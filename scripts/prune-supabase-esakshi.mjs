import { readFile } from 'node:fs/promises';

const input = process.env.ESAKSHI_INPUT || 'data/raw/esakshi/projects.ndjson';
const baseUrl = process.env.SUPABASE_URL?.replace(/\/$/, '');
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const pageSize = 1000;

if (!baseUrl || !serviceKey) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before pruning. No data was changed.');
  process.exit(2);
}

const currentRows = (await readFile(input, 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
const currentKeys = new Set(currentRows.map((row) => `${row.sourceWorkId}|${row.term}|${row.houseCode}`));
const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
const staleIds = [];
let offset = 0;

while (true) {
  const query = new URLSearchParams({ select: 'id,source_work_id,term,house_code', order: 'id', limit: String(pageSize), offset: String(offset) });
  const response = await fetch(`${baseUrl}/rest/v1/projects?${query}`, { headers });
  if (!response.ok) throw new Error(`Supabase project scan failed with HTTP ${response.status}: ${await response.text()}`);
  const rows = await response.json();
  for (const row of rows) if (!currentKeys.has(`${row.source_work_id}|${row.term}|${row.house_code}`)) staleIds.push(row.id);
  if (rows.length < pageSize) break;
  offset += pageSize;
}

for (let index = 0; index < staleIds.length; index += 200) {
  const batch = staleIds.slice(index, index + 200);
  const query = new URLSearchParams({ id: `in.(${batch.join(',')})` });
  const response = await fetch(`${baseUrl}/rest/v1/projects?${query}`, { method: 'DELETE', headers: { ...headers, Prefer: 'return=minimal' } });
  if (!response.ok) throw new Error(`Supabase stale-row delete failed with HTTP ${response.status}: ${await response.text()}`);
  console.log(JSON.stringify({ deleted: Math.min(index + batch.length, staleIds.length), total: staleIds.length }));
}

console.log(JSON.stringify({ scanned: offset + pageSize, currentRegister: currentRows.length, deleted: staleIds.length }, null, 2));
