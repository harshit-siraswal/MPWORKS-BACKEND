import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = process.env.MPLADS_CATALOG_PATH || join(here, '..', 'data', 'source', 'MPLADS.csv');
const sourceUrl = 'https://mplads.gov.in/mplads/';
const sourceRepository = 'https://github.com/Vonter/india-mplads-works';

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
const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const stableId = (row, index) => createHash('sha1').update(JSON.stringify(row)).digest('hex').slice(0, 12) + `-${index}`;
const sourceDate = (row) => clean(row['RECOMMENDED DATE']) || 'Not stated in source';
const amountInr = (value) => Number(String(value ?? '').replace(/[^0-9.-]/g, '')) || null;
const formatInr = (value) => {
  const amount = amountInr(value);
  return amount ? `₹${new Intl.NumberFormat('en-IN').format(amount)}` : 'Not stated in source';
};

function districtFromRow(row) {
  const ida = clean(row.IDA).replace(/_IDA$/i, '').replace(/,/g, ' ').trim();
  const withoutOffice = ida
    .replace(/^(AND\s+)?(DISTRICT\s+DEVELOPMENT\s+COMMISSIONER|DISTRICT\s+PLANNING\s+OFFICER|DISTRICT\s+COLLECTOR|DISTRICT\s+MAGISTRATE|DEPUTY\s+COMMISSIONER|COLLECTOR\s+CUM\s+DEV\s+COMMISSIONER|PROJECT\s+DIRECTOR\s+RDA|COMMISSIONER|COLLECTOR|DC|DM)\s*/i, '')
    .replace(/\s+MPLADS$/i, '')
    .trim();
  const districtPhrase = withoutOffice.match(/^(.+?)\s+DISTRICT(?:\s+.*)?$/i)?.[1];
  return clean(districtPhrase || withoutOffice || row.DISTRICT || row.CITY) || 'District not stated in source';
}

function termFromRow(row, house) {
  const member = clean(row['MP NAME']);
  const explicitTerm = member.match(/(1[5-8]th\s+Lok Sabha)/i)?.[1];
  if (explicitTerm) return explicitTerm.replace(/\s+/g, ' ');
  if (house === 'Rajya Sabha') return 'Rajya Sabha';
  // The checked-in upstream snapshot covers the 17th Lok Sabha period.
  return '17th Lok Sabha';
}

function memberTypeFromRow(row, house) {
  const member = clean(row['MP NAME']);
  if (house === 'Rajya Sabha' && /nominated/i.test(member)) return 'Nominated MP';
  if (/ex\s*mp|former/i.test(member)) return 'Former MP';
  if (house === 'Rajya Sabha') return 'Sitting MP';
  return 'Elected MP';
}

function attachmentValues(row) {
  return Object.entries(row)
    .filter(([key, value]) => value && /(image|attachment|photo|document|work.?id|wrk.?rec)/i.test(key))
    .flatMap(([, value]) => String(value).split(/[,|]/).map(clean).filter(Boolean));
}

const catalog = sourceRows.map((row, index) => {
  const house = clean(row.HOUSE) || (/rajya/i.test(clean(row.CONSTITUENCY)) ? 'Rajya Sabha' : 'Lok Sabha');
  const village = clean(row.VILLAGE);
  const block = clean(row.BLOCK);
  const city = clean(row.CITY);
  const ward = clean(row.WARD);
  const district = districtFromRow(row);
  const constituency = clean(row.CONSTITUENCY);
  const state = clean(row.STATE);
  const term = termFromRow(row, house);
  const memberType = memberTypeFromRow(row, house);
  const locationParts = [village, block, district, constituency, state].filter(Boolean);
  const attachmentCandidates = attachmentValues(row);
  const attachmentIds = attachmentCandidates.filter((value) => !/^https?:\/\//i.test(value) && /\d/.test(value));
  const imageUrls = attachmentCandidates.filter((value) => /^https?:\/\//i.test(value) && /image|photo|attachment/i.test(value));
  return {
    id: stableId(row, index),
    title: clean(row.WORK) || 'Untitled work in source record',
    location: locationParts.join(' · ') || 'Location not stated in source',
    villageRaw: village,
    city,
    ward,
    state,
    district,
    block,
    constituency,
    house,
    term,
    memberType,
    mp: clean(row['MP NAME']) || 'MP not stated in source',
    category: clean(row.CATEGORY) || 'Category not stated in source',
    status: clean(row.STATUS) || 'Status not stated in source',
    amount: formatInr(row['ALLOCATION AMOUNT']),
    evidence: imageUrls.length ? `${imageUrls.length + 1} source items` : '1 source record',
    updated: sourceDate(row),
    risk: 'Requires manual verification',
    score: null,
    review: true,
    source: 'MPLADS source snapshot · india-mplads-works',
    sourceUrl,
    sourceLicense: 'ODbL-1.0',
    sourceDate: sourceDate(row),
    fetchTimestamp: sourceFileUpdatedAt,
    summary: 'This record comes from a source-backed MPLADS work-list snapshot. Image evidence and project coordinates are only shown when the upstream record supplies them; their absence is not a conclusion.',
    evidenceItems: [
      { type: 'source-record', label: 'MPLADS work list row', status: 'available' },
      { type: 'image', label: 'Image evidence', status: imageUrls.length ? 'available' : 'not-in-source' },
      { type: 'location', label: 'Reliable project coordinates', status: 'not-in-source' }
    ],
    imageUrls,
    attachmentIds,
    attachmentCandidates,
    signals: [],
    raw: row,
    normalized: { workName: clean(row.WORK), village, city, ward, state, district, block, amountInr: amountInr(row['ALLOCATION AMOUNT']), hasReliableCoordinates: false }
  };
});

const unique = (items) => [...new Set(items.filter(Boolean))].sort((a, b) => a.localeCompare(b));

export function listProjects(filters = {}) {
  const query = clean(filters.query).toLowerCase();
  return catalog.filter((project) => {
    const haystack = `${project.title} ${project.location} ${project.villageRaw} ${project.city} ${project.ward} ${project.mp} ${project.category}`.toLowerCase();
    return (!query || haystack.includes(query))
      && (!filters.house || filters.house === 'All houses' || project.house === filters.house)
      && (!filters.term || filters.term === 'All terms' || project.term === filters.term)
      && (!filters.memberType || filters.memberType === 'All member types' || project.memberType === filters.memberType)
      && (!filters.state || filters.state === 'All states' || project.state === filters.state)
      && (!filters.district || filters.district === 'All districts' || project.district === filters.district)
      && (!filters.category || filters.category === 'All categories' || project.category === filters.category)
      && (!filters.status || filters.status === 'All statuses' || project.status === filters.status);
  });
}

export function getProject(id) { return catalog.find((project) => project.id === String(id)); }

export function getFacets(filters = {}) {
  const scoped = listProjects(filters);
  return {
    terms: ['17th Lok Sabha', '18th Lok Sabha'],
    houses: ['Lok Sabha', 'Rajya Sabha'],
    memberTypes: unique(catalog.map((project) => project.memberType)),
    states: unique((filters.house || filters.term) ? scoped.map((project) => project.state) : catalog.map((project) => project.state)),
    districts: unique(scoped.map((project) => project.district)),
    categories: unique(scoped.map((project) => project.category)),
    statuses: unique(scoped.map((project) => project.status))
  };
}

export function getSummary() {
  const total = catalog.length;
  const withImages = catalog.filter((project) => project.imageUrls.length).length;
  const terms = { '17th Lok Sabha': catalog.filter((project) => project.term === '17th Lok Sabha').length, '18th Lok Sabha': catalog.filter((project) => project.term === '18th Lok Sabha').length, 'Rajya Sabha': catalog.filter((project) => project.term === 'Rajya Sabha').length };
  return {
    total,
    completed: catalog.filter((project) => project.status.toLowerCase().includes('completed')).length,
    review: total,
    imageCoverage: total ? Math.round((withImages / total) * 10000) / 100 : null,
    sourceCoverage: 100,
    sourceDataThrough: catalog.map((project) => project.sourceDate).filter(Boolean).sort().at(-1) || null,
    lastUpdated: sourceFileUpdatedAt,
    terms,
    provenance: { source: sourceRepository, sourceUrl, license: 'ODbL-1.0', recordCount: total, snapshot: true }
  };
}

export function getSourceHealth() {
  const summary = getSummary();
  return {
    status: 'snapshot', source: sourceRepository, sourceUrl, license: 'ODbL-1.0', sourceFileUpdatedAt,
    discovered: catalog.length, parsed: catalog.length, failed: 0, imageDownloadRate: summary.imageCoverage,
    parserVersion: 'mplads-csv-parser-v0.2.0', staleRegions: [],
    termsAvailable: unique(catalog.map((project) => project.term)),
    housesAvailable: unique(catalog.map((project) => project.house)),
    notes: ['This checked-in snapshot is source-backed but not a live feed.', 'The snapshot has no image attachments or reliable project coordinates.', 'Run npm run fetch:mplads to crawl the official work register and create a fresh raw manifest.']
  };
}

export function getSourceMetadata() {
  return {
    sourceUrl, sourceFile: 'data/source/MPLADS.csv', sourceRepository, license: 'ODbL-1.0',
    officialWorkRegister: 'https://mplads.gov.in/MPLADS/AuthenticatedPages/Reports/Citizen/rptCitizenWorkRegister.aspx',
    liveIngestCommand: 'npm run fetch:mplads',
    currentSnapshot: '1 Apr 2023 onward upstream work-list export; flattened rows are labeled 17th Lok Sabha or Rajya Sabha when the source row does not carry an explicit term.'
  };
}

export function getCatalogRows() { return catalog; }
