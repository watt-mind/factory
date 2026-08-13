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
 * command and captured output as the artifact. Nonzero/timeout → no result;
 * the worker records FAILED with `agent_exit_<code>` as usual.
 */
import { spawn } from "node:child_process";
import { createWriteStream, writeFileSync } from "node:fs";
import path from "node:path";

const KILL_GRACE_MS = 10_000;
const OUTPUT_TAIL_CHARS = 2_000;

/** Substitute `{field}` placeholders in one argv element from spec.input. */
export function resolveTemplate(template, input) {
  return template.map((element) =>
    element.replace(/\{([A-Za-z0-9_]+)\}/g, (_, field) => {
      const value = input?.[field];
      if (value === undefined || value === null) {
        throw new Error(`command template references missing input field "${field}"`);
      }
      if (!["string", "number", "boolean"].includes(typeof value)) {
        throw new Error(`command template field "${field}" must be a primitive, got ${typeof value}`);
      }
      return String(value);
    }),
  );
}

/**
 * @returns {Promise<{ exitCode: number | null, timedOut: boolean }>}
 */
export async function execute({ spec, def, workspaceDir, timeoutMs }) {
  if (!Array.isArray(def.command) || def.command.length === 0) {
    throw new Error(`definition ${def.ref} has no command template — not a command-adapter agent`);
  }
  const argv = resolveTemplate(def.command, spec.input);

  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: workspaceDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
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
    let killTimer;
    const termTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref?.();
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      reject(err);
    });

    child.on("close", (exitCode) => {
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      if (exitCode === 0 && !timedOut) {
        const write = () => {
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
