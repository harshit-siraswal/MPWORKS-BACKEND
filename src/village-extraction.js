const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

export function normalizeVillageName(value) {
  return clean(value).toLocaleUpperCase('en-IN').replace(/[^A-Z0-9\u0900-\u097F ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function extractVillages(work) {
  const explicit = [work.village, work.VILLAGE, work.villageRaw].map(clean).filter(Boolean);
  const description = clean(work.description || work.WORK_DESCRIPTION || work.work || work.WORK);
  const results = explicit.map((name) => ({ name, normalizedName: normalizeVillageName(name), extractionMethod: 'source-village-field', confidence: 1, rawContext: name }));
  const pattern = /\b(?:village|vill\.?|gram|gram panchayat|panchayat)\s*(?:of|at|near|in|-)?\s*([A-Za-z\u0900-\u097F][A-Za-z0-9\u0900-\u097F.'’()\-/ ]{2,70}?)(?=\s*(?:,|;|\.|\(|\)|\b(?:block|district|tehsil|taluk|ward|under|road|via|near)\b|$))/gi;
  for (const match of description.matchAll(pattern)) {
    const name = clean(match[1]).replace(/\s+(?:and|or)$/i, '');
    if (name.length < 3) continue;
    results.push({ name, normalizedName: normalizeVillageName(name), extractionMethod: 'description-village-phrase', confidence: 0.72, rawContext: match[0] });
  }
  return [...new Map(results.filter((item) => item.normalizedName).map((item) => [item.normalizedName, item])).values()];
}

