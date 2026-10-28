"""Pack comic pages into a zip archive.

Two distinct products:
  cache    -> honours the configured compression mode
  download -> no lossy re-encode; original bytes when the page needed no restore,
              lossless WebP when it had to be descrambled (pixels stay exact)
"""
from __future__ import annotations

import io
import zipfile
from urllib.parse import quote

import thumbs

BAD_CHARS = set('\\/:*?"<>|')


def safe_name(text, fallback):
    cleaned = "".join(ch for ch in str(text or "") if ch not in BAD_CHARS)
    cleaned = cleaned.strip().strip(".")
    return (cleaned or fallback)[:80]


def content_disposition(filename):
    stem, _dot, ext = filename.rpartition(".")
    ascii_stem = stem.encode("ascii", "ignore").decode().strip(" ._-")
    ascii_ext = ext if ext.isascii() and ext.strip() else "zip"
    if not ascii_stem:
        ascii_fallback = "comic." + ascii_ext
    else:
        ascii_fallback = ascii_stem + "." + ascii_ext
    encoded = quote(filename, safe="")
    return 'attachment; filename="' + ascii_fallback + '"; filename*=UTF-8\'\'' + encoded


def build_zip(pages, album_title="", archive_name="", lossless=True, mode="none"):
    """pages: iterable of (index, name, raw_bytes, pil_image, restored)."""
    buffer = io.BytesIO()
    folder = safe_name(archive_name or album_title, "comic")
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_STORED) as zf:
        for idx, name, raw, image, restored in pages:
            stem = safe_name(str(name).rsplit(".", 1)[0], str(idx))
            entry = "{}/{:04d}_{}.webp".format(folder, idx, stem)
            if lossless and not restored:
                zf.writestr(entry, raw)
            elif lossless and restored:
                zf.writestr(entry, thumbs.recompress(image, "none"))
            else:
                zf.writestr(entry, thumbs.recompress(image, mode))
    buffer.seek(0)
    return buffer

