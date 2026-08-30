import { test, expect } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { budgetExhausted, todaysSpendBreakdown } from "./spend.mjs";

const jsonl = (...events) =>
  events.map((event) => JSON.stringify(event)).join("\n") + "\n";

const tempLogDir = () => mkdtempSync(path.join(tmpdir(), "factory-spend-"));

const policy = (perDay) => ({ budget: { per_day_usd: perDay } });

const permissionDenied = (target) => {
  const error = new Error(`EACCES: permission denied, open '${target}'`);
  error.code = "EACCES";
  return error;
};

test("missing log directory is an empty, explicitly unscanned day", () => {
  const logDir = path.join(tempLogDir(), "missing");
  try {
    expect(todaysSpendBreakdown(logDir)).toEqual({
      usd: 0,
      reported: 0,
      estimated: 0,
      runs: 0,
      scanned: false,
      reason: "no log directory",
    });
    expect(budgetExhausted(policy(1), logDir)).toBeNull();
  } finally {
    rmSync(path.dirname(logDir), { recursive: true, force: true });
  }
});

test("an unreadable log directory surfaces an error and closes the budget gate", () => {
  const root = tempLogDir();
  const logDir = path.join(root, "logs");
  mkdirSync(logDir);
  const stat = () => {
    throw permissionDenied(logDir);
  };
  try {
    const breakdown = todaysSpendBreakdown(logDir, { stat });
    expect(breakdown).toMatchObject({
      usd: 0,
      reported: 0,
      estimated: 0,
      runs: 0,
      scanned: false,
    });
    expect(breakdown.error).toContain("permission denied");
    expect(budgetExhausted(policy(100), logDir, { stat })).toMatch(
      /unreadable log directory/,
    );
    expect(budgetExhausted({}, logDir)).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a file read failure is surfaced and closes the budget gate", () => {
  const root = tempLogDir();
  const logDir = path.join(root, "logs");
  mkdirSync(logDir);
  writeFileSync(
    path.join(logDir, "first.jsonl"),
    jsonl({
      type: "result",
      total_cost_usd: 1.25,
      num_turns: 1,
    }),
    "utf8",
  );
  writeFileSync(
    path.join(logDir, "second.jsonl"),
    jsonl({
      type: "result",
      total_cost_usd: 2.5,
      num_turns: 1,
    }),
    "utf8",
  );
  let reads = 0;
  const readFile = (...args) => {
    if (reads++ === 1) throw permissionDenied(args[0]);
    return readFileSync(...args);
  };
  try {
    const breakdown = todaysSpendBreakdown(logDir, { readFile });
    expect(breakdown.scanned).toBe(false);
    expect(breakdown.error).toContain("permission denied");
    expect(breakdown).toMatchObject({
      estimated: 0,
      runs: 1,
    });
    expect(breakdown.reported === 1.25 || breakdown.reported === 2.5).toBe(
      true,
    );
    expect(breakdown.usd).toBe(breakdown.reported);

    reads = 0;
    expect(budgetExhausted(policy(100), logDir, { readFile })).toMatch(
      /unreadable log directory/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a clean fixture scan reports today's totals and scanned true", () => {
  const root = tempLogDir();
  const logDir = path.join(root, "logs");
  mkdirSync(logDir);
  writeFileSync(
    path.join(logDir, "factory-CLNT-1-today.jsonl"),
    jsonl(
      {
        type: "assistant",
        message: {
          usage: { input_tokens: 100, output_tokens: 50 },
          content: [],
        },
      },
      { type: "result", total_cost_usd: 1.25, num_turns: 2 },
    ),
    "utf8",
  );
  try {
    expect(todaysSpendBreakdown(logDir)).toMatchObject({
      usd: 1.25,
      reported: 1.25,
      estimated: 0,
      runs: 1,
      scanned: true,
    });
    expect(budgetExhausted(policy(2), logDir)).toBeNull();
    expect(budgetExhausted(policy(1), logDir)).toBe(
      "day budget spent (~$1.25 of $1 notional)",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
