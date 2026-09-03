import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { putR2Object, r2Configured } from '../src/persistence/r2.js';

const root = process.env.ESAKSHI_ROOT || 'data/raw/esakshi';
if (!r2Configured()) { console.log(JSON.stringify({ uploaded: 0, status: 'skipped', reason: 'R2 access credentials are not configured' })); process.exit(0); }
const files = [];
async function walk(dir) { for (const entry of await readdir(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) await walk(path); else if (/\.(csv|ndjson|json)$/i.test(entry.name)) files.push(path); } }
await walk(root);
const uploaded = [];
for (const path of files) { const key = `mplads/raw/${relative(root, path).replaceAll('\\', '/')}`; const body = await readFile(path); const stored = await putR2Object(key, body, path.endsWith('.csv') ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8'); uploaded.push({ key: stored.key, url: stored.url, bytes: body.length }); }
console.log(JSON.stringify({ uploaded: uploaded.length, status: 'completed', objects: uploaded }, null, 2));
