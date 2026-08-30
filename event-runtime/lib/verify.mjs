/**
 * Independent result verification (docs/event-runtime.md §9).
 *
 * The agent cannot certify its own result: this is ordinary code, outside the
 * model process, that reads the workspace's result.json and either produces
 * an accepted §5.3 run-result plus a compact receipt, or throws a typed
 * ContractViolation. Everything fails closed — a missing file, unparseable
 * JSON, an unknown refusal reason, a schema violation, an escaping artifact
 * path, or a declared artifact that does not exist are all violations, never
 * partial acceptances. These checks verify form, not truth (§9): semantic
 * evidence checking is slice 2.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { globToRegExp } from "../../orchestrator/owned-paths.mjs";
import { canonicalJson, hashBytes, hashJson, sha256Hex } from "./canonical.mjs";
import { resolveConfigPath } from "./config.mjs";
import { validateDecisionRequest } from "./decision.mjs";
import { processResultMemos } from "./memos.mjs";
import { validatePresentation } from "./presentation.mjs";
import { reposRoot } from "./repos.mjs";
import { validate } from "./schema.mjs";
import { confinedRegularFile, PathViolation } from "./workspace.mjs";

/**
 * Declared evidence is retained inline in the accepted result (OPS-206): a
 * stored hash whose bytes were destroyed with the workspace could never be
 * rechecked, and slice 2's verifier recomputes derived values from evidence.
 * The limit is a §14 size bound — larger evidence fails closed until a real
 * case earns the content-addressed artifact store.
 */
export const EVIDENCE_INLINE_LIMIT_BYTES = 256 * 1024;

/**
 * Hang guard for the repository-owned verification command (WM-262), not a
 * performance budget — it exists to tell "wedged forever" from "running".
 *
 * 120s was below the real cost and failed every dispatch (WM-510): this repo's
 * own verify at the time (`bun test && bun build/emit.mjs --check`, the full
 * suite) measured 196-217s, so nothing could ever pass. Sized at ~3x the
 * slowest observed run, which leaves room for a loaded host while staying far
 * under `limits.max_run_minutes: 90` in config/policy.yaml — the bound that
 * actually caps a wedged run. (The factory verify has since been narrowed to
 * `bun test event-runtime/lib && bun build/emit.mjs --check`, ~70s, WM-528 —
 * the ceiling stays where it is for the other repos.)
 *
 * Raise this rather than trimming it to fit: a ceiling that only just fits is
 * the same outage with a longer fuse. Per-repo tuning goes through
 * FACTORY_REPO_VERIFY_TIMEOUT_MS.
 */
export const DEFAULT_REPO_VERIFY_TIMEOUT_MS = 600_000;

function repoVerifyTimeoutMs() {
  const configured = Number(process.env.FACTORY_REPO_VERIFY_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_REPO_VERIFY_TIMEOUT_MS;
}

export const REFUSAL_REASONS = [
  "missing_input",
  "permission_denied",
  "needs_human",
  "unsupported_capability",
];

export class ContractViolation extends Error {
  constructor(
    violations,
    { reasonCode = "contract_violation", handoff = null } = {},
  ) {
    super(`contract violation: ${violations.join("; ")}`);
    this.name = "ContractViolation";
    this.violations = violations;
    this.reasonCode = reasonCode;
    // WM-718: when the handoff gate refuses, the worker-observed verification
    // (commands, exit codes, output tails, diff, deviations) rides along so
    // the worker can post it on the ticket and hold the PR.
    if (handoff) this.handoff = handoff;
  }
}

/**
 * Handoff verification (WM-718). The dispatch agent's `## Handoff` used to
 * claim "Verification: pass" for commands it had not run on the final tree
 * (3 of 10 PRs on 2026-08-18 failed CI on exactly the check the ticket named).
 * The repo `verify:` gate below is deliberately a subset of CI (WM-528), so
 * it let those through. This is the same check made honest: the WORKER runs
 * the ticket's own Verification Command, the web build when the diff reaches
 * `event-runtime/web/src/**`, and compares the diff with the ticket's Owned
 * Paths — and authors the Verification line itself.
 */
export const HANDOFF_REASON_CODES = new Set([
  "handoff_verification_failed",
  "handoff_verification_unspecified",
  "handoff_owned_paths_violation",
  "handoff_pr_form_invalid",
]);
export const HANDOFF_TAIL_LINES = 40;
export const HANDOFF_WEB_SRC_PREFIX = "event-runtime/web/src/";
export const HANDOFF_WEB_BUILD_DIR = "event-runtime/web";
export const HANDOFF_WEB_BUILD_COMMAND = "bun run build";
export const DEFAULT_OWNED_PATHS_CONFORMANCE = "advisory";
export const HANDOFF_COMMENT_HEADING =
  "## Handoff verification (worker-observed)";

// Ticket text is executable at this boundary. Do not inherit the worker's
// environment: it contains tracker, forge, provider and extension authority
// that no repository check needs. The outer namespace setup gets an even
// smaller environment than the command inside the chroot.
export const HANDOFF_HOST_ENV = Object.freeze({
  PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
  LANG: "C.UTF-8",
});
export const HANDOFF_GUEST_PATH =
  "/opt/factory-bin:/usr/local/bin:/usr/bin:/bin";
/** Where the verified worktree is mounted inside the chroot. */
export const HANDOFF_GUEST_WORKSPACE = "/workspace";
export const DEFAULT_HANDOFF_SANDBOX_TMPFS_MB = 1024;
export const HANDOFF_SANDBOX_NAMESPACES = Object.freeze([
  "user",
  "mount",
  "pid",
  "network",
]);
/**
 * Set in the guest environment so a handoff gate running INSIDE the sandbox
 * knows not to try to build another one. `clone(CLONE_NEWUSER)` is EPERM for
 * a chrooted process, so the boundary cannot nest — and this repo's own
 * `verify:` command runs the tests that exercise this very function, which
 * would otherwise all refuse `sandbox_unavailable` when the factory verifies
 * a change to itself. Ticket code forging the marker gains nothing: it is
 * already inside the boundary, and the pass-through keeps the same minimal
 * environment, cwd confinement and timeout.
 */
export const HANDOFF_SANDBOX_MARKER = "FACTORY_HANDOFF_SANDBOX";

/**
 * Upper bound for the guest tmpfs. A tmpfs is only a promise to the guest, but
 * a runaway suite can fill it all from host RAM/swap, so policy cannot hand
 * out more than this.
 */
export const MAX_HANDOFF_SANDBOX_TMPFS_MB = 8192;

/** Clamp a candidate tmpfs size into [default, max]; anything else -> default. */
export function clampHandoffSandboxTmpfsMb(value) {
  if (!Number.isSafeInteger(value) || value < DEFAULT_HANDOFF_SANDBOX_TMPFS_MB)
    return DEFAULT_HANDOFF_SANDBOX_TMPFS_MB;
  return Math.min(value, MAX_HANDOFF_SANDBOX_TMPFS_MB);
}

/** Missing or invalid local policy must not restore the old 256 MiB mount. */
export function policyHandoffSandboxTmpfsMb(root = reposRoot()) {
  try {
    return clampHandoffSandboxTmpfsMb(
      Bun.YAML.parse(
        readFileSync(resolveConfigPath("policy", { root }), "utf8"),
      )?.sandbox?.tmpfs_mb,
    );
  } catch {
    return DEFAULT_HANDOFF_SANDBOX_TMPFS_MB;
  }
}

function handoffSandboxLimits(tmpfsMb) {
  return `tmpfs=${tmpfsMb}MiB; namespaces=${HANDOFF_SANDBOX_NAMESPACES.join(",")}`;
}

/**
 * PID 1 must reap orphaned test processes. This Python init runs before the
 * chroot, supervises the setup shell, and terminates/reaps leftovers once the
 * command returns so a ticket check cannot leave a guest daemon behind.
 */
export const HANDOFF_SANDBOX_INIT = String.raw`
import os
import signal
import sys
import time

child = os.fork()
if child == 0:
    os.execv(sys.argv[1], sys.argv[1:])

def forward(signum, _frame):
    try:
        os.kill(child, signum)
    except ProcessLookupError:
        pass

signal.signal(signal.SIGTERM, forward)
signal.signal(signal.SIGINT, forward)
child_status = 1
while True:
    try:
        pid, status = os.wait()
    except InterruptedError:
        continue
    if pid == child:
        child_status = status
        break

def reap_all(grace_seconds):
    # Returns True once no children remain; False if the grace ran out.
    deadline = time.monotonic() + grace_seconds
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return True
        except InterruptedError:
            continue
        if pid == 0:
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.05)

try:
    os.kill(-1, signal.SIGTERM)
except ProcessLookupError:
    pass
if not reap_all(2.0):
    # A leftover that ignores SIGTERM (or is stuck in a handler) would keep
    # the sandbox alive past the command; escalate so the worker's reap never
    # hangs on it.
    try:
        os.kill(-1, signal.SIGKILL)
    except ProcessLookupError:
        pass
    while True:
        try:
            os.wait()
        except ChildProcessError:
            break
        except InterruptedError:
            continue

if os.WIFEXITED(child_status):
    sys.exit(os.WEXITSTATUS(child_status))
if os.WIFSIGNALED(child_status):
    sys.exit(128 + os.WTERMSIG(child_status))
sys.exit(1)
`;

/** True when this process is itself running inside a handoff sandbox. */
export function insideHandoffSandbox(env = process.env) {
  return env[HANDOFF_SANDBOX_MARKER] === "1";
}
export const HANDOFF_RUNTIME_COMMANDS = Object.freeze(["bun", "uv", "pnpm"]);

/** Non-system package runners mounted as individual, read-only executables. */
export function handoffRuntimeBinaries(which = (name) => Bun.which(name)) {
  return HANDOFF_RUNTIME_COMMANDS.flatMap((name) => {
    const executable = which(name);
    return executable ? [{ name, executable: realpathSync(executable) }] : [];
  });
}

/**
 * Constant setup program for the handoff shell's Linux isolation boundary.
 *
 * - a user namespace grants mount/chroot authority without host root;
 * - a network namespace has no host interfaces; loopback is brought up
 *   because suites routinely bind 127.0.0.1, and a namespaced loopback
 *   reaches nothing outside the sandbox;
 * - a private mount namespace exposes only read-only /usr, selected package
 *   runners, the intended worktree, the git directories that worktree's
 *   `.git` file points at, ephemeral /tmp, proc and basic devices;
 * - chroot makes host absolute paths and worktree symlink escapes unreachable.
 *
 * Argument protocol: root, workspace, guest_cwd, git_mount_count, tmpfs_mb,
 * then
 * `git_mount_count` × (host_path, ro|rw), then (name, executable) pairs for
 * the package runners, then the command as the last argument.
 *
 * Guest environment (GH-967): HOME/TMPDIR/PATH/LANG plus one pin.
 * `reposRoot()` is `FACTORY_REPOS_ROOT || FACTORY_ROOT`, and FACTORY_ROOT is
 * derived from the module's own location — so the previous
 * `FACTORY_ROOT=/workspace` set the variable nothing reads while leaving
 * `FACTORY_REPOS_ROOT` unset, silently undoing #1214's pin. The host factory
 * root is deliberately NOT bound into the chroot (it holds config/repos.yaml,
 * mirrors and other repos' worktrees — none of which a ticket's check needs),
 * so the only coherent repos root inside the guest is the worktree itself:
 * `FACTORY_REPOS_ROOT=/workspace`, which is exactly #1214's "pin the repos
 * root at the worktree, never at the worker's factory root" expressed in
 * guest coordinates. It is derived from the workspace root, not the command's
 * cwd, so the web-build call site (cwd `event-runtime/web`) is pinned right
 * too (#1224). #1214 covers the same seam on the unsandboxed path.
 */
export const HANDOFF_SANDBOX_SETUP = String.raw`
root=$1
workspace=$2
guest_cwd=$3
git_mounts=$4
tmpfs_mb=$5
shift 5
mount --make-rprivate /
mount -t tmpfs -o mode=0755,size=64m tmpfs "$root"
mkdir -p "$root/usr" "$root/workspace" "$root/tmp" "$root/dev" \
  "$root/proc" "$root/etc" "$root/home" "$root/opt/factory-bin"
for link in bin lib lib64 sbin; do
  target=$(readlink "/$link")
  ln -s "$target" "$root/$link"
done
mount --rbind /usr "$root/usr"
mount --make-rslave "$root/usr"
mount -o remount,bind,ro "$root/usr"
if [ -d /etc/alternatives ]; then
  mkdir -p "$root/etc/alternatives"
  mount --rbind /etc/alternatives "$root/etc/alternatives"
  mount --make-rslave "$root/etc/alternatives"
  mount -o remount,bind,ro "$root/etc/alternatives"
fi
mount --rbind "$workspace" "$root/workspace"
mount --make-rslave "$root/workspace"
mount -t tmpfs -o mode=1777,size="${"$"}{tmpfs_mb}m" tmpfs "$root/tmp"
mount -t proc proc "$root/proc"
for dev in null zero random urandom; do
  touch "$root/dev/$dev"
  mount --bind "/dev/$dev" "$root/dev/$dev"
done
ln -s /proc/self/fd "$root/dev/fd"
ln -s /proc/self/fd/0 "$root/dev/stdin"
ln -s /proc/self/fd/1 "$root/dev/stdout"
ln -s /proc/self/fd/2 "$root/dev/stderr"
if command -v ip >/dev/null 2>&1; then
  ip link set lo up || echo "handoff-sandbox: loopback stayed down" >&2
elif command -v ifconfig >/dev/null 2>&1; then
  ifconfig lo up || echo "handoff-sandbox: loopback stayed down" >&2
else
  echo "handoff-sandbox: no ip/ifconfig; loopback stays down" >&2
fi
while [ "$git_mounts" -gt 0 ]; do
  git_path=$1
  git_mode=$2
  shift 2
  git_mounts=$((git_mounts - 1))
  mkdir -p "$root$git_path"
  mount --rbind "$git_path" "$root$git_path"
  mount --make-rslave "$root$git_path"
  if [ "$git_mode" = ro ]; then
    mount -o remount,bind,ro "$root$git_path"
  fi
done
while [ "$#" -gt 1 ]; do
  name=$1
  executable=$2
  shift 2
  touch "$root/opt/factory-bin/$name"
  mount --bind "$executable" "$root/opt/factory-bin/$name"
  mount -o remount,bind,ro "$root/opt/factory-bin/$name"
done
command=$1
mkdir -p "$root/tmp/home"
/usr/sbin/chroot "$root" /bin/bash -ceu '
  cd "$1"
  shift
  exec /usr/bin/env -i \
    HOME=/tmp/home TMPDIR=/tmp PATH=${HANDOFF_GUEST_PATH} LANG=C.UTF-8 \
    FACTORY_REPOS_ROOT=${HANDOFF_GUEST_WORKSPACE} ${HANDOFF_SANDBOX_MARKER}=1 \
    /bin/bash -c "$1"
' bash "$guest_cwd" "$command"
`;

/**
 * A linked git worktree's `.git` is a file holding an absolute host gitdir
 * (`<repo>/.git/worktrees/<name>`), and that gitdir's `commondir` points at
 * the parent repository's `.git` where the objects live. Neither is under the
 * workspace, so inside the chroot `git` would fail with "not a git
 * repository". Both are bound back at their own absolute paths: the
 * worktree's own gitdir writable (it is this workspace's state — git refreshes
 * its index on `git status`), the shared repository `.git` read-only, so ticket
 * code can read history but cannot rewrite the host repository.
 *
 * A plain checkout (`.git` is a directory) needs nothing: it already lives
 * inside the bound workspace.
 */
export function handoffGitMounts(workspaceRoot, read = readFileSync) {
  const dotGit = path.join(workspaceRoot, ".git");
  let pointer;
  try {
    pointer = read(dotGit, "utf8");
  } catch {
    return [];
  }
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(String(pointer));
  if (!match) return [];
  const gitDir = path.resolve(workspaceRoot, match[1]);
  const mounts = [{ path: gitDir, mode: "rw" }];
  let commonDir = null;
  try {
    commonDir = path.resolve(
      gitDir,
      String(read(path.join(gitDir, "commondir"), "utf8")).trim(),
    );
  } catch {
    /* no commondir: a gitdir file that is not a linked worktree */
  }
  if (commonDir && !commonDir.startsWith(`${gitDir}${path.sep}`)) {
    mounts.push({ path: commonDir, mode: "ro" });
  }
  return mounts;
}

/** Reason code for a host that cannot build the handoff sandbox at all. */
export const HANDOFF_SANDBOX_UNAVAILABLE = "sandbox_unavailable";

let sandboxProbeCache = null;

/** Interpreter for the sandbox setup program and PID 1 init. */
export const HANDOFF_SANDBOX_PYTHON = "/usr/bin/python3";

/**
 * Can this host build the isolation boundary at all? Unprivileged user
 * namespaces are a kernel/distro toggle (`kernel.unprivileged_userns_clone`,
 * AppArmor `userns` restrictions, some container runtimes), and `unshare`
 * itself may be absent. When the probe says no, the handoff gate refuses with
 * `sandbox_unavailable` — an environment fault, distinct from the ticket's
 * check actually failing — instead of reporting the ticket's command red.
 * There is deliberately NO unsandboxed fallback: running ticket-authored
 * commands with the worker's credentials is exactly what GH-967 removes.
 */
export function handoffSandboxAvailable({
  spawn = spawnSync,
  cache = true,
  nested = insideHandoffSandbox(),
  exists = existsSync,
} = {}) {
  if (nested) return true;
  if (cache && sandboxProbeCache !== null) return sandboxProbeCache;
  let available;
  try {
    // The setup program runs under /usr/bin/python3 inside the namespace; a
    // host without it cannot build the boundary either, and must report
    // `sandbox_unavailable` rather than a bogus red for the ticket's command.
    if (!exists(HANDOFF_SANDBOX_PYTHON)) {
      if (cache) sandboxProbeCache = false;
      return false;
    }
    const res = spawn(
      "/usr/bin/unshare",
      [
        "--user",
        "--map-root-user",
        "--net",
        "--mount",
        "--pid",
        "--fork",
        "/bin/true",
      ],
      { env: HANDOFF_HOST_ENV, stdio: "ignore", timeout: 10_000 },
    );
    available = !res.error && res.status === 0;
  } catch {
    available = false;
  }
  if (cache) sandboxProbeCache = available;
  return available;
}

/** Test seam: forget a cached probe result. */
export function resetHandoffSandboxProbe() {
  sandboxProbeCache = null;
}

/** Thrown when the host cannot provide the handoff sandbox (GH-967). */
export class SandboxUnavailable extends Error {
  constructor() {
    super(
      "sandbox_unavailable: this host cannot create an unprivileged user+mount namespace, so the ticket's verification command cannot be run without the worker's credentials",
    );
    this.name = "SandboxUnavailable";
    this.reasonCode = HANDOFF_SANDBOX_UNAVAILABLE;
  }
}

/**
 * #1214 scrubbed `FACTORY_*` out of the inherited handoff environment and
 * pinned `FACTORY_REPOS_ROOT` at the worktree. The sandbox subsumes the scrub
 * — `env -i` in the chroot and the explicit map in the nested pass-through
 * inherit nothing at all, dropping every non-FACTORY credential too — so only
 * the pin needs carrying, and both paths set it (see HANDOFF_SANDBOX_SETUP).
 */

/** `dispatch.owned_paths_conformance` in config/policy.yaml: advisory (default) | strict. */
export function policyOwnedPathsConformance(root = reposRoot()) {
  const file = resolveConfigPath("policy", { root });
  if (!existsSync(file)) return DEFAULT_OWNED_PATHS_CONFORMANCE;
  try {
    const value = Bun.YAML.parse(readFileSync(file, "utf8"))?.dispatch
      ?.owned_paths_conformance;
    return value === "strict" ? "strict" : DEFAULT_OWNED_PATHS_CONFORMANCE;
  } catch {
    return DEFAULT_OWNED_PATHS_CONFORMANCE;
  }
}

/** Last N non-empty lines of a command's output, ANSI stripped. */
export function outputTail(output, lines = HANDOFF_TAIL_LINES) {
  return (
    String(output ?? "")
      // eslint-disable-next-line no-control-regex -- \x1b is the ANSI escape byte being stripped, not a typo
      .replace(/\x1b\[[0-9;]*m/g, "")
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0)
      .slice(-lines)
      .join("\n")
  );
}

/**
 * Run one handoff command as ordinary code in the worktree, capturing the
 * whole output to `logPath` and returning an observation the worker can quote.
 * `cwd` is where the command runs (may be a subdirectory such as the web
 * package); `worktreePath` is always the worktree root and is what
 * FACTORY_REPOS_ROOT is pinned to.
 */
export function runHandoffCommand({
  command,
  cwd,
  worktreePath = cwd,
  logPath,
  timeoutMs,
  spawn = spawnSync,
  runtimeBinaries = handoffRuntimeBinaries(),
  nested = insideHandoffSandbox(),
  sandboxAvailable = () => handoffSandboxAvailable({ nested }),
  tmpfsMb = policyHandoffSandboxTmpfsMb(),
}) {
  if (!sandboxAvailable()) throw new SandboxUnavailable();
  const root = realpathSync(worktreePath);
  const commandCwd = realpathSync(cwd);
  const relativeCwd = path.relative(root, commandCwd);
  if (relativeCwd.startsWith("..") || path.isAbsolute(relativeCwd)) {
    throw new PathViolation(root, relativeCwd, "escapes handoff worktree");
  }
  const guestCwd = path.posix.join(
    "/workspace",
    ...relativeCwd.split(path.sep).filter(Boolean),
  );
  const sandboxParent = existsSync(path.dirname(logPath))
    ? path.dirname(logPath)
    : tmpdir();
  const sandboxRoot = mkdtempSync(
    path.join(sandboxParent, ".handoff-sandbox-"),
  );
  const gitMounts = handoffGitMounts(root);
  const sandboxTmpfsMb = clampHandoffSandboxTmpfsMb(tmpfsMb);
  const fd = openSync(logPath, "w");
  let res;
  const startedAt = Date.now();
  try {
    const runtimeArgs = runtimeBinaries.flatMap(({ name, executable }) => [
      name,
      executable,
    ]);
    res = nested
      ? spawn(
          "/usr/bin/timeout",
          [
            "--signal=TERM",
            "--kill-after=0.1s",
            `${timeoutMs / 1000}s`,
            "/bin/bash",
            "-c",
            command,
          ],
          {
            cwd: commandCwd,
            // Stricter than #1214's FACTORY_* scrub, which the outer
            // boundary already subsumes: nothing is inherited at all, so no
            // forge/tracker/provider credential can reach the command even if
            // the enclosing guest ever gains one. The repos-root pin (#1214)
            // is carried explicitly.
            env: {
              ...HANDOFF_HOST_ENV,
              HOME: process.env.HOME ?? "/tmp/home",
              TMPDIR: process.env.TMPDIR ?? "/tmp",
              PATH: process.env.PATH ?? HANDOFF_HOST_ENV.PATH,
              FACTORY_REPOS_ROOT: root,
              [HANDOFF_SANDBOX_MARKER]: "1",
            },
            stdio: ["ignore", fd, fd],
            timeout: timeoutMs + 5_000,
          },
        )
      : spawn(
          "/usr/bin/timeout",
          [
            "--signal=TERM",
            "--kill-after=0.1s",
            `${timeoutMs / 1000}s`,
            "/usr/bin/unshare",
            "--user",
            "--map-root-user",
            "--net",
            "--mount",
            "--pid",
            "--fork",
            "--kill-child=KILL",
            HANDOFF_SANDBOX_PYTHON,
            "-c",
            HANDOFF_SANDBOX_INIT,
            "/bin/bash",
            "-ceu",
            HANDOFF_SANDBOX_SETUP,
            "bash",
            sandboxRoot,
            root,
            guestCwd,
            String(gitMounts.length),
            String(sandboxTmpfsMb),
            ...gitMounts.flatMap(({ path: gitPath, mode }) => [gitPath, mode]),
            ...runtimeArgs,
            command,
          ],
          {
            cwd: root,
            env: HANDOFF_HOST_ENV,
            stdio: ["ignore", fd, fd],
            // GNU timeout owns the process group and escalates TERM→KILL. This
            // outer ceiling catches timeout itself wedging during teardown.
            timeout: timeoutMs + 5_000,
          },
        );
  } finally {
    closeSync(fd);
    rmSync(sandboxRoot, { recursive: true, force: true });
  }
  const output = readFileSync(logPath, "utf8");
  const elapsedMs = Date.now() - startedAt;
  // Only the timeout's own verdict counts: 124 from GNU timeout, ETIMEDOUT
  // from the outer ceiling, or `timeout` itself dying by SIGKILL past the
  // budget (its --kill-after escalation signals the whole process group,
  // which it belongs to, so the killer takes the killer with it). A wall
  // clock that merely reached the budget, or a 137 the command itself exited
  // with (an OOM kill inside the suite, a test that SIGKILLs a child), is a
  // real failure with real output — reporting those as "timed out" hid the
  // actual red.
  const timedOut =
    res.error?.code === "ETIMEDOUT" ||
    res.status === 124 ||
    (res.status == null && res.signal === "SIGKILL" && elapsedMs >= timeoutMs);
  const exitCode = timedOut ? null : (res.status ?? (res.error ? 1 : 0));
  return {
    command,
    cwd: commandCwd,
    confinement: nested
      ? "inherited handoff sandbox (already namespaced + chrooted); minimal env"
      : `user+mount+pid+network namespace; chroot; ${handoffSandboxLimits(sandboxTmpfsMb)}`,
    sandbox: {
      tmpfsMb: sandboxTmpfsMb,
      namespaces: HANDOFF_SANDBOX_NAMESPACES,
    },
    elapsedMs,
    exitCode,
    timedOut,
    passed: !timedOut && exitCode === 0,
    output,
    tail: outputTail(output),
    logPath,
  };
}

/**
 * `bun test` flags that consume the following word. Their values must never
 * widen the covering set (`--preload ./setup.mjs`, `-t verify`, ...).
 */
const BUN_TEST_VALUE_FLAGS = new Set([
  "--preload",
  "-r",
  "--require",
  "--timeout",
  "-t",
  "--test-name-pattern",
  "--path-ignore-patterns",
  "--max-concurrency",
  "--rerun-each",
  "--reporter",
  "--reporter-outfile",
  "--coverage-dir",
  "--coverage-reporter",
  "--coverage-threshold",
  "--env-file",
  "--cwd",
  "--filter",
  "--tsconfig-override",
  "--define",
  "-d",
  "--loader",
  "-l",
  "--conditions",
  "--port",
  "--inspect",
  "--inspect-wait",
  "--inspect-brk",
  "--concurrent-workers",
  "--randomize-seed",
  "--seed",
  "--main-fields",
  "--jsx-factory",
  "--jsx-fragment",
  "--jsx-import-source",
  "--jsx-runtime",
  "--config",
  "-c",
]);

/** Filename shapes bun's default discovery treats as tests. */
const BUN_TEST_FILE_RE =
  /(?:^|[._-])(?:test|spec)\.(?:[cm]?[jt]sx?)$|(?:^|\/)(?:test|spec)\.[cm]?[jt]sx?$/;

export function isBunTestFile(filePath) {
  return BUN_TEST_FILE_RE.test(path.posix.basename(filePath));
}

function bunTestPaths(command) {
  if (typeof command !== "string") return null;
  const paths = [];
  const segments = command.split(/(?:&&|;)/);
  for (const segment of segments) {
    // Shell expansion or a pipeline makes the set of executed tests unclear.
    if (/[$`'"\\(){}[\]|<>*?]/.test(segment)) return null;
    const words = segment.trim().split(/\s+/);
    if (words[0] !== "bun" || words[1] !== "test") continue;
    let skipValue = false;
    for (const word of words.slice(2)) {
      if (skipValue) {
        // The value of a value-taking flag is never a test path.
        skipValue = false;
        continue;
      }
      if (word.startsWith("-")) {
        skipValue = !word.includes("=") && BUN_TEST_VALUE_FLAGS.has(word);
        continue;
      }
      if (
        /^\d+(?:\.\d+)?$/.test(word) ||
        !(/[/.]/.test(word) || word.endsWith("test"))
      ) {
        continue;
      }
      const normalized = path.posix.normalize(word);
      if (
        normalized === "." ||
        normalized.startsWith("../") ||
        path.isAbsolute(normalized)
      )
        return null;
      paths.push(normalized.replace(/\/$/, ""));
    }
  }
  return paths.length > 0 ? paths : null;
}

/**
 * True only when every explicit ticket test path is contained by an explicit
 * `bun test` path in repo verify. Unparseable commands and default test
 * discovery return false, preserving the independent ticket check.
 *
 * Exact-path matches stand on their own. A ticket path covered only by a
 * repo-verify DIRECTORY additionally has to be a real file under `root` whose
 * name matches bun's test pattern: directory discovery only ever runs
 * `*.test.*` / `*.spec.*` files, so a missing path or a helper module named on
 * the ticket would NOT actually have been exercised by step 1 — step 2 must
 * still run for it.
 */
export function ticketVerifyCoveredByRepoVerify(
  ticketCommand,
  repoVerify,
  { root = null, exists = existsSync } = {},
) {
  const ticketPaths = bunTestPaths(ticketCommand);
  const repoPaths = bunTestPaths(repoVerify);
  if (!ticketPaths || !repoPaths) return false;
  return ticketPaths.every((ticketPath) => {
    if (repoPaths.includes(ticketPath)) return true;
    const underDirectory = repoPaths.some((repoPath) =>
      ticketPath.startsWith(`${repoPath}/`),
    );
    if (!underDirectory) return false;
    if (!isBunTestFile(ticketPath)) return false;
    if (typeof root !== "string" || root === "") return false;
    return exists(path.join(root, ticketPath));
  });
}

/** Best-effort timeout for the pre-diff `git fetch origin <base>` (F4). */
const FETCH_BASE_TIMEOUT_MS = 10_000;

/**
 * Files the PR carries: `merge-base(origin/<base>, HEAD)..HEAD` in the
 * worktree. `null` files means the diff could not be computed (not a git
 * checkout, unknown base) — reported, never silently treated as empty.
 *
 * `origin/<base>` in the worktree can be stale by the time the handoff gate
 * runs — the worktree was materialized once, but develop keeps moving while
 * the agent works. A quiet, best-effort `git fetch origin <base>` right
 * before computing merge-base keeps the deviation diff honest against
 * current develop; a fetch failure (offline, auth, timeout) never blocks the
 * gate — it proceeds against the local ref and says so via `base_ref_stale`.
 *
 * `git` defaults to the real `execFileSync` runner and exists only so tests
 * can inject a stub that records call order and fails the fetch on cue.
 */
export function changedFilesSince({
  worktreePath,
  base,
  git = (args, { timeout = 60_000 } = {}) =>
    execFileSync("git", args, {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
    }).trim(),
}) {
  let baseRefStale = false;
  if (base) {
    try {
      git(["fetch", "--quiet", "origin", base], {
        timeout: FETCH_BASE_TIMEOUT_MS,
      });
    } catch {
      baseRefStale = true;
    }
  }
  const staleField = baseRefStale ? { base_ref_stale: true } : {};
  const candidates = base ? [`origin/${base}`, base] : [];
  for (const ref of candidates) {
    try {
      const mergeBase = git(["merge-base", ref, "HEAD"]);
      const out = git(["diff", "--name-only", `${mergeBase}..HEAD`]);
      const files = out ? out.split("\n").filter(Boolean) : [];
      return { ok: true, baseRef: ref, mergeBase, files, ...staleField };
    } catch (err) {
      const stderr = String(err?.stderr ?? err?.message ?? "")
        .trim()
        .split("\n")
        .pop();
      if (ref === candidates.at(-1))
        return {
          ok: false,
          baseRef: ref,
          files: null,
          error: stderr,
          ...staleField,
        };
    }
  }
  return {
    ok: false,
    baseRef: null,
    files: null,
    error: base ? "base unresolved" : "no base branch on the worktree record",
    ...staleField,
  };
}

/** Files outside every Owned Paths glob (`**` owns everything). */
export function ownedPathsDeviations(files = [], ownedPaths = []) {
  if (!Array.isArray(files)) return [];
  const globs = (ownedPaths ?? []).map((g) => String(g).trim()).filter(Boolean);
  if (globs.length === 0 || globs.includes("**")) return [];
  const matchers = globs.map((g) => globToRegExp(g));
  return files.filter((file) => !matchers.some((re) => re.test(file)));
}

function fenceBlock(text) {
  const body = String(text ?? "").trim() || "(no output)";
  return `\`\`\`\n${body}\n\`\`\``;
}

function commandLine(label, obs) {
  if (!obs) return null;
  const verdict = obs.timedOut
    ? "TIMED OUT"
    : obs.passed
      ? "exit 0 (pass)"
      : `exit ${obs.exitCode} (FAIL)`;
  return `- ${label}: \`${obs.command}\` — ${verdict}`;
}

/**
 * The worker-authored Handoff verification (WM-718). Composed only from what
 * the worker observed; the agent's own claim, when present, is kept below it
 * labelled agent-reported and never becomes the Verification line.
 */
export function composeHandoffVerification(handoff) {
  const lines = [HANDOFF_COMMENT_HEADING];
  const prNumber = handoff.pr?.number ?? handoff.prNumber;
  if (Number.isInteger(prNumber) && prNumber > 0) {
    // Only a boolean says anything about the PR's draft state: the
    // pr_base_unreadable path never sets prDraft, and the same composer writes
    // the failure comment before the worker drafts the PR.
    const draftState =
      typeof handoff.pr?.draft === "boolean"
        ? handoff.pr.draft
          ? "draft"
          : "ready"
        : typeof handoff.prDraft === "boolean"
          ? handoff.prDraft
            ? "draft"
            : "ready"
          : "draft state unknown";
    const fixes =
      typeof handoff.pr?.hasFixesLine === "boolean"
        ? handoff.pr.hasFixesLine
          ? "yes"
          : "no"
        : "unknown";
    const runTrailer =
      typeof handoff.pr?.hasRunTrailer === "boolean"
        ? handoff.pr.hasRunTrailer
          ? "yes"
          : "no"
        : "unknown";
    lines.push(
      `- PR: #${prNumber} (${draftState}) · Fixes: ${fixes} · run trailer: ${runTrailer}`,
    );
  }
  const primary = handoff.verification;
  if (primary) {
    lines.push(commandLine("Verification", primary));
    lines.push(fenceBlock(primary.tail));
    if (primary.source === "repo_verify") {
      if (handoff.ticketVerifyCoveredByRepoVerify) {
        lines.push(
          "  (ticket verification skipped: its explicit test paths are covered by repo verify)",
        );
      } else {
        lines.push(
          "  (no `## Verification Command` parsed on the ticket — the repo `verify:` command stood in for it)",
        );
      }
    }
  } else if (handoff.reasonCode === "handoff_verification_unspecified") {
    lines.push(
      "- Verification: NONE — the ticket has no parseable `## Verification Command` and the repo declares no `verify:` command; the handoff is refused (fail-closed).",
    );
  }
  if (handoff.repoVerify && handoff.repoVerify !== primary)
    lines.push(commandLine("Repo verify", handoff.repoVerify));
  if (handoff.webBuild) {
    lines.push(
      commandLine(
        `Web build (${HANDOFF_WEB_SRC_PREFIX}** changed)`,
        handoff.webBuild,
      ),
    );
    if (!handoff.webBuild.passed) lines.push(fenceBlock(handoff.webBuild.tail));
  } else if (handoff.diff?.ok) {
    lines.push(`- Web build: skipped (no ${HANDOFF_WEB_SRC_PREFIX}** changes)`);
  }
  if (handoff.diff?.ok) {
    const n = handoff.diff.files.length;
    lines.push(
      `- Files: ${n} changed vs ${handoff.diff.baseRef} (${handoff.diff.mergeBase.slice(0, 12)})`,
    );
    const deviations = handoff.ownedPathsDeviations ?? [];
    if (!handoff.ownedPathsKnown) {
      lines.push(
        "- Owned Paths deviations: unknown (ticket Owned Paths did not parse)",
      );
    } else if (deviations.length === 0) {
      lines.push("- Owned Paths deviations: none");
    } else {
      lines.push(
        `- Owned Paths deviations (${handoff.ownedPathsConformance}): ${deviations.length} file(s) outside the ticket's Owned Paths`,
      );
      for (const file of deviations) lines.push(`  - \`${file}\``);
    }
  } else {
    lines.push(
      `- Files: diff unavailable (${handoff.diff?.error ?? "unknown"}); Owned Paths deviations: unknown`,
    );
  }
  if (handoff.descriptionHash) {
    lines.push(
      `- ticket description hash at claim: \`${handoff.descriptionHash}\``,
    );
  }
  const claim = handoff.agentReported;
  if (claim && (claim.command || claim.output)) {
    lines.push(
      `- agent-reported: \`${claim.command ?? "(no command)"}\` — ${claim.passed === true ? "pass" : "not passed"}${claim.output ? `, ${String(claim.output).split("\n").filter(Boolean).slice(-1)[0]}` : ""}`,
    );
  }
  return lines.filter((line) => line !== null).join("\n");
}

function normalizeFailureOutput(output) {
  return (
    String(output ?? "")
      // eslint-disable-next-line no-control-regex -- \x1b is the ANSI escape byte being stripped, not a typo
      .replace(/\x1b\[[0-9;]*m/g, "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      // Lifecycle scripts emit recoverable, run-varying diagnostics as warn:.
      // They are evidence, not part of the underlying failure signature.
      .filter((line) => !/^warn:\s*/i.test(line))
      // Runners repeat these for unrelated failures; they are not evidence that
      // the same underlying check remains red.
      .filter(
        (line) =>
          !/^(\$ |bun test|error: script |error: ".*" exited|exited with code)/i.test(
            line,
          ),
      )
  );
}

/**
 * Deterministic normalized signature of a failure payload.
 * Exact equality is intentionally strict: any new signal (even a single
 * additional line) proves the failure signature changed.
 */
function failureSignature(output) {
  return normalizeFailureOutput(output).join("\n");
}

/**
 * Conservative evidence that post-agent verification hit the recorded red baseline.
 * Unlike partial line overlap, this compares full normalized signatures and fails
 * closed on ambiguous signal drift.
 */
function matchesRedBaseline(baseline, verifyOutput) {
  if (baseline?.status !== "red") return false;
  const baselineSig = failureSignature(baseline.output);
  const verifySig = failureSignature(verifyOutput);
  if (!baselineSig || !verifySig) return false;
  return baselineSig === verifySig;
}

const REPO_VERIFY_REASON_MAX_LINES = 40;
const REPO_VERIFY_REASON_MAX_CHARS = 8 * 1024;
// Anchored: a passing test whose *name* mentions "(fail)" must not be reported
// as the failure (WM-918's own registry test says "reads bun (fail) and ✗").
const REPO_VERIFY_TEST_FAILURE_LINE = /^\s*(?:\(fail\)|✗)/i;
const REPO_VERIFY_ERROR_LINE = /\berror\b/i;

function boundedDiagnostic(lines) {
  const excerpt = [];
  let remaining = REPO_VERIFY_REASON_MAX_CHARS;
  for (const line of lines) {
    const separatorLength = excerpt.length === 0 ? 0 : 1;
    if (remaining <= separatorLength) break;
    remaining -= separatorLength;
    if (line.length <= remaining) {
      excerpt.push(line);
      remaining -= line.length;
      continue;
    }
    excerpt.push(`${line.slice(0, Math.max(0, remaining - 1))}…`);
    break;
  }
  return excerpt.join("\n");
}

/**
 * Keep the actionable lines from a failed repository verification bounded for
 * the run reason. Explicit test-failure markers are retained before generic
 * errors, so later runner noise cannot displace the failing test names.
 */
function repoVerifyFailureExcerpt(output) {
  const lines = String(output ?? "")
    // eslint-disable-next-line no-control-regex -- \x1b is the ANSI escape byte being stripped, not a typo
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) return "";

  const testFailures = lines.filter((line) =>
    REPO_VERIFY_TEST_FAILURE_LINE.test(line),
  );
  const errors = lines.filter(
    (line) =>
      !REPO_VERIFY_TEST_FAILURE_LINE.test(line) &&
      REPO_VERIFY_ERROR_LINE.test(line),
  );
  if (testFailures.length === 0 && errors.length === 0) {
    return boundedDiagnostic(lines.slice(-REPO_VERIFY_REASON_MAX_LINES));
  }

  const excerpt = testFailures.slice(-REPO_VERIFY_REASON_MAX_LINES);
  const errorCapacity = Math.max(
    0,
    REPO_VERIFY_REASON_MAX_LINES - excerpt.length - 1,
  );
  if (errorCapacity > 0) excerpt.push(...errors.slice(-errorCapacity));
  const summary = lines.at(-1);
  if (
    excerpt.length < REPO_VERIFY_REASON_MAX_LINES &&
    !excerpt.includes(summary)
  )
    excerpt.push(summary);
  return boundedDiagnostic(excerpt);
}

export { normalizeFailureOutput, failureSignature };
/**
 * Verify one attempt's workspace output against the agent-result contract and
 * the agent definition's output schema.
 *
 * @returns {{ kind: "refused", reasonCode: string, result: object }
 *         | { kind: "completed", result: object, receipt: object }}
 * @throws {ContractViolation} on any contract failure — fail closed.
 */
export function verifyResult({
  spec,
  def,
  registry,
  workspaceDir,
  attempt,
  journalHead = null,
  extraArtifacts = [],
  worktreeRecord = null,
  verifyTimeoutMs = repoVerifyTimeoutMs(),
}) {
  let raw;
  try {
    raw = readFileSync(path.join(workspaceDir, "result.json"), "utf8");
  } catch {
    throw new ContractViolation(["missing_result"]);
  }

  let candidate;
  try {
    candidate = JSON.parse(raw);
  } catch (err) {
    throw new ContractViolation([`invalid_json: ${err.message}`]);
  }

  const shape = validate(registry.schemas.agentResult, candidate);
  if (!shape.valid) throw new ContractViolation(shape.errors);

  if (candidate.terminalState === "refused")
    return verifyRefused({ spec, def, candidate, attempt });
  if (candidate.decision !== undefined) {
    throw new ContractViolation(["decision_not_allowed_on_completed_result"]);
  }
  return verifyCompleted({
    spec,
    def,
    candidate,
    workspaceDir,
    attempt,
    journalHead,
    extraArtifacts,
    worktreeRecord,
    verifyTimeoutMs,
  });
}

/**
 * Refusal is not failure (§5.3) — but only typed, known reasons are admitted.
 * An optional artifact explains the refusal through the same output contract
 * as a completion, so useful context is retained without weakening validation.
 */
function verifyRefused({ spec, def, candidate, attempt }) {
  const violations = [];
  if (!candidate.reasonCode) violations.push("refused_without_reason_code");
  else if (!REFUSAL_REASONS.includes(candidate.reasonCode)) {
    violations.push(`unknown_refusal_reason: ${candidate.reasonCode}`);
  }
  if (violations.length > 0) throw new ContractViolation(violations);

  const context = {};
  const checks = ["schema_valid"];
  if (candidate.decision !== undefined) {
    const decisionCheck = validateDecisionRequest(candidate.decision, {
      refs: {
        issue: spec.input?.ticket,
        repo: spec.input?.repo,
        runId: spec.runId,
      },
    });
    if (decisionCheck.valid) context.decision = candidate.decision;
    else context.decisionErrors = decisionCheck.errors;
    checks.push("decision_validated");
  }
  if (candidate.artifact !== undefined) {
    const artifactCheck = validate(def.outputSchema, candidate.artifact);
    if (!artifactCheck.valid) throw new ContractViolation(artifactCheck.errors);

    const semantic = SEMANTIC_CHECKS[spec.outputContract];
    if (semantic) {
      const semanticViolations = semantic(candidate);
      if (semanticViolations.length > 0)
        throw new ContractViolation(semanticViolations);
      checks.push("evidence_recomputed");
    }

    context.artifact = candidate.artifact;
    context.artifactHash = hashJson(candidate.artifact);
    checks.push("hash_recomputed");
  }

  // Presentation is tolerant on the ask (§3.3): a valid one rides on the
  // result, an invalid one is dropped with its errors — a refusal is never
  // failed by a malformed summary. Resolved against the accepted artifact, or
  // {} when the refusal carries none. Not in the artifact hash or the receipt.
  if (candidate.presentation !== undefined) {
    const check = validatePresentation(
      candidate.presentation,
      candidate.artifact ?? {},
    );
    if (check.valid) context.presentation = candidate.presentation;
    else context.presentationErrors = check.errors;
    checks.push("presentation_validated");
  }

  const { evidence, evidenceSetHash } = retainedEvidence(candidate);
  if (evidence !== undefined) {
    context.evidence = evidence;
    context.evidenceSetHash = evidenceSetHash;
    checks.push("evidence_retained");
  }

  const result = {
    schemaVersion: "factory.run-result/v1",
    runId: spec.runId,
    attempt,
    terminalState: "refused",
    reasonCode: candidate.reasonCode,
    outputContract: spec.outputContract,
    ...context,
    verification: { status: "passed", checks },
    artifacts: [],
  };
  return { kind: "refused", reasonCode: candidate.reasonCode, result };
}

function retainedEvidence(candidate) {
  if (candidate.evidence === undefined)
    return { evidence: undefined, evidenceSetHash: null };

  const canonical = canonicalJson(candidate.evidence);
  const bytes = Buffer.byteLength(canonical, "utf8");
  if (bytes > EVIDENCE_INLINE_LIMIT_BYTES) {
    throw new ContractViolation([
      `evidence_too_large: ${bytes} bytes > ${EVIDENCE_INLINE_LIMIT_BYTES}`,
    ]);
  }
  return {
    evidence: candidate.evidence,
    evidenceSetHash: hashBytes(canonical),
  };
}

/** Last integer in a raw probe output — `df --output=used -B1` style. */
function parseProbeBytes(raw) {
  const match = String(raw ?? "")
    .trim()
    .match(/(\d+)\s*$/);
  return match ? Number(match[1]) : null;
}

/**
 * Work-scan is model-authored, so its individually valid fields still need a
 * deterministic consistency check (WM-350). The normalized candidate evidence
 * lets this verifier reconcile identities and dispositions instead of trusting
 * a summary count or model prose.
 */
function checkWorkPlan(candidate) {
  const { artifact, evidence } = candidate;
  const violations = [];
  const candidatesSeen = evidence?.candidatesSeen;
  const candidates = evidence?.candidates;
  const dispositions = new Set(["selected", "cap_full", "owned_paths_overlap"]);

  if (!Number.isInteger(candidatesSeen) || candidatesSeen < 0) {
    violations.push("evidence_candidatesSeen_required");
  }
  if (!Array.isArray(candidates)) {
    violations.push("evidence_candidates_required");
  }

  const normalizedCandidates = [];
  if (Array.isArray(candidates)) {
    for (const [index, entry] of candidates.entries()) {
      const valid =
        entry !== null &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        Object.keys(entry).length === 2 &&
        typeof entry.ticket === "string" &&
        // WM-1006: Linear TEAM-N or GitHub owner/repo#N / #N / N identifiers.
        /^([A-Z]+-[0-9]+|(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#?[0-9]+)$/.test(
          entry.ticket,
        ) &&
        dispositions.has(entry.disposition);
      if (!valid) {
        violations.push(`evidence_candidate_invalid_at_index_${index}`);
      } else {
        normalizedCandidates.push(entry);
      }
    }
    const candidateTickets = normalizedCandidates.map((entry) => entry.ticket);
    if (new Set(candidateTickets).size !== candidateTickets.length) {
      violations.push("evidence_candidate_tickets_must_be_unique");
    }
    if (
      Number.isInteger(candidatesSeen) &&
      candidatesSeen !== candidates.length
    ) {
      violations.push(
        `evidence_candidate_count_mismatch: candidatesSeen ${candidatesSeen} != candidates.length ${candidates.length}`,
      );
    }
  }

  if (
    !Number.isInteger(artifact.readyCandidates) ||
    artifact.readyCandidates < 0
  ) {
    violations.push("readyCandidates_required_for_work_plan");
  } else if (
    Number.isInteger(candidatesSeen) &&
    artifact.readyCandidates !== candidatesSeen
  ) {
    violations.push(
      `candidate_count_mismatch: readyCandidates ${artifact.readyCandidates} != evidence.candidatesSeen ${candidatesSeen}`,
    );
  }

  if (!Number.isInteger(artifact.triageBacklog) || artifact.triageBacklog < 0) {
    violations.push("triageBacklog_required_for_work_plan");
  }

  const planTickets = artifact.plan.map((item) => item.ticket);
  const deferredTickets = artifact.deferred.map((item) => item.ticket);
  const accountedTickets = [...planTickets, ...deferredTickets];
  if (new Set(accountedTickets).size !== accountedTickets.length) {
    violations.push("work_plan_ticket_accounting_must_be_unique");
  }

  const expectedTicket = planTickets[0] ?? null;
  if (artifact.ticket !== expectedTicket) {
    violations.push(
      `work_plan_ticket_must_equal_first_plan_ticket (expected ${expectedTicket})`,
    );
  }

  if (artifact.recommendation === "DISPATCH") {
    if (artifact.plan.length === 0)
      violations.push("dispatch_plan_must_not_be_empty");
    if (Object.hasOwn(artifact, "noopReason"))
      violations.push("dispatch_must_not_have_noopReason");

    const evidencePlan = normalizedCandidates
      .filter((entry) => entry.disposition === "selected")
      .map((entry) => entry.ticket);
    const evidenceDeferred = normalizedCandidates
      .filter((entry) => entry.disposition !== "selected")
      .map((entry) => ({ ticket: entry.ticket, reason: entry.disposition }));
    if (JSON.stringify(planTickets) !== JSON.stringify(evidencePlan)) {
      violations.push("dispatch_plan_must_match_candidate_evidence");
    }
    if (
      JSON.stringify(artifact.deferred) !== JSON.stringify(evidenceDeferred)
    ) {
      violations.push("dispatch_deferred_must_match_candidate_evidence");
    }
    if (
      Number.isInteger(candidatesSeen) &&
      accountedTickets.length !== candidatesSeen
    ) {
      violations.push(
        `dispatch_candidate_accounting_mismatch: plan ${artifact.plan.length} + deferred ${artifact.deferred.length} != candidatesSeen ${candidatesSeen}`,
      );
    }

    const hasCapDeferral = normalizedCandidates.some(
      (entry) => entry.disposition === "cap_full",
    );
    if (hasCapDeferral) {
      const inFlightSeen = evidence?.inFlightSeen;
      const maxInFlight = evidence?.maxInFlight;
      if (
        !Number.isInteger(inFlightSeen) ||
        inFlightSeen < 0 ||
        !Number.isInteger(maxInFlight) ||
        maxInFlight < 1
      ) {
        violations.push("capacity_evidence_required_for_cap_full");
      } else if (inFlightSeen + artifact.plan.length < maxInFlight) {
        violations.push(
          `cap_full_contradicts_capacity: inFlightSeen ${inFlightSeen} + plan ${artifact.plan.length} < maxInFlight ${maxInFlight}`,
        );
      }
    }
    if (artifact.triageBacklog !== 0) {
      violations.push(
        `dispatch_triageBacklog_must_be_0 (got ${artifact.triageBacklog})`,
      );
    }
  } else if (artifact.recommendation === "LOW_SUPPLY") {
    if (artifact.plan.length > 0 || artifact.deferred.length > 0) {
      violations.push("low_supply_plan_and_deferred_must_be_empty");
    }
    if (Object.hasOwn(artifact, "noopReason"))
      violations.push("low_supply_must_not_have_noopReason");
    if (artifact.readyCandidates !== 0) {
      violations.push(
        `low_supply_readyCandidates_must_be_0 (got ${artifact.readyCandidates})`,
      );
    }
    if (Number.isInteger(candidatesSeen) && candidatesSeen !== 0) {
      violations.push(
        `low_supply_candidatesSeen_must_be_0 (got ${candidatesSeen})`,
      );
    }
    if (normalizedCandidates.length !== 0)
      violations.push("low_supply_candidates_must_be_empty");
    if (
      Number.isInteger(artifact.triageBacklog) &&
      artifact.triageBacklog < 1
    ) {
      violations.push(
        `low_supply_triage_backlog_must_be_at_least_1 (got ${artifact.triageBacklog})`,
      );
    }
  } else if (artifact.recommendation === "NOOP") {
    if (artifact.plan.length > 0 || artifact.deferred.length > 0) {
      violations.push("noop_plan_and_deferred_must_be_empty");
    }
    if (!Object.hasOwn(artifact, "noopReason")) {
      violations.push("noopReason_required_for_noop");
    } else if (artifact.noopReason === "queue_empty") {
      if (artifact.readyCandidates !== 0) {
        violations.push(
          `queue_empty_readyCandidates_must_be_0 (got ${artifact.readyCandidates})`,
        );
      }
      if (Number.isInteger(candidatesSeen) && candidatesSeen !== 0) {
        violations.push(
          `queue_empty_candidatesSeen_must_be_0 (got ${candidatesSeen})`,
        );
      }
      if (normalizedCandidates.length !== 0)
        violations.push("queue_empty_candidates_must_be_empty");
    } else if (artifact.noopReason === "cap_full") {
      if (normalizedCandidates.length === 0)
        violations.push("cap_full_candidates_must_not_be_empty");
      if (
        normalizedCandidates.some((entry) => entry.disposition !== "cap_full")
      ) {
        violations.push(
          "cap_full_candidates_must_all_have_cap_full_disposition",
        );
      }
      const inFlightSeen = evidence?.inFlightSeen;
      const maxInFlight = evidence?.maxInFlight;
      if (
        !Number.isInteger(inFlightSeen) ||
        inFlightSeen < 0 ||
        !Number.isInteger(maxInFlight) ||
        maxInFlight < 1
      ) {
        violations.push("capacity_evidence_required_for_cap_full");
      } else if (inFlightSeen < maxInFlight) {
        violations.push(
          `cap_full_contradicts_capacity: inFlightSeen ${inFlightSeen} < maxInFlight ${maxInFlight}`,
        );
      }
    } else if (artifact.noopReason === "all_overlapping") {
      if (normalizedCandidates.length === 0)
        violations.push("all_overlapping_candidates_must_not_be_empty");
      if (
        normalizedCandidates.some(
          (entry) => entry.disposition !== "owned_paths_overlap",
        )
      ) {
        violations.push(
          "all_overlapping_candidates_must_all_have_overlap_disposition",
        );
      }
    }
    if (artifact.triageBacklog !== 0) {
      violations.push(
        `noop_triageBacklog_must_be_0 (got ${artifact.triageBacklog})`,
      );
    }
  }

  return violations;
}

/**
 * Semantic verification (§9, slice 2 / OPS-208): closed, data-only predicates
 * keyed by output contract. These check *truth*, not form — the claimed
 * numbers must be recomputable from the declared evidence, and a mismatch is
 * a ContractViolation, never a warning.
 */
const SEMANTIC_CHECKS = {
  "factory.disk-remediation/v1": (candidate) => {
    const violations = [];
    const { artifact, evidence } = candidate;
    if (evidence === undefined)
      return [
        "evidence_required: factory.disk-remediation/v1 claims are recomputed from probes",
      ];
    const before = parseProbeBytes(evidence.probeBefore);
    const after = parseProbeBytes(evidence.probeAfter);
    if (before === null)
      violations.push("evidence_unparseable: probeBefore has no byte count");
    if (after === null)
      violations.push("evidence_unparseable: probeAfter has no byte count");
    if (violations.length > 0) return violations;
    if (artifact.beforeUsedBytes !== before) {
      violations.push(
        `evidence_mismatch: beforeUsedBytes ${artifact.beforeUsedBytes} != probed ${before}`,
      );
    }
    if (artifact.afterUsedBytes !== after) {
      violations.push(
        `evidence_mismatch: afterUsedBytes ${artifact.afterUsedBytes} != probed ${after}`,
      );
    }
    if (artifact.reclaimedBytes !== before - after) {
      violations.push(
        `evidence_mismatch: reclaimedBytes ${artifact.reclaimedBytes} != recomputed ${before - after}`,
      );
    }
    return violations;
  },
  "factory.dispatch-result/v1": (candidate) => {
    const violations = [];
    const { artifact } = candidate;
    if (artifact.outcome === "PR_OPEN") {
      if (!artifact.prUrl) violations.push("pr_url_required_for_pr_open");
      if (artifact.verification?.passed !== true)
        violations.push("verification_must_pass_for_pr_open");
    }
    return violations;
  },
  "factory.work-plan/v1": (candidate) => checkWorkPlan(candidate),
};

function verifyCompleted({
  spec,
  def,
  candidate,
  workspaceDir,
  attempt,
  journalHead,
  extraArtifacts = [],
  worktreeRecord = null,
  verifyTimeoutMs,
}) {
  if (candidate.artifact === undefined)
    throw new ContractViolation(["missing_artifact"]);

  const artifactCheck = validate(def.outputSchema, candidate.artifact);
  if (!artifactCheck.valid) throw new ContractViolation(artifactCheck.errors);

  const semantic = SEMANTIC_CHECKS[spec.outputContract];
  if (semantic) {
    const semanticViolations = semantic(candidate);
    if (semanticViolations.length > 0)
      throw new ContractViolation(semanticViolations);
  }

  // Handoff gate (WM-718): a PR_OPEN result from a real worktree run is
  // verified by the worker, not by the agent's say-so. A bare `{}` record is
  // the worker's timeout preflight asking for form-only checks — no gate.
  //
  // The record comes only from the caller, i.e. the worker's own in-memory
  // result from createWorkspace (#944). It is never re-read from the
  // workspace's `.worktree.json`: that directory is agent-writable — the agent
  // authors `result.json` there — so a marker found beside it would let the
  // agent supply gate activation, the command executed as "repo verification"
  // and the ticket's Owned Paths, and certify its own PR_OPEN. Absent a
  // worker-supplied record the gate stays shut and only form checks apply.
  // The marker file remains workspace.mjs's durable teardown record for the
  // janitor; it carries no verification authority.
  const handoffChecks = [];
  let handoff = null;
  const isHandoff =
    candidate.artifact?.outcome === "PR_OPEN" &&
    Boolean(
      worktreeRecord &&
      (worktreeRecord.path || worktreeRecord.verify || worktreeRecord.repo),
    );
  if (isHandoff) {
    const worktreePath =
      worktreeRecord.path && existsSync(worktreeRecord.path)
        ? worktreeRecord.path
        : path.join(workspaceDir, "repo");
    const ticketCommand =
      typeof worktreeRecord.handoff?.verificationCommand === "string" &&
      worktreeRecord.handoff.verificationCommand.trim()
        ? worktreeRecord.handoff.verificationCommand.trim()
        : null;
    const ownedPaths = Array.isArray(worktreeRecord.handoff?.ownedPaths)
      ? worktreeRecord.handoff.ownedPaths
      : [];
    const ownedPathsKnown =
      worktreeRecord.handoff?.ownedPathsParsed === true ||
      (ownedPaths.length > 0 && !ownedPaths.includes("**"));
    const conformance = policyOwnedPathsConformance();
    const claim = candidate.artifact?.verification ?? null;
    handoff = {
      ticket: worktreeRecord.ticket ?? spec.input?.ticket ?? null,
      repo: worktreeRecord.repo ?? spec.input?.repo ?? null,
      github: worktreeRecord.github ?? null,
      prNumber: candidate.artifact?.prNumber ?? null,
      prUrl: candidate.artifact?.prUrl ?? null,
      runId: spec.runId,
      verification: null,
      repoVerify: null,
      webBuild: null,
      diff: null,
      ownedPaths,
      ownedPathsKnown,
      ownedPathsConformance: conformance,
      ownedPathsDeviations: [],
      descriptionHash: worktreeRecord.handoff?.descriptionHash ?? null,
      agentReported: claim
        ? {
            command: claim.command ?? null,
            passed: claim.passed === true,
            output: claim.output ?? null,
          }
        : null,
      ticketVerifyCoveredByRepoVerify: ticketVerifyCoveredByRepoVerify(
        ticketCommand,
        worktreeRecord.verify,
        { root: worktreePath },
      ),
      reasonCode: null,
    };
    const refuse = (reasonCode, violation) => {
      handoff.reasonCode = reasonCode;
      throw new ContractViolation([violation], { reasonCode, handoff });
    };
    // A host that cannot build the sandbox is an environment fault, not the
    // agent's red: refuse with its own code so the worker never drafts the
    // PR or returns the ticket over it.
    const runHandoffStep = (options) => {
      try {
        return runHandoffCommand(options);
      } catch (err) {
        if (err instanceof SandboxUnavailable) {
          refuse(HANDOFF_SANDBOX_UNAVAILABLE, err.message);
        }
        throw err;
      }
    };
    const failureWhy = (obs) =>
      obs.timedOut
        ? `timed out after ${verifyTimeoutMs}ms`
        : repoVerifyFailureExcerpt(obs.output) || `exit ${obs.exitCode}`;

    // Fail-closed: something must stand behind the Verification line.
    if (!worktreeRecord.verify && !ticketCommand) {
      refuse(
        "handoff_verification_unspecified",
        "handoff_verification_unspecified: the ticket has no parseable `## Verification Command` and the repo declares no `verify:` command",
      );
    }

    // 1. The repo's own verify command (the pre-WM-718 gate, kept as-is: it
    //    is what the red-baseline logic is keyed on).
    if (worktreeRecord.verify) {
      const obs = runHandoffStep({
        command: worktreeRecord.verify,
        cwd: worktreePath,
        worktreePath,
        logPath: path.join(workspaceDir, ".verify.log"),
        timeoutMs: verifyTimeoutMs,
      });
      obs.source = "repo_verify";
      handoff.repoVerify = obs;
      if (!obs.passed) {
        const baselineStillRed =
          !obs.timedOut &&
          matchesRedBaseline(worktreeRecord.baseline, obs.output);
        handoff.reasonCode = baselineStillRed
          ? "baseline_red"
          : "handoff_verification_failed";
        throw new ContractViolation(
          [`repo_verify_failed: ${failureWhy(obs)}`],
          { reasonCode: handoff.reasonCode, handoff },
        );
      }
      handoffChecks.push("repo_verify_passed");
    }

    // 2. The ticket's exact Verification Command on the final tree.
    if (ticketCommand && handoff.ticketVerifyCoveredByRepoVerify) {
      // Step 1 ran the broader repository test scope on this final tree, so a
      // second namespaced execution would only duplicate it (and its fixture
      // scratch space). Keep the worker observation as the ticket evidence.
      handoff.verification = handoff.repoVerify;
      handoffChecks.push("ticket_verify_covered_by_repo_verify");
    } else if (ticketCommand) {
      const obs = runHandoffStep({
        command: ticketCommand,
        cwd: worktreePath,
        worktreePath,
        logPath: path.join(workspaceDir, ".verify.ticket.log"),
        timeoutMs: verifyTimeoutMs,
      });
      obs.source = "ticket";
      handoff.verification = obs;
      if (!obs.passed) {
        refuse(
          "handoff_verification_failed",
          `ticket_verify_failed: ${failureWhy(obs)}; sandbox_limits: ${handoffSandboxLimits(obs.sandbox.tmpfsMb)}`,
        );
      }
      handoffChecks.push("ticket_verify_passed");
    } else {
      handoff.verification = handoff.repoVerify;
    }

    // 3. What the PR actually carries.
    handoff.diff = changedFilesSince({
      worktreePath,
      base: worktreeRecord.base ?? null,
    });
    const files = handoff.diff.files ?? [];

    // 4. tsc + vite for anything under event-runtime/web/src/** — the check
    //    #593 failed on, regardless of what the ticket's command covers.
    if (
      files.some((file) => file.startsWith(HANDOFF_WEB_SRC_PREFIX)) &&
      existsSync(path.join(worktreePath, HANDOFF_WEB_BUILD_DIR, "package.json"))
    ) {
      const obs = runHandoffStep({
        command: HANDOFF_WEB_BUILD_COMMAND,
        cwd: path.join(worktreePath, HANDOFF_WEB_BUILD_DIR),
        worktreePath,
        logPath: path.join(workspaceDir, ".verify.web.log"),
        timeoutMs: verifyTimeoutMs,
      });
      obs.command = `cd ${HANDOFF_WEB_BUILD_DIR} && ${HANDOFF_WEB_BUILD_COMMAND}`;
      handoff.webBuild = obs;
      if (!obs.passed) {
        refuse(
          "handoff_verification_failed",
          `web_build_failed: ${failureWhy(obs)}`,
        );
      }
      handoffChecks.push("web_build_passed");
    }

    // 5. Owned Paths conformance: listed always; refused under strict.
    if (handoff.diff.ok && ownedPathsKnown) {
      handoff.ownedPathsDeviations = ownedPathsDeviations(files, ownedPaths);
      if (handoff.ownedPathsDeviations.length === 0) {
        handoffChecks.push("owned_paths_conformant");
      } else if (conformance === "strict") {
        refuse(
          "handoff_owned_paths_violation",
          `owned_paths_violation: ${handoff.ownedPathsDeviations.length} file(s) outside the ticket's Owned Paths: ${handoff.ownedPathsDeviations.join(", ")}`,
        );
      } else {
        handoffChecks.push("owned_paths_deviations_advisory");
      }
    }
  }

  // Runtime-injected artifacts (e.g. the adapter's transcript): best-effort —
  // included when present, never a violation when absent, and never allowed
  // to shadow something the agent itself declared.
  const declared = candidate.artifacts ?? [];
  const declaredPaths = new Set(declared.map((entry) => entry.path));
  const injected = extraArtifacts.filter(
    (entry) =>
      !declaredPaths.has(entry.path) &&
      existsSync(path.join(workspaceDir, entry.path)),
  );

  const violations = [];
  const collected = [];
  // `confinedRegularFile` returns a realpath-canonical source, so the workspace
  // provenance root recorded below must be canonicalized in the same namespace
  // (WM-1017). On macOS the workspace enters as `/tmp/...` while the artifact
  // URI resolves to `/private/tmp/...`; recording the unresolved root made
  // `storeCollected`'s `path.relative(root, src)` escape the lexical root and
  // reject a valid artifact with a PathViolation. One namespace, both ends.
  const canonicalWorkspaceRoot = realpathSync(path.resolve(workspaceDir));
  for (const entry of [...declared, ...injected]) {
    let abs;
    try {
      abs = confinedRegularFile(workspaceDir, entry.path);
    } catch (err) {
      if (err?.code === "ENOENT") {
        violations.push(`artifact_missing: ${entry.path}`);
        continue;
      }
      if (!(err instanceof PathViolation)) throw err;
      violations.push(`artifact_path_escape: ${entry.path}`);
      continue;
    }
    try {
      const collectedEntry = {
        kind: entry.kind,
        uri: pathToFileURL(abs).href,
        sha256: sha256Hex(readFileSync(abs)),
      };
      // Internal, non-serializable provenance lets durable storage repeat the
      // same confinement preflight at its own trust boundary. Canonicalized to
      // match the realpath'd artifact URI so a symlinked workspace parent does
      // not read as an escape (WM-1017).
      Object.defineProperty(collectedEntry, "workspaceRoot", {
        value: canonicalWorkspaceRoot,
      });
      collected.push(collectedEntry);
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
      violations.push(`artifact_missing: ${entry.path}`);
    }
  }
  if (violations.length > 0) throw new ContractViolation(violations);

  const memoOutcome = processResultMemos({
    candidate,
    spec,
    def,
    workspaceDir,
    collected,
  });
  if (memoOutcome.errors.length > 0) {
    throw new ContractViolation(memoOutcome.errors);
  }

  const artifactHash = hashJson(candidate.artifact);

  const { evidence, evidenceSetHash } = retainedEvidence(candidate);

  // Presentation is tolerant on the ask (§3.3): a valid one rides on the run
  // result, an invalid one is dropped with its errors — a completed run whose
  // artifact passed is never failed by a malformed summary. Resolved against
  // the accepted artifact, and excluded from artifactHash and the receipt.
  const presentationContext = {};
  const presentationChecks = [];
  if (candidate.presentation !== undefined) {
    const check = validatePresentation(
      candidate.presentation,
      candidate.artifact,
    );
    if (check.valid) presentationContext.presentation = candidate.presentation;
    else presentationContext.presentationErrors = check.errors;
    presentationChecks.push("presentation_validated");
  }

  const result = {
    schemaVersion: "factory.run-result/v1",
    runId: spec.runId,
    attempt,
    terminalState: "completed",
    reasonCode: "ok",
    outputContract: spec.outputContract,
    artifact: candidate.artifact,
    artifactHash,
    ...(evidence !== undefined ? { evidence } : {}),
    evidenceSetHash,
    ...presentationContext,
    verification: {
      status: "passed",
      checks: [
        "schema_valid",
        "hash_recomputed",
        "paths_confined",
        "artifacts_exist",
        ...(evidence !== undefined ? ["evidence_retained"] : []),
        ...(SEMANTIC_CHECKS[spec.outputContract]
          ? ["evidence_recomputed"]
          : []),
        ...handoffChecks,
        ...presentationChecks,
        ...memoOutcome.checks,
      ],
    },
    artifacts: collected,
    ...(memoOutcome.memos.length > 0 ? { memos: memoOutcome.memos } : {}),
    ...(memoOutcome.usedMemos ? { usedMemos: memoOutcome.usedMemos } : {}),
  };
  const receipt = {
    runId: spec.runId,
    runSpecHash: hashJson(spec),
    artifactHash,
    evidenceSetHash,
    journalHead,
    verificationStatus: "passed",
  };
  return {
    kind: "completed",
    result,
    receipt,
    ...(handoff ? { handoff } : {}),
  };
}
