/**
 * bun test
 *
 * The parser is the one piece whose failure mode is SILENT: a schema it does not
 * understand reads as "0 turns, $0, no result", which is indistinguishable from a
 * harness that genuinely did nothing. That is how 35% of runs stayed invisible to
 * the budget gate for two days. So every harness gets a fixture, and the
 * assertion that matters is that a non-Claude run produces non-zero numbers.
 */
import { test, expect } from "bun:test";
import {
  parseRun,
  identify,
  messageSignature,
  errorSignature,
  estimateUSD,
  parseDuration,
} from "./transcript.mjs";

const jsonl = (...events) =>
  events.map((e) => JSON.stringify(e)).join("\n") + "\n";

// ------------------------------------------------------------- duration ---
test("parseDuration supports seconds, minutes, hours, days, and weeks", () => {
  expect(parseDuration("10s")).toBe(10_000);
  expect(parseDuration("30m")).toBe(1_800_000);
  expect(parseDuration("2h")).toBe(7_200_000);
  expect(parseDuration("3d")).toBe(259_200_000);
  expect(parseDuration("2w")).toBe(1_209_600_000);
});

test("parseDuration defaults unitless integers to days", () => {
  expect(parseDuration("7")).toBe(604_800_000);
});

test("parseDuration rejects invalid or unsafe values", () => {
  for (const value of ["", "nope", "1.5h", "-2d", "10ms"]) {
    expect(() => parseDuration(value)).toThrow(/invalid duration/);
  }
  expect(() => parseDuration("999999999999999999999d")).toThrow(/too large/);
});

// ------------------------------------------------------------- identify ---
test("identify pulls repo, stage and ticket out of the log filename", () => {
  expect(identify("bj29-CLNT-616-20260804-101500.jsonl")).toEqual({
    repo: "bj29",
    stage: "ticket",
    ticket: "CLNT-616",
  });
  expect(identify("legalease-factory-merge-20260804-211936.jsonl")).toEqual({
    repo: "legalease",
    stage: "factory-merge",
    ticket: null,
  });
  // Dispatch writes a trailing dot before the extension; it must not leak into the stage.
  expect(identify("cashsaas-CLNT-902-20260804191509..jsonl").ticket).toBe(
    "CLNT-902",
  );
  // Absolute path handling (WM-254)
  expect(
    identify(
      "/Users/hdkiller/.factory/logs/bj29-CLNT-616-20260804-101500.jsonl",
    ),
  ).toEqual({ repo: "bj29", stage: "ticket", ticket: "CLNT-616" });
  expect(identify("/path/to/repo-TICKET-date.jsonl").repo).toBe("repo");
});

// --------------------------------------------------------------- claude ---
test("claude: usage, tools, cost and verdict", () => {
  const run = parseRun(
    "bj29-CLNT-1-x.jsonl",
    jsonl(
      {
        type: "assistant",
        message: {
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 9000,
            cache_creation_input_tokens: 300,
          },
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "Bash",
              input: { command: "git status" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: "on branch main",
            },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 7,
        total_cost_usd: 1.25,
        duration_ms: 60000,
      },
    ),
  );
  expect(run.harness).toBe("claude");
  expect(run.in).toBe(100);
  expect(run.cacheRead).toBe(9000);
  expect(run.cacheWrite).toBe(300);
  expect(run.cost).toBe(1.25);
  expect(run.turns).toBe(7);
  expect(run.tools).toBe(1);
  expect(run.ok).toBe(true);
  expect(run.wasted).toBe(false);
});

test("claude: an errored tool result is counted and grouped by shape", () => {
  const run = parseRun(
    "bj29-CLNT-2-x.jsonl",
    jsonl(
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "Read",
              input: { file_path: "/a/b.md" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              is_error: true,
              content: "File does not exist: /a/b.md",
            },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 1,
        total_cost_usd: 0.1,
      },
    ),
  );
  expect(run.errors).toBe(1);
  expect([...run.errorSigs.keys()][0]).toStartWith("Read|");
});

test("claude: an Unknown command reply is a failure, not a success", () => {
  const run = parseRun(
    "bj29-factory-ticket-x.jsonl",
    jsonl({
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 1,
      result: "Unknown command: /factory-ticket",
    }),
  );
  expect(run.ok).toBe(false);
  expect(run.error).toBe("Unknown command: /factory-ticket");
});

// ---------------------------------------------------------------- codex ---
test("codex: token usage is recorded and input excludes the cached part", () => {
  // Codex's input_tokens INCLUDES cached_input_tokens, unlike Claude's disjoint
  // fields. Double-counting here makes the cache ratio read as perfect.
  const run = parseRun(
    "bj29-CLNT-603-x.jsonl",
    jsonl(
      {
        type: "item.started",
        item: { type: "command_execution", command: "npm test" },
      },
      {
        type: "item.completed",
        item: {
          type: "command_execution",
          aggregated_output: "ok",
          exit_code: 0,
        },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 1_291_572,
          cached_input_tokens: 1_223_424,
          cache_write_input_tokens: 0,
          output_tokens: 6591,
          reasoning_output_tokens: 2044,
        },
      },
    ),
  );
  expect(run.harness).toBe("codex");
  expect(run.in).toBe(1_291_572 - 1_223_424);
  expect(run.cacheRead).toBe(1_223_424);
  expect(run.out).toBe(6591 + 2044);
  expect(run.tools).toBe(1);
  expect(run.ok).toBe(true);
});

test("codex: cumulative usage snapshots replace prior turns", () => {
  const run = parseRun(
    "bj29-CLNT-276-x.jsonl",
    jsonl(
      {
        type: "turn.completed",
        usage: {
          input_tokens: 100,
          cached_input_tokens: 60,
          cache_write_input_tokens: 10,
          output_tokens: 20,
          reasoning_output_tokens: 5,
        },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 250,
          cached_input_tokens: 150,
          cache_write_input_tokens: 25,
          output_tokens: 50,
          reasoning_output_tokens: 15,
        },
      },
    ),
  );
  expect(run.turns).toBe(2);
  expect(run.in).toBe(100);
  expect(run.cacheRead).toBe(150);
  expect(run.cacheWrite).toBe(25);
  expect(run.out).toBe(65);
});

test("codex: a non-zero exit code counts as an error", () => {
  const run = parseRun(
    "bj29-CLNT-4-x.jsonl",
    jsonl(
      {
        type: "item.started",
        item: { type: "command_execution", command: "npm test" },
      },
      {
        type: "item.completed",
        item: {
          type: "command_execution",
          aggregated_output: "1 failing",
          exit_code: 1,
        },
      },
      {
        type: "turn.completed",
        usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 },
      },
    ),
  );
  expect(run.errors).toBe(1);
});

test("codex: a run killed before turn.completed is truncated, not merely quiet", () => {
  const run = parseRun(
    "legalease-factory-merge-x.jsonl",
    jsonl({
      type: "item.started",
      item: { type: "command_execution", command: "gh pr checks 186 --watch" },
    }),
  );
  expect(run.truncated).toBe(true);
  expect(run.wasted).toBe(true);
  expect(run.harness).toBe("codex");
});

// ------------------------------------------------------------------ agy ---
test("agy: a quota error is captured with the wall clock it burned", () => {
  const run = parseRun(
    "bj29-factory-merge-x.jsonl",
    jsonl(
      {
        event: "init",
        conversation_id: "abc",
        init: { tools: ["run_command"] },
      },
      {
        event: "result",
        result: {
          status: "ERROR",
          response: "",
          error: "Individual quota reached. Resets in 44h1m15s.",
          duration_seconds: 600.66,
          num_turns: 1,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
    ),
  );
  expect(run.harness).toBe("agy");
  expect(run.ok).toBe(false);
  expect(run.durMs).toBeCloseTo(600660, 0);
  expect(run.error).toContain("quota reached");
});

test("agy: an init-only transcript is truncated", () => {
  const run = parseRun(
    "bj29-factory-triage-x.jsonl",
    jsonl({ event: "init", conversation_id: "abc", init: { tools: [] } }),
  );
  expect(run.harness).toBe("agy");
  expect(run.truncated).toBe(true);
});

// ------------------------------------------------------------ agy-brain ---
test("agy-brain: parses tool calls, JSON-quoted CommandLine, tokens, cost, and duration", () => {
  const run = parseRun(
    "brain:conv-123",
    jsonl(
      {
        type: "USER_INPUT",
        content: "Run tests and check status",
        created_at: "2026-11-24T20:00:00Z",
      },
      {
        type: "PLANNER_RESPONSE",
        model: "gemini-4-neon-medium",
        created_at: "2026-11-24T20:00:05Z",
        input_tokens: 10_000,
        cache_read_tokens: 40_000,
        output_tokens: 500,
        tool_calls: [
          {
            name: "run_command",
            args: { CommandLine: '"git status --short"' },
          },
          {
            name: "read_file",
            args: { Path: '"/repo/lib/transcript.mjs"' },
          },
        ],
      },
      {
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-11-24T20:00:07Z",
        content:
          "Created At: 2026-11-24T21:00:05+01:00\nCompleted At: 2026-11-24T21:00:07+01:00\nCommand exited with code 0.\n\nCommand output:\nM lib/transcript.mjs\n",
      },
      {
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-11-24T20:00:08Z",
        content: "Showing lines 1-10 of 10\nexport function parseRun() {}",
      },
      {
        type: "PLANNER_RESPONSE",
        model: "gemini-4-neon-medium",
        created_at: "2026-11-24T20:01:00Z",
        input_tokens: 2_000,
        cache_read_tokens: 50_000,
        output_tokens: 300,
        tool_calls: [
          {
            name: "run_command",
            args: { CommandLine: '"git status --short"' },
          },
        ],
      },
      {
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-11-24T20:01:02Z",
        content: "Command exited with code 0\n\nCommand output:\n",
      },
    ),
  );
  expect(run.harness).toBe("agy-brain");
  expect(run.ok).toBe(true);
  expect(run.truncated).toBe(false);
  expect(run.wasted).toBe(false);
  expect(run.turns).toBe(2);
  expect(run.tools).toBe(3);
  expect(run.toolCalls.get("run_command")).toBe(2);
  expect(run.toolCalls.get("read_file")).toBe(1);
  expect(run.commands.get("git status --short")).toBe(2);
  expect(run.in).toBe(12_000);
  expect(run.cacheRead).toBe(90_000);
  expect(run.out).toBe(800);
  expect(run.cost).toBe(0);
  expect(run.estCost).toBeCloseTo(estimateUSD(run), 10);
  expect(run.estCost).toBeGreaterThan(0);
  expect(run.durMs).toBe(62_000);
  expect(run.errors).toBe(0);
});

test("agy-brain: non-zero exit codes and GENERIC errors produce normalised error signatures", () => {
  const run = parseRun(
    "brain:conv-err",
    jsonl(
      {
        type: "USER_INPUT",
        content: "Run lint",
        created_at: "2026-11-24T20:00:00Z",
      },
      {
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-24T20:00:02Z",
        input_tokens: 500,
        output_tokens: 100,
        tool_calls: [
          { name: "run_command", args: { CommandLine: '"bun run lint"' } },
          { name: "run_command", args: { CommandLine: '"bun run lint"' } },
          { name: "edit_file", args: { Path: '"/repo/a.mjs"' } },
        ],
      },
      {
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-11-24T20:00:05Z",
        content:
          "Created At: 2026-11-24T21:00:02+01:00\nCompleted At: 2026-11-24T21:00:05+01:00\nCommand exited with code 1.\n\nCommand output:\n/Users/a/repo/foo.mjs:12:3 error no-unused-vars\n",
      },
      {
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-11-24T20:00:08Z",
        content:
          "Created At: 2026-11-24T21:00:05+01:00\nCompleted At: 2026-11-24T21:00:08+01:00\nCommand exited with code 1\n\nCommand output:\n/Users/b/other/bar.mjs:99:1 error no-unused-vars\n",
      },
      {
        type: "GENERIC",
        status: "ERROR",
        error: "target text not found in /repo/a.mjs",
        created_at: "2026-11-24T20:00:10Z",
        content: "Encountered error in step execution",
      },
    ),
  );
  expect(run.harness).toBe("agy-brain");
  expect(run.errors).toBe(3);
  expect(run.commands.get("bun run lint")).toBe(2);
  const sigs = [...run.errorSigs.entries()];
  const lintSig = sigs.find(([k]) => k.startsWith("run_command|"));
  expect(lintSig).toBeDefined();
  expect(lintSig[1].count).toBe(2);
  expect(lintSig[1].sample).toContain("no-unused-vars");
  const editSig = sigs.find(([k]) => k.startsWith("edit_file|"));
  expect(editSig).toBeDefined();
  expect(editSig[1].count).toBe(1);
});

test("agy-brain: ERROR_MESSAGE records harness failure and error signature", () => {
  const run = parseRun(
    "brain:conv-fail",
    jsonl(
      {
        type: "USER_INPUT",
        content: "Do work",
        created_at: "2026-11-24T20:00:00Z",
      },
      {
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-24T20:00:02Z",
        input_tokens: 100,
        output_tokens: 20,
        tool_calls: [],
      },
      {
        type: "ERROR_MESSAGE",
        error: "API error (attempt 1): connection reset by peer",
        created_at: "2026-11-24T20:00:10Z",
      },
    ),
  );
  expect(run.harness).toBe("agy-brain");
  expect(run.ok).toBe(false);
  expect(run.wasted).toBe(true);
  expect(run.errors).toBe(1);
  expect(run.error).toContain("connection reset by peer");
  expect([...run.errorSigs.keys()][0]).toStartWith("ERROR_MESSAGE|");
  expect(run.durMs).toBe(10_000);
});

test("agy-brain: read_file containing 'Command exited with code 1' is not a false error", () => {
  const run = parseRun(
    "brain:conv-read-false-pos",
    jsonl(
      {
        type: "USER_INPUT",
        content: "Read test file",
        created_at: "2026-11-24T20:00:00Z",
      },
      {
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-24T20:00:01Z",
        input_tokens: 100,
        output_tokens: 20,
        tool_calls: [
          { name: "read_file", args: { Path: '"/repo/lib/transcript.test.mjs"' } },
        ],
      },
      {
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-11-24T20:00:02Z",
        content:
          'Created At: 2026-11-24T21:00:01+01:00\nCompleted At: 2026-11-24T21:00:02+01:00\nShowing lines 1-5 of 5\n1: // fixture: Command exited with code 1\n',
      },
    ),
  );
  expect(run.harness).toBe("agy-brain");
  expect(run.errors).toBe(0);
  expect(run.errorSigs.size).toBe(0);
});

test("agy-brain: transient ERROR_MESSAGE followed by PLANNER_RESPONSE clears stale run.error", () => {
  const run = parseRun(
    "brain:conv-recover",
    jsonl(
      {
        type: "USER_INPUT",
        content: "Retry work",
        created_at: "2026-11-24T20:00:00Z",
      },
      {
        type: "ERROR_MESSAGE",
        error: "API error (attempt 1): transient timeout",
        created_at: "2026-11-24T20:00:03Z",
      },
      {
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-24T20:00:06Z",
        input_tokens: 200,
        output_tokens: 50,
        tool_calls: [],
      },
    ),
  );
  expect(run.harness).toBe("agy-brain");
  expect(run.ok).toBe(true);
  expect(run.error).toBeNull();
  expect(run.errors).toBe(1);
});

// ------------------------------------------------------------ weighting ---
test("a payload is weighted by the turns it stayed in the context window", () => {
  // 1000 bytes read at tool call 1, with 3 more calls after it, is re-sent
  // roughly 3 times. Raw payload alone would rank this the same as a 1000-byte
  // result on the very last call, which costs nothing further.
  const run = parseRun(
    "bj29-CLNT-5-x.jsonl",
    jsonl(
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "Read",
              input: { file_path: "/big.png" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: "x".repeat(1000),
            },
          ],
        },
      },
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "t2",
              name: "Bash",
              input: { command: "ls" },
            },
          ],
        },
      },
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "t3",
              name: "Bash",
              input: { command: "pwd" },
            },
          ],
        },
      },
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "t4",
              name: "Bash",
              input: { command: "id" },
            },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 4,
        total_cost_usd: 0.1,
      },
    ),
  );
  expect(run.resultBytes).toBe(1000);
  expect(run.weightedBytes).toBe(3000);
  expect(run.toolResultBytes.get("Read").weighted).toBe(3000);
});

// ------------------------------------------------------------ signatures ---
test("errorSignature collapses paths, shas and numbers so one bug counts once", () => {
  const a = errorSignature(
    "File does not exist: /Users/x/repo/a.md at line 42",
  );
  const b = errorSignature(
    "File does not exist: /Users/y/other/b.md at line 7",
  );
  expect(a).toBe(b);
});

test("messageSignature keeps the command name that errorSignature would erase", () => {
  expect(messageSignature("Unknown command: /factory-ticket")).toContain(
    "/factory-ticket",
  );
  expect(messageSignature("quota reached. Resets in 44h1m15s.")).toBe(
    messageSignature("quota reached. Resets in 44h21m16s."),
  );
});

// -------------------------------------------------------------- pricing ---
test("a harness reporting no cost is still priced, so the budget gate sees it", () => {
  const run = parseRun(
    "bj29-CLNT-6-x.jsonl",
    jsonl({
      type: "turn.completed",
      usage: {
        input_tokens: 1_000_000,
        cached_input_tokens: 900_000,
        output_tokens: 10_000,
      },
    }),
  );
  expect(run.cost).toBe(0);
  expect(run.estCost).toBeGreaterThan(0);
  expect(run.estCost).toBeCloseTo(estimateUSD(run), 10);
});

test("a claude run keeps its reported cost rather than the estimate", () => {
  const run = parseRun(
    "bj29-CLNT-7-x.jsonl",
    jsonl(
      {
        type: "assistant",
        message: {
          usage: { input_tokens: 1000, output_tokens: 10 },
          content: [],
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 1,
        total_cost_usd: 3.5,
      },
    ),
  );
  expect(run.estCost).toBe(3.5);
});
