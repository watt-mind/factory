/**
 * Ephemeral workspaces (docs/event-runtime.md §7).
 *
 * Every run executes in a unique scratch directory populated only with its
 * declared inputs. The workspace is never durable state — accepted artifacts
 * and lifecycle events are — so destruction is unconditional unless a failure
 * policy says to retain for inspection. Path confinement here is contract
 * enforcement, not a security sandbox (§7): safeJoin exists so a declared
 * artifact path can never name a file outside the workspace, failing closed.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { canonicalJson } from "./canonical.mjs";
import { materializeArtifact } from "./artifacts.mjs";
import { artifactsRoot } from "./config.mjs";
import { getRepo, loadRepos } from "./repos.mjs";
import { materializeCheckout, releaseCheckout } from "./repository.mjs";
import { findPriorResumeContext } from "./transcripts.mjs";

/** Hard ceiling for repository-owned worktree lifecycle scripts (WM-262). */
export const DEFAULT_WORKTREE_SCRIPT_TIMEOUT_MS = 120_000;

function worktreeScriptTimeoutMs() {
  const configured = Number(process.env.FACTORY_WORKTREE_SCRIPT_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_WORKTREE_SCRIPT_TIMEOUT_MS;
}

export class PathViolation extends Error {
  constructor(workspaceDir, relPath) {
    super(`path "${relPath}" escapes workspace ${workspaceDir}`);
    this.name = "PathViolation";
    this.workspaceDir = workspaceDir;
    this.relPath = relPath;
  }
}

/** Tier-2 worktree delegation failure — always typed, never a bare throw. */
export class WorktreeError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorktreeError";
    this.code = "workspace_provisioning_error";
  }
}

/**
 * Resolve a declared workspace-relative path to an absolute one, rejecting
 * absolute inputs and anything that resolves outside the workspace. Strict:
 * the workspace directory itself is not a valid artifact path.
 */
export function safeJoin(workspaceDir, relPath) {
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new PathViolation(workspaceDir, relPath);
  }
  if (path.isAbsolute(relPath)) throw new PathViolation(workspaceDir, relPath);
  const root = path.resolve(workspaceDir);
  const resolved = path.resolve(root, relPath);
  if (!resolved.startsWith(root + path.sep)) throw new PathViolation(workspaceDir, relPath);
  return resolved;
}

/**
 * Create the attempt's directory and materialize its declared input as
 * canonical JSON — the same bytes the spec's inputHash was computed from.
 *
 * A `repository` workspace additionally materializes a read-only source tree
 * at the SHA pinned into the input at plan time (§7 tier 1, OPS-228). The
 * checkout lives inside this directory, so teardown is still one rm — plus a
 * `git worktree remove` so the mirror does not accumulate stale registrations.
 */
/** One run's declared artifact inputs may not exceed this in total. */
export const MAX_MATERIALIZED_BYTES = 64 * 1024 * 1024;

/** Resolve "$.input.logArtifact" against the run input; literals pass through. */
export function resolveInputRef(input, expr) {
  if (typeof expr !== "string") throw new Error(`artifact input ref must be a string, got ${typeof expr}`);
  if (!expr.startsWith("$.input.")) return expr;
  const value = expr
    .slice("$.input.".length)
    .split(".")
    .reduce((acc, key) => (acc === null || acc === undefined ? acc : acc[key]), input);
  if (typeof value !== "string" || !value) throw new Error(`artifact input ref "${expr}" resolves to nothing`);
  return value;
}

/**
 * Marker recording a delegated worktree inside its workspace, so teardown can
 * find the repo's own `worktree_down` without the caller re-plumbing repo
 * facts through every destroy path. Durable on disk (not module state): a
 * worker that dies and restarts must still know what to tear down.
 */
const WORKTREE_MARKER = ".worktree.json";

/**
 * Tier-2 mutating workspace (docs/event-runtime-dispatch.md §5, WM-108):
 * delegate to the `worktree_up` the repo declares in config/repos.yaml —
 * the runtime NEVER implements worktrees itself (event-runtime-workers.md
 * §5a rule 1). Git isolates branches, not ports or databases; those live in
 * the repo-owned script. The planner refuses `no_worktree_scripts` before
 * proposing, so reaching this without the scripts is a bypassed gate — it
 * still fails typed, not with a crash mid-spawn.
 *
 * The tree lands at `worktree_root/<ticket>` (the dispatcher's convention,
 * orchestrator/tick.mjs) and is reachable from the workspace at
 * `./<checkoutDir>` via symlink, mirroring tier 1's `./repo` layout. The
 * repo's declared `verify` command rides along in the returned record — the
 * §9 verifier runs it as ordinary code, never trusting the agent's report.
 */
function materializeWorktree({ workspaceDir, input, checkoutDir, timeoutMs }) {
  const repoName = input?.repo;
  const ticket = input?.ticket;
  if (!repoName || !ticket) {
    throw new WorktreeError("a worktree workspace needs input.repo and input.ticket");
  }
  const repo = getRepo(loadRepos(), repoName);
  if (!repo.worktreeUp || !repo.worktreeDown || !repo.worktreeRoot) {
    throw new WorktreeError(
      `repo "${repoName}" declares no worktree lifecycle in config/repos.yaml (worktree_up/worktree_down/worktree_root) — the planner should have refused this`,
    );
  }
  const worktreePath = path.join(repo.worktreeRoot, ticket);
  const record = {
    repo: repoName,
    ticket,
    path: worktreePath,
    repoPath: repo.path,
    down: repo.worktreeDown,
    verify: repo.verify,
  };
  // Persist teardown facts before bring-up starts. A script can create its
  // worktree and daemons before timing out; the marker lets the janitor find
  // and safely delegate cleanup even when createWorkspace never returns.
  writeFileSync(path.join(workspaceDir, WORKTREE_MARKER), `${canonicalJson(record)}\n`, "utf8");

  // Repo-owned bring-up may discover a red project baseline after the usable
  // worktree already exists. It reports that condition out-of-band and still
  // exits zero; a non-zero exit remains a provisioning failure.
  const reportPath = path.join(workspaceDir, ".worktree-up.json");
  const up = spawnSync("/bin/bash", [repo.worktreeUp, ticket], {
    cwd: repo.path,
    encoding: "utf8",
    env: { ...process.env, FACTORY_WORKTREE_REPORT: reportPath },
    timeout: timeoutMs,
  });
  // A timeout surfaces as up.error, not a non-zero status, so both are failures
  // (WM-262). The full stderr/stdout beats its last line — a bash `set -e` abort
  // often puts the useful message above the final one (WM-481).
  if (up.error?.code === "ETIMEDOUT" || up.status !== 0) {
    const timedOut = up.error?.code === "ETIMEDOUT";
    const stderr = (up.stderr || "").trim();
    const stdout = (up.stdout || "").trim();
    const why = timedOut
      ? `timed out after ${timeoutMs}ms`
      : stderr || stdout || `exit ${up.status}`;
    throw new WorktreeError(`worktree_up failed for ${repoName}/${ticket}: ${why}`);
  }

  if (!existsSync(worktreePath)) {
    throw new WorktreeError(`worktree_up reported success for ${repoName}/${ticket} but did not create ${worktreePath}`);
  }

  let baseline = null;
  if (existsSync(reportPath)) {
    try {
      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      if (report?.status !== "red" || typeof report.check !== "string" || typeof report.output !== "string") {
        throw new Error("expected status=red with string check and output");
      }
      baseline = report;
    } catch (err) {
      throw new WorktreeError(`worktree_up wrote an invalid baseline report for ${repoName}/${ticket}: ${err.message}`);
    }
  }

  symlinkSync(worktreePath, path.join(workspaceDir, checkoutDir));
  if (baseline) record.baseline = baseline;
  writeFileSync(path.join(workspaceDir, WORKTREE_MARKER), `${canonicalJson(record)}\n`, "utf8");

  // The agent contract points it at input.json, so runtime-discovered context
  // must be present there rather than hidden in an implementation marker.
  // Keep the run spec immutable; this is workspace-local execution context.
  if (baseline) {
    const enrichedInput = {
      ...input,
      baseline: {
        ...baseline,
        guidance: `The ${baseline.check} check already fails at this commit. If your ticket is unrelated, do not fix it; if it is related, use this as the starting point.`,
      },
    };
    writeFileSync(path.join(workspaceDir, "input.json"), `${canonicalJson(enrichedInput)}\n`, "utf8");
  }
  return record;
}

export function createWorkspace({
  root,
  runId,
  attempt,
  input,
  workspace = {},
  artifactStore = artifactsRoot(),
  worktreeTimeoutMs = worktreeScriptTimeoutMs(),
  adapter = null,
}) {
  // Lease loss can leave the prior attempt's scratch directory behind. Read
  // recognized harness session metadata before creating the new attempt;
  // absence (including normal cleanup after an orderly failure) means cold start.
  const resume = findPriorResumeContext({ root, runId, attempt, adapter });
  const dir = path.join(root, `${runId}-a${attempt}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "input.json"), `${canonicalJson(input)}\n`, "utf8");

  // Declared artifact inputs (§7 `artifacts`, OPS-372): the spec names hashes,
  // the provider writes bytes, the agent reads files. An agent can never ask
  // the store for something the spec did not declare.
  const materialized = [];
  if (workspace.type === "artifacts") {
    let total = 0;
    for (const entry of workspace.inputs ?? []) {
      const sha256 = resolveInputRef(input, entry.from);
      const out = materializeArtifact({
        storeRoot: artifactStore, sha256hex: sha256, workspaceDir: dir, as: entry.as,
      });
      total += out.sizeBytes;
      if (total > MAX_MATERIALIZED_BYTES) {
        throw new Error(`artifact inputs exceed ${MAX_MATERIALIZED_BYTES} bytes for this run`);
      }
      materialized.push({ as: entry.as, sha256, sizeBytes: out.sizeBytes });
    }
  }

  let checkout = null;
  if (workspace.type === "repository") {
    const subdir = workspace.checkoutDir ?? "repo";
    checkout = materializeCheckout({
      workspaceDir: dir,
      repoName: input?.repoPin?.repo ?? input?.repo,
      sha: input?.repoPin?.sha,
      subdir,
    });
  }

  let worktree = null;
  if (workspace.type === "worktree") {
    try {
      worktree = materializeWorktree({
        workspaceDir: dir,
        input,
        checkoutDir: workspace.checkoutDir ?? "repo",
        timeoutMs: worktreeTimeoutMs,
      });
    } catch (err) {
      if (err instanceof WorktreeError) throw err;
      const repoName = input?.repo ?? "unknown repo";
      const ticket = input?.ticket ?? "unknown ticket";
      throw new WorktreeError(
        `worktree provisioning failed for ${repoName}/${ticket}: ${err?.message ?? String(err)}`,
      );
    }
  }
  return { dir, checkout, materialized, worktree, resume };
}

/**
 * Remove the workspace unless retention was requested (§7: retain on failure
 * when policy says so). Returns false when retained, true when destroyed.
 */
export function destroyWorkspace(
  dir,
  {
    retain = false,
    checkout = null,
    repoName = null,
    worktreeTimeoutMs = worktreeScriptTimeoutMs(),
  } = {},
) {
  // Deregister a repository checkout even when the directory is retained:
  // a mirror that keeps stale worktree registrations refuses future adds.
  if (checkout) releaseCheckout({ checkoutPath: checkout, repoName });

  // Delegated worktree teardown (WM-108): run the repo's own `worktree_down`
  // on completion and failure alike, including when the failed workspace's
  // files are retained for inspection. The script owns daemon/port cleanup
  // and the safety property — it refuses dirty trees, and the runtime never
  // adds `--force` (lib/client.mjs carries the same rule). A refusal or failure
  // retains the whole workspace, marker included, so the leak is visible to
  // the janitor instead of an rm quietly orphaning a live dev server.
  const marker = path.join(dir, WORKTREE_MARKER);
  if (existsSync(marker)) {
    let record = null;
    try {
      record = JSON.parse(readFileSync(marker, "utf8"));
    } catch {
      record = null;
    }
    if (!record?.down || !record?.ticket) return false;
    const down = spawnSync("/bin/bash", [record.down, record.ticket], {
      cwd: record.repoPath,
      encoding: "utf8",
      timeout: worktreeTimeoutMs,
    });
    if (down.error?.code === "ETIMEDOUT" || down.status !== 0) return false;
    // A retained workspace may outlive a successfully removed worktree. Drop
    // its teardown marker so a later operator cleanup does not invoke the
    // repo script again against a tree that no longer exists.
    if (retain) rmSync(marker, { force: true });
  }

  if (retain) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}
