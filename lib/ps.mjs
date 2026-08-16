/**
 * Core inspection logic for 'factory ps'.
 * Discovers factory control-plane services, event runtime workers & runs,
 * agent sessions, worktree dev servers, and listening ports.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { API_HOST, DEFAULT_PORT } from "../event-runtime/lib/config.mjs";
import { factoryRoot } from "./factory-root.mjs";

export const c = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  magenta: (s) => `\x1b[35m${s}\x1b[0m`,
  blue: (s) => `\x1b[34m${s}\x1b[0m`,
};

export const noColors = {
  bold: (s) => String(s),
  dim: (s) => String(s),
  green: (s) => String(s),
  yellow: (s) => String(s),
  red: (s) => String(s),
  cyan: (s) => String(s),
  magenta: (s) => String(s),
  blue: (s) => String(s),
};

export const pad = (val, width) => String(val ?? "-").padEnd(width);
export const cell = (val, width) => `${pad(val, width)}  `;
const expand = (p, home = osHomedir()) => (p ? String(p).replace(/^~/, home) : p);

/**
 * Parse lines from `ps -axo pid,ppid,%cpu,%mem,etime,command`
 */
export function parsePs(raw) {
  if (!raw) return [];
  const lines = String(raw).trim().split("\n");
  const procs = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("PID") || trimmed.startsWith("pid")) continue;
    // Format: PID PPID %CPU %MEM ETIME COMMAND...
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\S+)\s+(.+)$/);
    if (!match) continue;
    const [, pidStr, ppidStr, cpuStr, memStr, etime, command] = match;
    procs.push({
      pid: Number(pidStr),
      ppid: Number(ppidStr),
      cpu: Number(cpuStr),
      mem: Number(memStr),
      etime,
      command,
    });
  }
  return procs;
}

/**
 * Parse lines from `lsof -iTCP -sTCP:LISTEN -n -P`
 */
export function parseLsof(raw) {
  if (!raw) return [];
  const lines = String(raw).trim().split("\n");
  const entries = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("COMMAND") || trimmed.startsWith("command")) continue;
    // Example: bun 80301 hdkiller 12u IPv4 0x... 0t0 TCP 127.0.0.1:7404 (LISTEN)
    // or: Google Chrome 671 hdkiller 11u IPv6 0x... 0t0 TCP *:60840 (LISTEN)
    const parts = trimmed.split(/\s+/);
    const tcpIndex = parts.lastIndexOf("TCP");
    if (tcpIndex < 7) continue;

    const proto = parts[tcpIndex - 3];
    if (proto !== "IPv4" && proto !== "IPv6") continue;

    const pid = Number(parts[tcpIndex - 6]);
    const command = parts.slice(0, tcpIndex - 6).join(" ");
    if (!command || Number.isNaN(pid)) continue;

    const nameCol = parts.slice(tcpIndex + 1).join(" ");
    const cleanName = nameCol.replace(/\s*\(LISTEN\)\s*$/i, "").trim();
    const portMatch = cleanName.match(/:(\d+)$/);
    if (!portMatch) continue;
    const port = Number(portMatch[1]);
    if (Number.isNaN(port)) continue;

    let host = "*";
    if (cleanName.includes("127.0.0.1")) host = "127.0.0.1";
    else if (cleanName.includes("[::1]")) host = "::1";
    else if (cleanName.includes("0.0.0.0")) host = "0.0.0.0";

    entries.push({
      command,
      pid,
      port,
      host,
      raw: trimmed,
    });
  }
  return entries;
}

/** Extract ticket ID from string if present (e.g. OPS-402, CLNT-1393, LAB-176) */
export function extractTicket(str) {
  if (!str) return null;
  const m = String(str).match(/\b([A-Z]{2,6}-\d+)\b/);
  return m ? m[1] : null;
}

/** Extract --port N flag value from a command string */
export function extractPortFlag(command) {
  if (!command) return null;
  const m = String(command).match(/(?:--port|-p)\s+([0-9]+)/);
  return m ? Number(m[1]) : null;
}

/** Extract --adapter-override flag value from command */
export function extractAdapterOverride(command) {
  if (!command) return null;
  const m = String(command).match(/--adapter-override\s+([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

/** Extract worktree / repo path from command */
export function extractWorktreePath(command, home = osHomedir()) {
  if (!command) return null;
  const expanded = expand(command, home);
  const wtMatch = expanded.match(/(\/[^\s]+(?:\.worktrees\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+))/);
  if (wtMatch) return wtMatch[1];
  const devMatch = expanded.match(/(\/[^\s]+(?:Develop\/[a-zA-Z0-9_.-]+))/);
  if (devMatch) return devMatch[1];
  return null;
}

/**
 * Categorize a single process from `ps`
 */
export function categorizeProcess(proc, { worktrees = [], repos = [], home = osHomedir() } = {}) {
  const cmd = proc.command;

  // Ignore Electron desktop helper processes for Claude / ChatGPT chrome extension
  if (
    cmd.includes("Claude Helper") ||
    cmd.includes("ChatGPT for Chrome") ||
    cmd.includes("claudefordesktop.ShipIt") ||
    cmd.includes("/Applications/Claude.app/") ||
    cmd.includes("Library/Application Support/Claude/")
  ) {
    return { kind: "ignored", service: "desktop-app", proc };
  }

  // Find if process PID matches any known worktree pidfile
  const matchingWt = worktrees.find((wt) =>
    Object.values(wt.pids || {}).includes(proc.pid) || (wt.path && cmd.includes(wt.path)),
  );

  // 1. Control Plane Services
  if (cmd.includes("event-runtime/cli.mjs serve") || cmd.includes("event-runtime/cli.js serve")) {
    const port = extractPortFlag(cmd);
    const adapter = extractAdapterOverride(cmd);
    const worktree = matchingWt?.path ?? extractWorktreePath(cmd, home);
    const ticket = matchingWt?.ticket ?? (extractTicket(cmd) || extractTicket(worktree));
    return {
      kind: "control-plane",
      service: "serve",
      subservice: "API Server",
      port,
      adapter,
      worktree,
      ticket,
      proc,
    };
  }

  if (cmd.includes("event-runtime/web/serve.mjs") || cmd.includes("event-runtime/web/serve.js")) {
    const port = extractPortFlag(cmd);
    const worktree = matchingWt?.path ?? extractWorktreePath(cmd, home);
    const ticket = matchingWt?.ticket ?? (extractTicket(cmd) || extractTicket(worktree));
    return {
      kind: "control-plane",
      service: "web",
      subservice: "Web UI Server",
      port,
      worktree,
      ticket,
      proc,
    };
  }

  if (cmd.includes("event-runtime/cli.mjs work") || cmd.includes("event-runtime/cli.js work")) {
    const adapter = extractAdapterOverride(cmd);
    const worktree = matchingWt?.path ?? extractWorktreePath(cmd, home);
    const ticket = matchingWt?.ticket ?? (extractTicket(cmd) || extractTicket(worktree));
    return {
      kind: "control-plane",
      service: "worker",
      subservice: "Event Worker",
      adapter,
      worktree,
      ticket,
      proc,
    };
  }

  // 2. Vite / Dev servers running inside event-runtime/web
  if (cmd.includes("vite") && (cmd.includes("event-runtime/web") || cmd.includes("factory"))) {
    const port = extractPortFlag(cmd);
    const worktree = matchingWt?.path ?? extractWorktreePath(cmd, home);
    const ticket = matchingWt?.ticket ?? (extractTicket(cmd) || extractTicket(worktree));
    return {
      kind: "control-plane",
      service: "web",
      subservice: "Vite Dev Server",
      port,
      worktree,
      ticket,
      proc,
    };
  }

  // 3. Agent Harnesses & CLI Runners
  if (cmd.includes("runners/run-agent.sh")) {
    const ticket = extractTicket(cmd) || matchingWt?.ticket;
    const worktree = matchingWt?.path ?? extractWorktreePath(cmd, home);
    return {
      kind: "agent",
      harness: "run-agent.sh",
      service: "agent-runner",
      ticket,
      worktree,
      proc,
    };
  }

  // CLI Claude runs (e.g. `claude -p` or bare `claude` in an interactive shell)
  if (/(?:^|\/|\s)claude(?:\s|$)/.test(cmd) && !cmd.includes("/Applications/") && !cmd.includes("Helper")) {
    const ticket = extractTicket(cmd) || matchingWt?.ticket;
    const worktree = matchingWt?.path ?? extractWorktreePath(cmd, home);
    return {
      kind: "agent",
      harness: "claude-code",
      service: "claude-session",
      ticket,
      worktree,
      proc,
    };
  }

  // Factory orchestrators / tools
  if (
    cmd.includes("orchestrator/tick.mjs") ||
    cmd.includes("orchestrator/janitor.mjs") ||
    cmd.includes("orchestrator/reaper.mjs") ||
    cmd.includes("orchestrator/doctor.mjs") ||
    cmd.includes("tools/dispatch.mjs")
  ) {
    const script = cmd.match(/(?:orchestrator|tools)\/([a-zA-Z0-9_-]+)\.mjs/)?.[1] ?? "orchestrator";
    const ticket = extractTicket(cmd) || matchingWt?.ticket;
    return {
      kind: "agent",
      harness: "factory-tool",
      service: script,
      ticket,
      proc,
    };
  }

  // 4. Worktree Dev Processes (Next, Nuxt, Django, Vite, Node/Bun apps inside worktree directories)
  if (matchingWt || cmd.includes(".worktrees/")) {
    const port = extractPortFlag(cmd);
    const ticket = extractTicket(cmd) || matchingWt?.ticket;
    const worktree = matchingWt?.path || extractWorktreePath(cmd, home);
    let devType = "dev-server";
    if (cmd.includes("vite")) devType = "vite";
    else if (cmd.includes("next")) devType = "next";
    else if (cmd.includes("nuxt")) devType = "nuxt";
    else if (cmd.includes("manage.py")) devType = "django";
    else if (cmd.includes("prisma")) devType = "prisma";
    else if (cmd.includes("postgres")) devType = "postgres";

    let repo = matchingWt?.repo;
    if (!repo && worktree) {
      const wtMatch = worktree.match(/\.worktrees\/([a-zA-Z0-9_.-]+)\//);
      if (wtMatch) {
        repo = wtMatch[1];
      } else {
        const devMatch = worktree.match(/Develop\/([a-zA-Z0-9_.-]+)/);
        if (devMatch) repo = devMatch[1];
      }
    }

    return {
      kind: "worktree-dev",
      service: devType,
      repo: repo ?? null,
      ticket,
      worktree,
      port,
      proc,
    };
  }

  return { kind: "other", proc };
}

/** Read the POSIX process state and full command for a PID. */
function inspectPidWithPs(pid) {
  const result = spawnSync("ps", ["-o", "stat=", "-o", "command=", "-p", String(pid)], {
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  return String(result.stdout ?? "").trim() || null;
}

/** Check that a PID is alive, non-zombie, and still belongs to the expected daemon. */
export function isPidAlive(
  pid,
  expectedCommand = null,
  { inspectPid = inspectPidWithPs, kill = process.kill, platform = process.platform } = {},
) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;

  try {
    kill(numericPid, 0);
  } catch {
    return false;
  }

  // Windows has no POSIX `ps`; signal 0 remains the best available check there.
  if (platform === "win32") return true;

  try {
    const processInfo = inspectPid(numericPid);
    const match = String(processInfo ?? "").trim().match(/^(\S+)\s+(.+)$/s);
    if (!match) return false;

    const [, state, command] = match;
    if (state.toUpperCase().includes("Z") || command.toLowerCase().includes("<defunct>")) return false;
    return expectedCommand ? command.includes(expectedCommand) : true;
  } catch {
    return false;
  }
}

const WORKTREE_DAEMON_SIGNATURES = {
  serve: "event-runtime/cli.mjs serve",
  worker: "event-runtime/cli.mjs work",
  web: "event-runtime/web/serve.mjs",
};

/**
 * Scan worktrees across configured repos
 */
export function scanWorktrees({
  reposYamlPath,
  worktreeRootFallback = "~/Develop/.worktrees",
  home = osHomedir(),
} = {}) {
  const result = [];
  const repos = [];

  if (reposYamlPath && existsSync(reposYamlPath)) {
    try {
      const parsed = Bun.YAML.parse(readFileSync(reposYamlPath, "utf8"));
      if (Array.isArray(parsed?.repos)) repos.push(...parsed.repos);
    } catch {
      // Fallback
    }
  }

  const rootsToScan = new Set();
  for (const r of repos) {
    if (r.worktree_root) rootsToScan.add(expand(r.worktree_root, home));
    if (r.path) {
      const expPath = expand(r.path, home);
      const parentWt = path.join(path.dirname(expPath), ".worktrees", r.name);
      if (existsSync(parentWt)) rootsToScan.add(parentWt);
    }
  }

  const fallback = expand(worktreeRootFallback, home);
  if (existsSync(fallback)) {
    try {
      for (const entry of readdirSync(fallback, { withFileTypes: true })) {
        if (entry.isDirectory()) rootsToScan.add(path.join(fallback, entry.name));
      }
    } catch {
      // ignore
    }
  }

  for (const rootDir of rootsToScan) {
    if (!existsSync(rootDir)) continue;
    try {
      const entries = readdirSync(rootDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const wtPath = path.join(rootDir, entry.name);
        const repoName = path.basename(rootDir);
        const name = entry.name;
        const ticket = extractTicket(name);

        // Read branch name if .git exists
        let branch = "-";
        const gitPath = path.join(wtPath, ".git");
        if (existsSync(gitPath)) {
          try {
            const gitContent = readFileSync(gitPath, "utf8").trim();
            if (gitContent.startsWith("gitdir:")) {
              const gitDir = gitContent.slice("gitdir:".length).trim();
              const headPath = path.isAbsolute(gitDir) ? path.join(gitDir, "HEAD") : path.join(wtPath, gitDir, "HEAD");
              if (existsSync(headPath)) {
                const headRef = readFileSync(headPath, "utf8").trim();
                branch = headRef.replace(/^ref:\s*refs\/heads\//, "");
              }
            }
          } catch {
            branch = "-";
          }
        }

        // Check .factory/run/ pid files
        const pids = {};
        const runDir = path.join(wtPath, ".factory/run");
        if (existsSync(runDir)) {
          for (const s of ["serve", "worker", "web"]) {
            const pidFile = path.join(runDir, `${s}.pid`);
            if (existsSync(pidFile)) {
              try {
                const p = Number(readFileSync(pidFile, "utf8").trim());
                if (isPidAlive(p, WORKTREE_DAEMON_SIGNATURES[s])) pids[s] = p;
              } catch {
                // ignore
              }
            }
          }
        }

        result.push({
          repo: repoName,
          name,
          path: wtPath,
          branch,
          ticket,
          pids,
          active: Object.keys(pids).length > 0,
        });
      }
    } catch {
      // ignore directory scan errors
    }
  }

  return { repos, worktrees: result };
}

/**
 * Probe a Control API on host:port
 */
export async function probeControlApi({ host = API_HOST, port = DEFAULT_PORT, timeoutMs = 800 } = {}) {
  const base = `http://${host}:${port}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${base}/status`, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const statusData = await res.json();

    let workers = [];
    try {
      const wRes = await fetch(`${base}/workers`, { signal: controller.signal });
      if (wRes.ok) {
        const wJson = await wRes.json();
        workers = wJson.workers ?? [];
      }
    } catch {
      // ignore
    }

    let runs = [];
    try {
      const rRes = await fetch(`${base}/runs`, { signal: controller.signal });
      if (rRes.ok) {
        const rJson = await rRes.json();
        runs = rJson.runs ?? [];
      }
    } catch {
      // ignore
    }

    return {
      online: true,
      port,
      host,
      env: statusData.env ?? null,
      events: statusData.events ?? null,
      proposals: statusData.proposals ?? null,
      runsCount: statusData.runs ?? null,
      workersCount: statusData.workers ?? null,
      anomalies: statusData.anomalies ?? null,
      workers,
      runs,
    };
  } catch (err) {
    return {
      online: false,
      port,
      host,
      error: err.name === "AbortError" ? "timed out" : err.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Collect complete snapshot of factory processes, ports, workers, and active runs
 */
export async function collectFactoryPsSnapshot({
  psOutput = null,
  lsofOutput = null,
  customPort = null,
  root = factoryRoot(),
  home = osHomedir(),
  fetchApi = true,
} = {}) {
  // 1. Run OS commands if raw outputs not injected
  const rawPs =
    psOutput ??
    (() => {
      try {
        const r = spawnSync("ps", ["-axo", "pid,ppid,%cpu,%mem,etime,command"], { encoding: "utf8" });
        return r.stdout ?? "";
      } catch {
        return "";
      }
    })();

  const rawLsof =
    lsofOutput ??
    (() => {
      try {
        const r = spawnSync("lsof", ["-iTCP", "-sTCP:LISTEN", "-n", "-P"], { encoding: "utf8" });
        return r.stdout ?? "";
      } catch {
        return "";
      }
    })();

  const processes = parsePs(rawPs);
  const listeningPorts = parseLsof(rawLsof);

  // 2. Discover configured repos and worktrees
  const reposYamlPath = path.join(root, "config/repos.yaml");
  const { repos, worktrees } = scanWorktrees({ reposYamlPath, home });

  // 3. Categorize processes
  const categorized = processes
    .map((p) => categorizeProcess(p, { worktrees, repos, home }))
    .filter((c) => c.kind !== "ignored" && c.kind !== "other");

  // Correlate control plane daemons & listening ports
  const controlPlane = [];
  const agentSessions = [];
  const devServers = [];

  for (const item of categorized) {
    const { proc, kind, service, port, adapter, worktree, ticket, harness, subservice } = item;

    if (kind === "control-plane") {
      let resolvedPort = port;
      if (!resolvedPort) {
        const portEntry = listeningPorts.find((lp) => lp.pid === proc.pid);
        if (portEntry) resolvedPort = portEntry.port;
      }
      // If still not resolved and not associated with a specific worktree, fallback to default port
      if (!resolvedPort && !worktree && service === "serve") {
        resolvedPort = DEFAULT_PORT;
      }

      controlPlane.push({
        service,
        subservice: subservice ?? service,
        pid: proc.pid,
        ppid: proc.ppid,
        port: resolvedPort ?? null,
        adapter: adapter ?? null,
        worktree: worktree ?? null,
        ticket: ticket ?? null,
        uptime: proc.etime,
        cpu: `${proc.cpu}%`,
        mem: `${proc.mem}%`,
        command: proc.command,
      });
    } else if (kind === "agent") {
      agentSessions.push({
        pid: proc.pid,
        harness: harness ?? "agent",
        service,
        ticket: ticket ?? null,
        worktree: worktree ?? null,
        uptime: proc.etime,
        cpu: `${proc.cpu}%`,
        mem: `${proc.mem}%`,
        command: proc.command,
      });
    } else if (kind === "worktree-dev") {
      let resolvedPort = port;
      if (!resolvedPort) {
        const portEntry = listeningPorts.find((lp) => lp.pid === proc.pid);
        if (portEntry) resolvedPort = portEntry.port;
      }
      devServers.push({
        pid: proc.pid,
        service,
        repo: item.repo ?? null,
        ticket: ticket ?? null,
        worktree: worktree ?? null,
        port: resolvedPort ?? null,
        uptime: proc.etime,
        cpu: `${proc.cpu}%`,
        mem: `${proc.mem}%`,
        command: proc.command,
      });
    }
  }

  // 5. Query candidate Control APIs
  const candidatePorts = new Set();
  if (customPort) candidatePorts.add(Number(customPort));
  candidatePorts.add(DEFAULT_PORT);

  for (const cp of controlPlane) {
    if (cp.service === "serve" && cp.port) candidatePorts.add(cp.port);
  }

  // Also check ports in 7381..7800 from listeningPorts that match bun/node
  for (const lp of listeningPorts) {
    if (lp.port >= 7381 && lp.port <= 7800 && (lp.command.includes("bun") || lp.command.includes("node"))) {
      candidatePorts.add(lp.port);
    }
  }

  const apiProbes = [];
  if (fetchApi) {
    const probePromises = Array.from(candidatePorts).map((p) => probeControlApi({ port: p }));
    const results = await Promise.allSettled(probePromises);
    for (const res of results) {
      if (res.status === "fulfilled" && res.value) {
        apiProbes.push(res.value);
      }
    }
  }

  // Extract all active runs and workers across live probed APIs
  const allWorkers = [];
  const inFlightRuns = [];

  for (const probe of apiProbes) {
    if (!probe.online) continue;
    if (Array.isArray(probe.workers)) {
      for (const w of probe.workers) {
        allWorkers.push({ ...w, apiPort: probe.port });
      }
    }
    if (Array.isArray(probe.runs)) {
      for (const r of probe.runs) {
        if (r.state === "RUNNING" || r.state === "LEASED" || r.state === "PROPOSED") {
          inFlightRuns.push({ ...r, apiPort: probe.port });
        }
      }
    }
  }

  // Summary counts
  const summary = {
    controlServices: controlPlane.length,
    activeWorkers: allWorkers.filter((w) => !w.stale).length,
    activeRuns: inFlightRuns.filter((r) => r.state === "RUNNING" || r.state === "LEASED").length,
    activeAgents: agentSessions.length,
    activeWorktrees: worktrees.filter((w) => w.active).length,
    totalWorktrees: worktrees.length,
    listeningPorts: listeningPorts.length,
  };

  return {
    timestamp: new Date().toISOString(),
    controlPlane,
    apiProbes,
    workers: allWorkers,
    runs: inFlightRuns,
    agents: agentSessions,
    devServers,
    worktrees,
    ports: listeningPorts,
    summary,
  };
}

/**
 * Format the PS snapshot into high-signal human terminal output
 */
export function formatFactoryPsReport(snapshot, { colors = true, all = false, repo = null } = {}) {
  const col = colors ? c : noColors;
  const out = [];

  out.push(col.bold("factory ps") + col.dim(` — ${snapshot.timestamp}`));

  // 1. Control Plane & Daemons
  out.push(col.bold("\nCONTROL PLANE & DAEMONS"));
  if (snapshot.controlPlane.length === 0) {
    out.push(col.dim("  no active control plane daemons (start API with: factory serve)"));
  } else {
    out.push(
      `  ${cell("SERVICE", 16)}${cell("PID", 8)}${cell("PORT", 8)}${cell("UPTIME", 12)}${cell("CPU/MEM", 12)}${cell("SCOPE/TICKET", 22)}STATUS`,
    );
    for (const cp of snapshot.controlPlane) {
      if (repo && cp.worktree && !cp.worktree.includes(repo)) continue;
      const apiProbe = snapshot.apiProbes.find((p) => p.port === cp.port);
      let status = col.green("running");
      if (cp.service === "serve") {
        if (apiProbe) {
          status = apiProbe.online ? col.green("online") : col.red("offline");
        } else {
          status = col.green("running");
        }
      }
      const scope = cp.ticket ?? (cp.worktree ? path.basename(cp.worktree) : "main");
      out.push(
        `  ${col.cyan(cell(cp.subservice, 16))}${cell(cp.pid, 8)}${cell(cp.port ?? "-", 8)}${cell(cp.uptime, 12)}${cell(`${cp.cpu}/${cp.mem}`, 12)}${cell(scope, 22)}${status}`,
      );
    }
  }

  // Control APIs summary
  for (const probe of snapshot.apiProbes) {
    if (probe.online) {
      const envStr = probe.env ? `${probe.env.name} (adapter: ${probe.env.adapter ?? "live"})` : "live";
      const wCount = probe.workersCount ? `${probe.workersCount.live ?? 0} live (${probe.workersCount.busy ?? 0} busy)` : "none";
      const rCount = probe.runsCount?.byState
        ? Object.entries(probe.runsCount.byState)
            .map(([k, v]) => `${k}:${v}`)
            .join(" ")
        : "none";
      out.push(col.dim(`  └─ API :${probe.port} [${envStr}]  workers: ${wCount}  runs: ${rCount}`));
    }
  }

  // 2. Event Runtime Workers & In-Flight Runs
  if (snapshot.workers.length > 0 || snapshot.runs.length > 0) {
    out.push(col.bold("\nEVENT RUNTIME: WORKERS & RUNS"));
    if (snapshot.workers.length > 0) {
      out.push(`  ${col.dim("Workers:")}`);
      out.push(
        `    ${cell("WORKER ID", 28)}${cell("PORT", 8)}${cell("PID", 8)}${cell("STATE", 10)}${cell("CURRENT RUN", 42)}LAST SEEN`,
      );
      for (const w of snapshot.workers) {
        const stateColor = w.stale ? col.red("stale") : w.state === "busy" ? col.yellow("busy") : col.green("idle");
        out.push(
          `    ${cell(w.workerId, 28)}${cell(w.apiPort ?? "-", 8)}${cell(w.pid ?? "-", 8)}${cell(stateColor, 18)}${cell(w.currentRun ?? "-", 42)}${col.dim(w.lastSeen ?? "-")}`,
        );
      }
    }
    if (snapshot.runs.length > 0) {
      out.push(`  ${col.dim("In-Flight Runs:")}`);
      out.push(
        `    ${cell("RUN ID", 42)}${cell("STATE", 12)}${cell("AGENT", 24)}${cell("ADAPTER", 10)}${cell("ATTEMPTS", 10)}ORIGIN`,
      );
      for (const r of snapshot.runs) {
        const stateColor = r.state === "RUNNING" ? col.green(r.state) : col.yellow(r.state);
        out.push(
          `    ${cell(r.runId, 42)}${cell(stateColor, 20)}${cell(r.spec?.agent ?? r.agent ?? "-", 24)}${cell(r.spec?.adapter ?? r.adapter ?? "-", 10)}${cell(`${r.attempts ?? 1}/${r.maxAttempts ?? r.spec?.maxAttempts ?? 1}`, 10)}${r.eventId ?? "-"}`,
        );
      }
    }
  }

  // 3. Agent Harnesses & CLI Sessions
  out.push(col.bold("\nAGENT HARNESSES & RUNNERS"));
  if (snapshot.agents.length === 0) {
    out.push(col.dim("  no active agent sessions or runners"));
  } else {
    out.push(
      `  ${cell("HARNESS", 16)}${cell("PID", 8)}${cell("TICKET", 12)}${cell("UPTIME", 12)}${cell("CPU/MEM", 12)}COMMAND`,
    );
    for (const a of snapshot.agents) {
      if (repo && a.worktree && !a.worktree.includes(repo)) continue;
      const cmdClip = a.command.length > 60 ? `${a.command.slice(0, 58)}…` : a.command;
      out.push(
        `  ${col.magenta(cell(a.harness, 16))}${cell(a.pid, 8)}${cell(a.ticket ?? "-", 12)}${cell(a.uptime, 12)}${cell(`${a.cpu}/${a.mem}`, 12)}${col.dim(cmdClip)}`,
      );
    }
  }

  // 4. Worktrees & Dev Servers
  const filteredWorktrees = all
    ? snapshot.worktrees
    : snapshot.worktrees.filter(
        (w) =>
          w.active ||
          snapshot.devServers.some(
            (d) => (d.worktree && d.worktree === w.path) || (d.ticket && w.ticket && d.ticket === w.ticket),
          ),
      );

  out.push(col.bold("\nWORKTREE DEV SERVERS & DAEMONS"));
  if (filteredWorktrees.length === 0 && snapshot.devServers.length === 0) {
    out.push(col.dim(`  no active worktree dev servers${all ? "" : " (use --all to list idle worktrees)"}`));
  } else {
    out.push(
      `  ${cell("REPO / TICKET", 24)}${cell("BRANCH", 28)}${cell("ACTIVE PIDS", 42)}${cell("PORTS", 16)}PATH`,
    );
    const renderedDevPids = new Set();
    for (const wt of filteredWorktrees) {
      if (repo && wt.repo !== repo) continue;
      const wtDevs = snapshot.devServers.filter(
        (d) =>
          (d.worktree && d.worktree === wt.path) ||
          (d.ticket && wt.ticket && d.ticket === wt.ticket) ||
          (d.repo && wt.repo && d.repo === wt.repo && d.ticket === wt.name),
      );
      for (const d of wtDevs) {
        renderedDevPids.add(d.pid);
      }

      const daemonPids = Object.entries(wt.pids || {}).map(([k, v]) => `${k}:${v}`);
      const devPids = wtDevs.map((d) => `${d.service}:${d.pid}`);
      const pidsStr = [...daemonPids, ...devPids].join(", ") || "-";

      const daemonPidValues = Object.values(wt.pids || {});
      const daemonPorts = snapshot.ports
        .filter((lp) => daemonPidValues.includes(lp.pid))
        .map((lp) => lp.port);
      const devServerPorts = wtDevs.map((d) => d.port).filter(Boolean);
      const devPidValues = wtDevs.map((d) => d.pid);
      const devPortsFromLsof = snapshot.ports
        .filter((lp) => devPidValues.includes(lp.pid))
        .map((lp) => lp.port);
      const allPorts = Array.from(new Set([...daemonPorts, ...devServerPorts, ...devPortsFromLsof])).sort(
        (a, b) => a - b,
      );
      const boundPorts = allPorts.join(", ") || "-";
      const branchDisplay = wt.branch.length > 26 ? `${wt.branch.slice(0, 24)}…` : wt.branch;
      out.push(
        `  ${col.cyan(cell(`${wt.repo}/${wt.name}`, 24))}${cell(branchDisplay, 28)}${cell(pidsStr, 42)}${cell(boundPorts, 16)}${col.dim(wt.path)}`,
      );
    }

    const unrenderedDevs = snapshot.devServers.filter((d) => !renderedDevPids.has(d.pid));
    for (const d of unrenderedDevs) {
      if (repo && d.repo && d.repo !== repo) continue;
      const repoTicket = d.repo && d.ticket ? `${d.repo}/${d.ticket}` : d.ticket ? d.ticket : d.service;
      const branch = "-";
      const pidStr = `${d.service}:${d.pid}`;
      const lsofPort = snapshot.ports.find((lp) => lp.pid === d.pid)?.port;
      const devPort = d.port ?? lsofPort;
      const boundPorts = devPort ? String(devPort) : "-";
      const wtPath = d.worktree ?? "-";
      out.push(
        `  ${col.cyan(cell(repoTicket, 24))}${cell(branch, 28)}${cell(pidStr, 42)}${cell(boundPorts, 16)}${col.dim(wtPath)}`,
      );
    }
  }

  // 5. Summary Footer
  const s = snapshot.summary;
  out.push(
    col.bold("\nSUMMARY: ") +
      col.green(`${s.controlServices} daemons`) +
      ", " +
      col.cyan(`${s.activeWorkers} workers`) +
      ", " +
      col.yellow(`${s.activeRuns} runs`) +
      ", " +
      col.magenta(`${s.activeAgents} agents`) +
      ", " +
      col.blue(`${s.activeWorktrees} active worktrees`) +
      col.dim(` (${s.totalWorktrees} total)`),
  );

  return out.join("\n");
}
