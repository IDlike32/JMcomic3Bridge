"""Background download tasks with multi-source scheduling.

Opening a comic creates a task instead of lazy-loading pages one by one. Pages are
fetched in order starting from where the user is actually looking, and spread over
all three active lines at once so every line is saturated simultaneously.

Only one task runs at a time: the chapter the user is reading. Everything else is
parked until it becomes the foreground task again.
"""
from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
from urllib.parse import urlsplit

import httpx

import thumbs
from descramble import DESC_VERSION, is_scrambled, page_stem, unscramble

UA = (
    "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
)

PAGE_TIMEOUT = 30.0

_page_client_lock = threading.Lock()
_page_client_obj = None


def _page_client() -> httpx.Client:
    """Shared keep-alive client for page images (one pool for every worker)."""
    global _page_client_obj
    with _page_client_lock:
        if _page_client_obj is None:
            _page_client_obj = httpx.Client(
                http2=False,
                timeout=httpx.Timeout(PAGE_TIMEOUT, connect=8.0),
                follow_redirects=True,
                limits=httpx.Limits(max_connections=24, max_keepalive_connections=12,
                                    keepalive_expiry=30.0),
            )
        return _page_client_obj
# One failed page request consumes one CDN attempt. The next scheduler pass avoids
# the previous lane, so a transient CDN failure can fail over to another source.
MAX_RETRIES = 1
PAGE_ATTEMPTS = 10


class CDNLimiter:
    """Bound all image downloads across chapter and cover workers."""

    def __init__(self, limit=12):
        self.limit = max(1, int(limit))
        self._slots = threading.BoundedSemaphore(self.limit)
        self._lock = threading.Lock()
        self._inflight = 0

    def acquire(self):
        self._slots.acquire()
        with self._lock:
            self._inflight += 1

    def release(self):
        with self._lock:
            self._inflight = max(0, self._inflight - 1)
        self._slots.release()

    def stats(self):
        with self._lock:
            return {"limit": self.limit, "inflight": self._inflight}


class Task:
    """One chapter being cached."""

    def __init__(self, cid, title="", aid="", scramble_id=None):
        self.cid = str(cid)
        self.title = title or str(cid)
        self.aid = str(aid or cid)
        self.scramble_id = scramble_id
        self.pages = []          # list of page dicts
        self.states = {}         # index -> idle|claimed|done|error|failed
        self.attempts = {}       # index -> failed fetch count (drives retry vs. give up)
        self.errors = {}         # index -> last failure reason (shown to the reader)
        self.focus = 0           # user position, drives download order
        self.state = "pending"   # pending|running|paused|done|error|cancelled
        self.bytes = 0
        self.created = time.time()
        self.updated = time.time()
        self.last_viewed = time.time()
        self.error = ""
        self.claimed = {}        # index -> lane name
        self.last_lanes = {}     # index -> last CDN lane, used for failover
        self._lock = threading.RLock()

    # ---------- setup ----------
    def load_pages(self, images):
        with self._lock:
            self.pages = []
            for idx, entry in enumerate(images):
                if isinstance(entry, str):
                    url = entry
                    page_no = idx + 1
                else:
                    url = entry.get("url") or entry.get("image") or ""
                    page_no = int(entry.get("page") or (idx + 1))
                if not url:
                    continue
                # The descrambler is keyed by the FILE NAME stem, not the page number
                # (mirrors the client: altKey = /\/([^/]+)\.webp/).
                stem = page_stem(url) or str(page_no)
                self.pages.append({"page": page_no, "url": url, "index": idx, "name": stem})
                if idx not in self.states:
                    self.states[idx] = "idle"
            self.updated = time.time()

    @property
    def total(self):
        return len(self.pages)

    def done_count(self):
        return sum(1 for s in self.states.values() if s == "done")

    def failed_count(self):
        return sum(1 for s in self.states.values() if s == "failed")

    def is_complete(self):
        # A page that failed every attempt is settled too: retrying it forever would
        # keep the chapter "running" and hide the failures from the reader.
        return self.total > 0 and (self.done_count() + self.failed_count()) >= self.total

    # ---------- scheduling ----------
    def next_page(self):
        """Claim the highest-priority unclaimed page.

        Priority spreads outwards from the focus point, alternating backwards and
        forwards, so scrolling up warms the same way scrolling down does.
        """
        with self._lock:
            n = self.total
            if not n:
                return None
            start = min(max(0, self.focus), n - 1)
            order = [start]
            step = 1
            while start - step >= 0 or start + step < n:
                if start + step < n:
                    order.append(start + step)
                if start - step >= 0:
                    order.append(start - step)
                step += 1
            for i in order:
                if self.states.get(i) in (None, "idle", "error"):
                    self.states[i] = "claimed"
                    return self.pages[i]
            return None

    def release(self, index, ok, nbytes=0, error=""):
        with self._lock:
            if ok:
                self.states[index] = "done"
                self.attempts.pop(index, None)
                self.errors.pop(index, None)
                self.last_lanes.pop(index, None)
                self.bytes += nbytes
            else:
                tries = self.attempts.get(index, 0) + 1
                self.attempts[index] = tries
                # error = will be picked up again (retrying), failed = given up.
                self.states[index] = "failed" if tries >= PAGE_ATTEMPTS else "error"
                if error:
                    self.error = error[:200]
                    self.errors[index] = error[:200]
            self.claimed.pop(index, None)
            self.updated = time.time()

    def retry_failed(self):
        """Re-arm every page that gave up, so the scheduler tries it again.

        Without this a page that spent its whole retry budget is settled forever and a
        user-requested retry would be a no-op.
        """
        with self._lock:
            rearmed = []
            for index, state in list(self.states.items()):
                if state != "failed":
                    continue
                self.states[index] = "idle"
                self.attempts.pop(index, None)
                self.errors.pop(index, None)
                self.last_lanes.pop(index, None)
                rearmed.append(index)
            if rearmed:
                if self.state in ("done", "error", "cancelled"):
                    self.state = "running"
                self.error = ""
                self.updated = time.time()
            return rearmed

    def page_failure(self, index):
        """Terminal failure detail for one page, or None while it is still trying."""
        with self._lock:
            state = self.states.get(index)
            if state != "failed":
                return None
            attempts = int(self.attempts.get(index, 0))
            return {
                "reason": self.errors.get(index) or "页面图片获取失败",
                "code": "page_fetch_failed",
                "attempts": attempts,
                "max_attempts": PAGE_ATTEMPTS,
                "exhausted": attempts >= PAGE_ATTEMPTS,
            }

    def reset_inflight(self):
        with self._lock:
            for idx, st in list(self.states.items()):
                if st == "claimed":
                    self.states[idx] = "idle"
            self.claimed.clear()
            self.last_lanes.clear()

    def set_focus(self, page_index):
        with self._lock:
            new_focus = max(0, min(int(page_index), max(0, self.total - 1)))
            if new_focus != self.focus:
                self.focus = new_focus
            self.last_viewed = time.time()
            self.updated = time.time()

    def touch(self):
        self.last_viewed = time.time()

    def to_dict(self):
        with self._lock:
            done = self.done_count()
            return {
                "cid": self.cid,
                "title": self.title,
                "aid": self.aid,
                "scramble_id": self.scramble_id,
                "state": self.state,
                "total": self.total,
                "done": done,
                "failed": self.failed_count(),
                "bytes": self.bytes,
                "focus": self.focus,
                "progress": round(done / self.total, 4) if self.total else 0.0,
                "created": self.created,
                "updated": self.updated,
                "last_viewed": self.last_viewed,
                "error": self.error,
                "pages": [{"page": p["page"], "index": p["index"],
                           "state": self.states.get(p["index"], "idle"),
                           "attempts": self.attempts.get(p["index"], 0),
                           "max_attempts": PAGE_ATTEMPTS,
                           "error": self.errors.get(p["index"], "")}
                          for p in self.pages],
            }


class TaskManager:
    """Owns all tasks and the shared worker pool."""

    def __init__(self, cache, settings, pool, client_factory, concurrency=12, hub=None, limiter=None):
        self.cache = cache
        self.limiter = limiter
        self.settings = settings
        self.pool = pool
        self.client_factory = client_factory
        self.concurrency = concurrency
        self.hub = hub
        self._lock = threading.RLock()
        self._tasks = {}
        self._foreground = None
        self._executor = ThreadPoolExecutor(max_workers=concurrency, thread_name_prefix="jmbridge")
        self._inflight = 0
        self._lane_speed = {}   # per-line EWMA throughput, drives lane weighting
        self._wake = threading.Event()
        self._stop = False
        self._scheduler = threading.Thread(target=self._loop, daemon=True, name="jmbridge-sched")
        self._scheduler.start()

    # ---------- lanes (the three sources) ----------
    def _lanes(self):
        """Snapshot of usable sources: one per active line, each with its img_host."""
        lanes = []
        for line in self.pool.active_lines():
            if line.img_host:
                lanes.append((line.host, line.img_host))
        if not lanes:
            for line in self.pool.active_lines():
                try:
                    self.pool.probe(line.host)
                    if line.img_host:
                        lanes.append((line.host, line.img_host))
                except Exception:
                    continue
        return lanes

    def _rewrite(self, url, img_host):
        """Point an image URL at a specific CDN, keeping path and query."""
        sp = urlsplit(url)
        path = sp.path + (("?" + sp.query) if sp.query else "")
        return img_host.rstrip("/") + path

    # ---------- task api ----------
    def get(self, cid):
        with self._lock:
            return self._tasks.get(str(cid))

    def require(self, cid):
        task = self.get(cid)
        if task is None:
            raise KeyError("no such task: %s" % cid)
        return task

    def create(self, cid, title="", aid="", scramble_id=None, images=None):
        with self._lock:
            task = self._tasks.get(str(cid))
            if task is None:
                task = Task(cid, title, aid, scramble_id)
                self._tasks[str(cid)] = task
            else:
                task.title = title or task.title
                task.aid = str(aid or task.aid)
                task.scramble_id = scramble_id if scramble_id is not None else task.scramble_id
            if images:
                task.load_pages(images)
            task.state = "pending" if task.state in ("error", "cancelled") else task.state
        self._wake.set()
        return task

    def all_tasks(self):
        with self._lock:
            tasks = list(self._tasks.values())
        tasks.sort(key=lambda t: (t.state != "running", -t.last_viewed))
        return tasks

    def retry_failed(self, cid):
        """Re-queue the pages that gave up. Returns how many were re-armed."""
        task = self.get(cid)
        if task is None:
            return 0
        rearmed = task.retry_failed()
        if rearmed:
            self._foreground = str(cid)
            task.touch()
            self._wake.set()
        return len(rearmed)

    def set_foreground(self, cid):
        """The chapter the user is looking at. Everything else parks."""
        with self._lock:
            self._foreground = str(cid) if cid else None
            for c in self._tasks:
                t = self._tasks[c]
                if t.cid == self._foreground:
                    t.touch()
                    if t.state in ("pending", "paused"):
                        t.state = "running"
                elif t.state == "running":
                    t.state = "paused"
                    t.reset_inflight()
        self._wake.set()
        return self._foreground

    def pause(self, cid):
        with self._lock:
            t = self._tasks.get(str(cid))
            if t:
                t.state = "paused"
                t.reset_inflight()
                if self._foreground == str(cid):
                    self._foreground = None
        self._wake.set()

    def resume(self, cid):
        with self._lock:
            t = self._tasks.get(str(cid))
            if t:
                t.state = "running"
                t.touch()
            self._foreground = str(cid)
        self._wake.set()

    def cancel(self, cid):
        with self._lock:
            t = self._tasks.get(str(cid))
            if t:
                t.state = "cancelled"
                t.reset_inflight()
                if self._foreground == str(cid):
                    self._foreground = None
        self._wake.set()

    def remove(self, cid):
        with self._lock:
            task = self._tasks.pop(str(cid), None)
            if self._foreground == str(cid):
                self._foreground = None
        self._wake.set()
        return task is not None

    def stats(self):
        with self._lock:
            tasks = list(self._tasks.values())
            fg = self._foreground
        running = [t for t in tasks if t.state == "running"]
        return {
            "total": len(tasks),
            "running": len(running),
            "paused": len([t for t in tasks if t.state == "paused"]),
            "done": len([t for t in tasks if t.is_complete()]),
            "foreground": fg,
            "lanes": [h for h, _ in self._lanes()],
            "inflight": self._inflight,
        }


    # ---------- scheduler ----------
    def _loop(self):
        while not self._stop:
            try:
                self._tick()
            except Exception:
                pass
            self._wake.wait(0.25)
            self._wake.clear()

    def _page_key(self, task, page_no):
        # Must match service._page_key byte for byte (1-based page number included).
        mode = self.settings.get("cache_compression") or "minimal"
        return "{}|{}|{}|v{}".format(task.cid, page_no, mode, DESC_VERSION)

    def _tick(self):
        with self._lock:
            fg = self._tasks.get(self._foreground) if self._foreground else None
            if fg is None:
                fg = next((t for t in self._tasks.values() if t.state == "running"), None)
        if fg is None:
            return
        if fg.state != "running":
            return

        if fg.is_complete():
            with self._lock:
                fg.state = "done"
            return
        if not fg.total:
            return

        lanes = self._lanes()
        if not lanes:
            return

        # Fill every free worker slot from the one running task.
        budget = self.concurrency * 2
        while self._inflight < self.concurrency and budget > 0:
            budget -= 1
            item = fg.next_page()
            if item is None:
                break
            lane = self._pick_lane(lanes, fg, item["index"])
            self._inflight += 1
            self._executor.submit(self._worker, fg, item, lane, lanes)

    def _pick_lane(self, lanes, task, index):
        """Spread pages across the three sources, weighted by measured speed."""
        best = None
        best_score = None
        previous = task.last_lanes.get(index)
        candidates = [lane for lane in lanes if lane[0] != previous] or lanes
        for host, img_host in candidates:
            line = self.pool.get(host)
            inflight = line.inflight if line else 0
            speed = self._lane_speed.get(host, 1.0)   # pages/sec, EWMA
            # Lower score wins: few in flight and historically fast.
            score = (inflight + 1) / max(speed, 0.05)
            if best_score is None or score < best_score:
                best_score = score
                best = (host, img_host)
        return best

    def _worker(self, task, item, lane, lanes=None):
        index = item["index"]
        page_no = item["page"]
        page_name = page_stem(item.get("name") or item.get("url") or str(page_no)) or str(page_no)
        ok = False
        size = 0
        err = ""
        try:
            host, img_host = lane
            task.last_lanes[index] = host
            content = self._fetch_race(task, item, lane, lanes or [lane])

            data, width, height = self._process(content, task, page_name)
            self.cache.put_bytes("pages", self._page_key(task, page_no), data,
                                 {"kind": "page", "cid": task.cid, "index": page_no,
                                  "aid": task.aid, "w": width, "h": height})
            size = len(data)
            ok = True
            # The reader is already open and waiting for exactly this page: tell it now
            # instead of making it poll to discover the bytes exist.
            if self.hub is not None:
                self.hub.publish("pages", {"cid": task.cid, "page": page_no,
                                           "w": width, "h": height})
            self._lane_speed[host] = self._lane_speed.get(host, 1.0) * 0.8 + 0.2 * 2.0
        except Exception as exc:
            err = str(exc)
            try:
                host = lane[0]
                self._lane_speed[host] = max(0.05, self._lane_speed.get(host, 1.0) * 0.7)
            except Exception:
                pass
        finally:
            task.release(index, ok, size, err)
            with self._lock:
                self._inflight = max(0, self._inflight - 1)
            if self.hub is not None:
                self.hub.publish("tasks", {"cid": task.cid, "state": task.state})
            self._wake.set()

    def _fetch_race(self, task, item, primary, lanes):
        """Use one source first, then race every other source once if it is slow."""
        ordered = [primary] + [lane for lane in lanes if lane[0] != primary[0]]
        distance = abs(int(item.get("index", 0)) - int(task.focus or 0))
        timeout = min(8.0, 1.5 + min(distance, 26) * 0.25)
        executor = ThreadPoolExecutor(max_workers=len(ordered), thread_name_prefix="jmbridge-fork")
        futures = {}
        try:
            for lane in ordered[:1]:
                futures[executor.submit(self._fetch_once, self._rewrite(item["url"], lane[1]), lane)] = lane
            done, pending = wait(list(futures), timeout=timeout)
            primary_ok = False
            for future in done:
                try:
                    if future.result():
                        primary_ok = True
                        return future.result()
                except Exception:
                    pass
            if not primary_ok:
                for lane in ordered[1:]:
                    futures[executor.submit(self._fetch_once, self._rewrite(item["url"], lane[1]), lane)] = lane
                done, pending = wait(list(futures), timeout=PAGE_TIMEOUT)
            last = "source timeout"
            while done:
                for future in done:
                    try:
                        content = future.result()
                        if content:
                            return content
                    except Exception as exc:
                        last = str(exc)
                if not pending:
                    break
                done, pending = wait(list(pending), timeout=PAGE_TIMEOUT, return_when=FIRST_COMPLETED)
            raise RuntimeError(last)
        finally:
            for future in futures:
                future.cancel()
            executor.shutdown(wait=False, cancel_futures=True)

    def _fetch_once(self, url, lane):
        host = lane[0]
        line = self.pool.get(host)
        acquired = False
        success = False
        try:
            if self.limiter is not None:
                self.limiter.acquire()
                acquired = True
            if line is not None:
                self.pool.acquire(line)
            headers = {"User-Agent": UA, "Referer": "https://18comic.vip/"}
            resp = _page_client().get(url, headers=headers, timeout=PAGE_TIMEOUT)
            if resp.status_code == 200 and resp.content:
                success = True
                return resp.content
            raise RuntimeError("HTTP %s" % resp.status_code)
        finally:
            if line is not None:
                self.pool.release(line, success)
            if acquired:
                self.limiter.release()

    def _fetch(self, url):
        """Fetch one page image, reusing a pooled connection.

        A fresh httpx.get per attempt meant a new TCP+TLS handshake for every page: at 12
        workers that is a handshake storm, and TLS handshakes were timing out under it.
        The pool keeps connections warm; a failed attempt still retries, and retries ask
        for a new connection so a dead pooled one cannot poison the next try.
        """
        last = ""
        for attempt in range(MAX_RETRIES):
            try:
                headers = {"User-Agent": UA, "Referer": "https://18comic.vip/"}
                if attempt:
                    headers["Connection"] = "close"
                resp = _page_client().get(url, headers=headers, timeout=PAGE_TIMEOUT)
                if resp.status_code == 200 and resp.content:
                    return resp.content
                last = "HTTP %s" % resp.status_code
            except Exception as exc:
                last = str(exc)
            time.sleep(0.25 * (attempt + 1))
        raise RuntimeError(last or "fetch failed")

    def _process(self, raw, task, page_name):
        """Return (bytes, width, height); the geometry is stored with the page."""
        mode = self.settings.get("cache_compression") or "minimal"
        if not is_scrambled(task.aid, task.scramble_id):
            if mode == "none":
                size, _mode = thumbs.probe_size(raw)
                return raw, (size[0] if size else 0), (size[1] if size else 0)
            img = thumbs._open(raw)
            width, height = img.size
            out = thumbs.recompress(img, mode)
            return (raw if len(out) >= len(raw) else out), width, height
        img = thumbs._open(raw)
        fixed = unscramble(img, task.aid, task.scramble_id, str(page_name))
        width, height = fixed.size
        lossless = thumbs.recompress(fixed, "none")
        if mode == "none":
            return lossless, width, height
        out = thumbs.recompress(fixed, mode)
        return (out if len(out) < len(lossless) else lossless), width, height

    def shutdown(self):
        self._stop = True
        self._wake.set()
        self._executor.shutdown(wait=False)
