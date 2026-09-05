from __future__ import annotations

import base64
import csv
import html
import io
import os
import re
import time
from datetime import datetime, timezone
from hashlib import sha256
from typing import Any
from uuid import uuid4

from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from .catalog import (
    SOURCE_URL,
    amount_inr,
    catalog,
    clean,
    estimate_project_amount,
    facets,
    format_inr,
    list_projects,
    metrics,
    public_project,
    risk_index,
    source_health,
    source_metadata,
    summary,
)
from .evidence_tools import inspect_local_evidence


API_VERSION = "1.0.0"
feedback_memory: list[dict[str, Any]] = []
district_jobs: dict[str, dict[str, Any]] = {}


class FilterQuery(BaseModel):
    query: str | None = None
    mp: str | None = None
    house: str | None = None
    term: str | None = None
    memberType: str | None = None
    state: str | None = None
    district: str | None = None
    constituency: str | None = None
    category: str | None = None
    status: str | None = None
    sort: str | None = None


class FeedbackRequest(BaseModel):
    action: str | None = None
    kind: str | None = None
    comment: str | None = Field(default=None, max_length=2000)
    rating: int | None = Field(default=None, ge=0, le=10)
    imageData: str | None = None


class DistrictAnalysisRequest(BaseModel):
    state: str | None = None
    district: str | None = None
    house: str | None = None
    term: str | None = None


class ReportRequest(BaseModel):
    category: str = "other"
    note: str | None = Field(default=None, max_length=2000)


origins = [item.strip() for item in os.getenv("CORS_ORIGINS", "*").split(",") if item.strip()]
app = FastAPI(
    title="MP Works API",
    summary="Source-backed MPLADS public data and evidence routes",
    description="FastAPI service for querying normalized MPLADS records, source metadata and bounded review signals.",
    version=API_VERSION,
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
)
app.add_middleware(CORSMiddleware, allow_origins=origins, allow_credentials=False, allow_methods=["GET", "POST", "OPTIONS"], allow_headers=["*"])


def filters_dict(filters: FilterQuery) -> dict[str, Any]:
    if hasattr(filters, "model_dump"):
        return filters.model_dump(exclude_none=True)
    return filters.dict(exclude_none=True)


def paged_projects(filters: dict[str, Any], limit: int, offset: int, kind: str | None = None) -> tuple[list[dict[str, Any]], int]:
    rows = list_projects(filters)
    if kind == "completed":
        rows = [row for row in rows if re.search(r"completed|partially completed", row.get("status", ""), flags=re.I)]
    rows = sorted(rows, key=lambda row: row.get("title", "").casefold()) if filters.get("sort") == "title" else rows
    page = rows[max(offset, 0): max(offset, 0) + min(max(limit, 1), 200)]
    public_rows = [public_project(row, feedback_summary(row["id"])) for row in page]
    direction = str(filters.get("sort") or "").lower()
    if direction in {"risk-desc", "fraud-desc"}:
        public_rows.sort(key=lambda row: row.get("riskIndex", {}).get("score") or 0, reverse=True)
    elif direction in {"risk-asc", "fraud-asc"}:
        public_rows.sort(key=lambda row: row.get("riskIndex", {}).get("score") or 0)
    elif direction == "evidence-desc":
        public_rows.sort(key=lambda row: row.get("attachmentCount", 0), reverse=True)
    return public_rows, len(rows)


def project_or_404(project_id: str) -> dict[str, Any]:
    project = next((item for item in catalog() if item["id"] == project_id), None)
    if not project:
        raise HTTPException(status_code=404, detail="project_not_found")
    return project


def feedback_ip_hash(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "").split(",")[0].strip()
    address = forwarded or (request.client.host if request.client else "unknown")
    salt = os.getenv("FEEDBACK_IP_SALT", "mpworks-feedback")
    return sha256(f"{salt}|{address}".encode()).hexdigest()


def feedback_summary(project_id: str, viewer_hash: str | None = None) -> dict[str, Any]:
    active = [row for row in feedback_memory if row["project_id"] == project_id and not row.get("undone_at")]
    ratings = [row["rating"] for row in active if row["kind"] == "rating" and isinstance(row.get("rating"), int)]
    comments = [row for row in active if row["kind"] == "comment" and row.get("comment")]
    photos = [row for row in active if row["kind"] == "photo" and row.get("url")]
    return {
        "projectId": project_id,
        "ratingCount": len(ratings),
        "averageRating": round(sum(ratings) / len(ratings), 1) if ratings else None,
        "photoCount": len(photos),
        "commentCount": len(comments),
        "photos": [{"url": row["url"], "createdAt": row["created_at"]} for row in photos[-20:]],
        "comments": [{"comment": row["comment"], "createdAt": row["created_at"]} for row in comments[-20:]],
        "viewer": {kind: any(row["kind"] == kind and row["ip_hash"] == viewer_hash for row in active) for kind in ("photo", "comment", "rating")},
    }


def evidence_for_project(project: dict[str, Any]) -> dict[str, Any]:
    files = []
    # Live attachment IDs are not sufficient proof of ownership: the source
    # endpoint has returned cross-record PDFs in the past. Only expose files
    # that carry both source verification and a completed project comparison.
    candidates = [candidate for candidate in project.get("attachmentCandidates", []) if candidate.get("officialSourceVerified") is True and candidate.get("aiVerified") is True]
    for candidate in candidates:
        file = {key: value for key, value in candidate.items() if key not in {"buffer", "localPath"}}
        local_path = candidate.get("localPath")
        if local_path:
            file.update({key: value for key, value in (inspect_local_evidence(local_path) or {}).items() if key not in {"fileName", "mimeType"}})
        files.append(file)
    for file in files:
        file["url"] = file.get("r2Url") or (f"/api/projects/{project['id']}/evidence/attachment/{file.get('attachmentId')}" if file.get("attachmentId") else file.get("sourceUrl"))
    return {
        "projectId": project["id"],
        "status": "available" if files else "not-available",
        "items": [{"type": "source-record", "label": "MPLADS work list row", "status": "available"}, {"type": "image", "label": "Image/PDF evidence", "status": "available" if files else "not-in-source"}, {"type": "location", "label": "Reliable project coordinates", "status": "not-in-source"}],
        "attachmentIds": [{"id": str(file.get("attachmentId"))} for file in files if file.get("attachmentId") is not None],
        "files": files,
        "images": [file for file in files if str(file.get("mimeType", "")).startswith("image/")],
        "documents": [file for file in files if file not in [item for item in files if str(item.get("mimeType", "")).startswith("image/")]],
        "imageUrls": [file["url"] for file in files if file.get("url")],
        "attachmentCount": len(files),
        "riskIndex": risk_index(project, evidence_count=len(files), feedback=feedback_summary(project["id"])),
        "comparison": {"status": "queued", "reason": "No AI comparison has been requested for this record."},
        "persistence": {"r2": "not-configured", "supabase": "not-configured", "stored": [], "warnings": []},
        "sourceUrl": project.get("sourceUrl", SOURCE_URL),
        "fetchTimestamp": project.get("fetchTimestamp"),
    }


def export_rows(filters: dict[str, Any], limit: int, offset: int) -> list[dict[str, Any]]:
    rows = list_projects(filters)[max(offset, 0): max(offset, 0) + min(max(limit, 1), 10_000)]
    exported = []
    for project in rows:
        public = public_project(project, feedback_summary(project["id"]))
        estimate = public["amountEstimate"]
        risk = public["riskIndex"]
        exported.append({
            "project_id": project["id"], "work_description": project["title"], "member_of_parliament": project["mp"], "house": project["house"], "term": project["term"], "state": project["state"], "district": project["district"], "constituency": project["constituency"], "village_or_area": project.get("villageRaw") or " | ".join(project.get("villageNames", [])), "category": project["category"], "status": project["status"], "recommended_amount": project["amount"], "ai_estimated_amount": estimate["formatted"], "ai_estimate_range": estimate["rangeFormatted"], "observed_amount": format_inr(estimate["observedAmountInr"]) if estimate["observedAmountInr"] else "", "amount_variance": format_inr(estimate["varianceAmountInr"]) if estimate["varianceAmountInr"] is not None else "", "amount_variance_percent": f"{estimate['variancePercent']}%" if estimate["variancePercent"] is not None else "", "amount_estimate_reason": estimate["reason"], "source_date": project["sourceDate"], "review_index": f"{risk['score']}/100", "review_label": risk["label"], "review_reason": risk["reason"], "evidence_links": " | ".join(file.get("url", "") for file in project.get("attachmentCandidates", []) if file.get("url")), "official_source": project["sourceUrl"],
        })
    return exported


EXPORT_HEADERS = ["project_id", "work_description", "member_of_parliament", "house", "term", "state", "district", "constituency", "village_or_area", "category", "status", "recommended_amount", "ai_estimated_amount", "ai_estimate_range", "observed_amount", "amount_variance", "amount_variance_percent", "amount_estimate_reason", "source_date", "review_index", "review_label", "review_reason", "evidence_links", "official_source"]


def csv_content(rows: list[dict[str, Any]]) -> str:
    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=EXPORT_HEADERS, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(rows)
    return output.getvalue()


def html_content(rows: list[dict[str, Any]]) -> str:
    heading = "".join(f"<th>{html.escape(header.replace('_', ' '))}</th>" for header in EXPORT_HEADERS)
    body = "".join("<tr>" + "".join(f"<td>{html.escape(str(row.get(header, '')))}</td>" for header in EXPORT_HEADERS) + "</tr>" for row in rows)
    return f"<!doctype html><meta charset='utf-8'><style>table{{border-collapse:collapse}}th,td{{border:1px solid #ccd6df;padding:5px;vertical-align:top}}th{{background:#eaf2f7}}</style><table><thead><tr>{heading}</tr></thead><tbody>{body}</tbody></table>"


def pdf_content(rows: list[dict[str, Any]]) -> bytes:
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer

    stream = io.BytesIO()
    document = SimpleDocTemplate(stream, pagesize=A4, rightMargin=30, leftMargin=30, topMargin=30, bottomMargin=30)
    styles = getSampleStyleSheet()
    story = [Paragraph("MP Works data export", styles["Title"]), Paragraph("Review index is a human-review signal, not a fraud probability or finding.", styles["BodyText"]), Spacer(1, 12)]
    for index, row in enumerate(rows, start=1):
        story.extend([Paragraph(f"{index}. {html.escape(row['work_description'])}", styles["Heading3"]), Paragraph(html.escape(f"MP: {row['member_of_parliament']} | {row['state']} | {row['district']} | {row['house']}"), styles["BodyText"]), Paragraph(html.escape(f"Status: {row['status']} | Amount: {row['recommended_amount']} | Review: {row['review_index']} {row['review_label']}"), styles["BodyText"]), Spacer(1, 8)])
    document.build(story)
    return stream.getvalue()


@app.get("/api/health", tags=["system"])
def health() -> dict[str, Any]:
    return {"status": "ok", "service": "mplad-intelligence-api", "version": API_VERSION, "framework": "FastAPI", "runtime": "Python"}


@app.get("/api/catalog/summary", tags=["catalog"])
def catalog_summary() -> dict[str, Any]:
    return {"data": summary(), "provenance": {"queryVersion": "summary-python-v1", "generatedAt": datetime.now(timezone.utc).isoformat()}}


@app.get("/api/catalog/facets", tags=["catalog"])
def catalog_facets(filters: FilterQuery = Depends()) -> dict[str, Any]:
    return {"data": facets(filters_dict(filters)), "provenance": source_metadata()}


@app.get("/api/catalog/metrics", tags=["catalog"])
def catalog_metrics(filters: FilterQuery = Depends()) -> dict[str, Any]:
    value = metrics(filters_dict(filters))
    scoped = list_projects(filters_dict(filters))
    value["sanctionedAmount"] = sum(amount_inr(item.get("raw", {}).get("SANCTION_AMOUNT")) or 0 for item in scoped) or None
    value["usedAmount"] = sum(amount_inr(item.get("raw", {}).get("ACTUAL_AMOUNT")) or 0 for item in scoped) or None
    return {"data": value, "provenance": source_metadata()}


@app.get("/api/villages", tags=["catalog"])
def villages(filters: FilterQuery = Depends(), limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0)) -> dict[str, Any]:
    values: dict[str, dict[str, Any]] = {}
    query = clean(filters.query).casefold()
    for project in list_projects(filters_dict(filters)):
        for name in project.get("villageNames", []):
            if query and query not in name.casefold():
                continue
            key = name.casefold()
            current = values.setdefault(key, {"name": name, "normalizedName": key, "state": project["state"], "district": project["district"], "projectIds": []})
            current["projectIds"].append(project["id"])
    rows = list(values.values())
    for row in rows:
        row["projectCount"] = len(row["projectIds"])
    page = rows[offset:offset + limit]
    return {"data": page, "meta": {"total": len(rows), "offset": offset, "limit": limit, "hasMore": offset + limit < len(rows)}, "provenance": source_metadata()}


@app.get("/api/projects", tags=["projects"])
def projects(filters: FilterQuery = Depends(), limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0)) -> dict[str, Any]:
    rows, total = paged_projects(filters_dict(filters), limit, offset)
    return {"data": rows, "meta": {"count": len(rows), "total": total, "limit": min(limit, 200), "offset": offset, "hasMore": offset + len(rows) < total, "queryVersion": "catalog-search-python-v1", "sourceUpdatedAt": load_source_updated_at()}}


def works_response(kind: str, filters: FilterQuery, limit: int, offset: int) -> dict[str, Any]:
    rows, total = paged_projects(filters_dict(filters), limit, offset, kind if kind == "completed" else None)
    return {"data": rows, "meta": {"count": len(rows), "total": total, "limit": min(limit, 200), "offset": offset, "hasMore": offset + len(rows) < total}, "provenance": source_metadata()}


@app.get("/api/works/recommended", tags=["projects"])
def recommended_works(filters: FilterQuery = Depends(), limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0)) -> dict[str, Any]:
    return works_response("recommended", filters, limit, offset)


@app.get("/api/works/completed", tags=["projects"])
def completed_works(filters: FilterQuery = Depends(), limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0)) -> dict[str, Any]:
    return works_response("completed", filters, limit, offset)


@app.get("/api/works/summary", tags=["projects"])
def works_summary(filters: FilterQuery = Depends()) -> dict[str, Any]:
    rows = list_projects(filters_dict(filters))
    return {"data": {"recommended": len(rows), "completed": sum(bool(re.search(r"completed|partially completed", row.get("status", ""), flags=re.I)) for row in rows), "total": len(rows), "filters": filters_dict(filters)}, "provenance": source_metadata()}


@app.get("/api/exports/{export_format}", tags=["exports"])
def export_data(export_format: str, filters: FilterQuery = Depends(), limit: int = Query(10_000, ge=1, le=10_000), offset: int = Query(0, ge=0)) -> Response:
    if export_format not in {"csv", "excel", "xls", "pdf"}:
        raise HTTPException(status_code=404, detail="route_not_found")
    rows = export_rows(filters_dict(filters), limit, offset)
    date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    if export_format == "csv":
        return Response(content=csv_content(rows), media_type="text/csv", headers={"Content-Disposition": f'attachment; filename="mpworks-export-{date}.csv"', "X-Export-Limit": str(limit), "X-Export-Offset": str(offset)})
    if export_format in {"excel", "xls"}:
        return Response(content=html_content(rows), media_type="application/vnd.ms-excel", headers={"Content-Disposition": f'attachment; filename="mpworks-export-{date}.xls"'})
    return Response(content=pdf_content(rows), media_type="application/pdf", headers={"Content-Disposition": f'attachment; filename="mpworks-export-{date}.pdf"'})


@app.get("/api/mps", tags=["members"])
def members(filters: FilterQuery = Depends(), limit: int = Query(24, ge=1, le=60), offset: int = Query(0, ge=0)) -> dict[str, Any]:
    groups: dict[str, dict[str, Any]] = {}
    for project in list_projects(filters_dict(filters)):
        member_id = sha256(f"{project['mp']}|{project['state']}".encode()).hexdigest()[:16]
        member = groups.setdefault(member_id, {"id": member_id, "name": project["mp"], "state": project["state"], "houses": [], "terms": [], "constituencies": [], "projectCount": 0, "projectIds": [], "sourceUrl": project["sourceUrl"]})
        for field in ("houses", "terms", "constituencies"):
            value = project["house"] if field == "houses" else project["term"] if field == "terms" else project["constituency"]
            if value not in member[field]: member[field].append(value)
        member["projectCount"] += 1
        member["projectIds"].append(project["id"])
    values = list(groups.values())
    page = values[offset:offset + limit]
    return {"data": [{key: value for key, value in member.items() if key != "projectIds"} for member in page], "meta": {"count": len(page), "total": len(values), "limit": limit, "offset": offset, "hasMore": offset + len(page) < len(values)}}


@app.get("/api/methodology", tags=["reference"])
def methodology() -> dict[str, Any]:
    return {"data": {"riskLanguage": "Risk indicators prioritize human review and are not conclusions.", "methods": ["source-record-retention", "description-cost-band-estimation", "opencv-bilateral-filter", "sauvola-threshold", "optional-thin-plate-spline-transform", "pypdfium2-page-rendering", "pdfplumber-text-extraction", "optional-vision-language-comparison"], "caveats": ["Image coverage is source-dependent.", "Sauvola, bilateral filtering and TPS are preprocessing capabilities of this Python pipeline, not hidden Gemini internals.", "Coordinates are never silently invented. The map uses an explicitly labelled district approximation only.", "No risk score is calculated until sufficient evidence is available."], "source": source_metadata()}}


@app.get("/api/source-health", tags=["reference"])
def source_health_route() -> dict[str, Any]:
    return {"data": source_health()}


@app.get("/api/projects/{project_id}/evidence", tags=["evidence"])
def project_evidence(project_id: str) -> dict[str, Any]:
    return {"data": evidence_for_project(project_or_404(project_id))}


@app.post("/api/projects/{project_id}/evidence/refresh", status_code=202, tags=["evidence"])
def refresh_evidence(project_id: str) -> dict[str, Any]:
    project = project_or_404(project_id)
    evidence = evidence_for_project(project)
    return {"data": {"projectId": project_id, "status": evidence["status"], "note": "The FastAPI service accepted the refresh request. The Node ingestion worker remains responsible for live eSAKSHI attachment retrieval and Gemini analysis.", "files": evidence["files"], "comparison": evidence["comparison"], "persistence": evidence["persistence"]}}


@app.get("/api/projects/{project_id}/evidence/attachment/{attachment_id}", tags=["evidence"])
def evidence_attachment(project_id: str, attachment_id: str) -> JSONResponse:
    project = project_or_404(project_id)
    if not any(str(item.get("attachmentId")) == attachment_id for item in project.get("attachmentCandidates", [])):
        return JSONResponse(status_code=404, content={"error": "attachment_payload_not_found"})
    return JSONResponse(status_code=501, content={"error": "attachment_proxy_not_enabled", "note": "Run the ingestion worker to persist this attachment before requesting its binary payload."})


@app.get("/api/projects/{project_id}/evidence/location", tags=["evidence"])
def evidence_location(project_id: str) -> dict[str, Any]:
    project_or_404(project_id)
    return {"data": {"coordinates": None, "message": "The available evidence images do not contain readable GPS coordinates."}}


@app.get("/api/projects/{project_id}", tags=["projects"])
def project(project_id: str) -> dict[str, Any]:
    value = project_or_404(project_id)
    return {"data": public_project(value, feedback_summary(project_id))}


@app.post("/api/projects/{project_id}/reports", status_code=202, tags=["projects"])
def report(project_id: str, body: ReportRequest) -> dict[str, Any]:
    project_or_404(project_id)
    return {"data": {"reportId": f"public-{project_id}-{int(time.time() * 1000)}", "projectId": project_id, "status": "Unverified public report", "received": True, "category": body.category}, "audit": {"event": "public_report_received", "createdAt": datetime.now(timezone.utc).isoformat()}}


@app.get("/api/projects/{project_id}/feedback", tags=["feedback"])
def get_feedback(project_id: str, request: Request) -> dict[str, Any]:
    project_or_404(project_id)
    return {"data": feedback_summary(project_id, feedback_ip_hash(request))}


@app.post("/api/projects/{project_id}/feedback", status_code=201, tags=["feedback"])
def post_feedback(project_id: str, body: FeedbackRequest, request: Request) -> dict[str, Any]:
    project_or_404(project_id)
    ip_hash = feedback_ip_hash(request)
    if body.action == "undo":
        if body.kind not in {"photo", "comment", "rating"}:
            raise HTTPException(status_code=400, detail="invalid_feedback_kind")
        for row in reversed(feedback_memory):
            if row["project_id"] == project_id and row["ip_hash"] == ip_hash and row["kind"] == body.kind and not row.get("undone_at"):
                row["undone_at"] = datetime.now(timezone.utc).isoformat()
                break
        else:
            raise HTTPException(status_code=404, detail="feedback_not_found")
        return {"data": feedback_summary(project_id, ip_hash), "message": f"{body.kind} feedback was undone."}
    requested: list[dict[str, Any]] = []
    if body.comment is not None:
        comment = body.comment.strip()
        if not comment: raise HTTPException(status_code=400, detail="invalid_comment")
        requested.append({"kind": "comment", "comment": comment})
    if body.rating is not None:
        requested.append({"kind": "rating", "rating": body.rating})
    if body.imageData is not None:
        match = re.match(r"^data:(image/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$", body.imageData, flags=re.I)
        if not match: raise HTTPException(status_code=400, detail="invalid_image")
        try: raw = base64.b64decode(re.sub(r"\s", "", match.group(2)), validate=True)
        except Exception as error: raise HTTPException(status_code=400, detail="invalid_image") from error
        if not raw or len(raw) > 6 * 1024 * 1024: raise HTTPException(status_code=400, detail="invalid_image")
        requested.append({"kind": "photo", "url": None})
    if not requested: raise HTTPException(status_code=400, detail="feedback_required")
    now = datetime.now(timezone.utc).isoformat()
    for item in requested:
        if any(row["project_id"] == project_id and row["ip_hash"] == ip_hash and row["kind"] == item["kind"] and not row.get("undone_at") for row in feedback_memory):
            raise HTTPException(status_code=409, detail="feedback_already_submitted")
        feedback_memory.append({"project_id": project_id, "ip_hash": ip_hash, "created_at": now, "undone_at": None, **item})
    return {"data": feedback_summary(project_id, ip_hash), "message": "Feedback received."}


@app.get("/api/mps/{member_id}/projects", tags=["members"])
def member_projects(member_id: str, filters: FilterQuery = Depends(), limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0)) -> dict[str, Any]:
    all_members = members(filters, 60, 0)["data"]
    member = next((value for value in all_members if value["id"] == member_id), None)
    if not member: raise HTTPException(status_code=404, detail="member_not_found")
    project_rows = [row for row in list_projects(filters_dict(filters)) if row["mp"] == member["name"] and row["state"] == member["state"]]
    page = project_rows[offset:offset + limit]
    return {"data": [public_project(row, feedback_summary(row["id"])) for row in page], "meta": {"count": len(page), "total": len(project_rows), "limit": limit, "offset": offset, "hasMore": offset + len(page) < len(project_rows)}, "member": member}


@app.get("/api/mps/{member_id}", tags=["members"])
def member(member_id: str, filters: FilterQuery = Depends()) -> dict[str, Any]:
    value = next((item for item in members(filters, 60, 0)["data"] if item["id"] == member_id), None)
    if not value: raise HTTPException(status_code=404, detail="member_not_found")
    return {"data": value, "provenance": source_metadata()}


@app.get("/api/map/locations", tags=["map"])
def map_locations(filters: FilterQuery = Depends()) -> dict[str, Any]:
    scoped = list_projects(filters_dict(filters))
    return {"data": {"points": [], "totalMatches": len(scoped), "precision": "District locations are approximate; the source does not publish project coordinates.", "mapSource": "OpenStreetMap Nominatim", "message": "Select a state or district to place source records on the map." if not filters.state and not filters.district else "The Python API has no geocoded point cached for this scope yet."}}


@app.get("/api/map/reverse", tags=["map"])
def map_reverse(lat: float = Query(..., ge=-90, le=90), lon: float = Query(..., ge=-180, le=180)) -> dict[str, Any]:
    return {"data": {"lat": lat, "lon": lon, "state": None, "district": None, "area": None, "displayName": None, "precision": "Map pin is user-selected; source records remain district/area matched."}}


@app.post("/api/district-analysis", status_code=202, tags=["analysis"])
def start_district_analysis(body: DistrictAnalysisRequest, background_tasks: BackgroundTasks) -> dict[str, Any]:
    if not body.district: raise HTTPException(status_code=400, detail="district_required")
    filters = {key: value for key, value in body.model_dump().items() if value} if hasattr(body, "model_dump") else {key: value for key, value in body.dict().items() if value}
    project_rows = list_projects(filters)
    if not project_rows: raise HTTPException(status_code=404, detail="district_has_no_projects")
    job_id = str(uuid4())
    district_jobs[job_id] = {"id": job_id, "status": "queued", "createdAt": datetime.now(timezone.utc).isoformat(), "completed": 0, "total": len(project_rows), "scope": filters, "results": []}

    def finish_job() -> None:
        job = district_jobs[job_id]
        job["status"] = "completed"
        job["completed"] = len(project_rows)
        job["completedAt"] = datetime.now(timezone.utc).isoformat()
        job["results"] = [{"projectId": row["id"], "score": risk_index(row)["score"], "label": risk_index(row)["label"], "confidence": 10, "evidenceCount": 0, "comparison": {"consistency": "inconclusive", "summary": "No AI evidence comparison was run by the public API worker.", "possibleIssues": []}} for row in project_rows]
        job["results"].sort(key=lambda item: item["score"] or -1, reverse=True)

    background_tasks.add_task(finish_job)
    return {"data": district_jobs[job_id], "note": "District analysis queued. The public FastAPI worker returns source-field review signals; the Node ingestion worker remains responsible for evidence downloads and Gemini comparisons."}


@app.get("/api/district-analysis/{job_id}", tags=["analysis"])
def district_analysis(job_id: str) -> dict[str, Any]:
    if job_id not in district_jobs: raise HTTPException(status_code=404, detail="analysis_job_not_found")
    return {"data": district_jobs[job_id]}


@app.get("/api/catalog/live-metrics", tags=["catalog"])
def live_metrics(combo: str | None = None) -> JSONResponse:
    if not combo or not re.fullmatch(r"\d+(,\d+){3,4}", combo):
        return JSONResponse(status_code=400, content={"error": "combo_required", "note": "Use the official eSAKSHI state,constituency,mp,house[,tenure] codes."})
    return JSONResponse(status_code=503, content={"error": "live_metrics_unavailable", "detail": "The Python API keeps live metric collection in the ingestion worker boundary."})


def load_source_updated_at() -> str:
    try:
        return summary()["lastUpdated"]
    except (FileNotFoundError, OSError):
        return datetime.now(timezone.utc).isoformat()
