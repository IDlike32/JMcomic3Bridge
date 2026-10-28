// Browse: category slugs, order tabs and 週刊 all funnel through loadGrid(), so
// there is one pagination path and one URL shape no matter what was clicked.
import { api, qs, fmtNum } from "../api.js";
import { isFavorite, toggleFavorite } from "../state.js";
import {
  el, icon, toast, tile, pageHead, segControl, chipStrip, openSheet,
  loadingRow, errorState, emptyState, skeletonGrid, infiniteScroll, warmCovers,
} from "../ui.js";

const ORDERS = [
  { label: "最新", value: "" },
  { label: "爱心", value: "tf" },
  { label: "日榜", value: "mv_t" },
  { label: "周榜", value: "mv_w" },
  { label: "月榜", value: "mv_m" },
  { label: "总榜", value: "mv" },
];

// 262 issues in one sheet is unusable on a phone; the recent issues are the ones
// people actually open.
const WEEK_ISSUES = 36;

function errText(err) {
  return err && err.message ? err.message : String(err || "未知错误");
}

function favTile(item) {
  const holder = { node: null };
  const build = () => {
    const node = tile(item, {
      favorite: isFavorite(item.id),
      onFavorite: async () => {
        try {
          const now = await toggleFavorite({ aid: item.id, title: item.name, author: item.author });
          toast(now ? "已收藏" : "已取消收藏");
        } catch (err) {
          toast("收藏失败：" + errText(err));
        }
        const prev = holder.node;
        const fresh = build();
        if (prev && typeof prev.replaceWith === "function") prev.replaceWith(fresh);
      },
    });
    holder.node = node;
    return node;
  };
  return build();
}

export async function renderBrowse(view, ctx) {
  const params = ctx.query;
  let cat = params.get("c") || "";
  let order = params.get("o") || "";
  let weekId = params.get("w") || "";
  let weekType = params.get("wt") || "";

  let disposed = false;
  let catalog = null;
  let weekCache = null;
  let weekChip = null;
  let scroll = null;
  let token = 0;

  const head = pageHead("浏览", { sub: "加载中…" });
  const subEl = head.querySelector(".sub");
  const segRow = el("div", { style: "margin-bottom:10px" });
  const catRow = el("div", { style: "margin-bottom:10px" });
  const subRow = el("div", { style: "margin-bottom:10px" });
  const weekRow = el("div", { class: "row wrap hidden", style: "margin-bottom:10px" });
  const tools = el("div", { class: "row wrap", style: "margin-bottom:14px" });
  const body = el("div");
  view.append(head, segRow, catRow, subRow, weekRow, tools, body);

  function setSub(text) {
    if (subEl) subEl.textContent = text;
  }

  function topCategories() {
    return ((catalog && catalog.categories) || []).filter((category) => String(category.id) !== "0");
  }

  // "最新A漫" is the id-0 pseudo category; an empty slug is how the API means it.
  function categoryChips() {
    return [{ label: "最新A漫", value: "" }].concat(
      topCategories().map((c) => ({ label: c.name, value: c.slug }))
    );
  }

  function resolveCat(slug) {
    if (!slug) return { parent: "", sub: "" };
    const list = topCategories();
    if (list.some((c) => c.slug === slug)) return { parent: slug, sub: "" };
    const host = list.find((c) => (c.sub_categories || []).some((s) => s.slug === slug));
    return host ? { parent: host.slug, sub: slug } : { parent: "", sub: "" };
  }

  function parentCategory(slug) {
    return topCategories().find((c) => c.slug === slug) || null;
  }

  function paintCategories() {
    const resolved = resolveCat(cat);
    if (resolved.parent !== cat) {
      cat = resolved.parent || "";
      syncUrl();
    }
    catRow.innerHTML = "";
    catRow.appendChild(chipStrip(categoryChips(), {
      value: resolved.parent,
      allowEmpty: false,
      onChange: (value) => {
        cat = value || "";
        syncUrl();
        paintCategories();
        loadGrid();
      },
    }));

    const host = parentCategory(resolved.parent);
    const subs = (host && host.sub_categories) || [];
    subRow.innerHTML = "";
    subRow.classList.toggle("hidden", !subs.length);
    if (!subs.length) return;
    subRow.appendChild(chipStrip([{ label: "全部", value: "" }].concat(
      subs.map((s) => ({ label: s.name, value: s.slug }))
    ), {
      value: resolved.sub,
      allowEmpty: false,
      onChange: (value) => {
        cat = value || resolved.parent;
        syncUrl();
        paintCategories();
        loadGrid();
      },
    }));
  }

  function syncUrl() {
    history.replaceState(null, "", "#/browse" + qs({ c: cat, o: order, w: weekId, wt: weekType }));
  }

  function weekLabel() {
    const issues = (weekCache && weekCache.categories) || [];
    const issue = issues.find((i) => String(i.id) === String(weekId));
    const types = (weekCache && weekCache.types) || [];
    const type = types.find((t) => String(t.id) === String(weekType));
    const label = issue ? issue.time : "第 " + weekId + " 期";
    return "週刊 · " + label + (type ? " · " + type.title : "");
  }

  function paintModes() {
    const week = !!weekId;
    segRow.classList.toggle("hidden", week);
    catRow.classList.toggle("hidden", week);
    if (week) subRow.classList.add("hidden");
    if (weekChip) weekChip.classList.toggle("on", week);
    weekRow.innerHTML = "";
    weekRow.classList.toggle("hidden", !week);
    if (!week) return;
    weekRow.append(
      el("span", { class: "tiny muted grow ellipsis", text: weekLabel() }),
      el("button", {
        class: "chip", type: "button", text: "退出週刊",
        onClick: () => {
          weekId = "";
          weekType = "";
          syncUrl();
          paintCategories();
          loadGrid();
        },
      })
    );
  }

  async function weekCatalog() {
    if (!weekCache) weekCache = await api.week();
    return weekCache;
  }

  async function runPaged(fetchPage, mine) {
    const grid = el("div", { class: "grid" });
    const sentinel = loadingRow("加载中…");
    body.append(grid, sentinel);
    const seen = new Set();
    let page = 0;
    let loaded = 0;
    let total = 0;

    function absorb(items) {
      let added = 0;
      (items || []).forEach((item) => {
        const id = String(item.id || "");
        if (!id || seen.has(id)) return;
        seen.add(id);
        grid.appendChild(favTile(item));
        added += 1;
      });
      loaded += added;
      setSub(total > loaded
        ? "已加载 " + fmtNum(loaded) + " / " + fmtNum(total) + " 部"
        : "共 " + fmtNum(loaded) + " 部");
      return added;
    }

    async function step() {
      const data = await fetchPage(page + 1);
      page += 1;
      const items = data.items || data.list || [];
      total = Number(data.total) || 0;
      const added = absorb(items);
      warmCovers(items.map((item) => item.id || item.aid), 360);
      if (!items.length || added === 0) return false;
      // Upstream total can equal one page length; only trust it when it is larger.
      if (total && total > items.length && loaded >= total) return false;
      return true;
    }

    async function onScroll() {
      try {
        const more = await step();
        if (!more) {
          if (scroll) {
            scroll.disconnect();
            scroll = null;
          }
          setSub("共 " + fmtNum(loaded) + " 部");
          sentinel.replaceWith(el("div", { class: "loading-row muted tiny", text: "已经到底了" }));
          return false;
        }
        return true;
      } catch (err) {
        toast("加载失败：" + errText(err));
        return false;
      }
    }

    try {
      const more = await step();
      if (mine !== token || disposed) return;
      if (!more) {
        sentinel.remove();
        setSub("共 " + fmtNum(loaded) + " 部");
        if (!loaded) {
          body.innerHTML = "";
          body.appendChild(emptyState({
            icon: "image",
            title: "这里没有内容",
            text: "换个分类或排序再看看",
          }));
        }
        return;
      }
    } catch (err) {
      if (mine !== token || disposed) return;
      body.innerHTML = "";
      body.appendChild(errorState(errText(err), () => loadGrid()));
      return;
    }
    scroll = infiniteScroll(sentinel, onScroll);
  }

  async function loadGrid() {
    const mine = ++token;
    if (scroll) {
      scroll.disconnect();
      scroll = null;
    }
    body.innerHTML = "";
    body.appendChild(skeletonGrid(12));
    setSub("加载中…");
    if (weekId) await weekCatalog().catch(() => null);
    if (mine !== token || disposed) return;
    body.innerHTML = "";
    paintModes();

    if (weekId) {
      await runPaged(
        (p) => (p === 1 ? api.week(weekId, weekType) : Promise.resolve({ items: [] })),
        mine
      );
      return;
    }
    await runPaged((p) => api.browse(cat, order, p), mine);
  }

  function openFilter() {
    const blocks = (catalog && catalog.blocks) || [];
    const wrap = el("div");
    blocks.forEach((block) => {
      wrap.appendChild(el("div", { class: "section-head" }, [
        el("h2", { text: block.title || "" }),
      ]));
      wrap.appendChild(el("div", { class: "chips", style: "margin-bottom:16px" },
        (block.content || []).map((tag) => el("button", {
          class: "chip", type: "button", text: tag,
          onClick: () => {
            sheet.close();
            location.hash = "#/search?q=" + encodeURIComponent(tag);
          },
        }))
      ));
    });
    const sheet = openSheet({ title: "筛选", subtitle: "点标签直接搜索", body: wrap });
  }

  async function openWeek() {
    let data;
    try {
      data = await weekCatalog();
    } catch (err) {
      toast("週刊列表加载失败");
      return;
    }
    if (disposed) return;
    const types = data.types || [];
    const issues = (data.categories || []).slice(0, WEEK_ISSUES);
    let typeId = weekType || (types[0] && types[0].id) || "";
    const wrap = el("div");
    wrap.appendChild(el("div", { style: "margin:6px 0 14px" }, [
      segControl({
        options: types.map((t) => ({ label: t.title || t.id, value: t.id })),
        value: typeId,
        onChange: (value) => { typeId = value; },
      }),
    ]));
    const chipBox = el("div", { class: "chips" });
    issues.forEach((issue) => {
      chipBox.appendChild(el("button", {
        class: "chip" + (String(issue.id) === String(weekId) ? " on" : ""),
        type: "button",
        text: issue.time || "第 " + issue.id + " 期",
        onClick: () => {
          weekId = String(issue.id);
          weekType = typeId;
          sheet.close();
          syncUrl();
          paintCategories();
          loadGrid();
        },
      }));
    });
    wrap.appendChild(chipBox);
    const sheet = openSheet({
      title: "週刊",
      subtitle: "共 " + ((data.categories || []).length) + " 期，这里列最近 " + issues.length + " 期",
      body: wrap,
    });
  }

  function filterButton() {
    return el("button", {
      class: "btn sm", type: "button", onClick: openFilter,
    }, [icon("filter"), el("span", { text: "筛选" })]);
  }

  function weekButton() {
    weekChip = el("button", {
      class: "chip" + (weekId ? " on" : ""), type: "button", onClick: openWeek,
    }, [icon("clock"), el("span", { text: "週刊" })]);
    return weekChip;
  }

  async function mount() {
    body.innerHTML = "";
    body.appendChild(skeletonGrid(12));
    try {
      catalog = await api.categories();
    } catch (err) {
      if (disposed) return;
      body.innerHTML = "";
      body.appendChild(errorState(errText(err), mount));
      return;
    }
    if (disposed) return;

    segRow.innerHTML = "";
    segRow.appendChild(segControl({
      options: ORDERS,
      value: order,
      onChange: (value) => {
        order = value || "";
        syncUrl();
        loadGrid();
      },
    }));
    tools.innerHTML = "";
    tools.append(filterButton(), weekButton());
    paintCategories();
    syncUrl();
    await loadGrid();
  }

  await mount();
  return () => {
    disposed = true;
    if (scroll) scroll.disconnect();
  };
}
