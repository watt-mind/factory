/** Artifact endpoints and bounded transcript reads. */
import {
  closeSync,
  createReadStream,
  openSync,
  readFileSync,
  readSync,
  rmSync,
} from "node:fs";
import {
  findArtifact,
  hashFile,
  listArtifacts,
  pruneArtifacts,
} from "./artifacts.mjs";
import { artifactsRoot } from "./config.mjs";

/** Crude but honest content-type: render text in the browser, download the rest. */
function looksLikeText(file) {
  const head = readFileSync(file).subarray(0, 512);
  return !head.includes(0);
}

export const TRANSCRIPT_MODEL_SCAN_BYTES = 64 * 1024;

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
}) {
  if (route === "GET /artifacts") {
    const orphanParam = url.searchParams.get("orphan");
    if (
      orphanParam !== null &&
      orphanParam !== "true" &&
      orphanParam !== "false"
    ) {
      return send(422, { error: "orphan must be true or false" });
    }
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam === null ? undefined : Number(limitParam);
    if (
      limit !== undefined &&
      (!Number.isInteger(limit) || limit < 1 || limit > 500)
    ) {
      return send(422, { error: "limit must be an integer between 1 and 500" });
    }
    const artifacts = listArtifacts(db, artifactsRoot(env.home), {
      orphan: orphanParam === null ? undefined : orphanParam === "true",
      kind: url.searchParams.has("kind")
        ? url.searchParams.get("kind")
        : undefined,
      search: url.searchParams.has("search")
        ? url.searchParams.get("search")
        : undefined,
      limit,
    });
    return send(200, { artifacts });
  }

  if (route === "POST /artifacts/prune") {
    const raw = await readBody(req);
    const parsed = raw.length === 0 ? { value: {} } : parseJson(raw);
    if (parsed.error) return send(422, { error: parsed.error });
    const body = parsed.value ?? {};
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return send(422, { error: "body must be an object" });
    }
    if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") {
      return send(422, { error: "dryRun must be a boolean" });
    }
    if (body.apply !== undefined && typeof body.apply !== "boolean") {
      return send(422, { error: "apply must be a boolean" });
    }
    if (body.apply === true && body.dryRun === true) {
      return send(422, { error: "apply and dryRun cannot both be true" });
    }
    const apply = body.apply === true;
    const result = pruneArtifacts(db, artifactsRoot(env.home), {
      now: nowMs,
      dryRun: !apply,
    });
    if (apply) clearStoreStats();
    return send(200, result);
  }

  const artifactGet = url.pathname.match(/^\/artifacts\/([0-9a-f]{64})$/);
  if (req.method === "GET" && artifactGet) {
    const found = findArtifact(artifactsRoot(env.home), artifactGet[1]);
    if (!found) return send(404, { error: `no artifact ${artifactGet[1]}` });
    if (hashFile(found.file) !== artifactGet[1]) {
      rmSync(found.file, { force: true });
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
    createReadStream(found.file).pipe(res);
    return;
  }

  return false;
}
