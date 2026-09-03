import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const inputDir = process.env.MPLADS_RAW_DIR || join(process.cwd(), 'data', 'raw', 'mplads');
const outputFile = process.env.MPLADS_OUTPUT || join(process.cwd(), 'data', 'source', 'MPLADS-live.csv');
const knownHeaders = ['MP NAME', 'WORK', 'CATEGORY', 'STATE', 'CONSTITUENCY', 'IDA', 'CITY', 'WARD', 'BLOCK', 'VILLAGE', 'RECOMMENDED DATE', 'ALLOCATION AMOUNT', 'IDA APPROVAL', 'STATUS'];

function clean(value) { return String(value ?? '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim(); }
function quote(value) { return `"${String(value ?? '').replace(/"/g, '""')}"`; }
function sourceContext(filename) {
  const lower = filename.toLowerCase();
  return { HOUSE: lower.includes('rajya') ? 'Rajya Sabha' : 'Lok Sabha', TERM: filename.match(/(1[5-8]th\s+Lok Sabha)/i)?.[1] || (lower.includes('rajya') ? 'Rajya Sabha' : '17th Lok Sabha') };
}
function tableRows(html) {
  return [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => [...match[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => clean(cell[1]))).filter((row) => row.length);
}

await mkdir(inputDir, { recursive: true });
const files = (await readdir(inputDir)).filter((file) => /\.(html?|xls)$/i.test(file) && !file.endsWith('.evidence.json'));
const rows = [];
const errors = [];
for (const file of files) {
  const buffer = await readFile(join(inputDir, file));
  const html = buffer.toString('utf8');
  if (html.includes('\u0000')) { errors.push({ file, error: 'binary workbook; export as HTML or add a workbook parser before normalization' }); continue; }
  const parsed = tableRows(html);
  if (!parsed.length) continue;
  const headerRow = parsed.find((row) => row.some((cell) => /MP NAME|WORK|CATEGORY/i.test(cell)));
  if (!headerRow) continue;
  const headerIndexes = new Map(headerRow.map((header, index) => [header.toUpperCase(), index]));
  for (const row of parsed.slice(parsed.indexOf(headerRow) + 1)) {
    if (!row.some(Boolean) || row.join(' ').toLowerCase().includes('no records')) continue;
    const output = Object.fromEntries(knownHeaders.map((header) => [header, row[headerIndexes.get(header)] || '']));
    if (!output.WORK && !output['MP NAME']) continue;
    Object.assign(output, sourceContext(file), { SOURCE_FILE: file });
    rows.push(output);
  }
}

const headers = [...knownHeaders, 'HOUSE', 'TERM', 'SOURCE_FILE'];
if (!rows.length) {
  console.log(JSON.stringify({ inputDir, outputFile, files: files.length, records: 0, errors, note: 'No raw exports found; no normalized catalog was written.' }, null, 2));
  process.exit(0);
}
const csv = [headers.map(quote).join(';'), ...rows.map((row) => headers.map((header) => quote(row[header])).join(';'))].join('\n') + '\n';
await writeFile(outputFile, csv, 'utf8');
console.log(JSON.stringify({ inputDir, outputFile, files: files.length, records: rows.length, errors }, null, 2));
