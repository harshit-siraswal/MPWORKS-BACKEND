import { createServer } from 'node:http';
import { listProjects, getProject, getSummary, getSourceHealth, getFacets, getSourceMetadata, getMetrics, getVillages } from './catalog.js';
import { getMetrics as getLiveMetrics } from './esakshi-source.js';
import { analyzeStoredAttachments, fetchAndAnalyzeAttachments, fetchAndAnalyzeImages } from './image-analysis.js';
import { analyzeEvidenceAgainstProject } from './evidence-analysis.js';
import { persistEvidence } from './persistence/evidence.js';
import { getDistrictAnalysis, startDistrictAnalysis } from './district-analysis.js';

const port = Number(process.env.PORT || 8000);
const geocodeCache = new Map();

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

function publicEvidence(evidence) {
  const files = (evidence.files || []).map(({ buffer, ...file }) => file);
  return { ...evidence, files, images: files.filter((file) => file.mimeType?.startsWith('image/')), documents: files };
}

function publicProject(project) {
  const { raw, normalized, evidenceItems, signals, attachmentCandidates, imageUrls, attachmentIds, ...safeProject } = project;
  return { ...safeProject, imageCount: imageUrls.length, attachmentCount: attachmentIds.length };
}

function amountFromProject(project, field, normalizedField) {
  const value = project.raw?.[field] ?? project.normalized?.[normalizedField];
  const amount = Number(String(value ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(amount) ? amount : 0;
}

function districtMetrics(filters) {
  const metrics = getMetrics(filters);
  const scoped = listProjects(filters);
  metrics.sanctionedAmount = scoped.reduce((sum, project) => sum + amountFromProject(project, 'SANCTION_AMOUNT', 'sanctionAmountInr'), 0) || null;
  metrics.usedAmount = scoped.reduce((sum, project) => sum + amountFromProject(project, 'ACTUAL_AMOUNT', 'usedAmountInr'), 0) || null;
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

  const refreshMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/evidence\/refresh$/);
  if (refreshMatch && request.method === 'POST') {
    const project = getProject(refreshMatch[1]);
    if (!project) return sendJson(response, 404, { error: 'project_not_found' });
    const attachmentOrigin = process.env.MPLADS_API_ORIGIN || 'https://mplads.gov.in';
    const evidence = project.attachmentCandidates?.length
      ? await analyzeStoredAttachments(project.attachmentCandidates)
      : project.imageUrls.length
      ? await fetchAndAnalyzeImages(project.imageUrls)
      : await fetchAndAnalyzeAttachments(project.attachmentIds, attachmentOrigin);
    let comparison = { status: 'inconclusive', reason: 'No image or PDF evidence was fetched' };
    let persistence = { r2: 'not-configured', supabase: 'not-configured', stored: [], warnings: [] };
    if (evidence.files.length) {
      try { comparison = await analyzeEvidenceAgainstProject(project, evidence.files); } catch (error) { comparison = { status: 'error', reason: error.message }; }
      try { persistence = await persistEvidence(project, evidence.files, comparison); } catch (error) { persistence = { r2: 'error', supabase: 'error', stored: [], warnings: [error.message] }; }
    }
    const files = publicEvidence(evidence);
    const note = evidence.files.length
      ? 'Source evidence was fetched. Image/PDF bytes were compared with the project metadata; AI findings are triage signals for human review, not a fraud finding.'
      : 'The selected source record contains no image or PDF attachment identifier.';
    return sendJson(response, 200, { data: { projectId: project.id, ...files, comparison, persistence, status: evidence.files.length ? 'analyzed' : 'not-available', note } });
  }

  const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)(?:\/(evidence|reports))?$/);
  if (projectMatch && request.method === 'GET') {
    const project = getProject(projectMatch[1]);
    if (!project) return sendJson(response, 404, { error: 'project_not_found' });
    if (projectMatch[2] === 'evidence') return sendJson(response, 200, { data: { projectId: project.id, items: project.evidenceItems, signals: project.signals, imageUrls: project.imageUrls, attachmentCount: project.attachmentIds.length, sourceUrl: project.sourceUrl, fetchTimestamp: project.fetchTimestamp } });
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
