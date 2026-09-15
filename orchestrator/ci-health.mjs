#!/usr/bin/env bun
/**
 * Is a base branch stuck red in the SAME job, push after push? (WM-1103)
 *
 *   bun orchestrator/ci-health.mjs                        # every repo, dry
 *   bun orchestrator/ci-health.mjs --repo legalease       # one repo, dry
 *   bun orchestrator/ci-health.mjs --repo legalease --apply
 *   bun orchestrator/ci-health.mjs --report               # remembered alarms
 *   bun orchestrator/ci-health.mjs --json
 *
 * On 2026-09-15 legalease `develop` was red in one job — `qualify` — for ten
 * hours and six consecutive pushes before a human heard about it. Every merge
 * agent that looked saw "deploy green, smoke green, one gate red", judged it
 * not-its-problem, and moved on; meanwhile every image publication and the
 * master receipt gate were stranded behind that gate. Nobody was wrong. Nobody
 * was watching the base branch either.
 *
 * `ci.mjs` is the other CI reader and answers a different question: over
 * fourteen days, which workflows are slow or flaky? That is a retro input. This
 * is the alarm: right now, on this base, has one job failed on two pushes in a
 * row? A single red run is noise (a flake, a bad commit already reverted). The
 * same job red across two DISTINCT head SHAs is a broken trunk, and the second
 * push is the earliest moment you can say so without crying wolf.
 *
 * Three properties, in the order they matter:
 *
 *   1. EXACTLY ONE NOTIFY PER OUTAGE. The alarm is remembered in
 *      ~/.factory/state/ci-health.json and stands until the job is seen green
 *      again (then one `CI GREEN`). A loop that pushes the same alert every
 *      fifteen minutes gets muted, and a muted channel loses the next one too.
 *   2. DRY BY DEFAULT. Without --apply nothing is sent AND nothing is written:
 *      a preview that consumed the alarm would silence the real alert.
 *   3. FAIL CLOSED. A forge that cannot answer, a job that vanished from the
 *      workflow, a run still in progress — none of these are evidence of
 *      green. Unknown holds the alarm and reports nothing new.
 *
 * Counting rules, all of which exist because of a real shape in the fixtures:
 *   - Runs are deduplicated by head SHA, newest first: a rerun of the same
 *     push is the same push, and its newest verdict is the one that counts.
 *   - A `cancelled` RUN is skipped, not counted — a push whose CI was
 *     superseded says nothing, so it must neither break a streak nor extend
 *     it. (Two reds with a cancelled run between them are consecutive.)
 *   - A job that is `cancelled`/`skipped`/absent inside a counted run is
 *     neutral for the same reason, at job granularity.
 *   - Jobs named in a repo's `advisory_jobs:` are ignored entirely. Some gates
 *     are advisory by design (security lint on a fork PR); alerting on them
 *     trains the operator to ignore this loop.
 *
 * Reads GitHub through the Forge connector, never `gh` directly: `runList` for
 * the branch's runs (filtered to the CI workflow by name here, because the
 * neutral contract has no `--workflow` and one extra verb is not worth it) and
 * the `apiRaw` escape hatch for each run's jobs. Every dependency is injected,
 * so the tests run against recorded JSON with no network and no clock.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfigYaml, ROOT } from "../lib/schedule.mjs";
import { STATE_DIR } from "../lib/factory-state.mjs";
import { loadForge } from "../lib/forge/index.mjs";

/** Where the alarm memory lives, so a `--once` cron tick has a past. */
export const CI_HEALTH_STATE_FILE = path.join(STATE_DIR, "ci-health.json");

/** How many distinct pushes back to look. The ticket's N. */
export const PUSH_WINDOW = 3;

/** Reds on this many consecutive distinct SHAs is an outage, not a flake. */
export const RED_STREAK_THRESHOLD = 2;

/** Workflow name used when a repo configures none. */
export const DEFAULT_CI_WORKFLOW = "CI";

/**
 * How many runs to ask the forge for. A base branch carries every workflow's
 * runs interleaved, so this is deliberately much larger than PUSH_WINDOW —
 * with a dozen workflows, the last three CI runs can be forty rows down.
 */
export const RUN_FETCH_LIMIT = 60;

/** Fields the decision needs off each workflow run. */
export const CI_HEALTH_RUN_FIELDS = Object.freeze([
  "databaseId",
  "headSha",
  "status",
  "conclusion",
  "createdAt",
  "url",
  "workflowName",
]);

/** A job verdict that means "this push failed for this job". */
const RED = new Set(["failure", "timed_out", "startup_failure"]);

/** A job verdict that means "this push passed for this job". */
const GREEN = new Set(["success"]);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "45m" / "10h" / "3d" — a span, not a timestamp, for the notify text. */
export function formatSpan(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  if (ms >= DAY) return `${Math.floor(ms / DAY)}d`;
  if (ms >= HOUR) return `${Math.floor(ms / HOUR)}h`;
  return `${Math.max(1, Math.floor(ms / MINUTE))}m`;
}

export function shortSha(sha) {
  return typeof sha === "string" && sha.length > 7
    ? sha.slice(0, 7)
    : (sha ?? "?");
}

/**
 * The CI workflow name for a repo. `merge_ci.workflow` is the same workflow
 * the merge stage gates on, so a repo that configured one is already telling
 * us which one is the trunk's verdict; `ci_health.workflow` overrides it for
 * the rare repo whose merge gate and trunk gate differ.
 */
export function ciWorkflowName(repo) {
  return (
    repo?.ci_health?.workflow ?? repo?.merge_ci?.workflow ?? DEFAULT_CI_WORKFLOW
  );
}

/** Job names this repo has declared advisory — never alarmed on. */
export function advisoryJobsFor(repo) {
  const declared = repo?.advisory_jobs;
  return Array.isArray(declared) ? declared.map((j) => String(j)) : [];
}

/**
 * The last `window` PUSHES on the branch, newest first.
 *
 * "Push", not "run": reruns of one SHA collapse to that SHA's newest run, and
 * a cancelled run is dropped entirely rather than being counted as a push with
 * no verdict — which is what makes a cancelled run between two reds leave the
 * reds adjacent.
 */
export function selectPushes(
  runs,
  { window = PUSH_WINDOW, workflow = null } = {},
) {
  const completed = (runs ?? []).filter((run) => {
    if (!run || run.status !== "completed" || !run.headSha) return false;
    if (run.conclusion === "cancelled") return false;
    if (
      workflow &&
      String(run.workflowName ?? "").toLowerCase() !== workflow.toLowerCase()
    )
      return false;
    return true;
  });
  completed.sort(
    (a, b) => Date.parse(b.createdAt ?? 0) - Date.parse(a.createdAt ?? 0),
  );

  const bySha = new Map();
  for (const run of completed) {
    if (bySha.has(run.headSha)) continue; // newest run for this push already kept
    bySha.set(run.headSha, run);
    if (bySha.size >= window) break;
  }
  return [...bySha.values()];
}

/** One run + its jobs, in the shape the decision consumes. */
export function toPush(run, jobs) {
  return {
    sha: run?.headSha ?? null,
    runId: run?.databaseId ?? null,
    url: run?.url ?? null,
    createdAtMs: Date.parse(run?.createdAt ?? "") || null,
    jobs: (jobs ?? []).map((job) => ({
      name: job?.name ?? "?",
      conclusion: job?.conclusion ?? null,
    })),
  };
}

function conclusionFor(push, job) {
  return (
    (push.jobs ?? []).find((entry) => entry.name === job)?.conclusion ?? null
  );
}

/**
 * The newest push on which this job returned an actual verdict, or null when
 * every push in the window was neutral for it. "Unknown" must never read as
 * "recovered", so the caller checks this rather than push[0] blindly.
 */
export function latestVerdict(pushes, job) {
  for (const push of pushes) {
    const conclusion = conclusionFor(push, job);
    if (RED.has(conclusion) || GREEN.has(conclusion))
      return { sha: push.sha, conclusion, url: push.url };
  }
  return null;
}

/**
 * Per job, how many consecutive pushes back from the newest it has been red.
 *
 * Walking newest -> oldest: red extends the streak, green ends it, anything
 * else (cancelled, skipped, the job simply absent from that run) is neutral
 * and is stepped over. The streak's `firstSha` is therefore the OLDEST red in
 * the run of reds, which is the "since" the notification quotes.
 */
export function redStreaks(pushes, { advisoryJobs = [] } = {}) {
  const advisory = new Set(advisoryJobs);
  const names = new Set();
  for (const push of pushes ?? [])
    for (const job of push.jobs ?? [])
      if (job.name && !advisory.has(job.name)) names.add(job.name);

  const streaks = new Map();
  for (const name of names) {
    let count = 0;
    let first = null;
    let latest = null;
    for (const push of pushes) {
      const conclusion = conclusionFor(push, name);
      if (RED.has(conclusion)) {
        count += 1;
        first = push;
        latest ??= push;
        continue;
      }
      if (GREEN.has(conclusion)) break;
      // neutral — neither counts nor breaks
    }
    if (!count) continue;
    streaks.set(name, {
      job: name,
      count,
      firstSha: first?.sha ?? null,
      firstAtMs: first?.createdAtMs ?? null,
      latestSha: latest?.sha ?? null,
      latestUrl: latest?.url ?? null,
    });
  }
  return streaks;
}

export function redMessage({
  repo,
  base,
  job,
  count,
  firstSha,
  firstAtMs,
  latestUrl,
  now,
}) {
  const age = firstAtMs == null ? "?" : formatSpan(now - firstAtMs);
  return (
    `CI RED ${repo}/${base}: ${job} red on ${count} consecutive pushes ` +
    `since ${shortSha(firstSha)} (${age}); latest ${latestUrl ?? "(no run url)"}`
  );
}

export function greenMessage({ repo, base, job, sha }) {
  return `CI GREEN ${repo}/${base}: ${job} recovered at ${shortSha(sha)}`;
}

/**
 * The whole decision, pure: pushes + the alarms we remember + the clock in,
 * the alerts to send and the alarms to remember next out. No IO, so every rule
 * above is a fixture test rather than a thing you find out in production.
 *
 * @returns {{ alerts: object[], jobs: object, redJobs: object[] }}
 *   `jobs` is this base's next alarm map; `redJobs` is every standing streak
 *   (alerted or not) for the report line.
 */
export function decideCiHealth({
  repo,
  base,
  pushes = [],
  priorJobs = {},
  now = Date.now(),
  advisoryJobs = [],
  threshold = RED_STREAK_THRESHOLD,
}) {
  const streaks = redStreaks(pushes, { advisoryJobs });
  const advisory = new Set(advisoryJobs);
  const alerts = [];
  const jobs = {};

  for (const [job, streak] of streaks) {
    const alarm = priorJobs?.[job];
    if (streak.count < threshold) {
      // Not (yet) an outage. An alarm already standing is only cleared by an
      // actual green — see the prior-alarm sweep below.
      continue;
    }
    if (alarm) {
      // Standing alarm: keep observing, say nothing. This is the property that
      // makes a 15-minute cadence affordable.
      jobs[job] = {
        ...alarm,
        count: streak.count,
        latestRunUrl: streak.latestUrl,
        seenAtMs: now,
      };
      continue;
    }
    alerts.push({
      kind: "red",
      repo,
      base,
      job,
      count: streak.count,
      firstSha: streak.firstSha,
      latestUrl: streak.latestUrl,
      message: redMessage({ repo, base, job, ...streak, now }),
    });
    jobs[job] = {
      since: streak.firstSha,
      sinceAtMs: streak.firstAtMs,
      count: streak.count,
      latestRunUrl: streak.latestUrl,
      notifiedAtMs: now,
      seenAtMs: now,
    };
  }

  // Alarms we already hold that produced no streak entry above: either the job
  // recovered, or we cannot tell. Only a green verdict on the newest push that
  // has one clears an alarm; silence never does.
  for (const [job, alarm] of Object.entries(priorJobs ?? {})) {
    if (jobs[job]) continue;
    if (advisory.has(job)) continue; // newly declared advisory — drop the alarm
    const verdict = latestVerdict(pushes, job);
    if (verdict && GREEN.has(verdict.conclusion)) {
      alerts.push({
        kind: "green",
        repo,
        base,
        job,
        sha: verdict.sha,
        message: greenMessage({ repo, base, job, sha: verdict.sha }),
      });
      continue;
    }
    jobs[job] = { ...alarm, seenAtMs: now };
  }

  return {
    alerts,
    jobs,
    redJobs: [...streaks.values()].filter((s) => s.count >= threshold),
  };
}

/* --- state ------------------------------------------------------------- */

export function emptyState() {
  return { version: 1, repos: {} };
}

export function readCiHealthState(file = CI_HEALTH_STATE_FILE) {
  try {
    if (!existsSync(file)) return emptyState();
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object") return emptyState();
    return { version: 1, repos: parsed.repos ?? {} };
  } catch {
    // A corrupt state file costs one duplicate alert, not the loop.
    return emptyState();
  }
}

export function writeCiHealthState(state, file = CI_HEALTH_STATE_FILE) {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/* --- the tick ----------------------------------------------------------- */

/**
 * One pass over the selected repos.
 *
 * `apply` gates BOTH the notify and the state write, together: sending without
 * remembering would repeat every tick, and remembering without sending would
 * swallow the alert entirely. They are one decision.
 */
export async function runCiHealthTick({
  repos,
  state = emptyState(),
  listRuns,
  listJobs,
  notify = () => false,
  now = Date.now(),
  apply = false,
  window = PUSH_WINDOW,
  threshold = RED_STREAK_THRESHOLD,
  log = () => {},
}) {
  const results = [];
  const nextRepos = { ...(state.repos ?? {}) };

  for (const repo of repos) {
    const base = repo.base || "main";
    const key = `${repo.name}/${base}`;
    const workflow = ciWorkflowName(repo);
    const advisoryJobs = advisoryJobsFor(repo);

    let runs;
    try {
      runs = await listRuns(repo, { branch: base, limit: RUN_FETCH_LIMIT });
    } catch (error) {
      results.push({
        repo: repo.name,
        base,
        workflow,
        error: `could not list runs: ${error instanceof Error ? error.message : String(error)}`,
        alerts: [],
        redJobs: [],
      });
      continue;
    }

    const selected = selectPushes(runs, { window, workflow });
    if (!selected.length) {
      results.push({
        repo: repo.name,
        base,
        workflow,
        error: null,
        pushes: 0,
        note: `no completed ${workflow} runs on ${base}`,
        alerts: [],
        redJobs: [],
      });
      continue;
    }

    const pushes = [];
    let jobsError = null;
    for (const run of selected) {
      try {
        pushes.push(toPush(run, await listJobs(repo, run)));
      } catch (error) {
        jobsError = error instanceof Error ? error.message : String(error);
        break;
      }
    }
    if (jobsError) {
      results.push({
        repo: repo.name,
        base,
        workflow,
        error: `could not read jobs: ${jobsError}`,
        alerts: [],
        redJobs: [],
      });
      continue;
    }

    const decision = decideCiHealth({
      repo: repo.name,
      base,
      pushes,
      priorJobs: nextRepos[key]?.jobs ?? {},
      now,
      advisoryJobs,
      threshold,
    });

    const sent = [];
    for (const alert of decision.alerts) {
      if (!apply) {
        log(`would notify: ${alert.message}`);
        continue;
      }
      // A notify that fails (transport down, `factory` missing, non-zero
      // exit, or a thrown spawn) must not be remembered as a delivered
      // alarm: forgetting the job makes the next tick send it again. One
      // duplicate push is the cheap failure mode; a silent outage is not.
      let ok;
      try {
        ok = await notify(alert.message);
      } catch (error) {
        ok = false;
        log(`notify threw: ${error?.message ?? error}`);
      }
      const delivered = ok !== false;
      sent.push({ ...alert, delivered });
      if (!delivered && alert.kind === "red") {
        delete decision.jobs[alert.job];
      }
      log(
        delivered
          ? `notified: ${alert.message}`
          : `notify FAILED (will retry next tick): ${alert.message}`,
      );
    }

    // Dry runs observe; they never consume the alarm that the real tick owes
    // the operator.
    if (apply) {
      nextRepos[key] = {
        checkedAtMs: now,
        workflow,
        jobs: decision.jobs,
      };
    }

    results.push({
      repo: repo.name,
      base,
      workflow,
      error: null,
      pushes: pushes.length,
      alerts: decision.alerts,
      sent,
      redJobs: decision.redJobs,
    });
  }

  return { results, state: { version: 1, repos: nextRepos } };
}

/* --- report ------------------------------------------------------------- */

/**
 * The "base CI health" block /factory-report gathers. Reads only the remembered
 * state — no forge calls — so it stays cheap enough for a report that runs it
 * per repo.
 */
export function formatReport(state, { repos = null, now = Date.now() } = {}) {
  const entries = Object.entries(state?.repos ?? {}).filter(
    ([key]) => !repos || repos.includes(key.split("/")[0]),
  );
  const lines = ["base CI health"];
  if (!entries.length) {
    lines.push(
      "  no base branch observed yet — run `factory ci-health --apply`",
    );
    return lines.join("\n");
  }
  for (const [key, entry] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    const jobs = Object.entries(entry?.jobs ?? {});
    if (!jobs.length) {
      lines.push(`  ${key}  green`);
      continue;
    }
    for (const [job, alarm] of jobs) {
      const age =
        alarm?.sinceAtMs == null ? "?" : formatSpan(now - alarm.sinceAtMs);
      lines.push(
        `  ${key}  RED ${job} — ${alarm?.count ?? "?"} consecutive pushes ` +
          `since ${shortSha(alarm?.since)} (${age})`,
      );
    }
  }
  return lines.join("\n");
}

/* --- live dependencies --------------------------------------------------- */

/**
 * The real forge, notifier, clock and state file. Everything above this line
 * is pure; everything below it is the part the tests replace.
 */
export function liveCiHealthDeps({
  forge = loadForge(),
  stateFile = CI_HEALTH_STATE_FILE,
  root = ROOT,
} = {}) {
  return {
    listRuns: (repo, { branch, limit }) =>
      forge.runList(repo.github, {
        branch,
        limit,
        fields: [...CI_HEALTH_RUN_FIELDS],
        retryOnRateLimit: true,
      }),
    listJobs: (repo, run) => {
      const body = forge.apiRaw(
        `repos/${repo.github}/actions/runs/${run.databaseId}/jobs?per_page=100`,
        { retryOnRateLimit: true },
      );
      const parsed = JSON.parse(body);
      return (parsed?.jobs ?? []).map((job) => ({
        name: job?.name,
        conclusion: job?.conclusion ?? null,
      }));
    },
    notify: (message) => {
      if (!Bun.which("factory")) return false;
      const result = Bun.spawnSync({
        cmd: ["factory", "notify", message],
        cwd: root,
        stdout: "ignore",
        stderr: "ignore",
      });
      return result.exitCode === 0;
    },
    readState: () => readCiHealthState(stateFile),
    writeState: (state) => writeCiHealthState(state, stateFile),
  };
}

/** Repos this loop can read: a github remote and a base branch. */
export function selectRepos(config, only = []) {
  return (config?.repos ?? []).filter(
    (repo) => repo?.github && (!only.length || only.includes(repo.name)),
  );
}

async function main(argv = process.argv.slice(2)) {
  const val = (flag) => {
    const i = argv.indexOf(flag);
    return i === -1 ? null : argv[i + 1];
  };
  const only = (val("--repo") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const jsonOut = argv.includes("--json");
  const report = argv.includes("--report");
  // The streak count is bounded by how far back we look, and each extra push
  // costs one jobs call. Three is enough to DETECT an outage; widen it when
  // you want the notification to quote the true length of a long one.
  const window = Math.max(
    2,
    parseInt(val("--window") ?? "", 10) || PUSH_WINDOW,
  );
  // --dry-run is the explicit spelling of the default. Both mean the same
  // thing; neither sends, neither writes.
  const apply = argv.includes("--apply") && !argv.includes("--dry-run");

  const deps = liveCiHealthDeps();

  if (report) {
    const state = deps.readState();
    if (jsonOut) {
      console.log(JSON.stringify(state, null, 2));
      return 0;
    }
    console.log(formatReport(state, { repos: only.length ? only : null }));
    return 0;
  }

  const repos = selectRepos(loadConfigYaml("repos"), only);
  if (!repos.length) {
    console.error(
      only.length
        ? `no repo named "${only.join(", ")}" in config/repos.yaml with a github remote`
        : "no repos with a github remote configured",
    );
    return 2;
  }

  const { results, state } = await runCiHealthTick({
    repos,
    state: deps.readState(),
    listRuns: deps.listRuns,
    listJobs: deps.listJobs,
    notify: deps.notify,
    apply,
    window,
    log: (line) => {
      if (!jsonOut) console.log(`  ${line}`);
    },
  });

  if (apply) deps.writeState(state);

  if (jsonOut) {
    console.log(JSON.stringify({ apply, results }, null, 2));
    return 0;
  }

  const c = {
    dim: (s) => `\x1b[2m${s}\x1b[0m`,
    bold: (s) => `\x1b[1m${s}\x1b[0m`,
    red: (s) => `\x1b[31m${s}\x1b[0m`,
    green: (s) => `\x1b[32m${s}\x1b[0m`,
    yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  };

  console.log(
    c.bold(
      `\nbase CI health — ${results.length} repo(s) — ${apply ? c.yellow("APPLY") : c.green("DRY RUN")}\n`,
    ),
  );
  for (const result of results) {
    const head = `${result.repo}/${result.base}`;
    if (result.error) {
      console.log(`  ${head.padEnd(28)} ${c.yellow(result.error)}`);
      continue;
    }
    if (result.note) {
      console.log(`  ${head.padEnd(28)} ${c.dim(result.note)}`);
      continue;
    }
    if (!result.redJobs.length) {
      console.log(
        `  ${head.padEnd(28)} ${c.green("green")} ${c.dim(`(${result.pushes} push(es) of ${result.workflow})`)}`,
      );
      continue;
    }
    for (const streak of result.redJobs) {
      console.log(
        `  ${head.padEnd(28)} ${c.red(`RED ${streak.job}`)} ${c.dim(`× ${streak.count} pushes since ${shortSha(streak.firstSha)}`)}`,
      );
    }
  }

  const alerts = results.flatMap((r) => r.alerts ?? []);
  console.log(
    alerts.length
      ? c.bold(
          `\n${alerts.length} alert(s) ${apply ? "sent" : "would be sent — re-run with --apply"}\n`,
        )
      : c.dim("\nnothing to say — no new red streak and no recovery\n"),
  );
  return 0;
}

if (import.meta.main) process.exitCode = await main();
