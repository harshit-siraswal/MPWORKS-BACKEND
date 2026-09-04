import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { putR2Object, r2Configured } from '../src/persistence/r2.js';
import { supabaseConfigured, supabaseInsert, supabaseUpdate, supabaseUpsert } from '../src/persistence/supabase.js';

const exec = promisify(execFile);
const rawRoot = join(process.cwd(), 'data', 'raw', 'esakshi');
const parserVersion = 'esakshi-agent-v0.2.0';
const sourceUrl = process.env.MPLADS_SOURCE_URL || 'https://mplads.mospi.gov.in/digigov/dashboard.html';
const contentTypeFor = (filePath) => ({ '.json': 'application/json', '.ndjson': 'application/x-ndjson', '.csv': 'text/csv' }[extname(filePath).toLowerCase()] || 'application/octet-stream');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const datePart = (value) => new Date(value).toISOString().slice(0, 10);

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const filePath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(filePath));
    else files.push(filePath);
  }
  return files;
}

function requireConfig() {
  if (!supabaseConfigured()) throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY are required for the ingestion agent');
  if (!r2Configured()) throw new Error('R2_ACCOUNT_ID or R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are required for the ingestion agent');
}

async function main() {
  if (process.argv.includes('--dry-run')) {
    console.log(JSON.stringify({ sourceUrl, bucket: process.env.R2_BUCKET || 'studyshare', publicBaseUrl: process.env.R2_PUBLIC_BASE_URL || null, rawPrefix: 'mplads/raw/', configured: supabaseConfigured() && r2Configured() }, null, 2));
    return;
  }
  requireConfig();

  const startedAt = new Date().toISOString();
  const snapshot = (await supabaseInsert('source_snapshots', {
    source_name: 'eSAKSHI MPLADS', source_url: sourceUrl, parser_version: parserVersion, manifest: { status: 'running', startedAt }
  }))[0];
  const run = (await supabaseInsert('ingest_runs', { snapshot_id: snapshot.id, status: 'running', stats: { parserVersion } }))[0];
  const discoverJob = (await supabaseInsert('ingest_jobs', { run_id: run.id, job_type: 'discover', status: 'running', payload: { sourceUrl }, attempt_count: 1, locked_at: startedAt }))[0];

  try {
    if (!process.argv.includes('--from-existing')) {
      const fetchArgs = ['scripts/fetch-esakshi.mjs'];
      if (process.argv.includes('--without-attachments') || String(process.env.MPLADS_WITHOUT_ATTACHMENTS).toLowerCase() === 'true') fetchArgs.push('--without-attachments');
      await exec(process.execPath, fetchArgs, { cwd: process.cwd(), env: process.env, maxBuffer: 50 * 1024 * 1024 });
    } else {
      console.log('Reusing existing collector output from data/raw/esakshi.');
    }
    const manifest = JSON.parse(await readFile(join(rawRoot, 'manifest.json'), 'utf8'));
    const partitionRows = (manifest.partitions?.length ? manifest.partitions : [{ partitionKey: 'all-configured-scopes', houseCode: null, tenureId: null, tenure: null, stateSourceId: null, stateName: null, status: 'completed', counts: {} }]).map((partition) => ({
      run_id: run.id, partition_key: partition.partitionKey, house_code: partition.houseCode || 'unknown', tenure_id: partition.tenureId || null, tenure: partition.tenure || null, state_source_id: partition.stateSourceId || null, state_name: partition.stateName || null, status: partition.status === 'completed' ? 'completed' : partition.status === 'failed' ? 'failed' : 'partial', attempt_count: 1, counts: partition.counts || {}, last_source_observed_at: manifest.fetchedAt, last_error: partition.error || null, started_at: startedAt, finished_at: manifest.fetchedAt
    }));
    const partitions = await supabaseUpsert('ingest_partitions', partitionRows, 'run_id,partition_key');
    const partitionByKey = new Map(partitions.map((partition) => [partition.partition_key, partition.id]));
    const partitionJobs = partitionRows.map((partition, index) => ({ run_id: run.id, job_type: 'fetch_partition', partition_id: partitions[index].id, status: partition.status === 'completed' ? 'completed' : 'failed', payload: { partitionKey: partition.partition_key, houseCode: partition.house_code, tenureId: partition.tenure_id, stateSourceId: partition.state_source_id }, attempt_count: 1, last_error: partition.last_error }));
    if (partitionJobs.length) await supabaseInsert('ingest_jobs', partitionJobs);

    const artifactRows = [];
    for (const filePath of await filesUnder(rawRoot)) {
      const body = await readFile(filePath);
      const relativePath = relative(rawRoot, filePath).replaceAll('\\', '/');
      const key = `mplads/raw/source=esakshi/run=${run.id}/fetched=${datePart(manifest.fetchedAt)}/${relativePath}`;
      const stored = await putR2Object(key, body, contentTypeFor(filePath));
      artifactRows.push({ run_id: run.id, partition_id: partitionByKey.get('all-configured-scopes') || null, source_route: relativePath.startsWith('report-') ? 'getTilesReportData' : 'collector-output', request_body: {}, response_status: 200, content_type: contentTypeFor(filePath), content_sha256: sha256(body), byte_size: body.length, r2_key: stored.key, fetched_at: manifest.fetchedAt, parser_version: parserVersion, response_meta: { relativePath } });
    }
    if (artifactRows.length) await supabaseUpsert('source_artifacts', artifactRows, 'run_id,r2_key');

    await exec(process.execPath, ['scripts/import-esakshi.mjs'], { cwd: process.cwd(), env: { ...process.env, MPWORKS_SNAPSHOT_ID: snapshot.id }, maxBuffer: 50 * 1024 * 1024 });
    await exec(process.execPath, ['scripts/upload-evidence-to-r2.mjs'], { cwd: process.cwd(), env: process.env, maxBuffer: 50 * 1024 * 1024 });

    const stats = { ...manifest, rawArtifacts: artifactRows.length, runId: run.id, snapshotId: snapshot.id, completedAt: new Date().toISOString() };
    await supabaseUpdate('ingest_jobs', `id=eq.${encodeURIComponent(discoverJob.id)}`, { status: 'completed', locked_at: null, updated_at: stats.completedAt });
    await supabaseUpdate('source_snapshots', `id=eq.${encodeURIComponent(snapshot.id)}`, { fetched_at: manifest.fetchedAt, record_count: manifest.works || 0, attachment_count: manifest.attachments || 0, manifest: stats });
    await supabaseUpdate('ingest_runs', `id=eq.${encodeURIComponent(run.id)}`, { status: manifest.errors?.length ? 'completed' : 'completed', finished_at: stats.completedAt, stats });
    console.log(JSON.stringify({ status: 'completed', runId: run.id, snapshotId: snapshot.id, works: manifest.works || 0, attachments: manifest.attachments || 0, rawArtifacts: artifactRows.length, errors: manifest.errors?.length || 0 }, null, 2));
  } catch (error) {
    await supabaseUpdate('ingest_jobs', `id=eq.${encodeURIComponent(discoverJob.id)}`, { status: 'failed', last_error: error.message, updated_at: new Date().toISOString() });
    await supabaseUpdate('ingest_runs', `id=eq.${encodeURIComponent(run.id)}`, { status: 'failed', finished_at: new Date().toISOString(), error: error.message, stats: { parserVersion } });
    throw error;
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
