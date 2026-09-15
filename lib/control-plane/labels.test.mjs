import { describe, expect, test } from "bun:test";
import {
  AGENT_READY_LABEL,
  classifyAgentReadyRemoval,
  IN_PROGRESS_LABEL,
} from "./labels.mjs";

describe("classifyAgentReadyRemoval", () => {
  const current = [AGENT_READY_LABEL, "type:bug"];

  test("allows a claim only when both claim labels share the write", () => {
    expect(
      classifyAgentReadyRemoval(current, {
        add: [IN_PROGRESS_LABEL, "agent:claude-code"],
        remove: [AGENT_READY_LABEL],
      }),
    ).toBe("claim");
    expect(
      classifyAgentReadyRemoval(current, {
        add: [IN_PROGRESS_LABEL],
        remove: [AGENT_READY_LABEL],
      }),
    ).toBe("unsafe");
  });

  test("allows removal after a move out of Todo", () => {
    expect(
      classifyAgentReadyRemoval(current, {
        remove: [AGENT_READY_LABEL],
        state: "Triage",
      }),
    ).toBe("demotion");
  });

  test("rejects bare and Todo removals", () => {
    expect(
      classifyAgentReadyRemoval(current, { remove: [AGENT_READY_LABEL] }),
    ).toBe("unsafe");
    expect(
      classifyAgentReadyRemoval(current, {
        remove: [AGENT_READY_LABEL],
        state: "Todo",
      }),
    ).toBe("unsafe");
  });

  test("ignores no-op removals and an explicit re-add", () => {
    expect(
      classifyAgentReadyRemoval(["type:bug"], {
        remove: [AGENT_READY_LABEL],
      }),
    ).toBe("none");
    expect(
      classifyAgentReadyRemoval(current, {
        add: [AGENT_READY_LABEL],
        remove: [AGENT_READY_LABEL],
      }),
    ).toBe("none");
  });
});
