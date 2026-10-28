// Wire format for the server's progressive streams (/api/prog, /api/progcover).
//
// A stream is a run of frames, each with a fixed 25-byte header, so a consumer can walk
// it with a small buffer and never has to guess where the next frame starts.
//
//   magic "JMPG1"(5) | kind(8, NUL padded) | width(4 BE) | height(4 BE) | length(4 BE)
//
// Kinds: "pr" (JSON {r,t,p} download progress), "p1".."p3"/"pf" (JPEG frames, best last),
// "err" (payload is the reason).

const MAGIC = "JMPG2";
// magic(5) + asset(4) + kind(8) + width(4) + height(4) + length(4)
const HEADER = 5 + 4 + 8 + 4 + 4 + 4;

function readU32(buf, at) {
  return ((buf[at] << 24) | (buf[at + 1] << 16) | (buf[at + 2] << 8) | buf[at + 3]) >>> 0;
}

function readAscii(buf, start, length) {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    const byte = buf[start + i];
    if (byte === 0) break;
    out += String.fromCharCode(byte);
  }
  return out;
}

export function parseFrames(onFrame, onError) {
  let buffer = new Uint8Array(0);

  return function push(chunk) {
    if (chunk && chunk.length) {
      const merged = new Uint8Array(buffer.length + chunk.length);
      merged.set(buffer, 0);
      merged.set(chunk, buffer.length);
      buffer = merged;
    }

    for (;;) {
      if (buffer.length < HEADER) return;
      const magic = readAscii(buffer, 0, 5);
      if (magic !== MAGIC) {
        onError(new Error("bad frame magic: " + magic));
        buffer = new Uint8Array(0);
        return;
      }
      const asset = readU32(buffer, 5);
      const kind = readAscii(buffer, 9, 8);
      const width = readU32(buffer, 17);
      const height = readU32(buffer, 21);
      const size = readU32(buffer, 25);
      if (buffer.length < HEADER + size) return;

      const payload = buffer.slice(HEADER, HEADER + size);
      buffer = buffer.slice(HEADER + size);
      // `asset` is 0 for single-image streams; batched cover streams use the album id.
      onFrame({ asset, kind, width, height, payload });
    }
  };
}

/**
 * Read a progressive stream and hand every frame to the caller.
 * @returns {{cancel: () => void, done: Promise<void>}}
 */
export function streamFrames(url, handlers) {
  const opts = handlers || {};
  const controller = new AbortController();
  let cancelled = false;

  const done = (async () => {
    const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
    if (!response.ok) throw new Error("HTTP " + response.status);

    const total = Number(response.headers.get("Content-Length") || 0);
    let received = 0;
    let chain = Promise.resolve();

    const push = parseFrames((frame) => {
      if (frame.kind === "err") {
        const reason = (() => {
          try {
            return new TextDecoder().decode(frame.payload);
          } catch (err) {
            return "stream error";
          }
        })();
        if (typeof opts.onError === "function") opts.onError(new Error(reason));
        return;
      }
      if (frame.kind === "pr") {
        // The server's own view of the download, which is more accurate than bytes of
        // this response: the response wraps a slower upstream transfer.
        try {
          const info = JSON.parse(new TextDecoder().decode(frame.payload));
          if (typeof opts.onProgress === "function") opts.onProgress(info.p || 0, info.r, info.t);
        } catch (err) {
          /* a malformed progress frame is not worth failing the image over */
        }
        return;
      }
      // Paint strictly in order: the last frame to land is always the sharpest.
      chain = chain.then(() => {
        if (cancelled) return;
        return opts.onFrame ? opts.onFrame(frame) : undefined;
      });
    }, opts.onError);

    if (!response.body || !response.body.getReader) {
      push(new Uint8Array(await response.arrayBuffer()));
    } else {
      const reader = response.body.getReader();
      for (;;) {
        const step = await reader.read();
        if (step.done) break;
        if (cancelled) {
          reader.cancel().catch(() => {});
          break;
        }
        received += step.value.length;
        push(step.value);
        if (total && typeof opts.onProgress === "function") {
          opts.onProgress(Math.min(0.99, received / total), received, total);
        }
      }
    }

    await chain;
    if (typeof opts.onProgress === "function" && !cancelled) opts.onProgress(1, received, total);
    if (typeof opts.onDone === "function" && !cancelled) opts.onDone();
  })();

  return {
    done,
    cancel() {
      cancelled = true;
      controller.abort();
    },
  };
}

/**
 * Paint a progressive stream onto a canvas, keeping the sharpest frame so far.
 * Shared by the reader pages and by cover tiles.
 */
export function paintIntoCanvas(url, canvas, handlers) {
  const opts = handlers || {};
  let cancelled = false;

  const job = streamFrames(url, {
    onProgress: opts.onProgress,
    onError: opts.onError,
    onDone: opts.onDone,
    onFrame: (frame) => {
      const blob = new Blob([frame.payload], { type: "image/jpeg" });
      return createImageBitmap(blob).then((bitmap) => {
        if (cancelled) {
          bitmap.close();
          return;
        }
        // Size from the decoded bitmap when the header carries no geometry: a canvas
        // stuck at its 300x150 default would stretch every cover.
        const targetWidth = frame.width || bitmap.width;
        const targetHeight = frame.height || bitmap.height;
        // Grow to the largest frame seen; shrinking would force a re-decode of what is
        // already drawn.
        if (targetWidth > canvas.width || targetHeight > canvas.height) {
          canvas.width = targetWidth;
          canvas.height = targetHeight;
        }
        const ctx = canvas.getContext("2d");
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();
        // Same handler name as streamFrames, so a consumer reads one contract.
        if (typeof opts.onFrame === "function") {
          opts.onFrame(frame, { width: targetWidth, height: targetHeight });
        }
      }).catch((err) => {
        // One undecodable frame must not blank the page.
        if (typeof opts.onFrameError === "function") opts.onFrameError(err, frame);
      });
    },
  });

  return {
    done: job.done,
    cancel() {
      cancelled = true;
      job.cancel();
    },
  };
}