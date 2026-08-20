#!/usr/bin/env bun
/** Event-runtime CLI argument routing and command dispatch. */
import { COMMANDS } from "./cli/commands.mjs";
import { USAGE as BASE_USAGE } from "./cli/usage.mjs";
import { backfillResultArtifacts } from "./lib/artifacts.mjs";
import { initPack } from "./lib/pack-init.mjs";
import { validatePack } from "./lib/pack-validate.mjs";
import {
  API_HOST,
  DEFAULT_PORT,
  artifactsRoot,
  runtimeHome,
} from "./lib/config.mjs";
import { openDb } from "./lib/db.mjs";
import { decisionRequestHash } from "./lib/decision.mjs";
import {
  contributionCounts,
  formatContributionCounts,
  loadExtensions,
  validateExtensionManifest,
} from "./lib/extensions.mjs";

const USAGE = BASE_USAGE.replace(
  "  inbox                          open items waiting on the human",
  "  inbox                          open items waiting on the human (? = decision pending)\n  decide <item-id> <option-id> [--field key=value]...\n                                 answer an inbox decision through the control API\n  memos <subjectType> <id> [--kind k] [--all]\n                                 live memos for a subject, with provenance and expiry",
)
  .replace(
    "  adapters [--json]               registered harness adapters: name, source, sandbox support (local, no serve needed)",
    "  adapters [--json]               registered harness adapters: name, source, sandbox support (local, no serve needed)\n  extensions list [--json]       allow-listed extensions (policy.yaml extensions:): name, version, path, contribution counts, config namespace\n  extensions validate <path>     validate a factory-extension.json without loading it",
  )
  .concat(
    "\n  pack init <name> [path]          scaffold a pinned, data-only pack (default packs/<name>)\n  pack validate <path>              validate one pack through the registry loader\n  artifacts backfill-results [--apply]\n                                 materialize stored typed result output (dry by default)",
  )
  .replace(
    "All commands except serve, work, supervise, and update-pins are clients of the control",
    "All commands except serve, work, supervise, update-pins, and artifacts are clients of the control",
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
    const err = new Error(
      payload?.message ?? payload?.error ?? `HTTP ${res.status}`,
    );
    err.status = res.status;
    throw err;
  }
  return payload;
}

/** Format one memo row for `memos` (docs/event-runtime-memos.md §8). */
function formatMemoLine(memo) {
  const subject = `${memo.subject?.type ?? "?"}:${memo.subject?.id ?? "?"}`;
  const live = memo.live === false ? "expired" : "live";
  const expires = memo.expiresAt ?? "-";
  const uses = `${memo.usefulCount ?? 0}u/${memo.wrongCount ?? 0}w`;
  const agent = memo.provenance?.agent ?? "-";
  const from =
    memo.inboxItemId && !memo.runId
      ? `operator decision ${memo.inboxItemId}`
      : memo.runId
        ? `${agent} ${memo.runId}`
        : agent;
  return `${memo.kind}\t${subject}\t${live}\t${expires}\t${uses}\t${from}`;
}

/** Read-only fold of live memos for one subject (WM-814). */
export async function memosCommand(args = []) {
  const positional = [];
  let kind;
  let all = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--kind") {
      kind = args[++i];
      continue;
    }
    if (args[i] === "--all") {
      all = true;
      continue;
    }
    positional.push(args[i]);
  }
  const [subjectType, subjectId] = positional;
  if (!subjectType || !subjectId) {
    throw new Error("usage: memos <subjectType> <id> [--kind k] [--all]");
  }
  const query = new URLSearchParams({
    subjectType,
    subjectId,
    live: all ? "false" : "true",
  });
  if (kind) query.set("kind", kind);
  const body = await callControl("GET", `/memos?${query}`);
  const memos = body.memos ?? [];
  if (memos.length === 0) {
    console.log(
      all
        ? `no memos for ${subjectType}:${subjectId}`
        : `no live memos for ${subjectType}:${subjectId}`,
    );
    return memos;
  }
  console.log("KIND\tSUBJECT\tSTATE\tEXPIRES\tUSES\tFROM");
  for (const memo of memos) {
    console.log(formatMemoLine(memo));
    if (typeof memo.body === "string" && memo.body.trim()) {
      for (const line of memo.body.trim().split("\n")) {
        console.log(`  ${line}`);
      }
    }
  }
  return memos;
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
    throw new Error(
      "usage: decide <item-id> <option-id> [--field key=value]...",
    );
  }
  const detail = await callControl(
    "GET",
    `/inbox/${encodeURIComponent(itemId)}`,
  );
  if (!detail.item.decision)
    throw new Error(`inbox item ${itemId} has no decision`);
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
    if (equals <= 0)
      throw new Error(`--field expects key=value, got ${assignment}`);
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

/**
 * `extensions list` — the allow-listed extensions the loader accepts (WM-838),
 * with their contribution counts (packs, adapters, hooks, panels, config)
 * and `contributes.config` namespace; faults print as anomalies on stderr,
 * exactly as /status would report them, and the command still exits 0
 * because a broken third-party extension is a configuration anomaly, not a
 * CLI failure.
 * `extensions validate <path>` — validate one manifest (schema, path
 * existence, adapter names) without loading a pack or importing an adapter;
 * exit 1 when it does not validate. Both are local — no serve needed.
 */
export async function extensionsCommand(args = []) {
  const [sub, ...rest] = args;
  if (sub === "validate") {
    const target = rest.find((a) => !a.startsWith("--"));
    if (!target) {
      console.error("usage: extensions validate <path>");
      process.exit(1);
    }
    const out = validateExtensionManifest(target);
    for (const warning of out.warnings) console.error(`warning: ${warning}`);
    if (!out.valid) {
      for (const error of out.errors) console.error(`error: ${error}`);
      process.exit(1);
    }
    const contributes = out.manifest.contributes ?? {};
    const counts = formatContributionCounts(contributionCounts(out.manifest));
    const namespace = contributes.config?.namespace;
    const configBit =
      typeof namespace === "string" && namespace !== ""
        ? `, config namespace ${namespace}`
        : "";
    console.log(
      `${out.manifest.name}@${out.manifest.version}: valid (${counts}${configBit})`,
    );
    return out;
  }
  if (sub === "list" || sub === undefined) {
    const loaded = await loadExtensions();
    if (rest.includes("--json") || args.includes("--json")) {
      console.log(
        JSON.stringify(
          { extensions: loaded.extensions, anomalies: loaded.anomalies },
          null,
          2,
        ),
      );
      return loaded;
    }
    for (const anomaly of loaded.anomalies)
      console.error(`anomaly: ${anomaly}`);
    const width = Math.max(
      10,
      ...loaded.extensions.map((ext) => ext.name.length + 2),
    );
    const nsWidth = Math.max(
      10,
      ...loaded.extensions.map(
        (ext) => (ext.config?.namespace ?? "-").length + 2,
      ),
    );
    console.log(
      `${"EXTENSION".padEnd(width)}${"VERSION".padEnd(10)}${"PACKS".padEnd(7)}${"ADAPTERS".padEnd(10)}${"HOOKS".padEnd(7)}${"PANELS".padEnd(8)}${"CONFIG".padEnd(8)}${"NAMESPACE".padEnd(nsWidth)}PATH`,
    );
    for (const ext of loaded.extensions) {
      const counts = contributionCounts(ext);
      const namespace = ext.config?.namespace ?? "-";
      console.log(
        `${ext.name.padEnd(width)}${ext.version.padEnd(10)}${String(counts.packs).padEnd(7)}${String(counts.adapters).padEnd(10)}${String(counts.hooks).padEnd(7)}${String(counts.panels).padEnd(8)}${String(counts.config).padEnd(8)}${namespace.padEnd(nsWidth)}${ext.path}`,
      );
    }
    return loaded;
  }
  console.error("usage: extensions list [--json] | extensions validate <path>");
  process.exit(1);
}

/** `pack init` and `pack validate` — local authoring commands, no serve needed. */
export function packCommand(args = []) {
  const [sub, first, second, ...rest] = args;
  if (sub === "init" && first && rest.length === 0) {
    const created = initPack(first, second ? { dir: second } : undefined);
    console.log(`${created.name}: initialized ${created.root}`);
    return created;
  }
  if (sub === "validate" && first && !second && rest.length === 0) {
    const checked = validatePack(first);
    console.log(
      `${checked.name}: valid (${checked.agents} agent${checked.agents === 1 ? "" : "s"}, namespace ${checked.namespace})`,
    );
    return checked;
  }
  throw new Error("usage: pack init <name> [path] | pack validate <path>");
}

/** Backfill accepted typed output into the content store (WM-858). */
export function artifactsCommand(
  args = [],
  { db = null, storeRoot = artifactsRoot(runtimeHome()) } = {},
) {
  const [sub, ...rest] = args;
  if (sub !== "backfill-results" || rest.some((arg) => arg !== "--apply")) {
    throw new Error("usage: artifacts backfill-results [--apply]");
  }
  const apply = rest.includes("--apply");
  const ownedDb = db ?? openDb();
  try {
    const counts = backfillResultArtifacts(ownedDb, storeRoot, { apply });
    const action = apply
      ? `${counts.materialized} materialized`
      : `${counts.wouldMaterialize} would be materialized`;
    console.log(
      `result artifacts: ${counts.scanned} rows scanned, ${counts.eligible} eligible, ${counts.alreadyStored} already stored, ${action}, ${counts.invalid} invalid${apply ? "" : " (dry run)"}`,
    );
    return counts;
  } finally {
    if (!db) ownedDb.close();
  }
}

export async function dispatch(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (command === "decide") return decideCommand(args);
  if (command === "inbox") return inboxCommand(args);
  if (command === "memos") return memosCommand(args);
  if (command === "extensions") return extensionsCommand(args);
  if (command === "pack") return packCommand(args);
  if (command === "artifacts") return artifactsCommand(args);
  if (!Object.hasOwn(COMMANDS, command)) {
    console.error(USAGE);
    process.exit(1);
  }
  return COMMANDS[command](args);
}

if (import.meta.main || process.argv[1]?.endsWith("cli.mjs")) {
  await dispatch();
}
