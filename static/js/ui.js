// Shared UI primitives. Every view builds DOM through these so the app looks like
// one thing: same tile, same section head, same sheet.
import { api, fmtAgo } from "./api.js";
import { onEvent } from "./events.js";

export function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    Object.keys(attrs).forEach((key) => {
      const val = attrs[key];
      if (val === null || val === undefined || val === false) return;
      if (key === "class") node.className = val;
      else if (key === "text") node.textContent = val;
      else if (key === "html") node.innerHTML = val;
      else if (key === "style") node.setAttribute("style", val);
      else if (key.startsWith("on") && typeof val === "function") {
        node.addEventListener(key.slice(2).toLowerCase(), val);
      } else if (val === true) node.setAttribute(key, "");
      else node.setAttribute(key, val);
    });
  }
  append(node, children);
  return node;
}

// `text` and real children are mutually exclusive: writing both used to duplicate the
// label (the text node stayed, then the elements were appended after it).
function append(node, children) {
  if (!children) return node;
  const list = Array.isArray(children) ? children : [children];
  const real = list.filter((child) => child !== null && child !== undefined && child !== false);
  if (!real.length) return node;
  // Drop a text value written from attrs.text; the children are the real content.
  node.textContent = "";
  real.forEach((child) => {
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  });
  return node;
}

export function icon(name, cls) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon" + (cls ? " " + cls : ""));
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#i-" + name);
  svg.appendChild(use);
  return svg;
}

export function iconButton(name, onClick, opts) {
  const options = opts || {};
  return el("button", {
    class: "icon-btn" + (options.class ? " " + options.class : ""),
    type: "button",
    title: options.title || "",
    "aria-label": options.title || "",
    onClick,
  }, [icon(name)]);
}

export function toast(message, ms) {
  const box = document.getElementById("toast");
  if (!box) return;
  box.textContent = message;
  box.classList.add("show");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => box.classList.remove("show"), ms || 2200);
}


function layerNode() {
  return document.getElementById("layer") || document.body;
}

export function openSheet(options) {
  const opts = options || {};
  const backdrop = el("div", { class: "backdrop" });
  const sheet = el("div", { class: "sheet", role: "dialog", "aria-modal": "true" }, [
    el("div", { class: "handle" }),
    opts.title ? el("h2", { text: opts.title }) : null,
    opts.subtitle ? el("div", { class: "muted tiny", text: opts.subtitle }) : null,
    opts.body || null,
  ]);

  const host = layerNode();
  host.appendChild(backdrop);
  host.appendChild(sheet);

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    backdrop.classList.remove("in");
    sheet.classList.remove("in");
    document.removeEventListener("keydown", onKey);
    setTimeout(() => {
      backdrop.remove();
      sheet.remove();
      if (typeof opts.onClose === "function") opts.onClose();
    }, 220);
  }
  function onKey(evt) {
    if (evt.key === "Escape") {
      evt.stopPropagation();
      close();
    }
  }
  backdrop.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  requestAnimationFrame(() => {
    backdrop.classList.add("in");
    sheet.classList.add("in");
  });
  return { sheet, close };
}

export function confirmDialog(options) {
  const opts = options || {};
  return new Promise((resolve) => {
    const body = el("div", {}, [
      opts.message ? el("p", { class: "muted", style: "margin:4px 0 18px", text: opts.message }) : null,
      el("div", { class: "row", style: "gap:10px;justify-content:flex-end" }, [
        el("button", {
          class: "btn ghost",
          type: "button",
          text: opts.cancelText || "取消",
          onClick: () => { sheet.close(); resolve(false); },
        }),
        el("button", {
          class: "btn " + (opts.danger ? "danger" : "primary"),
          type: "button",
          text: opts.okText || "确定",
          onClick: () => { sheet.close(); resolve(true); },
        }),
      ]),
    ]);
    const sheet = openSheet({
      title: opts.title || "确认",
      body,
      onClose: () => resolve(false),
    });
  });
}


export function segControl(options) {
  const opts = options || {};
  const items = opts.options || [];
  let current = opts.value;
  const wrap = el("div", { class: "seg", role: "tablist" });
  const pairs = items.map((item) => {
    const btn = el("button", {
      type: "button",
      text: item.label,
      role: "tab",
      onClick: () => {
        if (current === item.value) return;
        set(item.value);
        if (typeof opts.onChange === "function") opts.onChange(item.value);
      },
    });
    wrap.appendChild(btn);
    return { item: item, btn: btn };
  });
  function set(value) {
    current = value;
    pairs.forEach((pair) => pair.btn.classList.toggle("on", pair.item.value === value));
  }
  set(current);
  wrap.set = set;
  wrap.get = () => current;
  return wrap;
}

export function chipStrip(items, options) {
  const opts = options || {};
  let current = opts.value;
  const strip = el("div", { class: "strip" });
  const pairs = items.map((item) => {
    const value = typeof item === "string" ? item : item.value;
    const label = typeof item === "string" ? item : item.label;
    const chip = el("button", {
      class: "chip",
      type: "button",
      text: label,
      onClick: () => {
        let next = value;
        if (current === value) next = opts.allowEmpty === false ? value : null;
        set(next);
        if (typeof opts.onChange === "function") opts.onChange(next);
      },
    });
    strip.appendChild(chip);
    return { value: value, chip: chip };
  });
  function set(value) {
    current = value;
    pairs.forEach((pair) => pair.chip.classList.toggle("on", pair.value === value));
  }
  set(current);
  strip.set = set;
  strip.get = () => current;
  return strip;
}

export function coverImage(url) {
  const img = el("img", { src: url, alt: "", loading: "lazy", decoding: "async" });
  img.addEventListener("load", () => img.classList.add("ready"));
  img.addEventListener("error", () => {
    img.style.opacity = "0";
    img.dataset.failed = "1";
  });
  return img;
}

// A cover drawn from the progressive stream.
//
// Covers are JPEG on the CDN, and a truncated JPEG still decodes -- so this canvas gets
// rows of the real artwork while the rest is still downloading, top first. The loading
// starts only when the tile scrolls near the viewport: 80 tiles each opening a stream on
// page load would be worse than the problem it solves.
// Covers: a plain <img> per tile, with the queue living on the server.
//
// There is nothing to decode client-side any more -- the server relays the CDN's own
// bytes -- so a canvas would only add work. The overlay underneath animates so the wait
// reads as loading rather than as a broken tile; disk hits come back immediately and a
// 503 (no CDN slot free) is retried a couple of times instead of blanking the tile.
// Covers are cache-first, so a tile never waits on the CDN:
//
//   1. one status call per grid reports which covers are already stored,
//   2. tiles that are ready set their src immediately (a local read),
//   3. the rest are queued in one want call, and the server's event stream says when each
//      one lands, at which point that tile asks again and gets a hit.
//
// A grid therefore costs two small API calls instead of thirty image requests racing the
// CDN, and nothing sits in a spinner waiting for a slot.
const coverBatch = (() => {
  const pending = new Map();   // aid -> { aid, size, tiles: Set }
  const waiting = new Map();   // aid -> batch waiting for the background fetch
  let flushTimer = 0;
  let listening = false;

  function subscribe() {
    if (listening) return;
    listening = true;
    onEvent("covers", (evt) => {
      const key = String(evt.aid);
      const tile = waiting.get(key);
      if (!tile) return;
      // A spent retry budget is terminal: show why instead of asking again.
      const failure = evt.failure;
      if (evt.ok === false && failure && failure.exhausted) {
        waiting.delete(key);
        tile.tiles.forEach((entry) => entry.fail && entry.fail(failure));
        return;
      }
      if (evt.ok === false) return;
      waiting.delete(key);
      tile.tiles.forEach((entry) => entry.retry());
    });
  }

  function flush() {
    flushTimer = 0;
    const batch = Array.from(pending.values());
    pending.clear();
    if (!batch.length) return;
    const size = batch[0].size;
    const aids = batch.map((entry) => entry.aid);
    subscribe();

    api.coversStatus(aids, size).then((payload) => {
      const ready = (payload && payload.ready) || {};
      const failed = (payload && payload.failed) || {};
      const missing = [];
      batch.forEach((entry) => {
        const tiles = entry.tiles;
        const failure = failed[entry.aid];
        if (ready[entry.aid]) {
          tiles.forEach((tile) => tile.show());
        } else if (failure && failure.exhausted) {
          tiles.forEach((tile) => tile.fail && tile.fail(failure));
        } else {
          waiting.set(entry.aid, entry);
          missing.push(entry.aid);
        }
      });
      if (missing.length) api.coversWant(missing, size).catch(() => {});
    }).catch(() => {
      // The status call is an optimisation: fall back to each tile asking on its own.
      batch.forEach((entry) => entry.tiles.forEach((tile) => tile.show()));
    });
  }

  return {
    add(aid, size, tile) {
      const key = String(aid);
      let entry = pending.get(key);
      if (!entry) {
        entry = { aid: key, size: size || 360, tiles: new Set() };
        pending.set(key, entry);
      }
      entry.tiles.add(tile);
      if (!flushTimer) flushTimer = setTimeout(flush, 16);
    },
    forget(tile) {
      pending.forEach((entry, key) => {
        entry.tiles.delete(tile);
        if (!entry.tiles.size) pending.delete(key);
      });
      waiting.forEach((entry, key) => {
        entry.tiles.delete(tile);
        if (!entry.tiles.size) waiting.delete(key);
      });
    },
    // Coming back to a page that was frozen: the covers it was waiting for may have
    // landed while it was gone, and it missed the event that said so.
    resume() {
      waiting.forEach((entry) => entry.tiles.forEach((tile) => tile.retry && tile.retry()));
    },
    clear() {
      pending.clear();
      waiting.clear();
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = 0;
      }
      // The router drops every event handler on navigation, so the subscription flag has
      // to go with them or the next grid would never re-subscribe.
      listening = false;
    },
  };
})();

/**
 * A cover tile. Pass { aid, size } to get the batched cache-first path; a bare URL still
 * works for one-off images.
 */
export function coverCanvas(src, options) {
  const opts = options || {};
  const url = typeof src === "string" ? src : (opts.url || "");
  const aid = opts.aid ? String(opts.aid) : "";
  const size = opts.size ? Number(opts.size) : 360;

  // No src attribute: an empty one makes the browser request the page URL and fail.
  const img = el("img", { class: "cover-img", alt: "", decoding: "async" });
  const pct = el("span", { class: "cover-pct", text: "" });
  const wave = el("div", { class: "wave", "aria-hidden": "true" });
  const overlay = el("div", { class: "cover-load", "aria-hidden": "true" }, [wave, pct]);
  overlay.style.setProperty("--p", "0");
  const holder = el("div", { class: "cover-canvas-wrap" }, [img, overlay]);

  let finished = false;
  let observer = null;
  let retryTimer = 0;
  let attempts = 0;

  function finish() {
    if (finished) return;
    finished = true;
    holder.classList.add("loaded");
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  img.addEventListener("load", () => {
    holder.classList.remove("waiting");
    holder.classList.add("started");
    overlay.style.setProperty("--p", "1");
    finish();
  });

  img.addEventListener("error", () => {
    // 503 with a cache-first server means "not stored yet", not "gone". The event stream
    // normally arrives first; this backoff is the fallback that keeps a tile from being
    // left blank when an event is missed.
    attempts += 1;
    if (attempts > 6 || finished) {
      finish();
      return;
    }
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = 0;
      show();
    }, Math.min(2500, 300 * attempts));
  });

  function show() {
    if (finished) return;
    holder.classList.add("waiting");
    pct.textContent = "";
    // Clearing first makes a retry a real request: the same URL on a failed <img> is not
    // re-fetched.
    img.removeAttribute("src");
    img.src = url;
  }

  // Terminal failure: retrying cannot help, so say why and how many attempts were spent.
  function fail(failure) {
    if (finished && holder.classList.contains("failed")) return;
    finished = true;
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    const info = failure || {};
    const attempts = Number(info.attempts || 0);
    const max = Number(info.max_attempts || 0);
    holder.classList.add("failed", "loaded");
    holder.classList.remove("started", "waiting");
    holder.title = (info.reason || "封面图获取失败") +
      (max ? "（已重试 " + attempts + " / " + max + " 次）" : "");
    pct.textContent = attempts && max ? attempts + "/" + max : "";
    overlay.classList.add("cover-fail");
    let note = overlay.querySelector(".cover-fail-text");
    if (!note) {
      note = el("span", { class: "cover-fail-text" });
      overlay.appendChild(note);
    }
    note.textContent = (info.reason || "封面图获取失败");
    img.removeAttribute("src");
  }

  const tile = { retry: show, show, fail };

  function start() {
    if (finished) return;
    // Browse keeps a bounded page window, so enqueue covers immediately. The server
    // still limits network concurrency; the viewport must not control cache progress.
    if (aid) coverBatch.add(aid, size, tile);
    else show();
  }

  start();

  holder.__cancel = () => {
    finished = true;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = 0;
    }
    if (observer) observer.disconnect();
    observer = null;
    coverBatch.forget(tile);
    img.onload = null;
    img.onerror = null;
    img.removeAttribute("src");
  };
  return holder;
}

// Views unmount without telling their tiles; a navigation is the natural reset point.
export function resetCoverStream() {
  coverBatch.clear();
  coverWarmQueue.length = 0;
  coverWarmSeen.clear();
}

// Called when a frozen page is shown again (see app.js embed mode).
export function resumeCovers() {
  coverBatch.resume();
}

// Prefetch in visual order, six items at a time (3 columns by 2 rows). Only one
// chunk is submitted at once, so the queue starts at the top of the list.
const coverWarmQueue = [];
const coverWarmSeen = new Set();
let coverWarmRunning = false;

async function waitForCoverChunk(aids, size) {
  const wanted = aids.map((aid) => String(aid));
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const payload = await api.coversStatus(wanted, size);
      const ready = (payload && payload.ready) || {};
      const failed = (payload && payload.failed) || {};
      if (wanted.every((aid) => ready[aid] || (failed[aid] && failed[aid].exhausted))) return;
    } catch (err) {
      // Keep the chunk ordered, but let a transient status failure retry.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function drainCoverWarmQueue() {
  if (coverWarmRunning) return;
  coverWarmRunning = true;
  try {
    while (coverWarmQueue.length) {
      const { aids, size } = coverWarmQueue.splice(0, 1)[0];
      try {
        await api.coversWarm(aids, size);
        await waitForCoverChunk(aids, size);
      } catch (err) {
        // A failed prefetch must not block later visible chunks.
      }
    }
  } finally {
    coverWarmRunning = false;
    if (coverWarmQueue.length) drainCoverWarmQueue();
  }
}

export function warmCovers(aids, size) {
  const unique = Array.from(new Set((aids || []).map((aid) => String(aid)).filter(Boolean)))
    .filter((aid) => !coverWarmSeen.has(aid));
  if (!unique.length) return;
  unique.forEach((aid) => coverWarmSeen.add(aid));
  const chunkSize = 6;
  for (let i = 0; i < unique.length; i += chunkSize) {
    coverWarmQueue.push({ aids: unique.slice(i, i + chunkSize), size: size || 360 });
  }
  drainCoverWarmQueue();
}

export function tile(item, options) {
  const opts = options || {};
  const id = String(item.id || item.aid || item.cid || "");
  const title = item.name || item.title || opts.fallbackTitle || "(untitled)";
  const sub = opts.sub !== undefined
    ? opts.sub
    : [item.author, item.category && item.category.title].filter(Boolean).join(" · ");

  const cover = el("div", { class: "cover" }, [
    // Cache-first: the tile asks once per grid, then fills in from the event stream.
    coverCanvas(opts.cover || api.progCoverUrl(id, 360), { aid: id, size: 360 }),
    opts.badge ? el("span", { class: "badge", text: opts.badge }) : null,
    opts.progress
      ? el("div", { class: "progress" }, [
          el("i", { style: "width:" + Math.round(opts.progress * 100) + "%" }),
        ])
      : null,
  ]);

  if (opts.favorite !== undefined) {
    cover.appendChild(el("button", {
      class: "fav" + (opts.favorite ? " on" : ""),
      type: "button",
      title: "收藏",
      "aria-label": "收藏",
      onClick: (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        if (typeof opts.onFavorite === "function") opts.onFavorite(!opts.favorite, item);
      },
    }, [icon("heart")]));
  }

  const node = el("div", {
    class: "tile",
    tabindex: "0",
    role: "link",
    onClick: () => {
      if (typeof opts.onOpen === "function") {
        opts.onOpen(item);
        return;
      }
      if (!id) return;
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: "detail", aid: id }, location.origin);
      } else {
        location.hash = "#/album/" + id;
      }
    },
    onKeydown: (evt) => {
      if (evt.key === "Enter" || evt.key === " ") {
        evt.preventDefault();
        node.click();
      }
    },
    onContextmenu: (evt) => {
      if (typeof opts.onMenu !== "function") return;
      evt.preventDefault();
      opts.onMenu(item);
    },
  }, [
    cover,
    el("div", { class: "cap" }, [
      el("div", { class: "t", text: title }),
      sub ? el("div", { class: "s", text: sub }) : null,
      opts.note ? el("div", { class: "s", text: opts.note }) : null,
      opts.action ? el("button", { class: "btn sm tile-action", type: "button", text: opts.action.label, onClick: (evt) => { evt.preventDefault(); evt.stopPropagation(); opts.action.onClick(); } }) : null,
    ]),
  ]);
  return node;
}

export function tileGrid(items, options) {
  const opts = options || {};
  return el("div", { class: "grid" }, (items || []).map((item) => tile(item, opts)));
}

export function rail(items, options) {
  const opts = options || {};
  return el("div", { class: "rail" }, (items || []).map((item) => tile(item, opts)));
}

export function sectionHead(title, options) {
  const opts = options || {};
  return el("div", { class: "section-head" }, [
    el("h2", { text: title }),
    opts.sub ? el("span", { class: "muted tiny", text: opts.sub }) : null,
    opts.more
      ? el("span", { class: "more", onClick: opts.more.onClick }, [
          document.createTextNode(opts.more.label || "更多"),
          icon("chevron-right"),
        ])
      : null,
  ]);
}

export function section(title, options) {
  const opts = options || {};
  return el("div", { class: "section" }, [sectionHead(title, opts), opts.body || null]);
}


export function skeletonTile() {
  return el("div", { class: "sk-tile" }, [
    el("div", { class: "skeleton cover jm-skeleton-cover" }, [
      ...Array.from({ length: 9 }, () => el("i", { class: "jm-manga-panel" })),
    ]),
    el("div", { class: "skeleton line" }),
    el("div", { class: "skeleton line short" }),
  ]);
}

export function skeletonGrid(count) {
  const kids = [];
  const n = count || 12;
  for (let i = 0; i < n; i += 1) kids.push(skeletonTile());
  return el("div", { class: "grid" }, kids);
}

export function skeletonRail(count) {
  const kids = [];
  const n = count || 6;
  for (let i = 0; i < n; i += 1) kids.push(skeletonTile());
  return el("div", { class: "rail" }, kids);
}

export function loadingAnimation(type, label) {
  const kind = type || "manga";
  const nodes = [];
  if (kind === "cover") {
    nodes.push(el("div", { class: "jm-loader jm-loader-cover", role: "presentation" }, [
      el("div", { class: "jm-book-cover" }),
      el("i", { class: "jm-book-page" }),
      el("i", { class: "jm-book-page" }),
      el("i", { class: "jm-book-page" }),
    ]));
  } else if (kind === "catalog") {
    nodes.push(el("div", { class: "jm-loader jm-loader-catalog", role: "presentation" }, [
      ...Array.from({ length: 6 }, () => el("i", { class: "jm-shelf-book" })),
      el("div", { class: "jm-shelf" }),
    ]));
  } else if (kind === "detail") {
    nodes.push(el("div", { class: "jm-loader jm-loader-detail", role: "presentation" }, [
      ...Array.from({ length: 4 }, () => el("i", { class: "jm-info-card" })),
    ]));
  } else if (kind === "chapter") {
    nodes.push(el("div", { class: "jm-loader jm-loader-chapter", role: "presentation" }, [
      el("i", { class: "jm-page-left" }),
      el("i", { class: "jm-page-right" }),
    ]));
  } else {
    nodes.push(el("div", { class: "jm-loader jm-loader-manga", role: "presentation" }, [
      ...Array.from({ length: 9 }, () => el("i", { class: "jm-manga-panel" })),
    ]));
  }
  return el("div", { class: "jm-loading", role: "status" }, [
    ...nodes,
    label ? el("span", { class: "jm-loading-label", text: label }) : null,
  ]);
}

export function loadingRow(text, type) {
  return el("div", { class: "loading-row" }, [
    loadingAnimation(type || "manga", text || "加载中…"),
  ]);
}

export function emptyState(options) {
  const opts = options || {};
  const actions = [];
  if (opts.actionLabel) {
    actions.push(el("button", {
      class: "btn primary",
      type: "button",
      text: opts.actionLabel,
      onClick: opts.onAction,
    }));
  }
  if (opts.secondaryLabel) {
    actions.push(el("button", {
      class: "btn ghost",
      type: "button",
      text: opts.secondaryLabel,
      onClick: opts.onSecondary || goBack,
    }));
  }
  return el("div", { class: "empty" }, [
    icon(opts.icon || "image"),
    el("div", { class: "t", text: opts.title || "这里还什么都没有" }),
    opts.text ? el("div", { class: "s", text: opts.text }) : null,
    actions.length ? el("div", { class: "row", style: "gap:8px;justify-content:center" }, actions) : null,
  ]);
}

// Leaving a broken screen must always be one tap away, even when retrying failed.
function goBack() {
  if (history.length > 1) history.back();
  else location.hash = "#/home";
}

// The upstream answers a novel with a null payload: there is nothing to render.
export function isUnsupported(message) {
  return String(message || "").indexOf("unsupported_type") >= 0;
}

export function unsupportedState(onBack) {
  return emptyState({
    icon: "info",
    title: "暂不支持这种作品",
    text: "这是小说等非漫画类型，当前只能阅读漫画，无法加载。",
    secondaryLabel: "返回",
    onSecondary: onBack || goBack,
  });
}

export function errorState(message, onRetry) {
  if (isUnsupported(message)) return unsupportedState();
  return emptyState({
    icon: "info",
    title: "加载失败",
    text: message || "网络或线路出了点问题",
    actionLabel: onRetry ? "重试" : "",
    onAction: onRetry,
    secondaryLabel: "返回",
  });
}

export function listRow(options) {
  const opts = options || {};
  return el("div", { class: "list-row", onClick: opts.onClick }, [
    opts.icon ? el("div", { class: "lead" }, [icon(opts.icon)]) : null,
    el("div", { class: "grow" }, [
      el("div", { class: "title", text: opts.title || "" }),
      opts.desc ? el("div", { class: "desc", text: opts.desc }) : null,
    ]),
    opts.trailing || null,
    opts.chevron === false ? null : icon("chevron-right", "chev"),
  ]);
}

export function statCard(value, label) {
  return el("div", { class: "stat" }, [
    el("b", { text: String(value) }),
    el("span", { text: label }),
  ]);
}

export function pageHead(title, options) {
  const opts = options || {};
  return el("div", { class: "page-head" }, [
    opts.back
      ? el("button", { class: "back-btn", type: "button", "aria-label": "返回", onClick: opts.back }, [
          icon("arrow-left"),
        ])
      : null,
    el("div", { class: "grow" }, [
      el("h1", { text: title }),
      opts.sub ? el("div", { class: "sub", text: opts.sub }) : null,
    ]),
    opts.actions || null,
  ]);
}

export function infiniteScroll(sentinel, onLoad) {
  let busy = false;
  let done = false;
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting || busy || done) return;
      busy = true;
      Promise.resolve(onLoad())
        .then((hasMore) => {
          if (hasMore === false) done = true;
        })
        .catch(() => {})
        .finally(() => {
          busy = false;
        });
    });
  }, { rootMargin: "500px 0px" });
  observer.observe(sentinel);
  return {
    disconnect() {
      observer.disconnect();
    },
    finish() {
      done = true;
      observer.disconnect();
    },
  };
}

export function relativeTime(seconds) {
  return fmtAgo(seconds);
}