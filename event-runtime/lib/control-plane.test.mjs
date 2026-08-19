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
import { memoryControlPlane } from "../../lib/control-plane/memory.mjs";

const TEAM = "WM";
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
  };
}

/**
 * A `gql` that answers from the seed. Mutates the shared seed so both
 * implementations can be asserted through the same fixture.
 */
function fakeGql(seed) {
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
      const team = variables.t;
      const project = variables.p;
      const nodes = seed.tickets.filter((t) => {
        if ((t.team?.key ?? "") !== team) return false;
        if (project && t.project?.name !== project) return false;
        if ((t.state?.name ?? "").toLowerCase() !== "todo") return false;
        if (t.assignee) return false;
        return true;
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
      await cp.setLabels("WM-1", { remove: [AGENT_READY_LABEL] });
      expect((await cp.getTicket("WM-1")).labels.map((l) => l.name)).toEqual([
        "type:bug",
      ]);
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

  test("defaults to linear when the stanza or the file is absent", () => {
    expect(
      controlPlaneKindFromPolicy(withPolicy("merge:\n  max_fix_rounds: 2\n")),
    ).toBe("linear");
    expect(controlPlaneKindFromPolicy(withPolicy(null))).toBe("linear");
    expect(loadControlPlane({ root: withPolicy(null) }).kind).toBe("linear");
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
});
