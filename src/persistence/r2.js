import '../env.js';

export function r2Configured() {
  return Boolean(r2Endpoint() && process.env.R2_BUCKET && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY);
}

function r2Endpoint() {
  return process.env.R2_ENDPOINT || (process.env.R2_ACCOUNT_ID ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : '');
}

function publicUrlFor(key) {
  const base = (process.env.R2_PUBLIC_BASE_URL || process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
  return base ? `${base}/${key.split('/').map(encodeURIComponent).join('/')}` : `${r2Endpoint()}/${process.env.R2_BUCKET}/${key}`;
}

export async function createR2Client() {
  if (!r2Configured()) throw new Error('R2_ACCOUNT_ID or R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are required for uploads');
  const { S3Client } = await import('@aws-sdk/client-s3');
  return new S3Client({
    region: 'auto',
    endpoint: r2Endpoint(),
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      ...(process.env.R2_SESSION_TOKEN ? { sessionToken: process.env.R2_SESSION_TOKEN } : {}),
    },
    // R2 does not implement CRC32 as a full-object checksum. Avoid the
    // AWS SDK's optional checksum header on ordinary PutObject requests.
    requestChecksumCalculation: 'WHEN_REQUIRED',
  });
}

export async function putR2Object(key, body, contentType) {
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  const client = await createR2Client();
  await client.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key, Body: body, ContentType: contentType }));
  return { key, url: publicUrlFor(key) };
}
