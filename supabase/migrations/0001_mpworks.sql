-- MP Works persistence model. Apply with `supabase db push` or the Supabase SQL editor.
create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

create table if not exists public.source_snapshots (
  id uuid primary key default gen_random_uuid(),
  source_name text not null,
  source_url text not null,
  fetched_at timestamptz not null default now(),
  parser_version text not null,
  record_count integer not null default 0,
  attachment_count integer not null default 0,
  manifest jsonb not null default '{}'::jsonb
);

create table if not exists public.ingest_runs (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid references public.source_snapshots(id) on delete set null,
  status text not null check (status in ('running', 'completed', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  error text,
  stats jsonb not null default '{}'::jsonb
);

create table if not exists public.states (
  id uuid primary key default gen_random_uuid(),
  source_id text,
  name text not null,
  normalized_name text not null unique,
  raw jsonb not null default '{}'::jsonb
);

create table if not exists public.districts (
  id uuid primary key default gen_random_uuid(),
  state_id uuid references public.states(id) on delete cascade,
  source_id text,
  name text not null,
  normalized_name text not null,
  raw jsonb not null default '{}'::jsonb,
  unique (state_id, normalized_name)
);

create table if not exists public.constituencies (
  id uuid primary key default gen_random_uuid(),
  state_id uuid references public.states(id) on delete set null,
  source_id text,
  name text not null,
  normalized_name text not null,
  house text,
  raw jsonb not null default '{}'::jsonb,
  unique (state_id, normalized_name, house)
);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  source_work_id text not null,
  source_work_recommendation_id text,
  source_work_id_physical text,
  snapshot_id uuid references public.source_snapshots(id) on delete set null,
  state_id uuid references public.states(id) on delete set null,
  district_id uuid references public.districts(id) on delete set null,
  constituency_id uuid references public.constituencies(id) on delete set null,
  state text,
  district text,
  constituency text,
  constituency_source_id text,
  house_code text,
  house text,
  term text,
  mp text,
  work_category text,
  activity_name text,
  implementing_authority text,
  description text,
  stage text,
  flag integer,
  file_status boolean not null default false,
  recommendation_date date,
  sanction_date date,
  actual_end_date date,
  recommended_amount numeric,
  sanction_amount numeric,
  actual_amount numeric,
  letter_no text,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_work_id, term, house_code)
);

create table if not exists public.villages (
  id uuid primary key default gen_random_uuid(),
  state_id uuid references public.states(id) on delete set null,
  district_id uuid references public.districts(id) on delete set null,
  name text not null,
  normalized_name text not null,
  extraction_method text not null,
  confidence numeric,
  raw_context text,
  raw jsonb not null default '{}'::jsonb,
  unique (state_id, district_id, normalized_name)
);

create table if not exists public.project_villages (
  project_id uuid references public.projects(id) on delete cascade,
  village_id uuid references public.villages(id) on delete cascade,
  primary key (project_id, village_id)
);

create table if not exists public.project_documents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  source_attachment_id text not null,
  source_file_name text,
  source_url text,
  r2_key text,
  r2_url text,
  mime_type text,
  byte_size bigint,
  sha256 text,
  status text not null default 'discovered',
  analysis jsonb not null default '{}'::jsonb,
  raw jsonb not null default '{}'::jsonb,
  unique (project_id, source_attachment_id)
);

create table if not exists public.project_media (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  document_id uuid references public.project_documents(id) on delete set null,
  r2_key text,
  r2_url text,
  mime_type text,
  width integer,
  height integer,
  byte_size bigint,
  sha256 text,
  average_hash text,
  dominant_color text,
  analysis jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (project_id, sha256)
);

create table if not exists public.project_metrics (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid references public.source_snapshots(id) on delete set null,
  state text,
  district text,
  constituency text,
  house_code text,
  term text,
  allocated_amount numeric,
  expenditure_amount numeric,
  recommended_count integer,
  sanctioned_count integer,
  ongoing_count integer,
  completed_count integer,
  raw jsonb not null default '{}'::jsonb,
  fetched_at timestamptz not null default now(),
  unique (state, district, constituency, house_code, term)
);

create index if not exists projects_scope_idx on public.projects (state, district, constituency, house_code, term);
create index if not exists projects_description_trgm_idx on public.projects using gin (description gin_trgm_ops);
create index if not exists projects_mp_trgm_idx on public.projects using gin (mp gin_trgm_ops);
create index if not exists villages_name_trgm_idx on public.villages using gin (normalized_name gin_trgm_ops);
create index if not exists project_villages_village_idx on public.project_villages (village_id);

alter table public.source_snapshots enable row level security;
alter table public.ingest_runs enable row level security;
alter table public.states enable row level security;
alter table public.districts enable row level security;
alter table public.constituencies enable row level security;
alter table public.projects enable row level security;
alter table public.villages enable row level security;
alter table public.project_villages enable row level security;
alter table public.project_documents enable row level security;
alter table public.project_media enable row level security;
alter table public.project_metrics enable row level security;

create policy "public can read states" on public.states for select using (true);
create policy "public can read districts" on public.districts for select using (true);
create policy "public can read constituencies" on public.constituencies for select using (true);
create policy "public can read projects" on public.projects for select using (true);
create policy "public can read villages" on public.villages for select using (true);
create policy "public can read project village links" on public.project_villages for select using (true);
create policy "public can read project documents" on public.project_documents for select using (true);
create policy "public can read project media" on public.project_media for select using (true);
create policy "public can read project metrics" on public.project_metrics for select using (true);
create policy "public can read source snapshots" on public.source_snapshots for select using (true);

-- Ingest runs are intentionally not public. Server-side service-role writes bypass RLS.

