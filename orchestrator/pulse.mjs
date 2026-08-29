#!/usr/bin/env bun
/**
 * Factory Pulse — single-shot composite status report for master orchestrator.
 *
 *   factory pulse
 *   factory pulse --repo factory
 *   factory pulse --json
 *
 * Gathers stack health, worker capacity, in-flight runs, Linear supply depth,
 * and open PR status in a single pass.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { ROOT } from "../lib/schedule.mjs";
import { loadControlPlane } from "../lib/control-plane/index.mjs";
import { loadForge } from "../lib/forge/index.mjs";
import { fetchRecentSandboxRefusals } from "./watchdog.mjs";

const c = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

function sh(args, cwd = ROOT) {
  try {
    const result = Bun.spawnSync({
      cmd: args,
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      ok: result.exitCode === 0,
      out: result.stdout.toString().trim(),
      err: result.stderr.toString().trim(),
    };
  } catch (err) {
    return { ok: false, out: "", err: String(err) };
  }
}

function hasLinearKey() {
  if (process.env.LINEAR_API_KEY) return true;
  const envPaths = [
    path.join(homedir(), "Develop/hdkiller/.env"),
    path.join(process.cwd(), ".env"),
  ];
  for (const envPath of envPaths) {
    if (existsSync(envPath)) {
      try {
        const content = readFileSync(envPath, "utf8");
        if (content.includes("LINEAR_API_KEY=")) return true;
      } catch {
        /* intentionally ignored */
      }
    }
  }
  return false;
}

export async function gatherPulse({
  port = 7381,
  webPort = 7382,
  host = "127.0.0.1",
  repoName = "factory",
  fetchLinear = true,
  fetchGitHub = true,
} = {}) {
  const pulse = {
    timestamp: new Date().toISOString(),
    stack: {
      api: { ok: false },
      web: { ok: false, port: webPort },
      workers: { total: 0, busy: 0, idle: 0, list: [] },
    },
    runs: { active: [], proposed: 0, byState: {}, sandboxRefusals: [] },
    supply: {
      repo: repoName,
      team: "WM",
      dispatchable: 0,
      triage: 0,
      tickets: [],
    },
    prs: { total: 0, candidates: [] },
    workspace: {
      branch: "unknown",
      head: "unknown",
      behind: 0,
      ahead: 0,
      clean: true,
    },
  };

  // 1. API Health & Status
  try {
    const healthRes = await fetch(`http://${host}:${port}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (healthRes.ok) {
      const healthJson = await healthRes.json();
      pulse.stack.api = {
        ok: true,
        policyVersion: healthJson.policyVersion,
        env: healthJson.env?.name,
      };
    }
  } catch (err) {
    pulse.stack.api = { ok: false, error: err.message };
  }

  // 2. Web UI Health
  try {
    const webRes = await fetch(`http://${host}:${webPort}/`, {
      signal: AbortSignal.timeout(2000),
    });
    const ok = webRes.ok || webRes.status === 404; // serving HTTP
    pulse.stack.web = ok
      ? { ok: true, port: webPort }
      : {
          ok: false,
          port: webPort,
          error: `WEB_DOWN: Web UI returned HTTP ${webRes.status}`,
        };
  } catch (err) {
    pulse.stack.web = {
      ok: false,
      port: webPort,
      error: `WEB_DOWN: Web UI on :${webPort} unreachable (${err.message})`,
    };
  }

  // 3. Status & Workers & Runs from API (if alive)
  if (pulse.stack.api.ok) {
    try {
      const [statusRes, workersRes, runsRes, sandboxRefusals] =
        await Promise.all([
          fetch(`http://${host}:${port}/status`, {
            signal: AbortSignal.timeout(3000),
          }).then((r) => r.json()),
          fetch(`http://${host}:${port}/workers`, {
            signal: AbortSignal.timeout(3000),
          }).then((r) => r.json()),
          fetch(`http://${host}:${port}/runs?state=RUNNING`, {
            signal: AbortSignal.timeout(3000),
          }).then((r) => r.json()),
          fetchRecentSandboxRefusals({ host, port }),
        ]);

      if (workersRes?.workers) {
        const workers = workersRes.workers;
        pulse.stack.workers = {
          total: workers.length,
          busy: workers.filter((w) => w.state === "busy").length,
          idle: workers.filter((w) => w.state === "idle").length,
          list: workers.map((w) => ({
            id: w.workerId,
            state: w.state,
            host: w.host,
            runId: w.runId,
          })),
        };
      }

      if (statusRes?.runs?.byState) {
        pulse.runs.byState = statusRes.runs.byState;
      }
      if (statusRes?.proposals?.open) {
        pulse.runs.proposed = statusRes.proposals.open;
      }

      if (runsRes?.runs) {
        pulse.runs.active = runsRes.runs.map((r) => ({
          runId: r.runId,
          agent: r.agent,
          state: r.state,
          eventId: r.eventId,
          model: r.model,
          created_at: r.created_at,
          updated_at: r.updated_at,
        }));
      }
      pulse.runs.sandboxRefusals = sandboxRefusals;
    } catch {
      // partial fetch failure handled gracefully
    }
  }

  // 4. Linear Supply
  if (fetchLinear) {
    try {
      // Find repo team from repos.yaml
      let team = "WM";
      try {
        const reposCfg = Bun.YAML.parse(
          readFileSync(path.join(ROOT, "config/repos.yaml"), "utf8"),
        );
        const match = (reposCfg.repos ?? []).find((r) => r.name === repoName);
        if (match?.team) team = match.team;
      } catch {
        /* intentionally ignored */
      }
      pulse.supply.team = team;

      if (!hasLinearKey()) {
        pulse.supply.error = "LINEAR_API_KEY not configured";
      } else {
        const d = await loadControlPlane().raw(
          `query($t:String!){
            issues(first:100, filter:{ team:{key:{eq:$t}}, state:{type:{nin:["completed","canceled"]}} }){
              nodes{ id identifier title state{ name } labels(first:20){ nodes{ name } } assignee{ name } }
            }
          }`,
          { t: team },
        );

        const nodes = d?.issues?.nodes ?? [];
        const ready = nodes.filter(
          (i) =>
            i.state?.name === "Todo" &&
            !i.assignee &&
            (i.labels?.nodes ?? []).some((l) => l.name === "ai:agent-ready"),
        );
        const triage = nodes.filter((i) => i.state?.name === "Triage");

        pulse.supply.dispatchable = ready.length;
        pulse.supply.triage = triage.length;
        pulse.supply.tickets = ready
          .slice(0, 5)
          .map((i) => ({ identifier: i.identifier, title: i.title }));
      }
    } catch (err) {
      pulse.supply.error = err.message;
    }
  }

  // 5. Open GitHub PRs
  if (fetchGitHub) {
    try {
      const prs = loadForge().prList(null, {
        state: "open",
        limit: 15,
        fields: [
          "number",
          "title",
          "headRefName",
          "isDraft",
          "statusCheckRollup",
        ],
        cwd: ROOT,
      });
      pulse.prs.total = prs.length;
      pulse.prs.candidates = prs.map((pr) => {
        const checks = pr.statusCheckRollup ?? [];
        let ciStatus = "NONE";
        if (checks.length > 0) {
          const hasFailure = checks.some((c) => c.conclusion === "FAILURE");
          const hasPending = checks.some(
            (c) => c.status === "IN_PROGRESS" || c.status === "QUEUED",
          );
          const allSuccess = checks.every((c) => c.conclusion === "SUCCESS");
          if (hasFailure) ciStatus = "FAILING";
          else if (hasPending) ciStatus = "PENDING";
          else if (allSuccess) ciStatus = "PASSING";
        }
        return {
          number: pr.number,
          title: pr.title,
          headRefName: pr.headRefName,
          isDraft: pr.isDraft,
          ciStatus,
        };
      });
    } catch {
      // forge not available or errored
    }
  }

  // 6. Workspace Freshness
  try {
    const branchRes = sh(["git", "branch", "--show-current"]);
    const headRes = sh(["git", "rev-parse", "--short", "HEAD"]);
    const statusRes = sh(["git", "status", "--porcelain"]);
    const behindRes = sh([
      "git",
      "rev-list",
      "--count",
      "HEAD..origin/develop",
    ]);
    const aheadRes = sh(["git", "rev-list", "--count", "origin/develop..HEAD"]);

    pulse.workspace = {
      branch: branchRes.ok ? branchRes.out : "unknown",
      head: headRes.ok ? headRes.out : "unknown",
      behind: behindRes.ok ? parseInt(behindRes.out, 10) || 0 : 0,
      ahead: aheadRes.ok ? parseInt(aheadRes.out, 10) || 0 : 0,
      clean: statusRes.ok && statusRes.out.length === 0,
    };
  } catch {
    /* intentionally ignored */
  }

  return pulse;
}

export function formatPulse(pulse) {
  const lines = [];
  lines.push(
    c.bold(`FACTORY PULSE — ${new Date(pulse.timestamp).toUTCString()}`),
  );
  lines.push("");

  // Stack & Workers
  lines.push(c.bold("STACK & WORKERS"));
  const apiStatus = pulse.stack.api.ok
    ? `${c.green("✓ healthy")} ${c.dim(`(policy: ${pulse.stack.api.policyVersion || "unknown"})`)}`
    : c.red("✗ down");
  lines.push(`  API (:7381):     ${apiStatus}`);

  const webPort = pulse.stack.web.port ?? 7382;
  const webStatus = pulse.stack.web.ok
    ? c.green("✓ up")
    : c.red(`✗ ${pulse.stack.web.error || "WEB_DOWN: down or unreachable"}`);
  lines.push(`  Web (:${webPort}):     ${webStatus}`);

  const workers = pulse.stack.workers;
  const workerDetail =
    workers.total > 0
      ? `${workers.total} registered (${c.green(`${workers.busy} busy`)}, ${workers.idle} idle)`
      : c.yellow("0 registered");
  lines.push(`  Workers:         ${workerDetail}`);
  const sandboxRefusals = pulse.runs.sandboxRefusals ?? [];
  if (sandboxRefusals.length > 0) {
    const agents = [...new Set(sandboxRefusals.map((entry) => entry.agent))]
      .sort()
      .join(", ");
    lines.push(
      `  ${c.red("Scan loops refused: sandbox unavailable")} (${agents})`,
    );
  }
  lines.push("");

  // In-Flight Runs
  const activeRuns = pulse.runs.active;
  lines.push(
    c.bold(
      `IN-FLIGHT RUNS (${activeRuns.length} active, ${pulse.runs.proposed} proposed)`,
    ),
  );
  if (activeRuns.length === 0) {
    lines.push(c.dim("  No runs currently executing"));
  } else {
    for (const r of activeRuns) {
      const ageMs = Date.now() - new Date(r.created_at || Date.now()).getTime();
      const ageMin = Math.round(ageMs / 60000);
      lines.push(
        `  ${c.cyan(r.runId.slice(0, 12))} ${c.bold(r.agent)} [${r.state}] (${ageMin}m) ${c.dim(r.eventId || "")}`,
      );
    }
  }
  lines.push("");

  // Linear Supply
  lines.push(c.bold(`LINEAR SUPPLY (${pulse.supply.team || "WM"})`));
  if (pulse.supply.error) {
    lines.push(`  ${c.red("Linear read error:")} ${pulse.supply.error}`);
  } else {
    const supplyColor =
      pulse.supply.dispatchable >= 5
        ? c.green
        : pulse.supply.dispatchable > 0
          ? c.yellow
          : c.red;
    lines.push(
      `  Dispatchable:    ${supplyColor(`${pulse.supply.dispatchable} tickets`)} in Todo (ai:agent-ready, unassigned)`,
    );
    lines.push(`  Triage Backlog:  ${pulse.supply.triage} tickets in Triage`);
    if (pulse.supply.tickets.length > 0) {
      lines.push(c.dim("  Next up:"));
      for (const t of pulse.supply.tickets) {
        lines.push(`    ${c.bold(t.identifier)}  ${t.title}`);
      }
    }
  }
  lines.push("");

  // Open PRs
  lines.push(c.bold(`OPEN PULL REQUESTS (${pulse.prs.total} open)`));
  if (pulse.prs.candidates.length === 0) {
    lines.push(c.dim("  No open pull requests"));
  } else {
    for (const pr of pulse.prs.candidates.slice(0, 8)) {
      let ciBadge = c.dim("[NO CI]");
      if (pr.ciStatus === "PASSING") ciBadge = c.green("[CI PASS]");
      else if (pr.ciStatus === "FAILING") ciBadge = c.red("[CI FAIL]");
      else if (pr.ciStatus === "PENDING") ciBadge = c.yellow("[CI PENDING]");

      const draftBadge = pr.isDraft ? c.dim("(draft) ") : "";
      lines.push(
        `  ${c.bold(`#${pr.number}`)} ${ciBadge} ${draftBadge}${pr.title.slice(0, 60)}`,
      );
    }
  }
  lines.push("");

  // Workspace
  lines.push(c.bold("WORKSPACE"));
  const cleanStatus = pulse.workspace.clean
    ? c.green("clean")
    : c.yellow("dirty (uncommitted changes)");
  const syncStatus =
    pulse.workspace.behind > 0
      ? c.yellow(`behind origin/develop by ${pulse.workspace.behind}`)
      : pulse.workspace.ahead > 0
        ? c.cyan(`ahead of origin/develop by ${pulse.workspace.ahead}`)
        : c.green("up to date");
  lines.push(
    `  Branch:          ${c.bold(pulse.workspace.branch)} @ ${pulse.workspace.head} (${syncStatus})`,
  );
  lines.push(`  Working tree:    ${cleanStatus}`);

  return lines.join("\n");
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const jsonOut = argv.includes("--json");
  const repoIdx = argv.indexOf("--repo");
  const repoName = repoIdx !== -1 ? argv[repoIdx + 1] : "factory";

  const pulse = await gatherPulse({ repoName });
  if (jsonOut) {
    console.log(JSON.stringify(pulse, null, 2));
  } else {
    console.log(formatPulse(pulse));
  }
}
