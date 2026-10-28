// Bookshelf: reading history as rows, favorites as a grid.
import { api, fmtAgo } from "../api.js";
import {
  el, icon, iconButton, toast, pageHead, segControl, statCard, tile,
  skeletonGrid, emptyState, errorState, openSheet, coverCanvas,
} from "../ui.js";
import { state } from "../state.js";

const TABS = [
  { label: "历史", value: "hist" },
  { label: "收藏", value: "fav" },
];

const HISTORY_SORTS = [
  { label: "最近阅读", value: "recent" },
  { label: "进度最高", value: "progress" },
  { label: "标题", value: "title" },
];

function readHash(cid, aid) {
  return "#/read/" + encodeURIComponent(cid) + (aid ? "?aid=" + encodeURIComponent(aid) : "");
}

function aggregateHistory(rows) {
  const groups = new Map();
  (rows || []).forEach((row) => {
    const key = String(row.aid || row.cid || "");
    if (!key) return;
    const current = groups.get(key);
    if (!current || Number(row.updated || 0) > Number(current.updated || 0)) {
      groups.set(key, Object.assign({}, row, { work_title: current && current.work_title || row.album || row.title || key }));
    }
  });
  return Array.from(groups.values()).sort((a, b) => Number(b.updated || 0) - Number(a.updated || 0));
}

export async function renderLibrary(view, ctx) {
  const query = (ctx && ctx.query) || new URLSearchParams();
  let tab = query.get("tab") === "fav" ? "fav" : "hist";
  let progress = [];
  let favorites = [];
  let stats = {};
  let pageCacheEntries = [];

  const seg = segControl({
    options: TABS,
    value: tab,
    onChange: (value) => {
      tab = value;
      paint();
    },
  });
  const search = el("div", { class: "searchbar library-search" }, [
    icon("search"),
    el("input", { class: "input", type: "search", placeholder: "搜索书架", "aria-label": "搜索书架" }),
  ]);
  let historySort = "recent";
  let keyword = "";
  const sort = segControl({ options: HISTORY_SORTS, value: historySort, onChange: (value) => { historySort = value; paintHistory(); } });
  const cards = el("div", { class: "stats", style: "margin-bottom:16px" });
  const controls = el("div", { class: "library-controls" }, [search, sort]);
  const body = el("div");

  view.appendChild(pageHead("书架", { sub: "阅读历史与收藏", actions: seg }));
  view.appendChild(cards);
  view.appendChild(controls);
  view.appendChild(body);
  search.querySelector("input").addEventListener("input", (evt) => {
    keyword = String(evt.target.value || "").trim().toLowerCase();
    paintHistory();
    paintFavorites();
  });
  body.appendChild(skeletonGrid(8));

  try {
    const [progressPayload, favoritePayload, cachePayload] = await Promise.all([
      api.progressList(200),
      api.favorites(),
      api.cacheList("pages", 200, 0),
    ]);
    progress = (progressPayload && progressPayload.items) || [];
    favorites = (favoritePayload && favoritePayload.items) || [];
    pageCacheEntries = (cachePayload && cachePayload.entries) || [];
    stats = (progressPayload && progressPayload.stats) || (favoritePayload && favoritePayload.stats) || {};
  } catch (err) {
    body.replaceChildren(errorState(String((err && err.message) || err), () => {
      view.innerHTML = "";
      renderLibrary(view, { rest: [], query });
    }));
    return;
  }

  const histBody = el("div");
  const favBody = el("div", { class: "hidden" });
  body.replaceChildren(histBody, favBody);
  let activeSheet = null;

  function paint() {
    histBody.classList.toggle("hidden", tab !== "hist");
    favBody.classList.toggle("hidden", tab !== "fav");
    const hash = tab === "fav" ? "#/library?tab=fav" : "#/library";
    if (location.hash !== hash) history.replaceState(null, "", hash);
    controls.classList.toggle("hidden", tab === "fav" && !favorites.length);
    sort.classList.toggle("hidden", tab !== "hist");
    search.querySelector("input").placeholder = tab === "hist" ? "搜索历史记录" : "搜索收藏";
    paintHistory();
    paintFavorites();
  }

  function updateCards() {
    const favoriteTotal = Number(stats.favorites);
    cards.replaceChildren(
      statCard(aggregateHistory(progress).length, "阅读中"),
      statCard(Number.isFinite(favoriteTotal) ? Math.max(favoriteTotal, favorites.length) : favorites.length, "收藏"),
      statCard(aggregateHistory(progress).filter((row) => row.finished).length, "已读完")
    );
  }

  const EMPTY = {
    icon: "book",
    actionLabel: "去首页逛逛",
    onAction: () => { location.hash = "#/home"; },
  };

  function cacheSummary(aid, cid) {
    const matching = pageCacheEntries.filter((entry) => {
      const meta = entry.meta || {};
      const entryCid = String(meta.cid || '');
      return cid && entryCid ? entryCid === cid : String(meta.aid || '') === aid;
    });
    const count = matching.length;
    const total = Math.max(0, ...matching.map((entry) => Number((entry.meta || {}).total || 0)));
    if (total > 0 && count >= total) return { label: '已缓存', complete: true };
    if (count > 0) return { label: total ? '缓存 ' + count + '/' + total : '缓存 ' + count + ' 页', complete: false };
    return null;
  }

  function bookTile(item, options) {
    const aid = String(item.aid || item.id || '');
    const row = options && options.progress;
    const cid = String((row && row.cid) || aid);
    const readPercent = row ? Math.max(0, Math.min(1, Number(row.total) ? Number(row.page) / Number(row.total) : Number(row.percent) || 0)) : 0;
    const cached = cacheSummary(aid, cid);
    const title = item.title || item.name || aid;
    const note = row ? ((row.finished ? '已读完' : '第 ' + (Number(row.page) || 0) + ' / ' + (Number(row.total) || 0) + ' 页') + ' · ' + fmtAgo(row.updated)) : (item.author || '');
    return tile({ id: aid, title, author: item.author || '' }, {
      favorite: options && options.favorite,
      action: row ? { label: '继续阅读', onClick: () => { location.hash = readHash(cid, aid); } } : null,
      onFavorite: options && options.onFavorite,
      progress: readPercent,
      badge: cached ? cached.label : '',
      note,
      onOpen: () => {
        if (window.parent && window.parent !== window) window.parent.postMessage({ type: 'detail', aid }, location.origin);
        else location.hash = '#/album/' + encodeURIComponent(aid);
      },
      cover: api.progCoverUrl(aid, 360),
    });
  }

  function openMenu(row) {

    const aid = String(row.aid || "");
    const options = [];
    if (aid) {
      options.push(el("div", {
        class: "opt",
        onClick: () => {
          sheet.close();
          if (window.parent && window.parent !== window) window.parent.postMessage({ type: "detail", aid }, location.origin);
          else location.hash = "#/album/" + encodeURIComponent(aid);
        },
      }, [icon("info"), el("span", { text: "查看详情" })]));
    }
    options.push(el("div", {
      class: "opt",
      onClick: () => {
        sheet.close();
        removeHistory(row);
      },
    }, [icon("trash"), el("span", { text: "从历史移除" })]));

    const sheet = openSheet({
      title: row.album || row.title || String(row.cid || ""),
      subtitle: "第 " + (Number(row.page) || 0) + " / " + (Number(row.total) || 0) + " 页",
      body: el("div", { class: "opt-list" }, options),
      onClose: () => { activeSheet = null; },
    });
    activeSheet = sheet;
  }

  async function removeHistory(row) {
    const cid = String(row.cid || "");
    const aid = String(row.aid || cid);
    try {
      await api.progressDeleteSeries(aid);
    } catch (err) {
      toast("移除失败：" + String((err && err.message) || err));
      return;
    }
    progress = progress.filter((item) => String(item.aid || item.cid) !== aid);
    state.progress = (state.progress || []).filter((item) => String(item.aid || item.cid) !== aid);
    if (state.progressByCid) {
      Array.from(state.progressByCid.keys()).forEach((key) => {
        const item = state.progressByCid.get(key);
        if (String(item && (item.aid || item.cid)) === aid) state.progressByCid.delete(key);
      });
    }
    stats.progress = Math.max(0, (Number(stats.progress) || 1) - 1);
    paintHistory();
    toast("已从历史移除");
  }

  async function unfavorite(item) {
    const aid = String(item.aid || item.id || "");
    if (!aid) return;
    try {
      await api.favoriteRemove(aid);
    } catch (err) {
      toast("取消收藏失败：" + String((err && err.message) || err));
      return;
    }
    favorites = favorites.filter((row) => String(row.aid) !== aid);
    if (state.favoriteIds) state.favoriteIds.delete(aid);
    state.favorites = (state.favorites || []).filter((row) => String(row.aid) !== aid);
    stats.favorites = Math.max(0, (Number(stats.favorites) || favorites.length + 1) - 1);
    paintFavorites();
    toast("已取消收藏");
  }

  function paintHistory() {
    histBody.replaceChildren();
    let rows = aggregateHistory(progress);
    if (keyword) rows = rows.filter((row) => String(row.album || row.work_title || row.title || '').toLowerCase().includes(keyword));
    rows.sort((a, b) => {
      if (historySort === 'title') return String(a.album || a.work_title || a.title || '').localeCompare(String(b.album || b.work_title || b.title || ''), 'zh-CN');
      if (historySort === 'progress') return (Number(b.percent) || 0) - (Number(a.percent) || 0);
      return Number(b.updated || 0) - Number(a.updated || 0);
    });
    if (!rows.length) {
      histBody.appendChild(emptyState({ ...EMPTY, icon: keyword ? 'search' : 'clock', title: keyword ? '没有匹配的记录' : '还没有阅读记录', text: keyword ? '换个关键词试试' : '翻开一本漫画读上几页，就会出现在这里' }));
      updateCards();
      return;
    }
    histBody.appendChild(el('div', { class: 'grid library-grid' }, rows.map((row) => bookTile({ aid: String(row.aid || row.cid), title: row.album || row.work_title || row.title, author: row.author }, { progress: row }))));
    updateCards();
  }

  function paintFavorites() {
    favBody.replaceChildren();
    const rows = keyword ? favorites.filter((row) => String(row.title || row.author || '').toLowerCase().includes(keyword)) : favorites;
    if (!rows.length) {
      favBody.appendChild(emptyState({ ...EMPTY, icon: keyword ? 'search' : 'heart', title: keyword ? '没有匹配的收藏' : '还没有收藏', text: keyword ? '换个关键词试试' : '点封面右上角的心，就能把作品收进书架' }));
      updateCards();
      return;
    }
    favBody.appendChild(el('div', { class: 'grid library-grid' }, rows.map((item) => {
      const read = progress.find((row) => String(row.aid || row.cid) === String(item.aid));
      return bookTile(item, { favorite: true, onFavorite: () => unfavorite(item), progress: read });
    })));
    updateCards();
  }

  paintHistory();
  paintFavorites();
  paint();

  // The sheet lives in #layer, outside the view, so the router cannot clear it.
  return function cleanup() {
    if (activeSheet) activeSheet.close();
    activeSheet = null;
  };
}