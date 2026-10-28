"""In-process event fan-out: workers publish, request coroutines consume.

The loading pipeline is cache-first, so the only question the UI ever asks is "is this
stored yet?". Polling that question costs a request per second per view and still lags by
up to a second. Instead the worker that stores a page (or a cover) says so once, and every
open view reacts immediately: one event per stored object, zero polling.
"""
from __future__ import annotations

import asyncio
import threading

# A slow or hidden tab must never grow an unbounded buffer; stale events are worthless
# once newer ones exist, so the oldest is dropped instead of the newest.
_MAX_QUEUE = 512


class Hub:
    def __init__(self):
        self._lock = threading.Lock()
        self._subs = {}   # id(token) -> (loop, queue, topics, token)

    def subscribe(self, topics=("pages", "covers")):
        """Register from the event loop; returns (token, queue)."""
        loop = asyncio.get_running_loop()
        queue = asyncio.Queue(maxsize=_MAX_QUEUE)
        token = object()
        with self._lock:
            self._subs[id(token)] = (loop, queue, frozenset(topics), token)
        return token, queue

    def unsubscribe(self, token):
        with self._lock:
            self._subs.pop(id(token), None)

    def publish(self, topic, event):
        """Publish from any thread (worker threads included)."""
        payload = dict(event)
        payload["topic"] = topic
        with self._lock:
            subs = list(self._subs.values())
        for loop, queue, topics, _token in subs:
            if topic not in topics:
                continue
            try:
                loop.call_soon_threadsafe(_offer, queue, payload)
            except RuntimeError:
                continue   # loop already closed: the subscriber is gone

    def subscribers(self):
        with self._lock:
            return len(self._subs)


def _offer(queue, payload):
    if queue.full():
        try:
            queue.get_nowait()
        except Exception:
            pass
    try:
        queue.put_nowait(payload)
    except Exception:
        pass
