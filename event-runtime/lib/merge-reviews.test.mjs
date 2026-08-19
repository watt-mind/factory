import { describe, expect, test } from "bun:test";
import path from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { memoryForge } from "../../lib/forge/memory.mjs";
import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-merge-reviews-test-mjs";
import { openDb } from "./db.mjs";
import {
  enumerateMergeScan,
  lookupMergeReview,
  persistMergeReviewFromResult,
  runScanCli,
  upsertMergeReview,
} from "./merge-reviews.mjs";

const HEAD = "a".repeat(40);
const HEAD2 = "c".repeat(40);
const BASE = "b".repeat(40);
const GITHUB = "watt-mind/factory";

const repos = new Map([
  [
    "factory",
    {
      name: "factory",
      github: GITHUB,
      base: "develop",
      deployBranch: "master",
    },
  ],
]);

function pr({
  number,
  headRefOid = HEAD,
  headRefName = `feat/WM-${number}`,
  baseRefName = "develop",
  isDraft = false,
  state = "OPEN",
  title = `Fixes WM-${number}`,
} = {}) {
  return {
    number,
    state,
    isDraft,
    headRefOid,
    headRefName,
    baseRefName,
    title,
  };
}

function forgeWith(prs, { baseSha = BASE } = {}) {
  return memoryForge({
    repos: { [GITHUB]: { prs } },
    api: {
      [`repos/${GITHUB}/git/ref/heads/develop`]: baseSha,
    },
  });
}

function planItem(prNumber = 12) {
  return {
    pr: prNumber,
    headSha: HEAD,
    baseSha: BASE,
    headRef: `feat/WM-${prNumber}`,
    ticket: `WM-${prNumber}`,
    action: "merge_pr",
    reason: "green",
    checksGreen: true,
    mergeable: true,
    ownedPathsValid: true,
    handoffValid: true,
    testsFalsifiable: true,
    policySafe: true,
    sensitive: false,
    ambiguous: false,
  };
}

describe("merge_reviews ledger keying (WM-907)", () => {
  test("a fresh database has the merge_reviews table", () => {
    const db = openDb(":memory:");
    const tables = db
      .query(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((row) => row.name);
    expect(tables).toContain("merge_reviews");
  });

  test("lookup misses when the head SHA moved", () => {
    const db = openDb(":memory:");
    upsertMergeReview(db, {
      github: GITHUB,
      pr: 12,
      headSha: HEAD,
      baseSha: BASE,
      verdict: "MERGE",
      plan: planItem(12),
    });
    expect(
      lookupMergeReview(db, {
        github: GITHUB,
        pr: 12,
        headSha: HEAD,
        baseSha: BASE,
      })?.verdict,
    ).toBe("MERGE");
    expect(
      lookupMergeReview(db, {
        github: GITHUB,
        pr: 12,
        headSha: HEAD2,
        baseSha: BASE,
      }),
    ).toBeNull();
  });

  test("persistMergeReviewFromResult writes the COMPLETED merge-review artifact", () => {
    const db = openDb(":memory:");
    const persisted = persistMergeReviewFromResult(db, {
      spec: {
        agent: "merge-review@1",
        policyVersion: "git:test",
        input: { github: GITHUB, pr: 12 },
      },
      result: {
        terminalState: "completed",
        artifact: {
          verdict: "FIX",
          github: GITHUB,
          pr: 12,
          headSha: HEAD,
          baseSha: BASE,
          findings: ["rebase_onto_base"],
          fix: [
            {
              pr: 12,
              headSha: HEAD,
              baseSha: BASE,
              headRef: "feat/WM-12",
              ticket: "WM-12",
              finding: "rebase_onto_base",
              findingHash: "d".repeat(64),
              round: 1,
              mechanical: true,
              withinOwnedPaths: true,
              ownedPaths: ["event-runtime/lib/worker.mjs"],
            },
          ],
          plan: [],
        },
      },
      runId: "run_review_1",
      now: Date.parse("2026-08-19T12:00:00.000Z"),
    });
    expect(persisted).toBe(true);
    const row = lookupMergeReview(db, {
      github: GITHUB,
      pr: 12,
      headSha: HEAD,
      baseSha: BASE,
    });
    expect(row.verdict).toBe("FIX");
    expect(row.runId).toBe("run_review_1");
    expect(row.fix.finding).toBe("rebase_onto_base");
    expect(
      persistMergeReviewFromResult(db, {
        spec: { agent: "merge-scan@2" },
        result: { artifact: { verdict: "MERGE" } },
        runId: "run_scan",
      }),
    ).toBe(false);
  });
});

describe("merge-scan enumerator (WM-907)", () => {
  test("emits reviews only for ledger misses", () => {
    const db = openDb(":memory:");
    upsertMergeReview(db, {
      github: GITHUB,
      pr: 10,
      headSha: HEAD,
      baseSha: BASE,
      verdict: "ESCALATE",
    });
    const result = enumerateMergeScan({
      input: { repo: "factory" },
      db,
      forge: forgeWith([
        pr({ number: 10 }),
        pr({ number: 11, headRefOid: HEAD2, headRefName: "feat/WM-11" }),
        pr({ number: 12, isDraft: true, headRefName: "feat/WM-12" }),
        pr({
          number: 13,
          baseRefName: "master",
          headRefName: "feat/WM-13",
        }),
      ]),
      repos,
    });
    expect(result.terminalState).toBe("completed");
    expect(result.artifact.reviews.map((row) => row.pr)).toEqual([11]);
    expect(result.artifact.plan).toEqual([]);
    expect(result.artifact.recommendation).toBe("REVIEW");
  });

  test("selected scan forces a review even on a ledger hit", () => {
    const db = openDb(":memory:");
    upsertMergeReview(db, {
      github: GITHUB,
      pr: 10,
      headSha: HEAD,
      baseSha: BASE,
      verdict: "MERGE",
      plan: planItem(10),
    });
    const result = enumerateMergeScan({
      input: { repo: "factory", prNumbers: [10] },
      db,
      forge: forgeWith([pr({ number: 10 })]),
      repos,
    });
    expect(result.artifact.reviews).toEqual([
      {
        pr: 10,
        headSha: HEAD,
        baseSha: BASE,
        headRef: "feat/WM-10",
        ticket: "WM-10",
      },
    ]);
    expect(result.artifact.plan).toEqual([]);
  });

  test("open scan stubs the lowest MERGE candidate from the ledger", () => {
    const db = openDb(":memory:");
    upsertMergeReview(db, {
      github: GITHUB,
      pr: 20,
      headSha: HEAD,
      baseSha: BASE,
      verdict: "MERGE",
      plan: planItem(20),
    });
    upsertMergeReview(db, {
      github: GITHUB,
      pr: 8,
      headSha: HEAD,
      baseSha: BASE,
      verdict: "MERGE",
      plan: planItem(8),
    });
    const result = enumerateMergeScan({
      input: { repo: "factory" },
      db,
      forge: forgeWith([
        pr({ number: 20, headRefName: "feat/WM-20" }),
        pr({ number: 8, headRefName: "feat/WM-8" }),
      ]),
      repos,
    });
    expect(result.artifact.reviews).toEqual([]);
    expect(result.artifact.plan[0].pr).toBe(8);
    expect(result.artifact.recommendation).toBe("MERGE");
  });

  test("an invalid selected PR refuses the whole scan", () => {
    const result = enumerateMergeScan({
      input: { repo: "factory", prNumbers: [99] },
      db: openDb(":memory:"),
      forge: forgeWith([]),
      repos,
    });
    expect(result.terminalState).toBe("refused");
    expect(result.reasonCode).toBe("needs_human");
    expect(result.evidence.message).toMatch(/#99 missing/);
  });

  test("runScanCli writes result.json from input.json", () => {
    const dir = tmpDir("merge-scan-cli-");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "input.json"),
      JSON.stringify({ repo: "factory" }),
    );
    const db = openDb(":memory:");
    const code = runScanCli({
      cwd: dir,
      db,
      forge: forgeWith([]),
      repos,
    });
    expect(code).toBe(0);
    const written = JSON.parse(
      readFileSync(path.join(dir, "result.json"), "utf8"),
    );
    expect(written.artifact.noopReason).toBe("no_open_prs");
    expect(written.artifact.reviews).toEqual([]);
  });
});
