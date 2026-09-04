import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateProjectAmount } from '../src/amount-estimation.js';

test('estimates a description cost band and detects official amount variance', () => {
  const result = estimateProjectAmount({
    title: 'Construction of 10 street lights in village road',
    category: 'Street lighting',
    raw: { recommendedAmount: 2500000, actualAmount: 2500000 }
  });
  assert.equal(result.amountInr, 2678000);
  assert.equal(result.observedAmountKind, 'utilized');
  assert.equal(result.variancePercent, -6.6);
  assert.match(result.basis, /description-cost-band-v1/);
});

test('returns a transparent fallback when source amount is unavailable', () => {
  const result = estimateProjectAmount({ title: 'Improvement work at public facility', raw: {} });
  assert.equal(result.amountInr, 800000);
  assert.equal(result.observedAmountInr, null);
  assert.equal(result.variancePercent, null);
  assert.match(result.reason, /No specific work category/);
});

test('prioritizes the work description over a conflicting source category', () => {
  const result = estimateProjectAmount({ title: 'Construction of roads and drainage system', category: 'Water supply', raw: {} });
  assert.match(result.reason, /road and pavement/);
});
