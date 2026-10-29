// Search: debounced query, paged results, SSE expansion, and local advanced filters.
import { api } from "../api.js";
import {
  el, icon, iconButton, toast, section, segControl, tile, tileGrid,
  skeletonGrid, loadingRow, emptyState, errorState, listRow, infiniteScroll,
} from "../ui.js";

const HISTORY_KEY = "jmbridge.searchHistory";
const HISTORY_MAX = 20;
const ORDERS = [
  { label: "最新", value: "mr" },
  { label: "人气", value: "mv" },
  { label: "收藏", value: "tf" },
];

function readHistory() {
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter((word) => typeof word === "string" && word.trim()).slice(0, HISTORY_MAX);
  } catch (err) {
    return [];
  }
}

function writeHistory(list) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX)));
  } catch (err) {
    /* private mode: history is a nicety, searching must still work */
  }
}

function rememberQuery(word) {
  const q = String(word || "").trim();
  if (!q) return;
  writeHistory([q].concat(readHistory().filter((saved) => saved !== q)));
}

export async function renderSearch(view, ctx) {
  const query = (ctx && ctx.query) || new URLSearchParams();
  const wantedOrder = query.get("o");
  const SEARCH_TYPES = [{ label: "站内", value: "site" }, { label: "作品", value: "work" }, { label: "作者", value: "author" }, { label: "标签", value: "tag" }, { label: "登场人物", value: "character" }];
  const wantedType = query.get("search_type");
  const box = {
    word: (query.get("q") || "").trim(),
    conditions: (query.get("q") || "").split(/\s*\+\s*/).filter(Boolean).map((q) => ({ q, type: query.get("search_type") || "site" })),
    order: ORDERS.some((row) => row.value === wantedOrder) ? wantedOrder : "mr",
    searchType: SEARCH_TYPES.some((row) => row.value === wantedType) ? wantedType : "site",
    page: 0,
    total: 0,
    seen: new Set(),
    gen: 0,
    loading: false,
    ended: false,
    streaming: false,
    timer: 0,
    stream: null,
    scroller: null,
    items: [],
    filters: { include: (query.get("fin") || "").split(",").filter(Boolean), exclude: (query.get("fout") || "").split(",").filter(Boolean) },
    suggestions: [],
    hotTags: [],
    filterOpen: false,
    renderToken: 0,
    renderFrame: 0,
    renderOffset: 0,
    renderItems: [],
    renderedIds: new Set(),
    pageSize: 36,
    maxDomItems: 72,
  };

  const input = el("input", {
    class: "input",
    type: "search",
    placeholder: "输入搜索条件…",
    value: box.word,
    "aria-label": "搜索关键词",
    enterkeyhint: "search",
    autocomplete: "off",
  });
  const suggestionList = el("datalist", { id: "jm-search-suggestions" });
  const conditionHost = el("div", { class: "chips search-conditions" });
  input.setAttribute("list", "jm-search-suggestions");
  const sideBtn = el("button", { class: "btn ghost sm", type: "button" });
  const typeSelect = el("select", { class: "select searchbar-type", "aria-label": "搜索类型" }, SEARCH_TYPES.map((row) => el("option", { value: row.value, text: row.label })));
  typeSelect.value = box.searchType;
  const head = el("div", { class: "search-controls" }, [
    el("div", { class: "search-main" }, [el("div", { class: "searchbar searchbar-enhanced" }, [icon("search"), input, typeSelect, sideBtn]), suggestionList, conditionHost]),
  ]);

  const seg = segControl({
    options: ORDERS,
    value: box.order,
    onChange: (value) => {
      box.order = value;
      syncUrl(box.word, value);
      if (box.word) runSearch(box.word);
    },
  });
  const countNode = el("div", { class: "search-count" }, [
    el("div", { class: "search-count-label muted tiny" }),
    el("div", { class: "search-progress", role: "progressbar", "aria-label": "搜索结果加载进度", "aria-valuemin": "0", "aria-valuemax": "100" }, [el("i")]),
  ]);
  const advancedBtn = el("button", { class: "btn ghost sm", type: "button", text: "高级筛选" });
  typeSelect.addEventListener("change", () => { box.searchType = typeSelect.value; syncUrl(box.word, box.order); if (box.word) runSearch(box.word); });
  const filterHost = el("div", { class: "advanced-search hidden" });
  const toolbar = el("div", { class: "row wrap", style: "gap:10px;margin-bottom:10px" }, [
    seg,
    countNode,
    advancedBtn,
  ]);

  const stateHost = el("div");
  // One grid node for the whole session: re-creating it per page would reload every cover.
  const grid = tileGrid([], {});
  const sentinel = el("div", { style: "height:1px" });
  const foot = el("div", { class: "row", style: "justify-content:center;padding:12px 0" });
  const results = el("div", { class: "hidden" }, [toolbar, filterHost, stateHost, grid, sentinel, foot]);

  const hero = el("div");
  view.appendChild(head);
  view.appendChild(hero);
  view.appendChild(results);

  function closeStream() {
    if (box.stream) {
      box.stream.close();
      box.stream = null;
    }
    box.streaming = false;
    advancedBtn.disabled = false;
  }

  function syncUrl(word, order) {
    const params = new URLSearchParams();
    if (word) params.set("q", word);
    params.set("o", order);
    params.set("search_type", box.searchType);
    if (box.filters.include.length) params.set("fin", box.filters.include.join(","));
    if (box.filters.exclude.length) params.set("fout", box.filters.exclude.join(","));
    const hash = "#/search?" + params.toString();
    if (location.hash !== hash) history.replaceState(null, "", hash);
  }

  function syncSide() {
    sideBtn.textContent = input.value.trim() ? "添加" : (box.conditions.length ? "搜索" : "取消");
  }

  function renderConditions() {
    conditionHost.replaceChildren(...box.conditions.map((condition, index) => {
      const mode = SEARCH_TYPES.find((row) => row.value === condition.type);
      return el("button", { class: "chip on", type: "button", text: (mode ? mode.label : "站内") + " · " + condition.q + " ×", title: "移除此搜索条件", onClick: () => {
        box.conditions.splice(index, 1);
        box.word = box.conditions.map((item) => item.q).join(" +");
        input.value = "";
        renderConditions();
        syncSide();
        runSearch(box.word);
      } });
    }));
  }

  function addCondition() {
    const q = input.value.trim();
    if (!q) { if (box.conditions.length) runSearch(box.word); return; }
    if (box.conditions.length >= 8) { toast("最多添加 8 个搜索条件"); return; }
    box.conditions.push({ q, type: box.searchType });
    box.word = box.conditions.map((item) => item.q).join(" +");
    input.value = "";
    renderConditions();
    syncSide();
    runSearch(box.word);
  }

  function updateCount() {
    const parts = [];
    if (box.total > 0) parts.push("约 " + box.total + " 条");
    parts.push("已加载 " + box.seen.size + " 条");
    if (box.filters.include.length || box.filters.exclude.length) parts.push("二次筛选后 " + filteredItems().length + " 条");
    countNode.querySelector(".search-count-label").textContent = parts.join(" · ");
    const progress = box.total > 0 ? Math.min(100, box.seen.size / box.total * 100) : 0;
    const bar = countNode.querySelector(".search-progress");
    bar.setAttribute("aria-valuenow", String(Math.round(progress)));
    bar.classList.toggle("indeterminate", !box.total && box.loading);
    bar.firstElementChild.style.width = progress + "%";
  }

  function itemTags(item) {
    const raw = item && (item.tags || item.tag || []);
    const list = Array.isArray(raw) ? raw : String(raw || "").split(/[,，\s]+/);
    return Array.from(new Set(list.map((tag) => typeof tag === "object" ? (tag.title || tag.name || tag.text || "") : String(tag)).map((tag) => tag.trim()).filter(Boolean)));
  }

  function itemText(item) {
    return String(item && (item.name || item.title) || "").toLowerCase();
  }

  function conditionMatches(item, condition) {
    const needle = String(condition.value || "").trim().toLowerCase();
    if (!needle) return true;
    if (condition.type === "tag") return itemTags(item).some((tag) => tag.toLowerCase().includes(needle));
    if (condition.type === "author") return [item.author, item.authors, item.artist].flatMap((value) => Array.isArray(value) ? value : [value]).map((value) => String(value && typeof value === "object" ? (value.name || value.title || "") : value || "").toLowerCase()).some((value) => value.includes(needle));
    if (condition.type === "character") return [item.character, item.characters, item.actor, item.actors, item.cast].flatMap((value) => Array.isArray(value) ? value : [value]).map((value) => String(value && typeof value === "object" ? (value.name || value.title || "") : value || "").toLowerCase()).some((value) => value.includes(needle));
    if (condition.type === "work") return itemText(item).includes(needle);
    if (condition.type === "category") return String(item.category && (item.category.title || item.category.name) || "").toLowerCase().includes(needle);
    return false;
  }

  function matches(item) {
    return box.filters.include.every((condition) => conditionMatches(item, condition)) && !box.filters.exclude.some((condition) => conditionMatches(item, condition));
  }

  function syncFilters() {
    syncUrl(box.word, box.order);
    renderFiltered();
  }

  function renderFilterPanel() {
    const tags = Array.from(new Set(box.items.flatMap(itemTags))).sort((a, b) => a.localeCompare(b, "zh"));
    const categories = Array.from(new Set(box.items.map((item) => String(item && item.category && (item.category.title || item.category.name) || "")).filter(Boolean))).sort();
    const filterTypes = [{ label: "标题", value: "work" }, { label: "作者", value: "author" }, { label: "标签", value: "tag" }, { label: "人物", value: "character" }, { label: "分类", value: "category" }];
    const makeConditionGroup = (key, label) => {
      const type = el("select", { class: "select" }, filterTypes.map((row) => el("option", { value: row.value, text: row.label })));
      const value = el("input", { class: "input", placeholder: label + "值…" });
      const add = el("button", { class: "btn ghost sm", type: "button", text: "添加" });
      const list = el("div", { class: "chips" });
      const redraw = () => list.replaceChildren.apply(list, box.filters[key].map((condition, index) => el("button", { class: "chip on", type: "button", text: (filterTypes.find((row) => row.value === condition.type) || filterTypes[0]).label + " · " + condition.value + " ×", onClick: () => { box.filters[key].splice(index, 1); redraw(); syncFilters(); } })));
      add.addEventListener("click", () => { const text = value.value.trim(); if (!text) return; box.filters[key].push({ type: type.value, value: text }); value.value = ""; redraw(); syncFilters(); });
      redraw();
      return el("div", { class: "section" }, [el("div", { class: "muted tiny", text: label }), el("div", { class: "row wrap", style: "gap:8px" }, [type, value, add]), list]);
    };
    const clear = el("button", { class: "btn ghost sm", type: "button", text: "清除条件", onClick: () => { box.filters = { include: [], exclude: [] }; renderFilterPanel(); syncFilters(); } });
    filterHost.replaceChildren(el("div", { class: "advanced-panel" }, [makeConditionGroup("include", "包含"), makeConditionGroup("exclude", "排除"), clear, el("div", { class: "muted tiny", text: "二次筛选范围：当前已加载的结果" })]));
  }

  function filteredItems() { return box.items.filter(matches); }

  function renderFiltered() {
    box.renderToken += 1;
    if (box.renderFrame) cancelAnimationFrame(box.renderFrame);
    box.renderItems = filteredItems();
    box.renderOffset = 0;
    box.renderedIds.clear();
    grid.replaceChildren();
    updateCount();
    if (box.items.length && !box.renderItems.length) {
      stateHost.replaceChildren(emptyState({ icon: "search", title: "没有符合条件的结果", text: "调整高级搜索条件后重试" }));
      return;
    }
    if (stateHost.querySelector(".empty")) stateHost.replaceChildren();
    renderNextBatch();
  }

  function renderNextBatch() {
    if (box.renderFrame || box.renderOffset >= box.renderItems.length) return;
    const token = box.renderToken;
    box.renderFrame = requestAnimationFrame(() => {
      box.renderFrame = 0;
      if (token !== box.renderToken) return;
      const end = Math.min(box.renderOffset + box.pageSize, box.renderItems.length);
      const fragment = document.createDocumentFragment();
      for (; box.renderOffset < end; box.renderOffset += 1) {
        const item = box.renderItems[box.renderOffset];
        fragment.appendChild(tile(item));
      }
      grid.appendChild(fragment);
      while (grid.children.length > box.maxDomItems) {
        const old = grid.firstElementChild;
        if (!old) break;
        old.querySelectorAll(".cover-canvas-wrap").forEach((node) => { if (typeof node.__cancel === "function") node.__cancel(); });
        old.remove();
      }
      box.renderFrame = 0;
    });
  }

  function appendItems(items) {
    const preserveY = window.scrollY;
    let added = 0;
    (items || []).forEach((item) => {
      const id = String(item && item.id !== undefined && item.id !== null ? item.id : "");
      if (!id || box.seen.has(id)) return;
      box.seen.add(id);
      box.items.push(item);
      added += 1;
    });
    renderFiltered();
    refreshSuggestions();
    if (preserveY > 0) {
      requestAnimationFrame(() => {
        window.scrollTo(0, preserveY);
        requestAnimationFrame(() => window.scrollTo(0, preserveY));
      });
    }
    return added;
  }

  function finishList() {
    box.ended = true;
    if (box.scroller) box.scroller.disconnect();
    foot.replaceChildren(el("span", { class: "muted tiny", text: "已经到底了" }));
  }

  function attachScroll() {
    if (box.scroller) box.scroller.disconnect();
    box.scroller = infiniteScroll(sentinel, loadMore);
  }

  // A short page keeps the sentinel on screen without changing its intersection
  // state, so the observer alone would stall; ask once more by hand.
  function pump() {
    requestAnimationFrame(() => {
      if (box.ended || box.loading || box.streaming) return;
      if (sentinel.getBoundingClientRect().top < window.innerHeight + 200) loadMore();
    });
  }

  function showNoResult(word) {
    stateHost.replaceChildren(emptyState({
      icon: "search",
      title: "没有找到「" + word + "」",
      text: "换个关键词试试，也可以看看下面的热门标签",
      actionLabel: "看看热门标签",
      onAction: () => {
        input.value = "";
        syncSide();
        runSearch("");
        input.focus();
      },
    }));
    countNode.querySelector(".search-count-label").textContent = "";
    updateCount();
  }

  async function runSearch(text) {
    const word = String(text || "").trim();
    if (box.conditions.length && word !== box.conditions.map((condition) => condition.q).join(" +")) { box.conditions = []; renderConditions(); }
    closeStream();
    if (box.scroller) {
      box.scroller.disconnect();
      box.scroller = null;
    }
    box.gen += 1;
    const gen = box.gen;
    box.word = word;
    box.page = 0;
    box.total = 0;
    box.seen = new Set();
    box.items = [];
    box.loading = false;
    box.ended = false;
    grid.replaceChildren();
    foot.replaceChildren();
    syncUrl(word, box.order);

    if (!word) {
      results.classList.add("hidden");
      hero.classList.remove("hidden");
      renderHero();
      return;
    }

    hero.classList.add("hidden");
    results.classList.remove("hidden");
    stateHost.replaceChildren(skeletonGrid(12));
    countNode.querySelector(".search-count-label").textContent = "搜索中…";
    updateCount();

    try {
      const payload = await api.search(word, 1, box.order, box.searchType);
      if (gen !== box.gen) return;
      stateHost.replaceChildren();
      box.page = Number(payload.page) || 1;
      box.total = Number(payload.total) || 0;
      const added = appendItems(payload.items);
      updateCount();
      rememberQuery(word);
      if (!added && !box.total) {
        showNoResult(word);
        return;
      }
      if (box.total > 0 && box.seen.size >= box.total) {
        finishList();
        return;
      }
      attachScroll();
      pump();
    } catch (err) {
      if (gen !== box.gen) return;
      countNode.querySelector(".search-count-label").textContent = "";
    updateCount();
      stateHost.replaceChildren(errorState(
        String((err && err.message) || err),
        () => runSearch(box.word)
      ));
    }
  }

  async function loadMore() {
    if (!box.word || box.ended || box.streaming) return false;
    // Staying "busy" must not report the list as finished, or the observer retires for good.
    if (box.loading) return true;
    if (box.renderOffset < box.renderItems.length) { renderNextBatch(); pump(); return true; }
    const gen = box.gen;
    box.loading = true;
    foot.replaceChildren(loadingRow("加载更多…"));
    try {
      const payload = await api.search(box.word, box.page + 1, box.order, box.searchType);
      if (gen !== box.gen) return false;
      box.page = Number(payload.page) || box.page + 1;
      if (Number(payload.total)) box.total = Number(payload.total);
      const added = appendItems(payload.items);
      updateCount();
      foot.replaceChildren();
      if (!added) {
        finishList();
        return false;
      }
      if (box.total > 0 && box.seen.size >= box.total) {
        finishList();
        return false;
      }
      pump();
      return true;
    } catch (err) {
      if (gen !== box.gen) return false;
      foot.replaceChildren(el("button", {
        class: "btn ghost sm",
        type: "button",
        text: "加载失败，点此重试",
        onClick: () => {
          foot.replaceChildren();
          attachScroll();
        },
      }));
      return false;
    } finally {
      if (gen === box.gen) box.loading = false;
    }
  }

  function startDeep() {
    if (!box.word || box.streaming) return;
    closeStream();
    const gen = box.gen;
    const word = box.word;
    const order = box.order;
    let source;
    try {
      source = new EventSource(api.searchStreamUrl(word, order, box.searchType));
    } catch (err) {
      toast("当前环境不支持流式搜索");
      return;
    }
    box.stream = source;
    box.streaming = true;
    advancedBtn.disabled = true;
    stateHost.replaceChildren();
    toast("深度搜索开始，逐页抓取中", 1600);

    source.addEventListener("page", (evt) => {
      if (gen !== box.gen) {
        closeStream();
        return;
      }
      let data;
      try {
        data = JSON.parse(evt.data || "{}");
      } catch (err) {
        return;
      }
      if (Number(data.total)) box.total = Number(data.total);
      if (Number(data.page)) box.page = Math.max(box.page, Number(data.page));
      appendItems(data.items);
      updateCount();
      toast("第 " + (data.page || "-") + " 页 · 累计 " + (Number(data.unique) || box.seen.size) + " 条", 1300);
    });

    source.addEventListener("done", (evt) => {
      const finishedGen = gen === box.gen;
      let data = {};
      try {
        data = JSON.parse(evt.data || "{}");
      } catch (err) {
        data = {};
      }
      closeStream();
      if (!finishedGen) return;
      if (!box.seen.size) {
        showNoResult(word);
        return;
      }
      if (box.total > 0 && box.seen.size >= box.total) {
        finishList();
      } else {
        attachScroll();
      }
      toast("深度搜索完成 · " + (Number(data.unique) || box.seen.size) + " 条", 2000);
    });

    source.addEventListener("error", () => {
      if (!box.stream) return;
      // Without this the browser retries forever and the button stays dead.
      closeStream();
      if (gen !== box.gen) return;
      toast("深度搜索中断");
      if (!box.seen.size) {
        stateHost.replaceChildren(errorState("流式搜索中断", () => runSearch(word)));
      }
    });
  }

  function renderHero() {
    hero.replaceChildren();
    const hotBody = el("div", { class: "chips" }, [el("span", { class: "muted tiny", text: "读取中…" })]);
    hero.appendChild(section("热门标签", { body: hotBody }));
    api.hotTags().then((tags) => {
      if (!hero.isConnected) return;
      const list = (tags || []).filter(Boolean).slice(0, 100);
      box.hotTags = list;
      suggestionList.replaceChildren.apply(suggestionList, list.map((tag) => el("option", { value: tag })));
      if (!list.length) {
        hotBody.replaceChildren(el("span", { class: "muted tiny", text: "暂时没有热门标签" }));
        return;
      }
      hotBody.replaceChildren.apply(hotBody, list.map((tag) => el("button", {
        class: "chip",
        type: "button",
        text: tag,
        onClick: () => {
          input.value = tag;
          typeSelect.value = "tag";
          box.searchType = "tag";
          syncSide();
          addCondition();
        },
      })));
    }).catch(() => {
      if (!hero.isConnected) return;
      hotBody.replaceChildren(el("span", { class: "muted tiny", text: "热门标签读取失败" }));
    });

    const saved = readHistory();
    const histHead = el("div", { class: "section-head" }, [
      el("h2", { text: "搜索历史" }),
      el("span", { class: "grow" }),
      saved.length
        ? el("button", {
            class: "btn ghost sm",
            type: "button",
            text: "清空",
            onClick: () => {
              writeHistory([]);
              renderHero();
              toast("已清空搜索历史");
            },
          })
        : null,
    ]);
    const histBody = el("div", { class: "list" });
    if (!saved.length) {
      histBody.appendChild(el("div", { class: "muted tiny", text: "还没有搜索记录" }));
    }
    saved.forEach((word) => {
      histBody.appendChild(listRow({
        icon: "clock",
        title: word,
        chevron: false,
        trailing: iconButton("close", (evt) => {
          evt.stopPropagation();
          writeHistory(readHistory().filter((savedWord) => savedWord !== word));
          renderHero();
        }, { title: "删除这条记录" }),
        onClick: () => {
          box.conditions = word.split(/\s*\+\s*/).filter(Boolean).map((q) => ({ q, type: box.searchType }));
          input.value = "";
          renderConditions();
          syncSide();
          runSearch(word);
        },
      }));
    });
    hero.appendChild(el("div", { class: "section" }, [histHead, histBody]));
  }

  function refreshSuggestions() {
    const values = box.searchType === "tag" ? box.hotTags : box.items.flatMap((item) => {
      const value = box.searchType === "author" ? item.author : (item.character || item.characters || item.actor);
      return Array.isArray(value) ? value : [value];
    });
    const unique = Array.from(new Set(values.map((value) => typeof value === "object" ? (value.name || value.title || "") : String(value || "")).map((value) => value.trim()).filter(Boolean))).slice(0, 100);
    suggestionList.replaceChildren.apply(suggestionList, unique.map((value) => el("option", { value })));
  }

  input.addEventListener("focus", () => refreshSuggestions());
  input.addEventListener("input", () => {
    syncSide();
    refreshSuggestions();
    clearTimeout(box.timer);
    box.timer = 0;
  });
  input.addEventListener("keydown", (evt) => {
    if (evt.key === "Enter") {
      evt.preventDefault();
      clearTimeout(box.timer);
      syncSide();
      addCondition();
    } else if (evt.key === "Escape") {
      evt.preventDefault();
      input.value = "";
      syncSide();
      clearTimeout(box.timer);
      runSearch("");
    }
  });
  sideBtn.addEventListener("click", () => {
    if (input.value.trim()) {
      addCondition();
      input.focus();
      return;
    }
    if (box.conditions.length) {
      runSearch(box.word);
      return;
    }
    if (window.history.length > 1) window.history.back();
    else location.hash = "#/home";
  });

  advancedBtn.addEventListener("click", () => {
    box.filterOpen = !box.filterOpen;
    advancedBtn.textContent = box.filterOpen ? "收起二次搜索" : "二次搜索";
    filterHost.classList.toggle("hidden", !box.filterOpen);
    if (box.filterOpen) renderFilterPanel();
  });

  renderConditions();
  syncSide();
  if (box.word) runSearch(box.word);
  else {
    hero.classList.remove("hidden");
    renderHero();
  }

  return function cleanup() {
    clearTimeout(box.timer);
    if (box.renderFrame) { cancelAnimationFrame(box.renderFrame); box.renderFrame = 0; }
    box.renderToken += 1;
    box.gen += 1;
    closeStream();
    if (box.scroller) {
      box.scroller.disconnect();
      box.scroller = null;
    }
  };
}
