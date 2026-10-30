// Home puts the three data blocks in one pass: a single skeleton phase and a
// single retryable failure beat three sections that each fail on their own.
import { api, qs } from "../api.js";
import { state, isFavorite, toggleFavorite } from "../state.js";
import { canvasGrid } from "../canvas-grid.js";
import {
  el, icon, toast, tile, sectionHead, skeletonGrid, skeletonRail,
  errorState, infiniteScroll, loadingRow, warmCovers,
} from "../ui.js";

const RECENT = 10;

function errText(err) {
  return err && err.message ? err.message : String(err || "未知错误");
}

// opts.onFavorite reports the item, never the heart button, so the only way to
// flip the icon is to rebuild the tile in place and swap it into the DOM.
function favTile(item, extra) {
  const holder = { node: null };
  const build = () => {
    const node = tile(item, Object.assign({}, extra, {
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
    }));
    holder.node = node;
    return node;
  };
  return build();
}

async function goRandom() {
  try {
    const list = await api.random();
    const item = Array.isArray(list) ? list[0] : list;
    if (!item || !item.id) {
      toast("没抽到作品，再试一次");
      return;
    }
    if (window.parent && window.parent !== window) window.parent.postMessage({ type: "detail", aid: String(item.id) }, location.origin);
    else location.hash = "#/album/" + encodeURIComponent(item.id);
  } catch (err) {
    toast("随便看看失败了：" + errText(err));
  }
}

function randomButton() {
  return el("button", {
    class: "btn ghost sm", type: "button", title: "随便看看", onClick: goRandom,
  }, [icon("shuffle"), el("span", { text: "随便看看" })]);
}

function progressTile(row) {
  const aid = String(row.aid || "");
  const cid = String(row.cid || "");
  const total = Number(row.total) || 0;
  const page = Number(row.page) || 0;
  const percent = row.percent != null ? Number(row.percent) : (total ? page / total : 0);
  return tile({ id: aid, name: row.album || row.title || "未命名" }, {
    cover: api.progCoverUrl(aid, 300),
    sub: "第 " + page + " / " + total + " 页",
    progress: percent,
    action: { label: "继续阅读", onClick: () => { location.hash = "#/read/" + encodeURIComponent(cid) + "?aid=" + encodeURIComponent(aid); } },
  });
}

function recentProgress(rows) {
  const seen = new Set();
  const out = [];
  (rows || [])
    .slice()
    .sort((a, b) => (Number(b.updated) || 0) - (Number(a.updated) || 0))
    .forEach((row) => {
      const key = String(row.aid || row.cid || "");
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push(row);
    });
  return out.slice(0, RECENT);
}

function promoteHref(section) {
  return "#/listing" + qs({
    kind: "promote",
    id: section.id,
    title: section.title || "",
    slug: section.slug || "",
  });
}

export async function renderHome(view, ctx) {
  let disposed = false;
  let scroll = null;
  let latestCanvas = null;

  const head = el("div", { class: "page-head" }, [
    el("div", { class: "grow" }, [el("h1", { text: "JMBridge" })]),
    randomButton(),
  ]);
  const body = el("div");
  const fab = el("button", {
    class: "fab", type: "button", title: "随便看看", "aria-label": "随便看看", onClick: goRandom,
  }, [icon("shuffle")]);
  view.append(head, body, fab);

  async function mount() {
    if (scroll) {
      scroll.disconnect();
      scroll = null;
    }
    if (latestCanvas) {
      latestCanvas.destroy();
      latestCanvas = null;
    }
    body.innerHTML = "";
    body.append(skeletonRail(6), skeletonGrid(12));

    const [homeRes, latestRes, libRes] = await Promise.allSettled([
      api.home(), api.latest(1), api.library(),
    ]);
    if (disposed) return;
    if (homeRes.status === "rejected" && latestRes.status === "rejected") {
      body.innerHTML = "";
      body.appendChild(errorState(errText(homeRes.reason), mount));
      return;
    }
    body.innerHTML = "";

    const progressRows = libRes.status === "fulfilled"
      ? (libRes.value.progress || [])
      : (state.progress || []);
    const recent = recentProgress(progressRows);
    warmCovers(recent.map((row) => row.aid), 300);
    if (recent.length) {
      body.appendChild(el("div", { class: "section" }, [
        sectionHead("继续阅读", { sub: recent.length + " 部" }),
        el("div", { class: "rail" }, recent.map(progressTile)),
      ]));
    }

    if (homeRes.status === "fulfilled") {
      (homeRes.value.promote || []).forEach((section) => {
        const title = String(section.title || "").trim();
        if (["禁漫小說", "禁漫小说", "禁漫書庫", "禁漫书库"].includes(title)) return;
        const content = section.content || [];
        warmCovers(content.map((item) => item.id || item.aid), 360);
        // Short shelves (one to three covers) are still real shelves.
        if (!content.length) return;
        body.appendChild(el("div", { class: "section" }, [
          sectionHead(section.title || "推荐", {
            more: {
              label: "更多",
              onClick: () => { location.hash = promoteHref(section); },
            },
          }),
          el("div", { class: "rail" }, content.map((item) => favTile(item))),
        ]));
      });
    }

    body.appendChild(sectionHead("最新上架", {}));
    latestCanvas = canvasGrid({ label: "最新上架", onOpen: (item) => {
      const aid = String(item.id || item.aid || "");
      if (window.parent !== window) window.parent.postMessage({ type: "detail", aid }, location.origin);
      else location.hash = "#/album/" + encodeURIComponent(aid);
    } });
    const grid = latestCanvas;
    const sentinel = loadingRow("加载中…");
    body.append(grid.node, sentinel);

    if (latestRes.status === "rejected") {
      sentinel.remove();
      latestCanvas.destroy();
      latestCanvas = null;
      grid.node.remove();
      body.appendChild(errorState(errText(latestRes.reason), mount));
      return;
    }

    const seen = new Set();
    let page = 1;
    let loaded = 0;
    let total = Number(latestRes.value.total) || 0;

    function absorb(items) {
      let added = 0;
      (items || []).forEach((item) => {
        const id = String(item.id || "");
        if (!id || seen.has(id)) return;
        seen.add(id);
        grid.append([item]);
        added += 1;
      });
      loaded += added;
      return added;
    }

    absorb(latestRes.value.items);
    warmCovers((latestRes.value.items || []).map((item) => item.id || item.aid), 360);

    scroll = infiniteScroll(sentinel, async () => {
      try {
        page += 1;
        const data = await api.latest(page);
        if (disposed) return false;
        const items = data.items || [];
        total = Number(data.total) || total;
        const added = absorb(items);
        warmCovers(items.map((item) => item.id || item.aid), 360);
        // Upstream total echoes one page length, so a page that adds nothing new
        // is the honest end signal; total only counts when it exceeds a page.
        if (!items.length || added === 0 || (total > items.length && loaded >= total)) {
          sentinel.remove();
          if (scroll) scroll.finish();
          return false;
        }
        return true;
      } catch (err) {
        sentinel.remove();
        toast("加载更多失败：" + errText(err));
        return false;
      }
    });
  }

  await mount();
  return () => {
    disposed = true;
    if (scroll) scroll.disconnect();
    if (latestCanvas) latestCanvas.destroy();
  };
}
