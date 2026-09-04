import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

const pdfBase64 = Buffer.from('%PDF-1.4\nMPWORKS evidence fixture\n').toString('base64');

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function readRequestBody(request) {
  let body = '';
  for await (const chunk of request) body += chunk;
  return body;
}

async function createApiStub({ attachmentRefs = [], attachmentPayload = true } = {}) {
  const requests = [];
  const api = await listen(async (request, response) => {
    const body = await readRequestBody(request);
    requests.push({ method: request.method, url: request.url, body });
    response.setHeader('Content-Type', 'application/json');

    if (request.url === '/rest/PreLoginDashboardData/getAttachIdsbyFlag') {
      response.end(JSON.stringify(attachmentRefs));
      return;
    }
    if (request.url === '/rest/PreLoginCitizenWorkRcmdRest/getAttachmentById') {
      response.end(JSON.stringify(attachmentPayload ? [{ DATA: `data:application/pdf;base64,${pdfBase64}`, FILE_NAME: 'completion.pdf' }] : []));
      return;
    }
    if (request.url === '/rest/PreLoginDashboardData/getStateData') {
      response.end(JSON.stringify([]));
      return;
    }
    if (request.url === '/rest/PreLoginDashboardData/getTenureData') {
      response.end(JSON.stringify([]));
      return;
    }
    if (request.url === '/rest/PreLoginDashboardData/getTilesReportData') {
      response.end(JSON.stringify([]));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'unexpected fixture request' }));
  });
  return { ...api, requests };
}

async function createR2Stub() {
  const uploads = [];
  const r2 = await listen(async (request, response) => {
    const body = [];
    for await (const chunk of request) body.push(chunk);
    uploads.push({ method: request.method, url: request.url, body: Buffer.concat(body) });
    response.statusCode = 200;
    response.end('');
  });
  return { ...r2, uploads };
}

async function requestJson(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  return { status: response.status, body: await response.json() };
}

async function waitForEvidence(baseUrl, projectId, expectedStatus) {
  const deadline = Date.now() + 5_000;
  let latest;
  while (Date.now() < deadline) {
    latest = await requestJson(baseUrl, `/api/projects/${encodeURIComponent(projectId)}/evidence`);
    if (latest.body.data.status === expectedStatus) return latest.body.data;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`evidence job did not reach ${expectedStatus}: ${JSON.stringify(latest?.body)}`);
}

function serverEnv(overrides) {
  const env = { ...process.env, ...overrides };
  for (const key of ['GEMINI_API_KEY', 'SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY']) delete env[key];
  return env;
}

async function startApp(env) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: new URL('..', import.meta.url),
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start\nstdout: ${stdout}\nstderr: ${stderr}`)), 5_000);
    child.stdout.on('data', () => {
      if (stdout.includes('MPLAD Intelligence API listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => {
      if (code !== null) {
        clearTimeout(timer);
        reject(new Error(`server exited before startup (${code})\nstdout: ${stdout}\nstderr: ${stderr}`));
      }
    });
  });
  return { child, stop: () => child.kill() };
}

async function writeSnapshotCatalog(directory) {
  const csv = [
    '"MP NAME";"WORK";"CATEGORY";"STATE";"CONSTITUENCY";"IDA";"CITY";"WARD";"BLOCK";"VILLAGE";"RECOMMENDED DATE";"ALLOCATION AMOUNT";"IDA APPROVAL";"STATUS";"HOUSE"',
    '"Test MP";"NA - Evidence test";"Roads";"Test State";"TEST";"DISTRICT TEST_IDA";"";"";"Test Block";"Test Village";"2024-01-01";"100000";"Approved";"Completed";"Lok Sabha"'
  ].join('\n');
  const path = join(directory, 'catalog.csv');
  await writeFile(path, csv, 'utf8');
  return path;
}

test('evidence jobs return persisted R2 URLs and never expose SHA-256 hashes as proxy IDs', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mpworks-evidence-r2-'));
  const api = await createApiStub({ attachmentRefs: [{ ATTACH_ID: 'upstream-attachment-42', FILE_NAME: 'completion.pdf' }] });
  const r2 = await createR2Stub();
  const catalogPath = await writeSnapshotCatalog(directory);
  const port = await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const value = probe.address().port; probe.close(() => resolve(value)); });
  });
  const app = await startApp(serverEnv({
    HOST: '127.0.0.1',
    PORT: String(port),
    MPLADS_CATALOG_PATH: catalogPath,
    MPLADS_API_ORIGIN: api.baseUrl,
    MPLADS_MIN_INTERVAL_MS: '0',
    MPWORKS_ENV_FILE: join(directory, 'no-secrets.env'),
    R2_ENDPOINT: r2.baseUrl,
    R2_BUCKET: 'fixture-bucket',
    R2_ACCESS_KEY_ID: 'fixture-access-key',
    R2_SECRET_ACCESS_KEY: 'fixture-secret-key',
    R2_PUBLIC_BASE_URL: 'https://cdn.fixture.test'
  }));
  t.after(async () => {
    app.stop();
    await Promise.all([new Promise((resolve) => api.server.close(resolve)), new Promise((resolve) => r2.server.close(resolve))]);
    await rm(directory, { recursive: true, force: true });
  });

  const projectResponse = await requestJson(`http://127.0.0.1:${port}`, '/api/projects?limit=1');
  const projectId = projectResponse.body.data[0].id;
  assert.equal((await requestJson(`http://127.0.0.1:${port}`, `/api/projects/${projectId}/evidence/refresh`, { method: 'POST' })).status, 202);
  const evidence = await waitForEvidence(`http://127.0.0.1:${port}`, projectId, 'analyzed');

  assert.equal(evidence.attachmentIds[0], 'upstream-attachment-42');
  assert.equal(evidence.files.length, 1);
  const [file] = evidence.files;
  assert.equal(file.sourceAttachmentId, 'upstream-attachment-42');
  assert.match(file.sha256, /^[0-9a-f]{64}$/);
  assert.equal(file.url, file.r2Url);
  assert.match(file.url, /^https:\/\/cdn\.fixture\.test\/mplads\/evidence\//);
  assert.doesNotMatch(file.url, new RegExp(`/evidence/attachment/${file.sha256}$`));
  assert.equal(evidence.persistence.stored[0].r2Url, file.r2Url);
  assert.equal(r2.uploads.length, 1);
}, { concurrency: false });

test('live evidence discovery does not scan full state reports after empty direct lookup', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mpworks-evidence-live-'));
  const api = await createApiStub({ attachmentRefs: [], attachmentPayload: false });
  const liveRoot = join(directory, 'live');
  await mkdir(liveRoot, { recursive: true });
  await writeFile(join(liveRoot, 'projects.ndjson'), `${JSON.stringify({ sourceWorkId: '4242', term: '18th Lok Sabha', houseCode: '2', state: 'Test State', district: 'Test District', constituency: 'Test Constituency', mp: 'Test MP', activityName: 'Live evidence test', description: 'A live work', flag: 3, fileStatus: true })}\n`, 'utf8');
  await writeFile(join(liveRoot, 'attachments.ndjson'), '', 'utf8');
  const catalogPath = await writeSnapshotCatalog(directory);
  const port = await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const value = probe.address().port; probe.close(() => resolve(value)); });
  });
  const app = await startApp(serverEnv({
    HOST: '127.0.0.1',
    PORT: String(port),
    MPLADS_CATALOG_PATH: catalogPath,
    MPLADS_LIVE_ROOT: liveRoot,
    MPLADS_API_ORIGIN: api.baseUrl,
    MPLADS_MIN_INTERVAL_MS: '0',
    MPWORKS_ENV_FILE: join(directory, 'no-secrets.env')
  }));
  t.after(async () => {
    app.stop();
    await Promise.all([new Promise((resolve) => api.server.close(resolve)), rm(directory, { recursive: true, force: true })]);
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const projectId = 'live-4242-2-0';
  assert.equal((await requestJson(baseUrl, `/api/projects/${projectId}/evidence/refresh`, { method: 'POST' })).status, 202);
  const evidence = await waitForEvidence(baseUrl, projectId, 'not-available');

  const paths = api.requests.map(({ url }) => url);
  assert.equal(paths.filter((url) => url === '/rest/PreLoginDashboardData/getAttachIdsbyFlag').length, 2);
  assert.equal(paths.filter((url) => url === '/rest/PreLoginDashboardData/getStateData').length, 0);
  assert.equal(paths.filter((url) => url === '/rest/PreLoginDashboardData/getTenureData').length, 0);
  assert.equal(paths.filter((url) => url === '/rest/PreLoginDashboardData/getTilesReportData').length, 0);
  assert.equal(evidence.attachmentIds.length, 0);
}, { concurrency: false });
