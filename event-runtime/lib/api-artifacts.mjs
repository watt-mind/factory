/**
 * Artifact endpoints and bounded transcript reads.
 *
 * Validation errors: GET /artifacts returns `invalid_limit`, `invalid_orphan`,
 * or `invalid_before`; POST /artifacts/prune returns `invalid_body`,
 * `invalid_dry_run`, `invalid_apply`, or `conflicting_flags`.
 */
import {
  closeSync,
  createReadStream,
  openSync,
  readSync,
  rmSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";
import { findArtifact, hashFileAsync, pruneArtifacts } from "./artifacts.mjs";
import { artifactsRoot } from "./config.mjs";
import { ApiParameterError, parseListLimit } from "./api-params.mjs";

/** Crude but honest content-type: render text in the browser, download the rest. */
function looksLikeText(file) {
  let fd;
  try {
    fd = openSync(file, "r");
    const head = Buffer.alloc(512);
    const read = readSync(fd, head, 0, head.length, 0);
    return !head.subarray(0, read).includes(0);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export const TRANSCRIPT_MODEL_SCAN_BYTES = 64 * 1024;

function parseBeforeCursor(rawBefore) {
  if (!rawBefore) return null;
  try {
    const before = JSON.parse(
      Buffer.from(rawBefore, "base64url").toString("utf8"),
    );
    if (
      !before ||
      typeof before.mtime !== "string" ||
      !Number.isFinite(Date.parse(before.mtime)) ||
      new Date(before.mtime).toISOString() !== before.mtime ||
      !/^[0-9a-f]{64}$/.test(before.sha256)
    ) {
      throw new Error("invalid cursor");
    }
    return before;
  } catch {
    throw new ApiParameterError(
      "invalid_before",
      "before must be a valid cursor",
    );
  }
}

/** Bounded head of a stored artifact; null when it is missing or unreadable. */
export function artifactHead(
  artifactsDir,
  sha256,
  bytes = TRANSCRIPT_MODEL_SCAN_BYTES,
) {
  const found = findArtifact(artifactsDir, sha256);
  if (!found) return null;
  let fd;
  try {
    fd = openSync(found.file, "r");
    const buf = Buffer.alloc(Math.min(bytes, found.sizeBytes));
    const read = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, read).toString("utf8");
  } catch {
    // A pruned or half-written artifact is a missing observation, not a 500.
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Stream an artifact while closing both ends when either side fails or aborts. */
export async function streamArtifact(source, response) {
  const responseAlreadyClosed = response.destroyed || response.closed;
  try {
    await pipeline(source, response);
  } catch (err) {
    const clientAborted =
      err?.code === "ERR_STREAM_PREMATURE_CLOSE" || responseAlreadyClosed;
    if (!clientAborted) {
      console.warn(`artifact download stream failed: ${err.message}`);
    }
    response.destroy();
  }
}

export async function handleArtifactApiRoute({
  route,
  req,
  res,
  url,
  db,
  send,
  readBody,
  parseJson,
  env,
  nowMs,
  clearStoreStats,
  clearArtifactPage,
  getArtifactPage,
}) {
  if (route === "GET /artifacts") {
    // The inventory is cached for 10 s, so blobs removed outside this API can
    // remain visible until its next refresh.
    const orphanParam = url.searchParams.get("orphan");
    let limit;
    let before;
    try {
      if (
        orphanParam !== null &&
        orphanParam !== "true" &&
        orphanParam !== "false"
      ) {
        throw new ApiParameterError(
          "invalid_orphan",
          "orphan must be true or false",
        );
      }
      limit = parseListLimit(url, { defaultLimit: 100, maxLimit: 500 });
      before = parseBeforeCursor(url.searchParams.get("before"));
    } catch (err) {
      if (err instanceof ApiParameterError) return send(422, err.body);
      throw err;
    }
    const page = getArtifactPage(
      {
        orphan: orphanParam === null ? undefined : orphanParam === "true",
        kind: url.searchParams.has("kind")
          ? url.searchParams.get("kind")
          : undefined,
        search: url.searchParams.has("search")
          ? url.searchParams.get("search")
          : undefined,
        limit,
        before,
      },
      nowMs,
    );
    return send(200, page);
  }

  if (route === "POST /artifacts/prune") {
    const raw = await readBody(req);
    const parsed = raw.length === 0 ? { value: {} } : parseJson(raw);
    if (parsed.error) {
      return send(
        422,
        new ApiParameterError("invalid_body", parsed.error).body,
      );
    }
    const body = parsed.value;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return send(
        422,
        new ApiParameterError("invalid_body", "body must be an object").body,
      );
    }
    if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") {
      return send(
        422,
        new ApiParameterError("invalid_dry_run", "dryRun must be a boolean")
          .body,
      );
    }
    if (body.apply !== undefined && typeof body.apply !== "boolean") {
      return send(
        422,
        new ApiParameterError("invalid_apply", "apply must be a boolean").body,
      );
    }
    if (body.apply === true && body.dryRun === true) {
      return send(
        422,
        new ApiParameterError(
          "conflicting_flags",
          "apply and dryRun cannot both be true",
        ).body,
      );
    }
    const apply = body.apply === true;
    const result = pruneArtifacts(db, artifactsRoot(env.home), {
      now: nowMs,
      dryRun: !apply,
    });
    if (apply) {
      clearStoreStats();
      clearArtifactPage();
    }
    return send(200, result);
  }

  const artifactGet = url.pathname.match(/^\/artifacts\/([0-9a-f]{64})$/);
  if (req.method === "GET" && artifactGet) {
    const found = findArtifact(artifactsRoot(env.home), artifactGet[1]);
    if (!found) return send(404, { error: `no artifact ${artifactGet[1]}` });
    if ((await hashFileAsync(found.file)) !== artifactGet[1]) {
      rmSync(found.file, { force: true });
      clearStoreStats();
      clearArtifactPage();
      return send(404, { error: `no artifact ${artifactGet[1]}` });
    }
    const rawName = url.searchParams.get("name");
    const safeName = rawName
      ? rawName.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64)
      : "";
    res.writeHead(200, {
      "content-type": looksLikeText(found.file)
        ? "text/plain; charset=utf-8"
        : "application/octet-stream",
      "content-length": found.sizeBytes,
      ...(safeName
        ? {
            "content-disposition": `inline; filename="${safeName}-${artifactGet[1].slice(0, 12)}"`,
          }
        : {}),
    });
    await streamArtifact(createReadStream(found.file), res);
    return;
  }

  return false;
}
