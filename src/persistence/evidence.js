import { extname } from 'node:path';
import { putR2Object, r2Configured } from './r2.js';
import { supabaseConfigured, supabaseSelect, supabaseUpsert } from './supabase.js';

const safe = (value) => String(value ?? '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 80) || 'unknown';

async function findProjectId(project) {
  if (!supabaseConfigured()) return null;
  const sourceWorkId = project.raw?.sourceWorkId || project.raw?.source_work_id || project.raw?.WORK_RECOMMENDATION_DTL_ID || project.raw?.WORK_ID;
  if (!sourceWorkId) return null;
  const query = `select=id,source_work_id&source_work_id=eq.${encodeURIComponent(String(sourceWorkId))}&limit=1`;
  return (await supabaseSelect('projects', query))?.[0]?.id || null;
}

export async function persistEvidence(project, files = [], analysis = null) {
  const result = { r2: r2Configured() ? 'ready' : 'not-configured', supabase: supabaseConfigured() ? 'ready' : 'not-configured', stored: [], warnings: [] };
  const projectId = await findProjectId(project);
  if (supabaseConfigured() && !projectId) result.warnings.push('The source record has no matching live Supabase project id; evidence metadata was not linked to a project row.');
  const documents = [];
  for (const file of files) {
    const extension = extname(file.fileName || '') || (file.mimeType === 'application/pdf' ? '.pdf' : file.mimeType?.startsWith('image/') ? '.jpg' : '.bin');
    const key = `mplads/evidence/${safe(project.term)}/${safe(project.state)}/${safe(project.raw?.sourceWorkId || project.id)}/${file.sha256}${extension}`;
    let r2Url = null;
    if (r2Configured()) { const stored = await putR2Object(key, file.buffer, file.mimeType); r2Url = stored.url; file.r2Key = stored.key; file.r2Url = stored.url; file.persisted = true; }
    else result.warnings.push('R2 access credentials are not configured; files were analyzed in memory but not permanently stored.');
    const document = { project_id: projectId, source_attachment_id: String(file.sourceAttachmentId || file.sourceUrl || file.sha256), source_file_name: file.fileName || null, source_url: file.sourceUrl || null, r2_key: file.r2Key || null, r2_url: r2Url, mime_type: file.mimeType || null, byte_size: file.bytes || file.buffer.length, sha256: file.sha256, status: r2Url ? 'stored' : 'discovered', analysis: { ...file, buffer: undefined, projectComparison: analysis || null }, raw: { projectId: project.id } };
    documents.push(document);
    result.stored.push({ sourceAttachmentId: document.source_attachment_id, mimeType: document.mime_type, sha256: document.sha256, r2Url, status: document.status });
  }
  if (supabaseConfigured() && projectId && documents.length) {
    const rows = await supabaseUpsert('project_documents', documents, 'project_id,source_attachment_id');
    const media = files.filter((file) => file.mimeType?.startsWith('image/')).map((file) => { const doc = rows.find((row) => row.sha256 === file.sha256); return { project_id: projectId, document_id: doc?.id || null, r2_key: file.r2Key || null, r2_url: file.r2Url || null, mime_type: file.mimeType, width: file.width || null, height: file.height || null, byte_size: file.bytes || file.buffer.length, sha256: file.sha256, average_hash: file.averageHash || null, dominant_color: file.dominant ? JSON.stringify(file.dominant) : null, analysis: analysis || {} }; });
    if (media.length) await supabaseUpsert('project_media', media, 'project_id,sha256');
  }
  return result;
}
