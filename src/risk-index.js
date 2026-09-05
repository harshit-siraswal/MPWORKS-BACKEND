import { estimateProjectAmount } from './amount-estimation.js';

const INR = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

function meaningful(value) {
  const text = String(value ?? '').trim();
  return Boolean(text) && !/(?:\bnot stated\b|\bnot available\b|\bunknown\b|^n\/a$|^na$)/i.test(text);
}

function bounded(value, low = 0, high = 100) { return Math.max(low, Math.min(high, Math.round(value))); }

/**
 * Returns a review-priority signal, not a fraud probability or finding.
 * The same function is used by project, register, MP-profile and district views.
 */
export function calculateRiskIndex(project, comparison = null, evidenceCount = 0, feedback = null) {
  const count = Math.max(0, Number(evidenceCount) || 0);
  const missingFields = ['state', 'district', 'constituency', 'mp', 'status'].filter((field) => !meaningful(project?.[field]));
  const amount = estimateProjectAmount(project || {});
  let score = 15;
  const contributions = [];

  if (comparison?.status === 'completed' && comparison.consistency === 'inconsistent') {
    score += 55;
    contributions.push('AI found an evidence mismatch requiring human verification');
  } else if (comparison?.status === 'completed' && comparison.consistency === 'consistent') {
    contributions.push('AI evidence comparison was broadly consistent with the source record');
  } else if (count > 0) {
    score += 20;
    contributions.push('source evidence is available but has not received a fully consistent AI comparison');
  } else {
    score += 30;
    contributions.push('no source image or PDF evidence is currently indexed');
  }

  if (!comparison && !count && /completed|partially completed|physical inspection/i.test(String(project?.status || ''))) {
    score += 8;
    contributions.push('the source describes completed work without indexed evidence');
  }
  if (!comparison && !count && /unsanctioned|action pending/i.test(String(project?.status || ''))) {
    score += 6;
    contributions.push('the source status requires administrative follow-up');
  }

  if (missingFields.length) {
    score += Math.min(missingFields.length * 3, 15);
    contributions.push(`${missingFields.length} source field${missingFields.length === 1 ? '' : 's'} need completion`);
  }

  const variance = Number(amount.variancePercent);
  if (Number.isFinite(variance) && Math.abs(variance) > 15) {
    const amountContribution = Math.min(20, Math.round((Math.abs(variance) - 15) * 0.24));
    score += amountContribution;
    contributions.push(`official ${amount.observedAmountKind} amount differs from the description estimate by ${amount.varianceLabel}`);
  }

  const ratingCount = Math.max(0, Number(feedback?.ratingCount) || 0);
  const averageRating = Number(feedback?.averageRating);
  if (ratingCount > 0 && Number.isFinite(averageRating)) {
    // A small number of public ratings must not swing the index. At ten ratings
    // the signal reaches its full ±10-point range around a neutral 5/10 score.
    const ratingWeight = Math.min(ratingCount / 10, 1);
    const ratingContribution = ((5 - Math.max(0, Math.min(10, averageRating))) * 2) * ratingWeight;
    score += ratingContribution;
    contributions.push(`public feedback averages ${averageRating}/10 across ${ratingCount} rating${ratingCount === 1 ? '' : 's'}`);
  }
  const photoCount = Math.max(0, Number(feedback?.photoCount) || 0);
  const commentCount = Math.max(0, Number(feedback?.commentCount) || 0);
  if (photoCount) {
    score -= Math.min(photoCount, 3);
    contributions.push(`${photoCount} public photo${photoCount === 1 ? '' : 's'} provide additional review material`);
  }
  if (commentCount) {
    score += Math.min(commentCount, 3);
    contributions.push(`${commentCount} public comment${commentCount === 1 ? '' : 's'} remain subject to human review`);
  }

  score = bounded(score);
  const label = score >= 75 ? 'High review priority' : score >= 50 ? 'Elevated review priority' : score >= 30 ? 'Moderate review priority' : 'Lower review priority';
  const aiSummary = comparison?.summary ? ` AI summary: ${comparison.summary}` : '';
  const reason = `${contributions.join('; ')}.${aiSummary} This is a human-review signal, not proof of fraud.`;
  const comparisonConfidence = Number(comparison?.confidence);
  const confidence = Number.isFinite(comparisonConfidence) && comparisonConfidence > 0
    ? bounded(comparisonConfidence, 0, 100)
    : comparison?.status === 'completed' ? 25 : count ? 15 : 10;
  const amountReason = amount.variancePercent == null
    ? ` Amount comparison is unavailable because the source does not expose a usable allocated, sanctioned, or utilized amount. AI estimate: ${amount.rangeFormatted}.`
    : ` AI-assisted amount estimate is ${amount.formatted} (${amount.rangeFormatted}); official ${amount.observedAmountKind} amount is ${INR.format(amount.observedAmountInr)} (${amount.varianceLabel}). This variance is a review signal, not proof of fraud.`;
  return {
    score,
    label,
    reason: `${reason}${amountReason}`,
    confidence,
    basis: `${comparison ? 'AI evidence comparison plus source-field checks' : 'Source-field completeness and evidence availability; AI comparison pending'} plus description-cost estimate${ratingCount || photoCount || commentCount ? ' and public feedback' : ''}`,
    components: { evidence: count > 0 ? (comparison?.consistency === 'consistent' ? 0 : comparison?.consistency === 'inconsistent' ? 55 : 20) : 30, missingFields: missingFields.length, amountVariance: Number.isFinite(variance) && Math.abs(variance) > 15 ? Math.min(20, Math.round((Math.abs(variance) - 15) * 0.24)) : 0, publicRating: ratingCount > 0 && Number.isFinite(averageRating) ? Math.round(((5 - Math.max(0, Math.min(10, averageRating))) * 2) * Math.min(ratingCount / 10, 1) * 10) / 10 : 0, publicPhotos: -Math.min(photoCount, 3), publicComments: Math.min(commentCount, 3) }
  };
}
