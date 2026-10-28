// Full-length vertical flow.
//
// Every page owns its node for the whole session: no viewport window, no mounting
// and unmounting while scrolling. A node is a placeholder until the page is in the
// cache, then its <img> is pointed at the local page URL and covers the placeholder.
//
// Loading is driven by the cache task, not by the scroll position: the reader feeds
// per-page states in (setStatuses), and pages whose bytes are ready go into a bounded
// queue. A chapter that is already fully cached therefore loads in one go.
import { el } from "../../ui.js";

const DEFAULT_RATIO = 0.7; // height / width, for pages we have no geometry for yet
// Page requests are local cache reads now (503 while the worker is still fetching), so the
// limit is about not flooding the server with sockets, not about protecting a CDN.
const CONCURRENCY = 4;
const RETRY_LIMIT = 10;

const VISUAL_CLASS = {
  idle: "st-idle",
  loading: "st-loading",
  cached: "st-cached",
  retry: "st-retry",
  failed: "st-failed",
  loaded: "st-loaded",
};
const VISUAL_TEXT = {
  idle: "未缓存",
  loading: "缓存中",
  cached: "已缓存",
  retry: "重试中",
  failed: "失败",
  loaded: "",
};

export function createFlow(options) {
  const opts = options || {};
  const scrollEl = opts.scrollEl;
  const flowEl = opts.flowEl;
  const endCard = opts.endCard || null;

  let total = 0;
  let prefs = opts.prefs || {};
  let ratios = [];
  let known = [];
  let heights = [];
  let tops = [];
  let nodes = [];
  let destroyed = false;
  let rafPending = 0;
  let lastFirstVisible = -1;
  let queue = [];
  let inflight = 0;

  function metrics() {
    return {
      width: Math.max(1, scrollEl.clientWidth),
      height: Math.max(1, scrollEl.clientHeight),
    };
  }

  function flowWidth() {
    return Math.round(metrics().width * (prefs.zoom || 1));
  }

  function heightFor(index) {
    const { width, height } = metrics();
    const ratio = ratios[index] || DEFAULT_RATIO;
    const fit = prefs.fit || "width";
    if (fit === "height") return Math.round(height);
    if (fit === "original") {
      const natural = known[index] ? Math.round(height * ratio) : Math.round(width);
      return Math.max(120, Math.min(natural, width * 2));
    }
    return Math.round(flowWidth() / Math.max(0.08, ratio));
  }

  function indexAt(y) {
    let lo = 0;
    let hi = total - 1;
    let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (tops[mid] <= y) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  }

  function relayout(anchor) {
    heights = new Array(total);
    tops = new Array(total);
    const gap = prefs.gap === undefined ? 4 : prefs.gap;
    let y = 0;
    for (let i = 0; i < total; i += 1) {
      const h = heightFor(i);
      heights[i] = h;
      tops[i] = y;
      y += h + gap;
    }
    const endH = endCard ? 240 : 0;
    flowEl.style.width = (prefs.zoom || 1) === 1 ? "100%" : flowWidth() + "px";
    flowEl.style.height = Math.max(1, y + endH) + "px";
    if (endCard) {
      endCard.style.top = y + 20 + "px";
      endCard.style.height = endH + "px";
    }
    for (let i = 0; i < total; i += 1) {
      const entry = nodes[i];
      if (!entry) continue;
      entry.node.style.top = tops[i] + "px";
      entry.node.style.height = heights[i] + "px";
    }
    if (anchor !== undefined && anchor !== null) {
      scrollEl.scrollTop = Math.max(0, tops[anchor] || 0);
    }
  }

  // ---- per-page visual state -------------------------------------------------

  function visualOf(entry) {
    if (entry.broken) return "failed";
    if (entry.loaded) return "loaded";
    if (entry.state === "failed") return "failed";
    if (entry.state === "error" || entry.loadErrors) return "retry";
    if (entry.cached) return "cached";
    if (entry.state === "claimed") return "loading";
    if (entry.requested) return "loading";
    return "idle";
  }

  function paintState(entry) {
    const visual = visualOf(entry);
    const next = VISUAL_CLASS[visual];
    if (entry.visual !== next) {
      if (entry.visual) entry.node.classList.remove(entry.visual);
      entry.node.classList.add(next);
      entry.visual = next;
    }
    if (visual === "failed") {
      // Say why, and how much of the retry budget was spent, instead of a bare "失败".
      const reason = entry.error || (entry.broken ? "图片获取失败" : "无法获取此页图片");
      const spent = entry.attempts ? "（已重试 " + entry.attempts +
        (entry.maxAttempts ? " / " + entry.maxAttempts : "") + " 次）" : "";
      entry.label.textContent = reason + spent + " · 点击重试";
      entry.node.title = reason + spent + "（点击重试这一页）";
    } else if (visual !== "loaded") {
      entry.label.textContent = VISUAL_TEXT[visual];
      entry.node.title = "";
    }
  }

  // ---- loading queue ---------------------------------------------------------

  function releaseSlot() {
    if (inflight > 0) inflight -= 1;
    drain();
  }

  function drain() {
    while (!destroyed && inflight < CONCURRENCY && queue.length) {
      const index = queue.shift();
      const entry = nodes[index];
      if (!entry) continue;
      entry.queued = false;
      if (entry.loaded || entry.broken || !entry.cached) continue;
      inflight += 1;
      entry.requested = true;
      // Keep the tile's cache status visible until the local image responds.
      // The request itself is tracked separately to avoid making every tile look cached.
      // Clear first: assigning the same URL to a failed <img> does not reload it, and a
      // page that came back 503 must actually be asked for again.
      entry.img.removeAttribute("src");
      entry.img.src = opts.pageUrlFor(index);
    }
  }

  function enqueue(index) {
    const entry = nodes[index];
    if (!entry || entry.queued || entry.loaded || entry.broken || !entry.cached) return;
    entry.queued = true;
    queue.push(index);
    drain();
  }

  function buildNode(index) {
    const pageNo = index + 1;
    const wrap = el("div", { class: "rpage st-idle", "data-index": String(index) });
    const img = el("img", { class: "rpage-img", alt: "第 " + pageNo + " 页", decoding: "async" });
    const label = el("span", { class: "pct", text: VISUAL_TEXT.idle });
    const box = el("div", { class: "ph" }, [
      el("span", { class: "num", text: String(pageNo) }),
      el("span", { class: "st-dot", "aria-hidden": "true" }),
      label,
    ]);
    wrap.appendChild(img);
    wrap.appendChild(box);

    const entry = {
      node: wrap,
      img,
      box,
      label,
      state: "idle",
      cached: false,
      loaded: false,
      queued: false,
      broken: false,
      loadErrors: 0,
      retryTimer: 0,
      visual: "st-idle",
    };

    img.addEventListener("load", () => {
      entry.loaded = true;
      entry.requested = false;
      entry.loadErrors = 0;
      wrap.classList.add("loaded");
      box.style.opacity = "0";
      paintState(entry);
      releaseSlot();
      if (typeof opts.onLoaded === "function") opts.onLoaded(index);
      if (typeof opts.onStats === "function") opts.onStats(stats());
    });

    img.addEventListener("error", () => {
      entry.loadErrors += 1;
      // A 503 means the page is not in the cache *yet*: fetching belongs to the cache
      // task, so retrying immediately would only repeat the same miss. Drop back to
      // "waiting" and let the next status poll decide -- it flips cached when the task
      // stores the page, and that is what queues the load again.
      entry.broken = true;
      entry.requested = false;
      // Cache state is authoritative; do not retry an HTTP miss while the worker waits for CDN.
      wrap.classList.toggle("errored", entry.broken);
      paintState(entry);
      releaseSlot();
      // The retry-all button lives outside the flow; tell it that the failure count moved.
      if (typeof opts.onStats === "function") opts.onStats(stats());
    });

    // A failed page is a retry target: tapping it asks for that page again instead of
    // silently doing nothing.
    wrap.addEventListener("click", (evt) => {
      if (visualOf(entry) !== "failed") return;
      evt.stopPropagation();
      if (typeof opts.onRetryPage === "function") opts.onRetryPage(index);
    });

    return entry;
  }

  // ---- scroll reporting ------------------------------------------------------

  function enqueueWindow(center) {
    const from = Math.max(0, Number(center) || 0);
    const to = Math.min(total, from + 8);
    for (let index = from; index < to; index += 1) enqueue(index);
  }

  function reportVisible() {
    if (!total) return;
    const first = indexAt(scrollEl.scrollTop);
    enqueueWindow(first);
    if (first === lastFirstVisible) return;
    lastFirstVisible = first;
    if (typeof opts.onPageChange === "function") opts.onPageChange(first, total);
  }

  function scheduleReport() {
    if (rafPending) return;
    rafPending = requestAnimationFrame(() => {
      rafPending = 0;
      reportVisible();
    });
  }

  scrollEl.addEventListener("scroll", scheduleReport, { passive: true });

  function resize() {
    if (destroyed) return;
    const anchor = indexAt(scrollEl.scrollTop);
    const offset = scrollEl.scrollTop - (tops[anchor] || 0);
    relayout();
    scrollEl.scrollTop = Math.max(0, (tops[anchor] || 0) + offset);
  }
  window.addEventListener("resize", resize);

  function stats() {
    const out = { total, loaded: 0, cached: 0, loading: 0, idle: 0, retry: 0, failed: 0 };
    for (let i = 0; i < total; i += 1) {
      const entry = nodes[i];
      if (!entry) continue;
      out[visualOf(entry)] += 1;
    }
    return out;
  }

  return {
    setTotal(count) {
      total = Math.max(0, Number(count) || 0);
      ratios = new Array(total);
      known = new Array(total);
      heights = new Array(total);
      tops = new Array(total);
      queue = [];
      inflight = 0;
      nodes.forEach((entry) => {
        if (!entry) return;
        entry.img.removeAttribute("src");
        entry.node.remove();
      });
      nodes = new Array(total);
      for (let i = 0; i < total; i += 1) {
        const entry = buildNode(i);
        flowEl.appendChild(entry.node);
        nodes[i] = entry;
      }
      relayout();
    },
    loadVisible() {
      if (!destroyed && total) reportVisible();
    },
    setSizes(map) {
      let changed = false;
      Object.keys(map || {}).forEach((key) => {
        const index = Number(key) - 1;
        const pair = map[key];
        if (!(index >= 0 && index < total) || !pair || !pair[0] || !pair[1]) return;
        const ratio = pair[0] / pair[1];
        if (Math.abs((ratios[index] || DEFAULT_RATIO) - ratio) < 0.002) return;
        ratios[index] = ratio;
        known[index] = true;
        changed = true;
      });
      if (!changed) return;
      const anchor = indexAt(scrollEl.scrollTop);
      const offset = scrollEl.scrollTop - (tops[anchor] || 0);
      relayout();
      scrollEl.scrollTop = Math.max(0, (tops[anchor] || 0) + offset);
    },
    setStatuses(pages) {
      if (destroyed || !total) return;
      let changed = false;
      (pages || []).forEach((page) => {
        const index = Number(page.index);
        const entry = nodes[index];
        if (!entry) return;
        entry.state = page.state || "idle";
        entry.cached = !!page.cached;
        if (entry.cached) {
          entry.broken = false;
          entry.loadErrors = 0;
          entry.node.classList.remove("errored");
        }
        entry.error = page.error || "";
        entry.attempts = Number(page.attempts || 0);
        entry.maxAttempts = Number(page.max_attempts || 0);
        if (page.w && page.h) {
          const ratio = page.w / page.h;
          if (Math.abs((ratios[index] || DEFAULT_RATIO) - ratio) > 0.002) {
            ratios[index] = ratio;
            known[index] = true;
            changed = true;
          }
        }
        paintState(entry);
        if (entry.cached) enqueue(index);
      });
      enqueueWindow(indexAt(scrollEl.scrollTop));
      if (changed) {
        const anchor = indexAt(scrollEl.scrollTop);
        const offset = scrollEl.scrollTop - (tops[anchor] || 0);
        relayout();
        scrollEl.scrollTop = Math.max(0, (tops[anchor] || 0) + offset);
      }
      if (typeof opts.onStats === "function") opts.onStats(stats());
    },
    setPrefs(next) {
      prefs = next;
      const anchor = indexAt(scrollEl.scrollTop);
      relayout();
      scrollEl.scrollTop = Math.max(0, tops[anchor] || 0);
    },
    scrollToPage(pageNo, smooth) {
      const index = Math.max(0, Math.min(total - 1, Number(pageNo) - 1));
      const top = tops[index] || 0;
      if (smooth) scrollEl.scrollTo({ top: top, behavior: "smooth" });
      else scrollEl.scrollTop = top;
      reportVisible();
    },
    currentPage() {
      return indexAt(scrollEl.scrollTop) + 1;
    },
    pageHeight(index) {
      return heights[index] || 0;
    },
    scrollBy(delta) {
      scrollEl.scrollBy({ top: delta, behavior: "smooth" });
    },
    scrollToEnd() {
      scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior: "smooth" });
    },
    failedIndexes() {
      const out = [];
      for (let i = 0; i < total; i += 1) {
        const entry = nodes[i];
        if (entry && visualOf(entry) === "failed") out.push(i);
      }
      return out;
    },
    // Clear the local "gave up" state for one page so it is actually requested again.
    retryPage(index) {
      const entry = nodes[index];
      if (!entry) return false;
      entry.broken = false;
      entry.loadErrors = 0;
      entry.error = "";
      entry.requested = false;
      entry.node.classList.remove("errored");
      clearTimeout(entry.retryTimer);
      entry.retryTimer = 0;
      paintState(entry);
      enqueue(index);
      return true;
    },
    retryFailed() {
      const indexes = this.failedIndexes();
      indexes.forEach((index) => this.retryPage(index));
      return indexes.length;
    },
    stats,
    visuals() {
      const out = new Array(total);
      for (let i = 0; i < total; i += 1) {
        const entry = nodes[i];
        out[i] = entry ? visualOf(entry) : "idle";
      }
      return out;
    },
    destroy() {
      destroyed = true;
      scrollEl.removeEventListener("scroll", scheduleReport);
      window.removeEventListener("resize", resize);
      if (rafPending) cancelAnimationFrame(rafPending);
      queue = [];
      nodes.forEach((entry) => {
        if (!entry) return;
        entry.img.removeAttribute("src");
        entry.node.remove();
      });
      nodes = [];
    },
  };
}
