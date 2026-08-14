#!/usr/bin/env bun
/**
 * Factory process, port, worker, and agent inspection CLI.
 *
 *   factory ps
 *   factory ps --json
 *   factory ps --all
 *   factory ps --repo bj29
 *   factory ps --port 7404
 */
import { factoryRoot } from "../lib/factory-root.mjs";
import { collectFactoryPsSnapshot, formatFactoryPsReport, c } from "../lib/ps.mjs";

const argv = process.argv.slice(2);
const val = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? null : argv[i + 1];
};

if (argv.includes("-h") || argv.includes("--help") || argv.includes("help")) {
  console.log(`factory ps — inspect factory processes, ports, workers, and agents

usage:
  factory ps                summary of active daemons, workers, runs, and ports
  factory ps --json         output machine-readable JSON snapshot
  factory ps --all          include idle worktrees and background services
  factory ps --repo <name>  filter by repository name
  factory ps --port <port>  probe specific control API port (default: 7381)
`);
  process.exit(0);
}

const JSON_OUT = argv.includes("--json");
const ALL = argv.includes("--all");
const repo = val("--repo");
const customPort = val("--port");
const root = factoryRoot();

try {
  const snapshot = await collectFactoryPsSnapshot({
    customPort,
    root,
  });

  if (JSON_OUT) {
    console.log(JSON.stringify(snapshot, null, 2));
    process.exit(0);
  }

  const output = formatFactoryPsReport(snapshot, {
    colors: process.stdout.isTTY !== false,
    all: ALL,
    repo,
  });

  console.log(output);
} catch (err) {
  console.error(c.red(`factory ps error: ${err.message}`));
  process.exit(1);
}
