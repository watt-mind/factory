import { describe, expect, test } from "bun:test";
import { DEMO_LABELS, memoryControlPlane } from "./memory-plane.mjs";

function seed() {
  return memoryControlPlane({
    viewer: { id: "me", name: "Ada" },
    team: { id: "team-demo", key: "DEMO" },
    labels: [
      { id: "r", name: DEMO_LABELS.AGENT_READY },
      { id: "p", name: DEMO_LABELS.IN_PROGRESS },
    ],
    tickets: [
      {
        id: "1",
        identifier: "DEMO-1",
        title: "greet",
        description: "x",
        state: { name: "Todo" },
        assignee: null,
        team: { key: "DEMO" },
        labels: [{ id: "r", name: DEMO_LABELS.AGENT_READY }],
        comments: [],
      },
    ],
  });
}

describe("memory control plane (demo)", () => {
  test("listDispatchable returns Todo + ai:agent-ready + unassigned", async () => {
    const plane = seed();
    const ready = await plane.listDispatchable({ team: "DEMO" });
    expect(ready.map((t) => t.identifier)).toEqual(["DEMO-1"]);
  });

  test("claim moves to In Progress and swaps lifecycle labels", async () => {
    const plane = seed();
    const result = await plane.claim("DEMO-1", { harness: "fake" });
    expect(result.ok).toBe(true);
    const ticket = await plane.getTicket("DEMO-1");
    expect(ticket.state.name).toBe("In Progress");
    expect(ticket.assignee.name).toBe("Ada");
    const names = ticket.labels.map((l) => l.name);
    expect(names).toContain(DEMO_LABELS.IN_PROGRESS);
    expect(names).toContain("agent:fake");
    expect(names).not.toContain(DEMO_LABELS.AGENT_READY);
    expect(await plane.listDispatchable({ team: "DEMO" })).toEqual([]);
  });

  test("comment and transition are recorded", async () => {
    const plane = seed();
    await plane.claim("DEMO-1", { harness: "claude" });
    await plane.comment("DEMO-1", "hello");
    await plane.transition("DEMO-1", "In Review", {
      add: [DEMO_LABELS.NEEDS_REVIEW],
      remove: [DEMO_LABELS.IN_PROGRESS],
    });
    const ticket = await plane.getTicket("DEMO-1");
    expect(ticket.state.name).toBe("In Review");
    const comments = await plane.listComments("DEMO-1");
    expect(comments[0].body).toBe("hello");
    expect(plane.calls.map((c) => c.op)).toEqual([
      "claim",
      "comment",
      "transition",
      "getTicket",
      "listComments",
    ]);
  });
});
