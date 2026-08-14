/**
 * Remote worker management and SSH orchestration (OPS-445; docs/event-runtime-workers.md §3).
 *
 * Provides safe SSH command execution, remote node health probing, version-skew tracking,
 * and remote worker lifecycle operations (deploy, update, start, stop, restart).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { FACTORY_ROOT } from "./config.mjs";

export class NodeConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "NodeConfigError";
  }
}

export function nodesConfigPath(root = FACTORY_ROOT) {
  return process.env.FACTORY_NODES_CONFIG || path.join(root, "config", "nodes.yaml");
}

/** Expand leading ~ in paths */
export function expandHome(p, home = process.env.HOME) {
  if (typeof p !== "string") return p;
  if (p === "~") return home ?? p;
  if (p.startsWith("~/")) return path.join(home ?? "", p.slice(2));
  return p;
}

/**
 * Load and validate remote nodes configuration.
 *
 * @returns {Map<string, {
 *   name: string,
 *   host: string,
 *   user: string | null,
 *   port: number,
 *   factoryRoot: string,
 *   branch: string,
 *   env: Record<string, string | number>,
 *   labels: Record<string, string>,
 *   adapters: string[]
 * }>}
 */
export function loadNodesConfig({ configPath = null, root = FACTORY_ROOT } = {}) {
  const filePath = configPath || nodesConfigPath(root);
  if (!existsSync(filePath)) {
    return new Map();
  }

  let parsed;
  try {
    parsed = Bun.YAML.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new NodeConfigError(`malformed nodes config at ${filePath}: ${err.message}`);
  }

  const nodes = new Map();
  if (!parsed || typeof parsed !== "object" || !parsed.nodes) {
    return nodes;
  }

  for (const [name, entry] of Object.entries(parsed.nodes)) {
    if (!entry || typeof entry !== "object") {
      throw new NodeConfigError(`invalid node entry for "${name}" in ${filePath}`);
    }
    if (!entry.host || typeof entry.host !== "string") {
      throw new NodeConfigError(`node "${name}" is missing required "host" property`);
    }

    const port = Number(entry.port ?? 22);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new NodeConfigError(`node "${name}" has invalid port: ${entry.port}`);
    }

    const factoryRoot = entry.factory_root || "~/Develop/factory";
    const branch = entry.branch || "develop";
    const user = entry.user || null;
    const env = entry.env && typeof entry.env === "object" ? { ...entry.env } : {};
    const labels = entry.labels && typeof entry.labels === "object" ? { ...entry.labels } : {};
    const adapters = Array.isArray(entry.adapters) ? entry.adapters.map(String) : [];

    nodes.set(name, {
      name,
      host: entry.host,
      user,
      port,
      factoryRoot,
      branch,
      env,
      labels,
      adapters,
    });
  }

  return nodes;
}

/**
 * Build safe ssh argv array for child process execution.
 */
export function buildSshArgv(node, remoteCommand, { batchMode = true, connectTimeout = 5 } = {}) {
  const args = [];
  if (node.port && node.port !== 22) {
    args.push("-p", String(node.port));
  }
  if (batchMode) {
    args.push("-o", "BatchMode=yes");
  }
  if (connectTimeout) {
    args.push("-o", `ConnectTimeout=${connectTimeout}`);
  }

  const target = node.user ? `${node.user}@${node.host}` : node.host;
  args.push(target);

  if (typeof remoteCommand === "string") {
    args.push(remoteCommand);
  } else if (Array.isArray(remoteCommand)) {
    args.push(remoteCommand.join(" "));
  }

  return args;
}

/**
 * Execute an SSH command against a remote node.
 */
export function executeSsh(node, remoteCommand, {
  batchMode = true,
  connectTimeout = 5,
  spawnFn = null,
} = {}) {
  const args = buildSshArgv(node, remoteCommand, { batchMode, connectTimeout });
  const runner = spawnFn || ((cmd) => {
    const proc = Bun.spawnSync({
      cmd: ["ssh", ...cmd],
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: proc.exitCode,
      stdout: proc.stdout.toString(),
      stderr: proc.stderr.toString(),
    };
  });

  const res = runner(args);
  return {
    exitCode: res.exitCode,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    ok: res.exitCode === 0,
  };
}

/**
 * Probe remote node connectivity, git commit, runtime version, and running worker processes.
 */
export function probeRemoteNode(node, {
  localTrunkSha = null,
  connectTimeout = 2,
  spawnFn = null,
} = {}) {
  const remotePath = node.factoryRoot;
  // Probe script: checks git sha, branch, arch, os, bun version, and running worker pid
  const probeScript = [
    `REMOTE_DIR="${remotePath}";`,
    `if [ -d "$REMOTE_DIR" ]; then`,
    `  cd "$REMOTE_DIR" 2>/dev/null;`,
    `  HEAD_SHA=$(git rev-parse HEAD 2>/dev/null || echo "unknown");`,
    `  BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown");`,
    `  DIRTY=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ');`,
    `else`,
    `  HEAD_SHA="missing_dir";`,
    `  BRANCH="missing_dir";`,
    `  DIRTY="0";`,
    `fi;`,
    `ARCH=$(uname -m 2>/dev/null || echo "unknown");`,
    `OS=$(uname -s 2>/dev/null || echo "unknown");`,
    `BUN_VER=$(bun --version 2>/dev/null || echo "not_found");`,
    `WORKER_PIDS=$(ps -axo pid,command 2>/dev/null | grep -E "bun.*event-runtime/cli\\.mjs work" | grep -v grep | awk '{print $1}' | tr '\\n' ',' | sed 's/,$//');`,
    `echo "PROBE_RESULT:$$HEAD_SHA|$$BRANCH|$$DIRTY|$$ARCH|$$OS|$$BUN_VER|$$WORKER_PIDS"`,
  ].join(" ");

  const res = executeSsh(node, probeScript, { spawnFn, connectTimeout });

  if (!res.ok) {
    return {
      name: node.name,
      host: node.host,
      connected: false,
      error: (res.stderr || res.stdout || "ssh connection failed").trim(),
      outdated: null,
      skewStatus: "unreachable",
      details: null,
    };
  }

  const match = res.stdout.match(/PROBE_RESULT:(.*)/);
  if (!match) {
    return {
      name: node.name,
      host: node.host,
      connected: true,
      error: "invalid probe output format",
      outdated: null,
      skewStatus: "unknown",
      details: null,
    };
  }

  const [headSha, branch, dirtyCount, arch, osName, bunVer, pidsRaw] = match[1].trim().split("|");
  const pids = pidsRaw ? pidsRaw.split(",").map(Number).filter(Boolean) : [];
  const isMissingDir = headSha === "missing_dir";
  const isDirty = Number(dirtyCount) > 0;

  let outdated = false;
  let skewStatus = "synced";

  if (isMissingDir) {
    skewStatus = "not_deployed";
    outdated = true;
  } else if (localTrunkSha && headSha && headSha !== "unknown") {
    if (localTrunkSha !== headSha) {
      outdated = true;
      skewStatus = "outdated";
    }
  }

  return {
    name: node.name,
    host: node.host,
    port: node.port,
    connected: true,
    outdated,
    skewStatus,
    workerPids: pids,
    workerActive: pids.length > 0,
    details: {
      factoryRoot: node.factoryRoot,
      headSha: isMissingDir ? null : headSha,
      branch: isMissingDir ? null : branch,
      dirty: isDirty,
      arch,
      os: osName,
      bunVersion: bunVer,
      labels: node.labels,
      adapters: node.adapters,
    },
  };
}

/**
 * Deploy or update repository code and dependencies on a remote worker node.
 */
export function deployRemoteWorker(node, {
  ref = null,
  spawnFn = null,
} = {}) {
  const targetBranch = ref || node.branch || "develop";
  const remotePath = node.factoryRoot;

  const deployScript = [
    `set -e;`,
    `mkdir -p "${remotePath}";`,
    `cd "${remotePath}";`,
    `if [ ! -d ".git" ]; then`,
    `  echo "Cloning repository...";`,
    `  git clone https://github.com/watt-mind/factory.git . 2>&1;`,
    `fi;`,
    `echo "Updating branch ${targetBranch}...";`,
    `git fetch origin 2>&1;`,
    `git checkout "${targetBranch}" 2>&1;`,
    `git pull --ff-only origin "${targetBranch}" 2>&1;`,
    `echo "Installing dependencies...";`,
    `bun install 2>&1;`,
    `echo "DEPLOY_SUCCESS";`,
  ].join(" ");

  const res = executeSsh(node, deployScript, { spawnFn, connectTimeout: 10 });
  const ok = res.ok && res.stdout.includes("DEPLOY_SUCCESS");

  return {
    name: node.name,
    ok,
    stdout: res.stdout,
    stderr: res.stderr,
    error: ok ? null : (res.stderr || res.stdout || "deploy failed").trim(),
  };
}

/**
 * Start a worker daemon process on the remote node.
 */
export function startRemoteWorker(node, {
  spawnFn = null,
} = {}) {
  const remotePath = node.factoryRoot;
  const envVars = Object.entries(node.env || {})
    .map(([k, v]) => `export ${k}="${v}";`)
    .join(" ");

  const labelsArg = Object.entries(node.labels || {})
    .map(([k, v]) => `${k}=${v}`)
    .join(",");

  const adaptersArg = (node.adapters || []).join(",");

  const startScript = [
    `cd "${remotePath}" 2>/dev/null || exit 1;`,
    `mkdir -p .factory/run;`,
    `${envVars}`,
    `CMD="bun event-runtime/cli.mjs work";`,
    labelsArg ? `CMD="$CMD --labels ${labelsArg}";` : ``,
    adaptersArg ? `CMD="$CMD --adapters ${adaptersArg}";` : ``,
    `nohup $CMD >> .factory/run/worker.log 2>&1 &`,
    `PID=$!;`,
    `echo $PID > .factory/run/worker.pid;`,
    `echo "START_SUCCESS:$PID"`,
  ].join(" ");

  const res = executeSsh(node, startScript, { spawnFn });
  const match = res.stdout.match(/START_SUCCESS:(\d+)/);
  const ok = res.ok && Boolean(match);
  const pid = match ? Number(match[1]) : null;

  return {
    name: node.name,
    ok,
    pid,
    error: ok ? null : (res.stderr || res.stdout || "failed to start remote worker").trim(),
  };
}

/**
 * Stop running worker daemon processes on the remote node with graceful drain timeout.
 */
export function stopRemoteWorker(node, {
  drainTimeout = 15,
  spawnFn = null,
} = {}) {
  const remotePath = node.factoryRoot;

  const stopScript = [
    `cd "${remotePath}" 2>/dev/null;`,
    `PIDS=$(ps -axo pid,command 2>/dev/null | grep -E "bun.*event-runtime/cli\\.mjs work" | grep -v grep | awk '{print $1}');`,
    `if [ -z "$PIDS" ]; then`,
    `  echo "STOP_SUCCESS:0";`,
    `  exit 0;`,
    `fi;`,
    `for PID in $PIDS; do`,
    `  kill -TERM "$PID" 2>/dev/null || true;`,
    `done;`,
    `for i in $(seq ${drainTimeout}); do`,
    `  ALIVE=0;`,
    `  for PID in $PIDS; do`,
    `    if kill -0 "$PID" 2>/dev/null; then ALIVE=1; break; fi;`,
    `  done;`,
    `  if [ "$ALIVE" -eq 0 ]; then break; fi;`,
    `  sleep 1;`,
    `done;`,
    `for PID in $PIDS; do`,
    `  kill -9 "$PID" 2>/dev/null || true;`,
    `done;`,
    `rm -f .factory/run/worker.pid 2>/dev/null || true;`,
    `echo "STOP_SUCCESS:1"`,
  ].join(" ");

  const res = executeSsh(node, stopScript, { spawnFn });
  const ok = res.ok && res.stdout.includes("STOP_SUCCESS");

  return {
    name: node.name,
    ok,
    error: ok ? null : (res.stderr || res.stdout || "failed to stop remote worker").trim(),
  };
}

/**
 * Perform rolling update of remote worker: stop -> deploy/pull -> start.
 */
export function updateRemoteWorker(node, {
  ref = null,
  drainTimeout = 15,
  spawnFn = null,
} = {}) {
  const stopRes = stopRemoteWorker(node, { drainTimeout, spawnFn });
  if (!stopRes.ok) {
    return {
      name: node.name,
      ok: false,
      step: "stop",
      error: stopRes.error,
    };
  }

  const deployRes = deployRemoteWorker(node, { ref, spawnFn });
  if (!deployRes.ok) {
    return {
      name: node.name,
      ok: false,
      step: "deploy",
      error: deployRes.error,
    };
  }

  const startRes = startRemoteWorker(node, { spawnFn });
  if (!startRes.ok) {
    return {
      name: node.name,
      ok: false,
      step: "start",
      error: startRes.error,
    };
  }

  return {
    name: node.name,
    ok: true,
    pid: startRes.pid,
  };
}
