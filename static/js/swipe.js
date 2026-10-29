// Horizontal swipe for the tab strip.
//
// The page inside a frame owns its own touch stream, so a gesture has to be
// detected there and forwarded to the shell, which owns navigation and the
// filmstrip of frames. Three messages exist:
//
//   swipe-move { dx }              the pointer is moving sideways; drag the frame
//   swipe      { dir }             released past the threshold; navigate
//   swipe-move { dx: 0, cancel }   released short; spring the frame back
//
// A vertical drag, a horizontal scroller, an open sheet, or the reader never
// claims the gesture: dragging a cover rail must keep scrolling the rail.
const EXCLUDE = ".rail, .strip, .seg, .chips, .tabbar, .sidebar, .reader, " +
  ".sheet, .backdrop, .detail-panel, input, textarea, select, [data-no-swipe]";

const START_DX = 14;    // movement before the gesture is claimed
const MIN_DX = 56;      // release threshold
const SLOPE = 1.3;      // horizontal must beat vertical by this factor
const MAX_MS = 900;
const COOLDOWN = 420;

function isBlocked(target, extra) {
  if (typeof extra === "function" && extra()) return true;
  return !!(target && target.closest && target.closest(EXCLUDE));
}

/**
 * Wire the tab swipe gesture.
 * @param {{ send: (msg: object) => void, blocked?: () => boolean }} options
 * @returns {() => void} uninstall
 */
export function installTabSwipe(options) {
  const opts = options || {};
  const send = opts.send;
  if (typeof send !== "function") return function noop() {};

  let start = null;
  let claimed = false;
  let lastFire = 0;
  let moveFrame = 0;
  let moveDx = 0;

  function flushMove() {
    moveFrame = 0;
    if (claimed) send({ type: "swipe-move", dx: moveDx });
  }

  function reset() {
    start = null;
    claimed = false;
    moveDx = 0;
  }

  function onStart(evt) {
    if (!evt.touches || evt.touches.length !== 1) {
      reset();
      return;
    }
    if (isBlocked(evt.target, opts.blocked)) {
      reset();
      return;
    }
    const touch = evt.touches[0];
    start = { x: touch.clientX, y: touch.clientY, t: Date.now() };
    claimed = false;
  }

  function onMove(evt) {
    if (!start || !evt.touches || evt.touches.length !== 1) return;
    const touch = evt.touches[0];
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (!claimed) {
      if (Math.abs(dx) < START_DX) return;
      // The page scrolls down; only a clearly sideways drag belongs to navigation.
      if (Math.abs(dx) < Math.abs(dy) * SLOPE) {
        reset();
        return;
      }
      claimed = true;
    }
    moveDx = dx;
    if (!moveFrame) moveFrame = requestAnimationFrame(flushMove);
  }

  function cancelMove() {
    if (moveFrame) cancelAnimationFrame(moveFrame);
    moveFrame = 0;
    moveDx = 0;
  }

  function onEnd(evt) {
    if (!start) return;
    const touch = (evt.changedTouches && evt.changedTouches[0]) || start;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    const dt = Date.now() - start.t;
    const wasClaimed = claimed;
    cancelMove();
    reset();
    if (!wasClaimed) return;
    if (dt <= MAX_MS && Math.abs(dx) >= MIN_DX && Math.abs(dx) >= Math.abs(dy) * SLOPE) {
      const now = Date.now();
      if (now - lastFire >= COOLDOWN) {
        lastFire = now;
        send({ type: "swipe", dir: dx < 0 ? "next" : "prev" });
        return;
      }
    }
    send({ type: "swipe-move", dx: 0, cancel: true });
  }

  document.addEventListener("touchstart", onStart, { passive: true });
  document.addEventListener("touchmove", onMove, { passive: true });
  document.addEventListener("touchend", onEnd, { passive: true });
  document.addEventListener("touchcancel", reset, { passive: true });

  return function uninstall() {
    document.removeEventListener("touchstart", onStart);
    document.removeEventListener("touchmove", onMove);
    document.removeEventListener("touchend", onEnd);
    document.removeEventListener("touchcancel", reset);
    cancelMove();
  };
}
