# MPWORKS backend

Source-backed MPLADS catalog API for the MP Works explorer.

## Run

```powershell
npm install
npm start
```

The API listens on `http://127.0.0.1:8000`.

## MPLADS ingestion (the important path)

The checked-in `data/source/MPLADS.csv` is a reproducible upstream snapshot. It is not presented as a live government feed. The primary live collector is the LangGraph-ready eSAKSHI pipeline in `scripts/fetch-esakshi.mjs`:

```powershell
npm run fetch:mplads:dry
npm run fetch:esakshi:without-attachments
npm run fetch:esakshi
```

The collector uses the official eSAKSHI APIs behind `https://mplads.mospi.gov.in/digigov/dashboard.html`. It enumerates Lok Sabha/Rajya Sabha tenures and state scopes, downloads the three work reports, merges records by the official work ID, captures dashboard metrics, discovers attachment IDs via `getAttachIdsbyFlag`, downloads the returned base64 JPEG/PDF payloads via `getAttachmentById`, hashes every file, and analyzes images with Sharp. Configure `MPLADS_MAX_STATES=1` and `MPLADS_MAX_WORKS=2` for a small connectivity test.

The live run writes `data/raw/esakshi/projects.csv`, `projects.ndjson`, `metrics.json`, `attachments.ndjson` and `manifest.json`; source files are ignored by Git. A tested one-state run returned both a completion-certificate JPEG and a bill PDF with zero ingestion errors.

The LangGraph graph is configured in `langgraph.json` and exposed as `mplads_ingest`. It orchestrates source discovery, deterministic report collection and an optional Gemini anomaly summary. Put `GEMINI_API_KEY` in a local `.env`; it is never stored in the repository.

Supabase schema and RLS policies are in `supabase/migrations/0001_mpworks.sql` and the durable ingestion control plane is in `supabase/migrations/0002_agentic_ingestion.sql`. Run the end-to-end agent with `npm run agent:ingest` after setting `SUPABASE_URL`, either the preferred `SUPABASE_SECRET_KEY` or legacy `SUPABASE_SERVICE_ROLE_KEY`, and the R2 secrets. It writes immutable raw source artifacts under `mplads/raw/...`, verified evidence under `mplads/documents/...`, and catalogs metadata in Supabase. Use `MPLADS_MAX_STATES=1 MPLADS_MAX_WORKS=2` for a bounded connectivity test.

The R2 integration uses the S3-compatible endpoint derived from `R2_ACCOUNT_ID` and the public delivery host in `R2_PUBLIC_BASE_URL`. Keep all R2 access keys and the Supabase service key in local/deployment secrets; do not put them in the frontend or Git.

For a hosted worker, add `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_PUBLIC_BASE_URL`, and `OCR_CACHE_PREFIX` to the deployment secret store. Supabase Edge Functions expose project secrets through environment variables; the current Node worker instead reads the ignored root `.env` file. The dedicated MPWORKS Supabase project URL is `https://wqtegmhjizynqpmiyaxb.supabase.co`. Use `npm run agent:ingest:without-attachments` for the first national metadata pass; the default command also retrieves permitted source attachments.

`normalize-mplads.mjs` converts HTML work-register exports into a semicolon-delimited source file and preserves `HOUSE`, `TERM`, and `SOURCE_FILE`. To run the API on a freshly normalized file:

```powershell
$env:MPLADS_CATALOG_PATH = "data/source/MPLADS-live.csv"
npm start
```

The government host can be intermittent; the collector retries each API request three times and records any remaining errors in the manifest. When reachable, this pipeline fetches current terms (including 18th Lok Sabha when published by MPLADS) and attachment evidence.

## API routes

- `GET /api/projects?house=&term=&state=&district=&category=&query=&limit=&offset=`
- `GET /api/projects/:id`
- `GET /api/projects/:id/evidence`
- `POST /api/projects/:id/evidence/refresh` resolves the live eSAKSHI work ID, fetches official JPEG/PNG/PDF attachments, analyzes images, and stores them in R2 when configured
- `GET /api/projects/:id/evidence/attachment/:attachmentId` provides a bounded source proxy for attachments that have not yet been copied to R2
- `GET /api/projects/:id/evidence/location` checks stored evidence image EXIF metadata for GPS coordinates when available
- `POST /api/projects/:id/reports`
- `GET /api/map/locations` returns explicitly labelled district approximations from OpenStreetMap Nominatim
- `GET /api/catalog/summary`
- `GET /api/catalog/facets`
- `GET /api/catalog/metrics`
- `GET /api/catalog/live-metrics?combo=state,constituency,mp,house[,tenure]`
- `GET /api/villages?query=&state=&district=&house=&term=`
- `GET /api/source-health`
- `GET /api/methodology`

Image analysis uses Sharp to calculate format, dimensions, SHA-256, dominant colour and a perceptual average hash. Similarity is an evidence signal only; it is not a fraud conclusion. The legacy snapshot has no attachment URLs, so evidence refresh resolves the selected row against the live Supabase catalog and official eSAKSHI report before deciding whether attachments are available.

## Provenance

The checked-in snapshot is sourced from [Vonter/india-mplads-works](https://github.com/Vonter/india-mplads-works), which republishes public MPLADS work-list exports under ODbL-1.0. That open-source fetch/flatten pipeline informed the reproducible snapshot, while live collection uses the current official eSAKSHI API. The official source and endpoints are retained in API metadata.
