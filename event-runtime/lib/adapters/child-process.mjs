import { createWriteStream } from "node:fs";
import { Writable } from "node:stream";
import { transcriptMaxBytes } from "../config.mjs";

/** Spawn options that make a child its own process group on POSIX hosts. */
export const DETACHED_SPAWN_OPTIONS = Object.freeze({ detached: true });

/**
 * A writable transcript sink that caps stored bytes without backpressuring a
 * child after the cap is reached. The appended marker is its own NDJSON line,
 * even when the capped source chunk did not end with a newline.
 */
export function boundedTranscriptStream(
  filePath,
  {
    maxBytes = transcriptMaxBytes(),
    onTruncated,
    createDestination = createWriteStream,
  } = {},
) {
  const limit =
    Number.isSafeInteger(maxBytes) && maxBytes >= 0
      ? maxBytes
      : transcriptMaxBytes();
  const destination = createDestination(filePath);
  let destinationFailed = false;
  destination.on("error", () => {
    // Capture is best-effort. In particular, ENOSPC must not leave a pending
    // write waiting forever for a drain event that can no longer happen.
    destinationFailed = true;
  });

  const writeDestination = (chunk, callback) => {
    if (destinationFailed || destination.destroyed) {
      callback();
      return;
    }
    destination.write(chunk, (error) => {
      if (error) destinationFailed = true;
      // A transcript failure must not backpressure the child. Keep the outer
      // writable healthy so stdout continues to drain through process exit.
      callback();
    });
  };

  let bytes = 0;
  let truncated = false;
  const transcript = new Writable({
    write(chunk, encoding, callback) {
      if (truncated) {
        callback();
        return;
      }

      const source = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk, encoding);
      const remaining = limit - bytes;
      if (source.byteLength <= remaining) {
        bytes += source.byteLength;
        writeDestination(source, callback);
        return;
      }

      bytes += Math.max(remaining, 0);
      truncated = true;
      const marker = Buffer.from(
        `\n${JSON.stringify({
          type: "factory",
          subtype: "transcript_truncated",
          bytes,
        })}\n`,
      );
      const stored =
        remaining > 0
          ? Buffer.concat([source.subarray(0, remaining), marker])
          : marker;
      try {
        onTruncated?.({ bytes });
      } catch {
        // Trace reporting is observational; continue draining stdout.
      }
      writeDestination(stored, callback);
    },
    final(callback) {
      if (destinationFailed || destination.destroyed) {
        callback();
        return;
      }
      destination.end(() => callback());
    },
    destroy(error, callback) {
      destination.destroy();
      callback(error);
    },
  });

  Object.defineProperties(transcript, {
    truncated: { get: () => truncated },
    bytes: { get: () => bytes },
  });
  return transcript;
}

const terminations = new WeakMap();

function sendSignal(child, signal, kill) {
  try {
    kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already terminated
    }
  }
}

/**
 * Terminate a detached child and every subprocess in its process group.
 *
 * A second request for the same child is intentionally a no-op: timeout and
 * abort handlers can race, but only one TERM→KILL escalation should be armed.
 * The returned function cancels the pending escalation when the child closes.
 */
export function killProcessGroup(
  child,
  {
    killGraceMs,
    signal = "SIGTERM",
    kill = process.kill,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = {},
) {
  if (!child?.pid) return undefined;

  const existing = terminations.get(child);
  if (existing) return existing.cancel;

  sendSignal(child, signal, kill);

  let timer = null;
  const cancel = () => {
    if (timer) clearTimeoutFn(timer);
    timer = null;
  };
  terminations.set(child, { cancel });

  if (signal === "SIGTERM" && Number.isFinite(killGraceMs)) {
    timer = setTimeoutFn(() => sendSignal(child, "SIGKILL", kill), killGraceMs);
    timer.unref?.();
    child.once?.("close", cancel);
  }

  return cancel;
}
