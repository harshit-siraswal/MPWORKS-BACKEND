import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { analyzeImage } from '../src/image-analysis.js';
import { ESAKSHI_ORIGIN, attachmentIdsFromReferenceRows, getAttachment, getAttachmentReferences } from '../src/esakshi-source.js';

const root = join(process.cwd(), 'data', 'raw', 'esakshi');
const evidenceRoot = join(process.cwd(), 'data', 'evidence', 'esakshi');
const maxWorks = Math.max(Number(process.env.MPLADS_ATTACHMENT_MAX_WORKS || 0), 0);
const maxFiles = Math.max(Number(process.env.MPLADS_ATTACHMENT_MAX_FILES || 0), 0);
const allAttachments = process.argv.includes('--all-attachments');
const resume = process.argv.includes('--resume');
const progressPath = join(root, 'attachments-progress.json');

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const safe = (value) => clean(value).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 80) || 'unknown';
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

function inferMime(fileName, buffer) {
  const name = String(fileName || '').toLowerCase();
  if (buffer.subarray(0, 4).toString() === '%PDF') return { mime: 'application/pdf', ext: '.pdf' };
  if (buffer.subarray(0, 3).toString('hex') === 'ffd8ff' || /\.jpe?g$/.test(name)) return { mime: 'image/jpeg', ext: '.jpg' };
  if (buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' || /\.png$/.test(name)) return { mime: 'image/png', ext: '.png' };
  if (/\.webp$/.test(name)) return { mime: 'image/webp', ext: '.webp' };
  return { mime: 'application/octet-stream', ext: extname(name) || '.bin' };
}

function decodeBinary(value) {
  if (typeof value !== 'string' || value === 'N/A') return null;
  const match = value.match(/^data:[^;]+;base64,(.*)$/i);
  const base64 = (match ? match[1] : value).replace(/\s/g, '');
  if (!/^[a-z0-9+/=]+$/i.test(base64) || base64.length < 20) return null;
  const buffer = Buffer.from(base64, 'base64');
  return buffer.length ? buffer : null;
}

function decodeAttachmentRow(row) {
  if (!row || typeof row !== 'object') return null;
  for (const key of ['URL', 'url', 'CONTENT', 'content', 'DATA', 'data', 'FILE_DATA', 'fileData', 'DOCUMENT']) {
    const buffer = decodeBinary(row[key]);
    if (buffer) return { buffer, fileName: row.FILE_NAME || row.fileName || null };
  }
  return null;
}

async function main() {
  const sourceRows = (await readFile(join(root, 'projects.ndjson'), 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const candidates = sourceRows.filter((row) => allAttachments || row.fileStatus);
  let progress = { completedWorkIds: [], attachments: [], errors: [] };
  if (resume) {
    try { progress = JSON.parse(await readFile(progressPath, 'utf8')); } catch { /* start a new resumable run */ }
  }
  const completed = new Set(progress.completedWorkIds || []);
  const works = candidates.filter((row) => !completed.has(`${row.sourceWorkId}|${row.term}|${row.houseCode}`)).slice(0, maxWorks || candidates.length);
  const attachments = [];
  const errors = [...(progress.errors || [])];
  for (const work of works) {
    const attachmentStart = attachments.length;
    const flags = [...new Set([work.flag, 1, 2, 3].filter((flag) => Number.isFinite(flag)))];
    for (const flag of flags) {
      try {
        const referenceRows = await getAttachmentReferences(work.raw || work, flag);
        const referenceRefs = attachmentIdsFromReferenceRows(referenceRows);
        const refs = referenceRefs.length ? referenceRefs : attachmentIdsFromReferenceRows([work.raw || work]);
        for (const ref of refs) {
          if (!ref.id) continue;
          const payloadRows = await getAttachment(ref.id);
          for (const payloadRow of payloadRows) {
            const decoded = decodeAttachmentRow(payloadRow);
            if (!decoded) continue;
            const info = inferMime(decoded.fileName || ref.fileName, decoded.buffer);
            const digest = sha256(decoded.buffer);
            const dir = join(evidenceRoot, safe(work.term), safe(work.state), safe(work.sourceWorkId));
            await mkdir(dir, { recursive: true });
            const filePath = join(dir, `${digest}${info.ext}`);
            await writeFile(filePath, decoded.buffer);
            const analysis = info.mime.startsWith('image/')
              ? await analyzeImage(decoded.buffer, `${ESAKSHI_ORIGIN}/attachment/${ref.id}`)
              : { sourceUrl: `${ESAKSHI_ORIGIN}/attachment/${ref.id}`, sha256: digest, bytes: decoded.buffer.length, analyzedAt: new Date().toISOString(), analyzer: 'binary-evidence-v0.2.0' };
            attachments.push({ sourceWorkId: work.sourceWorkId, term: work.term, houseCode: work.houseCode, state: work.state, flag, attachmentId: ref.id, fileName: decoded.fileName || ref.fileName, mimeType: info.mime, localPath: filePath, sha256: digest, ...analysis });
            if (maxFiles && attachments.length >= maxFiles) break;
          }
          if (maxFiles && attachments.length >= maxFiles) break;
        }
      } catch (error) { errors.push({ sourceWorkId: work.sourceWorkId, flag, error: error.message }); }
      if (maxFiles && attachments.length >= maxFiles) break;
    }
    completed.add(`${work.sourceWorkId}|${work.term}|${work.houseCode}`);
    if (resume) {
      progress.attachments = [...(progress.attachments || []), ...attachments.slice(attachmentStart)];
      progress.errors = errors;
      await writeFile(progressPath, JSON.stringify({ completedWorkIds: [...completed], attachments: progress.attachments, errors }, null, 2), 'utf8');
    }
    if (maxFiles && attachments.length >= maxFiles) break;
  }
  const outputRows = resume ? [...(progress.attachments || []), ...attachments] : attachments;
  await writeFile(join(root, 'attachments.ndjson'), outputRows.map((row) => JSON.stringify(row)).join('\n'), 'utf8');
  await writeFile(join(root, 'attachments-manifest.json'), JSON.stringify({ fetchedAt: new Date().toISOString(), candidateWorks: candidates.length, selectedWorks: works.length, completedWorks: completed.size, attachments: outputRows.length, errors, mode: allAttachments ? 'all' : 'file-status' }, null, 2), 'utf8');
  console.log(JSON.stringify({ selectedWorks: works.length, completedWorks: completed.size, attachments: outputRows.length, images: outputRows.filter((row) => row.mimeType.startsWith('image/')).length, pdfs: outputRows.filter((row) => row.mimeType === 'application/pdf').length, errors: errors.length }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
