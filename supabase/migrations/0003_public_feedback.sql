-- Anonymous public project feedback. The server stores only a salted IP hash;
-- the table is service-role-only and is not exposed to browser clients.
create table if not exists public.project_public_feedback (
  id uuid primary key default gen_random_uuid(),
  project_key text not null,
  kind text not null check (kind in ('photo', 'comment', 'rating')),
  ip_hash text not null check (ip_hash ~ '^[0-9a-f]{64}$'),
  comment text,
  rating smallint check (rating between 0 and 10),
  r2_key text,
  r2_url text,
  mime_type text,
  file_size bigint check (file_size is null or file_size >= 0),
  undone_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_key, ip_hash, kind),
  check ((kind = 'comment' and comment is not null and rating is null and r2_url is null) or (kind = 'rating' and comment is null and rating is not null and r2_url is null) or (kind = 'photo' and comment is null and rating is null and r2_url is not null))
);

create index if not exists project_public_feedback_project_idx on public.project_public_feedback (project_key, created_at desc);
alter table public.project_public_feedback enable row level security;
revoke all on public.project_public_feedback from anon, authenticated;
-- The API uses the server-side service role, which bypasses RLS. No browser policy is intentional.
