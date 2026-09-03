import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { ChatGroq } from '@langchain/groq';
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
  const result = { supabase: 'skipped: credentials not configured', r2: 'skipped: credentials not configured' };
  if (supabaseConfigured()) { await exec(process.execPath, ['scripts/import-esakshi.mjs'], { cwd: process.cwd(), env: process.env, maxBuffer: 20 * 1024 * 1024 }); result.supabase = 'completed'; }
  if (r2Configured()) { await exec(process.execPath, ['scripts/upload-evidence-to-r2.mjs'], { cwd: process.cwd(), env: process.env, maxBuffer: 20 * 1024 * 1024 }); result.r2 = 'completed'; }
  return result;
}

async function analyzeRun(state) {
  if (!process.env.GROQ_API_KEY || !state.manifest) return { status: 'skipped', reason: 'GROQ_API_KEY is not configured', sourceFacts: { works: state.manifest?.works || 0, errors: state.manifest?.errors?.length || 0 } };
  const model = new ChatGroq({ apiKey: process.env.GROQ_API_KEY, model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile', temperature: 0 });
  const response = await model.invoke(`Review this ingestion manifest as an operations analyst. Do not invent facts; identify only possible scraper anomalies from this JSON: ${JSON.stringify(state.manifest)}`);
  return { status: 'completed', text: response.content };
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
