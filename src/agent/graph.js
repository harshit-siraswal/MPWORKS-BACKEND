import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { ESAKSHI_DASHBOARD_URL, getStates, getTenures } from '../esakshi-source.js';
import { r2Configured } from '../persistence/r2.js';
import { supabaseConfigured } from '../persistence/supabase.js';

const exec = promisify(execFile);
const State = Annotation.Root({
  runId: Annotation({ reducer: (_, next) => next, default: () => new Date().toISOString() }),
  source: Annotation({ reducer: (_, next) => next, default: () => ({}) }),
  manifest: Annotation({ reducer: (_, next) => next, default: () => null }),
  persisted: Annotation({ reducer: (_, next) => next, default: () => null }),
  anomalyReport: Annotation({ reducer: (_, next) => next, default: () => null }),
  error: Annotation({ reducer: (_, next) => next, default: () => null })
});

async function discoverSource() {
  const [states, lokTenures, rajyaTenures] = await Promise.all([getStates(), getTenures(2), getTenures(1)]);
  return { dashboardUrl: ESAKSHI_DASHBOARD_URL, apiOrigin: new URL(ESAKSHI_DASHBOARD_URL).origin, states, tenures: { lokSabha: lokTenures, rajyaSabha: rajyaTenures } };
}

async function scrapeReports() {
  await exec(process.execPath, ['scripts/fetch-esakshi.mjs'], { cwd: process.cwd(), env: process.env, maxBuffer: 20 * 1024 * 1024 });
  return JSON.parse(await readFile('data/raw/esakshi/manifest.json', 'utf8'));
}

async function persistRun() {
  const result = { supabase: 'skipped: credentials not configured', r2: 'skipped: credentials not configured', rawCatalog: 'skipped: R2 credentials not configured' };
  if (supabaseConfigured()) { await exec(process.execPath, ['scripts/import-esakshi.mjs'], { cwd: process.cwd(), env: process.env, maxBuffer: 20 * 1024 * 1024 }); result.supabase = 'completed'; }
  if (r2Configured()) { await exec(process.execPath, ['scripts/upload-evidence-to-r2.mjs'], { cwd: process.cwd(), env: process.env, maxBuffer: 20 * 1024 * 1024 }); await exec(process.execPath, ['scripts/upload-catalog-to-r2.mjs'], { cwd: process.cwd(), env: process.env, maxBuffer: 20 * 1024 * 1024 }); result.r2 = 'completed'; result.rawCatalog = 'completed'; }
  return result;
}

async function analyzeRun(state) {
  if (!process.env.GEMINI_API_KEY || !state.manifest) return { status: 'skipped', reason: 'GEMINI_API_KEY is not configured', sourceFacts: { works: state.manifest?.works || 0, errors: state.manifest?.errors?.length || 0 } };
  const model = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: `Review this ingestion manifest as an operations analyst. Do not invent facts; identify only possible scraper anomalies from this JSON: ${JSON.stringify(state.manifest)}` }] }],
      generationConfig: { temperature: 0 }
    })
  });
  if (!response.ok) throw new Error(`Gemini analysis failed with HTTP ${response.status}: ${await response.text()}`);
  const payload = await response.json();
  const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
  return { status: 'completed', provider: 'google-gemini', model, text };
}

const workflow = new StateGraph(State)
  .addNode('discover_source', async () => ({ source: await discoverSource() }))
  .addNode('scrape_reports', async () => ({ manifest: await scrapeReports() }))
  .addNode('persist_run', async () => ({ persisted: await persistRun() }))
  .addNode('analyze_run', async (state) => ({ anomalyReport: await analyzeRun(state) }))
  .addEdge(START, 'discover_source')
  .addEdge('discover_source', 'scrape_reports')
  .addEdge('scrape_reports', 'persist_run')
  .addEdge('persist_run', 'analyze_run')
  .addEdge('analyze_run', END);

export const graph = workflow.compile();
