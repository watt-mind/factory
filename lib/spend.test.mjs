import { test, expect } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
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
  const logDir = path.join(root, "not-a-directory");
  writeFileSync(logDir, "not a directory", "utf8");
  try {
    const breakdown = todaysSpendBreakdown(logDir);
    expect(breakdown).toMatchObject({
      usd: 0,
      reported: 0,
      estimated: 0,
      runs: 0,
      scanned: false,
    });
    expect(breakdown.error).toContain("not a directory");
    expect(budgetExhausted(policy(100), logDir)).toMatch(
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
    path.join(logDir, "z-good.jsonl"),
    jsonl({
      type: "result",
      total_cost_usd: 1.25,
      num_turns: 1,
    }),
    "utf8",
  );
  const unreadable = path.join(logDir, "a-unreadable.jsonl");
  writeFileSync(unreadable, "not readable", "utf8");
  chmodSync(unreadable, 0o000);
  try {
    const breakdown = todaysSpendBreakdown(logDir);
    expect(breakdown.scanned).toBe(false);
    expect(breakdown.error).toBeTruthy();
    expect(breakdown.usd).toBeGreaterThanOrEqual(0);
    expect(budgetExhausted(policy(100), logDir)).toMatch(
      /unreadable log directory/,
    );
  } finally {
    chmodSync(unreadable, 0o600);
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
