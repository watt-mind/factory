import { describe, expect, test } from "bun:test";
import { memoryControlPlane } from "./memory.mjs";
import { AGENT_READY_LABEL, IN_PROGRESS_LABEL } from "./labels.mjs";

const labels = [
  { id: "ready", name: AGENT_READY_LABEL },
  { id: "progress", name: IN_PROGRESS_LABEL },
  { id: "agent", name: "agent:claude-code" },
];

function plane() {
  const seed = {
    labels,
    tickets: [
      {
        id: "issue-1",
        identifier: "WM-1",
        state: { id: "todo", name: "Todo" },
        labels: [labels[0]],
      },
    ],
  };
  return { cp: memoryControlPlane(seed), ticket: seed.tickets[0] };
}

describe("memory ControlPlane agent-ready removal guard", () => {
  test("refuses bare transition and label removals without mutating", async () => {
    for (const removeReady of [
      (cp) => cp.transition("WM-1", undefined, { remove: [AGENT_READY_LABEL] }),
      (cp) => cp.setLabels("WM-1", { remove: [AGENT_READY_LABEL] }),
    ]) {
      const { cp, ticket } = plane();
      await expect(removeReady(cp)).rejects.toThrow(/refusing to remove/);
      expect(ticket.state.name).toBe("Todo");
      expect(ticket.labels.map((label) => label.name)).toEqual([
        AGENT_READY_LABEL,
      ]);
      expect(
        cp.calls.filter((call) =>
          ["transition", "setLabels"].includes(call.op),
        ),
      ).toEqual([]);
    }
  });

  test("allows a claim write and a move out of Todo", async () => {
    const claimed = plane();
    await claimed.cp.setLabels("WM-1", {
      add: [IN_PROGRESS_LABEL, "agent:claude-code"],
      remove: [AGENT_READY_LABEL],
    });
    expect(claimed.ticket.labels.map((label) => label.name).sort()).toEqual([
      "agent:claude-code",
      IN_PROGRESS_LABEL,
    ]);

    const moved = plane();
    await moved.cp.transition("WM-1", "Triage", {
      remove: [AGENT_READY_LABEL],
    });
    expect(moved.ticket.state.name).toBe("Triage");
    expect(moved.ticket.labels).toEqual([]);
  });
});
