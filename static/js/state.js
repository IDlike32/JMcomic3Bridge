// Shared app state. Views read from here, never from localStorage directly.
import { api } from "./api.js";

const THEME_KEY = "jmbridge.theme";

export const state = {
  settings: {},
  compressionModes: {},
  lines: [],
  activeLines: [],
  theme: "dark",
  // Library mirrors, refreshed by loadLibrary(); the Sets make tile lookups O(1).
  progress: [],
  favorites: [],
  favoriteIds: new Set(),
  progressByCid: new Map(),
};

export function setTheme(theme, notifyParent = true) {
  state.theme = theme === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", state.theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", state.theme === "light" ? "#edf4f1" : "#0b1012");
  try {
    localStorage.setItem(THEME_KEY, state.theme);
  } catch (err) {
    /* private mode: keep it in memory only */
  }
  window.dispatchEvent(new CustomEvent("themechange", { detail: state.theme }));
  // Inside a shell frame the sidebar/tabbar belong to another document; tell it.
  try {
    if (notifyParent && window.parent && window.parent !== window) {
      window.parent.postMessage({ type: "theme", theme: state.theme }, location.origin);
    }
  } catch (err) {
    /* detached frame */
  }
}

export function toggleTheme() {
  setTheme(state.theme === "dark" ? "light" : "dark");
  return state.theme;
}

export function restoreTheme(notifyParent = true) {
  let saved = "";
  try {
    saved = localStorage.getItem(THEME_KEY) || "";
  } catch (err) {
    saved = "";
  }
  setTheme(saved || "dark", notifyParent);
}

export async function refreshSettings() {
  const payload = await api.settings();
  state.settings = payload.settings || {};
  state.compressionModes = payload.compression_modes || {};
  return state.settings;
}

export async function saveSettings(patch) {
  const updated = await api.saveSettings(patch);
  state.settings = updated || state.settings;
  return state.settings;
}

export async function refreshLines() {
  const payload = await api.lines();
  state.lines = payload.lines || [];
  state.activeLines = payload.active || [];
  return payload;
}

export async function loadLibrary() {
  const payload = await api.library();
  state.progress = payload.progress || [];
  state.favorites = payload.favorites || [];
  state.favoriteIds = new Set(state.favorites.map((row) => String(row.aid)));
  state.progressByCid = new Map(state.progress.map((row) => [String(row.cid), row]));
  return payload;
}

export function isFavorite(aid) {
  return state.favoriteIds.has(String(aid));
}

export async function toggleFavorite(item) {
  const aid = String(item.aid || item.id || "");
  if (!aid) return false;
  const wasFavorite = isFavorite(aid);
  if (wasFavorite) {
    await api.favoriteRemove(aid);
    state.favoriteIds.delete(aid);
    state.favorites = state.favorites.filter((row) => String(row.aid) !== aid);
  } else {
    const record = await api.favoriteAdd({
      aid,
      title: item.title || item.name || "",
      author: Array.isArray(item.author) ? item.author.join(" / ") : item.author || "",
    });
    state.favoriteIds.add(aid);
    state.favorites = [record].concat(state.favorites);
  }
  return !wasFavorite;
}

export function progressFor(cid) {
  return state.progressByCid.get(String(cid)) || null;
}

// The most recent chapter per album, for "continue reading" on the home screen.
export function continueReading(limit) {
  const seen = new Set();
  const out = [];
  state.progress.forEach((row) => {
    const key = String(row.aid || row.cid);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(row);
  });
  return out.slice(0, limit || 12);
}

export async function bootstrap() {
  restoreTheme();
  const tasks = [
    refreshSettings().catch(() => {}),
    refreshLines().catch(() => {}),
    loadLibrary().catch(() => {}),
  ];
  await Promise.all(tasks);
}
