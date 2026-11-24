import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
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

    expect(out.repeats).toEqual([{ cmd: "bun run lint", count: 2, runs: 1 }]);

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

test("friction.mjs --sources claude,codex,t3code mines multi-harness sessions and T3Code v2 SQLite", () => {
  const root = mkdtempSync(path.join(tmpdir(), "factory-friction-multi-"));
  try {
    const claudeDir = path.join(root, "claude", "-Users-dev-repo");
    const codexDir = path.join(root, "codex", "2026", "11", "24");
    const t3DbPath = path.join(root, "statev2.sqlite");
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(codexDir, { recursive: true });

    // Interactive Claude session fixture
    writeFileSync(
      path.join(claudeDir, "sess-1.jsonl"),
      jsonl(
        {
          type: "user",
          sessionId: "sess-1",
          timestamp: "2026-11-24T10:00:00.000Z",
          message: { role: "user", content: "Run lint" },
        },
        {
          type: "assistant",
          sessionId: "sess-1",
          timestamp: "2026-11-24T10:00:02.000Z",
          message: {
            role: "assistant",
            usage: { input_tokens: 500, output_tokens: 100 },
            content: [
              {
                type: "tool_use",
                id: "tu1",
                name: "Bash",
                input: { command: "bun run lint" },
              },
              {
                type: "tool_use",
                id: "tu2",
                name: "Bash",
                input: { command: "bun run lint" },
              },
            ],
          },
        },
        {
          type: "user",
          sessionId: "sess-1",
          timestamp: "2026-11-24T10:00:04.000Z",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tu1",
                is_error: true,
                content: "/repo/a.mjs:12 error no-unused-vars",
              },
              {
                type: "tool_result",
                tool_use_id: "tu2",
                is_error: false,
                content: "ok",
              },
            ],
          },
        },
      ),
    );

    // Interactive Codex session fixture
    writeFileSync(
      path.join(codexDir, "rollout-2026-11-24-codex1.jsonl"),
      jsonl(
        {
          timestamp: "2026-11-24T11:00:00.000Z",
          type: "session_meta",
          payload: { id: "codex1", cwd: "/repo" },
        },
        {
          timestamp: "2026-11-24T11:00:01.000Z",
          type: "turn_context",
          payload: { turn_id: "t1", model: "gpt-6.2-sol" },
        },
        {
          timestamp: "2026-11-24T11:00:02.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            call_id: "c1",
            arguments: JSON.stringify({ cmd: "bun test" }),
          },
        },
        {
          timestamp: "2026-11-24T11:00:04.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "c1",
            output: "Exit code: 1\nOutput:\nFAIL /repo/foo.test.mjs\n",
          },
        },
        {
          timestamp: "2026-11-24T11:00:05.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            call_id: "c2",
            arguments: JSON.stringify({ cmd: "bun test" }),
          },
        },
        {
          timestamp: "2026-11-24T11:00:07.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "c2",
            output: "Exit code: 0\nOutput:\n1 pass\n",
          },
        },
        {
          timestamp: "2026-11-24T11:00:08.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 1000,
                cached_input_tokens: 600,
                output_tokens: 50,
              },
            },
          },
        },
      ),
    );

    // T3Code v2 SQLite fixture
    const db = new Database(t3DbPath);
    db.exec(`
      CREATE TABLE orchestration_v2_projection_threads (
        thread_id TEXT PRIMARY KEY,
        title TEXT NOT NULL
      );
      CREATE TABLE orchestration_v2_projection_runs (
        run_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        provider TEXT NOT NULL,
        status TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        completed_at TEXT,
        payload_json TEXT NOT NULL
      );
      CREATE TABLE orchestration_v2_command_receipts (
        command_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        command_type TEXT NOT NULL,
        accepted_at TEXT NOT NULL,
        result_sequence INTEGER NOT NULL,
        status TEXT NOT NULL,
        error TEXT
      );
    `);
    const nowIso = new Date().toISOString();
    const oldIso = "2020-01-01T00:00:00.000Z";
    db.query(
      "INSERT INTO orchestration_v2_projection_threads (thread_id, title) VALUES (?, ?)",
    ).run("th-1", "Fix desktop upload");
    db.query(
      "INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, completed_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("run-1", "th-1", 1, "codex", "completed", nowIso, nowIso, "{}");
    db.query(
      "INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, completed_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("run-2", "th-1", 2, "claude", "failed", nowIso, nowIso, "{}");
    db.query(
      "INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, completed_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("run-3", "th-1", 3, "codex", "interrupted", nowIso, nowIso, "{}");
    db.query(
      "INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, completed_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("run-old", "th-1", 0, "codex", "failed", oldIso, oldIso, "{}");
    db.query(
      "INSERT INTO orchestration_v2_command_receipts (command_id, thread_id, command_type, accepted_at, result_sequence, status, error) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "cmd-1",
      "th-1",
      "thread.pull-request.sync",
      nowIso,
      1,
      "rejected",
      "Failed to dispatch command 123",
    );
    db.query(
      "INSERT INTO orchestration_v2_command_receipts (command_id, thread_id, command_type, accepted_at, result_sequence, status, error) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "cmd-2",
      "th-1",
      "thread.pull-request.sync",
      nowIso,
      2,
      "rejected",
      "Failed to dispatch command 456",
    );
    db.query(
      "INSERT INTO orchestration_v2_command_receipts (command_id, thread_id, command_type, accepted_at, result_sequence, status, error) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("cmd-3", "th-1", "message.dispatch", nowIso, 3, "accepted", null);
    db.close();

    const script = path.join(import.meta.dir, "friction.mjs");
    const proc = Bun.spawnSync(
      [
        "bun",
        script,
        "--sources",
        "claude,codex,t3code",
        "--claude-dir",
        path.join(root, "claude"),
        "--codex-dir",
        path.join(root, "codex"),
        "--t3-db",
        t3DbPath,
        "--since",
        "7d",
        "--json",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    expect(proc.exitCode).toBe(0);
    const out = JSON.parse(proc.stdout.toString());

    expect(out.runs).toHaveLength(2);
    expect(out.runs.map((r) => r.harness).sort()).toEqual([
      "claude",
      "codex-session",
    ]);
    expect(out.runs.map((r) => r.file).sort()).toEqual([
      "claude:sess-1",
      "codex:rollout-2026-11-24-codex1",
    ]);

    expect(out.errors).toHaveLength(2);
    expect(out.errors.map((e) => e.tool).sort()).toEqual([
      "Bash",
      "exec_command",
    ]);

    expect(out.repeats.map((r) => r.cmd).sort()).toEqual([
      "bun run lint",
      "bun test",
    ]);

    expect(out.t3code).toBeDefined();
    expect(out.t3code.totalRuns).toBe(3); // run-old filtered out by --since 7d
    expect(out.t3code.statusCounts).toEqual({
      completed: 1,
      failed: 1,
      interrupted: 1,
    });
    expect(out.t3code.problemRuns).toHaveLength(2);
    expect(out.t3code.problemRuns[0].threadTitle).toBe("Fix desktop upload");
    expect(out.t3code.rejectedReceiptsCount).toBe(2);
    expect(out.t3code.rejectedReceipts).toHaveLength(1);
    expect(out.t3code.rejectedReceipts[0].commandType).toBe(
      "thread.pull-request.sync",
    );
    expect(out.t3code.rejectedReceipts[0].count).toBe(2);

    // Graceful skip when T3Code DB is missing
    const missingDbProc = Bun.spawnSync(
      [
        "bun",
        script,
        "--sources",
        "claude,t3code",
        "--claude-dir",
        path.join(root, "claude"),
        "--t3-db",
        path.join(root, "does-not-exist.sqlite"),
        "--json",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(missingDbProc.exitCode).toBe(0);
    const missingOut = JSON.parse(missingDbProc.stdout.toString());
    expect(missingOut.runs).toHaveLength(1);
    expect(missingOut.t3code).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("friction.mjs rejects empty, missing, or invalid --sources values", () => {
  const script = path.join(import.meta.dir, "friction.mjs");
  for (const args of [
    ["--sources"],
    ["--sources", ""],
    ["--sources", ","],
    ["--sources", "--json"],
    ["--sources", "bogus"],
  ]) {
    const proc = Bun.spawnSync(["bun", script, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(1);
    expect(proc.stderr.toString().length).toBeGreaterThan(0);
  }
});
