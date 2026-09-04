import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configFromEnv,
  createPacedCaller,
  decodePayload,
  detectMime,
  loadCompletedWorks,
  relationKey,
  sha256,
  workIdentity,
} from '../scripts/backfill-completed-evidence.mjs';

const tempRoot = await mkdtemp(join(tmpdir(), 'mpworks-backfill-'));
try {
  const report = 'report-17th-Lok-Sabha-2-Test-State-Works-Completed.json';
  await writeFile(join(tempRoot, report), JSON.stringify([
    { WORK_RECOMMENDATION_DTL_ID: 42, WORK_ID: 7, HOUSE_OF_PARLIAMENT: 2, FILE_STATUS: false, FLAG: 3 },
    { WORK_RECOMMENDATION_DTL_ID: 42, WORK_ID: 7, HOUSE_OF_PARLIAMENT: 2, FILE_STATUS: true, FLAG: 3 },
  ]));
  const works = await loadCompletedWorks({ root: tempRoot });
  assert.equal(works.length, 1, 'duplicate report rows must produce one work target');
  assert.equal(works[0].raws.length, 2);
  assert.equal(works[0].work.state, 'Test State');
  assert.equal(works[0].work.term, '17th Lok Sabha');
  assert.equal(workIdentity(works[0].work), '42|17th lok sabha|2|test state');

  const pdf = Buffer.from('%PDF-1.7 focused test');
  const decoded = decodePayload({ FILE_DATA: `data:application/pdf;base64,${pdf.toString('base64')}`, FILE_NAME: 'certificate.pdf' });
  assert.deepEqual(decoded.buffer, pdf);
  assert.equal(detectMime(decoded.fileName, decoded.buffer, decoded.declaredMime), 'application/pdf');
  assert.equal(detectMime('photo.jpg', Buffer.from([0xff, 0xd8, 0xff, 0x00])), 'image/jpeg');
  assert.equal(decodePayload({ URL: 'https://mplads.mospi.gov.in/attachment/42' }), null);

  const digest = sha256(pdf);
  assert.equal(relationKey(works[0].work, digest), relationKey(workIdentity(works[0].work), digest), 'content dedupe key must be stable for a work identity');
  assert.equal(configFromEnv({}).minIntervalMs, 1000, 'backfill must default to a conservative source interval');

  const starts = [];
  const paced = createPacedCaller({ intervalMs: 0, sleep: async () => {} });
  await Promise.all([paced(async () => { starts.push(1); }), paced(async () => { starts.push(2); })]);
  assert.deepEqual(starts, [1, 2], 'source calls must be single-flight even when callers overlap');
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

console.log('Completed-evidence backfill test passed.');
