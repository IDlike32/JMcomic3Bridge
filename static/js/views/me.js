// Me: app identity, library stats, shortcuts, appearance and line control.
import { api, fmtBytes } from "../api.js";
import { el, icon, toast, segControl, listRow, statCard, loadingRow } from "../ui.js";
import { state, setTheme, saveSettings, refreshLines } from "../state.js";

const VERSION_FALLBACK = "1.0.0";

export async function renderMe(view) {
  view.appendChild(loadingRow("加载中…"));

  // Every block is independent: a dead cache query must not hide the theme switch.
  const [library, cache, tasks, health] = await Promise.all([
    api.library().catch(() => null),
    api.cache().catch(() => null),
    api.tasks().catch(() => null),
    // #/me can be the first screen (deep link), so the line panel cannot rely on bootstrap.
    refreshLines().then(() => null).catch(() => null),
    api.health().catch(() => null),
  ]);

  view.innerHTML = "";
  view.appendChild(appCard(health));
  view.appendChild(statsRow(library, cache, tasks));
  view.appendChild(shortcuts());
  view.appendChild(appearance());
  view.appendChild(linesPanel());
}

function appCard(health) {
  // Same source as the line panel below, so the header dot can never disagree with it.
  const lines = state.lines || [];

  const active = lines.filter((line) => line.active);
  const healthy = active.filter((line) => line.ok).length;
  const online = healthy > 0 || (!active.length && lines.some((line) => line.ok));

  return el("div", {
    class: "panel",
    style: "display:flex;align-items:center;gap:14px;margin-bottom:16px",
  }, [
    el("div", {
      style: "width:46px;height:46px;border-radius:13px;flex:none;display:grid;place-items:center;" +
        "font-size:21px;font-weight:700;color:#fff;background:linear-gradient(140deg,var(--accent),#8a3ffc)",
      text: "J",
    }),
    el("div", { class: "grow" }, [
      el("div", { style: "font-size:16px;font-weight:650", text: "JMBridge" }),
      el("div", { class: "muted tiny", text: "v" + ((health && health.version) || VERSION_FALLBACK) + " · 本地漫画桥" }),
    ]),
    el("div", { class: "row", style: "gap:6px" }, [
      el("span", {
        style: "width:8px;height:8px;border-radius:50%;display:inline-block;background:" +
          (online ? "var(--ok)" : "var(--bad)"),
      }),
      el("span", {
        class: "tiny muted",
        text: active.length ? healthy + "/" + active.length + " 线路正常" : online ? "线路正常" : "线路不可用",
      }),
    ]),
  ]);
}

function statsRow(library, cache, tasks) {
  const history = (library && library.stats && library.stats.progress) || 0;
  const favorites = (library && library.stats && library.stats.favorites) || 0;
  const bytes = (cache && cache.total_bytes) || 0;
  const running = (tasks && tasks.stats && tasks.stats.running) || 0;

  return el("div", { class: "stats", style: "margin-bottom:18px" }, [
    statCard(String(history), "历史"),
    statCard(String(favorites), "收藏"),
    statCard(fmtBytes(bytes), "缓存占用"),
    statCard(String(running), "运行中的任务"),
  ]);
}

function shortcuts() {
  return el("div", { class: "panel", style: "margin-bottom:16px;padding:6px 14px" }, [
    listRow({
      icon: "download",
      title: "下载任务",
      desc: "查看章节下载进度与队列",
      onClick: () => { location.hash = "#/tasks"; },
    }),
    listRow({
      icon: "archive",
      title: "缓存管理",
      desc: "浏览与清理本地缓存",
      onClick: () => { location.hash = "#/cache"; },
    }),
    listRow({
      icon: "settings",
      title: "阅读与网络设置",
      desc: "压缩率、线路与语言",
      onClick: () => { location.hash = "#/settings"; },
    }),
  ]);
}

function appearance() {
  const current = state.theme === "light" ? "light" : "dark";
  const seg = segControl({
    options: [
      { label: "深色", value: "dark" },
      { label: "浅色", value: "light" },
    ],
    value: current,
    onChange: (value) => {
      setTheme(value);
      toast(value === "light" ? "已切换到浅色主题" : "已切换到深色主题");
    },
  });

  return el("div", { class: "panel", style: "margin-bottom:16px" }, [
    el("div", { class: "row", style: "margin-bottom:0" }, [
      el("div", { class: "grow" }, [
        el("div", { style: "font-size:14px", text: "外观" }),
        el("div", { class: "muted tiny", text: "主题跟随本机保存，重启后保持" }),
      ]),
      seg,
    ]),
  ]);
}

function linesPanel() {
  const list = el("div", { class: "list" });

  const probeBtn = el("button", { class: "btn sm", type: "button" }, [icon("signal"), el("span", { text: "测速" })]);
  const discoverBtn = el("button", { class: "btn sm", type: "button" }, [icon("refresh"), el("span", { text: "重新发现" })]);

  probeBtn.addEventListener("click", async () => {
    probeBtn.disabled = true;
    toast("测速中…");
    try {
      await api.probeLines();
      await refreshLines();
      paint();
      toast("测速完成：" + healthySummary());
    } catch (err) {
      toast("测速失败：" + messageOf(err));
    } finally {
      probeBtn.disabled = false;
    }
  });

  discoverBtn.addEventListener("click", async () => {
    discoverBtn.disabled = true;
    toast("正在重新发现线路…");
    try {
      await api.discoverLines();
      await refreshLines();
      paint();
      toast("发现完成：" + healthySummary());
    } catch (err) {
      toast("发现失败：" + messageOf(err));
    } finally {
      discoverBtn.disabled = false;
    }
  });

  function healthySummary() {
    const active = (state.lines || []).filter((line) => line.active);
    const healthy = active.filter((line) => line.ok);
    if (!healthy.length) return active.length ? "线路暂不可用" : "尚未探测到可用线路";
    const fastest = healthy.reduce((best, line) => {
      const ms = Number(line.latency_ms) || Infinity;
      return ms < (Number(best.latency_ms) || Infinity) ? line : best;
    }, healthy[0]);
    const ms = Number(fastest.latency_ms) || 0;
    return healthy.length + " 条可用，最快 " + (ms ? Math.round(ms) + " ms" : "未知延迟");
  }

  function paint() {
    list.innerHTML = "";
    const lines = state.lines || [];
    if (!lines.length) {
      list.appendChild(el("div", { class: "muted tiny", style: "padding:12px 4px", text: "还没有探测到线路" }));
      return;
    }
    const pinned = state.settings.pinned_host || "";
    lines.forEach((line) => {
      const isPinned = pinned && pinned === line.host;
      const pinBtn = el("button", {
        class: "btn sm" + (isPinned ? " primary" : ""),
        type: "button",
        text: isPinned ? "已固定" : "固定",
      });
      pinBtn.addEventListener("click", async () => {
        pinBtn.disabled = true;
        try {
          await saveSettings({ pinned_host: isPinned ? "" : line.host });
          await refreshLines();
          paint();
          toast(isPinned ? "已恢复自动选线" : "已固定 " + (line.label || line.host));
        } catch (err) {
          toast("保存失败：" + messageOf(err));
        } finally {
          pinBtn.disabled = false;
        }
      });

      list.appendChild(el("div", {
        class: "list-row",
        style: "cursor:default;align-items:center",
      }, [
        el("div", { class: "grow" }, [
          el("div", { class: "row", style: "gap:6px" }, [
            el("span", {
              style: "width:7px;height:7px;border-radius:50%;display:inline-block;flex:none;background:" +
                (line.ok ? "var(--ok)" : "var(--bad)"),
            }),
            el("span", { style: "font-size:14px", text: line.label || "线路" }),
            el("span", { class: "muted tiny ellipsis", text: line.host || "" }),
          ]),
          el("div", { class: "desc", text: latencyText(line) }),
        ]),
        line.active ? el("span", { class: "chip plain tiny", text: "使用中" }) : null,
        pinBtn,
      ]));
    });
  }

  paint();

  return el("div", { class: "panel" }, [
    el("div", { class: "panel-head" }, [
      el("h2", { text: "线路" }),
      el("div", { class: "grow" }),
      probeBtn,
      discoverBtn,
    ]),
    el("div", { class: "muted tiny", style: "margin-bottom:8px", text: "固定后所有请求只走该线路，图片仍按负载分摊。" }),
    list,
  ]);
}

function latencyText(line) {
  if (!line.ok) return line.last_error ? "不可用 · " + line.last_error : "不可用";
  const ms = Number(line.latency_ms) || 0;
  const parts = [ms ? Math.round(ms) + " ms" : "延迟未知"];
  if (line.inflight) parts.push(line.inflight + " 个请求进行中");
  if (line.failures) parts.push(line.failures + " 次失败");
  return parts.join(" · ");
}

function messageOf(err) {
  return String((err && err.message) || err || "网络或线路出了点问题");
}