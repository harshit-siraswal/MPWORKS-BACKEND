import { createServer } from 'node:http';
import { listProjects, getProject, getSummary, getSourceHealth, getFacets, getSourceMetadata } from './catalog.js';
import { fetchAndAnalyzeAttachments, fetchAndAnalyzeImages } from './image-analysis.js';

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
    category: url.searchParams.get('category'),
    status: url.searchParams.get('status')
  };
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
  if (request.method === 'GET' && url.pathname === '/api/source-health') return sendJson(response, 200, { data: getSourceHealth() });
  if (request.method === 'GET' && url.pathname === '/api/methodology') return sendJson(response, 200, { data: { riskLanguage: 'Risk indicators prioritize human review and are not conclusions.', methods: ['source-record-retention', 'optional-image-metadata-and-similarity'], caveats: ['Image coverage is source-dependent.', 'Coordinates are never silently invented. The map uses an explicitly labelled district approximation only.', 'No risk score is calculated until sufficient evidence is available.'], source: getSourceMetadata() } });

  if (request.method === 'GET' && url.pathname === '/api/projects') {
    const filtered = listProjects(filtersFrom(url));
    const requestedLimit = Number(url.searchParams.get('limit') || 50);
    const requestedOffset = Number(url.searchParams.get('offset') || 0);
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.floor(requestedLimit), 1), 200) : 50;
    const offset = Number.isFinite(requestedOffset) ? Math.max(Math.floor(requestedOffset), 0) : 0;
    const projects = filtered.slice(offset, offset + limit).map(({ raw, normalized, evidenceItems, signals, attachmentCandidates, imageUrls, attachmentIds, ...project }) => ({ ...project, imageCount: imageUrls.length, attachmentCount: attachmentIds.length }));
    return sendJson(response, 200, { data: projects, meta: { count: projects.length, total: filtered.length, limit, offset, hasMore: offset + projects.length < filtered.length, queryVersion: 'catalog-search-v0.2', sourceUpdatedAt: getSourceHealth().sourceFileUpdatedAt } });
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
    const evidence = project.imageUrls.length
      ? await fetchAndAnalyzeImages(project.imageUrls)
      : await fetchAndAnalyzeAttachments(project.attachmentIds, attachmentOrigin);
    return sendJson(response, 200, { data: { projectId: project.id, ...evidence, status: evidence.images.length ? 'analyzed' : 'not-available', note: evidence.images.length ? 'Image metadata and perceptual hashes were calculated from source URLs.' : 'The source record contains no image URL or attachment identifier.' } });
  }

  const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)(?:\/(evidence|reports))?$/);
  if (projectMatch && request.method === 'GET') {
    const project = getProject(projectMatch[1]);
    if (!project) return sendJson(response, 404, { error: 'project_not_found' });
    if (projectMatch[2] === 'evidence') return sendJson(response, 200, { data: { projectId: project.id, items: project.evidenceItems, signals: project.signals, imageUrls: project.imageUrls, sourceUrl: project.sourceUrl, fetchTimestamp: project.fetchTimestamp } });
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

server.listen(port, '127.0.0.1', () => console.log(`MPLAD Intelligence API listening on http://127.0.0.1:${port}`));
