import { graph } from '../src/agent/graph.js';

const result = await graph.invoke({});
console.log(JSON.stringify({
  runId: result.runId,
  source: result.source,
  manifest: result.manifest,
  persisted: result.persisted,
  anomalyReport: result.anomalyReport
}, null, 2));
