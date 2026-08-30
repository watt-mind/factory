import { describe, expect, test } from "bun:test";
import { linearControlPlane } from "./linear.mjs";
import { ControlPlaneError } from "./types.mjs";
import { AGENT_READY_LABEL, IN_PROGRESS_LABEL } from "./labels.mjs";

const guardLabels = [
  { id: "ready", name: AGENT_READY_LABEL },
  { id: "progress", name: IN_PROGRESS_LABEL },
  { id: "agent", name: "agent:claude-code" },
];

function guardPlane() {
  const ticket = {
    id: "issue-1",
    identifier: "WM-1",
    title: "Issue",
    state: { id: "todo", name: "Todo", type: "unstarted" },
    assignee: null,
    team: { key: "WM" },
    project: null,
    labels: { nodes: [guardLabels[0]] },
    comments: { nodes: [] },
    inverseRelations: { nodes: [] },
  };
  const updates = [];
  const cp = linearControlPlane({
    gql: async (query, variables) => {
      if (query.includes("issue(id:$k)")) return { issue: ticket };
      if (query.includes("issueLabels")) {
        return {
          issueLabels: {
            nodes: guardLabels,
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      }
      if (query.includes("teams(filter")) {
        return {
          teams: {
            nodes: [
              {
                id: "team-1",
                states: {
                  nodes: [{ id: "triage", name: "Triage" }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            ],
          },
        };
      }
      if (query.includes("issueUpdate")) {
        updates.push(variables.in);
        return { issueUpdate: { success: true } };
      }
      throw new Error(`unexpected query: ${query}`);
    },
  });
  return { cp, updates };
}

describe("Linear ControlPlane pagination (GH-1393)", () => {
  test("listTickets concatenates cursor-paginated issue results", async () => {
    const calls = [];
    const cp = linearControlPlane({
      gql: async (query, variables) => {
        calls.push({ query, variables });
        const page = variables.after ? 2 : 1;
        return {
          issues: {
            nodes: [
              {
                id: `issue-${page}`,
                identifier: `WM-${page}`,
                title: `Issue ${page}`,
                state: { id: "todo", name: "Todo", type: "started" },
                assignee: null,
                team: { key: "WM" },
                project: null,
                labels: { nodes: [] },
                comments: { nodes: [] },
                inverseRelations: { nodes: [] },
              },
            ],
            pageInfo:
              page === 1
                ? { hasNextPage: true, endCursor: "cursor-1" }
                : { hasNextPage: false, endCursor: null },
          },
        };
      },
    });

    await expect(cp.listTickets({ team: "WM" })).resolves.toMatchObject([
      { identifier: "WM-1" },
      { identifier: "WM-2" },
    ]);
    expect(calls.map(({ variables }) => variables.after)).toEqual([
      null,
      "cursor-1",
    ]);
    expect(calls[0].query).toContain("pageInfo{ hasNextPage endCursor }");
    expect(calls[0].query).toContain("$sort:[IssueSortInput!]");
    expect(calls[0].query).toContain("sort:$sort");
    expect(calls[0].query).not.toContain("IssueOrderByInput");
    expect(calls[0].variables.sort).toEqual([
      { createdAt: { order: "Ascending" } },
    ]);
  });

  test("passes an abort signal to gql and aborts it on the request timeout", async () => {
    let observed;
    const cp = linearControlPlane({
      gql: (_query, _variables, signal) => {
        observed = signal;
        return new Promise((_, reject) =>
          signal?.addEventListener("abort", () => reject(signal.reason)),
        );
      },
      timeoutMs: 1,
    });

    await expect(cp.raw("query { ping }")).rejects.toBeInstanceOf(
      ControlPlaneError,
    );
    expect(observed).toBeDefined();
    expect(observed.aborted).toBe(true);
  });

  test("paginates ticket labels and inverse relations only when needed", async () => {
    const cursors = [];
    const ticket = {
      id: "issue-1",
      identifier: "WM-1",
      title: "Issue",
      state: { id: "todo", name: "Todo", type: "started" },
      assignee: null,
      team: { key: "WM" },
      project: null,
      comments: { nodes: [] },
      labels: {
        nodes: [{ id: "first", name: "first" }],
        pageInfo: { hasNextPage: true, endCursor: "labels-1" },
      },
      inverseRelations: {
        nodes: [
          {
            type: "blocks",
            issue: {
              identifier: "WM-2",
              state: { type: "started" },
            },
          },
        ],
        pageInfo: { hasNextPage: true, endCursor: "relations-1" },
      },
    };
    const cp = linearControlPlane({
      gql: async (query, variables) => {
        if (query.includes("issue(id:$k)")) return { issue: ticket };
        if (query.includes("TicketLabelsPage")) {
          cursors.push(["labels", variables.after]);
          return {
            issue: {
              labels: {
                nodes: [{ id: "second", name: "second" }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          };
        }
        if (query.includes("TicketRelationsPage")) {
          cursors.push(["relations", variables.after]);
          return {
            issue: {
              inverseRelations: {
                nodes: [
                  {
                    type: "blocks",
                    issue: {
                      identifier: "WM-3",
                      state: { type: "started" },
                    },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          };
        }
        throw new Error(`unexpected query: ${query}`);
      },
    });

    await expect(cp.getTicket("WM-1")).resolves.toMatchObject({
      labels: [{ name: "first" }, { name: "second" }],
      blockedBy: ["WM-2", "WM-3"],
    });
    expect(cursors).toEqual([
      ["labels", "labels-1"],
      ["relations", "relations-1"],
    ]);
  });

  test("paginates workflow states after the first page", async () => {
    let update;
    const ticket = {
      id: "issue-1",
      identifier: "WM-1",
      title: "Issue",
      state: { id: "todo", name: "Todo", type: "started" },
      assignee: null,
      team: { key: "WM" },
      project: null,
      labels: { nodes: [] },
      comments: { nodes: [] },
      inverseRelations: { nodes: [] },
    };
    const cp = linearControlPlane({
      gql: async (query, variables) => {
        if (query.includes("issue(id:$k)")) return { issue: ticket };
        if (query.includes("teams(filter"))
          return {
            teams: {
              nodes: [
                {
                  id: "team-1",
                  states: {
                    nodes: [{ id: "todo", name: "Todo" }],
                    pageInfo: { hasNextPage: true, endCursor: "states-1" },
                  },
                },
              ],
            },
          };
        if (query.includes("TeamStatesPage")) {
          expect(variables.after).toBe("states-1");
          return {
            team: {
              states: {
                nodes: [{ id: "review", name: "In Review" }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          };
        }
        if (query.includes("issueUpdate")) {
          update = variables.in;
          return { issueUpdate: { success: true } };
        }
        throw new Error(`unexpected query: ${query}`);
      },
    });

    await cp.transition("WM-1", "In Review");
    expect(update).toEqual({ stateId: "review" });
  });

  test("setLabels resolves a label from the second cursor page", async () => {
    const labelCursors = [];
    let update = null;
    const cp = linearControlPlane({
      gql: async (query, variables) => {
        if (query.includes("issueLabels")) {
          labelCursors.push(variables.after);
          const page = variables.after ? 2 : 1;
          return {
            issueLabels: {
              nodes:
                page === 1
                  ? [{ id: "first", name: "first" }]
                  : [{ id: "second", name: "second" }],
              pageInfo:
                page === 1
                  ? { hasNextPage: true, endCursor: "labels-1" }
                  : { hasNextPage: false, endCursor: null },
            },
          };
        }
        if (query.includes("issueUpdate")) {
          update = variables.in;
          return { issueUpdate: { success: true } };
        }
        if (query.includes("issue(id:$k)")) {
          return {
            issue: {
              id: "issue-1",
              identifier: "WM-1",
              title: "Issue",
              state: { id: "todo", name: "Todo", type: "started" },
              assignee: null,
              team: { key: "WM" },
              project: null,
              labels: { nodes: [] },
              comments: { nodes: [] },
              inverseRelations: { nodes: [] },
            },
          };
        }
        throw new Error(`unexpected query: ${query}`);
      },
    });

    await cp.setLabels("WM-1", { add: ["second"] });
    expect(labelCursors).toEqual([null, "labels-1"]);
    expect(update).toEqual({ labelIds: ["second"] });
  });

  test("checks a missing transition label with one label-catalog query", async () => {
    let labelQueries = 0;
    const cp = linearControlPlane({
      gql: async (query) => {
        if (query.includes("issue(id:$k)")) {
          return {
            issue: {
              id: "issue-1",
              identifier: "WM-1",
              title: "Issue",
              state: { id: "todo", name: "Todo", type: "started" },
              assignee: null,
              team: { key: "WM" },
              project: null,
              labels: { nodes: [] },
              comments: { nodes: [] },
              inverseRelations: { nodes: [] },
            },
          };
        }
        if (query.includes("issueLabels")) {
          labelQueries++;
          return {
            issueLabels: {
              nodes: [{ id: "existing", name: "existing" }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          };
        }
        throw new Error(`unexpected query: ${query}`);
      },
    });

    await expect(
      cp.transition("WM-1", undefined, { add: ["missing"] }),
    ).rejects.toThrow("label(s) do not exist in this workspace: missing");
    expect(labelQueries).toBe(1);
  });

  test("listComments concatenates cursor-paginated comment results", async () => {
    const cursors = [];
    const cp = linearControlPlane({
      gql: async (_query, variables) => {
        cursors.push(variables.after);
        const page = variables.after ? 2 : 1;
        return {
          issue: {
            comments: {
              nodes: [{ id: `comment-${page}`, body: `Comment ${page}` }],
              pageInfo:
                page === 1
                  ? { hasNextPage: true, endCursor: "comments-1" }
                  : { hasNextPage: false, endCursor: null },
            },
          },
        };
      },
    });

    await expect(cp.listComments("WM-1")).resolves.toMatchObject([
      { id: "comment-1" },
      { id: "comment-2" },
    ]);
    expect(cursors).toEqual([null, "comments-1"]);
  });

  test("rejects a hung request at its configured timeout", async () => {
    const cp = linearControlPlane({
      gql: () => new Promise(() => {}),
      timeoutMs: 1,
    });

    await expect(cp.raw("query { ping }")).rejects.toBeInstanceOf(
      ControlPlaneError,
    );
    await expect(cp.raw("query { ping }")).rejects.toThrow(
      "linear graphql timed out after 1ms",
    );
  });

  test("refuses bare transition and label removals before updating", async () => {
    for (const removeReady of [
      (cp) => cp.transition("WM-1", undefined, { remove: [AGENT_READY_LABEL] }),
      (cp) => cp.setLabels("WM-1", { remove: [AGENT_READY_LABEL] }),
    ]) {
      const { cp, updates } = guardPlane();
      await expect(removeReady(cp)).rejects.toThrow(/refusing to remove/);
      expect(updates).toEqual([]);
    }
  });

  test("allows a claim write and a move out of Todo", async () => {
    const claimed = guardPlane();
    await claimed.cp.setLabels("WM-1", {
      add: [IN_PROGRESS_LABEL, "agent:claude-code"],
      remove: [AGENT_READY_LABEL],
    });
    expect(claimed.updates).toEqual([{ labelIds: ["progress", "agent"] }]);

    const moved = guardPlane();
    await moved.cp.transition("WM-1", "Triage", {
      remove: [AGENT_READY_LABEL],
    });
    expect(moved.updates).toEqual([{ stateId: "triage", labelIds: [] }]);
  });
});
