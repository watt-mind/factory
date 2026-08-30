/**
 * bun test
 *
 * templateGaps() checks only the two §5 sections that are mechanically
 * load-bearing (Owned Paths gates dispatch collision detection, Verification
 * Command gates "done"). An earlier version also checked Problem & Context,
 * Acceptance Criteria, and Source File Pointers -- against the live workspace
 * that produced five false positives (one an Urgent, fully-actionable
 * security ticket) for every two genuine catches, because those three vary
 * too much in legitimate format to check by regex. These tests pin both the
 * genuine catch (CLNT-871/872's shape) and the false positives that got cut.
 */
import { test, expect } from "bun:test";
import {
  demote,
  fetchReadyIssues,
  ownedPathsClosureGuard,
  readyPinGuard,
  main,
  templateGaps,
} from "./label-guard.mjs";
import { readyPinMarker } from "../event-runtime/lib/triage.mjs";

const FULL_SPEC = `## Problem & Context

Something is broken and it matters.

## Acceptance Criteria

- [ ] Observable requirement 1

## Owned Paths

- \`app/services/api.ts\`

## Verification Command

    npm test app/services/__tests__/api.test.ts`;

test("a real §5 spec passes with no gaps", () => {
  expect(templateGaps(FULL_SPEC)).toEqual([]);
});

test("a stale ready pin is reported without treating an absent pin as stale", async () => {
  const promoted = "original approved body";
  const changed = "body edited after approval";
  const stale = await readyPinGuard(
    { identifier: "WM-1574", description: changed },
    async () => [
      { body: readyPinMarker(promoted), createdAt: "2026-08-30T10:00:00Z" },
    ],
  );
  const missing = await readyPinGuard(
    { identifier: "WM-1574", description: changed },
    async () => [],
  );
  expect(stale).toBe("stale");
  expect(missing).toBe("missing");
});

test("a Verification Command heading with only blank lines under it is a gap", () => {
  const desc = `## Owned Paths

- \`app/services/api.ts\`

## Verification Command

`;
  expect(templateGaps(desc)).toEqual(["Verification Command"]);
});

test("duplicate §5 headings are unioned, so an appended respec fills the gap", () => {
  const desc = `## Owned Paths

None — deploy-only change.

## Verification Command

## Owned Paths

None

## Verification Command

    npm test
`;
  expect(templateGaps(desc)).toEqual([]);
});

test("main reports an unreadable ready pin instead of passing the ticket as clean", async () => {
  const cp = {
    listDispatchable: async () => [
      { identifier: "#1", title: "unreadable feed", description: FULL_SPEC },
      { identifier: "#2", title: "clean", description: FULL_SPEC },
    ],
    listComments: async (id) => {
      if (id === "#1") throw new Error("comments 502");
      return [
        { body: readyPinMarker(FULL_SPEC), createdAt: "2026-08-30T10:00:00Z" },
      ];
    },
  };
  const lines = [];
  const log = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    await main(["--repo", "factory"], {
      resolveControlPlane: () => cp,
      resolveRepos: () => [{ name: "factory", team: "WM", project: "Factory" }],
    });
  } finally {
    console.log = log;
  }
  const out = lines.join("\n");
  expect(out).toContain("#1");
  expect(out).toContain("unreadable: Ready Pin");
  expect(out).not.toMatch(/#2 .*clean/);
  expect(out).toContain("Guard findings: 1");
});

test("listing and demotion select the control plane configured for the repo", async () => {
  const repo = { name: "factory", team: "WM", project: "Factory" };
  const calls = [];
  const cp = {
    listDispatchable: async (filters) => {
      calls.push({ method: "listDispatchable", filters });
      return [{ identifier: "#1555" }];
    },
    transition: async (...args) => calls.push({ method: "transition", args }),
    comment: async (...args) => calls.push({ method: "comment", args }),
  };
  const resolveControlPlane = (options) => {
    calls.push({ method: "loadControlPlane", options });
    return cp;
  };

  const issues = await fetchReadyIssues(repo, resolveControlPlane);
  await demote(issues[0], repo, ["Owned Paths"], true, resolveControlPlane);

  expect(calls.filter((call) => call.method === "loadControlPlane")).toEqual([
    { method: "loadControlPlane", options: { repoName: "factory" } },
    { method: "loadControlPlane", options: { repoName: "factory" } },
  ]);
  expect(calls).toContainEqual({
    method: "listDispatchable",
    filters: { team: "WM", project: "Factory" },
  });
  expect(calls).toContainEqual({
    method: "transition",
    args: ["#1555", "Triage", { remove: ["ai:agent-ready"] }],
  });
});

test("a malformed registry digest policy is rendered as a guard message", () => {
  const result = ownedPathsClosureGuard("", {
    name: "factory",
    ownedPathsPolicy: { registryDigest: { inputs: [] } },
  });
  expect(result.gaps).toEqual([]);
  expect(result.messages).toHaveLength(1);
  expect(result.messages[0]).toContain("invalid_owned_paths_policy");
});

test("the 4-section Frappe support-ticket template fails on both mechanical gaps (CLNT-871/872)", () => {
  const desc = `## 🎫 Support Ticket Origin & Ingestion Metadata

* **Source:** Frappe Helpdesk Support Ticket #0011

## 📩 Original Customer Request

> some customer text

## 🛠️ Rephrased Specification for Implementation Agent

**Target Repository:** \`~/Develop/legalease\`

### Technical Tasks:

1. Do the thing.
2. Verify with existing tests.

## 🎨 Artifacts & End-User Response Guidance

Draft a response confirming completion.`;

  expect(templateGaps(desc)).toEqual(["Owned Paths", "Verification Command"]);
});

test("Owned Paths explicitly declared not-applicable for a non-code deploy ticket passes (CLNT-737, CLNT-218, CLNT-889)", () => {
  const variants = [
    "None in this repo — the fix is an environment variable on a Dokploy stack, followed by a redeploy.",
    "None — infra/deploy verification only, no code changes expected.",
    "No repository paths — this ticket only creates Linear attachments or a blocker comment.",
    "None in-repo — this ticket only closes the two named GitHub PRs and records the decision.",
  ];
  for (const body of variants) {
    const desc = `## Owned Paths\n\n${body}\n\n## Verification Command\n\nSome evidence.`;
    expect(templateGaps(desc), body).toEqual([]);
  }
});

test("an 'Evidence Required' heading counts as the non-code Verification Command substitute (CLNT-901)", () => {
  const desc = `## Owned Paths

No repository paths — this ticket only creates Linear attachments.

## Evidence Required

* Two Linear attachments meeting the viewport criteria above.`;
  expect(templateGaps(desc)).toEqual([]);
});

test("a real ticket with actual Owned Paths and a real Verification Command passes regardless of other heading names (CLNT-755)", () => {
  const desc = `## Finding

Some investigation writeup with no "Problem & Context" or "Acceptance
Criteria" heading at all -- surfaced during a PR review, not hand-written.

## What needs doing

* Fix the bug described above.

## Owned Paths

* \`app/src/checkins/photoOperations.ts\`
* \`app/src/checkins/checkinPhotos.ts\`

## Verification Command

\`\`\`bash
cd app && npm run lint && npm test
\`\`\``;
  expect(templateGaps(desc)).toEqual([]);
});

test("neither Owned Paths nor Verification Command present, and nothing declared N/A, is a genuine gap (CW-213)", () => {
  const desc = `## Production evidence

Some log line proving the bug is real.

## Acceptance criteria

- [ ] Fix the thing.

## Observed from

Production logs, 2026-07-29.`;
  expect(templateGaps(desc)).toEqual(["Owned Paths", "Verification Command"]);
});

test("Owned Paths heading present but unparseable and not declared N/A still fails", () => {
  const desc = `## Owned Paths

Some prose that isn't a path list and gives no real answer either way.

## Verification Command

    npm test`;
  expect(templateGaps(desc)).toEqual(["Owned Paths"]);
});

test("empty description fails both", () => {
  expect(templateGaps("")).toEqual(["Owned Paths", "Verification Command"]);
});

test("supports level 3 numbered headers (### 2. Owned Paths, ### 3. Verification Command) and colons", () => {
  const desc = `## 1. Problem & Context

Something is broken.

### 2. Owned Paths:

- \`orchestrator/owned-paths.mjs\`

### 3. Verification Command:

    bun test orchestrator/owned-paths.test.mjs`;
  expect(templateGaps(desc)).toEqual([]);
});

test("supports level 4 headers (#### 4. Owned Paths)", () => {
  const desc = `#### 1. Problem & Context

Something is broken.

#### 2. Owned Paths

- \`orchestrator/owned-paths.mjs\`

#### 3. Verification Command

    bun test`;
  expect(templateGaps(desc)).toEqual([]);
});

test("supports level 2 numbered headers with colons (## 2. Owned Paths:, ## 3. Verification Command:)", () => {
  const desc = `## 2. Owned Paths:

- \`orchestrator/owned-paths.mjs\`

## 3. Verification Command:

    bun test`;
  expect(templateGaps(desc)).toEqual([]);
});

test("detects missing Verification Command even with level 3 numbered Owned Paths", () => {
  const desc = `### 2. Owned Paths

- \`orchestrator/owned-paths.mjs\``;
  expect(templateGaps(desc)).toEqual(["Verification Command"]);
});
