import { describe, expect, test } from "bun:test";
import { inspect } from "./inspect.mjs";

describe("inspect command", () => {
  test("renders usage totals and per-attempt spend", async () => {
    const lines = [];
    const originalLog = console.log;
    console.log = (...args) => lines.push(args.join(" "));

    try {
      await inspect(
        {
          run: async () => ({
            run: {
              runId: "run-1",
              state: "COMPLETED",
              attempts: 1,
              created_at: "2026-01-01T00:00:00.000Z",
              updated_at: "2026-01-01T00:01:00.000Z",
              spec: {
                agent: "worker",
                adapter: "pi",
                outputContract: "factory.agent-result/v1",
                maxAttempts: 3,
              },
            },
            workspace: "/tmp/run-1",
            usage: {
              totals: {
                totalTokens: 30,
                inputTokens: 20,
                outputTokens: 10,
                cacheCreationInputTokens: 3,
                cacheReadInputTokens: 4,
                costUSD: 0.125,
              },
              attempts: [
                {
                  attempt: 1,
                  totalTokens: 30,
                  inputTokens: 20,
                  outputTokens: 10,
                  cacheCreationInputTokens: 3,
                  cacheReadInputTokens: 4,
                  costUSD: 0.125,
                  model: "test-model",
                  adapter: "pi",
                },
              ],
            },
            lifecycle: [],
            result: null,
            receipt: null,
          }),
        },
        "run-1",
      );
    } finally {
      console.log = originalLog;
    }

    const output = lines.join("\n");
    expect(output).toContain("usage");
    expect(output).toContain(
      "total      30 tokens   input 20   output 10   cache-write 3   cache-read 4   $0.1250",
    );
    expect(output).toContain(
      "attempt 1  30 tokens   input 20   output 10   cache-write 3   cache-read 4   $0.1250   model test-model   adapter pi",
    );
  });
});
