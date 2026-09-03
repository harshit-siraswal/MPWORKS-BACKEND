import { readFile, writeFile } from 'node:fs/promises';
import { putR2Object, r2Configured } from '../src/persistence/r2.js';
import { supabaseConfigured, supabaseSelect, supabaseUpsert } from '../src/persistence/supabase.js';

const input = process.env.ESAKSHI_ATTACHMENTS || 'data/raw/esakshi/attachments.ndjson';
const concurrency = Math.max(1, Math.min(Number(process.env.R2_UPLOAD_CONCURRENCY || 6), 12));
if (!r2Configured()) { console.error('Set R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY before uploading. No objects were written.'); process.exit(2); }
const rows = (await readFile(input, 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
let nextIndex = 0;
let uploaded = 0;
const workers = Array.from({ length: concurrency }, async () => {
  while (true) {
    const index = nextIndex++;
    if (index >= rows.length) return;
    const row = rows[index];
    const buffer = await readFile(row.localPath);
    // Keep the key stable with the previously uploaded evidence objects.
    const key = `mplads/${row.sourceWorkId}/${row.sha256}`;
    const stored = await putR2Object(key, buffer, row.mimeType);
    row.r2Key = stored.key;
    row.r2Url = stored.url;
    uploaded += 1;
    if (uploaded % 100 === 0 || uploaded === rows.length) console.log(JSON.stringify({ uploaded, total: rows.length }));
  }
});
await Promise.all(workers);
await writeFile(input, rows.map((row) => JSON.stringify(row)).join('\n'), 'utf8');
let mappedDocuments = [];
if (supabaseConfigured() && rows.length) {
  // Resolve only evidence-related projects instead of loading the full catalogue into memory.
  const sourceIds = [...new Set(rows.map((row) => String(row.sourceWorkId)).filter(Boolean))];
  const projectBySource = new Map();
  for (let index = 0; index < sourceIds.length; index += 100) {
    const batch = sourceIds.slice(index, index + 100).filter((value) => /^[A-Za-z0-9_-]+$/.test(value));
    const query = `select=id,source_work_id,term,house_code&source_work_id=in.(${batch.join(',')})`;
    const projectRows = await supabaseSelect('projects', query);
    for (const project of projectRows || []) projectBySource.set(`${project.source_work_id}|${project.term}|${project.house_code}`, project.id);
  }
  mappedDocuments = rows.map((row) => ({
    project_id: projectBySource.get(`${row.sourceWorkId}|${row.term}|${row.houseCode}`) || null,
    source_attachment_id: row.attachmentId,
    source_file_name: row.fileName || null,
    source_url: row.sourceUrl || null,
    r2_key: row.r2Key,
    r2_url: row.r2Url,
    mime_type: row.mimeType,
    byte_size: row.byteSize || row.bytes || null,
    sha256: row.sha256,
    status: 'stored',
    analysis: { sourceWorkId: row.sourceWorkId, term: row.term, houseCode: row.houseCode, r2Key: row.r2Key, r2Url: row.r2Url, sha256: row.sha256 }
  })).filter((row) => row.project_id);
  for (let index = 0; index < mappedDocuments.length; index += 250) await supabaseUpsert('project_documents', mappedDocuments.slice(index, index + 250), 'project_id,source_attachment_id');
}
console.log(JSON.stringify({ uploaded, bucket: process.env.R2_BUCKET, documentRows: mappedDocuments.length, concurrency }, null, 2));
