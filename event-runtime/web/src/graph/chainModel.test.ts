import { describe, expect, test } from "bun:test";
import {
  buildChainGraph,
  chainKeyOfEvent,
  chainOriginLabel,
  eventNodeId,
  runNodeId,
} from "./chainModel";
import type { ChainEvent, ChainRun } from "../types";

const at = (n: number) => new Date(Date.UTC(2026, 7, 17, 12, n)).toISOString();

function event(overrides: Partial<ChainEvent> & { eventId: string }): ChainEvent {
  return {
    source: "chain",
    type: "factory.work.requested",
    subject: null,
    status: "planned",
    occurredAt: at(0),
    receivedAt: at(0),
    admittedAt: at(0),
    correlationId: "corr-1",
    causationId: null,
    proposalId: null,
    proposalStatus: null,
    proposalDecision: null,
    runId: null,
    repos: [],
    ...overrides,
  };
}

function run(overrides: Partial<ChainRun> & { runId: string }): ChainRun {
  return {
    state: "COMPLETED",
    attempts: 1,
    agent: "dispatch@1",
    adapter: "fake",
    reasonCode: null,
    eventId: null,
    eventSource: null,
    created_at: at(1),
    updated_at: at(1),
    startedAt: at(1),
    finishedAt: at(2),
    repos: [],
    ...overrides,
  };
}

/**
 *   origin ─▶ run-1 ─┬─▶ chain-1-A ─▶ run-2 ─▶ chain-2 ─▶ run-3
 *                    └─▶ chain-1-B (dead-lettered, no run)
 */
const tree = {
  events: [
    event({ source: "test", eventId: "origin", type: "clock.tick.work-scan", runId: "run-1" }),
    event({ eventId: "chain-1-A", causationId: "run-1", runId: "run-2" }),
    event({ eventId: "chain-1-B", causationId: "run-1", status: "dead_lettered" }),
    event({ eventId: "chain-2", causationId: "run-2", runId: "run-3", type: "factory.merge.scan.requested" }),
  ],
  runs: [
    run({ runId: "run-1", agent: "work-scan@1", eventSource: "test", eventId: "origin" }),
    run({ runId: "run-2", eventSource: "chain", eventId: "chain-1-A" }),
    run({ runId: "run-3", agent: "merge-scan@1", state: "RUNNING", eventSource: "chain", eventId: "chain-2", finishedAt: null }),
  ],
};

describe("buildChainGraph (WM-527)", () => {
  test("one node per event and run; edges follow event→run and run→emitted event", () => {
    const g = buildChainGraph(tree);
    expect(g.nodes).toHaveLength(7);
    const edges = g.edges.map((e) => `${e.kind}:${e.source}>${e.target}`).sort();
    expect(edges).toEqual(
      [
        `produced:${eventNodeId("test", "origin")}>${runNodeId("run-1")}`,
        `produced:${eventNodeId("chain", "chain-1-A")}>${runNodeId("run-2")}`,
        `produced:${eventNodeId("chain", "chain-2")}>${runNodeId("run-3")}`,
        `emitted:${runNodeId("run-1")}>${eventNodeId("chain", "chain-1-A")}`,
        `emitted:${runNodeId("run-1")}>${eventNodeId("chain", "chain-1-B")}`,
        `emitted:${runNodeId("run-2")}>${eventNodeId("chain", "chain-2")}`,
      ].sort(),
    );
  });

  test("the origin is the only root; depth counts hops from it", () => {
    const g = buildChainGraph(tree);
    expect(g.rootIds).toEqual([eventNodeId("test", "origin")]);
    const depth = Object.fromEntries(g.nodes.map((n) => [n.id, n.depth]));
    expect(depth[eventNodeId("test", "origin")]).toBe(0);
    expect(depth[runNodeId("run-1")]).toBe(1);
    expect(depth[eventNodeId("chain", "chain-1-A")]).toBe(2);
    expect(depth[eventNodeId("chain", "chain-1-B")]).toBe(2);
    expect(depth[runNodeId("run-2")]).toBe(3);
    expect(depth[eventNodeId("chain", "chain-2")]).toBe(4);
    expect(depth[runNodeId("run-3")]).toBe(5);
    expect(g.maxDepth).toBe(5);
    expect(g.nodes.find((n) => n.id === eventNodeId("test", "origin"))?.root).toBe(true);
    expect(g.nodes.filter((n) => n.root)).toHaveLength(1);
    expect(chainOriginLabel(g)).toBe("clock.tick.work-scan · test");
  });

  test("a run whose event's proposal join is missing still hangs off its origin event", () => {
    const g = buildChainGraph({
      events: [event({ source: "test", eventId: "origin", runId: null })],
      runs: [run({ runId: "run-1", eventSource: "test", eventId: "origin" })],
    });
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]).toMatchObject({ kind: "produced", source: eventNodeId("test", "origin"), target: runNodeId("run-1") });
    expect(g.rootIds).toEqual([eventNodeId("test", "origin")]);
  });

  test("a causation parent outside the correlation becomes a root run", () => {
    const g = buildChainGraph({
      events: [event({ eventId: "chain-2", causationId: "run-2", runId: "run-3" })],
      runs: [run({ runId: "run-2" }), run({ runId: "run-3", eventSource: "chain", eventId: "chain-2" })],
    });
    expect(g.rootIds).toEqual([runNodeId("run-2")]);
    expect(chainOriginLabel(g)).toBe("dispatch@1 · run");
    expect(g.maxDepth).toBe(2);
  });

  test("dangling ids never produce edges; a self-referencing cycle does not hang", () => {
    const g = buildChainGraph({
      events: [event({ eventId: "e", causationId: "ghost", runId: "also-ghost" })],
      runs: [],
    });
    expect(g.edges).toEqual([]);
    expect(g.rootIds).toEqual([eventNodeId("chain", "e")]);

    // Malformed: run-x's own origin event claims run-x emitted it.
    const cyc = buildChainGraph({
      events: [event({ eventId: "e", causationId: "run-x", runId: "run-x" })],
      runs: [run({ runId: "run-x", eventSource: "chain", eventId: "e" })],
    });
    expect(cyc.nodes).toHaveLength(2);
    expect(cyc.rootIds).toEqual([]);
    expect(Number.isFinite(cyc.maxDepth)).toBe(true);
  });

  test("chainKeyOfEvent mirrors the emitter: correlation id, else the event's own id", () => {
    expect(chainKeyOfEvent({ correlationId: "corr-1", eventId: "x" })).toBe("corr-1");
    expect(chainKeyOfEvent({ correlationId: null, eventId: "x" })).toBe("x");
    expect(chainKeyOfEvent({ eventId: "x" })).toBe("x");
  });
});
