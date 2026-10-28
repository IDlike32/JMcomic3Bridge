"""JM APP protocol: request signing and response decryption.

Mirrors the Android client (JMComic3 2.1.12).
"""
from __future__ import annotations

import base64
import hashlib
import json
import time
from typing import Any

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

APP_TOKEN = "185Hcomic3PAPP7R"
APP_VERSION = "2.1.12"
KEY_FALLBACK = "18comicAPPContent"

PATHS = {
    "setting": "setting",
    "promote": "promote",
    "promote_list": "promote_list",
    "latest": "latest",
    "serialization": "serialization",
    "search": "search",
    "hot_tags": "hot_tags",
    "album": "album",
    "comic_read": "comic_read",
    "categories": "categories",
    "categories_filter": "categories/filter",
    "week": "week",
    "week_filter": "week/filter",
}

AD_ENDPOINTS = ("ad_content_all", "advertise_all")


def md5_hex(text: str) -> str:
    return hashlib.md5(text.encode("utf-8")).hexdigest()


def build_auth(now: int | None = None):
    ts = int(time.time()) if now is None else int(now)
    token = md5_hex(str(ts) + APP_TOKEN)
    return {"Tokenparam": "{},{}".format(ts, APP_VERSION), "Token": token}, ts


def _aes_ecb_decrypt(ciphertext_b64: str, key_utf8: str):
    try:
        raw = base64.b64decode(ciphertext_b64, validate=False)
    except Exception:
        return None
    if not raw:
        return None
    key = key_utf8.encode("utf-8")
    if len(key) != 32:
        return None
    try:
        dec = Cipher(algorithms.AES(key), modes.ECB()).decryptor()
        out = dec.update(raw) + dec.finalize()
    except Exception:
        return None
    pad = out[-1] if out else 0
    if 1 <= pad <= 16 and out.endswith(bytes([pad]) * pad):
        out = out[:-pad]
    return out


def decrypt_payload(blob: Any, url: str, ts: int) -> Any:
    if not isinstance(blob, str) or not blob:
        return None
    is_ad = any(term in url for term in AD_ENDPOINTS)
    candidates = []
    for content in (APP_TOKEN, KEY_FALLBACK):
        candidates.append(md5_hex(content) if is_ad else md5_hex(str(ts) + content))
    for key in candidates:
        plain = _aes_ecb_decrypt(blob, key)
        if not plain:
            continue
        try:
            return json.loads(plain.decode("utf-8"))
        except Exception:
            continue
    return None


def decrypt_host_list(ciphertext: str):
    plain = _aes_ecb_decrypt(ciphertext.strip(), md5_hex("diosfjckwpqpdfjkvnqQjsik"))
    if not plain:
        return None
    try:
        return json.loads(plain.decode("utf-8"))
    except Exception:
        return None
