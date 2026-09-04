import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.env.ESAKSHI_ROOT || 'data/raw/esakshi';
const names = await readdir(root);
const reportFiles = names.filter((name) => /^report-.*-Works-(Recommended|Sanctioned|Completed)\.json$/i.test(name));
const attachments = (await readFile(join(root, 'attachments.ndjson'), 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
const attachmentKeys = new Set(attachments.map((row) => `${row.sourceWorkId}|${row.term}|${row.houseCode}`));
const results = new Map();
const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const idFrom = (row) => String(row.WORK_RECOMMENDATION_DTL_ID ?? row.WORK_ID ?? row.ACTIVITY_NAME ?? '');

for (const file of reportFiles) {
  const reportType = file.match(/Works-(Recommended|Sanctioned|Completed)\.json$/i)?.[1] || 'Unknown';
  const rows = JSON.parse(await readFile(join(root, file), 'utf8'));
  const houseCode = file.match(/-(1|2)-/)?.[1] || '';
  const tenure = file.match(/^report-(.+?)-(?:1|2)-/)?.[1]?.replaceAll('-', ' ') || '';
  const bucket = results.get(reportType) || { reportType, rows: 0, fileStatus: 0, attachmentMatches: 0, terms: new Map() };
  for (const row of rows) {
    const term = clean(row.TENURE) || tenure;
    const key = `${idFrom(row)}|${term}|${String(row.HOUSE_OF_PARLIAMENT ?? houseCode)}`;
    bucket.rows += 1;
    if (row.FILE_STATUS === true || row.FILE_STATUS === 'true') bucket.fileStatus += 1;
    if (attachmentKeys.has(key)) bucket.attachmentMatches += 1;
    bucket.terms.set(term, (bucket.terms.get(term) || 0) + 1);
  }
  results.set(reportType, bucket);
}

console.log(JSON.stringify({
  reportFiles: reportFiles.length,
  attachments: attachments.length,
  reports: [...results.values()].map((row) => ({ ...row, terms: Object.fromEntries(row.terms) }))
}, null, 2));
