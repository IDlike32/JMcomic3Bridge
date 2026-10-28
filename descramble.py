"""Vertical block-reversal used by the JM reader.

Port of utils/Function.js -> scramble_image() / get_num() from the Android client.
The reader skips restoring pages when aid < scramble_id (older albums are clean).
"""
from __future__ import annotations

import hashlib
from urllib.parse import unquote, urlsplit

# Bump this whenever the restore algorithm (or its key) changes. It is part of the
# page cache key, so a fix automatically invalidates pages cached by the old logic.
DESC_VERSION = "5"

BUCKET_RANGE_10 = (268850, 421925)
BUCKET_MIN_8 = 421926

NUM_TABLE = {0: 2, 1: 4, 2: 6, 3: 8, 4: 10, 5: 12, 6: 14, 7: 16, 8: 18, 9: 20}


def page_stem(value) -> str:
    """Return the exact basename stem used by the official reader hash."""
    text = unquote(str(value or ""))
    path = urlsplit(text).path
    name = path.rsplit("/", 1)[-1]
    return name.rsplit(".", 1)[0] if "." in name else name


def get_num(aid, page) -> int:
    aid_s = str(aid)
    page_s = str(page)
    digest = hashlib.md5((aid_s + page_s).encode("utf-8")).hexdigest()
    # This is the Android client's literal rule: JavaScript charCodeAt/ord,
    # not numeric parsing of the hexadecimal nibble.
    key = ord(digest[-1])

    aid_int = int(aid_s)
    if BUCKET_RANGE_10[0] <= aid_int <= BUCKET_RANGE_10[1]:
        key %= 10
    elif aid_int >= BUCKET_MIN_8:
        key %= 8

    return NUM_TABLE.get(key % 10, 10)


def is_scrambled(aid, scramble_id) -> bool:
    if scramble_id in (None, "", 0, "0"):
        return False
    try:
        return int(aid) >= int(scramble_id)
    except (TypeError, ValueError):
        return False


def unscramble(img, aid, scramble_id, page):
    """Return a vertically restored copy of a PIL Image."""
    from PIL import Image

    if not is_scrambled(aid, scramble_id):
        return img

    num = get_num(aid, page)
    if num <= 1:
        return img

    if img.mode not in ("RGB", "RGBA", "L"):
        img = img.convert("RGB")

    w, h = img.size
    base = h // num
    remainder = h % num
    if base <= 0:
        return img

    out = Image.new(img.mode, (w, h))
    for i in range(num):
        copy_h = base
        py = base * i
        y = h - base * (i + 1) - remainder

        if i == 0:
            copy_h += remainder
        else:
            py += remainder

        top = max(0, y)
        bottom = min(y + copy_h, h)
        if bottom <= top:
            continue
        block = img.crop((0, top, w, bottom))
        out.paste(block, (0, py))
    return out
