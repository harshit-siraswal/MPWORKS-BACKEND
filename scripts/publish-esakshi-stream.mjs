import { createWriteStream } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { normalizeWork } from '../src/esakshi-source.js';

const root = process.env.ESAKSHI_ROOT || 'data/raw/esakshi';
const files = (await readdir(root)).filter((file) => /^report-.*-Works-Recommended\.json$/i.test(file)).sort();
const ndjsonPath = join(root, 'projects.ndjson');
const csvPath = join(root, 'projects.csv');
const ndjson = createWriteStream(ndjsonPath, { encoding: 'utf8' });
const headers = ['sourceWorkId', 'sourceWorkRecommendationId', 'sourceWorkIdPhysical', 'workCategory', 'activityName', 'state', 'constituency', 'constituencyId', 'implementingAuthority', 'term', 'mp', 'houseCode', 'description', 'recommendationDate', 'sanctionDate', 'actualEndDate', 'recommendedAmount', 'sanctionAmount', 'actualAmount', 'letterNo', 'stage', 'flag', 'fileStatus', 'sources'];
const cell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
const csv = createWriteStream(csvPath, { encoding: 'utf8' });
csv.write(`${headers.join(';')}\n`);
let works = 0;
const states = new Set();
for (const file of files) {
  const rows = JSON.parse(await readFile(join(root, file), 'utf8'));
  for (const row of rows) {
    const normalized = normalizeWork(row, file);
    if (!normalized.sourceWorkId) continue;
    delete normalized.raw;
    states.add(normalized.state);
    normalized.sources = [file.replace(/^report-/, '').replace(/-Works-Recommended\.json$/i, '')];
    const line = JSON.stringify(normalized);
    if (!ndjson.write(`${line}\n`)) await once(ndjson, 'drain');
    if (!csv.write(`${headers.map((field) => cell(field === 'sources' ? normalized.sources.join('|') : normalized[field])).join(';')}\n`)) await once(csv, 'drain');
    works += 1;
  }
}
ndjson.end();
csv.end();
await Promise.all([once(ndjson, 'finish'), once(csv, 'finish')]);
const manifest = { sourceUrl: 'https://mplads.mospi.gov.in/digigov/dashboard.html', apiOrigin: 'https://mplads.mospi.gov.in', generatedAt: new Date().toISOString(), reportFiles: files.length, states: [...states].sort(), works, status: 'reports-published-streamed', attachmentFiles: 'Stored separately under data/evidence/esakshi; attachment index is finalized by the crawler when available.' };
await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
console.log(JSON.stringify({ ...manifest, output: root }, null, 2));
