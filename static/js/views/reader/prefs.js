// Reader preferences. Module-local cache + localStorage so a scroll tick never
// touches storage.

const KEY = "jmbridge.reader.prefs";

export const DEFAULT_PREFS = {
  fit: "width",        // width | height | original
  gap: 4,              // px between pages
  zoom: 1,             // 1 .. 2.2
  dim: 0,              // 0 .. 0.7 black overlay (brightness)
  hideDelay: 3000,     // ms before the chrome fades; 0 = never
  prefetch: 4,         // pages kept ready around the viewport
  showCounter: true,   // page counter in the header
};

let cache = null;

export function loadPrefs() {
  if (cache) return cache;
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) || "{}") || {};
  } catch (err) {
    saved = {};
  }
  cache = Object.assign({}, DEFAULT_PREFS);
  Object.keys(DEFAULT_PREFS).forEach((key) => {
    if (saved[key] === undefined) return;
    if (typeof DEFAULT_PREFS[key] === "number" && typeof saved[key] !== "number") return;
    cache[key] = saved[key];
  });
  return cache;
}

export function savePrefs(patch) {
  const next = Object.assign(loadPrefs(), patch || {});
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch (err) {
    /* storage unavailable: the in-memory copy still drives the UI */
  }
  return next;
}
