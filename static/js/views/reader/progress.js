// Progress reporting: throttled during reading, guaranteed on exit.
import { api } from "../../api.js";

export function createProgressReporter(meta) {
  const info = meta || {};
  let timer = 0;
  let lastSent = { page: 0, at: 0 };
  let queuedPage = 0;
  let destroyed = false;

  function payload(page) {
    return {
      cid: info.cid,
      aid: info.aid || "",
      title: info.title || "",
      album: info.album || "",
      page: Math.max(1, Math.round(page || 1)),
      total: info.total || 0,
    };
  }

  function send(page, force) {
    if (destroyed) return;
    const next = Math.max(1, Math.round(page || 1));
    const now = Date.now();
    if (!force && next === lastSent.page && now - lastSent.at < 15000) return;
    lastSent = { page: next, at: now };
    api.progressSet(payload(next)).catch(() => {
      /* the next tick will retry; losing one beat is invisible to the reader */
    });
  }

  return {
    // Called on every page change; coalesces bursts into one request.
    report(page) {
      queuedPage = page;
      if (timer) return;
      timer = setTimeout(() => {
        timer = 0;
        send(queuedPage, false);
      }, 800);
    },
    flush(page) {
      if (timer) {
        clearTimeout(timer);
        timer = 0;
      }
      const target = page || queuedPage || lastSent.page || 1;
      lastSent = { page: Math.round(target), at: Date.now() };
      // sendBeacon survives a tab close where fetch would be dropped.
      const body = JSON.stringify(payload(target));
      try {
        if (navigator.sendBeacon) {
          navigator.sendBeacon("/api/progress", new Blob([body], { type: "application/json" }));
          return;
        }
      } catch (err) {
        /* fall through to fetch */
      }
      api.progressSet(payload(target)).catch(() => {});
    },
    destroy() {
      destroyed = true;
      if (timer) clearTimeout(timer);
      timer = 0;
    },
  };
}
