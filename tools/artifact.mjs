#!/usr/bin/env bun
/**
 * Generalized Factory artifact CLI (`factory artifact` / `factory pr-media`).
 *
 * Unifies the local content-addressed store (~/.factory/events/artifacts/<sha256>)
 * with the Cloudflare R2 artifact Worker (https://artifacts.watt-mind.com).
 *
 * Verbs:
 *   put <file>         store locally and upload to R2 (unless --local-only)
 *   get <sha256>       read from local store (or download from R2)
 *   ls                 list local and/or remote artifacts
 *   rm <sha256>        delete from local store and/or R2
 *   prune [--apply]    delegate local orphan prune to event-runtime
 *   backfill-results   delegate result artifact backfill to event-runtime
 *   pr-media <file...> validate, store, upload UX images/videos, emit GitHub Markdown,
 *                      and optionally post/update the PR + apply labels
 */

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { artifactsRoot, runtimeHome } from "../event-runtime/lib/config.mjs";
import {
  artifactPath,
  findArtifact,
  hashFile,
} from "../event-runtime/lib/artifacts.mjs";
import { detectContentType } from "../event-runtime/lib/api-artifacts.mjs";

const HEX64 = /^[0-9a-f]{64}$/;
export const DEFAULT_ARTIFACT_URL = "https://artifacts.watt-mind.com";
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 25 * 1024 * 1024;
export const MAX_GENERAL_BYTES = 50 * 1024 * 1024;

export const UX_EVIDENCE_START = "<!-- factory:ux-evidence:start -->";
export const UX_EVIDENCE_END = "<!-- factory:ux-evidence:end -->";

const EXT_TO_MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  pdf: "application/pdf",
  json: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  log: "text/plain; charset=utf-8",
  html: "text/html; charset=utf-8",
  csv: "text/csv; charset=utf-8",
};

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);
const VIDEO_EXTS = new Set(["mp4", "webm"]);
const PR_MEDIA_EXTS = new Set([...IMAGE_EXTS, ...VIDEO_EXTS]);

/** Parse a simple KEY=VALUE env file (ignoring comments and blank lines). */
export function parseEnvFile(text) {
  const out = {};
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/** Resolve remote Worker URL + Bearer token from env or ~/.config/factory/artifacts.env. */
export function loadArtifactConfig({
  env = process.env,
  configPath = path.join(os.homedir(), ".config", "factory", "artifacts.env"),
} = {}) {
  let fileVars = {};
  if (configPath && existsSync(configPath)) {
    fileVars = parseEnvFile(readFileSync(configPath, "utf8"));
  }
  const baseUrl = (
    env.FACTORY_ARTIFACT_URL ||
    fileVars.FACTORY_ARTIFACT_URL ||
    DEFAULT_ARTIFACT_URL
  ).replace(/\/+$/, "");
  const token =
    env.FACTORY_ARTIFACT_TOKEN || fileVars.FACTORY_ARTIFACT_TOKEN || "";
  return { baseUrl, token };
}

/** Normalize file extension (without leading dot). */
export function normalizeExt(filePath) {
  return path
    .extname(filePath || "")
    .replace(/^\./, "")
    .toLowerCase();
}

/** Determine content-type from magic bytes first, then extension. */
export function resolveContentType(filePath) {
  const ext = normalizeExt(filePath);
  const sniffed = detectContentType(filePath);
  if (
    sniffed !== "application/octet-stream" &&
    sniffed !== "text/plain; charset=utf-8"
  ) {
    return sniffed;
  }
  return EXT_TO_MIME[ext] || sniffed;
}

/** Atomically copy a file into the local content-addressed artifact store. */
export function storeLocalArtifact(filePath, storeRoot) {
  const bytes = readFileSync(filePath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  mkdirSync(storeRoot, { recursive: true });
  const dest = artifactPath(storeRoot, sha256);
  if (!existsSync(dest) || hashFile(dest) !== sha256) {
    const tmp = path.join(
      storeRoot,
      `${sha256}.tmp.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}`,
    );
    try {
      writeFileSync(tmp, bytes);
      renameSync(tmp, dest);
    } finally {
      if (existsSync(tmp)) rmSync(tmp, { force: true });
    }
  }
  return { sha256, bytes: bytes.byteLength, localPath: dest };
}

/** Check whether a path is tracked in git (refused for PR-only media). */
export function isGitTracked(filePath, runCmd = spawnSync) {
  const abs = path.resolve(filePath);
  const dir = path.dirname(abs);
  const res = runCmd("git", ["ls-files", "--error-unmatch", "--", abs], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return res.status === 0;
}

/** Upload bytes to the Cloudflare Worker R2 API. */
export async function uploadRemoteArtifact({
  filePath,
  sha256,
  contentType,
  ext,
  kind = "file",
  repo = "",
  ref = "",
  visibility = "public",
  baseUrl,
  token,
  fetchImpl = globalThis.fetch,
}) {
  if (!token) {
    throw new Error(
      "FACTORY_ARTIFACT_TOKEN is not set (configure env or ~/.config/factory/artifacts.env)",
    );
  }
  const body = readFileSync(filePath);
  const res = await fetchImpl(`${baseUrl}/api/artifacts/${sha256}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": contentType,
      "X-Artifact-Visibility": visibility,
      "X-Artifact-Kind": kind,
      "X-Artifact-Ext": ext,
      "X-Artifact-Repo": repo,
      "X-Artifact-Ref": ref,
      "X-Artifact-Filename": path.basename(filePath),
    },
    body,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new Error(
      `artifact upload failed (${res.status}): ${data?.error || text}`,
    );
  }
  return data;
}

/** Try extracting a PNG poster frame from a video using ffmpeg (returns null if unavailable). */
export function extractVideoPoster(videoPath, runCmd = spawnSync) {
  const tmpPoster = path.join(
    os.tmpdir(),
    `factory-poster-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}.png`,
  );
  const res = runCmd(
    "ffmpeg",
    [
      "-y",
      "-i",
      videoPath,
      "-frames:v",
      "1",
      "-vf",
      "scale='min(1280,iw)':-2",
      tmpPoster,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (
    res.status === 0 &&
    existsSync(tmpPoster) &&
    statSync(tmpPoster).size > 0
  ) {
    return tmpPoster;
  }
  if (existsSync(tmpPoster)) rmSync(tmpPoster, { force: true });
  return null;
}

/** Format uploaded PR media items into GitHub-ready Markdown. */
export function formatPrMediaMarkdown({
  before = null,
  after = null,
  items = [],
}) {
  const lines = [];
  if (before && after) {
    const beforeCap = before.caption || "Before";
    const afterCap = after.caption || "After";
    lines.push("| Before | After |");
    lines.push("| --- | --- |");
    lines.push(
      `| ![${beforeCap}](${before.url}) | ![${afterCap}](${after.url}) |`,
    );
  }
  for (const item of items) {
    const cap = item.caption || item.filename || "UX evidence";
    if (item.mediaType === "video") {
      if (item.posterUrl) {
        lines.push(`[![▶ ${cap}](${item.posterUrl})](${item.url})`);
        lines.push(`*Click thumbnail to watch video (${cap})*`);
      } else {
        lines.push(`- [▶ Watch video: ${cap}](${item.url})`);
      }
    } else {
      lines.push(`![${cap}](${item.url})`);
    }
  }
  return lines.join("\n");
}

/** Insert or replace the managed UX Evidence block in a PR body. */
export function upsertUxEvidenceBlock(existingBody, markdownContent) {
  const block = [
    UX_EVIDENCE_START,
    "## UX Evidence",
    markdownContent,
    UX_EVIDENCE_END,
  ].join("\n");

  const body = String(existingBody || "");
  const startIdx = body.indexOf(UX_EVIDENCE_START);
  const endIdx = body.indexOf(UX_EVIDENCE_END);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    return (
      body.slice(0, startIdx) +
      block +
      body.slice(endIdx + UX_EVIDENCE_END.length)
    );
  }
  const trimmed = body.trimEnd();
  return trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`;
}

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      positional.push(arg);
      continue;
    }
    if (arg === "-o") {
      flags.out = argv[++i];
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      flags.help = true;
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const booleanFlags = new Set([
      "local-only",
      "local",
      "remote",
      "json",
      "apply",
      "comment",
      "update-body",
      "no-labels",
      "no-poster",
      "allow-tracked",
    ]);
    if (booleanFlags.has(key)) {
      flags[key] = true;
    } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`flag --${key} requires a value`);
      }
      if (key === "caption") {
        flags.captions = flags.captions || [];
        flags.captions.push(next);
      } else {
        flags[key] = next;
      }
      i++;
    }
  }
  return { flags, positional };
}

function usageText() {
  return `factory artifact — manage local & Cloudflare R2 artifacts (artifacts.watt-mind.com)

Usage:
  factory artifact put <file> [--kind <kind>] [--repo <repo>] [--ref <id>]
                              [--visibility public|private] [--local-only] [--json]
  factory artifact get <sha256> [-o <path>] [--visibility public|private] [--local-only]
  factory artifact ls [--local|--remote] [--kind <kind>] [--repo <repo>] [--ref <id>]
                      [--visibility public|private] [--limit N] [--json]
  factory artifact rm <sha256> [--local] [--remote] [--visibility public|private]
  factory artifact prune [--apply]
  factory artifact backfill-results [--apply]
  factory artifact pr-media [file...] [--before <f> --after <f>] [--caption "..."]
                                      [--pr <num|url>] [--repo <owner/repo>]
                                      [--comment | --update-body] [--no-labels]
                                      [--no-poster] [--json]

Alias:
  factory pr-media ...        shorthand for 'factory artifact pr-media ...'

Config:
  FACTORY_ARTIFACT_URL        default: ${DEFAULT_ARTIFACT_URL}
  FACTORY_ARTIFACT_TOKEN      Bearer token (or ~/.config/factory/artifacts.env)
`;
}

function validatePrMediaFile(
  filePath,
  { allowTracked = false, runCmd = spawnSync } = {},
) {
  if (!existsSync(filePath)) {
    throw new Error(`file not found: ${filePath}`);
  }
  const st = statSync(filePath);
  if (!st.isFile()) {
    throw new Error(`not a regular file: ${filePath}`);
  }
  const ext = normalizeExt(filePath);
  if (!PR_MEDIA_EXTS.has(ext)) {
    throw new Error(
      `unsupported pr-media extension '.${ext || "(none)"}' for ${filePath} (allowed: ${[...PR_MEDIA_EXTS].join(", ")})`,
    );
  }
  const isVideo = VIDEO_EXTS.has(ext);
  const maxBytes = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (st.size === 0) {
    throw new Error(`file is empty: ${filePath}`);
  }
  if (st.size > maxBytes) {
    throw new Error(
      `file exceeds ${Math.round(maxBytes / (1024 * 1024))} MB limit: ${filePath} (${st.size} bytes)`,
    );
  }
  if (!allowTracked && isGitTracked(filePath, runCmd)) {
    throw new Error(
      `refusing git-tracked file '${filePath}' — PR-only media must stay outside git (pass --allow-tracked to override)`,
    );
  }
  return { ext, isVideo, size: st.size };
}

function attachMediaToPr({
  pr,
  repo,
  markdown,
  mode,
  addLabels,
  runCmd = spawnSync,
}) {
  const repoArgs = repo ? ["--repo", repo] : [];
  if (mode === "comment") {
    const body = `## UX Evidence\n\n${markdown}\n`;
    const res = runCmd(
      "gh",
      ["pr", "comment", String(pr), ...repoArgs, "--body", body],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (res.status !== 0) {
      throw new Error(
        `gh pr comment failed: ${(res.stderr || res.stdout || "").trim()}`,
      );
    }
  } else if (mode === "update-body") {
    const view = runCmd(
      "gh",
      ["pr", "view", String(pr), ...repoArgs, "--json", "body", "-q", ".body"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    if (view.status !== 0) {
      throw new Error(
        `gh pr view failed: ${(view.stderr || view.stdout || "").trim()}`,
      );
    }
    const nextBody = upsertUxEvidenceBlock(view.stdout, markdown);
    const edit = runCmd(
      "gh",
      ["pr", "edit", String(pr), ...repoArgs, "--body", nextBody],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    if (edit.status !== 0) {
      throw new Error(
        `gh pr edit failed: ${(edit.stderr || edit.stdout || "").trim()}`,
      );
    }
  }
  if (addLabels) {
    for (const label of ["has-screenshots", "type:ui-ux"]) {
      runCmd(
        "gh",
        ["pr", "edit", String(pr), ...repoArgs, "--add-label", label],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    }
  }
}

export async function runArtifactCli(
  argv,
  {
    env = process.env,
    storeRoot = null,
    configPath = path.join(os.homedir(), ".config", "factory", "artifacts.env"),
    fetchImpl = globalThis.fetch,
    runCmd = spawnSync,
    stdout = (s) => process.stdout.write(`${s}\n`),
    stderr = (s) => process.stderr.write(`${s}\n`),
  } = {},
) {
  const [verb, ...rest] = argv;
  if (!verb || verb === "help" || verb === "-h" || verb === "--help") {
    stdout(usageText());
    return 0;
  }

  const { flags, positional } = parseFlags(rest);
  if (flags.help) {
    stdout(usageText());
    return 0;
  }

  const resolvedStoreRoot = storeRoot || artifactsRoot(runtimeHome(env));
  const config = loadArtifactConfig({ env, configPath });

  if (verb === "put") {
    const filePath = positional[0];
    if (!filePath)
      throw new Error("usage: factory artifact put <file> [flags]");
    if (!existsSync(filePath)) throw new Error(`file not found: ${filePath}`);
    const st = statSync(filePath);
    if (!st.isFile()) throw new Error(`not a regular file: ${filePath}`);
    if (st.size === 0) throw new Error(`file is empty: ${filePath}`);
    if (st.size > MAX_GENERAL_BYTES) {
      throw new Error(`file exceeds 50 MB limit: ${filePath}`);
    }

    const visibility = flags.visibility || "public";
    if (visibility !== "public" && visibility !== "private") {
      throw new Error(
        `invalid --visibility '${visibility}' (expected public or private)`,
      );
    }
    const ext = normalizeExt(filePath);
    const contentType = resolveContentType(filePath);
    const local = storeLocalArtifact(filePath, resolvedStoreRoot);
    let remote = null;
    if (!flags["local-only"]) {
      remote = await uploadRemoteArtifact({
        filePath,
        sha256: local.sha256,
        contentType,
        ext,
        kind: flags.kind || "file",
        repo: flags.repo || "",
        ref: flags.ref || "",
        visibility,
        baseUrl: config.baseUrl,
        token: config.token,
        fetchImpl,
      });
    }
    const result = {
      sha256: local.sha256,
      bytes: local.bytes,
      contentType,
      ext,
      localPath: local.localPath,
      visibility,
      url: remote?.url || null,
      deduplicated: remote?.deduplicated ?? null,
    };
    if (flags.json) {
      stdout(JSON.stringify(result, null, 2));
    } else {
      stdout(remote?.url || local.localPath);
    }
    return 0;
  }

  if (verb === "get") {
    const sha256 = (positional[0] || "").toLowerCase();
    if (!HEX64.test(sha256)) {
      throw new Error(
        "usage: factory artifact get <64-hex-sha256> [-o <path>]",
      );
    }
    const found = findArtifact(resolvedStoreRoot, sha256);
    if (found) {
      if (flags.out) {
        mkdirSync(path.dirname(path.resolve(flags.out)), { recursive: true });
        copyFileSync(found.file, flags.out);
        stdout(path.resolve(flags.out));
      } else {
        stdout(found.file);
      }
      return 0;
    }
    if (flags["local-only"]) {
      throw new Error(`artifact not found locally: ${sha256}`);
    }
    const visibility = flags.visibility || "public";
    const prefix = visibility === "private" ? "/private/a" : "/a";
    const headers = config.token
      ? { Authorization: `Bearer ${config.token}` }
      : {};
    const res = await fetchImpl(`${config.baseUrl}${prefix}/${sha256}`, {
      headers,
    });
    if (!res.ok) {
      throw new Error(
        `remote artifact fetch failed (${res.status}): ${sha256}`,
      );
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const actualSha = createHash("sha256").update(buf).digest("hex");
    if (actualSha !== sha256) {
      throw new Error(
        `downloaded hash mismatch: expected ${sha256}, got ${actualSha}`,
      );
    }
    mkdirSync(resolvedStoreRoot, { recursive: true });
    const dest = artifactPath(resolvedStoreRoot, sha256);
    writeFileSync(dest, buf);
    if (flags.out) {
      mkdirSync(path.dirname(path.resolve(flags.out)), { recursive: true });
      copyFileSync(dest, flags.out);
      stdout(path.resolve(flags.out));
    } else {
      stdout(dest);
    }
    return 0;
  }

  if (verb === "ls") {
    const showLocal = flags.local || !flags.remote;
    const showRemote = Boolean(flags.remote);
    const limit = Math.min(Math.max(Number(flags.limit || "50") || 50, 1), 200);
    const out = {};

    if (showLocal) {
      const items = [];
      if (existsSync(resolvedStoreRoot)) {
        for (const name of readdirSync(resolvedStoreRoot)) {
          if (!HEX64.test(name)) continue;
          const file = path.join(resolvedStoreRoot, name);
          const st = statSync(file);
          if (!st.isFile()) continue;
          items.push({
            sha256: name,
            bytes: st.size,
            mtime: st.mtime.toISOString(),
            contentType: detectContentType(file),
          });
        }
      }
      items.sort((a, b) => b.mtime.localeCompare(a.mtime));
      out.local = items.slice(0, limit);
    }

    if (showRemote) {
      if (!config.token) {
        throw new Error(
          "FACTORY_ARTIFACT_TOKEN is required for --remote listing",
        );
      }
      const params = new URLSearchParams();
      if (flags.visibility) params.set("visibility", flags.visibility);
      if (flags.kind) params.set("kind", flags.kind);
      if (flags.repo) params.set("repo", flags.repo);
      if (flags.ref) params.set("ref", flags.ref);
      params.set("limit", String(limit));
      const res = await fetchImpl(
        `${config.baseUrl}/api/artifacts?${params.toString()}`,
        { headers: { Authorization: `Bearer ${config.token}` } },
      );
      if (!res.ok) {
        throw new Error(`remote artifact list failed (${res.status})`);
      }
      const data = await res.json();
      out.remote = data.artifacts || [];
    }

    if (flags.json) {
      stdout(JSON.stringify(out, null, 2));
    } else {
      if (out.local) {
        for (const item of out.local) {
          stdout(
            `local  ${item.sha256.slice(0, 12)}  ${String(item.bytes).padStart(9)}B  ${item.contentType.padEnd(24)}  ${item.mtime}`,
          );
        }
      }
      if (out.remote) {
        for (const item of out.remote) {
          stdout(
            `remote ${item.sha256.slice(0, 12)}  ${String(item.bytes).padStart(9)}B  ${(item.kind || "file").padEnd(14)}  ${item.url}`,
          );
        }
      }
    }
    return 0;
  }

  if (verb === "rm") {
    const sha256 = (positional[0] || "").toLowerCase();
    if (!HEX64.test(sha256)) {
      throw new Error(
        "usage: factory artifact rm <64-hex-sha256> [--local] [--remote]",
      );
    }
    const rmLocal = flags.local || !flags.remote;
    const rmRemote = Boolean(flags.remote);
    const result = { sha256, localDeleted: false, remoteDeleted: [] };

    if (rmLocal) {
      const found = findArtifact(resolvedStoreRoot, sha256);
      if (found) {
        rmSync(found.file, { force: true });
        result.localDeleted = true;
      }
    }
    if (rmRemote) {
      if (!config.token) {
        throw new Error(
          "FACTORY_ARTIFACT_TOKEN is required for --remote delete",
        );
      }
      const qs = flags.visibility
        ? `?visibility=${encodeURIComponent(flags.visibility)}`
        : "";
      const res = await fetchImpl(
        `${config.baseUrl}/api/artifacts/${sha256}${qs}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${config.token}` },
        },
      );
      if (!res.ok) {
        throw new Error(`remote artifact delete failed (${res.status})`);
      }
      const data = await res.json();
      result.remoteDeleted = data.deleted || [];
    }
    stdout(
      flags.json ? JSON.stringify(result, null, 2) : JSON.stringify(result),
    );
    return 0;
  }

  if (verb === "backfill-results") {
    const root = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
    );
    const args = ["event-runtime/cli.mjs", "artifacts", "backfill-results"];
    if (flags.apply) args.push("--apply");
    const res = runCmd("bun", args, { cwd: root, stdio: "inherit" });
    return res.status ?? 1;
  }

  if (verb === "prune") {
    const root = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
    );
    const script = [
      'import { openDb } from "./event-runtime/lib/db.mjs";',
      'import { artifactsRoot, runtimeHome } from "./event-runtime/lib/config.mjs";',
      'import { pruneArtifacts } from "./event-runtime/lib/artifacts.mjs";',
      "const home = runtimeHome();",
      "const db = openDb(home);",
      `const res = pruneArtifacts(db, artifactsRoot(home), { dryRun: ${flags.apply ? "false" : "true"} });`,
      "console.log(JSON.stringify(res, null, 2));",
    ].join("\n");
    const res = runCmd("bun", ["-e", script], { cwd: root, stdio: "inherit" });
    return res.status ?? 1;
  }

  if (verb === "pr-media") {
    const beforePath = flags.before || null;
    const afterPath = flags.after || null;
    if ((beforePath && !afterPath) || (!beforePath && afterPath)) {
      throw new Error("--before and --after must be provided together");
    }
    if (!beforePath && positional.length === 0) {
      throw new Error(
        "usage: factory artifact pr-media <file...> [--before <f> --after <f>] [--caption '...'] [--pr <num|url>] [--comment|--update-body]",
      );
    }
    if (flags.comment && flags["update-body"]) {
      throw new Error("cannot combine --comment and --update-body");
    }
    if ((flags.comment || flags["update-body"]) && !flags.pr) {
      throw new Error("--comment / --update-body requires --pr <num|url>");
    }

    const repo = flags.repo || "";
    const ref = flags.ref || (flags.pr ? `PR#${flags.pr}` : "");
    const allowTracked = Boolean(flags["allow-tracked"]);

    const uploadOne = async (filePath, caption = "") => {
      const { ext, isVideo } = validatePrMediaFile(filePath, {
        allowTracked,
        runCmd,
      });
      const contentType = resolveContentType(filePath);
      const kind = isVideo ? "ux-video" : "ux-screenshot";
      const local = storeLocalArtifact(filePath, resolvedStoreRoot);
      const remote = await uploadRemoteArtifact({
        filePath,
        sha256: local.sha256,
        contentType,
        ext,
        kind,
        repo,
        ref,
        visibility: "public",
        baseUrl: config.baseUrl,
        token: config.token,
        fetchImpl,
      });

      let posterUrl = null;
      if (isVideo && !flags["no-poster"]) {
        const posterPath = extractVideoPoster(filePath, runCmd);
        if (posterPath) {
          try {
            const posterLocal = storeLocalArtifact(
              posterPath,
              resolvedStoreRoot,
            );
            const posterRemote = await uploadRemoteArtifact({
              filePath: posterPath,
              sha256: posterLocal.sha256,
              contentType: "image/png",
              ext: "png",
              kind: "ux-screenshot",
              repo,
              ref,
              visibility: "public",
              baseUrl: config.baseUrl,
              token: config.token,
              fetchImpl,
            });
            posterUrl = posterRemote.url;
          } finally {
            rmSync(posterPath, { force: true });
          }
        }
      }

      return {
        filename: path.basename(filePath),
        caption: caption || path.basename(filePath, path.extname(filePath)),
        mediaType: isVideo ? "video" : "image",
        kind,
        sha256: local.sha256,
        bytes: local.bytes,
        localPath: local.localPath,
        url: remote.url,
        posterUrl,
      };
    };

    let beforeItem = null;
    let afterItem = null;
    if (beforePath && afterPath) {
      beforeItem = await uploadOne(beforePath, "Before");
      afterItem = await uploadOne(afterPath, "After");
    }

    const captions = flags.captions || [];
    const items = [];
    for (let i = 0; i < positional.length; i++) {
      items.push(await uploadOne(positional[i], captions[i] || ""));
    }

    const markdown = formatPrMediaMarkdown({
      before: beforeItem,
      after: afterItem,
      items,
    });

    if (flags.pr && (flags.comment || flags["update-body"])) {
      attachMediaToPr({
        pr: flags.pr,
        repo,
        markdown,
        mode: flags.comment ? "comment" : "update-body",
        addLabels: !flags["no-labels"],
        runCmd,
      });
    }

    if (flags.json) {
      stdout(
        JSON.stringify(
          { before: beforeItem, after: afterItem, items, markdown },
          null,
          2,
        ),
      );
    } else {
      stdout(markdown);
    }
    return 0;
  }

  stderr(`factory artifact: unknown verb '${verb}'`);
  stdout(usageText());
  return 2;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runArtifactCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`error: ${err?.message || err}\n`);
      process.exit(1);
    });
}
