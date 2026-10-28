"""Cover fetching, entirely off the request path.

A grid asks for thirty covers at once. Serving that per request meant thirty CDN calls
racing thirty <img> tags, and each one could park a worker thread on a slow CDN. Here a
request only reads the cache or records a want; a small worker pool fetches, stores, and
publishes an event, so a tile points at its image the moment the bytes exist.
"""
from __future__ import annotations

import threading
import time
from collections import deque
from itertools import count

COVER_ATTEMPTS = 3


class CoverQueue:
    def __init__(self, cache, pool, fetch_bytes, hub, workers=4, timeout=15.0, limiter=None):
        self.cache = cache
        self.limiter = limiter
        self.pool = pool
        self.fetch_bytes = fetch_bytes
        self.hub = hub
        self.timeout = timeout
        self._lock = threading.Lock()
        self._pending = deque()      # FIFO: the top of a grid loads first
        self._queued = set()
        self._inflight = set()
        self._failed = {}          # pair -> attempts, drives the retry budget
        self._failure_info = {}    # pair -> {reason, attempts, code, at} for the UI
        self._max_pending = max(32, int(workers) * 64)
        self._batch_ids = count(1)
        self._batches = {}
        self._pair_batches = {}
        self._priority = 0
        self._stop = False
        self._wake = threading.Event()
        self._threads = [
            threading.Thread(target=self._loop, daemon=True, name="cover-%d" % i)
            for i in range(max(1, int(workers)))
        ]
        for thread in self._threads:
            thread.start()

    # ---------- keys ----------
    @staticmethod
    def key(aid, size):
        return "cover|{}|{}".format(aid, size)

    @staticmethod
    def _reason(exc):
        """A short, user-facing reason instead of a raw traceback string."""
        text = str(exc or "").strip()
        low = text.lower()
        if "timeout" in low or "timed out" in low:
            return "图片服务器响应超时"
        if "404" in text:
            return "该作品没有可用的封面图"
        if "403" in text or "401" in text:
            return "图片服务器拒绝了请求"
        if "429" in text:
            return "图片服务器请求过多，被限流"
        if "non-image" in low:
            return "图片服务器返回了非图片内容"
        if "empty response" in low:
            return "图片服务器返回了空内容"
        if "http" in low:
            return "图片服务器返回错误：" + text[:80]
        if "ssl" in low or "certificate" in low:
            return "与图片服务器的安全连接失败"
        if "connect" in low or "network" in low or "name" in low:
            return "无法连接图片服务器"
        return text[:80] or "封面图获取失败"

    def failure(self, aid, size):
        """Why this cover is not available yet, and how many attempts it has used.

        Returns None when the pair is not failing, so a tile can tell "still working"
        (503) apart from "gave up" (a terminal reason the user can read).
        """
        with self._lock:
            info = self._failure_info.get((str(aid), int(size or 360)))
            if not info:
                return None
            attempts = self._failed.get((str(aid), int(size or 360)), info.get("attempts", 0))
            return {
                "reason": info.get("reason") or "封面图获取失败",
                "code": info.get("code") or "cover_fetch_failed",
                "attempts": int(attempts),
                "max_attempts": COVER_ATTEMPTS,
                "exhausted": attempts >= COVER_ATTEMPTS,
            }

    def _stored(self, aid, size):
        # Metadata only: a 30KB file read per tile per status call would be the same cost
        # the cache was supposed to remove. A row exists only while its file does.
        return bool(self.cache.get_meta("thumb", self.key(aid, size)))

    # ---------- reads (request path, never remote) ----------
    def read(self, aid, size):
        """Cached bytes, or None. Never fetches.

        A row whose file vanished is dropped by the cache itself, so a None here really
        means "not stored" and the caller may queue it again.
        """
        return self.cache.get_bytes("thumb", self.key(aid, size))

    def status(self, aids, size):
        aids = [str(aid) for aid in aids if str(aid)]
        present = self.cache.has_many("thumb", [self.key(aid, size) for aid in aids])
        return {aid: self.key(aid, size) in present for aid in aids}

    # ---------- scheduling ----------
    def want(self, aid, size):
        """Ask for a cover. Returns True when this call queued new work."""
        aid = str(aid)
        size = int(size or 360)
        if self._stored(aid, size):
            return False
        pair = (aid, size)
        with self._lock:
            if pair in self._queued or pair in self._inflight:
                return False
            if self._failed.get(pair, 0) >= COVER_ATTEMPTS:
                return False
            if len(self._pending) >= self._max_pending:
                return False
            self._queued.add(pair)
            self._pending.append(pair)
        self._wake.set()
        return True

    def want_many(self, aids, size):
        """Queue covers in visual task batches of six items (3 columns by 2 rows)."""
        size = int(size or 360)
        aids = list(dict.fromkeys(str(aid) for aid in aids if str(aid)))
        present = self.cache.has_many("thumb", [self.key(aid, size) for aid in aids])
        missing = [aid for aid in aids if self.key(aid, size) not in present]
        queued = 0
        for start in range(0, len(missing), 6):
            group = missing[start:start + 6]
            batch_id = "cover-{}".format(next(self._batch_ids))
            with self._lock:
                self._priority += 1
                self._batches[batch_id] = {"id": batch_id, "type": "covers", "title": "封面预缓存",
                                           "aids": group, "size": size, "priority": self._priority,
                                           "created": time.time()}
            for aid in group:
                pair = (aid, size)
                with self._lock:
                    if (pair in self._queued or pair in self._inflight
                            or self._failed.get(pair, 0) >= COVER_ATTEMPTS
                            or len(self._pending) >= self._max_pending):
                        continue
                    self._queued.add(pair)
                    self._pair_batches[pair] = batch_id
                    self._pending.append(pair)
                    queued += 1
        if queued:
            self._wake.set()
        return queued

    def retry_failed(self, aids, size):
        """Forget the spent retry budget for these covers and queue them again."""
        size = int(size or 360)
        rearmed = 0
        for aid in dict.fromkeys(str(a) for a in (aids or []) if str(a)):
            pair = (aid, size)
            if self._stored(aid, size):
                continue
            with self._lock:
                self._failed.pop(pair, None)
                self._failure_info.pop(pair, None)
            if self.want(aid, size):
                rearmed += 1
        return rearmed

    def task_snapshot(self):
        out = []
        with self._lock:
            batches = list(self._batches.values())
            queued = set(self._queued)
            inflight = set(self._inflight)
        for batch in batches:
            aids = batch["aids"]
            done = sum(1 for aid in aids if self._stored(aid, batch["size"]))
            active = sum(1 for aid in aids if (aid, batch["size"]) in queued or (aid, batch["size"]) in inflight)
            state = "done" if done == len(aids) else ("running" if active else "pending")
            out.append({**batch, "state": state, "total": len(aids), "done": done,
                        "failed": sum(self._failed.get((aid, batch["size"]), 0) >= COVER_ATTEMPTS for aid in aids),
                        "progress": round(done / len(aids), 4) if aids else 1.0,
                        "bytes": 0})
        return sorted(out, key=lambda item: (-item["priority"], item["created"]))

    def set_priority(self, batch_id, priority):
        with self._lock:
            batch = self._batches.get(str(batch_id))
            if not batch:
                return False
            batch["priority"] = max(0, min(9999, int(priority)))
            return True

    # ---------- workers ----------
    def _take(self):
        with self._lock:
            while self._pending:
                best_index = max(range(len(self._pending)), key=lambda index: self._batches.get(
                    self._pair_batches.get(self._pending[index]), {}).get("priority", 0))
                pair = self._pending[best_index]
                del self._pending[best_index]
                self._queued.discard(pair)
                if self._failed.get(pair, 0) >= COVER_ATTEMPTS or pair in self._inflight:
                    continue
                self._inflight.add(pair)
                return pair
        return None

    def _loop(self):
        while not self._stop:
            pair = self._take()
            if pair is None:
                self._wake.wait(0.5)
                self._wake.clear()
                continue
            aid, size = pair
            with self._lock:
                batch_id = self._pair_batches.get(pair, "")
            ok = False
            attempts = 0
            try:
                line = self.pool.pick_image_line()
                if self.limiter is not None:
                    self.limiter.acquire()
                self.pool.acquire(line)
                try:
                    url = "{}/media/albums/{}_3x4.jpg".format(line.img_host.rstrip("/"), aid)
                    body = self.fetch_bytes(url, timeout=self.timeout, attempts=2)
                    self.cache.put_bytes("thumb", self.key(aid, size), body,
                                         {"kind": "cover", "aid": aid, "size": size})
                    ok = True
                finally:
                    self.pool.release(line, ok=ok)
                    if self.limiter is not None:
                        self.limiter.release()
            except Exception as exc:
                with self._lock:
                    attempts = self._failed.get(pair, 0) + 1
                    self._failed[pair] = attempts
                    # Keep the reason so the UI can say why, not just "failed".
                    self._failure_info[pair] = {
                        "reason": self._reason(exc),
                        "code": "cover_fetch_failed",
                        "attempts": attempts,
                        "at": time.time(),
                    }
            finally:
                with self._lock:
                    self._inflight.discard(pair)
                    if ok:
                        self._failed.pop(pair, None)
                        self._failure_info.pop(pair, None)
                    if ok or attempts >= COVER_ATTEMPTS:
                        self._pair_batches.pop(pair, None)
            if not ok and attempts < COVER_ATTEMPTS:
                time.sleep(min(2.0, 0.25 * attempts))
                with self._lock:
                    if not self._stop and pair not in self._queued:
                        self._queued.add(pair)
                        self._pending.append(pair)
                self._wake.set()
            # Tell every open view at once; the tile then requests a cache hit.
            payload = {"aid": aid, "size": size, "ok": ok}
            if not ok:
                payload["failure"] = self.failure(aid, size)
            self.hub.publish("covers", payload)
            self.hub.publish("tasks", {"id": batch_id, "type": "covers", **payload})

    def stats(self):
        with self._lock:
            return {"pending": len(self._pending), "inflight": len(self._inflight),
                    "failed": len(self._failed)}

    def shutdown(self):
        self._stop = True
        self._wake.set()
