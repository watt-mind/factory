/**
 * Gondolin microVM sandbox — worker-side entry point (WM-185).
 *
 * Runs a command inside a hardware-isolated microVM instead of on the host,
 * with default-deny network egress and host-side secret substitution: the
 * guest holds only opaque placeholders, and the real credential is spliced in
 * by the host proxy on allowlisted upstreams. WM-130's RFC
 * (docs/eval-gondolin-sandbox.md) is the background; this module is the part
 * that actually runs.
 *
 * The VM host itself lives in runner.mjs and executes under **Node**, not
 * Bun, for a measured reason documented at the top of that file. Everything
 * here — policy handling, preflight, timeouts, streaming — stays on the Bun
 * side, and the two halves talk NDJSON over a pipe. The boundary is also why
 * resolved secrets travel on stdin rather than argv or env: argv is visible to
 * any process that can run `ps`.
 *
 * Every failure mode is a typed condition rather than a crash, mirroring
 * lib/adapters/pi.mjs's `CliNotFoundError`: a worker on a host without QEMU
 * must refuse the run cleanly and let placement send it elsewhere, not die
 * halfway through with a stack trace.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { FACTORY_ROOT } from "../config.mjs";
import { normalizePolicy, resolveSecretValues } from "./policy.mjs";

export { normalizePolicy, resolveSecretValues, SandboxPolicyError } from "./policy.mjs";

/** The SDK's package.json declares engines.node >= 23.6.0; below that it will not import. */
export const MIN_NODE_MAJOR = 23;
export const MIN_NODE_MINOR = 6;

export const RUNNER_PATH = path.join(FACTORY_ROOT, "event-runtime", "lib", "sandbox", "runner.mjs");

/** Grace between SIGTERM and SIGKILL for the runner child, matching the command adapter. */
export const KILL_GRACE_MS = 10_000;

export class SandboxUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "SandboxUnavailableError";
    this.code = "sandbox_unavailable";
  }
}

export class SandboxExecutionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SandboxExecutionError";
    this.code = code;
  }
}

/** QEMU's binary is named per guest architecture; the guest matches the host. */
export function qemuBinaryFor(arch = process.arch) {
  return arch === "arm64" ? "qemu-system-aarch64" : "qemu-system-x86_64";
}

export function parseNodeVersion(output) {
  const match = /v?(\d+)\.(\d+)\.\d+/.exec(String(output ?? "").trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

export function nodeVersionSatisfies(version) {
  if (!version) return false;
  if (version.major > MIN_NODE_MAJOR) return true;
  return version.major === MIN_NODE_MAJOR && version.minor >= MIN_NODE_MINOR;
}

/**
 * Can this host actually honour a sandboxed run? Reports a reason rather than
 * a bare boolean so `sandbox doctor` and the worker log can say what is
 * missing instead of "unavailable".
 *
 * @returns {{ available: boolean, reason: string|null, qemu: string|null, node: string|null, nodeVersion: string|null, sdk: boolean }}
 */
export function preflight({
  env = process.env,
  which = (name) => Bun.which(name),
  runNode = (bin) => {
    try {
      const proc = Bun.spawnSync([bin, "--version"]);
      return proc.success ? proc.stdout.toString() : null;
    } catch {
      // Bun.spawnSync throws ENOENT for a missing binary rather than
      // reporting failure — a FACTORY_SANDBOX_NODE pointing at nothing must
      // still come back as a typed "unavailable", not an exception.
      return null;
    }
  },
  sdkExists = () => existsSync(path.join(FACTORY_ROOT, "node_modules", "@earendil-works", "gondolin", "package.json")),
} = {}) {
  const report = { available: false, reason: null, qemu: null, node: null, nodeVersion: null, sdk: false };

  const qemuBin = qemuBinaryFor();
  report.qemu = which(qemuBin);
  if (!report.qemu) {
    report.reason = `${qemuBin} is not on PATH — install QEMU (macOS: brew install qemu)`;
    return report;
  }

  // FACTORY_SANDBOX_NODE exists because the worker itself runs under Bun and
  // the Node that satisfies the SDK may not be the one first on PATH (nvm).
  const nodeBin = env.FACTORY_SANDBOX_NODE || which("node");
  if (!nodeBin) {
    report.reason = "node is not on PATH — the Gondolin SDK requires Node (see runner.mjs); set FACTORY_SANDBOX_NODE";
    return report;
  }
  report.node = nodeBin;
  const version = parseNodeVersion(runNode(nodeBin));
  report.nodeVersion = version ? `${version.major}.${version.minor}` : null;
  if (!nodeVersionSatisfies(version)) {
    report.reason = `node at ${nodeBin} is ${report.nodeVersion ?? "unreadable"}, need >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} — set FACTORY_SANDBOX_NODE to a newer Node`;
    return report;
  }

  report.sdk = sdkExists();
  if (!report.sdk) {
    report.reason = "@earendil-works/gondolin is not installed — run `bun install`";
    return report;
  }

  report.available = true;
  return report;
}

export function assertAvailable(options) {
  const report = preflight(options);
  if (!report.available) throw new SandboxUnavailableError(report.reason);
  return report;
}

/**
 * Split a buffer of NDJSON into parsed events plus the unterminated remainder.
 * Pure, so the protocol can be tested without a VM.
 */
export function parseEvents(buffer) {
  const events = [];
  let rest = buffer;
  for (;;) {
    const nl = rest.indexOf("\n");
    if (nl === -1) break;
    const line = rest.slice(0, nl);
    rest = rest.slice(nl + 1);
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // A malformed line is runner noise, not a protocol event; the parent
      // must not die on it mid-run.
    }
  }
  return { events, rest };
}

/**
 * Run one command inside a Gondolin microVM.
 *
 * @param {object} options
 * @param {object} options.policy - raw sandbox policy (validated here)
 * @param {string[]|string} options.command - argv, or a shell string when `shell` is true
 * @param {string} [options.workspaceDir] - host dir bound to the policy's workspace mount
 * @param {number} options.timeoutMs
 * @param {boolean} [options.shell] - run via `/bin/sh -lc` (hand-driven CLI only)
 * @param {Record<string,string>} [options.env] - non-secret env for the guest
 * @param {(chunk: string) => void} [options.onStdout]
 * @param {(chunk: string) => void} [options.onStderr]
 * @param {AbortSignal} [options.abortSignal]
 * @returns {Promise<{ exitCode: number|null, timedOut: boolean, bootMs: number|null }>}
 */
export async function runInSandbox({
  policy: rawPolicy,
  command,
  workspaceDir,
  timeoutMs,
  shell = false,
  env = {},
  hostEnv = process.env,
  onStdout,
  onStderr,
  abortSignal,
  signal,
}) {
  // Order matters, and CI proved it: policy validation is host-independent,
  // so it goes first. A definition with a typo'd provider is wrong on every
  // machine, and reporting "qemu is not on PATH" for it sends the reader
  // hunting a hypervisor problem that does not exist. Host capability is
  // checked second, and secret resolution (which reads this host's env) last.
  const policy = normalizePolicy(rawPolicy, { workspaceDir });
  const report = assertAvailable({ env: hostEnv });
  const secrets = resolveSecretValues(policy, hostEnv);

  const guestCwd = workspaceDir ? policy.workspaceMount : undefined;
  const request = JSON.stringify({ policy, secrets, command, cwd: guestCwd, env, timeoutMs, shell });

  return new Promise((resolve, reject) => {
    const child = spawn(report.node, [RUNNER_PATH], {
      cwd: FACTORY_ROOT,
      // The runner resolves the SDK from FACTORY_ROOT/node_modules and needs
      // nothing else; it must not inherit the worker's credentials, since
      // keeping secrets off the guest is the entire point of the sandbox.
      env: { PATH: hostEnv.PATH ?? "", HOME: hostEnv.HOME ?? "", TMPDIR: hostEnv.TMPDIR ?? "" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stdin.on("error", () => {});
    child.stdin.write(request);
    child.stdin.end();

    let buffer = "";
    let bootMs = null;
    let exitCode = null;
    let timedOut = false;
    let failure = null;
    let stderrTail = "";

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const { events, rest } = parseEvents(buffer);
      buffer = rest;
      for (const event of events) {
        switch (event.type) {
          case "ready":
            bootMs = event.bootMs ?? null;
            break;
          case "stdout":
            onStdout?.(event.data);
            break;
          case "stderr":
            onStderr?.(event.data);
            break;
          case "exit":
            exitCode = event.exitCode ?? null;
            break;
          case "error":
            if (event.code === "sandbox_timeout") timedOut = true;
            else failure = new SandboxExecutionError(event.code, event.message);
            break;
          default:
            break;
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });

    // Belt and braces: the runner aborts the guest command on its own timer,
    // but a wedged runner (or a VM that will not tear down) must not pin the
    // worker's run slot open forever.
    let killTimer = null;
    const termTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref?.();
    }, timeoutMs + KILL_GRACE_MS);

    const onAbort = () => {
      child.kill("SIGTERM");
      if (!killTimer) {
        killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
        killTimer.unref?.();
      }
    };
    const abortSig = abortSignal ?? signal;
    if (abortSig) {
      if (abortSig.aborted) onAbort();
      else abortSig.addEventListener("abort", onAbort, { once: true });
    }

    const cleanup = () => {
      clearTimeout(termTimer);
      if (killTimer) clearTimeout(killTimer);
      if (abortSig) abortSig.removeEventListener?.("abort", onAbort);
    };

    child.on("error", (err) => {
      cleanup();
      reject(new SandboxUnavailableError(`failed to spawn the sandbox runner (${report.node}): ${err.message}`));
    });

    child.on("close", (runnerExit) => {
      cleanup();
      if (failure) return reject(failure);
      if (timedOut) return resolve({ exitCode: null, timedOut: true, bootMs });
      if (exitCode === null) {
        // The runner died before reporting a guest exit code — reporting 0 or
        // "failed" here would both be fabrication, so surface it as typed.
        return reject(
          new SandboxExecutionError(
            "sandbox_runner_crashed",
            `sandbox runner exited (${runnerExit}) without reporting a guest exit code${stderrTail ? `: ${stderrTail.trim()}` : ""}`,
          ),
        );
      }
      resolve({ exitCode, timedOut: false, bootMs });
    });
  });
}
