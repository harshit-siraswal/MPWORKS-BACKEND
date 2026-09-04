import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';

const maxBytes = 8 * 1024 * 1024;

function inferMime(fileName, buffer) {
  const name = String(fileName || '').toLowerCase();
  if (buffer.subarray(0, 4).toString() === '%PDF') return { mimeType: 'application/pdf', extension: '.pdf' };
  if (buffer.subarray(0, 3).toString('hex') === 'ffd8ff' || /\.jpe?g$/.test(name)) return { mimeType: 'image/jpeg', extension: '.jpg' };
  if (buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' || /\.png$/.test(name)) return { mimeType: 'image/png', extension: '.png' };
  if (/\.webp$/.test(name)) return { mimeType: 'image/webp', extension: '.webp' };
  return { mimeType: 'application/octet-stream', extension: '.bin' };
}

function inspectDocument(buffer, sourceUrl, mimeType, fileName, sourceAttachmentId) {
  return {
    sourceUrl,
    sourceAttachmentId: sourceAttachmentId || null,
    fileName: fileName || null,
    mimeType,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    bytes: buffer.byteLength,
    analyzedAt: new Date().toISOString(),
    analyzer: mimeType === 'application/pdf' ? 'node:crypto-document-evidence-v0.2.0' : 'sharp-image-evidence-v0.2.0'
  };
}

function averageHash(rawPixels) {
  const values = [...rawPixels];
  const average = values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
  return values.map((value) => value >= average ? '1' : '0').join('');
}

export async function analyzeImage(buffer, sourceUrl) {
  const image = sharp(buffer, { limitInputPixels: 40_000_000 });
  const [metadata, stats, grayscale] = await Promise.all([
    image.metadata(),
    image.stats(),
    image.clone().resize(8, 8, { fit: 'cover' }).greyscale().raw().toBuffer()
  ]);
  return {
    sourceUrl,
    mimeType: `image/${metadata.format || 'unknown'}`,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    format: metadata.format || 'unknown',
    width: metadata.width || null,
    height: metadata.height || null,
    bytes: buffer.byteLength,
    averageHash: averageHash(grayscale),
    dominant: stats.dominant ? { r: stats.dominant.r, g: stats.dominant.g, b: stats.dominant.b } : null,
    analyzedAt: new Date().toISOString(),
    analyzer: 'sharp-image-evidence-v0.2.0'
  };
}

export function hammingDistance(left, right) {
  if (!left || !right || left.length !== right.length) return null;
  return [...left].reduce((distance, value, index) => distance + (value === right[index] ? 0 : 1), 0);
}

export function compareImages(images) {
  return images.flatMap((left, leftIndex) => images.slice(leftIndex + 1).map((right) => ({
    left: left.sourceUrl,
    right: right.sourceUrl,
    hammingDistance: hammingDistance(left.averageHash, right.averageHash),
    likelySimilar: hammingDistance(left.averageHash, right.averageHash) !== null && hammingDistance(left.averageHash, right.averageHash) <= 8
  })));
}

async function fetchBuffer(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { 'User-Agent': 'MPWorks/0.1 source-evidence-fetcher' } });
  if (!response.ok) throw new Error(`source evidence request failed: ${response.status}`);
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > maxBytes) throw new Error('image exceeds 8 MB safety limit');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) throw new Error('image exceeds 8 MB safety limit');
  return buffer;
}

export async function fetchAndAnalyzeImages(urls = []) {
  const files = [];
  const errors = [];
  for (const url of [...new Set(urls)].slice(0, 12)) {
    try { const buffer = await fetchBuffer(url); files.push({ buffer, ...(await analyzeImage(buffer, url)), persisted: false }); }
    catch (error) { errors.push({ sourceUrl: url, error: error.message }); }
  }
  const images = files.filter((file) => file.mimeType?.startsWith('image/'));
  return { files, images, documents: files, comparisons: compareImages(images), errors };
}

export async function analyzeStoredAttachments(candidates = []) {
  const files = [];
  const errors = [];
  for (const candidate of candidates.slice(0, 4)) {
    try {
      const buffer = candidate.localPath ? await readFile(candidate.localPath) : candidate.r2Url ? await fetchBuffer(candidate.r2Url) : null;
      if (!buffer) continue;
      const mimeType = candidate.mimeType || inferMime(candidate.fileName, buffer).mimeType;
      const sourceUrl = candidate.sourceUrl || candidate.r2Url || `${candidate.attachmentId ? 'https://mplads.mospi.gov.in/attachment' : 'local-evidence'}/${candidate.attachmentId || ''}`;
      const base = mimeType.startsWith('image/') ? await analyzeImage(buffer, sourceUrl) : inspectDocument(buffer, sourceUrl, mimeType, candidate.fileName, candidate.attachmentId);
      files.push({ buffer, sourceAttachmentId: String(candidate.attachmentId || candidate.sourceAttachmentId || ''), fileName: candidate.fileName || null, ...base, persisted: false });
    } catch (error) { errors.push({ localPath: candidate.localPath, error: error.message }); }
  }
  const images = files.filter((file) => file.mimeType?.startsWith('image/'));
  const documents = files.filter((file) => file.mimeType === 'application/pdf' || !file.mimeType?.startsWith('image/'));
  return { files, images, documents, comparisons: compareImages(images), errors };
}

export async function fetchAndAnalyzeAttachments(ids = [], origin = 'https://mplads.mospi.gov.in') {
  const files = [];
  const errors = [];
  for (const id of [...new Set(ids)].slice(0, 12)) {
    try {
      const response = await fetch(`${origin}/rest/PreLoginCitizenWorkRcmdRest/getAttachmentById`, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8', Accept: 'application/json' }, body: JSON.stringify({ id }), signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`attachment request failed: ${response.status}`);
      const payload = await response.json();
      const candidates = [];
      const visit = (value, fileName = '', mimeType = '') => {
        if (typeof value === 'string') {
          const match = value.match(/^data:([^;]+);base64,(.+)$/i);
          if (match) candidates.push({ mimeType: match[1].toLowerCase(), base64: match[2], fileName });
          else if (/^[a-z0-9+/=\r\n]{20,}$/i.test(value) && value.replace(/\s/g, '').length % 4 === 0) candidates.push({ mimeType: mimeType || null, base64: value.replace(/\s/g, ''), fileName });
        } else if (Array.isArray(value)) value.forEach((item) => visit(item, fileName, mimeType));
        else if (value && typeof value === 'object') {
          const localName = value.FILE_NAME || value.fileName || value.filename || fileName;
          const localMime = value.MIME_TYPE || value.mimeType || value.CONTENT_TYPE || mimeType;
          Object.entries(value).forEach(([key, item]) => /image|photo|file|content|data|document|attachment|url/i.test(key) ? visit(item, String(localName || ''), String(localMime || '')) : null);
        }
      };
      visit(payload);
      for (const candidate of candidates) {
        const buffer = Buffer.from(candidate.base64, 'base64');
        if (buffer.byteLength > maxBytes) { errors.push({ id, error: 'attachment exceeds 8 MB safety limit' }); continue; }
        const inferred = inferMime('', buffer);
        const mimeType = candidate.mimeType && candidate.mimeType !== 'image/unknown' && candidate.mimeType !== 'application/octet-stream' ? candidate.mimeType : inferred.mimeType;
        const sourceUrl = `${origin}/attachment/${id}`;
        const base = mimeType.startsWith('image/') ? await analyzeImage(buffer, sourceUrl) : inspectDocument(buffer, sourceUrl, mimeType, candidate.fileName || null, id);
        files.push({ buffer, sourceAttachmentId: String(id), fileName: candidate.fileName || null, mimeType, ...base, persisted: false });
      }
      if (!candidates.length) errors.push({ id, error: 'attachment response contained no image or PDF payload' });
    } catch (error) { errors.push({ id, error: error.message }); }
  }
  const images = files.filter((file) => file.mimeType?.startsWith('image/'));
  const documents = files.filter((file) => file.mimeType === 'application/pdf' || !file.mimeType?.startsWith('image/'));
  return { files, images, documents, comparisons: compareImages(images), errors };
}
