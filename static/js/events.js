// One event stream for the whole app.
//
// Every view used to poll for "is it ready yet": the reader every 1.2s, task lists on an
// interval, covers by re-requesting. All of that is the same question, and the server
// already knows the answer the moment it stores the bytes. So: one SSE connection, opened
// on demand, fanning events out to whoever cares.
import { api } from "./api.js";

const handlers = new Map();   // topic -> Set(fn)
let source = null;
let opened = 0;
let wanted = 0;
let retryTimer = 0;
// A page kept alive in the background still holds subscriptions but must not hold a
// connection: the browser only grants six per origin, and the stream never ends.
let suspended = false;

function ensureOpen() {
  if (suspended || source || !wanted) return;
  if (typeof EventSource !== "function") return;
  source = new EventSource(api.eventsUrl());
  source.onopen = () => { opened = 0; };
  source.onmessage = (evt) => {
    let payload;
    try {
      payload = JSON.parse(evt.data);
    } catch (err) {
      return;
    }
    const set = handlers.get(payload.topic || "*");
    if (set) set.forEach((fn) => { try { fn(payload); } catch (err) { /* one view must not break the rest */ } });
  };
  source.onerror = () => {
    // The browser reconnects by itself, but a dead server would spin: back off instead.
    if (source) { source.close(); source = null; }
    if (!wanted) return;
    opened += 1;
    const delay = Math.min(15000, 500 * Math.pow(2, Math.min(opened, 4)));
    clearTimeout(retryTimer);
    retryTimer = setTimeout(ensureOpen, delay);
  };
}

function closeIfIdle() {
  if (wanted > 0 || !source) return;
  source.close();
  source = null;
}

/** Subscribe to a topic ("pages", "covers", "task" or "*"). Returns an unsubscribe fn. */
export function onEvent(topic, fn) {
  if (!handlers.has(topic)) handlers.set(topic, new Set());
  handlers.get(topic).add(fn);
  wanted += 1;
  ensureOpen();
  let alive = true;
  return () => {
    if (!alive) return;
    alive = false;
    const set = handlers.get(topic);
    if (set) set.delete(fn);
    wanted = Math.max(0, wanted - 1);
    closeIfIdle();
  };
}

/** Close the stream while the page is not on screen; reopen it when it comes back. */
export function setSuspended(on) {
  const next = !!on;
  if (next === suspended) return;
  suspended = next;
  if (suspended) {
    clearTimeout(retryTimer);
    if (source) {
      source.close();
      source = null;
    }
    return;
  }
  opened = 0;
  if (wanted) ensureOpen();
}

export function resetEvents() {
  wanted = 0;
  opened = 0;
  handlers.clear();
  clearTimeout(retryTimer);
  if (source) { source.close(); source = null; }
}
