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
  const model = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
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
  const prompt = `You are reviewing one public-works evidence file for human investigators. Compare this single image/PDF with the source project record. Do not invent facts, do not identify a person as fraudulent, and do not call an inconsistency proof of fraud. Return JSON only with this shape: {"consistency":"consistent|inconclusive|inconsistent","confidence":0,"possibleIssues":[],"evidenceFindings":[],"metadataChecks":{"location":"supported|not_supported|not_visible","workType":"supported|not_supported|not_visible","amount":"supported|not_verifiable","completion":"supported|not_supported|not_visible"},"requiresHumanReview":true,"summary":""}. Mark requiresHumanReview true whenever the file is missing, unreadable, or only partially comparable. Source project record: ${JSON.stringify(projectRecord)}`;
  async function compareOne(file) {
    let response;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType: file.mimeType, data: file.buffer.toString('base64') } }] }], generationConfig: { temperature: 0, responseMimeType: 'application/json' } }),
        // PDFs are sent as inline Gemini parts. Official source files can be
        // image-heavy and occasionally need longer than a small-host default.
        signal: AbortSignal.timeout(180_000)
      });
      if (response.ok) break;
      const body = await response.text();
      const retryable = [429, 500, 502, 503, 504].includes(response.status);
      if (!retryable || attempt === 2) throw new Error(`Gemini evidence analysis failed with HTTP ${response.status}: ${body}`);
      await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
    }
    const payload = await response.json();
    const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
    return parseJson(text) || { consistency: 'inconclusive', confidence: 0, possibleIssues: ['The AI response could not be parsed.'], evidenceFindings: [], requiresHumanReview: true, summary: text };
  }

  const results = [];
  for (const file of evidence) results.push({ file, result: await compareOne(file) });
  const inconsistencies = results.filter(({ result }) => result.consistency === 'inconsistent');
  const allConsistent = results.every(({ result }) => result.consistency === 'consistent');
  const allInconsistent = results.every(({ result }) => result.consistency === 'inconsistent');
  const consistency = allConsistent ? 'consistent' : allInconsistent ? 'inconsistent' : 'inconclusive';
  const summaries = results.map(({ file, result }) => `${file.fileName || file.sourceAttachmentId || 'Evidence file'}: ${result.summary || result.consistency}`).filter(Boolean);
  return {
    status: 'completed', provider: 'google-gemini', model, consistency,
    confidence: Math.round(results.reduce((sum, item) => sum + (Number(item.result.confidence) || 0), 0) / results.length),
    possibleIssues: results.flatMap(({ result }) => result.possibleIssues || []),
    evidenceFindings: results.flatMap(({ result }) => result.evidenceFindings || []),
    metadataChecks: results[0]?.result.metadataChecks || {},
    requiresHumanReview: results.some(({ result }) => result.requiresHumanReview !== false) || inconsistencies.length > 0,
    summary: summaries.join(' '),
    analyzedFiles: evidence.map(({ sourceAttachmentId, sourceUrl, mimeType, sha256 }) => ({ sourceAttachmentId, sourceUrl, mimeType, sha256 })),
    excludedFiles: inconsistencies.map(({ file, result }) => ({ sourceAttachmentId: file.sourceAttachmentId, sourceUrl: file.sourceUrl, fileName: file.fileName, reason: result.summary || 'The file was inconsistent with the source project.' }))
  };
}
