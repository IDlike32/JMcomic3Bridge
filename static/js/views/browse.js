import { api, qs, fmtNum } from "../api.js";
import { COVER_RADIUS, LIFT, createHoverTracker, drawHoverDetail, drawHoverGlow } from "../canvas-hover.js";
import { isFavorite, toggleFavorite } from "../state.js";
import {
  el, icon, toast, tile, pageHead, segControl, chipStrip, openSheet,
  loadingRow, errorState, emptyState, skeletonGrid, warmCovers,
} from "../ui.js";

const ORDERS = [
  { label: "最新", value: "" },
  { label: "爱心", value: "tf" },
  { label: "日榜", value: "mv_t" },
  { label: "周榜", value: "mv_w" },
  { label: "月榜", value: "mv_m" },
  { label: "总榜", value: "mv" },
];
const PAGE_SIZE = 80;
const WEEK_ISSUES = 36;

function errorMessage(error) {
  return error && error.message ? error.message : String(error || "未知错误");
}

function favoriteTile(item) {
  const nodeRef = { current: null };
  const create = () => {
    const node = tile(item, {
      favorite: isFavorite(item.id),
      onFavorite: async () => {
        try {
          const enabled = await toggleFavorite({ aid: item.id, title: item.name, author: item.author });
          toast(enabled ? "已收藏" : "已取消收藏");
        } catch (error) {
          toast("收藏失败：" + errorMessage(error));
        }
        const old = nodeRef.current;
        const fresh = create();
        if (old && old.isConnected) old.replaceWith(fresh);
      },
    });
    nodeRef.current = node;
    return node;
  };
  return create();
}

export async function renderBrowse(view, ctx) {
  const params = ctx.query;
  let category = params.get("c") || "";
  let order = params.get("o") || "";
  let weekId = params.get("w") || "";
  let weekType = params.get("wt") || "";
  let categories = [];
  let weekCatalog = null;
  let disposed = false;
  let requestId = 0;
  let pager = null;
  let transition = null;
  const filters = { include: [], exclude: [] };
  let filterOpen = false;

  const header = pageHead("浏览", { sub: "加载中…" });
  const sub = header.querySelector(".sub");
  // Same readout as the search page: a label plus a bar, so a long filtered load shows how
  // far along it is instead of only saying "still loading".
  const progressLabel = el("span", { class: "muted tiny", text: "" });
  const progressBar = el("div", {
    class: "search-progress hidden",
    role: "progressbar",
    "aria-label": "浏览加载进度",
    "aria-valuemin": "0",
    "aria-valuemax": "100",
  }, [el("i")]);
  const progressNode = el("div", { class: "browse-progress hidden" }, [progressLabel, progressBar]);
  const stickyRows = el("div", { class: "browse-sticky-order" });
  const orderRow = el("div", { style: "margin-bottom:10px" });
  const categoryRow = el("div", { style: "margin-bottom:10px" });
  const subCategoryRow = el("div", { style: "margin-bottom:10px" });
  const weekRow = el("div", { class: "row wrap hidden", style: "margin-bottom:10px" });
  const toolsRow = el("div", { class: "row wrap", style: "margin-bottom:14px" });
  const filterHost = el("div", { class: "hidden" });
  const content = el("div");
  const onCanvasOpen = (event) => {
    const item = event.detail && event.detail.item;
    const aid = item && String(item.id || item.aid || "");
    if (!aid) return;
    if (window.parent && window.parent !== window) window.parent.postMessage({ type: "detail", aid }, location.origin);
    else location.hash = "#/album/" + aid;
  };
  const onCanvasFavorite = async (event) => {
    const { item, index } = event.detail || {};
    if (!item) return;
    try {
      item.is_favorite = await toggleFavorite({ aid: item.id || item.aid, title: item.name, author: item.author });
      content.dispatchEvent(new CustomEvent("browse:itemstate", { detail: { item, index, enabled: item.is_favorite } }));
      if (pager && typeof pager.draw === "function") pager.draw();
    } catch (error) { toast("收藏失败：" + errorMessage(error)); }
  };
  content.addEventListener("browse:itemopen", onCanvasOpen);
  content.addEventListener("browse:itemfavorite", onCanvasFavorite);
  stickyRows.append(header, progressNode, orderRow, categoryRow, subCategoryRow, weekRow, toolsRow, filterHost);
  view.classList.add("browse-view");
  view.append(stickyRows, content);

  function setSubtitle(text) {
    if (sub) sub.textContent = text;
  }

  function updateUrl() {
    history.replaceState(null, "", "#/browse" + qs({ c: category, o: order, w: weekId, wt: weekType }));
  }

  function mainCategories() {
    return categories.filter((item) => String(item.id) !== "0");
  }

  function resolveCategory(slug) {
    if (!slug) return { parent: "", child: "" };
    const parent = mainCategories().find((item) => item.slug === slug);
    if (parent) return { parent: slug, child: "" };
    const owner = mainCategories().find((item) => (item.sub_categories || []).some((child) => child.slug === slug));
    return owner ? { parent: owner.slug, child: slug } : { parent: "", child: "" };
  }

  function paintCategories() {
    const resolved = resolveCategory(category);
    if (resolved.parent !== (resolveCategory(category).parent)) category = resolved.parent;
    categoryRow.replaceChildren(chipStrip(
      [{ label: "最新A漫", value: "" }].concat(mainCategories().map((item) => ({ label: item.name, value: item.slug }))),
      {
        value: resolved.parent,
        allowEmpty: false,
        onChange: (value) => {
          category = value || "";
          updateUrl();
          paintCategories();
          loadPage(1, 1, true);
        },
      }
    ));
    const parent = mainCategories().find((item) => item.slug === resolved.parent);
    const children = parent && parent.sub_categories || [];
    subCategoryRow.classList.toggle("hidden", !children.length);
    subCategoryRow.replaceChildren();
    if (!children.length) return;
    subCategoryRow.appendChild(chipStrip(
      [{ label: "全部", value: "" }].concat(children.map((item) => ({ label: item.name, value: item.slug }))),
      {
        value: resolved.child,
        allowEmpty: false,
        onChange: (value) => {
          category = value || resolved.parent;
          updateUrl();
          paintCategories();
          loadPage(1, 1, true);
        },
      }
    ));
  }

  function weeklyLabel() {
    const issue = (weekCatalog && weekCatalog.categories || []).find((item) => String(item.id) === String(weekId));
    const type = (weekCatalog && weekCatalog.types || []).find((item) => String(item.id) === String(weekType));
    return "週刊 · " + (issue ? issue.time : "第 " + weekId + " 期") + (type ? " · " + type.title : "");
  }

  function paintMode() {
    const weekly = Boolean(weekId);
    orderRow.classList.toggle("hidden", weekly);
    categoryRow.classList.toggle("hidden", weekly);
    subCategoryRow.classList.toggle("hidden", weekly);
    weekRow.classList.toggle("hidden", !weekly);
    weekRow.replaceChildren();
    if (!weekly) return;
    weekRow.append(
      el("span", { class: "tiny muted grow ellipsis", text: weeklyLabel() }),
      el("button", {
        class: "chip", type: "button", text: "退出週刊",
        onClick: () => {
          weekId = "";
          weekType = "";
          updateUrl();
          paintMode();
          paintCategories();
          loadPage(1, 1, true);
        },
      })
    );
  }

  function showFilterSheet() {
    filterOpen = !filterOpen;
    filterHost.classList.toggle("hidden", !filterOpen);
    if (!filterOpen) filterHost.className = "hidden";
    if (filterOpen) renderBrowseFilter();
  }

  function browseConditionMatches(item, condition) {
    const needle = String(condition.value || "").trim().toLowerCase();
    if (!needle) return true;
    const values = (value) => (Array.isArray(value) ? value : [value]).map((part) => String(part && typeof part === "object" ? (part.name || part.title || "") : part || "").toLowerCase());
    if (condition.type === "work") return String(item.name || item.title || "").toLowerCase().includes(needle);
    if (condition.type === "author") return values([item.author, item.authors, item.artist].flat()).some((value) => value.includes(needle));
    if (condition.type === "tag") return values(item.tags || item.tag || []).some((value) => value.includes(needle));
    if (condition.type === "character") return values([item.character, item.characters, item.actor, item.actors, item.cast].flat()).some((value) => value.includes(needle));
    if (condition.type === "category") return values(item.category && (item.category.title || item.category.name)).some((value) => value.includes(needle));
    return false;
  }

  function applyBrowseFilters() {
    if (pager && typeof pager.setFilters === "function") pager.setFilters(true);
  }

  // A filter runs on what has been loaded so far, so the first page is usually whittled down
  // to a list too short to scroll -- and a list that cannot scroll never asks for the next
  // page, which is how an ordinary filter used to look like "no results". While a filter is
  // armed the pager keeps pulling pages until the matches fill the screen or the source runs out.
  function filtersArmed() {
    return filters.include.length > 0 || filters.exclude.length > 0;
  }

  function renderBrowseFilter() {
    const types = [{ label: "标题", value: "work" }, { label: "作者", value: "author" }, { label: "标签", value: "tag" }, { label: "人物", value: "character" }, { label: "分类", value: "category" }];
    const register = () => { renderBrowseFilter(); applyBrowseFilters(); };
    const group = (key, label) => {
      const type = el("select", { class: "select" }, types.map((row) => el("option", { value: row.value, text: row.label })));
      const value = el("input", { class: "input", placeholder: label + "值…" });
      const list = el("div", { class: "chips" });
      const redraw = () => list.replaceChildren(...filters[key].map((condition, index) => el("button", { class: "chip on", type: "button", text: (types.find((row) => row.value === condition.type) || types[0]).label + " · " + condition.value + " ×", onClick: () => { filters[key].splice(index, 1); redraw(); register(); } })));
      const add = el("button", { class: "btn ghost sm", type: "button", text: "添加", onClick: () => { const text = value.value.trim(); if (!text) return; filters[key].push({ type: type.value, value: text }); value.value = ""; redraw(); register(); } });
      value.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); add.click(); } });
      redraw();
      return el("div", { class: "section" }, [el("div", { class: "muted tiny", text: label }), el("div", { class: "row wrap", style: "gap:8px" }, [type, value, add]), list]);
    };
    const clear = el("button", { class: "btn ghost sm", type: "button", text: "清除条件", onClick: () => { filters.include = []; filters.exclude = []; register(); } });
    filterHost.className = "browse-filter-panel";
    filterHost.replaceChildren(el("div", { class: "advanced-panel" }, [
      group("include", "包含"),
      group("exclude", "排除"),
      clear,
      el("div", { class: "muted tiny", text: "筛选范围：当前已加载的浏览结果，边加载边筛选" }),
    ]));
  }

  async function showWeekPicker() {
    try {
      if (!weekCatalog) weekCatalog = await api.week();
    } catch (error) {
      toast("週刊列表加载失败");
      return;
    }
    if (disposed) return;
    const types = weekCatalog.types || [];
    const issues = (weekCatalog.categories || []).slice(0, WEEK_ISSUES);
    let selectedType = weekType || (types[0] && types[0].id) || "";
    const body = el("div");
    body.appendChild(segControl({
      options: types.map((item) => ({ label: item.title || item.id, value: item.id })),
      value: selectedType,
      onChange: (value) => { selectedType = value; },
    }));
    body.appendChild(el("div", { class: "chips", style: "margin-top:12px" }, issues.map((issue) => el("button", {
      class: "chip" + (String(issue.id) === String(weekId) ? " on" : ""),
      type: "button",
      text: issue.time || "第 " + issue.id + " 期",
      onClick: () => {
        weekId = String(issue.id);
        weekType = selectedType;
        sheet.close();
        updateUrl();
        paintMode();
        loadPage(1, 1, true);
      },
    }))));
    const sheet = openSheet({ title: "週刊", subtitle: "选择期数", body });
  }

  function setPager(next) {
    if (pager) pager.disconnect();
    pager = next;
  }

  function loadPage(target, direction, reset) {
    const id = ++requestId;
    if (reset) {
      setPager(null);
      content.replaceChildren(skeletonGrid(12));
      window.scrollTo({ top: 0, behavior: "auto" });
    }
    const keyPrefix = weekId ? "week:" + weekId + ":" + weekType : "browse:" + category + ":" + order;
    const pageCache = new Map();
    const inFlight = new Map();
    const sourceItems = [];
    let items = sourceItems;
    const seen = new Set();
    const imageCache = new Map();
    const WINDOW_ROWS = 16;
    const PAGE_SIZE = 80;
    let page = 0;
    let total = 0;
    let hasMore = true;
    // Filtered mode reads the source back to back on its own. It used to stop as soon as the
    // matches filled the screen (and again after a page budget), which looked identical to a
    // hang: the bar froze at 12% while the label still claimed it was loading.
    const AUTOFILL_GAP = 120;      // ms between pages, so the chain is steady rather than a burst
    const AUTOFILL_RETRIES = 3;
    let autofill = false;
    let autofillTimer = 0;
    let autofillFailures = 0;
    let autofillKey = "";
    let autofillStalled = false;
    let filteredCount = 0;
    let columns = 1;
    let cardWidth = 104;
    let cardHeight = 260;
    let rowGap = 10;
    let frame = 0;
    let disposedPager = false;
    let status;
    let fpsNode;
    let canvas;
    let track;
    let pointerDown = false;
    let focusedIndex = 0;
    const hover = createHoverTracker();
    let canvasFocused = false;
    let loopFrame = 0;
    let loopAt = 0;
    let shimmerActive = false;
    const debugFps = new URLSearchParams(location.search).get("debugFps") === "1";
    const fpsSamples = [];
    let lowFrames = 0;
    let lastFpsAt = 0;
    let lastInterval = 0;
    let lastDrawStart = 0;
    let lastDrawDuration = 0;
    let renderedCards = 0;
    const coverProgress = new Map();
    const coverRetries = new Map();
    const COVER_MAX_ATTEMPTS = 6;
    const coverTimeouts = new Map();
    let restoring = Boolean(window.__jmRestoring);
    const onRestoreState = (event) => {
      const next = Boolean(event && event.detail && event.detail.restoring);
      if (next === restoring) return;
      restoring = next;
      draw();
    };
    window.addEventListener("jm:restore-state", onRestoreState);

    const state = { disconnect() {
      shimmerActive = false;
      stopLoop();
      hover.reset();
      clearTimeout(autofillTimer);
      disposedPager = true;
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("jm:restore-state", onRestoreState);
      if (frame) cancelAnimationFrame(frame);
      imageCache.forEach((image) => { image.onload = null; image.onerror = null; image.src = ""; });
      coverTimeouts.forEach((timeout) => clearTimeout(timeout));
      coverTimeouts.clear();
    } };
    state.draw = () => draw();
    state.setFilters = (resetScroll) => {
      const matches = (item, condition) => browseConditionMatches(item, condition);
      const matching = (item) => filters.include.every((condition) => matches(item, condition)) && !filters.exclude.some((condition) => matches(item, condition));
      const filtered = filters.include.length > 0 || filters.exclude.length > 0;
      items = filtered ? sourceItems.filter(matching) : sourceItems;
      filteredCount = items.length;
      focusedIndex = Math.min(focusedIndex, Math.max(0, items.length - 1));
      hover.reset();
      track.style.height = trackHeight() + "px";
      if (resetScroll) window.scrollTo({ top: 0, behavior: "auto" });
      autofill = filtered;
      // Every append re-runs the filter; only a changed condition set resets the retry state,
      // or a transient failure would be forgotten on the next page that arrives.
      const key = JSON.stringify([filters.include, filters.exclude]);
      if (key !== autofillKey) {
        autofillKey = key;
        autofillFailures = 0;
        autofillStalled = false;
      }
      paintStatus();
      draw();
      checkPrefetch();
      pumpAutofill();
    };
    // The only stop conditions are the source running out, the tab being hidden, or repeated
    // failures. Nothing here waits for the user to scroll.
    function pumpAutofill() {
      clearTimeout(autofillTimer);
      if (!autofill || autofillStalled || disposed || disposedPager || !hasMore) return;
      // A hidden tab stops the chain instead of reading the catalogue on a dead screen; the
      // visibility listener resumes it when the page comes back.
      if (document.hidden) return;
      // Back off while pages are failing, so a struggling source is not hammered.
      const delay = AUTOFILL_GAP * Math.max(1, autofillFailures * 3);
      autofillTimer = setTimeout(() => {
        autofillTimer = 0;
        if (!autofill || autofillStalled || disposed || disposedPager || !hasMore || document.hidden) return;
        fetchPage(page + 1);
      }, delay);
    }

    function stallAutofill(message) {
      autofillStalled = true;
      clearTimeout(autofillTimer);
      autofillTimer = 0;
      if (status) {
        status.textContent = message + " · 点这里继续加载";
        status.classList.add("error");
        status.style.cursor = "pointer";
      }
      paintStatus();
    }

    function resumeAutofill() {
      if (!autofill) return;
      autofillStalled = false;
      autofillFailures = 0;
      if (status) { status.classList.remove("error"); status.style.cursor = ""; }
      paintStatus();
      pumpAutofill();
    }
    setPager(state);

    function metrics() {
      const width = track.clientWidth;
      const wide = window.matchMedia("(min-width: 1100px)").matches;
      const medium = window.matchMedia("(min-width: 600px)").matches;
      const min = wide ? 150 : medium ? 132 : 104;
      rowGap = wide ? 16 : medium ? 14 : 10;
      columns = Math.max(1, Math.floor((width + rowGap) / (min + rowGap)));
      cardWidth = (width - rowGap * (columns - 1)) / columns;
      cardHeight = cardWidth * 4 / 3 + 72;
    }

    function totalRows() { return Math.max(1, Math.ceil(items.length / columns)); }
    function trackHeight() { return Math.max(window.innerHeight, totalRows() * (cardHeight + rowGap) + rowGap); }
    function visibleRange() {
      const top = track.getBoundingClientRect().top + window.scrollY;
      const row = Math.max(0, Math.floor((window.scrollY - top) / (cardHeight + rowGap)));
      const first = Math.max(0, row - 2);
      const last = Math.min(totalRows(), row + Math.ceil(window.innerHeight / (cardHeight + rowGap)) + 2);
      return { top, row, first, last };
    }

    function retryCover(item, aid, previousImage) {
      const attempts = coverRetries.get(aid) || 0;
      if (disposed || disposedPager) return;
      if (attempts >= COVER_MAX_ATTEMPTS) {
        // A cover that has failed this often is not coming back on its own. Retrying it
        // forever also keeps the shimmer alive, which repaints the whole canvas at 60fps
        // for as long as the browse page is open.
        if (previousImage) { previousImage.onload = null; previousImage.onerror = null; previousImage.src = ""; }
        imageCache.delete(aid);
        clearTimeout(coverTimeouts.get(aid));
        coverTimeouts.delete(aid);
        scheduleDraw();
        return;
      }
      coverRetries.set(aid, attempts + 1);
      if (previousImage) { previousImage.onload = null; previousImage.onerror = null; previousImage.src = ""; }
      imageCache.delete(aid);
      clearTimeout(coverTimeouts.get(aid));
      const delay = Math.min(2000, 500 + attempts * 250);
      const timer = setTimeout(() => {
        coverTimeouts.delete(aid);
        if (!disposed && !disposedPager) { imageFor(item, true); scheduleDraw(); }
      }, delay);
      coverTimeouts.set(aid, timer);
    }

    function imageFor(item, retry) {
      const aid = String(item.id || item.aid || "");
      if (!aid) return null;
      // Nothing is requested while the page is still settling at a restored offset: the
      // rows it scrolls past would be downloaded and thrown away.
      if (restoring) return null;
      let image = imageCache.get(aid);
      if (!image) {
        image = new Image();
        image.decoding = "async";
        image.src = api.progCoverUrl(aid, 360) + (retry ? "&retry=" + Date.now() : "");
        coverProgress.set(aid, 0);
        const timeout = setTimeout(() => {
          if (!image.complete) retryCover(item, aid, image);
        }, 8000);
        coverTimeouts.set(aid, timeout);
        image.onload = () => {
          clearTimeout(coverTimeouts.get(aid));
          coverTimeouts.delete(aid);
          coverRetries.delete(aid);
          const start = performance.now();
          const fade = (now) => {
            const progress = Math.min(1, (now - start) / 220);
            coverProgress.set(aid, progress);
            scheduleDraw();
            if (progress < 1) requestAnimationFrame(fade);
          };
          requestAnimationFrame(fade);
        };
        image.onerror = () => {
          clearTimeout(coverTimeouts.get(aid));
          retryCover(item, aid, image);
        };
        imageCache.set(aid, image);
      }
      return image;
    }

    function drawWrappedTitle(ctx, text, x, y, maxWidth, maxLines) {
      const chars = Array.from(String(text || "(untitled)"));
      const lines = [];
      let line = "";
      while (chars.length && lines.length < maxLines) {
        const char = chars.shift();
        if (ctx.measureText(line + char).width <= maxWidth || !line) line += char;
        else { lines.push(line); line = char; }
      }
      if (line && lines.length < maxLines) lines.push(line);
      if (chars.length && lines.length) {
        const last = lines.length - 1;
        while (lines[last] && ctx.measureText(lines[last] + "…").width > maxWidth) lines[last] = Array.from(lines[last]).slice(0, -1).join("");
        lines[last] += "…";
      }
      lines.forEach((value, index) => ctx.fillText(value, x, y + index * 16));
    }

    function roundedRect(ctx, x, y, width, height, radius) {
      const r = Math.min(radius, width / 2, height / 2);
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + width, y, x + width, y + height, r);
      ctx.arcTo(x + width, y + height, x, y + height, r);
      ctx.arcTo(x, y + height, x, y, r);
      ctx.arcTo(x, y, x + width, y, r);
      ctx.closePath();
    }

    // One frame loop drives both the loading shimmer and the hover easing, so a hover that
    // starts while covers load does not put two full repaints into the same frame.
    function ensureLoop() {
      if (loopFrame || disposed || disposedPager || id !== requestId) return;
      loopAt = performance.now();
      loopFrame = requestAnimationFrame(pump);
    }

    function pump(now) {
      loopFrame = 0;
      if (disposed || disposedPager || id !== requestId) { shimmerActive = false; return; }
      const dt = Math.min(64, Math.max(0, now - loopAt));
      loopAt = now;
      hover.step(dt);
      draw();
      draw.lastAt = performance.now();
    }

    function stopLoop() {
      if (loopFrame) cancelAnimationFrame(loopFrame);
      loopFrame = 0;
    }

    function draw() {
      if (!canvas || disposed || disposedPager || id !== requestId) return;
      const drawStart = performance.now();
      metrics();
      const dpr = window.devicePixelRatio || 1;
      const width = track.clientWidth;
      const height = Math.max(1, window.innerHeight);
      canvas.style.width = width + "px";
      canvas.style.height = height + "px";
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
      }
      const ctx = canvas.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const range = visibleRange();
      const scrollTop = Math.max(0, window.scrollY - range.top);
      const themeStyles = getComputedStyle(document.documentElement);
      const titleColor = themeStyles.getPropertyValue("--text").trim() || "#e9edf4";
      const authorColor = themeStyles.getPropertyValue("--muted").trim() || "#7c8698";
      const hoverColor = themeStyles.getPropertyValue("--accent").trim() || "#e8556d";
      renderedCards = 0;
      let shimmerNeeded = false;
      ctx.font = "12.5px 'Microsoft YaHei Local', 'Microsoft YaHei', sans-serif";
      for (let index = range.first * columns; index < Math.min(items.length, range.last * columns); index += 1) {
        const item = items[index];
        renderedCards += 1;
        const column = index % columns;
        const row = Math.floor(index / columns);
        const x = column * (cardWidth + rowGap);
        const y = row * (cardHeight + rowGap) - scrollTop;
        // Hover grows the cover itself instead of stacking an overlay on it, so the lift reads
        // as the card coming forward while the title block underneath stays put.
        const hoverValue = hover.progress(index);
        const grow = LIFT * hoverValue;
        const coverHeight = cardWidth * 4 / 3;
        const left = x - grow;
        const top = y - grow;
        const coverWidth = cardWidth + grow * 2;
        const boxHeight = coverHeight + grow * 2;
        const radius = COVER_RADIUS + 2 * hoverValue;
        ctx.fillStyle = "#20272b";
        roundedRect(ctx, left, top, coverWidth, boxHeight, radius);
        ctx.fill();
        ctx.save();
        roundedRect(ctx, left, top, coverWidth, boxHeight, radius);
        ctx.clip();
        const image = imageFor(item);
        if (image && image.complete && image.naturalWidth) {
          const scale = Math.max(coverWidth / image.naturalWidth, boxHeight / image.naturalHeight);
          const iw = image.naturalWidth * scale;
          const ih = image.naturalHeight * scale;
          const alpha = coverProgress.get(String(item.id || item.aid)) ?? 1;
          ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
          ctx.drawImage(image, left + (coverWidth - iw) / 2, top + (boxHeight - ih) / 2, iw, ih);
          ctx.globalAlpha = 1;
        } else if (restoring) {
          // While the offset is still being settled, a still placeholder keeps the frame
          // cheap: no gradient sweep, no follow-up frames, no image traffic.
          ctx.fillStyle = "#252e33"; ctx.fillRect(left, top, coverWidth, boxHeight);
        } else if ((coverRetries.get(String(item.id || item.aid)) || 0) >= COVER_MAX_ATTEMPTS) {
          // Given up: a still placeholder costs one fill instead of a per-frame animation.
          ctx.fillStyle = "#252e33"; ctx.fillRect(left, top, coverWidth, boxHeight);
        } else {
          const phase = (performance.now() / 900 + index * 0.17) % 1;
          const gradient = ctx.createLinearGradient(left - coverWidth + phase * coverWidth * 3, top, left + phase * coverWidth * 3, top);
          gradient.addColorStop(0, "#252e33"); gradient.addColorStop(.5, "#46535a"); gradient.addColorStop(1, "#252e33");
          ctx.fillStyle = gradient; ctx.fillRect(left, top, coverWidth, boxHeight);
          shimmerNeeded = true;
        }
        ctx.restore();
        if (hoverValue > 0) {
          drawHoverGlow(ctx, left, top, coverWidth, boxHeight, radius, hoverValue, hoverColor);
          drawHoverDetail(ctx, left, top, coverWidth, boxHeight, radius, hoverValue, hoverColor);
        }
        const badgeX = left + coverWidth - 18;
        const badgeY = top + 18;
        ctx.fillStyle = "rgba(8,10,14," + (0.62 + 0.14 * hoverValue).toFixed(3) + ")";
        ctx.beginPath(); ctx.arc(badgeX, badgeY, 12, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = item.is_favorite || isFavorite(item.id) ? "#ff6680" : "#e9eef0";
        ctx.font = "16px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("♥", badgeX, badgeY + 6);
        ctx.textAlign = "left";
        ctx.fillStyle = titleColor;
        ctx.font = "12.5px 'Microsoft YaHei Local', 'Microsoft YaHei', sans-serif";
        const title = item.name || item.title || "(untitled)";
        drawWrappedTitle(ctx, title, x + 2, y + coverHeight + 16, cardWidth - 4, 2);
        ctx.fillStyle = authorColor;
        ctx.font = "11px system-ui, sans-serif";
        const author = item.author || (item.category && item.category.title) || "";
        ctx.fillText(author.length > 20 ? author.slice(0, 19) + "…" : author, x + 2, y + coverHeight + 54, cardWidth - 4);
        if (index === focusedIndex && canvasFocused) {
          // Keyboard focus only: a persistent ring on the first card made the whole grid look
          // selected before the user had touched it. It tracks the hovered geometry so the two
          // rings never end up nested when a card is hovered and focused at once.
          ctx.strokeStyle = hoverColor;
          ctx.lineWidth = 2;
          roundedRect(ctx, left - 1, top - 1, coverWidth + 2, boxHeight + 2, radius + 1);
          ctx.stroke();
        }
      }
      lastDrawDuration = performance.now() - drawStart;
      if (debugFps) updateFpsOverlay(performance.now());
      shimmerActive = shimmerNeeded && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (shimmerActive || hover.busy()) ensureLoop();
      else stopLoop();
    }

    function updateFpsOverlay(now) {
      if (!fpsNode) return;
      if (lastFpsAt) {
        lastInterval = now - lastFpsAt;
        if (lastInterval > 33) lowFrames += 1;
      }
      lastFpsAt = now;
      fpsSamples.push(now);
      while (fpsSamples.length && now - fpsSamples[0] > 1000) fpsSamples.shift();
      const fps = Math.max(0, fpsSamples.length - 1);
      fpsNode.textContent = fps + " FPS | frame " + lastInterval.toFixed(1) + " ms | draw " + lastDrawDuration.toFixed(1) + " ms | cards " + renderedCards + " | low " + lowFrames;
      fpsNode.classList.toggle("low", fps < 30);
    }

    function scheduleDraw() {
      if (frame) return;
      frame = requestAnimationFrame((now) => {
        frame = 0;
        draw();
        draw.lastAt = now;
        checkPrefetch();
      });
    }

    function itemAt(clientX, clientY) {
      const range = visibleRange();
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      // Must match draw(): the sticky canvas only starts scrolling once the track reaches the
      // top of the viewport, so the offset is clamped instead of going negative above it.
      const logicalY = clientY - rect.top + Math.max(0, window.scrollY - range.top);
      const column = Math.floor(x / (cardWidth + rowGap));
      const row = Math.floor(logicalY / (cardHeight + rowGap));
      if (column < 0 || column >= columns || row < 0) return -1;
      const localX = x - column * (cardWidth + rowGap);
      const localY = logicalY - row * (cardHeight + rowGap);
      if (localX > cardWidth || localY > cardHeight || localY < 0) return -1;
      const index = row * columns + column;
      return index < items.length ? index : -1;
    }

    function dispatch(name, detail) { canvas.dispatchEvent(new CustomEvent(name, { detail, bubbles: true })); }
    function activate(index) {
      if (index < 0 || index >= items.length) return;
      focusedIndex = index;
      dispatch("browse:itemopen", { item: items[index], index });
      scheduleDraw();
    }

    function bindCanvasEvents() {
      // The pointer only sets a target; the frame loop eases each card towards it, so a fast
      // sweep leaves a short trail of cards settling back instead of snapping.
      canvas.addEventListener("pointermove", (event) => {
        const next = itemAt(event.clientX, event.clientY);
        canvas.style.cursor = next >= 0 ? "pointer" : "";
        if (hover.setTarget(next)) scheduleDraw();
      });
      canvas.addEventListener("pointerleave", () => {
        canvas.style.cursor = "";
        if (hover.setTarget(-1)) scheduleDraw();
      });
      // The focus ring follows real keyboard focus, so a mouse user never sees one.
      canvas.addEventListener("focus", () => { canvasFocused = true; draw(); });
      canvas.addEventListener("blur", () => { canvasFocused = false; draw(); });
      canvas.addEventListener("click", async (event) => {
        const index = itemAt(event.clientX, event.clientY);
        if (index < 0) return;
        const rect = canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const column = index % columns;
        const localX = x - column * (cardWidth + rowGap);
        const localY = (event.clientY - rect.top + Math.max(0, window.scrollY - visibleRange().top)) % (cardHeight + rowGap);
        if (localY < 36 && localX > cardWidth - 42) dispatch("browse:itemfavorite", { item: items[index], index });
        else activate(index);
      });
      canvas.addEventListener("keydown", (event) => {
        if (event.key === "ArrowRight") focusedIndex = Math.min(items.length - 1, focusedIndex + 1);
        else if (event.key === "ArrowLeft") focusedIndex = Math.max(0, focusedIndex - 1);
        else if (event.key === "ArrowDown") focusedIndex = Math.min(items.length - 1, focusedIndex + columns);
        else if (event.key === "ArrowUp") focusedIndex = Math.max(0, focusedIndex - columns);
        else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(focusedIndex); return; }
        else return;
        dispatch("browse:itemfocus", { item: items[focusedIndex], index: focusedIndex });
        scheduleDraw();
      });
    }

    function appendPage(data, pageNumber) {
      const batch = data.items || data.list || [];
      for (const item of batch) {
        const key = String(item.id || item.aid || "");
        if (!key || seen.has(key)) continue;
        seen.add(key); sourceItems.push(item);
      }
      state.setFilters(false);
      total = Number(data.total) || total;
      page = Math.max(page, pageNumber);
      if (weekId || !batch.length || (total && sourceItems.length >= total)) hasMore = false;
      track.style.height = trackHeight() + "px";
      // During a filtered sweep the pages are thrown away by the filter, so warming their
      // covers would queue requests for artwork the user may never see.
      if (!autofill) warmCovers(batch.map((item) => item.id || item.aid), 360);
      paintStatus();
      draw();
      scheduleDraw();
      requestAnimationFrame(() => { checkPrefetch(); pumpAutofill(); });
      return batch.length;
    }

    // The subtitle and the bar are the only places that can explain a filtered list honestly:
    // how much matched, how far through the source that reading is, and whether it is done.
    function paintStatus() {
      const loaded = sourceItems.length;
      const percents = total > 0 ? Math.min(100, loaded / total * 100) : 0;
      const armed = autofill;
      progressNode.classList.toggle("hidden", !armed);
      if (!armed) {
        progressBar.classList.remove("indeterminate");
        progressLabel.textContent = "";
        setSubtitle(weekId ? weeklyLabel() : total ? "已加载 " + fmtNum(loaded) + " / " + fmtNum(total) + " 部" : "已加载 " + fmtNum(loaded) + " 部");
        return;
      }
      setSubtitle("筛选命中 " + fmtNum(filteredCount) + " · 已读 " + fmtNum(loaded) + (total ? " / " + fmtNum(total) : ""));
      // The bar can only be a percentage when the source reports a total. Without one it runs
      // as an indeterminate sweep -- a made-up fraction would be a lie about progress.
      const running = hasMore && !autofillStalled;
      progressBar.classList.toggle("indeterminate", running && !total);
      progressBar.setAttribute("aria-valuenow", String(Math.round(percents)));
      progressBar.firstElementChild.style.width = total ? percents + "%" : "";
      if (autofillStalled) progressLabel.textContent = "加载已暂停 · 点下方提示继续";
      else if (running) progressLabel.textContent = total ? "自动加载中… " + Math.round(percents) + "%" : "自动加载中… 已读 " + fmtNum(loaded) + " 部";
      else progressLabel.textContent = "已扫描到底 · 共命中 " + fmtNum(filteredCount);
    }

    async function fetchPage(pageNumber) {
      if (disposed || disposedPager || !hasMore || inFlight.has(pageNumber)) return;
      const request = weekId ? api.week(weekId, weekType) : api.browse(category, order, pageNumber);
      inFlight.set(pageNumber, request);
      // The status row belongs to the unfiltered flow; a filtered sweep reports through the
      // progress readout, and rewriting this row would erase a stall message the user must click.
      if (status && !autofill) status.textContent = "加载中…";
      try {
        const data = pageCache.get(pageNumber) || await request;
        if (disposed || disposedPager || id !== requestId) return;
        pageCache.set(pageNumber, data);
        if (!appendPage(data, pageNumber)) hasMore = false;
        autofillFailures = 0;
        if (status && !autofill) {
          status.textContent = hasMore ? "继续下滑加载" : "已经到底了";
          status.classList.remove("error");
          status.style.cursor = "";
        }
      } catch (error) {
        autofillFailures += 1;
        if (autofill && autofillFailures >= AUTOFILL_RETRIES) {
          // A sweep that keeps failing is stopped and handed back to the user instead of
          // spinning on the same page forever.
          stallAutofill("已读 " + fmtNum(sourceItems.length) + " 部后加载失败：" + errorMessage(error));
        } else if (status && !autofill) {
          status.textContent = "加载失败，继续下滑重试：" + errorMessage(error);
          status.classList.add("error");
        }
      } finally {
        inFlight.delete(pageNumber);
        // The chain must be re-armed from here, not only from appendPage: a failed page never
        // appends, so relying on the success path would leave the sweep silently dead.
        if (autofill && hasMore && !autofillStalled && !disposedPager) pumpAutofill();
      }
    }

    function checkPrefetch() {
      if (!hasMore || disposedPager || id !== requestId || weekId) return;
      if (autofill) return;
      const range = visibleRange();
      const visibleEnd = Math.min(sourceItems.length, (range.last + 2) * columns);
      if (sourceItems.length && sourceItems.length - visibleEnd <= PAGE_SIZE) fetchPage(page + 1);
    }
    function onScroll() { scheduleDraw(); }
    function onVisibility() { if (!document.hidden) resumeAutofill(); }
    function onResize() { track.style.height = trackHeight() + "px"; scheduleDraw(); }

    canvas = document.createElement("canvas");
    canvas.className = "browse-canvas";
    canvas.tabIndex = 0;
    canvas.setAttribute("role", "listbox");
    canvas.setAttribute("aria-label", "书籍浏览");
    bindCanvasEvents();
    track = el("div", { class: "browse-canvas-track" });
    track.appendChild(canvas);
    status = loadingRow("加载中…");
    // The stalled state is the one place the sweep hands control back, so the row is clickable.
    status.addEventListener("click", () => { if (autofillStalled) resumeAutofill(); });
    if (debugFps) {
      fpsNode = el("div", { class: "browse-fps", role: "status" });
      content.appendChild(fpsNode);
    }
    content.replaceChildren(track, status);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    metrics();
    track.style.height = trackHeight() + "px";
    metrics();
    draw();
    fetchPage(1);
  }

  function buildToolbar() {
    orderRow.replaceChildren(segControl({
      options: ORDERS,
      value: order,
      onChange: (value) => {
        order = value || "";
        updateUrl();
        loadPage(1, 1, true);
      },
    }));
    const filter = el("button", { class: "btn sm", type: "button", onClick: showFilterSheet }, [icon("filter"), el("span", { text: "筛选" })]);
    const week = el("button", { class: "chip" + (weekId ? " on" : ""), type: "button", onClick: showWeekPicker }, [icon("clock"), el("span", { text: "週刊" })]);
    toolsRow.replaceChildren(filter, week);
  }

  try {
    content.replaceChildren(skeletonGrid(12));
    categories = (await api.categories()).categories || [];
    if (disposed) return () => {};
    paintCategories();
    buildToolbar();
    paintMode();
    updateUrl();
    loadPage(1, 1, true);
  } catch (error) {
    if (!disposed) content.replaceChildren(errorState(errorMessage(error), () => renderBrowse(view, ctx)));
  }

  return () => {
    disposed = true;
    requestId += 1;
    setPager(null);
    content.replaceChildren();
    view.replaceChildren();
  };
}
