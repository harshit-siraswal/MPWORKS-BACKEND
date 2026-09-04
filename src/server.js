import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { attachmentIdsFromReferenceRows, getAttachment, getAttachmentReferences, getStates, getTenures, getWorkReport, getMetrics as getLiveMetrics } from './esakshi-source.js';
import { listProjects, getProject, getSummary, getSourceHealth, getFacets, getSourceMetadata, getMetrics, getVillages, getMembers, getMember } from './catalog.js';
import { analyzeStoredAttachments, fetchAndAnalyzeAttachments, fetchAndAnalyzeImages } from './image-analysis.js';
import { analyzeEvidenceAgainstProject } from './evidence-analysis.js';
import exifr from 'exifr';
import { persistEvidence } from './persistence/evidence.js';
import { getDistrictAnalysis, startDistrictAnalysis } from './district-analysis.js';
import { putR2Object, r2Configured } from './persistence/r2.js';
import { supabaseConfigured, supabaseInsert, supabaseSelect, supabaseUpdate } from './persistence/supabase.js';
import { estimateProjectAmount } from './amount-estimation.js';

const port = Number(process.env.PORT || 8000);
const geocodeCache = new Map();
const memberImageCache = new Map();
const recoveredSourceCache = new Map();
const evidenceJobs = new Map();
const comparisonCache = new Map();
const feedbackMemory = new Map();
const feedbackRateLimit = new Map();
const INR = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
// The official attachment endpoint currently returns this known cross-record
// association for work 105146. Keep it quarantined until MPLADS corrects the
// upstream response; it must never be presented as Mumbai project evidence.
const quarantinedLiveEvidence = new Set(['105146|1845259.1915050']);

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
    status: url.searchParams.get('status'),
    sort: url.searchParams.get('sort')
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
  return { ...row, WORK_CATEGORY: row.WORK_CATEGORY || row.workCategory || project.category, ACTIVITY_NAME: row.ACTIVITY_NAME || row.activityName || project.title, WORK_DESCRIPTION: row.WORK_DESCRIPTION || row.description || project.title, IDA_NAME: row.IDA_NAME || row.implementingAuthority || project.district, CONSTITUENCY_ID: row.CONSTITUENCY_ID || row.constituencyId || null, LETTER_NO: row.LETTER_NO || row.letterNo || null, ACTUAL_AMOUNT: row.ACTUAL_AMOUNT ?? row.actualAmount ?? null, ACTUAL_END_DATE: row.ACTUAL_END_DATE || row.actualEndDate || null, WORK_ID: row.WORK_ID || row.sourceWorkIdPhysical || sourceWorkIdCandidates(project)[0], WORK_RECOMMENDATION_DTL_ID: row.WORK_RECOMMENDATION_DTL_ID || sourceWorkIdCandidates(project)[0], HOUSE_OF_PARLIAMENT: row.HOUSE_OF_PARLIAMENT || (project.house === 'Rajya Sabha' ? '1' : '2'), TENURE: row.TENURE || project.term, STATE_NAME: row.STATE_NAME || project.state, MP_NAME: row.MP_NAME || project.mp, CONSTITUENCY: row.CONSTITUENCY || project.constituency, FLAG: row.FLAG ?? row.flag ?? null, FILE_STATUS: row.FILE_STATUS ?? row.fileStatus ?? true };
}

function isQuarantinedLiveEvidence(project, attachmentId) {
  if (project?.source !== 'MPLADS live eSAKSHI ingest') return false;
  const workId = project.raw?.sourceWorkId || project.raw?.WORK_RECOMMENDATION_DTL_ID || project.raw?.WORK_ID;
  return quarantinedLiveEvidence.has(`${String(workId || '')}|${String(attachmentId || '')}`);
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

async function attachmentLookupFor(raw, requestedFlags = null) {
  const flags = [...new Set((requestedFlags || [raw?.FLAG, 1, 2, 3]).map(Number).filter((flag) => Number.isInteger(flag) && flag >= 1 && flag <= 3))];
  const responses = await Promise.allSettled(flags.map((flag) => getAttachmentReferences(raw, flag)));
  const refs = responses.flatMap((result) => result.status === 'fulfilled' ? attachmentIdsFromReferenceRows(result.value) : []);
  const fallbackRefs = attachmentIdsFromReferenceRows([raw]);
  return {
    refs: [...new Map([...refs, ...fallbackRefs].filter((item) => item.id).map((item) => [item.id, item])).values()],
    complete: responses.length > 0 && responses.every((result) => result.status === 'fulfilled'),
    errors: responses.filter((result) => result.status === 'rejected').map((result) => result.reason?.message || 'attachment lookup failed')
  };
}

async function attachmentIdsFor(project, raw, requestedFlags = null) {
  return (await attachmentLookupFor(raw, requestedFlags)).refs;
}

function attachmentProxyUrl(projectId, attachmentId) { return `/api/projects/${encodeURIComponent(projectId)}/evidence/attachment/${encodeURIComponent(attachmentId)}`; }

function isContentHash(value) { return /^[0-9a-f]{64}$/i.test(String(value || '')); }

function publicEvidenceUrl(projectId, file) {
  if (file.r2Url) return file.r2Url;
  if (file.sourceAttachmentId) return attachmentProxyUrl(projectId, file.sourceAttachmentId);
  if (file.sourceUrl && /^https?:\/\//i.test(file.sourceUrl)) return file.sourceUrl;
  return null;
}

function publicEvidenceForProject(evidence, projectId) {
  const result = publicEvidence(evidence);
  result.files = result.files.map((file) => ({ ...file, url: publicEvidenceUrl(projectId, file) }));
  result.images = result.files.filter((file) => file.mimeType?.startsWith('image/'));
  result.documents = result.files.filter((file) => file.mimeType === 'application/pdf' || !file.mimeType?.startsWith('image/'));
  return result;
}

async function appendEvidenceIndex(project, files) {
  if (project.source !== 'MPLADS live eSAKSHI ingest' || !files?.length) return;
  const root = process.env.MPLADS_LIVE_ROOT || join(process.cwd(), 'data', 'raw', 'esakshi');
  const path = join(root, 'attachments.ndjson');
  const existing = await readFile(path, 'utf8').catch(() => '');
  const existingKeys = new Set(existing.split(/\r?\n/).filter(Boolean).flatMap((line) => { try { const row = JSON.parse(line); return [`${row.sourceWorkId}|${row.term}|${row.houseCode}|${row.attachmentId}`]; } catch { return []; } }));
  const sourceWorkId = project.raw?.sourceWorkId || project.raw?.WORK_RECOMMENDATION_DTL_ID || project.raw?.WORK_ID;
  const rows = files.map((file) => ({ sourceWorkId: sourceWorkId == null ? null : String(sourceWorkId), term: project.term, houseCode: project.house === 'Rajya Sabha' ? '1' : '2', flag: file.flag || project.raw?.flag || project.raw?.FLAG || 3, attachmentId: file.sourceAttachmentId, officialSourceVerified: true, aiVerified: true, fileName: file.fileName || null, mimeType: file.mimeType || null, sha256: file.sha256 || null, bytes: file.bytes || null, r2Key: file.r2Key || null, r2Url: file.r2Url || file.url || null, sourceUrl: file.sourceUrl || null, analyzedAt: file.analyzedAt || new Date().toISOString(), analyzer: file.analyzer || 'on-demand-evidence' })).filter((row) => row.sourceWorkId && row.attachmentId && row.r2Url && !existingKeys.has(`${row.sourceWorkId}|${row.term}|${row.houseCode}|${row.attachmentId}`));
  if (!rows.length) return;
  await mkdir(root, { recursive: true });
  const separator = existing && !existing.endsWith('\n') ? '\n' : '';
  await appendFile(path, separator + rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
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
    Object.assign(job, { status: 'fetching', note: 'Fetching the official eSAKSHI attachment record before starting AI analysis…' });
    evidenceJobs.set(project.id, job);
    // The live catalog stores the normalized work row, which already contains
    // enough identifiers for getAttachIdsbyFlag. This avoids scanning a whole
    // state report for every project and is the critical path for completed
    // works that were not included in the initial attachment crawl.
    let directRefs = [];
    let directLookup = null;
    let verifiedCandidates = project.attachmentCandidates || [];
    const isLiveProject = project.source === 'MPLADS live eSAKSHI ingest';
    // A cached attachment is not authoritative for a live project. The source
    // work ID can be reused by a bad historical crawl, so every on-demand
    // analysis must first confirm the attachment ID against the current
    // eSAKSHI attachment lookup for this exact work.
    if (isLiveProject || !project.attachmentCandidates?.length) {
      try {
        directLookup = await attachmentLookupFor(sourcePayload(project, project.raw || {}), [project.raw?.flag, 1, 2, 3]);
        directRefs = directLookup.refs.filter((item) => !isQuarantinedLiveEvidence(project, item.id));
      } catch { /* use the empty result below */ }
    }
    // Some live catalog generations retained the recommendation id but not
    // the physical WORK_ID used by getAttachIdsbyFlag. When the direct lookup
    // is empty, rehydrate this one work from the official report and retry
    // with the exact source row. This is deliberately per-project and only
    // runs on an empty result, keeping the normal path fast while fixing the
    // completed-work evidence gap.
    // An empty, fully completed lookup is an authoritative "no attachment"
    // result. Only rehydrate the source report when the lookup itself failed;
    // otherwise every no-file project incurred several slow report downloads.
    const recovered = directRefs.length || (directLookup?.complete && isLiveProject) ? null : await recoverSourceProject(project);
    let recoveredLookup = null;
    if (recovered && (isLiveProject || !directRefs.length)) {
      recoveredLookup = await attachmentLookupFor(recovered.raw, [recovered.raw?.FLAG, 1, 2, 3]);
      if (recoveredLookup.refs.length) directRefs = recoveredLookup.refs.filter((item) => !isQuarantinedLiveEvidence(project, item.id));
    }
    const liveLookup = recoveredLookup || directLookup;
    if (isLiveProject) {
      const officialIds = new Set(directRefs.map((item) => String(item.id)));
      verifiedCandidates = liveLookup?.complete
        ? (project.attachmentCandidates || []).filter((file) => officialIds.has(String(file.sourceAttachmentId || file.attachmentId)) && !isQuarantinedLiveEvidence(project, file.sourceAttachmentId || file.attachmentId))
        : [];
    }
    const sourceProject = recovered ? { ...project, raw: recovered.raw, attachmentIds: [], attachmentCandidates: verifiedCandidates } : { ...project, attachmentCandidates: verifiedCandidates };
    const sourceRefs = directRefs.length ? directRefs : recovered ? [] : (isLiveProject ? [] : (sourceProject.attachmentCandidates?.length ? [] : project.attachmentIds.map((id) => ({ id }))));
    sourceProject.attachmentIds = sourceRefs.map((item) => item.id).filter(Boolean);
    if (sourceProject.attachmentIds.length) {
      Object.assign(job, { status: 'fetching', note: `Found ${sourceProject.attachmentIds.length} official attachment identifiers. Downloading source files…`, attachmentIds: sourceProject.attachmentIds, liveSourceWorkId: recovered?.sourceId || null });
      evidenceJobs.set(project.id, job);
    }
    const attachmentOrigin = process.env.MPLADS_API_ORIGIN || 'https://mplads.mospi.gov.in';
    let evidence = sourceProject.attachmentCandidates?.length ? await analyzeStoredAttachments(sourceProject.attachmentCandidates) : null;
    if (!evidence?.files.length) {
      evidence = sourceRefs.length ? await fetchAndAnalyzeAttachments(sourceProject.attachmentIds, attachmentOrigin) : sourceProject.imageUrls.length ? await fetchAndAnalyzeImages(sourceProject.imageUrls) : await fetchAndAnalyzeAttachments(sourceProject.attachmentIds, attachmentOrigin);
    }
    const files = publicEvidenceForProject(evidence, project.id);
    const missingAttachmentNote = project.source === 'MPLADS live eSAKSHI ingest'
      ? (liveLookup && !liveLookup.complete
        ? 'The official MPLADS attachment lookup was temporarily unavailable. The record was not served from an unverified cached association.'
        : 'The official MPLADS attachment lookup returned no attachment for this source work. Any older unverified association was withheld.')
      : 'This older work-list snapshot has no attachment identifier. The official live eSAKSHI record could not be matched to this row.';
    const feedback = feedbackSummary(project.id, await feedbackRows(project.id), null);
    Object.assign(job, { status: evidence.files.length ? 'analyzing' : 'not-available', note: evidence.files.length ? `Fetched ${evidence.files.length} source file${evidence.files.length === 1 ? '' : 's'}. Verifying the file against this source project before displaying or storing it.` : sourceProject.attachmentIds.length ? 'The official source returned attachment identifiers, but no readable image or PDF payload was returned.' : missingAttachmentNote, ...files, files: [], images: [], documents: [], riskIndex: riskIndex(project, null, evidence.files.length, feedback), attachmentIds: sourceProject.attachmentIds, liveSourceWorkId: recovered?.sourceId || null });
    evidenceJobs.set(project.id, job);
    if (!evidence.files.length) return;
    let comparison = { status: 'queued', reason: 'AI evidence comparison is still running.' };
    try { comparison = await analyzeEvidenceAgainstProject(project, evidence.files); } catch (error) { comparison = { status: 'error', reason: error.message }; }
    if (isLiveProject && (comparison.status !== 'completed' || comparison.consistency !== 'consistent')) {
      const rejected = comparison.status === 'completed';
      Object.assign(job, { status: rejected ? 'rejected' : 'verification-failed', note: rejected ? 'The fetched file was withheld because its contents conflict with this source project. It was not stored or counted as evidence.' : 'The fetched file was withheld because its identity could not be verified against this source project. It was not stored or counted as evidence; retry after the comparison service is available.', files: [], images: [], documents: [], comparison, riskIndex: riskIndex(project, comparison, 0, feedback), persistence: { r2: 'not-written', supabase: 'not-written', stored: [], warnings: [rejected ? 'Evidence identity mismatch' : 'Evidence identity verification incomplete'] } });
      evidenceJobs.set(project.id, job);
      return;
    }
    let persistence;
    try { persistence = await persistEvidence(sourceProject, evidence.files, comparison); } catch (error) { persistence = { r2: 'error', supabase: 'error', stored: [], warnings: [error.message] }; }
    // persistEvidence mutates each file with its permanent R2 URL. Rebuild the
    // public payload after persistence so clients never receive a stale proxy
    // URL built from a SHA-256 content hash.
    const persistedFiles = publicEvidenceForProject(evidence, project.id);
    try { await appendEvidenceIndex(project, persistedFiles.files); } catch (error) { persistence = { ...persistence, warnings: [...(persistence?.warnings || []), `Evidence index update failed: ${error.message}`] }; }
    if (evidence.files.length) {
      // Keep the in-process catalog consistent with the evidence endpoint so
      // MP profiles and work tables stop showing 0 immediately after a
      // successful on-demand fetch. The permanent source of truth remains R2.
      project.attachmentCandidates = persistedFiles.files.map(({ url, ...file }) => ({ ...file, r2Url: file.r2Url || url }));
      project.attachmentIds = [...new Set(persistedFiles.files.map((file) => file.sourceAttachmentId).filter(Boolean))];
      project.imageUrls = persistedFiles.images.map((file) => file.url).filter(Boolean);
    }
    Object.assign(job, { status: 'analyzed', note: 'Source evidence was fetched. Image/PDF bytes were compared with the project metadata; AI findings are triage signals for human review, not a fraud finding.', ...persistedFiles, comparison, riskIndex: riskIndex(project, comparison, evidence.files.length, feedback), persistence });
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
  for (const row of rows) for (const key of ['URL', 'url', 'CONTENT', 'content', 'DATA', 'data', 'FILE_DATA', 'fileData', 'FILE_CONTENT', 'fileContent', 'BASE64', 'base64', 'DOCUMENT', 'document', 'ATTACHMENT', 'attachment']) {
    const buffer = decodeAttachmentValue(row?.[key]);
    if (!buffer) continue;
    const fileName = row.FILE_NAME || row.fileName || 'evidence';
    const mimeType = buffer.subarray(0, 4).toString() === '%PDF' || /\.pdf$/i.test(fileName) ? 'application/pdf' : buffer.subarray(0, 3).toString('hex') === 'ffd8ff' ? 'image/jpeg' : buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' ? 'image/png' : 'application/octet-stream';
    return { buffer, fileName, mimeType };
  }
  return null;
}

async function fetchStoredDocumentBinary(id) {
  if (!supabaseConfigured()) return null;
  const value = String(id || '');
  const queries = [
    `source_attachment_id=eq.${encodeURIComponent(value)}`,
    ...(isContentHash(value) ? [`sha256=eq.${encodeURIComponent(value)}`] : [])
  ];
  for (const query of queries) {
    try {
      const rows = await supabaseSelect('project_documents', `select=source_attachment_id,source_file_name,mime_type,r2_url,source_url&${query}&limit=1`);
      const document = rows?.[0];
      if (!document) continue;
      for (const url of [document.r2_url, document.source_url]) {
        if (!/^https?:\/\//i.test(String(url || ''))) continue;
        const response = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { 'User-Agent': 'MPWorks/0.1 evidence-viewer' } });
        if (!response.ok) continue;
        const buffer = Buffer.from(await response.arrayBuffer());
        if (!buffer.length || buffer.length > 25 * 1024 * 1024) continue;
        const contentType = String(response.headers.get('content-type') || '').toLowerCase();
        const looksLikePdf = buffer.subarray(0, 4).toString() === '%PDF';
        const looksLikeImage = /^image\//.test(contentType) || buffer.subarray(0, 3).toString('hex') === 'ffd8ff' || buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
        if (document.mime_type === 'application/pdf' && !looksLikePdf) continue;
        if (document.mime_type?.startsWith('image/') && !looksLikeImage) continue;
        return { buffer, fileName: document.source_file_name || 'evidence', mimeType: document.mime_type || 'application/octet-stream' };
      }
    } catch { /* the source attachment fallback below remains available */ }
  }
  return null;
}

async function storedProjectComparison(project) {
  if (!supabaseConfigured()) return null;
  const cached = comparisonCache.get(project.id);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const ids = [...new Set([...(project.attachmentIds || []), ...(project.attachmentCandidates || []).map((file) => file.sourceAttachmentId || file.attachmentId).filter(Boolean)])].slice(0, 12);
  for (const id of ids) {
    try {
      const rows = await supabaseSelect('project_documents', `select=analysis&source_attachment_id=eq.${encodeURIComponent(String(id))}&limit=1`);
      const value = rows?.[0]?.analysis?.projectComparison;
      if (value && typeof value === 'object') {
        comparisonCache.set(project.id, { value, expiresAt: Date.now() + 5 * 60 * 1000 });
        return value;
      }
    } catch { /* the evidence endpoint can still serve the stored file */ }
  }
  comparisonCache.set(project.id, { value: null, expiresAt: Date.now() + 60 * 1000 });
  return null;
}

async function findPhotoGps(project) {
  const candidates = (project.attachmentCandidates || []).filter((file) => /image\//i.test(file.mimeType || '') && (file.r2Url || file.url)).slice(0, 4);
  for (const candidate of candidates) {
    try {
      const url = candidate.r2Url || candidate.url;
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) continue;
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > 25 * 1024 * 1024) continue;
      const gps = await exifr.gps(buffer);
      const lat = Number(gps?.latitude);
      const lon = Number(gps?.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { coordinates: { lat, lon }, sourceAttachmentId: candidate.sourceAttachmentId || candidate.attachmentId || null, source: 'image-exif-gps' };
    } catch { /* some evidence files do not contain EXIF GPS metadata */ }
  }
  return null;
}

function publicProject(project, feedback = null) {
  const { raw, normalized, evidenceItems, signals, attachmentCandidates, imageUrls, attachmentIds, ...safeProject } = project;
  const sourceMayHaveEvidence = Boolean(raw?.FILE_STATUS || raw?.fileStatus) || /completed|partially completed|physical inspection/i.test(project.status || '');
  return { ...safeProject, amountEstimate: estimateProjectAmount(project), imageCount: imageUrls.length, attachmentCount: attachmentIds.length, evidenceStatus: attachmentIds.length ? 'indexed' : sourceMayHaveEvidence ? 'source-pending-index' : 'not-reported-by-source', publicFeedback: feedback || { ratingCount: 0, averageRating: null, photoCount: 0, commentCount: 0 }, riskIndex: riskIndex(project, null, undefined, feedback) };
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

function riskIndex(project, comparison = null, evidenceCount = project.attachmentCandidates?.length || project.attachmentIds?.length || 0, feedback = null) {
  const missing = ['state', 'district', 'constituency', 'mp', 'status'].filter((field) => !String(project[field] || '').trim());
  let score = comparison?.consistency === 'inconsistent' ? 82 : comparison?.consistency === 'consistent' ? 18 : evidenceCount ? 34 : 48;
  if (!comparison && !evidenceCount && /completed|partially completed|physical inspection/i.test(project.status || '')) score += 12;
  if (!comparison && !evidenceCount && /unsanctioned|action pending/i.test(project.status || '')) score += 6;
  if (!comparison && !evidenceCount && !String(project.amount || '').trim()) score += 5;
  if (feedback?.averageRating != null) score += Math.round((5 - Number(feedback.averageRating)) * 2);
  score += Math.min(Number(feedback?.commentCount || 0) + Number(feedback?.photoCount || 0), 3);
  const estimate = estimateProjectAmount(project);
  const variance = Math.abs(Number(estimate.variancePercent));
  if (Number.isFinite(variance) && variance > 25) score += Math.min(18, Math.round((variance - 25) * 0.24));
  score = Math.max(0, Math.min(100, score + Math.min(missing.length * 4, 16)));
  const label = score >= 75 ? 'High review priority' : score >= 50 ? 'Elevated review priority' : score >= 30 ? 'Moderate review priority' : 'Lower review priority';
  const reason = comparison?.consistency === 'inconsistent'
    ? comparison.summary || comparison.possibleIssues?.join(' ') || 'The AI comparison found fields that need human verification.'
    : comparison?.consistency === 'consistent'
      ? comparison.summary || 'Available evidence is broadly consistent with the source record.'
      : evidenceCount
        ? 'Evidence is available, but a full AI comparison has not been completed for this record.'
        : 'No image or PDF evidence is currently available. This is an evidence-coverage limitation, not proof of fraud.';
  const contributionCount = Number(feedback?.commentCount || 0) + Number(feedback?.photoCount || 0);
  const feedbackReason = feedback?.ratingCount ? ` Public feedback averages ${feedback.averageRating}/10 across ${feedback.ratingCount} rating${feedback.ratingCount === 1 ? '' : 's'} and includes ${contributionCount} field contribution${contributionCount === 1 ? '' : 's'}.` : '';
  const amountReason = estimate.variancePercent == null
    ? ` Amount comparison is unavailable because the source does not expose a usable allocated, sanctioned, or utilized amount. AI estimate: ${estimate.rangeFormatted}.`
    : ` AI-assisted amount estimate is ${estimate.formatted} (${estimate.rangeFormatted}); official ${estimate.observedAmountKind} amount is ${INR.format(estimate.observedAmountInr)} (${estimate.varianceLabel}). This variance is a review signal, not proof of fraud.`;
  return { score, label, reason: `${reason}${amountReason}${feedbackReason}`, confidence: Number(comparison?.confidence) || (comparison ? 25 : 10), basis: `${comparison ? 'AI evidence comparison plus source-field checks' : 'Source-field completeness and evidence availability; AI comparison pending'} plus description-cost estimate${feedback?.ratingCount ? ' and public feedback' : ''}` };
}

function exportRows(filters) {
  const projects = listProjects(filters).slice(Math.max(Number(filters.offset || 0), 0), Math.max(Number(filters.offset || 0), 0) + Math.min(Math.max(Number(filters.limit || 10000), 1), 10000));
  return projects.map((project) => {
    const evidenceLinks = [...(project.imageUrls || []), ...(project.attachmentIds || []).map((id) => attachmentProxyUrl(project.id, id))].filter(Boolean);
    const risk = riskIndex(project);
    const estimate = estimateProjectAmount(project);
    return { project_id: project.id, work_description: project.title, member_of_parliament: project.mp, house: project.house, term: project.term, state: project.state, district: project.district, constituency: project.constituency, village_or_area: project.villageRaw || project.villageNames?.join(' | '), category: project.category, status: project.status, recommended_amount: project.amount, ai_estimated_amount: estimate.formatted, ai_estimate_range: estimate.rangeFormatted, observed_amount: estimate.observedAmountInr ? INR.format(estimate.observedAmountInr) : '', amount_variance: estimate.varianceAmountInr == null ? '' : INR.format(estimate.varianceAmountInr), amount_variance_percent: estimate.variancePercent == null ? '' : `${estimate.variancePercent}%`, amount_estimate_reason: estimate.reason, source_date: project.sourceDate, review_index: `${risk.score}/100`, review_label: risk.label, review_reason: risk.reason, evidence_links: evidenceLinks.join(' | '), official_source: project.sourceUrl };
  });
}

const exportHeaders = ['project_id', 'work_description', 'member_of_parliament', 'house', 'term', 'state', 'district', 'constituency', 'village_or_area', 'category', 'status', 'recommended_amount', 'ai_estimated_amount', 'ai_estimate_range', 'observed_amount', 'amount_variance', 'amount_variance_percent', 'amount_estimate_reason', 'source_date', 'review_index', 'review_label', 'review_reason', 'evidence_links', 'official_source'];
function exportCell(value) { return `"${String(value ?? '').replace(/"/g, '""')}"`; }
function csvExport(rows) { return [exportHeaders.join(','), ...rows.map((row) => exportHeaders.map((header) => exportCell(row[header])).join(','))].join('\r\n'); }
function excelExport(rows) { const headings = exportHeaders.map((header) => `<th>${header.replace(/_/g, ' ')}</th>`).join(''); const body = rows.map((row) => `<tr>${exportHeaders.map((header) => `<td>${String(row[header] ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}</td>`).join('')}</tr>`).join(''); return `<!doctype html><html><head><meta charset="utf-8"><style>table{border-collapse:collapse}th,td{border:1px solid #ccd6df;padding:5px;vertical-align:top}th{background:#eaf2f7}</style></head><body><table><thead><tr>${headings}</tr></thead><tbody>${body}</tbody></table></body></html>`; }
function pdfText(value) { return String(value ?? '').replace(/[^\x20-\x7E]/g, '?').replace(/[\\()]/g, (character) => `\\${character}`).slice(0, 230); }
function pdfExport(rows) { const lines = ['MP Works data export', `Records: ${rows.length}`, 'Review index is a human-review signal, not a fraud probability or finding.', '']; rows.forEach((row, index) => { lines.push(`${index + 1}. ${pdfText(row.work_description)}`); lines.push(`MP: ${pdfText(row.member_of_parliament)} | ${pdfText(row.state)} | ${pdfText(row.district)} | ${pdfText(row.house)}`); lines.push(`Status: ${pdfText(row.status)} | Amount: ${pdfText(row.recommended_amount)} | Review: ${pdfText(row.review_index)} ${pdfText(row.review_label)}`); lines.push(`Evidence: ${pdfText(row.evidence_links || 'none')}`); lines.push(''); }); const pages = []; for (let index = 0; index < lines.length; index += 46) pages.push(lines.slice(index, index + 46)); const objects = []; objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'; objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'; const kids = []; pages.forEach((pageLines) => { const pageId = objects.length; objects.push(null); const contentId = objects.length; objects.push(null); kids.push(`${pageId} 0 R`); const commands = ['BT', '/F1 8 Tf', '40 770 Td', ...pageLines.map((line) => `(${pdfText(line)}) Tj 0 -16 Td`), 'ET'].join('\n'); objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`; objects[contentId] = `<< /Length ${Buffer.byteLength(commands, 'latin1')} >>\nstream\n${commands}\nendstream`; }); objects[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`; let output = '%PDF-1.4\n'; const offsets = [0]; for (let index = 1; index < objects.length; index += 1) { offsets[index] = Buffer.byteLength(output, 'latin1'); output += `${index} 0 obj\n${objects[index]}\nendobj\n`; } const xrefOffset = Buffer.byteLength(output, 'latin1'); output += `xref\n0 ${objects.length}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`; return Buffer.from(output, 'latin1'); }

function feedbackIpHash(request) { const forwarded = String(request.headers['x-forwarded-for'] || '').split(',')[0].trim(); const ip = forwarded || String(request.headers['x-real-ip'] || request.socket.remoteAddress || 'unknown').trim(); const salt = process.env.FEEDBACK_IP_SALT || process.env.SUPABASE_URL || 'mpworks-feedback'; return createHash('sha256').update(`${salt}|${ip}`).digest('hex'); }
function feedbackKey(projectKey, ipHash, kind) { return `${projectKey}|${ipHash}|${kind}`; }
async function feedbackRows(projectKey) { if (supabaseConfigured()) { try { return await supabaseSelect('project_public_feedback', `select=id,kind,ip_hash,comment,rating,r2_url,mime_type,created_at,updated_at,undone_at&project_key=eq.${encodeURIComponent(projectKey)}&order=created_at.desc&limit=200`); } catch { /* fall back for a deployment awaiting its migration */ } } return [...feedbackMemory.values()].filter((row) => row.project_key === projectKey); }
function feedbackSummary(projectKey, rows, ipHash) { const active = rows.filter((row) => !row.undone_at); const ratings = active.map((row) => Number(row.rating)).filter((rating) => Number.isInteger(rating)); return { projectId: projectKey, ratingCount: ratings.length, averageRating: ratings.length ? Math.round((ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length) * 10) / 10 : null, photoCount: active.filter((row) => row.kind === 'photo').length, commentCount: active.filter((row) => row.kind === 'comment' && row.comment).length, photos: active.filter((row) => row.kind === 'photo' && row.r2_url).slice(0, 20).map((row) => ({ url: row.r2_url, createdAt: row.created_at })), comments: active.filter((row) => row.kind === 'comment' && row.comment).slice(0, 20).map((row) => ({ comment: row.comment, createdAt: row.created_at })), viewer: { photo: Boolean(rows.find((row) => row.kind === 'photo' && row.ip_hash === ipHash)), comment: Boolean(rows.find((row) => row.kind === 'comment' && row.ip_hash === ipHash)), rating: Boolean(rows.find((row) => row.kind === 'rating' && row.ip_hash === ipHash)) } }; }
async function allFeedbackRows() { if (supabaseConfigured()) { try { return await supabaseSelect('project_public_feedback', 'select=project_key,kind,rating,undone_at&limit=10000'); } catch { /* feedback migration may still be pending */ } } return [...feedbackMemory.values()]; }
async function feedbackAggregates(projects) { const wanted = new Set(projects.map((project) => project.id)); const rows = (await allFeedbackRows()).filter((row) => wanted.has(row.project_key)); const groups = new Map(); for (const row of rows) { if (row.undone_at) continue; const current = groups.get(row.project_key) || { ratingCount: 0, ratingTotal: 0, photoCount: 0, commentCount: 0 }; if (row.kind === 'rating' && Number.isInteger(Number(row.rating))) { current.ratingCount += 1; current.ratingTotal += Number(row.rating); } if (row.kind === 'photo') current.photoCount += 1; if (row.kind === 'comment') current.commentCount += 1; groups.set(row.project_key, current); } return new Map([...groups].map(([key, value]) => [key, { ...value, averageRating: value.ratingCount ? Math.round((value.ratingTotal / value.ratingCount) * 10) / 10 : null }])); }
async function publicProjects(projects, sort = '') { const aggregates = await feedbackAggregates(projects); const rows = projects.map((project) => publicProject(project, aggregates.get(project.id))); const direction = String(sort || '').toLowerCase(); if (direction === 'risk-desc' || direction === 'fraud-desc') rows.sort((a, b) => Number(b.riskIndex?.score || 0) - Number(a.riskIndex?.score || 0)); if (direction === 'risk-asc' || direction === 'fraud-asc') rows.sort((a, b) => Number(a.riskIndex?.score || 0) - Number(b.riskIndex?.score || 0)); if (direction === 'evidence-desc') rows.sort((a, b) => Number(b.attachmentCount || 0) - Number(a.attachmentCount || 0)); return rows; }
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
    const page = filtered.slice(offset, offset + limit);
    return sendJson(response, 200, { data: await publicProjects(page, filters.sort), meta: { count: Math.min(limit, Math.max(filtered.length - offset, 0)), total: filtered.length, limit, offset, hasMore: offset + limit < filtered.length, queryVersion: `works-${kind}-v0.1` }, provenance: getSourceMetadata() });
  }
  if (request.method === 'GET' && url.pathname === '/api/works/summary') {
    const filters = filtersFrom(url);
    const scoped = listProjects(filters);
    return sendJson(response, 200, { data: { recommended: scoped.length, completed: scoped.filter((project) => /completed|partially completed/i.test(project.status)).length, total: scoped.length, filters }, provenance: getSourceMetadata() });
  }
  const exportMatch = url.pathname.match(/^\/api\/exports\/(csv|excel|xls|pdf)$/i);
  if (request.method === 'GET' && exportMatch) {
    const format = exportMatch[1].toLowerCase();
    const requestedLimit = Number(url.searchParams.get('limit') || 10000);
    const exportLimit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.floor(requestedLimit), 1), 10000) : 10000;
    const exportOffset = Math.max(Number(url.searchParams.get('offset') || 0), 0);
    const rows = exportRows({ ...filtersFrom(url), limit: exportLimit, offset: exportOffset });
    const body = format === 'pdf' ? pdfExport(rows) : Buffer.from(format === 'csv' ? csvExport(rows) : excelExport(rows), 'utf8');
    const contentType = format === 'pdf' ? 'application/pdf' : format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.ms-excel; charset=utf-8';
    const extension = format === 'pdf' ? 'pdf' : format === 'csv' ? 'csv' : 'xls';
    response.writeHead(200, { 'Content-Type': contentType, 'Content-Length': body.length, 'Content-Disposition': `attachment; filename="mpworks-export-${new Date().toISOString().slice(0, 10)}.${extension}"`, 'Access-Control-Allow-Origin': '*', 'X-Export-Limit': String(exportLimit), 'X-Export-Offset': String(exportOffset) });
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
    const filters = filtersFrom(url);
    const member = getMember(memberProjectsMatch[1], filters);
    if (!member) return sendJson(response, 404, { error: 'member_not_found' });
    const projects = listProjects(filters).filter((project) => member.projectIds?.includes(project.id));
    const offset = Math.max(Number(url.searchParams.get('offset') || 0), 0);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 50), 1), 200);
    const page = projects.slice(offset, offset + limit);
    return sendJson(response, 200, { data: await publicProjects(page, filters.sort), meta: { count: Math.min(limit, Math.max(projects.length - offset, 0)), total: projects.length, limit, offset, hasMore: offset + limit < projects.length }, member });
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
    const filters = filtersFrom(url);
    const filtered = listProjects(filters);
    const requestedLimit = Number(url.searchParams.get('limit') || 50);
    const requestedOffset = Number(url.searchParams.get('offset') || 0);
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.floor(requestedLimit), 1), 200) : 50;
    const offset = Number.isFinite(requestedOffset) ? Math.max(Math.floor(requestedOffset), 0) : 0;
    const page = filtered.slice(offset, offset + limit);
    const projects = await publicProjects(page, filters.sort);
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
    if (current && ['processing', 'fetching', 'analyzing'].includes(current.status)) return sendJson(response, 202, { data: { projectId: project.id, ...evidenceJobPayload(current) } });
    void runEvidenceJob(project);
    return sendJson(response, 202, { data: { projectId: project.id, status: 'processing', note: 'Evidence fetching and AI analysis has started. This page will update automatically.', files: [], images: [], documents: [], comparison: { status: 'queued', reason: 'Evidence analysis is running.' }, persistence: { r2: 'pending', supabase: 'pending', stored: [], warnings: [] } } });
  }

  const locationMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/evidence\/location$/);
  if (locationMatch && request.method === 'GET') {
    const project = getProject(decodeURIComponent(locationMatch[1]));
    if (!project) return sendJson(response, 404, { error: 'project_not_found' });
    const location = await findPhotoGps(project);
    return sendJson(response, 200, { data: location || { coordinates: null, message: 'The available evidence images do not contain readable GPS coordinates.' } });
  }

  const attachmentMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/evidence\/attachment\/([^/]+)$/);
  if (attachmentMatch && request.method === 'GET') {
    const project = getProject(decodeURIComponent(attachmentMatch[1]));
    if (!project) return sendJson(response, 404, { error: 'project_not_found' });
    try {
      const attachmentId = decodeURIComponent(attachmentMatch[2]);
      const attachment = await fetchStoredDocumentBinary(attachmentId) || await fetchAttachmentBinary(attachmentId);
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
      const feedback = feedbackSummary(project.id, await feedbackRows(project.id), null);
      const job = evidenceJobPayload(evidenceJobs.get(project.id));
      if (job) return sendJson(response, 200, { data: { projectId: project.id, ...job, items: evidenceItemsForProject(project, job.files.length || job.attachmentIds.length), attachmentCount: job.files.length || job.attachmentIds.length, imageUrls: job.files.map((file) => file.url).filter(Boolean), sourceUrl: project.sourceUrl, fetchTimestamp: project.fetchTimestamp } });
      const files = (project.attachmentCandidates || []).filter((file) => !isQuarantinedLiveEvidence(project, file.attachmentId || file.sourceAttachmentId)).map(({ localPath, ...file }) => ({ ...file, sourceAttachmentId: file.attachmentId || file.sourceAttachmentId || null, status: file.r2Url ? 'stored' : 'discovered' }));
      const publicFiles = files.map((file) => ({ ...file, url: publicEvidenceUrl(project.id, file) }));
      if (!publicFiles.length && !project.attachmentIds.length) void runEvidenceJob(project);
      const queued = evidenceJobPayload(evidenceJobs.get(project.id));
      if (queued) return sendJson(response, 200, { data: { projectId: project.id, ...queued, items: evidenceItemsForProject(project, queued.files.length || queued.attachmentIds.length), attachmentCount: queued.files.length || queued.attachmentIds.length, imageUrls: queued.files.map((file) => file.url).filter(Boolean), sourceUrl: project.sourceUrl, fetchTimestamp: project.fetchTimestamp } });
      const sourceRefs = project.attachmentIds.map((id) => ({ id }));
      const cachedComparison = publicFiles.length ? await storedProjectComparison(project) : null;
      return sendJson(response, 200, { data: { projectId: project.id, status: publicFiles.length ? cachedComparison ? 'analyzed' : 'available' : 'not-available', liveSourceWorkId: null, attachmentIds: sourceRefs.map((item) => item.id).filter(Boolean), items: evidenceItemsForProject(project, publicFiles.length || sourceRefs.length), signals: project.signals, riskIndex: riskIndex(project, cachedComparison, publicFiles.length || sourceRefs.length, feedback), comparison: cachedComparison || { status: 'queued', reason: publicFiles.length ? 'Evidence is available; AI comparison has not been completed for this record.' : 'No evidence comparison is available.' }, publicFeedback: feedback, files: publicFiles, images: publicFiles.filter((file) => file.mimeType?.startsWith('image/')), documents: publicFiles.filter((file) => file.mimeType === 'application/pdf'), imageUrls: publicFiles.map((file) => file.url).filter(Boolean), attachmentCount: publicFiles.length || sourceRefs.length, sourceUrl: project.sourceUrl, fetchTimestamp: project.fetchTimestamp } });
    }
    const feedback = feedbackSummary(project.id, await feedbackRows(project.id), null);
    return sendJson(response, 200, { data: { ...project, amountEstimate: estimateProjectAmount(project), riskIndex: riskIndex(project, null, undefined, feedback), publicFeedback: feedback } });
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
