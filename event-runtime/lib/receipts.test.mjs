import { describe, expect, test } from "bun:test";
import { createReceipt } from "./receipts.mjs";

describe("createReceipt", () => {
  test("includes non-empty materialized harness pins", () => {
    const harnessPins = {
      ".pi/agent/prompts/factory-ticket.md": "sha256:content",
    };
    expect(
      createReceipt({
        runId: "run_harness",
        harnessPins,
      }).harnessPins,
    ).toEqual(harnessPins);
  });

  test("omits empty harness pins", () => {
    expect(
      createReceipt({ runId: "run_no_harness", harnessPins: {} }),
    ).not.toHaveProperty("harnessPins");
  });
});
