import { describe, expect, test } from "bun:test";
import { linearControlPlane } from "./linear.mjs";
import { ControlPlaneError } from "./types.mjs";
import { AGENT_READY_LABEL, IN_PROGRESS_LABEL } from "./labels.mjs";
import {
  LINEAR_TELEMETRY,
  recordLinearResponse,
  summarizeLinearRequests,
} from "../../tools/ticket.mjs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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

test("Linear response telemetry records a caller, ticket, headers, and budget delta", () => {
  const root = mkdtempSync(path.join(tmpdir(), "factory-linear-log-"));
  const previousLogDir = process.env.LINEAR_REQUEST_LOG_DIR;
  const previousCacheDir = process.env.LINEAR_CACHE_DIR;
  process.env.LINEAR_REQUEST_LOG_DIR = root;
  process.env.LINEAR_CACHE_DIR = path.join(root, "cache");
  try {
    recordLinearResponse(
      new Response("{}", {
        status: 200,
        headers: {
          "x-ratelimit-requests-remaining": "499",
          "x-ratelimit-requests-limit": "2500",
          "x-ratelimit-requests-reset": "1787150400",
        },
      }),
      { caller: "lib/control-plane/linear", ticket: "WM-2203" },
      { now: () => new Date("2026-09-01T12:00:00.000Z") },
    );
    recordLinearResponse(
      new Response("{}", {
        status: 200,
        headers: { "x-ratelimit-requests-remaining": "498" },
      }),
      { caller: "lib/control-plane/linear", ticket: "WM-2203" },
      { now: () => new Date("2026-09-01T12:00:01.000Z") },
    );
    const [entry, deltaEntry] = readFileSync(
      path.join(root, "linear-requests.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map(JSON.parse);
    expect(entry).toMatchObject({
      timestamp: "2026-09-01T12:00:00.000Z",
      caller: "lib/control-plane/linear",
      // GH-2203: `caller` names only the module. Without the process identity
      // serve, a worker and the CLI are indistinguishable in this log.
      process: path.basename(process.argv[1] ?? ""),
      pid: process.pid,
      role: process.env.FACTORY_ROLE ?? null,
      ticket: "WM-2203",
      status: 200,
      rateLimit: { requestsRemaining: 499, requestsLimit: 2500 },
      budgetDelta: null,
    });
    expect(deltaEntry.budgetDelta).toBe(-1);
    expect(
      summarizeLinearRequests({
        dir: root,
        now: Date.parse("2026-09-01T12:01:00.000Z"),
      }),
    ).toEqual([
      {
        caller: "lib/control-plane/linear",
        process: path.basename(process.argv[1] ?? ""),
        requests: 2,
        failures: 0,
        latestRemaining: 498,
        budgetDelta: -1,
      },
    ]);
  } finally {
    if (previousLogDir === undefined) delete process.env.LINEAR_REQUEST_LOG_DIR;
    else process.env.LINEAR_REQUEST_LOG_DIR = previousLogDir;
    if (previousCacheDir === undefined) delete process.env.LINEAR_CACHE_DIR;
    else process.env.LINEAR_CACHE_DIR = previousCacheDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Linear request logging fails open when the log directory is unusable", () => {
  const root = mkdtempSync(path.join(tmpdir(), "factory-linear-failopen-"));
  const blocker = path.join(root, "blocker");
  writeFileSync(blocker, "not a directory");
  const previousLogDir = process.env.LINEAR_REQUEST_LOG_DIR;
  const previousCacheDir = process.env.LINEAR_CACHE_DIR;
  // A regular file cannot be a parent directory, so mkdirSync throws ENOTDIR.
  process.env.LINEAR_REQUEST_LOG_DIR = path.join(blocker, "run");
  process.env.LINEAR_CACHE_DIR = path.join(root, "cache");
  try {
    expect(() =>
      recordLinearResponse(
        new Response("{}", {
          status: 200,
          headers: { "x-ratelimit-requests-remaining": "400" },
        }),
        { caller: "lib/control-plane/linear", ticket: "WM-2203" },
      ),
    ).not.toThrow();
    // The Linear call path is unaffected: the plane still answers normally
    // while telemetry is undeliverable.
    expect(summarizeLinearRequests({ dir: path.join(blocker, "run") })).toEqual(
      [],
    );
  } finally {
    if (previousLogDir === undefined) delete process.env.LINEAR_REQUEST_LOG_DIR;
    else process.env.LINEAR_REQUEST_LOG_DIR = previousLogDir;
    if (previousCacheDir === undefined) delete process.env.LINEAR_CACHE_DIR;
    else process.env.LINEAR_CACHE_DIR = previousCacheDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Linear request logging records no credentials and no request body", () => {
  const root = mkdtempSync(path.join(tmpdir(), "factory-linear-redact-"));
  const previousLogDir = process.env.LINEAR_REQUEST_LOG_DIR;
  const previousCacheDir = process.env.LINEAR_CACHE_DIR;
  process.env.LINEAR_REQUEST_LOG_DIR = root;
  process.env.LINEAR_CACHE_DIR = path.join(root, "cache");
  const secret = "lin_api_SUPERSECRETKEY";
  try {
    const response = new Response(
      JSON.stringify({ data: { issue: { identifier: "WM-2203" } } }),
      {
        status: 200,
        headers: {
          "x-ratelimit-requests-remaining": "400",
          authorization: secret,
          "set-cookie": `session=${secret}`,
        },
      },
    );
    recordLinearResponse(response, {
      caller: "lib/control-plane/linear",
      ticket: "WM-2203",
    });
    const line = readFileSync(
      path.join(root, "linear-requests.jsonl"),
      "utf8",
    ).trim();
    expect(line).not.toContain(secret);
    expect(line.toLowerCase()).not.toContain("authorization");
    expect(line.toLowerCase()).not.toContain("cookie");
    expect(line).not.toContain("mutation");
    expect(line).not.toContain("issueUpdate");
    // Only the declared telemetry keys are persisted.
    expect(Object.keys(JSON.parse(line)).sort()).toEqual([
      "budgetDelta",
      "caller",
      "pid",
      "process",
      "rateLimit",
      "role",
      "status",
      "ticket",
      "timestamp",
    ]);
  } finally {
    if (previousLogDir === undefined) delete process.env.LINEAR_REQUEST_LOG_DIR;
    else process.env.LINEAR_REQUEST_LOG_DIR = previousLogDir;
    if (previousCacheDir === undefined) delete process.env.LINEAR_CACHE_DIR;
    else process.env.LINEAR_CACHE_DIR = previousCacheDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("the control plane names the ticket of an operation that has no $k", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "factory-linear-ref-"));
  const previous = {
    logDir: process.env.LINEAR_REQUEST_LOG_DIR,
    cacheDir: process.env.LINEAR_CACHE_DIR,
    key: process.env.LINEAR_API_KEY,
    allow: process.env.FACTORY_LINEAR_ALLOW_NETWORK,
    offline: process.env.FACTORY_LINEAR_OFFLINE,
    fetch: globalThis.fetch,
  };
  process.env.LINEAR_REQUEST_LOG_DIR = root;
  process.env.LINEAR_CACHE_DIR = path.join(root, "cache");
  process.env.LINEAR_API_KEY = "test-key";
  process.env.FACTORY_LINEAR_ALLOW_NETWORK = "1";
  delete process.env.FACTORY_LINEAR_OFFLINE;
  const telemetry = [];
  // Every request is served from this stub; no socket is ever opened.
  globalThis.fetch = async (_url, init) => {
    telemetry.push(init?.[LINEAR_TELEMETRY]);
    return new Response(
      JSON.stringify({
        data: { issueUpdate: { success: true }, issue: { id: "issue-1" } },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  try {
    // `replaceDetail` reads by key and then mutates by UUID: the mutation
    // carries no `$k`, which is exactly the case the ticket ref must cover.
    await linearControlPlane().replaceDetail("WM-2203", "body");
    expect(telemetry.length).toBeGreaterThan(1);
    expect(telemetry.map((t) => t?.ticket)).toEqual(
      telemetry.map(() => "WM-2203"),
    );
    expect(telemetry[0]?.caller).toBe("lib/control-plane/linear");
  } finally {
    globalThis.fetch = previous.fetch;
    const restore = (name, value) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore("LINEAR_REQUEST_LOG_DIR", previous.logDir);
    restore("LINEAR_CACHE_DIR", previous.cacheDir);
    restore("LINEAR_API_KEY", previous.key);
    restore("FACTORY_LINEAR_ALLOW_NETWORK", previous.allow);
    restore("FACTORY_LINEAR_OFFLINE", previous.offline);
    rmSync(root, { recursive: true, force: true });
  }
});

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
