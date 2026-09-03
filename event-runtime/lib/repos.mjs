/**
 * Repo facts, read from the factory's local config/repos.yaml (OPS-228) and
 * overlaid with portable policy from each checkout's factory.repo/v1 file.
 *
 * Deliberately a reader, not an owner: host config remains the source of
 * checkout identity, routing, concurrency, and every input to a host-executed
 * command (`verify`, the `security` scanner flags), while repository-intrinsic
 * policy settings evolve with that repository in git.
 *
 * Tier 1 uses `name`, `path`, `github`, and `base`. The `worktree_*` and
 * `verify` fields are read but unused until tier 2 (docs/event-runtime-workers.md).
 * The registry fields (`team`, `project`, `report_only`, `max_in_flight`,
 * `deploy_branch`) are what an operator needs to tell a dispatch target from a
 * report-only one, and where its worktrees live (OPS-299).
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_MAX_IN_FLIGHT,
  FACTORY_ROOT,
  resolveConfigPath,
} from "./config.mjs";
import { validate } from "./schema.mjs";
// types.mjs only, never index.mjs: index.mjs reads this registry to resolve a
// repo's control plane (WM-1007), so importing it back here would cycle.
// types.mjs imports nothing.
import { CONTROL_PLANE_KINDS } from "../../lib/control-plane/types.mjs";

export class RepoError extends Error {
  constructor(message) {
    super(message);
    this.name = "RepoError";
  }
}

/**
 * Which factory checkout supplies repos.yaml. Defaults to the running one;
 * FACTORY_REPOS_ROOT points elsewhere (a runtime serving another checkout —
 * and the hook that makes these tests hermetic instead of depending on
 * whichever repos happen to exist on the machine).
 */
export function reposRoot() {
  return process.env.FACTORY_REPOS_ROOT || FACTORY_ROOT;
}

export function reposConfigPath(root = reposRoot()) {
  return resolveConfigPath("repos", { root });
}

const IN_REPO_CONFIG_PATHS = [".factory.yaml", ".factory/config.yaml"];
/**
 * Keys the host registry owns outright. An in-repo file may never set them:
 * `verify` and `security` are inputs to commands the host executes against a
 * PR's own checkout, so a PR that could author them could weaken its own
 * verification or secret scan; `max_in_flight` and `control_plane` are host
 * scheduling and routing controls (#1638 review).
 */
export const IN_REPO_HOST_OWNED_KEYS = Object.freeze([
  "verify",
  "security",
  "max_in_flight",
  "control_plane",
]);
const IN_REPO_CONFIG_SCHEMA_PATH = new URL(
  "../schemas/repo-config.schema.json",
  import.meta.url,
);
let inRepoConfigSchema;
const inRepoConfigCache = new Map();
const ignoredInRepoConfigWarnings = new Map();

/** Clear in-repo config and warning caches, primarily for isolated tests. */
export function resetInRepoConfigCache() {
  inRepoConfigCache.clear();
  ignoredInRepoConfigWarnings.clear();
}

function inRepoConfigCandidatePaths(repoRoot) {
  return IN_REPO_CONFIG_PATHS.map((relative) =>
    path.resolve(repoRoot, relative),
  );
}

/** Remove cached overlays and warnings for repos absent from the registry. */
function pruneInRepoConfigCaches(repoRoots) {
  const configuredFiles = new Set(
    repoRoots.flatMap((repoRoot) => inRepoConfigCandidatePaths(repoRoot)),
  );
  for (const file of inRepoConfigCache.keys()) {
    if (!configuredFiles.has(file)) inRepoConfigCache.delete(file);
  }
  for (const [key, warning] of ignoredInRepoConfigWarnings) {
    if (!warning.files.some((file) => configuredFiles.has(file))) {
      ignoredInRepoConfigWarnings.delete(key);
    }
  }
}

function repoConfigSchema() {
  if (inRepoConfigSchema) return inRepoConfigSchema;
  try {
    inRepoConfigSchema = JSON.parse(
      readFileSync(IN_REPO_CONFIG_SCHEMA_PATH, "utf8"),
    );
  } catch (error) {
    throw new RepoError(
      `cannot load built-in factory.repo/v1 schema: ${error.message}`,
    );
  }
  return inRepoConfigSchema;
}

const hasOwn = (value, key) =>
  value !== null &&
  typeof value === "object" &&
  Object.prototype.hasOwnProperty.call(value, key);

function validateInRepoConfigSemantics(config, file) {
  normalizeToolchain(config.toolchain, "in-repo config", file);
  normalizeOwnedPathsPolicy(config.owned_paths_policy, "in-repo config", file);

  if (config.merge_ci !== undefined && config.merge_ci !== null) {
    const { workflow, required_checks: requiredChecks } = config.merge_ci;
    if (new Set(requiredChecks).size !== requiredChecks.length) {
      throw new RepoError(
        `${file}: in-repo config merge_ci.required_checks must be unique`,
      );
    }
    if (!workflow.trim() || requiredChecks.some((check) => !check.trim())) {
      throw new RepoError(
        `${file}: in-repo config merge_ci values must be non-empty`,
      );
    }
  }
}

/**
 * Read portable repository policy from the checkout itself.
 *
 * A repository may use either the root-level shorthand or the namespaced
 * location, never both. Missing files are the legacy/host-only case and return
 * null; malformed or ambiguous declarations fail closed before host overlay.
 */
export function loadInRepoConfig(repoRoot = process.cwd()) {
  const candidatePaths = inRepoConfigCandidatePaths(repoRoot);
  const candidates = candidatePaths.map((file) => {
    const stat = statSync(file, { throwIfNoEntry: false });
    if (!stat) {
      inRepoConfigCache.delete(file);
      return null;
    }
    return { file, mtimeMs: stat.mtimeMs, size: stat.size };
  });
  const files = candidates.filter(Boolean);
  const fingerprint = candidates
    .map((candidate) =>
      candidate
        ? `${candidate.file}:${candidate.mtimeMs}:${candidate.size}`
        : "missing",
    )
    .join("|");
  if (files.length === 0) return null;
  if (files.length > 1) {
    const error = new RepoError(
      `${repoRoot}: both .factory.yaml and .factory/config.yaml exist; keep exactly one in-repo config`,
    );
    error.inRepoConfigFingerprint = fingerprint;
    error.inRepoConfigPaths = candidatePaths;
    throw error;
  }

  const { file, mtimeMs, size } = files[0];
  const cached = inRepoConfigCache.get(file);
  if (cached?.mtimeMs === mtimeMs && cached.size === size) {
    if (cached.error) throw cached.error;
    return cached.config;
  }

  try {
    const parsed = Bun.YAML.parse(readFileSync(file, "utf8"));
    const hostOwned = IN_REPO_HOST_OWNED_KEYS.filter((key) =>
      hasOwn(parsed, key),
    );
    if (hostOwned.length > 0) {
      throw new RepoError(
        `${file}: in-repo config may not set host-owned ${hostOwned
          .map((key) => `"${key}"`)
          .join(
            ", ",
          )}; the host repos.yaml owns ${IN_REPO_HOST_OWNED_KEYS.join(", ")}`,
      );
    }
    const result = validate(repoConfigSchema(), parsed);
    if (!result.valid) {
      throw new RepoError(
        `${file}: invalid factory.repo/v1 config: ${result.errors.join("; ")}`,
      );
    }
    validateInRepoConfigSemantics(parsed, file);
    inRepoConfigCache.set(file, { mtimeMs, size, config: parsed });
    return parsed;
  } catch (error) {
    const wrapped =
      error instanceof RepoError
        ? error
        : new RepoError(`${file}: invalid YAML: ${error.message}`);
    wrapped.inRepoConfigFingerprint = fingerprint;
    wrapped.inRepoConfigPaths = candidatePaths;
    inRepoConfigCache.set(file, { mtimeMs, size, error: wrapped });
    throw wrapped;
  }
}

function warnInRepoConfigIgnored(repoName, error) {
  const key = `${repoName}\u0000${error.message}`;
  const fingerprint = error.inRepoConfigFingerprint;
  if (ignoredInRepoConfigWarnings.get(key)?.fingerprint === fingerprint) return;
  ignoredInRepoConfigWarnings.set(key, {
    fingerprint,
    files: error.inRepoConfigPaths ?? [],
  });
  console.warn(
    `warning: repo ${repoName}: in-repo config ignored, host config applies: ${error.message}`,
  );
}

/**
 * Overlay repository-owned policy onto one host registry entry.
 *
 * Host identity and infrastructure stay intact. In-repo values own the
 * portable fields, escalate paths are a stable union, and every
 * IN_REPO_HOST_OWNED_KEYS entry always comes from the host — even for direct
 * callers that bypass loadInRepoConfig's rejection.
 */
export function mergeRepoConfig(hostConfig, inRepoConfig) {
  if (inRepoConfig === null || inRepoConfig === undefined) {
    return { ...hostConfig };
  }

  const { schemaVersion: _schemaVersion, worktree, ...portable } = inRepoConfig;
  const merged = { ...hostConfig, ...portable };

  if (hasOwn(inRepoConfig, "escalate_paths")) {
    const hostPaths = hostConfig.escalate_paths;
    const repoPaths = inRepoConfig.escalate_paths;
    if (Array.isArray(hostPaths) && Array.isArray(repoPaths)) {
      merged.escalate_paths = [...new Set([...hostPaths, ...repoPaths])];
    } else if (
      (hostPaths === undefined || hostPaths === null) &&
      Array.isArray(repoPaths)
    ) {
      merged.escalate_paths = [...repoPaths];
    } else {
      // Preserve malformed host policy as malformed. loadRepos projects it to
      // null so the planner's escalate-path gate refuses to evaluate it.
      merged.escalate_paths = hostPaths;
    }
  }

  if (hasOwn(inRepoConfig, "worktree") && worktree === null) {
    // An omitted worktree block inherits the host lifecycle. Explicit null is
    // an overlay value like the other nullable portable fields: it removes
    // every inherited lifecycle script without affecting host worktree_root.
    merged.worktree_up = null;
    merged.worktree_down = null;
    merged.worktree_warm = null;
  } else if (worktree && typeof worktree === "object") {
    for (const [nested, flat] of [
      ["up", "worktree_up"],
      ["down", "worktree_down"],
      ["warm", "worktree_warm"],
    ]) {
      if (hasOwn(worktree, nested)) merged[flat] = worktree[nested];
    }
  }

  for (const hostOnly of IN_REPO_HOST_OWNED_KEYS) {
    if (hasOwn(hostConfig, hostOnly)) merged[hostOnly] = hostConfig[hostOnly];
    else delete merged[hostOnly];
  }
  return merged;
}

/** Expand a leading ~ the way the config files write paths. */
export function expandHome(p) {
  if (typeof p !== "string") return p;
  if (p === "~") return process.env.HOME ?? p;
  if (p.startsWith("~/")) return path.join(process.env.HOME ?? "", p.slice(2));
  return p;
}

function normalizeOwnedPathsPolicy(raw = {}, repoName, file) {
  if (raw === null || raw === undefined) {
    return { direct: [], pinManifests: [] };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new RepoError(
      `${file}: repo ${repoName} owned_paths_policy must be an object`,
    );
  }

  const unknown = Object.keys(raw).filter(
    (key) => !["direct", "pin_manifests", "registry_digest"].includes(key),
  );
  if (unknown.length) {
    throw new RepoError(
      `${file}: repo ${repoName} owned_paths_policy has unknown keys (${unknown.join(", ")})`,
    );
  }

  const direct = [];
  if (raw.direct !== undefined) {
    if (!Array.isArray(raw.direct)) {
      throw new RepoError(
        `${file}: repo ${repoName} owned_paths_policy.direct must be an array`,
      );
    }
    for (const rule of raw.direct) {
      if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
        throw new RepoError(
          `${file}: repo ${repoName} owned_paths_policy.direct entries must be objects`,
        );
      }
      if (typeof rule.source !== "string" || !rule.source.trim()) {
        throw new RepoError(
          `${file}: repo ${repoName} owned_paths_policy.direct.source must be a non-empty string`,
        );
      }
      if (!Array.isArray(rule.requires) || rule.requires.length === 0) {
        throw new RepoError(
          `${file}: repo ${repoName} owned_paths_policy.direct.requires must be a non-empty array`,
        );
      }
      if (
        !rule.requires.every((req) => typeof req === "string" && req.trim())
      ) {
        throw new RepoError(
          `${file}: repo ${repoName} owned_paths_policy.direct.requires must contain only non-empty strings`,
        );
      }
      direct.push({
        source: rule.source.trim(),
        requires: rule.requires.map((req) => req.trim()),
      });
    }
  }

  const pinManifests = [];
  if (raw.pin_manifests !== undefined) {
    if (!Array.isArray(raw.pin_manifests)) {
      throw new RepoError(
        `${file}: repo ${repoName} owned_paths_policy.pin_manifests must be an array`,
      );
    }
    for (const manifest of raw.pin_manifests) {
      if (typeof manifest !== "string" || !manifest.trim()) {
        throw new RepoError(
          `${file}: repo ${repoName} owned_paths_policy.pin_manifests must contain only non-empty strings`,
        );
      }
      pinManifests.push(manifest.trim());
    }
  }

  let registryDigest;
  if (raw.registry_digest !== undefined) {
    const digest = raw.registry_digest;
    if (!digest || typeof digest !== "object" || Array.isArray(digest)) {
      throw new RepoError(
        `${file}: repo ${repoName} owned_paths_policy.registry_digest must be an object`,
      );
    }
    const unknownDigestKeys = Object.keys(digest).filter(
      (key) => !["inputs", "baseline"].includes(key),
    );
    if (unknownDigestKeys.length) {
      throw new RepoError(
        `${file}: repo ${repoName} owned_paths_policy.registry_digest has unknown keys (${unknownDigestKeys.join(", ")})`,
      );
    }
    if (!Array.isArray(digest.inputs) || digest.inputs.length === 0) {
      throw new RepoError(
        `${file}: repo ${repoName} owned_paths_policy.registry_digest.inputs must be a non-empty array`,
      );
    }
    if (
      !digest.inputs.every((input) => typeof input === "string" && input.trim())
    ) {
      throw new RepoError(
        `${file}: repo ${repoName} owned_paths_policy.registry_digest.inputs must contain only non-empty strings`,
      );
    }
    if (typeof digest.baseline !== "string" || !digest.baseline.trim()) {
      throw new RepoError(
        `${file}: repo ${repoName} owned_paths_policy.registry_digest.baseline must be a non-empty string`,
      );
    }
    registryDigest = {
      inputs: digest.inputs.map((input) => input.trim()),
      baseline: digest.baseline.trim(),
    };
  }

  return registryDigest
    ? { direct, pinManifests, registryDigest }
    : { direct, pinManifests };
}

// ---------------------------------------------------------------- toolchain ---
// WM-316 (docs/event-runtime-repos.md §5). A repo declares the executables its
// worktree script and verify command need, and the version range each must
// satisfy. Preflight *validates* — it never installs, upgrades, or otherwise
// mutates host tooling (§10, "Toolchain preflight validates; it does not
// install or mutate host tooling"). The point is to move "node 18 cannot run
// this repo" from mid-run, after a claim burned a slot, to before the claim.

/** Typed readiness outcomes from docs/event-runtime-repos.md §6.3. */
export const REPO_TOOLCHAIN_MISSING = "repo_toolchain_missing";
export const REPO_TOOLCHAIN_MISMATCH = "repo_toolchain_mismatch";
export const REPO_ATTESTATION_STALE = "repo_attestation_stale";

/**
 * How long a toolchain attestation stays current. Deliberately short: the
 * attestation is a claim about another process's disk, and a version manager
 * can move `node` under us between two runs. Freshness is defence in depth,
 * not the only gate — the config hash invalidates it too.
 */
export const TOOLCHAIN_ATTESTATION_MAX_AGE_MS = 60 * 60 * 1000;

/** Bumped when the meaning of an attestation changes; old ones then read stale. */
export const TOOLCHAIN_PREFLIGHT_VERSION = 1;

/** A probe is one `<exe> --version` and nothing else. */
export const TOOLCHAIN_VERSION_ARG = "--version";
const TOOLCHAIN_PROBE_TIMEOUT_MS = 10_000;

/**
 * A bare command name, resolved on PATH. Not a path, not a shell fragment:
 * the executable is spawned argv-style with no shell, and anything carrying a
 * separator, a space, or a metacharacter is a configuration error rather than
 * something to sanitize at spawn time.
 */
const TOOLCHAIN_EXECUTABLE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/**
 * One constrained comparator of a semver range: an optional operator followed
 * by a numeric or numeric-leading partial version (`>=22`, `^1.2.3`, `1.x`).
 * The canonical whole-range wildcard (`*`) is handled separately so wildcard
 * lookalikes cannot accidentally become always-pass constraints.
 */
const SEMVER_COMPARATOR =
  /^(?:[<>]=?|=|\^|~)?v?\d+(?:\.(?:\d+|[xX*]))?(?:\.(?:\d+|[xX*]))?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Whether a string is a semver range this implementation will evaluate.
 *
 * This exists because `Bun.semver.satisfies` is fail-OPEN on a malformed
 * range: `satisfies("1.2.3", "not a range")` returns true. A gate whose
 * unparseable constraint silently passes everything is worse than no gate, so
 * ranges are validated at config load and a bad one is a load error.
 */
export function isToolchainConstraint(constraint) {
  if (typeof constraint !== "string") return false;
  // node-semver allows whitespace between an operator and its version
  // (`>= 1.2.3`), so collapse it before tokenizing. A false reject here is
  // louder than a missed constraint: this throws inside `loadRepos`, which
  // would take down every command that reads the registry, not just the repo
  // with the odd spelling.
  const trimmed = constraint.trim().replace(/([<>]=?|=|\^|~)\s+/g, "$1");
  if (!trimmed) return false;
  // Deliberate policy: `*` means the executable must exist but any parsed
  // version passes. It is the only accepted spelling of a whole-range
  // wildcard; keeping it out of SEMVER_COMPARATOR rejects Bun's always-pass
  // interpretations of `<*`, `X`, `v*`, `*.2.3`, and similar lookalikes.
  if (trimmed === "*") return true;
  for (const clause of trimmed.split("||")) {
    const tokens = clause.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return false;
    // `A - B` hyphen range: exactly two comparators around a lone hyphen.
    if (tokens.includes("-")) {
      if (tokens.length !== 3 || tokens[1] !== "-") return false;
      // Hyphen endpoints are versions, not comparator expressions.
      if (/^[<>=^~]/.test(tokens[0]) || /^[<>=^~]/.test(tokens[2])) {
        return false;
      }
      if (!SEMVER_COMPARATOR.test(tokens[0])) return false;
      if (!SEMVER_COMPARATOR.test(tokens[2])) return false;
      continue;
    }
    // Toolchain policy admits a single version/comparator or a conventional
    // two-sided comparator set. Bare token lists and three-way sets are easy
    // to misread and have surprising cross-engine semantics.
    if (tokens.length > 2) return false;
    if (
      tokens.length === 2 &&
      !tokens.every((token) => /^(?:[<>]=?|=|\^|~)/.test(token))
    ) {
      return false;
    }
    if (!tokens.every((token) => SEMVER_COMPARATOR.test(token))) return false;
  }
  return true;
}

/**
 * Parse `toolchain:` into a canonical `[{executable, constraint}]` list.
 *
 * Two spellings are accepted because the design doc writes the map form
 * (`bun: ">=1.3 <2"`) and it reads well for the common case, while the list
 * form is explicit and survives a future per-entry field. They normalize to
 * the same thing; the list is what everything downstream sees.
 *
 * Absent/null returns null — "not declared" — which is what keeps this change
 * additive for every repo that has no block.
 */
export function normalizeToolchain(raw, repoName, file) {
  if (raw === undefined || raw === null) return null;

  /** @type {Array<[unknown, unknown]>} */
  let pairs;
  if (Array.isArray(raw)) {
    pairs = raw.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new RepoError(
          `${file}: repo ${repoName} toolchain entries must be objects with executable and constraint`,
        );
      }
      const unknown = Object.keys(item).filter(
        (key) => !["executable", "constraint"].includes(key),
      );
      if (unknown.length) {
        throw new RepoError(
          `${file}: repo ${repoName} toolchain entry has unknown keys (${unknown.join(", ")})`,
        );
      }
      return [item.executable, item.constraint];
    });
  } else if (typeof raw === "object") {
    pairs = Object.entries(raw);
  } else {
    throw new RepoError(
      `${file}: repo ${repoName} toolchain must be a map of executable to constraint, or a list of {executable, constraint}`,
    );
  }

  const seen = new Set();
  const toolchain = [];
  for (const [rawExecutable, rawConstraint] of pairs) {
    const executable =
      typeof rawExecutable === "string" ? rawExecutable.trim() : "";
    if (!TOOLCHAIN_EXECUTABLE.test(executable)) {
      throw new RepoError(
        `${file}: repo ${repoName} toolchain executable must be a bare command name, got ${JSON.stringify(rawExecutable)}`,
      );
    }
    if (seen.has(executable)) {
      throw new RepoError(
        `${file}: repo ${repoName} declares toolchain executable ${JSON.stringify(executable)} twice`,
      );
    }
    seen.add(executable);
    if (!isToolchainConstraint(rawConstraint)) {
      throw new RepoError(
        `${file}: repo ${repoName} toolchain constraint for ${JSON.stringify(executable)} must be a semver range ("*" is the only canonical any-version form), got ${JSON.stringify(rawConstraint)}`,
      );
    }
    toolchain.push({ executable, constraint: rawConstraint.trim() });
  }
  return toolchain;
}

/**
 * A **dotted** version token: `1.2`, `1.2.3`, `1.3.0-canary.1`, with an
 * optional prefix glued to it so `go1.22.0` reads as `1.22.0`.
 *
 * The dot is load-bearing. An earlier version of this accepted any bare
 * integer anywhere in the line, which manufactured a version out of ordinary
 * error output — `"Error 404: not found"` became `404.0.0`, and
 * `satisfies("404.0.0", ">=1.3")` is **true**. A tool that exits 0 and prints
 * a non-version line would have silently passed a loose constraint: the same
 * fail-open hazard `isToolchainConstraint` exists to close, one field over.
 *
 * The leading `(?<![\d.])` and trailing `(?![\d.])` keep the token whole, so
 * an IPv4 address (`10.0.0.1`) or a four-part build number matches nothing
 * rather than yielding a plausible-looking prefix.
 */
const VERSION_TOKEN =
  /(?<![\d.])v?(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?![\d.])/;

/**
 * Extract a comparable version from whatever a tool prints. `node --version`
 * says `v22.1.0`, `git --version` says `git version 2.39.5 (Apple Git-154)`,
 * `go version` says `go version go1.22.0 darwin/arm64`, `bun --version` says
 * `1.2.23`. Only the first non-empty line is considered, and a partial version
 * is widened to x.y.z so semver can compare it.
 *
 * Anything that is not a dotted version token is null — including a stray
 * integer inside an error message. The one exception is a line that is
 * *nothing but* an integer (`22`), which is unambiguous. Null fails closed:
 * the constraint cannot be proven, so the repo is not ready.
 */
export function normalizeToolVersion(raw) {
  if (typeof raw !== "string") return null;
  const line = raw.split("\n").find((candidate) => candidate.trim());
  if (!line) return null;
  const trimmed = line.trim();

  const match = trimmed.match(VERSION_TOKEN);
  if (match) {
    const [, major, minor, patch = "0", prerelease] = match;
    const base = `${Number(major)}.${Number(minor)}.${Number(patch)}`;
    return prerelease ? `${base}-${prerelease}` : base;
  }
  // A bare integer counts only when it is the entire line. `bun --version`
  // could legitimately print `2`; `Segmentation fault: 11` must not.
  if (/^\d+$/.test(trimmed)) return `${Number(trimmed)}.0.0`;
  return null;
}

/** Stable fingerprint of a repo's declared toolchain; a change invalidates attestations. */
export function toolchainHash(toolchain) {
  const canonical = JSON.stringify(
    (toolchain ?? []).map(({ executable, constraint }) => [
      executable,
      constraint,
    ]),
  );
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function satisfiesConstraint(version, constraint) {
  if (!version) return false;
  try {
    return Bun.semver.satisfies(version, constraint) === true;
  } catch {
    return false;
  }
}

/** Default PATH resolution. Injectable so tests never depend on the host. */
async function defaultWhich(executable) {
  return Bun.which(executable) ?? null;
}

/** Synchronous counterpart for the planner's deterministic admission path. */
function defaultWhichSync(executable) {
  return Bun.which(executable) ?? null;
}

/**
 * Default probe: run the resolved executable with exactly one argument,
 * `--version`, with no shell and no inherited stdin. This is the only
 * subprocess toolchain preflight ever starts.
 */
async function defaultSpawn(argv) {
  const proc = Bun.spawn(argv, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: TOOLCHAIN_PROBE_TIMEOUT_MS,
  });
  // A timeout can abort one of the pipe reads before its sibling has drained.
  // Preserve whatever was read and turn the probe into a normal failed result
  // so the caller can attest the tool instead of losing the whole preflight.
  const [stdoutResult, stderrResult, exitCodeResult] = await Promise.allSettled(
    [
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ],
  );
  return {
    exitCode:
      exitCodeResult.status === "fulfilled" ? exitCodeResult.value : null,
    stdout: stdoutResult.status === "fulfilled" ? stdoutResult.value : "",
    stderr: stderrResult.status === "fulfilled" ? stderrResult.value : "",
  };
}

/**
 * Synchronous version probe for planner admission. Keep its result shape
 * identical to defaultSpawn so both preflight variants produce the same typed
 * attestation. `spawnSync` enforces the same bounded probe timeout.
 */
function defaultSpawnSync(argv) {
  const result = spawnSync(argv[0], argv.slice(1), {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: TOOLCHAIN_PROBE_TIMEOUT_MS,
  });
  if (result.error) throw result.error;
  return {
    exitCode: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function probeErrorMessage(error) {
  const message = error?.message;
  return typeof message === "string" && message.trim()
    ? message
    : String(error);
}

function failedToolchainProbe({
  node,
  repo,
  executable,
  constraint,
  resolved,
  error,
  detail,
}) {
  const observedRaw = probeErrorMessage(error);
  return {
    tool: {
      executable,
      constraint,
      resolved,
      observed: null,
      observedRaw,
      satisfied: false,
    },
    reason: {
      reason: REPO_TOOLCHAIN_MISSING,
      node,
      repo,
      executable,
      constraint,
      observed: null,
      observedRaw,
      detail,
      action: `check that ${executable} is present and executable on ${node}, then re-run toolchain preflight for repo ${repo}`,
    },
  };
}

/**
 * Typed result for a tool `which` could not find on PATH. The reason's action
 * differs from a failed probe: the operator installs, not investigates.
 */
function missingToolchainProbe({ node, repo, executable, constraint }) {
  return {
    tool: {
      executable,
      constraint,
      resolved: null,
      observed: null,
      observedRaw: null,
      satisfied: false,
    },
    reason: {
      reason: REPO_TOOLCHAIN_MISSING,
      node,
      repo,
      executable,
      constraint,
      observed: null,
      action: `install ${executable} ${constraint} on ${node}, or drop it from repo ${repo}'s toolchain in config/repos.yaml`,
    },
  };
}

/**
 * Turn one `--version` probe result into its typed tool record and, when the
 * constraint is not satisfied, its mismatch reason. Shared by the async and
 * sync preflights so both attest identically.
 */
function probedToolchainTool({
  node,
  repo,
  executable,
  constraint,
  resolved,
  probe,
}) {
  const { exitCode, stdout, stderr } = probe;
  const output = stdout?.trim() ? stdout : (stderr ?? "");
  const observedRaw =
    output
      .split("\n")
      .find((line) => line.trim())
      ?.trim() ?? null;
  const observed = exitCode === 0 ? normalizeToolVersion(output) : null;
  const satisfied = satisfiesConstraint(observed, constraint);
  const tool = {
    executable,
    constraint,
    resolved,
    observed,
    observedRaw,
    satisfied,
  };
  if (satisfied) return { tool, reason: null };
  return {
    tool,
    reason: {
      reason: REPO_TOOLCHAIN_MISMATCH,
      node,
      repo,
      executable,
      constraint,
      // The observed version is the whole point of the payload: without it the
      // operator still has to go to the node to find out what is installed.
      observed,
      observedRaw,
      detail:
        exitCode !== 0
          ? "version_probe_failed"
          : observed === null
            ? "unparseable_version"
            : "constraint_unsatisfied",
      action: `make ${executable} ${constraint} the resolved version on ${node} (observed ${observed ?? observedRaw ?? "nothing"}), or relax repo ${repo}'s constraint in config/repos.yaml`,
    },
  };
}

/** Assemble the attestation both preflight variants return. */
function toolchainAttestation({ repo, node, now, toolchain, tools, reasons }) {
  return {
    repo: repo?.name ?? null,
    node,
    implementationVersion: TOOLCHAIN_PREFLIGHT_VERSION,
    toolchainHash: toolchainHash(toolchain),
    declared: toolchain !== null,
    verifiedAt: now().toISOString(),
    ok: reasons.length === 0,
    tools,
    reasons,
  };
}

/**
 * Verify one node's tooling against a repo's declared constraints and return
 * an attestation (docs/event-runtime-repos.md §6.2).
 *
 * Non-mutating by construction: the only command built here is
 * `[resolved, "--version"]` — the PATH-resolved path from `which`, so the
 * version reported is provably from the binary the attestation names. There is
 * no install, upgrade, or version-manager
 * path, and adding one would be reopening a §10 decision.
 *
 * A repo with nothing declared is attested `ok` without probing anything —
 * that is what makes this additive for repos that have no `toolchain:` block.
 */
export async function preflightToolchain(
  repo,
  {
    node = "local",
    now = () => new Date(),
    which = defaultWhich,
    spawn = defaultSpawn,
  } = {},
) {
  const toolchain = repo?.toolchain ?? null;
  const tools = [];
  const reasons = [];
  const record = ({ tool, reason }) => {
    tools.push(tool);
    if (reason) reasons.push(reason);
  };

  for (const { executable, constraint } of toolchain ?? []) {
    const probeContext = { node, repo: repo.name, executable, constraint };
    let resolved;
    try {
      resolved = await which(executable);
    } catch (error) {
      record(
        failedToolchainProbe({
          ...probeContext,
          resolved: null,
          error,
          detail: "which_failed",
        }),
      );
      continue;
    }
    if (!resolved) {
      record(missingToolchainProbe(probeContext));
      continue;
    }

    let probe;
    try {
      probe = await spawn([resolved, TOOLCHAIN_VERSION_ARG]);
    } catch (error) {
      record(
        failedToolchainProbe({
          ...probeContext,
          resolved,
          error,
          detail: "version_probe_threw",
        }),
      );
      continue;
    }
    record(probedToolchainTool({ ...probeContext, resolved, probe }));
  }

  return toolchainAttestation({ repo, node, now, toolchain, tools, reasons });
}

/**
 * Synchronous form of preflightToolchain for the planner. Planning is
 * deliberately synchronous; returning the same attestation shape keeps the
 * admission decision typed without turning planEvent into an async API.
 */
export function preflightToolchainSync(
  repo,
  {
    node = "local",
    now = () => new Date(),
    which = defaultWhichSync,
    spawn = defaultSpawnSync,
  } = {},
) {
  const toolchain = repo?.toolchain ?? null;
  const tools = [];
  const reasons = [];
  const record = ({ tool, reason }) => {
    tools.push(tool);
    if (reason) reasons.push(reason);
  };

  for (const { executable, constraint } of toolchain ?? []) {
    const probeContext = { node, repo: repo.name, executable, constraint };
    let resolved;
    try {
      resolved = which(executable);
    } catch (error) {
      record(
        failedToolchainProbe({
          ...probeContext,
          resolved: null,
          error,
          detail: "which_failed",
        }),
      );
      continue;
    }
    if (!resolved) {
      record(missingToolchainProbe(probeContext));
      continue;
    }

    let probe;
    try {
      probe = spawn([resolved, TOOLCHAIN_VERSION_ARG]);
    } catch (error) {
      record(
        failedToolchainProbe({
          ...probeContext,
          resolved,
          error,
          detail: "version_probe_threw",
        }),
      );
      continue;
    }
    record(probedToolchainTool({ ...probeContext, resolved, probe }));
  }

  return toolchainAttestation({ repo, node, now, toolchain, tools, reasons });
}

/** Does this attestation still describe this repo on this node, recently enough? */
export function toolchainAttestationCurrent(
  attestation,
  repo,
  {
    node = "local",
    now = () => new Date(),
    maxAgeMs = TOOLCHAIN_ATTESTATION_MAX_AGE_MS,
  } = {},
) {
  if (!attestation) return { current: false, detail: "absent" };
  if (attestation.implementationVersion !== TOOLCHAIN_PREFLIGHT_VERSION) {
    return { current: false, detail: "implementation_changed" };
  }
  if (attestation.repo !== repo?.name) {
    return { current: false, detail: "repo_changed" };
  }
  if (attestation.node !== node)
    return { current: false, detail: "node_changed" };
  if (attestation.toolchainHash !== toolchainHash(repo?.toolchain ?? null)) {
    return { current: false, detail: "config_changed" };
  }
  const verifiedAt = Date.parse(attestation.verifiedAt ?? "");
  if (!Number.isFinite(verifiedAt)) {
    return { current: false, detail: "unverifiable_timestamp" };
  }
  if (now().getTime() - verifiedAt > maxAgeMs) {
    return { current: false, detail: "expired" };
  }
  return { current: true, detail: null };
}

/**
 * Is this repo dispatchable on this node, given an attestation?
 *
 * The readiness table at docs/event-runtime-repos.md §1 makes `ready` mean
 * "has a current attestation", so a stale attestation is not-ready even when
 * its last result was green. A repo that declares nothing is ready without an
 * attestation: there is nothing to attest, and the nine repos in production
 * today declare nothing.
 */
export function repoReadiness({
  repo,
  attestation = null,
  node = "local",
  now = () => new Date(),
  maxAgeMs = TOOLCHAIN_ATTESTATION_MAX_AGE_MS,
} = {}) {
  if (!repo?.toolchain?.length) {
    return { ready: true, attested: false, reasons: [], refusal: null };
  }
  const { current, detail } = toolchainAttestationCurrent(attestation, repo, {
    node,
    now,
    maxAgeMs,
  });
  if (!current) {
    return {
      ready: false,
      attested: false,
      reasons: [
        {
          reason: REPO_ATTESTATION_STALE,
          node,
          repo: repo.name,
          detail,
          // Must be runnable: `bin/factory` has no `repo` subcommand, so the
          // repo-scoped `factory repo doctor <name>` the design sketches does
          // not exist yet. Name what exists and what is pending.
          action: `re-run toolchain preflight for repo ${repo.name} on ${node} — \`factory doctor\` reports the mismatch`,
        },
      ],
      refusal: `repo ${repo.name} has no current toolchain attestation on ${node} (${detail})`,
    };
  }
  if (!attestation.ok) {
    // Tolerate a malformed attestation rather than throwing. WM-317 persists
    // and reloads these, and once #1096 puts this on the pre-claim path a
    // throw would stall dispatch where a refusal merely skips one repo.
    const reasons = Array.isArray(attestation.reasons)
      ? attestation.reasons
      : [];
    return {
      ready: false,
      attested: true,
      reasons,
      refusal: refusalLine(repo, node, reasons),
    };
  }
  return { ready: true, attested: true, reasons: [], refusal: null };
}

/** One line an operator can act on, naming every failing constraint. */
function refusalLine(repo, node, reasons) {
  if (!Array.isArray(reasons) || reasons.length === 0) {
    return `repo ${repo.name} toolchain preflight failed on ${node} with no recorded reason — re-run preflight`;
  }
  const failures = reasons.map((r) =>
    r.reason === REPO_TOOLCHAIN_MISSING
      ? `${r.executable} ${r.constraint} (not found)`
      : `${r.executable} ${r.constraint} (observed ${r.observed ?? r.observedRaw ?? "nothing"})`,
  );
  return `repo ${repo.name} toolchain preflight failed on ${node}: ${failures.join("; ")}`;
}

/**
 * The gate dispatch calls before claiming a ticket (WM-316 acceptance
 * criterion "dispatch consults readiness before claiming").
 *
 * Returns `{ready, reasons, refusal, attestation}`. A repo with no declared
 * toolchain short-circuits to ready without probing — no subprocess, no
 * latency, no behaviour change. Otherwise a current attestation is reused and
 * a stale or absent one triggers a fresh, non-mutating preflight.
 *
 * Wiring this into orchestrator/tick.mjs is deliberately a separate change
 * (#1096): tick.mjs is outside this ticket's Owned Paths.
 */
export async function repoDispatchPreflight(
  repo,
  {
    node = "local",
    attestation = null,
    now = () => new Date(),
    maxAgeMs = TOOLCHAIN_ATTESTATION_MAX_AGE_MS,
    which,
    spawn,
  } = {},
) {
  if (!repo?.toolchain?.length) {
    return {
      ready: true,
      attested: false,
      reasons: [],
      refusal: null,
      attestation: null,
    };
  }
  const { current } = toolchainAttestationCurrent(attestation, repo, {
    node,
    now,
    maxAgeMs,
  });
  const fresh = current
    ? attestation
    : await preflightToolchain(repo, { node, now, which, spawn });
  return {
    ...repoReadiness({ repo, attestation: fresh, node, now, maxAgeMs }),
    attestation: fresh,
  };
}

/**
 * Synchronous dispatch readiness gate for planEvent. It deliberately mirrors
 * repoDispatchPreflight's return contract so callers can use either boundary
 * without changing their refusal handling.
 */
export function repoDispatchPreflightSync(
  repo,
  {
    node = "local",
    attestation = null,
    now = () => new Date(),
    maxAgeMs = TOOLCHAIN_ATTESTATION_MAX_AGE_MS,
    which,
    spawn,
  } = {},
) {
  if (!repo?.toolchain?.length) {
    return {
      ready: true,
      attested: false,
      reasons: [],
      refusal: null,
      attestation: null,
    };
  }
  const { current } = toolchainAttestationCurrent(attestation, repo, {
    node,
    now,
    maxAgeMs,
  });
  const fresh = current
    ? attestation
    : preflightToolchainSync(repo, { node, now, which, spawn });
  return {
    ...repoReadiness({ repo, attestation: fresh, node, now, maxAgeMs }),
    attestation: fresh,
  };
}

/**
 * @returns {Map<string, {name: string, path: string, github: string|null, base: string,
 *                        deployBranch: string|null, team: string|null, project: string|null,
 *                        controlPlane: "linear"|"memory"|"github"|null,
 *                        reportOnly: boolean, maxInFlight: number|null, smokeDeadlineSeconds: number|null,
 *                        mergeCi: {workflow: string, requiredChecks: string[]}|null,
 *                        escalatePaths: string[]|null, smokeWorkflow: string|null, smokeUrl: string|null,
 *                        deployment: {url: string|null, branch: string|null, revisionField: string|null}|null,
 *                        security: {pythonVersion: string|number|null, semgrepArgs: string|null,
 *                        gitleaksArgs: string|null}|null,
 *                        worktreeRoot: string|null, worktreeUp: string|null, worktreeDown: string|null,
 *                        worktreeWarm: string|null, verify: string|null,
 *                        toolchain: Array<{executable: string, constraint: string}>|null,
 *                        ownedPathsPolicy: { direct: Array<{source: string, requires: string[]}>, pinManifests: string[] }}>
 */
export function loadRepos({ root = reposRoot() } = {}) {
  const file = reposConfigPath(root);
  if (!existsSync(file)) throw new RepoError(`no repos config at ${file}`);
  let parsed;
  try {
    parsed = Bun.YAML.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new RepoError(`${file}: invalid YAML: ${err.message}`);
  }
  pruneInRepoConfigCaches(
    (parsed?.repos ?? [])
      .filter((entry) => entry?.path)
      .map((entry) => expandHome(entry.path)),
  );
  const repos = new Map();
  for (const hostEntry of parsed?.repos ?? []) {
    if (!hostEntry?.name)
      throw new RepoError(`${file}: a repo entry has no name`);
    if (!hostEntry.path)
      throw new RepoError(`${file}: repo ${hostEntry.name} has no path`);
    // One checkout's malformed .factory.yaml must not take the whole registry
    // down (and every other repo's dispatch with it): skip that repo's overlay,
    // warn, and let the host entry stand on its own. Mirrors the escalate_paths
    // stance below — the strict check belongs to the repo it describes.
    let inRepoConfig = null;
    try {
      inRepoConfig = loadInRepoConfig(expandHome(hostEntry.path));
    } catch (err) {
      if (!(err instanceof RepoError)) throw err;
      warnInRepoConfigIgnored(hostEntry.name, err);
    }
    const entry = mergeRepoConfig(hostEntry, inRepoConfig);
    let maxInFlight = null;
    if (entry.max_in_flight !== undefined && entry.max_in_flight !== null) {
      if (
        typeof entry.max_in_flight !== "number" ||
        !Number.isFinite(entry.max_in_flight) ||
        entry.max_in_flight <= 0
      ) {
        throw new RepoError(
          `${file}: repo ${entry.name} max_in_flight must be a positive number, got ${JSON.stringify(entry.max_in_flight)}`,
        );
      }
      maxInFlight = entry.max_in_flight;
    }
    let smokeDeadlineSeconds = null;
    const rawSmokeDeadline =
      entry.smoke_deadline_seconds ?? entry.deployment?.smoke_deadline_seconds;
    if (rawSmokeDeadline !== undefined && rawSmokeDeadline !== null) {
      if (
        typeof rawSmokeDeadline !== "number" ||
        !Number.isFinite(rawSmokeDeadline) ||
        rawSmokeDeadline <= 0
      ) {
        throw new RepoError(
          `${file}: repo ${entry.name} smoke_deadline_seconds must be a positive number, got ${JSON.stringify(rawSmokeDeadline)}`,
        );
      }
      smokeDeadlineSeconds = rawSmokeDeadline;
    }
    let mergeCi = null;
    if (entry.merge_ci !== undefined && entry.merge_ci !== null) {
      const workflow = entry.merge_ci?.workflow;
      const requiredChecks = entry.merge_ci?.required_checks;
      const validWorkflow =
        typeof workflow === "string" && workflow.trim().length > 0;
      const validChecks =
        Array.isArray(requiredChecks) &&
        requiredChecks.length > 0 &&
        requiredChecks.every(
          (check) => typeof check === "string" && check.trim().length > 0,
        ) &&
        new Set(requiredChecks).size === requiredChecks.length;
      if (!validWorkflow || !validChecks) {
        throw new RepoError(
          `${file}: repo ${entry.name} merge_ci requires a nonempty workflow and unique nonempty required_checks`,
        );
      }
      mergeCi = { workflow, requiredChecks: [...requiredChecks] };
    }
    // Read-only projection for the view. A malformed list is NOT a load
    // error here: one repo's bad escalate_paths must not take the whole
    // registry down (and every other repo's dispatch with it). The strict,
    // fail-closed check stays where the gate is evaluated — the planner's
    // escalate_paths reader (planner.mjs, `escalate_paths_intersect` /
    // `escalate_paths_unverifiable`), at plan time, for that repo alone. Malformed → null, i.e. "not
    // declared / cannot be evaluated", which is exactly how the gate treats it.
    let escalatePaths = null;
    if (
      Array.isArray(entry.escalate_paths) &&
      entry.escalate_paths.every(
        (glob) => typeof glob === "string" && glob.trim().length > 0,
      )
    ) {
      escalatePaths = [...entry.escalate_paths];
    }
    let deployment = null;
    if (entry.deployment !== undefined && entry.deployment !== null) {
      if (
        typeof entry.deployment !== "object" ||
        Array.isArray(entry.deployment)
      ) {
        throw new RepoError(
          `${file}: repo ${entry.name} deployment must be an object`,
        );
      }
      deployment = {
        url: entry.deployment.url ?? null,
        branch: entry.deployment.branch ?? null,
        revisionField: entry.deployment.revision_field ?? null,
      };
    }
    const security = normalizeSecurity(entry.security, entry.name, file);
    // WM-1007: which tracker holds this repo's tickets. Absent means "inherit
    // config/policy.yaml", which is why the default is null and not "linear" —
    // a value here would state a choice this file never made, and would
    // silently outrank the policy for every repo that omitted the key.
    let controlPlane = null;
    if (entry.control_plane !== undefined && entry.control_plane !== null) {
      if (!CONTROL_PLANE_KINDS.includes(entry.control_plane)) {
        throw new RepoError(
          `${file}: repo ${entry.name} control_plane must be one of ${CONTROL_PLANE_KINDS.join(", ")}, got ${JSON.stringify(entry.control_plane)}`,
        );
      }
      controlPlane = entry.control_plane;
    }
    repos.set(entry.name, {
      name: entry.name,
      path: expandHome(entry.path),
      github: entry.github ?? null,
      base: entry.base ?? "main",
      deployBranch: entry.deploy_branch ?? null,
      team: entry.team ?? null,
      project: entry.project ?? null,
      controlPlane,
      // Absent means dispatchable: report_only is the guard a repo opts into,
      // so anything but an explicit `true` must read as false rather than
      // "maybe" — an operator reading "dispatch" off a null would be wrong.
      reportOnly: entry.report_only === true,
      // Null, not a default: the cap's fallback lives with the dispatcher, and
      // inventing a number here would state a limit this file never set.
      maxInFlight,
      smokeDeadlineSeconds,
      smokeWorkflow: entry.smoke_workflow ?? null,
      smokeUrl: entry.smoke_url ?? null,
      deployment,
      security,
      mergeCi,
      escalatePaths,
      worktreeRoot: entry.worktree_root
        ? expandHome(entry.worktree_root)
        : null,
      worktreeUp: entry.worktree_up ?? null,
      worktreeDown: entry.worktree_down ?? null,
      worktreeWarm: entry.worktree_warm ?? null,
      verify: entry.verify ?? null,
      // null means "no toolchain declared": no preflight, no gating, exactly
      // today's behaviour (WM-316).
      toolchain: normalizeToolchain(entry.toolchain, entry.name, file),
      ownedPathsPolicy: normalizeOwnedPathsPolicy(
        entry.owned_paths_policy,
        entry.name,
        file,
      ),
    });
  }
  return repos;
}

function normalizeSecurity(raw, repoName, file) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new RepoError(`${file}: repo ${repoName} security must be an object`);
  }

  const keys = ["python_version", "semgrep_args", "gitleaks_args"];
  const unknown = Object.keys(raw).filter((key) => !keys.includes(key));
  if (unknown.length) {
    throw new RepoError(
      `${file}: repo ${repoName} security has unknown keys (${unknown.join(", ")})`,
    );
  }

  for (const field of ["semgrep_args", "gitleaks_args"]) {
    if (raw[field] !== undefined && typeof raw[field] !== "string") {
      throw new RepoError(
        `${file}: repo ${repoName} security.${field} must be a string, got ${JSON.stringify(raw[field])}`,
      );
    }
  }
  if (
    raw.python_version !== undefined &&
    typeof raw.python_version !== "string" &&
    typeof raw.python_version !== "number"
  ) {
    throw new RepoError(
      `${file}: repo ${repoName} security.python_version must be a string or number, got ${JSON.stringify(raw.python_version)}`,
    );
  }

  return {
    pythonVersion: raw.python_version ?? null,
    semgrepArgs: raw.semgrep_args ?? null,
    gitleaksArgs: raw.gitleaks_args ?? null,
  };
}

/**
 * Resolve a filesystem target to its configured repo record. Worktrees live
 * outside their configured checkout, so an origin remote is a deliberate
 * fallback after the canonical realpath-prefix match.
 */
export function findRepoForPath(repos, target, { remote = null } = {}) {
  for (const repo of repos.values()) {
    let byPath = false;
    try {
      const repoPath = realpathSync(repo.path);
      byPath = target === repoPath || target.startsWith(repoPath + path.sep);
    } catch {
      /* A missing optional checkout must not prevent a remote match. */
    }
    if (byPath || (remote && repo.github === remote)) return repo;
  }
  return null;
}

/**
 * The repo registry as the control API serves it (OPS-299): one row per
 * repos.yaml entry, in file order.
 *
 * An explicit allow-list, not the parsed entry: repos.yaml also carries
 * credential-bearing settings and whatever the next policy field turns out to
 * be, and a passthrough would publish each new key the moment someone adds it.
 * Nothing here reads `.env` or any credential — these are paths, branches, and
 * commands the repo already documents.
 *
 * `hasWorktree*` are booleans rather than the script paths because that is the
 * question a reader has ("can the janitor tear this repo's worktrees down?");
 * the path itself is only meaningful to the process that executes it.
 */
export function reposView(repos) {
  return [...repos.values()].map((repo) => ({
    name: repo.name,
    path: repo.path,
    github: repo.github,
    team: repo.team,
    project: repo.project,
    // null means "inherits config/policy.yaml"; an explicit value means the
    // repo is pinned to that tracker. Distinguishable over the wire so an
    // operator can tell one from the other (gh-870).
    controlPlane: repo.controlPlane,
    base: repo.base,
    deployBranch: repo.deployBranch,
    reportOnly: repo.reportOnly,
    maxInFlight: repo.maxInFlight,
    effective: {
      maxInFlight: repo.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT,
      maxInFlightSource: repo.maxInFlight === null ? "default" : "repo",
    },
    smokeDeadlineSeconds: repo.smokeDeadlineSeconds,
    smokeWorkflow: repo.smokeWorkflow,
    smokeUrl: repo.smokeUrl,
    deployment: repo.deployment,
    security: repo.security,
    mergeCi: repo.mergeCi,
    escalatePaths: repo.escalatePaths,
    ownedPathsPolicy: repo.ownedPathsPolicy,
    worktreeRoot: repo.worktreeRoot,
    hasWorktreeUp: repo.worktreeUp !== null,
    hasWorktreeDown: repo.worktreeDown !== null,
    hasWorktreeWarm: repo.worktreeWarm !== null,
    verify: repo.verify,
    // Declared constraints only — observed versions belong to a node's
    // attestation, not the registry projection.
    toolchain: repo.toolchain ?? null,
  }));
}

export function getRepo(repos, name) {
  const repo = repos.get(name);
  if (!repo) {
    throw new RepoError(
      `repo "${name}" is not in config/repos.yaml (have: ${[...repos.keys()].join(", ") || "none"})`,
    );
  }
  return repo;
}

/**
 * The isolated-checkout target for an overlay promotion PR (gh-860).
 *
 * Promotion never edits the live checkout: it hands `worktree_up` a base and a
 * ticket branch, writes tracked defaults in that worktree, and opens a PR
 * against the configured base. This resolver fails closed when the repo does
 * not declare the machinery that isolation requires — a base branch, a
 * `worktree_up` script, and a GitHub slug for the forge — so an operator can
 * never accidentally promote onto the wrong branch or into the live root.
 *
 * @returns {{ name: string, path: string, base: string, github: string,
 *             worktreeUp: string, worktreeRoot: string|null }}
 */
export function resolvePromotionTarget(repos, name) {
  const repo = getRepo(repos, name);
  if (typeof repo.base !== "string" || repo.base.trim() === "") {
    throw new RepoError(`repo "${name}" has no base branch for promotion`);
  }
  if (typeof repo.worktreeUp !== "string" || repo.worktreeUp.trim() === "") {
    throw new RepoError(
      `repo "${name}" has no worktree_up script; promotion requires an isolated checkout`,
    );
  }
  if (typeof repo.github !== "string" || repo.github.trim() === "") {
    throw new RepoError(`repo "${name}" has no github slug for a promotion PR`);
  }
  return {
    name: repo.name,
    path: repo.path,
    base: repo.base,
    github: repo.github,
    worktreeUp: repo.worktreeUp,
    worktreeRoot: repo.worktreeRoot,
  };
}

/**
 * Select the merge gate without treating an empty branch-protection response
 * as green. GitHub-owned required contexts win whenever they are nonempty;
 * the repo-owned declaration is the only permitted fallback.
 */
export function selectMergeCheckGate(repo, githubRequiredContexts) {
  if (!Array.isArray(githubRequiredContexts)) {
    throw new RepoError("GitHub required contexts are unavailable");
  }
  const valid = githubRequiredContexts.every(
    (name) => typeof name === "string" && name.trim().length > 0,
  );
  if (
    !valid ||
    new Set(githubRequiredContexts).size !== githubRequiredContexts.length
  ) {
    throw new RepoError("GitHub required contexts are malformed or ambiguous");
  }
  if (githubRequiredContexts.length > 0) {
    return {
      source: "github",
      workflow: null,
      requiredChecks: [...githubRequiredContexts],
    };
  }
  if (!repo?.mergeCi) {
    throw new RepoError(
      "GitHub required contexts are empty and no merge_ci fallback is configured",
    );
  }
  return {
    source: "config",
    workflow: repo.mergeCi.workflow,
    requiredChecks: [...repo.mergeCi.requiredChecks],
  };
}

/**
 * Prove one completed-success record for every named gate at one exact SHA.
 * Duplicate matching records are ambiguous rather than "one of them passed".
 * Unnamed extra checks are irrelevant: the selected gate is deliberately an
 * exact allow-list, not a snapshot of whatever happened to be visible first.
 */
export function proveMergeChecks({
  expectedChecks,
  actualChecks,
  expectedSha,
  workflow = null,
}) {
  if (
    !Array.isArray(expectedChecks) ||
    expectedChecks.length === 0 ||
    !Array.isArray(actualChecks) ||
    typeof expectedSha !== "string" ||
    expectedSha.length === 0
  ) {
    throw new RepoError("merge check evidence is empty or malformed");
  }
  for (const name of expectedChecks) {
    const matches = actualChecks.filter((check) => check?.name === name);
    if (matches.length !== 1) {
      throw new RepoError(
        `required check ${JSON.stringify(name)} is missing or ambiguous`,
      );
    }
    const check = matches[0];
    if (
      check.headSha !== expectedSha ||
      check.status !== "completed" ||
      check.conclusion !== "success" ||
      (workflow !== null && check.workflow !== workflow)
    ) {
      throw new RepoError(
        `required check ${JSON.stringify(name)} is not green at the exact SHA`,
      );
    }
  }
  return true;
}
