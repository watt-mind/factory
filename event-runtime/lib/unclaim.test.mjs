/**
 * Release-path regressions (WM-1024).
 *
 * On 2026-08-22 three tickets (WM-1008, WM-1015, WM-534) were released back
 * to `Todo` after transient test failures and silently left the queue. The
 * dispatchable predicate is `Todo` + `ai:agent-ready` + unassigned
 * (docs/protocol.md §4); the release dropped `ai:in-progress` and stopped,
 * so the tickets read `Todo` on every board while being invisible to every
 * dispatcher. WM-1015's agent even wrote "Returning to Todo + ai:agent-ready"
 * in its own comment — the prose was right, the mutation was not.
 *
 * These assert the resulting LABEL SET, not that some mutation ran. "It
 * called the CLI" was already true of the broken version.
 */
import { describe, expect, test } from "bun:test";
import {
  AGENT_READY_LABEL,
  BLOCKED_LABEL,
  IN_PROGRESS_LABEL,
  claimLabels,
  releaseLabels,
} from "../../lib/control-plane/labels.mjs";
import { computeUnclaimAction } from "../../orchestrator/tick.mjs";
import { defaultUnclaimTicket } from "./worker.mjs";

/** Apply an {add, remove} change the way a complete-set tracker update does. */
function applyChange(currentNames, { add = [], remove = [] }) {
  const dropped = new Set(remove);
  return [...new Set([...currentNames.filter((n) => !dropped.has(n)), ...add])];
}

const CLAIMED = [
  "type:feature",
  "area:architecture",
  "source:human",
  IN_PROGRESS_LABEL,
  "agent:pi",
];

describe("releaseLabels", () => {
  test("release to Todo yields a DISPATCHABLE ticket", () => {
    const after = applyChange(CLAIMED, releaseLabels(CLAIMED, { to: "Todo" }));
    // The whole bug, in one assertion.
    expect(after).toContain(AGENT_READY_LABEL);
    expect(after).not.toContain(IN_PROGRESS_LABEL);
    expect(after.filter((n) => n.startsWith("agent:"))).toEqual([]);
    // Non-lifecycle labels a human curated are untouched.
    expect(after).toContain("type:feature");
    expect(after).toContain("area:architecture");
    expect(after).toContain("source:human");
  });

  test("Todo is the default target", () => {
    expect(releaseLabels(CLAIMED)).toEqual(
      releaseLabels(CLAIMED, { to: "Todo" }),
    );
  });

  test("release to Blocked must NOT re-enter the queue", () => {
    const after = applyChange(
      CLAIMED,
      releaseLabels(CLAIMED, { to: "Blocked" }),
    );
    expect(after).toContain(BLOCKED_LABEL);
    // A blocked ticket waits for a human; agent-ready would loop it.
    expect(after).not.toContain(AGENT_READY_LABEL);
    expect(after).not.toContain(IN_PROGRESS_LABEL);
    expect(after.filter((n) => n.startsWith("agent:"))).toEqual([]);
  });

  test("releasing a Blocked ticket to Todo clears ai:blocked", () => {
    const blocked = ["type:bug", BLOCKED_LABEL];
    const after = applyChange(blocked, releaseLabels(blocked, { to: "Todo" }));
    expect(after).toContain(AGENT_READY_LABEL);
    expect(after).not.toContain(BLOCKED_LABEL);
  });

  test("is idempotent — a double release does not accumulate labels", () => {
    const once = applyChange(CLAIMED, releaseLabels(CLAIMED, { to: "Todo" }));
    const twice = applyChange(once, releaseLabels(once, { to: "Todo" }));
    expect(twice.sort()).toEqual(once.sort());
  });

  test("strips EVERY agent:* label, not just the current harness", () => {
    const messy = [...CLAIMED, "agent:claude-code", "agent:codex"];
    const after = applyChange(messy, releaseLabels(messy, { to: "Todo" }));
    expect(after.filter((n) => n.startsWith("agent:"))).toEqual([]);
  });

  test("is the exact inverse of claimLabels", () => {
    const base = ["type:feature", "source:human", AGENT_READY_LABEL];
    const claimed = applyChange(base, claimLabels(base, "pi"));
    expect(claimed).toContain(IN_PROGRESS_LABEL);
    expect(claimed).toContain("agent:pi");
    expect(claimed).not.toContain(AGENT_READY_LABEL);

    const released = applyChange(
      claimed,
      releaseLabels(claimed, { to: "Todo" }),
    );
    expect(released.sort()).toEqual(base.sort());
  });
});

describe("the two release implementations agree (WM-1024)", () => {
  // orchestrator/tick.mjs already did this correctly; event-runtime's worker
  // did not. They drifted because each rolled its own. This pins them
  // together so the next divergence fails a test instead of eating tickets.
  const issue = {
    labels: {
      nodes: [
        { id: "l-type", name: "type:feature" },
        { id: "l-src", name: "source:human" },
        { id: "l-prog", name: IN_PROGRESS_LABEL },
        { id: "l-agent", name: "agent:pi" },
      ],
    },
    comments: { nodes: [] },
  };
  const allLabels = [
    { id: "l-type", name: "type:feature" },
    { id: "l-src", name: "source:human" },
    { id: "l-prog", name: IN_PROGRESS_LABEL },
    { id: "l-agent", name: "agent:pi" },
    { id: "l-ready", name: AGENT_READY_LABEL },
    { id: "l-blocked", name: BLOCKED_LABEL },
  ];
  const nameOf = (id) => allLabels.find((l) => l.id === id)?.name;
  const currentNames = issue.labels.nodes.map((l) => l.name);

  test("tick.mjs unclaim produces the same set as releaseLabels(Todo)", () => {
    const action = computeUnclaimAction({
      issue,
      why: "transient failure",
      todoStateId: "s-todo",
      blockedStateId: "s-blocked",
      allLabels,
    });
    expect(action.repeated).toBe(false);
    expect(action.labelIds.map(nameOf).sort()).toEqual(
      applyChange(
        currentNames,
        releaseLabels(currentNames, { to: "Todo" }),
      ).sort(),
    );
  });

  test("tick.mjs repeated-failure demotion matches releaseLabels(Blocked)", () => {
    const action = computeUnclaimAction({
      issue,
      why: "transient failure",
      todoStateId: "s-todo",
      blockedStateId: "s-blocked",
      allLabels,
      threshold: 1,
    });
    expect(action.repeated).toBe(true);
    expect(action.labelIds.map(nameOf).sort()).toEqual(
      applyChange(
        currentNames,
        releaseLabels(currentNames, { to: "Blocked" }),
      ).sort(),
    );
  });
});

describe("worker defaultUnclaimTicket (the actual defect)", () => {
  // This is the test that would have caught it. The helper tests above
  // cannot fail against the old code, because releaseLabels did not exist —
  // this one drives the real release path and asserts the argv it builds.
  const claimedTicket = {
    state: { name: "In Progress" },
    labels: [
      { name: "type:feature" },
      { name: "source:human" },
      { name: IN_PROGRESS_LABEL },
      { name: "agent:pi" },
    ],
  };

  function release(ticket = claimedTicket) {
    const calls = [];
    const ok = defaultUnclaimTicket({
      repo: "factory",
      ticket: "WM-1008",
      why: "verification timed out",
      fetchTicket: () => ticket,
      runCli: (args) => {
        calls.push(args);
        return "";
      },
    });
    return { ok, calls };
  }

  test("re-adds ai:agent-ready so the ticket is dispatchable again", () => {
    const { ok, calls } = release();
    expect(ok).toBe(true);
    const state = calls.find((a) => a[0] === "state");
    expect(state).toBeDefined();
    expect(state).toContain("Todo");
    expect(state).toContain("--unassign");
    // The regression, precisely: this pair was missing.
    expect(state.join(" ")).toContain(`--add ${AGENT_READY_LABEL}`);
    expect(state.join(" ")).toContain(`--remove ${IN_PROGRESS_LABEL}`);
  });

  test("strips the stale agent:* label", () => {
    const { calls } = release();
    const state = calls.find((a) => a[0] === "state");
    expect(state.join(" ")).toContain("--remove agent:pi");
  });

  test("the resulting label set matches releaseLabels exactly", () => {
    const { calls } = release();
    const state = calls.find((a) => a[0] === "state");
    const names = claimedTicket.labels.map((l) => l.name);
    const { add, remove } = releaseLabels(names, { to: "Todo" });
    for (const n of add) expect(state.join(" ")).toContain(`--add ${n}`);
    for (const n of remove) expect(state.join(" ")).toContain(`--remove ${n}`);
  });

  test("the posted comment states the ticket is agent-ready again", () => {
    const { calls } = release();
    const comment = calls.find((a) => a[0] === "comment");
    expect(comment[2]).toContain(AGENT_READY_LABEL);
  });

  test("refuses to release a ticket it does not hold", () => {
    expect(release({ state: { name: "Todo" }, labels: [] }).ok).toBe(false);
    expect(
      release({
        state: { name: "In Progress" },
        labels: [{ name: "type:feature" }],
      }).ok,
    ).toBe(false);
  });

  test("tolerates the GraphQL nodes label shape (WM-978)", () => {
    const { ok, calls } = release({
      state: { name: "In Progress" },
      labels: { nodes: [{ name: IN_PROGRESS_LABEL }, { name: "agent:pi" }] },
    });
    expect(ok).toBe(true);
    expect(calls.find((a) => a[0] === "state").join(" ")).toContain(
      `--add ${AGENT_READY_LABEL}`,
    );
  });
});
