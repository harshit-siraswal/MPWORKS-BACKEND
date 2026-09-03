const DEFAULT_ORIGIN = 'https://mplads.mospi.gov.in';

export const ESAKSHI_ORIGIN = process.env.MPLADS_API_ORIGIN || DEFAULT_ORIGIN;
export const ESAKSHI_DASHBOARD_URL = process.env.MPLADS_SOURCE_URL || `${ESAKSHI_ORIGIN}/digigov/dashboard.html`;

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

async function post(path, body, timeoutMs = 60_000) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${ESAKSHI_ORIGIN}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8', Accept: 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`eSAKSHI ${path} returned HTTP ${response.status}`);
      const text = await response.text();
      try { return text ? JSON.parse(text.replace(/^\uFEFF/, '')) : null; }
      catch { throw new Error(`eSAKSHI ${path} returned invalid JSON`); }
    } catch (error) { lastError = error; if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1))); }
  }
  throw lastError;
}

function parseNestedReport(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const value = Object.values(payload).find((item) => typeof item === 'string' && item.trim().startsWith('['));
  if (!value) return [];
  try { return JSON.parse(value); } catch { return []; }
}

export async function getTenures(houseCode = 2) {
  return post('/rest/PreLoginDashboardData/getTenureData', { uname: `0,0,0,${houseCode}` });
}

export async function getStates() {
  return post('/rest/PreLoginDashboardData/getStateData', {});
}

export async function getConstituencies(stateId) {
  return post('/rest/PreLoginDashboardData/getConstituencyData', { id: stateId });
}

export async function getMpNames(stateId, houseCode, tenureId) {
  return post('/rest/PreLoginDashboardData/getMpNamesData', { state_combo: `${stateId},${houseCode},${tenureId}` });
}

export async function getMetrics(combo) {
  return post('/rest/PreLoginDashboardData/getTilesData', { uname: combo });
}

export async function getWorkReport(combo, key, timeoutMs = 120_000) {
  return parseNestedReport(await post('/rest/PreLoginDashboardData/getTilesReportData', { combo, key }, timeoutMs));
}

export async function getAttachmentReferences(work, flag = work.FLAG) {
  const payload = { ...work, FLAG: flag };
  const rows = await post('/rest/PreLoginDashboardData/getAttachIdsbyFlag', { json: payload });
  return Array.isArray(rows) ? rows : [];
}

export async function getAttachment(id) {
  const rows = await post('/rest/PreLoginCitizenWorkRcmdRest/getAttachmentById', { id }, 90_000);
  return Array.isArray(rows) ? rows : [];
}

export async function getReviews(work) {
  const rows = await post('/rest/PreLoginCitizenWorkRcmdRest/getReviewDetailsByWork', { json: work });
  return Array.isArray(rows) ? rows : [];
}

export function normalizeWork(row, sourceKey) {
  const id = row.WORK_RECOMMENDATION_DTL_ID ?? row.WORK_ID ?? row.ACTIVITY_NAME;
  return {
    sourceWorkId: id == null ? null : String(id),
    sourceWorkRecommendationId: row.WORK_RECOMMENDATION_DTL_ID == null ? null : String(row.WORK_RECOMMENDATION_DTL_ID),
    sourceWorkIdPhysical: row.WORK_ID == null ? null : String(row.WORK_ID),
    workCategory: clean(row.WORK_CATEGORY),
    activityName: clean(row.ACTIVITY_NAME),
    state: clean(row.STATE_NAME),
    district: clean(row.IDA_NAME).replace(/\s*\(.*$/, ''),
    constituency: clean(row.CONSTITUENCY),
    constituencyId: row.CONSTITUENCY_ID == null ? null : String(row.CONSTITUENCY_ID),
    implementingAuthority: clean(row.IDA_NAME),
    term: clean(row.TENURE),
    mp: clean(row.MP_NAME),
    houseCode: row.HOUSE_OF_PARLIAMENT == null ? null : String(row.HOUSE_OF_PARLIAMENT),
    description: clean(row.WORK_DESCRIPTION),
    recommendationDate: clean(row.RECOMMENDATION_DATE) || null,
    sanctionDate: clean(row.SANCTION_DATE) || null,
    actualEndDate: clean(row.ACTUAL_END_DATE) || null,
    recommendedAmount: row.RECOMMENDED_AMOUNT ?? null,
    sanctionAmount: row.SANCTION_AMOUNT ?? null,
    actualAmount: row.ACTUAL_AMOUNT ?? null,
    letterNo: clean(row.LETTER_NO),
    stage: clean(row.WORK_STAGE),
    flag: row.FLAG == null ? null : Number(row.FLAG),
    fileStatus: row.FILE_STATUS === true || row.FILE_STATUS === 'true',
    sourceKey,
    raw: row
  };
}

export function attachmentIdsFromReferenceRows(rows) {
  const found = [];
  for (const row of rows || []) {
    const names = Array.isArray(row.FILE_NAME) ? row.FILE_NAME : [row.FILE_NAME];
    const ids = Array.isArray(row.ATTACH_ID) ? row.ATTACH_ID : [row.ATTACH_ID];
    ids.filter(Boolean).forEach((id, index) => found.push({ id: String(id), fileName: clean(names[index] || names[0] || '') || null }));
    if (row.URL && row.URL !== 'N/A') found.push({ url: String(row.URL), fileName: clean(names[0] || '') || null });
  }
  return [...new Map(found.map((item) => [item.id || item.url, item])).values()];
}
