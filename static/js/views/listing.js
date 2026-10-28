// The generic grid behind every "更多" link. The kind only picks a loader and a
// fallback title; dedupe, stop rules and retry stay in one place.
import { api, fmtNum } from "../api.js";
import { isFavorite, toggleFavorite } from "../state.js";
import {
  el, toast, tile, pageHead, loadingRow, errorState, emptyState, infiniteScroll, warmCovers,
} from "../ui.js";

const TITLES = {
  latest: "最新上架",
  browse: "分类浏览",
  promote: "推荐",
  search: "搜索结果",
  serialization: "连载更新",
};

function errText(err) {
  return err && err.message ? err.message : String(err || "未知错误");
}

// Same rebuild trick as the home rails: the heart is inside the tile the factory
// returns, so replacing that tile is the only way to repaint its state.
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

export async function renderListing(view, ctx) {
  const params = ctx.query;
  const kind = params.get("kind") || "latest";
  const title = params.get("title") || TITLES[kind] || "列表";
  const args = {
    c: params.get("c") || "",
    o: params.get("o") || "",
    q: params.get("q") || "",
    id: params.get("id") || "",
    slug: params.get("slug") || "",
    type: params.get("type") || "",
    date: params.get("date") || "0",
  };

  const head = pageHead(title, { back: () => history.back(), sub: "加载中…" });
  const subEl = head.querySelector(".sub");
  const body = el("div");
  view.append(head, body);

  let disposed = false;
  let scroll = null;
  let viaBrowse = false;
  let page = 0;
  let loaded = 0;
  let total = 0;
  let seen = new Set();
  const grid = el("div", { class: "grid" });
  let sentinel = null;

  async function fetchPage(pageNo) {
    if (kind === "promote") {
      if (!viaBrowse) {
        const data = await api.promoteList(args.id, pageNo);
        const items = data.list || [];
        // Curated ids without promote content still deserve a page: their home
        // section carries a category slug, so browse that instead of dead-ending.
        if (pageNo === 1 && !items.length && args.slug) viaBrowse = true;
        else return { items: items, total: Number(data.total) || 0 };
      }
      return api.browse(args.slug, "", pageNo);
    }
    if (kind === "browse") return api.browse(args.c, args.o, pageNo);
    if (kind === "search") return api.search(args.q, pageNo, args.o || "mr");
    if (kind === "serialization") return api.serialization(pageNo, args.type, args.date);
    return api.latest(pageNo);
  }

  // A finished list must not keep advertising an upstream total it never reached.
  function setSub(done) {
    if (!subEl) return;
    subEl.textContent = (!done && total > loaded)
      ? "已加载 " + fmtNum(loaded) + " / " + fmtNum(total) + " 部"
      : "共 " + fmtNum(loaded) + " 部";
  }

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
    return added;
  }

  async function step() {
    const data = await fetchPage(page + 1);
    page += 1;
    const items = data.items || [];
    total = Number(data.total) || 0;
    const added = absorb(items);
    warmCovers(items.map((item) => item.id || item.aid), 360);
    setSub();
    if (!items.length || added === 0) return false;
    // Upstream total can equal a single page length, so trust it only when bigger.
    if (total && total > items.length && loaded >= total) return false;
    return true;
  }

  function stopScroll(replacement) {
    if (scroll) {
      scroll.disconnect();
      scroll = null;
    }
    if (!sentinel) return;
    if (replacement) sentinel.replaceWith(replacement);
    else sentinel.remove();
  }

  function retryRow(err) {
    const row = el("div", { class: "loading-row" }, [
      el("span", { class: "tiny muted", text: "加载失败：" + errText(err) }),
      el("button", {
        class: "btn sm", type: "button", text: "重试",
        onClick: () => {
          row.replaceWith(sentinel);
          scroll = infiniteScroll(sentinel, onScroll);
        },
      }),
    ]);
    return row;
  }

  async function onScroll() {
    try {
      const more = await step();
      if (!more) {
        setSub(true);
        stopScroll(el("div", { class: "loading-row muted tiny", text: "已经到底了" }));
        return false;
      }
      return true;
    } catch (err) {
      stopScroll(retryRow(err));
      return false;
    }
  }

  async function mount() {
    if (scroll) {
      scroll.disconnect();
      scroll = null;
    }
    body.innerHTML = "";
    grid.innerHTML = "";
    seen = new Set();
    page = 0;
    loaded = 0;
    total = 0;
    viaBrowse = false;
    sentinel = loadingRow("加载中…");
    body.append(grid, sentinel);

    try {
      const more = await step();
      if (disposed) return;
      if (!more) {
        if (!loaded) {
          body.innerHTML = "";
          body.appendChild(emptyState({
            icon: "image",
            title: "没有内容",
            text: "换个条件再看看",
          }));
        } else {
          setSub(true);
          sentinel.replaceWith(el("div", { class: "loading-row muted tiny", text: "已经到底了" }));
        }
        return;
      }
    } catch (err) {
      if (disposed) return;
      body.innerHTML = "";
      body.appendChild(errorState(errText(err), mount));
      return;
    }
    scroll = infiniteScroll(sentinel, onScroll);
  }

  await mount();
  return () => {
    disposed = true;
    if (scroll) scroll.disconnect();
  };
}
