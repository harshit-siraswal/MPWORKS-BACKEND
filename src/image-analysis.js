import { createHash } from 'node:crypto';
import sharp from 'sharp';

const maxBytes = 8 * 1024 * 1024;

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
    sha256: createHash('sha256').update(buffer).digest('hex'),
    format: metadata.format || 'unknown',
    width: metadata.width || null,
    height: metadata.height || null,
    bytes: buffer.byteLength,
    averageHash: averageHash(grayscale),
    dominant: stats.dominant ? { r: stats.dominant.r, g: stats.dominant.g, b: stats.dominant.b } : null,
    analyzedAt: new Date().toISOString(),
    analyzer: 'sharp-image-evidence-v0.1.0'
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
  if (!response.ok) throw new Error(`image request failed: ${response.status}`);
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > maxBytes) throw new Error('image exceeds 8 MB safety limit');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) throw new Error('image exceeds 8 MB safety limit');
  return buffer;
}

export async function fetchAndAnalyzeImages(urls = []) {
  const results = [];
  const errors = [];
  for (const url of [...new Set(urls)].slice(0, 12)) {
    try {
      results.push(await analyzeImage(await fetchBuffer(url), url));
    } catch (error) {
      errors.push({ sourceUrl: url, error: error.message });
    }
  }
  return { images: results, comparisons: compareImages(results), errors };
}

export async function fetchAndAnalyzeAttachments(ids = [], origin = 'https://mplads.gov.in') {
  const images = [];
  const errors = [];
  for (const id of [...new Set(ids)].slice(0, 12)) {
    try {
      const response = await fetch(`${origin}/rest/PreLoginCitizenWorkRcmdRest/getAttachmentById`, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8', Accept: 'application/json' }, body: JSON.stringify({ id }), signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`attachment request failed: ${response.status}`);
      const payload = await response.json();
      const candidates = [];
      const visit = (value) => {
        if (typeof value === 'string') {
          const match = value.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
          if (match) candidates.push({ mimeType: match[1], base64: match[2] });
          else if (/^[a-z0-9+/=\r\n]{200,}$/i.test(value) && value.length % 4 === 0) candidates.push({ mimeType: 'image/unknown', base64: value.replace(/\s/g, '') });
        } else if (value && typeof value === 'object') Object.entries(value).forEach(([key, item]) => /image|photo|file|content|data|document|attachment/i.test(key) ? visit(item) : null);
      };
      visit(payload);
      for (const candidate of candidates) images.push(await analyzeImage(Buffer.from(candidate.base64, 'base64'), `${origin}/attachment/${id}`));
      if (!candidates.length) errors.push({ id, error: 'attachment response contained no image payload' });
    } catch (error) { errors.push({ id, error: error.message }); }
  }
  return { images, comparisons: compareImages(images), errors };
}
