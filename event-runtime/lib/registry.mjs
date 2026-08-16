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
import { reposRoot } from "./repos.mjs";

export class RegistryError extends Error {
  constructor(message) {
    super(message);
    this.name = "RegistryError";
  }
}

const PINNED_FIELDS = ["prompt", "input_schema", "output_schema"];

// ---------------------------------------------------------------------------
// Model-tier routing (WM-135). Definitions declare INTENT — a tier from a
// closed vocabulary — never a concrete model id (the per-definition `model`
// override is the one escape hatch, and it wins over the tier). The tier →
// model mapping is operator policy, per adapter, in config/policy.yaml's
// `models:` block, so retiering the fleet is a one-line policy PR, not an
// edit fanned across every definition.

export const MODEL_TIERS = ["strong", "standard", "light"];

/**
 * The sentinel meaning "pass no model flag — use the CLI's own default".
 * Pinned verbatim into the RunSpec so the proposal an operator approves says
 * explicitly that the run rides the adapter default.
 */
export const DEFAULT_MODEL = "default";

/** Adapters that accept a model at all. command/actions/fake take none: a
 * declared tier there resolves to null (not applicable), never an error. */
export const MODEL_ADAPTERS = new Set(["claude", "pi", "agy"]);

/**
 * Read the `models:` tier map from config/policy.yaml (same root rule as
 * repos.yaml: the running factory checkout, FACTORY_REPOS_ROOT to override).
 * Shape is validated fail-closed — an unknown tier key or a non-string value
 * is a config error at load, not a surprise at dispatch. A missing file or
 * absent block is an empty map: fine until some definition declares a tier,
 * at which point resolution fails closed below.
 */
export function loadModelTierMap({ root = reposRoot() } = {}) {
  const file = path.join(root, "config", "policy.yaml");
  if (!existsSync(file)) return {};
  let parsed;
  try {
    parsed = Bun.YAML.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new RegistryError(`${file}: unparseable policy.yaml — ${err.message}`);
  }
  const models = parsed?.models;
  if (models === undefined || models === null) return {};
  if (typeof models !== "object" || Array.isArray(models)) {
    throw new RegistryError(`${file}: "models" must map adapter names to tier maps (WM-135)`);
  }
  for (const [adapter, tiers] of Object.entries(models)) {
    if (typeof tiers !== "object" || tiers === null || Array.isArray(tiers)) {
      throw new RegistryError(`${file}: models.${adapter} must map tiers to model values (WM-135)`);
    }
    for (const [tier, value] of Object.entries(tiers)) {
      if (!MODEL_TIERS.includes(tier)) {
        throw new RegistryError(`${file}: models.${adapter}.${tier} is not a tier (${MODEL_TIERS.join(", ")})`);
      }
      if (typeof value !== "string" || value.trim() === "") {
        throw new RegistryError(
          `${file}: models.${adapter}.${tier} must be a non-empty model value ("${DEFAULT_MODEL}" for the adapter default)`,
        );
      }
    }
  }
  return models;
}

/**
 * Resolve what model a definition runs on for a given adapter.
 * Order: per-definition `model` override > policy tier map > adapter default.
 * Returns null when the adapter takes no model (command/actions/fake — a
 * declared tier is recorded as not applicable, never an error) or when the
 * definition declares nothing (adapter default; today's behavior). A declared
 * tier with no mapping for a model-consuming adapter throws — fail closed,
 * never a silent fallback.
 */
export function resolveModel(def, adapter, modelTiers) {
  if (!MODEL_ADAPTERS.has(adapter)) return null;
  if (def?.model !== undefined) return def.model;
  if (def?.model_tier === undefined) return null;
  const value = modelTiers?.[adapter]?.[def.model_tier];
  if (typeof value !== "string" || value.trim() === "") {
    throw new RegistryError(
      `${def.ref ?? def.id}: model_tier "${def.model_tier}" has no mapping for adapter "${adapter}" — add models.${adapter}.${def.model_tier} to config/policy.yaml (WM-135, fail closed)`,
    );
  }
  return value;
}

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
  // Per-agent repo scoping (WM-64), the repo analogue of the actions adapter's
  // host allowlist: an optional closed set of repos the definition may run
  // over. Only the shape is checked here — membership against config/repos.yaml
  // is deliberately NOT validated at load, because repos.yaml is external
  // config that may legitimately change; the planner's plan-time check is the
  // authority. Absent field = unrestricted. An empty array is refused as a
  // half-finished edit: write the set or delete the field.
  if (def.repos !== undefined) {
    const wellFormed =
      Array.isArray(def.repos) && def.repos.length > 0 && def.repos.every((r) => typeof r === "string" && r.trim() !== "");
    if (!wellFormed) {
      throw new RegistryError(
        `${file}: "repos" must be a non-empty array of non-empty repo names (WM-64) — omit the field for an unrestricted agent`,
      );
    }
  }
  // Model-tier routing (WM-135): `model_tier` is a closed enum of intent;
  // `model` is the exact-id escape hatch. Both may coexist — the override
  // wins — but each must be well-formed, and whether a declared tier actually
  // maps to a model for the routed adapter is checked in loadRegistry, where
  // the adapter is known.
  if (def.model_tier !== undefined && !MODEL_TIERS.includes(def.model_tier)) {
    throw new RegistryError(
      `${file}: "model_tier" must be one of ${MODEL_TIERS.join(", ")} (got ${JSON.stringify(def.model_tier)}) — definitions declare intent, not model ids (WM-135)`,
    );
  }
  if (def.model !== undefined && (typeof def.model !== "string" || def.model.trim() === "")) {
    throw new RegistryError(`${file}: "model" must be a non-empty string model id — omit the field for tier/default routing (WM-135)`);
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
export function loadRegistry({ root = RUNTIME_ROOT, modelTiers = loadModelTierMap() } = {}) {
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
    // Model-tier routing (WM-135): every routed (agent, adapter) pair must
    // resolve NOW — a declared tier without a policy mapping is a load error,
    // never a silent fall-through to the adapter default at dispatch time.
    try {
      resolveModel(agents.get(mapping.agent), mapping.adapter, modelTiers);
    } catch (err) {
      throw new RegistryError(`event type ${type}: ${err.message}`);
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
      if (rule.independent !== undefined && rule.independent !== true) {
        throw new RegistryError(`edges.json: ${agentRef}.independent must be true when present`);
      }
      for (const [value, edge] of Object.entries(rule.edges ?? {})) {
        if (rule.independent === true) {
          if (typeof edge.whenItemsField !== "string" || !edge.whenItemsField) {
            throw new RegistryError(`edges.json: ${agentRef}.${value} independent edge has no whenItemsField`);
          }
          if (typeof edge.mixedEventId !== "string" || !edge.mixedEventId.includes("${runId}")) {
            throw new RegistryError(
              `edges.json: ${agentRef}.${value} independent edge needs a mixedEventId containing \${runId}`,
            );
          }
          if (edge.itemsField !== undefined && !edge.mixedEventId.includes("${item.")) {
            throw new RegistryError(
              `edges.json: ${agentRef}.${value} independent multi edge needs an item placeholder in mixedEventId`,
            );
          }
        }
        for (const field of ["eventId", "mixedEventId"]) {
          if (edge[field] !== undefined && (typeof edge[field] !== "string" || edge[field].trim() === "")) {
            throw new RegistryError(`edges.json: ${agentRef}.${value} ${field} must be a non-empty string`);
          }
        }
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

  return { root, agents, eventTypes, schemas, edges, schedules, modelTiers };
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
