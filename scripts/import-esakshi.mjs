import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extractVillages } from '../src/village-extraction.js';
import { supabaseConfigured, supabaseUpsert } from '../src/persistence/supabase.js';

const input = process.env.ESAKSHI_INPUT || 'data/raw/esakshi/projects.ndjson';
const metricsInput = process.env.ESAKSHI_METRICS || 'data/raw/esakshi/metrics.json';
const batchSize = 250;
const snapshotId = process.env.MPWORKS_SNAPSHOT_ID || null;
const chunks = (rows) => Array.from({ length: Math.ceil(rows.length / batchSize) }, (_, i) => rows.slice(i * batchSize, (i + 1) * batchSize));
const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const dateOrNull = (value) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10); };
const sourceWorkIdFor = (row) => {
  const sourceWorkId = clean(row.sourceWorkId);
  if (sourceWorkId) return sourceWorkId;
  return `missing:${createHash('sha256').update(JSON.stringify(row)).digest('hex').slice(0, 40)}`;
};

async function upsertBatched(table, rows, conflict) {
  const result = [];
  for (const chunk of chunks(rows)) result.push(...await supabaseUpsert(table, chunk, conflict));
  return result;
}

if (!supabaseConfigured()) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before importing. No data was written.');
  process.exit(2);
}

const works = (await readFile(input, 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
const states = [...new Map(works.filter((row) => row.state).map((row) => [row.state.toUpperCase(), { source_id: row.state, name: row.state, normalized_name: row.state.toUpperCase(), raw: { name: row.state } }])).values()];
const stateRows = await upsertBatched('states', states, 'normalized_name');
const stateIds = new Map(stateRows.map((row) => [row.normalized_name, row.id]));
const districts = [...new Map(works.filter((row) => row.district).map((row) => [`${row.state}|${row.district}`, { state_id: stateIds.get(row.state?.toUpperCase()) || null, source_id: row.district, name: row.district, normalized_name: row.district.toUpperCase(), raw: { name: row.district } }])).values()];
const districtRows = await upsertBatched('districts', districts, 'state_id,normalized_name');
const districtIds = new Map(districtRows.map((row) => [`${row.state_id}|${row.normalized_name}`, row.id]));
const constituencies = [...new Map(works.filter((row) => row.constituency).map((row) => [`${row.state}|${row.constituency}|${row.houseCode}`, { state_id: stateIds.get(row.state?.toUpperCase()) || null, source_id: row.constituencyId, name: row.constituency, normalized_name: row.constituency.toUpperCase(), house: row.houseCode === '1' ? 'Rajya Sabha' : 'Lok Sabha', raw: row.raw || {} }])).values()];
const constituencyRows = await upsertBatched('constituencies', constituencies, 'state_id,normalized_name,house');
const constituencyIds = new Map(constituencyRows.map((row) => [`${row.normalized_name}|${row.house}`, row.id]));
const projects = works.map((row) => ({
  source_work_id: sourceWorkIdFor(row),
  source_work_recommendation_id: row.sourceWorkRecommendationId,
  source_work_id_physical: row.sourceWorkIdPhysical,
  snapshot_id: snapshotId,
  state_id: stateIds.get(row.state?.toUpperCase()) || null,
  state: row.state || null,
  district_id: districtIds.get(`${stateIds.get(row.state?.toUpperCase())}|${row.district?.toUpperCase()}`) || null,
  district: row.district || null,
  constituency: row.constituency || null,
  constituency_source_id: row.constituencyId || null,
  constituency_id: constituencyIds.get(`${row.constituency?.toUpperCase()}|${row.houseCode === '1' ? 'Rajya Sabha' : 'Lok Sabha'}`) || null,
  house_code: row.houseCode || null,
  house: row.houseCode === '1' ? 'Rajya Sabha' : 'Lok Sabha',
  term: row.term || null,
  mp: row.mp || null,
  work_category: row.workCategory || null,
  activity_name: row.activityName || null,
  implementing_authority: row.implementingAuthority || null,
  description: row.description || null,
  stage: row.stage || null,
  flag: row.flag,
  file_status: row.fileStatus,
  recommendation_date: dateOrNull(row.recommendationDate),
  sanction_date: dateOrNull(row.sanctionDate),
  actual_end_date: dateOrNull(row.actualEndDate),
  recommended_amount: row.recommendedAmount,
  sanction_amount: row.sanctionAmount,
  actual_amount: row.actualAmount,
  letter_no: row.letterNo || null,
  // Full source rows are retained in R2/NDJSON. Keep only a tiny locator in Postgres.
  raw: { sourceWorkId: row.sourceWorkId, sourceKey: row.sourceKey || null }
}));
const projectRows = await upsertBatched('projects', projects, 'source_work_id,term,house_code');
const projectIds = new Map(projectRows.map((row) => [`${row.source_work_id}|${row.term}|${row.house_code}`, row.id]));
const villageMap = new Map();
for (const row of works) for (const village of extractVillages(row)) villageMap.set(`${row.state}|${row.district || ''}|${village.normalizedName}`, { state_id: stateIds.get(row.state?.toUpperCase()) || null, district_id: districtIds.get(`${stateIds.get(row.state?.toUpperCase())}|${row.district?.toUpperCase()}`) || null, name: village.name, normalized_name: village.normalizedName, extraction_method: village.extractionMethod, confidence: village.confidence, raw_context: village.rawContext, raw: { sourceWorkId: row.sourceWorkId } });
const villageRows = await upsertBatched('villages', [...villageMap.values()], 'state_id,district_id,normalized_name');
const villageIds = new Map(villageRows.map((row) => [`${row.district_id}|${row.normalized_name}`, row.id]));
// Village links are inserted only when a stable village row was returned by Supabase.
const links = [];
for (const row of works) {
  const projectId = projectIds.get(`${sourceWorkIdFor(row)}|${row.term}|${row.houseCode}`);
  if (!projectId) continue;
  for (const village of extractVillages(row)) { const villageId = villageIds.get(`${districtIds.get(`${stateIds.get(row.state?.toUpperCase())}|${row.district?.toUpperCase()}`)}|${village.normalizedName}`); if (villageId) links.push({ project_id: projectId, village_id: villageId }); }
}
await upsertBatched('project_villages', links, 'project_id,village_id');
let metricRows = [];
try { metricRows = JSON.parse(await readFile(metricsInput, 'utf8')).map((row) => ({ state: row.state || null, house_code: String(row.houseCode), term: row.tenure || null, raw: row.payload || row })); } catch { /* metrics are optional for a reports-only run */ }
if (metricRows.length) await upsertBatched('project_metrics', metricRows, 'state,district,constituency,house_code,term');
console.log(JSON.stringify({ imported: { states: stateRows.length, districts: districtRows.length, constituencies: constituencyRows.length, projects: projectRows.length, villages: villageRows.length, links: links.length, metrics: metricRows.length }, sourceWorkIds: { synthetic: works.filter((row) => !clean(row.sourceWorkId)).length } }, null, 2));
