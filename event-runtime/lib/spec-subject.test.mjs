import { describe, expect, test } from "bun:test";
import { loadRegistry } from "./registry.mjs";
import { renderSubject, specSubject } from "./spec-subject.mjs";

const registry = loadRegistry();

const dispatchSpec = {
  agent: "dispatch@1",
  model: "cursor-grok-4.6-high",
  adapter: "cursor",
  input: { repo: "factory", ticket: "WM-862" },
};

describe("specSubject (WM-897)", () => {
  test("renders the dispatch sidecar template over input pointers and {model}", () => {
    expect(specSubject(registry, dispatchSpec)).toBe(
      "Dispatch WM-862 · factory · cursor-grok-4.6-high",
    );
  });

  test("returns null when the agent has no subject (merge-scan) or the spec is junk", () => {
    expect(
      specSubject(registry, {
        agent: "merge-scan@2",
        input: { repo: "factory" },
      }),
    ).toBeNull();
    expect(specSubject(registry, null)).toBeNull();
    expect(specSubject(registry, { agent: "ghost@9" })).toBeNull();
    expect(specSubject(registry, { input: { ticket: "WM-1" } })).toBeNull();
  });

  test("a missing input pointer renders as empty rather than crashing", () => {
    expect(
      specSubject(registry, {
        agent: "dispatch@1",
        model: "x",
        input: { repo: "factory" },
      }),
    ).toBe("Dispatch  · factory · x");
  });

  test("renderSubject substitutes fixed fields and leaves unknown tokens alone", () => {
    expect(
      renderSubject("Run {agent} on {adapter}", {
        agent: "dispatch@1",
        adapter: "cursor",
      }),
    ).toBe("Run dispatch@1 on cursor");
    expect(renderSubject("Hi {flavour}", { agent: "x" })).toBe("Hi {flavour}");
    expect(renderSubject("static", {})).toBe("static");
  });
});
