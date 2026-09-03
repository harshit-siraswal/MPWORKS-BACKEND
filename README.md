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

Supabase schema and RLS policies are in `supabase/migrations/0001_mpworks.sql`. Import normalized data with `npm run import:esakshi` after setting `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Upload verified source files to the `mpworks` R2 bucket with `npm run upload:evidence` after setting S3-compatible R2 credentials.

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
- `POST /api/projects/:id/evidence/refresh` downloads and analyzes source image URLs when present
- `POST /api/projects/:id/reports`
- `GET /api/map/locations` returns explicitly labelled district approximations from OpenStreetMap Nominatim
- `GET /api/catalog/summary`
- `GET /api/catalog/facets`
- `GET /api/catalog/metrics`
- `GET /api/catalog/live-metrics?combo=state,constituency,mp,house[,tenure]`
- `GET /api/villages?query=&state=&district=&house=&term=`
- `GET /api/source-health`
- `GET /api/methodology`

Image analysis uses Sharp to calculate format, dimensions, SHA-256, dominant colour and a perceptual average hash. Similarity is an evidence signal only; it is not a fraud conclusion. The snapshot has no attachment URLs, so its image coverage correctly remains `0%` and individual records say `not-in-source`.

## Provenance

The checked-in snapshot is sourced from [Vonter/india-mplads-works](https://github.com/Vonter/india-mplads-works), which republishes public MPLADS work-list exports under ODbL-1.0. That open-source fetch/flatten pipeline informed the reproducible snapshot, while live collection uses the current official eSAKSHI API. The official source and endpoints are retained in API metadata.
