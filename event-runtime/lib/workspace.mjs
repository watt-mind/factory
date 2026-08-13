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
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { canonicalJson } from "./canonical.mjs";
import { materializeArtifact } from "./artifacts.mjs";
import { artifactsRoot } from "./config.mjs";
import { materializeCheckout, releaseCheckout } from "./repository.mjs";

export class PathViolation extends Error {
  constructor(workspaceDir, relPath) {
    super(`path "${relPath}" escapes workspace ${workspaceDir}`);
    this.name = "PathViolation";
    this.workspaceDir = workspaceDir;
    this.relPath = relPath;
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

export function createWorkspace({ root, runId, attempt, input, workspace = {}, artifactStore = artifactsRoot() }) {
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
  return { dir, checkout, materialized };
}

/**
 * Remove the workspace unless retention was requested (§7: retain on failure
 * when policy says so). Returns false when retained, true when destroyed.
 */
export function destroyWorkspace(dir, { retain = false, checkout = null, repoName = null } = {}) {
  // Deregister a repository checkout even when the directory is retained:
  // a mirror that keeps stale worktree registrations refuses future adds.
  if (checkout) releaseCheckout({ checkoutPath: checkout, repoName });
  if (retain) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}
