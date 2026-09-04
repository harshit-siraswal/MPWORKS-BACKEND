import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Keep CLI scripts self-contained on Node 18+ without logging or committing secret values.
const envPath = process.env.MPWORKS_ENV_FILE || join(process.cwd(), '.env');
try {
  const contents = readFileSync(envPath, 'utf8');
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || match[1] in process.env) continue;
    const value = match[2].replace(/^(['"])(.*)\1$/, '$2');
    process.env[match[1]] = value;
  }
} catch {
  // A missing local env file is valid for dry-runs and snapshot-only API use.
}
