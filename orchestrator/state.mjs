#!/usr/bin/env bun
/**
 * Factory session journal — what ran in interactive harnesses, and what's next.
 *
 *   bun orchestrator/state.mjs --repo bj29
 *   bun orchestrator/state.mjs --repo bj29 --json
 *   bun orchestrator/state.mjs record --type start --repo bj29 --command factory-triage --args "5"
 *
 * Events append to ~/.factory/state/events.jsonl. Live "next" always comes from
 * next.mjs / queue.mjs — never stored as truth.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  activeSession,
  appendEvent,
  eventLabel,
  formatClock,
  formatDuration,
  readEvents,
  sessionsFromEvents,
  SESSION_IDLE_MS,
} from "../lib/factory-state.mjs";
import { loadQueueConfig, fetchQueueSummaries } from "../lib/queue-summary.mjs";
import { recommendNext } from "../lib/next-recommend.mjs";
import { parseDuration } from "../lib/transcript.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SINCE_HELP =
  "expected a non-negative millisecond number or duration such as 30m, 36h, or 7d";

/** Parse --since while preserving state.mjs's legacy unitless-milliseconds form. */
export function parseSinceDuration(value) {
  const text = String(value ?? "").trim();
  const unit = text.at(-1)?.toLowerCase();
  if ("smhdw".includes(unit)) {
    try {
      return parseDuration(text);
    } catch {
      throw new TypeError(SINCE_HELP);
    }
  }

  const milliseconds = Number(text);
  if (
    !text ||
    !Number.isFinite(milliseconds) ||
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 0
  ) {
    throw new TypeError(SINCE_HELP);
  }
  return milliseconds;
}

/** Return the event-window timestamp used by --since. */
export function parseSinceMs(value, now = Date.now()) {
  const duration = value == null ? 7 * 86_400_000 : parseSinceDuration(value);
  const sinceMs = now - duration;
  if (!Number.isFinite(sinceMs)) throw new RangeError(SINCE_HELP);
  return sinceMs;
}

export async function main(argv = process.argv.slice(2)) {
  const val = (f) => {
    const i = argv.indexOf(f);
    return i === -1 ? null : argv[i + 1];
  };
  const has = (f) => argv.includes(f);

  if (has("record")) {
    const type = val("--type");
    if (!type) {
      console.error(
        "record requires --type (start|complete|recommend|friction|session-start|session-end)",
      );
      process.exit(2);
    }
    const repo = val("--repo");
    if (!repo && type !== "session-end") {
      console.error("record requires --repo");
      process.exit(2);
    }
    const issues = (val("--issues") || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const row = appendEvent({
      type,
      repo,
      harness: val("--harness") || process.env.FACTORY_HARNESS || undefined,
      session: val("--session") || process.env.FACTORY_SESSION_ID || undefined,
      command: val("--command") || undefined,
      args: val("--args") || undefined,
      exec: val("--exec") || undefined,
      slash: val("--slash") || undefined,
      reason: val("--reason") || undefined,
      constraint: val("--constraint") || undefined,
      summary: val("--summary") || undefined,
      runId: val("--run-id") || process.env.FACTORY_RUN_ID || undefined,
      ok: val("--ok") === "1" ? true : val("--ok") === "0" ? false : undefined,
      issues: issues.length ? issues : undefined,
    });
    if (has("--json")) console.log(JSON.stringify(row, null, 2));
    return 0;
  }

  const only = (val("--repo") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const JSON_OUT = has("--json");
  const sinceArg = val("--since");
  let sinceMs;
  try {
    sinceMs = parseSinceMs(sinceArg);
  } catch {
    console.error(`invalid --since ${JSON.stringify(sinceArg)}: ${SINCE_HELP}`);
    return 2;
  }
  const NO_LIVE = has("--no-live");

  const { repos, defaultCap } = loadQueueConfig(only.length ? only : []);
  const repoName = only[0] ?? repos[0]?.name;
  if (!repoName) {
    console.error("no repo — pass --repo or run from a configured checkout");
    return 2;
  }

  const events = readEvents({ repo: repoName, since: sinceMs });
  const session = activeSession({ repo: repoName });
  const recentSessions = sessionsFromEvents(events).slice(-5);

  let liveNext = null;
  if (!NO_LIVE) {
    const targetRepos = repos.filter((r) => r.name === repoName);
    if (targetRepos.length) {
      const summaries = await fetchQueueSummaries(targetRepos, defaultCap);
      const s = summaries[0];
      if (s) {
        const plan = recommendNext(s);
        const slash = plan.command
          ? `/factory-${String(plan.command).replace(/^factory-/, "")}${plan.args ? ` ${plan.args}` : ""}`
          : (plan.exec ?? "(wait)");
        liveNext = {
          slash,
          reason: plan.reason,
          constraint: plan.constraint,
          stage: plan.stage,
        };
      }
    }
  }

  const output = {
    repo: repoName,
    session: session
      ? {
          id: session.id,
          harness: session.harness,
          ageMs: Date.now() - session.startedAt,
          events: session.events.length,
        }
      : null,
    timeline: (session?.events ?? events.slice(-20)).map((e) => ({
      ts: e.ts,
      type: e.type,
      label: eventLabel(e),
      command: e.command,
      summary: e.summary,
    })),
    recentSessions: recentSessions.map((s) => ({
      id: s.id,
      harness: s.harness,
      stages: s.events.filter(
        (e) => e.type === "start" || e.type === "complete",
      ).length,
      lastAt: s.lastAt,
    })),
    liveNext,
  };

  if (JSON_OUT) {
    console.log(JSON.stringify(output, null, 2));
    return 0;
  }

  const c = {
    dim: (s) => `\x1b[2m${s}\x1b[0m`,
    bold: (s) => `\x1b[1m${s}\x1b[0m`,
    green: (s) => `\x1b[32m${s}\x1b[0m`,
    yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  };

  console.log(c.bold(`\nfactory state — ${repoName}\n`));

  if (session) {
    const age = formatDuration(Date.now() - session.startedAt);
    console.log(
      `Session  ${session.id}  ${c.green("active")}, ${age}, harness: ${session.harness}`,
    );
    for (const e of session.events.slice(-12)) {
      console.log(`  ${formatClock(e.ts)}  ${eventLabel(e)}`);
      if (e.reason && e.type === "recommend")
        console.log(c.dim(`           ${e.reason}`));
      if (e.summary && e.type === "complete")
        console.log(c.dim(`           ${e.summary}`));
    }
  } else {
    console.log(c.dim("No active session (idle > 4h or none recorded)."));
    const last = events.at(-5);
    if (last) {
      console.log(c.dim("\nRecent events:"));
      for (const e of events.slice(-8)) {
        console.log(`  ${formatClock(e.ts)}  ${eventLabel(e)}`);
      }
    }
  }

  if (liveNext) {
    console.log(c.bold("\nNext now:"));
    console.log(`  ${c.green(liveNext.slash)}`);
    console.log(c.dim(`  ${liveNext.reason}`));
    if (liveNext.constraint)
      console.log(c.dim(`  constraint: ${liveNext.constraint}`));
  } else if (!NO_LIVE) {
    console.log(c.dim("\nNext: (could not compute — check queue/network)"));
  }

  const stageCount = events.filter((e) => e.type === "complete").length;
  console.log(
    c.dim(
      `\nSince ${Math.round((Date.now() - sinceMs) / 86_400_000)}d: ${recentSessions.length} session(s), ${stageCount} completed stage(s)`,
    ),
  );
  console.log(
    c.dim(
      `Record: bun orchestrator/state.mjs record --type complete --repo ${repoName} --command ... --summary "..."\n`,
    ),
  );
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main();
}
