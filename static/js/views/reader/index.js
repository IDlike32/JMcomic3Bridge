// The reader.
//
// One scrolling surface, virtualised pages (flow.js), a chrome that fades out of
// the way, and a background download task that keeps the next pages ready.
import { api } from "../../api.js";
import { el, icon, toast, openSheet, segControl, isUnsupported } from "../../ui.js";
import { onEvent } from "../../events.js";
import { loadPrefs, savePrefs } from "./prefs.js";
import { createFlow } from "./flow.js";
import { createProgressReporter } from "./progress.js";

// Safety net only: pages arrive as "page stored" events, so this reconcile pass exists to
// recover from a missed event or a restarted task, not to poll for progress.
const RECONCILE_MS = 5000;
const HIDE_FIRST_MS = 2600;

function chapterLabel(chapter, index) {
  const name = (chapter && chapter.name) || "";
  if (name) return name;
  const sort = chapter && chapter.sort !== undefined ? chapter.sort : String(index + 1);
  return "第 " + sort + " 话";
}

export async function openReader(cid, aid) {
  const id = String(cid || "");
  if (!id) {
    location.hash = "#/home";
    return { close() {} };
  }

  const prefs = loadPrefs();
  const openingRoot = el("div", { class: "reader reader-opening-shell" });
  openingRoot.appendChild(el("div", { class: "r-bar top" }, [
    el("div", { class: "r-head" }, [
      el("button", { type: "button", "aria-label": "返回", onClick: () => history.back() }, [icon("arrow-left")]),
      el("div", { class: "title", text: "正在读取章节目录…" }),
    ]),
  ]));
  openingRoot.appendChild(el("div", { class: "reader-opening", role: "status" }, [
    el("span", { class: "spinner" }),
    el("div", { text: "正在连接漫画线路" }),
    el("div", { class: "muted tiny", text: "目录响应后会立即开始载入页面" }),
  ]));
  document.body.appendChild(openingRoot);

  let read = null;
  let failure = "";
  try {
    read = await api.read(id);
  } catch (err) {
    failure = String(err && err.message ? err.message : err);
  }

  openingRoot.remove();
  const root = el("div", { class: "reader" });
  const loadBar = el("div", { class: "r-loadbar" }, [el("i", { style: "width:0%" })]);
  const dim = el("div", { class: "r-dim" });
  const scroller = el("div", { class: "reader-scroll", tabindex: "0" });
  const flowEl = el("div", { class: "reader-flow" });
  const hint = el("div", { class: "r-hint", text: "轻点屏幕呼出工具栏" });
  scroller.appendChild(flowEl);

  if (failure) {
    // A novel chapter has no pages: retrying can never make it loadable.
    const unsupported = isUnsupported(failure);
    root.appendChild(el("div", { class: "r-bar top" }, [
      el("div", { class: "r-head" }, [
        el("button", { type: "button", "aria-label": "返回", onClick: () => history.back() }, [icon("arrow-left")]),
        el("div", { class: "title", text: unsupported ? "暂不支持" : "打开失败" }),
      ]),
    ]));
    const acts = [];
    if (!unsupported) {
      acts.push(el("button", { class: "btn primary", type: "button", text: "重试", onClick: () => location.reload() }));
    }
    acts.push(el("button", {
      class: unsupported ? "btn primary" : "btn ghost",
      type: "button",
      text: "返回",
      onClick: () => { if (history.length > 1) history.back(); else location.hash = "#/home"; },
    }));
    root.appendChild(el("div", { style: "flex:1;display:grid;place-items:center;padding:24px;text-align:center" }, [
      el("div", {}, [
        el("div", { style: "font-size:15px;margin-bottom:6px", text: unsupported ? "暂不支持这种作品" : "章节加载失败" }),
        el("div", { class: "muted tiny", style: "margin-bottom:18px",
          text: unsupported ? "这是小说等非漫画类型，当前只能阅读漫画，无法加载。" : failure }),
        el("div", { class: "row", style: "gap:8px;justify-content:center" }, acts),
      ]),
    ]));
    document.body.appendChild(root);
    return {
      close() {
        root.remove();
      },
    };
  }

  const total = parseInt(read.total_page, 10) || (read.images || []).length || 0;
  // series_id "0" means the chapter stands alone; using it as an album id would
  // break the neighbour lookup and every cover request keyed by it.
  const seriesId = String(read.series_id || "");
  const albumAid = String(aid || (seriesId && seriesId !== "0" ? seriesId : read.id || id));
  const scramble = read.scramble_id == null ? "" : read.scramble_id;
  const decodeAid = String(read.id || id);
  const title = read.name || "章节 " + id;

  // ---- chrome ----
  const counter = el("span", { class: "counter", text: prefs.showCounter ? "1 / " + total : "" });
  // No `text` here: el() would write it and then append the spans, duplicating the title.
  const titleNode = el("div", { class: "title", title: "打开章节列表 · cid " + id }, [
    el("span", { class: "r-title-name", text: title }),
    el("span", { class: "r-title-cid", text: "cid " + id }),
  ]);
  const backBtn = el("button", { type: "button", "aria-label": "返回", onClick: () => history.back() }, [icon("arrow-left")]);
  const settingsBtn = el("button", { type: "button", "aria-label": "阅读设置", onClick: () => openSettings() }, [icon("settings")]);
  const downloadBtn = el("button", {
    type: "button",
    "aria-label": "缓存进度",
    title: "缓存进度",
    onClick: () => toggleCacheTip(),
  }, [icon("download")]);

  // Only meaningful while something actually failed; hidden to keep the bar quiet.
  const retryAllBtn = el("button", {
    type: "button",
    class: "r-retry-all",
    hidden: true,
    "aria-label": "重试全部失败图片",
    title: "重试全部失败图片",
    onClick: () => retryAllFailed(),
  }, [icon("refresh"), el("span", { text: "重试" })]);

  const topBar = el("div", { class: "r-bar top" }, [
    el("div", { class: "r-head" }, [backBtn, el("div", { class: "grow", style: "min-width:0" }, [titleNode]), counter, retryAllBtn, downloadBtn, settingsBtn]),
  ]);

  const slider = el("input", {
    type: "range",
    min: "1",
    max: String(Math.max(1, total)),
    value: "1",
    "aria-label": "页码",
    onInput: (evt) => {
      const page = Number(evt.target.value);
      flow.scrollToPage(page);
      updateCounter(page);
      showPreview(page);
    },
    onChange: () => hidePreview(),
  });
  const preview = el("div", { class: "r-preview" }, [
    el("img", { alt: "" }),
    el("div", { class: "lbl", text: "1" }),
  ]);

  const prevBtn = el("button", { class: "btn", type: "button", disabled: true, onClick: () => goChapter(neighbors.prev) }, [
    icon("chevron-left"), el("span", { text: "上一章" }),
  ]);
  const nextBtn = el("button", { class: "btn", type: "button", disabled: true, onClick: () => goChapter(neighbors.next) }, [
    el("span", { text: "下一章" }), icon("chevron-right"),
  ]);
  const listBtn = el("button", { class: "btn", type: "button", onClick: () => toggleDrawer() }, [
    icon("list"), el("span", { text: "目录" }),
  ]);
  const jumpBtn = el("button", { class: "btn", type: "button", onClick: () => askJump() }, [
    icon("sort"), el("span", { text: "跳页" }),
  ]);

  const bottomBar = el("div", { class: "r-bar bottom" }, [
    el("div", { class: "r-foot" }, [
      el("div", { class: "r-slider" }, [slider]),
      el("div", { class: "nav-row" }, [prevBtn, listBtn, jumpBtn, nextBtn]),
    ]),
  ]);

  const chromeTop = el("div", { class: "r-chrome top" }, [topBar]);
  const chromeBottom = el("div", { class: "r-chrome bottom" }, [bottomBar]);

  // ---- cache progress tip (the download button opens this, nothing else) ----
  const tipGrid = el("div", { class: "grid" });
  const tipSum = el("div", { class: "sum" });
  const cacheTip = el("div", { class: "r-cachetip" }, [
    el("div", { class: "head" }, [
      el("span", { text: "缓存进度" }),
      el("button", { type: "button", "aria-label": "关闭", class: "x", onClick: () => toggleCacheTip(false) }, [icon("close")]),
    ]),
    tipGrid,
    el("div", { class: "legend" }, [
      el("span", {}, [el("i", { class: "ok" }), "已载入"]),
      el("span", {}, [el("i", { class: "wait" }), "缓存中"]),
      el("span", {}, [el("i", { class: "idle" }), "未开始"]),
      el("span", {}, [el("i", { class: "retry" }), "重试中"]),
      el("span", {}, [el("i", { class: "bad" }), "失败"]),
    ]),
    tipSum,
  ]);

  // ---- end-of-chapter card ----
  const endCard = el("div", { class: "r-endcard" }, [
    el("div", { class: "done-mark", text: "本章完" }),
    el("h3", { text: title }),
    el("div", { class: "acts" }, [
      el("button", { class: "btn primary", type: "button", text: "下一章", onClick: () => goChapter(neighbors.next) }),
      el("button", { class: "btn", type: "button", text: "章节列表", onClick: () => toggleDrawer(true) }),
      el("button", { class: "btn ghost", type: "button", text: "返回详情", onClick: () => { location.hash = "#/album/" + albumAid; } }),
    ]),
  ]);

  // ---- drawer ----
  const drawerBody = el("div", { class: "drawer-body" });
  const drawer = el("div", { class: "r-drawer" }, [
    el("div", { class: "drawer-head" }, [
      el("div", { class: "grow", style: "font-weight:600", text: "章节列表" }),
      el("button", { type: "button", "aria-label": "关闭", style: "background:transparent;border:0;color:#cbd3e1;cursor:pointer", onClick: () => toggleDrawer(false) }, [icon("close")]),
    ]),
    drawerBody,
  ]);

  root.appendChild(loadBar);
  root.appendChild(scroller);
  root.appendChild(dim);
  // The end card lives inside the flow surface: it has to scroll with the pages,
  // otherwise it would sit fixed over the last page forever.
  flowEl.appendChild(endCard);
  root.appendChild(chromeTop);
  root.appendChild(chromeBottom);
  root.appendChild(cacheTip);
  root.appendChild(preview);
  root.appendChild(hint);
  root.appendChild(drawer);
  document.body.appendChild(root);
  document.body.style.overflow = "hidden";

  // ---- state ----
  const neighbors = { prev: null, next: null };
  let series = [];
  let currentPage = 1;
  let readyPages = new Set();
  let visible = true;
  let hideTimer = 0;
  let statusPages = [];
  let tipOpen = false;
  let destroyed = false;
  let drawerOpen = false;
  let lastTapAt = 0;

  const flow = createFlow({
    scrollEl: scroller,
    flowEl,
    endCard,
    prefs,
    // A whole page image, not the frame stream: <img> decodes webp directly.
    pageUrlFor: (index) => api.pageUrl(id, index + 1, decodeAid, scramble),
    onPageChange: (index) => {
      const page = index + 1;
      currentPage = page;
      updateCounter(page);
      slider.value = String(page);
      reporter.report(page);
      api.focusTask(id, page).catch(() => {});
      if (page >= total && total > 0) showEnd();
    },
    onLoaded: (index) => {
      readyPages.add(index + 1);
      updateLoadBar();
      if (tipOpen) paintCacheTip();
    },
    onStats: () => {
      if (tipOpen) paintCacheTip();
      paintRetryButton();
    },
    onRetryPage: (index) => { retryOnePage(index); },
  });

  const reporter = createProgressReporter({
    cid: id,
    aid: albumAid,
    title: title,
    album: "",
    total: total,
  });

  function updateCounter(page) {
    if (!prefs.showCounter) {
      counter.textContent = "";
      return;
    }
    counter.textContent = page + " / " + total;
  }

  function updateLoadBar() {
    const ratio = total ? Math.min(1, readyPages.size / total) : 0;
    loadBar.firstChild.style.width = Math.round(ratio * 100) + "%";
    loadBar.style.opacity = ratio >= 1 ? "0" : "1";
    paintRetryButton();
  }

  // --- retrying failed artwork -------------------------------------------------
  //
  // Two levers, on purpose: the backend re-arms pages that spent their retry budget (and
  // covers whose budget went stale), while the local flow clears the "gave up" flag so the
  // <img> is really requested again instead of showing the same dead node.
  let retrying = false;

  function failedIndexes() {
    return flow.failedIndexes();
  }

  let lastFailedCount = 0;

  function paintRetryButton() {
    const count = failedIndexes().length;
    // A failure deserves to be seen: the chrome auto-hides, which would hide the only
    // retry affordance along with it.
    if (count > lastFailedCount) showChrome();
    lastFailedCount = count;
    retryAllBtn.hidden = count === 0;
    retryAllBtn.disabled = retrying;
    const label = retryAllBtn.querySelector("span");
    if (label) label.textContent = count ? "重试 " + count : "重试";
    retryAllBtn.title = count
      ? "重试全部 " + count + " 张无法加载的图片"
      : "重试全部失败图片";
  }

  async function retryAllFailed() {
    const count = failedIndexes().length;
    if (!count || retrying) return;
    retrying = true;
    paintRetryButton();
    try {
      const result = await api.retryTaskPages(id);
      const rearmed = Number((result && result.rearmed) || 0);
      flow.retryFailed();
      toast(rearmed ? "已重新排队 " + count + " 页，正在重试" : "已重试 " + count + " 页");
      await refreshStatus();
    } catch (err) {
      toast("重试失败：" + String((err && err.message) || err));
    } finally {
      retrying = false;
      paintRetryButton();
    }
  }

  async function retryOnePage(index) {
    if (retrying) return;
    retrying = true;
    paintRetryButton();
    try {
      await api.retryTaskPages(id).catch(() => null);
      flow.retryPage(index);
      toast("正在重试第 " + (index + 1) + " 页");
      await refreshStatus();
    } catch (err) {
      toast("重试失败：" + String((err && err.message) || err));
    } finally {
      retrying = false;
      paintRetryButton();
    }
  }

  // ---- cache tip ----
  //
  // Five states, one per block: green is on screen, yellow is still on its way
  // (downloading, or downloaded and queued for the browser), grey has not started,
  // purple is retrying, red gave up after three attempts.
  const BLOCK_CLASS = {
    loaded: "ok",
    cached: "wait",
    loading: "wait",
    idle: "idle",
    retry: "retry",
    failed: "bad",
  };
  const BLOCK_LABEL = {
    loaded: "已载入",
    cached: "已缓存，等待载入",
    loading: "正在缓存",
    idle: "未开始",
    retry: "重试中",
    failed: "无法获取",
  };
  let tipBlocks = [];
  let tipVisuals = [];

  function paintCacheTip() {
    if (!tipOpen) return;
    const visuals = flow.visuals();
    if (tipBlocks.length !== visuals.length) {
      tipGrid.innerHTML = "";
      tipBlocks = visuals.map((visual, index) => {
        const block = el("span", { class: "blk " + BLOCK_CLASS[visual] });
        block.title = "第 " + (index + 1) + " 页 · " + BLOCK_LABEL[visual];
        tipGrid.appendChild(block);
        return block;
      });
      tipVisuals = visuals.slice();
    } else {
      for (let i = 0; i < visuals.length; i += 1) {
        if (tipVisuals[i] === visuals[i]) continue;
        tipBlocks[i].className = "blk " + BLOCK_CLASS[visuals[i]];
        tipBlocks[i].title = "第 " + (i + 1) + " 页 · " + BLOCK_LABEL[visuals[i]];
        tipVisuals[i] = visuals[i];
      }
    }
    const counts = flow.stats();
    // Name the pages that cannot be fetched and why, so a stuck chapter is diagnosable
    // without opening dev tools.
    const failedPages = (statusPages || []).filter((page) => page.state === "failed");
    const firstReason = failedPages.length && failedPages[0].error ? failedPages[0].error : "";
    const spent = failedPages.length ? failedPages[0].attempts : 0;
    const maxSpent = failedPages.length ? failedPages[0].max_attempts : 0;
    tipSum.textContent =
      "已载入 " + counts.loaded + " / " + counts.total +
      " · 缓存中 " + (counts.cached + counts.loading) +
      (counts.failed
        ? " · 无法获取 " + counts.failed + " 页" +
          (firstReason ? "（" + firstReason + (spent ? "，已重试 " + spent + (maxSpent ? "/" + maxSpent : "") + " 次" : "") + "）" : "")
        : "");
  }

  function toggleCacheTip(force) {
    const next = force === undefined ? !tipOpen : !!force;
    tipOpen = next;
    cacheTip.classList.toggle("in", next);
    if (next) {
      showChrome();
      if (hideTimer) clearTimeout(hideTimer);
      paintCacheTip();
    } else {
      scheduleHide();
    }
  }

  function showPreview(page) {
    preview.querySelector(".lbl").textContent = String(page);
    const img = preview.querySelector("img");
    // Thumbnails are cache-only like pages; an uncached page keeps the number, no icon.
    img.addEventListener("error", () => { img.style.visibility = "hidden"; }, { once: true });
    img.addEventListener("load", () => { img.style.visibility = "visible"; }, { once: true });
    img.src = api.thumbUrl(id, page, decodeAid, scramble, 160);
    preview.classList.add("in");
  }

  function hidePreview() {
    preview.classList.remove("in");
  }

  function showEnd() {
    endCard.style.display = "flex";
  }

  // ---- chrome visibility ----
  function showChrome(restartTimer) {
    root.classList.remove("hide-ui");
    hint.classList.remove("in");
    if (restartTimer !== false) scheduleHide();
  }

  function hideChrome() {
    if (drawerOpen) return;
    root.classList.add("hide-ui");
  }

  function scheduleHide() {
    if (hideTimer) clearTimeout(hideTimer);
    const delay = Number(prefs.hideDelay) || 0;
    if (delay <= 0) return;
    hideTimer = setTimeout(hideChrome, delay);
  }

  function setDim(value) {
    dim.style.opacity = String(Math.max(0, Math.min(0.85, value)));
  }

  function applyFitClass() {
    root.classList.toggle("fit-height", prefs.fit === "height");
  }

  // ---- drawer ----
  function renderSeries() {
    drawerBody.innerHTML = "";
    if (!series.length) {
      drawerBody.appendChild(el("div", { class: "muted", style: "padding:16px;font-size:13px", text: "没有拿到章节列表" }));
      return;
    }
    series.forEach((chapter, index) => {
      const on = String(chapter.id) === id;
      const row = el("div", { class: "ch-item" + (on ? " on" : "") }, [
        el("span", { class: "idx", text: String(index + 1) }),
        el("span", { class: "nm", text: chapterLabel(chapter, index) }),
        on ? el("span", { class: "pg", text: "阅读中" }) : null,
      ]);
      row.addEventListener("click", () => {
        if (on) {
          toggleDrawer(false);
          return;
        }
        location.hash = "#/read/" + chapter.id + "?aid=" + albumAid;
      });
      drawerBody.appendChild(row);
    });
    // Scroll the drawer's own body only: scrollIntoView bubbles to ancestors and
    // used to shift the whole reader sideways to reveal the open drawer.
    const active = drawerBody.querySelector(".ch-item.on");
    if (active) {
      const offset = active.offsetTop - drawerBody.clientHeight / 2 + active.offsetHeight / 2;
      drawerBody.scrollTop = Math.max(0, offset);
    }
  }

  function toggleDrawer(force) {
    const next = force === undefined ? !drawerOpen : !!force;
    drawerOpen = next;
    drawer.classList.toggle("in", next);
    if (next) {
      showChrome(false);
      if (hideTimer) clearTimeout(hideTimer);
      renderSeries();
    } else {
      scheduleHide();
    }
  }

  // ---- chapter navigation ----
  function goChapter(target) {
    if (!target) {
      toast("没有更多章节了");
      return;
    }
    location.hash = "#/read/" + target.id + "?aid=" + albumAid;
  }

  function askJump() {
    const body = el("div", {}, [
      el("p", { class: "muted tiny", style: "margin:0 0 12px", text: "跳转到第几页（共 " + total + " 页）" }),
      el("input", { class: "input", type: "number", min: "1", max: String(total), value: String(currentPage), id: "jump-input" }),
    ]);
    const sheet = openSheet({
      title: "跳页",
      body,
      onClose: () => {},
    });
    const input = body.querySelector("input");
    input.focus();
    input.select();
    input.addEventListener("keydown", (evt) => {
      if (evt.key !== "Enter") return;
      const page = Number(input.value) || 1;
      sheet.close();
      flow.scrollToPage(page);
      showChrome();
    });
    body.appendChild(el("div", { class: "row", style: "margin-top:16px;justify-content:flex-end" }, [
      el("button", {
        class: "btn primary",
        type: "button",
        text: "跳转",
        onClick: () => {
          const page = Number(input.value) || 1;
          sheet.close();
          flow.scrollToPage(page);
          showChrome();
        },
      }),
    ]));
  }

  // ---- settings ----
  function openSettings() {
    const current = savePrefs({});
    const body = el("div", { class: "r-set" });

    function group(label, node) {
      body.appendChild(el("div", { class: "grp" }, [el("div", { class: "lbl", text: label }), node]));
    }

    group("图片适配", segControl({
      value: current.fit,
      options: [
        { label: "宽度撑满", value: "width" },
        { label: "高度适应", value: "height" },
        { label: "原始尺寸", value: "original" },
      ],
      onChange: (value) => apply({ fit: value }),
    }));

    group("页间距", segControl({
      value: String(current.gap),
      options: [
        { label: "无", value: "0" },
        { label: "小", value: "4" },
        { label: "中", value: "8" },
        { label: "大", value: "16" },
      ],
      onChange: (value) => apply({ gap: Number(value) }),
    }));

    group("预取页数", segControl({
      value: String(current.prefetch),
      options: [
        { label: "2", value: "2" },
        { label: "4", value: "4" },
        { label: "6", value: "6" },
      ],
      onChange: (value) => apply({ prefetch: Number(value) }),
    }));

    group("工具栏自动隐藏", segControl({
      value: String(current.hideDelay),
      options: [
        { label: "2 秒", value: "2000" },
        { label: "3 秒", value: "3000" },
        { label: "5 秒", value: "5000" },
        { label: "不隐藏", value: "0" },
      ],
      onChange: (value) => apply({ hideDelay: Number(value) }),
    }));

    const dimValue = el("span", { class: "val", text: Math.round(current.dim * 100) + "%" });
    group("亮度（遮罩）", el("div", { class: "range" }, [
      el("input", {
        type: "range",
        min: "0",
        max: "70",
        value: String(Math.round(current.dim * 100)),
        onInput: (evt) => {
          const value = Number(evt.target.value) / 100;
          dimValue.textContent = Math.round(value * 100) + "%";
          setDim(value);
          savePrefs({ dim: value });
        },
      }),
      dimValue,
    ]));

    group("缩放", el("div", { class: "range" }, [
      el("input", {
        type: "range",
        min: "100",
        max: "220",
        step: "5",
        value: String(Math.round(current.zoom * 100)),
        onInput: (evt) => {
          apply({ zoom: Number(evt.target.value) / 100 });
        },
      }),
      el("span", { class: "val", text: Math.round(current.zoom * 100) + "%" }),
    ]));

    group("页码显示", segControl({
      value: current.showCounter ? "on" : "off",
      options: [{ label: "显示", value: "on" }, { label: "隐藏", value: "off" }],
      onChange: (value) => {
        const showCounter = value === "on";
        apply({ showCounter });
        updateCounter(currentPage);
      },
    }));

    function apply(patch) {
      const next = savePrefs(patch);
      Object.assign(prefs, next);
      applyFitClass();
      flow.setPrefs(prefs);
      setDim(prefs.dim);
      if (patch.hideDelay !== undefined) scheduleHide();
      if (patch.showCounter !== undefined) updateCounter(flow.currentPage());
    }

    openSheet({ title: "阅读设置", body });
  }

  // ---- input ----
  function onScrollerClick(evt) {
    if (evt.target.closest("button")) return;
    const now = Date.now();
    if (now - lastTapAt < 280) {
      lastTapAt = 0;
      const zoomed = (prefs.zoom || 1) > 1.05;
      const next = zoomed ? 1 : 1.8;
      prefs = savePrefs({ zoom: next });
      flow.setPrefs(prefs);
      return;
    }
    lastTapAt = now;
    setTimeout(() => {
      if (lastTapAt !== now) return;
      lastTapAt = 0;
      if (root.classList.contains("hide-ui")) showChrome();
      else hideChrome();
    }, 220);
  }

  const keyHandler = (evt) => {
    const tag = (evt.target && evt.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (evt.target && evt.target.isContentEditable)) return;
    if (evt.target && evt.target.closest("[role=dialog], .sheet, .modal")) return;
    if (evt.key === "Escape") {
      if (drawerOpen) toggleDrawer(false);
      else history.back();
    } else if (evt.key === "ArrowDown" || evt.key === "PageDown" || evt.key === " ") {
      evt.preventDefault();
      flow.scrollBy(evt.key === " " ? metricsHeight() * 0.9 : metricsHeight() * 0.35);
      showChrome();
    } else if (evt.key === "ArrowUp" || evt.key === "PageUp") {
      evt.preventDefault();
      flow.scrollBy(-metricsHeight() * (evt.key === "PageUp" ? 0.9 : 0.35));
      showChrome();
    } else if (evt.key === "ArrowLeft") {
      evt.preventDefault();
      goChapter(neighbors.prev);
    } else if (evt.key === "ArrowRight") {
      evt.preventDefault();
      goChapter(neighbors.next);
    } else if (evt.key === "Home") {
      evt.preventDefault();
      flow.scrollToPage(1);
      showChrome();
    } else if (evt.key === "End") {
      evt.preventDefault();
      flow.scrollToEnd();
      showChrome();
    } else if (evt.key === "+" || evt.key === "=") {
      applyZoom(0.15);
    } else if (evt.key === "-" || evt.key === "_") {
      applyZoom(-0.15);
    } else if (evt.key === "f" || evt.key === "F") {
      toggleFullscreen();
    }
  };

  function metricsHeight() {
    return scroller.clientHeight || window.innerHeight;
  }

  function applyZoom(delta) {
    const next = Math.max(1, Math.min(2.2, Math.round(((prefs.zoom || 1) + delta) * 100) / 100));
    prefs = savePrefs({ zoom: next });
    flow.setPrefs(prefs);
    toast("缩放 " + Math.round(next * 100) + "%");
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      (document.documentElement.requestFullscreen || function () {}).call(document.documentElement).catch(() => {});
    } else if (document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    }
  }

  function onVisibility() {
    visible = !document.hidden;
    if (document.hidden) {
      reporter.flush(flow.currentPage());
      api.pauseTask(id).catch(() => {});
    } else {
      api.resumeTask(id).catch(() => {});
      startStatusPoll();
    }
  }

  function onPageHide() {
    reporter.flush(flow.currentPage());
  }

  scroller.addEventListener("click", onScrollerClick);
  document.addEventListener("keydown", keyHandler);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", onPageHide);

  // ---- data bootstrap ----
  //
  // Cache-first, event-driven. One status call paints the initial picture (a fully cached
  // chapter becomes visible immediately, in one pass). After that the cache task tells us
  // about each page the moment it is stored, so there is no poll interval to wait out --
  // and no request being sent every second while the reader sits open.
  function allSettled(pages) {
    return pages.length > 0 && pages.every((p) => p.state === "done" || p.state === "failed");
  }

  let taskAttempts = 0;
  let automaticRetryRounds = 0;
  const MAX_AUTOMATIC_RETRY_ROUNDS = 2;
  let unsubscribePages = null;
  let reconcileTimer = 0;

  // Nothing caches pages unless the task exists, so a failed creation would leave the
  // reader showing grey blocks forever. Retry a bounded number of times, and only while
  // the task is demonstrably not working.
  async function ensureTask(pages, taskState) {
    if (taskAttempts >= 3 || allSettled(pages)) return;
    const paused = taskState === "paused" || taskState === "pending";
    const working = pages.some((p) => p.state === "claimed" || p.state === "error");
    if (working && !paused) return;
    if (pages.some((p) => p.cached) && !paused && working) return;
    taskAttempts += 1;
    try {
      await api.createTask(id, title, albumAid, true);
    } catch (err) {
      if (taskAttempts >= 3 && !destroyed) {
        loadBar.style.opacity = "0";
        toast("页面缓存启动失败，请检查线路后重试");
        flow.loadVisible();
      }
    }
  }

  // A page was stored: flip just that page instead of refetching the whole chapter.
  function onPageStored(evt) {
    if (destroyed || String(evt.cid) !== id) return;
    const index = Number(evt.page) - 1;
    if (!(index >= 0)) return;
    if (evt.w && evt.h) flow.setSizes({ [String(index + 1)]: [evt.w, evt.h] });
    flow.setStatuses([{ index, page: Number(evt.page), state: "done", cached: true,
                        attempts: 0, w: evt.w || 0, h: evt.h || 0 }]);
    updateLoadBar();
    if (tipOpen) paintCacheTip();
  }

  async function refreshStatus() {
    try {
      const payload = await api.taskPages(id);
      if (destroyed) return;
      statusPages = payload.pages || [];
      flow.setStatuses(statusPages);
      // A task can survive a tab close in paused state. Cached pages are not proof
      // that the remaining pages are being downloaded; bring this chapter forward.
      if ((payload.state === "paused" || payload.state === "pending") && !allSettled(statusPages)) {
        api.createTask(id, title, albumAid, true).catch(() => {});
      }
      flow.loadVisible();
      updateLoadBar();
      if (tipOpen) paintCacheTip();
      if (allSettled(statusPages)) {
        const failed = statusPages.filter((page) => page.state === "failed").length;
        if (failed && automaticRetryRounds < MAX_AUTOMATIC_RETRY_ROUNDS) {
          automaticRetryRounds += 1;
          const result = await api.retryTaskPages(id);
          if (result && Number(result.rearmed) > 0) {
            statusPages = statusPages.map((page) => page.state === "failed"
              ? Object.assign({}, page, { state: "idle", attempts: 0, error: "", cached: false })
              : page);
            flow.setStatuses(statusPages);
            flow.loadVisible();
            updateLoadBar();
            if (tipOpen) paintCacheTip();
            scheduleReconcile();
            return;
          }
        }
        stopStatusPoll();
        return;
      }
      ensureTask(statusPages, payload.state);
      // The task advances on its own; a slow reconcile is only a safety net for a missed
      // event or a task that had to be restarted.
      scheduleReconcile();
    } catch (err) {
      scheduleReconcile();
    }
  }

  function scheduleReconcile() {
    if (destroyed || !visible || reconcileTimer) return;
    reconcileTimer = setTimeout(() => {
      reconcileTimer = 0;
      refreshStatus();
    }, RECONCILE_MS);
  }

  function startStatusPoll() {
    if (destroyed || !visible) return;
    if (!unsubscribePages) unsubscribePages = onEvent("pages", onPageStored);
    refreshStatus();
    scheduleReconcile();
  }

  function stopStatusPoll() {
    if (reconcileTimer) {
      clearTimeout(reconcileTimer);
      reconcileTimer = 0;
    }
    if (unsubscribePages) {
      unsubscribePages();
      unsubscribePages = null;
    }
  }

  function pollTask() {
    startStatusPoll();
  }

  async function loadNeighbors() {
    try {
      const payload = await api.neighbors(id, albumAid);
      neighbors.prev = payload.prev || null;
      neighbors.next = payload.next || null;
      prevBtn.disabled = !neighbors.prev;
      nextBtn.disabled = !neighbors.next;
      updateEndCard();
    } catch (err) {
      /* keep both buttons disabled */
    }
  }

  function updateEndCard() {
    const acts = endCard.querySelector(".acts");
    if (!acts) return;
    acts.innerHTML = "";
    if (neighbors.next) {
      acts.appendChild(el("button", {
        class: "btn primary",
        type: "button",
        text: "下一章：" + chapterLabel(neighbors.next, 0),
        onClick: () => goChapter(neighbors.next),
      }));
    }
    acts.appendChild(el("button", { class: "btn", type: "button", text: "章节列表", onClick: () => toggleDrawer(true) }));
    acts.appendChild(el("button", {
      class: "btn ghost",
      type: "button",
      text: "返回详情",
      onClick: () => { location.hash = "#/album/" + albumAid; },
    }));
  }

  async function loadSeries() {
    if (!albumAid) return;
    try {
      const album = await api.album(albumAid);
      series = (album.series || []).slice();
      if (series.length) renderSeries();
    } catch (err) {
      /* the drawer shows its empty state */
    }
  }

  async function startTask() {
    try {
      await api.createTask(id, title, albumAid, true);
      pollTask();
    } catch (err) {
      loadBar.style.opacity = "0";
    }
  }

  async function restorePosition() {
    try {
      const record = await api.progressGet(id);
      if (!record || !record.page || record.page < 2) return;
      if (record.page >= total) return;
      flow.scrollToPage(record.page);
      updateCounter(record.page);
      slider.value = String(record.page);
      scheduleHide();
      toast("已回到第 " + record.page + " 页");
    } catch (err) {
      /* a first read has no progress row */
    }
  }

  // ---- teardown ----
  function close() {
    if (destroyed) return;
    destroyed = true;
    reporter.flush(flow.currentPage());
    reporter.destroy();
    stopStatusPoll();
    if (hideTimer) clearTimeout(hideTimer);
    document.removeEventListener("keydown", keyHandler);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", onPageHide);
    scroller.removeEventListener("click", onScrollerClick);
    flow.destroy();
    api.pauseTask(id).catch(() => {});
    root.remove();
    document.body.style.overflow = "";
  }

  endCard.style.display = "none";
  setDim(prefs.dim);
  applyFitClass();
  flow.setTotal(total);
  requestAnimationFrame(() => flow.loadVisible());
  updateCounter(1);
  updateLoadBar();
  hint.classList.add("in");
  setTimeout(() => hint.classList.remove("in"), 2400);
  showChrome();

  loadNeighbors();
  loadSeries();
  startTask();
  restorePosition();

  return { close, root };
}

export default openReader;
