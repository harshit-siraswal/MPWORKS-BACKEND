import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateRiskIndex } from '../src/risk-index.js';

const project = {
  title: 'Construction of roads and pathways',
  state: 'Test State',
  district: 'Test District',
  constituency: 'Test Constituency',
  mp: 'Test MP',
  status: 'Work Completed',
  amount: '₹12,00,000',
  raw: { recommendedAmount: 1200000 }
};

test('uses evidence state and comparison outcome instead of one fixed score', () => {
  const noEvidence = calculateRiskIndex(project, null, 0);
  const pending = calculateRiskIndex(project, { status: 'unavailable' }, 2);
  const consistent = calculateRiskIndex(project, { status: 'completed', consistency: 'consistent', confidence: 80 }, 2);
  const inconsistent = calculateRiskIndex(project, { status: 'completed', consistency: 'inconsistent', confidence: 80 }, 2);

  assert.ok(noEvidence.score > pending.score);
  assert.ok(pending.score > consistent.score);
  assert.ok(inconsistent.score > consistent.score);
  assert.equal(consistent.confidence, 80);
  assert.equal(consistent.components.evidence, 0);
  assert.equal(inconsistent.components.evidence, 55);
});

test('public ratings are weighted by count and photos do not increase fraud priority', () => {
  const lowRating = calculateRiskIndex(project, null, 2, { ratingCount: 1, averageRating: 1, photoCount: 0, commentCount: 0 });
  const highRating = calculateRiskIndex(project, null, 2, { ratingCount: 1, averageRating: 9, photoCount: 0, commentCount: 0 });
  const manyLowRatings = calculateRiskIndex(project, null, 2, { ratingCount: 10, averageRating: 1, photoCount: 0, commentCount: 0 });
  const withPhotos = calculateRiskIndex(project, null, 2, { ratingCount: 0, averageRating: null, photoCount: 3, commentCount: 0 });
  const withComments = calculateRiskIndex(project, null, 2, { ratingCount: 0, averageRating: null, photoCount: 0, commentCount: 2 });

  assert.ok(lowRating.score > highRating.score);
  assert.ok(manyLowRatings.score > lowRating.score);
  assert.ok(withPhotos.score < calculateRiskIndex(project, null, 2).score);
  assert.ok(withComments.score > calculateRiskIndex(project, null, 2).score);
  assert.equal(lowRating.components.publicRating, 0.8);
  assert.equal(withPhotos.components.publicPhotos, -3);
  assert.equal(withComments.components.publicComments, 2);
});

test('placeholder source values are treated as missing fields and all scores are bounded', () => {
  const incomplete = calculateRiskIndex({ ...project, state: 'State not stated in source', mp: 'MP not stated in source' }, null, 0);
  assert.equal(incomplete.components.missingFields, 2);
  assert.ok(incomplete.score >= 0 && incomplete.score <= 100);
});
