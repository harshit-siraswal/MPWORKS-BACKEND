import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { attachmentIdsFromReferenceRows, getAttachment, getAttachmentReferences, getStates, getTenures, getWorkReport, getMetrics as getLiveMetrics } from './esakshi-source.js';
import { listProjects, getProject, getSummary, getSourceHealth, getFacets, getSourceMetadata, getMetrics, getVillages, getMembers, getMember } from './catalog.js';
import { analyzeStoredAttachments, fetchAndAnalyzeAttachments, fetchAndAnalyzeImages } from './image-analysis.js';
import { analyzeEvidenceAgainstProject } from './evidence-analysis.js';
import { persistEvidence } from './persistence/evidence.js';
import { getDistrictAnalysis, startDistrictAnalysis } from './district-analysis.js';
import { putR2Object, r2Configured } from './persistence/r2.js';
import { supabaseConfigured, supabaseInsert, supabaseSelect, supabaseUpdate } from './persistence/supabase.js';

const port = Number(process.env.PORT || 8000);
const geocodeCache = new Map();
const memberImageCache = new Map();
const recoveredSourceCache = new Map();
const evidenceJobs = new Map();
const feedbackMemory = new Map();
const feedbackRateLimit = new Map();

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  response.end(JSON.stringify(payload));
}

async function readBody(request) {
  let body = '';
  for await (const chunk of request) body += chunk;
  return body ? JSON.parse(body) : {};
}

function filtersFrom(url) {
  return {
    query: url.searchParams.get('query'),
    mp: url.searchParams.get('mp'),
    house: url.searchParams.get('house'),
    term: url.searchParams.get('term'),
    memberType: url.searchParams.get('memberType'),
    state: url.searchParams.get('state'),
    district: url.searchParams.get('district'),
    constituency: url.searchParams.get('constituency'),
    category: url.searchParams.get('category'),
    status: url.searchParams.get('status')
  };
}

async function findMemberImage(member) {
  if (memberImageCache.has(member.id)) return memberImageCache.get(member.id);
  try {
    const search = encodeURIComponent(`${member.name} Indian parliament ${member.state}`);
    const response = await fetch(`https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${search}&gsrnamespace=0&gsrlimit=3&prop=pageimages|info&piprop=thumbnail&pithumbsize=320&inprop=url&format=json&origin=*`, { signal: AbortSignal.timeout(8_000), headers: { 'User-Agent': 'MPWorks/0.1 public-data-explorer' } });
    if (!response.ok) throw new Error(`profile image search returned ${response.status}`);
    const pages = Object.values((await response.json()).query?.pages || {});
    const expected = String(member.name || '').toLowerCase().replace(/\b(shri|smt|dr|hon'?ble)\b/g, ' ').split(/[^a-z0-9]+/).filter((token) => token.length > 2);
    const page = pages.find((candidate) => { const title = String(candidate.title || '').toLowerCase().split(/[^a-z0-9]+/); return candidate.thumbnail?.source && expected.length >= 2 && expected.every((token) => title.includes(token)); });
    const image = page?.thumbnail?.source ? { imageUrl: page.thumbnail.source, imageSourceUrl: page.fullurl || `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title)}`, imageSource: 'Wikimedia Commons/Wikipedia thumbnail' } : null;
    memberImageCache.set(member.id, image);
    return image;
  } catch { memberImageCache.set(member.id, null); return null; }
}

function publicEvidence(evidence) {
  const files = (evidence.files || []).map(({ buffer, ...file }) => file);
  return { ...evidence, files, images: files.filter((file) => file.mimeType?.startsWith('image/')), documents: files.filter((file) => file.mimeType === 'application/pdf' || !file.mimeType?.startsWith('image/')) };
}

function sourceWorkIdCandidates(project) {
  const raw = project?.raw || {};
  const values = [raw.WORK_RECOMMENDATION_DTL_ID, raw.WORK_ID, raw.sourceWorkId, project?.title, raw.WORK];
  const ids = [];
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (/^\d+$/.test(text)) ids.push(text);
    const match = [...text.matchAll(/(?:^|\/)\s*([0-9]+)\s*-\s*/g)].at(-1);
    if (match?.[1]) ids.push(match[1]);
  }
  return [...new Set(ids)];
}

function sourcePayload(project, row) {
  return { ...row, WORK_RECOMMENDATION_DTL_ID: row.WORK_RECOMMENDATION_DTL_ID || sourceWorkIdCandidates(project)[0], HOUSE_OF_PARLIAMENT: row.HOUSE_OF_PARLIAMENT || (project.house === 'Rajya Sabha' ? '1' : '2'), TENURE: row.TENURE || project.term, STATE_NAME: row.STATE_NAME || project.state, MP_NAME: row.MP_NAME || project.mp, CONSTITUENCY: row.CONSTITUENCY || project.constituency, FLAG: row.FLAG ?? null, FILE_STATUS: row.FILE_STATUS ?? true };
}

async function recoverSourceProject(project) {
  const sourceId = sourceWorkIdCandidates(project)[0];
  if (!sourceId) return null;
  const cacheKey = `${sourceId}|${project.term}|${project.house}|${project.state}`;
  if (recoveredSourceCache.has(cacheKey)) return recoveredSourceCache.get(cacheKey);
  try {
    const states = await getStates();
    const state = states.find((item) => String(item.STATE_NAME || '').trim().toLowerCase() === String(project.state || '').trim().toLowerCase());
    const houseCode = project.house === 'Rajya Sabha' ? '1' : '2';
    const tenures = await getTenures(Number(houseCode));
    const tenure = tenures.find((item) => String(item.CAPTION || '').toLowerCase() === String(project.term || '').toLowerCase());
    if (!state?.STATE_ID || !tenure) return null;
    const combo = `${state.STATE_ID},0,0,${houseCode},${tenure.ID}`;
    for (const key of ['Works Completed', 'Works Sanctioned', 'Works Recommended']) {
      const rows = await getWorkReport(combo, key);
      const row = rows.find((item) => String(item.WORK_RECOMMENDATION_DTL_ID ?? item.WORK_ID ?? '') === sourceId);
      if (row) { const recovered = { sourceId, raw: { ...row, sourceKey: key } }; recoveredSourceCache.set(cacheKey, recovered); return recovered; }
    }
  } catch { /* the normal snapshot response remains available if the official source is down */ }
  return null;
}

async function attachmentIdsFor(project, raw) {
  const refs = [];
  const flags = [...new Set([raw?.FLAG, 1, 2, 3].map(Number).filter(Number.isFinite))];
  for (const flag of flags) {
    try { refs.push(...attachmentIdsFromReferenceRows(await getAttachmentReferences(raw, flag))); } catch { /* try the next official flag */ }
  }
  return [...new Map([...refs, ...attachmentIdsFromReferenceRows([raw])].filter((item) => item.id).map((item) => [item.id, item])).values()];
}

function attachmentProxyUrl(projectId, attachmentId) { return `/api/projects/${encodeURIComponent(projectId)}/evidence/attachment/${encodeURIComponent(attachmentId)}`; }

function publicEvidenceForProject(evidence, projectId) {
  const result = publicEvidence(evidence);
  result.files = result.files.map((file) => ({ ...file, url: file.r2Url || (file.sourceAttachmentId ? attachmentProxyUrl(projectId, file.sourceAttachmentId) : file.sourceUrl) }));
  result.images = result.files.filter((file) => file.mimeType?.startsWith('image/'));
  result.documents = result.files.filter((file) => file.mimeType === 'application/pdf' || !file.mimeType?.startsWith('image/'));
  return result;
}

function evidenceItemsForProject(project, attachmentCount) {
  return (project.evidenceItems || []).map((item) => item.type === 'image' ? { ...item, status: attachmentCount ? 'available' : item.status } : item);
}

function evidenceJobPayload(job) {
  if (!job) return null;
  return { status: job.status, note: job.note, files: job.files || [], images: job.images || [], documents: job.documents || [], comparison: job.comparison || { status: 'queued', reason: 'AI evidence comparison is still running.' }, riskIndex: job.riskIndex || null, persistence: job.persistence || { r2: 'pending', supabase: 'pending', stored: [], warnings: [] }, attachmentIds: job.attachmentIds || [], liveSourceWorkId: job.liveSourceWorkId || null, error: job.error || null };
}

async function runEvidenceJob(project) {
  const job = { status: 'processing', note: 'Fetching official source files and preparing AI analysis…', files: [], images: [], documents: [], attachmentIds: [], liveSourceWorkId: null, persistence: { r2: 'pending', supabase: 'pending', stored: [], warnings: [] } };
  evidenceJobs.set(project.id, job);
  try {
    const recovered = await recoverSourceProject(project);
    const sourceProject = recovered ? { ...project, raw: recovered.raw, attachmentIds: [], attachmentCandidates: project.attachmentCandidates || [] } : project;
    const sourceRefs = recovered ? await attachmentIdsFor(project, recovered.raw) : (sourceProject.attachmentCandidates?.length ? [] : project.attachmentIds.map((id) => ({ id })));
    sourceProject.attachmentIds = sourceRefs.map((item) => item.id).filter(Boolean);
    const attachmentOrigin = process.env.MPLADS_API_ORIGIN || 'https://mplads.mospi.gov.in';
    let evidence = sourceProject.attachmentCandidates?.length ? await analyzeStoredAttachments(sourceProject.attachmentCandidates) : null;
    if (!evidence?.files.length) {
      evidence = sourceRefs.length ? await fetchAndAnalyzeAttachments(sourceProject.attachmentIds, attachmentOrigin) : sourceProject.imageUrls.length ? await fetchAndAnalyzeImages(sourceProject.imageUrls) : await fetchAndAnalyzeAttachments(sourceProject.attachmentIds, attachmentOrigin);
    }
    const files = publicEvidenceForProject(evidence, project.id);
    Object.assign(job, { status: evidence.files.length ? 'analyzing' : 'not-available', note: evidence.files.length ? 'Source files were fetched. AI comparison is running; this page will update automatically.' : sourceProject.attachmentIds.length ? 'The official source returned attachment identifiers, but no readable image or PDF payload was returned.' : 'The live source record does not expose an image or PDF attachment identifier.', ...files, riskIndex: riskIndex(project, null, evidence.files.length), attachmentIds: sourceProject.attachmentIds, liveSourceWorkId: recovered?.sourceId || null });
    evidenceJobs.set(project.id, job);
    if (!evidence.files.length) return;
    let comparison = { status: 'queued', reason: 'AI evidence comparison is still running.' };
    try { comparison = await analyzeEvidenceAgainstProject(project, evidence.files); } catch (error) { comparison = { status: 'error', reason: error.message }; }
    let persistence;
    try { persistence = await persistEvidence(sourceProject, evidence.files, comparison); } catch (error) { persistence = { r2: 'error', supabase: 'error', stored: [], warnings: [error.message] }; }
    Object.assign(job, { status: 'analyzed', note: 'Source evidence was fetched. Image/PDF bytes were compared with the project metadata; AI findings are triage signals for human review, not a fraud finding.', comparison, riskIndex: riskIndex(project, comparison, evidence.files.length), persistence });
  } catch (error) {
    Object.assign(job, { status: 'failed', error: error.message, note: 'The official source or storage service was temporarily unavailable. Retry this record; no mock evidence was substituted.' });
  }
  evidenceJobs.set(project.id, job);
}

function decodeAttachmentValue(value) {
  if (typeof value !== 'string' || value === 'N/A') return null;
  const match = value.match(/^data:[^;]+;base64,(.*)$/i);
  const base64 = (match ? match[1] : value).replace(/\s/g, '');
  if (!/^[a-z0-9+/=]+$/i.test(base64) || base64.length < 20) return null;
  const buffer = Buffer.from(base64, 'base64');
  return buffer.length ? buffer : null;
}

async function fetchAttachmentBinary(id) {
  const rows = await getAttachment(id);
  for (const row of rows) for (const key of ['URL', 'url', 'CONTENT', 'content', 'DATA', 'data', 'FILE_DATA', 'fileData', 'DOCUMENT']) {
    const buffer = decodeAttachmentValue(row?.[key]);
    if (!buffer) continue;
    const fileName = row.FILE_NAME || row.fileName || 'evidence';
    const mimeType = buffer.subarray(0, 4).toString() === '%PDF' || /\.pdf$/i.test(fileName) ? 'application/pdf' : buffer.subarray(0, 3).toString('hex') === 'ffd8ff' ? 'image/jpeg' : buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' ? 'image/png' : 'application/octet-stream';
    return { buffer, fileName, mimeType };
  }
  return null;
}

function publicProject(project) {
  const { raw, normalized, evidenceItems, signals, attachmentCandidates, imageUrls, attachmentIds, ...safeProject } = project;
  return { ...safeProject, imageCount: imageUrls.length, attachmentCount: attachmentIds.length, riskIndex: riskIndex(project) };
}

function amountFromProject(project, field, normalizedField) {
  const value = project.raw?.[field] ?? project.raw?.[normalizedField] ?? project.normalized?.[normalizedField] ?? (normalizedField === 'recommendedAmount' ? project.normalized?.amountInr : null);
  const amount = Number(String(value ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(amount) ? amount : 0;
}

function districtMetrics(filters) {
  const metrics = getMetrics(filters);
  const scoped = listProjects(filters);
  metrics.sanctionedAmount = scoped.reduce((sum, project) => sum + amountFromProject(project, 'SANCTION_AMOUNT', 'sanctionAmount'), 0) || null;
  metrics.usedAmount = scoped.reduce((sum, project) => sum + amountFromProject(project, 'ACTUAL_AMOUNT', 'actualAmount'), 0) || null;
  return metrics;
}

function riskIndex(project, comparison = null, evidenceCount = project.attachmentCandidates?.length || project.attachmentIds?.length || 0) {
  const missing = ['state', 'district', 'constituency', 'mp', 'status'].filter((field) => !String(project[field] || '').trim());
  let score = comparison?.consistency === 'inconsistent' ? 82 : comparison?.consistency === 'consistent' ? 18 : evidenceCount ? 34 : 55;
  score = Math.max(0, Math.min(100, score + Math.min(missing.length * 4, 16)));
  const label = score >= 75 ? 'High review priority' : score >= 50 ? 'Elevated review priority' : score >= 30 ? 'Moderate review priority' : 'Lower review priority';
  const reason = comparison?.consistency === 'inconsistent'
    ? comparison.summary || comparison.possibleIssues?.join(' ') || 'The AI comparison found fields that need human verification.'
    : comparison?.consistency === 'consistent'
      ? comparison.summary || 'Available evidence is broadly consistent with the source record.'
      : evidenceCount
        ? 'Evidence is available, but a full AI comparison has not been completed for this record.'
        : 'No image or PDF evidence is currently available. This is an evidence-coverage limitation, not proof of fraud.';
  return { score, label, reason, confidence: Number(comparison?.confidence) || (comparison ? 25 : 10), basis: comparison ? 'AI evidence comparison plus source-field checks' : 'Source-field completeness and evidence availability; AI comparison pending' };
}

function exportRows(filters) {
  return listProjects(filters).map((project) => {
    const evidenceLinks = [...(project.imageUrls || []), ...(project.attachmentIds || []).map((id) => attachmentProxyUrl(project.id, id))].filter(Boolean);
    const risk = riskIndex(project);
    return { project_id: project.id, work_description: project.title, member_of_parliament: project.mp, house: project.house, term: project.term, state: project.state, district: project.district, constituency: project.constituency, village_or_area: project.villageRaw || project.villageNames?.join(' | '), category: project.category, status: project.status, recommended_amount: project.amount, source_date: project.sourceDate, review_index: `${risk.score}/100`, review_label: risk.label, review_reason: risk.reason, evidence_links: evidenceLinks.join(' | '), official_source: project.sourceUrl };
  });
}

const exportHeaders = ['project_id', 'work_description', 'member_of_parliament', 'house', 'term', 'state', 'district', 'constituency', 'village_or_area', 'category', 'status', 'recommended_amount', 'source_date', 'review_index', 'review_label', 'review_reason', 'evidence_links', 'official_source'];
function exportCell(value) { return `"${String(value ?? '').replace(/"/g, '""')}"`; }
function csvExport(rows) { return [exportHeaders.join(','), ...rows.map((row) => exportHeaders.map((header) => exportCell(row[header])).join(','))].join('\r\n'); }
function excelExport(rows) { const headings = exportHeaders.map((header) => `<th>${header.replace(/_/g, ' ')}</th>`).join(''); const body = rows.map((row) => `<tr>${exportHeaders.map((header) => `<td>${String(row[header] ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}</td>`).join('')}</tr>`).join(''); return `<!doctype html><html><head><meta charset="utf-8"><style>table{border-collapse:collapse}th,td{border:1px solid #ccd6df;padding:5px;vertical-align:top}th{background:#eaf2f7}</style></head><body><table><thead><tr>${headings}</tr></thead><tbody>${body}</tbody></table></body></html>`; }
function pdfText(value) { return String(value ?? '').replace(/[^\x20-\x7E]/g, '?').replace(/[\\()]/g, (character) => `\\${character}`).slice(0, 230); }
function pdfExport(rows) { const lines = ['MP Works data export', `Records: ${rows.length}`, 'Review index is a human-review signal, not a fraud probability or finding.', '']; rows.forEach((row, index) => { lines.push(`${index + 1}. ${pdfText(row.work_description)}`); lines.push(`MP: ${pdfText(row.member_of_parliament)} | ${pdfText(row.state)} | ${pdfText(row.district)} | ${pdfText(row.house)}`); lines.push(`Status: ${pdfText(row.status)} | Amount: ${pdfText(row.recommended_amount)} | Review: ${pdfText(row.review_index)} ${pdfText(row.review_label)}`); lines.push(`Evidence: ${pdfText(row.evidence_links || 'none')}`); lines.push(''); }); const pages = []; for (let index = 0; index < lines.length; index += 46) pages.push(lines.slice(index, index + 46)); const objects = []; objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'; objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'; const kids = []; pages.forEach((pageLines) => { const pageId = objects.length; objects.push(null); const contentId = objects.length; objects.push(null); kids.push(`${pageId} 0 R`); const commands = ['BT', '/F1 8 Tf', '40 770 Td', ...pageLines.map((line) => `(${pdfText(line)}) Tj 0 -16 Td`), 'ET'].join('\n'); objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`; objects[contentId] = `<< /Length ${Buffer.byteLength(commands, 'latin1')} >>\nstream\n${commands}\nendstream`; }); objects[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`; let output = '%PDF-1.4\n'; const offsets = [0]; for (let index = 1; index < objects.length; index += 1) { offsets[index] = Buffer.byteLength(output, 'latin1'); output += `${index} 0 obj\n${objects[index]}\nendobj\n`; } const xrefOffset = Buffer.byteLength(output, 'latin1'); output += `xref\n0 ${objects.length}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`; return Buffer.from(output, 'latin1'); }

function feedbackIpHash(request) { const forwarded = String(request.headers['x-forwarded-for'] || '').split(',')[0].trim(); const ip = forwarded || String(request.headers['x-real-ip'] || request.socket.remoteAddress || 'unknown').trim(); const salt = process.env.FEEDBACK_IP_SALT || process.env.SUPABASE_URL || 'mpworks-feedback'; return createHash('sha256').update(`${salt}|${ip}`).digest('hex'); }
function feedbackKey(projectKey, ipHash, kind) { return `${projectKey}|${ipHash}|${kind}`; }
async function feedbackRows(projectKey) { if (supabaseConfigured()) { try { return await supabaseSelect('project_public_feedback', `select=id,kind,ip_hash,comment,rating,r2_url,mime_type,created_at,updated_at,undone_at&project_key=eq.${encodeURIComponent(projectKey)}&order=created_at.desc&limit=200`); } catch { /* fall back for a deployment awaiting its migration */ } } return [...feedbackMemory.values()].filter((row) => row.project_key === projectKey); }
function feedbackSummary(projectKey, rows, ipHash) { const active = rows.filter((row) => !row.undone_at); const ratings = active.map((row) => Number(row.rating)).filter((rating) => Number.isInteger(rating)); return { projectId: projectKey, ratingCount: ratings.length, averageRating: ratings.length ? Math.round((ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length) * 10) / 10 : null, photoCount: active.filter((row) => row.kind === 'photo').length, commentCount: active.filter((row) => row.kind === 'comment' && row.comment).length, photos: active.filter((row) => row.kind === 'photo' && row.r2_url).slice(0, 20).map((row) => ({ url: row.r2_url, createdAt: row.created_at })), comments: active.filter((row) => row.kind === 'comment' && row.comment).slice(0, 20).map((row) => ({ comment: row.comment, createdAt: row.created_at })), viewer: { photo: Boolean(rows.find((row) => row.kind === 'photo' && row.ip_hash === ipHash)), comment: Boolean(rows.find((row) => row.kind === 'comment' && row.ip_hash === ipHash)), rating: Boolean(rows.find((row) => row.kind === 'rating' && row.ip_hash === ipHash)) } }; }
function checkFeedbackRateLimit(ipHash) { const now = Date.now(); const current = feedbackRateLimit.get(ipHash) || { startedAt: now, count: 0 }; if (now - current.startedAt > 60_000) { current.startedAt = now; current.count = 0; } current.count += 1; feedbackRateLimit.set(ipHash, current); return current.count <= 30; }
function decodeFeedbackImage(value) { const match = typeof value === 'string' && value.match(/^data:(image\/(?:jpeg|png|webp));base64,([a-z0-9+/=\s]+)$/i); if (!match) return null; const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64'); if (!buffer.length || buffer.length > 6 * 1024 * 1024) return null; const signature = buffer.subarray(0, 12).toString('hex'); const valid = (match[1] === 'image/jpeg' && signature.startsWith('ffd8ff')) || (match[1] === 'image/png' && signature.startsWith('89504e470d0a1a0a')) || (match[1] === 'image/webp' && buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP'); return valid ? { buffer, mimeType: match[1], extension: match[1].split('/')[1].replace('jpeg', 'jpg') } : null; }
async function insertFeedback(projectKey, ipHash, kind, fields) { const row = { project_key: projectKey, kind, ip_hash: ipHash, ...fields }; if (supabaseConfigured()) { try { return (await supabaseInsert('project_public_feedback', row))[0] || row; } catch { /* keep public feedback usable while a migration or database connection is recovering */ } } const key = feedbackKey(projectKey, ipHash, kind); if (feedbackMemory.has(key)) throw new Error('already_submitted'); feedbackMemory.set(key, { ...row, id: key, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), undone_at: null }); return feedbackMemory.get(key); }
async function undoFeedback(projectKey, ipHash, kind) { const rows = await feedbackRows(projectKey); const existing = rows.find((row) => row.kind === kind && row.ip_hash === ipHash); if (!existing) return false; if (supabaseConfigured() && existing.id) { try { await supabaseUpdate('project_public_feedback', `id=eq.${encodeURIComponent(existing.id)}`, { undone_at: new Date().toISOString(), updated_at: new Date().toISOString() }); return true; } catch { /* fall back to the process-local record */ } } const key = feedbackKey(projectKey, ipHash, kind); const row = feedbackMemory.get(key); if (row) { row.undone_at = new Date().toISOString(); row.updated_at = row.undone_at; } return true; }

async function geocodeDistrict(district, state) {
  const key = `${district}|${state}`;
  if (geocodeCache.has(key)) return geocodeCache.get(key);
  const query = encodeURIComponent(`${district}, ${state}, India`);
  try {
    const response = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${query}`, {
      headers: { 'User-Agent': 'MPWorks/0.1 public-administration-map' },
      signal: AbortSignal.timeout(12_000)
    });
    if (!response.ok) throw new Error(`geocoder returned ${response.status}`);
    const results = await response.json();
    const first = results[0];
    const point = first ? { district, state, lat: Number(first.lat), lon: Number(first.lon), precision: 'district approximation', geocoder: 'OpenStreetMap Nominatim' } : null;
    geocodeCache.set(key, point);
    return point;
  } catch {
    geocodeCache.set(key, null);
    return null;
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (request.method === 'OPTIONS') return sendJson(response, 204, {});

  if (request.method === 'GET' && url.pathname === '/api/health') return sendJson(response, 200, { status: 'ok', service: 'mplad-intelligence-api', version: '0.2.0' });
  if (request.method === 'GET' && url.pathname === '/api/catalog/summary') return sendJson(response, 200, { data: getSummary(), provenance: { queryVersion: 'summary-v0.2', generatedAt: new Date().toISOString() } });
  if (request.method === 'GET' && url.pathname === '/api/catalog/facets') return sendJson(response, 200, { data: getFacets(filtersFrom(url)), provenance: getSourceMetadata() });
  if (request.method === 'GET' && url.pathname === '/api/catalog/metrics') return sendJson(response, 200, { data: districtMetrics(filtersFrom(url)), provenance: getSourceMetadata() });
  if (request.method === 'GET' && url.pathname === '/api/villages') {
    const villages = getVillages(filtersFrom(url));
    const offset = Math.max(Number(url.searchParams.get('offset') || 0), 0);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 50), 1), 200);
    return sendJson(response, 200, { data: villages.slice(offset, offset + limit), meta: { total: villages.length, offset, limit, hasMore: offset + limit < villages.length }, provenance: getSourceMetadata() });
  }
  if (request.method === 'GET' && url.pathname === '/api/catalog/live-metrics') {
    const combo = url.searchParams.get('combo');
    if (!combo || !/^\d+(,\d+){3,4}$/.test(combo)) return sendJson(response, 400, { error: 'combo_required', note: 'Use the official eSAKSHI state,constituency,mp,house[,tenure] codes.' });
    try { return sendJson(response, 200, { data: await getLiveMetrics(combo), provenance: { source: getSourceMetadata().officialDashboard, api: getSourceMetadata().officialApi } }); }
    catch (error) { return sendJson(response, 502, { error: 'live_metrics_unavailable', detail: error.message }); }
  }
  if (request.method === 'GET' && (url.pathname === '/api/works/recommended' || url.pathname === '/api/works/completed')) {
    const kind = url.pathname.endsWith('completed') ? 'completed' : 'recommended';
    const filters = filtersFrom(url);
    const filtered = listProjects(filters).filter((project) => kind === 'completed' ? /completed|partially completed/i.test(project.status) : true);
    const requestedLimit = Number(url.searchParams.get('limit') || 50);
    const requestedOffset = Number(url.searchParams.get('offset') || 0);
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.floor(requestedLimit), 1), 200) : 50;
    const offset = Number.isFinite(requestedOffset) ? Math.max(Math.floor(requestedOffset), 0) : 0;
    return sendJson(response, 200, { data: filtered.slice(offset, offset + limit).map(publicProject), meta: { count: Math.min(limit, Math.max(filtered.length - offset, 0)), total: filtered.length, limit, offset, hasMore: offset + limit < filtered.length, queryVersion: `works-${kind}-v0.1` }, provenance: getSourceMetadata() });
  }
  if (request.method === 'GET' && url.pathname === '/api/works/summary') {
    const filters = filtersFrom(url);
    const scoped = listProjects(filters);
    return sendJson(response, 200, { data: { recommended: scoped.length, completed: scoped.filter((project) => /completed|partially completed/i.test(project.status)).length, total: scoped.length, filters }, provenance: getSourceMetadata() });
  }
  const exportMatch = url.pathname.match(/^\/api\/exports\/(csv|excel|xls|pdf)$/i);
  if (request.method === 'GET' && exportMatch) {
    const format = exportMatch[1].toLowerCase();
    const rows = exportRows(filtersFrom(url));
    const body = format === 'pdf' ? pdfExport(rows) : Buffer.from(format === 'csv' ? csvExport(rows) : excelExport(rows), 'utf8');
    const contentType = format === 'pdf' ? 'application/pdf' : format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.ms-excel; charset=utf-8';
    const extension = format === 'pdf' ? 'pdf' : format === 'csv' ? 'csv' : 'xls';
    response.writeHead(200, { 'Content-Type': contentType, 'Content-Length': body.length, 'Content-Disposition': `attachment; filename="mpworks-export-${new Date().toISOString().slice(0, 10)}.${extension}"`, 'Access-Control-Allow-Origin': '*' });
    return response.end(body);
  }
  if (request.method === 'GET' && url.pathname === '/api/mps') {
    const members = getMembers(filtersFrom(url));
    const requestedLimit = Math.min(Math.max(Number(url.searchParams.get('limit') || 24), 1), 60);
    const offset = Math.max(Number(url.searchParams.get('offset') || 0), 0);
    const page = members.slice(offset, offset + requestedLimit);
    const enriched = await Promise.all(page.map(async (member) => ({ ...member, ...(await findMemberImage(member) || {}) })));
    return sendJson(response, 200, { data: enriched, meta: { count: enriched.length, total: members.length, limit: requestedLimit, offset, hasMore: offset + enriched.length < members.length }, provenance: { imageSource: 'Wikimedia Commons/Wikipedia thumbnails when a matching public source is found' } });
  }
  const memberProjectsMatch = url.pathname.match(/^\/api\/mps\/([^/]+)\/projects$/);
  if (request.method === 'GET' && memberProjectsMatch) {
    const member = getMember(memberProjectsMatch[1], filtersFrom(url));
    if (!member) return sendJson(response, 404, { error: 'member_not_found' });
    const projects = listProjects(filtersFrom(url)).filter((project) => member.projectIds?.includes(project.id));
    const offset = Math.max(Number(url.searchParams.get('offset') || 0), 0);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 50), 1), 200);
    return sendJson(response, 200, { data: projects.slice(offset, offset + limit).map(publicProject), meta: { count: Math.min(limit, Math.max(projects.length - offset, 0)), total: projects.length, limit, offset, hasMore: offset + limit < projects.length }, member });
  }
  const memberMatch = url.pathname.match(/^\/api\/mps\/([^/]+)$/);
  if (request.method === 'GET' && memberMatch) {
    const member = getMember(memberMatch[1], filtersFrom(url));
    if (!member) return sendJson(response, 404, { error: 'member_not_found' });
    return sendJson(response, 200, { data: { ...member, ...(await findMemberImage(member) || {}) }, provenance: getSourceMetadata() });
  }
  if (request.method === 'GET' && url.pathname === '/api/source-health') return sendJson(response, 200, { data: getSourceHealth() });
  if (request.method === 'GET' && url.pathname === '/api/methodology') return sendJson(response, 200, { data: { riskLanguage: 'Risk indicators prioritize human review and are not conclusions.', methods: ['source-record-retention', 'optional-image-metadata-and-similarity'], caveats: ['Image coverage is source-dependent.', 'Coordinates are never silently invented. The map uses an explicitly labelled district approximation only.', 'No risk score is calculated until sufficient evidence is available.'], source: getSourceMetadata() } });

  if (request.method === 'GET' && url.pathname === '/api/projects') {
    const filtered = listProjects(filtersFrom(url));
    const requestedLimit = Number(url.searchParams.get('limit') || 50);
    const requestedOffset = Number(url.searchParams.get('offset') || 0);
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.floor(requestedLimit), 1), 200) : 50;
    const offset = Number.isFinite(requestedOffset) ? Math.max(Math.floor(requestedOffset), 0) : 0;
    const projects = filtered.slice(offset, offset + limit).map(publicProject);
    return sendJson(response, 200, { data: projects, meta: { count: projects.length, total: filtered.length, limit, offset, hasMore: offset + projects.length < filtered.length, queryVersion: 'catalog-search-v0.2', sourceUpdatedAt: getSourceHealth().sourceFileUpdatedAt } });
  }

  if (request.method === 'GET' && url.pathname.match(/^\/api\/district-analysis\/[^/]+$/)) {
    const job = getDistrictAnalysis(url.pathname.split('/').pop());
    return job ? sendJson(response, 200, { data: job }) : sendJson(response, 404, { error: 'analysis_job_not_found' });
  }

  if (request.method === 'POST' && url.pathname === '/api/district-analysis') {
    const body = await readBody(request);
    const filters = { state: body.state || null, district: body.district || null, house: body.house || null, term: body.term || null };
    if (!filters.district) return sendJson(response, 400, { error: 'district_required', note: 'Choose a district before starting district analysis.' });
    const projects = listProjects(filters);
    if (!projects.length) return sendJson(response, 404, { error: 'district_has_no_projects' });
    return sendJson(response, 202, { data: startDistrictAnalysis(projects, filters), note: 'District evidence analysis queued. Poll the returned job id for ranked results.' });
  }

  if (request.method === 'GET' && url.pathname === '/api/map/locations') {
    const filters = filtersFrom(url);
    const filtered = listProjects(filters);
    const groups = [...filtered.reduce((groupMap, project) => {
      const key = `${project.district}|${project.state}`;
      const current = groupMap.get(key) || { district: project.district, state: project.state, count: 0 };
      current.count += 1;
      groupMap.set(key, current);
      return groupMap;
    }, new Map()).values()];
    const candidates = (filters.district && filters.district !== 'All districts') ? groups : (filters.state && filters.state !== 'All states' ? groups.slice(0, 8) : []);
    const points = (await Promise.all(candidates.map(async (group) => ({ ...group, ...(await geocodeDistrict(group.district, group.state) || {}) })))).filter((point) => point.lat && point.lon);
    return sendJson(response, 200, { data: { points, totalMatches: filtered.length, precision: 'District locations are approximate; the source does not publish project coordinates.', mapSource: 'OpenStreetMap Nominatim', message: candidates.length ? (points.length ? null : 'The map provider did not return a location for this district.') : 'Select a state or district to place source records on the map.' } });
  }

  if (request.method === 'GET' && url.pathname === '/api/map/reverse') {
    const lat = Number(url.searchParams.get('lat'));
    const lon = Number(url.searchParams.get('lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return sendJson(response, 400, { error: 'invalid_coordinates' });
    try {
      const reverseUrl = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`;
      const reverseResponse = await fetch(reverseUrl, { headers: { 'User-Agent': 'MPWorks/0.1 public-administration-map' }, signal: AbortSignal.timeout(12_000) });
      if (!reverseResponse.ok) throw new Error(`geocoder returned ${reverseResponse.status}`);
      const payload = await reverseResponse.json();
      const address = payload.address || {};
      return sendJson(response, 200, { data: { lat, lon, state: address.state || null, district: address.state_district || address.district || address.county || address.city_district || null, area: address.village || address.town || address.suburb || address.city || address.municipality || null, displayName: payload.display_name || null, precision: 'Map pin is user-selected; source records remain district/area matched.' } });
    } catch (error) { return sendJson(response, 502, { error: 'reverse_geocode_unavailable', detail: error.message }); }
  }

  const refreshMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/evidence\/refresh$/);
  if (refreshMatch && request.method === 'POST') {
    const project = getProject(refreshMatch[1]);
    if (!project) return sendJson(response, 404, { error: 'project_not_found' });
    const current = evidenceJobs.get(project.id);
    if (current?.status === 'processing' || current?.status === 'analyzing') return sendJson(response, 202, { data: { projectId: project.id, ...evidenceJobPayload(current) } });
    void runEvidenceJob(project);
    return sendJson(response, 202, { data: { projectId: project.id, status: 'processing', note: 'Evidence fetching and AI analysis has started. This page will update automatically.', files: [], images: [], documents: [], comparison: { status: 'queued', reason: 'Evidence analysis is running.' }, persistence: { r2: 'pending', supabase: 'pending', stored: [], warnings: [] } } });
  }

  const attachmentMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/evidence\/attachment\/([^/]+)$/);
  if (attachmentMatch && request.method === 'GET') {
    const project = getProject(decodeURIComponent(attachmentMatch[1]));
    if (!project) return sendJson(response, 404, { error: 'project_not_found' });
    try {
      const attachment = await fetchAttachmentBinary(decodeURIComponent(attachmentMatch[2]));
      if (!attachment) return sendJson(response, 404, { error: 'attachment_payload_not_found' });
      response.writeHead(200, { 'Content-Type': attachment.mimeType, 'Content-Length': attachment.buffer.length, 'Cache-Control': 'private, max-age=300', 'Content-Disposition': `inline; filename="${String(attachment.fileName || 'evidence').replace(/[^a-z0-9._-]/gi, '_')}"` });
      return response.end(attachment.buffer);
    } catch (error) { return sendJson(response, 502, { error: 'attachment_fetch_failed', detail: error.message }); }
  }

  const feedbackMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/feedback$/);
  if (feedbackMatch && (request.method === 'GET' || request.method === 'POST')) {
    const projectKey = decodeURIComponent(feedbackMatch[1]);
    if (!getProject(projectKey)) return sendJson(response, 404, { error: 'project_not_found' });
    const ipHash = feedbackIpHash(request);
    if (request.method === 'GET') return sendJson(response, 200, { data: feedbackSummary(projectKey, await feedbackRows(projectKey), ipHash) });
    if (Number(request.headers['content-length'] || 0) > 9 * 1024 * 1024) return sendJson(response, 413, { error: 'feedback_payload_too_large', note: 'Images must be 6 MB or smaller.' });
    if (!checkFeedbackRateLimit(ipHash)) return sendJson(response, 429, { error: 'feedback_rate_limited', note: 'Please wait before sending more feedback.' });
    const body = await readBody(request);
    const rows = await feedbackRows(projectKey);
    if (body.action === 'undo') {
      if (!['photo', 'comment', 'rating'].includes(body.kind)) return sendJson(response, 400, { error: 'invalid_feedback_kind' });
      if (!await undoFeedback(projectKey, ipHash, body.kind)) return sendJson(response, 404, { error: 'feedback_not_found' });
      return sendJson(response, 200, { data: feedbackSummary(projectKey, await feedbackRows(projectKey), ipHash), message: `${body.kind} feedback was undone for this IP.` });
    }
    const requested = [];
    if (body.comment !== undefined) { const comment = String(body.comment || '').trim(); if (!comment || comment.length > 2000) return sendJson(response, 400, { error: 'invalid_comment', note: 'Comments must be between 1 and 2,000 characters.' }); requested.push({ kind: 'comment', fields: { comment } }); }
    if (body.rating !== undefined) { const rating = Number(body.rating); if (!Number.isInteger(rating) || rating < 0 || rating > 10) return sendJson(response, 400, { error: 'invalid_rating', note: 'Rating must be a whole number from 0 to 10.' }); requested.push({ kind: 'rating', fields: { rating } }); }
    if (body.imageData !== undefined) { if (!r2Configured()) return sendJson(response, 503, { error: 'photo_storage_unavailable', note: 'Photo storage is temporarily unavailable. Comments and ratings remain available.' }); const image = decodeFeedbackImage(body.imageData); if (!image) return sendJson(response, 400, { error: 'invalid_image', note: 'Upload a valid JPEG, PNG or WebP image up to 6 MB.' }); requested.push({ kind: 'photo', image }); }
    if (!requested.length) return sendJson(response, 400, { error: 'feedback_required', note: 'Send a comment, rating, or photo.' });
    const duplicates = requested.filter((item) => rows.some((row) => row.kind === item.kind && row.ip_hash === ipHash));
    if (duplicates.length) return sendJson(response, 409, { error: 'feedback_already_submitted', kinds: duplicates.map((item) => item.kind), note: 'Each IP can submit one photo, one comment and one rating per project. Only undo is available.' });
    for (const item of requested) {
      if (item.kind === 'photo') {
        const key = `mplads/public-feedback/${String(projectKey).replace(/[^a-z0-9_-]+/gi, '-').slice(0, 100)}/${item.image.extension}-${createHash('sha256').update(item.image.buffer).digest('hex')}.${item.image.extension}`;
        const stored = await putR2Object(key, item.image.buffer, item.image.mimeType);
        await insertFeedback(projectKey, ipHash, 'photo', { r2_key: stored.key, r2_url: stored.url, mime_type: item.image.mimeType, file_size: item.image.buffer.length });
      } else await insertFeedback(projectKey, ipHash, item.kind, item.fields);
    }
    return sendJson(response, 201, { data: feedbackSummary(projectKey, await feedbackRows(projectKey), ipHash), message: 'Feedback received.' });
  }

  const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)(?:\/(evidence|reports))?$/);
  if (projectMatch && request.method === 'GET') {
    const project = getProject(projectMatch[1]);
    if (!project) return sendJson(response, 404, { error: 'project_not_found' });
    if (projectMatch[2] === 'evidence') {
      const job = evidenceJobPayload(evidenceJobs.get(project.id));
      if (job) return sendJson(response, 200, { data: { projectId: project.id, ...job, items: evidenceItemsForProject(project, job.files.length || job.attachmentIds.length), attachmentCount: job.files.length || job.attachmentIds.length, imageUrls: job.files.map((file) => file.url).filter(Boolean), sourceUrl: project.sourceUrl, fetchTimestamp: project.fetchTimestamp } });
      const files = (project.attachmentCandidates || []).map(({ localPath, ...file }) => ({ ...file, sourceAttachmentId: file.attachmentId || file.sourceAttachmentId || null, status: file.r2Url ? 'stored' : 'discovered' }));
      const publicFiles = files.map((file) => ({ ...file, url: file.r2Url || (file.sourceAttachmentId ? attachmentProxyUrl(project.id, file.sourceAttachmentId) : file.sourceUrl) }));
      if (!publicFiles.length && !project.attachmentIds.length) void runEvidenceJob(project);
      const queued = evidenceJobPayload(evidenceJobs.get(project.id));
      if (queued) return sendJson(response, 200, { data: { projectId: project.id, ...queued, items: evidenceItemsForProject(project, queued.files.length || queued.attachmentIds.length), attachmentCount: queued.files.length || queued.attachmentIds.length, imageUrls: queued.files.map((file) => file.url).filter(Boolean), sourceUrl: project.sourceUrl, fetchTimestamp: project.fetchTimestamp } });
      const sourceRefs = project.attachmentIds.map((id) => ({ id }));
      return sendJson(response, 200, { data: { projectId: project.id, status: publicFiles.length ? 'available' : 'not-available', liveSourceWorkId: null, attachmentIds: sourceRefs.map((item) => item.id).filter(Boolean), items: evidenceItemsForProject(project, publicFiles.length || sourceRefs.length), signals: project.signals, riskIndex: riskIndex(project, null, publicFiles.length || sourceRefs.length), files: publicFiles, images: publicFiles.filter((file) => file.mimeType?.startsWith('image/')), documents: publicFiles.filter((file) => file.mimeType === 'application/pdf'), imageUrls: publicFiles.map((file) => file.url).filter(Boolean), attachmentCount: publicFiles.length || sourceRefs.length, sourceUrl: project.sourceUrl, fetchTimestamp: project.fetchTimestamp } });
    }
    return sendJson(response, 200, { data: project });
  }

  if (projectMatch && request.method === 'POST' && projectMatch[2] === 'reports') {
    const project = getProject(projectMatch[1]);
    if (!project) return sendJson(response, 404, { error: 'project_not_found' });
    const body = await readBody(request);
    return sendJson(response, 202, { data: { reportId: `public-${project.id}-${Date.now()}`, projectId: project.id, status: 'Unverified public report', received: true, category: body.category || 'other' }, audit: { event: 'public_report_received', createdAt: new Date().toISOString() } });
  }

  return sendJson(response, 404, { error: 'route_not_found' });
});

const host = process.env.HOST || '0.0.0.0';
server.listen(port, host, () => console.log(`MPLAD Intelligence API listening on http://${host}:${port}`));
