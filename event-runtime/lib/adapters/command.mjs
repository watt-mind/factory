/**
 * Deterministic-command adapter (docs/event-runtime.md §11, §14; OPS-223).
 *
 * The §14 "closed action registry" made concrete: a registered definition
 * declares a fixed argv template, and the only thing an event can influence
 * is the declared placeholder values — substituted per argv element, spawned
 * directly with no shell, so an input like `"; rm -rf /"` is just an inert
 * argument. This is the enforcement-by-construction that lets a `mutating:
 * true` definition into the registry at all (lib/registry.mjs).
 *
 * Exit 0 → writes result.json (factory.agent-result/v1) with the resolved
 * command and captured output as the artifact, unless the definition sets
 * `writesResult: true` (WM-907): then the command authors result.json and
 * this adapter does not overwrite it. Nonzero/timeout → no result; the
 * worker records FAILED with `agent_exit_<code>` as usual.
 *
 * A definition may add a `sandbox` block (WM-185), which moves execution off
 * the host and into a Gondolin microVM: the workspace is mounted read-write
 * inside the guest, network egress is default-deny, and declared secrets
 * reach the guest only as placeholders. The result contract is identical
 * either way — the same result.json, the same captured artifact, the same
 * exit-code semantics — so downstream verification cannot tell the two apart.
 * Without the block, this adapter behaves exactly as it always has. The
 * decision itself (sandboxed, or refused) is not this adapter's own any more:
 * it goes through lib/adapters/sandboxed.mjs like every other adapter (WM-313).
 */
import { spawn } from "node:child_process";
import { createWriteStream, writeFileSync } from "node:fs";
import path from "node:path";
import { FACTORY_ROOT } from "../config.mjs";
import { runSandboxed, sandboxRequested } from "./sandboxed.mjs";

/** This adapter executes inside the VM when a definition asks (WM-185). */
export const SANDBOX_SUPPORT = "gondolin";

const KILL_GRACE_MS = 10_000;
const OUTPUT_TAIL_CHARS = 2_000;

/**
 * Substitute `{field}` placeholders in one argv element.
 *
 * Bindings come from spec.input, plus `factoryRoot` injected from config
 * (same pattern as adapters/actions.mjs). The payload must never supply
 * factoryRoot — `{"factoryRoot":"/tmp/x"}` would otherwise pick which
 * script `bun` executes.
 */
export function resolveTemplate(template, input) {
  const context = { ...input, factoryRoot: FACTORY_ROOT };
  return template.map((element) =>
    element.replace(/\{([A-Za-z0-9_]+)\}/g, (_, field) => {
      const value = context[field];
      if (value === undefined || value === null) {
        throw new Error(
          `command template references missing input field "${field}"`,
        );
      }
      if (!["string", "number", "boolean"].includes(typeof value)) {
        throw new Error(
          `command template field "${field}" must be a primitive, got ${typeof value}`,
        );
      }
      return String(value);
    }),
  );
}

function killProcessGroup(child, signal = "SIGTERM") {
  const pid = child?.pid;
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already terminated
    }
  }
}

/**
 * The success half of the result contract, shared by the host and sandboxed
 * paths so the two can never drift into producing different artifacts.
 */
function writeResultJson({ workspaceDir, def, argv, output }) {
  if (def.writesResult) return;
  const captured = def.captureStdout
    ? [{ kind: def.captureKind ?? "output", path: def.captureStdout }]
    : [];
  writeFileSync(
    path.join(workspaceDir, "result.json"),
    `${JSON.stringify(
      {
        schemaVersion: "factory.agent-result/v1",
        terminalState: "completed",
        reasonCode: "ok",
        artifact: {
          command: argv,
          exitCode: 0,
          outputTail: output,
          ...(def.captureStdout ? { captured: def.captureStdout } : {}),
        },
        evidence: { command: argv, outputTail: output },
        ...(captured.length ? { artifacts: captured } : {}),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

/**
 * Sandboxed execution path (WM-185). The guest gets the workspace at the
 * policy's mount point and nothing else; argv runs with no shell, exactly as
 * on the host path.
 *
 * @returns {Promise<{ exitCode: number | null, timedOut: boolean }>}
 */
async function executeSandboxed({
  def,
  argv,
  workspaceDir,
  timeoutMs,
  abortSignal,
  onTrace,
  runSandbox,
}) {
  let output = "";
  const collect = (chunk) => {
    output = (output + chunk).slice(-OUTPUT_TAIL_CHARS);
  };
  const capture = def.captureStdout
    ? createWriteStream(path.join(workspaceDir, def.captureStdout))
    : null;

  const { exitCode, timedOut } = await runSandboxed({
    adapter: "command",
    def,
    argv,
    workspaceDir,
    timeoutMs,
    abortSignal,
    onTrace,
    runSandbox,
    onStdout: (chunk) => {
      capture?.write(chunk);
      collect(chunk);
    },
    onStderr: collect,
  });

  if (capture) await new Promise((done) => capture.end(done));
  if (exitCode === 0 && !timedOut) {
    writeResultJson({ workspaceDir, def, argv, output });
  }
  return { exitCode, timedOut };
}

/**
 * @returns {Promise<{ exitCode: number | null, timedOut: boolean }>}
 */
export async function execute({
  spec,
  def,
  workspaceDir,
  timeoutMs,
  abortSignal,
  signal,
  onTrace,
  runSandbox,
}) {
  if (!Array.isArray(def.command) || def.command.length === 0) {
    throw new Error(
      `definition ${def.ref} has no command template — not a command-adapter agent`,
    );
  }
  const argv = resolveTemplate(def.command, spec.input);

  if (sandboxRequested(def)) {
    return executeSandboxed({
      def,
      argv,
      workspaceDir,
      timeoutMs,
      abortSignal: abortSignal ?? signal,
      onTrace,
      runSandbox,
    });
  }

  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: workspaceDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    let output = "";
    const collect = (chunk) => {
      output = (output + chunk.toString()).slice(-OUTPUT_TAIL_CHARS);
    };
    // `captureStdout` keeps the WHOLE stream as a declared artifact (OPS-372).
    // The tail above is a preview for the artifact body; a CI log truncated to
    // 2000 chars is useless to a downstream agent, which is the entire reason
    // artifact inputs exist.
    const capture = def.captureStdout
      ? createWriteStream(path.join(workspaceDir, def.captureStdout))
      : null;
    if (capture) child.stdout.pipe(capture);
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    let timedOut = false;
    let killTimer = null;
    const termTimer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child, "SIGTERM");
      killTimer = setTimeout(
        () => killProcessGroup(child, "SIGKILL"),
        KILL_GRACE_MS,
      );
    }, timeoutMs);

    const onAbort = () => {
      killProcessGroup(child, "SIGTERM");
      if (!killTimer) {
        killTimer = setTimeout(
          () => killProcessGroup(child, "SIGKILL"),
          KILL_GRACE_MS,
        );
      }
    };
    const abortSig = abortSignal ?? signal;
    if (abortSig) {
      if (abortSig.aborted) {
        onAbort();
      } else {
        abortSig.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.on("error", (err) => {
      clearTimeout(termTimer);
      if (killTimer) clearTimeout(killTimer);
      if (abortSig) abortSig.removeEventListener?.("abort", onAbort);
      reject(err);
    });

    child.on("close", (exitCode) => {
      clearTimeout(termTimer);
      if (killTimer) clearTimeout(killTimer);
      if (abortSig) abortSig.removeEventListener?.("abort", onAbort);
      if (exitCode === 0 && !timedOut) {
        const write = () => {
          writeResultJson({ workspaceDir, def, argv, output });
          resolve({ exitCode, timedOut });
        };
        // The capture stream must be flushed before the verifier hashes it.
        if (capture) capture.end(write);
        else write();
        return;
      }
      capture?.end();
      resolve({ exitCode, timedOut });
    });
  });
}
