import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { putR2Object, r2Configured } from '../src/persistence/r2.js';
import { supabaseConfigured, supabaseSelect, supabaseUpsert } from '../src/persistence/supabase.js';

const input = process.env.ESAKSHI_ATTACHMENTS || 'data/raw/esakshi/attachments.ndjson';
if (!r2Configured()) { console.error('Set R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY before uploading. No objects were written.'); process.exit(2); }
const rows = (await readFile(input, 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
const projectRows = supabaseConfigured() ? await supabaseSelect('projects', 'select=id,source_work_id,term,house_code') : [];
const projectBySource = new Map((projectRows || []).map((row) => [`${row.source_work_id}|${row.term}|${row.house_code}`, row.id]));
const documents = [];
for (const row of rows) {
  const buffer = await readFile(row.localPath);
  const key = `mplads/${row.sourceWorkId}/${row.sha256}${basename(row.localPath).slice(row.localPath.lastIndexOf('.'))}`;
  const stored = await putR2Object(key, buffer, row.mimeType);
  row.r2Key = stored.key;
  row.r2Url = stored.url;
  documents.push({ project_id: projectBySource.get(`${row.sourceWorkId}|${row.term}|${row.houseCode}`) || null, source_attachment_id: row.attachmentId, source_file_name: row.fileName || null, source_url: row.sourceUrl || null, r2_key: stored.key, r2_url: stored.url, mime_type: row.mimeType, byte_size: row.byteSize || row.bytes || buffer.length, sha256: row.sha256, status: 'stored', analysis: row });
}
await writeFile(input, rows.map((row) => JSON.stringify(row)).join('\n'), 'utf8');
const mappedDocuments = documents.filter((row) => row.project_id);
if (supabaseConfigured() && mappedDocuments.length) await supabaseUpsert('project_documents', mappedDocuments, 'project_id,source_attachment_id');
console.log(JSON.stringify({ uploaded: documents.length, bucket: process.env.R2_BUCKET, documents }, null, 2));
