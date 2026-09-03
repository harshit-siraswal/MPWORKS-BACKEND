# MPWORKS backend

Initial API slice for MPLAD Intelligence. It provides a dependency-free Node.js catalog service backed by a checked-in, source-attributed MPLADS work-list snapshot.

## Run

```powershell
npm start
```

The API listens on `http://127.0.0.1:8000`.

Available routes:

- `GET /api/health`
- `GET /api/projects?query=&state=&district=&category=`
- `GET /api/projects/:id`
- `GET /api/projects/:id/evidence`
- `POST /api/projects/:id/reports`
- `GET /api/catalog/summary`
- `GET /api/source-health`
- `GET /api/methodology`

The catalog parser keeps raw and normalized fields side by side, preserves evidence gaps, and exposes source metadata. It does not manufacture coordinates, image evidence, risk scores, or project conclusions. Persistent ingestion, immutable evidence storage, moderation, and authentication remain subsequent slices from the product documentation.

## Data provenance

The checked-in CSV is sourced from [Vonter/india-mplads-works](https://github.com/Vonter/india-mplads-works), which republishes the public MPLADS work list under the Open Data Commons Open Database License (ODbL-1.0). The upstream government source is retained in the API metadata and in `data/source/NOTICE.md`.

This repository stores a snapshot for reproducible local development. The snapshot contains administrative text and work-list fields, but no reliable coordinates or image attachments, so the API reports those limitations explicitly.
