from __future__ import annotations

import csv
import hashlib
import json
import os
import re
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any


BASE_DIR = Path(__file__).resolve().parents[1]
SOURCE_URL = "https://mplads.mospi.gov.in/digigov/dashboard.html"
SOURCE_REPOSITORY = "https://github.com/Vonter/india-mplads-works"
INR_SYMBOL = "₹"


def clean(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def amount_inr(value: Any) -> int | None:
    match = re.sub(r"[^0-9.-]", "", str(value or ""))
    try:
        number = float(match)
    except ValueError:
        return None
    return int(number) if number else None


def format_inr(value: Any) -> str:
    amount = amount_inr(value)
    if not amount:
        return "Not stated in source"
    text = str(abs(amount))
    if len(text) > 3:
        last = text[-3:]
        head = text[:-3]
        groups: list[str] = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        text = ",".join(groups + [last])
    return f"{'-' if amount < 0 else ''}{INR_SYMBOL}{text}"


def source_date(row: dict[str, str]) -> str:
    return clean(row.get("RECOMMENDED DATE")) or "Not stated in source"


def district_from_row(row: dict[str, str]) -> str:
    ida = re.sub(r"_IDA$", "", clean(row.get("IDA")), flags=re.I)
    ida = re.sub(r",", " ", ida).strip()
    without_office = re.sub(
        r"^(AND\s+)?(DISTRICT\s+DEVELOPMENT\s+COMMISSIONER|DISTRICT\s+PLANNING\s+OFFICER|DISTRICT\s+COLLECTOR|DISTRICT\s+MAGISTRATE|DEPUTY\s+COMMISSIONER|COLLECTOR\s+CUM\s+DEV\s+COMMISSIONER|PROJECT\s+DIRECTOR\s+RDA|COMMISSIONER|COLLECTOR|DC|DM)\s*",
        "",
        ida,
        flags=re.I,
    )
    without_office = re.sub(r"\s+MPLADS$", "", without_office, flags=re.I).strip()
    phrase = re.match(r"^(.+?)\s+DISTRICT(?:\s+.*)?$", without_office, flags=re.I)
    return clean((phrase.group(1) if phrase else without_office) or row.get("DISTRICT") or row.get("CITY")) or "District not stated in source"


def extract_villages(row: dict[str, Any]) -> list[str]:
    values = [clean(row.get("VILLAGE")), clean(row.get("village"))]
    text = clean(" ".join(str(row.get(key, "")) for key in ("WORK", "WORK_DESCRIPTION", "description", "activityName", "ACTIVITY_NAME")))
    values.extend(clean(match) for match in re.findall(r"(?:village|gram)\s*[:=-]?\s*([A-Za-z][A-Za-z .'-]{2,60})", text, flags=re.I))
    result: list[str] = []
    for value in values:
        value = re.sub(r"\s+", " ", value).strip(" ,.;:-")
        if value and value.lower() not in {item.lower() for item in result}:
            result.append(value)
    return result[:12]


def attachment_values(row: dict[str, str]) -> list[str]:
    values: list[str] = []
    for key, value in row.items():
        if value and re.search(r"image|attachment|photo|document|work.?id|wrk.?rec", key, flags=re.I):
            values.extend(clean(item) for item in re.split(r"[,|]", str(value)) if clean(item))
    return values


def stable_id(row: dict[str, str], index: int) -> str:
    payload = json.dumps(row, ensure_ascii=False, separators=(",", ":"))
    return f"{hashlib.sha1(payload.encode('utf-8')).hexdigest()[:12]}-{index}"


def snapshot_project(row: dict[str, str], index: int, source_updated_at: str) -> dict[str, Any]:
    house = clean(row.get("HOUSE")) or ("Rajya Sabha" if "rajya" in clean(row.get("CONSTITUENCY")).lower() else "Lok Sabha")
    village = clean(row.get("VILLAGE"))
    block = clean(row.get("BLOCK"))
    city = clean(row.get("CITY"))
    ward = clean(row.get("WARD"))
    district = district_from_row(row)
    constituency = clean(row.get("CONSTITUENCY"))
    state = clean(row.get("STATE"))
    explicit_term = re.search(r"(1[5-8]th\s+Lok Sabha)", clean(row.get("MP NAME")), flags=re.I)
    term = explicit_term.group(1).replace("  ", " ") if explicit_term else ("Rajya Sabha" if house == "Rajya Sabha" else "17th Lok Sabha")
    member = clean(row.get("MP NAME"))
    member_type = "Nominated MP" if house == "Rajya Sabha" and re.search(r"nominated", member, flags=re.I) else "Former MP" if re.search(r"ex\s*mp|former", member, flags=re.I) else "Sitting MP" if house == "Rajya Sabha" else "Elected MP"
    attachments = attachment_values(row)
    attachment_ids = [value for value in attachments if not re.match(r"https?://", value, flags=re.I) and re.search(r"\d", value)]
    image_urls = [value for value in attachments if re.match(r"https?://", value, flags=re.I) and re.search(r"image|photo|attachment", value, flags=re.I)]
    villages = extract_villages({**row, "village": village})
    return {
        "id": stable_id(row, index),
        "title": clean(row.get("WORK")) or "Untitled work in source record",
        "location": " · ".join(item for item in (village, block, district, constituency, state) if item) or "Location not stated in source",
        "villageRaw": village,
        "villageNames": villages,
        "city": city,
        "ward": ward,
        "state": state,
        "district": district,
        "block": block,
        "constituency": constituency,
        "house": house,
        "term": term,
        "memberType": member_type,
        "mp": member or "MP not stated in source",
        "category": clean(row.get("CATEGORY")) or "Category not stated in source",
        "status": clean(row.get("STATUS")) or "Status not stated in source",
        "amount": format_inr(row.get("ALLOCATION AMOUNT")),
        "evidence": f"{len(image_urls) + 1} source items" if image_urls else "1 source record",
        "updated": source_date(row),
        "risk": "Requires manual verification",
        "score": None,
        "review": True,
        "source": "MPLADS source snapshot · india-mplads-works",
        "sourceUrl": SOURCE_URL,
        "sourceLicense": "ODbL-1.0",
        "sourceDate": source_date(row),
        "fetchTimestamp": source_updated_at,
        "summary": "This record comes from a source-backed MPLADS work-list snapshot. Image evidence and project coordinates are only shown when the upstream record supplies them; their absence is not a conclusion.",
        "imageUrls": image_urls,
        "attachmentIds": attachment_ids,
        "attachmentCandidates": [],
        "signals": [],
        "raw": row,
        "normalized": {"workName": clean(row.get("WORK")), "village": village, "villageNames": villages, "state": state, "district": district, "block": block, "amountInr": amount_inr(row.get("ALLOCATION AMOUNT")), "hasReliableCoordinates": False},
    }


def read_ndjson(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            try:
                value = json.loads(line)
                if isinstance(value, dict):
                    rows.append(value)
            except json.JSONDecodeError:
                continue
    return rows


def resolve_source_path() -> Path:
    configured = os.getenv("MPLADS_CATALOG_PATH")
    path = Path(configured) if configured else BASE_DIR / "data" / "source" / "MPLADS.csv"
    return path if path.is_absolute() else BASE_DIR / path


@lru_cache(maxsize=1)
def load_catalog() -> tuple[list[dict[str, Any]], str, int, int]:
    source_path = resolve_source_path()
    updated_at = datetime.fromtimestamp(source_path.stat().st_mtime, tz=timezone.utc).isoformat().replace("+00:00", "Z")
    projects: list[dict[str, Any]] = []
    with source_path.open("r", encoding="utf-8-sig", newline="") as handle:
        for index, row in enumerate(csv.DictReader(handle, delimiter=";")):
            projects.append(snapshot_project({key: value or "" for key, value in row.items()}, index, updated_at))

    live_root = Path(os.getenv("MPLADS_LIVE_ROOT", str(BASE_DIR / "data" / "raw" / "esakshi")))
    live_rows = read_ndjson(live_root / "projects.ndjson")
    live_attachments = read_ndjson(live_root / "attachments.ndjson")
    attachment_map: dict[str, list[dict[str, Any]]] = {}
    for file in live_attachments:
        key = f"{file.get('sourceWorkId')}|{file.get('term')}|{file.get('houseCode')}"
        attachment_map.setdefault(key, []).append(file)
    live_projects: list[dict[str, Any]] = []
    live_ids: set[str] = set()
    for index, row in enumerate(live_rows):
        source_id = clean(row.get("sourceWorkId"))
        live_ids.add(source_id)
        key = f"{source_id}|{row.get('term')}|{row.get('houseCode')}"
        # Attachment IDs alone are not proof of ownership. The source endpoint
        # has returned cross-record PDFs; only publish files that passed both
        # source identity and project-content verification.
        files = [file for file in attachment_map.get(key, []) if file.get("officialSourceVerified") is True and file.get("aiVerified") is True]
        villages = extract_villages(row)
        project = {
            "id": f"live-{source_id}-{clean(row.get('houseCode'))}-{index}",
            "title": clean(row.get("activityName")) or clean(row.get("description")) or "Untitled live eSAKSHI work",
            "location": " · ".join(clean(row.get(key)) for key in ("description", "district", "constituency", "state") if clean(row.get(key))),
            "villageRaw": villages[0] if villages else "",
            "villageNames": villages,
            "city": "", "ward": "", "state": clean(row.get("state")), "district": clean(row.get("district")), "block": "",
            "constituency": clean(row.get("constituency")), "house": "Rajya Sabha" if str(row.get("houseCode")) == "1" else "Lok Sabha",
            "term": clean(row.get("term")), "memberType": "Sitting MP" if str(row.get("houseCode")) == "1" else "Elected MP",
            "mp": clean(row.get("mp")) or "MP not stated in source", "category": clean(row.get("workCategory")) or "Category not stated in source",
            "status": clean(row.get("stage")) or "Status not stated in source", "amount": format_inr(row.get("recommendedAmount")),
            "evidence": f"{len(files)} source attachments" if files else "1 live source record", "updated": clean(row.get("recommendationDate")) or "Not stated in source",
            "risk": "Requires manual verification", "score": None, "review": True, "source": "MPLADS live eSAKSHI ingest", "sourceUrl": SOURCE_URL,
            "sourceLicense": "Official eSAKSHI source", "sourceDate": clean(row.get("recommendationDate")) or "Not stated in source",
            "fetchTimestamp": files[0].get("analyzedAt", updated_at) if files else updated_at,
            "summary": "This record was fetched from the official eSAKSHI work report. Attached images and PDFs are retained as evidence and compared with the source project fields when analysis is requested.",
            "imageUrls": [clean(file.get("r2Url")) for file in files if clean(file.get("r2Url"))],
            "attachmentIds": [str(file.get("attachmentId")) for file in files if file.get("attachmentId") is not None],
            "attachmentCandidates": files, "signals": [], "raw": row,
            "normalized": {"workName": clean(row.get("description")) or clean(row.get("activityName")), "village": villages[0] if villages else "", "villageNames": villages, "state": clean(row.get("state")), "district": clean(row.get("district")), "amountInr": amount_inr(row.get("recommendedAmount")), "hasReliableCoordinates": False},
        }
        live_projects.append(project)
    snapshot_projects = [project for project in projects if not re.search(r"/\d+-", clean(project["raw"].get("WORK"))) or not live_ids.intersection(re.findall(r"/(\d+)-", clean(project["raw"].get("WORK"))))]
    return snapshot_projects + live_projects, updated_at, len(snapshot_projects), len(live_projects)


def catalog() -> list[dict[str, Any]]:
    return load_catalog()[0]


def district_belongs_to_state(project: dict[str, Any], counts: dict[str, dict[str, int]]) -> bool:
    district = clean(project.get("district")).upper()
    state = clean(project.get("state")).upper()
    states = counts.get(district)
    if not states or len(states) < 2:
        return True
    ordered = sorted(states.items(), key=lambda item: item[1], reverse=True)
    total = sum(states.values())
    return state == ordered[0][0] or ordered[0][1] / total < 0.8


def list_projects(filters: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    filters = filters or {}
    projects = catalog()
    counts: dict[str, dict[str, int]] = {}
    for project in projects:
        counts.setdefault(clean(project.get("district")).upper(), {})[clean(project.get("state")).upper()] = counts.setdefault(clean(project.get("district")).upper(), {}).get(clean(project.get("state")).upper(), 0) + 1
    query = clean(filters.get("query")).lower()
    result: list[dict[str, Any]] = []
    for project in projects:
        haystack = " ".join(str(project.get(key, "")) for key in ("title", "location", "villageRaw", "mp", "category")) + " " + clean(project.get("raw", {}).get("WORK"))
        match = (
            (not query or query in haystack.lower())
            and (not filters.get("mp") or filters.get("mp") == "All MPs" or project.get("mp") == filters.get("mp"))
            and (not filters.get("house") or filters.get("house") == "All houses" or project.get("house") == filters.get("house"))
            and (not filters.get("term") or filters.get("term") == "All terms" or project.get("term") == filters.get("term"))
            and (not filters.get("memberType") or filters.get("memberType") == "All member types" or project.get("memberType") == filters.get("memberType"))
            and (not filters.get("state") or filters.get("state") == "All states" or project.get("state") == filters.get("state"))
            and district_belongs_to_state(project, counts)
            and (not filters.get("district") or filters.get("district") == "All districts" or project.get("district") == filters.get("district"))
            and (not filters.get("constituency") or filters.get("constituency") == "All constituencies" or project.get("constituency") == filters.get("constituency"))
            and (not filters.get("category") or filters.get("category") == "All categories" or project.get("category") == filters.get("category"))
            and (not filters.get("status") or filters.get("status") == "All statuses" or project.get("status") == filters.get("status"))
        )
        if match:
            result.append(project)
    return result


def unique(items: list[Any]) -> list[str]:
    return sorted({clean(item) for item in items if clean(item)}, key=str.casefold)


COST_BANDS = [
    (("street light", "led light", "solar light", "high mast"), "street lighting", 450_000),
    (("handpump", "tube well", "tubewell", "borewell", "water supply", "drinking water", "water tank"), "water infrastructure", 650_000),
    (("drain", "drainage", "culvert", "puliya", "crossing"), "drainage and crossing", 900_000),
    (("road", "cc road", "cement road", "pavement", "lane", "interlocking"), "road and pavement", 1_200_000),
    (("school room", "classroom", "school building", "toilet", "anganwadi"), "school and community facilities", 1_800_000),
    (("community hall", "samudayik bhawan", "stage", "shed"), "community building", 2_500_000),
    (("solar", "solar panel", "solar power"), "solar installation", 1_000_000),
    (("library", "computer", "laboratory", "lab equipment"), "education equipment", 850_000),
    (("ambulance", "medical", "health centre", "health center"), "health facility", 1_400_000),
]


def estimate_project_amount(project: dict[str, Any]) -> dict[str, Any]:
    raw = project.get("raw", {})
    text = clean(" ".join(str(raw.get(key, "")) for key in ("WORK", "WORK_DESCRIPTION", "description", "activityName", "ACTIVITY_NAME")) + " " + str(project.get("category", ""))).lower()
    primary = clean(" ".join(str(raw.get(key, "")) for key in ("WORK", "WORK_DESCRIPTION", "description", "activityName", "ACTIVITY_NAME"))).lower()
    band = next((candidate for candidate in COST_BANDS if any(key in primary for key in candidate[0])), None) or next((candidate for candidate in COST_BANDS if any(key in text for key in candidate[0])), None)
    base = band[2] if band else 800_000
    quantity_match = re.search(r"(?:^|\s)(\d{1,3})\s*(?:nos?\.?|units?|items?|lights?|rooms?|km|kilomet(?:er|re)s?|meters?|metres?)\b", text, flags=re.I)
    quantity = max(1, min(int(quantity_match.group(1)), 20)) if quantity_match else None
    multiplier = min(1 + quantity * 0.45, 8) if quantity and re.search(r"km|kilomet", quantity_match.group(0), flags=re.I) else 1 + (quantity - 1) * 0.55 if quantity else 1
    point = round(max(50_000, min(base * multiplier, 50_000_000)) / 1000) * 1000
    low = round(max(50_000, point * 0.65) / 1000) * 1000
    high = round(min(75_000_000, point * 1.45) / 1000) * 1000
    observed = amount_inr(raw.get("ACTUAL_AMOUNT")) or amount_inr(raw.get("SANCTION_AMOUNT")) or amount_inr(raw.get("ALLOCATION AMOUNT")) or project.get("normalized", {}).get("amountInr")
    variance_amount = round(observed - point, -3) if observed else None
    variance_percent = round((observed - point) / point * 100, 1) if observed else None
    label = f"{'+' if variance_percent is not None and variance_percent > 0 else ''}{variance_percent}% vs estimate" if variance_percent is not None else "No comparable official amount"
    return {"currency": "INR", "amountInr": int(point), "lowInr": int(low), "highInr": int(high), "formatted": format_inr(point), "rangeFormatted": f"{format_inr(low)} - {format_inr(high)}", "observedAmountInr": observed or None, "observedAmountKind": "recommended" if observed else None, "varianceAmountInr": variance_amount, "variancePercent": variance_percent, "varianceLabel": label, "confidence": 62 if band and quantity else 48 if band else 25, "basis": "description-cost-band-v1", "reason": f"Estimated from the {band[1]} cost band" + (f" and a detected quantity of {quantity}." if quantity else ".") if band else "No specific work category was recognized; a conservative general public-works cost band was used.", "caveat": "AI-assisted estimate for triage only. It is not a tender, market-rate, or audit valuation."}


def risk_index(project: dict[str, Any], comparison: dict[str, Any] | None = None, evidence_count: int | None = None, feedback: dict[str, Any] | None = None) -> dict[str, Any]:
    evidence_count = evidence_count if evidence_count is not None else len(project.get("attachmentCandidates", [])) or len(project.get("attachmentIds", []))
    missing = [field for field in ("state", "district", "constituency", "mp", "status") if not clean(project.get(field))]
    consistency = (comparison or {}).get("consistency")
    score = 82 if consistency == "inconsistent" else 18 if consistency == "consistent" else 34 if evidence_count else 48
    if not comparison and not evidence_count and re.search(r"completed|partially completed|physical inspection", project.get("status", ""), flags=re.I): score += 12
    if not comparison and not evidence_count and re.search(r"unsanctioned|action pending", project.get("status", ""), flags=re.I): score += 6
    estimate = estimate_project_amount(project)
    variance = abs(float(estimate["variancePercent"])) if estimate["variancePercent"] is not None else 0
    if variance > 25: score += min(18, round((variance - 25) * 0.24))
    score = max(0, min(100, score + min(len(missing) * 4, 16)))
    label = "High review priority" if score >= 75 else "Elevated review priority" if score >= 50 else "Moderate review priority" if score >= 30 else "Lower review priority"
    reason = (comparison or {}).get("summary") or ("Evidence is available, but a full AI comparison has not been completed for this record." if evidence_count else "No image or PDF evidence is currently available. This is an evidence-coverage limitation, not proof of fraud.")
    if estimate["variancePercent"] is None:
        reason += f" Amount comparison is unavailable. AI estimate: {estimate['rangeFormatted']}."
    else:
        reason += f" AI-assisted amount estimate is {estimate['formatted']} ({estimate['rangeFormatted']}); official amount is {format_inr(estimate['observedAmountInr'])} ({estimate['varianceLabel']}). This variance is a review signal, not proof of fraud."
    return {"score": score, "label": label, "reason": reason, "confidence": int((comparison or {}).get("confidence") or (25 if comparison else 10)), "basis": "Source-field completeness and evidence availability; AI comparison pending plus description-cost estimate"}


def public_project(project: dict[str, Any], feedback: dict[str, Any] | None = None) -> dict[str, Any]:
    result = {key: value for key, value in project.items() if key not in {"raw", "normalized", "signals", "attachmentCandidates", "imageUrls", "attachmentIds"}}
    source_may_have_evidence = bool(project.get("raw", {}).get("FILE_STATUS")) or bool(re.search(r"completed|partially completed|physical inspection", project.get("status", ""), flags=re.I))
    result.update({"amountEstimate": estimate_project_amount(project), "imageCount": len(project.get("imageUrls", [])), "attachmentCount": len(project.get("attachmentIds", [])), "evidenceStatus": "indexed" if project.get("attachmentIds") else "source-pending-index" if source_may_have_evidence else "not-reported-by-source", "publicFeedback": feedback or {"ratingCount": 0, "averageRating": None, "photoCount": 0, "commentCount": 0}, "riskIndex": risk_index(project, feedback=feedback)})
    return result


def facets(filters: dict[str, Any]) -> dict[str, list[str]]:
    scoped = list_projects(filters)
    projects = catalog()
    return {"terms": ["17th Lok Sabha", "18th Lok Sabha"], "houses": ["Lok Sabha", "Rajya Sabha"], "memberTypes": unique([item.get("memberType") for item in projects]), "states": unique([item.get("state") for item in (scoped if filters.get("house") or filters.get("term") else projects)]), "districts": unique([item.get("district") for item in scoped]), "constituencies": unique([item.get("constituency") for item in scoped]), "categories": unique([item.get("category") for item in scoped]), "statuses": unique([item.get("status") for item in scoped])}


def summary() -> dict[str, Any]:
    projects, updated_at, snapshot_count, live_count = load_catalog()
    total = len(projects)
    image_count = sum(bool(item.get("imageUrls")) for item in projects)
    return {"total": total, "completed": sum("completed" in item.get("status", "").lower() for item in projects), "review": total, "imageCoverage": round(image_count / total * 10000) / 100 if total else None, "sourceCoverage": 100, "sourceDataThrough": sorted(item.get("sourceDate", "") for item in projects)[-1] if projects else None, "lastUpdated": updated_at, "terms": {"17th Lok Sabha": sum(item.get("term") == "17th Lok Sabha" for item in projects), "18th Lok Sabha": sum(item.get("term") == "18th Lok Sabha" for item in projects), "Rajya Sabha": sum(item.get("house") == "Rajya Sabha" for item in projects)}, "provenance": {"source": SOURCE_REPOSITORY, "sourceUrl": SOURCE_URL, "license": "ODbL-1.0", "recordCount": total, "snapshot": snapshot_count > 0, "liveRecords": live_count, "liveMetrics": False}}


def metrics(filters: dict[str, Any]) -> dict[str, Any]:
    scoped = list_projects(filters)
    return {"scope": {key: filters.get(key) for key in ("house", "term", "state", "district", "constituency")}, "sourceRecordCount": len(scoped), "allocatedAmount": None, "expenditureAmount": None, "recommendedAmount": sum(item.get("normalized", {}).get("amountInr") or 0 for item in scoped) or None, "worksRecommended": len(scoped), "worksSanctioned": sum(not re.search(r"unsanctioned|pending", item.get("status", ""), flags=re.I) and re.search(r"sanctioned|completed|ongoing|progress", item.get("status", ""), flags=re.I) is not None for item in scoped), "worksOngoing": sum(bool(re.search(r"ongoing|under\s+(process|progress)|progress|partially", item.get("status", ""), flags=re.I)) for item in scoped), "worksCompleted": sum("completed" in item.get("status", "").lower() for item in scoped), "fieldsUnavailable": ["allocatedAmount", "expenditureAmount"], "note": "Exact official allocation and expenditure totals require the live eSAKSHI metric run; this scope uses source work records."}


def source_health() -> dict[str, Any]:
    projects, updated_at, *_ = load_catalog()
    return {"status": "snapshot", "source": SOURCE_REPOSITORY, "sourceUrl": SOURCE_URL, "license": "ODbL-1.0", "sourceFileUpdatedAt": updated_at, "discovered": len(projects), "parsed": len(projects), "failed": 0, "imageDownloadRate": summary()["imageCoverage"], "parserVersion": "mplads-python-csv-parser-v1.0.0", "staleRegions": [], "termsAvailable": unique([item.get("term") for item in projects]), "housesAvailable": unique([item.get("house") for item in projects]), "notes": ["This checked-in snapshot is source-backed but not a live feed.", "The snapshot has no reliable project coordinates.", "Run the Node eSAKSHI ingestion worker to crawl official reports and attachments."]}


def source_metadata() -> dict[str, Any]:
    return {"sourceUrl": SOURCE_URL, "sourceFile": "data/source/MPLADS.csv", "sourceRepository": SOURCE_REPOSITORY, "license": "ODbL-1.0", "officialDashboard": SOURCE_URL, "officialApi": "https://mplads.mospi.gov.in/rest/PreLoginDashboardData", "liveIngestCommand": "npm run fetch:esakshi", "currentSnapshot": "1 Apr 2023 onward upstream work-list export; the live eSAKSHI worker supports current report data."}
