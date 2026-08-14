#!/usr/bin/env bun
/**
 * Remote worker nodes CLI (OPS-445; docs/event-runtime-workers.md §3).
 *
 * Usage:
 *   factory workers [list]            inspect remote worker nodes and version skew
 *   factory workers deploy            deploy/bootstrap factory code on remote nodes
 *   factory workers update            pull latest code, install deps, restart remote workers
 *   factory workers start             start worker daemons on remote nodes
 *   factory workers stop              stop worker daemons on remote nodes
 *   factory workers restart           restart worker daemons on remote nodes
 *
 * Flags:
 *   --node <name>                     target a specific node (default: all nodes)
 *   --ref <branch/tag/sha>            target git ref (default: develop)
 *   --json                            machine-readable JSON output
 *   -h, --help                        show this help
 */
import {
  loadNodesConfig,
  probeRemoteNode,
  deployRemoteWorker,
  updateRemoteWorker,
  startRemoteWorker,
  stopRemoteWorker,
} from "../event-runtime/lib/workers-remote.mjs";
import { FACTORY_ROOT } from "../event-runtime/lib/config.mjs";

const argv = process.argv.slice(2);

function val(flag) {
  const i = argv.indexOf(flag);
  if (i === -1 || i === argv.length - 1) return null;
  return argv[i + 1];
}

const c = {
  reset: (s) => `\x1b[0m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

function pad(str, len) {
  const s = String(str ?? "");
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}

function printHelp() {
  console.log(`
${c.bold("factory workers")} — remote worker node orchestration and version skew tracking

${c.bold("USAGE")}
  factory workers [list]             inspect configured nodes and version skew
  factory workers deploy             deploy/clone factory and install dependencies
  factory workers update             pull latest code and restart remote workers
  factory workers start              start worker daemon on remote nodes
  factory workers stop               stop worker daemon on remote nodes
  factory workers restart            restart worker daemon on remote nodes

${c.bold("FLAGS")}
  --node <name>                      target a specific node (default: all nodes)
  --ref <ref>                        target git ref for deploy/update (default: node config branch)
  --json                             output structured JSON
  -h, --help                         display this help message
`);
  process.exit(0);
}

if (argv.includes("-h") || argv.includes("--help")) {
  printHelp();
}

const JSON_OUT = argv.includes("--json");
const targetNode = val("--node");
const targetRef = val("--ref");
const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : "list";

function getLocalTrunkSha() {
  try {
    const res = Bun.spawnSync({
      cmd: ["git", "rev-parse", "HEAD"],
      stdout: "pipe",
      stderr: "pipe",
    });
    return res.exitCode === 0 ? res.stdout.toString().trim() : null;
  } catch {
    return null;
  }
}

try {
  const nodesMap = loadNodesConfig({ root: FACTORY_ROOT });

  if (nodesMap.size === 0) {
    if (JSON_OUT) {
      console.log(JSON.stringify({ nodes: [], count: 0, message: "no nodes configured in config/nodes.yaml" }, null, 2));
    } else {
      console.log(c.yellow("No remote worker nodes configured in config/nodes.yaml"));
    }
    process.exit(0);
  }

  const selectedNodes = targetNode
    ? (nodesMap.has(targetNode) ? [nodesMap.get(targetNode)] : null)
    : Array.from(nodesMap.values());

  if (!selectedNodes) {
    console.error(c.red(`Error: unknown node "${targetNode}". Configured nodes: ${Array.from(nodesMap.keys()).join(", ")}`));
    process.exit(1);
  }

  const localSha = getLocalTrunkSha();

  if (command === "list") {
    const probes = selectedNodes.map((node) => probeRemoteNode(node, { localTrunkSha: localSha }));

    if (JSON_OUT) {
      console.log(JSON.stringify({
        timestamp: new Date().toISOString(),
        localTrunkSha: localSha,
        nodes: probes,
      }, null, 2));
      process.exit(0);
    }

    console.log(c.bold(`factory workers — remote worker fleet (${probes.length} configured)`));
    if (localSha) {
      console.log(c.dim(`Local trunk SHA: ${localSha.slice(0, 8)}`));
    }
    console.log();

    console.log(
      c.dim("  ") +
      c.bold(pad("NODE", 16)) + "  " +
      c.bold(pad("HOST", 22)) + "  " +
      c.bold(pad("STATUS", 14)) + "  " +
      c.bold(pad("SKEW", 12)) + "  " +
      c.bold(pad("BRANCH / SHA", 24)) + "  " +
      c.bold(pad("WORKER", 10)) + "  " +
      c.bold("LABELS"),
    );

    for (const p of probes) {
      let statusStr = c.red("unreachable");
      let skewStr = c.dim("-");
      let branchSha = c.dim("-");
      let workerStr = c.dim("stopped");
      let labelsStr = "";

      if (p.connected) {
        statusStr = c.green("connected");
        if (p.skewStatus === "synced") {
          skewStr = c.green("synced");
        } else if (p.skewStatus === "outdated") {
          skewStr = c.yellow("outdated");
        } else if (p.skewStatus === "not_deployed") {
          skewStr = c.red("not deployed");
        }

        if (p.details?.branch || p.details?.headSha) {
          const b = p.details.branch ?? "";
          const s = p.details.headSha ? p.details.headSha.slice(0, 7) : "";
          branchSha = `${b}@${s}`;
        }

        if (p.workerActive) {
          workerStr = c.green(`PID ${p.workerPids.join(",")}`);
        }

        labelsStr = Object.entries(p.details?.labels || {})
          .map(([k, v]) => `${k}:${v}`)
          .join(" ");
      } else {
        skewStr = c.red("error");
        branchSha = c.dim(p.error?.slice(0, 24) ?? "");
      }

      console.log(
        "  " +
        pad(p.name, 16) + "  " +
        pad(p.host, 22) + "  " +
        pad(statusStr, 23) + "  " +
        pad(skewStr, 21) + "  " +
        pad(branchSha, 24) + "  " +
        pad(workerStr, 19) + "  " +
        c.dim(labelsStr),
      );
    }
    console.log();
    process.exit(0);
  }

  if (command === "deploy") {
    const results = [];
    for (const node of selectedNodes) {
      if (!JSON_OUT) console.log(c.cyan(`Deploying to node ${node.name} (${node.host})...`));
      const res = deployRemoteWorker(node, { ref: targetRef });
      results.push(res);
      if (!JSON_OUT) {
        if (res.ok) {
          console.log(c.green(`✓ Node ${node.name} deployed successfully`));
        } else {
          console.log(c.red(`✗ Node ${node.name} deploy failed: ${res.error}`));
        }
      }
    }
    if (JSON_OUT) console.log(JSON.stringify(results, null, 2));
    process.exit(results.every((r) => r.ok) ? 0 : 1);
  }

  if (command === "start") {
    const results = [];
    for (const node of selectedNodes) {
      if (!JSON_OUT) console.log(c.cyan(`Starting worker on node ${node.name}...`));
      const res = startRemoteWorker(node);
      results.push(res);
      if (!JSON_OUT) {
        if (res.ok) {
          console.log(c.green(`✓ Worker started on ${node.name} (PID ${res.pid})`));
        } else {
          console.log(c.red(`✗ Failed to start worker on ${node.name}: ${res.error}`));
        }
      }
    }
    if (JSON_OUT) console.log(JSON.stringify(results, null, 2));
    process.exit(results.every((r) => r.ok) ? 0 : 1);
  }

  if (command === "stop") {
    const results = [];
    for (const node of selectedNodes) {
      if (!JSON_OUT) console.log(c.cyan(`Stopping worker on node ${node.name}...`));
      const res = stopRemoteWorker(node);
      results.push(res);
      if (!JSON_OUT) {
        if (res.ok) {
          console.log(c.green(`✓ Worker stopped on ${node.name}`));
        } else {
          console.log(c.red(`✗ Failed to stop worker on ${node.name}: ${res.error}`));
        }
      }
    }
    if (JSON_OUT) console.log(JSON.stringify(results, null, 2));
    process.exit(results.every((r) => r.ok) ? 0 : 1);
  }

  if (command === "update" || command === "restart") {
    const results = [];
    for (const node of selectedNodes) {
      if (!JSON_OUT) console.log(c.cyan(`Updating/restarting worker on node ${node.name}...`));
      const res = updateRemoteWorker(node, { ref: targetRef });
      results.push(res);
      if (!JSON_OUT) {
        if (res.ok) {
          console.log(c.green(`✓ Node ${node.name} updated and worker restarted (PID ${res.pid})`));
        } else {
          console.log(c.red(`✗ Failed on step "${res.step}" for node ${node.name}: ${res.error}`));
        }
      }
    }
    if (JSON_OUT) console.log(JSON.stringify(results, null, 2));
    process.exit(results.every((r) => r.ok) ? 0 : 1);
  }

  console.error(c.red(`Unknown command "${command}". Run "factory workers --help" for usage.`));
  process.exit(1);
} catch (err) {
  console.error(c.red(`factory workers error: ${err.message}`));
  process.exit(1);
}
