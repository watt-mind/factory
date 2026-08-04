#!/usr/bin/env bun
/**
 * Foreground monitor — a read-only window onto what tick.mjs / run.mjs are
 * doing right now: queue depth per repo (via `queue.mjs --json`), which
 * tickets are in flight or in review, and a live tail of the selected
 * ticket's session log under ~/.factory/logs.
 *
 *   bun orchestrator/watch.jsx
 *   bun orchestrator/watch.jsx --repo bj29
 *
 * Read-only, with TWO deliberate exceptions:
 *   `x` runs the stale-claim reaper for the selected repo's team — dry-run
 *       first, `--apply` only after a second explicit `y`, only when the dry
 *       run found something to reclaim;
 *   `u` launches the unblock sweep agent (factory-unblock) for the selected
 *       repo — immediately, no dry step: the sweep is Linear-write-only and
 *       rule-bound to touch nothing without new evidence, so the guard lives
 *       in the command, not in a confirm keystroke. It shows up in the agents
 *       section like any stage agent, tailable from here.
 * (`b` shows the blocked-tickets digest, which is read-only like the rest.)
 * Everything else re-reads the same state queue.mjs and the log files already
 * expose — including `enter`, which just hands the terminal to $PAGER on the
 * selected log file and takes it back, and `c`, which copies a ticket id via
 * pbcopy. This is the bird's-eye view across repos and in-flight tickets;
 * run.mjs is still the place to watch one job's full dry/apply output.
 *
 * Unattended signal: the terminal tab title (OSC 0) carries the repo and a
 * "⚠" once anything needs a look (a failed stage, a blocked ticket, a quiet
 * running ticket, or spend over 90% of the daily cap) — same condition rings
 * the bell once, on the transition into that state, so leaving this in a
 * background tab still surfaces trouble.
 */
import React, { useEffect, useRef, useState } from "react";
import { render, Box, Text, useInput, useStdout } from "ink";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "../lib/schedule.mjs";
import { todaysSpendUSD } from "../lib/spend.mjs";
import {
  buildTicketRows, latestLogForTicket, tailEntries, entryTone, formatEntry, formatSpend,
  formatIssueCounts, parseReaperOutput, linearDeepLink, stageStatuses, formatAge, visibleWindow,
  activeAgents, spendPct, spendTone, agentCapStat, needsAttention,
} from "./watch-lib.mjs";

const LOG_DIR = path.join(homedir(), ".factory/logs");
const QUEUE_POLL_MS = 20_000;
const LOG_POLL_MS = 3_000;
const TAIL_BUFFER = 500;   // entries kept for PgUp scrollback, well beyond one screen
const LOG_PAGE = 10;       // rows per PgUp/PgDn
const QUIET_MS = 90_000;   // matches the "quiet" threshold TicketList already renders

const argv = process.argv.slice(2);
const val = (f) => { const i = argv.indexOf(f); return i === -1 ? null : argv[i + 1]; };
const REPO_FILTER = val("--repo");

const policy = (() => {
  try { return Bun.YAML.parse(readFileSync(path.join(ROOT, "config/policy.yaml"), "utf8")); } catch { return {}; }
})();
const PER_DAY_USD = policy?.budget?.per_day_usd ?? 0;

const clock = () => new Date().toTimeString().slice(0, 8);

async function fetchQueue() {
  const args = ["orchestrator/queue.mjs", "--json"];
  if (REPO_FILTER) args.push("--repo", REPO_FILTER);
  const p = Bun.spawn(["bun", ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0) throw new Error(err.trim() || `queue.mjs exited ${code}`);
  return JSON.parse(out);
}

function StatChip({ label, value, tone }) {
  const color = tone === "warn" ? "yellow" : tone === "bad" ? "red" : tone === "good" ? "green" : undefined;
  return (
    <Box marginRight={2}>
      <Text dimColor>{label} </Text>
      <Text color={color} bold={Boolean(tone)}>{value}</Text>
    </Box>
  );
}

function RepoTabs({ repos, selected }) {
  if (repos.length < 2) return null;
  return (
    <Box marginBottom={1}>
      {repos.map((r, i) => (
        <Box key={r} marginRight={2}>
          <Text bold={i === selected} color={i === selected ? "green" : undefined} dimColor={i !== selected}>
            {i === selected ? "▶ " : "  "}{r}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

function QueueStrip({ summary }) {
  if (!summary) return <Text dimColor>waiting for queue.mjs…</Text>;
  // "agents" is how many are in flight against the repo's concurrency
  // ceiling (inProgress + slotsFree) — the question "how many can spawn, and
  // how many is the max" in one glance, tone flips at the ceiling itself.
  const agents = agentCapStat(summary.inProgress, summary.slotsFree);
  return (
    <Box>
      <StatChip label="agents" value={agents.text} tone={agents.tone} />
      <StatChip label="ready" value={summary.ready} tone={summary.ready ? "good" : undefined} />
      <StatChip label="review" value={summary.inReview} tone={summary.inReview ? "warn" : undefined} />
      <StatChip label="triage" value={summary.triage} />
      <StatChip label="blocked" value={summary.blocked} tone={summary.blocked ? "bad" : undefined} />
      <StatChip label="PRs" value={summary.openPRs} tone={summary.openPRs ? "warn" : undefined} />
      <StatChip label="done" value={formatIssueCounts(summary.done, summary.total, summary.countCapped)} />
    </Box>
  );
}

/**
 * triage -> dispatch -> merge, with a live dot on whatever is running right
 * now (log written < 90s ago) and "how long since it last ran, and did it
 * end well" for the rest.
 *
 * An idle stage with a backlog is the strip's whole reason to exist — "merge
 * hasn't run in 40m and 12 PRs are waiting" means the supervisor for that
 * stage isn't running (or its gate is failing), and that renders yellow so it
 * cannot be mistaken for a quiet queue. `counts` carries how many agents each
 * stage is running (dispatch runs one per ticket, so ×N).
 */
function StageStrip({ stages, waiting, counts }) {
  if (!stages) return null;
  return (
    <Box>
      <Text dimColor>stages </Text>
      {stages.map((s) => {
        const failed = s.lastResult && !s.lastResult.ok;
        const backlog = waiting?.[s.stage] ?? 0;
        const n = counts?.[s.stage] ?? 0;
        return (
          <Box key={s.stage} marginRight={2}>
            {s.active ? (
              <Text color="green">● {s.stage}{n > 1 ? ` ×${n}` : ""}</Text>
            ) : backlog > 0 ? (
              <Text color="yellow">
                ○ {s.stage} {formatAge(s.ageMs)} — {backlog} waiting
                {failed ? <Text color="red" bold> FAIL</Text> : null}
              </Text>
            ) : (
              <Text dimColor>
                ○ {s.stage} <Text>{formatAge(s.ageMs)}</Text>
                {failed ? <Text color="red" bold> FAIL</Text> : null}
              </Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

const SHORTCUTS = [
  ["↑ ↓", "select a ticket"],
  ["← →", "switch repo"],
  ["1-9", "jump straight to repo tab N"],
  ["o", "open the selected ticket in Linear (desktop app, browser fallback)"],
  ["c", "copy the selected ticket's identifier to the clipboard"],
  ["r", "refresh queue + spend now"],
  ["x", "run the stale-claim reaper (dry run) for this repo's team"],
  ["y", "confirm reaper --apply — only offered when the dry run found stale claims"],
  ["b", "blocked-tickets digest for this repo — every hold, its question, its age"],
  ["u", "launch the unblock sweep agent for this repo (spawns immediately, no dry run)"],
  ["PgUp/PgDn", "scroll the log tail; PgUp stops following live output"],
  ["G", "jump the log tail back to live (re-follow)"],
  ["enter", "open the selected log in $PAGER (full scrollback, search with /)"],
  ["?", "this help"],
  ["esc", "close an open pane; quit when none is open"],
  ["q", "quit"],
];

function HelpPane() {
  return (
    <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">keyboard shortcuts</Text>
      {SHORTCUTS.map(([keys, what]) => (
        <Text key={keys}>
          <Text bold color="cyan">{keys.padEnd(6)}</Text>
          {what}
        </Text>
      ))}
      <Text dimColor>esc close</Text>
    </Box>
  );
}

/**
 * Runs orchestrator/reaper.mjs and takes over the main pane while the output
 * is up. Dry runs happen on `x` alone; the `stale` count parsed from that dry
 * run is what unlocks the `y` -> --apply step.
 */
function ReaperPane({ reaper }) {
  const title = {
    dry: `reaper — dry run (team ${reaper.team})…`,
    "dry-done": `reaper — dry run (team ${reaper.team})`,
    applying: `reaper — applying (team ${reaper.team})…`,
    applied: `reaper — reclaimed (team ${reaper.team})`,
    error: "reaper — failed",
  }[reaper.phase];
  const canApply = reaper.phase === "dry-done" && reaper.stale > 0;
  return (
    <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor={reaper.phase === "error" ? "red" : "yellow"} paddingX={1}>
      <Text bold color={reaper.phase === "error" ? "red" : "yellow"}>{title}</Text>
      {reaper.lines.length === 0 && <Text dimColor>running…</Text>}
      {reaper.lines.map((line, i) => (
        <Text key={i} wrap="truncate-end">{line}</Text>
      ))}
      <Text dimColor>{canApply ? "y reclaim these · " : ""}esc close</Text>
    </Box>
  );
}

/**
 * Blocked-tickets digest (`b`) — read-only output of orchestrator/digest.mjs,
 * shown in place of the ticket panes. Long digests scroll off; the CLI is the
 * place for the full report, this is the glance.
 */
function DigestPane({ digest, height }) {
  const title = {
    running: `blocked digest (${digest.repo})…`,
    done: `blocked digest (${digest.repo})`,
    error: "blocked digest — failed",
  }[digest.phase];
  const shown = digest.lines.slice(0, Math.max(1, height - 2));
  return (
    <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor={digest.phase === "error" ? "red" : "cyan"} paddingX={1}>
      <Text bold color={digest.phase === "error" ? "red" : "cyan"}>{title}</Text>
      {digest.lines.length === 0 && <Text dimColor>running…</Text>}
      {shown.map((line, i) => (
        <Text key={i} wrap="truncate-end">{line}</Text>
      ))}
      {digest.lines.length > shown.length && <Text dimColor>… {digest.lines.length - shown.length} more — run `bun orchestrator/digest.mjs` for the full report</Text>}
      <Text dimColor>esc close</Text>
    </Box>
  );
}

/**
 * Confirmation that `u` actually spawned the sweep. The run itself is not
 * awaited here — run-agent.sh writes `<repo>-factory-unblock-<stamp>.jsonl`,
 * so the agents section picks it up within a poll and its log is tailable
 * like any stage agent's.
 */
function UnblockPane({ unblock }) {
  const failed = unblock.phase === "error";
  return (
    <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor={failed ? "red" : "green"} paddingX={1}>
      <Text bold color={failed ? "red" : "green"}>
        {failed ? "unblock sweep — failed to launch" : `unblock sweep launched (${unblock.repo})`}
      </Text>
      {unblock.lines.map((line, i) => (
        <Text key={i} wrap="truncate-end">{line}</Text>
      ))}
      {!failed && <Text dimColor>it will appear under agents shortly — select it there to tail its log</Text>}
      <Text dimColor>esc close</Text>
    </Box>
  );
}

async function runReaperProcess(team, apply) {
  const args = ["orchestrator/reaper.mjs", "--team", team];
  if (apply) args.push("--apply");
  const p = Bun.spawn(["bun", ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { out, err };
}

function TicketList({ stageAgents, rows, ready, blocked, ages, selected, height }) {
  // Budget in rows: agents section (1 header + 1 per agent), 1 in-flight
  // header, 2 per ticket, 3 for the ready section, 2 for the blocked section
  // (header + one line each, capped), 2 for the more-above/below markers.
  // Never let the list outgrow the pane — an overgrown frame is what pushes
  // the TUI into terminal scrollback.
  const agentReserve = stageAgents.length > 0 ? stageAgents.length + 1 : 0;
  const readyReserve = ready?.length > 0 ? 3 : 0;
  const blockedReserve = blocked?.length > 0 ? Math.min(blocked.length, 3) + 1 : 0;
  const maxRows = Math.max(1, Math.floor((height - agentReserve - 1 - readyReserve - blockedReserve - 2) / 2));
  const ticketSel = Math.max(0, selected - stageAgents.length);
  const [start, end] = visibleWindow(rows.length, ticketSel, maxRows);
  return (
    <Box flexDirection="column" width="42%" marginRight={1}>
      {stageAgents.length > 0 && (
        <Box flexDirection="column">
          <Text dimColor>agents</Text>
          {stageAgents.map((a, i) => (
            <Text key={a.file} inverse={i === selected}>
              <Text color="green">●</Text> {a.label}
              {a.harness ? <Text dimColor> {a.harness}</Text> : null}
              <Text dimColor> {formatAge(a.ageMs)}</Text>
            </Text>
          ))}
        </Box>
      )}
      <Text dimColor>in flight</Text>
      {rows.length === 0 && <Text dimColor>  nothing running or in review</Text>}
      {start > 0 && <Text dimColor>  ▲ {start} more</Text>}
      {rows.slice(start, end).map((t, idx) => {
        const i = start + idx;
        const isSel = stageAgents.length + i === selected;
        const age = ages?.[t.identifier];
        // A running ticket whose log went quiet is the thing to look at — the
        // agent may be thinking, or gone (the reaper fires at 45m of Linear
        // silence; this is the earlier, cheaper tell).
        const quiet = t.status === "running" && age != null && age >= 90_000;
        const dot = t.status === "running" ? (quiet ? "◌" : "●") : "◐";
        const dotColor = t.status === "running" ? (quiet ? "yellow" : "green") : "yellow";
        const note = t.status !== "running" ? "in review"
          : age == null ? "running — no log"
          : quiet ? `quiet ${formatAge(age)}`
          : `running ${formatAge(age)}`;
        return (
          <Box key={t.identifier} flexDirection="column" marginBottom={0}>
            <Text inverse={isSel}>
              <Text color={dotColor}>{dot}</Text> {t.identifier}{" "}
              <Text dimColor color={quiet ? "yellow" : undefined}>{note}</Text>
            </Text>
            <Text dimColor wrap="truncate-end">  {t.title}</Text>
          </Box>
        );
      })}
      {end < rows.length && <Text dimColor>  ▼ {rows.length - end} more</Text>}
      {ready?.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>ready to dispatch</Text>
          <Text dimColor wrap="truncate-end">  {ready.join(" · ")}</Text>
        </Box>
      )}
      {blocked?.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>blocked</Text>
          {blocked.slice(0, 3).map((t) => (
            <Text key={t.identifier} color="red" wrap="truncate-end">  ⛔ {t.identifier} — {t.title}</Text>
          ))}
          {blocked.length > 3 && <Text dimColor>  … {blocked.length - 3} more — press b for the full digest</Text>}
        </Box>
      )}
    </Box>
  );
}

const TONE_COLOR = { tool: "cyan", ok: "green", fail: "red" };

// entries[] is the full buffer (see TAIL_BUFFER in App); scrollOffset counts
// rows back from the live end, 0 = following. PgUp increases it (freezes the
// view further back in history), PgDn/G walk it back to 0 (re-follow).
function LogTail({ label, entries, scrollOffset, height }) {
  const rows = Math.max(1, height - 1);
  const end = Math.max(0, entries.length - scrollOffset);
  const start = Math.max(0, end - rows);
  const shown = entries.slice(start, end);
  const following = scrollOffset === 0;
  return (
    <Box flexDirection="column" width="58%">
      <Text dimColor>
        {label ? `log tail — ${label}` : "log tail"}
        {label && !following && <Text color="yellow"> — scrolled (G to follow)</Text>}
      </Text>
      {!label && <Text dimColor>  select a ticket or agent to tail its log</Text>}
      {label && entries.length === 0 && <Text dimColor>  no log yet</Text>}
      {shown.map((entry, i) => (
        <Text key={start + i} wrap="truncate-end" color={TONE_COLOR[entryTone(entry)]}>{formatEntry(entry)}</Text>
      ))}
    </Box>
  );
}

function App() {
  const [summaries, setSummaries] = useState([]);
  const [error, setError] = useState(null);
  const [lastPoll, setLastPoll] = useState(null);
  const [repoIdx, setRepoIdx] = useState(0);
  const [rowIdx, setRowIdx] = useState(0);
  const [logEntries, setLogEntries] = useState([]);
  const [scrollOffset, setScrollOffset] = useState(0); // rows back from live; 0 = following
  const [spend, setSpend] = useState(0);
  const [lastPollMs, setLastPollMs] = useState(null);
  const [nowTick, setNowTick] = useState(Date.now());
  const [reaper, setReaper] = useState(null); // { phase, team, lines, stale }
  const [digest, setDigest] = useState(null); // { phase, repo, lines }
  const [unblock, setUnblock] = useState(null); // { phase, repo, lines }
  const [stages, setStages] = useState(null);
  const [agents, setAgents] = useState([]);
  const [ticketAges, setTicketAges] = useState({});
  const [showHelp, setShowHelp] = useState(false);
  const pollRef = useRef(null);
  const logFileRef = useRef(null);
  const wasAttention = useRef(false);
  const { stdout } = useStdout();
  const width = Math.max(70, stdout?.columns ?? 100);
  const height = Math.max(12, stdout?.rows ?? 40);
  // Rows left for the ticket-list/log panes: borders 2, title 1, tabs 2,
  // queue strip 1, stage strip 1, pane margins 2, footer 1.
  const paneHeight = Math.max(4, height - 10);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const data = await fetchQueue();
        if (cancelled) return;
        setSummaries(data);
        setError(null);
        setLastPoll(clock());
        setLastPollMs(Date.now());
      } catch (e) {
        if (!cancelled) setError(String(e.message ?? e));
      }
    };
    pollRef.current = poll;
    poll();
    const id = setInterval(poll, QUEUE_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
    // rowIdx is not clamped here — it's clamped at render time against the
    // current agents+tickets list, which this effect can't see.
  }, []);

  useEffect(() => {
    const id = setInterval(() => setSpend(todaysSpendUSD(LOG_DIR)), LOG_POLL_MS);
    setSpend(todaysSpendUSD(LOG_DIR));
    return () => clearInterval(id);
  }, []);

  // Drives the "next poll in Ns" countdown in the footer — otherwise a stale
  // queue strip and a slow poll look identical.
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const summary = summaries[repoIdx];
  const rows = buildTicketRows(summary ?? {});
  // Selection runs over one flat list: live stage agents first (triage/merge —
  // dispatch agents ARE the running tickets below), then tickets.
  const stageAgents = agents.filter((a) => !a.identifier);
  const allCount = stageAgents.length + rows.length;
  const selIdx = Math.min(rowIdx, Math.max(0, allCount - 1));
  const selAgent = selIdx < stageAgents.length ? stageAgents[selIdx] : null;
  const selTicketRow = selAgent ? null : rows[selIdx - stageAgents.length] ?? null;
  const selectedTicket = selTicketRow?.identifier ?? null;

  useEffect(() => {
    if (!summary?.repo) { setStages(null); setAgents([]); setTicketAges({}); return; }
    const scan = () => {
      setStages(stageStatuses(LOG_DIR, summary.repo));
      setAgents(activeAgents(LOG_DIR, summary.repo));
      const ages = {};
      for (const t of summary.inProgressTickets ?? []) {
        const f = latestLogForTicket(LOG_DIR, summary.repo, t.identifier);
        ages[t.identifier] = f ? Math.max(0, Date.now() - Bun.file(f).lastModified) : null;
      }
      setTicketAges(ages);
    };
    scan();
    const id = setInterval(scan, LOG_POLL_MS);
    return () => clearInterval(id);
  }, [summary]);

  const budgetTone = spendTone(spend, PER_DAY_USD);
  const quietTickets = rows.filter(
    (t) => t.status === "running" && ticketAges[t.identifier] != null && ticketAges[t.identifier] >= QUIET_MS,
  ).length;
  const attention = needsAttention({ blocked: summary?.blocked ?? 0, stages: stages ?? [], quietTickets, budgetTone });

  // Terminal tab title (OSC 0) follows the selected repo and gets a "⚠"
  // prefix for as long as `attention` holds. The bell is separate and rings
  // once, only on the false -> true edge, so an unresolved problem nags the
  // tab (title) without nagging the ear (bell) every poll.
  useEffect(() => {
    if (process.stdout.isTTY) {
      const prefix = attention ? "⚠ " : "";
      process.stdout.write(`\x1b]0;${prefix}factory watch${summary?.repo ? ` — ${summary.repo}` : ""}\x07`);
    }
    if (attention && !wasAttention.current && process.stdout.isTTY) process.stdout.write("\x07");
    wasAttention.current = attention;
  }, [summary?.repo, attention]);

  const selKey = selAgent ? selAgent.file : selectedTicket;
  useEffect(() => { setScrollOffset(0); }, [selKey, summary?.repo]); // switching selection re-follows live output
  useEffect(() => {
    const tail = () => {
      if (!summary || (!selAgent && !selectedTicket)) { setLogEntries([]); logFileRef.current = null; return; }
      const file = selAgent ? selAgent.file : latestLogForTicket(LOG_DIR, summary.repo, selectedTicket);
      logFileRef.current = file;
      setLogEntries(tailEntries(file, TAIL_BUFFER));
    };
    tail();
    const id = setInterval(tail, LOG_POLL_MS);
    return () => clearInterval(id);
  }, [selKey, summary?.repo]);

  const startReaper = async (team, apply) => {
    setReaper({ phase: apply ? "applying" : "dry", team, lines: [], stale: 0 });
    try {
      const { out, err } = await runReaperProcess(team, apply);
      const text = (out + (err ? `\n${err}` : "")).trimEnd();
      setReaper({
        phase: apply ? "applied" : "dry-done",
        team,
        lines: text.split("\n").filter((l) => l.trim() !== "").slice(-16),
        stale: parseReaperOutput(out).stale,
      });
      // A reclaim changes the queue right now — don't leave the strip stale
      // for up to 20s claiming the ticket is still In Progress.
      if (apply) pollRef.current?.();
    } catch (e) {
      setReaper({ phase: "error", team, lines: [String(e.message ?? e)], stale: 0 });
    }
  };

  const startDigest = async (repo) => {
    setDigest({ phase: "running", repo, lines: [] });
    try {
      const p = Bun.spawn(["bun", "orchestrator/digest.mjs", "--repo", repo], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([
        new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
      ]);
      const text = (code === 0 ? out : out + `\n${err}`).trimEnd();
      setDigest({ phase: code === 0 ? "done" : "error", repo, lines: text.split("\n").filter((l) => l.trim() !== "") });
    } catch (e) {
      setDigest({ phase: "error", repo, lines: [String(e.message ?? e)] });
    }
  };

  // No dry step and no confirm, on purpose (the header says why). Launch is
  // fire-and-forget: the sweep's own log under ~/.factory/logs is the record,
  // and the agents section is where to watch it. Only a spawn that dies within
  // 3s (harness missing, bad flags) is reported back here.
  const startUnblock = (repo) => {
    try {
      const p = Bun.spawn(["bash", "runners/run-agent.sh", "--repo", repo, "--command", "factory-unblock", "--read-only", "--args", "10"],
        { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
      setUnblock({ phase: "launched", repo, lines: [] });
      const born = Date.now();
      p.exited.then(async (code) => {
        if (code !== 0 && Date.now() - born < 3000) {
          const err = await new Response(p.stderr).text();
          const out = await new Response(p.stdout).text();
          setUnblock({ phase: "error", repo, lines: (out + "\n" + err).trim().split("\n").slice(-8) });
        }
      });
    } catch (e) {
      setUnblock({ phase: "error", repo, lines: [String(e.message ?? e)] });
    }
  };

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) process.exit(0);
    if (showHelp) {
      if (key.escape || input === "?") setShowHelp(false);
      return;
    }
    if (input === "?") { setShowHelp(true); return; }
    if (digest) {
      if (key.escape) setDigest(null);
      return;
    }
    if (unblock) {
      if (key.escape) setUnblock(null);
      return;
    }
    if (reaper) {
      // The pane owns the keyboard while it's up: esc closes it (instead of
      // quitting), y confirms --apply, and only off a dry run that found work.
      if (key.escape) setReaper(null);
      if (input === "y" && reaper.phase === "dry-done" && reaper.stale > 0) startReaper(reaper.team, true);
      return;
    }
    if (key.escape) process.exit(0);
    if (input === "r") { pollRef.current?.(); setSpend(todaysSpendUSD(LOG_DIR)); }
    if (input === "o") {
      const url = selTicketRow?.url;
      if (url) {
        // Desktop app first; if the linear:// handler isn't registered, `open`
        // exits non-zero and the https URL goes to the browser instead.
        const deep = linearDeepLink(url);
        const p = Bun.spawn(["open", deep ?? url], { stdout: "ignore", stderr: "ignore" });
        if (deep) p.exited.then((code) => { if (code !== 0) Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" }); });
      }
    }
    if (input === "x" && summary?.team) startReaper(summary.team, false);
    if (input === "b" && summary?.repo) startDigest(summary.repo);
    if (input === "u" && summary?.repo) startUnblock(summary.repo);
    if (input === "c" && selTicketRow?.identifier) {
      try {
        const p = Bun.spawn(["pbcopy"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
        p.stdin.write(selTicketRow.identifier);
        p.stdin.end();
      } catch { /* no clipboard available — nothing to fall back to here */ }
    }
    if (key.leftArrow) { setRepoIdx((i) => Math.max(0, i - 1)); setRowIdx(0); }
    if (key.rightArrow) { setRepoIdx((i) => Math.max(0, Math.min(summaries.length - 1, i + 1))); setRowIdx(0); }
    if (/^[1-9]$/.test(input) && Number(input) - 1 < summaries.length) { setRepoIdx(Number(input) - 1); setRowIdx(0); }
    if (key.upArrow) setRowIdx(Math.max(0, selIdx - 1));
    if (key.downArrow) setRowIdx(Math.min(Math.max(0, allCount - 1), selIdx + 1));
    if (key.pageUp) setScrollOffset((o) => Math.min(Math.max(0, logEntries.length - 1), o + LOG_PAGE));
    if (key.pageDown) setScrollOffset((o) => Math.max(0, o - LOG_PAGE));
    if (input === "G") setScrollOffset(0);
    if (key.return && logFileRef.current) {
      // Suspend the alt-screen TUI, hand the terminal to $PAGER for real
      // scrollback + search, then take it back. Synchronous on purpose —
      // ink's own input loop is paused for the duration, same as htop's `l`.
      const file = logFileRef.current;
      process.stdout.write("\x1b[?1049l");
      Bun.spawnSync([process.env.PAGER || "less", "-R", "+G", file], { stdout: "inherit", stdin: "inherit", stderr: "inherit" });
      process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H");
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} width={width} height={height}>
      <Text bold color={attention ? "yellow" : undefined}>{attention ? "⚠ " : ""}factory — foreground monitor</Text>
      <RepoTabs repos={summaries.map((s) => s.repo)} selected={repoIdx} />
      <QueueStrip summary={summary} />
      <StageStrip
        stages={stages}
        counts={{ dispatch: agents.filter((a) => a.identifier).length }}
        waiting={{ triage: summary?.triageState ?? 0, dispatch: summary?.startable?.length ?? 0, merge: summary?.openPRs ?? 0 }}
      />
      <Box marginTop={1} marginBottom={1} flexGrow={1}>
        {showHelp ? (
          <HelpPane />
        ) : reaper ? (
          <ReaperPane reaper={reaper} />
        ) : digest ? (
          <DigestPane digest={digest} height={paneHeight} />
        ) : unblock ? (
          <UnblockPane unblock={unblock} />
        ) : (
          <>
            <TicketList stageAgents={stageAgents} rows={rows} ready={summary?.startable} blocked={summary?.blockedTickets} ages={ticketAges} selected={selIdx} height={paneHeight} />
            <LogTail label={selAgent ? `${selAgent.label} agent${selAgent.harness ? ` (${selAgent.harness})` : ""}` : selectedTicket} entries={logEntries} scrollOffset={scrollOffset} height={paneHeight} />
          </>
        )}
      </Box>
      <Box justifyContent="space-between">
        <Text dimColor>
          spend {formatSpend(spend, PER_DAY_USD)}
          {spendPct(spend, PER_DAY_USD) != null && (
            <Text color={budgetTone === "bad" ? "red" : budgetTone === "warn" ? "yellow" : undefined}> ({spendPct(spend, PER_DAY_USD)}%)</Text>
          )}
          {" "}today
          {error ? <Text color="red">  ! {error.slice(0, 50)}</Text> : null}
        </Text>
        <Text dimColor>
          {lastPoll ? `updated ${lastPoll}${lastPollMs != null ? ` · next ${Math.max(0, Math.ceil((QUEUE_POLL_MS - (nowTick - lastPollMs)) / 1000))}s` : ""}` : "loading…"}  ? shortcuts · q quit
        </Text>
      </Box>
    </Box>
  );
}

// Fullscreen: take over the terminal's alternate screen buffer (the htop/vim
// behaviour), so the shell prompt and scrollback are untouched underneath and
// come back intact on exit — however the process ends.
process.stdout.write("\x1b[?1049h\x1b[H");
process.on("exit", () => process.stdout.write("\x1b[?1049l\x1b]0;\x07"));
render(<App />);
