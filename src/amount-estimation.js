const INR = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

const COST_BANDS = [
  { keys: ['street light', 'led light', 'solar light', 'high mast'], label: 'street lighting', base: 450000 },
  { keys: ['handpump', 'tube well', 'tubewell', 'borewell', 'water supply', 'drinking water', 'water tank'], label: 'water infrastructure', base: 650000 },
  { keys: ['drain', 'drainage', 'culvert', 'puliya', 'crossing'], label: 'drainage and crossing', base: 900000 },
  { keys: ['road', 'cc road', 'cement road', 'pavement', 'lane', 'interlocking'], label: 'road and pavement', base: 1200000 },
  { keys: ['school room', 'classroom', 'school building', 'toilet', 'anganwadi'], label: 'school and community facilities', base: 1800000 },
  { keys: ['community hall', 'samudayik bhawan', 'stage', 'shed'], label: 'community building', base: 2500000 },
  { keys: ['solar', 'solar panel', 'solar power'], label: 'solar installation', base: 1000000 },
  { keys: ['library', 'computer', 'laboratory', 'lab equipment'], label: 'education equipment', base: 850000 },
  { keys: ['ambulance', 'medical', 'health centre', 'health center'], label: 'health facility', base: 1400000 },
];

function textFor(project) {
  const raw = project?.raw || {};
  return [project?.title, project?.category, raw.WORK, raw.WORK_DESCRIPTION, raw.description, raw.activityName, raw.ACTIVITY_NAME]
    .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

function amount(value) {
  const parsed = Number(String(value ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function observedAmount(project) {
  const raw = project?.raw || {};
  const normalized = project?.normalized || {};
  const candidates = [
    ['utilized', raw.ACTUAL_AMOUNT, raw.actualAmount, raw.actual_amount, normalized.actualAmount],
    ['sanctioned', raw.SANCTION_AMOUNT, raw.sanctionAmount, raw.sanctionedAmount, normalized.sanctionAmount],
    ['recommended', raw.RECOMMENDED_AMOUNT, raw.recommendedAmount, raw.ALLOCATION_AMOUNT, raw.allocationAmount, normalized.recommendedAmount, normalized.amountInr, project?.amount],
  ];
  for (const [kind, ...values] of candidates) {
    const value = values.map(amount).find(Boolean);
    if (value) return { kind, value };
  }
  return { kind: null, value: 0 };
}

function quantityMultiplier(text) {
  const match = text.match(/(?:^|\s)(\d{1,3})\s*(?:nos?\.?|units?|items?|lights?|rooms?|km|kilomet(?:er|re)s?|meters?|metres?)(?:\s|$)/i)
    || text.match(/(?:^|\s)(\d{1,3})\s+(?=(?:street\s+lights?|classrooms?|rooms?|handpumps?|toilets?|solar\s+lights?)(?:\s|$))/i);
  if (!match) return { multiplier: 1, quantity: null };
  const quantity = Math.max(1, Math.min(Number(match[1]), 20));
  const unit = match[0].toLowerCase();
  const multiplier = /km|kilomet/.test(unit) ? Math.min(1 + quantity * 0.45, 8) : 1 + (quantity - 1) * 0.55;
  return { multiplier, quantity };
}

function rounded(value) { return Math.round(value / 1000) * 1000; }

export function estimateProjectAmount(project) {
  const text = textFor(project);
  const band = COST_BANDS.find((candidate) => candidate.keys.some((key) => text.includes(key)));
  const base = band?.base || 800000;
  const { multiplier, quantity } = quantityMultiplier(text);
  const point = rounded(Math.max(50000, Math.min(base * multiplier, 50000000)));
  const low = rounded(Math.max(50000, point * 0.65));
  const high = rounded(Math.min(75000000, point * 1.45));
  const observed = observedAmount(project);
  const varianceAmount = observed.value ? rounded(observed.value - point) : null;
  const variancePercent = observed.value ? Math.round(((observed.value - point) / point) * 1000) / 10 : null;
  const confidence = band && quantity ? 62 : band ? 48 : 25;
  const basis = 'description-cost-band-v1';
  const reason = band
    ? `Estimated from the ${band.label} cost band${quantity ? ` and a detected quantity of ${quantity}` : ''}.`
    : 'No specific work category was recognized; a conservative general public-works cost band was used.';
  return {
    currency: 'INR',
    amountInr: point,
    lowInr: low,
    highInr: high,
    formatted: INR.format(point),
    rangeFormatted: `${INR.format(low)} - ${INR.format(high)}`,
    observedAmountInr: observed.value || null,
    observedAmountKind: observed.kind,
    varianceAmountInr: varianceAmount,
    variancePercent,
    varianceLabel: variancePercent == null ? 'No comparable official amount' : `${variancePercent > 0 ? '+' : ''}${variancePercent}% vs estimate`,
    confidence,
    basis,
    reason,
    caveat: 'AI-assisted estimate for triage only. It is not a tender, market-rate, or audit valuation.'
  };
}
