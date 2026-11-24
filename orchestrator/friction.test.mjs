import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const jsonl = (...events) =>
  events.map((e) => JSON.stringify(e)).join("\n") + "\n";

test("friction.mjs --brain-only --brain-dir <tmp> --json mines interactive brain transcripts", () => {
  const root = mkdtempSync(path.join(tmpdir(), "factory-friction-brain-"));
  try {
    const convA = path.join(root, "conv-alpha", ".system_generated", "logs");
    const convB = path.join(root, "conv-beta", ".system_generated", "logs");
    mkdirSync(convA, { recursive: true });
    mkdirSync(convB, { recursive: true });

    writeFileSync(
      path.join(convA, "transcript.jsonl"),
      jsonl(
        {
          type: "USER_INPUT",
          content: "Fix lint",
          created_at: "2026-11-24T10:00:00Z",
        },
        {
          type: "PLANNER_RESPONSE",
          input_tokens: 1000,
          cache_read_tokens: 5000,
          output_tokens: 200,
          created_at: "2026-11-24T10:00:05Z",
          tool_calls: [
            { name: "run_command", args: { CommandLine: '"bun run lint"' } },
            { name: "run_command", args: { CommandLine: '"bun run lint"' } },
          ],
        },
        {
          type: "GENERIC",
          status: "DONE",
          created_at: "2026-11-24T10:00:07Z",
          content:
            "Command exited with code 1.\n\nCommand output:\n/repo/a.mjs:10 error no-undef",
        },
        {
          type: "GENERIC",
          status: "DONE",
          created_at: "2026-11-24T10:00:09Z",
          content: "Command exited with code 0.\n\nCommand output:\nok",
        },
      ),
    );

    writeFileSync(
      path.join(convB, "transcript.jsonl"),
      jsonl(
        {
          type: "USER_INPUT",
          content: "Fix lint again",
          created_at: "2026-11-24T11:00:00Z",
        },
        {
          type: "PLANNER_RESPONSE",
          input_tokens: 800,
          output_tokens: 150,
          created_at: "2026-11-24T11:00:05Z",
          tool_calls: [
            { name: "run_command", args: { CommandLine: '"bun run lint"' } },
          ],
        },
        {
          type: "GENERIC",
          status: "DONE",
          created_at: "2026-11-24T11:00:08Z",
          content:
            "Command exited with code 1.\n\nCommand output:\n/repo/b.mjs:42 error no-undef",
        },
      ),
    );

    const script = path.join(import.meta.dir, "friction.mjs");
    const proc = Bun.spawnSync(
      ["bun", script, "--brain-only", "--brain-dir", root, "--json"],
      { stdout: "pipe", stderr: "pipe" },
    );

    expect(proc.exitCode).toBe(0);
    const out = JSON.parse(proc.stdout.toString());

    expect(out.runs).toHaveLength(2);
    expect(out.runs.every((r) => r.harness === "agy-brain")).toBe(true);
    expect(out.runs.map((r) => r.file).sort()).toEqual([
      "brain:conv-alpha",
      "brain:conv-beta",
    ]);

    expect(out.errors).toHaveLength(1);
    expect(out.errors[0].tool).toBe("run_command");
    expect(out.errors[0].count).toBe(2);
    expect(out.errors[0].runs).toBe(2);

    expect(out.repeats).toEqual([
      { cmd: "bun run lint", count: 2, runs: 1 },
    ]);

    const filtered = Bun.spawnSync(
      [
        "bun",
        script,
        "--brain-only",
        "--brain-dir",
        root,
        "--run",
        "conv-alpha",
        "--json",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(filtered.exitCode).toBe(0);
    const filteredOut = JSON.parse(filtered.stdout.toString());
    expect(filteredOut.runs).toHaveLength(1);
    expect(filteredOut.runs[0].file).toBe("brain:conv-alpha");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
