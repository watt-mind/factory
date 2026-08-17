import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FACTORY_ROOT } from "../config.mjs";
import { openDb } from "../db.mjs";
import { planAdmittedEvents } from "../planner.mjs";
import { loadRegistry } from "../registry.mjs";
import { validate } from "../schema.mjs";
import { emitDueTicks } from "../schedules.mjs";
import { preflight } from "../sandbox/gondolin.mjs";
import { execute, resolveTemplate, SANDBOX_SUPPORT } from "./command.mjs";
import { SANDBOX_CONSOLE_FILE } from "./sandboxed.mjs";

const def = (command) => ({ ref: "test-cmd@1", command });
const spec = (input) => ({ input });
const ws = () => mkdtempSync(path.join(os.tmpdir(), "evrt-cmd-"));
const REAPER_SCRIPT = path.join(FACTORY_ROOT, "orchestrator", "reaper.mjs");

describe("resolveTemplate", () => {
  test("substitutes placeholders inside argv elements", () => {
    expect(resolveTemplate(["gh", "run", "rerun", "{runId}", "--repo", "{repo}"], { runId: 42, repo: "wm/x" }))
      .toEqual(["gh", "run", "rerun", "42", "--repo", "wm/x"]);
    expect(resolveTemplate(["notify", "CI RED {repo}: {summary}"], { repo: "wm/x", summary: "boom" }))
      .toEqual(["notify", "CI RED wm/x: boom"]);
  });

  test("missing or non-primitive fields fail closed", () => {
    expect(() => resolveTemplate(["x", "{gone}"], {})).toThrow('missing input field "gone"');
    expect(() => resolveTemplate(["x", "{obj}"], { obj: { a: 1 } })).toThrow("must be a primitive");
  });

  test("hostile input stays a single inert argument — no shell exists", () => {
    const argv = resolveTemplate(["echo", "{msg}"], { msg: "; rm -rf / && echo pwned" });
    expect(argv).toEqual(["echo", "; rm -rf / && echo pwned"]);
  });

  test("factoryRoot is injected from config, never from input (OPS-404)", () => {
    expect(resolveTemplate(["bun", "{factoryRoot}/orchestrator/reaper.mjs", "--apply"], {})).toEqual([
      "bun",
      REAPER_SCRIPT,
      "--apply",
    ]);
    expect(
      resolveTemplate(["bun", "{factoryRoot}/orchestrator/reaper.mjs"], { factoryRoot: "/tmp/pwn" }),
    ).toEqual(["bun", REAPER_SCRIPT]);
  });
});

describe("execute", () => {
  test("exit 0 writes a factory.agent-result/v1 with the resolved command", async () => {
    const workspaceDir = ws();
    const outcome = await execute({
      spec: spec({ msg: "hello" }),
      def: def(["echo", "{msg}"]),
      workspaceDir,
      timeoutMs: 5000,
    });
    expect(outcome).toEqual({ exitCode: 0, timedOut: false });
    const result = JSON.parse(readFileSync(path.join(workspaceDir, "result.json"), "utf8"));
    expect(result.terminalState).toBe("completed");
    expect(result.artifact.command).toEqual(["echo", "hello"]);
    expect(result.artifact.exitCode).toBe(0);
    expect(result.artifact.outputTail).toContain("hello");
  });

  test("nonzero exit writes no result — the worker records the failure", async () => {
    const workspaceDir = ws();
    const outcome = await execute({
      spec: spec({}),
      def: def(["false"]),
      workspaceDir,
      timeoutMs: 5000,
    });
    expect(outcome.exitCode).toBe(1);
    expect(() => readFileSync(path.join(workspaceDir, "result.json"))).toThrow();
  });

  test("timeout TERMs the child and reports timedOut", async () => {
    const workspaceDir = ws();
    const outcome = await execute({
      spec: spec({}),
      def: def(["sleep", "30"]),
      workspaceDir,
      timeoutMs: 300,
    });
    expect(outcome.timedOut).toBe(true);
  }, 10_000);

  test("a definition without a command template is refused", async () => {
    await expect(
      execute({ spec: spec({}), def: { ref: "x@1" }, workspaceDir: ws(), timeoutMs: 1000 }),
    ).rejects.toThrow("no command template");
  });

  test("execute injects factoryRoot so a payload cannot pick the script (OPS-404)", async () => {
    const workspaceDir = ws();
    const outcome = await execute({
      spec: spec({ factoryRoot: "/tmp/pwn" }),
      def: def(["test", "-f", "{factoryRoot}/orchestrator/reaper.mjs"]),
      workspaceDir,
      timeoutMs: 5000,
    });
    expect(outcome).toEqual({ exitCode: 0, timedOut: false });
    const result = JSON.parse(readFileSync(path.join(workspaceDir, "result.json"), "utf8"));
    expect(result.artifact.command).toEqual(["test", "-f", REAPER_SCRIPT]);
    expect(result.artifact.command.join(" ")).not.toContain("/tmp/pwn");
  });

  test("timeout kills the whole process group, leaving no orphaned grandchildren (OPS-411)", async () => {
    const workspaceDir = ws();
    const pidFile = path.join(workspaceDir, "grandchild.pid");
    // sh spawns background sleep and writes its pid, then waits
    const script = `sh -c 'sleep 30 & echo $! > "${pidFile}"; wait'`;
    const outcome = await execute({
      spec: spec({}),
      def: def(["sh", "-c", script]),
      workspaceDir,
      timeoutMs: 200,
    });
    expect(outcome.timedOut).toBe(true);

    // Give the kernel a brief moment to finish reaping signals
    await new Promise((r) => setTimeout(r, 100));

    if (existsSync(pidFile)) {
      const grandchildPid = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
      let alive = true;
      try {
        process.kill(grandchildPid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    }
  }, 10_000);

  test("abortSignal terminates process group immediately (OPS-411)", async () => {
    const workspaceDir = ws();
    const pidFile = path.join(workspaceDir, "grandchild_abort.pid");
    const script = `sh -c 'sleep 30 & echo $! > "${pidFile}"; wait'`;
    const ac = new AbortController();

    const runPromise = execute({
      spec: spec({}),
      def: def(["sh", "-c", script]),
      workspaceDir,
      timeoutMs: 10_000,
      abortSignal: ac.signal,
    });

    // Abort after 200ms
    setTimeout(() => ac.abort(), 200);

    const outcome = await runPromise;
    expect(outcome.timedOut).toBe(false);

    await new Promise((r) => setTimeout(r, 100));
    if (existsSync(pidFile)) {
      const grandchildPid = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
      let alive = true;
      try {
        process.kill(grandchildPid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    }
  }, 10_000);
});

/**
 * A schema-valid sample for a command-adapter input. Required (and declared)
 * fields only — enough that every `{placeholder}` drawn from input has a
 * primitive to substitute. `factoryRoot` is not a schema field and must not
 * appear here.
 */
function sampleFromSchema(schema) {
  if (!schema || typeof schema !== "object") return "x";
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  const types = schema.type === undefined ? ["object"] : Array.isArray(schema.type) ? schema.type : [schema.type];
  const type = types.find((t) => t !== "null") ?? "string";
  switch (type) {
    case "string": {
      if (schema.pattern === "^[^/\\s]+/[^/\\s]+$") return "wm/x";
      if (schema.pattern === "^[0-9a-f]{64}$") return "a".repeat(64);
      if (schema.pattern === "^[0-9a-f]{40}$") return "b".repeat(40);
      if (schema.pattern === "^/[A-Za-z0-9/._-]*$") return "/var";
      if (schema.pattern === "^[A-Z]+-[0-9]+$") return "OPS-1";
      return "x".repeat(schema.minLength ?? 1);
    }
    case "integer":
    case "number":
      return schema.minimum ?? 0;
    case "boolean":
      return true;
    case "array": {
      const n = schema.minItems ?? 0;
      const item = sampleFromSchema(schema.items ?? { type: "string" });
      return Array.from({ length: n }, () => structuredClone(item));
    }
    case "object": {
      const obj = {};
      for (const [key, sub] of Object.entries(schema.properties ?? {})) {
        obj[key] = sampleFromSchema(sub);
      }
      return obj;
    }
    default:
      return "x";
  }
}

describe("command-adapter registry (OPS-404)", () => {
  const registry = loadRegistry();
  const commandDefs = [...registry.agents.values()].filter(
    (agent) => Array.isArray(agent.command) && agent.command.length > 0,
  );

  test("factoryRoot is not an input-schema field — it is injected server-side", () => {
    const offenders = [];
    for (const agent of registry.agents.values()) {
      if (agent.inputSchema?.properties?.factoryRoot) {
        offenders.push(agent.ref);
      }
    }
    expect(offenders).toEqual([]);
    const reaper = registry.agents.get("reaper@1");
    expect(validate(reaper.inputSchema, { loop: "reaper", slot: "2026-08-14T04:00:00.000Z", factoryRoot: "/tmp/pwn" }).valid).toBe(
      false,
    );
  });

  test("every registered command template resolves against a schema-valid input", () => {
    expect(commandDefs.length).toBeGreaterThan(0);
    for (const agent of commandDefs) {
      const input = sampleFromSchema(agent.inputSchema);
      const checked = validate(agent.inputSchema, input);
      expect(checked.valid, `${agent.ref} sample is not schema-valid: ${checked.errors?.join("; ")}`).toBe(true);
      expect(input).not.toHaveProperty("factoryRoot");
      const argv = resolveTemplate(agent.command, input);
      expect(argv.every((el) => typeof el === "string")).toBe(true);
      expect(argv.some((el) => el.includes("{"))).toBe(false);
    }
  });

  test("a reaper run planned from a clock tick resolves its argv and executes", async () => {
    const db = openDb(path.join(mkdtempSync(path.join(os.tmpdir(), "evrt-reaper-")), "runtime.db"));
    const withReaper = {
      ...registry,
      schedules: {
        ...registry.schedules,
        reaper: { ...registry.schedules.reaper, enabled: true, approval: "auto" },
      },
    };
    emitDueTicks(db, withReaper, { now: Date.parse("2026-08-14T04:30:00Z") });
    planAdmittedEvents(db, withReaper, { policyVersion: "git:test-pv" });

    const row = db.query(`SELECT spec_json FROM runs`).get();
    expect(row).toBeTruthy();
    const planned = JSON.parse(row.spec_json);
    expect(planned.agent).toBe("reaper@1");
    expect(planned.adapter).toBe("command");
    expect(validate(registry.agents.get("reaper@1").inputSchema, planned.input).valid).toBe(true);

    const argv = resolveTemplate(registry.agents.get("reaper@1").command, planned.input);
    expect(argv).toEqual(["bun", REAPER_SCRIPT, "--apply"]);
    expect(existsSync(argv[1])).toBe(true);

    // The shipped template includes --apply (Linear writes). Prove execute()
    // with the planned tick's input actually spawns, using the same
    // {factoryRoot} placeholder against the real script path.
    const workspaceDir = ws();
    const outcome = await execute({
      spec: planned,
      def: { ref: "reaper@1", command: ["test", "-f", "{factoryRoot}/orchestrator/reaper.mjs"] },
      workspaceDir,
      timeoutMs: 5000,
    });
    expect(outcome).toEqual({ exitCode: 0, timedOut: false });
    const result = JSON.parse(readFileSync(path.join(workspaceDir, "result.json"), "utf8"));
    expect(result.artifact.command).toEqual(["test", "-f", REAPER_SCRIPT]);
  });
});

describe("sandboxed execution (WM-185)", () => {
  const sandboxDef = (command, extra = {}) => ({
    ref: "sandboxed-cmd@1",
    command,
    sandbox: { provider: "gondolin", allowedHosts: [] },
    ...extra,
  });

  test("a sandboxed definition must name an absolute guest path", async () => {
    // Array-form exec inside the guest does not search $PATH, and a host path
    // like /opt/homebrew/bin/bun does not exist in the Alpine guest — so a
    // bare "bun" would fail deep inside the VM with a useless message.
    await expect(
      execute({ spec: spec({}), def: sandboxDef(["bun", "--version"]), workspaceDir: ws(), timeoutMs: 5000 }),
    ).rejects.toThrow(/must start with an absolute guest path/);
  });

  test("an invalid sandbox policy is refused before any VM is booted", async () => {
    await expect(
      execute({
        spec: spec({}),
        def: sandboxDef(["/bin/true"], { sandbox: { provider: "firecracker" } }),
        workspaceDir: ws(),
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/unknown sandbox provider/);
  });

  test("goes through the shared sandbox seam (WM-313): the stubbed VM boundary sees the argv, and the result contract plus console artifact are written on the host", async () => {
    expect(SANDBOX_SUPPORT).toBe("gondolin");
    const workspaceDir = ws();
    const trace = [];
    let seen;
    const outcome = await execute({
      spec: spec({}),
      def: sandboxDef(["/bin/echo", "hi"], { captureStdout: "out.txt" }),
      workspaceDir,
      timeoutMs: 5000,
      onTrace: (kind, payload) => trace.push({ kind, payload }),
      runSandbox: async (request) => {
        seen = request;
        request.onStdout("hi\n");
        return { exitCode: 0, timedOut: false, bootMs: 9 };
      },
    });
    expect(outcome).toEqual({ exitCode: 0, timedOut: false });
    // No stdin wrapping for the command adapter: the argv runs as declared, no shell.
    expect(seen.command).toEqual(["/bin/echo", "hi"]);
    expect(seen.policy).toEqual({ provider: "gondolin", allowedHosts: [] });
    expect(seen.workspaceDir).toBe(workspaceDir);
    const result = JSON.parse(readFileSync(path.join(workspaceDir, "result.json"), "utf8"));
    expect(result.artifact.command).toEqual(["/bin/echo", "hi"]);
    expect(result.artifact.outputTail).toContain("hi");
    expect(readFileSync(path.join(workspaceDir, "out.txt"), "utf8")).toBe("hi\n");
    expect(readFileSync(path.join(workspaceDir, SANDBOX_CONSOLE_FILE), "utf8")).toContain("adapter=command");
    expect(trace.some((t) => t.kind === "lifecycle" && t.payload.note === "sandbox_console")).toBe(true);
  });

  test("a cancelled sandboxed command resolves like a cancelled host command: null exit, not timed out", async () => {
    const ac = new AbortController();
    const pending = execute({
      spec: spec({}),
      def: sandboxDef(["/bin/sleep", "60"]),
      workspaceDir: ws(),
      timeoutMs: 60_000,
      abortSignal: ac.signal,
      runSandbox: ({ abortSignal }) =>
        new Promise((_, reject) => {
          abortSignal.addEventListener("abort", () => reject(Object.assign(new Error("runner exited (null)"), { code: "sandbox_runner_crashed" })));
        }),
    });
    setTimeout(() => ac.abort(), 5);
    expect(await pending).toEqual({ exitCode: null, timedOut: false });
  });

  const report = preflight();
  const itVM = report.available ? test : test.skip;

  itVM(
    "produces the same result contract as the host path, from inside the VM",
    async () => {
      const workspaceDir = ws();
      const def = sandboxDef(["/bin/sh", "-c", "echo sandboxed-output > /workspace/captured.txt; echo sandboxed-output"], {
        captureStdout: "captured.txt",
      });

      const outcome = await execute({ spec: spec({}), def, workspaceDir, timeoutMs: 120_000 });
      expect(outcome).toEqual({ exitCode: 0, timedOut: false });

      // result.json is written on the host, with the same shape the
      // unsandboxed path produces — downstream verification cannot tell which
      // path ran, which is the point.
      const result = JSON.parse(readFileSync(path.join(workspaceDir, "result.json"), "utf8"));
      expect(result.schemaVersion).toBe("factory.agent-result/v1");
      expect(result.terminalState).toBe("completed");
      expect(result.artifact.exitCode).toBe(0);
      expect(result.artifact.outputTail).toContain("sandboxed-output");
      expect(result.artifacts).toEqual([{ kind: "output", path: "captured.txt" }]);
      // The guest wrote this file through the mount; the host must see it.
      expect(readFileSync(path.join(workspaceDir, "captured.txt"), "utf8")).toContain("sandboxed-output");
    },
    180_000,
  );

  itVM(
    "a nonzero guest exit writes no result, exactly like the host path",
    async () => {
      const workspaceDir = ws();
      const outcome = await execute({
        spec: spec({}),
        def: sandboxDef(["/bin/sh", "-c", "exit 3"]),
        workspaceDir,
        timeoutMs: 120_000,
      });
      expect(outcome).toEqual({ exitCode: 3, timedOut: false });
      expect(existsSync(path.join(workspaceDir, "result.json"))).toBe(false);
    },
    180_000,
  );
});
