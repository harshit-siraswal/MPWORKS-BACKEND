import assert from 'node:assert/strict';
import { getFacets, getProject, getSourceHealth, getSummary, listProjects } from '../src/catalog.js';

const summary = getSummary();
assert.ok(summary.total > 0, 'the catalog must contain source records');
assert.equal(summary.total, getSourceHealth().parsed);
assert.ok(getFacets().states.length > 0);
assert.ok(listProjects({ query: 'community' }).length > 0);

const firstProject = listProjects({})[0];
assert.equal(getProject(firstProject.id).id, firstProject.id);
assert.equal(firstProject.score, null);
assert.equal(firstProject.risk, 'Requires manual verification');
assert.equal(firstProject.normalized.hasReliableCoordinates, false);

console.log(`Catalog smoke test passed for ${summary.total} source records.`);
