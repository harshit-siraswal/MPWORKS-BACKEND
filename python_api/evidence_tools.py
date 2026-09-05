"""Deterministic evidence inspection used before any optional VLM comparison.

Gemini does not secretly apply these algorithms. The Python service records
which local preprocessing steps ran, then sends bounded evidence to a separate
vision-language model only when that worker is configured.
"""

from __future__ import annotations

import hashlib
import io
import mimetypes
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from PIL import Image


def sauvola_threshold(gray: np.ndarray, window_size: int = 25, k: float = 0.2, r: float = 128.0) -> np.ndarray:
    """Return a Sauvola-style binarisation using OpenCV box filters."""
    window_size = max(3, int(window_size) | 1)
    gray_float = gray.astype(np.float32)
    mean = cv2.boxFilter(gray_float, -1, (window_size, window_size), normalize=True)
    mean_square = cv2.boxFilter(gray_float * gray_float, -1, (window_size, window_size), normalize=True)
    standard_deviation = np.sqrt(np.maximum(mean_square - mean * mean, 0))
    threshold = mean * (1 + k * (standard_deviation / r - 1))
    return (gray_float > threshold).astype(np.uint8) * 255


def _image_metadata(raw: bytes, path: Path) -> dict[str, Any]:
    image = Image.open(io.BytesIO(raw)).convert("RGB")
    rgb = np.asarray(image)
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    denoised = cv2.bilateralFilter(gray, 5, 50, 50)
    thresholded = sauvola_threshold(denoised)
    digest = hashlib.sha256(raw).hexdigest()
    resized = cv2.resize(thresholded, (8, 8), interpolation=cv2.INTER_AREA)
    average_hash = "".join("1" if value >= resized.mean() else "0" for value in resized.flatten())
    dominant = rgb.reshape(-1, 3).mean(axis=0).round().astype(int).tolist()
    methods = ["sha256", "opencv-bilateral-filter", "sauvola-threshold", "average-hash"]
    if hasattr(cv2, "createThinPlateSplineShapeTransformer"):
        methods.append("opencv-thin-plate-spline-transform")
    return {"fileName": path.name, "mimeType": mimetypes.guess_type(path.name)[0] or "image/octet-stream", "sha256": digest, "bytes": len(raw), "format": image.format.lower() if image.format else path.suffix.lstrip("."), "width": image.width, "height": image.height, "averageHash": average_hash, "dominant": {"r": dominant[0], "g": dominant[1], "b": dominant[2]}, "preprocessing": methods}


def _pdf_metadata(raw: bytes, path: Path) -> dict[str, Any]:
    import pdfplumber
    import pypdfium2

    document = pypdfium2.PdfDocument(raw)
    page_count = len(document)
    text_length = 0
    with pdfplumber.open(io.BytesIO(raw)) as pdf:
        for page in pdf.pages[: min(page_count, 4)]:
            text_length += len(page.extract_text() or "")
    return {"fileName": path.name, "mimeType": "application/pdf", "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw), "pageCount": page_count, "textCharactersSampled": text_length, "preprocessing": ["sha256", "pypdfium2-page-count", "pdfplumber-text-extraction"]}


def inspect_local_evidence(path_value: str | Path) -> dict[str, Any] | None:
    path = Path(path_value)
    if not path.exists() or not path.is_file() or path.stat().st_size > 25 * 1024 * 1024:
        return None
    raw = path.read_bytes()
    if path.suffix.lower() == ".pdf":
        return _pdf_metadata(raw, path)
    try:
        return _image_metadata(raw, path)
    except (OSError, ValueError, Image.DecompressionBombError):
        return {"fileName": path.name, "mimeType": mimetypes.guess_type(path.name)[0] or "application/octet-stream", "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw), "preprocessing": ["sha256"]}
