import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname, join } from 'node:path';
import { analyzeImage } from '../src/image-analysis.js';
import { ESAKSHI_DASHBOARD_URL, ESAKSHI_ORIGIN, getAttachment, getAttachmentReferences, getConstituencies, getMetrics, getStates, getTenures, getWorkReport, normalizeWork, attachmentIdsFromReferenceRows } from '../src/esakshi-source.js';

const root = join(process.cwd(), 'data', 'raw', 'esakshi');
const evidenceRoot = join(process.cwd(), 'data', 'evidence', 'esakshi');
const args = new Set(process.argv.slice(2));
const maxStates = Number(process.env.MPLADS_MAX_STATES || 0);
const maxWorks = Number(process.env.MPLADS_MAX_WORKS || 0);
const withAttachments = !args.has('--without-attachments');
const requestedState = process.env.MPLADS_STATE_ID || '';
const requestedTenure = process.env.MPLADS_TENURE_ID || '';
const requestedHouse = process.env.MPLADS_HOUSE_CODE || '';

if (args.has('--dry-run')) {
  console.log(JSON.stringify({ sourceUrl: ESAKSHI_DASHBOARD_URL, apiOrigin: ESAKSHI_ORIGIN, houses: requestedHouse ? [requestedHouse] : ['2 (Lok Sabha)', '1 (Rajya Sabha)'], tenure: requestedTenure || 'all available eSAKSHI tenures', attachments: withAttachments, output: root }, null, 2));
  process.exit(0);
}

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const safe = (value) => clean(value).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 80) || 'unknown';
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function inferMime(fileName, buffer) {
  const name = String(fileName || '').toLowerCase();
  if (buffer.subarray(0, 4).toString() === '%PDF') return { mime: 'application/pdf', ext: '.pdf' };
  if (buffer.subarray(0, 3).toString('hex') === 'ffd8ff' || /\.jpe?g$/.test(name)) return { mime: 'image/jpeg', ext: '.jpg' };
  if (buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' || /\.png$/.test(name)) return { mime: 'image/png', ext: '.png' };
  if (/\.webp$/.test(name)) return { mime: 'image/webp', ext: '.webp' };
  return { mime: 'application/octet-stream', ext: extname(name) || '.bin' };
}

function base64FromAttachment(row) {
  const value = row?.URL ?? row?.url ?? row?.CONTENT ?? row?.content ?? row?.DATA ?? row?.data;
  if (typeof value !== 'string' || value === 'N/A') return null;
  const match = value.match(/^data:[^;]+;base64,(.*)$/i);
  const base64 = (match ? match[1] : value).replace(/\s/g, '');
  if (!/^[a-z0-9+/=]+$/i.test(base64) || base64.length < 20) return null;
  return Buffer.from(base64, 'base64');
}

async function writeJson(path, value) { await writeFile(path, JSON.stringify(value, null, 2), 'utf8'); }

async function main() {
  await mkdir(root, { recursive: true });
  await mkdir(evidenceRoot, { recursive: true });
  const houses = requestedHouse ? [Number(requestedHouse)] : [2, 1];
  const allWorks = new Map();
  const metrics = [];
  const attachments = [];
  const errors = [];
  const states = await getStates();
  const selectedStates = states.filter((state) => !requestedState || String(state.STATE_ID) === requestedState).slice(0, maxStates || states.length);
  const reportKeys = ['Works Recommended', 'Works Sanctioned', 'Works Completed'];

  for (const houseCode of houses) {
    let tenures = await getTenures(houseCode);
    if (requestedTenure) tenures = tenures.filter((tenure) => String(tenure.ID) === requestedTenure);
    for (const tenure of tenures) {
      for (const state of selectedStates) {
        const combo = `${state.STATE_ID},0,0,${houseCode},${tenure.ID}`;
        try {
          const stateMetrics = await getMetrics(combo);
          metrics.push({ combo, stateId: String(state.STATE_ID), state: state.STATE_NAME, houseCode, tenureId: tenure.ID, tenure: tenure.CAPTION, payload: stateMetrics });
          for (const key of reportKeys) {
            const rows = await getWorkReport(combo, key);
            await writeJson(join(root, `report-${safe(tenure.CAPTION)}-${houseCode}-${safe(state.STATE_NAME)}-${safe(key)}.json`), rows);
            for (const row of rows) {
              const normalized = normalizeWork({ ...row, HOUSE_OF_PARLIAMENT: row.HOUSE_OF_PARLIAMENT ?? houseCode, TENURE: row.TENURE ?? tenure.CAPTION, STATE_NAME: row.STATE_NAME ?? state.STATE_NAME }, key);
              const keyId = normalized.sourceWorkId ? `${normalized.sourceWorkId}|${normalized.term}|${normalized.houseCode}` : `${combo}-${row.Sno}`;
              const previous = allWorks.get(keyId) || { ...normalized, sources: [], attachmentRefs: [] };
              allWorks.set(keyId, { ...previous, ...Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== null && value !== '')), sources: [...new Set([...previous.sources, key])] });
            }
          }
        } catch (error) {
          errors.push({ combo, state: state.STATE_NAME, tenure: tenure.CAPTION, error: error.message });
        }
      }
    }
  }

  const works = [...allWorks.values()].slice(0, maxWorks || allWorks.size);
  if (withAttachments) {
    for (const work of works) {
      if (!work.fileStatus && !args.has('--all-attachments')) continue;
      const flags = [...new Set([work.flag, 1, 2, 3].filter((flag) => Number.isFinite(flag)))];
      for (const flag of flags) {
        try {
          const refs = attachmentIdsFromReferenceRows(await getAttachmentReferences(work.raw || work, flag));
          for (const ref of refs) {
            if (!ref.id) continue;
            const payloadRows = await getAttachment(ref.id);
            for (const payloadRow of payloadRows) {
              const buffer = base64FromAttachment(payloadRow);
              if (!buffer) continue;
              const info = inferMime(payloadRow.FILE_NAME || ref.fileName, buffer);
              const digest = sha256(buffer);
              const dir = join(evidenceRoot, safe(work.term), safe(work.state), safe(work.sourceWorkId));
              await mkdir(dir, { recursive: true });
              const filePath = join(dir, `${digest}${info.ext}`);
              await writeFile(filePath, buffer);
              const analysis = info.mime.startsWith('image/') ? await analyzeImage(buffer, `${ESAKSHI_ORIGIN}/attachment/${ref.id}`) : { byteSize: buffer.length, sha256: digest, analyzer: 'node:crypto', analyzedAt: new Date().toISOString() };
              attachments.push({ sourceWorkId: work.sourceWorkId, term: work.term, houseCode: work.houseCode, state: work.state, flag, attachmentId: ref.id, fileName: payloadRow.FILE_NAME || ref.fileName, mimeType: info.mime, localPath: filePath, sha256: digest, ...analysis });
            }
          }
        } catch (error) { errors.push({ sourceWorkId: work.sourceWorkId, flag, attachmentError: error.message }); }
      }
    }
  }

  const projectHeaders = ['sourceWorkId', 'sourceWorkRecommendationId', 'sourceWorkIdPhysical', 'workCategory', 'activityName', 'state', 'constituency', 'constituencyId', 'implementingAuthority', 'term', 'mp', 'houseCode', 'description', 'recommendationDate', 'sanctionDate', 'actualEndDate', 'recommendedAmount', 'sanctionAmount', 'actualAmount', 'letterNo', 'stage', 'flag', 'fileStatus', 'sources'];
  const csv = [projectHeaders.join(';'), ...works.map((row) => projectHeaders.map((field) => csvCell(field === 'sources' ? row.sources?.join('|') : row[field])).join(';'))].join('\n');
  await writeFile(join(root, 'projects.csv'), csv, 'utf8');
  await writeFile(join(root, 'projects.ndjson'), works.map((row) => JSON.stringify(row)).join('\n'), 'utf8');
  await writeFile(join(root, 'attachments.ndjson'), attachments.map((row) => JSON.stringify(row)).join('\n'), 'utf8');
  await writeJson(join(root, 'metrics.json'), metrics);
  await writeJson(join(root, 'manifest.json'), { sourceUrl: ESAKSHI_DASHBOARD_URL, apiOrigin: ESAKSHI_ORIGIN, fetchedAt: new Date().toISOString(), states: selectedStates, works: works.length, attachments: attachments.length, metrics: metrics.length, errors, mode: withAttachments ? 'reports-and-attachments' : 'reports-only' });
  console.log(JSON.stringify({ sourceUrl: ESAKSHI_DASHBOARD_URL, states: selectedStates.length, works: works.length, attachments: attachments.length, metrics: metrics.length, errors: errors.length, output: root }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
