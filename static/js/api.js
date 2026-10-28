// Network layer only: no DOM, no app state. Everything returns plain JSON.

// Bump when a rendering fix must invalidate images the browser already holds.
export const ASSET_VERSION = "5";

async function jsonFetch(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error("HTTP " + res.status + " " + text.slice(0, 160));
  }
  const body = await res.json();
  return body.data !== undefined ? body.data : body;
}

function postJson(path, payload) {
  return jsonFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
}

export function qs(params) {
  const usp = new URLSearchParams();
  Object.keys(params || {}).forEach((key) => {
    const val = params[key];
    if (val === undefined || val === null || val === "") return;
    usp.set(key, String(val));
  });
  const text = usp.toString();
  return text ? "?" + text : "";
}

export const api = {
  // ---- meta ----
  health: () => jsonFetch("/api/health"),
  lines: () => jsonFetch("/api/lines"),
  discoverLines: () => jsonFetch("/api/lines/discover", { method: "POST" }),
  probeLines: () => jsonFetch("/api/lines/probe", { method: "POST" }),
  settings: () => jsonFetch("/api/settings"),
  saveSettings: (patch) => postJson("/api/settings", patch),

  // ---- discovery ----
  home: () => jsonFetch("/api/home"),
  latest: (page) => jsonFetch("/api/latest" + qs({ page: page || 1 })),
  serialization: (page, type, date) =>
    jsonFetch("/api/serialization" + qs({ page: page || 1, type, date: date === undefined ? 0 : date })),
  categories: () => jsonFetch("/api/categories"),
  browse: (c, o, page) => jsonFetch("/api/browse" + qs({ c, o, page: page || 1 })),
  week: (id, type) => jsonFetch("/api/week" + qs({ id, type })),
  hotTags: () => jsonFetch("/api/hot_tags"),
  random: () => jsonFetch("/api/random"),
  promoteList: (id, page) => jsonFetch("/api/promote/list" + qs({ id, page: page || 1 })),

  // ---- search ----
  search: (q, page, o) => jsonFetch("/api/search" + qs({ q, page: page || 1, o: o || "mr" })),
  searchFull: (q, o, maxPages) =>
    jsonFetch("/api/search/full" + qs({ q, o: o || "mr", max_pages: maxPages || 0 })),
  searchStreamUrl: (q, o) => "/api/search/stream" + qs({ q, o: o || "mr" }),

  // ---- album / chapter ----
  album: (aid) => jsonFetch("/api/album/" + encodeURIComponent(aid)),
  albumProgress: (aid) => jsonFetch("/api/album/" + encodeURIComponent(aid) + "/progress"),
  read: (cid) => jsonFetch("/api/read/" + encodeURIComponent(cid)),
  neighbors: (cid, aid) =>
    jsonFetch("/api/chapter/" + encodeURIComponent(cid) + "/neighbors" + qs({ aid })),

  // ---- library ----
  progressList: (limit) => jsonFetch("/api/progress" + qs({ limit: limit || 200 })),
  progressGet: (cid) => jsonFetch("/api/progress/" + encodeURIComponent(cid)),
  progressSet: (payload) => postJson("/api/progress", payload),
  progressDelete: (cid) =>
    jsonFetch("/api/progress/" + encodeURIComponent(cid), { method: "DELETE" }),
  progressDeleteSeries: (aid) =>
    jsonFetch("/api/progress/series/" + encodeURIComponent(aid), { method: "DELETE" }),
  favorites: () => jsonFetch("/api/favorites"),
  favoriteAdd: (payload) => postJson("/api/favorites", payload),
  favoriteRemove: (aid) =>
    jsonFetch("/api/favorites/" + encodeURIComponent(aid), { method: "DELETE" }),
  library: () => jsonFetch("/api/library"),

  // ---- download tasks ----
  tasks: () => jsonFetch("/api/tasks"),
  task: (cid) => jsonFetch("/api/tasks/" + encodeURIComponent(cid)),
  taskPages: (cid, mode) =>
    jsonFetch("/api/tasks/" + encodeURIComponent(cid) + "/pages" + qs({ mode })),
  // One stream for everything that used to be polled.
  eventsUrl: () => "/api/events",
  // Covers: which are stored (one call per grid), and queueing the rest.
  coversStatus: (aids, size) =>
    jsonFetch("/api/covers/status" + qs({ aids: (aids || []).join(","), size: size || 360 })),
  coversWant: (aids, size) =>
    postJson("/api/covers/want", { aids: aids || [], size: size || 360 }),
  // Queue every known cover for background caching; the UI still decides when to display it.
  coversWarm: (aids, size) =>
    postJson("/api/covers/warm", { aids: aids || [], size: size || 360 }),
  createTask: (cid, title, aid, foreground) =>
    postJson("/api/tasks", {
      cid,
      title: title || "",
      aid: aid || "",
      foreground: foreground !== false,
    }),
  retryTaskPages: (cid) =>
    jsonFetch("/api/tasks/" + encodeURIComponent(cid) + "/retry", { method: "POST" }),
  coversRetry: (aids, size) =>
    postJson("/api/covers/retry", { aids: aids || [], size: size || 360 }),
  focusTask: (cid, page) =>
    postJson("/api/tasks/" + encodeURIComponent(cid) + "/focus", { page }),
  pauseTask: (cid) => jsonFetch("/api/tasks/" + encodeURIComponent(cid) + "/pause", { method: "POST" }),
  resumeTask: (cid) => jsonFetch("/api/tasks/" + encodeURIComponent(cid) + "/resume", { method: "POST" }),
  cancelTask: (cid) => jsonFetch("/api/tasks/" + encodeURIComponent(cid) + "/cancel", { method: "POST" }),
  deleteTask: (cid) => jsonFetch("/api/tasks/" + encodeURIComponent(cid), { method: "DELETE" }),
  coverTaskPriority: (id, priority) =>
    postJson("/api/tasks/cover/" + encodeURIComponent(id) + "/priority", { priority }),
  tasksStreamUrl: () => "/api/tasks/stream",

  // ---- cache / storage ----
  cache: () => jsonFetch("/api/cache"),
  cacheList: (kind, limit, offset) =>
    jsonFetch("/api/cache/" + kind + qs({ limit: limit || 100, offset: offset || 0 })),
  cacheClear: (kind) => jsonFetch("/api/cache/" + kind, { method: "DELETE" }),
  cacheDeleteItem: (kind, key) =>
    jsonFetch("/api/cache/item" + qs({ kind, key }), { method: "DELETE" }),
  cacheDropPages: (cid) =>
    jsonFetch("/api/cache/pages/" + encodeURIComponent(cid), { method: "DELETE" }),
  cacheEvict: () => jsonFetch("/api/cache/evict", { method: "POST" }),
  cachePack: (cid, mode) =>
    jsonFetch("/api/cache/pack/" + encodeURIComponent(cid) + qs({ mode }), { method: "POST" }),

  // ---- media ----
  // Finished cover file (hero background, plain <img> uses).
  coverUrl: (aid, size) =>
    aid ? "/api/cover/" + encodeURIComponent(aid) + qs({ size: size || 360 }) : "",
  // Cache-first cover: 200 when stored, 503 (queued) otherwise. The tile retries.
  progCoverUrl: (aid, size) =>
    aid ? "/api/progcover/" + encodeURIComponent(aid) + qs({ size: size || 360, v: ASSET_VERSION }) : "",
  // The version parameter is what actually busts an already-cached image: response
  // headers alone cannot evict bytes the browser stored earlier.
  pageUrl: (cid, index, aid, scramble, mode) =>
    "/api/image/" + encodeURIComponent(cid) + "/" + index +
    qs({ aid, scramble: scramble == null ? "" : scramble, mode, v: ASSET_VERSION }),
  // Progressive page stream: frames arrive smallest-first for canvas painting.
  progUrl: (cid, index, aid, scramble, mode) =>
    "/api/prog/" + encodeURIComponent(cid) + "/" + index +
    qs({ aid, scramble: scramble == null ? "" : scramble, mode }),
  thumbUrl: (cid, index, aid, scramble, size) =>
    "/api/image/" + encodeURIComponent(cid) + "/" + index +
    qs({
      aid,
      scramble: scramble == null ? "" : scramble,
      thumb: size || 320,
      v: ASSET_VERSION,
    }),
  downloadUrl: (cid, title) =>
    "/api/download/" + encodeURIComponent(cid) + qs({ title: title || "" }),
};

// ---- formatting helpers (pure) ----
export function fmtBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Number(bytes);
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return value.toFixed(idx === 0 ? 0 : 1) + " " + units[idx];
}

export function fmtNum(value) {
  const n = Number(value) || 0;
  if (n >= 100000000) return (n / 100000000).toFixed(1) + "亿";
  if (n >= 10000) return (n / 10000).toFixed(1) + "万";
  return String(n);
}

export function fmtAgo(seconds) {
  const then = Number(seconds) || 0;
  if (!then) return "";
  const diff = Math.max(0, Date.now() / 1000 - then);
  if (diff < 60) return "刚刚";
  if (diff < 3600) return Math.floor(diff / 60) + " 分钟前";
  if (diff < 86400) return Math.floor(diff / 3600) + " 小时前";
  if (diff < 86400 * 30) return Math.floor(diff / 86400) + " 天前";
  const date = new Date(then * 1000);
  return date.getMonth() + 1 + "月" + date.getDate() + "日";
}

export function itemTitle(item) {
  if (!item) return "";
  return item.name || item.title || item.album || String(item.id || item.aid || "");
}

export function itemCoverId(item) {
  if (!item) return "";
  return String(item.id || item.aid || "");
}

export function itemAuthor(item) {
  if (!item) return "";
  if (Array.isArray(item.author)) return item.author.join(" / ");
  return item.author || "";
}

export function itemCategory(item) {
  if (!item || !item.category) return "";
  const main = item.category.title || "";
  const sub = item.category_sub && item.category_sub.title ? item.category_sub.title : "";
  return sub ? main + " · " + sub : main;
}
