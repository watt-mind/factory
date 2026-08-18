#!/usr/bin/env bun
/** Event-runtime CLI argument routing and command dispatch. */
import { COMMANDS } from "./cli/commands.mjs";
import { USAGE as BASE_USAGE } from "./cli/usage.mjs";
import { API_HOST, DEFAULT_PORT } from "./lib/config.mjs";
import { decisionRequestHash } from "./lib/decision.mjs";

const USAGE = BASE_USAGE.replace(
  "  inbox                          open items waiting on the human",
  "  inbox                          open items waiting on the human (? = decision pending)\n  decide <item-id> <option-id> [--field key=value]...\n                                 answer an inbox decision through the control API",
);

// Preserve the small programmatic surface used by runtime tests and tooling.
export {
  PRUNE_INTERVAL_MS,
  TICK_SUBSYSTEMS,
  acquireServeLock,
  isProcessAlive,
  releaseServeLock,
  serveLockPath,
  tick,
} from "./cli/serve.mjs";
export { getAnomalyLines, getPoolLines, status } from "./cli/status.mjs";
export { doctor } from "./cli/doctor.mjs";
export {
  SPAWN_GRACE_MS,
  readPool,
  runDir,
  slotFiles,
} from "./cli/supervise.mjs";
export { COMMAND_NAMES, COMMANDS } from "./cli/commands.mjs";

function controlUrl(pathname) {
  const port = Number(process.env.FACTORY_EVENT_PORT ?? DEFAULT_PORT);
  return `http://${API_HOST}:${port}${pathname}`;
}

async function callControl(method, pathname, body) {
  const res = await fetch(controlUrl(pathname), {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(payload?.message ?? payload?.error ?? `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return payload;
}

/** Owned-path override of the split inbox command, adding decision markers. */
export async function inboxCommand() {
  const body = await callControl("GET", "/inbox?status=open");
  if (body.items.length === 0) {
    console.log("no open inbox items");
    return;
  }
  console.log("ID\tKIND\tSEVERITY\tCREATED\tTITLE");
  for (const item of body.items) {
    const marker = item.decision && !item.response ? "? " : "";
    console.log(
      `${item.id}\t${item.kind}\t${item.severity}\t${item.createdAt}\t${marker}${item.title}`,
    );
  }
}

function parseDecisionField(field, raw) {
  if (field?.kind === "multi-choice") return raw === "" ? [] : raw.split(",");
  if (field?.kind === "confirm") {
    if (raw === "true") return true;
    if (raw === "false") return false;
  }
  if (field?.kind === "number") {
    const number = Number(raw);
    if (raw.trim() !== "" && Number.isFinite(number)) return number;
  }
  return raw;
}

export async function decideCommand(args) {
  const [itemId, optionId, ...rest] = args;
  if (!itemId || !optionId) {
    throw new Error("usage: decide <item-id> <option-id> [--field key=value]...");
  }
  const detail = await callControl(
    "GET",
    `/inbox/${encodeURIComponent(itemId)}`,
  );
  if (!detail.item.decision) throw new Error(`inbox item ${itemId} has no decision`);
  const declared = new Map(
    (detail.item.decision.fields ?? []).map((field) => [field.id, field]),
  );
  const fields = {};
  for (let index = 0; index < rest.length; index++) {
    if (rest[index] !== "--field" || !rest[index + 1]) {
      throw new Error(`unexpected decide argument: ${rest[index]}`);
    }
    const assignment = rest[++index];
    const equals = assignment.indexOf("=");
    if (equals <= 0) throw new Error(`--field expects key=value, got ${assignment}`);
    const key = assignment.slice(0, equals);
    const raw = assignment.slice(equals + 1);
    fields[key] = parseDecisionField(declared.get(key), raw);
  }
  const result = await callControl(
    "POST",
    `/inbox/${encodeURIComponent(itemId)}/decide`,
    {
      schemaVersion: "factory.decision-response/v1",
      requestHash: decisionRequestHash(detail.item.decision),
      optionId,
      fields,
    },
  );
  console.log(
    `${result.item.id}: ${result.effect.kind} ${result.effect.outcome}`,
  );
  return result;
}

export async function dispatch(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (command === "decide") return decideCommand(args);
  if (command === "inbox") return inboxCommand(args);
  if (!Object.hasOwn(COMMANDS, command)) {
    console.error(USAGE);
    process.exit(1);
  }
  return COMMANDS[command](args);
}

if (import.meta.main || process.argv[1]?.endsWith("cli.mjs")) {
  await dispatch();
}
