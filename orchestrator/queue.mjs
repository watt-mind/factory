#!/usr/bin/env bun
/**
 * Where is the loop right now?
 *
 *   bun orchestrator/queue.mjs              # every configured repo
 *   bun orchestrator/queue.mjs --repo bj29
 *
 * Read-only. This is the `dry_command` for all three agent stages, so "what
 * would this job do" never means "spawn an agent and find out" — it means look
 * at the queue the job would draw from.
 *
 * It also answers the question that actually governs throughput: is the factory
 * about to idle? A deep Triage pile with an empty agent-ready queue means the
 * constraint is specification, not execution, and dispatching harder won't help.
 */
import {
  fetchQueueSummaries,
  loadQueueConfig,
  STAGE_GATES,
} from "../lib/queue-summary.mjs";
import { budgetExhausted } from "../lib/spend.mjs";

const argv = process.argv.slice(2);
const val = (f) => {
  const i = argv.indexOf(f);
  return i === -1 ? null : argv[i + 1];
};
const only = (val("--repo") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const GATE = val("--gate");
const JSON_OUT = argv.includes("--json");

const { repos, policy, defaultCap } = loadQueueConfig(only);
if (!repos.length) {
  console.error(
    only
      ? `no repo named "${only}" in config/repos.yaml`
      : "no repos configured",
  );
  process.exit(2);
}

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

const summary = await fetchQueueSummaries(repos, defaultCap);

for (const repo of repos) {
  const s = summary.find((x) => x.repo === repo.name);
  if (!s) continue;

  if (!GATE && !JSON_OUT)
    console.log(
      c.bold(`\n${repo.name}`) +
        c.dim(`  ${repo.team} / ${repo.project}  ->  ${repo.base}`),
    );

  const quiet = GATE || JSON_OUT;
  const line = (label, n, color = (x) => x) => {
    if (!quiet)
      console.log(`  ${label.padEnd(22)} ${color(String(n).padStart(3))}`);
  };

  line(
    "Triage (unspecified)",
    s.triageState,
    s.triageState > 20 ? c.yellow : (x) => x,
  );
  if (s.triageHeld) line("Triage, held for you", s.triageHeld, c.red);
  if (s.answered) line("Held, reply received", s.answered, c.green);
  line("Todo, not ready", s.todoNotReady);
  line("READY to dispatch", s.ready, s.ready ? c.green : c.red);
  if (s.readyStale) line("READY, stale pin", s.readyStale, c.yellow);
  if (s.readyUnreadable)
    line("READY, pin unreadable", s.readyUnreadable, c.yellow);
  if (s.readyMissingPin) line("READY, no pin", s.readyMissingPin, c.yellow);
  if (s.readyHeld) line("READY, held by blocker", s.readyHeld, c.yellow);
  line("In Progress", s.inProgress);
  line("In Review", s.inReview, s.inReview ? c.cyan : (x) => x);
  line("Blocked", s.blocked, s.blocked ? c.red : (x) => x);
  line(
    "Done / project total",
    `${s.done}/${s.total}${s.countCapped ? "+" : ""}`,
    c.dim,
  );

  if (quiet) continue;

  const answeredIds = new Set(
    (s.answeredTickets ?? []).map((t) => t.identifier),
  );
  const workerIds = new Set(s.liveWorkerIds ?? []);

  if (s.startable.length) {
    console.log(
      c.dim(
        `\n  dispatch would start (cap ${repo.max_in_flight ?? defaultCap}, ${s.inProgress} running, ${s.slotsFree} slot(s) free):`,
      ),
    );
    for (const t of s.startableTickets)
      console.log(
        `    ${c.green(t.identifier.padEnd(10))} ${t.title.slice(0, 60)}`,
      );
  } else if (repo.report_only && s.ready) {
    console.log(
      c.dim(
        `\n  report_only — dispatch is disabled here by design (${s.ready} ready ticket(s) would otherwise start)`,
      ),
    );
  } else if (s.ready && s.slotsFree === 0) {
    console.log(
      c.dim(
        `\n  no free worker slot — ${s.workers}/${repo.max_in_flight ?? defaultCap} live, ${s.ready} ready and waiting`,
      ),
    );
    for (const t of s.inProgressTickets.filter((i) =>
      workerIds.has(i.identifier),
    )) {
      console.log(
        c.dim(
          `    working: ${t.identifier.padEnd(10)} ${t.title.slice(0, 55)}`,
        ),
      );
    }
  } else if (s.ready) {
    console.log(
      c.dim(
        `\n  nothing startable — all ready tickets collide with running or with each other's unparseable Owned Paths`,
      ),
    );
  } else if (s.readyStale || s.readyUnreadable || s.readyMissingPin) {
    // Only name the counts that are non-zero; "0 pin feed(s) could not be
    // read" is noise that hides the one line that matters.
    const reasons = [
      s.readyStale && `${s.readyStale} ready ticket(s) have stale pins`,
      s.readyMissingPin && `${s.readyMissingPin} ready ticket(s) have no pin`,
      s.readyUnreadable && `${s.readyUnreadable} pin feed(s) could not be read`,
    ].filter(Boolean);
    console.log(c.dim(`\n  nothing startable — ${reasons.join(", ")}`));
  } else if (s.readyHeld) {
    // Not "queue empty": there IS specified work, it is waiting on its
    // blockers, and if those never finish this line is the only symptom.
    console.log(
      c.dim(
        `\n  nothing startable — every ready ticket is waiting on a blocker (see below)`,
      ),
    );
  } else {
    console.log(
      c.dim(`\n  queue empty — the constraint is specification, not dispatch.`),
    );
    console.log(
      c.dim(`  ${s.triageState} ticket(s) in Triage. Run the triage stage.`),
    );
  }

  if (s.readyHeld) {
    console.log(
      c.dim(`\n  ready but held — waiting on another ticket, not on capacity:`),
    );
    for (const t of s.readyHeldTickets)
      console.log(
        `    ${c.yellow(t.identifier.padEnd(10))} blocked by ${t.blockedBy.join(", ")}  ${c.dim(t.title.slice(0, 45))}`,
      );
  }
  if (s.readyStale) {
    console.log(
      c.yellow(
        `\n  ready pin stale — re-promote after reviewing the body change:`,
      ),
    );
    for (const t of s.readyStaleTickets)
      console.log(`    ${t.identifier.padEnd(10)} ${t.title.slice(0, 60)}`);
  }
  if (s.readyMissingPin) {
    console.log(
      c.yellow(
        `\n  ${s.readyMissingPin} ready ticket(s) have no ready-pin — re-promote (remove/add ai:agent-ready) to stamp one:`,
      ),
    );
    for (const t of s.readyMissingPinTickets)
      console.log(`    ${t.identifier.padEnd(10)} ${t.title.slice(0, 60)}`);
  }
  if (s.inReview) {
    console.log(c.dim(`\n  awaiting review/merge:`));
    for (const t of s.inReviewTickets)
      console.log(
        `    ${c.cyan(t.identifier.padEnd(10))} ${t.title.slice(0, 60)}`,
      );
  }
  if (s.openPRs) {
    console.log(
      c.dim(`\n  open PRs the merge stage would look at: ${s.openPRs}`),
    );
  }
  if (s.blocked) {
    console.log(c.red(`\n  BLOCKED — needs a human:`));
    for (const t of s.blockedTickets) {
      const tag = answeredIds.has(t.identifier)
        ? c.green("  <- reply received, triage will re-examine")
        : "";
      console.log(
        `    ${t.identifier.padEnd(10)} ${t.title.slice(0, 60)}${tag}`,
      );
    }
  }
}

if (JSON_OUT) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

if (GATE) {
  const spent = budgetExhausted(policy);
  if (spent) {
    console.log(
      `${spent} — no ${GATE} this tick. Running work finishes; nothing new starts.`,
    );
    process.exit(1);
  }

  const has = STAGE_GATES[GATE];
  if (!has) {
    console.error(`unknown gate "${GATE}" (known: triage, dispatch, merge)`);
    process.exit(2);
  }

  const hits = summary.filter(has);
  if (hits.length) {
    console.log(
      hits.map((s) => `${s.repo}: ${GATE} work available`).join("; "),
    );
    process.exit(0);
  }
  console.log(`no ${GATE} work in ${summary.map((s) => s.repo).join(", ")}`);
  process.exit(1);
}

console.log();
