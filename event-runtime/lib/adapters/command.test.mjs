import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execute, resolveTemplate } from "./command.mjs";

const def = (command) => ({ ref: "test-cmd@1", command });
const spec = (input) => ({ input });
const ws = () => mkdtempSync(path.join(os.tmpdir(), "evrt-cmd-"));

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
});
