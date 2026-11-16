import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  classifyMentalModelPaths,
  collectRecap,
  parseHandoffSignals,
  parseSinceWindow,
} from "./recap.mjs";

test("parseSinceWindow handles durations, overnight alias, lastSessionIso default, and rejects invalid input", () => {
  const now = new Date("2026-11-15T15:00:00.000Z");

  const rel = parseSinceWindow("12h", { now });
  expect(rel.sinceIso).toBe("2026-11-15T03:00:00.000Z");

  const overnight = parseSinceWindow("overnight", { now });
  expect(overnight.sinceIso).toBe("2026-11-15T01:00:00.000Z");

  const fromSession = parseSinceWindow(undefined, {
    now,
    lastSessionIso: "2026-11-15T07:30:00.000Z",
  });
  expect(fromSession.sinceIso).toBe("2026-11-15T07:30:00.000Z");
  expect(fromSession.label).toContain("last session");

  const fallback24h = parseSinceWindow(undefined, {
    now,
    lastSessionIso: "2026-10-01T00:00:00.000Z",
  });
  expect(fallback24h.sinceIso).toBe("2026-11-14T15:00:00.000Z");

  expect(() => parseSinceWindow("not-a-window", { now })).toThrow();
});

test("parseHandoffSignals extracts Fixes IDs, UX critique, non-trivial Risks assumptions, and artifact hashes", () => {
  const sha = "a".repeat(64);
  const body = [
    "## Summary",
    "Fixes #2386",
    "Fixes WM-1140",
    "",
    "## Handoff",
    "- PR: https://github.com/watt-mind/factory/pull/2387",
    "- UX critique: required — SHIP",
    "- Risks: Chose local SQLite read-only mode without WAL lock; verify on Linux",
    `- Screenshot: https://factory.local/api/artifacts/${sha}`,
  ].join("\n");

  const parsed = parseHandoffSignals(body);
  expect(parsed.fixes).toEqual(["#2386", "WM-1140"]);
  expect(parsed.uxCritique).toBe("required — SHIP");
  expect(parsed.risks).toContain("Chose local SQLite read-only mode");
  expect(parsed.hasAssumptions).toBe(true);
  expect(parsed.artifactHashes).toEqual([sha]);

  const clean = parseHandoffSignals("## Handoff\n- Risks: none known\n");
  expect(clean.hasAssumptions).toBe(false);
  expect(clean.risks).toBeNull();
});

test("classifyMentalModelPaths buckets schema, api, config, decisions, and harness paths", () => {
  const buckets = classifyMentalModelPaths([
    "prisma/migrations/20261115_init/migration.sql",
    "server/api/workouts.post.ts",
    "config/repos.example.yaml",
    "docs/product-decisions.md",
    "shared/floor.md",
    "src/utils/math.ts",
  ]);
  expect(buckets.schema).toEqual([
    "prisma/migrations/20261115_init/migration.sql",
  ]);
  expect(buckets.api).toEqual(["server/api/workouts.post.ts"]);
  expect(buckets.config).toEqual(["config/repos.example.yaml"]);
  expect(buckets.decisions).toEqual(["docs/product-decisions.md"]);
  expect(buckets.harness).toEqual(["shared/floor.md"]);
});

test("collectRecap synthesizes git origin/<base>, merged/escalated PRs, local artifacts, and read-only runtime DB while failing closed on fetch errors", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "recap-test-"));
  const artifactsDir = path.join(tmp, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  const shotSha = "b".repeat(64);
  const shotPath = path.join(artifactsDir, shotSha);
  writeFileSync(shotPath, "fake-png");

  const dbFile = path.join(tmp, "runtime.db");
  const db = new Database(dbFile);
  db.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      status TEXT NOT NULL,
      project_tag TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE results (
      run_id TEXT PRIMARY KEY,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE inbox_items (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT,
      project_tag TEXT,
      created_at TEXT NOT NULL
    );
  `);
  db.query(
    `INSERT INTO runs VALUES ('run_1', 'dispatch@1', 'COMPLETED', 'alpha', '2026-11-15T10:00:00.000Z', '2026-11-15T10:05:00.000Z')`,
  ).run();
  db.query(
    `INSERT INTO results VALUES ('run_1', ?, '2026-11-15T10:05:00.000Z')`,
  ).run(
    JSON.stringify({
      outcome: "PR_OPEN",
      artifacts: [
        {
          sha256: shotSha,
          kind: "ux-screenshot",
          mediaType: "image/png",
          label: "Dashboard polished card",
        },
      ],
    }),
  );
  db.query(
    `INSERT INTO inbox_items VALUES ('inb_1', 'ESCALATED', 'open', 'Auth middleware change needs review', 'Touches session cookie scope', 'alpha', '2026-11-15T11:00:00.000Z')`,
  ).run();
  db.query(
    `INSERT INTO inbox_items VALUES ('inb_old', 'ESCALATED', 'open', 'Months-old stale item', 'Historical backlog', 'alpha', '2026-09-01T00:00:00.000Z')`,
  ).run();
  db.close();

  const reposMap = {
    alpha: {
      path: "/fake/alpha",
      github: "watt-mind/alpha",
      base: "develop",
      deploy_branch: "main",
    },
    offlineRepo: {
      path: "/fake/offline",
      github: "watt-mind/offline",
      base: "develop",
    },
  };

  const exec = (cmd) => {
    const joined = cmd.join(" ");
    if (joined.includes("/fake/offline") && joined.includes("fetch")) {
      return { status: 1, stdout: "", stderr: "network unreachable" };
    }
    if (joined.includes("/fake/alpha") && joined.includes("fetch")) {
      return { status: 0, stdout: "", stderr: "" };
    }
    if (joined.includes("rev-parse origin/develop")) {
      return { status: 0, stdout: "1234567890abcdef\n", stderr: "" };
    }
    if (joined.includes("rev-list --count origin/main..origin/develop")) {
      return { status: 0, stdout: "2\n", stderr: "" };
    }
    if (joined.includes("log origin/develop")) {
      return {
        status: 0,
        stdout:
          "COMMIT\t11111111\tfeat(ui): polish dashboard (#10)\t2026-11-15T09:30:00Z\nshared/floor.md\n",
        stderr: "",
      };
    }
    if (joined.includes("gh pr list") && joined.includes("--state merged")) {
      if (joined.includes("watt-mind/offline")) {
        return { status: 1, stdout: "", stderr: "gh offline" };
      }
      return {
        status: 0,
        stdout: JSON.stringify([
          {
            number: 10,
            title: "feat(ui): polish dashboard (#10)",
            url: "https://github.com/watt-mind/alpha/pull/10",
            mergedAt: "2026-11-15T09:30:00Z",
            body: `Fixes #10\n- UX critique: required — SHIP\n- Risks: Defaulted mobile breakpoint to 640px\nhttps://factory.local/api/artifacts/${shotSha}`,
          },
        ]),
        stderr: "",
      };
    }
    if (joined.includes("gh pr list") && joined.includes("--label escalated")) {
      if (joined.includes("watt-mind/offline")) {
        return { status: 1, stdout: "", stderr: "gh offline" };
      }
      return {
        status: 0,
        stdout: JSON.stringify([
          {
            number: 12,
            title: "sec(auth): tighten cookie flags (#12)",
            url: "https://github.com/watt-mind/alpha/pull/12",
            body: "Fixes #12\n- Risks: Changes SameSite attribute on auth cookie",
            labels: [{ name: "escalated" }],
          },
        ]),
        stderr: "",
      };
    }
    return { status: 0, stdout: "[]", stderr: "" };
  };

  try {
    const recap = await collectRecap({
      repoNames: ["alpha", "offlineRepo"],
      since: "12h",
      now: new Date("2026-11-15T15:00:00.000Z"),
      reposMap,
      exec,
      dbFile,
      artifactsDir,
      loadHolds: async (name) =>
        name === "alpha"
          ? [
              {
                identifier: "ALPHA-9",
                title: "Pick billing currency",
                kind: "blocked",
                url: "https://linear.app/issue/ALPHA-9",
                question: "EUR or HUF default?",
              },
            ]
          : [],
    });

    const alpha = recap.repos.find((r) => r.repo === "alpha");
    const offline = recap.repos.find((r) => r.repo === "offlineRepo");

    expect(alpha.freshness).toBe("clean");
    expect(alpha.unshippedCommits).toBe(2);
    expect(alpha.mergedPrs).toHaveLength(1);
    expect(alpha.mergedPrs[0].handoff.hasAssumptions).toBe(true);
    expect(alpha.mergedPrs[0].resolvedArtifacts[0].localPath).toBe(shotPath);
    expect(alpha.escalatedPrs).toHaveLength(1);
    expect(alpha.mentalModelSignals.harness).toEqual(["shared/floor.md"]);

    // Fail-closed Checkout Freshness: failed git fetch must report "unknown", never "clean".
    expect(offline.freshness).toBe("unknown");
    expect(offline.prsStatus).toBe("unknown");

    expect(recap.runtime.uxScreenshots).toHaveLength(1);
    expect(recap.runtime.uxScreenshots[0].localPath).toBe(shotPath);
    expect(recap.runtime.inboxItems).toHaveLength(1);
    expect(recap.runtime.olderOpenInboxCount).toBe(1);
    expect(recap.attentionNeeded.length).toBeGreaterThanOrEqual(3);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("parseSinceWindow supports m/d/w durations, ISO-8601 strings, and rejects out-of-range dates or future sessions", () => {
  const now = new Date("2026-11-15T15:00:00.000Z");

  expect(parseSinceWindow("30m", { now }).sinceIso).toBe(
    "2026-11-15T14:30:00.000Z",
  );
  expect(parseSinceWindow("7d", { now }).sinceIso).toBe(
    "2026-11-08T15:00:00.000Z",
  );
  expect(parseSinceWindow("2w", { now }).sinceIso).toBe(
    "2026-11-01T15:00:00.000Z",
  );
  expect(parseSinceWindow("2026-11-15T06:00:00Z", { now }).sinceIso).toBe(
    "2026-11-15T06:00:00.000Z",
  );

  // Future lastSessionIso falls back to 24h instead of producing an empty future window.
  expect(
    parseSinceWindow("", {
      now,
      lastSessionIso: "2026-11-16T00:00:00.000Z",
    }).sinceIso,
  ).toBe("2026-11-14T15:00:00.000Z");

  expect(() => parseSinceWindow("0h", { now })).toThrow();
  expect(() => parseSinceWindow("2026-02-30", { now })).toThrow();
});

test("collectRecap handles missing runtime DB, live v17 schema, throwing holds loader, and risk-first ordering", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "recap-edge-"));
  const dbFile = path.join(tmp, "v17.db");
  const db = new Database(dbFile);
  db.exec(`
    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      spec_json TEXT NOT NULL,
      spec_hash TEXT NOT NULL,
      state TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE results (
      run_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      result_json TEXT NOT NULL,
      accepted_at TEXT NOT NULL,
      PRIMARY KEY (run_id, attempt)
    );
    CREATE TABLE inbox_items (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      refs_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
  `);
  db.query(
    `INSERT INTO runs VALUES ('r_live', 'idem_1', ?, 'hash', 'completed', 1, '2026-11-15T12:00:00.000Z', '2026-11-15T12:10:00.000Z')`,
  ).run(JSON.stringify({ agent: "dispatch", repo: "alpha" }));
  db.query(
    `INSERT INTO inbox_items VALUES ('inb_ci', 'CI RED', 'Base branch red', 'Lint failed on develop', ?, '2026-11-15T12:15:00.000Z', NULL)`,
  ).run(JSON.stringify({ repo: "alpha" }));
  db.close();

  const reposMap = new Map([
    [
      "alpha",
      {
        name: "alpha",
        path: "/fake/alpha",
        github: "watt-mind/alpha",
        base: "develop",
      },
    ],
  ]);

  const exec = (cmd) => {
    const joined = cmd.join(" ");
    if (joined.includes("fetch")) return { status: 0, stdout: "", stderr: "" };
    if (joined.includes("rev-parse"))
      return { status: 0, stdout: "abcdef1234567890\n", stderr: "" };
    if (joined.includes("--label escalated")) {
      return {
        status: 0,
        stdout: JSON.stringify([
          {
            number: 99,
            title: "sec: rotate token verifier (#99)",
            url: "https://github.com/watt-mind/alpha/pull/99",
            body: "- Risks: None.",
            labels: [{ name: "escalated" }],
          },
        ]),
        stderr: "",
      };
    }
    if (joined.includes("gh pr list")) {
      return { status: 0, stdout: "[]", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };

  try {
    const recap = await collectRecap({
      repoNames: ["alpha"],
      since: "6h",
      now: new Date("2026-11-15T15:00:00.000Z"),
      reposMap,
      exec,
      dbFile,
      artifactsDir: path.join(tmp, "no-artifacts"),
      loadHolds: async () => {
        throw new Error("tracker timeout");
      },
    });

    expect(recap.repos[0].holdsStatus).toBe("unknown");
    expect(recap.runtime.status).toBe("ok");
    expect(recap.runtime.runs).toHaveLength(1);
    expect(recap.runtime.inboxItems).toHaveLength(1);
    expect(recap.attentionNeeded.map((i) => i.category)).toEqual([
      "escalated_pr",
      "inbox",
    ]);

    const missingDbRecap = await collectRecap({
      repoNames: ["alpha"],
      since: "6h",
      now: new Date("2026-11-15T15:00:00.000Z"),
      reposMap,
      exec,
      dbFile: path.join(tmp, "missing.db"),
      loadHolds: async () => [],
    });
    expect(missingDbRecap.runtime.status).toBe("unavailable");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI --help prints usage header and exits 0", () => {
  const recapCli = path.join(import.meta.dir, "recap.mjs");
  const res = Bun.spawnSync({
    cmd: [process.execPath, recapCli, "--help"],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(res.exitCode).toBe(0);
  expect(res.stdout.toString()).toContain(
    "factory recap — read-only operator delta catch-up and decision collector",
  );
});
