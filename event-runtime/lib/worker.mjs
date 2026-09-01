/**
 * Single-worker execution with leases and fencing (docs/event-runtime.md §8).
 *
 * Delivery is at-least-once, never assumed exactly-once: a claim takes a
 * lease with a monotonic fencing token, an expired lease re-queues the run,
 * and only the attempt holding the run's highest token may publish a terminal
 * result. Storing an accepted result and its derived completion event is one
 * transaction via the outbox — an invalid or refused output emits no
 * completion event at all (§15 exit criterion). An operator cancelling a run
 * mid-flight surfaces here as IllegalTransition; the worker stops quietly,
 * publishing nothing.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { localNotifyOutboxPath } from "../../lib/notify.mjs";
import {
  LEASE_HEARTBEAT_MS,
  leaseDir,
  liveWorkerLeases,
  releaseWorkerLease,
  renewWorkerLease,
  writeWorkerLease,
} from "../../lib/worker-leases.mjs";
import { loadForge } from "../../lib/forge/index.mjs";
import { releaseLabels } from "../../lib/control-plane/labels.mjs";
import { storeCollected, storeResultArtifact } from "./artifacts.mjs";
import { canonicalJson, hashBytes, hashJson, sha256Hex } from "./canonical.mjs";
import { artifactsRoot, FACTORY_ROOT, resolveConfigPath } from "./config.mjs";
import { nextCounter, recordRunUsage, tx, txImmediate } from "./db.mjs";
import { getAgent } from "./registry.mjs";
import {
  definitionAgentName,
  filesystemConfinementRefusal,
  MODEL_BACKED_ADAPTERS,
  normalizeWorkspaceOnlyFallback,
  sandboxUnavailableCapability,
  workspaceOnlyHostFallback,
} from "./adapters/sandboxed.mjs";
import { isSandboxGuarded } from "./adapters/index.mjs";
import { preflight as sandboxPreflight } from "./sandbox/gondolin.mjs";
import { createRun, IllegalTransition, transition } from "./lifecycle.mjs";
import {
  buildEscalatedContinuationSpec,
  HARNESS_KINDS,
  HARNESS_NAME_PATTERN,
  worktreeDispatchAutoEligibility,
  worktreeMergeFixEligibility,
} from "./planner.mjs";
import { newRunId } from "./ids.mjs";
import { isTrustedAssociation } from "./triage.mjs";
import { closeOpenProposalForRun } from "./proposals.mjs";
import { computeDefHash, createReceipt, verifyDefHash } from "./receipts.mjs";
import { traceRecorder } from "./trace.mjs";
import {
  ContractViolation,
  composeHandoffVerification,
  HANDOFF_DEPENDENCIES_MISSING,
  HANDOFF_REASON_CODES,
  HANDOFF_SANDBOX_UNAVAILABLE,
  normalizeFailureOutput,
  RECOVERED_RESULT_REASON,
  verifyResult,
} from "./verify.mjs";
import {
  effectiveOwnedPaths,
  parseOwnedPaths,
  parseVerificationCommand,
} from "../../orchestrator/owned-paths.mjs";
import { HEARTBEAT_STALE_MS, satisfiesPlacement } from "./workers.mjs";
import {
  assertSandboxWorkspaceSupported,
  confinedRegularFile,
  createWorkspace,
  destroyWorkspace,
  PathViolation,
  safeJoin,
} from "./workspace.mjs";
import { createInboxItem } from "./inbox.mjs";
import { persistMergeReviewFromResult } from "./merge-reviews.mjs";
import { registerMemos } from "./memos.mjs";
import { templateFor } from "./decision-templates.mjs";
import { proposalReasonPlain } from "./proposal-subject.mjs";
import {
  DETACHED_SPAWN_OPTIONS,
  killProcessGroup,
} from "./adapters/child-process.mjs";

const HARNESS_UNKNOWN_CODES = Object.freeze({
  skills: "harness_unknown_skill",
  commands: "harness_unknown_command",
  subagents: "harness_unknown_subagent",
});

function retireMissingPinnedMemo(db, input, error, now) {
  const match = /^artifact ([a-f0-9]{64}) is not in the store$/.exec(
    error?.message ?? "",
  );
  const sha256 = match?.[1];
  if (
    !sha256 ||
    !input?.memoPin?.entries?.some((entry) => entry?.sha256 === sha256)
  ) {
    return false;
  }
  return (
    db
      .query(
        `UPDATE memos
         SET retired_at = ?, retired_reason = 'artifact_missing'
         WHERE sha256 = ? AND retired_at IS NULL`,
      )
      .run(now, sha256).changes > 0
  );
}

// schedule.yaml is deliberately absent. Unlike repos/policy — pure instance
// state a delegated checkout needs verbatim — the schedule overlay layers on
// top of the branch's tracked kernel schedules (event-runtime/schedules.json).
// A worktree's branch may have trimmed a loop out of the kernel (e.g. #1028),
// yet the live operator overlay can still carry a stale, partial entry for it
// (`enabled: true` with no cadence). Copied in, that entry loads as a brand-new
// overlay loop with no `every`, and the repo verify gate dies with
// `unparseable cadence "undefined"` (#1051). Omitting it lets the checkout fall
// back to the tracked schedule.example.yaml, which always verifies.
const INSTANCE_LOCAL_CONFIG_FILES = Object.freeze([
  "repos.yaml",
  "policy.yaml",
]);

/**
 * Ensure `rel` is git-ignored in `checkoutPath`, adding it to the checkout's
 * local `info/exclude` if the repo does not already ignore it. Returns true
 * when the path is (or becomes) ignored. A client repo does not gitignore the
 * factory's instance config, so this is how that config can be copied in for a
 * run while staying un-stageable — a copied-but-committable instance config
 * would leak the operator's routing/policy into the repo.
 */
/**
 * Run one bounded `git` probe on the claim path. Always settles: on normal
 * exit (`close`), on a spawn failure (`error`, e.g. ENOENT — Node need not
 * emit `close` after that), and on the subprocess-timeout ceiling. stderr is
 * discarded rather than piped so a chatty git can never stall the probe on an
 * undrained pipe. `command` exists only so tests can point the probe at a
 * non-existent binary.
 */
export async function runClaimPathGitProbe({
  checkoutPath,
  args,
  name,
  onTimeout,
  command = "git",
}) {
  const timeoutMs = workerSubprocessTimeoutMs();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        ...DETACHED_SPAWN_OPTIONS,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch (error) {
      resolve({ status: null, stdout: "", error });
      return;
    }

    let stdout = "";
    let error = null;
    let settled = false;
    const settle = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, stdout, error });
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.once("error", (spawnError) => {
      error = spawnError;
      // A failed spawn (ENOENT, EACCES) may never reach `close`; settle now so
      // the claim path cannot hang on a missing or broken git binary.
      settle(null);
    });
    const timer = setTimeout(() => {
      error = Object.assign(
        new Error(`git ${name} timed out after ${timeoutMs}ms`),
        { code: "ETIMEDOUT" },
      );
      console.warn(
        `[worker] claim-path git probe timed out: repo=${checkoutPath} probe=${name} ceiling=${timeoutMs}ms`,
      );
      try {
        onTimeout?.({ repo: checkoutPath, name, ceilingMs: timeoutMs });
      } catch {
        // Trace observability cannot interfere with config provisioning.
      }
      killProcessGroup(child, { signal: "SIGKILL" });
    }, timeoutMs);
    timer.unref?.();
    child.once("close", (status) => settle(status));
  });
}

async function ensureLocallyIgnored(checkoutPath, rel, { onTimeout } = {}) {
  const isIgnored = async () =>
    (
      await runClaimPathGitProbe({
        checkoutPath,
        args: ["-C", checkoutPath, "check-ignore", "-q", "--", rel],
        name: "check-ignore",
        onTimeout,
      })
    ).status === 0;
  if (await isIgnored()) return true;
  const resolved = await runClaimPathGitProbe({
    checkoutPath,
    args: ["-C", checkoutPath, "rev-parse", "--git-path", "info/exclude"],
    name: "rev-parse",
    onTimeout,
  });
  if (resolved.status !== 0) return false;
  const excludeFile = path.resolve(checkoutPath, resolved.stdout.trim());
  try {
    mkdirSync(path.dirname(excludeFile), { recursive: true });
    const existing = existsSync(excludeFile)
      ? readFileSync(excludeFile, "utf8")
      : "";
    if (!existing.split(/\r?\n/).includes(`/${rel}`)) {
      const sep = existing === "" || existing.endsWith("\n") ? "" : "\n";
      writeFileSync(excludeFile, `${existing}${sep}/${rel}\n`);
    }
  } catch {
    return false;
  }
  return isIgnored();
}

/**
 * Bring the operator-owned config files into a delegated checkout. These
 * files are intentionally untracked, so a fresh worktree otherwise falls
 * back to examples and cannot use this factory instance's routing or policy.
 * The schedule overlay is excluded on purpose (see INSTANCE_LOCAL_CONFIG_FILES).
 */
export async function provisionInstanceLocalConfigs({
  checkoutPath,
  factoryRoot = process.env.FACTORY_ROOT || FACTORY_ROOT,
  onProbeTimeout,
} = {}) {
  if (!checkoutPath) return [];
  const sourceConfig = path.join(factoryRoot, "config");
  const destinationConfig = path.join(checkoutPath, "config");
  const isGitCheckout =
    spawnSync(
      "git",
      ["-C", checkoutPath, "rev-parse", "--is-inside-work-tree"],
      {
        encoding: "utf8",
        timeout: workerSubprocessTimeoutMs(),
        killSignal: "SIGKILL",
      },
    ).status === 0;
  const copied = [];

  for (const filename of INSTANCE_LOCAL_CONFIG_FILES) {
    const source = path.join(sourceConfig, filename);
    const rel = path.posix.join("config", filename);
    if (!existsSync(source)) continue;
    const destination = path.join(destinationConfig, filename);
    if (path.resolve(source) === path.resolve(destination)) continue;

    // The instance config must never be stageable in the checkout — an agent
    // could otherwise commit the operator's routing/policy (with client names)
    // into a repo. The factory repo already gitignores these paths; a client
    // repo (bj29, cashsaas, …) has no such entry, so make the path locally
    // ignored (`.git/info/exclude`) first. Either way the copied config is
    // present for the run — merge-review resolves the repo's control plane and
    // merge_ci gate from it — but can never be `git add`-ed. Before this,
    // client-repo merge-review failed closed on the missing config (the guard
    // silently skipped the copy, leaving only the tracked example, which the
    // client repo does not ship). Only fall back to the example if the path
    // cannot be made ignore-protected.
    if (
      isGitCheckout &&
      !(await ensureLocallyIgnored(checkoutPath, rel, {
        onTimeout: onProbeTimeout,
      }))
    ) {
      continue;
    }
    mkdirSync(destinationConfig, { recursive: true });
    cpSync(source, destination);
    copied.push(rel);
  }
  return copied;
}

export class HarnessMaterializeError extends Error {
  /**
   * @param {string} code - typed reason: `harness_unknown_*` / `harness_unsupported` / `harness_unmaterializable`
   * @param {string} detail
   */
  constructor(code, detail) {
    super(detail);
    this.name = "HarnessMaterializeError";
    this.code = code;
  }
}

/**
 * Catalog roots for resolving declared harness names (WM-851). Prefers
 * WM-849's `registry.harnessRoots` when present; otherwise `shared/`.
 */
export function harnessCatalogRoots(registry, factoryRoot = FACTORY_ROOT) {
  if (Array.isArray(registry?.harnessRoots) && registry.harnessRoots.length > 0)
    return registry.harnessRoots;
  return [
    {
      name: "factory/core",
      builtin: true,
      prefix: null,
      skills: path.join(factoryRoot, "shared", "skills"),
      commands: path.join(factoryRoot, "shared", "commands"),
      subagents: path.join(factoryRoot, "shared", "agents"),
    },
  ];
}

function catalogHas(roots, kind, name) {
  for (const root of roots) {
    const dir = root[kind];
    if (typeof dir !== "string" || dir === "") continue;
    const candidate =
      kind === "skills" ? path.join(dir, name) : path.join(dir, `${name}.md`);
    if (existsSync(candidate)) return true;
  }
  return false;
}

function harnessRelDest(layout, name) {
  const parts = layout.dest(name);
  if (!Array.isArray(parts) || parts.some((p) => typeof p !== "string")) {
    throw new HarnessMaterializeError(
      "harness_unmaterializable",
      `adapter dest() for ${JSON.stringify(name)} did not return a path-segment array`,
    );
  }
  return parts.join("/");
}

/** Hash every regular file copied for one declared harness component. */
function harnessFilePins(dest, workspaceDir) {
  const files = [];
  const visit = (file) => {
    const st = statSync(file);
    if (st.isFile()) {
      files.push(file);
      return;
    }
    for (const entry of readdirSync(file, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      visit(path.join(file, entry.name));
    }
  };
  visit(dest);
  return Object.fromEntries(
    files
      .sort()
      .map((file) => [
        path.relative(workspaceDir, file),
        hashBytes(readFileSync(file)),
      ]),
  );
}

/**
 * Copy declared RunSpec.harness content into the attempt workspace using the
 * target adapter's `HARNESS_LAYOUT`. No-op when the spec omits harness or
 * names nothing. Throws `HarnessMaterializeError` with a typed `code`.
 */
export function materializeRunHarness({
  spec,
  adapter,
  adapterKey,
  workspaceDir,
  registry,
  factoryRoot = FACTORY_ROOT,
} = {}) {
  const harness = spec?.harness;
  if (!harness || typeof harness !== "object") return [];
  const declaredCount = HARNESS_KINDS.reduce(
    (n, kind) => n + (Array.isArray(harness[kind]) ? harness[kind].length : 0),
    0,
  );
  if (declaredCount === 0) return [];

  // `safeJoin` returns a realpath-canonical destination. Keep the root used
  // for receipt-relative paths in that same namespace so a symlinked workspace
  // parent does not turn an in-workspace harness file into an apparent escape.
  let canonicalWorkspaceDir;
  try {
    canonicalWorkspaceDir = realpathSync(path.resolve(workspaceDir));
  } catch (err) {
    throw new HarnessMaterializeError(
      "harness_unmaterializable",
      `workspace root ${JSON.stringify(String(workspaceDir))} cannot be resolved: ${err?.message ?? String(err)}`,
    );
  }
  const layout = adapter?.HARNESS_LAYOUT;
  const roots = harnessCatalogRoots(registry, factoryRoot);
  const written = [];

  for (const kind of HARNESS_KINDS) {
    const names = Array.isArray(harness[kind]) ? harness[kind] : [];
    for (const name of names) {
      if (typeof name !== "string" || !HARNESS_NAME_PATTERN.test(name)) {
        throw new HarnessMaterializeError(
          HARNESS_UNKNOWN_CODES[kind],
          `${kind} name ${JSON.stringify(name)} is not a legal harness identifier`,
        );
      }
      if (!catalogHas(roots, kind, name)) {
        throw new HarnessMaterializeError(
          HARNESS_UNKNOWN_CODES[kind],
          `${kind.slice(0, -1)} "${name}" is not in the harness catalog`,
        );
      }
      const kindLayout = layout?.[kind];
      if (!kindLayout) {
        throw new HarnessMaterializeError(
          "harness_unsupported",
          `adapter "${adapterKey}" cannot materialize ${kind}`,
        );
      }
      const srcParts = kindLayout.source(name);
      if (
        !Array.isArray(srcParts) ||
        srcParts.some((p) => typeof p !== "string")
      ) {
        throw new HarnessMaterializeError(
          "harness_unmaterializable",
          `adapter "${adapterKey}" source() for ${kind}/${name} did not return a path-segment array`,
        );
      }
      const src = path.join(factoryRoot, ...srcParts);
      let dest;
      try {
        dest = safeJoin(
          canonicalWorkspaceDir,
          harnessRelDest(kindLayout, name),
        );
      } catch (err) {
        throw new HarnessMaterializeError(
          "harness_unmaterializable",
          err instanceof PathViolation
            ? `${kind}/${name} dest escapes the workspace`
            : (err?.message ?? String(err)),
        );
      }
      if (!existsSync(src)) {
        throw new HarnessMaterializeError(
          "harness_unmaterializable",
          `${kind}/${name} has no emitted packaging for adapter "${adapterKey}"`,
        );
      }
      const st = statSync(src);
      if (kindLayout.type === "dir" && !st.isDirectory()) {
        throw new HarnessMaterializeError(
          "harness_unmaterializable",
          `${kind}/${name} emit path is not a directory for adapter "${adapterKey}"`,
        );
      }
      if (kindLayout.type === "file" && !st.isFile()) {
        throw new HarnessMaterializeError(
          "harness_unmaterializable",
          `${kind}/${name} emit path is not a file for adapter "${adapterKey}"`,
        );
      }
      mkdirSync(path.dirname(dest), { recursive: true });
      cpSync(src, dest, { recursive: kindLayout.type === "dir" });
      written.push({
        kind,
        name,
        dest: path.relative(canonicalWorkspaceDir, dest),
        pins: harnessFilePins(dest, canonicalWorkspaceDir),
      });
    }
  }
  return written;
}

/**
 * Runtime-injected artifacts: adapters that capture the agent's output write
 * it here (workspace-relative); the verifier includes it when present. The
 * agent does not have to declare its own transcript.
 */
const RUNTIME_ARTIFACTS = [
  { kind: "transcript", path: ".transcript.json" },
  { kind: "sandbox-console", path: ".sandbox-console.log" },
];

/** Grace added to the execution deadline before a lease is considered abandoned. */
export const LEASE_GRACE_SECONDS = 120;

/**
 * Adapters that honor AbortSignal, so the worker's durable DB-backed deadline
 * monitor — not the adapter's own TERM/KILL timer — is the authoritative
 * timer and can move while an attempt is running (WM-566). Their `timeoutMs`
 * is only a runaway backstop, but it must be a real one: agy forwards it out
 * of process as `--print-timeout` and the gondolin guest timer uses it to
 * stop a wedged runner from pinning the run slot open (WM-692).
 */
export const DYNAMIC_DEADLINE_ADAPTERS = new Set([
  "agy",
  "claude",
  "command",
  "cursor",
  "fake",
  "pi",
]);

/** `limits.max_run_minutes` from config/policy.yaml, or null when unavailable. */
export function policyMaxRunMinutes(root = FACTORY_ROOT) {
  try {
    const value = Bun.YAML.parse(
      readFileSync(resolveConfigPath("policy", { root }), "utf8"),
    )?.limits?.max_run_minutes;
    return Number.isFinite(value) && value > 0 ? Number(value) : null;
  } catch {
    return null;
  }
}

/**
 * Explicit operator opt-out for workspace-only model confinement, normalized
 * to `{ mode: "host", agents: string[]|null }` or `null`. Unknown, malformed,
 * and absent values all fail closed.
 */
export function policyWorkspaceOnlyFallback(root = FACTORY_ROOT) {
  try {
    const policy = Bun.YAML.parse(
      readFileSync(resolveConfigPath("policy", { root }), "utf8"),
    );
    return normalizeWorkspaceOnlyFallback(
      policy?.sandbox?.workspace_only_fallback,
    );
  } catch {
    return null;
  }
}

/**
 * Gondolin's preflight shells out to QEMU and Node, so it must not run per
 * claim: a host's virtualization capability does not change inside a worker
 * process. Memoized here (rather than in the sandbox module) because this is
 * the hot caller.
 */
let SANDBOX_PREFLIGHT_CACHE;
export function cachedSandboxPreflight() {
  if (SANDBOX_PREFLIGHT_CACHE === undefined) {
    SANDBOX_PREFLIGHT_CACHE = sandboxPreflight();
  }
  return SANDBOX_PREFLIGHT_CACHE;
}

/** Test seam: forget the memoized host capability report. */
export function resetSandboxPreflightCache() {
  SANDBOX_PREFLIGHT_CACHE = undefined;
}

/**
 * The `timeoutMs` handed to `adapter.execute`. Dynamic-deadline adapters get
 * the policy ceiling: no non-override extension can move a deadline past
 * `started_at + max_run_minutes`, so `max(budget, max_run_minutes) + lease
 * grace` keeps every policy-bounded extension alive while still bounding a
 * wedged child. Every other adapter keeps its exact run budget.
 */
export function adapterExecuteTimeoutMs({
  adapterKey,
  spec,
  maxRunMinutes = policyMaxRunMinutes(),
}) {
  const budgetMs = spec.timeoutSeconds * 1000;
  if (!DYNAMIC_DEADLINE_ADAPTERS.has(adapterKey)) return budgetMs;
  const policyMs =
    Number.isFinite(maxRunMinutes) && maxRunMinutes > 0
      ? maxRunMinutes * 60_000
      : 0;
  return Math.max(budgetMs, policyMs) + LEASE_GRACE_SECONDS * 1000;
}
const DEADLINE_POLL_MS = 100;

function deadlineEventFromReason(reason, type) {
  if (typeof reason !== "string" || !reason.startsWith("{")) return null;
  try {
    const value = JSON.parse(reason);
    if (
      value?.type === type &&
      typeof value.deadlineAt === "string" &&
      Number.isFinite(Date.parse(value.deadlineAt))
    )
      return value;
  } catch {
    /* intentionally ignored */
  }
  return null;
}

function deadlineExtensionFromReason(reason) {
  const value = deadlineEventFromReason(reason, "deadline_extended");
  return value && Number.isInteger(value.seconds) && value.seconds > 0
    ? value
    : null;
}

function deadlineExpiredFromReason(reason) {
  return deadlineEventFromReason(reason, "deadline_expired");
}

/** Durable attempt deadline: latest extension, then the immutable initial budget. */
export function attemptDeadline(db, runId, attempt, spec = null) {
  const extensionRows = db
    .query(
      `SELECT reason FROM lifecycle_events WHERE run_id = ? AND attempt = ? ORDER BY seq DESC`,
    )
    .all(runId, attempt);
  for (const row of extensionRows) {
    const extension = deadlineExtensionFromReason(row.reason);
    if (extension) return Date.parse(extension.deadlineAt);
  }
  const row = db
    .query(
      `SELECT started_at, lease_expires_at FROM attempts WHERE run_id = ? AND attempt = ?`,
    )
    .get(runId, attempt);
  if (!row) return null;
  const parsedSpec =
    spec ??
    (() => {
      const run = db
        .query(`SELECT spec_json FROM runs WHERE run_id = ?`)
        .get(runId);
      return run?.spec_json ? JSON.parse(run.spec_json) : null;
    })();
  if (row.started_at && Number.isFinite(Number(parsedSpec?.timeoutSeconds))) {
    return (
      Date.parse(row.started_at) + Number(parsedSpec.timeoutSeconds) * 1000
    );
  }
  if (row.lease_expires_at) {
    return Date.parse(row.lease_expires_at) - LEASE_GRACE_SECONDS * 1000;
  }
  return null;
}

export function deadlineExtensions(db, runId) {
  return db
    .query(
      `SELECT seq, actor, reason, at FROM lifecycle_events WHERE run_id = ? ORDER BY seq`,
    )
    .all(runId)
    .flatMap((row) => {
      const extension = deadlineExtensionFromReason(row.reason);
      return extension
        ? [{ seq: row.seq, actor: row.actor, at: row.at, ...extension }]
        : [];
    });
}

/** Append an audited extension and move the current attempt's lease atomically. */
export function extendRunDeadline(
  db,
  runId,
  {
    seconds,
    actor,
    override = false,
    maxDeadlineMs = null,
    policyVersion = "unknown",
    now = Date.now(),
  } = {},
) {
  return txImmediate(db, () => {
    const run = db
      .query(`SELECT state, attempts, spec_json FROM runs WHERE run_id = ?`)
      .get(runId);
    if (!run) return { refused: true, code: "unknown_run", status: 404 };
    if (!["RUNNING", "VERIFYING"].includes(run.state)) {
      return {
        refused: true,
        code: "run_not_extendable",
        status: 409,
        state: run.state,
      };
    }
    const spec = JSON.parse(run.spec_json);
    if (spec.adapter === "actions") {
      return {
        refused: true,
        code: "adapter_deadline_not_extendable",
        status: 409,
        adapter: spec.adapter,
      };
    }
    const deadlineRows = db
      .query(
        `SELECT reason FROM lifecycle_events WHERE run_id = ? AND attempt = ? ORDER BY seq DESC`,
      )
      .all(runId, run.attempts);
    if (deadlineRows.some((row) => deadlineExpiredFromReason(row.reason))) {
      return { refused: true, code: "deadline_already_expired", status: 409 };
    }
    const currentDeadline = attemptDeadline(db, runId, run.attempts, spec);
    if (!Number.isFinite(currentDeadline)) {
      return { refused: true, code: "deadline_unavailable", status: 409 };
    }
    // Serialize the edge decision under the same write lock as worker expiry.
    // A delayed worker poll must not let an operator revive an already-spent
    // deadline merely because the durable expiry marker has not landed yet.
    if (resolveNow(now) >= currentDeadline) {
      return {
        refused: true,
        code: "deadline_already_expired",
        status: 409,
        deadlineAt: new Date(currentDeadline).toISOString(),
      };
    }
    const deadlineMs = currentDeadline + seconds * 1000;
    if (
      !override &&
      Number.isFinite(maxDeadlineMs) &&
      deadlineMs > maxDeadlineMs
    ) {
      return {
        refused: true,
        code: "policy_run_limit",
        status: 409,
        deadlineAt: new Date(currentDeadline).toISOString(),
        maxDeadlineAt: new Date(maxDeadlineMs).toISOString(),
      };
    }
    const at = iso(now);
    const deadlineAt = new Date(deadlineMs).toISOString();
    const leaseExpiresAt = new Date(
      deadlineMs + LEASE_GRACE_SECONDS * 1000,
    ).toISOString();
    const reason = canonicalJson({
      type: "deadline_extended",
      seconds,
      deadlineAt,
      override: override === true,
    });
    const record = {
      runId,
      from: run.state,
      to: run.state,
      actor,
      reason,
      attempt: run.attempts,
      policyVersion,
      at,
    };
    db.query(
      `INSERT INTO lifecycle_events
         (run_id, from_state, to_state, actor, reason, attempt, correlation_id, causation_id, policy_version, at, record_hash)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
    ).run(
      runId,
      run.state,
      run.state,
      actor,
      reason,
      run.attempts,
      policyVersion,
      at,
      hashJson(record),
    );
    db.query(
      `UPDATE attempts SET lease_expires_at = ? WHERE run_id = ? AND attempt = ?`,
    ).run(leaseExpiresAt, runId, run.attempts);
    db.query(`UPDATE runs SET updated_at = ? WHERE run_id = ?`).run(at, runId);
    return {
      runId,
      seconds,
      deadlineAt,
      leaseExpiresAt,
      override: override === true,
    };
  });
}

/**
 * Durably claim expiry before signalling the adapter. This transaction races
 * the extension transaction under the same SQLite write lock: an extension
 * that commits first moves the deadline, while an expiry that commits first
 * makes every later extension a typed refusal throughout TERM/KILL grace.
 */
export function expireRunDeadline(
  db,
  runId,
  attempt,
  fencingToken,
  { actor, policyVersion = "unknown", now = Date.now() } = {},
) {
  return txImmediate(db, () => {
    const run = db
      .query(`SELECT state, attempts, spec_json FROM runs WHERE run_id = ?`)
      .get(runId);
    if (
      !run ||
      run.attempts !== attempt ||
      !["RUNNING", "VERIFYING"].includes(run.state)
    ) {
      return { expired: false, inactive: true };
    }
    if (!assertCurrentToken(db, runId, fencingToken))
      return { expired: false, fenced: true };
    const rows = db
      .query(
        `SELECT reason FROM lifecycle_events WHERE run_id = ? AND attempt = ? ORDER BY seq DESC`,
      )
      .all(runId, attempt);
    const prior = rows
      .map((row) => deadlineExpiredFromReason(row.reason))
      .find(Boolean);
    if (prior)
      return { expired: true, deadlineAt: prior.deadlineAt, existing: true };

    const deadlineMs = attemptDeadline(
      db,
      runId,
      attempt,
      JSON.parse(run.spec_json),
    );
    const currentNow = resolveNow(now);
    if (!Number.isFinite(deadlineMs) || currentNow < deadlineMs) {
      return { expired: false, deadlineMs };
    }

    const at = iso(currentNow);
    const deadlineAt = new Date(deadlineMs).toISOString();
    const reason = canonicalJson({ type: "deadline_expired", deadlineAt });
    const record = {
      runId,
      from: run.state,
      to: run.state,
      actor,
      reason,
      attempt,
      policyVersion,
      at,
    };
    db.query(
      `INSERT INTO lifecycle_events
         (run_id, from_state, to_state, actor, reason, attempt, correlation_id, causation_id, policy_version, at, record_hash)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
    ).run(
      runId,
      run.state,
      run.state,
      actor,
      reason,
      attempt,
      policyVersion,
      at,
      hashJson(record),
    );
    return { expired: true, deadlineAt };
  });
}

/** Infrastructure retries are independent from the agent-error attempt budget. */
export const DEFAULT_MAX_ENVIRONMENT_RETRIES = 3;

/** Claim-lock contention is deferred independently from execution attempts. */
// Requeue budget for the per-repo dispatch lock. Contended runs re-queue with
// exponential backoff without spending an execution attempt.
//
// WM-1124: the default is now unbounded (Infinity → never terminally REFUSE
// with claim_lock_starvation). acquireClaimLock() only ever returns false for a
// *live* lock owner — a dead owner's lock is reclaimed in place (see the
// isAlive branch there), so a deferred run is, by construction, only ever
// contending against an owner that WILL release. A live owner's hold is bounded
// (claim + gate control-plane reads under the worker subprocess timeout, not
// the agent run), so the contender reliably wins a later cycle. A fixed ceiling
// turned that transient, self-healing contention into a terminal refusal: an
// N-wide same-repo dispatch burst (observed 14–16 per scan) starved most of
// itself — 11 of 14 terminally REFUSED in one 2026-08-29 cycle — wasting a full
// scan and the agents' budget on tickets that were never actually un-claimable.
// Durable defer-and-retry is strictly safer here than a terminal refusal, and
// the atomic claim is untouched: the lock, gate read, and claim keep their
// exact ordering. An explicit finite `maxClaimLockContentionRequeues` option
// still caps the requeues (used by the starvation-ceiling test and available to
// operators); only the production default stops being terminal.
export const DEFAULT_MAX_CLAIM_LOCK_REQUEUES = Infinity;
export const DEFAULT_MAX_TRANSIENT_GATE_REQUEUES = 3;
export const CLAIM_LOCK_BACKOFF_BASE_MS = 25;
export const CLAIM_LOCK_BACKOFF_MAX_MS = 1_000;

/** Hard ceiling for synchronous git and Linear helper processes (WM-262). */
export const DEFAULT_WORKER_SUBPROCESS_TIMEOUT_MS = 120_000;

function workerSubprocessTimeoutMs() {
  const configured = Number(process.env.FACTORY_WORKER_SUBPROCESS_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_WORKER_SUBPROCESS_TIMEOUT_MS;
}

/** Worktree vanished between agent finish and handoff verify (`realpath` ENOENT). */
const HANDOFF_WORKTREE_MISSING = "handoff_worktree_missing";
/** GitHub read exhausted its bounded rate-limit retry during handoff. */
export const HANDOFF_FORGE_UNAVAILABLE = "handoff_forge_unavailable";
/** Non-`ContractViolation` throw from `verifyResult` / `assertHandoffPullRequestBase`. */
const VERIFICATION_INTERNAL_ERROR = "verification_internal_error";

/**
 * The repair turn only restates an envelope the agent already produced, so it
 * gets its own small budget rather than a second full run's worth of wall
 * clock. A wedged repair must not be able to consume the attempt deadline.
 */
const PI_RESULT_REPAIR_TIMEOUT_MS = 5 * 60 * 1000;

/** Evidence copy of the rejected envelope, kept beside the workspace result. */
const INVALID_RESULT_FILE = "result.invalid.json";

/** Bound on the rejected bytes echoed into the repair prompt and the trace. */
const INVALID_RESULT_PREVIEW_BYTES = 8000;

const USAGE_SUM_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheCreationInputTokens",
  "cacheReadInputTokens",
  "costUSD",
];

/**
 * The repair is a second billable adapter turn on the same attempt. Attempt
 * usage is a total, not a last-writer-wins snapshot, so add its tokens and
 * cost to what the primary execution already reported.
 */
function mergeAttemptUsage(base, extra, adapterKey) {
  const merged = { adapter: adapterKey, ...(base ?? {}), ...(extra ?? {}) };
  for (const field of USAGE_SUM_FIELDS) {
    const snake = field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    const read = (usage) => {
      const value = usage?.[field] ?? usage?.[snake];
      return Number.isFinite(value) && value >= 0 ? value : 0;
    };
    const total = read(base) + read(extra);
    if (total > 0) merged[field] = total;
    delete merged[snake];
  }
  return merged;
}

/**
 * Snapshot the rejected envelope before the repair turn overwrites
 * `result.json`. The invalid payload is the primary evidence for why the run
 * failed; a repair that fails again must not be the reason it disappeared.
 */
function snapshotInvalidResult({ workspaceDir, onTrace }) {
  let raw;
  const source = path.join(workspaceDir, "result.json");
  const target = path.join(workspaceDir, INVALID_RESULT_FILE);
  try {
    raw = readFileSync(source);
    writeFileSync(target, raw);
  } catch (err) {
    onTrace?.("lifecycle", {
      event: "pi_result_repair_snapshot_failed",
      source,
      error: String(err?.message ?? err),
    });
    return null;
  }
  const text = raw.toString("utf8");
  const snapshot = {
    source,
    path: target,
    bytes: raw.length,
    sha256: sha256Hex(raw),
    preview: text.slice(0, INVALID_RESULT_PREVIEW_BYTES),
  };
  onTrace?.("lifecycle", { event: "pi_result_repair_snapshot", ...snapshot });
  return snapshot;
}

/** A zero-exit Pi run gets one chance to correct its own invalid envelope. */
function mayRepairPiResult({ adapterKey, outcome, error }) {
  return (
    adapterKey === "pi" &&
    outcome?.exitCode === 0 &&
    outcome?.timedOut !== true &&
    error instanceof ContractViolation &&
    error.reasonCode === "contract_violation" &&
    !error.handoff &&
    Array.isArray(error.violations) &&
    error.violations.length > 0
  );
}

const ENVIRONMENT_FAILURES = new Set([
  "adapter_error",
  "lease_expired",
  "linear_unconfigured",
  "registry_stale",
  // GH-967: the host could not build the handoff sandbox. Nothing about the
  // agent's work is implicated, so this must never burn an agent attempt or
  // draft the PR — it is the worker host that needs attention.
  HANDOFF_SANDBOX_UNAVAILABLE,
  // The offline sandbox cannot restore packages; this is a host fault rather
  // than evidence that the agent's branch is red.
  HANDOFF_DEPENDENCIES_MISSING,
  // Same family: the worktree is gone, so continuation/retry must not treat
  // the throw as an agent red (#1663).
  HANDOFF_WORKTREE_MISSING,
  HANDOFF_FORGE_UNAVAILABLE,
]);
const isAgentHandoffFailure = (reasonCode) =>
  HANDOFF_REASON_CODES.has(reasonCode) &&
  reasonCode !== HANDOFF_DEPENDENCIES_MISSING;
// The handoff gate (WM-718) catching the agent's own red is an agent error:
// bounded by maxAttempts like any contract violation, never an environment
// retry and never fatal — the ticket is already back in Todo + agent-ready.
const AGENT_FAILURES = new Set([
  "contract_violation",
  ...[...HANDOFF_REASON_CODES].filter(isAgentHandoffFailure),
]);
const FATAL_FAILURES = new Set([
  "cli_not_found",
  "filesystem_confinement_unavailable",
  "sandbox_unsupported",
  "worktree_sandbox_unsupported",
  "unknown_adapter",
  "agent_definition_mismatch",
  "workspace_integrity_violation",
  VERIFICATION_INTERNAL_ERROR,
]);

/** Closed failure taxonomy: unknown reasons fail safe as fatal and never retry. */
export function classifyFailureCause(reasonCode) {
  if (ENVIRONMENT_FAILURES.has(reasonCode)) return "environment";
  if (
    AGENT_FAILURES.has(reasonCode) ||
    String(reasonCode).startsWith("agent_exit_")
  ) {
    return "agent_error";
  }
  if (
    FATAL_FAILURES.has(reasonCode) ||
    String(reasonCode).startsWith("policy_denied:") ||
    String(reasonCode).startsWith("harness_")
  ) {
    return "fatal";
  }
  return "fatal";
}

/**
 * Only an ENOENT whose target lies inside the run's own workspace (the
 * delegated worktree or the workspace dir `verifyResult` realpaths) is the
 * vanished-worktree environment failure. An ENOENT elsewhere — a missing
 * verifier binary or config — is a harness defect and must not draw on the
 * environment retry budget.
 */
function verificationInternalReasonCode(err, roots = []) {
  if (err?.code !== "ENOENT") return VERIFICATION_INTERNAL_ERROR;
  const target = err.path ?? err.dest ?? null;
  if (typeof target !== "string" || !target) return VERIFICATION_INTERNAL_ERROR;
  const resolved = path.resolve(target);
  for (const root of roots) {
    if (typeof root !== "string" || !root) continue;
    const rel = path.relative(path.resolve(root), resolved);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
      return HANDOFF_WORKTREE_MISSING;
    }
  }
  return VERIFICATION_INTERNAL_ERROR;
}

function verificationInternalErrorPayload(err) {
  return {
    code: err?.code ?? err?.name ?? null,
    message: err?.message ?? String(err),
  };
}

/** Closed eligibility predicate; a continuation can never escalate again. */
export function tierEscalationEligibility(spec, reasonCode) {
  const rootRunId = spec?.rootRunId ?? spec?.runId ?? null;
  // The ticket's acceptance criteria name `verification_failed`; the code the
  // runtime actually emits for that condition is `handoff_verification_failed`
  // (verify.mjs HANDOFF_REASON_CODES). Match the emitted codes only — a
  // reason code no producer writes is dead weight that reads as coverage.
  const eligibleReason =
    isAgentHandoffFailure(reasonCode) ||
    reasonCode === "contract_violation" ||
    String(reasonCode).startsWith("agent_exit_");
  const eligible = Boolean(
    spec?.agent === "dispatch@1" &&
    spec?.workspace?.type === "worktree" &&
    ["light", "standard"].includes(spec?.modelTier) &&
    !spec?.escalatedFromRunId &&
    eligibleReason,
  );
  return { eligible, rootRunId };
}

/**
 * Decide whether an otherwise eligible tier escalation still owns work to do.
 *
 * The failed agent can hand a ticket to review before its worker observes a
 * failed handoff verification. Do not let that late failure create a stronger
 * continuation which races the retained PR's review/fix lane.
 */
export function tierEscalationContinuationGuard(
  spec,
  reasonCode,
  {
    fetchTicket,
    findPullRequest = defaultFindWorkspacePullRequest,
    workspacePath,
  } = {},
) {
  const eligibility = tierEscalationEligibility(spec, reasonCode);
  if (!eligibility.eligible) return { ...eligibility, skip: false };

  let ticket;
  try {
    ticket = fetchTicket?.(spec.input?.ticket, spec.input?.repo);
  } catch {
    // Preserve the existing continuation behavior when the tracker cannot be
    // read. The continuation's claim-time gate still performs its own
    // fail-closed tracker proof before it can execute.
    ticket = null;
  }
  if (ticket?.state?.name === "In Review") {
    return { ...eligibility, skip: true, reason: "ticket_in_review" };
  }

  let pullRequest;
  try {
    pullRequest = workspacePath ? findPullRequest?.({ workspacePath }) : null;
  } catch {
    // PR discovery is an additional ownership signal, not a reason to drop a
    // recoverable continuation when the forge is temporarily unavailable.
    pullRequest = null;
  }
  if (pullRequest?.isDraft === false) {
    return { ...eligibility, skip: true, reason: "retained_pr_open" };
  }
  return { ...eligibility, skip: false };
}

/**
 * Layer the RunSpec-derived dispatch identity onto the adapter environment.
 *
 * Any `dispatch@<version>` agent qualifies. Identity keys are only emitted when
 * the spec actually carries the value, so a spec without a ticket or repo never
 * exports the literal string "null". Non-dispatch agents get `env` unchanged.
 */
export function dispatchIdentityEnv({
  spec,
  env = {},
  runId = null,
  ticketId = null,
  repoName = null,
  resultPath = null,
}) {
  if (!String(spec?.agent ?? "").startsWith("dispatch@")) return env;
  // A dispatched agent must never inherit the worker's control bearer. It can
  // retain a notification locally and the worker will submit it after exit.
  const agentEnv = { ...env };
  delete agentEnv.FACTORY_CONTROL_API_TOKEN;
  const identity = { FACTORY_DISPATCH: "1" };
  if (runId != null && runId !== "") identity.FACTORY_RUN_ID = String(runId);
  if (ticketId != null && ticketId !== "")
    identity.FACTORY_TICKET = String(ticketId);
  if (repoName != null && repoName !== "")
    identity.FACTORY_REPO = String(repoName);
  if (resultPath != null && resultPath !== "")
    identity.FACTORY_RESULT_PATH = String(resultPath);
  // A dispatched agent needs the location of its isolated runtime to retain
  // notifications, but never the worker's control bearer. The caller supplies
  // these two non-secret values explicitly rather than copying process.env.
  for (const key of ["FACTORY_EVENT_HOME", "FACTORY_EVENT_PORT"]) {
    const value = env[key];
    if (value != null && value !== "") identity[key] = String(value);
  }
  return { ...agentEnv, ...identity };
}

const LOCAL_NOTIFY_OUTBOX_SCHEMA = "factory.local-notify-outbox/v1";
const LOCAL_NOTIFY_ACTIVE_RUN_STATES = Object.freeze([
  "QUEUED",
  "LEASED",
  "RUNNING",
  "VERIFYING",
]);
/**
 * How long a retained outbox file must sit untouched before the sweep may
 * delete it. Long enough that no live drain can lose its recovery source,
 * short enough that a crashed worker's leftovers do not accumulate.
 */
const LOCAL_NOTIFY_OUTBOX_GRACE_MS = 60 * 60 * 1000;

function localNotifyPort(port) {
  const value = typeof port === "string" ? port.trim() : String(port);
  if (!/^[1-9]\d*$/.test(value)) return null;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric <= 65_535 ? numeric : null;
}

/**
 * Remove retained local notification files for runs that can no longer be
 * executed. This is deliberately separate from the per-run drain in
 * executeClaimed's finally block: a crashed or unclaimed run never reaches
 * that block. Queued runs remain protected because a retry can still drain
 * their prior attempt's retained escalation.
 *
 * Active-state protection alone is not enough. A file is written by the agent
 * before the run reaches any of those states in this worker's view (and a
 * concurrent worker's run is invisible to a different event home's snapshot),
 * so a run-state check on its own would delete the very file the drain treats
 * as its recovery source. A file must therefore also be older than
 * LOCAL_NOTIFY_OUTBOX_GRACE_MS before it is eligible.
 */
export function sweepOrphanedLocalNotifyOutbox({
  db,
  home = process.env.FACTORY_EVENT_HOME,
  now = Date.now(),
  graceMs = LOCAL_NOTIFY_OUTBOX_GRACE_MS,
} = {}) {
  if (!db || typeof home !== "string" || home.trim() === "") return [];
  const outboxDir = path.join(home, "outbox");
  if (!existsSync(outboxDir)) return [];

  let entries;
  try {
    entries = readdirSync(outboxDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const activeRunIds = new Set(
    db
      .query(
        `SELECT run_id FROM runs WHERE state IN (${LOCAL_NOTIFY_ACTIVE_RUN_STATES.map(() => "?").join(", ")})`,
      )
      .all(...LOCAL_NOTIFY_ACTIVE_RUN_STATES)
      .map(({ run_id: runId }) => runId),
  );
  const swept = [];
  for (const entry of entries) {
    const match = /^([A-Za-z0-9._-]+)\.jsonl$/.exec(entry.name);
    if (!match || activeRunIds.has(match[1])) continue;
    const filePath = path.join(outboxDir, entry.name);
    let mtimeMs;
    try {
      mtimeMs = statSync(filePath).mtimeMs;
    } catch {
      continue;
    }
    if (!(now - mtimeMs >= graceMs)) continue;
    try {
      unlinkSync(filePath);
      swept.push(match[1]);
    } catch {
      // A concurrent writer or permissions change must not stop a worker from
      // claiming the next run; the next startup will retry this hygiene pass.
    }
  }
  return swept;
}

function localOutboxEntry(value, runId) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schemaVersion !== LOCAL_NOTIFY_OUTBOX_SCHEMA ||
    value.runId !== runId ||
    value.source !== `agent:${runId}` ||
    typeof value.kind !== "string" ||
    value.kind.trim() === "" ||
    typeof value.title !== "string" ||
    value.title.trim() === "" ||
    !value.refs ||
    typeof value.refs !== "object" ||
    Array.isArray(value.refs)
  ) {
    return null;
  }
  return value;
}

/**
 * Submit agent-retained notifications with the worker's bearer. Failed lines
 * stay in the append-only run outbox so the worker can report their exact text
 * in the ticket handoff instead of silently losing an escalation.
 */
export async function drainLocalNotifyOutbox({
  home = process.env.FACTORY_EVENT_HOME,
  runId,
  port = process.env.FACTORY_EVENT_PORT || "7381",
  token = process.env.FACTORY_CONTROL_API_TOKEN,
  fetchFn = fetch,
}) {
  let outboxPath;
  try {
    outboxPath = localNotifyOutboxPath({ home, runId });
  } catch (error) {
    return { delivered: [], undelivered: [], error: error.message };
  }
  if (!existsSync(outboxPath)) return { delivered: [], undelivered: [] };

  const lines = readFileSync(outboxPath, "utf8").split("\n").filter(Boolean);

  const validatedPort = localNotifyPort(port);
  if (validatedPort === null) {
    // Report one undelivered entry per retained line rather than a bare
    // `error` field: the caller only reads `undelivered`, and a misconfigured
    // port must surface as the same ticket comment as any other delivery
    // failure instead of failing silently. The file stays put as the
    // recovery source.
    const error =
      "FACTORY_EVENT_PORT must be a positive integer between 1 and 65535";
    return {
      delivered: [],
      undelivered: lines.map((line) => {
        let entry;
        try {
          entry = localOutboxEntry(JSON.parse(line), runId);
        } catch {
          entry = null;
        }
        return {
          title: entry ? entry.title : "invalid local notification record",
          error,
        };
      }),
      error,
    };
  }

  const retained = [];
  const delivered = [];
  const undelivered = [];
  for (const line of lines) {
    let entry;
    try {
      entry = localOutboxEntry(JSON.parse(line), runId);
    } catch {
      entry = null;
    }
    if (!entry) {
      retained.push(line);
      undelivered.push({
        title: "invalid local notification record",
        error: "invalid outbox entry",
      });
      continue;
    }
    try {
      const response = await fetchFn(
        `http://127.0.0.1:${validatedPort}/inbox`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            kind: entry.kind,
            title: entry.title,
            refs: entry.refs,
            source: entry.source,
          }),
        },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      delivered.push(entry);
    } catch (error) {
      retained.push(line);
      undelivered.push({
        title: entry.title,
        error: String(error?.message ?? error),
      });
    }
  }
  if (retained.length)
    writeFileSync(outboxPath, `${retained.join("\n")}\n`, "utf8");
  else unlinkSync(outboxPath);
  return { delivered, undelivered };
}

function maxEnvironmentRetries(spec) {
  return Number.isInteger(spec.maxEnvironmentRetries) &&
    spec.maxEnvironmentRetries >= 0
    ? spec.maxEnvironmentRetries
    : DEFAULT_MAX_ENVIRONMENT_RETRIES;
}

function failureCount(db, runId, cause) {
  return db
    .query(
      `SELECT reason_code FROM attempts WHERE run_id = ? AND finished_at IS NOT NULL`,
    )
    .all(runId)
    .filter((row) => classifyFailureCause(row.reason_code) === cause).length;
}

/** Called after the current attempt is finalized, so counts include this failure. */
function retryDecision(
  db,
  runId,
  spec,
  reasonCode,
  { includeCurrentFailure = false } = {},
) {
  const cause = classifyFailureCause(reasonCode);
  if (cause === "environment") {
    const failures =
      failureCount(db, runId, cause) + (includeCurrentFailure ? 1 : 0);
    return {
      cause,
      retry: failures <= maxEnvironmentRetries(spec),
    };
  }
  if (cause === "agent_error") {
    const failures =
      failureCount(db, runId, cause) + (includeCurrentFailure ? 1 : 0);
    return { cause, retry: failures < spec.maxAttempts };
  }
  return { cause, retry: false };
}

function typedFailureReason(reasonCode, detail = reasonCode) {
  return `failure:${classifyFailureCause(reasonCode)}:${detail}`;
}

function terminalFailureReason(decision, reasonCode, detail = reasonCode) {
  if (decision.cause === "environment" && !decision.retry) {
    return typedFailureReason(
      reasonCode,
      `${detail}; environment_retry_budget_exhausted`,
    );
  }
  return typedFailureReason(reasonCode, detail);
}

function resolveNow(now) {
  return typeof now === "function" ? now() : (now ?? Date.now());
}

function iso(now) {
  return new Date(resolveNow(now)).toISOString();
}

// Must mirror the refs verify.mjs validated the authored decision against
// (issue = input.ticket, repo, runId); a divergence here would let a decision
// that passed verify fail createInboxItem's legality check at write time.
function refusalInboxRefs(spec) {
  const refs = { runId: spec.runId };
  const input = spec.input ?? {};
  const issue = input.ticket;
  const repo = input.repo;
  const pr = input.pr ?? input.prNumber;
  if (issue !== undefined && issue !== null && String(issue).trim())
    refs.issue = String(issue);
  if (repo !== undefined && repo !== null && String(repo).trim())
    refs.repo = String(repo);
  if (pr !== undefined && pr !== null && String(pr).trim())
    refs.pr = String(pr);
  return refs;
}

function refusalText(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  for (const key of ["message", "summary", "reason", "finding", "title"]) {
    const text = refusalText(value[key]);
    if (text) return text;
  }
  return null;
}

function refusalFindingLines(...values) {
  return [
    ...new Set(
      values.flatMap((value) => {
        const entries = Array.isArray(value) ? value : [value];
        return entries.map(refusalText).filter(Boolean);
      }),
    ),
  ];
}

function refusalEvidenceBody(result) {
  const evidence = result?.evidence ?? {};
  const lines = [];
  const summary =
    refusalText(evidence.summary) ??
    refusalText(evidence.agentSummary) ??
    refusalText(result?.summary);
  if (summary) lines.push(`Agent summary: ${summary}`);

  const reason = refusalText(evidence.reason);
  if (reason)
    lines.push(`Agent reason: ${proposalReasonPlain(reason) ?? reason}`);

  const message = refusalText(evidence.message);
  if (message) lines.push(`Agent message: ${message}`);

  const findings = refusalFindingLines(
    evidence.findings,
    evidence.finding,
    result?.findings,
    result?.finding,
  );
  if (findings.length)
    lines.push(
      `Agent findings:\n${findings.map((item) => `- ${item}`).join("\n")}`,
    );
  return lines.join("\n\n");
}

function createRefusalInboxItem(db, spec, result, { now }) {
  if (result.reasonCode !== "needs_human") return null;
  const refs = refusalInboxRefs(spec);
  const decision =
    result.decision ??
    templateFor("ESCALATED", {
      producer: "escalation",
      refs,
    });
  const subject = refs.issue ?? refs.runId;
  const body =
    [
      refusalEvidenceBody(result),
      result.decisionErrors?.length
        ? `The agent's decision request was rejected:\n${result.decisionErrors.join("\n")}`
        : null,
    ]
      .filter(Boolean)
      .join("\n\n") || null;
  return createInboxItem(
    db,
    {
      kind: "ESCALATED",
      title:
        result.decision?.question ??
        `ESCALATED ${subject}: ${result.reasonCode}`,
      body,
      reasonCode: result.reasonCode,
      ticketTitle: spec.approvalPolicy?.dispatchEvidence?.ticket?.title,
      refs,
      source: `agent:${spec.runId}`,
      decision,
      dedupeKey: `ESCALATED:${refs.issue ?? refs.runId}`,
    },
    { now },
  );
}

function finishAttempt(
  db,
  runId,
  attempt,
  terminalState,
  reasonCode,
  now,
  usage = {},
) {
  const finishedAt = iso(now);
  db.query(
    `UPDATE attempts SET terminal_state = ?, reason_code = ?, finished_at = ?
     WHERE run_id = ? AND attempt = ?`,
  ).run(terminalState, reasonCode, finishedAt, runId, attempt);
  recordRunUsage(db, { runId, attempt, recordedAt: finishedAt, ...usage });
}

/** Include ignored files: an agent must not be able to hide a repository write. */
export function repositoryStatus(
  checkoutPath,
  { timeoutMs = workerSubprocessTimeoutMs(), gitCommand = "git" } = {},
) {
  const result = spawnSync(
    gitCommand,
    [
      "-C",
      checkoutPath,
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--ignored=matching",
    ],
    {
      encoding: "utf8",
      timeout: timeoutMs,
    },
  );
  return result.status === 0 ? result.stdout : null;
}

/** Fail closed: a read-only repository workspace is acceptable only if clean. */
export function repositoryIsClean(checkoutPath) {
  return repositoryStatus(checkoutPath)?.trim() === "";
}

function assertCurrentToken(db, runId, fencingToken) {
  const maxToken = db
    .query(`SELECT MAX(fencing_token) AS m FROM attempts WHERE run_id = ?`)
    .get(runId)?.m;
  return fencingToken === maxToken;
}

function recordFencedAttempt(
  db,
  { runId, attempt, actor, policyVersion, now = Date.now() },
) {
  const at = iso(now);
  const run = db.query(`SELECT state FROM runs WHERE run_id = ?`).get(runId);
  const state = run?.state ?? null;
  const record = {
    runId,
    from: state,
    to: "FENCED",
    actor,
    reason: "fenced_attempt",
    attempt,
    policyVersion,
    at,
  };
  const record_hash = hashJson(record);
  db.query(
    `INSERT INTO lifecycle_events
       (run_id, from_state, to_state, actor, reason, attempt, correlation_id, causation_id, policy_version, at, record_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    runId,
    state,
    "FENCED",
    actor,
    "fenced_attempt",
    attempt,
    null,
    null,
    policyVersion,
    at,
    record_hash,
  );
}

function latestJournalHash(db, runId) {
  return (
    db
      .query(
        `SELECT record_hash FROM lifecycle_events WHERE run_id = ? ORDER BY seq DESC LIMIT 1`,
      )
      .get(runId)?.record_hash ?? null
  );
}

function receiptWithDeadlineExtensions(db, runId, options) {
  const receipt = createReceipt(options);
  const extensions = deadlineExtensions(db, runId);
  return extensions.length > 0
    ? { ...receipt, deadlineExtensions: canonicalJson(extensions) }
    : receipt;
}

/** The admitted event this run was planned from, via its proposal (may be absent). */
function originatingEvent(db, runId) {
  return (
    db
      .query(
        `SELECT e.type, e.event_id, e.correlation_id, e.causation_id, p.event_source AS source
       FROM proposals p
       JOIN events e ON e.source = p.event_source AND e.event_id = p.event_id
       WHERE p.run_id = ?
       LIMIT 1`,
      )
      .get(runId) ?? null
  );
}

function resultArtifactForRun(db, runId) {
  const row = db
    .query(
      `SELECT result_json FROM results WHERE run_id = ? ORDER BY attempt DESC LIMIT 1`,
    )
    .get(runId);
  if (!row?.result_json) return null;
  try {
    return JSON.parse(row.result_json)?.artifact ?? null;
  } catch {
    return null;
  }
}

function failureReasonCodeForRun(db, runId) {
  return (
    db
      .query(
        `SELECT reason_code AS reasonCode
           FROM attempts
          WHERE run_id = ? AND finished_at IS NOT NULL
          ORDER BY attempt DESC
          LIMIT 1`,
      )
      .get(runId)?.reasonCode ?? null
  );
}

function tierEscalationForContinuation(db, runId) {
  const row = db
    .query(`SELECT * FROM tier_escalations WHERE continuation_run_id = ?`)
    .get(runId);
  if (!row) return null;
  return {
    rootRunId: row.root_run_id,
    failedRunId: row.failed_run_id,
    continuationRunId: row.continuation_run_id,
    repo: row.repo,
    ticket: row.ticket,
    workspacePath: row.workspace_path,
    sourceWorkspacePath: row.source_workspace_path,
    projectionState: row.projection_state,
    failedRunArtifact: resultArtifactForRun(db, row.failed_run_id),
    failedRunReasonCode: failureReasonCodeForRun(db, row.failed_run_id),
  };
}

/**
 * Only diagnostics the next dispatch can act on belong in its continuation.
 * Each violation is matched on its own, anchored at its start: a
 * `repo_verify_failed:` reason that merely quotes a `web_build_failed:` line
 * inside its output is not a handoff failure, and a pre-joined
 * `ContractViolation.message` is split back into its lines first.
 */
export function continuationHandoffFailure(violations) {
  if (
    typeof violations === "string" &&
    /^contract_violation: missing_result\b/.test(violations)
  ) {
    return violations;
  }
  const lines = Array.isArray(violations)
    ? violations
    : typeof violations === "string"
      ? violations.split(/;\s+(?=[a-z_]+:)/)
      : [];
  const failure = lines.find(
    (line) =>
      typeof line === "string" &&
      /^(?:(?:web_build_failed|ticket_verify_failed):|contract_violation: missing_result\b)/.test(
        line,
      ),
  );
  return failure ?? null;
}

/**
 * Pick the continuation's handoff failure from a verification failure. The
 * matcher anchors each violation at its start, so the composed
 * `<reasonCode>: ...` failure reason (`handoff_verification_failed: web_build_failed: ...`)
 * would defeat it; only the `missing_result` diagnostic lives in that string.
 */
export function escalationHandoffFailure(error, failureReason) {
  const violations = Array.isArray(error?.violations) ? error.violations : [];
  const missingResult =
    violations.length === 1 && violations[0] === "missing_result";
  return continuationHandoffFailure(missingResult ? failureReason : violations);
}

/** Add worker-observed handoff context without mutating the validated spec. */
export function continuationExecutionInput(input, handoffFailure) {
  return typeof handoffFailure === "string" && handoffFailure
    ? { ...input, handoffFailure }
    : input;
}

/** Leave a foreign-owned escalation in an explicit terminal projection state. */
function refuseTierEscalationClaim(db, handoff, reasonCode) {
  if (
    !handoff?.rootRunId ||
    !handoff?.failedRunId ||
    !handoff?.continuationRunId
  )
    return false;
  const changed = db
    .query(
      `UPDATE tier_escalations
          SET projection_state = 'refused', projection_error = ?
        WHERE root_run_id = ?
          AND failed_run_id = ?
          AND continuation_run_id = ?
          AND projection_state <> 'refused'`,
    )
    .run(
      reasonCode,
      handoff.rootRunId,
      handoff.failedRunId,
      handoff.continuationRunId,
    );
  return changed.changes === 1;
}

/** Create exactly one auto-approved continuation and durable workspace transfer. */
export function scheduleTierEscalation(
  db,
  registry,
  failedSpec,
  {
    workspacePath,
    sourceWorkspacePath,
    actor = "worker",
    policyVersion = failedSpec.policyVersion,
    now = Date.now(),
    continuationRunId = newRunId(),
    reasonCode,
    handoffFailure = null,
    continuationGuard = null,
  } = {},
) {
  const rootRunId = failedSpec.rootRunId ?? failedSpec.runId;
  const existing = db
    .query(`SELECT * FROM tier_escalations WHERE root_run_id = ?`)
    .get(rootRunId);
  if (existing) return existing;
  if (!tierEscalationEligibility(failedSpec, reasonCode).eligible) return null;
  if (continuationGuard?.skip) return null;
  if (!workspacePath || !sourceWorkspacePath)
    throw new Error("tier escalation requires the retained workspace paths");

  const origin = originatingEvent(db, failedSpec.runId);
  const spec = buildEscalatedContinuationSpec(registry, failedSpec, {
    runId: continuationRunId,
    operatorAuthorized: origin?.source === "operator",
    handoffFailure,
  });
  const at = iso(now);
  const eventId = `tier-escalation:${rootRunId}`;
  const envelope = {
    schemaVersion: "factory.event/v1",
    eventId,
    type: origin?.type ?? "factory.dispatch.requested",
    source: "handoff",
    subject: failedSpec.agent,
    occurredAt: at,
    correlationId: origin?.correlation_id ?? rootRunId,
    causationId: failedSpec.runId,
    payload: spec.input,
  };
  db.query(
    `INSERT OR IGNORE INTO events
       (source, event_id, type, subject, occurred_at, received_at,
        correlation_id, causation_id, envelope_json, payload_hash, status,
        admitted_at)
     VALUES ('handoff', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?)`,
  ).run(
    eventId,
    envelope.type,
    failedSpec.agent,
    at,
    at,
    envelope.correlationId,
    failedSpec.runId,
    canonicalJson(envelope),
    hashJson(spec.input),
    at,
  );
  createRun(db, {
    runId: continuationRunId,
    idempotencyKey: spec.idempotencyKey,
    spec,
    specJson: canonicalJson(spec),
    specHash: hashJson(spec),
    actor,
    correlationId: envelope.correlationId,
    causationId: failedSpec.runId,
    policyVersion,
    now,
  });
  transition(db, {
    runId: continuationRunId,
    to: "APPROVED",
    expectFrom: "PROPOSED",
    actor,
    reason: `auto_approved:tier-escalation:${failedSpec.runId}`,
    correlationId: envelope.correlationId,
    causationId: failedSpec.runId,
    policyVersion,
    now,
  });
  db.query(
    `INSERT INTO proposals
       (id, event_source, event_id, run_id, decision, spec_json, spec_hash,
        idempotency_key, status, reason, created_at, ttl_seconds, decided_at,
        decided_by)
     VALUES (?, 'handoff', ?, ?, 'run', ?, ?, ?, 'approved', ?, ?, 0, ?, ?)`,
  ).run(
    `tier-escalation:${rootRunId}`,
    eventId,
    continuationRunId,
    canonicalJson(spec),
    hashJson(spec),
    spec.idempotencyKey,
    `escalated_from:${failedSpec.runId}`,
    at,
    at,
    actor,
  );
  db.query(
    `INSERT INTO tier_escalations
       (root_run_id, failed_run_id, continuation_run_id, repo, ticket,
        workspace_path, source_workspace_path, projection_state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(
    rootRunId,
    failedSpec.runId,
    continuationRunId,
    failedSpec.input.repo,
    String(failedSpec.input.ticket),
    workspacePath,
    sourceWorkspacePath,
    at,
  );
  return db
    .query(`SELECT * FROM tier_escalations WHERE root_run_id = ?`)
    .get(rootRunId);
}

const TIER_ESCALATION_COMMENT_MARKER = "factory:tier-escalation:";

export function defaultFindWorkspacePullRequest({ workspacePath, forge }) {
  if (!workspacePath) return null;
  const branch = execFileSync(
    "git",
    ["-C", workspacePath, "branch", "--show-current"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
  if (!branch) return null;
  const pullRequest = (forge ?? loadForge())
    .prList(null, {
      cwd: workspacePath,
      state: "open",
      fields: ["number", "url", "headRefName", "isDraft"],
      timeout: workerSubprocessTimeoutMs(),
    })
    .find((pr) => pr?.headRefName === branch && pr?.url);
  if (pullRequest) return pullRequest;

  // A local branch alone is not resumable evidence. Confirm that this exact
  // head exists at origin before producing the BLOCKED recovery artifact.
  // A hung or failing ls-remote must not wedge recovery: bound it like the
  // prList call above and treat any failure as "no pushed branch".
  let remote;
  try {
    remote = execFileSync(
      "git",
      [
        "-C",
        workspacePath,
        "ls-remote",
        "--heads",
        "origin",
        `refs/heads/${branch}`,
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: workerSubprocessTimeoutMs(),
        killSignal: "SIGKILL",
      },
    ).trim();
  } catch {
    return null;
  }
  return remote ? { pushedBranch: branch } : null;
}

const MISSING_RESULT_OUTPUT_CHARS = 2 * 1024;

function missingResultFailure(workspaceDir, error = null) {
  const resultPath = path.resolve(workspaceDir, "result.json");
  const fallbackPaths = error?.missingResultFallbacks ?? [];
  const stalePaths = error?.missingResultPaths ?? [];
  const output = [
    ["stdout", ".transcript.json"],
    ["stderr", ".stderr.txt"],
    ["sandbox console", ".sandbox-console.log"],
  ]
    .flatMap(([label, file]) => {
      try {
        return [
          `[${label}]`,
          readFileSync(path.join(workspaceDir, file), "utf8"),
        ];
      } catch {
        return [];
      }
    })
    .join("\n");
  const normalized = normalizeFailureOutput(output).join("\n");
  const tail = normalized.slice(-MISSING_RESULT_OUTPUT_CHARS);
  const fallbackDetail = fallbackPaths.length
    ? `; probed fallbacks ${fallbackPaths.join(", ")}`
    : "";
  const staleDetail = stalePaths.length
    ? `; stale result.json found at ${stalePaths.map(({ path: candidatePath, mtime }) => `${candidatePath} (mtime ${mtime}, before this attempt started)`).join(", ")}`
    : "";
  return `missing_result: expected ${resultPath}${fallbackDetail}${staleDetail}; agent stdout/stderr (last 2 KB): ${tail || "(no captured output)"}`;
}

/**
 * Recover the one contract failure whose durable work may already be complete.
 * The finder resolves the branch from the checkout; the PR read then proves
 * the agent reached its final Handoff before the worker authors result.json.
 * The artifact stays inside the registered `factory.dispatch-result/v1`
 * schema (`additionalProperties: false`); the observed head SHA is carried as
 * top-level evidence so the real definition verifies the synthesized result.
 */
export function recoverMissingDispatchResult({
  error,
  spec,
  def,
  workspaceDir,
  worktreeRecord,
  findPullRequest = defaultFindWorkspacePullRequest,
  fetchPullRequest = defaultFetchHandoffPullRequest,
}) {
  if (
    spec?.agent !== "dispatch@1" ||
    !(error instanceof ContractViolation) ||
    error.violations.length !== 1 ||
    error.violations[0] !== "missing_result" ||
    !worktreeRecord?.path
  ) {
    return null;
  }

  let listed;
  try {
    listed = findPullRequest({
      workspacePath: worktreeRecord.path,
      github: worktreeRecord.github,
    });
  } catch (err) {
    if (err?.code === "forge_rate_limited") {
      throw new ContractViolation(
        ["handoff_forge_unavailable: GitHub rate limited recovery PR lookup"],
        { reasonCode: HANDOFF_FORGE_UNAVAILABLE },
      );
    }
    return null;
  }
  if (typeof listed?.pushedBranch === "string" && listed.pushedBranch) {
    const base = worktreeRecord.base ?? "<configured-base>";
    const resumeCommand = `gh pr create --base ${base} --title "..." --body "Fixes ${spec.input?.ticket}"`;
    const candidate = {
      schemaVersion: "factory.agent-result/v1",
      terminalState: "completed",
      reasonCode: "pushed_branch_no_pr",
      artifact: {
        outcome: "BLOCKED",
        repo: spec.input?.repo,
        ticket: spec.input?.ticket,
        prUrl: null,
        prNumber: null,
        verification: { command: null, passed: false, output: "" },
        summary: `Branch ${listed.pushedBranch} is pushed but has no PR; resume with ${resumeCommand}`,
      },
      evidence: {
        branch: listed.pushedBranch,
        resumeCommand,
        commands: [
          `git -C ${worktreeRecord.path} branch --show-current`,
          `git -C ${worktreeRecord.path} ls-remote --heads origin refs/heads/${listed.pushedBranch}`,
          "forge.prList(open, headRefName)",
        ],
      },
    };
    writeFileSync(
      path.join(workspaceDir, "result.json"),
      `${JSON.stringify(candidate, null, 2)}\n`,
      "utf8",
    );
    return { candidate, retainWorkspace: true };
  }
  const prNumber = Number(listed?.number);
  if (!Number.isInteger(prNumber) || prNumber < 1 || !listed?.url) return null;
  if (listed?.state && String(listed.state).toUpperCase() !== "OPEN")
    return null;

  let pullRequest;
  try {
    pullRequest = fetchPullRequest({
      github: worktreeRecord.github,
      prNumber,
    });
  } catch (err) {
    if (err?.code === "forge_rate_limited") {
      throw new ContractViolation(
        ["handoff_forge_unavailable: GitHub rate limited recovery PR read"],
        { reasonCode: HANDOFF_FORGE_UNAVAILABLE },
      );
    }
    return null;
  }
  const body = pullRequest?.body ?? listed?.body;
  if (typeof body !== "string" || !/^## Handoff\s*$/m.test(body)) return null;

  const headSha = pullRequest?.headRefOid ?? listed?.headRefOid ?? null;
  if (!/^[0-9a-f]{40}$/.test(String(headSha))) return null;

  const verificationCommand =
    worktreeRecord.handoff?.verificationCommand ??
    worktreeRecord.verify ??
    null;
  const candidate = {
    schemaVersion: "factory.agent-result/v1",
    terminalState: "completed",
    reasonCode: RECOVERED_RESULT_REASON,
    artifact: {
      outcome: "PR_OPEN",
      repo: spec.input?.repo,
      ticket: spec.input?.ticket,
      prUrl: listed.url,
      prNumber,
      verification: {
        command: verificationCommand,
        passed: true,
        output: "worker recovery; normal handoff verification pending",
      },
      summary:
        "Worker recovered an open PR after the agent omitted result.json",
    },
    evidence: {
      headSha,
      commands: [
        `git -C ${worktreeRecord.path} branch --show-current`,
        `forge.prList(open, headRefName)`,
        `forge.prView(${prNumber})`,
      ],
    },
  };
  writeFileSync(
    path.join(workspaceDir, "result.json"),
    `${JSON.stringify(candidate, null, 2)}\n`,
    "utf8",
  );
  return { candidate };
}

export function defaultProjectTierEscalation({
  repo,
  ticket,
  failedRunId,
  continuationRunId,
  workspacePath,
  fetchTicket,
  runCli = runLinearCli,
  findPullRequest = defaultFindWorkspacePullRequest,
}) {
  const current =
    typeof fetchTicket === "function"
      ? fetchTicket(ticket, repo)
      : JSON.parse(runCli(["get", ticket, "--json"], { repo }));
  const names = (
    Array.isArray(current?.labels)
      ? current.labels
      : (current?.labels?.nodes ?? [])
  )
    .map((label) => label?.name)
    .filter(Boolean);
  const tierLabels = names.filter(
    (name) => name.startsWith("tier:") && name !== "tier:strong",
  );
  runCli(
    [
      "labels",
      ticket,
      "--add",
      "tier:strong",
      ...tierLabels.flatMap((name) => ["--remove", name]),
    ],
    { repo },
  );
  const marker = `${TIER_ESCALATION_COMMENT_MARKER}${failedRunId}:${continuationRunId}`;
  let alreadyCommented = false;
  try {
    const comments = JSON.parse(
      runCli(["comments", ticket, "--json"], { repo }),
    );
    alreadyCommented = comments.some((entry) =>
      String(entry?.body ?? "").includes(marker),
    );
  } catch {
    // A comment read is an idempotency optimization. Posting remains required.
  }
  let existingPullRequest = null;
  if (workspacePath) {
    try {
      existingPullRequest = findPullRequest({ workspacePath });
    } catch {
      // PR discovery enriches the escalation notice. The durable run ids are
      // still sufficient to project the continuation when the forge is down.
    }
  }
  if (!alreadyCommented) {
    const prLine = existingPullRequest?.url
      ? `\n\nRetained worktree PR: ${existingPullRequest.url}`
      : "";
    runCli(
      [
        "comment",
        ticket,
        `Tier escalation scheduled: failed run \`${failedRunId}\` continues as strong run \`${continuationRunId}\` in the same retained worktree.${prLine}\n\n<!-- ${marker} -->`,
      ],
      { repo },
    );
  }
  return true;
}

/** Retry pending tracker projections before a continuation can become runnable. */
export function reconcileTierEscalations(
  db,
  {
    projectTierEscalation = defaultProjectTierEscalation,
    fetchTicket,
    now = Date.now(),
    policyVersion = "unknown",
  } = {},
) {
  const row = db
    .query(
      `SELECT * FROM tier_escalations WHERE projection_state = 'pending' ORDER BY created_at LIMIT 1`,
    )
    .get();
  if (!row) return { ok: true, projected: 0 };
  try {
    const projected = projectTierEscalation({
      repo: row.repo,
      ticket: row.ticket,
      failedRunId: row.failed_run_id,
      continuationRunId: row.continuation_run_id,
      workspacePath: row.workspace_path,
      fetchTicket,
    });
    if (projected === false)
      throw new Error("tracker projection returned false");
  } catch (err) {
    db.query(
      `UPDATE tier_escalations
          SET projection_attempts = projection_attempts + 1,
              projection_error = ?
        WHERE root_run_id = ?`,
    ).run(String(err?.message ?? err), row.root_run_id);
    return {
      ok: false,
      reasonCode: "tier_escalation_writeback_failed",
      continuationRunId: row.continuation_run_id,
      error: String(err?.message ?? err),
    };
  }
  txImmediate(db, () => {
    const at = iso(now);
    db.query(
      `UPDATE tier_escalations
          SET projection_state = 'applied', projection_attempts = projection_attempts + 1,
              projection_error = NULL, projected_at = ?
        WHERE root_run_id = ? AND projection_state = 'pending'`,
    ).run(at, row.root_run_id);
    const state = db
      .query(`SELECT state FROM runs WHERE run_id = ?`)
      .get(row.continuation_run_id)?.state;
    if (state === "APPROVED") {
      transition(db, {
        runId: row.continuation_run_id,
        to: "QUEUED",
        expectFrom: "APPROVED",
        actor: "tier-escalation",
        reason: `tracker_projection_applied:${row.failed_run_id}`,
        causationId: row.failed_run_id,
        policyVersion,
        now,
      });
    }
  });
  return {
    ok: true,
    projected: 1,
    continuationRunId: row.continuation_run_id,
  };
}

/**
 * Claim the oldest QUEUED run: bump the attempt counter, take a lease with a
 * fresh fencing token, and move it to LEASED — all in one transaction.
 *
 * @returns {{ runId: string, attempt: number, fencingToken: number, spec: object } | { runId: string, spec: object, refused: true, retryable: true, reloadRequired: boolean, reasonCode: "registry_stale", workerRegistryVersion: string, checkoutRegistryVersion: string } | null}
 */
export function claimNext(
  db,
  {
    owner,
    now = () => Date.now(),
    policyVersion = "unknown",
    registryVersion = null,
    currentRegistryVersion = null,
    labels = {},
    adapters = null,
    adapterOverride,
    projectTierEscalation = defaultProjectTierEscalation,
    fetchTicket,
    onTierEscalationProjectionError = (entry) =>
      console.error(
        `[worker] ${entry.reasonCode} for ${entry.continuationRunId}: ${entry.error}`,
      ),
  } = {},
) {
  // Production workers call claimNext() directly rather than runOnce(). Do
  // this before looking for QUEUED work so a restart cannot strand a durable
  // escalation in APPROVED after the scheduling transaction committed but
  // before its tracker projection completed.
  const pendingEscalation = reconcileTierEscalations(db, {
    projectTierEscalation,
    fetchTicket,
    now,
    policyVersion,
  });
  if (!pendingEscalation.ok) onTierEscalationProjectionError(pendingEscalation);
  // BEGIN IMMEDIATE, not the default deferred transaction: two workers must
  // not both read the same QUEUED row before either writes (OPS-233).
  return txImmediate(db, () => {
    const claimNow = resolveNow(now);
    // Claim-lock backoff is recorded on the latest QUEUED lifecycle event.
    // updated_at cannot be treated as a generic not-before because tests and
    // event replay may enqueue rows whose source timestamps are ahead of this
    // worker's clock.
    const candidates = db
      .query(
        `SELECT r.run_id, r.spec_json, r.attempts,
                le.reason AS queue_reason, le.at AS queued_at
           FROM runs r
           JOIN lifecycle_events le ON le.seq = (
             SELECT MAX(latest.seq) FROM lifecycle_events latest WHERE latest.run_id = r.run_id
           )
          WHERE r.state = 'QUEUED'
          ORDER BY r.created_at, r.run_id`,
      )
      .all();
    let row = null;
    let spec = null;
    let staleRefusal = null;
    let checkoutVersion;
    const resolveCheckoutVersion = () => {
      if (checkoutVersion !== undefined) return checkoutVersion;
      checkoutVersion =
        typeof currentRegistryVersion === "function"
          ? currentRegistryVersion()
          : currentRegistryVersion;
      return checkoutVersion;
    };
    for (const candidate of candidates) {
      const backoff =
        /^(?:claim_lock_contention:\d+|dispatch_gate_transient:[^:]+:\d+):backoff_(\d+)ms$/.exec(
          candidate.queue_reason ?? "",
        );
      if (
        backoff &&
        Date.parse(candidate.queued_at) + Number(backoff[1]) > claimNow
      )
        continue;
      const candidateSpec = JSON.parse(candidate.spec_json);
      if (!satisfiesPlacement(labels, candidateSpec.placement)) continue;
      if (
        adapters &&
        !adapterOverride &&
        !adapters.includes(candidateSpec.adapter)
      )
        continue;
      // The worker snapshots the registry and policy at startup. A run planned
      // against another checkout must stay QUEUED; leasing it would execute and
      // validate with incompatible definitions. Compare the live checkout too
      // so only an actually stale worker reloads — an older queued spec must not
      // put a fresh supervisor into an endless exit-75 loop.
      if (
        registryVersion &&
        (candidateSpec.promptVersion !== registryVersion ||
          candidateSpec.policyVersion !== registryVersion)
      ) {
        const current = resolveCheckoutVersion();
        const reloadRequired =
          candidateSpec.promptVersion === current &&
          candidateSpec.policyVersion === current &&
          registryVersion !== current;
        const refusal = {
          runId: candidate.run_id,
          spec: candidateSpec,
          refused: true,
          retryable: true,
          reloadRequired,
          reasonCode: "registry_stale",
          workerRegistryVersion: registryVersion,
          checkoutRegistryVersion: current,
        };
        if (reloadRequired) return refusal;
        staleRefusal ??= refusal;
        continue;
      }
      row = candidate;
      spec = candidateSpec;
      break;
    }
    if (!row) return staleRefusal;
    const attempt = row.attempts + 1;
    const fencingToken = nextCounter(db, "fencing");
    const leaseExpiresAt = iso(
      claimNow + (spec.timeoutSeconds + LEASE_GRACE_SECONDS) * 1000,
    );

    db.query(
      `UPDATE runs SET attempts = ?, updated_at = ? WHERE run_id = ?`,
    ).run(attempt, iso(claimNow), row.run_id);
    db.query(
      `INSERT INTO attempts (run_id, attempt, fencing_token, lease_owner, lease_expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(row.run_id, attempt, fencingToken, owner, leaseExpiresAt);
    transition(db, {
      runId: row.run_id,
      to: "LEASED",
      expectFrom: "QUEUED",
      actor: owner,
      reason: "claimed",
      attempt,
      policyVersion,
      now: claimNow,
    });

    return { runId: row.run_id, attempt, fencingToken, spec };
  });
}

function defaultIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function defaultLocksDir() {
  if (process.env.FACTORY_LOCKS_DIR) return process.env.FACTORY_LOCKS_DIR;
  // Ticket claims must share the dispatcher lock, not this runtime instance's
  // private event home. Supervisors use one tracker identity, so an assignee
  // read-back cannot distinguish two concurrent claims from this machine.
  return path.join(homedir(), ".factory", "locks");
}

export function dispatchLockPath(repoName, root = defaultLocksDir()) {
  return path.join(root, `${repoName}.dispatch.lock`);
}

export function acquireClaimLock(
  lockFile,
  { pid = process.pid, now = Date.now(), isAlive = defaultIsAlive } = {},
) {
  mkdirSync(path.dirname(lockFile), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockFile, `${pid} ${now}\n`, { flag: "wx" });
      return true;
    } catch {
      let lockPid;
      try {
        const content = readFileSync(lockFile, "utf8").trim();
        [lockPid] = content.split(/\s+/).map(Number);
      } catch {
        return false;
      }
      const alive = isAlive(lockPid);
      // Age alone is not proof of abandonment: a slow but live Linear claim
      // must retain mutual exclusion. Only a dead owner makes the lock stale.
      if (alive) return false;
      try {
        unlinkSync(lockFile);
      } catch {
        /* intentionally ignored */
      }
    }
  }
  return false;
}

export function releaseClaimLock(lockFile) {
  try {
    unlinkSync(lockFile);
  } catch {
    /* intentionally ignored */
  }
}

function claimLockBackoffMs(contentionNumber, random = Math.random) {
  const cap = Math.min(
    CLAIM_LOCK_BACKOFF_MAX_MS,
    CLAIM_LOCK_BACKOFF_BASE_MS * 2 ** Math.max(0, contentionNumber - 1),
  );
  const sample = Math.min(1, Math.max(0, Number(random()) || 0));
  return Math.floor(cap / 2 + (sample * cap) / 2);
}

/**
 * Put a run that never acquired the claim lock back in the queue without
 * spending its execution attempt. The lifecycle reason and timestamp form a
 * durable not-before value consumed by claimNext().
 */
function deferClaimLockContention(
  db,
  {
    runId,
    attempt,
    fencingToken,
    owner,
    policyVersion,
    now,
    maxRequeues = DEFAULT_MAX_CLAIM_LOCK_REQUEUES,
    random = Math.random,
  },
) {
  return txImmediate(db, () => {
    const currentNow = resolveNow(now);
    if (!assertCurrentToken(db, runId, fencingToken)) {
      recordFencedAttempt(db, {
        runId,
        attempt,
        actor: owner,
        policyVersion,
        now: currentNow,
      });
      return { fenced: true };
    }
    const prior = Number(
      db
        .query(
          `SELECT COUNT(*) AS n FROM lifecycle_events
       WHERE run_id = ? AND reason LIKE 'claim_lock_contention:%'`,
        )
        .get(runId)?.n ?? 0,
    );
    if (prior >= maxRequeues) return { starved: true, contentions: prior };

    const contentionNumber = prior + 1;
    const backoffMs = claimLockBackoffMs(contentionNumber, random);
    transition(db, {
      runId,
      to: "QUEUED",
      expectFrom: "RUNNING",
      actor: owner,
      reason: `claim_lock_contention:${contentionNumber}:backoff_${backoffMs}ms`,
      attempt,
      policyVersion,
      now: currentNow,
    });
    db.query(`DELETE FROM attempts WHERE run_id = ? AND attempt = ?`).run(
      runId,
      attempt,
    );
    db.query(`UPDATE runs SET attempts = ? WHERE run_id = ?`).run(
      attempt - 1,
      runId,
    );
    return { requeued: true, contentions: contentionNumber, backoffMs };
  });
}

/**
 * A plan-time eligibility proof makes a contradictory claim-time Linear read
 * distinguishable from a real gate refusal. Defer those reads without spending
 * an execution attempt, with the same durable not-before mechanism as the
 * machine-local claim lock.
 */
function deferTransientDispatchGate(
  db,
  {
    runId,
    attempt,
    fencingToken,
    owner,
    policyVersion,
    now,
    reasonCode,
    expectFrom = "RUNNING",
    maxRequeues = DEFAULT_MAX_TRANSIENT_GATE_REQUEUES,
    random = Math.random,
  },
) {
  return txImmediate(db, () => {
    const currentNow = resolveNow(now);
    if (!assertCurrentToken(db, runId, fencingToken)) {
      recordFencedAttempt(db, {
        runId,
        attempt,
        actor: owner,
        policyVersion,
        now: currentNow,
      });
      return { fenced: true };
    }
    const prior = Number(
      db
        .query(
          `SELECT COUNT(*) AS n FROM lifecycle_events
       WHERE run_id = ? AND reason GLOB ?`,
        )
        .get(runId, `dispatch_gate_transient:${reasonCode}:*`)?.n ?? 0,
    );
    if (prior >= maxRequeues) return { exhausted: true, requeues: prior };

    const requeueNumber = prior + 1;
    const backoffMs = claimLockBackoffMs(requeueNumber, random);
    // VERIFYING normally only reaches a terminal state. A transient forge
    // read is different: preserve the legal lifecycle journal without
    // finalizing (or charging) this attempt, then use the same QUEUED
    // transient-gate record as the pre-execution path.
    if (expectFrom === "VERIFYING") {
      transition(db, {
        runId,
        to: "FAILED",
        expectFrom,
        actor: owner,
        reason: `handoff_transient:${reasonCode}`,
        attempt,
        policyVersion,
        now: currentNow,
      });
    }
    transition(db, {
      runId,
      to: "QUEUED",
      expectFrom: expectFrom === "VERIFYING" ? "FAILED" : expectFrom,
      actor: owner,
      reason: `dispatch_gate_transient:${reasonCode}:${requeueNumber}:backoff_${backoffMs}ms`,
      attempt,
      policyVersion,
      now: currentNow,
    });
    db.query(`DELETE FROM attempts WHERE run_id = ? AND attempt = ?`).run(
      runId,
      attempt,
    );
    db.query(`UPDATE runs SET attempts = ? WHERE run_id = ?`).run(
      attempt - 1,
      runId,
    );
    return { requeued: true, requeues: requeueNumber, backoffMs };
  });
}

function hasPlanTimeDispatchEvidence(spec) {
  return Boolean(
    spec?.approvalPolicy?.dispatchEvidence?.ticket?.descriptionHash,
  );
}

/**
 * A reaped lease leaves the Linear claim in place. Prove from the attempt
 * ledger that this new attempt belongs to the same run and immediately follows
 * a lease-expired claim before relaxing the Todo/unassigned dispatch gate.
 */
export function claimedRetryFor(db, runId, attempt) {
  if (!Number.isInteger(attempt) || attempt <= 1) return null;
  const priorAttempt = attempt - 1;
  const prior = db
    .query(
      `SELECT terminal_state, reason_code FROM attempts WHERE run_id = ? AND attempt = ?`,
    )
    .get(runId, priorAttempt);
  if (
    prior?.terminal_state !== "FAILED" ||
    prior?.reason_code !== "lease_expired"
  )
    return null;
  const requeue = db
    .query(
      `SELECT reason FROM lifecycle_events
     WHERE run_id = ? AND to_state = 'QUEUED' AND attempt = ?
     ORDER BY seq DESC LIMIT 1`,
    )
    .get(runId, priorAttempt);
  if (requeue?.reason !== "retry:environment") return null;
  return { runId, priorAttempt, reasonCode: "lease_expired" };
}

/**
 * Verify the operator authorisation against the run input and live ticket
 * bytes before an agent can see it. Decision effects mint descriptionHash with hashBytes(description)
 * (UTF-8, no appended newline); keeping the inverse here removes the model's
 * former freedom to choose a different byte recipe.
 *
 * The returned input is an execution-only copy. The durable RunSpec remains
 * immutable, while input.json and the adapter receive verified: true.
 */
export function humanDecisionAuthorisationGate(
  input,
  { fetchTicket = defaultFetchTicket } = {},
) {
  const authorisation = input?.humanDecision?.authorisation;
  if (!authorisation) return { ok: true, input };

  // The authorisation is single-use and bound to one ticket: decision effects
  // mint it with the inbox item's issue/repo refs. A copy carried into another
  // run's input must never authorise that run.
  if (
    String(authorisation.ticket ?? "") !== String(input?.ticket ?? "") ||
    String(authorisation.repo ?? "") !== String(input?.repo ?? "")
  ) {
    return {
      ok: false,
      refusal: {
        decision: "noop",
        reason: "authorisation_stale:ticket",
        detail:
          "humanDecision.authorisation.ticket/repo do not match the run input ticket/repo",
      },
      evidence: { descriptionHash: null, ownedPaths: [] },
    };
  }

  const ticket = fetchTicket(input.ticket, input.repo);
  const description = ticket?.description;
  const descriptionHash =
    typeof description === "string" ? hashBytes(description) : null;
  const ownedPaths =
    typeof description === "string" ? parseOwnedPaths(description) : [];
  // Refusal evidence is a fingerprint, never the raw ticket JSON.
  const evidence = { descriptionHash, ownedPaths };

  if (
    descriptionHash === null ||
    authorisation.descriptionHash !== descriptionHash
  ) {
    return {
      ok: false,
      refusal: {
        decision: "noop",
        reason: "authorisation_stale:description",
        detail:
          "humanDecision.authorisation.descriptionHash does not match the canonical hashBytes of the current ticket description",
      },
      evidence,
    };
  }

  // The operator may narrow the scope (decision-effects authorisedPaths keeps
  // only the chosen paths), so `paths` must be a non-empty subset of the
  // ticket's current Owned Paths — "authorisation.paths ∩ Owned Paths" in
  // docs/event-runtime-inbox.md §3.1. Anything outside Owned Paths means the
  // ticket's scope moved after approval; an empty set authorises nothing.
  const authorisedPaths = Array.isArray(authorisation.paths)
    ? authorisation.paths.filter((entry) => typeof entry === "string")
    : [];
  const ownedSet = new Set(ownedPaths);
  const foreignPaths = authorisedPaths.filter((entry) => !ownedSet.has(entry));
  if (authorisedPaths.length === 0 || foreignPaths.length > 0) {
    return {
      ok: false,
      refusal: {
        decision: "noop",
        reason: "authorisation_stale:paths",
        detail:
          authorisedPaths.length === 0
            ? "humanDecision.authorisation.paths is empty; nothing is authorised"
            : `humanDecision.authorisation.paths is not a subset of the ticket's Owned Paths: ${foreignPaths.join(", ")}`,
      },
      evidence,
    };
  }

  return {
    ok: true,
    input: {
      ...input,
      humanDecision: {
        ...input.humanDecision,
        authorisation: { ...authorisation, verified: true },
      },
    },
    evidence: { ...evidence, ticket },
  };
}

function contradictsPlanTimeOwnedPaths(spec, gateResult) {
  const planned = spec?.approvalPolicy?.dispatchEvidence?.ticket;
  const current = gateResult?.evidence?.ticket;
  return Boolean(
    planned?.descriptionHash &&
    planned.ownedPathsParsed === true &&
    current?.ownedPathsParsed === false &&
    current.descriptionHash !== planned.descriptionHash,
  );
}

// ---------------------------------------------------------------------------
// Dev live-reload: code stamp + drain-aware reload watcher (WM-213)
// ---------------------------------------------------------------------------

/**
 * Exit code the worker uses to ask its supervisor for a restart. Distinct from
 * 0 (drained cleanly — stay down) and from any crash, so `bin/live-stack.sh
 * __supervise-worker` re-execs on exactly this and nothing else.
 */
export const CODE_RELOAD_EXIT = 75;

/** Uncached checkout provenance, used to distinguish a stale worker from a stale queued spec. */
export function checkoutPolicyVersion(repoRoot = FACTORY_ROOT) {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: workerSubprocessTimeoutMs(),
    }).trim();
    return `git:${sha}`;
  } catch {
    return "unknown";
  }
}

/**
 * Data that changes the meaning of a planned run.  Keep this separate from
 * the executable paths so callers that add another code directory cannot
 * accidentally drop the registry inputs from the worker stamp.
 */
export const REGISTRY_STAMP_PATHS = [
  "event-runtime/agents",
  "event-runtime/schemas",
  "event-runtime/event-types.json",
  "event-runtime/edges.json",
  "event-runtime/schedules.json",
];

/** The effective local config, including the clean-checkout example fallback. */
export function resolvedRegistryConfigPaths(repoRoot = codeStampRoot()) {
  return ["policy", "schedule"].map((name) => {
    const local = `config/${name}.yaml`;
    return existsSync(path.join(repoRoot, local))
      ? local
      : `config/${name}.example.yaml`;
  });
}

/** What "the worker's code" is: executable code plus resolved registry data. */
export const CODE_STAMP_PATHS = [
  "event-runtime/lib",
  "event-runtime/cli.mjs",
  ...REGISTRY_STAMP_PATHS,
];

/** Re-stamping cadence. The poll loop is faster (500ms) and must not re-hash twice a second. */
export const RELOAD_CHECK_INTERVAL_MS = 1_000;

/**
 * Which checkout the stamp describes. `FACTORY_CODE_STAMP_ROOT` exists because
 * a worker can be started from a different checkout than the one it watches —
 * and because tests must be able to dirty a tree that is not this repo.
 */
export function codeStampRoot() {
  return process.env.FACTORY_CODE_STAMP_ROOT || FACTORY_ROOT;
}

function walkStampFiles(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walkStampFiles(abs, out);
    else if (entry.isFile()) out.push(abs);
  }
  return out;
}

/** Repo-relative, sorted list of the files the stamp covers. */
export function codeStampFiles(
  repoRoot = codeStampRoot(),
  paths = CODE_STAMP_PATHS,
) {
  const files = [];
  // cli/work.mjs adds event-runtime/cli to the executable set.  Always union
  // the registry inputs so that older/custom call sites cannot create a
  // code-only watcher which would execute stale definitions.
  for (const rel of new Set([
    ...paths,
    ...REGISTRY_STAMP_PATHS,
    ...resolvedRegistryConfigPaths(repoRoot),
  ])) {
    const abs = path.join(repoRoot, rel);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkStampFiles(abs, files);
    else if (st.isFile()) files.push(abs);
  }
  return files.map((f) => path.relative(repoRoot, f)).sort();
}

/**
 * A short, stable identity for the code and registry data this worker is
 * running: a content hash of the stamp paths.
 *
 * Contents, not mtimes — a `git checkout` that rewrites a file back to what it
 * already was must NOT bounce the worker, and an uncommitted edit must, which
 * a HEAD-only stamp misses entirely. Reading ~1MB once a second is free next
 * to the agent runs this loop supervises.
 */
export function codeStamp(
  repoRoot = codeStampRoot(),
  paths = CODE_STAMP_PATHS,
) {
  const hash = createHash("sha256");
  for (const rel of codeStampFiles(repoRoot, paths)) {
    hash.update(rel);
    hash.update("\0");
    try {
      hash.update(readFileSync(path.join(repoRoot, rel)));
    } catch {
      hash.update("<unreadable>");
    }
    hash.update("\0");
  }
  // Do not include HEAD: committing an unrelated README must not bounce every
  // worker when none of the bytes it executes or resolves changed.
  return `files:${hash.digest("hex").slice(0, 12)}`;
}

/**
 * Poll-boundary reload detection. `check(inFlight, { force })` is called by
 * the claim loop *between* claims and returns one of:
 *
 *   none      nothing changed (or it is not time to re-stamp yet)
 *   deferred  code changed but this worker holds a lease — keep going
 *   reload    code changed and the worker is idle — exit CODE_RELOAD_EXIT
 *
 * `deferred` can never become `reload` inside the same call, so a running
 * agent cannot be killed by a code change *by construction* — that is the
 * whole reason this is a poll-boundary check and not an fs watcher. Once a
 * change is seen it is latched (`pending`), so the reload happens on the very
 * next idle check rather than one interval later, and the stamp is not
 * recomputed while it waits.
 */
export function createReloadWatcher({
  repoRoot = codeStampRoot(),
  intervalMs = RELOAD_CHECK_INTERVAL_MS,
  stamp = () => codeStamp(repoRoot),
  now = () => Date.now(),
} = {}) {
  const from = stamp();
  let lastCheck = now();
  let pending = null;
  let deferredSeen = false;

  return {
    from,
    check(inFlight = null, { force = false } = {}) {
      if (!pending) {
        const at = now();
        // A completed run is a mandatory freshness boundary: force bypasses
        // only the cadence gate so a hot queue cannot hide a recent edit.
        if (!force && at - lastCheck < intervalMs)
          return { action: "none", from, to: from };
        lastCheck = at;
        const to = stamp();
        if (to === from) return { action: "none", from, to };
        pending = to;
      }
      if (inFlight) {
        const first = !deferredSeen;
        deferredSeen = true;
        return {
          action: "deferred",
          from,
          to: pending,
          runId: inFlight,
          first,
        };
      }
      return { action: "reload", from, to: pending };
    },
  };
}

const linearCli = () => path.join(FACTORY_ROOT, "tools", "ticket.mjs");

/**
 * Resolve Linear credentials from the environment, optionally reading an
 * explicitly configured env file. Tests and offline runs never read disk for
 * a key; their children inherit the same offline guard through process.env.
 */
export function resolveLinearApiKey({
  env = process.env,
  envFile = env.FACTORY_LINEAR_ENV_FILE,
} = {}) {
  if (env.LINEAR_API_KEY) return env.LINEAR_API_KEY;
  if (
    env.FACTORY_LINEAR_OFFLINE === "1" ||
    env.NODE_ENV === "test" ||
    env.BUN_TEST
  )
    return null;
  if (!envFile) return null;
  if (!existsSync(envFile)) return null;

  try {
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("="))
        continue;
      const idx = trimmed.indexOf("=");
      if (trimmed.slice(0, idx).trim() !== "LINEAR_API_KEY") continue;
      const value = trimmed
        .slice(idx + 1)
        .trim()
        .replace(/^['"]|['"]$/g, "");
      if (!value) return null;
      env.LINEAR_API_KEY = value;
      return value;
    }
  } catch {
    return null;
  }
  return null;
}

/** Execute one bounded Linear CLI operation; exported for timeout regression tests. */
export function runLinearCli(
  args,
  { command = "bun", timeoutMs = workerSubprocessTimeoutMs(), repo } = {},
) {
  // Do not even spawn the tracker CLI in test/offline mode. Besides making the
  // child inherit tools/ticket.mjs's fetch guard, this makes an omitted test
  // seam observable before a real executable can escape the test process.
  if (
    process.env.FACTORY_LINEAR_ALLOW_NETWORK !== "1" &&
    (process.env.FACTORY_LINEAR_OFFLINE === "1" ||
      process.env.NODE_ENV === "test" ||
      process.env.BUN_TEST)
  ) {
    const error = new Error(
      "linear_offline_guard: tracker CLI spawn is disabled in test/offline mode",
    );
    error.code = "linear_offline_guard";
    throw error;
  }
  // --repo so ticket.mjs resolves the ticket's OWN control plane. Without it a
  // Linear-repo claim/read runs against the worker cwd's plane (github) and
  // silently no-ops — the claim read-back then reports ticket_claim_lost,
  // blocking all dispatch for control_plane: linear repos (bj29, cashsaas).
  const full = repo
    ? [linearCli(), ...args, "--repo", repo]
    : [linearCli(), ...args];
  return execFileSync(command, full, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
  });
}

function defaultClaimTicket({ repo, ticket, harness = "claude" }) {
  try {
    runLinearCli(["claim", ticket, "--agent", harness], { repo });
    return { ok: true };
  } catch (err) {
    const stderr = String(err?.stderr ?? "");
    return { ok: false, error: stderr.trim().split("\n").pop() || err.message };
  }
}

// `runCli` is the test seam, mirroring the `fetchTicket` injection already
// here: the interesting behaviour is the exact argv this builds (WM-1024),
// and asserting "some mutation ran" was already true of the broken version.
export function defaultUnclaimTicket({
  repo,
  ticket,
  why,
  log = null,
  fetchTicket,
  runCli = runLinearCli,
}) {
  try {
    let cur = null;
    if (typeof fetchTicket === "function") {
      cur = fetchTicket(ticket);
    } else {
      const out = runCli(["get", ticket, "--json"], { repo });
      cur = JSON.parse(out);
    }
    if (!cur || cur.state?.name !== "In Progress") return false;
    if (
      !(Array.isArray(cur.labels) ? cur.labels : (cur.labels?.nodes ?? [])) // WM-978
        .some((l) => l.name === "ai:in-progress")
    )
      return false;

    // WM-1024: `Todo` + unassigned is NOT dispatchable — the predicate in
    // docs/protocol.md §4 also requires `ai:agent-ready`. This path used to
    // drop `ai:in-progress` and stop there, which did not re-queue the ticket
    // but hid it: the board still read `Todo`, and no dispatcher ever picked
    // it up again. Also strips the stale `agent:*` label, which otherwise
    // claims a harness still holds work it has given up.
    const currentNames = (
      Array.isArray(cur.labels) ? cur.labels : (cur.labels?.nodes ?? [])
    ).map((l) => l.name);
    const { add, remove } = releaseLabels(currentNames, { to: "Todo" });
    runCli(
      [
        "state",
        ticket,
        "Todo",
        "--unassign",
        ...add.flatMap((n) => ["--add", n]),
        ...remove.flatMap((n) => ["--remove", n]),
      ],
      { repo },
    );
    const body = `Dispatch run failed, claim released back to Todo + ai:agent-ready.\n\n**Why:** ${why}${log ? `\n**Log:** \`${log.replace(homedir(), "~")}\`` : ""}`;
    runCli(["comment", ticket, body], { repo });
    return true;
  } catch {
    return false;
  }
}

function defaultFetchTicket(ticket, repo) {
  return JSON.parse(runLinearCli(["get", ticket, "--json"], { repo }));
}

/**
 * The claim-time facts the handoff gate (WM-718) needs and the run spec does
 * not carry: the ticket's Verification Command and Owned Paths. Read once
 * here, revalidate that same read against admission (and GitHub's trust/pin),
 * then persist it on the worker-owned worktree record. Read, hash, trust and
 * pin failures all fail closed before an agent or ticket command can run.
 */
export function ticketHandoffContext(
  ticket,
  fetchTicket,
  repo,
  admittedTicket = null,
) {
  try {
    const cur = fetchTicket(ticket, repo);
    const description = cur?.description ?? "";
    const descriptionHash = hashJson(description);
    if (
      !admittedTicket?.descriptionHash ||
      admittedTicket.descriptionHash !== descriptionHash
    ) {
      return {
        ok: false,
        reasonCode: "ticket_body_changed_post_claim",
        detail:
          "ticket description changed between dispatch admission and post-claim command capture; review the new body and re-apply ai:agent-ready",
      };
    }
    if (cur?.controlPlaneKind === "github") {
      const trustedEditor =
        isTrustedAssociation(cur.authorAssociation) &&
        isTrustedAssociation(cur.lastEditorAssociation);
      if (!trustedEditor) {
        return {
          ok: false,
          reasonCode: "ticket_untrusted_post_claim_editor",
          detail:
            "GitHub author/editor trust could not be revalidated on the post-claim ticket read",
        };
      }
      if (!cur.readyPinHash || cur.readyPinHash !== descriptionHash) {
        return {
          ok: false,
          reasonCode: "ticket_ready_pin_invalid_post_claim",
          detail:
            "GitHub ready-body pin was absent or mismatched on the post-claim ticket read; review the body and re-apply ai:agent-ready",
        };
      }
    }
    const parsed = parseOwnedPaths(description);
    return {
      ok: true,
      handoff: {
        verificationCommand: parseVerificationCommand(description),
        ownedPaths: effectiveOwnedPaths(description),
        ownedPathsParsed: parsed.length > 0,
        descriptionHash,
      },
    };
  } catch (err) {
    return {
      ok: false,
      reasonCode: "ticket_post_claim_read_failed",
      detail: `post-claim ticket read failed closed: ${String(err?.message ?? err)}`,
    };
  }
}

function defaultCommentTicket({ ticket, body, repo }) {
  runLinearCli(["comment", ticket, body], { repo });
  return true;
}

/**
 * The handoff gate refused (WM-718): the agent already moved the ticket to
 * In Review, so the ordinary un-claim (which only acts on In Progress) is a
 * no-op here. Return it to Todo + ai:agent-ready — the harness caught the
 * agent, the spec is fine — and leave the worker-observed verification as
 * the record of why. Never Blocked.
 *
 * `runCli` defaults to the real `runLinearCli` and exists only so tests can
 * inject a stub that fails the first call without touching Linear.
 */
export function defaultReturnHandoffTicket({
  ticket,
  body,
  repo,
  fetchTicket,
  runCli = runLinearCli,
}) {
  try {
    const cur =
      typeof fetchTicket === "function"
        ? fetchTicket(ticket, repo)
        : defaultFetchTicket(ticket, repo);
    const state = cur?.state?.name;
    if (!cur || !["In Progress", "In Review"].includes(state)) return false;
    const args = [
      "state",
      ticket,
      "Todo",
      "--unassign",
      "--add",
      "ai:agent-ready",
      "--remove",
      "ai:in-progress",
      "--remove",
      "ai:needs-review",
    ];
    let agentReadyRestored = true;
    let labelWarning = null;
    try {
      runCli(args, { repo });
    } catch {
      // `--add ai:agent-ready` can fail independently of the state move
      // (e.g. the Owned Paths closure check re-running on `--add`). Retry as
      // two separate calls — state+unassign+removes first, then the label
      // add on its own — so a labels-endpoint failure never silently strands
      // the ticket Todo/unassigned WITHOUT the label that makes it
      // dispatchable again.
      runCli(
        args.filter((a, i) => !(a === "--add" || args[i - 1] === "--add")),
        { repo },
      );
      try {
        runCli(["labels", ticket, "--add", "ai:agent-ready"], { repo });
      } catch (err) {
        agentReadyRestored = false;
        labelWarning = String(err?.stderr ?? err?.message ?? err)
          .trim()
          .split("\n")
          .pop();
        // This must never be silent: the ticket is now Todo/unassigned
        // without the label that makes it dispatchable, and nothing else
        // will notice.
        console.error(
          `[worker] ai:agent-ready NOT restored on ${ticket} after handoff return: ${labelWarning}`,
        );
      }
    }
    const finalBody = agentReadyRestored
      ? body
      : [
          body,
          `**ai:agent-ready NOT restored** — the label add failed after the ticket returned to Todo (${labelWarning ?? "unknown error"}). This ticket will not redispatch until the label is added manually.`,
        ]
          .filter(Boolean)
          .join("\n\n");
    if (finalBody) runCli(["comment", ticket, finalBody], { repo });
    return { ok: true, agentReadyRestored, warning: labelWarning };
  } catch {
    return false;
  }
}

/**
 * A verified PR_OPEN must not remain dispatchable when its agent omitted the
 * final ticket projection. This is deliberately a small, best-effort repair:
 * the caller owns the claim/fencing guard, while this helper re-reads the
 * ticket so an agent that already put it In Review receives no duplicate
 * mutation. Like defaultUnclaimTicket / defaultBlockBaselineTicket it only
 * touches a ticket still in the dispatch states (Todo, In Progress): a human
 * who moved it to Blocked / Done / Canceled mid-run keeps that decision, and
 * a closed GitHub issue is never reopened by the worker.
 */
const RECONCILABLE_HANDOFF_STATES = new Set(["Todo", "In Progress"]);

export function defaultReconcileVerifiedHandoffTicket({
  ticket,
  repo,
  fetchTicket,
  runCli = runLinearCli,
  mayMutate = () => true,
}) {
  try {
    if (!mayMutate()) return false;
    const cur =
      typeof fetchTicket === "function"
        ? fetchTicket(ticket, repo)
        : defaultFetchTicket(ticket, repo);
    if (!cur) return false;
    const stateName = cur.state?.name;
    if (stateName === "In Review") return false;
    if (!RECONCILABLE_HANDOFF_STATES.has(stateName)) {
      console.error(
        `[worker] not reconciling verified handoff ticket ${ticket}: state is ${JSON.stringify(stateName ?? null)}, left as-is`,
      );
      return false;
    }
    runCli(
      [
        "state",
        ticket,
        "In Review",
        "--add",
        "ai:needs-review",
        "--remove",
        "ai:in-progress",
        "--remove",
        "ai:agent-ready",
      ],
      { repo },
    );
    return true;
  } catch (err) {
    console.error(
      `[worker] failed to reconcile verified handoff ticket ${ticket}: ${String(err?.message ?? err)}`,
    );
    return false;
  }
}

/**
 * Convert an already-opened PR to draft and say why, so nobody merges a red
 * handoff (merge-apply skips drafts). `forge` is a test seam only.
 */
export function defaultHoldPullRequest({
  github,
  prNumber,
  body,
  forge = null,
}) {
  if (!github || !Number.isInteger(prNumber)) return false;
  forge ??= loadForge();
  const opts = { timeout: workerSubprocessTimeoutMs() };
  let held = false;
  try {
    forge.prSetDraft(github, prNumber, true, opts);
    held = true;
  } catch {
    /* already a draft, or forge unavailable — the comment still lands */
  }
  try {
    forge.prComment(github, prNumber, body, opts);
    held = true;
  } catch {
    /* intentionally ignored */
  }
  return held;
}

/** Read the live PR form at handoff; dispatch must never rely on GitHub's default branch. */
function defaultFetchHandoffPullRequest({ github, prNumber }) {
  if (!github || !Number.isInteger(prNumber)) {
    throw new Error("handoff PR requires github and a numeric PR number");
  }
  return loadForge().prView(github, prNumber, {
    fields: ["baseRefName", "body", "headRefOid", "isDraft"],
    timeout: workerSubprocessTimeoutMs(),
  });
}

function handoffPrNumber(handoff) {
  if (Number.isInteger(handoff?.prNumber) && handoff.prNumber > 0)
    return handoff.prNumber;
  return null;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Finds a valid `Fixes <ticket>` first line (case-insensitive, tolerant of
 * surrounding whitespace and one trailing punctuation mark). A body may open
 * with blank lines, so "first" means the first non-empty line. When no such
 * line is found the result distinguishes the two correctable shapes: a
 * well-formed Fixes line that sits somewhere further down (`misplacedLine` —
 * move it to the top) from a Fixes-like line that is malformed
 * (`malformedLine` — rewrite it). Accepts the full `owner/repo#n` form, the
 * short `#n` form when the PR lives in that repository, and Linear ids
 * verbatim. Returns null when the handoff carries no usable ticket, so the
 * caller reports "unknown" rather than probing the body for `Fixes null`.
 */
function handoffFixesLine({ lines, ticket, github }) {
  const ref = typeof ticket === "string" ? ticket.trim() : "";
  if (!ref) return { present: null, malformedLine: null, misplacedLine: null };
  const alternatives = [escapeRegExp(ref)];
  const repoMatch = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([0-9]+)$/.exec(ref);
  if (
    repoMatch &&
    typeof github === "string" &&
    github.trim().toLowerCase() === repoMatch[1].toLowerCase()
  ) {
    alternatives.push(`#${repoMatch[2]}`);
  }
  const pattern = new RegExp(
    `^\\s*fixes\\s+(?:${alternatives.join("|")})\\s*[.,;:]?\\s*$`,
    "i",
  );
  const firstLine = lines.find((line) => line.trim() !== "") ?? "";
  if (pattern.test(firstLine))
    return { present: true, malformedLine: null, misplacedLine: null };
  const misplacedLine = lines.find((line) => pattern.test(line)) ?? null;
  if (misplacedLine !== null)
    return { present: false, malformedLine: null, misplacedLine };
  return {
    present: false,
    malformedLine: lines.find((line) => /^\s*fixes\b/i.test(line)) ?? null,
    misplacedLine: null,
  };
}

/**
 * Fail the handoff closed if GitHub cannot prove that the PR targets the
 * configured repository base. Kept here, beside the worker's other external
 * handoff effects, so tests can inject the PR read without a live forge.
 */
export function assertHandoffPullRequestBase({
  handoff,
  base,
  fetchPullRequest,
}) {
  const expected = typeof base === "string" ? base.trim() : "";
  const prNumber = handoffPrNumber(handoff);
  if (!expected || !handoff?.github || !prNumber) {
    throw new ContractViolation(
      [
        "pr_base_unverifiable: handoff requires configured base, GitHub repository, and numeric PR number",
      ],
      { reasonCode: "handoff_verification_failed", handoff },
    );
  }
  let pr;
  try {
    pr = fetchPullRequest({ github: handoff.github, prNumber });
  } catch (err) {
    if (err?.code === "forge_rate_limited") {
      throw new ContractViolation(
        [
          `handoff_forge_unavailable: GitHub rate limited PR #${prNumber} base read`,
        ],
        { reasonCode: HANDOFF_FORGE_UNAVAILABLE, handoff },
      );
    }
    throw new ContractViolation(
      [
        `pr_base_unreadable: could not read base for PR #${prNumber}: ${String(err?.message ?? err)}`,
      ],
      { reasonCode: "handoff_verification_failed", handoff },
    );
  }
  const actual =
    typeof pr?.baseRefName === "string" ? pr.baseRefName.trim() : "";
  handoff.prBase = { expected, actual: actual || null };
  // GitHub returns `body: null` for an empty description; treat it as "".
  const bodyLines = (typeof pr?.body === "string" ? pr.body : "").split(
    /\r?\n/,
  );
  const fixesLine = handoffFixesLine({
    lines: bodyLines,
    ticket: handoff.ticket,
    github: handoff.github,
  });
  const hasFixesLine = fixesLine.present;
  const hasRunTrailer =
    typeof handoff.runId === "string" && handoff.runId.trim()
      ? bodyLines.some((line) => line.trim() === `run:${handoff.runId.trim()}`)
      : null;
  const hasUnexpandedRunTrailer =
    typeof handoff.runId === "string" && handoff.runId.trim()
      ? bodyLines.some((line) => {
          const trailer = line.trim();
          return (
            trailer === "run:$FACTORY_RUN_ID" ||
            trailer === "run:${FACTORY_RUN_ID}"
          );
        })
      : null;
  handoff.pr = {
    number: prNumber,
    draft: pr?.isDraft === true,
    headSha:
      typeof pr?.headRefOid === "string" && pr.headRefOid.trim()
        ? pr.headRefOid.trim()
        : null,
    hasFixesLine,
    hasRunTrailer,
    hasUnexpandedRunTrailer,
  };
  handoff.prDraft = handoff.pr.draft;
  if (!actual) {
    throw new ContractViolation(
      [`pr_base_unreadable: PR #${prNumber} has no baseRefName`],
      { reasonCode: "handoff_verification_failed", handoff },
    );
  }
  if (actual !== expected) {
    throw new ContractViolation(
      [
        `pr_base_mismatch: PR #${prNumber} targets ${actual}, expected configured base ${expected}`,
      ],
      { reasonCode: "handoff_verification_failed", handoff },
    );
  }
  if (hasFixesLine === false) {
    let formDetail;
    if (fixesLine.misplacedLine !== null) {
      // The line is correct — only its position is wrong. Saying "malformed"
      // here would quote the expectation back as the offence.
      formDetail = ` has ${JSON.stringify(fixesLine.misplacedLine.trim())} but it must be the first line of the PR body`;
    } else if (fixesLine.malformedLine) {
      formDetail = ` has malformed Fixes line ${JSON.stringify(fixesLine.malformedLine)}; expected exactly Fixes ${handoff.ticket}`;
    } else {
      formDetail = ` has no Fixes line for ${handoff.ticket}`;
    }
    throw new ContractViolation(
      [`handoff_pr_form_invalid: PR #${prNumber}${formDetail}`],
      { reasonCode: "handoff_pr_form_invalid", handoff },
    );
  }
  if (hasUnexpandedRunTrailer) {
    throw new ContractViolation(
      [
        `run_trailer_unexpanded: PR #${prNumber} contains a literal run trailer; append the concrete run ID with printf 'run:%s\\n' "$FACTORY_RUN_ID"`,
      ],
      { reasonCode: "run_trailer_unexpanded", handoff },
    );
  }
}

/**
 * Promote a successfully verified dispatch PR out of draft so GitHub routes
 * its full CI lane. The handoff's state is updated only after `gh pr ready`
 * succeeds, making the worker-authored handoff comment an observation of the
 * final PR state rather than the draft state it had during local verification.
 *
 * Best effort, like the handoff comment itself: the run is already verified by
 * the time this is called, so a transient forge error must not fail it, redraft
 * anything, or bounce the ticket. On failure the handoff keeps `draft: true`,
 * the comment truthfully records `draft: yes`, and this returns false.
 */
export function defaultMarkHandoffPullRequestReady({ handoff, forge = null }) {
  if (handoff?.pr?.draft !== true) return false;
  const prNumber = handoffPrNumber(handoff);
  if (!handoff.github || !prNumber) return false;
  try {
    forge ??= loadForge();
    forge.prSetDraft(handoff.github, prNumber, false, {
      timeout: workerSubprocessTimeoutMs(),
    });
  } catch (err) {
    console.error(
      `[worker] could not mark PR #${prNumber} ready for review: ${String(err?.message ?? err)}`,
    );
    return false;
  }
  handoff.pr.draft = false;
  handoff.prDraft = false;
  return true;
}

const BASELINE_COMMENT_MARKER = "wm:baseline:red:";

function baselineFailureSignature({ why, log = null, baseline = null }) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        why,
        log,
        baseline:
          baseline && typeof baseline === "object"
            ? {
                check: baseline.check,
                exitCode: baseline.exitCode,
                output: baseline.output,
              }
            : null,
      }),
    )
    .digest("hex");
}

function hasRecordedBaselineFailureComment(ticket, signature, repo) {
  const marker = `${BASELINE_COMMENT_MARKER}${signature}`;
  try {
    const out = runLinearCli(["comments", ticket, "--json"], { repo });
    const comments = JSON.parse(out);
    return (comments ?? []).some((row) =>
      String(row.body ?? "").includes(marker),
    );
  } catch {
    return false;
  }
}

export function defaultBlockBaselineTicket({
  repo,
  ticket,
  why,
  log = null,
  baseline = null,
  fetchTicket,
  runCli = runLinearCli,
  hasRecordedBaselineFailure = hasRecordedBaselineFailureComment,
}) {
  try {
    let cur = null;
    if (typeof fetchTicket === "function") {
      cur = fetchTicket(ticket);
    } else {
      const out = runLinearCli(["get", ticket, "--json"], { repo });
      cur = JSON.parse(out);
    }
    if (!cur || cur.state?.name !== "In Progress") return false;
    if (
      !(Array.isArray(cur.labels) ? cur.labels : (cur.labels?.nodes ?? [])) // WM-978
        .some((l) => l.name === "ai:in-progress")
    )
      return false;

    const signature = baselineFailureSignature({ why, log, baseline });
    runCli(
      [
        "state",
        ticket,
        "Blocked",
        "--unassign",
        "--add",
        "ai:blocked",
        "--remove",
        "ai:in-progress",
      ],
      { repo },
    );

    if (!hasRecordedBaselineFailure(ticket, signature, repo)) {
      const marker = `${BASELINE_COMMENT_MARKER}${signature}`;
      const body = `Dispatch run blocked due pre-existing baseline red.\n\n**Why:** ${why}${log ? `\n**Log:** \`${log.replace(homedir(), "~")}\`` : ""}\n\n
<!-- ${marker} -->`;
      runCli(["comment", ticket, body], { repo });
    }
    return true;
  } catch {
    return false;
  }
}

/** Active executions by runId for cooperative cancellation. */
const ACTIVE_EXECUTIONS = new Map();

/**
 * Execute one claimed attempt to a terminal state. Returns a summary
 * { runId, attempt, terminalState, reasonCode, receipt? }, or
 * { cancelled: true } when an operator moved the run under us, or
 * { fenced: true } when a newer attempt owns the run at publish time.
 */
export async function executeClaimed(
  db,
  registry,
  adapters,
  claim,
  {
    workspacesRoot,
    artifactStore = artifactsRoot(),
    now = () => Date.now(),
    policyVersion = "unknown",
    adapterOverride,
    env = {},
    dispatch,
    resolveLinearKey = resolveLinearApiKey,
    policyRoot = FACTORY_ROOT,
    sandboxAvailability,
    materializeWorktree,
    localNotifyFetch,
    verifyResult: verifyResultFn = verifyResult,
  } = {},
) {
  const { runId, attempt, fencingToken, spec } = claim;
  const owner =
    db
      .query(
        `SELECT lease_owner FROM attempts WHERE run_id = ? AND attempt = ?`,
      )
      .get(runId, attempt)?.lease_owner ?? "worker";
  const retain = spec.workspace?.retainOnFailure === true;
  let workspaceDir = null;
  let checkoutPath = null;
  let worktreePath = null;
  let checkoutBaseline;
  let worktreeRecord;
  const cleanupWorkspace = ({ retainWorkspace = false } = {}) => {
    if (!workspaceDir) return;
    const fenced = !assertCurrentToken(db, runId, fencingToken);
    if (fenced && spec.workspace?.type === "worktree") {
      // A newer attempt for this run uses the same delegated worktree. Remove
      // only the stale attempt's teardown marker so destroyWorkspace cleans its
      // wrapper directory without invoking worktree_down under the live retry.
      try {
        unlinkSync(path.join(workspaceDir, ".worktree.json"));
      } catch {
        /* intentionally ignored */
      }
    }
    destroyWorkspace(workspaceDir, {
      retain: retainWorkspace,
      checkout: fenced ? null : checkoutPath,
      repoName,
    });
  };
  const repoName = spec.input?.repoPin?.repo ?? spec.input?.repo ?? null;
  const ticketId = spec.input?.ticket ?? null;
  const isWorktree = spec.workspace?.type === "worktree";
  const tierHandoff = tierEscalationForContinuation(db, runId);
  const handoffFailure = spec.approvalPolicy?.escalation?.handoffFailure;
  const worktreeHandoff =
    tierHandoff && typeof handoffFailure === "string"
      ? { ...tierHandoff, handoffFailure }
      : tierHandoff;

  let leaseHeartbeat = null;
  let ticketClaimed = false;
  const ticketLeaseOwner = `${owner}:${runId}:${fencingToken}`;
  const mayMutateClaimedTicket = () =>
    ticketClaimed && assertCurrentToken(db, runId, fencingToken);
  let attemptUsage = { adapter: adapterOverride ?? spec.adapter };
  let materializedHarnessPins = null;

  let dispatchOpts = dispatch;
  // The demo dispatch stub is only ever activated explicitly (WM-533): a
  // missing credential must never be read as permission to fake a claim.
  const dispatchStubSelected =
    process.env.FACTORY_DISPATCH_STUB === "1" ||
    adapterOverride === "fake" ||
    spec.adapter === "fake";
  const explicitDispatchStub = !dispatchOpts && dispatchStubSelected;
  if (explicitDispatchStub) {
    dispatchOpts = {
      fetchTicket: () => ({
        identifier: ticketId,
        state: { name: "Todo" },
        assignee: null,
        labels: { nodes: [{ name: "ai:agent-ready" }] },
        // The claim gate fails closed on unknown or match-everything scopes
        // (owned_paths_unknown, WM-575/#952), so the demo dispatch fixture
        // must model a bounded, parseable scope.
        description: "## Owned Paths\n- event-runtime/lib/**\n",
      }),
      fetchInFlight: () => [],
      countLeases: () => 0,
      claimTicket: () => ({ ok: true }),
      unclaimTicket: () => true,
      // The stub never reaches Linear or GitHub — including the WM-718
      // handoff comment, PR hold, and ticket return.
      commentTicket: () => true,
      returnHandoffTicket: () => true,
      reconcileVerifiedHandoffTicket: () => false,
      holdPullRequest: () => false,
      markHandoffPullRequestReady: () => false,
      findWorkspacePullRequest: () => null,
    };
  } else if (dispatchStubSelected) {
    // A caller that supplies only some dispatch seams (locks, ticket reads,
    // claim accounting) must not silently fall through to the real tracker
    // for the ones it left out. These three are best-effort, non-asserted
    // mutations, so the "a fake run never reaches Linear or GitHub"
    // guarantee above has to hold for a partial override too — otherwise a
    // fake dispatch posts real handoff comments and blocks on the network.
    dispatchOpts = {
      commentTicket: () => true,
      returnHandoffTicket: () => true,
      reconcileVerifiedHandoffTicket: () => false,
      holdPullRequest: () => false,
      markHandoffPullRequestReady: () => false,
      findWorkspacePullRequest: () => null,
      ...dispatchOpts,
    };
  }
  const linearConfigured =
    dispatchOpts || !isWorktree || !repoName || !ticketId
      ? true
      : Boolean(resolveLinearKey());

  const locksDir = dispatchOpts?.locksDir ?? defaultLocksDir();
  const leasesDir = dispatchOpts?.leasesDir ?? leaseDir();
  const lockFile = repoName ? dispatchLockPath(repoName, locksDir) : null;
  const isAliveFn = dispatchOpts?.isAlive ?? defaultIsAlive;
  const claimTicketFn =
    dispatchOpts?.claimTicket ??
    (dispatchOpts?.fetchTicket ? () => ({ ok: true }) : defaultClaimTicket);
  const unclaimTicketFn =
    dispatchOpts?.unclaimTicket ??
    ((args) =>
      defaultUnclaimTicket({
        ...args,
        fetchTicket: dispatchOpts?.fetchTicket,
      }));
  const blockTicketFn =
    dispatchOpts?.blockBaselineTicket ??
    ((args) =>
      defaultBlockBaselineTicket({
        ...args,
        fetchTicket: dispatchOpts?.fetchTicket,
      }));
  const fetchTicketFn = dispatchOpts?.fetchTicket ?? defaultFetchTicket;
  const commentTicketFn = dispatchOpts?.commentTicket ?? defaultCommentTicket;
  const returnHandoffTicketFn =
    dispatchOpts?.returnHandoffTicket ??
    ((args) =>
      defaultReturnHandoffTicket({
        ...args,
        fetchTicket: dispatchOpts?.fetchTicket,
      }));
  const reconcileVerifiedHandoffTicketFn =
    dispatchOpts?.reconcileVerifiedHandoffTicket ??
    ((args) =>
      defaultReconcileVerifiedHandoffTicket({
        ...args,
        fetchTicket: dispatchOpts?.fetchTicket,
      }));
  const holdPullRequestFn =
    dispatchOpts?.holdPullRequest ?? defaultHoldPullRequest;
  const fetchHandoffPullRequestFn =
    dispatchOpts?.fetchHandoffPullRequest ?? defaultFetchHandoffPullRequest;
  const markHandoffPullRequestReadyFn =
    dispatchOpts?.markHandoffPullRequestReady ??
    defaultMarkHandoffPullRequestReady;
  const projectTierEscalationFn =
    dispatchOpts?.projectTierEscalation ?? defaultProjectTierEscalation;
  let handoffContext = null;
  let executionInput = spec.input;

  const nowFn = typeof now === "function" ? now : () => now ?? Date.now();

  const tierEscalationDue = (reasonCode) => {
    const eligibility = tierEscalationEligibility(spec, reasonCode);
    if (!eligibility.eligible) return false;
    return failureCount(db, runId, "agent_error") + 1 >= spec.maxAttempts;
  };

  // The guard performs live tracker and forge reads. Memoize per reason code:
  // a terminal path consults it once for the claim-release decision and again
  // inside the escalation write, and those two answers must be the same world.
  let escalationGuardCache = null;
  const resolveEscalationGuard = (reasonCode) => {
    if (escalationGuardCache?.reasonCode === reasonCode) {
      return escalationGuardCache.guard;
    }
    const guard = tierEscalationDue(reasonCode)
      ? tierEscalationContinuationGuard(spec, reasonCode, {
          fetchTicket: fetchTicketFn,
          findPullRequest:
            dispatchOpts?.findWorkspacePullRequest ??
            defaultFindWorkspacePullRequest,
          workspacePath: worktreePath ?? checkoutPath,
        })
      : null;
    escalationGuardCache = { reasonCode, guard };
    return guard;
  };

  const projectScheduledEscalation = (scheduled) =>
    scheduled
      ? reconcileTierEscalations(db, {
          projectTierEscalation: projectTierEscalationFn,
          fetchTicket: fetchTicketFn,
          now: nowFn,
          policyVersion,
        })
      : null;

  const commentTierEscalationSkip = (reason) => {
    if (!reason || !mayMutateClaimedTicket()) return;
    const why =
      reason === "ticket_in_review"
        ? "ticket is already In Review"
        : "the retained worktree already has an open non-draft PR";
    try {
      commentTicketFn({
        repo: repoName,
        ticket: ticketId,
        body: `Tier escalation skipped: ${why}; failed run \`${runId}\` remains with the existing review handoff.`,
      });
    } catch {
      /* The terminal run remains recorded even if tracker commentary fails. */
    }
  };

  const abortController = new AbortController();
  let cancelPoll = null;
  // Idempotent so a supervised follow-up adapter turn (the bounded Pi result
  // repair) can re-arm cancellation after the primary execution stopped it.
  const startCancellationMonitor = () => {
    ACTIVE_EXECUTIONS.set(runId, {
      abort: (reason) => abortController.abort(reason),
      controller: abortController,
      runId,
      attempt,
    });
    if (cancelPoll) return;
    cancelPoll = setInterval(() => {
      try {
        const state = db
          .query(`SELECT state FROM runs WHERE run_id = ?`)
          .get(runId)?.state;
        if (state === "CANCELLED" && !abortController.signal.aborted) {
          abortController.abort("db_cancelled");
        }
      } catch {
        // ignore
      }
    }, 250);
    cancelPoll?.unref?.();
  };
  startCancellationMonitor();
  const stopCancellationMonitor = () => {
    if (cancelPoll) clearInterval(cancelPoll);
    cancelPoll = null;
    ACTIVE_EXECUTIONS.delete(runId);
  };

  /** Terminal failure-shaped write: classify, finalize, and budget any retry atomically. */
  const failTerminal = (to, journalReason, reasonCode, beforeTerminal) => {
    const escalationGuard = resolveEscalationGuard(reasonCode);
    const result = txImmediate(db, () => {
      const currentNow = nowFn();
      if (!assertCurrentToken(db, runId, fencingToken)) {
        recordFencedAttempt(db, {
          runId,
          attempt,
          actor: owner,
          policyVersion,
          now: currentNow,
        });
        return { fenced: true };
      }
      beforeTerminal?.(currentNow);
      const expectFrom = db
        .query(`SELECT state FROM runs WHERE run_id = ?`)
        .get(runId)?.state;
      const decision = retryDecision(db, runId, spec, reasonCode, {
        includeCurrentFailure: true,
      });
      transition(db, {
        runId,
        to,
        expectFrom,
        actor: owner,
        reason: terminalFailureReason(decision, reasonCode, journalReason),
        attempt,
        policyVersion,
        now: currentNow,
      });
      finishAttempt(
        db,
        runId,
        attempt,
        to,
        reasonCode,
        currentNow,
        attemptUsage,
      );
      let escalation = null;
      if (decision.retry) {
        transition(db, {
          runId,
          to: "QUEUED",
          expectFrom: "FAILED",
          actor: owner,
          reason: `retry:${decision.cause}`,
          attempt,
          policyVersion,
          now: nowFn(),
        });
      } else if (escalationGuard?.eligible && !escalationGuard.skip) {
        escalation = scheduleTierEscalation(db, registry, spec, {
          workspacePath: worktreePath ?? checkoutPath,
          sourceWorkspacePath: workspaceDir,
          actor: owner,
          policyVersion,
          now: currentNow,
          reasonCode,
          continuationGuard: escalationGuard,
        });
      }
      return {
        ok: true,
        cause: decision.cause,
        requeued: decision.retry,
        escalation,
        tierEscalationSkip:
          !decision.retry && escalationGuard?.skip
            ? escalationGuard.reason
            : null,
      };
    });
    commentTierEscalationSkip(result?.tierEscalationSkip);
    return result;
  };

  let def = null;
  try {
    def = getAgent(registry, spec.agent);
  } catch {
    /* intentionally ignored */
  }

  // The `unconfined` attestation, once admission has decided. Declared here so
  // that EVERY terminal receipt this execution writes carries it — a refusal
  // or a failure after an unconfined admission is exactly the record an
  // auditor needs, so it must not be attached to the success path alone.
  // Null until admission runs, and null for every confined run.
  let filesystemConfinementReceipt = null;
  // The recorder is built before the main `try` so terminal-error reporting
  // can use it; its construction prepares a statement and must therefore
  // never throw out of executeClaimed (§14: trace failures stay invisible to
  // the attempt). Fall back to a no-op recorder with the same call surface.
  const recorder = (() => {
    try {
      return traceRecorder(db, { runId, attempt });
    } catch (err) {
      console.error(
        `[worker] trace recorder unavailable for run ${runId} attempt ${attempt}: ${err?.message ?? String(err)}`,
      );
      const noop = () => {};
      noop.stats = () => ({ recorded: 0, dropped: 0 });
      return noop;
    }
  })();
  const recordTerminalError = (operation, err) => {
    const message = err?.message ?? String(err);
    console.error(
      `[worker] terminal ${operation} failed for run ${runId} attempt ${attempt}: ${message}`,
    );
    // `lifecycle` is the nearest supported trace kind to a terminal error.
    try {
      recorder("lifecycle", {
        terminalError: true,
        operation,
        runId,
        attempt,
        message,
      });
    } catch {
      // A terminal error must still be reported when trace storage is down.
    }
    return message;
  };

  const refuseTerminal = (
    reasonCode,
    checks = ["dispatch_gate"],
    { causeTyped = false, detail = null, receiptEvidence = null } = {},
  ) =>
    txImmediate(db, () => {
      const currentNow = nowFn();
      if (!assertCurrentToken(db, runId, fencingToken)) {
        recordFencedAttempt(db, {
          runId,
          attempt,
          actor: owner,
          policyVersion,
          now: currentNow,
        });
        return { fenced: true };
      }
      const journalReason = causeTyped
        ? typedFailureReason(reasonCode)
        : (detail ?? reasonCode);
      transition(db, {
        runId,
        to: "VERIFYING",
        expectFrom: "RUNNING",
        actor: owner,
        reason: journalReason,
        attempt,
        policyVersion,
        now: currentNow,
      });
      transition(db, {
        runId,
        to: "REFUSED",
        expectFrom: "VERIFYING",
        actor: owner,
        reason: journalReason,
        attempt,
        policyVersion,
        now: currentNow,
      });
      closeOpenProposalForRun(db, runId, {
        actor: owner,
        reason: "run_refused",
        now: currentNow,
      });
      const receipt = receiptWithDeadlineExtensions(db, runId, {
        runId,
        spec,
        def,
        artifactHash: null,
        evidenceSetHash: null,
        journalHead: latestJournalHash(db, runId),
        verificationStatus: "passed",
        extraReceipt: receiptEvidence
          ? {
              ...(filesystemConfinementReceipt ?? {}),
              dispatchGateEvidence: receiptEvidence,
            }
          : filesystemConfinementReceipt,
        harnessPins: materializedHarnessPins,
      });
      const result = {
        schemaVersion: "factory.run-result/v1",
        runId,
        attempt,
        terminalState: "refused",
        reasonCode,
        outputContract: spec.outputContract,
        verification: { status: "passed", checks },
        artifacts: [],
      };
      db.query(
        `INSERT INTO results (run_id, attempt, result_json, artifact_hash, evidence_set_hash, verification_json, receipt_json, accepted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        runId,
        attempt,
        canonicalJson(result),
        "none",
        null,
        canonicalJson(result.verification),
        canonicalJson(receipt),
        iso(currentNow),
      );
      finishAttempt(
        db,
        runId,
        attempt,
        "REFUSED",
        reasonCode,
        currentNow,
        attemptUsage,
      );
      return { ok: true, receipt };
    });

  /** Convert a non-ContractViolation verify throw into a terminal FAILED summary. */
  const failVerificationInternal = (err) => {
    const reasonCode = verificationInternalReasonCode(err, [
      worktreePath,
      workspaceDir,
    ]);
    const error = verificationInternalErrorPayload(err);
    const journalReason = `${reasonCode}: ${error.message}`;
    if (mayMutateClaimedTicket()) {
      try {
        unclaimTicketFn({
          repo: repoName,
          ticket: ticketId,
          why: journalReason,
          log: null,
        });
      } catch {
        /* intentionally ignored */
      }
    }
    const result = {
      schemaVersion: "factory.run-result/v1",
      runId,
      attempt,
      terminalState: "failed",
      reasonCode,
      outputContract: spec.outputContract,
      error,
      verification: {
        status: "failed",
        stage: "verification",
        checks: [],
      },
      artifacts: [],
    };
    let res;
    let terminalError;
    try {
      res = failTerminal("FAILED", journalReason, reasonCode, (currentNow) => {
        const receipt = receiptWithDeadlineExtensions(db, runId, {
          runId,
          spec,
          def,
          artifactHash: null,
          evidenceSetHash: null,
          journalHead: latestJournalHash(db, runId),
          verificationStatus: "failed",
          extraReceipt: filesystemConfinementReceipt,
          harnessPins: materializedHarnessPins,
        });
        db.query(
          `INSERT INTO results (run_id, attempt, result_json, artifact_hash, evidence_set_hash, verification_json, receipt_json, accepted_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          runId,
          attempt,
          canonicalJson(result),
          "none",
          null,
          canonicalJson(result.verification),
          canonicalJson(receipt),
          iso(currentNow),
        );
      });
    } catch (failErr) {
      terminalError = recordTerminalError("failTerminal", failErr);
    }
    cleanupWorkspace({ retainWorkspace: retain });
    if (res?.fenced) return { fenced: true };
    return {
      runId,
      attempt,
      terminalState: "FAILED",
      reasonCode,
      error,
      ...(terminalError ? { terminalError } : {}),
    };
  };

  try {
    const started = txImmediate(db, () => {
      const currentNow = nowFn();
      if (!assertCurrentToken(db, runId, fencingToken)) {
        recordFencedAttempt(db, {
          runId,
          attempt,
          actor: owner,
          policyVersion,
          now: currentNow,
        });
        return { fenced: true };
      }
      transition(db, {
        runId,
        to: "RUNNING",
        expectFrom: "LEASED",
        actor: owner,
        reason: "started",
        attempt,
        policyVersion,
        now: currentNow,
      });
      db.query(
        `UPDATE attempts SET started_at = ? WHERE run_id = ? AND attempt = ?`,
      ).run(iso(currentNow), runId, attempt);
      return { ok: true, startedAt: iso(currentNow) };
    });
    if (started?.fenced) {
      return { fenced: true };
    }

    // A registry reload can remove an agent after its proposal was approved.
    // Refuse the already-queued run before any dispatch claim, workspace, or
    // adapter side effect.  This is an expected data change, not a loader
    // crash and not a retryable execution failure.
    if (!def) {
      const refusedRes = refuseTerminal(
        "agent_unregistered_after_reload",
        ["registry_reload"],
        { causeTyped: true },
      );
      stopCancellationMonitor();
      if (refusedRes?.fenced) return { fenced: true };
      return {
        runId,
        attempt,
        terminalState: "REFUSED",
        reasonCode: "agent_unregistered_after_reload",
        receipt: refusedRes?.receipt,
      };
    }

    const adapterKey = adapterOverride ?? spec.adapter;
    const selectedAdapter = adapters[adapterKey];
    // Production entry points supply only registry-wrapped adapters. Unit and
    // integration tests may inject a raw non-model contract stub under a model
    // route; that stub spawns no model and is outside this boundary.
    const modelRuntimeSelected =
      MODEL_BACKED_ADAPTERS.includes(adapterKey) &&
      isSandboxGuarded(selectedAdapter);
    const missingModelDefinitionPin =
      def?.mutating === false && modelRuntimeSelected && !spec.defHash;
    if (missingModelDefinitionPin || (def && !verifyDefHash(spec, def))) {
      const refusedRes = refuseTerminal(
        "agent_definition_mismatch",
        [missingModelDefinitionPin ? "def_hash_missing" : "def_hash_mismatch"],
        { causeTyped: true },
      );
      stopCancellationMonitor();
      if (refusedRes?.fenced) return { fenced: true };
      return {
        runId,
        attempt,
        terminalState: "REFUSED",
        reasonCode: "agent_definition_mismatch",
        receipt: refusedRes.receipt,
      };
    }
    const filesystemIntent =
      spec.filesystem ?? def?.capabilities?.filesystem ?? null;
    const confinementDef =
      filesystemIntent === def?.capabilities?.filesystem
        ? def
        : {
            ...def,
            capabilities: {
              ...(def?.capabilities ?? {}),
              filesystem: filesystemIntent,
            },
          };
    const workspaceOnlyFallback = policyWorkspaceOnlyFallback(policyRoot);
    const hostSandbox = modelRuntimeSelected
      ? (sandboxAvailability ?? cachedSandboxPreflight())
      : null;
    // The fallback is a *host-capability* escape hatch, never a way to opt an
    // agent out of a sandbox this machine can actually provide.
    const unconfinedWorkspaceOnly =
      modelRuntimeSelected &&
      hostSandbox?.available === false &&
      workspaceOnlyHostFallback(confinementDef, { workspaceOnlyFallback });
    const confinementRefusal = modelRuntimeSelected
      ? filesystemConfinementRefusal(adapterKey, confinementDef, {
          sandboxSupport: selectedAdapter?.SANDBOX_SUPPORT ?? null,
          sandboxAvailability: hostSandbox,
          workspaceOnlyFallback,
        })
      : null;
    if (confinementRefusal) {
      const res = refuseTerminal(
        confinementRefusal.code,
        ["filesystem_confinement"],
        { detail: confinementRefusal.detail },
      );
      stopCancellationMonitor();
      if (res?.fenced) return { fenced: true };
      return {
        runId,
        attempt,
        terminalState: "REFUSED",
        reasonCode: confinementRefusal.code,
        receipt: res?.receipt,
      };
    }
    filesystemConfinementReceipt = unconfinedWorkspaceOnly
      ? {
          filesystemConfinement: {
            status: "unconfined",
            declared: "workspace-only",
            fallback: "host",
            source: "policy:sandbox.workspace_only_fallback",
            agent: definitionAgentName(confinementDef),
            hostCapability: sandboxUnavailableCapability(hostSandbox),
          },
        }
      : null;

    if (isWorktree && repoName && ticketId) {
      if (!linearConfigured) {
        const res = failTerminal(
          "FAILED",
          "linear_unconfigured",
          "linear_unconfigured",
        );
        stopCancellationMonitor();
        if (res?.fenced) return { fenced: true };
        return {
          runId,
          attempt,
          terminalState: "FAILED",
          reasonCode: "linear_unconfigured",
        };
      }

      const lockAcquired = acquireClaimLock(lockFile, {
        pid: process.pid,
        now: nowFn(),
        isAlive: isAliveFn,
      });
      if (!lockAcquired) {
        const deferred = deferClaimLockContention(db, {
          runId,
          attempt,
          fencingToken,
          owner,
          policyVersion,
          now: nowFn,
          maxRequeues: Number.isInteger(
            dispatchOpts?.maxClaimLockContentionRequeues,
          )
            ? Math.max(0, dispatchOpts.maxClaimLockContentionRequeues)
            : DEFAULT_MAX_CLAIM_LOCK_REQUEUES,
          random: dispatchOpts?.random ?? Math.random,
        });
        if (deferred?.fenced) {
          stopCancellationMonitor();
          return { fenced: true };
        }
        if (deferred?.requeued) {
          stopCancellationMonitor();
          return {
            runId,
            attempt,
            terminalState: "QUEUED",
            reasonCode: "claim_lock_contention",
            requeueAfterMs: deferred.backoffMs,
          };
        }
        const res = refuseTerminal("claim_lock_starvation", [
          "dispatch_claim_lock",
        ]);
        stopCancellationMonitor();
        if (res?.fenced) return { fenced: true };
        return {
          runId,
          attempt,
          terminalState: "REFUSED",
          reasonCode: "claim_lock_starvation",
          receipt: res?.receipt,
        };
      }

      const deferTransientGate = (reasonCode) => {
        releaseClaimLock(lockFile);
        const deferred = deferTransientDispatchGate(db, {
          runId,
          attempt,
          fencingToken,
          owner,
          policyVersion,
          now: nowFn,
          reasonCode,
          maxRequeues: Number.isInteger(dispatchOpts?.maxTransientGateRequeues)
            ? Math.max(0, dispatchOpts.maxTransientGateRequeues)
            : DEFAULT_MAX_TRANSIENT_GATE_REQUEUES,
          random: dispatchOpts?.random ?? Math.random,
        });
        if (deferred?.fenced) return { fenced: true };
        if (deferred?.requeued) {
          return {
            runId,
            attempt,
            terminalState: "QUEUED",
            reasonCode,
            requeueAfterMs: deferred.backoffMs,
          };
        }
        const res = refuseTerminal(reasonCode, [
          "dispatch_gate",
          "transient_retry_exhausted",
        ]);
        if (res?.fenced) return { fenced: true };
        return {
          runId,
          attempt,
          terminalState: "REFUSED",
          reasonCode,
          receipt: res?.receipt,
        };
      };

      // WM-469 de-hardcoded the merge-fix role from the kernel: the definition
      // declares `dispatchGateExempt: true` (validated by the registry) instead
      // of a `gate: "merge-fix"` literal the worker string-matched. Keep the
      // planner and worker keyed off the SAME declarative field — a legacy
      // `gate` value is still honoured so an older pinned spec cannot silently
      // fall through to the dispatch claim gate and refuse with ticket_assigned.
      const gate =
        def?.dispatchGateExempt === true
          ? "merge-fix"
          : (def?.gate ?? "dispatch");
      if (!["dispatch", "merge-fix"].includes(gate)) {
        releaseClaimLock(lockFile);
        const reasonCode = "worktree_gate_unknown";
        const res = refuseTerminal(reasonCode, ["worktree_gate"]);
        if (res?.fenced) return { fenced: true };
        return {
          runId,
          attempt,
          terminalState: "REFUSED",
          reasonCode,
          receipt: res?.receipt,
        };
      }

      let gateResult;
      try {
        if (gate === "merge-fix") {
          const fetchNonTerminalRuns =
            dispatchOpts?.fetchNonTerminalRuns ??
            (() =>
              db
                .query(
                  // A competing run is one that is actually admitted to execute.
                  // PROPOSED rows (unapproved or expired proposals) and FAILED
                  // runs are not competing: counting them refused every later
                  // merge-fix for the ticket forever (WM-747/#663 on 2026-08-19:
                  // two expired PROPOSED rows blocked six rounds of fixes).
                  `SELECT run_id AS runId, state
               FROM runs
              WHERE run_id <> ?
                AND state IN ('QUEUED','LEASED','RUNNING','VERIFYING')
                AND json_extract(spec_json, '$.input.repo') = ?
                AND json_extract(spec_json, '$.input.ticket') = ?
              ORDER BY created_at, run_id`,
                )
                .all(runId, repoName, ticketId));
          gateResult = worktreeMergeFixEligibility(spec.input, {
            fetchTicket: dispatchOpts?.fetchTicket,
            fetchPullRequest: dispatchOpts?.fetchPullRequest,
            fetchNonTerminalRuns,
            now: nowFn,
          });
        } else {
          // A continuation whose tracker projection has not been applied yet
          // is not runnable: the planner would refuse it terminally as
          // ticket_assigned (tier_escalation_check_failed:
          // ticket_escalation_projection_applied) and the row would stay
          // pending forever (#1290). Requeue and let reconcileTierEscalations
          // finish the projection first.
          if (worktreeHandoff?.projectionState === "pending") {
            return deferTransientGate("tier_escalation_projection_pending");
          }
          const authorisationGate = humanDecisionAuthorisationGate(spec.input, {
            fetchTicket: fetchTicketFn,
          });
          if (!authorisationGate.ok) {
            gateResult = authorisationGate;
          } else {
            executionInput = authorisationGate.input;
            gateResult = worktreeDispatchAutoEligibility(spec.input, {
              ...(dispatchOpts ?? {}),
              ...(authorisationGate.evidence?.ticket
                ? { fetchTicket: () => authorisationGate.evidence.ticket }
                : {}),
              claimedRetry: claimedRetryFor(db, runId, attempt),
              escalatedContinuation: worktreeHandoff,
              hasTicketLease:
                dispatchOpts?.hasTicketLease ??
                ((repo, ticket) =>
                  liveWorkerLeases(repo, { dir: leasesDir }).some(
                    (lease) => String(lease.ticket) === String(ticket),
                  )),
              // Match the planner's operator-only bypass from the immutable
              // proposal that admitted this run. Never trust caller options here:
              // chain and schedule runs must keep the security/escalation gate.
              //
              // A spec field alone can never carry this authorisation: chain and
              // schedule runs inherit approvalPolicy (dispatchEvidence included,
              // via stableChainApprovalPolicyForHash) from the dispatch they
              // descend from, so trusting `dispatchEvidence.checks
              // .operator_authorized` would hand every descendant of one operator
              // dispatch a permanent ai:escalated/security bypass. The escalation
              // claim is only believed when the durable tier_escalations row read
              // for THIS run authenticates it as the continuation of the exact
              // failed run the spec names.
              operatorAuthorized:
                originatingEvent(db, runId)?.source === "operator" ||
                (worktreeHandoff?.projectionState === "applied" &&
                  spec.approvalPolicy?.escalation?.operatorAuthorized ===
                    true &&
                  spec.approvalPolicy.escalation.failedRunId ===
                    worktreeHandoff.failedRunId &&
                  spec.approvalPolicy.escalation.rootRunId ===
                    worktreeHandoff.rootRunId),
            });
          }
        }
      } catch (err) {
        if (
          gate === "dispatch" &&
          hasPlanTimeDispatchEvidence(spec) &&
          String(err?.message ?? err).startsWith("linear_read_failed:")
        ) {
          return deferTransientGate("linear_read_failed");
        }
        releaseClaimLock(lockFile);
        throw err;
      }

      if (!gateResult.ok) {
        const gateRefusal = gateResult.refusal;
        if (
          gate === "dispatch" &&
          gateRefusal.reason === "owned_paths_unknown" &&
          contradictsPlanTimeOwnedPaths(spec, gateResult)
        ) {
          return deferTransientGate("owned_paths_unknown");
        }
        // A forge read failure while checking the failed run's PR is as
        // transient as a Linear read failure: requeue with backoff instead
        // of permanently killing the escalation continuation. Only when the
        // retries are exhausted does the continuation refuse terminally, and
        // then the tier_escalations row must leave 'applied' with it.
        if (
          gate === "dispatch" &&
          gateRefusal.reason === "ticket_escalation_pr_read_failed" &&
          worktreeHandoff
        ) {
          const deferred = deferTransientGate(gateRefusal.reason);
          if (deferred?.terminalState === "REFUSED") {
            refuseTierEscalationClaim(db, worktreeHandoff, gateRefusal.reason);
          }
          return deferred;
        }
        releaseClaimLock(lockFile);
        // The retained PR was rejected by the failed run's handoff gate and is
        // still open as a ready (non-draft) PR. Route it to review rather than
        // silently stranding it behind a refused continuation that cannot
        // open a second PR — and hold the PR itself (draft + quoted reason)
        // so the merge stage cannot land it without a fix round. Runs after
        // the claim lock is released: both are CLI subprocesses.
        if (
          gate === "dispatch" &&
          gateRefusal.reason === "ticket_pr_handoff_verification_failed" &&
          worktreeHandoff &&
          assertCurrentToken(db, runId, fencingToken)
        ) {
          const heldPr = gateResult.evidence?.escalatedWorkspacePullRequest;
          const heldPrNumber = Number(heldPr?.number);
          const failedReason = worktreeHandoff.failedRunReasonCode ?? null;
          if (Number.isInteger(heldPrNumber) && heldPrNumber > 0) {
            try {
              holdPullRequestFn({
                repo: repoName,
                github: gateResult.evidence?.repo?.github ?? null,
                prNumber: heldPrNumber,
                prUrl: heldPr?.url ?? null,
                body: `**Result:** run ${worktreeHandoff.failedRunId} FAILED \`${failedReason ?? "handoff_verification_failed"}\` — the tier-${spec.modelTier ?? "escalation"} continuation ${runId} was refused (\`${gateRefusal.reason}\`) because this PR was still open and ready.\n\nConverted to draft by the factory worker: the handoff did not verify. Address the recorded failure before marking it ready for review.`,
              });
            } catch {
              /* intentionally ignored */
            }
          }
          try {
            reconcileVerifiedHandoffTicketFn({
              repo: repoName,
              ticket: ticketId,
              reason: failedReason,
              prNumber: Number.isInteger(heldPrNumber) ? heldPrNumber : null,
            });
          } catch {
            /* The continuation refusal remains durable if projection fails. */
          }
        }
        if (
          gate === "dispatch" &&
          [
            "ticket_claimed_by_other",
            "ticket_escalation_pr_closed",
            "ticket_escalation_pr_read_failed",
            "ticket_pr_already_open",
            "ticket_pr_handoff_verification_failed",
          ].includes(gateRefusal.reason) &&
          worktreeHandoff
        ) {
          refuseTierEscalationClaim(db, worktreeHandoff, gateRefusal.reason);
        }
        const res = refuseTerminal(gateRefusal.reason, [`${gate}_gate`], {
          detail: gateRefusal.detail,
          receiptEvidence:
            gate === "dispatch" && worktreeHandoff ? gateResult.evidence : null,
        });
        if (res?.fenced) return { fenced: true };
        return {
          runId,
          attempt,
          terminalState: "REFUSED",
          reasonCode: gateRefusal.reason,
          receipt: res?.receipt,
        };
      }

      if (gate === "merge-fix") {
        // The ticket is already assigned and under review by definition. The
        // merge-fix gate proved those live facts; trying the dispatch claim
        // verb here would reject the valid run as ticket_assigned.
        releaseClaimLock(lockFile);
      } else {
        // The retry gate has already re-read and authenticated the surviving
        // claim. Do not run the mutating claim command again: besides being
        // redundant, that could steal the ticket if ownership changed in the
        // narrow interval after the gate read.
        const resumedClaim =
          gateResult.evidence?.checks?.ticket_claim_retry === true ||
          gateResult.evidence?.checks?.ticket_claim_escalation === true;
        if (!resumedClaim) {
          let claimRes;
          try {
            claimRes = await claimTicketFn({
              repo: repoName,
              ticket: ticketId,
              harness: spec.adapter ?? "claude",
            });
          } finally {
            releaseClaimLock(lockFile);
          }

          if (!claimRes?.ok) {
            const reasonCode = claimRes?.reasonCode || "ticket_claim_lost";
            const res = refuseTerminal(reasonCode, ["dispatch_claim"]);
            if (res?.fenced) return { fenced: true };
            return {
              runId,
              attempt,
              terminalState: "REFUSED",
              reasonCode,
              receipt: res?.receipt,
            };
          }
        } else {
          releaseClaimLock(lockFile);
        }

        ticketClaimed = true;
        const capture = ticketHandoffContext(
          ticketId,
          fetchTicketFn,
          repoName,
          gateResult.evidence?.ticket,
        );
        if (!capture.ok) {
          // Never re-queue and thereby bless a body that changed in the
          // admission-to-capture window. This needs a fresh human/triage read
          // and a new ready pin, not an automatic retry of executable text.
          if (mayMutateClaimedTicket()) {
            try {
              blockTicketFn({
                repo: repoName,
                ticket: ticketId,
                why: capture.detail,
                baseline: {
                  check: "post_claim_ticket_capture",
                  exitCode: null,
                  output: capture.reasonCode,
                },
              });
            } catch {
              /* intentionally ignored */
            }
          }
          const res = refuseTerminal(
            capture.reasonCode,
            ["post_claim_ticket_capture"],
            { detail: capture.detail },
          );
          if (res?.fenced) return { fenced: true };
          return {
            runId,
            attempt,
            terminalState: "REFUSED",
            reasonCode: capture.reasonCode,
            receipt: res?.receipt,
          };
        }
        handoffContext = capture.handoff;
        writeWorkerLease({
          repo: repoName,
          ticket: ticketId,
          owner: ticketLeaseOwner,
          pid: process.pid,
          dir: leasesDir,
          now: nowFn(),
        });
        leaseHeartbeat = setInterval(() => {
          try {
            renewWorkerLease({
              repo: repoName,
              ticket: ticketId,
              owner: ticketLeaseOwner,
              dir: leasesDir,
              now: Date.now(),
            });
          } catch {
            /* intentionally ignored */
          }
        }, LEASE_HEARTBEAT_MS);
        leaseHeartbeat?.unref?.();
      }
    }

    let created;
    try {
      created = createWorkspace({
        root: workspacesRoot,
        runId,
        attempt,
        input: executionInput,
        workspace: spec.workspace,
        artifactStore,
        adapter: adapterKey,
        ticketLeaseOwner,
        workerLeasesDir: leasesDir,
        worktreeHandoff,
        materializeWorktree,
      });
    } catch (err) {
      // Missing declared inputs are permanent: re-queuing cannot repopulate an
      // artifact store entry that the run has already pinned by hash. This
      // boundary is deliberately narrow so a similarly worded later error is
      // not mistaken for an input-materialization failure.
      if (/^artifact [a-f0-9]{64} is not in the store$/.test(err?.message)) {
        err.code = "input_artifact_missing";
      }
      throw err;
    }
    workspaceDir = created.dir;
    // A continuation receives the original schema-validated input, plus this
    // workspace-local diagnostic. It is deliberately not written into the
    // RunSpec input: the original ticket event remains immutable and the
    // closed dispatch input schema need not admit worker-owned context.
    if (worktreeHandoff?.handoffFailure) {
      const inputPath = path.join(workspaceDir, "input.json");
      const executionInput = JSON.parse(readFileSync(inputPath, "utf8"));
      writeFileSync(
        inputPath,
        `${canonicalJson(
          continuationExecutionInput(
            executionInput,
            worktreeHandoff.handoffFailure,
          ),
        )}\n`,
        "utf8",
      );
    }
    assertSandboxWorkspaceSupported(workspaceDir, def);
    // Repository checkouts receive instance-local config and integrity
    // baselining. Delegated worktrees already provision their own instance and
    // must not be mutated by that repository-only setup; retain their path
    // separately for an escalation ownership transfer.
    checkoutPath = created.checkout?.path ?? null;
    worktreePath = created.worktree?.path ?? null;
    // The guard is load-bearing, not redundant: provisioning is async, and
    // awaiting it for a checkout-less run would yield before the adapter
    // starts, letting a cancel issued right after the claim short-circuit the
    // attempt instead of aborting a started adapter (OPS-417).
    if (checkoutPath) {
      await provisionInstanceLocalConfigs({
        checkoutPath,
        onProbeTimeout: ({ repo, name, ceilingMs }) =>
          recorder("lifecycle", {
            note: `probe_timeout:${name}`,
            repo,
            ceilingMs,
          }),
      });
    }
    checkoutBaseline = checkoutPath ? repositoryStatus(checkoutPath) : null;
    worktreeRecord = created.worktree
      ? {
          ...created.worktree,
          ...(handoffContext ? { handoff: handoffContext } : {}),
        }
      : null;
    db.query(
      `UPDATE attempts SET workspace_path = ? WHERE run_id = ? AND attempt = ?`,
    ).run(workspaceDir, runId, attempt);

    const adapter = adapters[adapterKey];
    if (!adapter) {
      const res = failTerminal("FAILED", "unknown_adapter", "unknown_adapter");
      cleanupWorkspace({ retainWorkspace: retain });
      if (res?.fenced) return { fenced: true };
      return {
        runId,
        attempt,
        terminalState: "FAILED",
        reasonCode: "unknown_adapter",
      };
    }
    if (!def) def = getAgent(registry, spec.agent);

    try {
      const writtenHarness = materializeRunHarness({
        spec,
        adapter,
        adapterKey,
        workspaceDir,
        registry,
      });
      const pins = Object.assign(
        {},
        ...writtenHarness.map((entry) => entry.pins),
      );
      materializedHarnessPins = Object.keys(pins).length > 0 ? pins : null;
    } catch (err) {
      if (err instanceof HarnessMaterializeError) {
        const refusedRes = refuseTerminal(err.code, ["harness_materialize"], {
          causeTyped: true,
          detail: err.message,
        });
        cleanupWorkspace();
        if (refusedRes?.fenced) return { fenced: true };
        return {
          runId,
          attempt,
          terminalState: "REFUSED",
          reasonCode: err.code,
          receipt: refusedRes.receipt,
        };
      }
      throw err;
    }

    // Live trace (factory.trace/v1): the recorder is already defensive, but
    // wrap it anyway — an adapter streaming trace events mid-run must never
    // be able to turn a recording problem into a failed attempt.
    // Real wall-clock per event — NOT the claim-time `now`. Trace timestamps
    // are the one place frozen time defeats the feature: "what is the agent
    // doing right now" needs to say when each step actually happened.
    const onTrace = (kind, payload) => {
      try {
        recorder(kind, payload);
      } catch {
        // swallow: trace is observability, not correctness
      }
    };

    // FAILED / TIMED_OUT / CANCELLED write no results receipt, so the
    // unconfined attestation would otherwise exist only for runs that reached
    // COMPLETED or REFUSED. Recording it on the attempt trace makes the
    // audit line survive every terminal path.
    if (filesystemConfinementReceipt) {
      onTrace("lifecycle", filesystemConfinementReceipt);
    }

    const onUsage = (usage) => {
      attemptUsage = { adapter: adapterKey, ...(usage ?? {}) };
    };

    // The extension endpoint changes the durable deadline while this promise
    // is in flight. Re-read it both on a short cadence and at the timer edge:
    // an extension committed just before the old edge must win the race.
    const logicalBase = nowFn();
    const wallBase = Date.now();
    const logicalNow = () => logicalBase + (Date.now() - wallBase);
    let deadlineTimer = null;
    let deadlinePoll = null;
    let deadlineExpired = false;
    const refreshDeadline = () => {
      if (abortController.signal.aborted) return;
      const deadlineMs = attemptDeadline(db, runId, attempt, spec);
      if (!Number.isFinite(deadlineMs)) return;
      try {
        const leaseExpiresAt = new Date(
          deadlineMs + LEASE_GRACE_SECONDS * 1000,
        ).toISOString();
        db.query(
          `UPDATE attempts SET lease_expires_at = ?
            WHERE run_id = ? AND attempt = ? AND fencing_token = ?
              AND (lease_expires_at IS NULL OR lease_expires_at < ?)`,
        ).run(leaseExpiresAt, runId, attempt, fencingToken, leaseExpiresAt);
      } catch {
        /* intentionally ignored */
      }
      if (deadlineTimer) clearTimeout(deadlineTimer);
      const leftMs = deadlineMs - logicalNow();
      if (leftMs <= 0) {
        const expiry = expireRunDeadline(db, runId, attempt, fencingToken, {
          actor: owner,
          policyVersion,
          now: logicalNow(),
        });
        if (expiry.expired) {
          deadlineExpired = true;
          abortController.abort("deadline_expired");
          return;
        }
        if (Number.isFinite(expiry.deadlineMs)) {
          deadlineTimer = setTimeout(
            refreshDeadline,
            Math.max(1, expiry.deadlineMs - logicalNow()),
          );
          deadlineTimer.unref?.();
        }
        return;
      }
      deadlineTimer = setTimeout(refreshDeadline, leftMs);
      deadlineTimer.unref?.();
    };
    // Idempotent for the same reason as `startCancellationMonitor`: the
    // bounded Pi result repair re-arms the durable deadline for its own turn.
    const startDeadlineMonitor = () => {
      if (deadlinePoll) return;
      refreshDeadline();
      deadlinePoll = setInterval(refreshDeadline, DEADLINE_POLL_MS);
      deadlinePoll.unref?.();
    };
    startDeadlineMonitor();
    const stopDeadlineMonitor = () => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (deadlinePoll) clearInterval(deadlinePoll);
      deadlineTimer = null;
      deadlinePoll = null;
    };

    const workerEventHome =
      env.FACTORY_EVENT_HOME ?? process.env.FACTORY_EVENT_HOME;
    const workerEventPort =
      env.FACTORY_EVENT_PORT ?? process.env.FACTORY_EVENT_PORT;
    const workerControlToken =
      env.FACTORY_CONTROL_API_TOKEN ?? process.env.FACTORY_CONTROL_API_TOKEN;
    // The agent may have retained a notification because it deliberately
    // lacks the control bearer. Callers drain in `finally` so an adapter throw
    // can never strand a retained escalation, and only after the adapter has
    // fully stopped, so no writer races the read/truncate cycle. Neither the
    // drain nor its ticket comment may throw: the agent's primary terminal
    // outcome (or error) always wins.
    const drainNotifyOutboxSafely = async () => {
      try {
        const notificationDrain = isWorktree
          ? await drainLocalNotifyOutbox({
              runId,
              home: workerEventHome,
              port: workerEventPort,
              token: workerControlToken,
              fetchFn: localNotifyFetch,
            })
          : { delivered: [], undelivered: [] };
        if (notificationDrain.undelivered.length && mayMutateClaimedTicket()) {
          try {
            const messages = notificationDrain.undelivered
              .slice(0, 10)
              .map(
                ({ title, error }) => `- ${JSON.stringify(title)} — ${error}`,
              )
              .join("\n");
            commentTicketFn({
              repo: repoName,
              ticket: ticketId,
              body:
                `## Notification outbox\n` +
                `Worker could not deliver ${notificationDrain.undelivered.length} retained notification(s); intended text:\n${messages}`,
            });
          } catch {
            // The retained outbox remains the recovery source if the tracker
            // is down.
          }
        }
      } catch (err) {
        recordTerminalError("drainLocalNotifyOutbox", err);
      }
    };

    let outcome;
    let adapterEnv;
    try {
      // Dispatch identity comes from the immutable RunSpec, never the ambient
      // worker environment. The adapter's child-environment builder preserves
      // these values while continuing to strip credentials it does not need.
      const dispatchEnv = { ...env };
      for (const key of ["FACTORY_EVENT_HOME", "FACTORY_EVENT_PORT"]) {
        if (dispatchEnv[key] === undefined && process.env[key] !== undefined)
          dispatchEnv[key] = process.env[key];
      }
      adapterEnv = dispatchIdentityEnv({
        spec,
        env: dispatchEnv,
        runId,
        ticketId,
        repoName,
        resultPath: path.join(workspaceDir, "result.json"),
      });
      outcome = await adapter.execute({
        spec:
          executionInput === spec.input
            ? spec
            : { ...spec, input: executionInput },
        def,
        workspaceDir,
        timeoutMs: adapterExecuteTimeoutMs({
          adapterKey,
          spec,
          maxRunMinutes: policyMaxRunMinutes(policyRoot),
        }),
        env: adapterEnv,
        onTrace,
        onUsage,
        resume: created.resume ?? null,
        abortSignal: abortController.signal,
        signal: abortController.signal,
      });
    } finally {
      stopDeadlineMonitor();
      stopCancellationMonitor();
      await drainNotifyOutboxSafely();
    }

    if (outcome?.usage)
      attemptUsage = { adapter: adapterKey, ...outcome.usage };
    if (deadlineExpired) outcome = { ...(outcome ?? {}), timedOut: true };

    if (abortController.signal.aborted && !deadlineExpired) {
      const terminalState = db
        .query(`SELECT state FROM runs WHERE run_id = ?`)
        .get(runId)?.state;
      let unclaimError;
      if (mayMutateClaimedTicket()) {
        try {
          unclaimTicketFn({
            repo: repoName,
            ticket: ticketId,
            why: terminalState === "FAILED" ? "force_failed" : "cancelled",
            log: null,
          });
        } catch (err) {
          unclaimError = recordTerminalError("unclaimTicket", err);
        }
      }
      cleanupWorkspace();
      const res = txImmediate(db, () => {
        const currentNow = nowFn();
        if (!assertCurrentToken(db, runId, fencingToken)) {
          recordFencedAttempt(db, {
            runId,
            attempt,
            actor: owner,
            policyVersion,
            now: currentNow,
          });
          return { fenced: true };
        }
        const state = db
          .query(`SELECT state FROM runs WHERE run_id = ?`)
          .get(runId)?.state;
        if (state === "CANCELLED") {
          try {
            finishAttempt(
              db,
              runId,
              attempt,
              "CANCELLED",
              "cancelled",
              currentNow,
              attemptUsage,
            );
          } catch (err) {
            return {
              finishError: recordTerminalError("finishAttempt", err),
            };
          }
        }
        return { ok: true };
      });
      if (res?.fenced) return { fenced: true };
      return {
        cancelled: true,
        ...(unclaimError ? { unclaimError } : {}),
        ...(res?.finishError ? { finishError: res.finishError } : {}),
      };
    }

    const { exitCode, timedOut, policyDenials = [] } = outcome ?? {};
    let lateCompletion = false;

    if (timedOut) {
      // The adapter's stream may outlive the agent-authored artifact. Perform
      // an output-contract preflight before recording TIMED_OUT, but suppress
      // worktree command verification until after the fenced VERIFYING
      // transition below. The normal verifier then runs again in full.
      try {
        verifyResultFn({
          spec,
          def,
          registry,
          workspaceDir,
          attempt,
          attemptStartedAt: started.startedAt,
          extraArtifacts: RUNTIME_ARTIFACTS,
          // The empty record keeps worktree command verification suppressed;
          // the checkout path is handed over separately so the stray-result
          // probe still looks beside the worktree on this branch.
          worktreeRecord: {},
          checkoutPath: worktreeRecord?.path ?? null,
          onTrace,
        });
        lateCompletion = true;
      } catch (err) {
        if (!(err instanceof ContractViolation)) {
          return failVerificationInternal(err);
        }
      }

      if (!lateCompletion) {
        if (mayMutateClaimedTicket()) {
          try {
            unclaimTicketFn({
              repo: repoName,
              ticket: ticketId,
              why: "timeout",
              log: null,
            });
          } catch {
            /* intentionally ignored */
          }
        }
        const res = failTerminal("TIMED_OUT", "timeout", "timeout");
        cleanupWorkspace({ retainWorkspace: retain });
        if (res?.fenced) return { fenced: true };
        return {
          runId,
          attempt,
          terminalState: "TIMED_OUT",
          reasonCode: "timeout",
        };
      }
    }
    const denial = policyDenials[0];
    if (!lateCompletion && denial) {
      if (mayMutateClaimedTicket()) {
        try {
          unclaimTicketFn({
            repo: repoName,
            ticket: ticketId,
            why: `policy_denied:${denial.tool}`,
            log: null,
          });
        } catch {
          /* intentionally ignored */
        }
      }
      const reasonCode = `policy_denied:${denial.tool}`;
      const res = failTerminal("FAILED", reasonCode, reasonCode);
      cleanupWorkspace({ retainWorkspace: retain });
      if (res?.fenced) return { fenced: true };
      return { runId, attempt, terminalState: "FAILED", reasonCode };
    }
    if (!lateCompletion && exitCode !== 0) {
      const reasonCode = `agent_exit_${exitCode}`;
      const escalating = tierEscalationDue(reasonCode);
      // A skipped escalation writes no continuation, so the claim has no
      // successor to inherit it: release it here or the ticket is stranded
      // In Progress forever. `defaultUnclaimTicket` no-ops unless the ticket
      // is still In Progress + ai:in-progress, so the `ticket_in_review` skip
      // cannot drag a reviewed ticket back to Todo (#2006).
      const escalationGuard = escalating
        ? resolveEscalationGuard(reasonCode)
        : null;
      if (mayMutateClaimedTicket() && (!escalating || escalationGuard?.skip)) {
        try {
          unclaimTicketFn({
            repo: repoName,
            ticket: ticketId,
            why: reasonCode,
            log: null,
          });
        } catch {
          /* intentionally ignored */
        }
      }
      const res = failTerminal("FAILED", reasonCode, reasonCode);
      const projection = projectScheduledEscalation(res?.escalation);
      if (!res?.escalation) cleanupWorkspace({ retainWorkspace: retain });
      if (res?.fenced) return { fenced: true };
      return {
        runId,
        attempt,
        terminalState: "FAILED",
        reasonCode,
        ...(res?.tierEscalationSkip
          ? { tierEscalationSkip: res.tierEscalationSkip }
          : {}),
        ...(res?.escalation
          ? {
              escalatedRunId: res.escalation.continuation_run_id,
              escalationProjection: projection,
            }
          : {}),
      };
    }

    // The settings policy is preventative; this is the independent, durable
    // check before a repository-read run's output can be accepted or emitted.
    // Mutating worktree workspaces are exempt.
    if (
      !isWorktree &&
      !def.mutating &&
      checkoutPath &&
      (checkoutBaseline === null ||
        repositoryStatus(checkoutPath) !== checkoutBaseline)
    ) {
      const reasonCode = "workspace_integrity_violation";
      const res = failTerminal("FAILED", reasonCode, reasonCode);
      cleanupWorkspace({ retainWorkspace: true });
      if (res?.fenced) return { fenced: true };
      return { runId, attempt, terminalState: "FAILED", reasonCode };
    }

    const toVerifying = txImmediate(db, () => {
      const currentNow = nowFn();
      if (!assertCurrentToken(db, runId, fencingToken)) {
        recordFencedAttempt(db, {
          runId,
          attempt,
          actor: owner,
          policyVersion,
          now: currentNow,
        });
        return { fenced: true };
      }
      transition(db, {
        runId,
        to: "VERIFYING",
        expectFrom: "RUNNING",
        actor: owner,
        reason: lateCompletion ? "late_completion_after_timeout" : "exit_0",
        attempt,
        policyVersion,
        now: currentNow,
      });
      return { ok: true };
    });
    if (toVerifying?.fenced) {
      cleanupWorkspace();
      return { fenced: true };
    }

    let verified;
    let recovery = null;
    verificationAttempt: try {
      verified = verifyResultFn({
        spec,
        def,
        registry,
        workspaceDir,
        attempt,
        attemptStartedAt: started.startedAt,
        extraArtifacts: RUNTIME_ARTIFACTS,
        worktreeRecord,
        onTrace,
      });
      // `prNumber` was optional on pre-WM-576 dispatch artifacts. Preserve
      // their accepted handoffs; current dispatch prompts require it, and all
      // new PR_OPEN artifacts are checked against the configured base here.
      if (verified.handoff && handoffPrNumber(verified.handoff)) {
        assertHandoffPullRequestBase({
          handoff: verified.handoff,
          base: worktreeRecord?.base,
          fetchPullRequest: fetchHandoffPullRequestFn,
        });
      }
    } catch (err) {
      if (!(err instanceof ContractViolation)) {
        return failVerificationInternal(err);
      }
      let activeError = err;
      let recovered;
      try {
        recovered = recoverMissingDispatchResult({
          error: err,
          spec,
          def,
          workspaceDir,
          worktreeRecord,
          findPullRequest:
            dispatchOpts?.findWorkspacePullRequest ??
            defaultFindWorkspacePullRequest,
          fetchPullRequest: fetchHandoffPullRequestFn,
        });
      } catch (recoveryError) {
        if (!(recoveryError instanceof ContractViolation)) {
          return failVerificationInternal(recoveryError);
        }
        activeError = recoveryError;
      }
      if (recovered) {
        recovery = recovered;
        try {
          verified = verifyResultFn({
            spec,
            def,
            registry,
            workspaceDir,
            attempt,
            attemptStartedAt: started.startedAt,
            extraArtifacts: RUNTIME_ARTIFACTS,
            worktreeRecord,
            onTrace,
          });
          if (verified.handoff && handoffPrNumber(verified.handoff)) {
            assertHandoffPullRequestBase({
              handoff: verified.handoff,
              base: worktreeRecord?.base,
              fetchPullRequest: fetchHandoffPullRequestFn,
            });
          }
          // A recovered candidate can name a more precise terminal outcome
          // than ordinary missing-result recovery. In particular, a pushed
          // branch with no PR must remain distinguishable so the ticket claim
          // is released below instead of being completed as a normal recovery.
          if (
            !verified.result.reasonCode ||
            verified.result.reasonCode === "ok"
          ) {
            verified.result.reasonCode = RECOVERED_RESULT_REASON;
          }
          break verificationAttempt;
        } catch (recoveryError) {
          if (!(recoveryError instanceof ContractViolation)) {
            return failVerificationInternal(recoveryError);
          }
          activeError = recoveryError;
        }
      }
      // Codex-tier Pi sessions have historically completed the ticket while
      // writing an invented result shape. Give only that zero-exit, pre-handoff
      // contract failure one bounded turn with the validator diagnostics; a
      // handoff-gate failure must never be retried as an envelope repair.
      if (mayRepairPiResult({ adapterKey, outcome, error: activeError })) {
        const originalViolations = activeError.violations;
        const invalidSnapshot = snapshotInvalidResult({
          workspaceDir,
          onTrace,
        });
        let repairOutcome = null;
        let repairUsage = null;
        // The repair is a live adapter turn like any other: it runs under the
        // same durable deadline and cancellation supervision, and drains the
        // notify outbox in `finally` so a throw can never strand a retained
        // escalation.
        startCancellationMonitor();
        startDeadlineMonitor();
        try {
          repairOutcome = await adapter.execute({
            spec:
              executionInput === spec.input
                ? spec
                : { ...spec, input: executionInput },
            def,
            workspaceDir,
            timeoutMs: PI_RESULT_REPAIR_TIMEOUT_MS,
            env: adapterEnv,
            onTrace,
            onUsage: (usage) => {
              repairUsage = usage ?? null;
            },
            resume: created.resume ?? null,
            abortSignal: abortController.signal,
            signal: abortController.signal,
            resultRepair: {
              violations: originalViolations,
              priorResultPath: invalidSnapshot?.source ?? null,
              priorResult: invalidSnapshot?.preview ?? null,
            },
          });
        } catch (repairError) {
          // The repair is best-effort commentary on an already-failed
          // envelope. An adapter throw leaves the original violations
          // standing rather than reclassifying the run.
          onTrace("lifecycle", {
            event: "pi_result_repair_failed",
            error: String(repairError?.message ?? repairError),
          });
          repairOutcome = null;
        } finally {
          stopDeadlineMonitor();
          stopCancellationMonitor();
          await drainNotifyOutboxSafely();
        }
        if (repairOutcome?.usage) repairUsage = repairOutcome.usage;
        if (repairUsage)
          attemptUsage = mergeAttemptUsage(
            attemptUsage,
            repairUsage,
            adapterKey,
          );
        if (
          repairOutcome?.exitCode === 0 &&
          !repairOutcome?.timedOut &&
          !abortController.signal.aborted
        ) {
          try {
            verified = verifyResultFn({
              spec,
              def,
              registry,
              workspaceDir,
              attempt,
              attemptStartedAt: started.startedAt,
              extraArtifacts: RUNTIME_ARTIFACTS,
              worktreeRecord,
              onTrace,
            });
            if (verified.handoff && handoffPrNumber(verified.handoff)) {
              assertHandoffPullRequestBase({
                handoff: verified.handoff,
                base: worktreeRecord?.base,
                fetchPullRequest: fetchHandoffPullRequestFn,
              });
            }
            break verificationAttempt;
          } catch (repairError) {
            if (!(repairError instanceof ContractViolation)) {
              return failVerificationInternal(repairError);
            }
            // The rejected original is what a human has to read; the repair's
            // own violations are appended detail, never a replacement.
            activeError = new ContractViolation(
              [
                ...originalViolations,
                ...(repairError.violations ?? []).map(
                  (violation) => `after repair: ${violation}`,
                ),
                ...(invalidSnapshot
                  ? [`rejected envelope retained at ${invalidSnapshot.path}`]
                  : []),
              ],
              {
                reasonCode: activeError.reasonCode,
                handoff: repairError.handoff ?? activeError.handoff ?? null,
              },
            );
          }
        }
      }
      if (activeError.reasonCode === HANDOFF_FORGE_UNAVAILABLE) {
        const deferred = deferTransientDispatchGate(db, {
          runId,
          attempt,
          fencingToken,
          owner,
          policyVersion,
          now: nowFn,
          reasonCode: HANDOFF_FORGE_UNAVAILABLE,
          expectFrom: "VERIFYING",
          maxRequeues: Number.isInteger(dispatchOpts?.maxTransientGateRequeues)
            ? Math.max(0, dispatchOpts.maxTransientGateRequeues)
            : DEFAULT_MAX_TRANSIENT_GATE_REQUEUES,
          random: dispatchOpts?.random ?? Math.random,
        });
        if (deferred?.fenced) return { fenced: true };
        if (deferred?.requeued) {
          return {
            runId,
            attempt,
            terminalState: "QUEUED",
            reasonCode: HANDOFF_FORGE_UNAVAILABLE,
            requeueAfterMs: deferred.backoffMs,
          };
        }
      }
      const reasonCode =
        activeError.reasonCode === "baseline_red" ||
        activeError.reasonCode === HANDOFF_SANDBOX_UNAVAILABLE ||
        activeError.reasonCode === HANDOFF_DEPENDENCIES_MISSING ||
        activeError.reasonCode === HANDOFF_FORGE_UNAVAILABLE ||
        HANDOFF_REASON_CODES.has(activeError.reasonCode)
          ? activeError.reasonCode
          : "contract_violation";
      let failureReason =
        activeError.violations.length === 1 &&
        activeError.violations[0] === "missing_result"
          ? `${reasonCode}: ${missingResultFailure(workspaceDir, activeError)}`
          : `${reasonCode}: ${activeError.violations.join(", ")}`;
      const continuationFailure = escalationHandoffFailure(
        activeError,
        failureReason,
      );
      const handoff = activeError.handoff ?? null;
      const handoffBody = handoff
        ? `${composeHandoffVerification(handoff)}\n\n**Result:** run ${runId} FAILED \`${reasonCode}\` — ${activeError.violations.join("; ")}`
        : null;
      const escalating = tierEscalationDue(reasonCode);
      // WM-718: the PR is the agent's, already opened; the structural hold is
      // to draft it and quote the observed failure where the reviewer looks.
      if (
        isAgentHandoffFailure(reasonCode) &&
        handoff?.prNumber &&
        mayMutateClaimedTicket()
      ) {
        try {
          holdPullRequestFn({
            repo: repoName,
            github: handoff.github,
            prNumber: handoff.prNumber,
            prUrl: handoff.prUrl,
            body: `${handoffBody}\n\nConverted to draft by the factory worker: the handoff did not verify.`,
          });
        } catch {
          /* intentionally ignored */
        }
      }
      // Resolve the guard only AFTER the hold above: an ordinary handoff
      // verification failure has just converted the agent's own PR to draft,
      // and probing the forge before that would read the still-open PR as
      // retained review ownership and suppress every escalation on the most
      // common failure path (#2006).
      const escalationGuard = escalating
        ? resolveEscalationGuard(reasonCode)
        : null;
      if (mayMutateClaimedTicket() && (!escalating || escalationGuard?.skip)) {
        if (escalationGuard?.skip) {
          // No continuation was scheduled, so nothing inherits the claim.
          // Release it through the plain unclaim, which no-ops unless the
          // ticket is still In Progress + ai:in-progress — the
          // `ticket_in_review` skip must never pull a reviewed ticket back to
          // Todo the way the handoff return would.
          try {
            unclaimTicketFn({
              repo: repoName,
              ticket: ticketId,
              why: failureReason,
              log: null,
            });
          } catch {
            /* intentionally ignored */
          }
        } else if (isAgentHandoffFailure(reasonCode)) {
          try {
            const returned = returnHandoffTicketFn({
              repo: repoName,
              ticket: ticketId,
              why: failureReason,
              body: `${handoffBody}\n\nClaim released back to Todo + ai:agent-ready.`,
              handoff,
            });
            // Surface a failed label restore in the journal/returned summary
            // too — the comment posted on the ticket is not the only place a
            // human (or the next dispatch pass) looks.
            if (returned && returned.agentReadyRestored === false) {
              failureReason = `${failureReason} (ai:agent-ready NOT restored: ${returned.warning ?? "unknown error"})`;
            }
          } catch {
            /* intentionally ignored */
          }
        } else if (reasonCode === "baseline_red") {
          try {
            blockTicketFn({
              repo: repoName,
              ticket: ticketId,
              why: failureReason,
              log: null,
              baseline: worktreeRecord?.baseline,
            });
          } catch {
            /* intentionally ignored */
          }
        } else {
          try {
            unclaimTicketFn({
              repo: repoName,
              ticket: ticketId,
              why: failureReason,
              log: null,
            });
          } catch {
            /* intentionally ignored */
          }
        }
      }
      // Invalid output is a typed contract failure and emits no completion
      // event (§15) — no results row, no outbox row. A matching pre-existing
      // red baseline is equally non-admissible, but is named separately and
      // not retried as though the agent caused an ordinary contract failure.
      const res = txImmediate(db, () => {
        const currentNow = nowFn();
        if (!assertCurrentToken(db, runId, fencingToken)) {
          recordFencedAttempt(db, {
            runId,
            attempt,
            actor: owner,
            policyVersion,
            now: currentNow,
          });
          return { fenced: true };
        }
        const decision = retryDecision(db, runId, spec, reasonCode, {
          includeCurrentFailure: true,
        });
        transition(db, {
          runId,
          to: "FAILED",
          expectFrom: "VERIFYING",
          actor: owner,
          reason: terminalFailureReason(decision, reasonCode, failureReason),
          attempt,
          policyVersion,
          now: currentNow,
        });
        finishAttempt(
          db,
          runId,
          attempt,
          "FAILED",
          reasonCode,
          currentNow,
          attemptUsage,
        );
        let escalation = null;
        if (decision.retry) {
          transition(db, {
            runId,
            to: "QUEUED",
            expectFrom: "FAILED",
            actor: owner,
            reason: `retry:${decision.cause}`,
            attempt,
            policyVersion,
            now: nowFn(),
          });
        } else if (escalationGuard?.eligible && !escalationGuard.skip) {
          escalation = scheduleTierEscalation(db, registry, spec, {
            workspacePath: worktreePath ?? checkoutPath,
            sourceWorkspacePath: workspaceDir,
            actor: owner,
            policyVersion,
            now: currentNow,
            reasonCode,
            handoffFailure: continuationFailure,
            continuationGuard: escalationGuard,
          });
        }
        return {
          ok: true,
          escalation,
          tierEscalationSkip:
            !decision.retry && escalationGuard?.skip
              ? escalationGuard.reason
              : null,
        };
      });
      const projection = projectScheduledEscalation(res?.escalation);
      commentTierEscalationSkip(res?.tierEscalationSkip);
      if (!res?.escalation) cleanupWorkspace({ retainWorkspace: retain });
      if (res?.fenced) return { fenced: true };
      return {
        runId,
        attempt,
        terminalState: "FAILED",
        reasonCode,
        detail: failureReason,
        ...(handoff ? { handoff } : {}),
        ...(res?.tierEscalationSkip
          ? { tierEscalationSkip: res.tierEscalationSkip }
          : {}),
        ...(res?.escalation
          ? {
              escalatedRunId: res.escalation.continuation_run_id,
              escalationProjection: projection,
            }
          : {}),
      };
    }

    if (verified.kind === "refused") {
      if (mayMutateClaimedTicket()) {
        try {
          unclaimTicketFn({
            repo: repoName,
            ticket: ticketId,
            why: `refused: ${verified.reasonCode}`,
            log: null,
          });
        } catch {
          /* intentionally ignored */
        }
      }
      const collected = [];
      for (const entry of RUNTIME_ARTIFACTS) {
        let abs;
        try {
          // Refusal artifacts bypass verifyCompleted's collection path, so
          // repeat the shared canonical/regular-file preflight before the
          // first host-side read or hash. Missing and guest-supplied links are
          // best-effort omissions, just like absent runtime artifacts.
          abs = confinedRegularFile(workspaceDir, entry.path);
        } catch (err) {
          if (err?.code === "ENOENT") continue;
          if (!(err instanceof PathViolation)) throw err;
          continue;
        }
        try {
          const collectedEntry = {
            kind: entry.kind,
            uri: `file://${abs}`,
            sha256: sha256Hex(readFileSync(abs)),
          };
          // The fixed runtime files live at the workspace root. The helper
          // returned their canonical path, so dirname is canonical provenance
          // for storeCollected's independent pre-copy confinement check.
          Object.defineProperty(collectedEntry, "workspaceRoot", {
            value: path.dirname(abs),
          });
          collected.push(collectedEntry);
        } catch (err) {
          // The guest may unlink the artifact between the preflight and the
          // read; that is the same best-effort omission as never writing it.
          if (err?.code !== "ENOENT") throw err;
        }
      }
      const artifacts = storeCollected({
        entries: collected,
        storeRoot: artifactStore,
      });
      const refusedResult = {
        ...verified.result,
        artifacts,
      };

      // Refusal is not failure (§5.3): store the typed result, publish no
      // completion event, clean the workspace normally.
      const res = txImmediate(db, () => {
        const currentNow = nowFn();
        if (!assertCurrentToken(db, runId, fencingToken)) {
          recordFencedAttempt(db, {
            runId,
            attempt,
            actor: owner,
            policyVersion,
            now: currentNow,
          });
          return { fenced: true };
        }
        transition(db, {
          runId,
          to: "REFUSED",
          expectFrom: "VERIFYING",
          actor: owner,
          reason: verified.reasonCode,
          attempt,
          policyVersion,
          now: currentNow,
        });
        closeOpenProposalForRun(db, runId, {
          actor: owner,
          reason: "run_refused",
          now: currentNow,
        });
        const receipt = receiptWithDeadlineExtensions(db, runId, {
          runId,
          spec,
          def,
          artifactHash: null,
          evidenceSetHash: null,
          journalHead: latestJournalHash(db, runId),
          verificationStatus: "passed",
          extraReceipt: filesystemConfinementReceipt,
          harnessPins: materializedHarnessPins,
        });
        db.query(
          `INSERT INTO results (run_id, attempt, result_json, artifact_hash, evidence_set_hash, verification_json, receipt_json, accepted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          runId,
          attempt,
          canonicalJson(refusedResult),
          "none",
          null,
          canonicalJson(refusedResult.verification),
          canonicalJson(receipt),
          iso(currentNow),
        );
        // Best-effort projection: the inbox row must never un-record the
        // terminal REFUSED state or its result row by throwing out of this tx.
        try {
          createRefusalInboxItem(db, spec, refusedResult, { now: currentNow });
        } catch (err) {
          console.error(
            `[worker] refusal inbox item not created for ${runId}: ${err?.message ?? err}`,
          );
        }
        finishAttempt(
          db,
          runId,
          attempt,
          "REFUSED",
          verified.reasonCode,
          currentNow,
          attemptUsage,
        );
        return { ok: true, receipt };
      });
      cleanupWorkspace();
      if (res?.fenced) return { fenced: true };
      return {
        runId,
        attempt,
        terminalState: "REFUSED",
        reasonCode: verified.reasonCode,
        receipt: res.receipt,
      };
    }

    // Recovery found a remote branch but no PR. It is a completed, durable
    // diagnostic rather than an agent handoff failure, so it does not use the
    // handoff-return path; it must still release the claim for the next
    // dispatcher instead of stranding the ticket In Progress.
    if (
      recovery?.candidate?.reasonCode === "pushed_branch_no_pr" &&
      verified.result.reasonCode === "pushed_branch_no_pr" &&
      mayMutateClaimedTicket()
    ) {
      try {
        unclaimTicketFn({
          repo: repoName,
          ticket: ticketId,
          why: "pushed_branch_no_pr",
          log: null,
        });
      } catch {
        /* intentionally ignored */
      }
    }

    // The run is accepted: neither failed nor refused. Only now may the PR
    // leave draft — a refused handoff must not be promoted — and promoting it
    // before the handoff comment is composed keeps that comment an observation
    // of the PR's final state.
    if (verified.handoff && handoffPrNumber(verified.handoff)) {
      markHandoffPullRequestReadyFn({ handoff: verified.handoff });
    }

    // WM-718: the Handoff's Verification line is worker-authored. Post what
    // was observed on the ticket; the agent's claim rides below it labelled
    // agent-reported. Best effort — a comment failure never fails a verified
    // run.
    if (verified.handoff && mayMutateClaimedTicket()) {
      let stateReconciled = false;
      try {
        stateReconciled =
          reconcileVerifiedHandoffTicketFn({
            repo: repoName,
            ticket: ticketId,
            mayMutate: mayMutateClaimedTicket,
          }) === true;
      } catch (err) {
        console.error(
          `[worker] failed to reconcile verified handoff ticket ${ticketId}: ${String(err?.message ?? err)}`,
        );
      }
      try {
        commentTicketFn({
          repo: repoName,
          ticket: ticketId,
          body: [
            composeHandoffVerification(verified.handoff),
            ...(stateReconciled ? ["- state reconciled by worker"] : []),
          ].join("\n"),
          handoff: verified.handoff,
        });
      } catch {
        /* intentionally ignored */
      }
    }

    // Copy verified artifact files into the durable content-addressed store
    // (§7) BEFORE the workspace dies and before the row referencing them
    // commits. Orphans from a failed commit are harmless; dead links are not.
    verified.result.artifacts = storeCollected({
      entries: verified.result.artifacts,
      storeRoot: artifactStore,
    });
    storeResultArtifact({
      artifact: verified.result.artifact,
      artifactHash: verified.result.artifactHash,
      storeRoot: artifactStore,
    });

    // Completed: fencing check, result, receipt, outbox event, and the
    // COMPLETED transition are one transaction.
    const published = txImmediate(db, () => {
      const currentNow = nowFn();
      if (!assertCurrentToken(db, runId, fencingToken)) {
        recordFencedAttempt(db, {
          runId,
          attempt,
          actor: owner,
          policyVersion,
          now: currentNow,
        });
        return { fenced: true };
      }

      const receipt = receiptWithDeadlineExtensions(db, runId, {
        runId,
        spec,
        def,
        artifactHash: verified.result.artifactHash,
        evidenceSetHash: verified.result.evidenceSetHash,
        journalHead: latestJournalHash(db, runId),
        verificationStatus: "passed",
        extraReceipt: filesystemConfinementReceipt
          ? {
              ...(verified.receipt ?? {}),
              ...filesystemConfinementReceipt,
            }
          : verified.receipt,
        harnessPins: materializedHarnessPins,
      });
      const { result } = verified;
      db.query(
        `INSERT INTO results (run_id, attempt, result_json, artifact_hash, evidence_set_hash, verification_json, receipt_json, accepted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        runId,
        attempt,
        canonicalJson(result),
        result.artifactHash,
        result.evidenceSetHash,
        canonicalJson(result.verification),
        canonicalJson(receipt),
        iso(currentNow),
      );
      // The accepted result only carries `memos`/`usedMemos`; the pin lives on
      // the spec, so pass it through or the NULL-verdict `memo_uses` rows for
      // pinned-but-unmentioned memos (docs §8 trust signal) never land.
      registerMemos(
        db,
        runId,
        { ...result, memoPin: spec.input?.memoPin },
        {
          now: currentNow,
          agent: spec.agent,
          runState: "COMPLETED",
        },
      );
      persistMergeReviewFromResult(db, {
        spec,
        result,
        runId,
        now: currentNow,
      });

      const origin = originatingEvent(db, runId);
      const envelope = {
        schemaVersion: "factory.event/v1",
        eventId: `event-runtime:${runId}:${attempt}`,
        type: origin
          ? origin.type.replace(/\.requested$/, ".completed")
          : "factory.run.completed",
        source: "event-runtime",
        subject: spec.agent,
        occurredAt: iso(currentNow),
        correlationId: origin?.correlation_id ?? null,
        causationId: origin?.causation_id ?? null,
        payload: {
          runId,
          attempt,
          artifactHash: result.artifactHash,
          outputContract: spec.outputContract,
        },
      };
      db.query(`INSERT INTO outbox (event_json, created_at) VALUES (?, ?)`).run(
        canonicalJson(envelope),
        iso(currentNow),
      );

      transition(db, {
        runId,
        to: "COMPLETED",
        expectFrom: "VERIFYING",
        actor: owner,
        reason: "ok",
        attempt,
        policyVersion,
        now: currentNow,
      });
      finishAttempt(
        db,
        runId,
        attempt,
        "COMPLETED",
        "ok",
        currentNow,
        attemptUsage,
      );
      return { receipt };
    });

    if (published.fenced) {
      cleanupWorkspace();
      return { fenced: true };
    }
    cleanupWorkspace({ retainWorkspace: recovery?.retainWorkspace === true });
    return {
      runId,
      attempt,
      terminalState: "COMPLETED",
      reasonCode: "ok",
      receipt: published.receipt,
      ...(verified.handoff ? { handoff: verified.handoff } : {}),
    };
  } catch (err) {
    if (mayMutateClaimedTicket()) {
      try {
        unclaimTicketFn({
          repo: repoName,
          ticket: ticketId,
          why: err?.message ?? String(err),
          log: null,
        });
      } catch {
        /* intentionally ignored */
      }
    }
    if (err instanceof IllegalTransition) {
      // Operator moved the run under us (cancel) — stop quietly, publish nothing.
      cleanupWorkspace();
      const state = db
        .query(`SELECT state FROM runs WHERE run_id = ?`)
        .get(runId)?.state;
      if (state === "CANCELLED") {
        return { cancelled: true };
      }
      if (!assertCurrentToken(db, runId, fencingToken)) {
        txImmediate(db, () => {
          recordFencedAttempt(db, {
            runId,
            attempt,
            actor: owner,
            policyVersion,
            now,
          });
        });
        return { fenced: true };
      }
      return { cancelled: false, error: err.message };
    }
    // A missing CLI (OPS-296: `pi`/`npx` absent from PATH) is a typed,
    // recognizable adapter precondition, not an opaque crash — an adapter
    // signals it by throwing an error with `code: "cli_not_found"` (see
    // lib/adapters/pi.mjs's CliNotFoundError) before ever spawning a child.
    // No `requeue`: retrying on the same worker just fails the same way.
    const isCliNotFound = err?.code === "cli_not_found";
    const isSandboxUnsupported = err?.code === "sandbox_unsupported";
    const isWorktreeSandboxUnsupported =
      err?.code === "worktree_sandbox_unsupported";
    const isWorkspaceProvisioning =
      err?.code === "workspace_provisioning_error";
    const isInputArtifactMissing = err?.code === "input_artifact_missing";
    const reasonCode = isCliNotFound
      ? "cli_not_found"
      : isSandboxUnsupported
        ? "sandbox_unsupported"
        : isWorktreeSandboxUnsupported
          ? "worktree_sandbox_unsupported"
          : isWorkspaceProvisioning
            ? "workspace_provisioning_error"
            : isInputArtifactMissing
              ? "input_artifact_missing"
              : "adapter_error";
    const journalReason = `${reasonCode}: ${err?.message ?? String(err)}`;
    let res;
    let terminalError;
    try {
      res = failTerminal(
        "FAILED",
        journalReason,
        reasonCode,
        isInputArtifactMissing
          ? (currentNow) =>
              retireMissingPinnedMemo(db, spec.input, err, currentNow)
          : undefined,
      );
    } catch (err) {
      terminalError = recordTerminalError("failTerminal", err);
    }
    cleanupWorkspace({ retainWorkspace: retain });
    if (res?.fenced) return { fenced: true };
    return {
      runId,
      attempt,
      terminalState: "FAILED",
      reasonCode,
      error: err?.message,
      ...(terminalError ? { terminalError } : {}),
    };
  } finally {
    stopCancellationMonitor();
    if (leaseHeartbeat) clearInterval(leaseHeartbeat);
    if (ticketClaimed) {
      try {
        releaseWorkerLease({
          repo: repoName,
          ticket: ticketId,
          owner: ticketLeaseOwner,
          dir: leasesDir,
        });
      } catch {
        /* intentionally ignored */
      }
    }
  }
}

/**
 * Explicit operator recovery for a worker that stopped heartbeating while it
 * still owned a run. This mirrors the lease reaper's retry/exhaustion rules,
 * but targets exactly the selected worker/run. When the run is retried it is
 * re-queued with the retry cause derived from the same decision as the reaper;
 * operator provenance is carried by `actor` (default "operator") on the
 * recorded transitions, not by the reason string.
 */
export function releaseStalledWorkerLease(
  db,
  { workerId, runId },
  {
    now = () => Date.now(),
    policyVersion = "unknown",
    actor = "operator",
  } = {},
) {
  const currentNow = resolveNow(now);
  return txImmediate(db, () => {
    const worker = db
      .query(
        `SELECT state, current_run, last_seen FROM workers WHERE worker_id = ?`,
      )
      .get(workerId);
    if (!worker) throw new Error(`unknown worker ${workerId}`);
    const stale =
      worker.state !== "stopped" &&
      currentNow - Date.parse(worker.last_seen) > HEARTBEAT_STALE_MS;
    if (!stale || !worker.current_run)
      throw new Error(`worker ${workerId} is not stalled with an active run`);
    if (runId && worker.current_run !== runId) {
      throw new Error(
        `worker ${workerId} holds ${worker.current_run}, not ${runId}`,
      );
    }

    const heldRunId = worker.current_run;
    const run = db
      .query(`SELECT state, attempts, spec_json FROM runs WHERE run_id = ?`)
      .get(heldRunId);
    if (!run)
      throw new Error(`worker ${workerId} references unknown run ${heldRunId}`);
    if (!["LEASED", "RUNNING", "VERIFYING"].includes(run.state)) {
      throw new Error(`run ${heldRunId} is ${run.state}, not actively leased`);
    }
    const attempt = db
      .query(
        `SELECT lease_owner FROM attempts WHERE run_id = ? AND attempt = ?`,
      )
      .get(heldRunId, run.attempts);
    if (!attempt) throw new Error(`run ${heldRunId} has no current attempt`);
    if (attempt.lease_owner && attempt.lease_owner !== workerId) {
      throw new Error(
        `run ${heldRunId} is leased by ${attempt.lease_owner}, not ${workerId}`,
      );
    }

    const spec = JSON.parse(run.spec_json);
    db.query(
      `UPDATE attempts SET lease_expires_at = ? WHERE run_id = ? AND attempt = ?`,
    ).run(iso(currentNow - 1), heldRunId, run.attempts);
    const decision = retryDecision(db, heldRunId, spec, "lease_expired", {
      includeCurrentFailure: true,
    });
    const failureReason = terminalFailureReason(decision, "lease_expired");
    if (run.state === "VERIFYING") {
      transition(db, {
        runId: heldRunId,
        to: "FAILED",
        actor,
        reason: failureReason,
        attempt: run.attempts,
        policyVersion,
        now: currentNow,
      });
    }
    finishAttempt(
      db,
      heldRunId,
      run.attempts,
      "FAILED",
      "lease_expired",
      currentNow,
    );
    if (decision.retry) {
      transition(db, {
        runId: heldRunId,
        to: "QUEUED",
        actor,
        reason: `retry:${decision.cause}`,
        attempt: run.attempts,
        policyVersion,
        now: currentNow,
      });
    } else {
      if (run.state === "LEASED") {
        transition(db, {
          runId: heldRunId,
          to: "RUNNING",
          actor,
          reason: failureReason,
          attempt: run.attempts,
          policyVersion,
          now: currentNow,
        });
      }
      if (run.state !== "VERIFYING") {
        transition(db, {
          runId: heldRunId,
          to: "FAILED",
          actor,
          reason: failureReason,
          attempt: run.attempts,
          policyVersion,
          now: currentNow,
        });
      }
    }
    db.query(
      `UPDATE workers SET state = 'stopped', current_run = NULL, stopped_at = ? WHERE worker_id = ?`,
    ).run(iso(currentNow), workerId);
    return { released: true, runId: heldRunId };
  });
}

/**
 * Re-queue LEASED/RUNNING/VERIFYING runs whose current attempt's lease expired.
 * The stale attempt keeps its (now lower) fencing token, so a late publish from
 * it is fenced out. Lease loss spends only the dedicated environment budget.
 */
export function reapExpiredLeases(
  db,
  {
    now = () => Date.now(),
    policyVersion = "unknown",
    onError = ({ runId, error }) =>
      console.error(
        `[worker] expired lease ${runId}: ${error?.message ?? String(error)}`,
      ),
  } = {},
) {
  const currentNow = resolveNow(now);
  const nowIso = iso(currentNow);
  const candidateSql = `SELECT r.run_id, r.attempts, r.spec_json, r.state FROM runs r
       JOIN attempts a ON a.run_id = r.run_id AND a.attempt = r.attempts
       WHERE r.state IN ('LEASED', 'RUNNING', 'VERIFYING') AND a.lease_expires_at < ?`;
  const candidates = db.query(candidateSql).all(nowIso);
  let reaped = 0;

  for (const candidate of candidates) {
    try {
      const outcome = txImmediate(db, () => {
        // The candidate list is a snapshot taken outside this transaction. A
        // worker may have renewed the lease (or the run may have moved on)
        // since; re-read under the write lock and only act when the row is
        // still exactly the expired attempt we selected.
        const row = db
          .query(
            `${candidateSql} AND r.run_id = ? AND r.attempts = ? AND r.state = ?`,
          )
          .get(nowIso, candidate.run_id, candidate.attempts, candidate.state);
        if (!row) return "skipped";
        const spec = JSON.parse(row.spec_json);
        const decision = retryDecision(db, row.run_id, spec, "lease_expired", {
          includeCurrentFailure: true,
        });
        const failureReason = terminalFailureReason(decision, "lease_expired");

        // VERIFYING cannot transition directly to QUEUED; record its failure first.
        if (row.state === "VERIFYING") {
          transition(db, {
            runId: row.run_id,
            to: "FAILED",
            actor: "reaper",
            reason: failureReason,
            attempt: row.attempts,
            policyVersion,
            now: currentNow,
          });
        }
        finishAttempt(
          db,
          row.run_id,
          row.attempts,
          "FAILED",
          "lease_expired",
          currentNow,
        );
        if (decision.retry) {
          transition(db, {
            runId: row.run_id,
            to: "QUEUED",
            actor: "reaper",
            reason: `retry:${decision.cause}`,
            attempt: row.attempts,
            policyVersion,
            now: currentNow,
          });
          return "reaped";
        }

        // LEASED has no direct FAILED edge; advance through RUNNING only when
        // the environment retry ceiling is exhausted and the run must terminate.
        if (row.state === "LEASED") {
          transition(db, {
            runId: row.run_id,
            to: "RUNNING",
            actor: "reaper",
            reason: failureReason,
            attempt: row.attempts,
            policyVersion,
            now: currentNow,
          });
        }
        if (row.state !== "VERIFYING") {
          transition(db, {
            runId: row.run_id,
            to: "FAILED",
            actor: "reaper",
            reason: failureReason,
            attempt: row.attempts,
            policyVersion,
            now: currentNow,
          });
        }
        return "reaped";
      });
      if (outcome === "reaped") reaped += 1;
    } catch (error) {
      onError({ runId: candidate.run_id, error });
    }
  }

  return reaped;
}

/** Claim and execute one run, or return a typed refusal/null without execution. */
export async function runOnce(db, registry, adapters, opts = {}) {
  sweepOrphanedLocalNotifyOutbox({
    db,
    home: opts.env?.FACTORY_EVENT_HOME ?? opts.eventHome,
  });
  // claimNext already reconciles pending escalation projections and logs a
  // failed one without abandoning the claim: a tracker outage on one
  // escalation must never stall claiming of every other queued run. Forward
  // the dispatch-scoped tracker hooks so it uses the same ones this call does.
  const claim = claimNext(db, {
    ...opts,
    projectTierEscalation:
      opts.projectTierEscalation ??
      opts.dispatch?.projectTierEscalation ??
      defaultProjectTierEscalation,
    fetchTicket: opts.fetchTicket ?? opts.dispatch?.fetchTicket,
  });
  if (!claim || claim.refused) return claim;
  return executeClaimed(db, registry, adapters, claim, opts);
}

/**
 * Operator cancel (§13): cancels runs in pre-terminal states.
 * For VERIFYING, transitions to FAILED with reason operator_cancel.
 * A still-open proposal for the run is closed in the same transaction.
 */
export function cancelRun(
  db,
  runId,
  {
    actor,
    reason = "operator_cancel",
    now = () => Date.now(),
    policyVersion,
    unclaimTierEscalation = defaultUnclaimTicket,
    cleanupTierEscalationWorkspace = ({ sourceWorkspacePath, repo }) =>
      destroyWorkspace(sourceWorkspacePath, { repoName: repo }),
  } = {},
) {
  const currentNow = resolveNow(now);
  const outcome = txImmediate(db, () => {
    // Read the executor registry inside the transaction: an execution can
    // register or finish while the write waits on the lock, and the
    // post-commit ownership handoff below must act on what was true when the
    // cancellation actually committed.
    const active = ACTIVE_EXECUTIONS.get(runId);
    const run = db
      .query(`SELECT state, attempts FROM runs WHERE run_id = ?`)
      .get(runId);
    if (!run) throw new Error(`unknown run ${runId}`);
    let result;
    if (run.state === "VERIFYING") {
      result = transition(db, {
        runId,
        to: "FAILED",
        actor,
        reason,
        policyVersion,
        now: currentNow,
      });
      finishAttempt(db, runId, run.attempts, "FAILED", "cancelled", currentNow);
    } else {
      result = transition(db, {
        runId,
        to: "CANCELLED",
        actor,
        reason,
        policyVersion,
        now: currentNow,
      });
      if (run.state === "RUNNING" || run.state === "LEASED") {
        finishAttempt(
          db,
          runId,
          run.attempts,
          "CANCELLED",
          "cancelled",
          currentNow,
        );
      }
    }
    const proposalClose = closeOpenProposalForRun(db, runId, {
      actor,
      now: currentNow,
    });
    const escalation = tierEscalationForContinuation(db, runId);
    const escalationRefused = escalation
      ? refuseTierEscalationClaim(db, escalation, reason)
      : false;
    if (active) {
      active.abort(reason);
    }
    return {
      ...result,
      proposalClose,
      escalation,
      escalationRefused,
      hadActiveExecution: Boolean(active),
    };
  });
  const {
    escalation,
    escalationRefused,
    hadActiveExecution: active,
    ...cancelledRun
  } = outcome;

  // An executing continuation owns its ticket/workspace cleanup and responds
  // to the abort above. An APPROVED/QUEUED continuation has no executor to do
  // that work, so cancellation must consume the durable ownership transfer.
  // Keep tracker/filesystem effects outside the SQLite write transaction.
  if (!escalation || active) return cancelledRun;

  let claimReleased = false;
  let claimReleaseError = null;
  try {
    claimReleased =
      unclaimTierEscalation({
        repo: escalation.repo,
        ticket: escalation.ticket,
        why: reason,
        log: null,
      }) === true;
  } catch (err) {
    claimReleaseError = err?.message ?? String(err);
  }

  let workspaceCleaned = false;
  let workspaceCleanupError = null;
  try {
    workspaceCleaned =
      cleanupTierEscalationWorkspace({
        sourceWorkspacePath: escalation.sourceWorkspacePath,
        workspacePath: escalation.workspacePath,
        repo: escalation.repo,
        ticket: escalation.ticket,
      }) === true;
  } catch (err) {
    workspaceCleanupError = err?.message ?? String(err);
  }

  return {
    ...cancelledRun,
    escalationCancellation: {
      projectionRefused: escalationRefused,
      claimReleased,
      workspaceCleaned,
      ...(claimReleaseError ? { claimReleaseError } : {}),
      ...(workspaceCleanupError ? { workspaceCleanupError } : {}),
    },
  };
}

/**
 * Force-fail a stranded or non-terminal run with a journaled transition.
 */
export function forceFailRun(
  db,
  runId,
  {
    actor = "operator",
    reason = "operator_force_fail",
    now = () => Date.now(),
    policyVersion = "unknown",
  } = {},
) {
  const currentNow = resolveNow(now);
  return txImmediate(db, () => {
    const run = db
      .query(`SELECT state, attempts FROM runs WHERE run_id = ?`)
      .get(runId);
    if (!run) throw new Error(`unknown run ${runId}`);
    let result;
    if (run.state === "VERIFYING" || run.state === "RUNNING") {
      result = transition(db, {
        runId,
        to: "FAILED",
        actor,
        reason,
        policyVersion,
        now: currentNow,
      });
      finishAttempt(db, runId, run.attempts, "FAILED", reason, currentNow);
    } else if (run.state === "LEASED") {
      transition(db, {
        runId,
        to: "RUNNING",
        actor,
        reason: "force_fail_start",
        attempt: run.attempts,
        policyVersion,
        now: currentNow,
      });
      result = transition(db, {
        runId,
        to: "FAILED",
        actor,
        reason,
        policyVersion,
        now: currentNow,
      });
      finishAttempt(db, runId, run.attempts, "FAILED", reason, currentNow);
    } else if (
      run.state === "QUEUED" ||
      run.state === "APPROVED" ||
      run.state === "PROPOSED"
    ) {
      result = transition(db, {
        runId,
        to: "CANCELLED",
        actor,
        reason,
        policyVersion,
        now: currentNow,
      });
    } else {
      throw new Error(`cannot force-fail run in terminal state ${run.state}`);
    }
    closeOpenProposalForRun(db, runId, { actor, now: currentNow });
    if (run.state === "RUNNING" || run.state === "VERIFYING") {
      const active = ACTIVE_EXECUTIONS.get(runId);
      if (active) active.abort(reason);
    }
    return result;
  });
}

/**
 * Operator retry (§13): FAILED → QUEUED, or recovery from VERIFYING. Only
 * agent-caused failures spend maxAttempts; environment attempts remain retryable.
 * Retrying past the agent budget requires the explicit force override.
 *
 * REFUSED is immutable in the lifecycle journal. Give the operator the exact
 * fresh watched-dispatch command instead of leaking an IllegalTransition.
 */
export function retryRun(
  db,
  runId,
  { actor, force = false, now = () => Date.now(), policyVersion } = {},
) {
  const currentNow = resolveNow(now);
  const row = db
    .query(`SELECT state, spec_json, attempts FROM runs WHERE run_id = ?`)
    .get(runId);
  if (!row) throw new Error(`unknown run ${runId}`);
  const spec = JSON.parse(row.spec_json);
  if (row.state === "REFUSED") {
    const reasonCode =
      db
        .query(
          `SELECT reason_code FROM attempts WHERE run_id = ? ORDER BY attempt DESC LIMIT 1`,
        )
        .get(runId)?.reason_code ?? "unknown_refusal";
    const payload = JSON.stringify({
      repo: spec.input?.repo,
      ticket: spec.input?.ticket,
    });
    const command = `factory dispatch event factory.dispatch.requested --payload '${payload}' --watch`;
    const sensitive = [
      "ticket_security",
      "ticket_escalated",
      "escalate_paths_intersect",
    ].includes(reasonCode);
    throw new Error(
      `refused_run_not_retryable: ${runId} was refused by ${reasonCode}; ` +
        `${sensitive ? "human review is required before a fresh watched dispatch; " : "submit a fresh watched dispatch with: "}` +
        command,
    );
  }
  if (
    !force &&
    (failureCount(db, runId, "agent_error") >= spec.maxAttempts ||
      failureCount(db, runId, "fatal") > 0)
  ) {
    throw new Error("attempts_exhausted");
  }
  if (row.state === "VERIFYING") {
    return txImmediate(db, () => {
      transition(db, {
        runId,
        to: "FAILED",
        actor,
        reason: "operator_retry_verifying",
        policyVersion,
        now: currentNow,
      });
      finishAttempt(
        db,
        runId,
        row.attempts,
        "FAILED",
        "operator_retry",
        currentNow,
      );
      return transition(db, {
        runId,
        to: "QUEUED",
        actor,
        reason: force ? "operator_retry_forced" : "operator_retry",
        policyVersion,
        now: currentNow,
      });
    });
  }
  return transition(db, {
    runId,
    to: "QUEUED",
    actor,
    reason: force ? "operator_retry_forced" : "operator_retry",
    policyVersion,
    now: currentNow,
  });
}
