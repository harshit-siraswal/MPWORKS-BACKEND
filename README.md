# MPWORKS backend

Source-backed MPLADS catalog API for the MP Works explorer.

## Run

```powershell
npm install
npm start
```

The API listens on `http://127.0.0.1:8000`.

## MPLADS ingestion (the important path)

The checked-in `data/source/MPLADS.csv` is a reproducible upstream snapshot. It is not presented as a live government feed. The live collector is `scripts/fetch-mplads.mjs`:

```powershell
npm run fetch:mplads:dry
npm run fetch:mplads
npm run normalize:mplads
```

The collector uses Playwright to read the official work-register dropdowns instead of guessing URLs. It iterates the portal's House, Tenure, State and Location selections, saves each returned table, records the source manifest, captures work/attachment attributes exposed in the page, calls the public review and attachment endpoints used by the portal, and saves the attachment responses for analysis. Configure `MPLADS_SOURCE_URL` if the official portal changes its work-register URL, and `MPLADS_MAX_STATES=1` for a small connectivity test.

`normalize-mplads.mjs` converts HTML work-register exports into a semicolon-delimited source file and preserves `HOUSE`, `TERM`, and `SOURCE_FILE`. To run the API on a freshly normalized file:

```powershell
$env:MPLADS_CATALOG_PATH = "data/source/MPLADS-live.csv"
npm start
```

The current environment could not reach the government host during implementation, so a live crawl was not claimed as completed. When the host is reachable, this pipeline is the path that fetches current terms (including 18th Lok Sabha if published by MPLADS) and attachment evidence.

## API routes

- `GET /api/projects?house=&term=&state=&district=&category=&query=&limit=&offset=`
- `GET /api/projects/:id`
- `GET /api/projects/:id/evidence`
- `POST /api/projects/:id/evidence/refresh` downloads and analyzes source image URLs when present
- `POST /api/projects/:id/reports`
- `GET /api/map/locations` returns explicitly labelled district approximations from OpenStreetMap Nominatim
- `GET /api/catalog/summary`
- `GET /api/catalog/facets`
- `GET /api/source-health`
- `GET /api/methodology`

Image analysis uses Sharp to calculate format, dimensions, SHA-256, dominant colour and a perceptual average hash. Similarity is an evidence signal only; it is not a fraud conclusion. The snapshot has no attachment URLs, so its image coverage correctly remains `0%` and individual records say `not-in-source`.

## Provenance

The checked-in snapshot is sourced from [Vonter/india-mplads-works](https://github.com/Vonter/india-mplads-works), which republishes public MPLADS work-list exports under ODbL-1.0. The official source and work-register URL are retained in `data/source/NOTICE.md` and API metadata.
