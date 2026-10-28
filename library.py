"""Reading progress and favourites, kept apart from the blob cache.

The cache is disposable (LRU-evicted); this file is the opposite: it is the small
amount of state the reader must never lose, so it lives in its own SQLite file.
"""
from __future__ import annotations

import sqlite3
import threading
import time
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS progress (
    cid      TEXT PRIMARY KEY,
    aid      TEXT NOT NULL DEFAULT '',
    title    TEXT NOT NULL DEFAULT '',
    album    TEXT NOT NULL DEFAULT '',
    page     INTEGER NOT NULL DEFAULT 1,
    total    INTEGER NOT NULL DEFAULT 0,
    finished INTEGER NOT NULL DEFAULT 0,
    updated  REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS favorites (
    aid    TEXT PRIMARY KEY,
    title  TEXT NOT NULL DEFAULT '',
    author TEXT NOT NULL DEFAULT '',
    added  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_progress_updated ON progress(updated DESC);
"""


class Library:
    def __init__(self, data_dir: Path):
        data_dir = Path(data_dir)
        data_dir.mkdir(parents=True, exist_ok=True)
        self.path = data_dir / "library.db"
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(str(self.path), check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.executescript(SCHEMA)
        self._conn.commit()

    # ------------------------------------------------------------ progress
    def set_progress(self, cid, page, total=0, aid="", title="", album=""):
        cid = str(cid)
        page = max(1, int(page or 1))
        total = max(0, int(total or 0))
        now = time.time()
        finished = 1 if total and page >= total else 0
        with self._lock:
            self._conn.execute(
                "INSERT INTO progress(cid,aid,title,album,page,total,finished,updated) "
                "VALUES(?,?,?,?,?,?,?,?) "
                "ON CONFLICT(cid) DO UPDATE SET "
                "  page=excluded.page,"
                "  total=CASE WHEN excluded.total>0 THEN excluded.total ELSE progress.total END,"
                "  finished=excluded.finished,"
                "  updated=excluded.updated,"
                "  aid=CASE WHEN excluded.aid<>'' THEN excluded.aid ELSE progress.aid END,"
                "  title=CASE WHEN excluded.title<>'' THEN excluded.title ELSE progress.title END,"
                "  album=CASE WHEN excluded.album<>'' THEN excluded.album ELSE progress.album END",
                (cid, aid or "", title or "", album or "", page, total, finished, now),
            )
            self._conn.commit()
        return self.get_progress(cid)

    def get_progress(self, cid):
        with self._lock:
            row = self._conn.execute(
                "SELECT cid,aid,title,album,page,total,finished,updated FROM progress WHERE cid=?",
                (str(cid),),
            ).fetchone()
        return self._row_to_progress(row)

    def recent(self, limit=20):
        with self._lock:
            rows = self._conn.execute(
                "SELECT cid,aid,title,album,page,total,finished,updated FROM progress "
                "ORDER BY updated DESC LIMIT ?",
                (max(1, int(limit)),),
            ).fetchall()
        return [r for r in (self._row_to_progress(row) for row in rows) if r]

    def series_progress(self, aid):
        """Every chapter progress row belonging to one album (for the album page)."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT cid,aid,title,album,page,total,finished,updated FROM progress "
                "WHERE aid=? ORDER BY updated DESC",
                (str(aid),),
            ).fetchall()
        return [r for r in (self._row_to_progress(row) for row in rows) if r]

    def delete_progress(self, cid):
        with self._lock:
            cur = self._conn.execute("DELETE FROM progress WHERE cid=?", (str(cid),))
            self._conn.commit()
            return cur.rowcount

    def delete_series_progress(self, aid):
        with self._lock:
            cur = self._conn.execute("DELETE FROM progress WHERE aid=?", (str(aid),))
            self._conn.commit()
            return cur.rowcount

    def clear_progress(self):
        with self._lock:
            cur = self._conn.execute("DELETE FROM progress")
            self._conn.commit()
            return cur.rowcount

    def _row_to_progress(self, row):
        if not row:
            return None
        cid, aid, title, album, page, total, finished, updated = row
        return {
            "cid": cid, "aid": aid, "title": title, "album": album,
            "page": page, "total": total, "finished": bool(finished),
            "updated": updated,
            "percent": round(page / total, 4) if total else 0.0,
        }

    # ----------------------------------------------------------- favourites
    def add_favorite(self, aid, title="", author=""):
        aid = str(aid)
        with self._lock:
            self._conn.execute(
                "INSERT INTO favorites(aid,title,author,added) VALUES(?,?,?,?) "
                "ON CONFLICT(aid) DO UPDATE SET "
                "  title=CASE WHEN excluded.title<>'' THEN excluded.title ELSE favorites.title END,"
                "  author=CASE WHEN excluded.author<>'' THEN excluded.author ELSE favorites.author END",
                (aid, title or "", author or "", time.time()),
            )
            self._conn.commit()
            row = self._conn.execute(
                "SELECT aid,title,author,added FROM favorites WHERE aid=?", (aid,)
            ).fetchone()
        return self._favorite(row)

    def remove_favorite(self, aid):
        with self._lock:
            cur = self._conn.execute("DELETE FROM favorites WHERE aid=?", (str(aid),))
            self._conn.commit()
            return cur.rowcount

    def is_favorite(self, aid):
        with self._lock:
            row = self._conn.execute("SELECT 1 FROM favorites WHERE aid=?", (str(aid),)).fetchone()
        return bool(row)

    def favorites(self):
        with self._lock:
            rows = self._conn.execute(
                "SELECT aid,title,author,added FROM favorites ORDER BY added DESC"
            ).fetchall()
        return [self._favorite(row) for row in rows]

    def _favorite(self, row):
        if not row:
            return None
        aid, title, author, added = row
        return {"aid": aid, "title": title, "author": author, "added": added}

    def stats(self):
        with self._lock:
            p = self._conn.execute("SELECT COUNT(*) FROM progress").fetchone()[0]
            f = self._conn.execute("SELECT COUNT(*) FROM favorites").fetchone()[0]
        return {"progress": p, "favorites": f}

    def cache_eviction_context(self):
        """Return lightweight reading signals for disposable page-cache eviction."""
        with self._lock:
            favorites = {str(row[0]) for row in self._conn.execute("SELECT aid FROM favorites").fetchall()}
            rows = self._conn.execute("SELECT aid, page, total, updated FROM progress").fetchall()
        progress = {}
        for aid, page, total, updated in rows:
            key = str(aid or "")
            if not key:
                continue
            ratio = (float(page) / float(total)) if total else 0.0
            old = progress.get(key)
            if old is None or (ratio, float(updated or 0)) > (old[0], old[1]):
                progress[key] = (ratio, float(updated or 0))
        return {"favorites": favorites, "progress": progress}

    def close(self):
        try:
            self._conn.close()
        except Exception:
            pass
