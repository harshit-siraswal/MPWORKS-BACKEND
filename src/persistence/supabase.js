import '../env.js';

const url = process.env.SUPABASE_URL?.replace(/\/$/, '');
const configuredKey = (() => {
  if (process.env.SUPABASE_SECRET_KEY) return { value: process.env.SUPABASE_SECRET_KEY, modern: true };
  try {
    const keys = JSON.parse(process.env.SUPABASE_SECRET_KEYS || '{}');
    if (keys.default) return { value: keys.default, modern: true };
  } catch { /* fall back to the legacy key */ }
  return { value: process.env.SUPABASE_SERVICE_ROLE_KEY, modern: false };
})();

export function supabaseConfigured() { return Boolean(url && configuredKey.value); }

async function request(path, options = {}) {
  if (!supabaseConfigured()) throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY are required for persistence');
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: { apikey: configuredKey.value, ...(configuredKey.modern ? {} : { Authorization: `Bearer ${configuredKey.value}` }), 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  if (!response.ok) throw new Error(`Supabase request failed with HTTP ${response.status}: ${await response.text()}`);
  const text = await response.text();
  return text ? JSON.parse(text) : [];
}

export async function supabaseUpsert(table, rows, onConflict) {
  if (!rows?.length) return [];
  return request(`${table}?on_conflict=${encodeURIComponent(onConflict)}`, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(rows)
  });
}

export async function supabaseSelect(table, query = '') {
  if (!supabaseConfigured()) return null;
  return request(`${table}?${query}`, { headers: { 'Content-Type': 'application/json' } });
}

export async function supabaseInsert(table, row) {
  return request(table, { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
}

export async function supabaseUpdate(table, query, patch) {
  return request(`${table}?${query}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch) });
}
