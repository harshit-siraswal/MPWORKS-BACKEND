import { createServer } from 'node:http';
import { attachmentIdsFromReferenceRows, getAttachment, getAttachmentReferences, getStates, getTenures, getWorkReport, getMetrics as getLiveMetrics } from './esakshi-source.js';
import { listProjects, getProject, getSummary, getSourceHealth, getFacets, getSourceMetadata, getMetrics, getVillages, getMembers, getMember } from './catalog.js';
import { analyzeStoredAttachments, fetchAndAnalyzeAttachments, fetchAndAnalyzeImages } from './image-analysis.js';
import { analyzeEvidenceAgainstProject } from './evidence-analysis.js';
import { persistEvidence } from './persistence/evidence.js';
import { getDistrictAnalysis, startDistrictAnalysis } from './district-analysis.js';

const port = Number(process.env.PORT || 8000);
const geocodeCache = new Map();
const memberImageCache = new Map();
const recoveredSourceCache = new Map();

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
    const page = pages.find((candidate) => candidate.thumbnail?.source && candidate.title?.toLowerCase().includes(member.name.split(' ')[0].toLowerCase())) || pages.find((candidate) => candidate.thumbnail?.source);
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
  return { ...safeProject, imageCount: imageUrls.length, attachmentCount: attachmentIds.length };
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
    try {
      const recovered = await recoverSourceProject(project);
      const sourceProject = recovered ? { ...project, raw: recovered.raw, attachmentIds: [], attachmentCandidates: project.attachmentCandidates || [] } : project;
      const sourceRefs = recovered ? await attachmentIdsFor(project, recovered.raw) : (sourceProject.attachmentCandidates?.length ? [] : project.attachmentIds.map((id) => ({ id })));
      sourceProject.attachmentIds = sourceRefs.map((item) => item.id).filter(Boolean);
      const attachmentOrigin = process.env.MPLADS_API_ORIGIN || 'https://mplads.mospi.gov.in';
      let evidence = sourceProject.attachmentCandidates?.length ? await analyzeStoredAttachments(sourceProject.attachmentCandidates) : null;
      if (!evidence?.files.length) {
        evidence = sourceRefs.length
          ? await fetchAndAnalyzeAttachments(sourceProject.attachmentIds, attachmentOrigin)
          : sourceProject.imageUrls.length
          ? await fetchAndAnalyzeImages(sourceProject.imageUrls)
          : await fetchAndAnalyzeAttachments(sourceProject.attachmentIds, attachmentOrigin);
      }
      let comparison = { status: 'inconclusive', reason: 'No image or PDF evidence was fetched' };
      let persistence = { r2: 'not-configured', supabase: 'not-configured', stored: [], warnings: [] };
      if (evidence.files.length) {
        try { comparison = await analyzeEvidenceAgainstProject(project, evidence.files); } catch (error) { comparison = { status: 'error', reason: error.message }; }
        try { persistence = await persistEvidence(sourceProject, evidence.files, comparison); } catch (error) { persistence = { r2: 'error', supabase: 'error', stored: [], warnings: [error.message] }; }
      }
      const files = publicEvidenceForProject(evidence, project.id);
      const note = evidence.files.length
        ? 'Source evidence was fetched. Image/PDF bytes were compared with the project metadata; AI findings are triage signals for human review, not a fraud finding.'
        : sourceProject.attachmentIds.length ? 'The official source returned attachment identifiers, but no readable image or PDF payload was returned.' : 'The live source record does not expose an image or PDF attachment identifier.';
      return sendJson(response, 200, { data: { projectId: project.id, liveSourceWorkId: recovered?.sourceId || null, attachmentIds: sourceProject.attachmentIds, ...files, comparison, persistence, status: evidence.files.length ? 'analyzed' : 'not-available', note } });
    } catch (error) {
      return sendJson(response, 503, { error: 'evidence_refresh_unavailable', detail: error.message, note: 'The official source or storage service was temporarily unavailable. Retry this record; no mock evidence was substituted.' });
    }
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

  const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)(?:\/(evidence|reports))?$/);
  if (projectMatch && request.method === 'GET') {
    const project = getProject(projectMatch[1]);
    if (!project) return sendJson(response, 404, { error: 'project_not_found' });
    if (projectMatch[2] === 'evidence') {
      const files = (project.attachmentCandidates || []).map(({ localPath, ...file }) => ({ ...file, sourceAttachmentId: file.attachmentId || file.sourceAttachmentId || null, status: file.r2Url ? 'stored' : 'discovered' }));
      const recovered = files.length || project.attachmentIds.length ? null : await recoverSourceProject(project);
      const sourceRefs = recovered ? await attachmentIdsFor(project, recovered.raw) : project.attachmentIds.map((id) => ({ id }));
      const publicFiles = files.map((file) => ({ ...file, url: file.r2Url || (file.sourceAttachmentId ? attachmentProxyUrl(project.id, file.sourceAttachmentId) : file.sourceUrl) }));
      return sendJson(response, 200, { data: { projectId: project.id, liveSourceWorkId: recovered?.sourceId || null, attachmentIds: sourceRefs.map((item) => item.id).filter(Boolean), items: evidenceItemsForProject(project, publicFiles.length || sourceRefs.length), signals: project.signals, files: publicFiles, images: publicFiles.filter((file) => file.mimeType?.startsWith('image/')), documents: publicFiles.filter((file) => file.mimeType === 'application/pdf'), imageUrls: publicFiles.map((file) => file.url).filter(Boolean), attachmentCount: publicFiles.length || sourceRefs.length, sourceUrl: project.sourceUrl, fetchTimestamp: project.fetchTimestamp } });
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
