import { describe, expect, test } from "bun:test";
import { proposalSubject } from "./proposal-subject.mjs";
import { loadRegistry } from "./registry.mjs";

const registry = loadRegistry();
const emptyRegistry = { views: new Map() };

describe("proposalSubject (WM-897)", () => {
  test("delegates to the view subject when the agent's sidecar defines one", () => {
    expect(
      proposalSubject(registry, {
        agent: "dispatch@1",
        model: "cursor-grok-4.6-high",
        adapter: "cursor",
        input: { repo: "factory", ticket: "WM-862" },
      }),
    ).toBe("Dispatch WM-862 · factory · cursor-grok-4.6-high");
  });

  test("keeps the dispatch fallback when the view does not define subject", () => {
    expect(
      proposalSubject(emptyRegistry, {
        agent: "dispatch@1",
        model: "sonnet",
        input: { repo: "bj29", ticket: "CLNT-1" },
      }),
    ).toBe("Dispatch CLNT-1 · bj29 · sonnet");
    expect(
      proposalSubject(emptyRegistry, {
        agent: "dispatch@1",
        input: {},
      }),
    ).toBe("Dispatch ? · ? · default");
  });

  test("returns null for a non-dispatch agent without a subject", () => {
    expect(
      proposalSubject(registry, {
        agent: "merge-scan@2",
        input: { repo: "factory" },
      }),
    ).toBeNull();
    expect(proposalSubject(registry, null)).toBeNull();
  });
});
