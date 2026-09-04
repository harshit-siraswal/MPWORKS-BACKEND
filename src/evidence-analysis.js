function parseJson(text) {
  const cleaned = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(cleaned); } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    try { return match ? JSON.parse(match[0]) : null; } catch { return null; }
  }
}

export async function analyzeEvidenceAgainstProject(project, files = []) {
  if (!process.env.GEMINI_API_KEY) return { status: 'unavailable', reason: 'GEMINI_API_KEY is not configured' };
  const evidence = files.filter((file) => file.buffer && (file.mimeType?.startsWith('image/') || file.mimeType === 'application/pdf')).slice(0, 4);
  if (!evidence.length) return { status: 'inconclusive', reason: 'No image or PDF evidence was fetched' };
  const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
  const projectRecord = {
    title: project.title,
    description: project.raw?.description || project.raw?.WORK_DESCRIPTION || project.title,
    state: project.state,
    district: project.district,
    constituency: project.constituency,
    block: project.block,
    village: project.villageRaw,
    amount: project.amount,
    status: project.status,
    recommendationDate: project.sourceDate,
    mp: project.mp
  };
  const parts = [{ text: `You are reviewing public-works evidence for human investigators. Compare the supplied image/PDF evidence with this source project record. Do not invent facts, do not identify a person as fraudulent, and do not call an inconsistency proof of fraud. Return JSON only with this shape: {"consistency":"consistent|inconclusive|inconsistent","confidence":0,"possibleIssues":[],"evidenceFindings":[],"metadataChecks":{"location":"supported|not_supported|not_visible","workType":"supported|not_supported|not_visible","amount":"supported|not_verifiable","completion":"supported|not_supported|not_visible"},"requiresHumanReview":true,"summary":""}. Mark requiresHumanReview true whenever evidence is missing, unreadable, or only partially comparable. Source project record: ${JSON.stringify(projectRecord)}` }];
  for (const file of evidence) parts.push({ inlineData: { mimeType: file.mimeType, data: file.buffer.toString('base64') } });
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature: 0, responseMimeType: 'application/json' } }),
    // PDFs are sent as inline Gemini parts. Most complete quickly, but the
    // official source files can be image-heavy and occasionally need longer
    // than the old 90-second ceiling on the small EC2 host.
    signal: AbortSignal.timeout(180_000)
  });
  if (!response.ok) throw new Error(`Gemini evidence analysis failed with HTTP ${response.status}: ${await response.text()}`);
  const payload = await response.json();
  const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
  const parsed = parseJson(text);
  return { status: parsed ? 'completed' : 'unparsed', provider: 'google-gemini', model, ...(parsed || { summary: text }), analyzedFiles: evidence.map(({ sourceAttachmentId, sourceUrl, mimeType, sha256 }) => ({ sourceAttachmentId, sourceUrl, mimeType, sha256 })) };
}
