import { describe, expect, test } from "bun:test";
import { buildCapabilityGraph } from "./model";
import type { AgentsView } from "../types";

// The topology rules are pure data — tested without React or a browser.

const agent = (over: Partial<AgentsView["agents"][number]> = {}) =>
  ({
    ref: "a@1",
    id: "a",
    version: 1,
    outputContract: "c/v1",
    workspace: { type: "ephemeral" },
    capabilities: { services: ["x:read"] },
    limits: { timeout_seconds: 60, attempts: 1 },
    mutating: false,
    promptFile: "p.md",
    prompt: "",
    inputSchemaFile: "i.json",
    inputSchema: {},
    outputSchemaFile: "o.json",
    outputSchema: {},
    pins: {},
    command: null,
    actionRegistry: null,
    hosts: null,
    eventTypes: [],
    ...over,
  }) as AgentsView["agents"][number];

const view = (over: Partial<AgentsView> = {}): AgentsView => ({
  agents: [],
  edges: {},
  eventTypes: [],
  contracts: {},
  ...over,
});

describe("buildCapabilityGraph", () => {
  test("routes event types to their agents", () => {
    const g = buildCapabilityGraph(
      view({
        agents: [agent({ ref: "doctor@1" })],
        eventTypes: [
          { type: "gh.failed", agent: "doctor@1", adapter: "claude", idempotencyScope: ["inputHash"], proposalTtlSeconds: 1800 },
        ],
      }),
    );
    expect(g.nodes.map((n) => n.id)).toEqual(["event:gh.failed", "agent:doctor@1"]);
    expect(g.edges).toEqual([
      { id: "routes:gh.failed", source: "event:gh.failed", target: "agent:doctor@1", kind: "routes" },
    ]);
  });

  test("draws recommendation edges from an agent to follow-up event types", () => {
    const g = buildCapabilityGraph(
      view({
        agents: [agent({ ref: "doctor@1" }), agent({ ref: "rerun@1", mutating: true, command: ["gh", "run"] })],
        eventTypes: [
          { type: "gh.failed", agent: "doctor@1", adapter: "claude", idempotencyScope: [], proposalTtlSeconds: null },
          { type: "ci.rerun", agent: "rerun@1", adapter: "command", idempotencyScope: [], proposalTtlSeconds: null },
        ],
        edges: {
          "doctor@1": {
            recommendationField: "verdict",
            edges: { FLAKE: { eventType: "ci.rerun", input: {} } },
          },
        },
      }),
    );
    const rec = g.edges.find((e) => e.kind === "recommends");
    expect(rec).toMatchObject({ source: "agent:doctor@1", target: "event:ci.rerun", label: "verdict = FLAKE" });
    const rerun = g.nodes.find((n) => n.id === "agent:rerun@1");
    expect(rerun).toMatchObject({ kind: "agent", mutating: true, execution: "command" });
  });

  test("unmapped enum values become one terminal — 'the chain ends here' is topology", () => {
    const g = buildCapabilityGraph(
      view({
        agents: [
          agent({
            ref: "doctor@1",
            outputSchema: { properties: { verdict: { enum: ["TICKET", "ENV", "FLAKE"] } } },
          }),
          agent({ ref: "rerun@1" }),
        ],
        eventTypes: [
          { type: "gh.failed", agent: "doctor@1", adapter: "claude", idempotencyScope: [], proposalTtlSeconds: null },
          { type: "ci.rerun", agent: "rerun@1", adapter: "command", idempotencyScope: [], proposalTtlSeconds: null },
        ],
        edges: {
          "doctor@1": { recommendationField: "verdict", edges: { FLAKE: { eventType: "ci.rerun", input: {} } } },
        },
      }),
    );
    const terminal = g.nodes.find((n) => n.kind === "terminal");
    expect(terminal).toMatchObject({ id: "terminal:doctor@1", reason: "TICKET, ENV" });
    expect(g.edges.some((e) => e.target === "terminal:doctor@1")).toBe(true);
  });

  test("fully-mapped enums draw no terminal", () => {
    const g = buildCapabilityGraph(
      view({
        agents: [
          agent({ ref: "d@1", outputSchema: { properties: { r: { enum: ["GO"] } } } }),
          agent({ ref: "next@1" }),
        ],
        eventTypes: [
          { type: "t.next", agent: "next@1", adapter: "command", idempotencyScope: [], proposalTtlSeconds: null },
        ],
        edges: { "d@1": { recommendationField: "r", edges: { GO: { eventType: "t.next", input: {} } } } },
      }),
    );
    expect(g.nodes.some((n) => n.kind === "terminal")).toBe(false);
  });

  test("never draws an edge to an unregistered target", () => {
    const g = buildCapabilityGraph(
      view({
        agents: [agent({ ref: "d@1" })],
        edges: { "d@1": { recommendationField: "r", edges: { GO: { eventType: "nope.missing", input: {} } } } },
      }),
    );
    expect(g.edges).toEqual([]);
  });

  test("action-registry agents report their execution shape, actions, and hosts", () => {
    const g = buildCapabilityGraph(
      view({
        agents: [
          agent({
            ref: "remediate@1",
            mutating: true,
            actionRegistry: { "docker-builder-prune": { remote: "sudo docker builder prune -af" } },
            hosts: ["lab", "web"],
          }),
        ],
      }),
    );
    expect(g.nodes[0]).toMatchObject({
      kind: "agent",
      execution: "actions",
      actions: ["docker-builder-prune"],
      hosts: ["lab", "web"],
    });
  });
});
