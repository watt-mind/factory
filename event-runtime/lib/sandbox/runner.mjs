/**
 * Gondolin VM host — the Node half of the sandbox (WM-185).
 *
 * THIS FILE RUNS UNDER NODE, NOT BUN, AND THAT IS NOT A STYLE CHOICE.
 * Measured on this SDK (@earendil-works/gondolin 0.12.0, macOS arm64, QEMU
 * 11.1.0): under Bun the VM boots, the VFS mounts, and `vm.exec()` works —
 * but the host-side TLS mediation never answers. An allowlisted request hangs
 * until its own timeout with no error raised and no debug output emitted. The
 * identical script under Node v24.18 returns the response normally. A silent
 * hang on the network path is the worst failure mode available to a sandbox,
 * so lib/sandbox/gondolin.mjs spawns this file as a Node child process rather
 * than importing the SDK into the worker's Bun process. Do not "simplify"
 * that boundary away without re-running the invariant tests.
 *
 * Protocol: the caller writes one JSON request to stdin and reads NDJSON
 * events from stdout. The request travels over stdin specifically because it
 * carries resolved secret values — argv is world-readable via `ps`, and the
 * whole point of this subsystem is that credentials stay out of reach.
 *
 *   request  { policy, secrets, command, cwd, env, timeoutMs, shell }
 *   events   { type: "ready",  bootMs }
 *            { type: "stdout", data }
 *            { type: "stderr", data }
 *            { type: "exit",   exitCode, signal }
 *            { type: "error",  code, message }
 *
 * stdout carries the protocol and nothing else; this file's own diagnostics
 * go to stderr, which the parent surfaces only on failure.
 */
import { readFileSync } from "node:fs";

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function readRequest() {
  // fd 0 to EOF — the parent writes one JSON object and closes stdin.
  return JSON.parse(readFileSync(0, "utf8"));
}

async function main() {
  const request = readRequest();
  const { policy, secrets = {}, command, cwd, env = {}, timeoutMs, shell = false } = request;

  let sdk;
  try {
    sdk = await import("@earendil-works/gondolin");
  } catch (err) {
    emit({ type: "error", code: "sandbox_unavailable", message: `@earendil-works/gondolin is not installed: ${err.message}` });
    process.exit(2);
  }
  const { VM, RealFSProvider, ReadonlyProvider, createHttpHooks } = sdk;

  // Default-deny egress plus placeholder substitution. `allowedHosts` is
  // always passed explicitly — an omitted allowlist means "allow all" to this
  // SDK, and lib/sandbox/policy.mjs exists partly to make that impossible.
  const { httpHooks, env: placeholderEnv } = createHttpHooks({
    allowedHosts: policy.allowedHosts,
    secrets: Object.fromEntries(
      Object.entries(secrets).map(([name, { hosts, value }]) => [name, { hosts, value }]),
    ),
  });

  const mounts = {};
  for (const mount of policy.mounts) {
    const provider = new RealFSProvider(mount.hostPath);
    mounts[mount.guestPath] = mount.readonly ? new ReadonlyProvider(provider) : provider;
  }

  const bootStart = Date.now();
  let vm;
  try {
    vm = await VM.create({
      httpHooks,
      // Placeholders first, caller env second: a caller must not be able to
      // overwrite a placeholder with something that looks like a credential.
      env: { ...env, ...placeholderEnv },
      memory: policy.memory,
      cpus: policy.cpus,
      ...(Object.keys(mounts).length > 0 ? { vfs: { mounts } } : {}),
      sessionLabel: "factory-event-runtime",
    });
  } catch (err) {
    emit({ type: "error", code: "sandbox_boot_failed", message: err.message });
    process.exit(2);
  }
  emit({ type: "ready", bootMs: Date.now() - bootStart });

  const abort = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => abort.abort(), timeoutMs) : null;

  try {
    // The parent sends an argv array unless it explicitly asked for a shell.
    // Array form executes the binary directly with no shell, preserving the
    // command adapter's closed-registry guarantee (lib/adapters/command.mjs):
    // an input value can never become a command. The string form (`/bin/sh
    // -lc`) exists only for the hand-driven `sandbox exec --shell` path.
    if (shell ? typeof command !== "string" : !Array.isArray(command)) {
      throw new Error(shell ? "shell mode requires a command string" : "non-shell mode requires an argv array");
    }
    const proc = vm.exec(command, {
      cwd,
      signal: abort.signal,
      stdout: "pipe",
      stderr: "pipe",
      buffer: false,
    });
    proc.stdout?.on("data", (chunk) => emit({ type: "stdout", data: chunk.toString() }));
    proc.stderr?.on("data", (chunk) => emit({ type: "stderr", data: chunk.toString() }));
    const result = await proc;
    emit({ type: "exit", exitCode: result.exitCode, signal: result.signal ?? null });
  } catch (err) {
    if (abort.signal.aborted) {
      emit({ type: "error", code: "sandbox_timeout", message: `guest command exceeded ${timeoutMs}ms` });
    } else {
      emit({ type: "error", code: "sandbox_exec_failed", message: err.message });
    }
  } finally {
    if (timer) clearTimeout(timer);
    // Teardown on every path: a leaked QEMU process is exactly the litter the
    // gondolin-cleanup cron on `shadow` was written to sweep up.
    try {
      await vm.close();
    } catch (err) {
      process.stderr.write(`vm.close failed: ${err.message}\n`);
    }
  }
}

main().catch((err) => {
  emit({ type: "error", code: "sandbox_runner_crashed", message: err?.message ?? String(err) });
  process.exit(2);
});
