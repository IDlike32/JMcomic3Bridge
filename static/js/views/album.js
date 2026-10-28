// Album detail: hero header, chapter list with per-chapter progress, downloads.
import { api, fmtNum } from "../api.js";
import {
  el, icon, iconButton, toast, openSheet, confirmDialog, coverCanvas,
  rail, sectionHead, skeletonRail, loadingRow, errorState,
} from "../ui.js";
import { isFavorite, toggleFavorite } from "../state.js";

const CHUNK = 200;
const TAG_PREVIEW = 16;
const DETAIL_OVERLAY = new URLSearchParams(location.search).get("overlay") === "detail";

export async function renderAlbum(view, ctx) {
  const aid = String((ctx && ctx.rest && ctx.rest[0]) || "");
  if (!aid) {
    view.appendChild(errorState("缺少作品编号"));
    return;
  }

  view.appendChild(albumSkeleton());

  let album;
  let progress = { items: [], favorite: false };
  try {
    const [payload, prog] = await Promise.all([
      api.album(aid),
      // Progress is a nicety: a failure here must not blank the whole page.
      api.albumProgress(aid).catch(() => ({ items: [], favorite: false })),
    ]);
    album = payload || {};
    progress = prog || progress;
  } catch (err) {
    view.innerHTML = "";
    view.appendChild(errorState(messageOf(err), () => {
      view.innerHTML = "";
      renderAlbum(view, ctx);
    }));
    return;
  }

  view.innerHTML = "";

  // Upstream uses "N/A" as an author placeholder; showing it is worse than hiding it.
  const authors = (Array.isArray(album.author) ? album.author : [album.author])
    .map((name) => String(name == null ? "" : name).trim())
    .filter((name) => name && !/^n\/?a$/i.test(name))
    .join(" / ");
  const chapters = chapterList(album, aid);
  const progressByCid = new Map(
    (progress.items || []).map((row) => [String(row.cid), row])
  );
  const latest = (progress.items || [])
    .slice()
    .sort((a, b) => (Number(b.updated) || 0) - (Number(a.updated) || 0))[0] || null;
  const primaryCid = latest ? String(latest.cid) : chapters[0].id;
  const chapterHost = el("div");
  let chapterPanelNode = null;
  let suspended = false;

  function showChapterPanel() {
    if (suspended || chapterPanelNode) return;
    chapterPanelNode = chapterPanel();
    chapterHost.appendChild(chapterPanelNode);
  }

  function hideChapterPanel() {
    if (!chapterPanelNode) return;
    chapterPanelNode.remove();
    chapterPanelNode = null;
  }

  view.appendChild(hero(album, aid, authors));
  view.appendChild(actionBar());
  const description = descriptionBlock(album.description);
  if (description) view.appendChild(description);
  view.appendChild(chapterHost);
  showChapterPanel();
  const related = relatedBlock(album.related_list);
  if (related) view.appendChild(related);

  function onVisibility() {
    const hidden = document.visibilityState === "hidden";
    if (hidden === suspended) return;
    suspended = hidden;
    if (suspended) hideChapterPanel();
    else showChapterPanel();
  }
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    hideChapterPanel();
  };

  function actionBar() {
    const primary = el("button", {
      class: "btn primary grow",
      type: "button",
      onClick: () => {
        location.hash = "#/read/" + primaryCid + "?aid=" + aid;
      },
    }, [
      icon("play"),
      el("span", {
        text: latest && latest.page
          ? "继续阅读 · 第 " + latest.page + " 页"
          : "开始阅读",
      }),
    ]);

    const fav = el("button", {
      class: "icon-btn fav-btn" + (isFavorite(aid) ? " on" : ""),
      type: "button",
      title: isFavorite(aid) ? "移出书架" : "加入书架",
      "aria-label": isFavorite(aid) ? "移出书架" : "加入书架",
    }, [icon("heart")]);
    fav.addEventListener("click", async () => {
      try {
        const on = await toggleFavorite({
          aid,
          title: album.name || "",
          author: authors,
        });
        fav.classList.toggle("on", on);
        fav.title = on ? "移出书架" : "加入书架";
        fav.setAttribute("aria-label", fav.title);
        toast(on ? "已加入书架" : "已移出书架");
      } catch (err) {
        toast("收藏失败：" + messageOf(err));
      }
    });

    const zip = el("button", { class: "btn sm", type: "button", title: "下载 ZIP" }, [
      icon("download"),
      el("span", { text: "ZIP" }),
    ]);
    zip.addEventListener("click", () => {
      window.open(api.downloadUrl(primaryCid, album.name || ""), "_blank");
    });

    const more = iconButton("more", openMore, { title: "更多操作" });

    return el("div", {
      class: "row",
      style: "position:sticky;top:0;z-index:6;gap:8px;padding:10px 0;margin-bottom:6px;background:color-mix(in srgb, var(--bg) 88%, transparent);backdrop-filter:blur(12px)",
    }, [primary, fav, zip, more]);
  }

  function openMore() {
    const body = el("div", { class: "list" }, [
      moreRow("archive", "打包进缓存", "按当前压缩率打包本章，离线可读", async () => {
        // Empty mode means "use the configured compression tier" on the server.
        const res = await api.cachePack(primaryCid, "");
        return "已打包 " + (res.pages || 0) + " 页";
      }),
      moreRow("trash", "清空本书缓存", "只删本书已缓存的页面", async () => {
        const ok = await confirmDialog({
          title: "清空本书缓存",
          message: "将删除本书已缓存的页面，阅读时会重新下载。",
          okText: "清空",
          danger: true,
        });
        if (!ok) return "";
        const removed = await dropBookCache(chapters.map((ch) => ch.id));
        return removed ? "已清空 " + removed + " 项" : "没有可清理的缓存";
      }),
    ]);
    const sheet = openSheet({
      title: "更多操作",
      subtitle: album.name || "",
      body,
    });

    function moreRow(iconName, title, desc, run) {
      const row = el("div", { class: "list-row" }, [
        el("div", { class: "lead" }, [icon(iconName)]),
        el("div", { class: "grow" }, [
          el("div", { class: "title", text: title }),
          el("div", { class: "desc", text: desc }),
        ]),
        icon("chevron-right", "chev"),
      ]);
      row.addEventListener("click", async () => {
        sheet.close();
        toast("处理中…");
        try {
          const message = await run();
          if (message) toast(message);
        } catch (err) {
          toast("操作失败：" + messageOf(err));
        }
      });
      return row;
    }
  }

  function chapterPanel() {
    let keyword = "";
    let descending = false;
    let limit = CHUNK;

    const filter = el("input", {
      class: "input",
      type: "search",
      placeholder: "筛选章节",
      style: "height:34px;width:auto;min-width:110px;flex:1;max-width:180px",
    });
    const orderLabel = el("span", { text: "正序" });
    const orderBtn = el("button", { class: "btn sm", type: "button" }, [
      icon("sort"),
      orderLabel,
    ]);
    orderBtn.addEventListener("click", () => {
      descending = !descending;
      orderLabel.textContent = descending ? "倒序" : "正序";
      limit = CHUNK;
      paint();
    });
    filter.addEventListener("input", () => {
      keyword = filter.value.trim().toLowerCase();
      limit = CHUNK;
      paint();
    });

    const rows = el("div", { class: "list" });
    const panel = el("div", { class: "panel" }, [
      el("div", { class: "panel-head" }, [
        el("h2", { text: "章节 " + chapters.length }),
        el("div", { class: "grow" }),
        filter,
        orderBtn,
      ]),
      rows,
    ]);

    function paint() {
      rows.innerHTML = "";
      const matched = chapters.filter((ch) =>
        !keyword || ch.name.toLowerCase().includes(keyword)
      );
      const ordered = descending ? matched.slice().reverse() : matched;
      if (!ordered.length) {
        rows.appendChild(el("div", { class: "muted tiny", style: "padding:10px 4px", text: "没有匹配的章节" }));
        return;
      }
      ordered.slice(0, limit).forEach((ch) => rows.appendChild(chapterRow(ch)));
      const rest = ordered.length - limit;
      if (rest > 0) {
        rows.appendChild(el("button", {
          class: "btn ghost block sm",
          type: "button",
          text: "显示更多（还有 " + rest + " 章）",
          onClick: () => { limit += CHUNK; paint(); },
        }));
      }
    }

    paint();
    return panel;
  }

  function chapterRow(ch) {
    const row = progressByCid.get(ch.id);
    const status = !row
      ? ""
      : row.finished
        ? "已读"
        : row.page ? "第 " + row.page + " 页" : "";
    const node = el("div", {
      class: "ch-item",
      role: "link",
      tabindex: "0",
      style: "color:var(--text);border-bottom:1px solid var(--border);border-radius:0",
      onClick: () => { location.hash = "#/read/" + ch.id + "?aid=" + aid; },
      onKeydown: (evt) => {
        if (evt.key === "Enter" || evt.key === " ") {
          evt.preventDefault();
          node.click();
        }
      },
    }, [
      el("span", { class: "idx", text: String(ch.index) }),
      el("span", { class: "nm", text: ch.name }),
      status ? el("span", { class: "ch-progress", text: status }) : null,
    ]);
    return node;
  }

  function hero(data, albumId, authorLine) {
    const bg = el("div", {
      style: "position:absolute;inset:-30px;background-image:url('" + api.coverUrl(albumId, 640) +
        "');background-size:cover;background-position:center;filter:blur(26px) saturate(1.15);opacity:.5",
    });
    const mask = el("div", {
      style: "position:absolute;inset:0;background:linear-gradient(180deg,color-mix(in srgb, var(--bg) 30%, transparent),color-mix(in srgb, var(--bg) 78%, transparent) 58%,var(--bg))",
    });
    // coverCanvas() returns an absolutely positioned fill layer: it has to live in a
    // sized box, or it stretches over the whole hero and covers the text.
    const cover = el("div", { class: "hero-cover" }, [
      coverCanvas(api.progCoverUrl(albumId, 360), { aid: albumId, size: 360 }),
    ]);
    cover.firstChild.setAttribute("alt", data.name || "");

    const stats = el("div", { class: "row wrap tiny muted", style: "gap:12px;margin-top:8px" }, [
      el("span", { text: fmtNum(data.total_views) + " 浏览" }),
      el("span", { text: fmtNum(data.likes) + " 点赞" }),
      el("span", { text: (data.total_photos || 0) + " 页" }),
    ]);

    const back = el("button", {
      class: "back-btn hero-back",
      type: "button",
      "aria-label": "返回",
      title: "返回",
      onClick: () => {
        // A deep link into an album has no history to go back to.
        if (DETAIL_OVERLAY && window.parent && window.parent !== window) {
          window.parent.postMessage({ type: "detail-back" }, location.origin);
        } else if (window.history.length > 1) history.back();
        else location.hash = "#/home";
      },
    }, [icon("arrow-left")]);

    return el("div", {
      style: "position:relative;overflow:hidden;border-radius:var(--radius);padding:18px 16px;margin-bottom:10px",
    }, [
      bg,
      mask,
      back,
      el("div", { class: "row hero-body", style: "position:relative;z-index:2;align-items:flex-start;gap:14px;margin-top:34px" }, [
        cover,
        el("div", { class: "grow hero-info" }, [
          el("h1", { text: data.name || "(无标题)", style: "font-size:19px;line-height:1.35" }),
          el("div", { class: "row wrap muted tiny", style: "gap:12px;margin-top:4px" }, [
            authorLine ? el("span", { text: authorLine }) : null,
            el("span", { text: "車牌號：" + albumId }),
          ]),
          stats,
          tagBox(data.tags),
        ]),
      ]),
    ]);
  }

  function tagBox(tags) {
    // Upstream rows can carry whitespace-only or duplicated tags; those render as
    // empty pills, so normalise before drawing.
    const list = Array.from(new Set((tags || [])
      .map((tag) => String(tag == null ? "" : tag).trim())
      .filter(Boolean)));
    if (!list.length) return null;
    const box = el("div", { class: "chips", style: "margin-top:10px" });
    let opened = false;
    function paint() {
      box.innerHTML = "";
      const shown = opened ? list : list.slice(0, TAG_PREVIEW);
      shown.forEach((tag) => {
        box.appendChild(el("button", {
          class: "chip",
          type: "button",
          text: tag,
          onClick: () => { location.hash = "#/search?q=" + encodeURIComponent(tag); },
        }));
      });
      if (!opened && list.length > TAG_PREVIEW) {
        box.appendChild(el("button", {
          class: "chip plain",
          type: "button",
          text: "+" + (list.length - TAG_PREVIEW),
          onClick: () => { opened = true; paint(); },
        }));
      }
    }
    paint();
    return box;
  }

  function descriptionBlock(text) {
    const body = String(text || "").trim();
    if (!body) return null;
    const para = el("p", { class: "dim clamp3", style: "margin:0;white-space:pre-line", text: body });
    const toggle = el("button", { class: "btn ghost sm", type: "button", text: "展开" });
    toggle.addEventListener("click", () => {
      toggle.textContent = para.classList.toggle("clamp3") ? "展开" : "收起";
    });
    return el("div", { class: "panel" }, [
      el("div", { class: "row", style: "align-items:baseline;margin-bottom:6px" }, [
        el("h2", { text: "简介" }),
        el("div", { class: "grow" }),
        toggle,
      ]),
      para,
    ]);
  }

  function relatedBlock(items) {
    const list = (items || []).filter((item) => item && (item.id || item.aid)).map((item) => Object.assign({}, item, { id: String(item.id || item.aid) }));
    if (!list.length) return null;
    const relatedRail = rail(list);
    relatedRail.addEventListener("click", (evt) => {
      const card = evt.target.closest && evt.target.closest(".tile");
      if (!card || !relatedRail.contains(card)) return;
      const index = Array.prototype.indexOf.call(relatedRail.children, card);
      if (index < 0 || !list[index]) return;
      evt.preventDefault();
      evt.stopPropagation();
      openRelated(list[index]);
    }, true);
    return el("div", { class: "section", style: "margin-top:20px" }, [
      sectionHead("相关推荐", { sub: list.length + " 部" }),
      relatedRail,
    ]);

    function openRelated(item) {
      const id = String(item && (item.id || item.aid) || "");
      if (!id) return;
      if (window.parent && window.parent !== window) window.parent.postMessage({ type: "detail-next", aid: id }, location.origin);
      else location.hash = "#/album/" + encodeURIComponent(id);
    }
  }
}

function chapterList(album, aid) {
  const series = Array.isArray(album.series) ? album.series.filter((ch) => ch && ch.id) : [];
  if (series.length) {
    return series
      .slice()
      .sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0))
      .map((ch, idx) => ({
        id: String(ch.id),
        index: ch.sort || idx + 1,
        name: String(ch.name || "第 " + (ch.sort || idx + 1) + " 话"),
      }));
  }
  // A single-volume album is its own chapter: the read endpoint keys off the album id.
  return [{ id: aid, index: 1, name: album.name || "正篇" }];
}

async function dropBookCache(ids) {
  const wanted = new Set(ids.map(String));
  if (wanted.size <= 4) {
    let removed = 0;
    for (const cid of wanted) {
      const res = await api.cacheDropPages(cid);
      removed += (res && res.removed) || 0;
    }
    return removed;
  }
  // One request per chapter would mean hundreds of DELETEs for a long series;
  // scanning the index first keeps the purge to a single pass over cached pages.
  const entries = [];
  let offset = 0;
  while (entries.length < 4000) {
    const page = await api.cacheList("pages", 200, offset);
    const rows = (page && page.entries) || [];
    entries.push(...rows);
    if (rows.length < 200) break;
    offset += rows.length;
  }
  let removed = 0;
  for (const entry of entries) {
    const meta = entry.meta || {};
    if (!wanted.has(String(meta.cid || ""))) continue;
    const key = entry.key.indexOf("|") >= 0
      ? entry.key.slice(entry.key.indexOf("|") + 1)
      : entry.key;
    const res = await api.cacheDeleteItem("pages", key);
    removed += (res && res.removed) || 0;
  }
  return removed;
}

function albumSkeleton() {
  return el("div", {}, [
    el("div", { class: "skeleton", style: "height:150px;border-radius:var(--radius);margin-bottom:16px" }),
    el("div", { class: "row", style: "gap:14px;margin-bottom:16px;align-items:flex-start" }, [
      el("div", { class: "skeleton", style: "width:110px;height:147px;border-radius:var(--radius-sm)" }),
      el("div", { class: "grow" }, [
        el("div", { class: "skeleton", style: "height:16px;width:72%;margin-bottom:10px" }),
        el("div", { class: "skeleton", style: "height:12px;width:38%;margin-bottom:12px" }),
        el("div", { class: "skeleton", style: "height:12px;width:55%" }),
      ]),
    ]),
    loadingRow("加载详情…"),
    skeletonRail(4),
  ]);
}

function messageOf(err) {
  return String((err && err.message) || err || "网络或线路出了点问题");
}