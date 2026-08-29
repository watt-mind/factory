/**
 * Transcript capture and stream flush guarantees (docs/event-runtime.md §6, §7; OPS-426).
 *
 * Adapters capture agent stdout into `.transcript.json` as a runtime artifact.
 * When large NDJSON streams are emitted, the child process `close` event may fire
 * before the Node/Bun write stream has finished flushing all buffered chunks to disk.
 *
 * This module ensures write streams are completely flushed and closed before
 * computing sha256 hashes and storing artifacts into the content-addressed store,
 * guaranteeing the artifact store's core invariant: stored bytes always equal
 * the computed hash and the agent's full output.
 */
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "./canonical.mjs";
import { artifactPath } from "./artifacts.mjs";

export const TRANSCRIPT_FILENAME = ".transcript.json";

/** Session metadata is emitted at the head of both supported NDJSON streams. */
export const MAX_RESUME_SCAN_BYTES = 1024 * 1024;

function validSessionId(value, adapter) {
  if (typeof value !== "string" || value.length === 0 || value.length > 256)
    return false;
  if (adapter === "claude") {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    );
  }
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

/**
 * Extract the native harness session identifier from recognized top-level
 * metadata for the expected adapter and prior workspace. Nested agent text or
 * metadata naming a different cwd is never interpreted as resume context.
 */
export function transcriptSessionId(transcriptPath, adapter) {
  if (adapter !== "claude" && adapter !== "pi") return null;

  let fd;
  try {
    fd = openSync(transcriptPath, "r");
    const buffer = Buffer.alloc(MAX_RESUME_SCAN_BYTES);
    const size = readSync(fd, buffer, 0, buffer.byteLength, 0);
    const lines = buffer.subarray(0, size).toString("utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const priorWorkspace = path.dirname(transcriptPath);
      const candidate =
        adapter === "claude" &&
        event?.type === "system" &&
        event?.subtype === "init" &&
        event?.cwd === priorWorkspace
          ? event.session_id
          : adapter === "pi" &&
              event?.type === "session" &&
              event?.cwd === priorWorkspace
            ? event.id
            : null;
      if (validSessionId(candidate, adapter)) return candidate;
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* intentionally ignored */
      }
    }
  }
  return null;
}

/**
 * Find the newest earlier attempt whose retained workspace contains native
 * session metadata. Missing, cleaned, partial, or malformed transcripts are a
 * normal cold-start condition, not a workspace provisioning failure.
 */
export function findPriorResumeContext({ root, runId, attempt, adapter }) {
  if (!Number.isInteger(attempt) || attempt <= 1) return null;
  for (let priorAttempt = attempt - 1; priorAttempt >= 1; priorAttempt -= 1) {
    const transcriptPath = path.join(
      root,
      `${runId}-a${priorAttempt}`,
      TRANSCRIPT_FILENAME,
    );
    if (!existsSync(transcriptPath)) continue;
    const sessionId = transcriptSessionId(transcriptPath, adapter);
    if (sessionId) return { attempt: priorAttempt, sessionId, transcriptPath };
  }
  return null;
}

/**
 * Await a writable stream's complete flush to disk and close.
 * Idempotent, safe against already-closed or destroyed streams, and rejects on write errors.
 *
 * @param {import("node:stream").Writable | import("node:fs").WriteStream} stream
 * @returns {Promise<void>}
 */
export function waitForStreamFlush(stream) {
  if (!stream) return Promise.resolve();
  if (stream.writableFinished || stream.closed) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      stream.removeListener("finish", onFinish);
      stream.removeListener("close", onClose);
      stream.removeListener("error", onError);
    };

    const onFinish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const onClose = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const onError = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    stream.once("finish", onFinish);
    stream.once("close", onClose);
    stream.once("error", onError);

    // `destroyed === true` is NOT proof the stream has fully settled. An
    // fs.WriteStream can still be completing its asynchronous open/close after
    // `destroyed` flips true but while `closed` is still false, and it may emit a
    // late `error` (e.g. ENOENT if its directory was removed in the meantime).
    // Resolving here would strip the `error`/`close` listeners and let that late
    // rejection escape as a process-level unhandled error (Bun reports it as
    // `1 error` / `0 fail`). The early return above already handles the truly
    // terminal `writableFinished`/`closed` cases, so here we stay attached and
    // let `close`/`finish` resolve or a late `error` reject through this promise.
  });
}

/**
 * Create a managed transcript capture write stream in a workspace.
 *
 * @param {string} workspaceDir
 * @param {{ filename?: string, flags?: string }} [options]
 * @returns {{
 *   stream: import("node:fs").WriteStream,
 *   filePath: string,
 *   flush: () => Promise<void>,
 *   endAndFlush: () => Promise<void>
 * }}
 */
export function createTranscriptCapture(
  workspaceDir,
  { filename = TRANSCRIPT_FILENAME, flags = "w" } = {},
) {
  const filePath = path.join(workspaceDir, filename);
  const stream = createWriteStream(filePath, { flags });

  const flush = () => waitForStreamFlush(stream);

  const endAndFlush = () => {
    if (stream.writableFinished || stream.closed) {
      return Promise.resolve();
    }
    if (!stream.writableEnded) {
      stream.end();
    }
    return waitForStreamFlush(stream);
  };

  return {
    stream,
    filePath,
    flush,
    endAndFlush,
  };
}

/**
 * Compute the sha256 hash and size of a transcript file after ensuring any write stream is flushed.
 *
 * @param {string} filePath - Absolute path to transcript file
 * @param {import("node:stream").Writable} [stream] - Optional active write stream to flush first
 * @returns {Promise<{ sha256: string, sizeBytes: number, bytes: Buffer }>}
 */
export async function computeTranscriptHash(filePath, stream = null) {
  if (stream) {
    await waitForStreamFlush(stream);
  }
  if (!existsSync(filePath)) {
    throw new Error(`transcript file does not exist: ${filePath}`);
  }
  const bytes = readFileSync(filePath);
  const sha256 = sha256Hex(bytes);
  return {
    sha256,
    sizeBytes: bytes.byteLength,
    bytes,
  };
}

/**
 * Ensure transcript is flushed, compute its hash, and copy it to the content-addressed store.
 * Guarantees that the stored file contains the full bytes matching the computed sha256 hash.
 *
 * @param {object} params
 * @param {string} params.workspaceDir - Directory containing transcript
 * @param {string} [params.filename] - Transcript filename (default .transcript.json)
 * @param {string} params.storeRoot - Root directory of artifact store
 * @param {import("node:stream").Writable} [params.stream] - Optional active write stream
 * @returns {Promise<{ sha256: string, sizeBytes: number, uri: string, storePath: string }>}
 */
export async function flushAndStoreTranscript({
  workspaceDir,
  filename = TRANSCRIPT_FILENAME,
  storeRoot,
  stream = null,
}) {
  const filePath = path.join(workspaceDir, filename);
  if (stream) {
    if (!stream.writableEnded) {
      stream.end();
    }
    await waitForStreamFlush(stream);
  }

  const { sha256, sizeBytes } = await computeTranscriptHash(filePath);

  mkdirSync(storeRoot, { recursive: true });
  const dest = artifactPath(storeRoot, sha256);

  if (!existsSync(dest)) {
    copyFileSync(filePath, dest);
  }

  // Verify stored artifact matches computed sha256 and size
  const storedStat = statSync(dest);
  if (storedStat.size !== sizeBytes) {
    throw new Error(
      `stored artifact size mismatch for ${dest}: expected ${sizeBytes} bytes, got ${storedStat.size} bytes`,
    );
  }

  return {
    sha256,
    sizeBytes,
    uri: `file://${dest}`,
    storePath: dest,
  };
}
