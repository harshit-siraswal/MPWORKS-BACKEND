import { appendFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { attachmentIdsFromReferenceRows, getAttachment, getAttachmentReferences, normalizeWork } from '../src/esakshi-source.js';
import { putR2Object, r2Configured } from '../src/persistence/r2.js';

const root = process.env.ESAKSHI_ROOT || 'data/raw/esakshi';
const evidenceIndex = process.env.ESAKSHI_ATTACHMENTS || join(root, 'attachments.ndjson');
const concurrency = Math.max(1, Math.min(Number(process.env.ATTACHMENT_BACKFILL_CONCURRENCY || 4), 8));
const limit = Math.max(0, Number(process.env.ATTACHMENT_BACKFILL_LIMIT || 0));
const reportType = process.env.ATTACHMENT_BACKFILL_REPORT_TYPE || 'Completed';
const requestedSourceFile = process.env.ATTACHMENT_BACKFILL_SOURCE_FILE || '';
const requestedSourceWorkId = process.env.ATTACHMENT_BACKFILL_SOURCE_WORK_ID || '';
const requestedFlags = String(process.env.ATTACHMENT_BACKFILL_FLAGS || '').split(',').map(Number).filter(Number.isFinite);
const publicUrl = process.env.R2_PUBLIC_URL?.replace(/\/$/, '');

if (!r2Configured() || !publicUrl) {
  console.error('Set R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_PUBLIC_URL before backfilling. No files were written.');
  process.exit(2);
}

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const safe = (value) => clean(value).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 80) || 'unknown';
const mime = (fileName, buffer) => {
  const name = String(fileName || '').toLowerCase();
  if (buffer.subarray(0, 4).toString() === '%PDF') return 'application/pdf';
  if (buffer.subarray(0, 3).toString('hex') === 'ffd8ff' || /\.jpe?g$/.test(name)) return 'image/jpeg';
  if (buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' || /\.png$/.test(name)) return 'image/png';
  if (/\.webp$/.test(name)) return 'image/webp';
  return 'application/octet-stream';
};
const payloadBuffer = (row) => {
  const value = row?.URL ?? row?.url ?? row?.CONTENT ?? row?.content ?? row?.DATA ?? row?.data;
  if (typeof value !== 'string' || value === 'N/A') return null;
  const match = value.match(/^data:[^;]+;base64,(.*)$/i);
  const base64 = (match ? match[1] : value).replace(/\s/g, '');
  return /^[a-z0-9+/=]+$/i.test(base64) && base64.length >= 20 ? Buffer.from(base64, 'base64') : null;
};

const files = (await readdir(root)).filter((name) => new RegExp(`^report-.*-Works-${reportType}\\.json$`, 'i').test(name) && (!requestedSourceFile || name === requestedSourceFile));
const existing = (await readFile(evidenceIndex, 'utf8').catch(() => '')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
const existingWorkKeys = new Set(existing.map((row) => {
  const parts = String(row.localPath || '').replaceAll('\\\\', '/').split('/');
  const evidenceIndex = parts.indexOf('esakshi');
  const pathState = evidenceIndex >= 0 ? parts[evidenceIndex + 2]?.replaceAll('-', ' ') : '';
  return `${row.sourceWorkId}|${row.term}|${row.houseCode}|${row.state || pathState || ''}`;
}));
const existingWorkIdentities = new Set(existing.map((row) => {
  const parts = String(row.localPath || '').replaceAll('\\\\', '/').split('/');
  const evidenceIndex = parts.indexOf('esakshi');
  const pathState = evidenceIndex >= 0 ? parts[evidenceIndex + 2]?.replaceAll('-', ' ') : '';
  return `${row.sourceWorkId}|${row.state || pathState || ''}`;
}));
const existingHashes = new Set(existing.map((row) => row.sha256).filter(Boolean));
const existingByHash = new Map(existing.filter((row) => row.sha256 && row.r2Key).map((row) => [row.sha256, row]));
const works = new Map();

for (const file of files) {
  const match = file.match(/^report-(.+)-(1|2)-(.+)-Works-(Recommended|Sanctioned|Completed)\.json$/i);
  if (!match) continue;
  const [, tenureFolder, houseCode, stateFolder] = match;
  const tenure = tenureFolder.replaceAll('-', ' ');
  const state = stateFolder.replaceAll('-', ' ');
  const rows = JSON.parse(await readFile(join(root, file), 'utf8'));
  for (const raw of rows) {
    const wrapped = { ...raw, HOUSE_OF_PARLIAMENT: raw.HOUSE_OF_PARLIAMENT ?? houseCode, TENURE: raw.TENURE ?? tenure, STATE_NAME: raw.STATE_NAME ?? state };
    const work = normalizeWork(wrapped, file);
    const stageText = `${work.stage} ${file}`;
    if (!work.sourceWorkId || !work.fileStatus || (requestedSourceWorkId && work.sourceWorkId !== requestedSourceWorkId) || !/(completed|partially|ongoing|progress|sanctioned|recommended)/i.test(stageText)) continue;
    const key = `${work.sourceWorkId}|${work.term}|${work.houseCode}|${work.state}`;
    if (!existingWorkKeys.has(key) && !existingWorkIdentities.has(`${work.sourceWorkId}|${work.state}`)) {
      const previous = works.get(key) || { work, raws: [] };
      works.set(key, { work, raws: [...previous.raws, raw] });
    }
  }
}

const targets = [...works.values()].slice(0, limit || undefined);
let next = 0;
let processed = 0;
let discovered = 0;
let failures = 0;
let writeQueue = Promise.resolve();
const persist = (row) => { writeQueue = writeQueue.then(() => appendFile(evidenceIndex, `${JSON.stringify(row)}\n`, 'utf8')); return writeQueue; };

async function processWork({ work, raws }) {
  const refs = new Map();
  const refDiagnostics = [];
  for (const raw of raws) {
    for (const flag of [...new Set((requestedFlags.length ? requestedFlags : [raw.FLAG, work.flag, 1, 2, 3]).filter((value) => Number.isFinite(Number(value))).map(Number))]) {
      try {
        const referenceRows = await getAttachmentReferences(raw, flag);
        const flagRefs = attachmentIdsFromReferenceRows(referenceRows);
        refDiagnostics.push({ sourceKey: raw.__sourceKey || null, flag, responseRows: referenceRows.length, responseSample: referenceRows[0] || null, refs: flagRefs.map((ref) => ({ id: ref.id, fileName: ref.fileName })) });
        for (const ref of flagRefs) if (ref.id) refs.set(ref.id, ref);
      } catch (error) { console.error(JSON.stringify({ sourceWorkId: work.sourceWorkId, flag, error: error.message })); }
    }
  }
  let workFiles = 0;
  for (const ref of refs.values()) {
    try {
      for (const payloadRow of await getAttachment(ref.id)) {
        const buffer = payloadBuffer(payloadRow);
        if (!buffer || buffer.byteLength > 8 * 1024 * 1024) continue;
        const digest = sha256(buffer);
        const fileName = payloadRow.FILE_NAME || ref.fileName || `${digest}.bin`;
        const contentType = mime(fileName, buffer);
        const key = `mplads/${work.sourceWorkId}/${digest}`;
        const previous = existingByHash.get(digest);
        const stored = previous ? { key: previous.r2Key, url: previous.r2Url } : await putR2Object(key, buffer, contentType);
        const row = { sourceWorkId: work.sourceWorkId, term: work.term, houseCode: work.houseCode, state: work.state, flag: work.flag, attachmentId: ref.id, fileName, mimeType: contentType, sha256: digest, bytes: buffer.length, r2Key: stored.key, r2Url: stored.url, sourceUrl: `https://mplads.mospi.gov.in/attachment/${ref.id}`, analyzedAt: new Date().toISOString(), analyzer: contentType.startsWith('image/') ? 'r2-streamed-image-evidence' : 'r2-streamed-document-evidence' };
        existingHashes.add(digest);
        existingByHash.set(digest, row);
        await persist(row);
        discovered += 1;
        workFiles += 1;
      }
    } catch (error) { failures += 1; console.error(JSON.stringify({ sourceWorkId: work.sourceWorkId, attachmentId: ref.id, error: error.message })); }
  }
  existingWorkKeys.add(`${work.sourceWorkId}|${work.term}|${work.houseCode}|${work.state}`);
  existingWorkIdentities.add(`${work.sourceWorkId}|${work.state}`);
  processed += 1;
  if (!workFiles) console.log(JSON.stringify({ sourceWorkId: work.sourceWorkId, state: work.state, sourceKey: work.sourceKey, rawAttachId: raws.map((raw) => raw.ATTACH_ID), rawWorkId: raws.map((raw) => raw.WORK_ID), refDiagnostics, uniqueReferences: refs.size }));
  if (processed % 25 === 0 || processed === targets.length) console.log(JSON.stringify({ processed, total: targets.length, discovered, failures, lastSourceWorkId: work.sourceWorkId, lastWorkFiles: workFiles }));
}

await Promise.all(Array.from({ length: concurrency }, async () => { while (true) { const index = next++; if (index >= targets.length) return; await processWork(targets[index]); } }));
await writeQueue;
console.log(JSON.stringify({ targets: targets.length, processed, discovered, failures, concurrency }, null, 2));
