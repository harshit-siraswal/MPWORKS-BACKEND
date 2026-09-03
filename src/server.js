import { createServer } from 'node:http';
import { listProjects, getProject, getSummary, getSourceHealth, getFacets, getSourceMetadata } from './catalog.js';

const port = Number(process.env.PORT || 8000);

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

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (request.method === 'OPTIONS') return sendJson(response, 204, {});

  if (request.method === 'GET' && url.pathname === '/api/health') return sendJson(response, 200, { status: 'ok', service: 'mplad-intelligence-api', version: '0.1.0' });
  if (request.method === 'GET' && url.pathname === '/api/catalog/summary') return sendJson(response, 200, { data: getSummary(), provenance: { queryVersion: 'summary-v0.1', generatedAt: new Date().toISOString() } });
  if (request.method === 'GET' && url.pathname === '/api/catalog/facets') return sendJson(response, 200, { data: getFacets(), provenance: getSourceMetadata() });
  if (request.method === 'GET' && url.pathname === '/api/source-health') return sendJson(response, 200, { data: getSourceHealth() });
  if (request.method === 'GET' && url.pathname === '/api/methodology') return sendJson(response, 200, { data: { riskLanguage: 'Risk indicators prioritize human review and are not conclusions.', methods: ['source-record-retention'], caveats: ['This source snapshot contains no image attachments.', 'Coordinates are never silently invented.', 'No risk score is calculated until sufficient evidence is available.'], source: getSourceMetadata() } });

  if (request.method === 'GET' && url.pathname === '/api/projects') {
    const filtered = listProjects({ query: url.searchParams.get('query'), state: url.searchParams.get('state'), district: url.searchParams.get('district'), category: url.searchParams.get('category') });
    const requestedLimit = Number(url.searchParams.get('limit') || 12);
    const requestedOffset = Number(url.searchParams.get('offset') || 0);
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.floor(requestedLimit), 1), 100) : 12;
    const offset = Number.isFinite(requestedOffset) ? Math.max(Math.floor(requestedOffset), 0) : 0;
    const projects = filtered.slice(offset, offset + limit).map(({ raw, normalized, evidenceItems, signals, ...project }) => project);
    return sendJson(response, 200, { data: projects, meta: { count: projects.length, total: filtered.length, limit, offset, hasMore: offset + projects.length < filtered.length, queryVersion: 'catalog-search-v0.1', sourceUpdatedAt: getSourceHealth().sourceFileUpdatedAt } });
  }

  const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)(?:\/(evidence|reports))?$/);
  if (projectMatch && request.method === 'GET') {
    const project = getProject(projectMatch[1]);
    if (!project) return sendJson(response, 404, { error: 'project_not_found' });
    if (projectMatch[2] === 'evidence') return sendJson(response, 200, { data: { projectId: project.id, items: project.evidenceItems, signals: project.signals, sourceUrl: project.sourceUrl, fetchTimestamp: project.fetchTimestamp } });
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
