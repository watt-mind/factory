/**
 * bun test
 *
 * The label logic is the dangerous part. Linear's issueUpdate takes the
 * COMPLETE label set rather than a delta, so a function that returns "the
 * labels to add" instead of "the labels the ticket should end up with" silently
 * strips every other label on the ticket. That is data loss with no error, on
 * tickets a human curated — so it gets real tests.
 */
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { test, expect } from "bun:test";
import {
  resolveLabelIds,
  claimLabels,
  validateLabels,
  formatTicket,
  agentLabel,
  TYPE_LABELS,
  formatComment,
  formatComments,
  parsePositionalArgs,
  transitionThenComment,
  fileTicket,
  closureCheckMessages,
  descriptionReplacementRequest,
  replacementSucceeded,
  resolveRepoName,
  resolveRepoNameFromTicket,
  normalizeTicketRef,
  resolveRepoNameForFile,
  instanceConfigRoot,
  InstanceConfigMissingError,
  __resetLinearReposCache,
  assertLinearNetworkAllowed,
  LinearOfflineGuardError,
  LINEAR_OFFLINE_GUARD_EXIT,
  linearNetworkIsOffline,
} from "./ticket.mjs";
import { gql } from "../orchestrator/reaper.mjs";

const LABELS = [
  { id: "l-ready", name: "ai:agent-ready" },
  { id: "l-prog", name: "ai:in-progress" },
  { id: "l-claude", name: "agent:claude-code" },
  { id: "l-codex", name: "agent:codex" },
  { id: "l-bug", name: "type:bug" },
  { id: "l-area", name: "area:api" },
  { id: "l-review", name: "ai:needs-review" },
];

test("the Linear offline guard identifies its trigger and escape hatch", () => {
  expect(linearNetworkIsOffline({ FACTORY_LINEAR_OFFLINE: "1" })).toBe(true);
  let thrown;
  try {
    assertLinearNetworkAllowed("https://api.linear.app/graphql", {
      FACTORY_LINEAR_OFFLINE: "1",
    });
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(LinearOfflineGuardError);
  expect(thrown?.message).toBe(
    "linear_offline_guard: Linear network access is disabled by FACTORY_LINEAR_OFFLINE=1; set FACTORY_LINEAR_ALLOW_NETWORK=1 to allow Linear network access",
  );
  expect(thrown?.exitCode).toBe(LINEAR_OFFLINE_GUARD_EXIT);
  expect(() =>
    assertLinearNetworkAllowed("https://api.linear.app/graphql", {
      FACTORY_LINEAR_OFFLINE: "1",
      FACTORY_LINEAR_ALLOW_NETWORK: "1",
    }),
  ).not.toThrow();
});

test("the Linear transport fails offline before credential lookup or retry", async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.LINEAR_API_KEY;
  const previousOffline = process.env.FACTORY_LINEAR_OFFLINE;
  const previousAllow = process.env.FACTORY_LINEAR_ALLOW_NETWORK;
  let calls = 0;
  delete process.env.LINEAR_API_KEY;
  process.env.FACTORY_LINEAR_OFFLINE = "1";
  delete process.env.FACTORY_LINEAR_ALLOW_NETWORK;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("{}", { status: 200 });
  };

  try {
    let thrown;
    try {
      await gql("query { ping }", {}, { retries: 5 });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LinearOfflineGuardError);
    expect(thrown?.exitCode).toBe(LINEAR_OFFLINE_GUARD_EXIT);
    expect(calls).toBe(0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.LINEAR_API_KEY;
    else process.env.LINEAR_API_KEY = previousKey;
    if (previousOffline === undefined)
      delete process.env.FACTORY_LINEAR_OFFLINE;
    else process.env.FACTORY_LINEAR_OFFLINE = previousOffline;
    if (previousAllow === undefined)
      delete process.env.FACTORY_LINEAR_ALLOW_NETWORK;
    else process.env.FACTORY_LINEAR_ALLOW_NETWORK = previousAllow;
  }
});

test("the Linear transport does not retry a 429 rate-limit response", async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.LINEAR_API_KEY;
  const previousAllow = process.env.FACTORY_LINEAR_ALLOW_NETWORK;
  let calls = 0;
  process.env.LINEAR_API_KEY = "test-key";
  process.env.FACTORY_LINEAR_ALLOW_NETWORK = "1";
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('{"errors":[{"message":"RATELIMITED"}]}', {
      status: 429,
      headers: {
        "x-ratelimit-requests-remaining": "0",
        "x-ratelimit-requests-reset": "1786539600",
      },
    });
  };

  try {
    let thrown = null;
    try {
      await gql("query { ping }", {}, { retries: 5 });
    } catch (err) {
      thrown = err;
    }
    expect(String(thrown?.message)).toContain("linear_rate_limited");
    // The raw header is a unix epoch; consumers get the ISO reset clock.
    expect(thrown?.resetAt).toBe(new Date(1786539600 * 1000).toISOString());
    expect(calls).toBe(1);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.LINEAR_API_KEY;
    else process.env.LINEAR_API_KEY = previousKey;
    if (previousAllow === undefined)
      delete process.env.FACTORY_LINEAR_ALLOW_NETWORK;
    else process.env.FACTORY_LINEAR_ALLOW_NETWORK = previousAllow;
  }
});

// ------------------------------------------------------------ label math ---
test("adding a label KEEPS the labels already on the ticket", () => {
  const ids = resolveLabelIds(
    ["type:bug", "area:api"],
    { add: ["ai:needs-review"] },
    LABELS,
  );
  expect(ids).toContain("l-bug");
  expect(ids).toContain("l-area");
  expect(ids).toContain("l-review");
  expect(ids).toHaveLength(3);
});

test("removing takes out only the named label", () => {
  const ids = resolveLabelIds(
    ["type:bug", "ai:agent-ready"],
    { remove: ["ai:agent-ready"] },
    LABELS,
  );
  expect(ids).toEqual(["l-bug"]);
});

test("unknown label names are dropped rather than sent as undefined ids", () => {
  // A stale label removed from the workspace must not become `undefined` in the
  // mutation array — Linear rejects the whole update, losing the state change.
  const ids = resolveLabelIds(
    ["type:bug", "area:deleted-label"],
    { add: [] },
    LABELS,
  );
  expect(ids).toEqual(["l-bug"]);
});

test("the result never contains duplicates", () => {
  const ids = resolveLabelIds(["type:bug"], { add: ["type:bug"] }, LABELS);
  expect(ids).toEqual(["l-bug"]);
});

// ----------------------------------------------------------------- claim ---
test("the claude harness maps to the label that actually exists in Linear", () => {
  // `claude` on the CLI is `agent:claude-code` in the workspace. Getting this
  // wrong fails silently: unresolved ids are filtered out, so the ticket simply
  // never records which harness holds it.
  expect(agentLabel("claude")).toBe("agent:claude-code");
  expect(agentLabel("codex")).toBe("agent:codex");
  expect(agentLabel("gemini")).toBe("agent:gemini");
});

test("claiming drops agent-ready and adds in-progress plus the harness label", () => {
  const { add, remove } = claimLabels(["ai:agent-ready", "type:bug"], "claude");
  expect(add).toEqual(["ai:in-progress", "agent:claude-code"]);
  expect(remove).toContain("ai:agent-ready");

  const ids = resolveLabelIds(
    ["ai:agent-ready", "type:bug"],
    { add, remove },
    LABELS,
  );
  expect(ids).toContain("l-prog");
  expect(ids).toContain("l-claude");
  expect(ids).toContain("l-bug"); // curated label survives
  expect(ids).not.toContain("l-ready"); // lifecycle flag replaced
});

test("re-claiming on a different harness does not leave two agent:* labels", () => {
  const { add, remove } = claimLabels(
    ["agent:codex", "ai:in-progress"],
    "claude",
  );
  expect(remove).toContain("agent:codex");
  const ids = resolveLabelIds(
    ["agent:codex", "ai:in-progress"],
    { add, remove },
    LABELS,
  );
  expect(ids).toContain("l-claude");
  expect(ids).not.toContain("l-codex");
});

// ------------------------------------------------------------ validation ---
test("type:chore is rejected with the list of values that work", () => {
  const bad = validateLabels(["type:chore"]);
  expect(bad).toHaveLength(1);
  expect(bad[0]).toContain("maintenance");
});

test("every documented type:* value passes", () => {
  expect(validateLabels(TYPE_LABELS.map((t) => `type:${t}`))).toEqual([]);
});

test("an unknown source:* is rejected; area:* is free-form and is not", () => {
  expect(validateLabels(["source:invented"])).toHaveLength(1);
  expect(validateLabels(["source:agent", "area:anything-goes"])).toEqual([]);
});

// -------------------------------------------------------------- rendering ---
test("formatTicket shows the fields the protocol acts on", () => {
  const text = formatTicket({
    identifier: "CLNT-616",
    title: "Fix login",
    url: "https://linear.app/x/CLNT-616",
    state: { name: "Todo" },
    assignee: null,
    labels: [{ name: "ai:agent-ready" }],
  });
  expect(text).toContain("CLNT-616");
  expect(text).toContain("Todo");
  expect(text).toContain("(unassigned)");
  expect(text).toContain("ai:agent-ready");
});

test("formatTicket still accepts Linear's { nodes } label wrapper", () => {
  const text = formatTicket({
    identifier: "CLNT-1",
    title: "x",
    labels: { nodes: [{ name: "type:bug" }] },
  });
  expect(text).toContain("type:bug");
});

// ------------------------------------------------------------- comments ---
test("formatComment formats author, timestamp, and body", () => {
  const text = formatComment({
    user: { id: "u-1", name: "Laszlo Racz" },
    createdAt: "2026-08-14T12:00:00.000Z",
    body: "## Handoff\n- PR: https://github.com/org/repo/pull/1\n- Verification: pass",
  });
  expect(text).toContain("Laszlo Racz");
  expect(text).toContain("2026-08-14T12:00:00.000Z");
  expect(text).toContain("## Handoff");
});

test("formatComment handles missing user and missing timestamp gracefully", () => {
  const text = formatComment({
    body: "Automated comment",
  });
  expect(text).toContain("(unknown)");
  expect(text).toContain("Automated comment");
});

test("formatComments handles empty comment list", () => {
  expect(formatComments([])).toBe("(no comments)");
  expect(formatComments({ comments: { nodes: [] } })).toBe("(no comments)");
});

test("formatComments joins multiple comments in chronological order with delimiter", () => {
  const comments = [
    {
      user: { name: "Alice" },
      createdAt: "2026-08-14T10:00:00.000Z",
      body: "First comment",
    },
    {
      user: { name: "Bob" },
      createdAt: "2026-08-14T11:00:00.000Z",
      body: "Second comment",
    },
  ];
  const text = formatComments(comments);
  expect(text).toContain("Alice");
  expect(text).toContain("First comment");
  expect(text).toContain("Bob");
  expect(text).toContain("Second comment");
  expect(text).toContain("---");
  expect(text.indexOf("Alice")).toBeLessThan(text.indexOf("Bob"));
});

test("formatComments accepts issue object containing comments nodes", () => {
  const issue = {
    identifier: "OPS-294",
    comments: {
      nodes: [
        {
          user: { name: "Charlie" },
          createdAt: "2026-08-14T12:00:00.000Z",
          body: "Testing issue comments wrapper",
        },
      ],
    },
  };
  const text = formatComments(issue);
  expect(text).toContain("Charlie");
  expect(text).toContain("Testing issue comments wrapper");
});

// ------------------------------------------------------- argument parsing ---
test("state label-only updates do not parse flag values as positional arguments", () => {
  expect(
    parsePositionalArgs([
      "state",
      "WM-250",
      "--add",
      "ai:needs-review",
      "--remove",
      "ai:in-progress",
    ]),
  ).toEqual(["WM-250"]);
});

test("state and label updates preserve the explicit state positional argument", () => {
  expect(
    parsePositionalArgs([
      "state",
      "WM-250",
      "In Review",
      "--add",
      "ai:needs-review",
    ]),
  ).toEqual(["WM-250", "In Review"]);
});

// ------------------------------------------------------- state comments ---
test("state posts its optional comment only after the transition succeeds", async () => {
  const calls = [];
  const cp = {
    async transition(...args) {
      calls.push(["transition", ...args]);
    },
    async comment(...args) {
      calls.push(["comment", ...args]);
    },
  };

  await transitionThenComment(
    cp,
    "WM-910",
    "Todo",
    { add: ["ai:agent-ready"], remove: [], unassign: false },
    "standard scope with focused verification",
  );

  expect(calls).toEqual([
    [
      "transition",
      "WM-910",
      "Todo",
      { add: ["ai:agent-ready"], remove: [], unassign: false },
    ],
    ["comment", "WM-910", "standard scope with focused verification"],
  ]);
});

test("state without a comment preserves transition-only behavior", async () => {
  const calls = [];
  const cp = {
    async transition(...args) {
      calls.push(["transition", ...args]);
    },
    async comment(...args) {
      calls.push(["comment", ...args]);
    },
  };

  await transitionThenComment(
    cp,
    "WM-910",
    "Todo",
    { add: [], remove: [], unassign: false },
    undefined,
  );

  expect(calls).toEqual([
    ["transition", "WM-910", "Todo", { add: [], remove: [], unassign: false }],
  ]);
});

test("state does not post a comment when the transition fails", async () => {
  const calls = [];
  const cp = {
    async transition() {
      calls.push("transition");
      throw new Error("transition rejected");
    },
    async comment() {
      calls.push("comment");
    },
  };

  await expect(
    transitionThenComment(cp, "WM-910", "Todo", {}, "do not post"),
  ).rejects.toThrow("transition rejected");
  expect(calls).toEqual(["transition"]);
});

// ------------------------------------------------------------- file verb ---

function fileHarness(result) {
  const calls = [];
  const emitted = [];
  const exits = [];
  const cp = {
    async file(opts) {
      calls.push(opts);
      return result;
    },
  };
  const io = {
    emit: (obj, text) => emitted.push({ obj, text }),
    setExitCode: (code) => exits.push(code),
  };
  return { cp, calls, emitted, exits, io };
}

test("file surfaces control-plane warnings: warning line, ok:false, exit 1", async () => {
  const { cp, emitted, exits, io } = fileHarness({
    identifier: "watt-mind/factory#42",
    url: "https://github.com/watt-mind/factory/issues/42",
    warnings: [
      "watt-mind/factory#42 exists, but a follow-up write failed: boom",
    ],
  });
  const before = process.exitCode ?? 0;
  try {
    await fileTicket(
      cp,
      { team: "WM", title: "t", body: "", labels: [], state: "Triage" },
      io,
    );
  } finally {
    process.exitCode = before;
  }
  expect(emitted).toHaveLength(1);
  expect(emitted[0].obj).toMatchObject({
    ok: false,
    identifier: "watt-mind/factory#42",
    warnings: [expect.stringContaining("follow-up write failed")],
  });
  expect(emitted[0].text).toBe(
    "filed watt-mind/factory#42 in Triage  https://github.com/watt-mind/factory/issues/42\nwarning: watt-mind/factory#42 exists, but a follow-up write failed: boom",
  );
  expect(exits).toEqual([1]);
});

test("file sets process.exitCode=1 on warnings by default", async () => {
  const { cp, io } = fileHarness({
    identifier: "WM-1",
    url: "u",
    warnings: ["off the board"],
  });
  // Bun ignores `process.exitCode = undefined`, so restore to a number: a
  // stale 1 here would make the whole suite exit non-zero with 0 failures.
  const before = process.exitCode ?? 0;
  try {
    process.exitCode = 0;
    await fileTicket(
      cp,
      { team: "WM", title: "t", state: "Triage" },
      { emit: io.emit },
    );
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = before;
  }
});

test("file without warnings prints the clean line, ok:true, and leaves the exit code alone", async () => {
  const { cp, calls, emitted, exits, io } = fileHarness({
    identifier: "WM-2",
    url: "https://linear.app/wm/issue/WM-2",
  });
  await fileTicket(
    cp,
    { team: "WM", title: "t", body: "b", labels: ["type:bug"], state: "Todo" },
    io,
  );
  expect(emitted[0].obj).toEqual({
    ok: true,
    identifier: "WM-2",
    url: "https://linear.app/wm/issue/WM-2",
  });
  expect(emitted[0].text).toBe(
    "filed WM-2 in Todo  https://linear.app/wm/issue/WM-2",
  );
  expect(exits).toEqual([]);
  // No dedupe key: neither dedupeKey nor matchTitle reaches the control plane.
  expect(calls[0]).toEqual({
    team: "WM",
    title: "t",
    body: "b",
    labels: ["type:bug"],
    state: "Todo",
    projectId: undefined,
  });
  expect("dedupeKey" in calls[0]).toBe(false);
  expect("matchTitle" in calls[0]).toBe(false);
});

test("file --dedupe-key K passes dedupeKey:'K' with matchTitle:true", async () => {
  const { cp, calls, io } = fileHarness({ identifier: "WM-3", url: "u" });
  await fileTicket(
    cp,
    { team: "WM", title: "t", state: "Triage", dedupeKey: " K " },
    io,
  );
  expect(calls[0]).toMatchObject({ dedupeKey: "K", matchTitle: true });
});

test("file says 'reused' when the control plane deduplicated onto an existing issue", async () => {
  const { cp, emitted, exits, io } = fileHarness({
    identifier: "watt-mind/factory#7",
    url: "https://github.com/watt-mind/factory/issues/7",
    reused: true,
    warnings: ["reused closed issue #7: the dedupe key matched a closed issue"],
  });
  await fileTicket(
    cp,
    { team: "WM", title: "t", state: "Triage", dedupeKey: "run-1" },
    io,
  );
  expect(emitted[0].text).toBe(
    "reused watt-mind/factory#7 in Triage  https://github.com/watt-mind/factory/issues/7\nwarning: reused closed issue #7: the dedupe key matched a closed issue",
  );
  expect(emitted[0].obj).toMatchObject({ ok: false, reused: true });
  expect(exits).toEqual([1]);
});

test("values for other flags are not treated as positional arguments", () => {
  expect(
    parsePositionalArgs(["claim", "WM-250", "--agent", "codex", "--json"]),
  ).toEqual(["WM-250"]);
  expect(
    parsePositionalArgs([
      "file",
      "--team",
      "WM",
      "--title",
      "A title",
      "--todo",
    ]),
  ).toEqual([]);
  expect(
    parsePositionalArgs([
      "triage",
      "WM-313",
      "--comment",
      "Scope needs revision",
    ]),
  ).toEqual(["WM-313"]);
  expect(
    parsePositionalArgs(["answer", "WM-313", "Use the existing seam"]),
  ).toEqual(["WM-313", "Use the existing seam"]);
});

test("markdown bodies beginning with a horizontal rule stay positional", () => {
  expect(
    parsePositionalArgs(["detail", "WM-314", "---\n\n## Heading"]),
  ).toEqual(["WM-314", "---\n\n## Heading"]);
});

test("the end-of-options sentinel preserves arbitrary leading dashes", () => {
  expect(
    parsePositionalArgs(["answer", "WM-315", "--", "--word\nbody"]),
  ).toEqual(["WM-315", "--word\nbody"]);
  expect(
    parsePositionalArgs(["comment", "WM-316", "--", "---\n\n## Heading"]),
  ).toEqual(["WM-316", "---\n\n## Heading"]);
});

test("detail --replace keeps its Markdown body positional", () => {
  expect(
    parsePositionalArgs(["detail", "WM-318", "--replace", "## Heading"]),
  ).toEqual(["WM-318", "## Heading"]);
});

test("detail --replace uses each tracker's body replacement mutation", () => {
  expect(
    descriptionReplacementRequest("watt-mind/factory#42", "issue-id", "new"),
  ).toMatchObject({
    variables: { id: "issue-id", body: "new" },
    resultAt: ["updateIssue", "issue", "id"],
  });
  expect(
    descriptionReplacementRequest("CLNT-42", "issue-id", "new"),
  ).toMatchObject({
    variables: { id: "issue-id", description: "new" },
    resultAt: ["issueUpdate", "success"],
  });
});

test("detail --replace routes bare and #-prefixed GitHub numbers to GitHub, not Linear", () => {
  for (const identifier of ["1564", "#1564", " 1564 "]) {
    expect(
      descriptionReplacementRequest(identifier, "I_1", "new").resultAt,
    ).toEqual(["updateIssue", "issue", "id"]);
  }
});

test("detail --replace lets the control plane's kind override the identifier shape", () => {
  expect(
    descriptionReplacementRequest("CLNT-42", "I_1", "new", { kind: "github" })
      .resultAt,
  ).toEqual(["updateIssue", "issue", "id"]);
  expect(
    descriptionReplacementRequest("42", "lin-id", "new", { kind: "linear" })
      .resultAt,
  ).toEqual(["issueUpdate", "success"]);
});

test("replacementSucceeded treats success:false as a failure", () => {
  const at = ["issueUpdate", "success"];
  expect(replacementSucceeded({ issueUpdate: { success: false } }, at)).toBe(
    false,
  );
  expect(replacementSucceeded({ issueUpdate: { success: true } }, at)).toBe(
    true,
  );
  expect(replacementSucceeded({ data: { issueUpdate: {} } }, at)).toBe(false);
  expect(
    replacementSucceeded({ updateIssue: { issue: { id: "I_1" } } }, [
      "updateIssue",
      "issue",
      "id",
    ]),
  ).toBe(true);
});

test("unknown flags remain flags instead of becoming positional bodies", () => {
  expect(parsePositionalArgs(["detail", "WM-317", "--add-label"])).toEqual([
    "WM-317",
  ]);
});

// -------------------------------------------------------- label mutations ---
test("label edits support both addition and removal without touching other labels", () => {
  const current = ["type:bug", "area:api", "ai:in-progress"];
  const ids = resolveLabelIds(
    current,
    { add: ["ai:needs-review"], remove: ["ai:in-progress"] },
    LABELS,
  );
  expect(ids).toContain("l-bug");
  expect(ids).toContain("l-area");
  expect(ids).toContain("l-review");
  expect(ids).not.toContain("l-prog");
  expect(ids).toHaveLength(3);
});

test("closure check blocks ai:agent-ready when Owned Paths closure policy is incomplete", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "linear-closure-"));
  const repoPath = path.join(root, "repo");
  const previous = process.env.FACTORY_REPOS_ROOT;
  try {
    mkdirSync(path.join(root, "config"), { recursive: true });
    mkdirSync(path.join(repoPath, "event-runtime", "agents"), {
      recursive: true,
    });
    mkdirSync(path.join(repoPath, "event-runtime", "schemas"), {
      recursive: true,
    });
    writeFileSync(
      path.join(repoPath, "event-runtime", "agents", "triage-scan.json"),
      `${JSON.stringify({
        pins: { "event-runtime/schemas/triage-scan.output.json": "x" },
      })}\n`,
    );
    writeFileSync(
      path.join(root, "config", "repos.yaml"),
      `repos:\n  - name: wm\n    path: ${repoPath}\n    team: WM\n    project: Tests\n    owned_paths_policy:\n      direct:\n        - source: shared/**\n          requires:\n            - dist/**\n      pin_manifests:\n        - event-runtime/agents/*.json\n`,
    );

    process.env.FACTORY_REPOS_ROOT = root;
    __resetLinearReposCache();

    expect(
      closureCheckMessages({
        team: { key: "WM" },
        project: { name: "Tests" },
        description: "## Owned Paths\n- shared/**\n",
      }),
    ).toEqual([
      "Missing required Owned Paths entry: dist/** (required by shared/**)",
    ]);

    expect(
      closureCheckMessages({
        team: { key: "WM" },
        project: { name: "Tests" },
        description:
          "## Owned Paths\n- shared/**\n- event-runtime/schemas/triage-scan.output.json\n- dist/**\n",
      }),
    ).toEqual([
      "Missing required Owned Paths entry: event-runtime/agents/triage-scan.json (required by event-runtime/schemas/triage-scan.output.json from event-runtime/agents/triage-scan.json)",
    ]);

    __resetLinearReposCache();
  } finally {
    if (previous === undefined) delete process.env.FACTORY_REPOS_ROOT;
    else process.env.FACTORY_REPOS_ROOT = previous;
    __resetLinearReposCache();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------- grep invariant ---
// Same shape as lib/forge's "nothing outside lib/forge/ spawns gh" check:
// new Linear GraphQL call sites must go through the adapter, not gql().
// WM-962 shrank this to the transport itself plus the adapter. Everything
// else reaches the tracker through `loadControlPlane()` — a typed verb where
// the contract models the question, `raw()` where it does not. Adding a name
// back here means a second transport with its own credential path and no
// shared retry/backoff, which is exactly what this invariant exists to stop.
const GQL_IMPORT_ALLOWED = new Set([
  "event-runtime/lib/linear.mjs",
  "lib/control-plane/linear.mjs",
  "orchestrator/reaper.mjs",
]);

test("no new call site imports gql outside lib/control-plane and the reaper transport", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const proc = Bun.spawnSync({
    cmd: [
      "git",
      "grep",
      "-nE",
      // POSIX ERE, NOT PCRE: `git grep -E` does not support `\b`, so the
      // original pattern here matched nothing and this invariant passed
      // vacuously from the day it was written (found while shrinking the
      // allowlist in WM-962). Spell the word boundary explicitly.
      String.raw`import \{[^}]*(^|[^a-zA-Z])gql([^a-zA-Z]|$)`,
      "--",
      "orchestrator",
      "lib",
      "event-runtime",
      "tools",
    ],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const hits = (proc.stdout?.toString() || "")
    .split("\n")
    .filter(Boolean)
    .filter((line) => {
      const file = line.split(":")[0];
      return !GQL_IMPORT_ALLOWED.has(file) && !file.endsWith(".test.mjs");
    });
  expect(hits).toEqual([]);
});

test("the gql grep invariant can actually match (it once could not)", () => {
  // The check above is only worth having if its pattern works. It shipped
  // with `\b`, which `git grep -E` (POSIX ERE) does not implement, so it
  // silently matched nothing. Assert the pattern still finds the known
  // allowlisted importers — if this returns nothing, the invariant above is
  // vacuous again regardless of what it reports.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const proc = Bun.spawnSync({
    cmd: [
      "git",
      "grep",
      "-lE",
      String.raw`import \{[^}]*(^|[^a-zA-Z])gql([^a-zA-Z]|$)`,
      "--",
      "orchestrator",
      "lib",
      "event-runtime",
      "tools",
    ],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const files = (proc.stdout?.toString() || "").split("\n").filter(Boolean);
  expect(files).toContain("lib/control-plane/linear.mjs");
  expect(files.length).toBeGreaterThan(0);
});

// ------------------------------------------------ repo resolution (WM-1007) ---
// The CLI must know which repos.yaml entry an invocation is about, because
// that entry decides which control plane the verb talks to. The worktree case
// is the one that matters: every dispatched agent runs from
// <worktree_root>/<TICKET>, never from `path`.
test("resolveRepoName matches the checkout, the worktree root, and --repo", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "linear-reporesolve-"));
  const previous = process.env.FACTORY_REPOS_ROOT;
  try {
    mkdirSync(path.join(root, "config"), { recursive: true });
    const alphaPath = path.join(root, "alpha");
    const alphaWt = path.join(root, "wt", "alpha");
    const betaPath = path.join(root, "beta");
    writeFileSync(
      path.join(root, "config", "repos.yaml"),
      `repos:\n  - name: alpha\n    path: ${alphaPath}\n    worktree_root: ${alphaWt}\n  - name: beta\n    path: ${betaPath}\n`,
    );
    process.env.FACTORY_REPOS_ROOT = root;
    __resetLinearReposCache();

    // cwd inside the checkout
    expect(resolveRepoName({ cwd: alphaPath, repoFlag: undefined })).toBe(
      "alpha",
    );
    expect(
      resolveRepoName({
        cwd: path.join(alphaPath, "lib"),
        repoFlag: undefined,
      }),
    ).toBe("alpha");
    // cwd inside a WORKTREE — resolves via worktree_root, not path
    expect(
      resolveRepoName({
        cwd: path.join(alphaWt, "WM-1007"),
        repoFlag: undefined,
      }),
    ).toBe("alpha");
    // a different repo
    expect(resolveRepoName({ cwd: betaPath, repoFlag: undefined })).toBe(
      "beta",
    );
    // nothing matches -> null, so the caller falls back to policy
    expect(
      resolveRepoName({ cwd: os.tmpdir(), repoFlag: undefined }),
    ).toBeNull();
    // an explicit flag wins over cwd
    expect(resolveRepoName({ cwd: alphaPath, repoFlag: "beta" })).toBe("beta");
    // a bad flag is the operator's mistake, not a silent fallback
    expect(() => resolveRepoName({ cwd: alphaPath, repoFlag: "nope" })).toThrow(
      /unknown --repo "nope"/,
    );
    // a prefix that is not a path boundary must not match
    expect(
      resolveRepoName({ cwd: `${alphaPath}-other`, repoFlag: undefined }),
    ).toBeNull();
  } finally {
    if (previous === undefined) delete process.env.FACTORY_REPOS_ROOT;
    else process.env.FACTORY_REPOS_ROOT = previous;
    __resetLinearReposCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test("factory exposes `ticket`, and `linear` as a deprecated alias", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const script = readFileSync(path.join(root, "bin", "factory"), "utf8");
  expect(script).toContain("ticket)");
  expect(script).toContain("tools/ticket.mjs");
  // The alias must survive until the prompt sweep lands, or dispatch breaks.
  expect(script).toContain("linear)");
  expect(script).toMatch(/factory linear is deprecated/);
});

const GH975_REPOS = new Map([
  ["factory", { name: "factory", github: "watt-mind/factory" }],
  ["legalease", { name: "legalease", github: "watt-mind/legalease" }],
]);

test("resolveRepoNameFromTicket: owner/repo#N resolves the matching registry entry (GH-975)", () => {
  expect(resolveRepoNameFromTicket("watt-mind/factory#975", GH975_REPOS)).toBe(
    "factory",
  );
});

test("resolveRepoNameFromTicket: case-insensitive on the github slug", () => {
  expect(resolveRepoNameFromTicket("Watt-Mind/Factory#1", GH975_REPOS)).toBe(
    "factory",
  );
});

test("resolveRepoNameFromTicket: configured repository names resolve case-insensitively", () => {
  expect(resolveRepoNameFromTicket("factory#7", GH975_REPOS)).toBe("factory");
  expect(resolveRepoNameFromTicket("Factory#7", GH975_REPOS)).toBe("factory");
});

test("normalizeTicketRef: both configured GitHub spellings use the full slug", () => {
  expect(normalizeTicketRef("factory#7", GH975_REPOS)).toBe(
    "watt-mind/factory#7",
  );
  expect(normalizeTicketRef("Watt-Mind/Factory#7", GH975_REPOS)).toBe(
    "watt-mind/factory#7",
  );
});

test("resolveRepoNameFromTicket: linear-style and bare ids resolve nothing", () => {
  expect(resolveRepoNameFromTicket("WM-123", GH975_REPOS)).toBeNull();
  expect(resolveRepoNameFromTicket("975", GH975_REPOS)).toBeNull();
  expect(resolveRepoNameFromTicket(undefined, GH975_REPOS)).toBeNull();
  expect(resolveRepoNameFromTicket("nope#7", GH975_REPOS)).toBeNull();
});

test("resolveRepoNameForFile: --from chooses its GitHub repo and refuses an ambiguous workspace", () => {
  expect(
    resolveRepoNameForFile({
      cwd: os.tmpdir(),
      repos: GH975_REPOS,
      repoFlag: undefined,
      fromFlag: "watt-mind/factory#975",
    }),
  ).toBe("factory");
  expect(
    resolveRepoNameForFile({
      cwd: os.tmpdir(),
      repos: GH975_REPOS,
      repoFlag: undefined,
      fromFlag: undefined,
    }),
  ).toBeNull();
});

test("resolveRepoNameForFile: a Linear-style --from falls through to cwd instead of terminating", () => {
  const repos = new Map([
    [
      "factory",
      { name: "factory", path: "/srv/factory", github: "watt-mind/factory" },
    ],
  ]);
  // Unresolvable cwd: the Linear id names no repository, so nothing resolves.
  expect(
    resolveRepoNameForFile({
      cwd: os.tmpdir(),
      repos,
      repoFlag: undefined,
      fromFlag: "CLNT-616",
    }),
  ).toBeNull();
  // Inside a configured checkout the same flag lets cwd decide.
  expect(
    resolveRepoNameForFile({
      cwd: "/srv/factory/tools",
      repos,
      repoFlag: undefined,
      fromFlag: "CLNT-616",
    }),
  ).toBe("factory");
});

/**
 * Spawn `ticket.mjs file` against an ephemeral instance root whose cwd is
 * outside every configured repository. `gh` is shadowed by a stub that logs
 * its arguments and fails, and HOME points at the fixture so no operator
 * Linear key leaks in: each route therefore ends in a deterministic, offline
 * failure that identifies which control plane was reached.
 */
function spawnTicketOutsideRepo(args, { controlPlane } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ticket-file-route-"));
  const workspace = path.join(root, "workspace");
  const bin = path.join(root, "bin");
  const ghLog = path.join(root, "gh.log");
  const cliRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  try {
    mkdirSync(path.join(root, "config"), { recursive: true });
    mkdirSync(workspace);
    mkdirSync(bin);
    writeFileSync(
      path.join(bin, "gh"),
      [
        "#!/bin/sh",
        `printf '%s\n' "$*" >> "${ghLog}"`,
        'echo "stub gh: offline" >&2',
        "exit 1",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    // The default (repo-less) plane is read from policy.yaml, as in a real
    // instance root; the fixture pins it to Linear.
    writeFileSync(
      path.join(root, "config", "policy.yaml"),
      "controlPlane:\n  kind: linear\n",
    );
    writeFileSync(
      path.join(root, "config", "repos.yaml"),
      `repos:\n  - name: factory\n    path: ${path.join(root, "repo")}\n    github: watt-mind/factory\n` +
        (controlPlane ? `    control_plane: ${controlPlane}\n` : ""),
    );
    const env = { ...process.env, FACTORY_REPOS_ROOT: root, HOME: root };
    env.PATH = `${bin}${path.delimiter}${env.PATH ?? ""}`;
    for (const name of Object.keys(env)) {
      if (
        name === "LINEAR_API_KEY" ||
        name === "GH_TOKEN" ||
        name === "GITHUB_TOKEN" ||
        name.startsWith("FACTORY_GH_APP_")
      )
        delete env[name];
    }
    const result = Bun.spawnSync({
      cmd: ["bun", path.join(cliRoot, "tools", "ticket.mjs"), ...args],
      cwd: workspace,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: result.exitCode,
      stderr: result.stderr.toString(),
      ghCalls: existsSync(ghLog) ? readFileSync(ghLog, "utf8") : "",
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const spawnFileOutsideRepo = (args, options) =>
  spawnTicketOutsideRepo(["file", ...args], options);

test("queue --repo rejects an unknown repository before reporting queue usage", () => {
  const result = spawnTicketOutsideRepo(["queue", "--repo", "nosuch"]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('unknown --repo "nosuch"');
  expect(result.stderr).toContain("known: factory");
  expect(result.stderr).not.toContain("usage: queue");
  expect(result.ghCalls).toBe("");
});

test("file refuses an unresolvable workspace with both routing flags", () => {
  const result = spawnFileOutsideRepo(["--title", "finding"]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("--repo <name> or --from <owner/repo#N>");
  expect(result.ghCalls).toBe("");
});

test("file --from <Linear-id> --team reaches the Linear plane from an unresolvable workspace", () => {
  const result = spawnFileOutsideRepo([
    "--from",
    "CLNT-616",
    "--team",
    "CLNT",
    "--title",
    "finding",
  ]);
  expect(result.exitCode).toBe(LINEAR_OFFLINE_GUARD_EXIT);
  // The default (Linear) plane was selected, but offline mode wins before
  // credential lookup so the operator gets an actionable refusal instead.
  expect(result.stderr).toContain(
    "linear_offline_guard: Linear network access is disabled by FACTORY_LINEAR_OFFLINE=1",
  );
  expect(result.stderr).toContain("FACTORY_LINEAR_ALLOW_NETWORK=1");
  expect(result.stderr).not.toContain("LINEAR_API_KEY not found");
  expect(result.stderr).not.toContain("--repo <name> or --from <owner/repo#N>");
  expect(result.ghCalls).toBe("");
});

test("file --from owner/repo#N reaches that repository's GitHub plane without --team", () => {
  const result = spawnFileOutsideRepo(
    ["--from", "watt-mind/factory#1", "--title", "finding"],
    { controlPlane: "github" },
  );
  expect(result.exitCode).toBe(1);
  expect(result.stderr).not.toContain("--repo <name> or --from <owner/repo#N>");
  expect(result.stderr).not.toContain("usage: file");
  // The GitHub adapter bound to watt-mind/factory and asked gh for its labels.
  expect(result.ghCalls).toContain("repos/watt-mind/factory/labels");
});

test("file without --title reports usage before any routing", () => {
  const result = spawnFileOutsideRepo(["--body", "no title"]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("usage: file --title");
  expect(result.stderr).not.toContain("--repo <name> or --from <owner/repo#N>");
});

test("unknown GitHub-shaped ticket refs fail before a control-plane transport", () => {
  const result = spawnTicketOutsideRepo(["labels", "nope#7", "--remove", "x"]);
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain('unrecognised ticket ref "nope#7"');
  expect(result.stderr).toContain("<owner>/<repo>#N or <repo-name>#N");
  expect(result.ghCalls).toBe("");
});

test("verbs missing the ticket argument report usage before ref normalisation", () => {
  for (const verb of ["comments", "unclaim", "labels"]) {
    const result = spawnTicketOutsideRepo([verb]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`usage: ${verb} <ISSUE-ID>`);
    expect(result.stderr).not.toContain("unrecognised ticket ref");
    expect(result.ghCalls).toBe("");
  }
});

test("short configured GitHub refs reach the adapter as full identifiers", () => {
  const result = spawnTicketOutsideRepo(
    ["labels", "factory#7", "--remove", "x"],
    { controlPlane: "github" },
  );
  expect(result.exitCode).toBe(1);
  expect(result.ghCalls).toContain("repos/watt-mind/factory/issues/7");
  expect(result.ghCalls).not.toContain("factory#7");
});

// ----------------------------------- instance config resolution (GH-975) ---
// Every ticket verb acts on instance-local control-plane state, so the CLI must
// resolve which operator checkout owns `config/repos.yaml` BEFORE it touches
// cwd or the ticket identifier. A dispatched agent runs from an ephemeral
// runtime workspace that has no `config/repos.yaml`; it receives the operator
// checkout through `FACTORY_ROOT`, and resolution must honour that rather than
// falling back to the executing agent's own checkout (which would point at the
// tracked example config and misroute a real GitHub ticket into a Linear
// lookup).
function makeConfiguredRoot(label) {
  const root = mkdtempSync(path.join(os.tmpdir(), label));
  mkdirSync(path.join(root, "config"), { recursive: true });
  writeFileSync(
    path.join(root, "config", "repos.yaml"),
    "repos:\n  - name: wm\n    path: /nonexistent\n",
  );
  return root;
}

test("instanceConfigRoot uses FACTORY_ROOT when the execution checkout lacks config/repos.yaml", () => {
  const factoryRoot = makeConfiguredRoot("ticket-facroot-");
  // The execution checkout is a bare workspace with no config/ at all — the
  // exact shape of a dispatched runtime workspace under ~/.factory.
  const checkoutRoot = mkdtempSync(path.join(os.tmpdir(), "ticket-checkout-"));
  try {
    // The bare checkout on its own is not a valid instance config root...
    expect(() => instanceConfigRoot({ env: {}, checkoutRoot })).toThrow(
      InstanceConfigMissingError,
    );
    // ...but FACTORY_ROOT names the operator checkout that owns the config.
    expect(
      instanceConfigRoot({ env: { FACTORY_ROOT: factoryRoot }, checkoutRoot }),
    ).toBe(path.resolve(factoryRoot));
  } finally {
    rmSync(factoryRoot, { recursive: true, force: true });
    rmSync(checkoutRoot, { recursive: true, force: true });
  }
});

test("instanceConfigRoot: FACTORY_REPOS_ROOT is the explicit override, ahead of FACTORY_ROOT", () => {
  const reposRoot = makeConfiguredRoot("ticket-reposroot-");
  const factoryRoot = makeConfiguredRoot("ticket-facroot2-");
  try {
    expect(
      instanceConfigRoot({
        env: { FACTORY_REPOS_ROOT: reposRoot, FACTORY_ROOT: factoryRoot },
        checkoutRoot: "/nonexistent",
      }),
    ).toBe(path.resolve(reposRoot));
  } finally {
    rmSync(reposRoot, { recursive: true, force: true });
    rmSync(factoryRoot, { recursive: true, force: true });
  }
});

test("instanceConfigRoot throws instance_config_missing when no instance config is available", () => {
  // No override env and a checkout without config/repos.yaml: a syntactically
  // valid fallback is exactly what must NOT happen here, so this is an explicit
  // refusal rather than a silent default-plane lookup.
  const checkoutRoot = mkdtempSync(path.join(os.tmpdir(), "ticket-noconfig-"));
  try {
    let thrown;
    try {
      instanceConfigRoot({ env: {}, checkoutRoot });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InstanceConfigMissingError);
    expect(thrown.code).toBe("instance_config_missing");
    expect(thrown.message).toContain("instance_config_missing");
    expect(thrown.message).toContain(
      path.join(path.resolve(checkoutRoot), "config", "repos.yaml"),
    );
  } finally {
    rmSync(checkoutRoot, { recursive: true, force: true });
  }
});

/**
 * Run `ticket.mjs detail <n> --replace` from inside a GitHub-plane repository
 * against a stub `gh` on PATH that answers the reads the adapter makes and
 * records every call (arguments and stdin) so the test can see which
 * mutation the CLI actually issued.
 */
function spawnDetailReplaceAgainstStubGh(args, { body }) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ticket-detail-replace-"));
  const repoDir = path.join(root, "repo");
  const bin = path.join(root, "bin");
  const ghLog = path.join(root, "gh.log");
  const stdinLog = path.join(root, "gh-stdin.log");
  const cliRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const issue = JSON.stringify({
    number: 1564,
    node_id: "I_1564",
    title: "respec me",
    body: "## Owned Paths\n\n- old/path.mjs\n",
    state: "open",
    html_url: "https://github.com/watt-mind/factory/issues/1564",
    labels: [],
    user: { login: "owner" },
    author_association: "OWNER",
  });
  const project = JSON.stringify({
    data: {
      repository: {
        projectsV2: {
          nodes: [
            {
              id: "P_1",
              title: "Factory",
              field: {
                id: "F_1",
                options: [{ id: "o_todo", name: "Todo" }],
              },
            },
          ],
        },
      },
    },
  });
  try {
    mkdirSync(path.join(root, "config"), { recursive: true });
    mkdirSync(repoDir);
    mkdirSync(bin);
    writeFileSync(
      path.join(bin, "gh"),
      [
        "#!/bin/sh",
        'input=""',
        'for a in "$@"; do [ "$a" = "-" ] && input=$(cat); done',
        `printf '%s\n' "$*" >> "${ghLog}"`,
        `printf '%s\n' "$input" >> "${stdinLog}"`,
        'case "$*" in',
        "  *graphql*)",
        '    case "$input" in',
        `      *updateIssue*) printf '%s\\n' '{"data":{"updateIssue":{"issue":{"id":"I_1564"}}}}' ;;`,
        `      *FindRepoProject*) printf '%s\\n' '${project}' ;;`,
        `      *ProjectItems*) printf '%s\\n' '{"data":{"node":{"items":{"nodes":[],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}' ;;`,
        `      *) printf '%s\\n' '{"data":{}}' ;;`,
        "    esac ;;",
        `  *issues/1564/comments*) printf '%s\\n' '[]' ;;`,
        `  *issues/1564*) printf '%s\\n' '${issue}' ;;`,
        `  *) printf '%s\\n' '{}' ;;`,
        "esac",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    writeFileSync(
      path.join(root, "config", "policy.yaml"),
      "controlPlane:\n  kind: github\n",
    );
    writeFileSync(
      path.join(root, "config", "repos.yaml"),
      `repos:\n  - name: factory\n    path: ${repoDir}\n    github: watt-mind/factory\n    control_plane: github\n`,
    );
    const env = { ...process.env, FACTORY_REPOS_ROOT: root, HOME: root };
    env.PATH = `${bin}${path.delimiter}${env.PATH ?? ""}`;
    for (const name of Object.keys(env)) {
      if (
        name === "LINEAR_API_KEY" ||
        name === "GH_TOKEN" ||
        name === "GITHUB_TOKEN" ||
        name.startsWith("FACTORY_GH_APP_")
      )
        delete env[name];
    }
    const result = Bun.spawnSync({
      cmd: [
        "bun",
        path.join(cliRoot, "tools", "ticket.mjs"),
        "detail",
        ...args,
        "--",
        body,
      ],
      cwd: repoDir,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      ghCalls: existsSync(ghLog) ? readFileSync(ghLog, "utf8") : "",
      ghStdin: existsSync(stdinLog) ? readFileSync(stdinLog, "utf8") : "",
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("detail <bare number> --replace on a GitHub repo issues the GitHub updateIssue mutation", () => {
  const result = spawnDetailReplaceAgainstStubGh(["1564", "--replace"], {
    body: "## Owned Paths\n\n- new/path.mjs\n",
  });
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("detail replaced");
  expect(result.ghCalls).toContain("repos/watt-mind/factory/issues/1564");
  const mutations = result.ghStdin
    .split("\n")
    .filter((line) => line.includes("mutation"));
  expect(mutations).toHaveLength(1);
  expect(mutations[0]).toContain("updateIssue");
  expect(mutations[0]).not.toContain("issueUpdate");
  expect(JSON.parse(mutations[0]).variables).toEqual({
    id: "I_1564",
    body: "## Owned Paths\n\n- new/path.mjs",
  });
});

test("detail --replace with an unchanged body issues no mutation", () => {
  const result = spawnDetailReplaceAgainstStubGh(["#1564", "--replace"], {
    body: "## Owned Paths\n\n- old/path.mjs\n",
  });
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("already matches");
  expect(result.ghStdin).not.toContain("mutation");
});
