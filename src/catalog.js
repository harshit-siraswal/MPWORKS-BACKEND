import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = join(here, '..', 'data', 'source', 'MPLADS.csv');
const sourceUrl = 'https://www.mplads.gov.in/mplads/';

function parseDelimitedLine(line) {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"' && line[index + 1] === '"' && quoted) { cell += '"'; index += 1; continue; }
    if (character === '"') { quoted = !quoted; continue; }
    if (character === ';' && !quoted) { cells.push(cell.trim()); cell = ''; continue; }
    cell += character;
  }
  cells.push(cell.trim());
  return cells;
}

function readSourceRows() {
  const lines = readFileSync(sourcePath, 'utf8').split(/\r?\n/).filter(Boolean);
  const headers = parseDelimitedLine(lines.shift()).map((header) => header.replace(/^\uFEFF/, ''));
  return lines.map((line) => Object.fromEntries(parseDelimitedLine(line).map((value, index) => [headers[index], value])));
}

const sourceRows = readSourceRows();
const sourceFileUpdatedAt = statSync(sourcePath).mtime.toISOString();
const clean = (value) => String(value || '').trim();
const stableId = (row, index) => createHash('sha1').update(JSON.stringify(row)).digest('hex').slice(0, 12) + `-${index}`;
const formatInr = (value) => {
  const amount = Number(String(value || '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(amount) && amount > 0 ? `₹${new Intl.NumberFormat('en-IN').format(amount)}` : 'Not stated in source';
};
const sourceDate = (row) => clean(row['RECOMMENDED DATE']) || 'Not stated in source';

const catalog = sourceRows.map((row, index) => {
  const village = clean(row.VILLAGE);
  const block = clean(row.BLOCK);
  const constituency = clean(row.CONSTITUENCY);
  const state = clean(row.STATE);
  const locationParts = [village, block, constituency, state].filter(Boolean);
  return {
    id: stableId(row, index),
    title: clean(row.WORK) || 'Untitled work in source record',
    location: locationParts.join(' · ') || 'Location not stated in source',
    villageRaw: village,
    state,
    district: block,
    constituency,
    mp: clean(row['MP NAME']) || 'MP not stated in source',
    category: clean(row.CATEGORY) || 'Category not stated in source',
    status: clean(row.STATUS) || 'Status not stated in source',
    amount: formatInr(row['ALLOCATION AMOUNT']),
    evidence: '1 source record',
    updated: sourceDate(row),
    risk: 'Requires manual verification',
    score: null,
    review: true,
    source: 'MPLADS source snapshot · india-mplads-works',
    sourceUrl,
    sourceLicense: 'ODbL-1.0',
    sourceDate: sourceDate(row),
    fetchTimestamp: sourceFileUpdatedAt,
    summary: 'This record comes from the public MPLADS source snapshot. The snapshot does not include image evidence, reliable coordinates, or an independently calculated risk score.',
    evidenceItems: [
      { type: 'source-record', label: 'MPLADS work list row', status: 'available' },
      { type: 'image', label: 'Image evidence', status: 'not-in-source' },
      { type: 'location', label: 'Reliable coordinates', status: 'not-in-source' }
    ],
    signals: [],
    raw: row,
    normalized: { workName: clean(row.WORK), village, state, block, amountInr: Number(String(row['ALLOCATION AMOUNT'] || '').replace(/[^0-9.-]/g, '')) || null, hasReliableCoordinates: false }
  };
});

export function listProjects(filters = {}) {
  const query = clean(filters.query).toLowerCase();
  return catalog.filter((project) => {
    const haystack = `${project.title} ${project.location} ${project.villageRaw} ${project.mp} ${project.category}`.toLowerCase();
    return (!query || haystack.includes(query))
      && (!filters.state || filters.state === 'All states' || project.state === filters.state)
      && (!filters.district || filters.district === 'All districts' || project.district === filters.district)
      && (!filters.category || filters.category === 'All categories' || project.category === filters.category);
  });
}

export function getProject(id) { return catalog.find((project) => project.id === String(id)); }

export function getFacets() {
  const unique = (key) => [...new Set(catalog.map((project) => project[key]).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return { states: unique('state'), districts: unique('district'), categories: unique('category') };
}

export function getSummary() {
  const total = catalog.length;
  return {
    total,
    completed: catalog.filter((project) => project.status.toLowerCase().includes('completed')).length,
    review: total,
    imageCoverage: null,
    sourceCoverage: null,
    sourceDataThrough: catalog.map((project) => project.sourceDate).filter(Boolean).sort().at(-1) || null,
    lastUpdated: sourceFileUpdatedAt,
    provenance: { source: 'Vonter/india-mplads-works', sourceUrl, license: 'ODbL-1.0', recordCount: total }
  };
}

export function getSourceHealth() {
  return { status: 'snapshot', source: 'Vonter/india-mplads-works', sourceUrl, license: 'ODbL-1.0', sourceFileUpdatedAt, discovered: catalog.length, parsed: catalog.length, failed: 0, imageDownloadRate: null, parserVersion: 'mplads-csv-parser-v0.1.0', staleRegions: [], notes: ['This source snapshot contains work-list records but no image attachments or reliable coordinates.'] };
}

export function getSourceMetadata() { return { sourceUrl, license: 'ODbL-1.0', sourceFile: 'data/source/MPLADS.csv', sourceRepository: 'https://github.com/Vonter/india-mplads-works' }; }
