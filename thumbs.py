"""Thumbnail and page recompression helpers."""
from __future__ import annotations

import io

from PIL import Image

THUMB_SIZES = {"s": 160, "m": 320, "l": 640}


def _open(data: bytes):
    img = Image.open(io.BytesIO(data))
    img.load()
    return img


def make_thumb(data: bytes, size: int = 320) -> bytes:
    img = _open(data)
    if img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGB")
    img.thumbnail((size, size), Image.LANCZOS)
    out = io.BytesIO()
    img.save(out, format="WEBP", quality=82, method=4)
    return out.getvalue()


def recompress(img, mode: str) -> bytes:
    """Encode a PIL image for the pages cache.

    mode: none | minimal | medium | max
    """
    if img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGB")

    if mode == "none":
        out = io.BytesIO()
        img.save(out, format="WEBP", lossless=True, method=4)
        return out.getvalue()

    widths = {"minimal": 1600, "medium": 1280, "max": 960}
    qualities = {"minimal": 85, "medium": 72, "max": 52}

    limit = widths.get(mode, 1600)
    if img.width > limit:
        ratio = limit / img.width
        img = img.resize((limit, max(1, int(img.height * ratio))), Image.LANCZOS)

    out = io.BytesIO()
    img.save(out, format="WEBP", quality=qualities.get(mode, 92), method=4)
    return out.getvalue()


def probe_size(data: bytes):
    try:
        img = _open(data)
        return img.size, img.mode
    except Exception:
        return None, None
