-- Durable ingestion control plane. Raw source payloads and source credentials stay outside the public Data API.
create table if not exists public.ingest_partitions (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.ingest_runs(id) on delete cascade,
  partition_key text not null,
  house_code text not null,
  tenure_id text,
  tenure text,
  state_source_id text,
  state_name text,
  status text not null default 'discovered' check (status in ('discovered', 'running', 'completed', 'partial', 'failed')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  checkpoint jsonb not null default '{}'::jsonb,
  counts jsonb not null default '{}'::jsonb,
  last_source_observed_at timestamptz,
  last_error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, partition_key)
);

create table if not exists public.source_artifacts (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.ingest_runs(id) on delete cascade,
  partition_id uuid references public.ingest_partitions(id) on delete set null,
  source_route text not null,
  request_body jsonb not null default '{}'::jsonb,
  response_status integer,
  content_type text,
  content_sha256 text not null check (content_sha256 ~* '^[0-9a-f]{64}$'),
  byte_size bigint not null check (byte_size >= 0),
  r2_key text not null,
  fetched_at timestamptz not null default now(),
  parser_version text,
  response_meta jsonb not null default '{}'::jsonb,
  unique (run_id, r2_key)
);

create table if not exists public.ingest_jobs (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.ingest_runs(id) on delete cascade,
  job_type text not null check (job_type in ('discover', 'fetch_partition', 'fetch_attachment', 'normalize', 'publish')),
  partition_id uuid references public.ingest_partitions(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed', 'dead_letter')),
  payload jsonb not null default '{}'::jsonb,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ingest_partitions_status_idx on public.ingest_partitions (status, updated_at desc);
create index if not exists ingest_jobs_queue_idx on public.ingest_jobs (status, available_at, created_at);
create index if not exists source_artifacts_run_idx on public.source_artifacts (run_id, fetched_at desc);

alter table public.ingest_partitions enable row level security;
alter table public.source_artifacts enable row level security;
alter table public.ingest_jobs enable row level security;

-- No anon/authenticated policies are intentional: these are service-role-only control-plane tables.
