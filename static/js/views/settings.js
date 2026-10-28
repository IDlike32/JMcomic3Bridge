// Settings: line control, aggregation, cache limit and compression.
// Every write goes through the server and the panel is repainted from the
// server's answer, so a failed save can never leave a lie on screen.
import { api, fmtBytes } from "../api.js";
import {
  el, toast, pageHead, segControl, emptyState,
} from "../ui.js";
import { state, refreshSettings, refreshLines, saveSettings } from "../state.js";

const COMPRESSION_HINT = {
  none: "原图无损，占用最大",
  minimal: "轻微重编码，肉眼几乎无差",
  medium: "明显缩小体积，细节略降",
  max: "最省空间，画质下降明显",
};

const COMPRESSION_FALLBACK = ["none", "minimal", "medium", "max"];

const CACHE_LIMITS = [
  { label: "512MB", value: 512 },
  { label: "1GB", value: 1024 },
  { label: "2GB", value: 2048 },
  { label: "4GB", value: 4096 },
  { label: "8GB", value: 8192 },
];

const LANGS = [
  { label: "繁體", value: "TW" },
  { label: "简体", value: "CN" },
  { label: "EN", value: "EN" },
];

function panel(title, opts) {
  const options = opts || {};
  const head = el("div", { class: "panel-head" }, [
    el("h2", { class: "grow", text: title }),
    options.actions || null,
  ]);
  const body = el("div", {});
  const node = el("div", { class: "panel" }, [head, body]);
  return { node, body, head };
}

function fieldRow(label, control, hint) {
  return el("div", { style: "margin-bottom:14px" }, [
    el("div", { class: "row wrap", style: "gap:10px;margin-bottom:6px" }, [
      el("span", { class: "tiny dim", text: label }),
      control,
    ]),
    hint ? el("div", { class: "muted tiny", text: hint }) : null,
  ]);
}

function latencyText(line) {
  if (line.latency_ms === null || line.latency_ms === undefined) return "-";
  return Math.round(line.latency_ms) + " ms";
}

export async function renderSettings(view, ctx) {
  view.appendChild(pageHead("设置", { back: () => history.back() }));

  const linesHost = el("div", {});
  const aggHost = el("div", {});
  const cacheHost = el("div", {});
  const zipHost = el("div", {});
  const langHost = el("div", {});

  const linesPanel = panel("线路", { actions: el("div", { class: "row", style: "gap:8px" }, [
    el("button", { class: "btn sm", type: "button", text: "测速", onClick: probe }),
    el("button", { class: "btn sm ghost", type: "button", text: "重新发现", onClick: discover }),
  ]) });
  linesPanel.body.appendChild(linesHost);

  const aggPanel = panel("聚合");
  aggPanel.body.appendChild(aggHost);

  const cachePanel = panel("缓存上限");
  cachePanel.body.appendChild(cacheHost);

  const zipPanel = panel("漫画压缩");
  zipPanel.body.appendChild(zipHost);

  const langPanel = panel("接口语言");
  langPanel.body.appendChild(langHost);

  view.appendChild(linesPanel.node);
  view.appendChild(aggPanel.node);
  view.appendChild(cachePanel.node);
  view.appendChild(zipPanel.node);
  view.appendChild(langPanel.node);

  await Promise.all([
    refreshSettings().catch(() => {}),
    refreshLines().catch(() => {}),
  ]);
  paintAll();

  async function probe() {
    toast("正在测速…", 4000);
    try {
      await api.probeLines();
      await refreshLines();
      paintLines();
      toast("测速完成");
    } catch (err) {
      toast("测速失败：" + (err && err.message ? err.message : "网络异常"));
    }
  }

  async function discover() {
    toast("正在重新发现线路…", 6000);
    try {
      await api.discoverLines();
      await refreshLines();
      paintLines();
      toast("线路已更新");
    } catch (err) {
      toast("发现失败：" + (err && err.message ? err.message : "网络异常"));
    }
  }

  // Any failed write throws out of here; the caller reloads from the server so
  // the control snaps back to the value that is actually stored.
  async function commit(patch, okText) {
    try {
      await saveSettings(patch);
      await refreshSettings().catch(() => {});
      await refreshLines().catch(() => {});
      paintAll();
      toast(okText);
      return true;
    } catch (err) {
      await refreshSettings().catch(() => {});
      paintAll();
      toast("保存失败：" + (err && err.message ? err.message : "网络异常"));
      return false;
    }
  }

  function paintLines() {
    linesHost.innerHTML = "";
    const lines = state.lines || [];
    if (!lines.length) {
      linesHost.appendChild(emptyState({
        icon: "signal",
        title: "还没有可用线路",
        text: "点「重新发现」让程序自动探测镜像站",
        actionLabel: "重新发现",
        onAction: discover,
      }));
      return;
    }

    const pinned = (state.settings && state.settings.pinned_host) || "";
    const table = el("table", {}, [
      el("thead", {}, [el("tr", {}, [
        el("th", { text: "线路" }),
        el("th", { text: "延迟" }),
        el("th", { text: "状态" }),
        el("th", { text: "图片主机" }),
        el("th", { text: "操作" }),
      ])]),
    ]);
    const tbody = el("tbody", {});
    lines.forEach((line) => {
      const isPinned = pinned === line.host;
      const pinBtn = el("button", {
        class: "btn sm" + (isPinned ? " primary" : ""),
        type: "button",
        text: isPinned ? "已固定" : "固定",
        onClick: () => commit(
          { pinned_host: isPinned ? "" : line.host },
          isPinned ? "已恢复自动聚合" : "已固定 " + line.host
        ),
      });
      tbody.appendChild(el("tr", {}, [
        el("td", {}, [
          el("div", { text: line.label || "线路" }),
          el("div", { class: "muted tiny", style: "font-family:var(--mono)", text: line.host }),
        ]),
        el("td", { class: "num", text: latencyText(line) }),
        el("td", {}, [
          el("span", { class: "row", style: "gap:6px" }, [
            el("span", { class: "dot", style: "width:7px;height:7px;border-radius:50%;background:" + (line.ok ? "var(--ok)" : "var(--surface-3)") }),
            el("span", { class: "muted tiny", text: line.ok ? "正常" : (line.active ? "不可用" : "未启用") }),
          ]),
        ]),
        el("td", { class: "muted tiny ellipsis", style: "max-width:220px", text: line.img_host || "-" }),
        el("td", {}, [pinBtn]),
      ]));
    });
    table.appendChild(tbody);
    linesHost.appendChild(table);

    const activeCount = (state.activeLines || []).length;
    linesHost.appendChild(el("div", { class: "muted tiny", style: "margin-top:10px", text:
      "接口请求自动选最快线路并故障转移；图片按负载分摊。当前启用 " + activeCount + " 条，固定线路会优先使用。" }));
  }

  function paintAgg() {
    aggHost.innerHTML = "";
    const value = Number((state.settings && state.settings.active_lines) || 3);
    aggHost.appendChild(fieldRow(
      "聚合线路条数",
      segControl({
        options: [1, 2, 3].map((n) => ({ label: n + " 条", value: n })),
        value: value,
        onChange: (next) => commit({ active_lines: Number(next) }, "已切换为 " + next + " 条聚合"),
      }),
      "同时使用的线路越多，速度越快，也越容易被限流"
    ));
  }

  function paintCache() {
    cacheHost.innerHTML = "";
    const current = Number((state.settings && state.settings.cache_limit_mb) || 2048);
    // A limit set from an older build may not be one of the presets; keep it
    // visible as its own option instead of showing nothing selected.
    const options = CACHE_LIMITS.slice();
    if (!options.some((item) => item.value === current)) {
      options.push({ label: current + "MB", value: current });
    }
    cacheHost.appendChild(fieldRow(
      "总容量上限",
      segControl({
        options,
        value: current,
        onChange: (next) => commit({ cache_limit_mb: Number(next) }, "上限已设为 " + fmtBytes(Number(next) * 1024 * 1024)),
      }),
      "超出上限时按最久未使用自动淘汰"
    ));
    cacheHost.appendChild(el("div", { class: "muted tiny", text: "当前 " + fmtBytes(current * 1024 * 1024) }));
  }

  function paintCompression() {
    zipHost.innerHTML = "";
    const modes = state.compressionModes || {};
    const keys = Object.keys(modes).length ? Object.keys(modes) : COMPRESSION_FALLBACK;
    const current = (state.settings && state.settings.cache_compression) || "medium";
    const controls = segControl({
      options: keys.map((key) => ({
        label: (modes[key] && modes[key].label) || key,
        value: key,
      })),
      value: keys.indexOf(current) >= 0 ? current : keys[0],
      onChange: (next) => commit({ cache_compression: next }, "压缩档位已切换"),
    });
    zipHost.appendChild(fieldRow(
      "漫画页压缩",
      controls,
      COMPRESSION_HINT[current] || "仅影响新写入的缓存"
    ));
    zipHost.appendChild(el("div", { class: "muted tiny", text: "当前档位只对之后下载或缓存的页面生效，已有缓存保持原样。" }));
  }

  function paintLang() {
    langHost.innerHTML = "";
    const current = (state.settings && state.settings.lang) || "TW";
    langHost.appendChild(fieldRow(
      "接口语言",
      segControl({
        options: LANGS,
        value: current,
        onChange: (next) => commit({ lang: next }, "语言已切换"),
      }),
      "影响标题与简介的返回语言，需要重新请求才会更新"
    ));
  }

  function paintAll() {
    paintLines();
    paintAgg();
    paintCache();
    paintCompression();
    paintLang();
  }
}
