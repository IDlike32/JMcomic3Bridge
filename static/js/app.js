// Router + shell wiring.
//
// One file, two roles:
//
//   shell (top window)      - owns the sidebar/tabbar and keeps only the active route frame,
//                             releasing inactive documents to keep their DOM and JS state
//                             from accumulating in the background.
//   embed (/?embed=1#/route) - the ordinary app running inside such a frame. Its own chrome
//                             is hidden and every navigation it starts is forwarded to the
//                             shell instead of being handled locally.
//
// A frame is therefore *frozen* on the route it was created for. Views keep using
// "location.hash = ..." and "history.back()" unchanged; in embed mode those calls turn
// into messages to the shell, which owns the real history and decides which frame shows.
import { el, icon, resetCoverStream, resumeCovers, errorState } from "./ui.js";
import { resetEvents, setSuspended } from "./events.js";
import { state, bootstrap, refreshLines, setTheme, restoreTheme } from "./state.js";
import { installTabSwipe } from "./swipe.js";

const view = document.getElementById("view");
const lineDots = document.getElementById("line-dots");
const EMBED = document.documentElement.classList.contains("embed") ||
  new URLSearchParams(location.search).has("embed");

const NAV_HEADS = ["home", "browse", "search", "library", "me"];
const READ_HEAD = "read";

const ROUTES = {
  home: () => import("./views/home.js").then((module) => module.renderHome),
  browse: () => import("./views/browse.js?v=37").then((module) => module.renderBrowse),
  search: () => import("./views/search.js").then((module) => module.renderSearch),
  library: () => import("./views/library.js").then((module) => module.renderLibrary),
  me: () => import("./views/me.js").then((module) => module.renderMe),
  album: () => import("./views/album.js").then((module) => module.renderAlbum),
  listing: () => import("./views/listing.js").then((module) => module.renderListing),
  tasks: () => import("./views/tasks.js").then((module) => module.renderTasks),
  cache: () => import("./views/cache.js").then((module) => module.renderCache),
  settings: () => import("./views/settings.js").then((module) => module.renderSettings),
};

function normalizeHash(hash) {
  let raw = String(hash === undefined ? location.hash : hash || "").trim();
  if (raw.charAt(0) === "#") raw = raw.slice(1);
  if (!raw) return "#/home";
  if (raw.charAt(0) !== "/") raw = "/" + raw;
  return "#" + raw;
}

function headOf(hash) {
  const segments = normalizeHash(hash).slice(1).split("?")[0].split("/").filter(Boolean);
  return segments[0] || "home";
}

function parseHash(hash) {
  const raw = normalizeHash(hash).slice(1);
  const parts = raw.split("?");
  const segments = parts[0].split("/").filter(Boolean);
  return {
    head: segments[0] || "home",
    rest: segments.slice(1),
    query: new URLSearchParams(parts[1] || ""),
    raw,
  };
}

function paintLines() {
  if (!lineDots) return;
  lineDots.innerHTML = "";
  (state.lines || []).forEach((line) => {
    if (!line.active) return;
    const dot = el("span", {
      class: "dot",
      title: line.host + (line.latency_ms ? " · " + Math.round(line.latency_ms) + "ms" : ""),
      style: "width:7px;height:7px;border-radius:50%;display:inline-block;background:" +
        (line.ok ? "var(--ok)" : "#4b5563"),
    });
    lineDots.appendChild(dot);
  });
}

function setNav(name) {
  document.querySelectorAll("[data-nav]").forEach((node) => {
    node.classList.toggle("active", node.dataset.nav === name);
  });
  const tabbar = document.getElementById("tabbar");
  if (tabbar) tabbar.classList.toggle("hidden", !name);
}

function paintChrome(hash) {
  const head = headOf(hash);
  // The reader fills the window in the old app too; now it also gets the sidebar's space.
  document.body.classList.toggle("immersive", head === READ_HEAD);
  setNav(NAV_HEADS.indexOf(head) >= 0 ? head : "");
}

// ===================================================================== shell mode
//
// The shell renders nothing itself. It keeps a table of frames, shows one, and mirrors the
// address bar. Which frame is shown is the only thing a navigation changes.

const frames = new Map();   // normalized hash -> { key, frame, ready, used }
const scrollPositions = new Map();
let activeFrame = null;
let loadingNode = null;
let detailPanel = null;
let detailFrame = null;
let detailHistory = [];
let clock = 0;

function post(entry, message) {
  const win = entry.frame.contentWindow;
  if (!win) return;
  try {
    win.postMessage(message, location.origin);
  } catch (err) {
    /* frame still committing its document; it reports "ready" when it is */
  }
}

function showLoading() {
  if (loadingNode) loadingNode.classList.remove("off");
}

function hideLoading() {
  if (loadingNode) loadingNode.classList.add("off");
}

function makeFrame(key) {
  const frame = document.createElement("iframe");
  frame.className = "frame";
  frame.setAttribute("title", "页面 " + key);
  frame.setAttribute("aria-hidden", "true");
  // The reader asks for fullscreen; without this the request is silently refused.
  frame.setAttribute("allow", "fullscreen");
  frame.setAttribute("allowfullscreen", "");
  frame.src = "/?embed=1" + key;
  const entry = { key, frame, ready: false, used: ++clock };
  // A frame that never reports readiness (script error, offline) must not leave a spinner
  // up forever: the load event is a good-enough signal that something is there.
  frame.addEventListener("load", () => {
    setTimeout(() => markReady(entry), 1200);
  });
  view.appendChild(frame);
  frames.set(key, entry);
  return entry;
}

function markReady(entry) {
  if (entry.ready) return;
  entry.ready = true;
  if (entry === activeFrame) hideLoading();
}

function activate(entry) {
  activeFrame = entry;
  entry.used = ++clock;
  frames.forEach((other) => {
    const on = other === entry;
    other.frame.classList.toggle("on", on);
    other.frame.setAttribute("aria-hidden", on ? "false" : "true");
    // A hidden page closes its event stream: open connections are a scarce resource and
    // a frozen page has no use for live updates.
    post(other, { type: "active", on });
  });
  if (entry.ready) hideLoading();
  else showLoading();
}

function saveScrollPosition(entry) {
  if (!entry) return;
  try {
    const y = entry.frame.contentWindow && entry.frame.contentWindow.scrollY;
    if (Number.isFinite(y)) scrollPositions.set(entry.key, Math.max(0, y));
  } catch (_) {}
}

function drop(entry) {
  if (!entry) return;
  saveScrollPosition(entry);
  post(entry, { type: "active", on: false });
  frames.delete(entry.key);
  if (entry === activeFrame) activeFrame = null;
  entry.frame.remove();
}

function rekey(entry, key) {
  if (entry.key === key) return;
  const previousKey = entry.key;
  frames.delete(previousKey);
  if (scrollPositions.has(previousKey)) scrollPositions.set(key, scrollPositions.get(previousKey));
  const occupant = frames.get(key);
  if (occupant && occupant !== entry) drop(occupant);
  entry.key = key;
  frames.set(key, entry);
}

// Declared above route(): route() reads the pending direction on every navigation.
let swipeOffset = 0;
let swipePending = 0;   // -1 back, +1 forward, 0 none: the direction a new frame enters from
let swipeFrame = 0;
let swipeSource = null;
let swipeLatestDx = 0;

function route() {
  const key = normalizeHash(location.hash);
  closeDetail();
  paintChrome(key);

  if (activeFrame && activeFrame.key === key) {
    activeFrame.used = ++clock;
    hideLoading();
    return;
  }

  const leaving = activeFrame;
  saveScrollPosition(leaving);
  let entry = frames.get(key);
  if (!entry) entry = makeFrame(key);
  activate(entry);
  if (leaving && leaving !== entry) drop(leaving);
  if (swipePending) {
    const dir = swipePending;
    swipePending = 0;
    applyEnter(entry, dir);
  }
}

// ---------------------------------------------------------------- tab swipe
//
// A frame cannot navigate the app, and it is the only thing that sees the
// finger. So it reports the gesture and the shell decides: drag the frame with
// the finger, then either commit to the neighbouring tab or spring back.

function tabNeighbour(dir) {
  const order = NAV_HEADS;
  const index = order.indexOf(headOf(location.hash));
  if (index < 0) return null;
  const next = order[index + (dir === "next" ? 1 : -1)];
  return next || null;
}

function paintSwipe(dx) {
  if (!activeFrame) return;
  const node = activeFrame.frame;
  const limit = Math.min(120, window.innerWidth * 0.28);
  swipeOffset = Math.max(-limit, Math.min(limit, dx * 0.32));
  if (Math.abs(swipeOffset) > 0.5) node.classList.add("swiping");
  node.style.transform = swipeOffset ? "translate3d(" + swipeOffset + "px,0,0)" : "";
}

function scheduleSwipePaint(source, dx) {
  swipeSource = source;
  swipeLatestDx = dx;
  if (swipeFrame) return;
  swipeFrame = requestAnimationFrame(() => {
    swipeFrame = 0;
    if (activeFrame && swipeSource === activeFrame.frame.contentWindow) paintSwipe(swipeLatestDx);
  });
}

function settleSwipe() {
  if (swipeFrame) cancelAnimationFrame(swipeFrame);
  swipeFrame = 0;
  swipeSource = null;
  if (!activeFrame) return;
  const node = activeFrame.frame;
  node.classList.remove("swiping");
  node.classList.add("settling");
  node.style.transform = "";
  setTimeout(() => node.classList.remove("settling"), 320);
  swipeOffset = 0;
}

function applyEnter(entry, dir) {
  const node = entry.frame;
  node.classList.remove("enter-fwd", "enter-back");
  if (!dir) return;
  // Restart the animation even when the same class was used a moment ago.
  void node.offsetWidth;
  node.classList.add(dir > 0 ? "enter-fwd" : "enter-back");
  setTimeout(() => node.classList.remove("enter-fwd", "enter-back"), 420);
}

function handleSwipe(source, data) {
  if (!activeFrame || activeFrame.frame.contentWindow !== source) return;
  if (data.type === "swipe-move") {
    if (data.cancel) settleSwipe();
    else scheduleSwipePaint(source, Number(data.dx) || 0);
    return;
  }
  if (data.type !== "swipe") return;
  const target = tabNeighbour(data.dir);
  if (!target) {
    settleSwipe();
    return;
  }
  swipePending = data.dir === "next" ? 1 : -1;
  settleSwipe();
  location.hash = "#/" + target;
}


function entryFor(source) {
  let found = null;
  frames.forEach((entry) => {
    if (entry.frame.contentWindow === source) found = entry;
  });
  return found;
}

function onHostMessage(evt) {
  if (evt.origin !== location.origin) return;
  const data = evt.data;
  if (!data || typeof data !== "object") return;
  if (data.type === "swipe" || data.type === "swipe-move") {
    handleSwipe(evt.source, data);
    return;
  }
  if (detailFrame && evt.source === detailFrame.contentWindow) {
    if ((data.type === "detail" || data.type === "detail-next" || data.type === "detail-replace") && typeof data.aid === "string" && data.aid) {
      const nextAid = String(data.aid);
      if (data.type !== "detail-replace") detailHistory.push(nextAid);
      detailFrame.contentWindow.postMessage({ type: "detail-render", aid: nextAid }, location.origin);
      return;
    }
    if (data.type === "detail-back" || data.type === "history") {
      if (detailHistory.length > 1) {
        detailHistory.pop();
        detailFrame.contentWindow.postMessage({ type: "detail-render", aid: detailHistory[detailHistory.length - 1] }, location.origin);
      } else closeDetail();
      return;
    }
    if (data.type === "nav" && typeof data.hash === "string") {
      closeDetail();
      const next = normalizeHash(data.hash);
      if (next !== normalizeHash(location.hash)) location.hash = next;
      return;
    }
    if (data.type === "theme" && (data.theme === "dark" || data.theme === "light")) {
      detailFrame.contentWindow.postMessage({ type: "theme", theme: state.theme }, location.origin);
    }
    return;
  }
  if (data.type === "detail" && typeof data.aid === "string" && data.aid) {
    openDetail(data.aid);
    return;
  }
  const entry = entryFor(evt.source);
  if (!entry) return;
  if (data.type === "ready") {
    markReady(entry);
    post(entry, { type: "theme", theme: state.theme });
    post(entry, { type: "active", on: entry === activeFrame });
    if (entry === activeFrame) {
      post(entry, { type: "restore-scroll", y: scrollPositions.get(entry.key) || 0 });
    }
    return;
  }
  if (data.type === "scroll" && Number.isFinite(data.y)) {
    scrollPositions.set(entry.key, Math.max(0, data.y));
    return;
  }
  if (data.type === "nav" && typeof data.hash === "string") {
    const next = normalizeHash(data.hash);
    if (next === normalizeHash(location.hash)) route();
    else location.hash = next;
    return;
  }
  if (data.type === "replace" && typeof data.hash === "string") {
    // Address-bar bookkeeping from inside a page (search query, library tab). The page
    // stays mounted; only the shell's hash follows it.
    const next = normalizeHash(data.hash);
    try { scrollPositions.set(next, Math.max(0, entry.frame.contentWindow.scrollY || 0)); } catch (_) {}
    rekey(entry, next);
    history.replaceState(null, "", next);
    paintChrome(next);
    return;
  }
  if (data.type === "history" && typeof data.delta === "number" && data.delta !== 0) {
    history.go(data.delta);
    return;
  }
  if (data.type === "theme" && (data.theme === "dark" || data.theme === "light")) {
    if (entry !== activeFrame) return;
    setTheme(data.theme);
    frames.forEach((other) => {
      if (other !== entry) post(other, { type: "theme", theme: state.theme });
    });
    if (detailFrame && detailFrame.contentWindow) {
      detailFrame.contentWindow.postMessage({ type: "theme", theme: state.theme }, location.origin);
    }
  }
}

function openDetail(aid) {
  closeDetail();
  detailHistory = [String(aid)];
  const backdrop = el("button", { class: "detail-backdrop", type: "button", "aria-label": "关闭简介", onClick: closeDetail });
  detailPanel = el("section", { class: "detail-panel", role: "dialog", "aria-label": "作品简介" });
  const handle = el("div", { class: "detail-handle", "aria-label": "向下拖动关闭简介" });
  detailFrame = document.createElement("iframe");
  detailFrame.className = "detail-frame";
  detailFrame.title = "作品简介";
  detailFrame.src = "/?embed=1&overlay=detail#/album/" + encodeURIComponent(aid);
  detailFrame.setAttribute("allow", "fullscreen");
  detailFrame.addEventListener("load", () => {
    if (detailFrame && detailFrame.contentWindow) {
      detailFrame.contentWindow.postMessage({ type: "theme", theme: state.theme }, location.origin);
    }
  });
  detailPanel.append(handle, detailFrame);
  view.append(backdrop, detailPanel);

  let startY = 0;
  let currentY = 0;
  let dragging = false;
  handle.addEventListener("pointerdown", (evt) => {
    dragging = true;
    startY = evt.clientY;
    currentY = 0;
    handle.setPointerCapture(evt.pointerId);
    detailPanel.classList.add("dragging");
  });
  handle.addEventListener("pointermove", (evt) => {
    if (!dragging) return;
    currentY = Math.max(0, evt.clientY - startY);
    detailPanel.style.setProperty("--drag-y", currentY + "px");
    backdrop.style.setProperty("--drag-opacity", String(Math.max(.12, 1 - currentY / 420)));
  });
  const finishDrag = (evt) => {
    if (!dragging) return;
    dragging = false;
    handle.releasePointerCapture(evt.pointerId);
    detailPanel.classList.remove("dragging");
    if (currentY > 110) closeDetail();
    else {
      detailPanel.style.removeProperty("--drag-y");
      backdrop.style.removeProperty("--drag-opacity");
    }
  };
  handle.addEventListener("pointerup", finishDrag);
  handle.addEventListener("pointercancel", finishDrag);
  requestAnimationFrame(() => {
    if (detailPanel) {
      detailPanel.classList.add("open");
      backdrop.classList.add("open");
    }
  });
}

function closeDetail() {
  if (!detailPanel) return;
  const panel = detailPanel;
  const backdrop = view.querySelector(".detail-backdrop");
  panel.classList.remove("open");
  if (backdrop) backdrop.classList.remove("open");
  detailPanel = null;
  detailFrame = null;
  detailHistory = [];
  setTimeout(() => { panel.remove(); if (backdrop) backdrop.remove(); }, 420);
}

function bootShell() {
  view.className = "stage";
  loadingNode = el("div", { class: "stage-loading" }, [
    el("div", { class: "jm-loading jm-loading-stage", role: "status" }, [
      el("div", { class: "jm-loader jm-loader-chapter" }, [
        el("i", { class: "jm-page-left" }),
        el("i", { class: "jm-page-right" }),
      ]),
      el("span", { class: "jm-loading-label", text: "正在翻开页面…" }),
    ]),
  ]);
  view.appendChild(loadingNode);

  window.addEventListener("hashchange", route);
  window.addEventListener("message", onHostMessage);
  setTheme(localStorage.getItem("jmbridge.theme") || "dark");

  if (!location.hash) history.replaceState(null, "", "#/home");
  route();

  bootstrap().then(paintLines).catch(() => {});
  setInterval(() => {
    refreshLines().then(paintLines).catch(() => {
      /* offline is fine, keep the last known dots */
    });
  }, 60000);
}

// ===================================================================== embed mode

let activeCleanup = null;
let activeReader = null;
let renderToken = 0;
let frozenHash = "#/home";
let rawReplaceState = null;
let renderChain = Promise.resolve();

function postHost(message) {
  try {
    if (window.parent && window.parent !== window) window.parent.postMessage(message, location.origin);
  } catch (err) {
    /* detached frame */
  }
}

async function teardown() {
  if (activeReader) {
    const reader = activeReader;
    activeReader = null;
    try {
      reader.close();
    } catch (err) {
      /* already gone */
    }
  }
  if (typeof activeCleanup === "function") {
    try {
      activeCleanup();
    } catch (err) {
      /* keep routing */
    }
  }
  activeCleanup = null;
  // Tiles from the previous screen must not keep a stream open behind the new one, and a
  // screen's event subscriptions die with it (views re-subscribe on render).
  resetCoverStream();
  resetEvents();
  view.innerHTML = "";
}

async function renderRouteNow() {
  const token = ++renderToken;
  const { head, rest, query } = parseHash(frozenHash);

  await teardown();
  if (token !== renderToken) return;

  if (head === READ_HEAD) {
    view.innerHTML = "";
    view.appendChild(el("div", { class: "panel reader-loading", style: "min-height:50vh;display:grid;place-items:center" }, [
      el("div", { class: "muted", text: "正在打开阅读器…" }),
      el("div", { class: "jm-loader jm-loader-chapter", "aria-hidden": "true" }, [
        el("i", { class: "jm-page-left" }), el("i", { class: "jm-page-right" }),
      ]),
    ]));
    try {
      const { openReader } = await import("./views/reader/index.js?v=12");
      if (token !== renderToken) return;
      view.innerHTML = "";
      const reader = await openReader(rest[0], query.get("aid"), () => token === renderToken);
      if (token !== renderToken) {
        try { reader && reader.close && reader.close(); } catch (err) { /* stale route */ }
        return;
      }
      activeReader = reader;
    } catch (err) {
      if (token !== renderToken) return;
      view.innerHTML = "";
      view.appendChild(errorState(String(err && err.message ? err.message : err), () => renderRoute()));
    }
    return;
  }

  const runner = ROUTES[head];
  if (!runner) {
    // Unknown route inside a frame means the shell was handed a bad hash; go home.
    postHost({ type: "nav", hash: "#/home" });
    return;
  }

  try {
    const render = await runner();
    if (token !== renderToken) return;
    const cleanup = await render(view, { rest, query });
    if (token !== renderToken) {
      if (typeof cleanup === "function") cleanup();
      else if (cleanup && typeof cleanup.destroy === "function") cleanup.destroy();
      return;
    }
    activeCleanup = typeof cleanup === "function"
      ? cleanup
      : (cleanup && typeof cleanup.destroy === "function" ? () => cleanup.destroy() : null);
  } catch (err) {
    view.innerHTML = "";
    view.appendChild(errorState(String(err && err.message ? err.message : err), () => renderRoute()));
  }
}

function renderRoute() {
  const run = renderChain.then(renderRouteNow, renderRouteNow);
  renderChain = run.catch(() => {});
  return run;
}

function bootEmbed() {
  restoreTheme(false);
  frozenHash = normalizeHash(location.hash);
  if (location.hash !== frozenHash) rawReplaceState.call(history, null, "", frozenHash);

  // A frame never navigates. It asks the shell to, then puts its own address back so the
  // document it already rendered stays the document it is showing.
  window.addEventListener("hashchange", () => {
    const next = normalizeHash(location.hash);
    if (next === frozenHash) return;
    postHost({ type: "nav", hash: next });
    try {
      rawReplaceState.call(history, null, "", frozenHash);
    } catch (err) {
      /* detached frame */
    }
  });

  let pendingRestoreY = null;
  let restoreObserver = null;
  let restoreTimer = 0;
  // Views check this while drawing: covers stay unloaded until the page has settled at
  // the restored offset, so the position is reached without a burst of image requests
  // for rows the user is scrolling straight past.
  function setRestoring(on) {
    if (on) window.__jmRestoring = true;
    else window.__jmRestoring = false;
    window.dispatchEvent(new CustomEvent("jm:restore-state", { detail: { restoring: on } }));
  }
  function finishRestore() {
    pendingRestoreY = null;
    if (restoreObserver) restoreObserver.disconnect();
    restoreObserver = null;
    clearTimeout(restoreTimer);
    setRestoring(false);
  }
  function applyPendingRestore() {
    if (pendingRestoreY === null) return;
    const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const y = Math.min(pendingRestoreY, maxY);
    window.scrollTo(0, y);
    if (maxY < pendingRestoreY) return;
    requestAnimationFrame(() => {
      if (Math.abs(window.scrollY - pendingRestoreY) < 2) finishRestore();
    });
  }

  window.addEventListener("message", (evt) => {
    if (evt.origin !== location.origin) return;
    const data = evt.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "detail-render" && typeof data.aid === "string" && data.aid) {
      frozenHash = "#/album/" + encodeURIComponent(data.aid);
      rawReplaceState.call(history, null, "", frozenHash);
      renderRoute();
    } else if (data.type === "active" && typeof data.on === "boolean") {
      setSuspended(!data.on);
      if (data.on) resumeCovers();
    } else if (data.type === "restore-scroll" && Number.isFinite(data.y)) {
      pendingRestoreY = Math.max(0, data.y);
      setRestoring(true);
      if (restoreObserver) restoreObserver.disconnect();
      restoreObserver = new MutationObserver(applyPendingRestore);
      restoreObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
      clearTimeout(restoreTimer);
      restoreTimer = setTimeout(finishRestore, 15000);
      requestAnimationFrame(() => requestAnimationFrame(applyPendingRestore));
    } else if (data.type === "theme" && (data.theme === "dark" || data.theme === "light")) {
      setTheme(data.theme, false);
    }
  });

  let scrollFrame = 0;
  window.addEventListener("scroll", () => {
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      if (pendingRestoreY !== null) return;
      postHost({ type: "scroll", y: activeReader && typeof activeReader.currentScroll === "function"
        ? activeReader.currentScroll() : window.scrollY });
    });
  }, { passive: true });

  let dragRail = null;
  let dragPointerId = 0;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragStartScroll = 0;
  let dragFrame = 0;
  let dragLatestDx = 0;
  let dragged = false;
  window.addEventListener("pointerdown", (evt) => {
    if (evt.button !== 0) return;
    const rail = evt.target.closest && evt.target.closest(".rail, .strip");
    if (!rail || rail.scrollWidth <= rail.clientWidth) return;
    dragRail = rail;
    dragPointerId = evt.pointerId;
    dragStartX = evt.clientX;
    dragStartY = evt.clientY;
    dragStartScroll = rail.scrollLeft;
    dragged = false;
  });
  window.addEventListener("pointermove", (evt) => {
    if (!dragRail || evt.pointerId !== dragPointerId) return;
    const dx = evt.clientX - dragStartX;
    const dy = evt.clientY - dragStartY;
    if (!dragged) {
      if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.15) return;
      dragged = true;
      dragRail.setPointerCapture?.(dragPointerId);
      dragRail.classList.add("dragging");
    }
    evt.preventDefault();
    dragLatestDx = dx;
    if (!dragFrame) {
      dragFrame = requestAnimationFrame(() => {
        dragFrame = 0;
        if (dragRail) dragRail.scrollLeft = dragStartScroll - dragLatestDx;
      });
    }
  }, { passive: false });
  window.addEventListener("pointerup", (evt) => {
    if (!dragRail || evt.pointerId !== dragPointerId) return;
    if (dragFrame) cancelAnimationFrame(dragFrame);
    dragFrame = 0;
    if (dragged) {
      dragRail.scrollLeft = dragStartScroll - dragLatestDx;
      dragRail.releasePointerCapture?.(dragPointerId);
    }
    dragRail.classList.remove("dragging");
    dragRail = null;
    dragPointerId = 0;
  });
  window.addEventListener("click", (evt) => {
    if (!dragged) return;
    const rail = evt.target.closest && evt.target.closest(".rail, .strip");
    if (rail) {
      evt.preventDefault();
      evt.stopPropagation();
    }
    dragged = false;
  }, true);
  window.addEventListener("wheel", (evt) => {
    if (Math.abs(evt.deltaY) <= Math.abs(evt.deltaX)) return;
    const rail = evt.target.closest && evt.target.closest(".rail, .strip");
    if (!rail || rail.scrollWidth <= rail.clientWidth) return;
    rail.scrollLeft += evt.deltaY;
    evt.preventDefault();
  }, { passive: false });

  // Wait for the first paint before listening for input, so a queued message cannot
  // arrive at a router that has not started.
  // Sideways drag between tabs. The reader, a sheet, or a horizontal scroller keeps
  // the gesture for itself, so this never steals a rail scroll.
  installTabSwipe({
    send: postHost,
    blocked: () => !!activeReader || !!document.querySelector(".sheet, .backdrop, .detail-panel, [role=dialog]"),
  });

  renderRoute().then(() => {
    postHost({ type: "ready" });
    requestAnimationFrame(() => requestAnimationFrame(() => {
      postHost({ type: "scroll", y: window.scrollY });
    }));
    // Hidden until the shell says otherwise; a background page must not hold a socket.
    setSuspended(true);
  }).catch(() => postHost({ type: "ready" }));
}

function bootShared() {
  rawReplaceState = History.prototype.replaceState;
  // "Back" inside a page means the app's history, which lives in the shell. A local
  // history.back() would blank the frame (its only entry is itself).
  history.back = () => postHost({ type: "history", delta: -1 });
  history.forward = () => postHost({ type: "history", delta: 1 });
  history.go = (delta) => {
    const step = Number(delta) || 0;
    if (step !== 0) postHost({ type: "history", delta: step });
  };
  // replaceState is how search and the library tab keep the URL honest; the shell has to
  // hear about it or the address bar would describe a page the user has left.
  history.replaceState = function (stateObject, title, url) {
    rawReplaceState.call(this, stateObject, title, url);
    const next = normalizeHash(location.hash);
    if (next !== frozenHash) postHost({ type: "replace", hash: next });
  };
}

if (EMBED) {
  bootShared();
  bootEmbed();
} else {
  bootShell();
}

export { icon };
