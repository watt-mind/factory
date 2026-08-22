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
  closureCheckMessages,
  resolveRepoName,
  __resetLinearReposCache,
} from "./ticket.mjs";

const LABELS = [
  { id: "l-ready", name: "ai:agent-ready" },
  { id: "l-prog", name: "ai:in-progress" },
  { id: "l-claude", name: "agent:claude-code" },
  { id: "l-codex", name: "agent:codex" },
  { id: "l-bug", name: "type:bug" },
  { id: "l-area", name: "area:api" },
  { id: "l-review", name: "ai:needs-review" },
];

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
const GQL_IMPORT_ALLOWED = new Set([
  "event-runtime/lib/linear.mjs",
  "lib/control-plane/linear.mjs",
  "orchestrator/reaper.mjs",
  // Remaining call sites sit outside this ticket's Owned Paths (WM-962).
  "orchestrator/reply-detection.mjs",
]);

test("no new call site imports gql outside lib/control-plane and the reaper transport", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const proc = Bun.spawnSync({
    cmd: [
      "git",
      "grep",
      "-nE",
      String.raw`import \{[^}]*\bgql\b`,
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

// ------------------------------------------------- rename + shim (WM-1026) ---
// The rename is only safe because the old path keeps working: agent prompts,
// shared commands and every emitted harness bundle still invoke
// `tools/linear.mjs`, and they are swept separately.
test("tools/linear.mjs still runs, delegating to ticket.mjs", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const r = Bun.spawnSync({
    cmd: ["bun", path.join(root, "tools", "linear.mjs")],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = r.stdout.toString();
  const stderr = r.stderr.toString();
  // Same usage output as the real CLI...
  expect(stdout).toContain("verbs:");
  expect(stdout).toContain("claim");
  // ...and the deprecation notice on STDERR, never stdout: `get --json`,
  // `queue` and `budget` print machine-readable output that callers parse.
  expect(stderr).toContain("deprecated");
  expect(stdout).not.toContain("deprecated");
});

test("the shim re-exports the module's public surface", async () => {
  const shim = await import("./linear.mjs");
  const real = await import("./ticket.mjs");
  for (const name of Object.keys(real)) {
    expect(shim[name]).toBe(real[name]);
  }
  expect(typeof real.main).toBe("function");
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
