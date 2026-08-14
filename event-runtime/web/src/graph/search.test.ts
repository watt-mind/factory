import { describe, expect, test } from "bun:test";
import { largestComponentIds, matchNodes } from "./search";
import type { CapabilityGraph, GraphNode } from "./model";

const event = (type: string): GraphNode => ({
  id: `event:${type}`,
  kind: "eventType",
  label: type,
  adapter: "claude",
  scope: [],
  ttl: null,
});

const agent = (ref: string): GraphNode => ({
  id: `agent:${ref}`,
  kind: "agent",
  label: ref,
  adapter: "claude",
  mutating: false,
  execution: "model",
  contract: "c/v1",
  capabilities: [],
  actions: [],
  hosts: [],
});

describe("matchNodes", () => {
  const nodes = [event("gh.run.failed"), agent("ci-doctor@1"), agent("rerun@2")];

  test("case-insensitive substring on label", () => {
    expect(matchNodes(nodes, "DOCTOR")).toEqual(["agent:ci-doctor@1"]);
  });

  test("matches on id prefix too", () => {
    expect(matchNodes(nodes, "event:")).toEqual(["event:gh.run.failed"]);
  });

  test("preserves node order across multiple matches", () => {
    expect(matchNodes(nodes, "r")).toEqual([
      "event:gh.run.failed",
      "agent:ci-doctor@1",
      "agent:rerun@2",
    ]);
  });

  test("blank and whitespace-only queries match nothing", () => {
    expect(matchNodes(nodes, "")).toEqual([]);
    expect(matchNodes(nodes, "   ")).toEqual([]);
  });

  test("no match returns empty", () => {
    expect(matchNodes(nodes, "zzz")).toEqual([]);
  });
});

describe("largestComponentIds", () => {
  const edge = (id: string, source: string, target: string) =>
    ({ id, source, target, kind: "routes" }) as CapabilityGraph["edges"][number];

  test("picks the component with the most nodes", () => {
    const graph: CapabilityGraph = {
      nodes: [event("a"), agent("a@1"), event("b"), agent("b@1"), event("c")],
      edges: [
        edge("1", "event:a", "agent:a@1"),
        edge("2", "event:b", "agent:b@1"),
        edge("3", "agent:a@1", "event:b"),
      ],
    };
    expect(largestComponentIds(graph).sort()).toEqual(
      ["agent:a@1", "agent:b@1", "event:a", "event:b"].sort(),
    );
  });

  test("breaks node-count ties by edge count", () => {
    const graph: CapabilityGraph = {
      nodes: [event("a"), agent("a@1"), event("b"), agent("b@1")],
      edges: [
        edge("1", "event:b", "agent:b@1"),
        edge("2", "agent:b@1", "event:b"),
      ],
    };
    // Both components have 2 nodes; b's has 2 edges vs a's 0... a's are isolated.
    expect(largestComponentIds(graph).sort()).toEqual(["agent:b@1", "event:b"].sort());
  });

  test("empty graph yields empty", () => {
    expect(largestComponentIds({ nodes: [], edges: [] })).toEqual([]);
  });

  test("isolated single nodes form one-node components", () => {
    const graph: CapabilityGraph = { nodes: [event("solo")], edges: [] };
    expect(largestComponentIds(graph)).toEqual(["event:solo"]);
  });
});
