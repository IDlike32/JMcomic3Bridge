"""Disk cache with SQLite accounting and LRU eviction.

Kinds: search (full result payloads), thumb (covers), pages (comic pages), zip (archives).
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
import time
from pathlib import Path

KINDS = ("search", "thumb", "pages", "zip", "prog")


def _hash(key: str) -> str:
    return hashlib.sha1(key.encode("utf-8")).hexdigest()


class Cache:
    def __init__(self, settings):
        self.settings = settings
        self.eviction_context = None
        self.root = settings.cache_dir
        self.db_path = settings.db_path
        self._lock = threading.RLock()
        self._touched = {}
        self._touched_at = time.time()
        self._bytes = 0
        self._conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute(
            "CREATE TABLE IF NOT EXISTS blobs ("
            " key TEXT PRIMARY KEY, kind TEXT NOT NULL, path TEXT NOT NULL,"
            " size INTEGER NOT NULL, created REAL NOT NULL, accessed REAL NOT NULL, meta TEXT)"
        )
        self._conn.execute("CREATE INDEX IF NOT EXISTS idx_kind ON blobs(kind)")
        self._conn.execute("CREATE INDEX IF NOT EXISTS idx_accessed ON blobs(accessed)")
        self._conn.commit()
        for kind in KINDS:
            (self.root / kind).mkdir(parents=True, exist_ok=True)
        # Start from the real total, so the first write already knows how full we are.
        self._bytes = self.total_size()

    def _path_for(self, kind: str, key: str) -> Path:
        return self.root / kind / _hash(key)

    def get_path(self, kind: str, key: str):
        """Look a blob up without writing.

        Every read used to UPDATE accessed and commit while holding the cache lock, so a
        reader loading pages turned each hit into a transaction that the download workers
        had to queue behind. Touches are now collected in memory and flushed in batches;
        the on-disk path is trusted instead of stat()ing it on every hit.
        """
        full = kind + "|" + key
        with self._lock:
            row = self._conn.execute("SELECT path FROM blobs WHERE key=?", (full,)).fetchone()
            if not row:
                return None
            path = Path(row[0])
            self._touch(full)
            return path

    def get_bytes(self, kind: str, key: str):
        path = self.get_path(kind, key)
        if path is None:
            return None
        try:
            return path.read_bytes()
        except Exception:
            # The row outlived its file (deleted outside the app, or a half-written
            # blob). Drop it so "has metadata" and "can be read" cannot disagree --
            # callers use the former to decide whether to queue a re-fetch.
            self.delete_key(kind, key)
            return None

    def get_json(self, kind: str, key: str):
        raw = self.get_bytes(kind, key)
        if raw is None:
            return None
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return None

    def get_meta(self, kind: str, key: str) -> dict:
        """Metadata only -- lets the reader learn page geometry without reading the blob."""
        full = kind + "|" + key
        with self._lock:
            row = self._conn.execute("SELECT meta FROM blobs WHERE key=?", (full,)).fetchone()
        if not row or not row[0]:
            return {}
        try:
            return json.loads(row[0])
        except Exception:
            return {}

    def has_many(self, kind: str, keys) -> set:
        """Return present keys with one bounded SQLite query."""
        keys = list(dict.fromkeys(str(key) for key in keys if key))
        if not keys:
            return set()
        full_keys = [kind + "|" + key for key in keys]
        found = set()
        with self._lock:
            for start in range(0, len(full_keys), 400):
                chunk = full_keys[start:start + 400]
                placeholders = ",".join("?" for _ in chunk)
                rows = self._conn.execute(
                    "SELECT key FROM blobs WHERE key IN (" + placeholders + ")", chunk
                ).fetchall()
                found.update(row[0] for row in rows)
        return {key.split("|", 1)[1] for key in found}

    def put_bytes(self, kind: str, key: str, data: bytes, meta=None) -> Path:
        path = self._path_for(kind, key)
        tmp = path.with_suffix(".tmp")
        tmp.write_bytes(data)
        tmp.replace(path)
        self._record(kind, key, path, len(data), meta)
        return path

    def put_json(self, kind: str, key: str, obj, meta=None) -> Path:
        raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        return self.put_bytes(kind, key, raw, meta)

    def _record(self, kind, key, path, size, meta):
        now = time.time()
        full = kind + "|" + key
        with self._lock:
            previous = self._conn.execute("SELECT size FROM blobs WHERE key=?", (full,)).fetchone()
            self._conn.execute(
                "INSERT INTO blobs(key,kind,path,size,created,accessed,meta) VALUES(?,?,?,?,?,?,?) "
                "ON CONFLICT(key) DO UPDATE SET path=excluded.path, size=excluded.size, "
                "accessed=excluded.accessed, meta=excluded.meta",
                (full, kind, str(path), size, now, now, json.dumps(meta or {}, ensure_ascii=False)),
            )
            self._conn.commit()
            limit_bytes = int(self.settings.get("cache_limit_mb") or 0) * 1024 * 1024
            self._bytes += size - int(previous[0]) if previous else size
            over = limit_bytes > 0 and self._bytes > limit_bytes
        # A full-table size check per stored page was itself a hot spot: only evict when
        # the running total says we are over the limit.
        if over:
            self.enforce_limit()

    # ---- access-time batching ----
    _TOUCH_FLUSH_SECONDS = 5.0
    _TOUCH_FLUSH_ROWS = 128

    def _touch(self, full: str):
        """Record a hit in memory; the lock is already held by the caller."""
        self._touched[full] = time.time()
        if (len(self._touched) >= self._TOUCH_FLUSH_ROWS
                or time.time() - self._touched_at >= self._TOUCH_FLUSH_SECONDS):
            self._flush_touches()

    def _flush_touches(self):
        """Write the pending access times in one transaction (lock held)."""
        if not self._touched:
            self._touched_at = time.time()
            return
        rows = list(self._touched.items())
        self._touched.clear()
        self._touched_at = time.time()
        try:
            self._conn.executemany("UPDATE blobs SET accessed=? WHERE key=?",
                                   [(ts, full) for full, ts in rows])
            self._conn.commit()
        except Exception:
            pass

    def touch_flush(self):
        """Public flush point for callers that just finished a burst of reads."""
        with self._lock:
            self._flush_touches()

    def total_size(self) -> int:
        with self._lock:
            row = self._conn.execute("SELECT COALESCE(SUM(size),0) FROM blobs").fetchone()
            return int(row[0] or 0)

    def enforce_limit(self):
        limit = int(self.settings.get("cache_limit_mb") or 0) * 1024 * 1024
        if limit <= 0:
            return
        total = self.total_size()
        self._bytes = total
        if total <= limit:
            return
        target = int(limit * 0.9)
        with self._lock:
            rows = self._conn.execute(
                "SELECT key, path, size, kind, meta, accessed FROM blobs ORDER BY accessed ASC"
            ).fetchall()
            context = self.eviction_context() if callable(self.eviction_context) else {}
            favorites = context.get("favorites", set())
            progress = context.get("progress", {})
            def eviction_rank(row):
                key, _path, _size, kind, raw_meta, accessed = row
                if kind != "pages":
                    return (2, float(accessed or 0))
                try:
                    meta = json.loads(raw_meta) if raw_meta else {}
                except Exception:
                    meta = {}
                aid = str(meta.get("aid") or "")
                if aid in favorites:
                    return (3, float(accessed or 0))
                signal = progress.get(aid)
                if signal is not None:
                    ratio, updated = signal
                    return (0, float(ratio), float(updated), float(accessed or 0))
                return (1, float(accessed or 0))
            rows.sort(key=eviction_rank)
            freed = 0
            need = self.total_size() - target
            for key, path, size, _kind, _meta, _accessed in rows:
                if freed >= need:
                    break
                try:
                    Path(path).unlink(missing_ok=True)
                except Exception:
                    pass
                self._conn.execute("DELETE FROM blobs WHERE key=?", (key,))
                freed += size
            self._conn.commit()

    def stats(self) -> dict:
        with self._lock:
            rows = self._conn.execute(
                "SELECT kind, COUNT(*), COALESCE(SUM(size),0) FROM blobs GROUP BY kind"
            ).fetchall()
        by_kind = {kind: {"count": 0, "bytes": 0} for kind in KINDS}
        for kind, count, size in rows:
            by_kind[kind] = {"count": count, "bytes": size}
        total = sum(v["bytes"] for v in by_kind.values())
        limit = int(self.settings.get("cache_limit_mb") or 0) * 1024 * 1024
        return {"total_bytes": total, "limit_bytes": limit, "by_kind": by_kind}

    def clear(self, kind=None) -> int:
        with self._lock:
            if kind:
                rows = self._conn.execute("SELECT key, path FROM blobs WHERE kind=?", (kind,)).fetchall()
            else:
                rows = self._conn.execute("SELECT key, path FROM blobs").fetchall()
            for key, path in rows:
                try:
                    Path(path).unlink(missing_ok=True)
                except Exception:
                    pass
            if kind:
                self._conn.execute("DELETE FROM blobs WHERE kind=?", (kind,))
            else:
                self._conn.execute("DELETE FROM blobs")
            self._conn.commit()
            # Recompute instead of zeroing: zero would make the eviction check never fire.
            self._bytes = self.total_size()
        return len(rows)

    def delete_prefix(self, prefix: str, kind=None) -> int:
        with self._lock:
            sql = "SELECT key, path FROM blobs WHERE key LIKE ?"
            args = [prefix + "%"]
            if kind:
                sql += " AND kind=?"
                args.append(kind)
            rows = self._conn.execute(sql, args).fetchall()
            for key, path in rows:
                try:
                    Path(path).unlink(missing_ok=True)
                except Exception:
                    pass
                self._conn.execute("DELETE FROM blobs WHERE key=?", (key,))
            self._conn.commit()
            self._bytes = self.total_size()
        return len(rows)

    def list_prefix(self, kind: str, prefix: str, limit: int = 5000) -> list:
        """Entries of one kind whose key starts with prefix, via an index range scan.

        The reader asks "which pages of this chapter are cached?" on every status call;
        scanning the whole kind (thousands of rows, each with parsed JSON) was the wrong
        shape for a question with an obvious prefix.
        """
        low = kind + "|" + prefix
        high = low[:-1] + chr(ord(low[-1]) + 1) if low else low
        with self._lock:
            rows = self._conn.execute(
                "SELECT key, size, meta FROM blobs WHERE key >= ? AND key < ? LIMIT ?",
                (low, high, limit),
            ).fetchall()
        out = []
        for key, size, meta in rows:
            try:
                meta_obj = json.loads(meta) if meta else {}
            except Exception:
                meta_obj = {}
            out.append({"key": key, "size": size, "meta": meta_obj})
        return out

    def list_entries(self, kind: str, limit: int = 500, offset: int = 0) -> list:
        with self._lock:
            rows = self._conn.execute(
                "SELECT key, size, created, accessed, meta FROM blobs WHERE kind=? "
                "ORDER BY accessed DESC LIMIT ? OFFSET ?",
                (kind, limit, offset),
            ).fetchall()
        out = []
        for key, size, created, accessed, meta in rows:
            try:
                meta_obj = json.loads(meta) if meta else {}
            except Exception:
                meta_obj = {}
            out.append({"key": key, "size": size, "created": created,
                        "accessed": accessed, "meta": meta_obj})
        return out

    def delete_key(self, kind: str, key: str) -> int:
        """Remove exactly one entry (used by per-item delete buttons)."""
        full = kind + "|" + key
        with self._lock:
            row = self._conn.execute("SELECT path FROM blobs WHERE key=?", (full,)).fetchone()
            if not row:
                return 0
            try:
                Path(row[0]).unlink(missing_ok=True)
            except Exception:
                pass
            size = self._conn.execute(
                "SELECT size FROM blobs WHERE key=?", (full,)).fetchone()
            self._conn.execute("DELETE FROM blobs WHERE key=?", (full,))
            self._conn.commit()
            if size:
                self._bytes = max(0, self._bytes - int(size[0] or 0))
        return 1

    def close(self):
        # Do not lose the last few access times when the reader stops.
        try:
            self.touch_flush()
        except Exception:
            pass
        try:
            self._conn.close()
        except Exception:
            pass
