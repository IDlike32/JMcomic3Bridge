"""HTTP client for the JM APP API, with automatic line failover."""
from __future__ import annotations

import threading
import time
from typing import Any
from urllib.parse import urlencode

import httpx

from protocol import PATHS, build_auth, decrypt_payload

UA = (
    "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
)

DEFAULT_TIMEOUT = 20.0

# A single metadata request may try up to four lines, so a dead network could hold one
# worker thread for over a minute. These bound the damage: a request gives up after the
# budget, and only a few may be in their upstream wait at the same time. Everything else
# fails fast instead of queueing, which is what used to freeze the whole app.
REQUEST_BUDGET = 12.0
MAX_UPSTREAM = 12

_upstream_slots = threading.BoundedSemaphore(MAX_UPSTREAM)

# Metadata calls used module-level httpx.get/post, which builds a throwaway client for
# every request: a fresh DNS lookup, TCP connect and TLS handshake each time. Under a
# page load that turned into a handshake storm and surfaced as
# "_ssl.c:1018: The handshake operation timed out". One pooled client per host keeps the
# connection alive between calls; connecting still has its own short timeout so a dead
# line fails over quickly instead of eating the whole request budget.
_http_client = None
_http_lock = threading.Lock()
CONNECT_TIMEOUT = 5.0


def _http() -> httpx.Client:
    global _http_client
    with _http_lock:
        if _http_client is None:
            _http_client = httpx.Client(
                http2=False,
                timeout=httpx.Timeout(DEFAULT_TIMEOUT, connect=CONNECT_TIMEOUT),
                follow_redirects=True,
                limits=httpx.Limits(max_connections=32, max_keepalive_connections=16,
                                    keepalive_expiry=30.0),
                headers={"User-Agent": UA, "Accept": "*/*"},
            )
        return _http_client


class JMError(RuntimeError):
    pass


class JMBusy(JMError):
    """The upstream budget is exhausted; the caller should answer 503, not wait."""


class JMClient:
    def __init__(self, pool, host: str | None = None, settings=None, fetch_bytes=None):
        self.pool = pool
        self.host = host
        self.settings = settings
        # Injected by the service: one pooled HTTP client for all CDN image traffic.
        # Left None, every call pays its own TCP+TLS handshake.
        self._fetch_bytes = fetch_bytes

    # ---------- low level ----------
    def _build_url(self, line, endpoint: str, params: dict) -> tuple[str, str]:
        path = PATHS.get(endpoint, endpoint)
        query = dict(params or {})
        lang = query.get("lang")
        if not lang and self.settings is not None:
            lang = self.settings.get("lang")
        if not lang:
            lang = "TW"
        query["lang"] = lang
        url = "https://{}/{}?{}".format(line.host, path, urlencode(query))
        return url, path

    def _request_once(self, line, endpoint: str, params: dict, method: str, form,
                      timeout: float = DEFAULT_TIMEOUT) -> dict:
        # Keep the connect deadline short even when the caller's remaining budget is
        # large: a line that cannot complete a handshake in CONNECT_TIMEOUT is dead, and
        # the next line deserves the remaining time instead.
        read_timeout = min(DEFAULT_TIMEOUT, timeout)
        request_timeout = httpx.Timeout(read_timeout, connect=min(CONNECT_TIMEOUT, read_timeout))
        url, _path = self._build_url(line, endpoint, params)
        headers, ts = build_auth()
        headers["User-Agent"] = UA
        headers["Accept"] = "*/*"

        self.pool.acquire(line)
        ok = False
        try:
            if method.upper() == "POST":
                resp = _http().post(url, headers=headers, data=form or {},
                                    timeout=request_timeout)
            else:
                resp = _http().get(url, headers=headers, timeout=request_timeout)
            if resp.status_code != 200:
                raise JMError("HTTP {} for {}".format(resp.status_code, url))
            body = resp.json()
            ok = True
        finally:
            self.pool.release(line, ok)

        if not isinstance(body, dict):
            raise JMError("unexpected payload shape")

        payload = decrypt_payload(body.get("data"), url, ts)
        code = body.get("code")
        if code != 200:
            raise JMError("api code {} for {}".format(code, url))

        if payload is None and body.get("data"):
            raise JMError("decrypt failed for {}".format(url))

        return {"code": code, "data": payload, "url": url, "ts": ts, "host": line.host}

    # ---------- public ----------
    def request(self, endpoint: str, params: dict | None = None, method: str = "GET", form=None, ts_override=None) -> dict:
        pinned = self.host
        if pinned is None and self.settings is not None:
            pinned = self.settings.get("pinned_host") or None

        if not _upstream_slots.acquire(blocking=False):
            raise JMBusy("upstream busy")

        tried = set()
        last_error = None
        deadline = time.monotonic() + REQUEST_BUDGET
        try:
            for _ in range(4):
                remaining = deadline - time.monotonic()
                if remaining <= 0.5:
                    break
                line = self.pool.pick(pinned if pinned and pinned not in tried else None)
                if line.host in tried and len(tried) >= 3:
                    break
                tried.add(line.host)
                try:
                    return self._request_once(line, endpoint, params or {}, method, form,
                                              timeout=min(DEFAULT_TIMEOUT, remaining))
                except Exception as exc:
                    last_error = exc
                    if pinned and line.host == pinned:
                        pinned = None  # fall back to aggregation
                    continue
        finally:
            _upstream_slots.release()
        raise JMError(str(last_error) if last_error else "request failed")

    def get(self, endpoint: str, params: dict | None = None) -> Any:
        return self.request(endpoint, params).get("data")

    def post(self, endpoint: str, form: dict | None = None, params: dict | None = None) -> Any:
        return self.request(endpoint, params, method="POST", form=form).get("data")

    # ---------- image ----------
    def image_bytes(self, url: str) -> bytes:
        """Fetch an image, honouring the line that owns the img_host when possible."""
        if self._fetch_bytes is not None:
            return self._fetch_bytes(url)

        headers = {"User-Agent": UA, "Accept": "image/*, */*"}
        errors = []
        for _ in range(3):
            try:
                line = self.pool.pick_image_line()
                self.pool.acquire(line)
                try:
                    resp = _http().get(url, headers=headers, timeout=DEFAULT_TIMEOUT)
                    if resp.status_code == 200 and resp.content:
                        return resp.content
                    errors.append("HTTP {}".format(resp.status_code))
                finally:
                    self.pool.release(line, True)
            except Exception as exc:
                errors.append(str(exc))
                continue
        raise JMError("image fetch failed: {}".format(errors[-1] if errors else "unknown"))
