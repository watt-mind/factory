/**
 * Registered agent definitions and event-type mappings
 * (docs/event-runtime.md §5.4, §6).
 *
 * An inbound event may only select what is registered here. Definitions pin
 * their prompt and schema files by content hash: editing a pinned file
 * without bumping the version fails at load, closed. The run spec's git-SHA
 * promptVersion is provenance recorded at planning time, not a second
 * identity.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { hashBytes } from "./canonical.mjs";
import { APPROVAL_MODES, CATCH_UP_MODES, parseCadence } from "./schedules.mjs";
import { RUNTIME_ROOT } from "./config.mjs";

export class RegistryError extends Error {
  constructor(message) {
    super(message);
    this.name = "RegistryError";
  }
}

const PINNED_FIELDS = ["prompt", "input_schema", "output_schema"];

function loadAgentDef(root, file) {
  const def = JSON.parse(readFileSync(file, "utf8"));
  for (const field of ["id", "version", ...PINNED_FIELDS, "workspace", "capabilities", "limits"]) {
    if (def[field] === undefined) throw new RegistryError(`${file}: missing "${field}"`);
  }
  // §14 enforcement path: a mutating definition is admitted only when it is
  // enforceable by construction — a fixed argv template (the closed action
  // registry), never a model. LLM agents stay read-only in the MVP (§3),
  // with one boundary move stated in docs/event-runtime-dispatch.md §6
  // (WM-107/WM-108): a mutating LLM agent over a tier-2 `worktree` workspace,
  // whose enforcement is the coordination design itself — watched proposals,
  // the shared claim/capacity/Owned Paths gates, and the repo's own scripts.
  if (def.mutating !== false) {
    const tier2Worktree = def.workspace?.type === "worktree";
    const closedArgv =
      Array.isArray(def.command) && def.command.length > 0 && def.command.every((e) => typeof e === "string");
    const closedActionRegistry =
      def.actionRegistry !== undefined &&
      def.hosts !== undefined &&
      Array.isArray(def.exec) &&
      Object.values(def.actionRegistry).every((a) => typeof a?.remote === "string") &&
      Object.values(def.hosts).every((t) => typeof t === "string");
    // Item-list form (OPS-229): every registered action is a fixed local argv,
    // applied per approved item — closed by construction, same as the others.
    const closedItemList =
      def.actionRegistry !== undefined &&
      typeof def.itemsField === "string" &&
      typeof def.itemKey === "string" &&
      Object.values(def.actionRegistry).every(
        (a) => Array.isArray(a?.argv) && a.argv.length > 0 && a.argv.every((e) => typeof e === "string"),
      );
    if (!closedArgv && !closedActionRegistry && !closedItemList && !tier2Worktree) {
      throw new RegistryError(
        `${file}: mutating agents are admitted only as closed command templates, closed action registries, or tier-2 worktree agents (docs/event-runtime.md §14; docs/event-runtime-dispatch.md §6; OPS-223/OPS-208/WM-108)`,
      );
    }
  }
  const pins = def.pins ?? {};
  for (const field of PINNED_FIELDS) {
    const rel = def[field];
    const abs = path.join(root, rel);
    const actual = hashBytes(readFileSync(abs));
    if (!pins[rel]) throw new RegistryError(`${file}: "${rel}" has no pin — run: bun event-runtime/cli.mjs update-pins`);
    if (pins[rel] !== actual) {
      throw new RegistryError(
        `${file}: "${rel}" content ${actual} does not match pin ${pins[rel]} — bump the version (and re-pin) instead of editing in place`,
      );
    }
  }
  return {
    ...def,
    ref: `${def.id}@${def.version}`,
    promptPath: path.join(root, def.prompt),
    inputSchema: JSON.parse(readFileSync(path.join(root, def.input_schema), "utf8")),
    outputSchema: JSON.parse(readFileSync(path.join(root, def.output_schema), "utf8")),
  };
}

/**
 * @returns {{ root: string, agents: Map<string, object>, eventTypes: object, schemas: object }}
 */
export function loadRegistry({ root = RUNTIME_ROOT } = {}) {
  const agents = new Map();
  const agentsDir = path.join(root, "agents");
  for (const name of readdirSync(agentsDir).filter((n) => n.endsWith(".json")).sort()) {
    const def = loadAgentDef(root, path.join(agentsDir, name));
    if (agents.has(def.ref)) throw new RegistryError(`duplicate agent definition ${def.ref}`);
    agents.set(def.ref, def);
  }

  const eventTypes = JSON.parse(readFileSync(path.join(root, "event-types.json"), "utf8"));
  for (const [type, mapping] of Object.entries(eventTypes)) {
    // Observe-only types (WM-75): admitted and recorded, resolved by the
    // planner as a typed NOOP — never a run, never a human_needed ask. They
    // name no agent, and naming one anyway is a config error, not a hint.
    if (mapping.observe === true) {
      if (mapping.agent) {
        throw new RegistryError(`event type ${type} is observe-only but names agent ${mapping.agent} — pick one`);
      }
      continue;
    }
    if (!mapping.agent || !agents.has(mapping.agent)) {
      throw new RegistryError(`event type ${type} maps to unregistered agent ${mapping.agent}`);
    }
    if (!Array.isArray(mapping.idempotencyScope) || mapping.idempotencyScope.length === 0) {
      throw new RegistryError(`event type ${type} declares no idempotency scope (§5.4)`);
    }
  }

  const schemas = {
    envelope: JSON.parse(readFileSync(path.join(root, "schemas", "factory.event.v1.json"), "utf8")),
    agentResult: JSON.parse(readFileSync(path.join(root, "schemas", "factory.agent-result.v1.json"), "utf8")),
  };

  // Recommendation edges (OPS-223): validated fail-closed at load — a chain
  // may only connect registered agents through registered event types, and
  // input mappings may only draw from the source run's input or artifact.
  let edges = {};
  const edgesFile = path.join(root, "edges.json");
  if (existsSync(edgesFile)) {
    edges = JSON.parse(readFileSync(edgesFile, "utf8"));
    for (const [agentRef, rule] of Object.entries(edges)) {
      if (!agents.has(agentRef)) throw new RegistryError(`edges.json: unregistered source agent ${agentRef}`);
      if (typeof rule.recommendationField !== "string" || !rule.recommendationField) {
        throw new RegistryError(`edges.json: ${agentRef} has no recommendationField`);
      }
      for (const [value, edge] of Object.entries(rule.edges ?? {})) {
        if (!eventTypes[edge.eventType]) {
          throw new RegistryError(`edges.json: ${agentRef}.${value} targets unregistered event type ${edge.eventType}`);
        }
        for (const expr of Object.values(edge.input ?? {})) {
          if (typeof expr === "string" && expr.startsWith("$.") && !/^\$\.(input|artifact|artifactHash)(\.|$)/.test(expr)) {
            throw new RegistryError(`edges.json: ${agentRef}.${value} input path "${expr}" — only $.input.*, $.artifact.* and $.artifactHash.* are allowed`);
          }
        }
      }
    }
  }

  // Schedules (OPS-381): validated fail-closed at load — an unparseable
  // cadence or an unregistered event type must be a startup error, not a
  // surprise at 03:00 when nothing fires.
  let schedules = {};
  const schedulesFile = path.join(root, "schedules.json");
  if (existsSync(schedulesFile)) {
    schedules = JSON.parse(readFileSync(schedulesFile, "utf8"));
    for (const [loop, schedule] of Object.entries(schedules)) {
      if (!/^[a-z][a-z0-9-]*$/.test(loop)) throw new RegistryError(`schedules.json: bad loop name "${loop}"`);
      try {
        parseCadence(schedule.every);
      } catch (err) {
        throw new RegistryError(`schedules.json: ${loop}: ${err.message}`);
      }
      if (!eventTypes[schedule.eventType]) {
        throw new RegistryError(`schedules.json: ${loop} fires unregistered event type ${schedule.eventType}`);
      }
      const catchUp = schedule.catchUp ?? "none";
      if (!CATCH_UP_MODES.includes(catchUp)) {
        throw new RegistryError(`schedules.json: ${loop} has unknown catchUp "${catchUp}" (${CATCH_UP_MODES.join(", ")})`);
      }
      const approval = schedule.approval ?? "watched";
      if (!APPROVAL_MODES.includes(approval)) {
        throw new RegistryError(`schedules.json: ${loop} has unknown approval "${approval}" (${APPROVAL_MODES.join(", ")})`);
      }
      // Unattended approval on a loop that is not even switched on is almost
      // certainly a half-finished edit; refuse it rather than let it lurk.
      if (approval === "auto" && !schedule.enabled) {
        throw new RegistryError(`schedules.json: ${loop} declares approval "auto" but is not enabled — decide one`);
      }
      // The ship chain's deploy-branch merge is PERMANENTLY watched: that
      // approval IS the human master decision, so the config that would
      // delete it cannot load, whoever writes it and however good the track
      // record looks (docs/event-runtime-dispatch.md §7, WM-111).
      if (approval === "auto" && eventTypes[schedule.eventType]?.humanApprovalOnly === true) {
        throw new RegistryError(
          `schedules.json: ${loop} declares approval "auto" but ${schedule.eventType} is humanApprovalOnly — the deploy-branch decision is permanently the human's watched approval (docs/event-runtime-dispatch.md §7, WM-111)`,
        );
      }
      // A static payload rides along on every tick (repo-scoped loops need
      // {repo}). Tick fields always win the merge, so a payload claiming
      // loop/slot identity is a config error, not a spoofing vector.
      if (schedule.payload !== undefined) {
        if (typeof schedule.payload !== "object" || schedule.payload === null || Array.isArray(schedule.payload)) {
          throw new RegistryError(`schedules.json: ${loop} payload must be a plain object`);
        }
        for (const reserved of ["loop", "slot", "cadenceSeconds", "skippedSlots"]) {
          if (reserved in schedule.payload) {
            throw new RegistryError(`schedules.json: ${loop} payload must not set reserved tick field "${reserved}"`);
          }
        }
      }
    }
  }

  return { root, agents, eventTypes, schemas, edges, schedules };
}

export function getAgent(registry, ref) {
  const def = registry.agents.get(ref);
  if (!def) throw new RegistryError(`unregistered agent ${ref}`);
  return def;
}

export function getEventType(registry, type) {
  return registry.eventTypes[type] ?? null;
}

/** Recompute every definition's pins in place — the deliberate operator verb. */
export function updatePins({ root = RUNTIME_ROOT } = {}) {
  const changed = [];
  const agentsDir = path.join(root, "agents");
  for (const name of readdirSync(agentsDir).filter((n) => n.endsWith(".json")).sort()) {
    const file = path.join(agentsDir, name);
    const def = JSON.parse(readFileSync(file, "utf8"));
    const pins = {};
    for (const field of PINNED_FIELDS) {
      if (!def[field]) continue;
      pins[def[field]] = hashBytes(readFileSync(path.join(root, def[field])));
    }
    if (JSON.stringify(def.pins) !== JSON.stringify(pins)) {
      writeFileSync(file, `${JSON.stringify({ ...def, pins }, null, 2)}\n`, "utf8");
      changed.push(name);
    }
  }
  return changed;
}
