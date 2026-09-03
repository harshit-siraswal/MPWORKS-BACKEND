const url = process.env.SUPABASE_URL?.replace(/\/$/, '');
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export function supabaseConfigured() { return Boolean(url && serviceKey); }

export async function supabaseUpsert(table, rows, onConflict) {
  if (!supabaseConfigured()) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for persistence');
  if (!rows?.length) return [];
  const response = await fetch(`${url}/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}`, {
    method: 'POST',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(rows)
  });
  if (!response.ok) throw new Error(`Supabase upsert ${table} failed with HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}

export async function supabaseSelect(table, query = '') {
  if (!supabaseConfigured()) return null;
  const response = await fetch(`${url}/rest/v1/${table}?${query}`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
  if (!response.ok) throw new Error(`Supabase select ${table} failed with HTTP ${response.status}`);
  return response.json();
}

