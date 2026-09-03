import { readdir, writeFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

const root = process.env.ESAKSHI_EVIDENCE_ROOT || 'data/evidence/esakshi';
const output = process.env.ESAKSHI_ATTACHMENTS || 'data/raw/esakshi/attachments.ndjson';
const publicUrl = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
const rows = [];
const mime = (file) => ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.pdf': 'application/pdf' }[extname(file).toLowerCase()] || 'application/octet-stream');
async function walk(dir) { for (const entry of await readdir(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) await walk(path); else if (/\.(jpe?g|png|webp|pdf|bin)$/i.test(entry.name)) { const rel = relative(root, path).replaceAll('\\', '/'); const parts = rel.split('/'); if (parts.length < 4) continue; const [termFolder, state, sourceWorkId, fileName] = parts; const term = termFolder.replaceAll('-', ' '); const key = `mplads/${sourceWorkId}/${fileName}`; rows.push({ sourceWorkId, term, houseCode: ['Retired', 'Sitting'].includes(term) ? '1' : '2', attachmentId: fileName.replace(/\.[^.]+$/, ''), fileName, mimeType: mime(fileName), localPath: path, r2Key: key, r2Url: publicUrl ? `${publicUrl}/${key}` : null, sourceUrl: null, sha256: fileName.replace(/\.[^.]+$/, '') }); } } }
await walk(root);
await writeFile(output, rows.map((row) => JSON.stringify(row)).join('\n'), 'utf8');
console.log(JSON.stringify({ indexed: rows.length, output }, null, 2));
