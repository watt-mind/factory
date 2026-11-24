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

describe("Linear ControlPlane file() metadata (GH-2446)", () => {
  function filePlane({ projects = [], issues = {} } = {}) {
    const createdInputs = [];
    const queries = [];
    const cp = linearControlPlane({
      gql: async (query, variables) => {
        queries.push({ query, variables });
        if (query.includes("teams(filter")) {
          return {
            teams: {
              nodes: [
                {
                  id: "team-wm",
                  states: {
                    nodes: [
                      { id: "st-triage", name: "Triage" },
                      { id: "st-todo", name: "Todo" },
                    ],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              ],
            },
          };
        }
        if (query.includes("issueLabels")) {
          return {
            issueLabels: {
              nodes: [{ id: "lbl-bug", name: "type:bug" }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          };
        }
        if (query.includes("projects(filter")) {
          return {
            projects: {
              nodes: projects.filter(
                (p) => p.name.toLowerCase() === variables.name.toLowerCase(),
              ),
            },
          };
        }
        if (query.includes("issue(id:$k)")) {
          return { issue: issues[variables.k] ?? null };
        }
        if (query.includes("issueCreate")) {
          createdInputs.push(variables.in);
          return {
            issueCreate: {
              success: true,
              issue: {
                identifier: "WM-99",
                url: "https://linear.app/wm/issue/WM-99",
              },
            },
          };
        }
        throw new Error(`unexpected query: ${query}`);
      },
    });
    return { cp, createdInputs, queries };
  }

  test("resolves project by name, parent by issue key, and passes priority", async () => {
    const { cp, createdInputs } = filePlane({
      projects: [{ id: "proj-uuid-1", name: "Factory" }],
      issues: { "WM-10": { id: "issue-uuid-10", identifier: "WM-10" } },
    });

    await cp.file({
      team: "WM",
      title: "Sub-issue",
      body: "details",
      labels: ["type:bug"],
      project: "factory",
      parent: "WM-10",
      priority: 2,
    });

    expect(createdInputs).toHaveLength(1);
    expect(createdInputs[0]).toMatchObject({
      teamId: "team-wm",
      title: "Sub-issue",
      projectId: "proj-uuid-1",
      parentId: "issue-uuid-10",
      priority: 2,
    });
  });

  test("accepts priority 0 and rejects invalid priorities", async () => {
    const { cp, createdInputs } = filePlane();
    await cp.file({ team: "WM", title: "Zero priority", priority: 0 });
    expect(createdInputs[0].priority).toBe(0);

    await expect(
      cp.file({ team: "WM", title: "Too high", priority: 5 }),
    ).rejects.toBeInstanceOf(ControlPlaneError);
    await expect(
      cp.file({ team: "WM", title: "Negative", priority: -1 }),
    ).rejects.toBeInstanceOf(ControlPlaneError);
  });

  test("throws ControlPlaneError when project or parent does not exist", async () => {
    const { cp } = filePlane({ projects: [], issues: {} });

    await expect(
      cp.file({ team: "WM", title: "Bad project", project: "NoSuchProject" }),
    ).rejects.toThrow("no such project: NoSuchProject");

    await expect(
      cp.file({ team: "WM", title: "Bad parent", parent: "WM-404" }),
    ).rejects.toThrow("no such parent issue: WM-404");
  });

  test("passes a UUID project directly without querying projects", async () => {
    const uuid = "12345678-1234-1234-1234-123456789abc";
    const { cp, createdInputs, queries } = filePlane();
    await cp.file({ team: "WM", title: "UUID project", project: uuid });
    expect(createdInputs[0].projectId).toBe(uuid);
    expect(queries.some((q) => q.query.includes("projects(filter"))).toBe(
      false,
    );
  });
});

describe("Linear ControlPlane timeout and transient retries (GH-2323)", () => {
  test("defaults request timeout to 30_000ms and honors FACTORY_LINEAR_TIMEOUT_MS override", async () => {
    const previousTimeout = process.env.FACTORY_LINEAR_TIMEOUT_MS;
    const originalSetTimeout = globalThis.setTimeout;
    const observedTimeouts = [];
    delete process.env.FACTORY_LINEAR_TIMEOUT_MS;
    globalThis.setTimeout = (fn, ms, ...args) => {
      observedTimeouts.push(ms);
      return originalSetTimeout(fn, ms, ...args);
    };
    try {
      const cp = linearControlPlane({
        gql: async () => ({ ping: "ok" }),
      });
      await expect(cp.raw("query { ping }")).resolves.toEqual({ ping: "ok" });
      expect(observedTimeouts).toContain(30_000);

      observedTimeouts.length = 0;
      process.env.FACTORY_LINEAR_TIMEOUT_MS = "1234";
      const overridden = linearControlPlane({
        gql: async () => ({ ping: "ok" }),
      });
      await expect(overridden.raw("query { ping }")).resolves.toEqual({
        ping: "ok",
      });
      expect(observedTimeouts).toContain(1234);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      if (previousTimeout === undefined)
        delete process.env.FACTORY_LINEAR_TIMEOUT_MS;
      else process.env.FACTORY_LINEAR_TIMEOUT_MS = previousTimeout;
    }
  });

  test("retries timed-out requests with jittered backoff and succeeds on retry", async () => {
    let attempts = 0;
    const signals = [];
    const delays = [];
    const cp = linearControlPlane({
      gql: (_query, _variables, signal) => {
        attempts++;
        signals.push(signal);
        if (attempts < 3) {
          return new Promise((_, reject) =>
            signal?.addEventListener("abort", () => reject(signal.reason)),
          );
        }
        return Promise.resolve({ ping: "recovered" });
      },
      timeoutMs: 5,
      sleep: async (ms) => {
        delays.push(ms);
      },
      random: () => 0.5,
    });

    await expect(cp.raw("query { ping }")).resolves.toEqual({
      ping: "recovered",
    });
    expect(attempts).toBe(3);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(true);
    expect(signals[2].aborted).toBe(false);
    expect(delays).toHaveLength(2);
    expect(delays[0]).toBeGreaterThan(0);
    expect(delays[1]).toBeGreaterThan(delays[0]);
  });

  test("retries transient HTTP 5xx and network errors and succeeds on retry", async () => {
    let attempts = 0;
    const delays = [];
    const cp = linearControlPlane({
      gql: async () => {
        attempts++;
        if (attempts === 1) throw new Error("HTTP 503: Service Unavailable");
        if (attempts === 2) {
          const err = new Error("socket hang up");
          err.code = "ECONNRESET";
          throw err;
        }
        return { viewer: { id: "u-1" } };
      },
      sleep: async (ms) => {
        delays.push(ms);
      },
      random: () => 0.5,
    });

    await expect(cp.raw("query { viewer { id } }")).resolves.toEqual({
      viewer: { id: "u-1" },
    });
    expect(attempts).toBe(3);
    expect(delays).toHaveLength(2);
  });

  test("throws a clear timeout error mentioning FACTORY_LINEAR_TIMEOUT_MS when retries are exhausted", async () => {
    let attempts = 0;
    const delays = [];
    const cp = linearControlPlane({
      gql: () => {
        attempts++;
        return new Promise(() => {});
      },
      timeoutMs: 5,
      sleep: async (ms) => {
        delays.push(ms);
      },
      random: () => 0.5,
    });

    let caught;
    try {
      await cp.raw("query { ping }");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ControlPlaneError);
    expect(caught.message).toContain("linear graphql timed out after 5ms");
    expect(caught.message).toContain("FACTORY_LINEAR_TIMEOUT_MS");
    expect(attempts).toBe(3);
    expect(delays).toHaveLength(2);
  });

  test("throws a clear 5xx error mentioning FACTORY_LINEAR_TIMEOUT_MS when retries are exhausted", async () => {
    let attempts = 0;
    const delays = [];
    const cp = linearControlPlane({
      gql: async () => {
        attempts++;
        throw new Error("HTTP 502: Bad Gateway");
      },
      timeoutMs: 50,
      sleep: async (ms) => {
        delays.push(ms);
      },
      random: () => 0.5,
    });

    let caught;
    try {
      await cp.raw("query { ping }");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ControlPlaneError);
    expect(caught.status).toBe(502);
    expect(caught.message).toContain("HTTP 502: Bad Gateway");
    expect(caught.message).toContain("FACTORY_LINEAR_TIMEOUT_MS");
    expect(attempts).toBe(3);
    expect(delays).toHaveLength(2);
  });

  test("does not retry 4xx, GraphQL validation errors, or Linear rate-limit errors", async () => {
    const rateLimited = Object.assign(
      new Error("linear_rate_limited: resetAt=2026-09-01T12:00:00.000Z"),
      { rateLimited: true, resetAt: "2026-09-01T12:00:00.000Z" },
    );
    const cases = [
      {
        label: "HTTP 400",
        error: new Error("HTTP 400: Bad Request"),
        expectedStatus: 400,
      },
      {
        label: "HTTP 404",
        error: Object.assign(new Error("Not Found"), { status: 404 }),
        expectedStatus: 404,
      },
      {
        label: "GraphQL validation error",
        error: new Error('[{"message":"Argument Validation Error"}]'),
        expectedStatus: null,
      },
      {
        label: "GraphQL validation error mentioning HTTP 502",
        error: new Error(
          '[{"message":"Description cannot contain HTTP 502 literal"}]',
        ),
        expectedStatus: null,
      },
      {
        label: "Linear offline guard",
        error: Object.assign(new Error("Linear network access blocked"), {
          code: "linear_offline_guard",
        }),
        expectedStatus: null,
      },
      {
        label: "Linear rate limit",
        error: rateLimited,
        expectedStatus: null,
      },
    ];

    for (const c of cases) {
      let attempts = 0;
      const delays = [];
      const cp = linearControlPlane({
        gql: async () => {
          attempts++;
          throw c.error;
        },
        sleep: async (ms) => {
          delays.push(ms);
        },
      });

      let caught;
      try {
        await cp.raw("query { ping }");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ControlPlaneError);
      expect(caught.status).toBe(c.expectedStatus);
      expect(attempts).toBe(1);
      expect(delays).toHaveLength(0);
      if (c.error === rateLimited) {
        expect(caught.cause?.rateLimited).toBe(true);
      }
    }
  });

  test("does not replay non-idempotent comment() or file() mutations on timeout or transient errors", async () => {
    const failureModes = [
      {
        label: "timeout",
        fail: () => new Promise(() => {}),
      },
      {
        label: "HTTP 503",
        fail: async () => {
          throw new Error("HTTP 503: Service Unavailable");
        },
      },
      {
        label: "ECONNRESET",
        fail: async () => {
          const err = new Error("socket hang up");
          err.code = "ECONNRESET";
          throw err;
        },
      },
    ];

    for (const mode of failureModes) {
      let commentCalls = 0;
      let createCalls = 0;
      const delays = [];
      const cp = linearControlPlane({
        gql: async (query) => {
          if (query.includes("issue(id:$k)")) {
            return {
              issue: {
                id: "issue-1",
                identifier: "WM-1",
                title: "Issue",
                state: { id: "todo", name: "Todo", type: "unstarted" },
                assignee: null,
                team: { key: "WM" },
                project: null,
                labels: { nodes: [] },
                comments: { nodes: [] },
                inverseRelations: { nodes: [] },
              },
            };
          }
          if (query.includes("teams(filter")) {
            return {
              teams: {
                nodes: [
                  {
                    id: "team-wm",
                    states: {
                      nodes: [{ id: "st-triage", name: "Triage" }],
                      pageInfo: { hasNextPage: false, endCursor: null },
                    },
                  },
                ],
              },
            };
          }
          if (query.includes("issueLabels")) {
            return {
              issueLabels: {
                nodes: [],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            };
          }
          if (query.includes("commentCreate")) {
            commentCalls++;
            return mode.fail();
          }
          if (query.includes("issueCreate")) {
            createCalls++;
            return mode.fail();
          }
          throw new Error(`unexpected query: ${query}`);
        },
        timeoutMs: 5,
        sleep: async (ms) => {
          delays.push(ms);
        },
      });

      await expect(cp.comment("WM-1", "hello")).rejects.toBeInstanceOf(
        ControlPlaneError,
      );
      expect(commentCalls).toBe(1);

      await expect(
        cp.file({ team: "WM", title: "New ticket" }),
      ).rejects.toBeInstanceOf(ControlPlaneError);
      expect(createCalls).toBe(1);
      expect(delays).toHaveLength(0);
    }
  });
});

describe("Linear ControlPlane list() and file() extensions (GH-2461)", () => {
  const sampleIssue = (overrides = {}) => ({
    id: "issue-1",
    identifier: "CLNT-101",
    title: "Desktop sync polish",
    description: "Ensure desktop tray updates cleanly",
    url: "https://linear.app/watt-mind/issue/CLNT-101",
    priority: 2,
    createdAt: "2026-10-01T10:00:00Z",
    startedAt: null,
    updatedAt: "2026-10-02T10:00:00Z",
    state: { id: "st-todo", name: "Todo", type: "unstarted" },
    assignee: { id: "user-me", name: "Laszlo" },
    team: { key: "CLNT" },
    project: { name: "Desktop" },
    labels: {
      nodes: [{ id: "l-bug", name: "type:bug" }],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
    ...overrides,
  });

  test("list() builds IssueFilter for team, project, parent, state, labels, assignee, query, and limit (GH-2461)", async () => {
    const calls = [];
    const cp = linearControlPlane({
      gql: async (query, variables) => {
        calls.push({ query, variables });
        if (query.includes("issue(id:$k)")) {
          return {
            issue: { id: "parent-uuid-9210", identifier: variables.k },
          };
        }
        if (query.includes("viewer{")) {
          return { viewer: { id: "user-me", name: "Laszlo" } };
        }
        if (query.includes("users(first:250")) {
          return {
            users: {
              nodes: [
                {
                  id: "user-ada",
                  name: "Ada Lovelace",
                  displayName: "ada",
                  email: "ada@watt-mind.com",
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          };
        }
        if (query.includes("issues(first:$first")) {
          return {
            issues: {
              nodes: [sampleIssue()],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          };
        }
        throw new Error(`unexpected query: ${query}`);
      },
    });

    const rows = await cp.list({
      team: "CLNT",
      project: "Desktop",
      parent: "CLNT-9210",
      state: "In Progress",
      labels: ["type:bug", "area:ui"],
      assignee: "self",
      query: "desktop",
      limit: 25,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].identifier).toBe("CLNT-101");

    const listCall = calls.find((c) => c.query.includes("issues(first:$first"));
    expect(listCall.variables.first).toBe(25);
    expect(listCall.variables.filter).toEqual({
      team: { key: { eq: "CLNT" } },
      project: { name: { eqIgnoreCase: "Desktop" } },
      parent: { id: { eq: "parent-uuid-9210" } },
      state: { name: { eqIgnoreCase: "In Progress" } },
      assignee: { id: { eq: "user-me" } },
      and: [
        { labels: { some: { name: { eqIgnoreCase: "type:bug" } } } },
        { labels: { some: { name: { eqIgnoreCase: "area:ui" } } } },
        {
          or: [
            { title: { containsIgnoreCase: "desktop" } },
            { description: { containsIgnoreCase: "desktop" } },
          ],
        },
      ],
    });

    // Named user lookup by displayName / email works; default open excludes completed/canceled
    calls.length = 0;
    await cp.list({ team: "CLNT", assignee: "ada@watt-mind.com" });
    const openCall = calls.find((c) => c.query.includes("issues(first:$first"));
    expect(openCall.variables.filter).toEqual({
      team: { key: { eq: "CLNT" } },
      state: { type: { nin: ["completed", "canceled"] } },
      assignee: { id: { eq: "user-ada" } },
    });

    // allStates omits the state filter; state: "closed" filters completed/canceled
    calls.length = 0;
    await cp.list({ team: "CLNT", allStates: true });
    expect(
      calls.find((c) => c.query.includes("issues(first:$first")).variables
        .filter,
    ).toEqual({ team: { key: { eq: "CLNT" } } });

    calls.length = 0;
    await cp.list({ team: "CLNT", state: "closed" });
    expect(
      calls.find((c) => c.query.includes("issues(first:$first")).variables
        .filter,
    ).toEqual({
      team: { key: { eq: "CLNT" } },
      state: { type: { in: ["completed", "canceled"] } },
    });

    // Unknown user rejects cleanly
    await expect(
      cp.list({ team: "CLNT", assignee: "ghost@example.com" }),
    ).rejects.toThrow(/no such user/i);
  });

  test("list() respects limit cap and stops paginating once limit is reached (GH-2461)", async () => {
    let pageCalls = 0;
    const cp = linearControlPlane({
      gql: async () => {
        pageCalls += 1;
        return {
          issues: {
            nodes: [
              sampleIssue({
                id: `i-${pageCalls}-1`,
                identifier: `CLNT-${pageCalls}1`,
              }),
              sampleIssue({
                id: `i-${pageCalls}-2`,
                identifier: `CLNT-${pageCalls}2`,
              }),
            ],
            pageInfo: {
              hasNextPage: true,
              endCursor: `cursor-${pageCalls}`,
            },
          },
        };
      },
    });

    const rows = await cp.list({ team: "CLNT", limit: 3 });
    expect(rows).toHaveLength(3);
    expect(pageCalls).toBe(2);
  });

  test("file() resolves --state and --assignee (self, @me, and user lookup) (GH-2461)", async () => {
    const createInputs = [];
    const cp = linearControlPlane({
      gql: async (query, variables) => {
        if (query.includes("teams(filter")) {
          return {
            teams: {
              nodes: [
                {
                  id: "team-clnt",
                  states: {
                    nodes: [
                      { id: "st-triage", name: "Triage" },
                      { id: "st-progress", name: "In Progress" },
                    ],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              ],
            },
          };
        }
        if (query.includes("issueLabels")) {
          return {
            issueLabels: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          };
        }
        if (query.includes("viewer{")) {
          return { viewer: { id: "user-viewer", name: "Laszlo" } };
        }
        if (query.includes("users(first:250")) {
          return {
            users: {
              nodes: [
                {
                  id: "user-ada",
                  name: "Ada Lovelace",
                  displayName: "ada",
                  email: "ada@watt-mind.com",
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          };
        }
        if (query.includes("issueCreate")) {
          createInputs.push(variables.in);
          return {
            issueCreate: {
              success: true,
              issue: {
                identifier: "CLNT-500",
                url: "https://linear.app/watt-mind/issue/CLNT-500",
              },
            },
          };
        }
        throw new Error(`unexpected query: ${query}`);
      },
    });

    await cp.file({
      team: "CLNT",
      title: "Self assigned",
      state: "in progress",
      assignee: "self",
    });
    expect(createInputs[0]).toMatchObject({
      stateId: "st-progress",
      assigneeId: "user-viewer",
    });

    await cp.file({
      team: "CLNT",
      title: "Named assignee",
      state: "Triage",
      assignee: "Ada Lovelace",
    });
    expect(createInputs[1]).toMatchObject({
      stateId: "st-triage",
      assigneeId: "user-ada",
    });

    await expect(
      cp.file({ team: "CLNT", title: "Bad state", state: "Nonexistent" }),
    ).rejects.toThrow(/has no "Nonexistent" state/);

    await expect(
      cp.file({ team: "CLNT", title: "Bad user", assignee: "nobody" }),
    ).rejects.toThrow(/no such user/i);
  });
});
