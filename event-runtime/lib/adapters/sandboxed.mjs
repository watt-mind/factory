/**
 * The sandbox decision, shared by every adapter (WM-313).
 *
 * WM-185 built the Gondolin microVM harness (lib/sandbox/) and wired exactly
 * one adapter to it: `command`. The two adapters that spawn LLM agents with a
 * shell — `pi` and `claude` — read the same definitions and simply never
 * looked at `def.sandbox`, so a definition asking for isolation got a host
 * process and no error. That inverts the threat model in
 * docs/eval-gondolin-sandbox.md §1.1: closed-argv commands could be isolated,
 * open-ended agents could not.
 *
 * This module is the seam that makes ignoring the block impossible by
 * omission. Every adapter's `execute()` starts by consulting it, and there are
 * exactly two legal outcomes when a definition carries `sandbox`:
 *
 *   1. the adapter runs the agent INSIDE the VM through `runSandboxed()`, or
 *   2. the adapter refuses with `SandboxUnsupportedError` (typed, naming the
 *      adapter and the reason) via `refuseSandbox()`.
 *
 * Silently running on the host is not on that list. `sandboxed.test.mjs`
 * enumerates every module in this directory and proves each one lands on (1)
 * or (2), so a new adapter that forgets to decide fails the suite rather than
 * quietly widening the fleet's host-execution surface.
 *
 * Fallback is deliberate, never accidental: a host that cannot honour the
 * policy surfaces `SandboxUnavailableError` from lib/sandbox/gondolin.mjs and
 * the run fails typed. Placement (`sandbox=gondolin`, lib/workers.mjs
 * `satisfiesPlacement`) is what keeps such a run off that host in the first
 * place; this module never re-routes to host execution.
 *
 * Secrets never pass through here. A policy names host env vars; resolution
 * and placeholder substitution live in lib/sandbox/policy.mjs and runner.mjs.
 * The guest environment this module assembles is built from constants and a
 * short locale allowlist — the caller's `env` (which for a served worker is
 * the whole of `process.env`) is not forwarded, because keeping the worker's
 * credentials out of a model-controlled guest is the point of the exercise.
 */
import { createWriteStream, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { runInSandbox } from "../sandbox/gondolin.mjs";
import { normalizePolicy } from "../sandbox/policy.mjs";
import { MODEL_ADAPTERS } from "../registry.mjs";
import { FACTORY_ROOT } from "../config.mjs";

/**
 * Stable refusal code shared by the planner and worker. A workspace-only
 * declaration is a security boundary, not documentation: model execution is
 * admitted only when this module can prove that the selected adapter enters a
 * disposable guest rather than spawning on the worker host.
 */
export const FILESYSTEM_CONFINEMENT_REASON =
  "filesystem_confinement_unavailable";

/** Model-process adapters: registry model routes plus Hermes' fixed LLM harness. */
export const MODEL_BACKED_ADAPTERS = Object.freeze(
  [...new Set([...MODEL_ADAPTERS, "hermes"])].sort(),
);
const MODEL_BACKED_ADAPTER_SET = new Set(MODEL_BACKED_ADAPTERS);

const RAW_CREDENTIAL_PATH =
  /(?:^|\/)\.(?:aws|azure|claude|config\/gcloud|config\/gh|cursor|gnupg|kube|ssh)(?:\/|$)|(?:^|\/)(?:credentials|hosts\.yml|secrets\.env)(?:\/|$)|(?:^|\/)\.worktrees(?:\/|$)/;

/** The only runtime-owned subtree that a sandboxed adapter may mount from HOME. */
export const HOME_MOUNT_ALLOWLIST = Object.freeze([
  ".factory/event-runtime/workspaces",
]);

function pathContains(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/** A runtime mount must not expose a broad host root, credentials, or operator-home data. */
function unsafeHostMountReason(hostPath) {
  const resolved = path.resolve(hostPath);
  const home = homedir();
  if (pathContains(resolved, home)) return "contains the operator home";
  if (resolved === "/root" || /^\/(?:home|Users)\/[^/]+$/.test(resolved))
    return "names a broad host user home";
  if (pathContains(resolved, FACTORY_ROOT))
    return "contains the Factory runtime checkout";
  if (resolved === "/tmp") return "contains the shared host temporary root";
  if (["/dev", "/etc", "/proc", "/run", "/sys", "/var"].includes(resolved))
    return "names a broad host system root";
  if (RAW_CREDENTIAL_PATH.test(resolved))
    return "names a raw credential store or sibling worktree";
  if (
    pathContains(home, resolved) &&
    !HOME_MOUNT_ALLOWLIST.some((prefix) =>
      pathContains(path.join(home, prefix), resolved),
    )
  ) {
    return "lies inside the operator home";
  }
  return null;
}

/**
 * Where an agent-CLI adapter expects its binary inside the guest, per the
 * image contract in docs/eval-gondolin-guest-image.md §2.3. Array-form exec
 * inside the VM does not search $PATH, so these are absolute by construction.
 * A definition may override per adapter through `sandbox.guestBinaries`
 * (e.g. to point at a read-only `sandbox.mounts` entry carrying the toolchain
 * — the virtio-fs route the RFC prefers over rebuilding per run).
 */
export const GUEST_BINARIES = Object.freeze({
  pi: "/usr/local/bin/pi",
  claude: "/usr/local/bin/claude",
});

/** The guest's default PATH lacks /usr/local/bin, which is where the image contract puts the CLIs. */
export const GUEST_PATH = "/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
export const GUEST_HOME = "/root";
export const GUEST_SHELL = "/bin/sh";
export const GUEST_XDG_ROOT = "/tmp/factory-xdg";

/**
 * Guest console capture: boot timing, guest stderr, exit/timeout/failure, in
 * one file next to result.json so a sandboxed failure is as diagnosable as a
 * host one. Retained with the workspace on failure, and its tail also rides a
 * `lifecycle` trace event so `inspect` shows it without the workspace.
 */
export const SANDBOX_CONSOLE_FILE = ".sandbox-console.log";
const CONSOLE_TRACE_CHARS = 4000;

/** Locale-only variables copied from the worker into the guest; nothing else crosses. */
const GUEST_LOCALE_ENV = ["LANG", "LC_ALL", "LC_CTYPE"];

export class SandboxUnsupportedError extends Error {
  constructor(adapter, reason) {
    super(
      `adapter "${adapter}" cannot honour a sandbox policy — the definition asks for one, so the run is refused rather than executed on the host. ${reason}`,
    );
    this.name = "SandboxUnsupportedError";
    this.code = "sandbox_unsupported";
    this.adapter = adapter;
  }
}

/** Does this definition ask to be sandboxed? Anything but absent/null counts, so a malformed block is refused later, not ignored. */
export function sandboxRequested(def) {
  return def?.sandbox !== undefined && def?.sandbox !== null;
}

/**
 * Return a typed admission refusal when a non-mutating model run promises a
 * workspace-only filesystem but the selected adapter cannot enforce it.
 *
 * Today pi is the only admitted model adapter: it owns the Gondolin execution
 * path. agy, Cursor, Claude and Hermes deliberately fail closed until they
 * have an equivalent guest route. Extra host mounts are accepted only when
 * explicitly declared read-only; the workspace itself remains the one
 * writable mount.
 * `normalizePolicy()` also proves that secrets are named host variables scoped
 * to allowed hosts rather than raw values copied into the guest.
 *
 * Non-model adapters and mutating definitions are outside this ticket's
 * boundary and retain their existing admission semantics.
 *
 * @param {{ sandboxSupport?: string|null }} [runtime] - worker-side attestation
 *   from the actual selected adapter module; omitted by the deterministic
 *   planner, which admits the built-in pi route by name.
 * @returns {{ code: string, detail: string } | null}
 */
export function filesystemConfinementRefusal(adapter, def, runtime = {}) {
  if (
    def?.mutating !== false ||
    def?.capabilities?.filesystem !== "workspace-only" ||
    !MODEL_BACKED_ADAPTER_SET.has(adapter)
  ) {
    return null;
  }

  const refuse = (detail) => ({
    code: FILESYSTEM_CONFINEMENT_REASON,
    detail: `${def?.ref ?? "definition"}: ${detail}`,
  });

  if (adapter !== "pi") {
    return refuse(
      `adapter "${adapter}" has no enforced workspace-only guest path; refusing before model spawn`,
    );
  }
  if (
    Object.hasOwn(runtime, "sandboxSupport") &&
    runtime.sandboxSupport !== "gondolin"
  ) {
    return refuse(
      `selected adapter "pi" reports SANDBOX_SUPPORT=${JSON.stringify(runtime.sandboxSupport)} instead of "gondolin"`,
    );
  }
  if (!sandboxRequested(def)) {
    return refuse(
      'adapter "pi" requires an explicit sandbox policy for capabilities.filesystem="workspace-only"',
    );
  }

  let policy;
  try {
    policy = normalizePolicy(def.sandbox);
  } catch (err) {
    return refuse(`sandbox policy is not enforceable: ${err.message}`);
  }
  const writableAsset = policy.mounts.find((mount) => !mount.readonly);
  if (writableAsset) {
    return refuse(
      `sandbox runtime mount ${JSON.stringify(writableAsset.guestPath)} must be read-only; only the declared workspace may be writable`,
    );
  }
  for (const mount of policy.mounts) {
    let unsafe = unsafeHostMountReason(mount.hostPath);
    if (unsafe) {
      return refuse(
        `sandbox runtime mount ${JSON.stringify(mount.hostPath)} ${unsafe}; credentials must use the declared secret broker`,
      );
    }
    let realHostPath;
    try {
      realHostPath = realpathSync(mount.hostPath);
    } catch (err) {
      return refuse(
        `sandbox runtime mount ${JSON.stringify(mount.hostPath)} cannot be resolved before admission: ${err.message}`,
      );
    }
    unsafe = unsafeHostMountReason(realHostPath);
    if (unsafe) {
      return refuse(
        `sandbox runtime mount ${JSON.stringify(mount.hostPath)} resolves to ${JSON.stringify(realHostPath)}, which ${unsafe}; credentials must use the declared secret broker`,
      );
    }
  }
  return null;
}

/**
 * The fail-closed half of the decision. An adapter that cannot execute inside
 * the VM calls this first thing in `execute()`; it is a no-op for ordinary
 * definitions and a typed refusal for sandboxed ones.
 */
export function refuseSandbox(adapter, def, reason) {
  if (!sandboxRequested(def)) return;
  throw new SandboxUnsupportedError(adapter, reason);
}

/** Absolute guest path of an adapter's CLI, honouring a per-definition override. */
export function guestBinary(def, adapter) {
  const override = def?.sandbox?.guestBinaries?.[adapter];
  const resolved = override ?? GUEST_BINARIES[adapter];
  if (typeof resolved !== "string" || !resolved.startsWith("/")) {
    throw new Error(
      `definition ${def?.ref ?? "?"} is sandboxed, so sandbox.guestBinaries.${adapter} must be an absolute guest path (got ${JSON.stringify(override ?? null)})`,
    );
  }
  return resolved;
}

/**
 * The environment an agent CLI sees inside the guest. Built, not inherited:
 * the worker's env carries the credentials the sandbox exists to withhold, and
 * host paths (HOME, PATH, TMPDIR) mean nothing in an Alpine guest anyway.
 * Placeholders for declared secrets are added AFTER this by runner.mjs, so a
 * value here can never shadow one.
 *
 * @param {Record<string,string>} extra - adapter-specific, non-secret additions
 * @param {Record<string,string|undefined>} [hostEnv]
 */
export function guestEnvironment(extra = {}, hostEnv = process.env) {
  const env = {
    HOME: GUEST_HOME,
    PATH: GUEST_PATH,
    TERM: "dumb",
    XDG_CONFIG_HOME: `${GUEST_XDG_ROOT}/config`,
    XDG_CACHE_HOME: `${GUEST_XDG_ROOT}/cache`,
    XDG_DATA_HOME: `${GUEST_XDG_ROOT}/data`,
    XDG_RUNTIME_DIR: `${GUEST_XDG_ROOT}/run`,
  };
  for (const key of GUEST_LOCALE_ENV) {
    if (typeof hostEnv[key] === "string" && hostEnv[key] !== "")
      env[key] = hostEnv[key];
  }
  // Adapter additions cannot replace confinement-critical paths. Secret
  // placeholders are injected later by the broker and do not travel through
  // this escape hatch.
  return { ...extra, ...env };
}

/**
 * Wrap an argv so the guest process reads its stdin from a workspace file.
 * `runInSandbox()` has no stdin channel (its request carries secrets and is
 * one-shot), and pi's prompt has always travelled on stdin — so the prompt is
 * written into the workspace on the host and redirected inside the guest.
 * The redirect target is relative to the guest cwd, which `runInSandbox`
 * pins to the policy's workspace mount, so no host path is ever spliced in.
 * The script string is a constant; the binary and its arguments arrive as
 * positional parameters (`$0`, `$@`) and are never re-parsed by the shell.
 */
export function withStdinFile(argv, stdinFile) {
  if (typeof stdinFile !== "string" || !/^[A-Za-z0-9._-]+$/.test(stdinFile)) {
    throw new Error(
      `sandbox stdin file must be a bare workspace filename, got ${JSON.stringify(stdinFile)}`,
    );
  }
  return [GUEST_SHELL, "-c", `exec "$0" "$@" < ./${stdinFile}`, ...argv];
}

function assertGuestArgv(def, argv) {
  if (
    !Array.isArray(argv) ||
    argv.length === 0 ||
    typeof argv[0] !== "string" ||
    !argv[0].startsWith("/")
  ) {
    // Array-form exec does not search $PATH inside the guest, and a host path
    // like /opt/homebrew/bin/bun does not exist there. Failing here with the
    // real reason beats a bare "no such file" from inside a VM.
    throw new Error(
      `definition ${def?.ref ?? "?"} is sandboxed, so its command must start with an absolute guest path (got ${JSON.stringify(argv?.[0] ?? null)})`,
    );
  }
}

/**
 * Run one adapter's process inside the microVM, preserving the host-path
 * contract the worker relies on:
 *
 *   - `{ exitCode, timedOut }` with the same meaning as a host child: a guest
 *     timeout is `{ exitCode: null, timedOut: true }`, a cooperative cancel
 *     (`abortSignal`) resolves `{ exitCode: null, timedOut: false }` exactly as
 *     a SIGTERMed host child does — the worker checks the abort signal itself.
 *   - anything the guest wrote under the workspace mount is on the host by the
 *     time this resolves, because VFS writes are performed synchronously by
 *     the runner and the runner has exited.
 *   - the guest console lands in `SANDBOX_CONSOLE_FILE` and a `lifecycle`
 *     trace event on every path (success, failure, timeout, cancel, refusal).
 *
 * `runSandbox` is injectable so adapter tests stub the VM boundary; the
 * default is the real `runInSandbox`.
 *
 * @returns {Promise<{ exitCode: number|null, timedOut: boolean, bootMs: number|null }>}
 */
export async function runSandboxed({
  adapter,
  def,
  workspaceDir,
  argv,
  stdinFile,
  env = {},
  timeoutMs,
  abortSignal,
  onStdout,
  onStderr,
  onTrace,
  runSandbox = runInSandbox,
}) {
  assertGuestArgv(def, argv);
  const command = stdinFile ? withStdinFile(argv, stdinFile) : argv;

  const consolePath = path.join(workspaceDir, SANDBOX_CONSOLE_FILE);
  const consoleStream = createWriteStream(consolePath);
  consoleStream.on("error", () => {});
  let consoleTail = "";
  const note = (line) => {
    const text = `${line}\n`;
    consoleStream.write(text);
    consoleTail = (consoleTail + text).slice(-CONSOLE_TRACE_CHARS);
  };
  const started = Date.now();
  note(
    `[sandbox] adapter=${adapter} definition=${def?.ref ?? "?"} provider=${def?.sandbox?.provider ?? "?"} argv=${JSON.stringify(command)}`,
  );

  let outcome;
  let failure = null;
  try {
    outcome = await runSandbox({
      policy: def.sandbox,
      command,
      workspaceDir,
      timeoutMs,
      abortSignal,
      env,
      onStdout,
      onStderr: (chunk) => {
        const text = String(chunk);
        consoleStream.write(text);
        consoleTail = (consoleTail + text).slice(-CONSOLE_TRACE_CHARS);
        onStderr?.(text);
      },
    });
  } catch (err) {
    failure = err;
  }

  if (
    failure &&
    abortSignal?.aborted &&
    failure.code === "sandbox_runner_crashed"
  ) {
    // The runner was torn down mid-run because WE asked for it. A host child
    // in the same position closes with a null exit code; report the same so
    // the worker's cancel path cannot tell the two apart.
    failure = null;
    outcome = { exitCode: null, timedOut: false, bootMs: null };
  }

  const elapsed = Date.now() - started;
  if (failure) {
    note(
      `[sandbox] failed after ${elapsed}ms: ${failure.code ?? failure.name}: ${failure.message}`,
    );
  } else {
    note(
      `[sandbox] boot=${outcome.bootMs ?? "?"}ms exit=${outcome.exitCode ?? "null"} timedOut=${outcome.timedOut} elapsed=${elapsed}ms${abortSignal?.aborted ? " cancelled=true" : ""}`,
    );
  }
  // Settle on close OR error: a stream that already errored (ENOSPC, EACCES)
  // is not guaranteed to run the end() callback, and an adapter promise that
  // never settles is a wedged run until the lease reaper (cold review #543).
  await new Promise((done) => {
    if (consoleStream.destroyed || consoleStream.closed) return done();
    consoleStream.once("close", done);
    consoleStream.once("error", done);
    consoleStream.end();
  });

  try {
    onTrace?.("lifecycle", {
      note: "sandbox_console",
      adapter,
      bootMs: outcome?.bootMs ?? null,
      exitCode: outcome?.exitCode ?? null,
      timedOut: outcome?.timedOut ?? false,
      ...(failure
        ? { error: `${failure.code ?? failure.name}: ${failure.message}` }
        : {}),
      text: consoleTail,
    });
  } catch {
    // trace is observability, never control flow
  }

  if (failure) throw failure;
  return {
    exitCode: outcome.exitCode ?? null,
    timedOut: outcome.timedOut === true,
    bootMs: outcome.bootMs ?? null,
  };
}
