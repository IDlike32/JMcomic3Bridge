// Download page: opened in its own tab by the album's ZIP button. The archive takes
// minutes to fetch, so this page starts a packing job, shows progress, and hands off
// the finished file to the browser when ready.
import { api, fmtBytes } from "./api.js";
import { el } from "./ui.js";

const params = new URLSearchParams(location.search);
const cid = String(params.get("cid") || "").trim();
const title = String(params.get("title") || "");
const page = document.getElementById("page");

const POLL_MS = 700;
let jobId = "";
let timer = 0;
let savedOnce = false;
let lastState = "";

const spinner = el("div", { class: "dl-spinner" });
const mark = el("div", { class: "dl-mark" }, [spinner]);
const titleEl = el("div", { class: "dl-title", text: title || "打包下载" });
const sub = el("div", { class: "dl-sub", text: "正在准备…" });
const barFill = el("i", { style: "width:0%" });
const bar = el("div", { class: "bar" }, [barFill]);
const countEl = el("span", { text: "" });
const sizeEl = el("span", { class: "hidden" });
const stats = el("div", { class: "dl-stats" }, [countEl, sizeEl]);
const error = el("div", { class: "dl-error hidden" });
const actions = el("div", { class: "dl-actions" });
const hint = el("div", { class: "dl-hint", text: "" });

page.appendChild(el("section", { class: "dl-card" }, [
  el("div", { class: "dl-head" }, [mark, el("div", { class: "grow" }, [titleEl, sub])]),
  bar, stats, error, actions, hint,
]));

function messageOf(err) {
  return (err && err.message) || String(err || "网络异常");
}

function stopPolling() {
  if (timer) clearTimeout(timer);
  timer = 0;
}

function saveFile(job) {
  const a = document.createElement("a");
  a.href = api.zipFileUrl(jobId);
  a.download = job.filename || "comic.zip";
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function paint(job) {
  const state = job.state || "queued";
  const total = Number(job.total) || 0;
  const done = Number(job.done) || 0;
  const pct = state === "done" ? 100 : Math.min(100, Math.round((Number(job.progress) || 0) * 100));

  mark.className = "dl-mark" + (state === "done" ? " ok" : state === "failed" ? " bad" : "");
  spinner.classList.toggle("hidden", state === "done" || state === "failed");

  if (state === "queued") sub.textContent = "正在准备…";
  else if (state === "downloading") sub.textContent = "正在下载页面 " + done + " / " + total;
  else if (state === "packing") sub.textContent = "正在打包压缩…";
  else if (state === "done") sub.textContent = job.filename || "打包完成";
  else if (state === "failed") sub.textContent = "打包失败";

  bar.className = "bar" + (state === "done" ? " ok" : state === "failed" ? " bad" : "");
  barFill.style.width = pct + "%";

  if (total > 0 && state !== "failed") {
    countEl.textContent = done + " / " + total + " 页";
    countEl.classList.remove("hidden");
  } else {
    countEl.classList.add("hidden");
  }

  if (state === "done" && job.bytes) {
    sizeEl.textContent = fmtBytes(job.bytes);
    sizeEl.classList.remove("hidden");
  } else {
    sizeEl.classList.add("hidden");
  }

  if (state === "failed" && job.error) {
    error.textContent = job.error;
    error.classList.remove("hidden");
  } else {
    error.classList.add("hidden");
  }

  if (state !== lastState) {
    actions.textContent = "";
    if (state === "done") {
      const save = el("a", {
        class: "btn primary",
        href: api.zipFileUrl(jobId),
        download: job.filename || "comic.zip",
        text: "下载 ZIP" + (job.bytes ? " (" + fmtBytes(job.bytes) + ")" : ""),
      });
      save.addEventListener("click", () => { savedOnce = true; });
      const close = el("button", { class: "btn ghost", type: "button", text: "关闭页面" });
      close.addEventListener("click", () => window.close());
      actions.append(save, close);
      hint.textContent = "打包已完成，点击“下载 ZIP”保存到浏览器。";
    } else if (state === "failed") {
      const retry = el("button", { class: "btn primary", type: "button", text: "重试" });
      retry.addEventListener("click", start);
      const close = el("button", { class: "btn ghost", type: "button", text: "关闭页面" });
      close.addEventListener("click", () => window.close());
      actions.append(retry, close);
      hint.textContent = "";
    } else {
      const close = el("button", { class: "btn ghost", type: "button", text: "关闭页面" });
      close.addEventListener("click", () => window.close());
      actions.appendChild(close);
      hint.textContent = "可以离开这个页面去做别的，但别关掉它。";
    }
    lastState = state;
  }
}

async function start() {
  stopPolling();
  savedOnce = false;
  lastState = "";
  paint({ state: "queued", done: 0, total: 0, progress: 0 });
  try {
    const job = await api.zipJobStart(cid, title);
    jobId = job.id;
    paint(job);
    poll();
  } catch (err) {
    paint({ state: "failed", error: messageOf(err) });
  }
}

async function poll() {
  timer = setTimeout(async () => {
    try {
      const job = await api.zipJob(jobId);
      paint(job);
      if (job.state === "done" || job.state === "failed") return;
    } catch (err) {
      paint({ state: "failed", error: messageOf(err) });
      return;
    }
    poll();
  }, POLL_MS);
}

if (!cid) {
  paint({ state: "failed", error: "缺少作品编号" });
} else {
  start();
}
