/**
 * ControlPlane contract suite (WM-797): the same assertions run against the
 * memory fake and against the Linear implementation driven by a fake `gql`
 * that serves the same seed. A verb that passes here on one and not the
 * other is a contract bug, not a test bug.
 */
import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-control-plane-test-mjs";
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { linearControlPlane } from "../../lib/control-plane/linear.mjs";
import {
  AGENT_READY_LABEL,
  ControlPlaneError,
  CONTROL_PLANE_KINDS,
  controlPlaneKindFromPolicy,
  IN_PROGRESS_LABEL,
  loadControlPlane,
} from "../../lib/control-plane/index.mjs";
import * as controlPlaneIndex from "../../lib/control-plane/index.mjs";
import { githubControlPlane as githubControlPlaneFromAdapter } from "../../lib/control-plane/github.mjs";
import { memoryControlPlane } from "../../lib/control-plane/memory.mjs";

const TEAM = "WM";
const GH_REPO = "acme/widget";
const RAW_PING = "query { ping }";

function freshSeed() {
  return {
    viewer: { id: "user-me", name: "Ada" },
    team: { id: "team-wm", key: TEAM },
    states: [
      { id: "s-triage", name: "Triage" },
      { id: "s-todo", name: "Todo" },
      { id: "s-progress", name: "In Progress" },
      { id: "s-review", name: "In Review" },
      { id: "s-blocked", name: "Blocked" },
      { id: "s-done", name: "Done" },
    ],
    labels: [
      { id: "l-ready", name: AGENT_READY_LABEL },
      { id: "l-prog", name: IN_PROGRESS_LABEL },
      { id: "l-claude", name: "agent:claude-code" },
      { id: "l-codex", name: "agent:codex" },
      { id: "l-bug", name: "type:bug" },
      { id: "l-feat", name: "type:feature" },
      { id: "l-review", name: "ai:needs-review" },
      { id: "l-src", name: "source:agent" },
    ],
    tickets: [
      {
        id: "id-1",
        identifier: "WM-1",
        title: "ready ticket",
        description: "## Owned Paths\n* lib/control-plane/**\n",
        url: "https://linear.app/watt-mind/issue/WM-1",
        state: { id: "s-todo", name: "Todo", type: "unstarted" },
        assignee: null,
        team: { key: TEAM },
        project: { name: "Factory" },
        labels: [{ id: "l-ready", name: AGENT_READY_LABEL }],
        comments: [],
      },
      {
        id: "id-2",
        identifier: "WM-2",
        title: "in progress ticket",
        description: "",
        url: "https://linear.app/watt-mind/issue/WM-2",
        state: { id: "s-progress", name: "In Progress", type: "started" },
        assignee: { id: "user-other", name: "Other" },
        team: { key: TEAM },
        project: { name: "Factory" },
        labels: [
          { id: "l-prog", name: IN_PROGRESS_LABEL },
          { id: "l-claude", name: "agent:claude-code" },
        ],
        comments: [
          {
            id: "c-1",
            body: "hello",
            createdAt: "2026-08-19T10:00:00Z",
            user: { id: "user-other", name: "Other" },
          },
        ],
      },
      {
        id: "id-3",
        identifier: "WM-3",
        title: "todo but not agent-ready",
        description: "",
        url: "https://linear.app/watt-mind/issue/WM-3",
        state: { id: "s-todo", name: "Todo", type: "unstarted" },
        assignee: null,
        team: { key: TEAM },
        project: { name: "Factory" },
        labels: [{ id: "l-bug", name: "type:bug" }],
        comments: [],
      },
      {
        id: "id-4",
        identifier: "CLNT-4",
        title: "other team ready",
        description: "",
        url: "https://linear.app/watt-mind/issue/CLNT-4",
        state: { id: "s-todo", name: "Todo", type: "unstarted" },
        assignee: null,
        team: { key: "CLNT" },
        project: { name: "bj29" },
        labels: [{ id: "l-ready", name: AGENT_READY_LABEL }],
        comments: [],
      },
    ],
    raw: { [RAW_PING]: { ping: true } },
    loseNextClaim: null,
  };
}

function toLinearIssue(t) {
  return {
    id: t.id,
    identifier: t.identifier,
    title: t.title,
    description: t.description,
    url: t.url,
    state: t.state,
    assignee: t.assignee,
    team: t.team,
    project: t.project,
    labels: { nodes: t.labels ?? [] },
    comments: { nodes: t.comments ?? [] },
    // WM-1008. The seed writes priority/createdAt flat and blockers as plain
    // identifiers; this is where they take Linear's wire shape, so the SAME
    // fixture drives both the memory fake and the Linear adapter.
    priority: t.priority ?? 0,
    createdAt: t.createdAt ?? "",
    inverseRelations: {
      nodes: (t.blockedBy ?? []).map((id) => ({
        type: "blocks",
        issue: {
          identifier: id,
          state: { type: stateTypeOfSeed(id) },
        },
      })),
    },
  };
}

/** Linear state `type` of a seeded blocker, resolved from the shared seed. */
let SEED_FOR_RELATIONS = null;
function stateTypeOfSeed(identifier) {
  const t = SEED_FOR_RELATIONS?.tickets?.find(
    (x) => x.identifier === identifier,
  );
  const name = (t?.state?.name ?? "").toLowerCase();
  if (!t) return "started"; // unknown blocker: fail closed, stays blocking
  if (["done"].includes(name)) return "completed";
  if (["canceled", "duplicate"].includes(name)) return "canceled";
  return t.state?.type ?? "started";
}

/**
 * A `gql` that answers from the seed. Mutates the shared seed so both
 * implementations can be asserted through the same fixture.
 */
function fakeGql(seed) {
  SEED_FOR_RELATIONS = seed;
  const gql = async (query, variables = {}) => {
    gql.calls.push({ query, variables });
    const q = String(query).replace(/\s+/g, " ");
    const fail = (message) => {
      throw new Error(message);
    };

    if (seed.raw?.[query]) {
      const hit = seed.raw[query];
      return typeof hit === "function" ? hit(variables) : hit;
    }

    if (q.includes("viewer{") || q.includes("viewer {")) {
      return { viewer: seed.viewer };
    }
    if (q.includes("issueLabels")) {
      return { issueLabels: { nodes: seed.labels } };
    }
    if (q.includes("teams(")) {
      const key = variables.t;
      if (key && key !== seed.team.key && key !== "CLNT") {
        return { teams: { nodes: [] } };
      }
      const teamId = key === "CLNT" ? "team-clnt" : seed.team.id;
      return {
        teams: {
          nodes: [{ id: teamId, states: { nodes: seed.states } }],
        },
      };
    }

    if (q.includes("issueCreate")) {
      const input = variables.in ?? {};
      const identifier = `WM-${seed.tickets.length + 1}`;
      const ticket = {
        id: `id-${identifier}`,
        identifier,
        title: input.title,
        description: input.description ?? "",
        url: `https://linear.app/watt-mind/issue/${identifier}`,
        state:
          seed.states.find((s) => s.id === input.stateId) ?? seed.states[0],
        assignee: null,
        team: { key: TEAM },
        project: null,
        labels: (input.labelIds ?? []).map((id) =>
          seed.labels.find((l) => l.id === id),
        ),
        comments: [],
      };
      seed.tickets.push(ticket);
      return {
        issueCreate: {
          success: true,
          issue: { identifier: ticket.identifier, url: ticket.url },
        },
      };
    }

    if (q.includes("commentCreate")) {
      const input = variables.in ?? {};
      const ticket = seed.tickets.find((t) => t.id === input.issueId);
      if (!ticket) fail(`no such issue id ${input.issueId}`);
      (ticket.comments ??= []).push({
        id: `c-${(ticket.comments?.length ?? 0) + 1}`,
        body: input.body,
        createdAt: "2026-08-19T12:00:00Z",
        user: seed.viewer,
      });
      return { commentCreate: { success: true } };
    }

    if (q.includes("issueUpdate")) {
      const ticket = seed.tickets.find((t) => t.id === variables.id);
      if (!ticket) fail(`no such issue id ${variables.id}`);
      const input = variables.in ?? {};
      if (input.stateId) {
        ticket.state =
          seed.states.find((s) => s.id === input.stateId) ?? ticket.state;
      }
      if (input.assigneeId === null) ticket.assignee = null;
      else if (input.assigneeId) {
        ticket.assignee =
          input.assigneeId === seed.viewer.id
            ? { ...seed.viewer }
            : { id: input.assigneeId, name: "Other" };
      }
      if (input.labelIds) {
        ticket.labels = input.labelIds.map((id) =>
          seed.labels.find((l) => l.id === id),
        );
      }
      if (input.description !== undefined)
        ticket.description = input.description;
      if (seed.loseNextClaim) {
        ticket.assignee = { ...seed.loseNextClaim };
        seed.loseNextClaim = null;
      }
      return { issueUpdate: { success: true } };
    }

    if (q.includes("issues(")) {
      // WM-1008: listTickets sends either an explicit state-name list ($s) or
      // a "not finished" type filter. Assignee is NOT filtered server-side any
      // more — listDispatchable applies that, so the fake must return claimed
      // tickets too or the dispatcher can never see In Progress work.
      const team = variables.t;
      const project = variables.p;
      const wanted = variables.s?.length
        ? new Set(variables.s.map((n) => String(n).toLowerCase()))
        : null;
      const nodes = seed.tickets.filter((t) => {
        if ((t.team?.key ?? "") !== team) return false;
        if (project && t.project?.name !== project) return false;
        const name = (t.state?.name ?? "").toLowerCase();
        if (wanted) return wanted.has(name);
        return !["done", "canceled", "duplicate"].includes(name);
      });
      return { issues: { nodes: nodes.map(toLinearIssue) } };
    }

    if (q.includes("issue(id:") || q.includes("issue(id :")) {
      const key = variables.k ?? variables.id;
      const ticket = seed.tickets.find(
        (t) => t.identifier === key || t.id === key,
      );
      if (!ticket) return { issue: null };
      if (q.includes("comments(")) return { issue: toLinearIssue(ticket) };
      if (
        q.includes("assignee") &&
        !q.includes("title") &&
        !q.includes("ISSUE") &&
        !q.includes("identifier")
      ) {
        return { issue: { assignee: ticket.assignee } };
      }
      return { issue: toLinearIssue(ticket) };
    }

    fail(`unknown graphql ${q.slice(0, 120)}`);
  };
  gql.calls = [];
  return gql;
}

const IMPLEMENTATIONS = [
  [
    "memory",
    () => {
      const seed = freshSeed();
      return { cp: memoryControlPlane(seed), seed };
    },
  ],
  [
    "linear",
    () => {
      const seed = freshSeed();
      return { cp: linearControlPlane({ gql: fakeGql(seed) }), seed };
    },
  ],
];

for (const [name, make] of IMPLEMENTATIONS) {
  describe(`control-plane contract: ${name}`, () => {
    test("kind is a known implementation", () => {
      const { cp } = make();
      expect(CONTROL_PLANE_KINDS).toContain(cp.kind);
      expect(cp.kind).toBe(name);
    });

    test("getTicket returns the normalized ticket (flat labels, no nodes)", async () => {
      const { cp } = make();
      const t = await cp.getTicket("WM-1");
      expect(t.identifier).toBe("WM-1");
      expect(t.title).toBe("ready ticket");
      expect(t.labels).toEqual([{ id: "l-ready", name: AGENT_READY_LABEL }]);
      expect(t.labels.nodes).toBeUndefined();
      expect(t.assignee).toBeNull();
      expect(t.state.name).toBe("Todo");
    });

    test("getTicket on an unknown id throws ControlPlaneError", async () => {
      const { cp } = make();
      let err;
      try {
        await cp.getTicket("WM-999");
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ControlPlaneError);
      expect(err.message).toMatch(/no such issue/i);
    });

    test("listComments returns the comment bodies", async () => {
      const { cp } = make();
      expect(await cp.listComments("WM-2")).toEqual([
        {
          id: "c-1",
          body: "hello",
          createdAt: "2026-08-19T10:00:00Z",
          user: { id: "user-other", name: "Other" },
        },
      ]);
      expect(await cp.listComments("WM-1")).toEqual([]);
      await expect(cp.listComments("WM-999")).rejects.toThrow(
        ControlPlaneError,
      );
    });

    test("listDispatchable is Todo + ai:agent-ready + unassigned, scoped to team", async () => {
      const { cp } = make();
      const ready = await cp.listDispatchable({ team: TEAM });
      expect(ready.map((t) => t.identifier)).toEqual(["WM-1"]);
      const factory = await cp.listDispatchable({
        team: TEAM,
        project: "Factory",
      });
      expect(factory.map((t) => t.identifier)).toEqual(["WM-1"]);
      const none = await cp.listDispatchable({
        team: TEAM,
        project: "Nope",
      });
      expect(none).toEqual([]);
      await expect(cp.listDispatchable({})).rejects.toThrow(ControlPlaneError);
    });

    // ------------------------------------------- WM-1008: order and gating ---
    // These run against EVERY implementation. Both properties fail silently
    // if an adapter skips them: a wrong order just dispatches the wrong
    // ticket first, and a missed blocker runs work whose dependency is not
    // finished. Neither raises an error, so only a test catches them.

    /** Seed three ready tickets with explicit priorities and creation times. */
    function withQueue(seed) {
      const base = seed.tickets[0];
      const mk = (n, priority, createdAt, extra = {}) => ({
        ...base,
        id: `id-q${n}`,
        identifier: `WM-${n}`,
        title: `queued ${n}`,
        priority,
        createdAt,
        labels: [{ id: "l-ready", name: AGENT_READY_LABEL }],
        assignee: null,
        state: { id: "s-todo", name: "Todo", type: "unstarted" },
        ...extra,
      });
      seed.tickets.push(
        mk(20, 3, "2026-01-01T00:00:00Z"),
        mk(21, 1, "2026-01-02T00:00:00Z"),
        mk(22, null, "2026-01-03T00:00:00Z"),
        mk(23, 1, "2026-01-01T00:00:00Z"),
      );
      return seed;
    }

    test("listDispatchable is ordered priority asc, then createdAt asc", async () => {
      const { cp, seed } = make();
      withQueue(seed);
      const ready = (await cp.listDispatchable({ team: TEAM })).map(
        (t) => t.identifier,
      );
      // WM-23 and WM-21 are both priority 1; WM-23 was created first.
      expect(ready.indexOf("WM-23")).toBeLessThan(ready.indexOf("WM-21"));
      expect(ready.indexOf("WM-21")).toBeLessThan(ready.indexOf("WM-20"));
    });

    test("a ticket with no priority sorts LAST, never first", async () => {
      const { cp, seed } = make();
      withQueue(seed);
      const ready = (await cp.listDispatchable({ team: TEAM })).map(
        (t) => t.identifier,
      );
      // WM-22 has null priority. Treated as 0 it would lead the queue, which
      // is exactly backwards — "unset" must never outrank "urgent".
      expect(ready.at(-1)).toBe("WM-22");
      expect(ready[0]).not.toBe("WM-22");
    });

    test("priority is normalized: absent/zero reads as null", async () => {
      const { cp } = make();
      const t = await cp.getTicket("WM-1");
      expect(t.priority ?? null).toBeNull();
    });

    test("a ticket with an OPEN blocker is excluded from listDispatchable", async () => {
      const { cp, seed } = make();
      const base = seed.tickets[0];
      seed.tickets.push({
        ...base,
        id: "id-blocker",
        identifier: "WM-30",
        title: "the blocker",
        state: { id: "s-todo", name: "Todo", type: "unstarted" },
        labels: [],
        assignee: null,
      });
      seed.tickets.push({
        ...base,
        id: "id-blocked",
        identifier: "WM-31",
        title: "the dependent",
        state: { id: "s-todo", name: "Todo", type: "unstarted" },
        labels: [{ id: "l-ready", name: AGENT_READY_LABEL }],
        assignee: null,
        blockedBy: ["WM-30"],
      });
      const ready = await cp.listDispatchable({ team: TEAM });
      expect(ready.map((t) => t.identifier)).not.toContain("WM-31");
    });

    test("closing the blocker releases the dependent", async () => {
      const { cp, seed } = make();
      const base = seed.tickets[0];
      const blocker = {
        ...base,
        id: "id-blocker",
        identifier: "WM-30",
        title: "the blocker",
        state: { id: "s-todo", name: "Todo", type: "unstarted" },
        labels: [],
        assignee: null,
      };
      seed.tickets.push(blocker, {
        ...base,
        id: "id-blocked",
        identifier: "WM-31",
        title: "the dependent",
        state: { id: "s-todo", name: "Todo", type: "unstarted" },
        labels: [{ id: "l-ready", name: AGENT_READY_LABEL }],
        assignee: null,
        blockedBy: ["WM-30"],
      });
      expect(
        (await cp.listDispatchable({ team: TEAM })).map((t) => t.identifier),
      ).not.toContain("WM-31");

      blocker.state = { id: "s-done", name: "Done", type: "completed" };
      expect(
        (await cp.listDispatchable({ team: TEAM })).map((t) => t.identifier),
      ).toContain("WM-31");
    });

    test("listTickets returns In Progress work with descriptions", async () => {
      // The dispatcher needs Owned Paths of RUNNING tickets to test collision.
      const { cp, seed } = make();
      const base = seed.tickets[0];
      seed.tickets.push({
        ...base,
        id: "id-running",
        identifier: "WM-40",
        title: "running",
        description: "## Owned Paths\n- lib/running/**\n",
        state: { id: "s-progress", name: "In Progress", type: "started" },
        labels: [{ id: "l-prog", name: IN_PROGRESS_LABEL }],
        assignee: { id: "user-me", name: "Ada" },
      });
      const running = await cp.listTickets({
        team: TEAM,
        states: ["In Progress"],
      });
      expect(running.map((t) => t.identifier)).toContain("WM-40");
      expect(
        running.find((t) => t.identifier === "WM-40").description,
      ).toContain("Owned Paths");
    });

    test("listTickets requires a team", async () => {
      const { cp } = make();
      await expect(cp.listTickets({})).rejects.toThrow(ControlPlaneError);
    });

    test("claim moves to In Progress, assigns the viewer, swaps claim labels", async () => {
      const { cp } = make();
      const result = await cp.claim("WM-1");
      expect(result).toEqual({
        ok: true,
        identifier: "WM-1",
        assignee: "Ada",
      });
      const t = await cp.getTicket("WM-1");
      expect(t.state.name).toBe("In Progress");
      expect(t.assignee).toEqual({ id: "user-me", name: "Ada" });
      const names = t.labels.map((l) => l.name).sort();
      expect(names).toContain(IN_PROGRESS_LABEL);
      expect(names).toContain("agent:claude-code");
      expect(names).not.toContain(AGENT_READY_LABEL);
    });

    test("claim reports a lost race instead of throwing", async () => {
      const { cp, seed } = make();
      seed.loseNextClaim = { id: "user-other", name: "Other" };
      const result = await cp.claim("WM-1");
      expect(result.ok).toBe(false);
      expect(result.assignee).toBe("Other");
    });

    test("comment lands on the ticket and is readable back", async () => {
      const { cp } = make();
      await cp.comment("WM-1", "working");
      const comments = await cp.listComments("WM-1");
      expect(comments.map((c) => c.body)).toEqual(["working"]);
      await expect(cp.comment("WM-999", "x")).rejects.toThrow(
        ControlPlaneError,
      );
      await expect(cp.comment("WM-1", "")).rejects.toThrow(ControlPlaneError);
    });

    test("setLabels keeps existing labels (complete-set, not a delta)", async () => {
      const { cp } = make();
      await cp.setLabels("WM-1", { add: ["type:bug"] });
      const names = (await cp.getTicket("WM-1")).labels.map((l) => l.name);
      expect(names).toContain(AGENT_READY_LABEL);
      expect(names).toContain("type:bug");
      await expect(
        cp.setLabels("WM-1", { remove: [AGENT_READY_LABEL] }),
      ).rejects.toThrow(/refusing to remove ai:agent-ready/);
      expect(
        (await cp.getTicket("WM-1")).labels.map((l) => l.name).sort(),
      ).toEqual([AGENT_READY_LABEL, "type:bug"].sort());
    });

    test("setLabels rejects unknown type:* values before mutating", async () => {
      const { cp } = make();
      await expect(
        cp.setLabels("WM-1", { add: ["type:chore"] }),
      ).rejects.toThrow(/type:chore/);
      expect((await cp.getTicket("WM-1")).labels.map((l) => l.name)).toEqual([
        AGENT_READY_LABEL,
      ]);
    });

    test("transition moves state, can unassign, and rejects unknown states", async () => {
      const { cp } = make();
      await cp.transition("WM-2", "In Review", {
        add: ["ai:needs-review"],
        remove: [IN_PROGRESS_LABEL],
        unassign: true,
      });
      const t = await cp.getTicket("WM-2");
      expect(t.state.name).toBe("In Review");
      expect(t.assignee).toBeNull();
      const names = t.labels.map((l) => l.name);
      expect(names).toContain("ai:needs-review");
      expect(names).not.toContain(IN_PROGRESS_LABEL);
      await expect(cp.transition("WM-2", "DoesNotExist")).rejects.toThrow(
        ControlPlaneError,
      );
    });

    test("file creates a ticket in Triage with the requested labels", async () => {
      const { cp } = make();
      const created = await cp.file({
        team: TEAM,
        title: "new finding",
        body: "saw this while doing WM-797",
        labels: ["type:feature", "source:agent"],
      });
      expect(created.identifier).toMatch(/^WM-/);
      expect(created.url).toBeTruthy();
      const t = await cp.getTicket(created.identifier);
      expect(t.title).toBe("new finding");
      expect(t.state.name).toBe("Triage");
      expect(t.labels.map((l) => l.name).sort()).toEqual([
        "source:agent",
        "type:feature",
      ]);
      await expect(cp.file({ team: TEAM })).rejects.toThrow(ControlPlaneError);
    });

    test("appendDetail is idempotent", async () => {
      const { cp } = make();
      const first = await cp.appendDetail(
        "WM-1",
        "## Verification\n`bun test`",
      );
      expect(first.appended).toBe(true);
      const again = await cp.appendDetail(
        "WM-1",
        "## Verification\n`bun test`",
      );
      expect(again.appended).toBe(false);
      const t = await cp.getTicket("WM-1");
      expect(t.description).toContain("## Owned Paths");
      expect(t.description).toContain("## Verification");
      expect(t.description.match(/## Verification/g)).toHaveLength(1);
    });

    test("raw is the escape hatch; unknown queries throw", async () => {
      const { cp } = make();
      expect(await cp.raw(RAW_PING)).toEqual({ ping: true });
      await expect(cp.raw("query { nope }")).rejects.toThrow(ControlPlaneError);
    });
  });
}

describe("loadControlPlane selection", () => {
  const withPolicy = (yaml) => {
    const root = tmpDir("control-plane-policy-");
    mkdirSync(path.join(root, "config"), { recursive: true });
    if (yaml !== null)
      writeFileSync(path.join(root, "config", "policy.yaml"), yaml);
    return root;
  };

  test("defaults to linear when the stanza is absent", () => {
    expect(
      controlPlaneKindFromPolicy(withPolicy("merge:\n  max_fix_rounds: 2\n")),
    ).toBe("linear");
  });

  test("falls back to config/policy.example.yaml, and fails closed when neither exists", () => {
    const root = tmpDir("control-plane-policy-fallback-");
    mkdirSync(path.join(root, "config"), { recursive: true });
    expect(() => controlPlaneKindFromPolicy(root)).toThrow(/policy\.yaml/);

    writeFileSync(
      path.join(root, "config", "policy.example.yaml"),
      "controlPlane:\n  kind: memory\n",
    );
    expect(controlPlaneKindFromPolicy(root)).toBe("memory");
    expect(loadControlPlane({ root }).kind).toBe("memory");
  });

  test("selects memory from policy and passes the seed through", async () => {
    const root = withPolicy("controlPlane:\n  kind: memory\n");
    const cp = loadControlPlane({ root, seed: freshSeed() });
    expect(cp.kind).toBe("memory");
    expect(
      (await cp.listDispatchable({ team: TEAM })).map((t) => t.identifier),
    ).toEqual(["WM-1"]);
  });

  test("an unknown kind is a configuration error, not a silent linear", () => {
    const root = withPolicy("controlPlane:\n  kind: jira\n");
    expect(() => loadControlPlane({ root })).toThrow(/controlPlane\.kind/);
    expect(() => loadControlPlane({ kind: "jira" })).toThrow(
      /unknown control-plane kind/,
    );
  });

  test("explicit kind overrides policy; gql reaches the linear impl", async () => {
    const root = withPolicy("controlPlane:\n  kind: memory\n");
    const seed = freshSeed();
    const gql = fakeGql(seed);
    const cp = loadControlPlane({ root, kind: "linear", gql });
    expect(cp.kind).toBe("linear");
    expect((await cp.getTicket("WM-1")).identifier).toBe("WM-1");
    expect(gql.calls.length).toBeGreaterThan(0);
  });

  test("the repo's own policy.yaml selects linear", () => {
    expect(loadControlPlane().kind).toBe("linear");
  });

  // ------------------------------------------------ per-repo selection ---
  // WM-1007. The point of these is the precedence chain: a repo may pick its
  // own tracker, and a repo that says nothing must INHERIT rather than
  // default, so adding the key to one repo never moves another.
  describe("per-repo control_plane", () => {
    const withRepos = (policyYaml, reposYaml) => {
      const root = tmpDir("control-plane-repos-");
      mkdirSync(path.join(root, "config"), { recursive: true });
      // null means "no explicit controlPlane stanza", not "no config file at
      // all" — write the example so the policy reader still resolves.
      writeFileSync(
        path.join(
          root,
          "config",
          policyYaml !== null ? "policy.yaml" : "policy.example.yaml",
        ),
        policyYaml ?? "",
      );
      writeFileSync(path.join(root, "config", "repos.yaml"), reposYaml);
      return root;
    };
    const REPOS = [
      "repos:",
      "  - name: onGithub",
      "    path: /tmp/on-github",
      "    control_plane: github",
      "  - name: onMemory",
      "    path: /tmp/on-memory",
      "    control_plane: memory",
      "  - name: inherits",
      "    path: /tmp/inherits",
      "",
    ].join("\n");

    test("a repo's control_plane outranks policy", () => {
      const root = withRepos("controlPlane:\n  kind: linear\n", REPOS);
      expect(loadControlPlane({ root, repoName: "onMemory" }).kind).toBe(
        "memory",
      );
    });

    test("a repo without the key inherits policy, not the default", () => {
      const root = withRepos("controlPlane:\n  kind: memory\n", REPOS);
      expect(loadControlPlane({ root, repoName: "inherits" }).kind).toBe(
        "memory",
      );
    });

    test("with neither repo key nor policy stanza it is linear", () => {
      const root = withRepos(null, REPOS);
      expect(loadControlPlane({ root, repoName: "inherits" }).kind).toBe(
        "linear",
      );
    });

    test("an explicit kind outranks the repo entry", () => {
      const root = withRepos("controlPlane:\n  kind: linear\n", REPOS);
      expect(
        loadControlPlane({ root, repoName: "onMemory", kind: "linear" }).kind,
      ).toBe("linear");
    });

    test("one repo choosing github does not move a repo that inherits", () => {
      const root = withRepos("controlPlane:\n  kind: linear\n", REPOS);
      expect(loadControlPlane({ root, repoName: "onGithub" }).kind).toBe(
        "github",
      );
      expect(loadControlPlane({ root, repoName: "inherits" }).kind).toBe(
        "linear",
      );
    });

    test("an unknown repo throws rather than falling back to policy", () => {
      const root = withRepos("controlPlane:\n  kind: linear\n", REPOS);
      expect(() => loadControlPlane({ root, repoName: "typo" })).toThrow(
        /unknown repo "typo"/,
      );
    });

    test("an invalid control_plane value is a load error naming the repo", () => {
      const root = withRepos(
        null,
        "repos:\n  - name: bad\n    path: /tmp/bad\n    control_plane: jira\n",
      );
      expect(() => loadControlPlane({ root, repoName: "bad" })).toThrow(
        /repo bad control_plane must be one of/,
      );
    });

    test("no repoName never reads the repo registry", () => {
      // repos.yaml is deliberately absent: the global path must not depend on
      // it, or every existing call site breaks in a checkout without one.
      const root = tmpDir("control-plane-no-repos-");
      mkdirSync(path.join(root, "config"), { recursive: true });
      writeFileSync(
        path.join(root, "config", "policy.yaml"),
        "controlPlane:\n  kind: memory\n",
      );
      expect(loadControlPlane({ root }).kind).toBe("memory");
    });
  });

  test("re-exports githubControlPlane from the adapter", () => {
    expect(controlPlaneIndex.githubControlPlane).toBe(
      githubControlPlaneFromAdapter,
    );
  });

  test("CONTROL_PLANE_KINDS includes github", () => {
    expect(CONTROL_PLANE_KINDS).toContain("github");
  });

  test("selects github from an explicit kind and runs getTicket / listDispatchable", async () => {
    const seed = githubSelectionSeed();
    const api = fakeGithubApi(seed);
    const cp = loadControlPlane({
      kind: "github",
      api,
      repo: GH_REPO,
      teams: { [TEAM]: GH_REPO },
    });
    expect(cp.kind).toBe("github");
    const ticket = await cp.getTicket(`${GH_REPO}#1`);
    expect(ticket.identifier).toBe(`${GH_REPO}#1`);
    expect(ticket.title).toBe("ready ticket");
    expect(ticket.state.name).toBe("Todo");
    expect(
      (await cp.listDispatchable({ team: TEAM })).map((t) => t.identifier),
    ).toEqual([`${GH_REPO}#1`]);
  });

  test("selects github from policy.yaml and passes root options through", async () => {
    const root = withPolicy(
      [
        "controlPlane:",
        "  kind: github",
        "  github:",
        `    repo: ${GH_REPO}`,
        "    teams:",
        `      ${TEAM}: ${GH_REPO}`,
        "    project: Factory",
        "",
      ].join("\n"),
    );
    expect(controlPlaneKindFromPolicy(root)).toBe("github");
    const seed = githubSelectionSeed();
    const api = fakeGithubApi(seed);
    const cp = loadControlPlane({ root, api });
    expect(cp.kind).toBe("github");
    expect(
      (await cp.listDispatchable({ team: TEAM })).map((t) => t.identifier),
    ).toEqual([`${GH_REPO}#1`]);
  });
});

function githubSelectionSeed() {
  return {
    repo: GH_REPO,
    issue: {
      id: 101,
      node_id: "I_1",
      number: 1,
      title: "ready ticket",
      body: "",
      html_url: `https://github.com/${GH_REPO}/issues/1`,
      state: "open",
      assignee: null,
      labels: [{ id: 10, name: AGENT_READY_LABEL }],
      comments: [],
    },
    project: {
      id: "PVT_1",
      title: "Factory",
      field: {
        id: "FIELD_status",
        name: "Status",
        options: [{ id: "opt-todo", name: "Todo" }],
      },
    },
    items: [
      {
        id: "PVTI_1",
        content: {
          id: "I_1",
          number: 1,
          repository: { nameWithOwner: GH_REPO },
        },
        fieldValueByName: { name: "Todo" },
      },
    ],
  };
}

function fakeGithubApi(seed) {
  const api = (method, pathName, { body, query } = {}) => {
    api.calls.push({ method, pathName, body, query });
    const pathOnly = String(pathName).replace(/^\//, "").split("?")[0];
    if (pathOnly === "graphql") {
      const q = body?.query ?? "";
      if (q.includes("FindRepoProject") || q.includes("FindViewerProject")) {
        const node = {
          id: seed.project.id,
          title: seed.project.title,
          field: seed.project.field,
        };
        return {
          data: {
            repository: { projectsV2: { nodes: [node] } },
            viewer: { projectsV2: { nodes: [node] } },
          },
        };
      }
      if (q.includes("ProjectItems")) {
        return { data: { node: { items: { nodes: seed.items } } } };
      }
      throw new ControlPlaneError("raw query not seeded");
    }
    const one = pathOnly.match(/^repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/);
    if (one && method === "GET") {
      if (one[1] !== seed.repo || Number(one[2]) !== seed.issue.number) {
        throw new ControlPlaneError("github api: Not Found", { status: 404 });
      }
      return seed.issue;
    }
    const list = pathOnly.match(/^repos\/([^/]+\/[^/]+)\/issues$/);
    if (list && method === "GET") return [seed.issue];
    // WM-1008: this minimal fake has no dependency data. Returning [] here
    // exercises the "no blockers" path; the 404-tolerance path is covered in
    // lib/control-plane/github.test.mjs.
    if (method === "GET" && /\/dependencies\/blocked_by$/.test(pathOnly))
      return [];
    throw new ControlPlaneError(`unknown github api ${method} ${pathName}`);
  };
  api.calls = [];
  return api;
}
