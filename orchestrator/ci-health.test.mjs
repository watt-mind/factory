import { test, expect } from "bun:test";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  advisoryJobsFor,
  ciWorkflowName,
  decideCiHealth,
  formatReport,
  formatSpan,
  latestVerdict,
  readCiHealthState,
  redStreaks,
  runCiHealthTick,
  selectPushes,
  selectRepos,
  shortSha,
  writeCiHealthState,
  PUSH_WINDOW,
} from "./ci-health.mjs";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-09-15T08:00:00.000Z");

/** One `gh run list` row, in the shape the forge returns it. */
function run({
  id,
  sha,
  createdAt,
  conclusion = "failure",
  status = "completed",
  workflowName = "CI",
}) {
  return {
    databaseId: id,
    headSha: sha,
    status,
    conclusion,
    createdAt,
    url: `https://github.com/watt-mind/legalease/actions/runs/${id}`,
    workflowName,
  };
}

/** A push (run + its jobs) already normalized, for the pure-decision tests. */
function push({ sha, hoursAgo = 0, jobs }) {
  return {
    sha,
    runId: 1,
    url: `https://github.com/o/r/actions/runs/${sha}`,
    createdAtMs: NOW - hoursAgo * HOUR,
    jobs: Object.entries(jobs).map(([name, conclusion]) => ({
      name,
      conclusion,
    })),
  };
}

const decide = (pushes, opts = {}) =>
  decideCiHealth({
    repo: "legalease",
    base: "develop",
    pushes,
    now: NOW,
    ...opts,
  });

/* --- run selection ------------------------------------------------------ */

test("selectPushes keeps the newest run per head SHA and drops cancelled runs", () => {
  const pushes = selectPushes(
    [
      run({
        id: 5,
        sha: "cccccccccc",
        createdAt: "2026-09-15T07:00:00Z",
        conclusion: "success",
      }),
      run({
        id: 4,
        sha: "cccccccccc",
        createdAt: "2026-09-15T06:00:00Z",
        conclusion: "failure",
      }),
      run({
        id: 3,
        sha: "bbbbbbbbbb",
        createdAt: "2026-09-15T05:00:00Z",
        conclusion: "cancelled",
      }),
      run({ id: 2, sha: "aaaaaaaaaa", createdAt: "2026-09-15T04:00:00Z" }),
      run({ id: 1, sha: "9999999999", createdAt: "2026-09-15T03:00:00Z" }),
    ],
    { window: PUSH_WINDOW },
  );

  // cccccccccc collapses to its newest (id 5); the cancelled push is gone.
  expect(pushes.map((p) => p.databaseId)).toEqual([5, 2, 1]);
});

test("selectPushes ignores other workflows and runs that have not completed", () => {
  const pushes = selectPushes(
    [
      run({
        id: 9,
        sha: "aaaaaaa1",
        createdAt: "2026-09-15T07:00:00Z",
        workflowName: "Security",
      }),
      run({
        id: 8,
        sha: "aaaaaaa2",
        createdAt: "2026-09-15T06:30:00Z",
        status: "in_progress",
        conclusion: null,
      }),
      run({ id: 7, sha: "aaaaaaa3", createdAt: "2026-09-15T06:00:00Z" }),
    ],
    { workflow: "CI" },
  );
  expect(pushes.map((p) => p.databaseId)).toEqual([7]);
});

/* --- the counting rules ------------------------------------------------- */

test("two consecutive reds on distinct SHAs produce exactly one CI RED", () => {
  const result = decide([
    push({
      sha: "b2b2b2b2b2",
      hoursAgo: 1,
      jobs: { qualify: "failure", unit: "success" },
    }),
    push({
      sha: "a1a1a1a1a1",
      hoursAgo: 3,
      jobs: { qualify: "failure", unit: "success" },
    }),
    push({
      sha: "0f0f0f0f0f",
      hoursAgo: 6,
      jobs: { qualify: "success", unit: "success" },
    }),
  ]);

  expect(result.alerts).toHaveLength(1);
  expect(result.alerts[0].kind).toBe("red");
  expect(result.alerts[0].message).toBe(
    "CI RED legalease/develop: qualify red on 2 consecutive pushes since a1a1a1a (3h); " +
      "latest https://github.com/o/r/actions/runs/b2b2b2b2b2",
  );
  expect(result.jobs.qualify.since).toBe("a1a1a1a1a1");
});

test("a single red is a flake, not an outage", () => {
  const result = decide([
    push({ sha: "b2b2b2b2b2", hoursAgo: 1, jobs: { qualify: "failure" } }),
    push({ sha: "a1a1a1a1a1", hoursAgo: 3, jobs: { qualify: "success" } }),
  ]);
  expect(result.alerts).toEqual([]);
  expect(result.jobs).toEqual({});
});

test("alternating red and green never alarms", () => {
  const result = decide([
    push({ sha: "cccccccccc", hoursAgo: 1, jobs: { e2e: "failure" } }),
    push({ sha: "bbbbbbbbbb", hoursAgo: 2, jobs: { e2e: "success" } }),
    push({ sha: "aaaaaaaaaa", hoursAgo: 3, jobs: { e2e: "failure" } }),
  ]);
  expect(result.alerts).toEqual([]);
});

test("a standing alarm is never re-sent, however many more reds land", () => {
  const priorJobs = {
    qualify: {
      since: "a1a1a1a1a1",
      sinceAtMs: NOW - 3 * HOUR,
      count: 2,
      notifiedAtMs: NOW - 2 * HOUR,
    },
  };
  const result = decide(
    [
      push({ sha: "c3c3c3c3c3", hoursAgo: 0.5, jobs: { qualify: "failure" } }),
      push({ sha: "b2b2b2b2b2", hoursAgo: 1, jobs: { qualify: "failure" } }),
      push({ sha: "a1a1a1a1a1", hoursAgo: 3, jobs: { qualify: "failure" } }),
    ],
    { priorJobs },
  );

  expect(result.alerts).toEqual([]);
  // The alarm keeps its original "since" — the outage did not restart.
  expect(result.jobs.qualify.since).toBe("a1a1a1a1a1");
  expect(result.jobs.qualify.count).toBe(3);
});

test("a cancelled run between two reds leaves them consecutive", () => {
  // The cancelled run is already gone by selectPushes; prove the pair that
  // survives is still read as consecutive rather than as two singles.
  const runs = [
    run({
      id: 3,
      sha: "b2b2b2b2b2",
      createdAt: "2026-09-15T07:00:00Z",
      conclusion: "failure",
    }),
    run({
      id: 2,
      sha: "1d1d1d1d1d",
      createdAt: "2026-09-15T06:00:00Z",
      conclusion: "cancelled",
    }),
    run({
      id: 1,
      sha: "a1a1a1a1a1",
      createdAt: "2026-09-15T05:00:00Z",
      conclusion: "failure",
    }),
  ];
  const selected = selectPushes(runs, { workflow: "CI" });
  expect(selected.map((r) => r.headSha)).toEqual(["b2b2b2b2b2", "a1a1a1a1a1"]);

  const result = decide(
    selected.map((r, i) =>
      push({ sha: r.headSha, hoursAgo: i + 1, jobs: { qualify: "failure" } }),
    ),
  );
  expect(result.alerts).toHaveLength(1);
  expect(result.alerts[0].message).toContain("red on 2 consecutive pushes");
});

test("a job that is cancelled inside a counted run neither counts nor breaks", () => {
  const result = decide([
    push({ sha: "cccccccccc", hoursAgo: 1, jobs: { qualify: "failure" } }),
    push({ sha: "bbbbbbbbbb", hoursAgo: 2, jobs: { qualify: "cancelled" } }),
    push({ sha: "aaaaaaaaaa", hoursAgo: 3, jobs: { qualify: "failure" } }),
  ]);
  expect(result.alerts).toHaveLength(1);
  expect(result.alerts[0].message).toContain(
    "red on 2 consecutive pushes since aaaaaaa",
  );
});

test("advisory jobs are excluded entirely", () => {
  const pushes = [
    push({
      sha: "bbbbbbbbbb",
      hoursAgo: 1,
      jobs: { "security lint": "failure", unit: "success" },
    }),
    push({
      sha: "aaaaaaaaaa",
      hoursAgo: 3,
      jobs: { "security lint": "failure", unit: "success" },
    }),
  ];
  expect(decide(pushes).alerts).toHaveLength(1); // control: it would alarm

  const result = decide(pushes, { advisoryJobs: ["security lint"] });
  expect(result.alerts).toEqual([]);
  expect(redStreaks(pushes, { advisoryJobs: ["security lint"] }).size).toBe(0);
});

/* --- recovery ----------------------------------------------------------- */

test("recovery sends exactly one CI GREEN and clears the alarm", () => {
  const priorJobs = {
    qualify: {
      since: "a1a1a1a1a1",
      sinceAtMs: NOW - 10 * HOUR,
      count: 6,
      notifiedAtMs: NOW - 9 * HOUR,
    },
  };
  const result = decide(
    [
      push({ sha: "d4d4d4d4d4", hoursAgo: 0.5, jobs: { qualify: "success" } }),
      push({ sha: "c3c3c3c3c3", hoursAgo: 2, jobs: { qualify: "failure" } }),
    ],
    { priorJobs },
  );

  expect(result.alerts).toHaveLength(1);
  expect(result.alerts[0].kind).toBe("green");
  expect(result.alerts[0].message).toBe(
    "CI GREEN legalease/develop: qualify recovered at d4d4d4d",
  );
  expect(result.jobs.qualify).toBeUndefined();

  // ...and the next tick, with the alarm cleared, says nothing at all.
  const after = decide(
    [push({ sha: "d4d4d4d4d4", hoursAgo: 0.5, jobs: { qualify: "success" } })],
    { priorJobs: result.jobs },
  );
  expect(after.alerts).toEqual([]);
});

test("silence is not recovery — an alarmed job that vanished holds its alarm", () => {
  const priorJobs = {
    qualify: {
      since: "a1a1a1a1a1",
      sinceAtMs: NOW - 10 * HOUR,
      count: 6,
      notifiedAtMs: NOW - 9 * HOUR,
    },
  };
  const result = decide(
    [push({ sha: "d4d4d4d4d4", hoursAgo: 0.5, jobs: { unit: "success" } })],
    { priorJobs },
  );
  expect(result.alerts).toEqual([]);
  expect(result.jobs.qualify.since).toBe("a1a1a1a1a1");
  expect(
    latestVerdict(
      [push({ sha: "d4d4d4d4d4", jobs: { unit: "success" } })],
      "qualify",
    ),
  ).toBeNull();
});

/* --- the case this loop exists for -------------------------------------- */

// 2026-09-15: legalease `develop` was red in the digest-bound qualification
// gate for six consecutive pushes and about ten hours (21:45Z -> 06:50Z) while
// deploy and smoke stayed green, so every merge agent walked past it. Recorded
// here as the shape the alarm has to catch.
const LEGALEASE_QUALIFY = "Digest-Bound Dev Runtime Qualification / qualify";
const LEGALEASE_RUNS = [
  run({
    id: 31266151610,
    sha: "6f4ad0c9b1e2",
    createdAt: "2026-09-15T06:50:00Z",
  }),
  run({
    id: 31264012288,
    sha: "5e39bf7a0d41",
    createdAt: "2026-09-15T04:05:00Z",
  }),
  run({
    id: 31261770004,
    sha: "4c18ae62f3b7",
    createdAt: "2026-09-15T01:30:00Z",
  }),
  run({
    id: 31259443121,
    sha: "3b07d9514a2c",
    createdAt: "2026-09-14T23:40:00Z",
  }),
  run({
    id: 31258220997,
    sha: "2a96c8403e1b",
    createdAt: "2026-09-14T22:35:00Z",
  }),
  run({
    id: 31257001455,
    sha: "9f2c1ab7d508",
    createdAt: "2026-09-14T21:45:00Z",
  }),
  run({
    id: 31255880311,
    sha: "8e1b0fa6c497",
    createdAt: "2026-09-14T20:10:00Z",
    conclusion: "success",
  }),
];
const legaleaseJobs = (sha) => [
  { name: "Django Check", conclusion: "success" },
  { name: "Django Unit Tests", conclusion: "success" },
  { name: "Browser E2E Tests", conclusion: "success" },
  { name: "Deploy Dev", conclusion: "success" },
  {
    name: LEGALEASE_QUALIFY,
    conclusion: sha === "8e1b0fa6c497" ? "success" : "failure",
  },
];

test("2026-09-15 legalease: qualify red on six consecutive pushes alarms once", async () => {
  const now = Date.parse("2026-09-15T07:50:00Z"); // ten hours after the first red
  const sent = [];
  const { results, state } = await runCiHealthTick({
    repos: [
      {
        name: "legalease",
        github: "watt-mind/legalease",
        base: "develop",
        merge_ci: { workflow: "CI" },
      },
    ],
    listRuns: () => LEGALEASE_RUNS,
    listJobs: (_repo, r) => legaleaseJobs(r.headSha),
    notify: (message) => {
      sent.push(message);
      return true;
    },
    now,
    apply: true,
    window: 6,
  });

  expect(sent).toEqual([
    "CI RED legalease/develop: Digest-Bound Dev Runtime Qualification / qualify " +
      "red on 6 consecutive pushes since 9f2c1ab (10h); " +
      "latest https://github.com/watt-mind/legalease/actions/runs/31266151610",
  ]);
  expect(results[0].redJobs.map((s) => s.job)).toEqual([LEGALEASE_QUALIFY]);
  expect(state.repos["legalease/develop"].jobs[LEGALEASE_QUALIFY].since).toBe(
    "9f2c1ab7d508",
  );

  // Deploy and smoke were green throughout — exactly why a human never heard.
  expect(sent.join("\n")).not.toContain("Deploy Dev");
});

test("2026-09-15 legalease: the default three-push window still catches it", async () => {
  const sent = [];
  await runCiHealthTick({
    repos: [
      { name: "legalease", github: "watt-mind/legalease", base: "develop" },
    ],
    listRuns: () => LEGALEASE_RUNS,
    listJobs: (_repo, r) => legaleaseJobs(r.headSha),
    notify: (message) => sent.push(message) && true,
    now: Date.parse("2026-09-15T07:50:00Z"),
    apply: true,
  });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("red on 3 consecutive pushes since 4c18ae6");
});

/* --- the tick's own guarantees ------------------------------------------ */

test("a dry tick prints the notification, sends nothing and remembers nothing", async () => {
  const sent = [];
  const printed = [];
  const before = { version: 1, repos: {} };
  const { results, state } = await runCiHealthTick({
    repos: [
      { name: "legalease", github: "watt-mind/legalease", base: "develop" },
    ],
    state: before,
    listRuns: () => LEGALEASE_RUNS,
    listJobs: (_repo, r) => legaleaseJobs(r.headSha),
    notify: (message) => sent.push(message),
    now: Date.parse("2026-09-15T07:50:00Z"),
    apply: false,
    log: (line) => printed.push(line),
  });

  expect(sent).toEqual([]);
  expect(printed.join("\n")).toContain(
    "would notify: CI RED legalease/develop:",
  );
  expect(results[0].alerts).toHaveLength(1);
  // The alarm must survive the preview, or the real tick goes silent.
  expect(state.repos).toEqual({});
});

test("a forge that cannot answer reports the error and changes no alarm", async () => {
  const priorState = {
    version: 1,
    repos: {
      "legalease/develop": {
        jobs: {
          qualify: { since: "a1a1a1a1a1", sinceAtMs: NOW - HOUR, count: 2 },
        },
      },
    },
  };
  const { results, state } = await runCiHealthTick({
    repos: [
      { name: "legalease", github: "watt-mind/legalease", base: "develop" },
    ],
    state: priorState,
    listRuns: () => {
      throw new Error("gh: API rate limit exceeded");
    },
    listJobs: () => [],
    notify: () => true,
    apply: true,
  });

  expect(results[0].error).toContain("API rate limit exceeded");
  expect(results[0].alerts).toEqual([]);
  expect(state.repos["legalease/develop"].jobs.qualify.since).toBe(
    "a1a1a1a1a1",
  );
});

test("a repo with no completed runs of its workflow is reported, not alarmed", async () => {
  const { results } = await runCiHealthTick({
    repos: [{ name: "wm-home", github: "watt-mind/wm-home", base: "develop" }],
    listRuns: () => [
      run({
        id: 1,
        sha: "aaaaaaa",
        createdAt: "2026-09-15T01:00:00Z",
        workflowName: "Deploy",
      }),
    ],
    listJobs: () => [],
    apply: true,
  });
  expect(results[0].note).toBe("no completed CI runs on develop");
  expect(results[0].alerts).toEqual([]);
});

/* --- config and report -------------------------------------------------- */

test("ciWorkflowName and advisoryJobsFor read the repo entry", () => {
  expect(ciWorkflowName({})).toBe("CI");
  expect(ciWorkflowName({ merge_ci: { workflow: "Build" } })).toBe("Build");
  expect(
    ciWorkflowName({
      merge_ci: { workflow: "Build" },
      ci_health: { workflow: "Trunk" },
    }),
  ).toBe("Trunk");
  expect(advisoryJobsFor({})).toEqual([]);
  expect(advisoryJobsFor({ advisory_jobs: ["security lint"] })).toEqual([
    "security lint",
  ]);
});

test("selectRepos needs a github remote and honours --repo", () => {
  const config = {
    repos: [
      { name: "factory", github: "watt-mind/factory" },
      { name: "local-only" },
      { name: "lawz", github: "watt-mind/lawz" },
    ],
  };
  expect(selectRepos(config).map((r) => r.name)).toEqual(["factory", "lawz"]);
  expect(selectRepos(config, ["lawz"]).map((r) => r.name)).toEqual(["lawz"]);
});

test("formatReport renders a base CI health block from the remembered state", () => {
  const state = {
    version: 1,
    repos: {
      "factory/develop": { jobs: {} },
      "legalease/develop": {
        jobs: {
          qualify: {
            since: "9f2c1ab7d508",
            sinceAtMs: NOW - 10 * HOUR,
            count: 6,
          },
        },
      },
    },
  };
  expect(formatReport(state, { now: NOW })).toBe(
    [
      "base CI health",
      "  factory/develop  green",
      "  legalease/develop  RED qualify — 6 consecutive pushes since 9f2c1ab (10h)",
    ].join("\n"),
  );
  expect(formatReport({ repos: {} })).toContain("no base branch observed yet");
  expect(formatReport(state, { repos: ["factory"], now: NOW })).not.toContain(
    "legalease",
  );
});

test("state round-trips and an unreadable file degrades to empty", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ci-health-"));
  const file = path.join(dir, "ci-health.json");
  expect(readCiHealthState(file)).toEqual({ version: 1, repos: {} });

  const state = { version: 1, repos: { "factory/develop": { jobs: {} } } };
  expect(writeCiHealthState(state, file)).toBe(true);
  expect(existsSync(file)).toBe(true);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(state);
  expect(readCiHealthState(file)).toEqual(state);

  Bun.write(file, "{ not json");
  expect(readCiHealthState(file)).toEqual({ version: 1, repos: {} });
});

test("formatSpan and shortSha render the notification's variable parts", () => {
  expect(formatSpan(45 * 60_000)).toBe("45m");
  expect(formatSpan(10 * HOUR)).toBe("10h");
  expect(formatSpan(50 * HOUR)).toBe("2d");
  expect(formatSpan(5_000)).toBe("1m");
  expect(formatSpan(-1)).toBe("?");
  expect(shortSha("9f2c1ab7d508")).toBe("9f2c1ab");
  expect(shortSha(null)).toBe("?");
});

test("a failed notify is not remembered as delivered: the next tick re-sends", async () => {
  const now = Date.parse("2026-09-15T07:50:00Z");
  const repos = [
    {
      name: "legalease",
      github: "watt-mind/legalease",
      base: "develop",
      merge_ci: { workflow: "CI" },
    },
  ];
  const attempts = [];
  // Tick 1: the transport is down (factory notify exits non-zero).
  const first = await runCiHealthTick({
    repos,
    listRuns: () => LEGALEASE_RUNS,
    listJobs: (_repo, r) => legaleaseJobs(r.headSha),
    notify: (message) => {
      attempts.push(message);
      return false;
    },
    now,
    apply: true,
    window: 6,
  });
  expect(attempts).toHaveLength(1);
  expect(first.results[0].sent[0].delivered).toBe(false);
  // The alarm must NOT be persisted, or the outage goes silent for its whole duration.
  expect(
    first.state.repos["legalease/develop"].jobs[LEGALEASE_QUALIFY],
  ).toBeUndefined();

  // Tick 2, transport back: the same red is sent again exactly once.
  const second = await runCiHealthTick({
    repos,
    state: first.state,
    listRuns: () => LEGALEASE_RUNS,
    listJobs: (_repo, r) => legaleaseJobs(r.headSha),
    notify: (message) => {
      attempts.push(message);
      return true;
    },
    now: now + 15 * 60_000,
    apply: true,
    window: 6,
  });
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toBe(attempts[0]);
  expect(
    second.state.repos["legalease/develop"].jobs[LEGALEASE_QUALIFY].since,
  ).toBe("9f2c1ab7d508");
});

test("a notify that throws neither crashes the tick nor consumes the alarm", async () => {
  const now = Date.parse("2026-09-15T07:50:00Z");
  const { results, state } = await runCiHealthTick({
    repos: [
      {
        name: "legalease",
        github: "watt-mind/legalease",
        base: "develop",
        merge_ci: { workflow: "CI" },
      },
    ],
    listRuns: () => LEGALEASE_RUNS,
    listJobs: (_repo, r) => legaleaseJobs(r.headSha),
    notify: () => {
      throw new Error("spawn EAGAIN");
    },
    now,
    apply: true,
    window: 6,
  });
  expect(results[0].sent[0].delivered).toBe(false);
  expect(
    state.repos["legalease/develop"].jobs[LEGALEASE_QUALIFY],
  ).toBeUndefined();
});
