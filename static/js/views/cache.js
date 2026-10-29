// Cache manager: per-kind usage, entry list, purge. Every mutation re-reads
// /api/cache so the bars and the list can never disagree with the server.
import { api, fmtBytes, fmtAgo } from "../api.js";
import {
  el, toast, pageHead, statCard, segControl, listRow, emptyState, errorState,
  loadingRow, confirmDialog,
} from "../ui.js";
import { state } from "../state.js";

const KINDS = [
  { value: "search", label: "元数据", hint: "接口返回的 JSON" },
  { value: "thumb", label: "封面", hint: "封面缩略图" },
  { value: "pages", label: "漫画页", hint: "阅读过的页面图片" },
  { value: "zip", label: "压缩包", hint: "打包好的章节" },
  { value: "prog", label: "渐进帧", hint: "阅读器分段绘制的页面帧" },
];

const KIND_LABEL = {};
KINDS.forEach((kind) => { KIND_LABEL[kind.value] = kind.label; });

const PAGE_SIZE = 200;
const BOOK_PAGE_SIZE = 24;

function truncate(text, max) {
  const value = String(text || "");
  return value.length > max ? value.slice(0, max - 1) + "…" : value;
}

// Entries are keyed "kind|rest"; the delete endpoint wants only the rest.
function keyRest(key) {
  const at = key.indexOf("|");
  return at >= 0 ? key.slice(at + 1) : key;
}

function entryLabel(entry) {
  const meta = entry.meta || {};
  if (meta.title) return String(meta.title);
  if (meta.q) return "搜索 " + truncate(meta.q, 28);
  if (meta.kind === "page") return "第 " + (Number(meta.index) + 1) + " 页";
  if (meta.kind === "browse") return "浏览列表 第 " + (meta.page || 1) + " 页";
  if (meta.kind === "read") return "章节数据 " + (meta.cid || "");
  return truncate(entry.key, 40);
}

function entryDesc(entry) {
  const meta = entry.meta || {};
  const parts = [];
  if (meta.cid) parts.push("cid " + meta.cid);
  if (meta.aid && meta.aid !== meta.cid) parts.push("aid " + meta.aid);
  if (meta.mode) parts.push("压缩 " + meta.mode);
  parts.push(fmtBytes(entry.size));
  parts.push(fmtAgo(entry.accessed) || "未访问");
  parts.push(truncate(entry.key, 46));
  return parts.join(" · ");
}

export async function renderCache(view, ctx) {
  view.appendChild(pageHead("缓存管理", { back: () => history.back() }));

  const summaryHost = el("div", { style: "margin-bottom:14px" });
  const actionHost = el("div", { class: "row wrap", style: "margin-bottom:14px;gap:8px" });
  const segHost = el("div", { style: "margin-bottom:12px" });
  const listHost = el("div", {});
  view.appendChild(summaryHost);
  view.appendChild(actionHost);
  view.appendChild(segHost);
  view.appendChild(listHost);

  let stats = null;
  let kind = "pages";
  let entries = [];
  let offset = 0;
  let hasMore = false;
  let visibleBooks = BOOK_PAGE_SIZE;
  let busy = false;

  const seg = segControl({
    options: KINDS.map((item) => ({ label: item.label, value: item.value })),
    value: kind,
    onChange: (next) => {
      kind = next;
      reloadList();
      paintActions();
    },
  });
  segHost.appendChild(seg);

  function categoryRow(item, info, totalBytes, limitBytes) {
    const bytes = info.bytes || 0;
    const share = totalBytes > 0 ? Math.round((bytes / totalBytes) * 100) : 0;
    return el("div", { style: "margin-bottom:12px" }, [
      el("div", { class: "row", style: "gap:8px;margin-bottom:5px" }, [
        el("span", { class: "grow", text: item.label }),
        el("span", { class: "muted tiny", text: (info.count || 0) + " 项" }),
        el("span", { class: "tiny", style: "font-variant-numeric:tabular-nums", text: fmtBytes(bytes) + " · " + share + "%" }),
      ]),
      el("div", { class: "bar", title: fmtBytes(bytes) + " / " + fmtBytes(limitBytes) }, [
        el("i", { style: "width:" + (limitBytes > 0 ? Math.min(100, (bytes / limitBytes) * 100) : 0) + "%" }),
      ]),
    ]);
  }

  function paintSummary() {
    if (!stats) return;
    const total = stats.total_bytes || 0;
    const limit = stats.limit_bytes || 0;
    const byKind = stats.by_kind || {};
    const usedPct = limit > 0 ? Math.min(100, Math.round((total / limit) * 100)) : 0;

    summaryHost.innerHTML = "";
    summaryHost.appendChild(el("div", { class: "stats", style: "margin-bottom:12px" }, [
      statCard(fmtBytes(total), "已用"),
      statCard(fmtBytes(limit), "上限"),
      statCard(usedPct + "%", "占用比例"),
    ]));

    const panel = el("div", { class: "panel" }, [
      el("div", { class: "panel-head" }, [
        el("h2", { class: "grow", text: "分类占用" }),
        el("span", { class: "muted tiny", text: "空间不足时先清理读得少的历史缓存，书架收藏的最后清理" }),
      ]),
    ]);
    KINDS.forEach((item) => {
      panel.appendChild(categoryRow(item, byKind[item.value] || { count: 0, bytes: 0 }, total, limit));
    });
    summaryHost.appendChild(panel);
  }

  function paintActions() {
    actionHost.innerHTML = "";
    actionHost.appendChild(el("button", {
      class: "btn sm",
      type: "button",
      text: "按上限整理",
      onClick: evict,
    }));
    actionHost.appendChild(el("button", {
      class: "btn sm danger",
      type: "button",
      text: "清空" + (KIND_LABEL[kind] || kind),
      onClick: () => clearKind(kind),
    }));
    actionHost.appendChild(el("button", {
      class: "btn sm ghost",
      type: "button",
      text: "刷新",
      onClick: () => reload(),
    }));
  }

  function deleteButton(entry) {
    return el("button", {
      class: "btn sm danger",
      type: "button",
      text: "删除",
      onClick: async (evt) => {
        if (evt && evt.stopPropagation) evt.stopPropagation();
        try {
          await api.cacheDeleteItem(kind, keyRest(entry.key));
          toast("已删除该项");
          await reload();
        } catch (err) {
          toast("删除失败：" + (err && err.message ? err.message : "网络异常"));
        }
      },
    });
  }

  function entryRow(entry) {
    return listRow({
      icon: "archive",
      title: entryLabel(entry),
      desc: entryDesc(entry),
      trailing: el("div", { class: "row", style: "gap:6px" }, [deleteButton(entry)]),
      chevron: false,
    });
  }

  // Pages are one file per page, so listing 58 rows for one chapter hides the
  // useful action: drop or pack the whole chapter at once.
  function bookGroups() {
    const groups = new Map();
    entries.forEach((entry) => {
      const meta = entry.meta || {};
      const cid = meta.cid || keyRest(entry.key).split("|")[0];
      if (!groups.has(cid)) groups.set(cid, { cid: cid, aid: meta.aid || cid, entries: [], bytes: 0 });
      const group = groups.get(cid);
      group.entries.push(entry);
      group.aid = group.aid || meta.aid || cid;
      group.bytes += entry.size || 0;
    });
    return Array.from(groups.values());
  }

  function bookHead(group) {
    return el("div", { class: "panel-head cache-book-head", style: "margin-bottom:4px" }, [
      el("div", { class: "grow" }, [
        el("div", { class: "cache-book-title", text: "漫画 " + group.cid }),
        el("div", { class: "muted tiny", text: "章节缓存 · " + group.entries.length + " 页 · " + fmtBytes(group.bytes) }),
      ]),
      el("button", {
        class: "btn sm ghost",
        type: "button",
        text: "打开阅读",
        onClick: () => { location.hash = "#/read/" + encodeURIComponent(group.cid) + "?aid=" + encodeURIComponent(group.aid || group.cid); },
      }),
      el("button", {
        class: "btn sm",
        type: "button",
        text: "打包",
        onClick: () => packBook(group.cid),
      }),
      el("button", {
        class: "btn sm danger",
        type: "button",
        text: "删除缓存",
        onClick: () => dropBook(group.cid, group.entries.length),
      }),
    ]);
  }

  function paintList() {
    listHost.innerHTML = "";
    if (!entries.length) {
      listHost.appendChild(emptyState({
        icon: "archive",
        title: "这一类还没有缓存",
        text: "阅读、浏览或下载之后会产生缓存，随时可以在这里清理",
        actionLabel: "去首页看看",
        onAction: () => { location.hash = "#/home"; },
      }));
      return;
    }

    const panel = el("div", { class: "panel" });

    if (kind === "pages") {
      const groups = bookGroups();
      groups.slice(0, visibleBooks).forEach((group) => {
        panel.appendChild(el("div", { class: "cache-book" }, [bookHead(group)]));
      });
      hasMore = visibleBooks < groups.length;
    } else {
      const list = el("div", { class: "list" });
      entries.forEach((entry) => list.appendChild(entryRow(entry)));
      panel.appendChild(list);
    }

    if (hasMore) {
      panel.appendChild(el("div", { class: "row", style: "justify-content:center;margin-top:12px" }, [
        el("button", { class: "btn sm", type: "button", text: "加载更多", onClick: () => loadEntries(true) }),
      ]));
    }

    listHost.appendChild(panel);
  }

  async function packBook(cid) {
    const mode = (state.settings && state.settings.cache_compression) || "medium";
    try {
      toast("正在打包…", 6000);
      await api.cachePack(cid, mode);
      toast("已打包，可在「压缩包」里查看");
      await reload();
    } catch (err) {
      toast("打包失败：" + (err && err.message ? err.message : "网络异常"));
    }
  }

  async function dropBook(cid, count) {
    const ok = await confirmDialog({
      title: "删除本书页面",
      message: "删除 cid " + cid + " 的 " + count + " 个页面缓存？下次阅读会重新下载。",
      okText: "删除",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.cacheDropPages(cid);
      toast("已删除本书页面");
      await reload();
    } catch (err) {
      toast("删除失败：" + (err && err.message ? err.message : "网络异常"));
    }
  }

  async function clearKind(target) {
    const ok = await confirmDialog({
      title: "清空" + (KIND_LABEL[target] || target),
      message: "删除全部「" + (KIND_LABEL[target] || target) + "」缓存？此操作不可撤销。",
      okText: "清空",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.cacheClear(target);
      toast("已清空" + (KIND_LABEL[target] || target));
      await reload();
    } catch (err) {
      toast("清空失败：" + (err && err.message ? err.message : "网络异常"));
    }
  }

  async function evict() {
    try {
      await api.cacheEvict();
      toast("已按上限整理");
      await reload();
    } catch (err) {
      toast("整理失败：" + (err && err.message ? err.message : "网络异常"));
    }
  }

  async function loadStats() {
    stats = await api.cache();
    paintSummary();
  }

  async function loadEntries(append) {
    if (busy) return;
    busy = true;
    const scrollY = window.scrollY;
    if (!append) {
      entries = [];
      offset = 0;
      visibleBooks = BOOK_PAGE_SIZE;
      listHost.innerHTML = "";
      listHost.appendChild(loadingRow("读取缓存列表…", "catalog"));
    }
    try {
      const currentKind = kind;
      if (currentKind === "pages") {
        if (!append || entries.length === 0) {
          const allEntries = [];
          let cursor = 0;
          let batch = [];
          do {
            const payload = await api.cacheList(currentKind, PAGE_SIZE, cursor);
            batch = payload.entries || [];
            allEntries.push(...batch);
            cursor += batch.length;
          } while (batch.length === PAGE_SIZE);
          entries = allEntries;
        }
        const bookCount = bookGroups().length;
        if (append) visibleBooks = Math.min(visibleBooks + BOOK_PAGE_SIZE, bookCount);
        offset = entries.length;
        hasMore = visibleBooks < bookCount;
      } else {
        const payload = await api.cacheList(currentKind, PAGE_SIZE, append ? offset : 0);
        const batch = payload.entries || [];
        entries = append ? entries.concat(batch) : batch;
        offset = append ? offset + batch.length : batch.length;
        hasMore = batch.length >= PAGE_SIZE;
      }
      paintList();
    } catch (err) {
      if (append) {
        toast("加载失败：" + (err && err.message ? err.message : "网络异常"));
      } else {
        listHost.innerHTML = "";
        listHost.appendChild(errorState(
          err && err.message ? err.message : "缓存列表加载失败",
          () => reload()
        ));
      }
    } finally {
      busy = false;
      if (window.scrollY !== scrollY) window.scrollTo(0, scrollY);
    }
  }

  function reloadList() {
    return loadEntries(false);
  }

  async function reload() {
    try {
      await loadStats();
    } catch (err) {
      summaryHost.innerHTML = "";
      summaryHost.appendChild(errorState(
        err && err.message ? err.message : "缓存信息加载失败",
        () => reload()
      ));
      return;
    }
    await reloadList();
  }

  paintActions();
  summaryHost.appendChild(loadingRow("读取缓存…", "catalog"));
  await reload();
}
