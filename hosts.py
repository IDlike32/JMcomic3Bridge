"""Line (host) discovery, health scoring and aggregation.

The Android client bootstraps its host list from a remote encrypted document,
then measures each line. We do the same, but keep the best three alive and
spread work across them.
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field

import httpx

from protocol import decrypt_host_list

DISCOVERY_URLS = (
    "https://rup4a04-c02.tos-cn-hongkong.bytepluses.com/newsvr-2025.txt",
    "https://rup4a04-c01.tos-ap-southeast-1.bytepluses.com/newsvr-2025.txt",
)

# Used only when discovery is unreachable.
FALLBACK_HOSTS = [
    ("www.cdnhjk.net", "線路1"),
    ("www.cdnutc.cc", "線路2"),
    ("www.cdngwc.net", "線路3"),
    ("www.cdngwc.club", "線路4"),
    ("www.cdnutc.me", "線路5"),
]

UA = (
    "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
)


@dataclass
class Line:
    host: str
    label: str = ""
    ok: bool = False
    latency_ms: float | None = None
    failures: int = 0
    inflight: int = 0
    total_requests: int = 0
    last_checked: float = 0.0
    last_error: str = ""
    img_host: str = ""
    main_web_host: str = ""

    def to_dict(self) -> dict:
        return {
            "host": self.host,
            "label": self.label,
            "ok": self.ok,
            "latency_ms": None if self.latency_ms is None else round(self.latency_ms, 1),
            "failures": self.failures,
            "inflight": self.inflight,
            "total_requests": self.total_requests,
            "last_checked": self.last_checked,
            "last_error": self.last_error,
            "img_host": self.img_host,
            "main_web_host": self.main_web_host,
        }

    def score(self) -> float:
        """Lower is better. Penalise failures and current load."""
        if not self.ok:
            return 1e9
        base = self.latency_ms if self.latency_ms is not None else 2500.0
        return base + self.failures * 800 + self.inflight * 150


@dataclass
class LinePool:
    max_active: int = 3
    _lock: threading.RLock = field(default_factory=threading.RLock)
    _lines: dict = field(default_factory=dict)
    _order: list = field(default_factory=list)
    _last_discovery: float = 0.0

    # ---------- discovery ----------
    def discover(self, force: bool = False) -> list:
        with self._lock:
            if not force and self._lines and (time.time() - self._last_discovery) < 3600:
                return list(self._order)

        found = None
        for url in DISCOVERY_URLS:
            try:
                resp = httpx.get(url, timeout=12.0, headers={"User-Agent": UA})
                if resp.status_code != 200:
                    continue
                data = decrypt_host_list(resp.text)
                if data and data.get("Server"):
                    found = data
                    break
            except Exception:
                continue

        if found:
            servers = found.get("Server") or []
            labelled = {h: lab for h, lab in (found.get("jm3_Server") or [])}
            pairs = [(h, labelled.get(h, "")) for h in servers]
        else:
            pairs = list(FALLBACK_HOSTS)

        with self._lock:
            for host, label in pairs:
                if host not in self._lines:
                    self._lines[host] = Line(host=host, label=label)
                elif label and not self._lines[host].label:
                    self._lines[host].label = label
            self._order = [h for h, _ in pairs]
            self._last_discovery = time.time()
            return list(self._order)

    # ---------- health ----------
    def probe_all(self, limit: int | None = None) -> list:
        hosts = self.discover()
        if limit:
            hosts = hosts[:limit]
        for host in hosts:
            self.probe(host)
        return self.active_lines()

    def probe(self, host: str) -> Line:
        line = self._lines.get(host)
        if line is None:
            line = Line(host=host)
            with self._lock:
                self._lines[host] = line

        from client import JMClient  # local import avoids a cycle

        client = JMClient(self, host=host)
        started = time.perf_counter()
        try:
            payload = client.request("setting", {"app_img_shunt": "1"}, ts_override=None)
            elapsed = (time.perf_counter() - started) * 1000
            data = payload.get("data") if isinstance(payload, dict) else None
            line.ok = True
            line.latency_ms = elapsed
            line.failures = 0
            line.last_error = ""
            if isinstance(data, dict):
                line.img_host = data.get("img_host") or ""
                line.main_web_host = data.get("main_web_host") or ""
        except Exception as exc:
            line.ok = False
            line.failures += 1
            line.latency_ms = None
            line.last_error = str(exc)[:200]
        line.last_checked = time.time()
        return line

    # ---------- selection ----------
    def active_lines(self) -> list:
        with self._lock:
            lines = [self._lines[h] for h in self._order if h in self._lines]
        healthy = [ln for ln in lines if ln.ok]
        healthy.sort(key=lambda ln: ln.score())
        # Keep the pinned host in front when the user chose a line manually.
        picked = healthy[: self.max_active]
        if not picked:
            picked = sorted(lines, key=lambda ln: ln.failures)[: self.max_active]
        return picked

    def pick(self, pinned: str | None = None) -> Line:
        with self._lock:
            if pinned:
                line = self._lines.get(pinned)
                if line is not None:
                    return line
                line = Line(host=pinned)
                self._lines[pinned] = line
                return line
        candidates = self.active_lines()
        if not candidates:
            self.discover(force=True)
            self.probe_all(limit=self.max_active)
            candidates = self.active_lines()
        if not candidates:
            raise RuntimeError("no reachable JM line")
        return candidates[0]

    def pick_image_line(self) -> Line:
        """Least-loaded image line; image traffic is what needs spreading."""
        candidates = [ln for ln in self.active_lines() if ln.img_host]
        if not candidates:
            for line in self.active_lines():
                if not line.img_host:
                    try:
                        self.probe(line.host)
                    except Exception:
                        pass
            candidates = [ln for ln in self.active_lines() if ln.img_host]
        if not candidates:
            raise RuntimeError("no line exposes img_host")
        candidates.sort(key=lambda ln: (ln.inflight, ln.latency_ms or 9999))
        return candidates[0]

    def acquire(self, line: Line):
        with self._lock:
            line.inflight += 1
            line.total_requests += 1

    def release(self, line: Line, ok: bool = True):
        with self._lock:
            line.inflight = max(0, line.inflight - 1)
            if ok:
                line.failures = 0
            else:
                line.failures += 1
                if line.failures >= 3:
                    line.ok = False

    def get(self, host: str) -> Line | None:
        with self._lock:
            return self._lines.get(host)

    def snapshot(self) -> dict:
        active = [ln.host for ln in self.active_lines()]
        with self._lock:
            lines = [self._lines[h].to_dict() for h in self._order if h in self._lines]
        for entry in lines:
            entry["active"] = entry["host"] in active
        return {"lines": lines, "active": active, "last_discovery": self._last_discovery}
