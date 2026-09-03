import assert from 'node:assert/strict';
import { getFacets, getProject, getSourceHealth, getSummary, listProjects } from '../src/catalog.js';

const summary = getSummary();
assert.ok(summary.total > 0, 'the catalog must contain source records');
assert.equal(summary.total, getSourceHealth().parsed);
assert.ok(getFacets().states.length > 0);
assert.ok(listProjects({ query: 'community' }).length > 0);
assert.ok(listProjects({ term: '17th Lok Sabha' }).length > 0);
assert.equal(listProjects({ term: '18th Lok Sabha' }).length, 0, 'the current snapshot must not invent 18th-term rows');
assert.ok(listProjects({ house: 'Lok Sabha' }).length > 0);
assert.ok(listProjects({ house: 'Rajya Sabha' }).length > 0);
const district = listProjects({})[0].district;
assert.ok(district && listProjects({ district }).length > 1, 'district filter must match the full district, not one block');
assert.notEqual(listProjects({})[0].district, listProjects({})[0].block, 'district and block must remain separate fields');

const firstProject = listProjects({})[0];
assert.equal(getProject(firstProject.id).id, firstProject.id);
assert.equal(firstProject.score, null);
assert.equal(firstProject.risk, 'Requires manual verification');
assert.equal(firstProject.normalized.hasReliableCoordinates, false);

console.log(`Catalog smoke test passed for ${summary.total} source records.`);
