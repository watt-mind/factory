#!/usr/bin/env bun
/**
 * Dispatch: one OS process per ticket, rolling.
 *
 *   bun orchestrator/tick.mjs --repo bj29                 # dry — what it would start
 *   bun orchestrator/tick.mjs --repo bj29 --apply
 *   bun orchestrator/tick.mjs --repo bj29 --apply --max 2
 *   bun orchestrator/tick.mjs --repo bj29 --apply --ticket CLNT-611
 *   bun orchestrator/tick.mjs --repo bj29 --apply --no-refill   # start a batch, don't refill
 *
 * Each ticket gets its own process, log file, budget and session id, so a stuck
 * ticket can be killed alone and a failed one resumed alone.
 *
 * ROLLING, NOT BATCHED. When a ticket finishes, its slot is refilled
 * immediately from the queue — the run does not wait for the slowest ticket
 * before starting anything else. Batching is the dominant throughput loss in
 * practice: one 40-minute ticket idles two agents for 40 minutes.
 *
 * The queue is re-read on every refill, so tickets that became agent-ready
 * *during* the run (triage promoting one, or an agent filing follow-up work)
 * get picked up without waiting for the next supervisor tick.
 */
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync, createWriteStream } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { gql } from "./reaper.mjs";
import { ROOT } from "../lib/schedule.mjs";
import { parseOwnedPaths, effectiveOwnedPaths, pathsCollide } from "./owned-paths.mjs";
import { openBlockers, BLOCKING_RELATIONS_GQL } from "./blockers.mjs";
import { budgetExhausted } from "../lib/spend.mjs";
import { agentLabel } from "../tools/linear.mjs";
import { LEASE_HEARTBEAT_MS, releaseWorkerLease, renewWorkerLease, writeWorkerLease, liveWorkerLeases } from "../lib/worker-leases.mjs";
import { emitFactoryEvent } from "../lib/emit-event.mjs";

export const DISPATCH_FAILURE_THRESHOLD = 3;

export function isDispatchFailureComment(body) {
  if (!body || typeof body !== "string") return false;
  return /Dispatch (run )?failed/i.test(body.trim());
}

export function countPriorDispatchFailures(comments = []) {
  if (!Array.isArray(comments) || comments.length === 0) return 0;
  const sorted = [...comments].sort((a, b) => {
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return ta - tb;
  });
  let count = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const c = sorted[i];
    if (isDispatchFailureComment(c?.body)) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

export function isRepeatedDispatchFailure(comments = [], threshold = DISPATCH_FAILURE_THRESHOLD) {
  return (countPriorDispatchFailures(comments) + 1) >= threshold;
}

export function computeUnclaimAction({
  issue,
  why,
  log,
  todoStateId,
  blockedStateId,
  allLabels = [],
  threshold = DISPATCH_FAILURE_THRESHOLD,
  homedirStr = homedir(),
}) {
  const labelId = (n) => allLabels.find((l) => l.name === n)?.id;
  const keep = (issue.labels?.nodes ?? [])
    .filter((l) => l.name !== "ai:in-progress" && !l.name.startsWith("agent:") && l.name !== "ai:agent-ready" && l.name !== "ai:blocked")
    .map((l) => l.id);

  const priorFailures = countPriorDispatchFailures(issue.comments?.nodes ?? []);
  const totalFailures = priorFailures + 1;
  const isRepeated = totalFailures >= threshold;

  if (isRepeated) {
    const blockedLabelId = labelId("ai:blocked");
    const wantLabels = [...new Set([...keep, blockedLabelId].filter(Boolean))];
    const targetStateId = blockedStateId ?? todoStateId;
    const body = `Dispatch run failed repeatedly (${totalFailures} consecutive dispatch failures), moved to Blocked.\n\n**Why:** ${why}${log ? `\n**Log:** \`${log.replace(homedirStr, "~")}\`` : ""}\n\nDemoted with \`ai:blocked\` to prevent infinite re-dispatch loops. Please investigate the cause before re-queuing.`;
    return {
      repeated: true,
      totalFailures,
      stateId: targetStateId,
      assigneeId: null,
      labelIds: wantLabels,
      commentBody: body,
    };
  }

  const readyLabelId = labelId("ai:agent-ready");
  const wantLabels = [...new Set([...keep, readyLabelId].filter(Boolean))];
  const body = `Dispatch run failed, claim released back to Todo.\n\n**Why:** ${why}${log ? `\n**Log:** \`${log.replace(homedirStr, "~")}\`` : ""}`;
  return {
    repeated: false,
    totalFailures,
    stateId: todoStateId,
    assigneeId: null,
    labelIds: wantLabels,
    commentBody: body,
  };
}

export function preserveWip(wt, ticketIdentifier) {
  if (!wt || !existsSync(wt)) return { preserved: false, reason: "no_worktree" };
  try {
    const status = spawnSync("git", ["status", "--porcelain"], { cwd: wt, encoding: "utf8" });
    if (status.status !== 0) return { preserved: false, reason: "git_error", error: status.stderr };
    const dirty = (status.stdout || "").trim();
    if (!dirty) return { preserved: false, reason: "clean" };

    const add = spawnSync("git", ["add", "-A"], { cwd: wt, encoding: "utf8" });
    if (add.status !== 0) {
      const diff = spawnSync("git", ["diff", "HEAD"], { cwd: wt, encoding: "utf8" });
      if (diff.stdout) {
        const patchPath = path.join(tmpdir(), `${ticketIdentifier}-wip.patch`);
        writeFileSync(patchPath, diff.stdout);
        return { preserved: true, method: "patch", patchPath };
      }
      return { preserved: false, reason: "git_add_failed", error: add.stderr };
    }

    const commitMsg = `wip: ${ticketIdentifier} uncommitted progress`;
    const commit = spawnSync("git", ["commit", "-m", commitMsg], { cwd: wt, encoding: "utf8" });
    if (commit.status === 0) {
      const rev = spawnSync("git", ["rev-parse", "HEAD"], { cwd: wt, encoding: "utf8" });
      const hash = (rev.stdout || "").trim();
      return { preserved: true, method: "commit", hash, message: commitMsg };
    }

    const diff = spawnSync("git", ["diff", "--cached"], { cwd: wt, encoding: "utf8" });
    if (diff.stdout) {
      const patchPath = path.join(tmpdir(), `${ticketIdentifier}-wip.patch`);
      writeFileSync(patchPath, diff.stdout);
      return { preserved: true, method: "patch", patchPath };
    }

    return { preserved: false, reason: "commit_failed", error: commit.stderr };
  } catch (err) {
    return { preserved: false, reason: "exception", error: err.message };
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Atomically acquire a dispatch claim lock, replacing corrupt or stale locks.
 *
 * Dependencies are injectable so tests can verify that invalid PIDs are never
 * passed to process.kill().
 */
export function acquireClaimLock(
  lock,
  {
    currentPid = process.pid,
    now = Date.now,
    isProcessAlive = processIsAlive,
    onStale = () => {},
  } = {},
) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lock, `${currentPid} ${now()}\n`, { flag: "wx" });
      return true;
    } catch {
      let raw;
      try {
        raw = readFileSync(lock, "utf8");
      } catch {
        // The file may have disappeared between the exclusive create and read.
        // Retry once rather than treating that race as a held lock.
        continue;
      }

      const fields = raw.trim().split(/\s+/);
      const pid = Number(fields[0]);
      const at = Number(fields[1]);
      const valid = fields.length === 2
        && Number.isInteger(pid)
        && pid > 0
        && Number.isFinite(at);
      const alive = valid && isProcessAlive(pid);
      if (alive && now() - at < 120_000) return false;

      onStale(valid ? pid : null);
      try { unlinkSync(lock); } catch {}
    }
  }
  return false;
}

export async function main(argv = process.argv.slice(2)) {
const val = (f) => { const i = argv.indexOf(f); return i === -1 ? null : argv[i + 1]; };
const APPLY = argv.includes("--apply");
const REFILL = !argv.includes("--no-refill");
const MAX = Number(val("--max") ?? 0) || Infinity;
const ONE = val("--ticket");

const expand = (p) => String(p ?? "").replace(/^~/, homedir());
const cfg = Bun.YAML.parse(readFileSync(path.join(ROOT, "config/repos.yaml"), "utf8"));
const policy = Bun.YAML.parse(readFileSync(path.join(ROOT, "config/policy.yaml"), "utf8"));
const repo = (cfg.repos ?? []).find((r) => r.name === val("--repo"));
if (!repo) { console.error(`--repo required; known: ${(cfg.repos ?? []).map((r) => r.name).join(", ")}`); process.exit(2); }
if (repo.report_only) { console.error(`${repo.name} is report_only — no worktree tooling, dispatch is unsafe here`); process.exit(2); }

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`, cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};
const clock = () => new Date().toTimeString().slice(0, 8);
const repoPath = expand(repo.path);
const cap = repo.max_in_flight ?? policy?.concurrency?.max_in_flight_per_repo ?? 3;

// Same probe as run-agent.sh: the wall-clock cap is a safety feature, and a
// safety feature that crashes every spawn on a machine without coreutils is
// worse than saying plainly that the cap is off.
// Which agent CLI runs the tickets. Claude by default; `agy` (Antigravity)
// draws on a different provider's quota entirely, which is the point — a
// second supervisor on a second harness adds capacity without spending more
// of the same weekly allowance.
const HARNESS = val("--harness") ?? "claude";
if (!Bun.which(HARNESS)) { console.error(`harness "${HARNESS}" is not on PATH`); process.exit(2); }
// linear.md's agent:* taxonomy names the harness that actually holds the
// claim (agent:claude-code, agent:gemini, ...) — it must track HARNESS, not
// assume claude, or a ticket run on agy gets labelled as if Claude did it.
const AGENT_LABEL = agentLabel(HARNESS);

const TIMEOUT_BIN = Bun.which("timeout") ?? Bun.which("gtimeout");
if (!TIMEOUT_BIN) console.log(c.yellow("  ! no timeout(1)/gtimeout on PATH — a wedged run will not be wall-clock capped"));

// The ticket prompt, inlined rather than invoked as `/factory-ticket <ID>`.
//
// A slash command only resolves from the directory the session runs in, and
// that directory is a fresh WORKTREE. `.claude/commands/` holds symlinks into
// this repo, but a worktree carries only what the branch has committed — so a
// command added here after the last commit to the product repo does not exist
// where it is needed, and `claude -p` answers "Unknown command", reports
// subtype `success`, and exits having done nothing. Every ticket in the batch
// then burns a claim in under a second.
//
// The body is plain harness-neutral markdown, which is why run-agent.sh
// already passes it this way for the non-Claude harnesses. Doing the same here
// deletes the failure class instead of documenting it.
const COMMAND_MD = readFileSync(path.join(ROOT, "shared/commands/factory-ticket.md"), "utf8");
const COMMAND_MODEL = /^model:\s*(\S+)/m.exec(/^---\n([\s\S]*?)\n---\n/.exec(COMMAND_MD)?.[1] ?? "")?.[1] ?? null;
const COMMAND_BODY = COMMAND_MD.replace(/^---\n[\s\S]*?\n---\n/, "");
const promptFor = (id) => COMMAND_BODY.replaceAll("$ARGUMENTS", id);

const Q = `query($t:String!,$p:String!){ issues(first:250, filter:{
    team:{key:{eq:$t}}, project:{name:{eq:$p}},
    state:{ type:{ nin:["completed","canceled"] } } }){
  nodes{ id identifier title description state{name} assignee{id} labels(first:20){nodes{name}} priority ${BLOCKING_RELATIONS_GQL} } } }`;

/** Current queue straight from Linear — never cached, because it changes under us. */
async function fetchState() {
  const nodes = (await gql(Q, { t: repo.team, p: repo.project }))?.issues?.nodes ?? [];
  const has = (i, n) => (i.labels?.nodes ?? []).some((l) => l.name === n);
  return {
    inProgress: nodes.filter((i) => i.state?.name === "In Progress"),
    // Assignee is NOT a gate: this workspace hasn't landed per-agent Linear
    // identities (OPS-40) yet, so every claim -- human or agent -- writes the
    // same shared account. That makes "has an assignee" indistinguishable
    // from "was claimed and never cleared," which is exactly the reaper's
    // job to fix, not dispatch's job to avoid by skipping the ticket forever.
    // The actual collision guard is claim()'s read-back compare-and-swap
    // below, which is assignee-based but per-ticket at claim time, not a
    // blanket "already has anyone" skip.
    ready: nodes
      .filter((i) => i.state?.name === "Todo" && has(i, "ai:agent-ready"))
      .sort((a, b) => (a.priority || 99) - (b.priority || 99)),
  };
}

/**
 * What can start right now, given what is running right now.
 * Owned Paths overlap is checked at THIS moment, not from a plan computed
 * earlier — under rolling dispatch the in-flight set changes continuously.
 *
 * Two orthogonal gates: `blocked by` relations answer "can this run AT ALL
 * yet", Owned Paths answers "can it run alongside what's in flight". Both are
 * read fresh with the queue on every fill, so a blocker merged mid-run
 * releases its dependents on the next refill, no sweep needed.
 */
function selectable(state, excludeIds, limit) {
  const busy = state.inProgress.flatMap((i) => effectiveOwnedPaths(i.description ?? ""));
  const out = [];
  for (const t of state.ready) {
    if (out.length >= limit) break;
    if (excludeIds.has(t.identifier)) continue;
    if (ONE && t.identifier !== ONE) continue;
    if (openBlockers(t).length) continue;
    const own = effectiveOwnedPaths(t.description ?? "");
    if (pathsCollide(own, busy)) continue;
    out.push({ ...t, own });
    busy.push(...own);
  }
  return out;
}

// ------------------------------------------------------------------- dry ----
const first = await fetchState();
const firstWorkers = liveWorkerLeases(repo.name);
const freeNow = Math.max(0, cap - firstWorkers.length);
console.log(c.bold(`\n${repo.name}`) + c.dim(`  cap ${cap} · ${firstWorkers.length} live worker(s) · ${first.inProgress.length} claim(s) · ${freeNow} slot(s) · ${first.ready.length} ready`));

if (!APPLY) {
  const picked = selectable(first, new Set(), Math.min(freeNow, MAX));
  for (const t of first.ready) {
    const blockers = openBlockers(t);
    if (blockers.length) console.log(c.yellow(`  skip ${t.identifier} — blocked by ${blockers.join(", ")}`));
    else if (!parseOwnedPaths(t.description ?? "").length) console.log(c.yellow(`  ${t.identifier} — no parseable Owned Paths, treated as owning everything (dispatchable, but runs alone)`));
  }
  if (!picked.length) { console.log(c.dim("  nothing to start.\n")); process.exit(0); }
  console.log(c.bold(`\nwould start ${picked.length} now${REFILL ? ", then refill slots as they free" : ""}:`));
  for (const t of picked) console.log(`  ${c.green(t.identifier)}  ${t.title.slice(0, 60)}\n    ${c.dim(t.own.join(", "))}`);
  console.log(c.dim("\ndry run — re-run with --apply\n"));
  process.exit(0);
}

// ----------------------------------------------------------------- claim ----
const me = (await gql(`query{ viewer{ id name } }`))?.viewer;
const states = (await gql(`query($t:String!){ team(id:$t){ states(first:50){ nodes{ id name } } } }`, { t: repo.team }))?.team?.states?.nodes ?? [];
const inProgressId = states.find((s) => s.name.toLowerCase() === "in progress")?.id;
const todoId = states.find((s) => s.name.toLowerCase() === "todo")?.id;
const blockedId = states.find((s) => s.name.toLowerCase() === "blocked")?.id;
const allLabels = (await gql(`query{ issueLabels(first:250){ nodes{ id name } } }`))?.issueLabels?.nodes ?? [];
const labelId = (n) => allLabels.find((l) => l.name === n)?.id;
if (!inProgressId) { console.error("no 'In Progress' state on team " + repo.team); process.exit(1); }

async function claim(t) {
  // Drop ai:agent-ready on claim. It means "waiting to be picked up", so
  // keeping it alongside ai:in-progress leaves the ticket asserting two
  // lifecycle states at once — and it survives all the way to Done, where
  // CLNT-675 sat carrying both ai:needs-review and ai:agent-ready. One flag,
  // one value; the same rule the triage hold now follows.
  const keep = (t.labels?.nodes ?? [])
    .filter((l) => l.name !== "ai:agent-ready")
    .map((l) => allLabels.find((x) => x.name === l.name)?.id).filter(Boolean);
  const want = [...new Set([...keep, labelId("ai:in-progress"), labelId(AGENT_LABEL)].filter(Boolean))];
  await gql(`mutation($id:String!,$in:IssueUpdateInput!){ issueUpdate(id:$id,input:$in){ success } }`,
    { id: t.id, in: { stateId: inProgressId, assigneeId: me.id, labelIds: want } });
  // Linear has no compare-and-swap; this read-back IS the concurrency control.
  const back = (await gql(`query($id:String!){ issue(id:$id){ assignee{id} } }`, { id: t.id }))?.issue;
  return back?.assignee?.id === me.id;
}

/**
 * A failed run must not keep its claim. With the reaper off a timer, a ticket
 * left In Progress after its process died consumes a cap slot until a human
 * notices — three failures and dispatch throughput is silently zero.
 *
 * Only rolls back tickets that still look like OUR claim (In Progress, assigned
 * to us, ai:in-progress present). An agent that legitimately moved its ticket —
 * to Blocked with a question, or to In Review with a PR — keeps that state.
 */
async function unclaim(t, why, log) {
  const cur = (await gql(
    `query($id:String!){ issue(id:$id){ state{name} assignee{id} labels(first:20){nodes{id name}} comments(last:10){nodes{body createdAt}} } }`,
    { id: t.id }))?.issue;
  if (!cur || cur.state?.name !== "In Progress" || cur.assignee?.id !== me.id) return false;
  if (!(cur.labels?.nodes ?? []).some((l) => l.name === "ai:in-progress")) return false;

  const action = computeUnclaimAction({
    issue: cur,
    why,
    log,
    todoStateId: todoId,
    blockedStateId: blockedId,
    allLabels,
    threshold: DISPATCH_FAILURE_THRESHOLD,
  });

  await gql(`mutation($id:String!,$in:IssueUpdateInput!){ issueUpdate(id:$id,input:$in){ success } }`,
    { id: t.id, in: { stateId: action.stateId ?? undefined, assigneeId: null, labelIds: action.labelIds } });
  await gql(`mutation($in:CommentCreateInput!){ commentCreate(input:$in){ success } }`,
    { in: { issueId: t.id, body: action.commentBody } });

  if (action.repeated) {
    console.log(`${c.dim(clock())} ${c.cyan(t.identifier)} ${c.red("blocked (repeated dispatch failures)")} ${c.dim(`— ${why}`)}`);
  } else {
    console.log(`${c.dim(clock())} ${c.cyan(t.identifier)} ${c.yellow("un-claimed")} ${c.dim(`— ${why}`)}`);
  }
  return true;
}

// ------------------------------------------------------------------ warm ----
let warmChecked = false;
/**
 * Warming costs one compile; skipping it costs N. So it only pays from two
 * tickets up, and only once per run — after claiming (minutes here cannot lose
 * a claimed ticket) and before any worktree-up (nothing should clone a template
 * being rewritten underneath it).
 */
function warmIfWorthIt(count) {
  if (warmChecked || argv.includes("--no-warm") || !repo.worktree_warm) return;
  warmChecked = true;
  if (count < 2) { console.log(c.dim(`  (single ticket — not warming; same compile either way)`)); return; }

  const gate = spawnSync("/bin/bash", ["-lc", `bun orchestrator/warm.mjs --repo ${repo.name} --gate`], { cwd: ROOT, encoding: "utf8" });
  if (gate.status !== 0) { console.log(c.dim(`  warm cache fresh — ${gate.stdout.trim()}`)); return; }
  console.log(c.yellow(`\n  ${gate.stdout.trim()}`));
  console.log(c.dim(`  Compiling once so ${count} worktrees don't.\n`));
  const r = spawnSync("/bin/bash", ["-lc", `bun orchestrator/warm.mjs --repo ${repo.name} --apply`], { cwd: ROOT, stdio: "inherit" });
  console.log(r.status === 0 ? c.green(`\n  warm cache refreshed.\n`) : c.yellow(`\n  warm refresh failed — continuing; worktrees will be slower.\n`));
}

// ------------------------------------------------------------------- run ----
const LOG_DIR = path.join(homedir(), ".factory/logs");
mkdirSync(LOG_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
const leaseOwner = `${process.pid}-${stamp}`;
const results = [];

// CIRCUIT BREAKER (policy.circuit_breaker). Environment failures — the
// worktree template refusing to build — are not ticket-specific: left running,
// a broken template converts the whole queue into failed claims in minutes.
const ENV_FAIL_LIMIT = policy?.circuit_breaker?.consecutive_env_failures ?? 2;
let envFailures = 0;
let tripped = false;

// Counts a failure that says nothing about the ticket and everything about the
// machine — a template that won't build, a session that ends before it takes a
// turn. Ticket-specific failures must NOT come through here: one hard ticket
// stopping the queue is a worse outcome than letting it fail alone.
function noteEnvFailure(what) {
  if (++envFailures >= ENV_FAIL_LIMIT && !tripped) {
    tripped = true;
    console.log(c.red(`\n  CIRCUIT BREAKER: ${envFailures} consecutive environment failures (${what}) — no further tickets will be claimed this run. Fix the environment first.\n`));
  }
}

async function runTicket(t) {
  const wt = path.join(expand(repo.worktree_root), t.identifier);
  const up = spawnSync("/bin/bash", [repo.worktree_up, t.identifier], { cwd: repoPath, encoding: "utf8" });
  if (up.status !== 0) {
    const why = (up.stderr || up.stdout || "").trim().split("\n").pop();
    console.log(c.red(`  ${t.identifier} worktree-up failed: ${why}`));
    results.push({ id: t.identifier, ok: false, why: "worktree-up failed" });
    // Must not throw: an unhandled rejection here kills the whole rolling
    // loop via Promise.race in the main dispatch loop below, taking down
    // every OTHER in-flight ticket's tracking with it. Same guard as the
    // other two unclaim() call sites.
    preserveWip(wt, t.identifier);
    await unclaim(t, `worktree-up failed: ${why}`).catch(() => {});
    noteEnvFailure("worktree-up");
    return;
  }
  // NB: a working worktree-up does not clear the streak — only a run that
  // actually took a turn does (below). Clearing it here let four consecutive
  // zero-turn sessions through, because each one built its worktree fine.
  console.log(`${c.dim(clock())} ${c.cyan(t.identifier)} worktree ready ${c.dim(wt)}`);

  const log = path.join(LOG_DIR, `${repo.name}-${t.identifier}-${stamp}.jsonl`);
  const out = createWriteStream(log);
  const budget = String(cfg.budget?.per_ticket_usd ?? policy?.budget?.per_ticket_usd ?? 15);
  // Same hard cap as run-agent.sh: a wedged ticket must not hold its slot
  // forever. TERM at the limit, KILL 30s later.
  const maxMin = policy?.limits?.max_run_minutes ?? 45;

  await new Promise((resolve) => {
    // Spawned without a shell: the prompt is a markdown document full of
    // backticks and quotes, and there is no quoting of it into `bash -lc`
    // that stays correct as the command body is edited.
    // Flags differ per harness; the PROMPT does not. That is the whole reason
    // the command bodies are harness-neutral markdown, and why run-agent.sh
    // can already drive agy. Mirrors run-agent.sh's non-claude invocation.
    let harnessArgs = [];
    if (HARNESS === "claude") {
      harnessArgs = [
        "-p", promptFor(t.identifier),
        "--output-format", "stream-json", "--verbose",
        "--max-budget-usd", budget,
        "--fallback-model", "sonnet",
        // --strict makes this file the ONLY source of MCP servers: no user
        // scope, no project .mcp.json, no claude.ai connectors. What an
        // unattended agent can reach is declared in git and moves by PR.
        // Drops the Linear MCP too — tools/linear.mjs replaces it, reached via
        // the FACTORY_ROOT set below. Mirrors run-agent.sh.
        "--mcp-config", path.join(ROOT, "config/mcp/claude.json"), "--strict-mcp-config",
        ...(COMMAND_MODEL ? ["--model", COMMAND_MODEL] : []),
      ];
    } else if (HARNESS === "codex") {
      const model = COMMAND_MODEL && !["sonnet", "opus", "haiku"].includes(COMMAND_MODEL.toLowerCase()) ? COMMAND_MODEL : null;
      harnessArgs = [
        "exec", "--json",
        "--dangerously-bypass-approvals-and-sandbox",
        "-C", wt,
        ...(model ? ["--model", model] : []),
        promptFor(t.identifier),
      ];
    } else if (HARNESS === "pi") {
      const model = COMMAND_MODEL && !["sonnet", "opus", "haiku"].includes(COMMAND_MODEL.toLowerCase()) ? COMMAND_MODEL : null;
      harnessArgs = [
        "-p",
        "--mode", "json",
        ...(model ? ["--model", model] : []),
        promptFor(t.identifier),
      ];
    } else {
      harnessArgs = [
        "-p", promptFor(t.identifier),
        "--output-format", "stream-json",
        "--dangerously-skip-permissions",
        "--add-dir", wt,
        "--print-timeout", `${Math.max(1, maxMin - 2)}m`,
        // agy receives the command body rather than its frontmatter, so pin
        // its model explicitly. Other compatible harnesses retain their CLI
        // defaults until they gain a dedicated adapter.
        ...(HARNESS === "agy" ? ["--model", "gemini-3.6-flash-medium"] : []),
      ];
    }

    const harnessBin = (HARNESS === "pi" && !Bun.which("pi")) ? "npx" : HARNESS;
    const piPreArgs = (HARNESS === "pi" && !Bun.which("pi")) ? ["pi"] : [];
    const envArgs = [
      "-u", "ANTHROPIC_API_KEY",
      "-u", "GEMINI_API_KEY",
      "-u", "GOOGLE_API_KEY",
      "-u", "GOOGLE_GENAI_API_KEY",
      "-u", "OPENAI_API_KEY",
      "-u", "MISTRAL_API_KEY",
      "-u", "DEEPSEEK_API_KEY",
      "-u", "GROQ_API_KEY",
      "-u", "CLAUDECODE",
      "-u", "CLAUDE_CODE_ENTRYPOINT",
      // Agents run in a worktree, not in this checkout, so `bun
      // tools/linear.mjs` does not resolve for them. The floor tells them to
      // use "$FACTORY_ROOT/tools/linear.mjs"; this is what makes that true.
      // Without it, --strict-mcp-config removes the Linear MCP and leaves no
      // replacement — the control plane goes silent.
      `FACTORY_ROOT=${ROOT}`,
      // Run id == transcript basename, same convention as run-agent.sh: the
      // rollup keys on it, linear.mjs stamps it into comments, the floor puts
      // it in PR bodies. One key joins Linear/GitHub back to this log (OPS-76).
      `FACTORY_RUN_ID=${path.basename(log, ".jsonl")}`,
      harnessBin, ...piPreArgs, ...harnessArgs
    ];
    const [bin, args] = TIMEOUT_BIN
      ? [TIMEOUT_BIN, ["-k", "30s", `${maxMin}m`, "env", ...envArgs]]
      : ["env", envArgs];
    const child = spawn(bin, args, { cwd: wt, stdio: ["ignore", "pipe", "pipe"] });
    children.add(child);
    // Replace the dispatcher's short setup lease with the actual ticket worker
    // as soon as it exists. The lease is independent of transcript activity:
    // a long test or API call can be silent without looking dead.
    writeWorkerLease({ repo: repo.name, ticket: t.identifier, owner: leaseOwner, pid: child.pid });
    // Lifecycle observation (WM-75): fire-and-forget — the runtime being down
    // must never affect dispatch. eventId is stable within this tick run.
    void emitFactoryEvent("factory.ticket.dispatched",
      { repo: repo.name, ticket: t.identifier, harness: HARNESS, worktree: wt },
      { eventId: `dispatch:${t.identifier}:${stamp}`, subject: t.identifier });
    child.on("close", () => children.delete(child));

    let buf = "";
    let recorded = false;
    let turnCount = 0;
    const tag = c.cyan(`[${t.identifier}]`);
    const processLine = (line) => {
      if (!line.trim().startsWith("{")) return;
      let e; try { e = JSON.parse(line); } catch { return; }
      if (e.type === "assistant") {
        for (const p of e.message?.content ?? []) {
          if (p.type === "tool_use") {
            const d = String(p.input?.command ?? p.input?.file_path ?? p.input?.description ?? "").replace(/\s+/g, " ").slice(0, 66);
            console.log(`${c.dim(clock())} ${tag} ${p.name} ${c.dim(d)}`);
          }
        }
      }
      if (HARNESS === "codex") {
        if (e.type === "turn.started" || e.type === "turn.created") turnCount++;
        if (e.type === "item.started" && (e.item?.type === "command_execution" || e.item?.type === "call")) {
          const d = String(e.item.command ?? "").replace(/\s+/g, " ").slice(0, 66);
          console.log(`${c.dim(clock())} ${tag} bash ${c.dim(d)}`);
        } else if (e.type === "item.started" && e.item?.type === "mcp_tool_call") {
          const d = String(e.item.tool ?? "mcp").replace(/\s+/g, " ").slice(0, 66);
          console.log(`${c.dim(clock())} ${tag} ${d}`);
        }
        if (e.type === "turn.completed") {
          e = { type: "result", subtype: "success", is_error: false, num_turns: turnCount || 1, total_cost_usd: 0, result: "finished" };
        }
      } else if (HARNESS === "pi") {
        if (e.type === "message" && e.message?.role === "assistant") {
          for (const p of e.message.content ?? []) {
            if (p.type === "toolCall") {
              turnCount++;
              const d = String(p.input?.path ?? p.input?.command ?? p.input?.pattern ?? JSON.stringify(p.input ?? {})).replace(/\s+/g, " ").slice(0, 66);
              console.log(`${c.dim(clock())} ${tag} ${p.name ?? "tool"} ${c.dim(d)}`);
            }
          }
        }
        if (e.type === "result" && e.result) {
          const ok = e.result.exitCode === 0;
          e = { type: "result", subtype: ok ? "success" : "failed", is_error: !ok, num_turns: turnCount || 1, total_cost_usd: 0, result: ok ? "finished" : "failed" };
        }
      } else if (HARNESS !== "claude") {
        const s = e.event === "step_update" ? (e.step_update ?? {}) : null;
        if (s?.step_type === "tool" && s.state === "ACTIVE") {
          const par = s.tool_info?.parameters ?? {};
          const d = String(par.CommandLine ?? par.command ?? par.AbsolutePath ?? par.path ?? "").replace(/\s+/g, " ").slice(0, 66);
          console.log(`${c.dim(clock())} ${tag} ${s.tool_name ?? "tool"} ${c.dim(d)}`);
        }
        const env = e.event === "result" ? e.result : ("status" in e && "num_turns" in e ? e : null);
        if (!env) return;
        e = { subtype: String(env.status).toLowerCase() === "success" ? "success" : String(env.status ?? "?"),
              is_error: String(env.status).toLowerCase() !== "success",
              num_turns: env.num_turns, total_cost_usd: env.total_cost_usd ?? 0, result: env.response ?? "" };
      }
      if (e.type === "result" || "num_turns" in e) {
        const turns = e.num_turns ?? 0;
        const ok = e.subtype === "success" && !e.is_error && turns > 0;
        console.log(`${c.dim(clock())} ${tag} ${ok ? c.green("done") : c.red("FAILED")} ${c.dim(`${turns} turns ~$${(e.total_cost_usd ?? 0).toFixed(2)}`)}`);
        const said = String(e.result ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
        results.push({
          id: t.identifier, ok, log,
          why: ok ? undefined : `${turns} turns, ended ${e.subtype ?? "?"}${e.is_error ? " (error)" : ""}${said ? ` — ${said}` : ""}`,
        });
        if (turns === 0) noteEnvFailure("session ended without taking a turn");
        else if (ok) envFailures = 0;
        recorded = true;
      }
    };
    child.stdout.on("data", (d) => {
      out.write(d);
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) processLine(line);
    });
    child.stderr.on("data", (d) => out.write(d));
    child.on("close", async (code) => {
      // The final "result" line isn't guaranteed a trailing newline, so
      // whatever is still in `buf` when the process exits needs a look too —
      // otherwise a clean exit with no trailing "\n" silently reports nothing.
      if (buf.trim()) processLine(buf);
      // If the child never emitted a parseable result (crash, bad spawn,
      // killed by the timeout), record it as a failure explicitly. Silence
      // here previously showed up as "0 ok, 0 failed" — indistinguishable
      // from an empty run.
      if (!recorded) {
        console.log(`${c.dim(clock())} ${tag} ${c.red("FAILED")} ${c.dim(`no result (exit ${code})`)}`);
        results.push({ id: t.identifier, ok: false, log, why: `no result emitted (exit ${code})` });
      }
      out.end();
      // A failed run must not keep its claim (unclaim() checks the ticket
      // still looks like ours — Blocked/In Review moves are left alone).
      const r = results.findLast((x) => x.id === t.identifier);
      if (r && !r.ok) {
        preserveWip(wt, t.identifier);
        await unclaim(t, r.why ?? "run failed", log).catch(() => {});
      }
      releaseWorkerLease({ repo: repo.name, ticket: t.identifier, owner: leaseOwner });
      resolve();
    });
  });
}

// --------------------------------------------------------- rolling loop -----
const running = new Map();   // identifier -> promise
const inFlight = new Map();  // identifier -> ticket, for releasing claims on interrupt
const children = new Set();  // spawned agent processes, so shutdown can stop them explicitly
let shuttingDown = false;

/**
 * Ctrl-C must not leave claims behind.
 *
 * The agent processes share our process group, so the same Ctrl-C that stops
 * the supervisor already stopped them — but the code that releases a claim on
 * failure lives in THIS process, in each child's close handler. Exiting
 * immediately skipped it, and three tickets claimed seconds before a Ctrl-C
 * stayed `In Progress` with nothing running: dispatch slots held by ghosts
 * until a human noticed, since the reaper needs 45 minutes of silence first.
 *
 * So: stop claiming, stop the children, give their own handlers a moment to
 * release cleanly, then release whatever is still held and leave.
 */
async function shutdown(sig) {
  if (shuttingDown) process.exit(130);   // second Ctrl-C: the operator means it
  shuttingDown = true;
  console.log(c.yellow(`\n  ${sig} — releasing ${inFlight.size} claim(s) before exit. Ctrl-C again to abandon them.`));

  for (const ch of children) { try { ch.kill("SIGTERM"); } catch {} }

  const deadline = Date.now() + 10_000;
  while (running.size && Date.now() < deadline) await Bun.sleep(250);

  for (const [id, t] of [...inFlight]) {
    releaseWorkerLease({ repo: repo.name, ticket: t.identifier, owner: leaseOwner });
    const wt = path.join(expand(repo.worktree_root), t.identifier);
    preserveWip(wt, t.identifier);
    await unclaim(t, `dispatcher interrupted (${sig}) before the run finished`).catch(() => {});
    console.log(c.dim(`  released ${id}`));
  }
  console.log(c.dim(`\nstopped. Claims released; worktrees left in place for the next dispatch.\n`));
  process.exit(130);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
const seen = new Set();      // everything we have claimed this run
const warned = new Set();    // skip-warnings already printed, so refills don't repeat them
let startedCount = 0;
let drained = false;

/**
 * Cross-process claim lock, so more than one supervisor can work one repo.
 *
 * Linear has no compare-and-swap, so claim() writes the assignee and reads it
 * back. That works against a foreign agent, and not at all against a second
 * supervisor of YOUR OWN: both authenticate as the same Linear user (OPS-40),
 * so the read-back returns our id for both and each concludes it won. Two
 * agents then enter the same worktree — same branch, same database, same
 * ports. The slot accounting has the same problem: each dispatcher sees
 * `cap - inProgress` before the other's claims land, so both fill the cap.
 *
 * Both are fixed by serialising the read-decide-claim window on the machine
 * where the supervisors run. It is short — a Linear query and one update per
 * ticket — so the second dispatcher waits milliseconds, then re-reads and sees
 * the first one's claims.
 *
 * A holder that dies leaves the file behind, so the lock carries its pid and
 * is stolen when that process is gone or the lock is older than 2 minutes.
 */
const LOCK = path.join(homedir(), ".factory/locks", `${repo.name}.dispatch.lock`);
mkdirSync(path.dirname(LOCK), { recursive: true });

const releaseClaimLock = () => { try { unlinkSync(LOCK); } catch {} };

async function fill() {
  if (startedCount >= MAX || tripped || shuttingDown) return;
  const spent = budgetExhausted(policy);
  if (spent) {
    if (!drained) console.log(c.yellow(`\n  ${spent} — draining: running tickets finish, nothing new starts.\n`));
    drained = true;
    return;
  }
  // Everything from here to the last claim() must be exclusive: read the queue,
  // decide, claim. Another dispatcher reading in the middle of it would see
  // slots we are about to take.
  if (!acquireClaimLock(LOCK, {
    onStale: (pid) => console.log(c.yellow(
      pid === null
        ? "  corrupt dispatch lock — taking it"
        : `  stale dispatch lock from pid ${pid} — taking it`,
    )),
  })) {
    console.log(c.dim(`  another dispatcher is claiming for ${repo.name} — skipping this pass`));
    return;
  }
  try {

  const state = await fetchState();
  const free = Math.min(cap - liveWorkerLeases(repo.name).length, MAX - startedCount);
  if (free <= 0) return;

  // Same warnings the dry run prints — without them, "READY is high but nothing
  // starts" is invisible in exactly the mode that matters (see F-7). Keyed per
  // reason: a blocked ticket can unblock mid-run and then be worth re-warning
  // about its missing Owned Paths, and vice versa.
  for (const t of state.ready) {
    if (seen.has(t.identifier)) continue;
    const blockers = openBlockers(t);
    if (blockers.length && !warned.has(`${t.identifier}:blocked`)) {
      warned.add(`${t.identifier}:blocked`);
      console.log(c.yellow(`  skip ${t.identifier} — blocked by ${blockers.join(", ")}`));
    } else if (!blockers.length && !parseOwnedPaths(t.description ?? "").length && !warned.has(`${t.identifier}:paths`)) {
      warned.add(`${t.identifier}:paths`);
      console.log(c.yellow(`  ${t.identifier} — no parseable Owned Paths, treated as owning everything (dispatchable, but runs alone)`));
    }
  }

  const picked = selectable(state, seen, free);
  if (!picked.length) return;

  const claimed = [];
  for (const t of picked) {
    if (await claim(t)) { claimed.push(t); seen.add(t.identifier); console.log(`${c.dim(clock())} ${c.cyan(t.identifier)} claimed`); }
    else console.log(c.yellow(`  ${t.identifier} claim lost to another agent`));
  }
  if (!claimed.length) return;

  warmIfWorthIt(claimed.length);

  for (const t of claimed) {
    startedCount++;
    // Count the claim immediately, including worktree setup, so another local
    // supervisor cannot observe a free slot in the small gap before spawn.
    writeWorkerLease({ repo: repo.name, ticket: t.identifier, owner: leaseOwner });
    inFlight.set(t.identifier, t);
    const p = runTicket(t).finally(() => {
      releaseWorkerLease({ repo: repo.name, ticket: t.identifier, owner: leaseOwner });
      running.delete(t.identifier);
      inFlight.delete(t.identifier);
    });
    running.set(t.identifier, p);
  }

  } finally { releaseClaimLock(); }
}

// A worker lease is deliberately not driven by its JSONL output: agents can
// spend minutes in a test runner with no transcript event. The parent remains
// responsible for the child, so its heartbeat is the authoritative liveness
// signal; a vanished parent naturally lets every lease expire.
const leaseHeartbeat = setInterval(() => {
  for (const t of inFlight.values()) {
    renewWorkerLease({ repo: repo.name, ticket: t.identifier, owner: leaseOwner });
  }
}, LEASE_HEARTBEAT_MS);

// Orphaned agent Chrome holds SingletonLock on the shared profile and blocks
// every later browser launch (×43+ failures across 20 runs in friction.mjs).
// Sweep before dispatch — only kills Chrome reparented to PID 1.
if (APPLY) {
  const sweep = spawnSync("/bin/bash", ["-lc", "bun orchestrator/chrome-sweep.mjs --apply"], { cwd: ROOT, encoding: "utf8" });
  const line = (sweep.stdout || sweep.stderr || "").trim().split("\n").filter(Boolean).pop();
  if (line && !line.includes("no orphaned")) console.log(c.dim(`  chrome-sweep: ${line}`));
}

await fill();
if (!running.size) { clearInterval(leaseHeartbeat); console.log(c.dim("\n  nothing started.\n")); process.exit(0); }

while (running.size) {
  await Promise.race(running.values());
  // A slot just freed. Re-read the queue — triage may have promoted something,
  // or a finishing agent may have filed follow-up work, while we were busy.
  if (REFILL && startedCount < MAX) {
    const before = running.size;
    await fill();
    if (running.size > before) console.log(c.dim(`  ${clock()} refilled — ${running.size} in flight`));
  }
}

console.log(c.bold("\nsummary"));
for (const r of results) console.log(`  ${r.ok ? c.green("ok  ") : c.red("FAIL")} ${r.id}${r.log ? c.dim("  " + r.log.replace(homedir(), "~")) : ""}${r.why ? c.dim("  " + r.why) : ""}`);
const failed = results.filter((r) => !r.ok).length;
  if (tripped) console.log(c.red(`circuit breaker tripped — dispatch stopped after ${envFailures} consecutive environment failures.`));
  console.log(c.dim(`\n${results.length - failed} ok, ${failed} failed, ${startedCount} started. Merging is a separate stage.\n`));
  clearInterval(leaseHeartbeat);
  process.exit(failed || tripped ? 1 : 0);
}

if (import.meta.main || process.argv[1]?.endsWith("tick.mjs")) {
  main().catch((err) => {
    console.error(`Dispatch error: ${err.message || err}`);
    process.exit(1);
  });
}
