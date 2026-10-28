"""Runtime settings, persisted as JSON."""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
# Portable by default: everything lives next to the code unless JMBRIDGE_HOME says otherwise.
DEFAULT_DATA_DIR = Path(os.environ.get("JMBRIDGE_HOME") or (APP_DIR / "data"))

COMPRESSION_MODES = {
    "none": {"label": "无压缩", "quality": None, "max_width": None},
    "minimal": {"label": "最小损失", "quality": 92, "max_width": 1600},
    "medium": {"label": "中等", "quality": 78, "max_width": 1280},
    "max": {"label": "最省空间", "quality": 55, "max_width": 960},
}

DEFAULTS = {
    "cache_limit_mb": 2048,
    "cache_compression": "minimal",
    "active_lines": 3,
    "max_lines": 3,
    "pinned_host": "",
    "lang": "TW",
    "prefer_webp": True,
    "stream_first_pages": 3,
}


class Settings:
    def __init__(self, data_dir: Path | None = None):
        self.data_dir = Path(data_dir or DEFAULT_DATA_DIR)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.path = self.data_dir / "settings.json"
        self._lock = threading.RLock()
        self._data = dict(DEFAULTS)
        self._load()

    def _load(self):
        if self.path.exists():
            try:
                raw = json.loads(self.path.read_text("utf-8"))
                if isinstance(raw, dict):
                    for key, val in raw.items():
                        if key in DEFAULTS:
                            self._data[key] = val
            except Exception:
                pass

    def save(self):
        with self._lock:
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self._data, ensure_ascii=False, indent=2), "utf-8")
            tmp.replace(self.path)

    def get(self, key, default=None):
        with self._lock:
            return self._data.get(key, DEFAULTS.get(key, default))

    def update(self, patch: dict) -> dict:
        with self._lock:
            for key, val in patch.items():
                if key in DEFAULTS:
                    self._data[key] = val
            self.save()
            return dict(self._data)

    def as_dict(self) -> dict:
        with self._lock:
            return dict(self._data)

    @property
    def cache_dir(self) -> Path:
        p = self.data_dir / "cache"
        p.mkdir(parents=True, exist_ok=True)
        return p

    @property
    def db_path(self) -> Path:
        return self.data_dir / "cache.db"
