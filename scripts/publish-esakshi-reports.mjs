import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeWork } from '../src/esakshi-source.js';

const root = process.env.ESAKSHI_ROOT || 'data/raw/esakshi';
const reportFiles = (await readdir(root)).filter((file) => /^report-.*-Works-(Recommended|Sanctioned|Completed)\.json$/i.test(file));
const allWorks = new Map();
const sourceStates = new Set();
for (const file of reportFiles) {
  const rows = JSON.parse(await readFile(join(root, file), 'utf8'));
  for (const row of rows) {
    const normalized = normalizeWork(row, file);
    delete normalized.raw;
    sourceStates.add(normalized.state);
    const key = normalized.sourceWorkId ? `${normalized.sourceWorkId}|${normalized.term}|${normalized.houseCode}` : `${file}|${row.Sno}`;
    const previous = allWorks.get(key) || { ...normalized, sources: [], attachmentRefs: [] };
    allWorks.set(key, { ...previous, ...Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== null && value !== '')), sources: [...new Set([...previous.sources, file.replace(/^report-/, '').replace(/-Works-.*$/, '')])] });
  }
}
const works = [...allWorks.values()];
const fields = ['sourceWorkId', 'sourceWorkRecommendationId', 'sourceWorkIdPhysical', 'workCategory', 'activityName', 'state', 'constituency', 'constituencyId', 'implementingAuthority', 'term', 'mp', 'houseCode', 'description', 'recommendationDate', 'sanctionDate', 'actualEndDate', 'recommendedAmount', 'sanctionAmount', 'actualAmount', 'letterNo', 'stage', 'flag', 'fileStatus', 'sources'];
const cell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
const csv = [fields.join(';'), ...works.map((row) => fields.map((field) => cell(field === 'sources' ? row.sources.join('|') : row[field])).join(';'))].join('\n');
await writeFile(join(root, 'projects.csv'), csv, 'utf8');
await writeFile(join(root, 'projects.ndjson'), works.map((row) => JSON.stringify(row)).join('\n'), 'utf8');
const manifest = { sourceUrl: 'https://mplads.mospi.gov.in/digigov/dashboard.html', apiOrigin: 'https://mplads.mospi.gov.in', generatedAt: new Date().toISOString(), reportFiles: reportFiles.length, states: [...sourceStates].sort(), works: works.length, status: 'reports-published-attachments-still-running' };
await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
console.log(JSON.stringify({ ...manifest, output: root }, null, 2));
