import { describe, expect, test } from "bun:test";
import { linearControlPlane } from "./linear.mjs";
import { ControlPlaneError } from "./types.mjs";

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
});
