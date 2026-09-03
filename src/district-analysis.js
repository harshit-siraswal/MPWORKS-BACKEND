import { randomUUID } from 'node:crypto';
import { analyzeEvidenceAgainstProject } from './evidence-analysis.js';
import { analyzeStoredAttachments, fetchAndAnalyzeAttachments, fetchAndAnalyzeImages } from './image-analysis.js';
import { persistEvidence } from './persistence/evidence.js';

const jobs = new Map();
const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

function scoreFor(comparison, evidenceCount) {
  if (!comparison || comparison.status === 'unavailable') return { score: null, label: 'AI unavailable', confidence: 0 };
  if (!evidenceCount || comparison.status === 'inconclusive') return { score: 50, label: 'Insufficient evidence', confidence: 20 };
  if (comparison.consistency === 'inconsistent') return { score: 85, label: 'High review priority', confidence: Number(comparison.confidence) || 75 };
  if (comparison.consistency === 'consistent') return { score: 15, label: 'Low review priority', confidence: Number(comparison.confidence) || 70 };
  return { score: 50, label: 'Needs review', confidence: Number(comparison.confidence) || 25 };
}

async function evidenceFor(project) {
  const stored = await analyzeStoredAttachments(project.attachmentCandidates || []);
  if (stored.files.length) return stored;
  if (project.imageUrls.length) return fetchAndAnalyzeImages(project.imageUrls);
  return fetchAndAnalyzeAttachments(project.attachmentIds, process.env.MPLADS_API_ORIGIN || 'https://mplads.mospi.gov.in');
}

async function runJob(job) {
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  const results = [];
  let cursor = 0;
  const concurrency = 2;
  async function consume() {
    while (cursor < job.projects.length) {
      const project = job.projects[cursor++];
      try {
        const evidence = await evidenceFor(project);
        let comparison = { status: 'inconclusive', reason: 'No image or PDF evidence was fetched' };
        if (evidence.files.length) comparison = await analyzeEvidenceAgainstProject(project, evidence.files);
        let persistence = { r2: 'not-configured', supabase: 'not-configured', stored: [], warnings: [] };
        if (evidence.files.length) { try { persistence = await persistEvidence(project, evidence.files, comparison); } catch (error) { persistence = { r2: 'error', supabase: 'error', stored: [], warnings: [error.message] }; } }
        const priority = scoreFor(comparison, evidence.files.length);
        results.push({ projectId: project.id, score: priority.score, label: priority.label, confidence: priority.confidence, evidenceCount: evidence.files.length, comparison: { consistency: comparison.consistency || comparison.status, summary: comparison.summary || comparison.reason || '', possibleIssues: comparison.possibleIssues || [] }, persistence: { r2: persistence.r2, supabase: persistence.supabase } });
      } catch (error) { results.push({ projectId: project.id, score: null, label: 'Analysis failed', confidence: 0, evidenceCount: 0, comparison: { consistency: 'error', summary: error.message, possibleIssues: [] } }); }
      job.completed = results.length;
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, job.projects.length || 1) }, consume));
  job.results = results.sort((left, right) => (right.score ?? -1) - (left.score ?? -1));
  job.status = 'completed';
  job.completedAt = new Date().toISOString();
  job.projects = undefined;
}

export function startDistrictAnalysis(projects, scope) {
  const id = randomUUID();
  const job = { id, status: 'queued', createdAt: new Date().toISOString(), completed: 0, total: projects.length, scope, projects, results: [] };
  jobs.set(id, job);
  runJob(job).catch((error) => { job.status = 'failed'; job.error = error.message; job.completedAt = new Date().toISOString(); job.projects = undefined; });
  return publicJob(job);
}

function publicJob(job) { const { projects, ...safeJob } = job; return safeJob; }
export function getDistrictAnalysis(id) { const job = jobs.get(id); return job ? publicJob(job) : null; }
