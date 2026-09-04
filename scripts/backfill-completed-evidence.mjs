import { appendFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ESAKSHI_ORIGIN, attachmentIdsFromReferenceRows, getAttachment, getAttachmentReferences, normalizeWork } from '../src/esakshi-source.js';
import { putR2Object, r2Configured } from '../src/persistence/r2.js';

const DEFAULT_REPORT_TYPE = 'Completed';
const DEFAULT_MIN_INTERVAL_MS = 1_000;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

export const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
export const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

function numberFromEnv(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function configFromEnv(env = process.env) {
  const root = env.ESAKSHI_ROOT || 'data/raw/esakshi';
  const evidenceIndex = env.ESAKSHI_ATTACHMENTS || join(root, 'attachments.ndjson');
  const configuredFlags = String(env.ATTACHMENT_BACKFILL_FLAGS || '')
    .split(',')
    .map(Number)
    .filter(Number.isFinite);
  return {
    root,
    evidenceIndex,
    progressPath: env.ATTACHMENT_BACKFILL_PROGRESS || `${evidenceIndex}.progress.ndjson`,
    limit: Math.max(0, numberFromEnv(env.ATTACHMENT_BACKFILL_LIMIT, 0)),
    reportType: env.ATTACHMENT_BACKFILL_REPORT_TYPE || DEFAULT_REPORT_TYPE,
    requestedSourceFile: env.ATTACHMENT_BACKFILL_SOURCE_FILE || '',
    requestedSourceWorkId: env.ATTACHMENT_BACKFILL_SOURCE_WORK_ID || '',
    requestedFlags: configuredFlags,
    minIntervalMs: Math.max(0, numberFromEnv(env.ATTACHMENT_BACKFILL_MIN_INTERVAL_MS, DEFAULT_MIN_INTERVAL_MS)),
    maxBytes: Math.max(1, numberFromEnv(env.ATTACHMENT_BACKFILL_MAX_BYTES, DEFAULT_MAX_BYTES)),
  };
}

export function parseReportFileName(fileName) {
  const match = String(fileName).match(/^report-(.+)-(1|2)-(.+)-Works-(Recommended|Sanctioned|Completed)\.json$/i);
  if (!match) return null;
  const [, tenureFolder, houseCode, stateFolder, reportType] = match;
  return {
    tenure: tenureFolder.replaceAll('-', ' '),
    houseCode,
    state: stateFolder.replaceAll('-', ' '),
    reportType,
  };
}

function identityPart(value) {
  return clean(value).toLocaleLowerCase('en-IN');
}

export function workIdentity(work) {
  return [work?.sourceWorkId, work?.term, work?.houseCode, work?.state].map(identityPart).join('|');
}

export function relationKey(workOrIdentity, digest) {
  const identity = typeof workOrIdentity === 'string' ? workOrIdentity : workIdentity(workOrIdentity);
  return digest ? `${identity}|${digest}` : null;
}

function decodeBase64(value) {
  if (typeof value !== 'string' || value.trim() === '' || value.trim().toUpperCase() === 'N/A') return null;
  const trimmed = value.trim();
  const dataUri = trimmed.match(/^data:([^;,]+);base64,(.*)$/is);
  if (!dataUri && /^(?:https?:|blob:)/i.test(trimmed)) return null;
  const base64 = (dataUri ? dataUri[2] : trimmed).replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!base64 || base64.length % 4 === 1 || !/^[a-z0-9+/]*={0,2}$/i.test(base64)) return null;
  try {
    const buffer = Buffer.from(base64, 'base64');
    return buffer.length ? { buffer, declaredMime: dataUri?.[1]?.toLowerCase() || null } : null;
  } catch {
    return null;
  }
}

const PAYLOAD_FIELDS = [
  'URL', 'url', 'CONTENT', 'content', 'DATA', 'data', 'FILE_DATA', 'fileData',
  'FILE_CONTENT', 'fileContent', 'BASE64', 'base64', 'DOCUMENT', 'document',
  'ATTACHMENT', 'attachment',
];

export function decodePayload(row) {
  if (!row || typeof row !== 'object') return null;
  for (const field of PAYLOAD_FIELDS) {
    const decoded = decodeBase64(row[field]);
    if (decoded) {
      return {
        buffer: decoded.buffer,
        declaredMime: decoded.declaredMime,
        fileName: clean(row.FILE_NAME ?? row.fileName ?? row.FILENAME ?? row.filename) || null,
      };
    }
  }
  return null;
}

export function payloadBuffer(row) {
  return decodePayload(row)?.buffer || null;
}

export function detectMime(fileName, buffer, declaredMime = '') {
  const name = String(fileName || '').toLowerCase();
  if (buffer?.subarray(0, 4).toString() === '%PDF' || /\.pdf$/.test(name)) return 'application/pdf';
  if (buffer?.subarray(0, 3).toString('hex') === 'ffd8ff' || /\.jpe?g$/.test(name)) return 'image/jpeg';
  if (buffer?.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' || /\.png$/.test(name)) return 'image/png';
  if (buffer?.subarray(0, 6).toString() === 'GIF87a' || buffer?.subarray(0, 6).toString() === 'GIF89a' || /\.gif$/.test(name)) return 'image/gif';
  if ((buffer?.subarray(0, 4).toString() === 'RIFF' && buffer?.subarray(8, 12).toString() === 'WEBP') || /\.webp$/.test(name)) return 'image/webp';
  if (/^image\//i.test(declaredMime)) return declaredMime.toLowerCase();
  if (/^application\/pdf$/i.test(declaredMime)) return 'application/pdf';
  return 'application/octet-stream';
}

export async function readNdjson(filePath) {
  const text = await readFile(filePath, 'utf8').catch(() => '');
  const rows = [];
  let malformed = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { malformed += 1; }
  }
  return { rows, malformed };
}

export async function loadCompletedWorks({ root, reportType = DEFAULT_REPORT_TYPE, requestedSourceFile = '', requestedSourceWorkId = '' }) {
  const files = (await readdir(root).catch(() => []))
    .filter((name) => {
      const parsed = parseReportFileName(name);
      return parsed && parsed.reportType.toLowerCase() === reportType.toLowerCase() && (!requestedSourceFile || name === requestedSourceFile);
    })
    .sort((a, b) => a.localeCompare(b));
  const works = new Map();

  for (const file of files) {
    const parsed = parseReportFileName(file);
    let rows;
    try { rows = JSON.parse(await readFile(join(root, file), 'utf8')); } catch { continue; }
    if (!Array.isArray(rows)) continue;
    for (const raw of rows) {
      const wrapped = {
        ...raw,
        HOUSE_OF_PARLIAMENT: raw.HOUSE_OF_PARLIAMENT ?? parsed.houseCode,
        TENURE: clean(raw.TENURE) || parsed.tenure,
        STATE_NAME: clean(raw.STATE_NAME) || parsed.state,
      };
      const work = normalizeWork(wrapped, file);
      if (!work.sourceWorkId || (requestedSourceWorkId && work.sourceWorkId !== requestedSourceWorkId)) continue;
      const key = workIdentity(work);
      const previous = works.get(key);
      works.set(key, { work: previous?.work || work, raws: [...(previous?.raws || []), raw] });
    }
  }
  return [...works.values()];
}

export function createPacedCaller({ intervalMs = DEFAULT_MIN_INTERVAL_MS, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  let nextRequestAt = 0;
  let queue = Promise.resolve();
  return (operation) => {
    const result = queue.then(async () => {
      const waitMs = Math.max(nextRequestAt - Date.now(), 0);
      if (waitMs) await sleep(waitMs);
      try {
        return await operation();
      } finally {
        nextRequestAt = Date.now() + intervalMs;
      }
    });
    queue = result.catch(() => undefined);
    return result;
  };
}

function stateFromLegacyRow(row) {
  if (row?.state) return row.state;
  const parts = String(row?.localPath || '').replaceAll('\\', '/').split('/');
  const evidenceIndex = parts.indexOf('esakshi');
  return evidenceIndex >= 0 ? parts[evidenceIndex + 2]?.replaceAll('-', ' ') || '' : '';
}

function identityFromRecord(row) {
  return workIdentity({ sourceWorkId: row?.sourceWorkId, term: row?.term, houseCode: row?.houseCode, state: stateFromLegacyRow(row) });
}

function canonicalRecord(previous, next) {
  if (!previous) return next;
  return previous.r2Key ? previous : next;
}

class EvidenceIndex {
  constructor(filePath, rows) {
    this.filePath = filePath;
    this.rows = [];
    this.byRelation = new Map();
    this.byHash = new Map();
    for (const row of rows) {
      const key = relationKey(identityFromRecord(row), row?.sha256);
      if (key) {
        const previous = this.byRelation.get(key);
        const chosen = canonicalRecord(previous, row);
        if (previous) this.rows[this.rows.indexOf(previous)] = chosen;
        else this.rows.push(chosen);
        this.byRelation.set(key, chosen);
      } else {
        this.rows.push(row);
      }
      if (row?.sha256 && row?.r2Key) {
        const existing = this.byHash.get(row.sha256);
        this.byHash.set(row.sha256, canonicalRecord(existing, row));
      }
    }
  }

  async rewrite() {
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(tempPath, this.rows.map((row) => JSON.stringify(row)).join('\n') + (this.rows.length ? '\n' : ''), 'utf8');
    await rename(tempPath, this.filePath);
  }

  async upsert(row) {
    const key = relationKey(row, row.sha256);
    const previous = this.byRelation.get(key);
    if (previous?.r2Key) return { row: previous, uploaded: false, indexed: false };
    if (previous) {
      const index = this.rows.indexOf(previous);
      this.rows[index] = row;
      this.byRelation.set(key, row);
      if (row.r2Key) this.byHash.set(row.sha256, row);
      await this.rewrite();
      return { row, uploaded: true, indexed: true };
    }
    this.rows.push(row);
    this.byRelation.set(key, row);
    if (row.sha256 && row.r2Key && !this.byHash.has(row.sha256)) this.byHash.set(row.sha256, row);
    let separator = '';
    try { separator = (await readFile(this.filePath, 'utf8')).endsWith('\n') ? '' : '\n'; } catch { /* the append creates a new file */ }
    await appendFile(this.filePath, `${separator}${JSON.stringify(row)}\n`, 'utf8');
    return { row, uploaded: true, indexed: true };
  }

  r2ForHash(digest) {
    const row = this.byHash.get(digest);
    return row?.r2Key ? { key: row.r2Key, url: row.r2Url } : null;
  }
}

function applyProgressEvent(state, event) {
  if (!event || typeof event !== 'object' || !event.workKey) return;
  if (event.type === 'work-completed') {
    state.completed.add(event.workKey);
    state.active.delete(event.workKey);
    return;
  }
  if (event.type === 'references') {
    state.active.set(event.workKey, {
      refs: Array.isArray(event.refs) ? event.refs : [],
      completedFlags: new Set(Array.isArray(event.completedFlags) ? event.completedFlags.map(Number) : []),
      processedRefIds: new Set(Array.isArray(event.processedRefIds) ? event.processedRefIds.map(String) : []),
    });
    return;
  }
  if (event.type === 'ref-completed') {
    const current = state.active.get(event.workKey) || { refs: [], completedFlags: new Set(), processedRefIds: new Set() };
    current.processedRefIds.add(String(event.attachmentId));
    state.active.set(event.workKey, current);
  }
}

export async function loadProgress(filePath) {
  const { rows } = await readNdjson(filePath);
  const state = { completed: new Set(), active: new Map() };
  for (const event of rows) applyProgressEvent(state, event);
  return state;
}

function serializableProgressEvent(workKey, current) {
  return {
    type: 'references',
    workKey,
    refs: current.refs,
    completedFlags: [...current.completedFlags],
    processedRefIds: [...current.processedRefIds],
    at: new Date().toISOString(),
  };
}

function flagsForWork(work, raws, requestedFlags) {
  const values = requestedFlags.length ? requestedFlags : raws.flatMap((raw) => [raw.FLAG, work.flag, 3, 1, 2]);
  return [...new Set(values.map(Number).filter((value) => Number.isInteger(value) && value >= 1 && value <= 3))];
}

async function main() {
  const config = configFromEnv();
  if (!r2Configured()) {
    console.error('Set R2_ENDPOINT (or R2_ACCOUNT_ID), R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY before backfilling. No files were written.');
    return 2;
  }

  await mkdir(config.root, { recursive: true });
  await mkdir(dirname(config.evidenceIndex), { recursive: true });
  await mkdir(dirname(config.progressPath), { recursive: true });
  const [{ rows: existingRows, malformed }, progress] = await Promise.all([readNdjson(config.evidenceIndex), loadProgress(config.progressPath)]);
  const index = new EvidenceIndex(config.evidenceIndex, existingRows);
  if (malformed) console.error(JSON.stringify({ warning: 'ignored malformed evidence-index lines', malformed }));
  if (index.rows.length !== existingRows.length) await index.rewrite();

  const discoveredWorks = await loadCompletedWorks(config);
  const targets = discoveredWorks.filter(({ work }) => !progress.completed.has(workIdentity(work))).slice(0, config.limit || undefined);
  const sourceRequest = createPacedCaller({ intervalMs: config.minIntervalMs });
  let processed = 0;
  const skippedCompleted = discoveredWorks.filter(({ work }) => progress.completed.has(workIdentity(work))).length;
  const deferredByLimit = Math.max(discoveredWorks.length - skippedCompleted - targets.length, 0);
  let discovered = 0;
  let uploads = 0;
  let failures = 0;
  const checkpoint = async (event) => appendFile(config.progressPath, `${JSON.stringify(event)}\n`, 'utf8');

  for (const target of targets) {
    const { work, raws } = target;
    const workKey = workIdentity(work);
    const current = progress.active.get(workKey) || { refs: [], completedFlags: new Set(), processedRefIds: new Set() };
    const refs = new Map(current.refs.map((ref) => [String(ref.id), ref]));
    for (const ref of attachmentIdsFromReferenceRows(raws)) {
      if (ref.id) refs.set(String(ref.id), { ...ref, flags: [...new Set([...(refs.get(String(ref.id))?.flags || []), work.flag].filter(Number.isFinite))] });
    }
    current.refs = [...refs.values()];
    let hadError = false;

    for (const flag of flagsForWork(work, raws, config.requestedFlags)) {
      if (current.completedFlags.has(flag)) continue;
      try {
        const referenceRows = await sourceRequest(() => getAttachmentReferences(raws[0], flag));
        for (const ref of attachmentIdsFromReferenceRows(referenceRows)) {
          if (!ref.id) continue;
          const id = String(ref.id);
          const previous = refs.get(id) || {};
          refs.set(id, { ...previous, ...ref, id, flags: [...new Set([...(previous.flags || []), flag])] });
        }
        current.refs = [...refs.values()];
        current.completedFlags.add(flag);
        progress.active.set(workKey, current);
        await checkpoint(serializableProgressEvent(workKey, current));
      } catch (error) {
        hadError = true;
        failures += 1;
        console.error(JSON.stringify({ sourceWorkId: work.sourceWorkId, flag, phase: 'references', error: error.message }));
      }
    }

    for (const ref of refs.values()) {
      if (current.processedRefIds.has(String(ref.id))) continue;
      try {
        const payloadRows = await sourceRequest(() => getAttachment(ref.id));
        for (const payloadRow of payloadRows) {
          const decoded = decodePayload(payloadRow);
          if (!decoded) continue;
          if (decoded.buffer.byteLength > config.maxBytes) {
            console.error(JSON.stringify({ sourceWorkId: work.sourceWorkId, attachmentId: ref.id, phase: 'payload', warning: 'payload exceeds max bytes', bytes: decoded.buffer.byteLength }));
            continue;
          }
          const contentType = detectMime(decoded.fileName || ref.fileName, decoded.buffer, decoded.declaredMime);
          if (!(contentType === 'application/pdf' || contentType.startsWith('image/'))) continue;
          const digest = sha256(decoded.buffer);
          const existingObject = index.r2ForHash(digest);
          const stored = existingObject || await putR2Object(`mplads/evidence/${digest}`, decoded.buffer, contentType);
          if (!existingObject) uploads += 1;
          const row = {
            workIdentity: workKey,
            sourceWorkId: work.sourceWorkId,
            term: work.term,
            houseCode: work.houseCode,
            state: work.state,
            flag: ref.flags?.[0] ?? work.flag,
            attachmentId: String(ref.id),
            fileName: decoded.fileName || ref.fileName || `${digest}.bin`,
            mimeType: contentType,
            sha256: digest,
            bytes: decoded.buffer.length,
            r2Key: stored.key,
            r2Url: stored.url,
            sourceUrl: `${ESAKSHI_ORIGIN}/attachment/${ref.id}`,
            analyzedAt: new Date().toISOString(),
            analyzer: contentType.startsWith('image/') ? 'r2-streamed-image-evidence' : 'r2-streamed-document-evidence',
          };
          const result = await index.upsert(row);
          if (result.indexed) discovered += 1;
        }
        current.processedRefIds.add(String(ref.id));
        progress.active.set(workKey, current);
        await checkpoint(serializableProgressEvent(workKey, current));
      } catch (error) {
        hadError = true;
        failures += 1;
        console.error(JSON.stringify({ sourceWorkId: work.sourceWorkId, attachmentId: ref.id, phase: 'payload', error: error.message }));
      }
    }

    const allFlagsFetched = current.completedFlags.size === flagsForWork(work, raws, config.requestedFlags).length;
    const allRefsProcessed = [...refs.keys()].every((id) => current.processedRefIds.has(id));
    if (!hadError && allFlagsFetched && allRefsProcessed) {
      progress.completed.add(workKey);
      progress.active.delete(workKey);
      await checkpoint({ type: 'work-completed', workKey, at: new Date().toISOString() });
    }
    processed += 1;
    if (processed % 25 === 0 || processed === targets.length) {
      console.log(JSON.stringify({ processed, total: targets.length, skippedCompleted, deferredByLimit, discovered, uploads, failures, lastSourceWorkId: work.sourceWorkId, references: refs.size }));
    }
  }

  console.log(JSON.stringify({ targets: targets.length, processed, skippedCompleted, deferredByLimit, discovered, uploads, failures, minIntervalMs: config.minIntervalMs }, null, 2));
  return failures ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((exitCode) => { if (exitCode) process.exitCode = exitCode; }).catch((error) => { console.error(error); process.exitCode = 1; });
}
