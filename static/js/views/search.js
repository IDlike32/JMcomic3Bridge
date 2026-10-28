// Search: debounced query, paged infinite scroll, plus an SSE deep pass.
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
  const box = {
    word: (query.get("q") || "").trim(),
    order: ORDERS.some((row) => row.value === wantedOrder) ? wantedOrder : "mr",
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
  };

  const input = el("input", {
    class: "input",
    type: "search",
    placeholder: "搜索标题、作者或标签",
    value: box.word,
    "aria-label": "搜索关键词",
    enterkeyhint: "search",
    autocomplete: "off",
  });
  const sideBtn = el("button", { class: "btn ghost sm", type: "button" });
  const head = el("div", { class: "row", style: "gap:8px;margin-bottom:16px" }, [
    el("div", { class: "grow" }, [el("div", { class: "searchbar" }, [icon("search"), input])]),
    sideBtn,
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
  const countNode = el("span", { class: "muted tiny" });
  const deepBtn = el("button", { class: "btn ghost sm", type: "button", text: "深度搜索" });
  const toolbar = el("div", { class: "row wrap", style: "gap:10px;margin-bottom:10px" }, [
    seg,
    countNode,
    el("span", { class: "grow" }),
    deepBtn,
  ]);

  const stateHost = el("div");
  // One grid node for the whole session: re-creating it per page would reload every cover.
  const grid = tileGrid([], {});
  const sentinel = el("div", { style: "height:1px" });
  const foot = el("div", { class: "row", style: "justify-content:center;padding:12px 0" });
  const results = el("div", { class: "hidden" }, [toolbar, stateHost, grid, sentinel, foot]);

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
    deepBtn.disabled = false;
  }

  function syncUrl(word, order) {
    const params = new URLSearchParams();
    if (word) params.set("q", word);
    params.set("o", order);
    const hash = "#/search?" + params.toString();
    if (location.hash !== hash) history.replaceState(null, "", hash);
  }

  function syncSide() {
    sideBtn.textContent = input.value.trim() ? "清空" : "取消";
  }

  function updateCount() {
    const parts = [];
    if (box.total > 0) parts.push("约 " + box.total + " 条");
    parts.push("已显示 " + box.seen.size + " 条");
    countNode.textContent = parts.join(" · ");
  }

  function appendItems(items) {
    let added = 0;
    (items || []).forEach((item) => {
      const id = String(item && item.id !== undefined && item.id !== null ? item.id : "");
      if (!id || box.seen.has(id)) return;
      box.seen.add(id);
      grid.appendChild(tile(item));
      added += 1;
    });
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
    countNode.textContent = "";
  }

  async function runSearch(text) {
    const word = String(text || "").trim();
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
    countNode.textContent = "搜索中…";

    try {
      const payload = await api.search(word, 1, box.order);
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
      countNode.textContent = "";
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
    const gen = box.gen;
    box.loading = true;
    foot.replaceChildren(loadingRow("加载更多…"));
    try {
      const payload = await api.search(box.word, box.page + 1, box.order);
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
      source = new EventSource(api.searchStreamUrl(word, order));
    } catch (err) {
      toast("当前环境不支持流式搜索");
      return;
    }
    box.stream = source;
    box.streaming = true;
    deepBtn.disabled = true;
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
      const list = (tags || []).filter(Boolean).slice(0, 24);
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
          syncSide();
          runSearch(tag);
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
          input.value = word;
          syncSide();
          runSearch(word);
        },
      }));
    });
    hero.appendChild(el("div", { class: "section" }, [histHead, histBody]));
  }

  input.addEventListener("input", () => {
    syncSide();
    clearTimeout(box.timer);
    box.timer = setTimeout(() => runSearch(input.value), 400);
  });
  input.addEventListener("keydown", (evt) => {
    if (evt.key === "Enter") {
      evt.preventDefault();
      clearTimeout(box.timer);
      runSearch(input.value);
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
      input.value = "";
      syncSide();
      clearTimeout(box.timer);
      runSearch("");
      input.focus();
      return;
    }
    if (window.history.length > 1) window.history.back();
    else location.hash = "#/home";
  });
  deepBtn.addEventListener("click", startDeep);

  syncSide();
  if (box.word) runSearch(box.word);
  else {
    hero.classList.remove("hidden");
    renderHero();
  }

  return function cleanup() {
    clearTimeout(box.timer);
    box.gen += 1;
    closeStream();
    if (box.scroller) {
      box.scroller.disconnect();
      box.scroller = null;
    }
  };
}
