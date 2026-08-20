import { spawn } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { artifactsRoot, runtimeHome } from "./config.mjs";
import { openDb } from "./db.mjs";
import { reposRoot } from "./repos.mjs";

/** Bound so a hung Linear call cannot freeze serve forever (OPS-301 review). */
export const JANITOR_TIMEOUT_MS = 120_000;
export const JANITOR_MAX_BUFFER = 1_000_000;
export const DEFAULT_TRACE_RETENTION_DAYS = 14;
export const DEFAULT_ARTIFACT_RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
const SHA256 = /^[a-f0-9]{64}$/;

function retentionMs(days, name) {
  if (!Number.isFinite(days) || days <= 0)
    throw new Error(`${name} must be a positive number of days`);
  return days * DAY_MS;
}

function resultArtifactHashes(result, fallbackHash) {
  const hashes = new Set();
  for (const entry of result?.artifacts ?? []) {
    if (typeof entry?.sha256 === "string" && SHA256.test(entry.sha256))
      hashes.add(entry.sha256);
  }
  const value = result?.artifactHash ?? fallbackHash;
  const match = /^sha256:([a-f0-9]{64})$/.exec(value ?? "");
  if (match && result?.artifact !== undefined) hashes.add(match[1]);
  return hashes;
}

/**
 * Retain recent trace audit rows and artifacts referenced by recently-created
 * runs. This is deliberately a standalone maintenance operation: dry-run is
 * the default and callers must pass `apply: true` to mutate either store.
 */
export function sweepRuntimeRetention(
  db,
  storeRoot,
  {
    traceRetentionDays = DEFAULT_TRACE_RETENTION_DAYS,
    artifactRetentionDays = DEFAULT_ARTIFACT_RETENTION_DAYS,
    now = Date.now(),
    apply = false,
    log = () => {},
  } = {},
) {
  const traceCutoff = new Date(
    now - retentionMs(traceRetentionDays, "traceRetentionDays"),
  ).toISOString();
  const artifactCutoffMs =
    now - retentionMs(artifactRetentionDays, "artifactRetentionDays");
  const trace = db
    .query(`SELECT COUNT(*) AS count FROM attempt_trace WHERE ts < ?`)
    .get(traceCutoff).count;
  if (apply && trace > 0)
    db.query(`DELETE FROM attempt_trace WHERE ts < ?`).run(traceCutoff);

  const referenced = new Set();
  for (const row of db
    .query(
      `SELECT results.result_json, results.artifact_hash
       FROM results JOIN runs ON runs.run_id = results.run_id
       WHERE runs.created_at >= ?`,
    )
    .all(new Date(artifactCutoffMs).toISOString())) {
    try {
      for (const hash of resultArtifactHashes(
        JSON.parse(row.result_json),
        row.artifact_hash,
      ))
        referenced.add(hash);
    } catch {
      // A corrupt historical result is not permission to remove its bytes.
      return {
        trace: { deleted: trace, dryRun: !apply },
        artifacts: { deleted: 0, freedBytes: 0, retained: 0, dryRun: !apply },
        error: "unreadable result artifact reference",
      };
    }
  }

  let deleted = 0;
  let freedBytes = 0;
  let retained = 0;
  if (existsSync(storeRoot)) {
    for (const name of readdirSync(storeRoot)) {
      if (!SHA256.test(name)) continue;
      const file = path.join(storeRoot, name);
      const stat = statSync(file);
      if (
        !stat.isFile() ||
        referenced.has(name) ||
        stat.mtimeMs >= artifactCutoffMs
      ) {
        retained += 1;
        continue;
      }
      deleted += 1;
      freedBytes += stat.size;
      if (apply) rmSync(file, { force: true });
    }
  }
  const result = {
    trace: { deleted: trace, dryRun: !apply },
    artifacts: { deleted, freedBytes, retained, dryRun: !apply },
  };
  log(
    `retention: ${trace} trace rows and ${deleted} artifacts (${freedBytes} bytes) ${apply ? "deleted" : "would be deleted"}`,
  );
  return result;
}

/** Run the retention sweep as an explicit, dry-by-default maintenance command. */
export function runtimeRetentionCommand(args = [], options = {}) {
  let apply = false;
  let traceRetentionDays = DEFAULT_TRACE_RETENTION_DAYS;
  let artifactRetentionDays = DEFAULT_ARTIFACT_RETENTION_DAYS;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--apply") apply = true;
    else if (args[i] === "--trace-days") traceRetentionDays = Number(args[++i]);
    else if (args[i] === "--artifact-days")
      artifactRetentionDays = Number(args[++i]);
    else
      throw new Error(
        "usage: janitor.mjs retention [--apply] [--trace-days N] [--artifact-days N]",
      );
  }
  const db = options.db ?? openDb();
  try {
    return sweepRuntimeRetention(
      db,
      options.storeRoot ?? artifactsRoot(runtimeHome()),
      {
        traceRetentionDays,
        artifactRetentionDays,
        apply,
        now: options.now,
        log: options.log ?? console.log,
      },
    );
  } finally {
    if (!options.db) db.close();
  }
}

/**
 * Argv for one repos.yaml name. `--force` is not a flag and must never become
 * one — the worktree_down refusal on dirty trees is the safety property.
 * Spawn runs against `reposRoot()` so FACTORY_REPOS_ROOT cannot survey one
 * yaml and tear down another.
 */
export function janitorArgv(name, { apply = false } = {}) {
  const args = [
    path.join(reposRoot(), "orchestrator", "janitor.mjs"),
    "--repo",
    name,
    "--json",
  ];
  if (apply === true) args.push("--apply");
  return args;
}

/**
 * Spawn `orchestrator/janitor.mjs --json` for one repos.yaml name asynchronously (OPS-301, OPS-364).
 * Never passes `--force`. Injectable on createApi so tests never hit Linear
 * or real worktrees. Actor is the loopback operator — this is a host-side
 * spawn, the same trust as typing `factory janitor` on the machine.
 */
export async function spawnFactoryJanitor(
  name,
  {
    apply = false,
    timeoutMs = JANITOR_TIMEOUT_MS,
    maxBuffer = JANITOR_MAX_BUFFER,
  } = {},
) {
  const args = janitorArgv(name, { apply });
  const root = reposRoot();

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer = null;

    const child = spawn(process.execPath, args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* intentionally ignored */
      }
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* intentionally ignored */
        }
      }, 2000);
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > maxBuffer) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* intentionally ignored */
        }
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > maxBuffer) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* intentionally ignored */
        }
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);

      if (timedOut) {
        const err = new Error("janitor timed out");
        err.status = 504;
        return reject(err);
      }

      if (code === 2) {
        const err = new Error(`unknown repo ${name}`);
        err.status = 404;
        return reject(err);
      }

      if (code !== 0) {
        const err = new Error(stderr.trim() || `janitor exit ${code}`);
        err.status = 500;
        return reject(err);
      }

      let parsed;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch (e) {
        const err = new Error(
          stderr.trim() || stdout.trim() || `invalid json: ${e.message}`,
        );
        err.status = 500;
        return reject(err);
      }

      if (parsed && Array.isArray(parsed.results)) {
        const err = new Error("janitor returned multiple repos; expected one");
        err.status = 500;
        return reject(err);
      }

      resolve(parsed);
    });
  });
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (command !== "retention") {
    throw new Error(
      "usage: janitor.mjs retention [--apply] [--trace-days N] [--artifact-days N]",
    );
  }
  runtimeRetentionCommand(args);
}
