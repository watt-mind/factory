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
import {
  controlApi,
  controlApiFailureCode,
  fetchRecentSandboxRefusals,
} from "./watchdog.mjs";

const c = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

const LINEAR_SUPPLY_PAGE_SIZE = 100;
const MAX_LINEAR_SUPPLY_PAGES = 5;
const ONE_HOUR_MS = 3600_000;
const QUEUED_RUN_STATUSES = new Set([
  "queued",
  "waiting",
  "pending",
  "requested",
]);

function toNonNegativeFinite(value, fallback = 0) {
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    typeof value === "boolean"
  ) {
    return fallback;
  }
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, num);
}

/**
 * Compute CI runner / merge-queue capacity verdict and headroom metrics.
 */
export function computeCapacity({
  queuedRuns = 0,
  activeRuns = 0,
  runnerCap = 8,
  openReadyPrs = 0,
  mergedLastHour = 0,
  mergeBatchSize = 8,
} = {}) {
  const safeQueuedRuns = toNonNegativeFinite(queuedRuns);
  const safeActiveRuns = toNonNegativeFinite(activeRuns);
  const safeRunnerCap = toNonNegativeFinite(runnerCap);
  const safeOpenReadyPrs = toNonNegativeFinite(openReadyPrs);
  const safeMergedLastHour = toNonNegativeFinite(mergedLastHour);
  const safeMergeBatchSize = toNonNegativeFinite(mergeBatchSize);

  const runnerHeadroom = Math.max(0, safeRunnerCap - safeActiveRuns);
  const queuePressure = safeActiveRuns + safeQueuedRuns;

  let verdict = "WIDEN";
  let reason = `Runner headroom available (${runnerHeadroom} slots free) and open-PR queue (${safeOpenReadyPrs}/${safeMergeBatchSize}) allow widening or continuing dispatch`;
  if (safeOpenReadyPrs >= safeMergeBatchSize) {
    verdict = "DRAIN_MERGES_FIRST";
    reason = `Open ready PRs (${safeOpenReadyPrs} >= ${safeMergeBatchSize} merge batch size); /factory-merge must drain before widening dispatch`;
  } else if (safeQueuedRuns > 0 || safeActiveRuns >= safeRunnerCap) {
    verdict = "HOLD_OR_BUNDLE";
    reason = `CI runner pool pressure (${safeActiveRuns}/${safeRunnerCap} active, ${safeQueuedRuns} queued, ${queuePressure} total); hold new singles or coalesce cohesive tickets into bundles`;
  }

  return {
    runnerCap: safeRunnerCap,
    activeRuns: safeActiveRuns,
    queuedRuns: safeQueuedRuns,
    runnerHeadroom,
    openReadyPrs: safeOpenReadyPrs,
    mergeBatchSize: safeMergeBatchSize,
    mergedLastHour: safeMergedLastHour,
    verdict,
    reason,
  };
}

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
  forge = null,
  runnerCap = 8,
  mergeBatchSize = 8,
  now = Date.now(),
  controlPlane,
  webFetch = globalThis.fetch,
  workspaceProbe = sh,
  workspaceCwd = ROOT,
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
      truncated: false,
    },
    prs: { total: 0, candidates: [] },
    capacity: {
      ...computeCapacity({ runnerCap, mergeBatchSize }),
      available: false,
    },
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
    const healthJson = await controlApi("/health", { host, port });
    pulse.stack.api = {
      ok: true,
      policyVersion: healthJson.policyVersion,
      env: healthJson.env?.name,
    };
  } catch (err) {
    const code = controlApiFailureCode(err);
    pulse.stack.api = { ok: false, code, error: `${code}: ${err.message}` };
  }

  // 2. Web UI Health
  try {
    const webRes = await webFetch(`http://${host}:${webPort}/`, {
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
          controlApi("/status", { host, port }),
          controlApi("/workers", { host, port }),
          controlApi("/runs?state=RUNNING", { host, port }),
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
    } catch (err) {
      const code = controlApiFailureCode(err);
      // A failed protected read (auth, control lock, timeout, 5xx) is not an
      // idle factory. Surface it to the operator instead of leaving the
      // default empty workers/runs values, keeping what /health told us.
      pulse.stack.api = {
        ...pulse.stack.api,
        ok: false,
        code,
        error: `${code}: ${err.message}`,
      };
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

      if (!controlPlane && !hasLinearKey()) {
        pulse.supply.error = "LINEAR_API_KEY not configured";
      } else {
        const linear = controlPlane ?? loadControlPlane();
        const ready = [];
        const triage = [];
        let after = null;

        for (let page = 0; page < MAX_LINEAR_SUPPLY_PAGES; page += 1) {
          const d = await linear.raw(
            `query($t:String!,$after:String){
              issues(first:${LINEAR_SUPPLY_PAGE_SIZE}, after:$after, filter:{ team:{key:{eq:$t}}, state:{name:{in:["Todo","Triage"]}} }){
                nodes{ id identifier title state{ name } labels(first:20){ nodes{ name } } assignee{ name } }
                pageInfo{ hasNextPage endCursor }
              }
            }`,
            { t: team, after },
          );

          const issues = d?.issues?.nodes ?? [];
          ready.push(
            ...issues.filter(
              (i) =>
                i.state?.name === "Todo" &&
                !i.assignee &&
                (i.labels?.nodes ?? []).some(
                  (l) => l.name === "ai:agent-ready",
                ),
            ),
          );
          triage.push(...issues.filter((i) => i.state?.name === "Triage"));

          const pageInfo = d?.issues?.pageInfo;
          if (!pageInfo?.hasNextPage) break;
          if (page === MAX_LINEAR_SUPPLY_PAGES - 1 || !pageInfo.endCursor) {
            pulse.supply.truncated = true;
            break;
          }
          after = pageInfo.endCursor;
        }

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

  // 5. Open GitHub PRs & Capacity / Flow Probe
  let activeForge = forge;
  let ciRunError = null;
  if (!activeForge && fetchGitHub) {
    try {
      activeForge = loadForge();
    } catch (err) {
      ciRunError = err?.message ?? String(err);
    }
  }

  let openReadyPrs = 0;
  let activeRuns = 0;
  let queuedRuns = 0;
  let mergedLastHour = 0;
  let openPrError = null;
  let mergedError = null;

  if (activeForge) {
    try {
      const openLimit = Math.max(15, toNonNegativeFinite(mergeBatchSize, 8));
      const prs = activeForge.prList(null, {
        state: "open",
        limit: openLimit,
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
      openReadyPrs = pulse.prs.candidates.filter(
        (pr) => !pr.isDraft && pr.ciStatus !== "FAILING",
      ).length;
    } catch (err) {
      openPrError = err?.message ?? String(err);
      pulse.prs.error = openPrError;
    }

    try {
      const ciRuns = activeForge.runList(null, {
        limit: 40,
        fields: ["databaseId", "status", "conclusion", "createdAt"],
        cwd: ROOT,
      });
      for (const run of ciRuns ?? []) {
        const status = String(run?.status ?? "").toLowerCase();
        if (status === "in_progress") activeRuns += 1;
        else if (QUEUED_RUN_STATUSES.has(status)) queuedRuns += 1;
      }
    } catch (err) {
      ciRunError = err?.message ?? String(err);
    }

    try {
      const mergedPrs = activeForge.prList(null, {
        state: "merged",
        limit: 20,
        fields: ["number", "mergedAt"],
        cwd: ROOT,
      });
      const parsedNow =
        now instanceof Date
          ? now.getTime()
          : typeof now === "number"
            ? now
            : Date.parse(now);
      const effectiveNow = Number.isFinite(parsedNow) ? parsedNow : Date.now();
      const hourAgo = effectiveNow - ONE_HOUR_MS;
      for (const pr of mergedPrs ?? []) {
        const mergedAtMs = pr?.mergedAt ? Date.parse(pr.mergedAt) : Number.NaN;
        if (
          Number.isFinite(mergedAtMs) &&
          mergedAtMs >= hourAgo &&
          mergedAtMs <= effectiveNow
        ) {
          mergedLastHour += 1;
        }
      }
    } catch (err) {
      mergedError = err?.message ?? String(err);
    }
  }

  const capacityErrors = [openPrError, ciRunError, mergedError].filter(Boolean);
  if (capacityErrors.length > 0) {
    pulse.errors = capacityErrors;
  }
  pulse.capacity = {
    ...computeCapacity({
      queuedRuns,
      activeRuns,
      runnerCap,
      openReadyPrs,
      mergedLastHour,
      mergeBatchSize,
    }),
    available: Boolean(activeForge && !ciRunError),
    ...(ciRunError ? { ciRunError } : {}),
    ...(mergedError ? { mergedError } : {}),
    ...(openPrError ? { openPrError } : {}),
  };

  // 6. Workspace Freshness
  try {
    const branchRes = workspaceProbe(
      ["git", "branch", "--show-current"],
      workspaceCwd,
    );
    const headRes = workspaceProbe(
      ["git", "rev-parse", "--short", "HEAD"],
      workspaceCwd,
    );
    const statusRes = workspaceProbe(
      ["git", "status", "--porcelain"],
      workspaceCwd,
    );
    const behindRes = workspaceProbe(
      ["git", "rev-list", "--count", "HEAD..origin/develop"],
      workspaceCwd,
    );
    const aheadRes = workspaceProbe(
      ["git", "rev-list", "--count", "origin/develop..HEAD"],
      workspaceCwd,
    );

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
    if (pulse.supply.truncated) {
      lines.push(c.yellow("  Supply counts:   (truncated)"));
    }
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

  // Capacity & Flow
  lines.push(c.bold("CAPACITY & FLOW"));
  if (!pulse.capacity) {
    lines.push(c.dim("  Capacity telemetry unavailable"));
  } else {
    const cap = pulse.capacity;
    const verdictColor =
      cap.verdict === "WIDEN"
        ? c.green
        : cap.verdict === "HOLD_OR_BUNDLE"
          ? c.yellow
          : c.red;
    if (cap.available === false) {
      const errDetail = cap.ciRunError || cap.mergedError || cap.openPrError;
      lines.push(
        c.yellow(
          errDetail
            ? `  Status:          unavailable (${errDetail})`
            : "  Status:          unavailable (GitHub offline)",
        ),
      );
    } else if (cap.mergedError || cap.openPrError) {
      const errDetail = cap.mergedError || cap.openPrError;
      lines.push(c.yellow(`  Warning:         partial read (${errDetail})`));
    }
    lines.push(
      `  CI Runs:         ${cap.activeRuns}/${cap.runnerCap} active, ${cap.queuedRuns} queued, ${cap.runnerHeadroom} headroom`,
    );
    lines.push(
      `  Open Ready PRs:  ${cap.openReadyPrs}/${cap.mergeBatchSize} merge batch`,
    );
    lines.push(`  Merged (1h):     ${cap.mergedLastHour}`);
    lines.push(
      `  Verdict:         ${verdictColor(cap.verdict)} — ${cap.reason}`,
    );
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
