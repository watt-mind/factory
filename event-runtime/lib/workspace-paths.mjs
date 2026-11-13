/**
 * Path confinement primitives shared by workspace provisioning and artifact
 * publication. Keeping these independent of either subsystem prevents the
 * trust boundary from making the two high-level modules depend on each other.
 */
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

export class PathViolation extends Error {
  constructor(workspaceDir, relPath, detail = "escapes workspace") {
    super(`path "${relPath}" ${detail} ${workspaceDir}`);
    this.name = "PathViolation";
    this.workspaceDir = workspaceDir;
    this.relPath = relPath;
    this.detail = detail;
  }
}

/**
 * Canonicalize the workspace root for containment checks. A root that no
 * longer exists (destroyed or retained-then-removed workspace) is reported as
 * a PathViolation rather than a raw ENOENT so callers see one error class.
 */
function canonicalWorkspaceRoot(workspaceDir, relPath) {
  try {
    return realpathSync(path.resolve(workspaceDir));
  } catch {
    throw new PathViolation(
      workspaceDir,
      relPath,
      "workspace root not resolvable",
    );
  }
}

/**
 * Resolve a declared workspace-relative path to an absolute one, rejecting
 * absolute inputs and anything that resolves outside the workspace. Strict:
 * the workspace directory itself is not a valid artifact path. Returns the
 * canonical (realpath) absolute path, so symlinked roots resolve to their
 * real location.
 */
export function safeJoin(workspaceDir, relPath) {
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new PathViolation(workspaceDir, relPath);
  }
  if (path.isAbsolute(relPath)) throw new PathViolation(workspaceDir, relPath);
  // Keep both ends of containment checks in the same namespace. On macOS the
  // system temp root may enter as /var while realpath resolves it as
  // /private/var; comparing a candidate in one spelling with a root in the
  // other incorrectly rejects an in-workspace artifact as an escape.
  const root = canonicalWorkspaceRoot(workspaceDir, relPath);
  const resolved = path.resolve(root, relPath);
  if (!resolved.startsWith(root + path.sep))
    throw new PathViolation(workspaceDir, relPath);
  return resolved;
}

/**
 * Resolve one existing workspace-relative artifact source without following
 * symlinks. Lexical confinement alone is insufficient here: the host later
 * interprets symlinks preserved from a sandboxed guest in the host namespace.
 * Every component beneath the workspace root is therefore checked with lstat,
 * then both endpoints are canonicalized and the final source must be a regular
 * file.
 *
 * This deliberately centralizes the preflight used by result verification and
 * durable artifact storage. A check/open TOCTOU window remains between this
 * path-based preflight and callers' subsequent read/hash/copy operations. Fully
 * closing it requires descriptor-relative openat-style traversal with no-follow
 * semantics, which node:fs does not expose; callers re-run this helper at each
 * trust boundary and verify the copied bytes by hash in the meantime.
 */
export function confinedRegularFile(workspaceDir, relPath) {
  const root = canonicalWorkspaceRoot(workspaceDir, relPath);
  const source = safeJoin(root, relPath);
  const relative = path.relative(root, source);
  const components = relative.split(path.sep).filter(Boolean);
  let cursor = root;

  for (const [index, component] of components.entries()) {
    cursor = path.join(cursor, component);
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) {
      throw new PathViolation(
        workspaceDir,
        relPath,
        `contains symlink component "${components.slice(0, index + 1).join(path.sep)}" beneath workspace`,
      );
    }
    const final = index === components.length - 1;
    if (!final && !stat.isDirectory()) {
      throw new PathViolation(
        workspaceDir,
        relPath,
        `contains non-directory component "${components.slice(0, index + 1).join(path.sep)}" beneath workspace`,
      );
    }
    if (final && !stat.isFile()) {
      throw new PathViolation(
        workspaceDir,
        relPath,
        "does not name a regular file beneath workspace",
      );
    }
  }

  const canonicalSource = realpathSync(source);
  if (!canonicalSource.startsWith(root + path.sep)) {
    throw new PathViolation(
      workspaceDir,
      relPath,
      "canonically escapes workspace",
    );
  }
  return canonicalSource;
}
