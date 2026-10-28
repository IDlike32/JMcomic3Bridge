"""JMBridge FastAPI service."""
from __future__ import annotations

import asyncio
import io
import json
import threading
import time
from urllib.parse import quote
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
import httpx
from PIL import Image

import archive
import thumbs
from cache import Cache
from client import JMClient, JMBusy, JMError
from config import COMPRESSION_MODES, Settings
from covers import CoverQueue
from descramble import DESC_VERSION, is_scrambled, page_stem, unscramble
from hosts import LinePool
from hub import Hub
from library import Library

settings = Settings()
pool = LinePool(max_active=int(settings.get("active_lines") or 3))
cache = Cache(settings)
library = Library(settings.data_dir)
cache.eviction_context = library.cache_eviction_context
hub = Hub()
app = FastAPI(title="JMBridge", version="1.0.0")
_zip_jobs = {}
_zip_jobs_lock = threading.Lock()


def _zip_job_snapshot(job):
    return {key: value for key, value in job.items() if key != "data"}


def _run_zip_job(job_id, cid, title):
    try:
        meta = cache.get_json("search", "read|{}".format(cid)) or {}
        name = title or meta.get("name") or cid
        pages = _page_urls(meta)
        with _zip_jobs_lock:
            job = _zip_jobs[job_id]
            job.update({"total": len(pages), "state": "downloading"})
        collected = []
        for page in _collect_pages(cid, lossless=True, compression="none"):
            collected.append(page)
            with _zip_jobs_lock:
                job["done"] = len(collected)
                job["progress"] = round(len(collected) / len(pages), 4) if pages else 0
        if not collected:
            raise RuntimeError("没有下载到可用页面")
        with _zip_jobs_lock:
            _zip_jobs[job_id]["state"] = "packing"
        buf = archive.build_zip(collected, album_title=name, archive_name=name, lossless=True)
        data = buf.getvalue()
        cache.put_bytes("zip", "{}|download".format(cid), data,
                        {"kind": "download", "cid": cid, "title": name, "pages": len(collected)})
        with _zip_jobs_lock:
            _zip_jobs[job_id].update({"state": "done", "progress": 1.0,
                                      "done": len(collected), "data": data,
                                      "filename": archive.safe_name(name, cid) + ".zip"})
    except Exception as exc:
        with _zip_jobs_lock:
            if job_id in _zip_jobs:
                _zip_jobs[job_id].update({"state": "failed", "error": str(exc) or "打包失败"})


@app.exception_handler(JMBusy)
async def _upstream_busy(request: Request, exc: JMBusy):
    """Too many upstream calls in flight: answer now, let the client come back.

    Waiting here is what turned a slow network into a frozen app -- every worker thread
    ended up parked on the same dead endpoint.
    """
    return JSONResponse({"ok": False, "error": "upstream busy"}, status_code=503,
                        headers={"Retry-After": "2"})


@app.exception_handler(JMError)
async def _upstream_failed(request: Request, exc: JMError):
    """A dead or slow JM line is a gateway problem, not a bug in this app.

    An unhandled JMError surfaced as a 500 with a traceback, which told the browser to
    give up and told us nothing; 502 with a short message lets the UI show its retry.
    """
    return JSONResponse({"ok": False, "error": str(exc) or "upstream failed"},
                        status_code=502, headers={"Retry-After": "2"})


def _client() -> JMClient:
    # _fetch_bytes and _cdn are defined later in the module; resolve them at call time.
    return JMClient(pool, settings=settings, fetch_bytes=_fetch_bytes)


from tasks import CDNLimiter, PAGE_ATTEMPTS, TaskManager  # noqa: E402  (needs the singletons above)

cdn_limiter = CDNLimiter(12)
tasks = TaskManager(
    cache=cache,
    limiter=cdn_limiter,
    settings=settings,
    pool=pool,
    client_factory=_client,
    concurrency=12,
    hub=hub,
)

# Covers are fetched here, never inside a request: a request only reads the cache or
# records a want, so opening a grid costs one status call instead of thirty CDN calls.
covers = CoverQueue(cache, pool, lambda url, timeout=15.0, attempts=2: _fetch_bytes(url, timeout, attempts),
                    hub, workers=4, limiter=cdn_limiter)


@app.middleware("http")
async def _revalidate_static(request: Request, call_next):
    """Keep the app entry and its modules fresh for local in-place updates."""
    response = await call_next(request)
    if request.url.path == "/" or request.url.path.endswith((".js", ".css", ".html")):
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
    return response

SEARCH_TTL = 24 * 3600


def _ok(data=None, **extra):
    payload = {"ok": True, "data": data}
    payload.update(extra)
    return JSONResponse(payload)


def _fail(status_code, code, reason, attempts=0, max_attempts=0, exhausted=False, **extra):
    """One shape for "this piece of content could not be fetched".

    Images are consumed by <img>, which cannot read a body, so the same facts also ride
    on headers -- that is how a plain <img> tile can still tell the user why.
    """
    payload = {
        "ok": False,
        "error": {
            "code": code,
            "reason": reason,
            "attempts": int(attempts),
            "max_attempts": int(max_attempts),
            "exhausted": bool(exhausted),
        },
    }
    payload.update(extra)
    return JSONResponse(payload, status_code=status_code, headers={
        "Cache-Control": "no-store",
        "X-Fail-Code": str(code),
        # Header values are latin-1: percent-encode so a Chinese reason survives.
        "X-Fail-Reason": quote(str(reason)[:180], safe=""),
        "X-Attempts": str(int(attempts)),
        "X-Max-Attempts": str(int(max_attempts)),
        "Retry-After": "2",
    })


@app.on_event("startup")
async def _startup():
    def warm():
        try:
            pool.discover()
            pool.probe_all(limit=int(settings.get("active_lines") or 3))
        except Exception:
            pass

    asyncio.get_running_loop().run_in_executor(None, warm)


# ------------------------------------------------------------------ meta

@app.get("/api/health")
def health():
    return _ok({"version": "1.0.0", "lines": pool.snapshot(), "cache": cache.stats()})


@app.get("/api/lines")
def lines():
    return _ok(pool.snapshot())


@app.post("/api/lines/discover")
def lines_discover():
    pool.discover(force=True)
    return _ok(pool.probe_all(limit=int(settings.get("active_lines") or 3)) and pool.snapshot())


@app.post("/api/lines/probe")
def lines_probe():
    pool.probe_all(limit=8)
    return _ok(pool.snapshot())


@app.get("/api/settings")
def get_settings():
    return _ok({"settings": settings.as_dict(), "compression_modes": COMPRESSION_MODES})


@app.post("/api/settings")
async def set_settings(request: Request):
    patch = await request.json()
    updated = settings.update(patch or {})
    if "active_lines" in (patch or {}):
        pool.max_active = max(1, min(3, int(updated.get("active_lines") or 3)))
    return _ok(updated)


# ------------------------------------------------------------------ recommend

@app.get("/api/recommend")
def recommend():
    cached = cache.get_json("search", "recommend:v1")
    if cached:
        return _ok(cached, cached=True)
    client = _client()
    out = {"promote": [], "latest": []}
    try:
        out["promote"] = client.get("promote") or []
    except JMError:
        out["promote"] = []
    try:
        latest = client.get("latest", {"page": "1"})
        out["latest"] = (latest.get("list") if isinstance(latest, dict) else latest) or []
    except JMError:
        out["latest"] = []
    cache.put_json("search", "recommend:v1", out, {"kind": "recommend"})
    return _ok(out, cached=False)


@app.get("/api/promote/list")
def promote_list(id: str = Query(""), page: int = Query(1)):
    data = _client().get("promote_list", {"id": id, "page": page})
    return _ok(data)


# ------------------------------------------------------------------ search

def _search_fetch(query: str, page: int, order: str) -> dict:
    params = {"search_query": query, "page": page, "o": order}
    data = _client().get("search", params)
    if isinstance(data, list):
        list_items = data
        total = len(data)
    elif isinstance(data, dict):
        list_items = data.get("content") or data.get("list") or []
        total = int(data.get("total") or 0)
    else:
        list_items, total = [], 0
    return {"query": query, "page": page, "order": order, "items": list_items, "total": total,
            "fetched_at": time.time()}


@app.get("/api/search")
def search(q: str = Query(..., min_length=1), page: int = Query(1), o: str = Query("mr"),
           refresh: bool = Query(False)):
    key = "{}|{}|{}|{}".format(q, page, o, settings.get("lang"))
    if not refresh:
        hit = cache.get_json("search", key)
        if hit:
            return _ok(hit, cached=True)
    result = _search_fetch(q, page, o)
    cache.put_json("search", key, result, {"kind": "search", "q": q, "page": page})
    return _ok(result, cached=False)


def _sse(event: str, data) -> str:
    return "event: {}\ndata: {}\n\n".format(event, json.dumps(data, ensure_ascii=False))


@app.get("/api/search/stream")
async def search_stream(q: str = Query(..., min_length=1), o: str = Query("mr"),
                        pages: int = Query(6), full: bool = Query(False)):
    """Stream results page by page so the UI can render as data arrives."""

    async def gen():
        loop = asyncio.get_running_loop()
        emitted = set()
        page = 1
        empty_streak = 0
        yield _sse("start", {"query": q, "order": o})
        while True:
            if not full and page > pages:
                break
            key = "{}|{}|{}|{}".format(q, page, o, settings.get("lang"))
            cached = cache.get_json("search", key)
            if cached:
                result = cached
            else:
                try:
                    result = await loop.run_in_executor(None, _search_fetch, q, page, o)
                except Exception as exc:
                    yield _sse("error", {"page": page, "message": str(exc)})
                    break
                cache.put_json("search", key, result, {"kind": "search", "q": q, "page": page})

            items = [it for it in result.get("items", []) if it.get("id") not in emitted]
            for it in items:
                emitted.add(it.get("id"))
            yield _sse("page", {"page": page, "items": items, "total": result.get("total", 0),
                                "unique": len(emitted), "cached": bool(cached)})

            if not items:
                empty_streak += 1
                if empty_streak >= 1:
                    break
            else:
                empty_streak = 0
            page += 1

        yield _sse("done", {"query": q, "pages": page - 1, "unique": len(emitted)})

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/search/full")
def search_full(q: str = Query(..., min_length=1), o: str = Query("mr"),
                max_pages: int = Query(0), refresh: bool = Query(False)):
    """Full-result search, persisted to the search cache."""
    key = "full|{}|{}|{}".format(q, o, settings.get("lang"))
    if not refresh:
        hit = cache.get_json("search", key)
        if hit:
            return _ok(hit, cached=True)

    seen, items, page = set(), [], 1
    while True:
        if max_pages and page > max_pages:
            break
        page_key = "{}|{}|{}|{}".format(q, page, o, settings.get("lang"))
        result = None if refresh else cache.get_json("search", page_key)
        if not result:
            try:
                result = _search_fetch(q, page, o)
            except Exception:
                break
            cache.put_json("search", page_key, result, {"kind": "search", "q": q, "page": page})
        fresh = 0
        for it in result.get("items", []):
            if it.get("id") not in seen:
                seen.add(it.get("id"))
                items.append(it)
                fresh += 1
        total = result.get("total") or 0
        if fresh == 0:
            break
        if total and len(items) >= total:
            break
        if not result.get("items"):
            break
        page += 1
        if page > 400:
            break

    payload = {"query": q, "order": o, "items": items, "pages": page, "total": len(items),
               "fetched_at": time.time()}
    cache.put_json("search", key, payload, {"kind": "search", "q": q, "full": True})
    return _ok(payload, cached=False)


# ------------------------------------------------------------------ album / read

def _album_cache_key(aid: str) -> str:
    return "album|{}".format(aid)


@app.get("/api/album/{aid}")
def album(aid: str, refresh: bool = Query(False)):
    key = _album_cache_key(aid)
    if not refresh:
        hit = cache.get_json("search", key)
        if hit:
            return _ok(hit, cached=True)
    data = _client().get("album", {"id": aid})
    # Novels and other non-comic works answer with a null payload: there is no page
    # list to show, so name the limitation instead of failing on data.get().
    if not isinstance(data, dict):
        raise HTTPException(status_code=415, detail="unsupported_type:novel")
    cache.put_json("search", key, data, {"kind": "album", "aid": aid, "title": data.get("name", "")})
    return _ok(data, cached=False)


@app.get("/api/read/{cid}")
def read(cid: str, express: str = Query(""), refresh: bool = Query(False)):
    key = "read|{}".format(cid)
    if not refresh:
        hit = cache.get_json("search", key)
        if hit:
            return _ok(hit, cached=True)
    data = _client().get("comic_read", {"id": cid, "express": express} if express else {"id": cid})
    # A novel chapter has no image list; the reader cannot render it.
    if not isinstance(data, dict) or not _page_urls(data):
        raise HTTPException(status_code=415, detail="unsupported_type:novel")
    cache.put_json("search", key, data, {"kind": "read", "cid": cid})
    return _ok(data, cached=False)


def _series_aid(read_payload: dict, explicit: str = "") -> str:
    """The album a chapter belongs to. `"0"` is the API's way of saying "none"."""
    for candidate in (explicit, read_payload.get("series_id"), read_payload.get("id")):
        text = str(candidate or "").strip()
        if text and text != "0":
            return text
    return ""


def _page_urls(read_payload: dict) -> list:
    images = read_payload.get("images") or []
    urls = []
    for idx, entry in enumerate(images, start=1):
        if isinstance(entry, str):
            urls.append({"page": idx, "url": entry})
        elif isinstance(entry, dict):
            urls.append({"page": entry.get("page") or idx, "url": entry.get("image") or ""})
    return [u for u in urls if u["url"]]


def _page_key(cid: str, index: int, compression: str) -> str:
    # Mode separates quality tiers; DESC_VERSION makes an algorithm fix invalidate
    # pages that were restored by the old logic.
    return "{}|{}|{}|v{}".format(cid, index, compression, DESC_VERSION)


# ------------------------------------------------------------------ progressive streaming
#
# Two different problems, two different answers:
#
#   * Covers are JPEG. A truncated JPEG still decodes: you get the rows that arrived,
#     which is exactly the "fills in from the top" effect we want, so the cover stream is
#     decoded every time another slice of the file lands.
#   * Page images are WebP. Pillow refuses to decode a partial VP8 bitstream at all
#     ("could not create decoder object"), so a page cannot be painted from half a file.
#     What we can do is report the CDN download honestly (progress frames) and then emit
#     the quality ladder one frame at a time, smallest first.
#
# Frame wire format (fixed 25-byte header):
#
#   magic "JMPG1"(5) | kind(8, NUL padded) | width(4 BE) | height(4 BE) | length(4 BE) | payload
#
# kinds: meta (JSON dims/total) | pr (JSON progress) | p1..p3 (JPEG frames) | err

PROG_STEPS = (
    ("p1", 360, 40),
    ("p2", 780, 62),
    ("p3", 0, 80),  # width 0 = keep the source size
)

PROG_MAGIC = b"JMPG2"
# magic(5) + asset(4) + kind(8) + width(4) + height(4) + length(4)
PROG_HEADER = 5 + 4 + 8 + 4 + 4 + 4

UA_IMAGE = ("Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36")


def _prog_key(cid: str, index: int, compression: str) -> str:
    return "{}|{}|{}|v{}".format(cid, index, compression, DESC_VERSION)


def _frame(kind: str, width: int, height: int, payload: bytes,
           asset: int = 0) -> bytes:
    """One frame. `asset` lets a single response carry several images (a grid of covers)."""
    return b"".join((
        PROG_MAGIC,
        int(asset).to_bytes(4, "big"),
        kind.encode("ascii").ljust(8, b"\0"),
        int(width).to_bytes(4, "big"),
        int(height).to_bytes(4, "big"),
        len(payload).to_bytes(4, "big"),
        payload,
    ))


def _json_frame(kind: str, obj: dict, asset: int = 0) -> bytes:
    return _frame(kind, 0, 0, json.dumps(obj, ensure_ascii=False).encode("utf-8"), asset)


def _encode_jpeg(img, quality: int, max_width: int = 0) -> bytes:
    step = img
    if max_width and img.width > max_width:
        ratio = max_width / img.width
        step = img.resize((max_width, max(1, int(img.height * ratio))), Image.LANCZOS)
    if step.mode not in ("RGB", "L"):
        step = step.convert("RGB")
    buf = io.BytesIO()
    step.save(buf, format="JPEG", quality=quality, optimize=False,
              subsampling=2 if quality < 60 else 0)
    return buf.getvalue()


_cdn_client = None
_cdn_lock = threading.Lock()



def _cdn() -> httpx.Client:
    """Client for CDN image traffic, on short-lived connections.

    HTTP/2 multiplexing put every concurrent fetch onto one TCP connection. When the CDN
    silently dropped that connection, every stream riding it hung until the read timeout,
    and a burst of page loads looked exactly like a frozen app. HTTP/1.1 with a 15s
    keep-alive expiry only reuses a connection while it is provably fresh, and each
    request is bounded by its own read timeout instead of a shared stream.
    """
    global _cdn_client
    with _cdn_lock:
        if _cdn_client is None:
            _cdn_client = httpx.Client(
                http2=False,
                timeout=httpx.Timeout(20.0, connect=8.0, read=15.0),
                follow_redirects=True,
                limits=httpx.Limits(max_keepalive_connections=24, max_connections=48,
                                    keepalive_expiry=15.0),
                headers={"User-Agent": UA_IMAGE, "Accept": "image/*, */*"},
            )
        return _cdn_client


def _fetch_bytes(url: str, timeout: float = 30.0, attempts: int = 3) -> bytes:
    """Fetch a whole image, rotating image hosts and refreshing dead connections.

    Image host settings can differ between API lines. Retry against each configured
    image host instead of repeating the same failing URL and report non-image 200 bodies
    as such rather than mislabeling them as HTTP errors.
    """
    from urllib.parse import urlsplit, urlunsplit

    parsed = urlsplit(url)
    path = urlunsplit(("", "", parsed.path, parsed.query, ""))
    hosts = []
    for line in pool.active_lines():
        host = (line.img_host or "").rstrip("/")
        if host and host not in hosts:
            hosts.append(host)
    initial = urlunsplit((parsed.scheme, parsed.netloc, parsed.path, parsed.query, ""))
    urls = [initial] + [host + path for host in hosts if host != parsed.netloc]
    last = "no attempt"
    total = max(1, attempts)
    for attempt in range(total):
        target = urls[attempt % len(urls)]
        headers = {"Connection": "close"} if attempt else None
        try:
            response = _cdn().get(target, timeout=timeout, headers=headers)
            if response.status_code == 200 and response.content:
                body = response.content
                content_type = (response.headers.get("content-type") or "").lower()
                looks_image = (body[:3] == b"\xff\xd8\xff" or
                                body[:8] == b"\x89PNG\r\n\x1a\n" or
                                body[:6] in (b"GIF87a", b"GIF89a") or
                                (body[:4] == b"RIFF" and body[8:12] == b"WEBP"))
                if looks_image or content_type.startswith("image/"):
                    return body
                last = "HTTP 200 non-image response"
            elif response.status_code == 200:
                last = "HTTP 200 empty response"
            else:
                last = "HTTP %s" % response.status_code
        except Exception as exc:
            last = "%s: %s" % (type(exc).__name__, exc)
        time.sleep(0.2 * (attempt + 1))
    raise RuntimeError(last)


def _ladder(source: bytes):
    """Yield the quality ladder one frame at a time, smallest first.

    A generator on purpose: the reader can paint p1 while p2 and p3 are still being
    encoded, instead of waiting for the whole ladder.
    """
    img = thumbs._open(source)
    for kind, width, quality in PROG_STEPS:
        step_width = min(width, img.width) if width else img.width
        step_height = max(1, int(img.height * (step_width / img.width)))
        yield _frame(kind, step_width, step_height, _encode_jpeg(img, quality, width))


def _page_source(cid: str, index: int, aid: str, scramble_id, compression: str):
    """Locate a page: (url, album_aid, scramble_id, cache_key) or None."""
    read_payload = cache.get_json("search", "read|{}".format(cid))
    if read_payload is None:
        read_payload = _client().get("comic_read", {"id": cid})
        cache.put_json("search", "read|{}".format(cid), read_payload, {"kind": "read", "cid": cid})
    target = next((p for p in _page_urls(read_payload) if int(p["page"]) == index), None)
    if target is None:
        return None
    decode_aid = str(read_payload.get("id") or cid)
    scramble = scramble_id if scramble_id != "" else read_payload.get("scramble_id")
    return {
        "url": target["url"],
        "album_aid": decode_aid,
        "scramble_id": scramble,
        "name": target["url"].rsplit("/", 1)[-1].rsplit(".", 1)[0],
        "key": _page_key(cid, index, compression),
    }


@app.get("/api/prog/{cid}/{index}")
def progressive_page(cid: str, index: int, aid: str = Query(""), scramble: str = Query(""),
                     mode: str = Query("")):
    """Page image: CDN progress first, then the quality ladder frame by frame."""
    compression = mode or settings.get("cache_compression") or "minimal"
    key = _prog_key(cid, index, compression)
    cached = cache.get_bytes("prog", key)

    def gen():
        if cached:
            yield cached
            return

        # Cache only: the frame ladder is re-encoded from the stored page, and a page
        # that is not stored yet is reported instead of being downloaded here. This
        # route is a pure reader; fetching lives in the cache task.
        info = _page_source(cid, index, aid, scramble, compression)
        if info is None:
            yield _frame("err", 0, 0, b"page out of range")
            return

        source = cache.get_bytes("pages", info["key"])
        if source is None:
            yield _frame("err", 0, 0, b"page not cached yet")
            return

        yield _json_frame("pr", {"r": 1, "t": 1, "p": 1})
        parts = []
        for frame in _ladder(source):
            parts.append(frame)
            yield frame
        cache.put_bytes("prog", key, b"".join(parts),
                        {"kind": "prog", "cid": cid, "index": index})

    return StreamingResponse(gen(), media_type="application/octet-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no",
                                      "X-Prog": "hit" if cached else "miss"})


# ------------------------------------------------------------------ cover serving
#
# Cache-first, and the request does no network work at all. A miss records a want and
# answers 503 immediately; covers.py fetches it in the background and publishes an event,
# so the tile gets its bytes on the next attempt without ever waiting on the CDN inside a
# request. That is what keeps a grid of thirty tiles from becoming thirty racing downloads
# (and what used to starve the thread pool until the whole app stopped answering).

@app.get("/api/progcover/{aid}")
def progressive_cover(aid: str, size: int = Query(360)):
    """Cover, cache-first: stored bytes now, otherwise ask the queue and answer 503.

    This route is the hot one -- every tile in every grid hits it -- so it does no network
    work at all. A miss records a want (the queue fetches it in the background) and answers
    503 with a short Retry-After. The tile listens on the event stream, so it usually gets
    its image on the first retry, and a burst of thirty tiles costs thirty cheap local
    lookups instead of thirty racing CDN downloads.
    """
    size = max(0, min(int(size or 0), 900))
    body = covers.read(aid, size)
    if body is not None:
        return Response(body, media_type=_sniff_image_type(body),
                        headers={"Cache-Control": "no-cache", "X-Cache": "HIT"})

    covers.want(aid, size)
    failure = covers.failure(aid, size)
    if failure and failure.get("exhausted"):
        return _fail(502, failure["code"],
                     "无法获取封面图：{}（已重试 {} 次）".format(failure["reason"], failure["attempts"]),
                     attempts=failure["attempts"], max_attempts=failure["max_attempts"],
                     exhausted=True, aid=aid, size=size)
    return Response(b"cover not ready", status_code=503, media_type="text/plain",
                    headers={"Retry-After": "1", "X-Cache": "MISS",
                             "X-Attempts": str((failure or {}).get("attempts", 0)),
                             "Cache-Control": "no-store"})


@app.get("/api/cover/{aid}")
def cover_raw(aid: str, size: int = Query(360)):
    """The cover as the CDN serves it, byte for byte (plain <img> consumers).

    Same rule as /api/progcover: cache or 503. The detail page hero retries on its own.
    """
    size = max(0, min(int(size or 0), 900))
    body = covers.read(aid, size)
    if body is not None:
        return Response(body, media_type=_sniff_image_type(body),
                        headers={"X-Cache": "HIT",
                                 "Cache-Control": "public, max-age=86400"})

    covers.want(aid, size)
    failure = covers.failure(aid, size)
    if failure and failure.get("exhausted"):
        return _fail(502, failure["code"],
                     "无法获取封面图：{}（已重试 {} 次）".format(failure["reason"], failure["attempts"]),
                     attempts=failure["attempts"], max_attempts=failure["max_attempts"],
                     exhausted=True, aid=aid, size=size)
    return Response(b"cover not ready", status_code=503, media_type="text/plain",
                    headers={"Retry-After": "1", "X-Cache": "MISS",
                             "X-Attempts": str((failure or {}).get("attempts", 0)),
                             "Cache-Control": "no-store"})


@app.post("/api/covers/retry")
async def cover_retry(request: Request):
    """Re-queue covers whose retry budget was spent, so a user retry is not a no-op."""
    body = await request.json()
    size = max(0, min(int(body.get("size") or 360), 900))
    aids = [str(a) for a in (body.get("aids") or []) if str(a).strip()]
    return _ok({"queued": covers.retry_failed(aids, size), "stats": covers.stats()})


@app.get("/api/covers/status")
def cover_status(aids: str = Query(""), size: int = Query(360)):
    """Which of these covers are already stored (one call for a whole grid)."""
    size = max(0, min(int(size or 0), 900))
    wanted = [a.strip() for a in (aids or "").split(",") if a.strip()]
    ready = covers.status(wanted, size)
    # Only failing covers carry detail: a healthy grid stays a tiny payload.
    failed = {}
    for aid in wanted:
        info = covers.failure(aid, size)
        if info:
            failed[aid] = info
    return _ok({"size": size, "ready": ready, "failed": failed})


@app.post("/api/covers/want")
async def cover_want(request: Request):
    """Queue visible covers for fetching."""
    body = await request.json()
    size = max(0, min(int(body.get("size") or 360), 900))
    aids = [str(a) for a in (body.get("aids") or []) if str(a).strip()]
    return _ok({"queued": covers.want_many(aids, size), "stats": covers.stats()})


@app.post("/api/covers/warm")
async def cover_warm(request: Request):
    """Queue a bounded background prefetch without making the UI request images."""
    body = await request.json()
    size = max(0, min(int(body.get("size") or 360), 900))
    aids = [str(a) for a in (body.get("aids") or []) if str(a).strip()]
    return _ok({"queued": covers.want_many(aids, size), "stats": covers.stats()})


@app.get("/api/events")
async def events(request: Request):
    """One stream for everything the UI would otherwise poll.

    Events: page-stored (a reader page exists), cover-stored, task (state change). The
    client patches its own state from these, so nothing has to ask "is it ready yet?" at a
    fixed interval.
    """
    token, queue = hub.subscribe()

    async def stream():
        try:
            yield b": connected\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    payload = await asyncio.wait_for(queue.get(), timeout=15.0)
                except asyncio.TimeoutError:
                    yield b": ping\n\n"      # keep proxies from closing an idle stream
                    continue
                yield ("data: " + json.dumps(payload, ensure_ascii=False) + "\n\n").encode("utf-8")
        finally:
            hub.unsubscribe(token)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-store",
                                      "X-Accel-Buffering": "no",
                                      "Connection": "keep-alive"})


def _sniff_image_type(blob: bytes) -> str:
    if blob[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if blob[:4] == b"RIFF" and blob[8:12] == b"WEBP":
        return "image/webp"
    if blob[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if blob[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    return "application/octet-stream"


@app.get("/api/image/{cid}/{index}")
def image(cid: str, index: int, aid: str = Query(""), scramble: str = Query(""),
          mode: str = Query(""), thumb: int = Query(0)):
    # Images are addressed by a stable URL, so the browser must never store them:
    # a render produced by an older algorithm would otherwise be reused forever.
    no_store = {"Cache-Control": "no-store, max-age=0"}
    compression = mode or settings.get("cache_compression") or "minimal"
    if thumb:
        tkey = "{}|{}|{}".format(cid, index, thumb)
        hit = cache.get_bytes("thumb", tkey)
        if hit:
            return Response(hit, media_type="image/webp",
                            headers={"X-Cache": "HIT", **no_store})

    # The chapter's page list is cached by /api/read (the reader always loads it first).
    # Without it this route cannot even name the page, and it must not go to the network
    # to find out: that is the cache task's job.
    read_payload = cache.get_json("search", "read|{}".format(cid))
    if read_payload is None:
        return Response(b"chapter not loaded yet", status_code=503, media_type="text/plain",
                        headers={"Retry-After": "2", "X-Cache": "MISS", **no_store})

    pages = _page_urls(read_payload)
    target = next((p for p in pages if int(p["page"]) == index), None)
    if target is None:
        raise HTTPException(status_code=404, detail="page out of range")

    decode_aid = str(read_payload.get("id") or cid)
    scramble_id = scramble if scramble != "" else read_payload.get("scramble_id")
    name = page_stem(target["url"])

    # Read-only: this endpoint never pulls from the CDN.
    #
    # Every page request used to be a potential 60s CDN download holding one of the
    # shared worker threads, so a reader opening a chapter fired dozens of them at once
    # and starved the whole app -- /api/health and static files included. Fetching now
    # belongs to exactly one place (the cache task, bounded and retried there); this
    # endpoint only serves what that task already stored, and answers 503 while the
    # page is still on its way. The reader treats 503 as "retrying", not as an error.
    key = _page_key(cid, index, compression)
    data = cache.get_bytes("pages", key)
    hit = data is not None
    if data is None:
        prefix = "pages|{}|{}|".format(cid, index)
        for entry in cache.list_prefix("pages", "{}|{}|".format(cid, index)):
            candidate = entry.get("key", "")
            if candidate.startswith(prefix) and candidate.endswith("|v" + DESC_VERSION):
                data = cache.get_bytes("pages", candidate[len("pages|"):])
                if data is not None:
                    break
    if data is None:
        failure = None
        task = tasks.get(cid)
        if task is not None:
            for item in task.to_dict().get("pages", []):
                if int(item.get("page") or -1) == index:
                    failure = task.page_failure(int(item.get("index")))
                    break
        if failure:
            return _fail(502, failure["code"],
                         "无法获取第 {} 页图片：{}（已重试 {} 次）".format(
                             index, failure["reason"], failure["attempts"]),
                         attempts=failure["attempts"], max_attempts=failure["max_attempts"],
                         exhausted=failure["exhausted"], cid=cid, page=index)
        return Response(b"page not cached yet", status_code=503, media_type="text/plain",
                        headers={"Retry-After": "2", "X-Cache": "MISS", **no_store})

    if thumb:
        small = thumbs.make_thumb(data, thumb)
        cache.put_bytes("thumb", "{}|{}|{}".format(cid, index, thumb), small,
                        {"kind": "thumb", "cid": cid, "index": index})
        return Response(small, media_type="image/webp",
                        headers={"X-Cache": "MISS", **no_store})

    return Response(data, media_type="image/webp",
                    headers={"X-Cache": "HIT" if hit else "MISS", **no_store})


@app.get("/api/pages/stream/{cid}")
async def pages_stream(cid: str, aid: str = Query(""), scramble: str = Query(""),
                       mode: str = Query(""), start: int = Query(1), count: int = Query(4)):
    """Stream consecutive page images as multipart so the reader can append."""
    compression = mode or settings.get("cache_compression") or "minimal"
    loop = asyncio.get_running_loop()

    rkey = "read|{}".format(cid)
    read_payload = cache.get_json("search", rkey)
    if read_payload is None:
        read_payload = await loop.run_in_executor(None, lambda: _client().get("comic_read", {"id": cid}))
        cache.put_json("search", rkey, read_payload, {"kind": "read", "cid": cid})

    pages = _page_urls(read_payload)
    album_aid = str(read_payload.get("id") or cid)
    scramble_id = scramble if scramble != "" else read_payload.get("scramble_id")
    selected = [p for p in pages if int(p["page"]) >= start][:count]

    def fetch(item):
        key = _page_key(cid, item["page"], compression)
        return item["page"], cache.get_bytes("pages", key)

    async def gen():
        import base64
        boundary = "jmbridgeframe"
        for item in selected:
            page_no, data = await loop.run_in_executor(None, fetch, item)
            # An uncached page is reported, not fetched: this route must never hold a
            # worker thread on a CDN download.
            payload = json.dumps({"page": page_no, "hit": data is not None,
                                  "b64": base64.b64encode(data).decode("ascii") if data else ""})
            yield "--{}\r\nContent-Type: application/json\r\n\r\n{}\r\n".format(boundary, payload).encode()
        yield "--{}--\r\n".format(boundary).encode()

    return StreamingResponse(gen(), media_type="multipart/mixed; boundary=jmbridgeframe")


# ------------------------------------------------------------------ download / cache

def _collect_pages(cid: str, lossless: bool, compression: str):
    """Yield (index, filename, raw_bytes, pil_image_or_None) for a chapter."""
    client = _client()
    read_payload = cache.get_json("search", "read|{}".format(cid))
    if read_payload is None:
        read_payload = client.get("comic_read", {"id": cid})
        cache.put_json("search", "read|{}".format(cid), read_payload, {"kind": "read", "cid": cid})

    pages = _page_urls(read_payload)
    album_aid = str(read_payload.get("id") or cid)
    scramble_id = read_payload.get("scramble_id")

    for item in pages:
        name = page_stem(item["url"])
        try:
            raw = client.image_bytes(item["url"])
        except Exception:
            continue
        img = thumbs._open(raw)
        restored = is_scrambled(decode_aid, scramble_id)
        if restored:
            img = unscramble(img, decode_aid, scramble_id, name)
        yield item["page"], name, raw, img, restored


# ------------------------------------------------------------------ discover

SORTS = {"": "new", "tf": "likes", "mv": "views", "mv_m": "month", "mv_w": "week", "mv_t": "day"}


def _items(payload) -> tuple[list, int]:
    if isinstance(payload, list):
        return payload, len(payload)
    if isinstance(payload, dict):
        items = payload.get("content") or payload.get("list") or []
        return items, int(payload.get("total") or 0)
    return [], 0


@app.get("/api/home")
def home():
    """Everything the home screen needs, in one round trip."""
    hit = cache.get_json("search", "home:v2")
    if hit:
        return _ok(hit, cached=True)
    client = _client()
    out = {"promote": [], "latest": [], "hot_tags": [], "serialization": []}
    for key, endpoint, params in (
        ("promote", "promote", None),
        ("latest", "latest", {"page": "1"}),
        ("hot_tags", "hot_tags", None),
        # The serialization endpoint returns {"error": ...} unless date is present.
        ("serialization", "serialization", {"page": 1, "date": 0}),
    ):
        try:
            items, _total = _items(client.get(endpoint, params) if params else client.get(endpoint))
            out[key] = items
        except JMError:
            out[key] = []
    cache.put_json("search", "home:v2", out, {"kind": "home"})
    return _ok(out, cached=False)


@app.get("/api/latest")
def latest(page: int = Query(1), refresh: bool = Query(False)):
    key = "latest|{}|{}".format(page, settings.get("lang"))
    if not refresh:
        hit = cache.get_json("search", key)
        if hit:
            return _ok(hit, cached=True)
    items, total = _items(_client().get("latest", {"page": str(page)}))
    result = {"page": page, "items": items, "total": total}
    cache.put_json("search", key, result, {"kind": "latest", "page": page})
    return _ok(result, cached=False)


@app.get("/api/serialization")
def serialization(page: int = Query(1), type_: str = Query("", alias="type"),
                   date: int = Query(0)):
    # date must always be sent (0 = "any time"); without it the upstream API answers
    # with {"error": ...} instead of a list.
    params = {"page": page, "date": date}
    if type_:
        params["type"] = type_
    items, total = _items(_client().get("serialization", params))
    return _ok({"page": page, "items": items, "total": total})


@app.get("/api/categories")
def categories():
    hit = cache.get_json("search", "categories:v1")
    if hit:
        return _ok(hit, cached=True)
    data = _client().get("categories") or {}
    out = {"categories": data.get("categories") or [], "blocks": data.get("blocks") or []}
    cache.put_json("search", "categories:v1", out, {"kind": "categories"})
    return _ok(out, cached=False)


@app.get("/api/browse")
def browse(c: str = Query(""), o: str = Query(""), page: int = Query(1),
           refresh: bool = Query(False)):
    key = "browse|{}|{}|{}|{}".format(c, o, page, settings.get("lang"))
    if not refresh:
        hit = cache.get_json("search", key)
        if hit:
            return _ok(hit, cached=True)
    items, total = _items(_client().get("categories_filter", {"c": c, "o": o, "page": page}))
    result = {"c": c, "o": o, "order": SORTS.get(o, "new"), "page": page,
              "items": items, "total": total}
    cache.put_json("search", key, result, {"kind": "browse", "c": c, "o": o, "page": page})
    return _ok(result, cached=False)


@app.get("/api/week")
async def week(id: str = Query(""), type: str = Query("")):
    """Weekly picks: the issue index, or one issue's contents."""
    if not id and not type:
        hit = cache.get_json("search", "week:index")
        if hit:
            return _ok(hit, cached=True)
        data = await asyncio.get_running_loop().run_in_executor(None, lambda: _client().get("week"))
        out = {"categories": (data or {}).get("categories") or [],
               "types": (data or {}).get("type") or []}
        cache.put_json("search", "week:index", out, {"kind": "week"})
        return _ok(out, cached=False)

    params = {}
    if id:
        params["id"] = id
    if type:
        params["type"] = type
    loop = asyncio.get_running_loop()
    items, total = _items(await loop.run_in_executor(
        None, lambda: _client().get("week_filter", params)))
    return _ok({"id": id, "type": type, "items": items, "total": total})


@app.get("/api/hot_tags")
def hot_tags():
    hit = cache.get_json("search", "hot_tags:v1")
    if hit:
        return _ok(hit, cached=True)
    tags = _client().get("hot_tags") or []
    cache.put_json("search", "hot_tags:v1", tags, {"kind": "hot_tags"})
    return _ok(tags, cached=False)


@app.get("/api/random")
def random_pick():
    return _ok(_client().get("random_recommend") or [])


# ------------------------------------------------------------------ library

@app.get("/api/progress")
def progress_list(limit: int = Query(24)):
    return _ok({"items": library.recent(limit), "stats": library.stats()})


@app.get("/api/progress/{cid}")
def progress_get(cid: str):
    return _ok(library.get_progress(cid))


@app.post("/api/progress")
async def progress_set(request: Request):
    body = await request.json()
    cid = str(body.get("cid") or "").strip()
    if not cid:
        raise HTTPException(status_code=400, detail="cid is required")
    record = library.set_progress(
        cid,
        page=body.get("page") or 1,
        total=body.get("total") or 0,
        aid=body.get("aid") or "",
        title=body.get("title") or "",
        album=body.get("album") or "",
    )
    return _ok(record)


@app.delete("/api/progress/series/{aid}")
def progress_series_delete(aid: str):
    return _ok({"removed": library.delete_series_progress(aid)})


@app.delete("/api/progress/{cid}")
def progress_delete(cid: str):
    return _ok({"removed": library.delete_progress(cid)})


@app.get("/api/favorites")
def favorites_list():
    return _ok({"items": library.favorites(), "stats": library.stats()})


@app.post("/api/favorites")
async def favorites_add(request: Request):
    body = await request.json()
    aid = str(body.get("aid") or "").strip()
    if not aid:
        raise HTTPException(status_code=400, detail="aid is required")
    record = library.add_favorite(aid, title=body.get("title") or "", author=body.get("author") or "")
    return _ok(record)


@app.delete("/api/favorites/{aid}")
def favorites_remove(aid: str):
    return _ok({"removed": library.remove_favorite(aid)})


@app.get("/api/library")
def library_overview():
    return _ok({
        "progress": library.recent(24),
        "favorites": library.favorites(),
        "stats": library.stats(),
    })


# ------------------------------------------------------------------ reader extras

@app.get("/api/chapter/{cid}/neighbors")
def chapter_neighbors(cid: str, aid: str = Query("")):
    """Previous/next chapter within the album, resolved from the album's series list."""
    read_payload = cache.get_json("search", "read|{}".format(cid))
    if read_payload is None:
        read_payload = _client().get("comic_read", {"id": cid})
        cache.put_json("search", "read|{}".format(cid), read_payload, {"kind": "read", "cid": cid})
    album_aid = _series_aid(read_payload, aid) or str(cid)

    album = cache.get_json("search", "album|{}".format(album_aid))
    if not isinstance(album, dict):
        album = _client().get("album", {"id": album_aid})
        if not isinstance(album, dict):
            raise HTTPException(status_code=502, detail="album unavailable")
        cache.put_json("search", "album|{}".format(album_aid), album,
                       {"kind": "album", "aid": album_aid, "title": album.get("name", "")})

    series = album.get("series") or []
    index = next((i for i, ch in enumerate(series) if str(ch.get("id")) == str(cid)), -1)
    prev = series[index - 1] if index > 0 else None
    nxt = series[index + 1] if 0 <= index < len(series) - 1 else None
    return _ok({
        "cid": cid,
        "aid": album_aid,
        "index": index,
        "total": len(series),
        "prev": {"id": prev.get("id"), "name": prev.get("name") or ""} if prev else None,
        "next": {"id": nxt.get("id"), "name": nxt.get("name") or ""} if nxt else None,
    })


@app.get("/api/album/{aid}/progress")
def album_progress(aid: str):
    return _ok({"aid": aid, "items": library.series_progress(aid),
                "favorite": library.is_favorite(aid)})


@app.get("/api/download/{cid}")
def download(cid: str, title: str = Query("")):
    """Lossless archive. Independent of the cache compression mode."""
    meta = cache.get_json("search", "read|{}".format(cid)) or {}
    name = title or meta.get("name") or cid
    archive_key = "{}|download".format(cid)
    cached = cache.get_bytes("zip", archive_key)
    if cached is not None:
        buf = io.BytesIO(cached)
    else:
        pages = list(_collect_pages(cid, lossless=True, compression="none"))
        if not pages:
            raise HTTPException(status_code=502, detail="no pages fetched")

        buf = archive.build_zip(pages, album_title=name, archive_name=name, lossless=True)
        cache.put_bytes("zip", archive_key, buf.getvalue(),
                        {"kind": "download", "cid": cid, "title": name, "pages": len(pages)})
    buf.seek(0)
    filename = "{}.zip".format(archive.safe_name(name, cid))
    return StreamingResponse(buf, media_type="application/zip",
                             headers={"Content-Disposition": archive.content_disposition(filename)})


@app.delete("/api/cache/item")
def cache_delete_item(kind: str = Query(...), key: str = Query(...)):
    # Registered before /api/cache/{kind} so a single-item delete is not swallowed by it.
    removed = cache.delete_key(kind, key)
    return _ok({"removed": removed, "stats": cache.stats()})


@app.get("/api/cache")
def cache_stats():
    return _ok(cache.stats())


@app.get("/api/cache/{kind}")
def cache_list(kind: str, limit: int = Query(200), offset: int = Query(0)):
    if kind not in ("search", "thumb", "pages", "zip", "prog"):
        raise HTTPException(status_code=400, detail="unknown cache kind")
    entries = cache.list_entries(kind, limit=limit, offset=offset)
    return _ok({"kind": kind, "entries": entries, "stats": cache.stats()["by_kind"].get(kind, {})})


@app.delete("/api/cache/{kind}")
def cache_clear(kind: str):
    if kind not in ("search", "thumb", "pages", "zip", "prog"):
        raise HTTPException(status_code=400, detail="unknown cache kind")
    removed = cache.clear(kind)
    return _ok({"removed": removed, "stats": cache.stats()})


@app.delete("/api/cache/pages/{cid}")
def cache_drop_pages(cid: str):
    removed = cache.delete_prefix("pages|{}|".format(cid))
    return _ok({"removed": removed, "stats": cache.stats()})


@app.delete("/api/cache/zip/{key}")
def cache_drop_zip(key: str):
    removed = cache.delete_prefix("zip|" + key)
    return _ok({"removed": removed, "stats": cache.stats()})


@app.post("/api/cache/evict")
def cache_evict():
    cache.enforce_limit()
    return _ok(cache.stats())
@app.post("/api/cache/pack/{cid}")
def cache_pack(cid: str, mode: str = Query("")):
    """Pack a chapter into a cached zip using the configured compression."""
    compression = mode or settings.get("cache_compression") or "minimal"
    lossless = compression == "none"
    meta = cache.get_json("search", "read|{}".format(cid)) or {}
    title = meta.get("name") or cid
    pages = list(_collect_pages(cid, lossless=False, compression=compression))
    if not pages:
        raise HTTPException(status_code=502, detail="no pages fetched")
    buf = archive.build_zip(pages, album_title=title, archive_name=title,
                            lossless=lossless, mode=compression)
    key = "{}|{}".format(cid, compression)
    cache.put_bytes("zip", key, buf.getvalue(),
                    {"kind": "pack", "cid": cid, "title": title, "mode": compression,
                     "pages": len(pages)})
    return _ok({"cid": cid, "mode": compression, "bytes": buf.getbuffer().nbytes,
                "pages": len(pages)})


@app.get("/api/cache/zip/{cid}/file")
def cache_zip_file(cid: str, mode: str = Query("")):
    """Serve a packed archive back by chapter id."""
    compression = mode or settings.get("cache_compression") or "minimal"
    data = cache.get_bytes("zip", "{}|{}".format(cid, compression))
    if data is None:
        raise HTTPException(status_code=404, detail="archive not packed")
    meta = cache.get_json("search", "read|{}".format(cid)) or {}
    name = meta.get("name") or cid
    filename = "{}.zip".format(archive.safe_name(name, cid))
    return Response(data, media_type="application/zip",
                    headers={"Content-Disposition": archive.content_disposition(filename)})


# ------------------------------------------------------------------ tasks

def _task_snapshot():
    cover_tasks = covers.task_snapshot()
    snapshot = tasks.stats()
    snapshot["cover_pending"] = sum(1 for item in cover_tasks if item["state"] == "pending")
    snapshot["cover_running"] = sum(1 for item in cover_tasks if item["state"] == "running")
    snapshot["cover_done"] = sum(1 for item in cover_tasks if item["state"] == "done")
    snapshot["cover_total"] = len(cover_tasks)
    snapshot["total"] += len(cover_tasks)
    snapshot["cdn"] = cdn_limiter.stats()
    return {"tasks": [t.to_dict() for t in tasks.all_tasks()] + cover_tasks, "stats": snapshot}


def _task_snapshot_of(cid: str):
    task = tasks.get(cid)
    return task.to_dict() if task is not None else None


@app.get("/api/tasks")
def task_list():
    return _ok(_task_snapshot())


@app.post("/api/tasks/cover/{batch_id}/priority")
async def cover_task_priority(batch_id: str, request: Request):
    body = await request.json()
    if not covers.set_priority(batch_id, body.get("priority", 0)):
        raise HTTPException(status_code=404, detail="no such cover task")
    return _ok(_task_snapshot())


@app.get("/api/tasks/stream")
async def task_stream():
    """SSE: push a new snapshot whenever anything changed, plus a keep-alive.

    Polling the manager is deliberate: it is a cheap in-memory read, and a single
    generator cannot leak subscription state the way a pub/sub pair can.
    """
    async def gen():
        last = ""
        idle = 0.0
        while True:
            snapshot = _task_snapshot()
            signature = json.dumps(snapshot, sort_keys=True, default=str)
            if signature != last:
                last = signature
                idle = 0.0
                yield _sse("tasks", snapshot)
            else:
                idle += 0.5
                if idle >= 15.0:
                    idle = 0.0
                    yield ": keep-alive\n\n"
            await asyncio.sleep(0.5)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})


def _spawn_task(cid: str, title: str = "", aid: str = "", foreground: bool = True):
    """Create (or reuse) the cache task for a chapter and return its snapshot."""
    existing = tasks.get(cid)
    read_payload = cache.get_json("search", "read|{}".format(cid))
    if read_payload is None:
        read_payload = _client().get("comic_read", {"id": cid})
        cache.put_json("search", "read|{}".format(cid), read_payload,
                       {"kind": "read", "cid": cid})
    pages = _page_urls(read_payload)
    album_aid = str(read_payload.get("id") or cid)
    if existing is not None and existing.total > 0:
        if foreground:
            tasks.set_foreground(cid)
        return existing.to_dict()

    # A prior task may have been created while chapter metadata was temporarily empty.
    # Reusing that zero-page task would leave the reader permanently blank.
    task = tasks.create(cid, title=title or read_payload.get("name") or cid,
                        aid=album_aid, scramble_id=read_payload.get("scramble_id"),
                        images=pages)
    if foreground:
        tasks.set_foreground(cid)
    return task.to_dict()


@app.get("/api/tasks/{cid}")
def task_get(cid: str):
    snapshot = _task_snapshot_of(cid)
    if snapshot is None:
        raise HTTPException(status_code=404, detail="no such task")
    return _ok(snapshot)


@app.get("/api/tasks/{cid}/pages")
def task_pages(cid: str, mode: str = Query("")):
    """Per-page cache state, so the reader can paint progress without guessing.

    A page's displayed state melds two sources: the scheduler (idle / claimed /
    done / error / failed) and the page cache (the bytes are actually on disk).
    The reader needs both: "cached" decides whether the browser may load it, while
    "error vs failed" decides whether the block is retrying or given up.
    """
    compression = mode or settings.get("cache_compression") or "minimal"
    # The exact mode wins; another tier is readable if it used the current descrambler.
    cached = {}
    prefix = "pages|{}|".format(cid)
    for entry in cache.list_prefix("pages", str(cid) + "|"):
        meta = entry.get("meta") or {}
        index = meta.get("index")
        if index is None:
            continue
        key = entry.get("key", "")
        exact = key == prefix + _page_key(cid, index, compression)
        compatible = key.startswith(prefix + str(index) + "|") and key.endswith("|v" + DESC_VERSION)
        if not exact and not compatible:
            continue
        if int(index) not in cached or exact:
            cached[int(index)] = (meta.get("w") or 0, meta.get("h") or 0)

    task = tasks.get(cid)
    snapshot = task.to_dict() if task is not None else {}
    task_pages_by_number = {int(item["page"]): item for item in snapshot.get("pages", [])}
    read_payload = cache.get_json("search", "read|{}".format(cid))
    pages = []
    for idx, entry in enumerate(_page_urls(read_payload) if read_payload else []):
        page_no = int(entry.get("page") or (idx + 1))
        task_item = task_pages_by_number.get(page_no, {})
        width, height = cached.get(page_no, (0, 0))
        pages.append({
            "page": page_no,
            "index": int(task_item.get("index", idx)),
            "state": task_item.get("state", "done" if page_no in cached else "idle"),
            "attempts": task_item.get("attempts", 0),
            "max_attempts": task_item.get("max_attempts", PAGE_ATTEMPTS),
            "error": task_item.get("error", ""),
            "cached": page_no in cached,
            "w": width,
            "h": height,
        })
    state = snapshot.get("state", "done" if pages and all(p["cached"] for p in pages) else "idle")

    return _ok({
        "cid": cid,
        "mode": compression,
        "state": state,
        "total": len(pages),
        "cached": sum(1 for p in pages if p["cached"]),
        "failed": sum(1 for p in pages if p["state"] == "failed"),
        "pages": pages,
    })


@app.post("/api/tasks")
async def task_create(request: Request):
    body = await request.json()
    cid = str(body.get("cid") or "").strip()
    if not cid:
        raise HTTPException(status_code=400, detail="cid is required")
    loop = asyncio.get_running_loop()
    snapshot = await loop.run_in_executor(
        None,
        lambda: _spawn_task(cid, body.get("title") or "", body.get("aid") or "",
                            foreground=body.get("foreground", True)),
    )
    return _ok(snapshot)


@app.post("/api/tasks/{cid}/retry")
def task_retry_failed(cid: str):
    """Give the pages that gave up a fresh retry budget (user asked to retry)."""
    rearmed = tasks.retry_failed(cid)
    if not rearmed:
        return _ok({"rearmed": 0, "task": _task_snapshot_of(cid)})
    return _ok({"rearmed": rearmed, "task": _task_snapshot_of(cid)})


@app.post("/api/tasks/{cid}/focus")
async def task_focus(cid: str, request: Request):
    """Report where the user is. Pages before this are dropped, this one leads."""
    body = await request.json()
    page = int(body.get("page") or 1)
    if tasks.get(cid) is None:
        await asyncio.get_running_loop().run_in_executor(None, _spawn_task, cid)
    task = tasks.get(cid)
    if task is not None:
        task.set_focus(page - 1)          # payload is 1-based
    if tasks.stats().get("foreground") != cid:
        tasks.set_foreground(cid)
    return _ok(_task_snapshot_of(cid))


@app.post("/api/tasks/{cid}/pause")
def task_pause(cid: str):
    tasks.pause(cid)
    return _ok(tasks.stats())


@app.post("/api/tasks/{cid}/resume")
def task_resume(cid: str):
    tasks.resume(cid)
    return _ok(tasks.stats())


@app.post("/api/tasks/{cid}/cancel")
def task_cancel(cid: str):
    tasks.cancel(cid)
    return _ok(tasks.stats())


@app.delete("/api/tasks/{cid}")
def task_delete(cid: str):
    removed = tasks.remove(cid)
    if not removed:
        raise HTTPException(status_code=404, detail="no such task")
    return _ok(tasks.stats())


# ------------------------------------------------------------------ static SPA
_STATIC = Path(__file__).resolve().parent / "static"
if _STATIC.exists():
    app.mount("/", StaticFiles(directory=str(_STATIC), html=True), name="static")
