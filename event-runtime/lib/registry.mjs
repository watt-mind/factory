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
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { format as prettierFormat, resolveConfig } from "prettier";
import { hashBytes } from "./canonical.mjs";
import { APPROVAL_MODES, CATCH_UP_MODES, parseCadence } from "./schedules.mjs";
import { RUNTIME_ROOT, resolveConfigPath } from "./config.mjs";
import { MEMO_KINDS, SUBJECT_TYPES } from "./memos.mjs";
import { reposRoot } from "./repos.mjs";
import { contractViewRel, validateArtifactView } from "./artifact-view.mjs";
import { PANELS_DIR, loadPanelDir, mergePanels } from "./panel-view.mjs";
import { HarnessPinError, verifyHarnessPins } from "./pins.mjs";

export class RegistryError extends Error {
  constructor(message) {
    super(message);
    this.name = "RegistryError";
  }
}

const PINNED_FIELDS = ["prompt", "input_schema", "output_schema"];
const MAP_FILES = {
  "event-types": "event-types.json",
  edges: "edges.json",
  schedules: "schedules.json",
};

function parseJson(bytes, description) {
  try {
    return JSON.parse(
      typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf8"),
    );
  } catch (err) {
    throw new RegistryError(`${description}: invalid JSON — ${err.message}`);
  }
}

function readJson(file, description = file) {
  return parseJson(readFileSync(file), description);
}

function nullDict() {
  return Object.create(null);
}

function isStrictDescendant(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/** Resolve a pack-owned resource without allowing lexical or symlink escape. */
function resolvePackResource(root, canonicalRoot, relative) {
  if (typeof relative !== "string" || relative === "") {
    throw new RegistryError("pinned resource path must be a non-empty string");
  }
  const resolved = path.resolve(root, relative);
  if (!isStrictDescendant(root, resolved)) {
    throw new RegistryError(
      `${relative}: resource resolves outside pack root ${root}`,
    );
  }
  if (!existsSync(resolved)) return resolved;
  const canonical = realpathSync(resolved);
  if (!isStrictDescendant(canonicalRoot, canonical)) {
    throw new RegistryError(
      `${relative}: resource resolves outside canonical pack root ${canonicalRoot}`,
    );
  }
  return canonical;
}

const SCHEDULE_OVERLAY_FIELDS = new Set(["enabled", "every", "payload"]);
const OPERATOR_AUTHORIZED_AUTO_SOURCE = "operator-authorized-auto";

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Instance schedule settings intentionally sit outside the pinned registry.
 * They may turn a kernel loop on, change its cadence, or add static payload
 * keys, but cannot change its event routing. Unattended approval is the one
 * exception: it requires both `approval: auto` on the loop and the same loop
 * named in the top-level `overlay_auto_approve` allowlist.
 */
function loadScheduleOverlay(file) {
  if (!existsSync(file)) {
    return { schedules: nullDict(), autoApprove: new Set() };
  }
  let parsed;
  try {
    parsed = Bun.YAML.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new RegistryError(
      `${file}: unparseable schedule.yaml — ${err.message}`,
    );
  }
  if (parsed !== null && parsed !== undefined && !isPlainObject(parsed)) {
    throw new RegistryError(`${file}: schedule.yaml must be an object`);
  }
  const allowedLoops = parsed?.overlay_auto_approve;
  if (
    allowedLoops !== undefined &&
    (!Array.isArray(allowedLoops) ||
      allowedLoops.some((loop) => typeof loop !== "string" || !loop) ||
      new Set(allowedLoops).size !== allowedLoops.length)
  ) {
    throw new RegistryError(
      `${file}: "overlay_auto_approve" must be an array of unique, non-empty loop names`,
    );
  }
  if (
    parsed?.schedules !== undefined &&
    parsed.schedules !== null &&
    !isPlainObject(parsed.schedules)
  ) {
    throw new RegistryError(`${file}: "schedules" must be an object`);
  }
  return {
    schedules: parsed?.schedules ?? nullDict(),
    autoApprove: new Set(allowedLoops ?? []),
  };
}

function cloneSchedules(schedules) {
  const clone = nullDict();
  for (const [loop, schedule] of Object.entries(schedules)) {
    clone[loop] = isPlainObject(schedule)
      ? {
          ...schedule,
          ...(isPlainObject(schedule.payload)
            ? { payload: { ...schedule.payload } }
            : {}),
        }
      : schedule;
  }
  return clone;
}

function isOverlayScheduleSource(source) {
  return source === "overlay" || source === OPERATOR_AUTHORIZED_AUTO_SOURCE;
}

function applyScheduleOverlay(kernelSchedules, overlayConfig, file) {
  const { schedules: overlay, autoApprove } = overlayConfig;
  const schedules = cloneSchedules(kernelSchedules);
  const sources = nullDict();
  for (const loop of Object.keys(schedules)) sources[loop] = "kernel";
  // Which fields the overlay itself set for a loop (existing-loop overrides
  // only, from SCHEDULE_OVERLAY_FIELDS). Used downstream to tell "the
  // overlay deliberately disabled this loop" apart from "the overlay only
  // touched payload/cadence and enabled happens to already be false" — only
  // the former is the safe emergency-stop case (WM-998 review).
  const overlayFields = nullDict();

  for (const [loop, override] of Object.entries(overlay)) {
    if (!isPlainObject(override)) {
      throw new RegistryError(`${file}: schedules.${loop} must be an object`);
    }
    if (Object.hasOwn(schedules, loop)) {
      for (const field of Object.keys(override)) {
        if (
          !SCHEDULE_OVERLAY_FIELDS.has(field) &&
          !(field === "approval" && override.approval === "auto")
        ) {
          throw new RegistryError(
            `${file}: schedules.${loop}.${field} cannot override a kernel schedule (allowed: enabled, every, payload, and approval: auto with overlay_auto_approve)`,
          );
        }
      }
      if (override.payload !== undefined && !isPlainObject(override.payload)) {
        throw new RegistryError(
          `${file}: schedules.${loop}.payload must be a plain object`,
        );
      }
      const requestedAuto = override.approval === "auto";
      const authorizedAuto = requestedAuto && autoApprove.has(loop);
      if (requestedAuto && !authorizedAuto) {
        console.warn(
          `${file}: schedules.${loop}.approval "auto" ignored — ${loop} is not named in overlay_auto_approve, so the loop remains "watched"`,
        );
      }
      schedules[loop] = {
        ...schedules[loop],
        ...override,
        ...(override.payload !== undefined
          ? {
              payload: {
                ...(schedules[loop].payload ?? {}),
                ...override.payload,
              },
            }
          : {}),
        ...(requestedAuto
          ? { approval: authorizedAuto ? "auto" : "watched" }
          : {}),
      };
      overlayFields[loop] = new Set(Object.keys(override));
      sources[loop] = authorizedAuto
        ? OPERATOR_AUTHORIZED_AUTO_SOURCE
        : "overlay";
    } else {
      // A brand-new loop the overlay is introducing has no kernel-reviewed
      // approval policy behind it. It always queues for human approval: an
      // overlay cannot grant itself "auto" on a loop nobody upstream ever
      // signed off on (WM-998 review — closes the self-approval hole).
      if (
        Object.hasOwn(override, "approval") &&
        override.approval !== "watched"
      ) {
        console.warn(
          `${file}: schedules.${loop}.approval "${override.approval}" ignored for a new overlay loop — new instance loops are always "watched"`,
        );
      }
      schedules[loop] = {
        ...override,
        ...(isPlainObject(override.payload)
          ? { payload: { ...override.payload } }
          : {}),
        approval: "watched",
      };
      overlayFields[loop] = new Set(Object.keys(override));
    }
    if (!Object.hasOwn(sources, loop)) sources[loop] = "overlay";
  }
  return { schedules, sources, overlayFields };
}

function policyFile(root) {
  return resolveConfigPath("policy", { root });
}

/**
 * Read the explicit filesystem-pack allowlist. No directory discovery is ever
 * performed: an absent block is the empty list, and malformed entries fail
 * before any pack content is read.
 */
export function loadPackRoots({ root = reposRoot() } = {}) {
  const file = policyFile(root);
  if (!existsSync(file)) return [];
  let parsed;
  try {
    parsed = Bun.YAML.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new RegistryError(
      `${file}: unparseable policy.yaml — ${err.message}`,
    );
  }
  const configured = parsed?.packs;
  if (configured === undefined || configured === null) return [];
  if (!Array.isArray(configured))
    throw new RegistryError(`${file}: "packs" must be an array`);

  const names = new Set();
  return configured.map((entry, index) => {
    const at = `${file}: packs[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new RegistryError(`${at} must be an object with name and path`);
    }
    for (const key of Object.keys(entry)) {
      if (!["name", "path", "namespace"].includes(key))
        throw new RegistryError(`${at}: unknown field "${key}"`);
    }
    if (typeof entry.name !== "string" || entry.name.trim() === "") {
      throw new RegistryError(`${at}.name must be a non-empty string`);
    }
    if (names.has(entry.name))
      throw new RegistryError(`${file}: duplicate pack name "${entry.name}"`);
    names.add(entry.name);
    if (typeof entry.path !== "string" || entry.path.trim() === "") {
      throw new RegistryError(`${at}.path must be a non-empty string`);
    }
    if (!path.isAbsolute(entry.path)) {
      throw new RegistryError(`${at}.path must be an absolute path`);
    }
    if (entry.namespace !== undefined && typeof entry.namespace !== "string") {
      throw new RegistryError(`${at}.namespace must be a string when present`);
    }
    return {
      kind: "fs",
      name: entry.name,
      path: path.resolve(entry.path),
      ...(entry.namespace !== undefined ? { namespace: entry.namespace } : {}),
    };
  });
}

/**
 * Filesystem implementation of the storage seam consumed by loadRegistry.
 * Definition parsing and pinned bytes stay behind this interface so merged
 * validation is equally usable by a future database-backed loader.
 */
export function createFsPackLoader(
  pack,
  { builtIn = false, ignorePins = false } = {},
) {
  const root = path.resolve(pack.path);
  let canonicalRoot;
  try {
    canonicalRoot = realpathSync(root);
  } catch (err) {
    throw new RegistryError(
      `pack "${pack.name}": root ${root} is not accessible — ${err.message}`,
    );
  }
  let pins;
  return {
    listAgentDefs() {
      const dir = path.join(root, "agents");
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter(isDefinitionFile)
        .sort()
        .map((name) => {
          const source = path.join(dir, name);
          return { source, definition: readJson(source) };
        });
    },
    // Optional seam member (WM-454): artifact-view sidecars are a filesystem
    // notion, so only the fs loader offers them. loadRegistry treats an
    // absent method as "this pack has no views".
    readArtifactView(entry, def) {
      return loadArtifactView(root, canonicalRoot, entry.source, def);
    },
    // Optional seam member (WM-840): `panels/*.panel.json` under the pack
    // root, validated by lib/panel-view.mjs; a pack without the directory
    // contributes no panels, and loadRegistry treats an absent method the
    // same way.
    listPanels(origin) {
      return loadPanelDir(path.join(root, PANELS_DIR), { origin });
    },
    readPinned(relative, def) {
      if (pins === undefined && !builtIn && !ignorePins) {
        const file = path.join(root, "pins.json");
        pins = existsSync(file) ? readJson(file) : nullDict();
        if (typeof pins !== "object" || pins === null || Array.isArray(pins)) {
          throw new RegistryError(`${file}: pins must be a path-to-hash map`);
        }
      }
      const file = resolvePackResource(root, canonicalRoot, relative);
      return {
        expected: builtIn
          ? Object.hasOwn(def.pins ?? nullDict(), relative)
            ? def.pins[relative]
            : undefined
          : !ignorePins && Object.hasOwn(pins, relative)
            ? pins[relative]
            : undefined,
        bytes: existsSync(file) ? readFileSync(file) : null,
        source: file,
        path: file,
      };
    },
    readMap(name) {
      const filename = MAP_FILES[name];
      if (!filename) throw new RegistryError(`unknown pack map "${name}"`);
      const file = path.join(root, filename);
      if (!existsSync(file)) return nullDict();
      const value = readJson(file);
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new RegistryError(`${file}: top level must be an object`);
      }
      return value;
    },
  };
}

function configuredPack(pack) {
  if (pack.kind !== "fs")
    throw new RegistryError(
      `pack ${pack.name}: unsupported configured kind "${pack.kind}"`,
    );
  const manifestFile = path.join(pack.path, "pack.json");
  if (!existsSync(manifestFile))
    throw new RegistryError(`pack ${pack.name}: missing ${manifestFile}`);
  const manifest = readJson(manifestFile);
  if (manifest.name !== pack.name) {
    throw new RegistryError(
      `${manifestFile}: manifest name ${JSON.stringify(manifest.name)} does not match policy name "${pack.name}"`,
    );
  }
  if (typeof manifest.version !== "string" || manifest.version.trim() === "") {
    throw new RegistryError(
      `${manifestFile}: version must be a non-empty string`,
    );
  }
  if (
    manifest.namespace !== undefined &&
    typeof manifest.namespace !== "string"
  ) {
    throw new RegistryError(
      `${manifestFile}: namespace must be a string when present`,
    );
  }
  if (
    pack.namespace !== undefined &&
    manifest.namespace !== undefined &&
    pack.namespace !== manifest.namespace
  ) {
    throw new RegistryError(
      `${manifestFile}: namespace ${JSON.stringify(manifest.namespace)} does not match policy namespace ${JSON.stringify(pack.namespace)}`,
    );
  }
  const namespace = pack.namespace ?? manifest.namespace;
  if (namespace === undefined) {
    throw new RegistryError(
      `${manifestFile}: non-built-in packs must declare namespace in the manifest or policy.yaml`,
    );
  }
  return {
    ...pack,
    root: path.resolve(pack.path),
    namespace,
    version: manifest.version,
  };
}

function injectedPack(pack) {
  if (typeof pack?.kind !== "string" || pack.kind.trim() === "") {
    throw new RegistryError("injected pack roots must declare a kind");
  }
  if (typeof pack.name !== "string" || pack.name.trim() === "") {
    throw new RegistryError(
      "injected pack roots must declare a non-empty name",
    );
  }
  if (typeof pack.namespace !== "string") {
    throw new RegistryError(
      `injected pack "${pack.name}" must declare namespace`,
    );
  }
  return {
    ...pack,
    root: pack.root ?? pack.path ?? `${pack.kind}:${pack.name}`,
  };
}

function defaultLoaderFor(pack, options) {
  if (pack.kind !== "fs") {
    throw new RegistryError(
      `pack ${pack.name}: no loader registered for kind "${pack.kind}"`,
    );
  }
  return createFsPackLoader(pack, options);
}

function assertLoader(loader, pack) {
  for (const method of ["listAgentDefs", "readPinned", "readMap"]) {
    if (typeof loader?.[method] !== "function") {
      throw new RegistryError(
        `pack ${pack.name}: loader is missing ${method}()`,
      );
    }
  }
  return loader;
}

function mergeMap(target, sources, incoming, pack, label) {
  for (const [key, value] of Object.entries(incoming)) {
    if (Object.hasOwn(target, key)) {
      throw new RegistryError(
        `duplicate ${label} ${JSON.stringify(key)} from packs "${sources[key]}" and "${pack.name}"`,
      );
    }
    target[key] = value;
    sources[key] = pack.name;
  }
}

/** Agent definition files: every `agents/*.json` except the view sidecars. */
const VIEW_SUFFIX = ".view.json";
const isDefinitionFile = (name) =>
  name.endsWith(".json") && !name.endsWith(VIEW_SUFFIX);

/**
 * Artifact-view sidecar (WM-454 / WM-897, docs/event-runtime-artifact-views.md §2):
 * `agents/<name>.view.json` beside `agents/<name>.json`, optional. When that
 * file is absent, `agents/views/<output_contract>.view.json` is the
 * contract-keyed fallback so nine command-result agents share one sidecar.
 * The agent file wins when both exist, including when it is invalid — a
 * broken agent sidecar is an anomaly, not a silent fall-through.
 *
 * Loaded and validated against the definition's output *and* input schemas;
 * a view that does not parse or does not fit is a configuration anomaly
 * (surfaced in /status.anomalies.configuration) and the agent is served
 * WITHOUT a view — never a load failure, never a rendering crash. Views are
 * not part of the definition pin (§2.3): a rendering tweak is not a
 * contract change.
 * @returns {{ file: string|null, view: object|null, source: "agent"|"contract"|null, anomaly: string|null }}
 */
function readViewFile(abs, rel, def, source) {
  let view;
  try {
    view = JSON.parse(readFileSync(abs, "utf8"));
  } catch (err) {
    return {
      file: rel,
      view: null,
      source: null,
      anomaly: `artifact view ${rel} for ${def.ref} is unparseable: ${err.message}`,
    };
  }
  const check = validateArtifactView(view, def.outputSchema, def.inputSchema);
  if (!check.valid) {
    return {
      file: rel,
      view: null,
      source: null,
      anomaly: `artifact view ${rel} for ${def.ref} does not fit its schemas (served without a view): ${check.errors.join("; ")}`,
    };
  }
  return { file: rel, view, source, anomaly: null };
}

function loadArtifactView(root, canonicalRoot, defFile, def) {
  const agentRel = path.relative(root, defFile).replace(/\.json$/, VIEW_SUFFIX);
  const agentAbs = resolvePackResource(root, canonicalRoot, agentRel);
  if (existsSync(agentAbs))
    return readViewFile(agentAbs, agentRel, def, "agent");
  const contractRel = contractViewRel(def.output_contract);
  if (contractRel) {
    const contractAbs = resolvePackResource(root, canonicalRoot, contractRel);
    if (existsSync(contractAbs))
      return readViewFile(contractAbs, contractRel, def, "contract");
  }
  return { file: null, view: null, source: null, anomaly: null };
}

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
export const MODEL_ADAPTERS = new Set(["claude", "pi", "agy", "cursor"]);

/**
 * Compose independently persisted runtime tier cells over the tracked policy
 * map. Both inputs are validated against the same closed adapter/tier
 * vocabularies as loadModelTierMap so a corrupt stored row cannot silently
 * add policy surface at startup.
 */
export function composeModelTierMap(tracked = {}, runtime = {}) {
  const effective = Object.fromEntries(
    Object.entries(tracked).map(([adapter, tiers]) => [adapter, { ...tiers }]),
  );
  for (const [adapter, tiers] of Object.entries(runtime)) {
    if (!MODEL_ADAPTERS.has(adapter)) {
      throw new RegistryError(
        `runtime model-tier override has unknown adapter ${JSON.stringify(adapter)} (expected one of ${[...MODEL_ADAPTERS].join(", ")})`,
      );
    }
    if (typeof tiers !== "object" || tiers === null || Array.isArray(tiers)) {
      throw new RegistryError(
        `runtime model-tier override for ${adapter} must map tiers to model values`,
      );
    }
    for (const [tier, model] of Object.entries(tiers)) {
      if (!MODEL_TIERS.includes(tier)) {
        throw new RegistryError(
          `runtime model-tier override ${adapter}.${tier} has unknown tier (expected ${MODEL_TIERS.join(", ")})`,
        );
      }
      if (typeof model !== "string" || model.trim() === "") {
        throw new RegistryError(
          `runtime model-tier override ${adapter}.${tier} must be a non-empty model value`,
        );
      }
      effective[adapter] = { ...(effective[adapter] ?? {}), [tier]: model };
    }
  }
  return effective;
}

/**
 * Read the `models:` tier map from config/policy.yaml (same root rule as
 * repos.yaml: the running factory checkout, FACTORY_REPOS_ROOT to override).
 * Shape is validated fail-closed — an unknown tier key or a non-string value
 * is a config error at load, not a surprise at dispatch. A missing file or
 * absent block is an empty map: fine until some definition declares a tier,
 * at which point resolution fails closed below.
 */
export function loadModelTierMap({ root = reposRoot() } = {}) {
  const file = resolveConfigPath("policy", { root });
  if (!existsSync(file)) return {};
  let parsed;
  try {
    parsed = Bun.YAML.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new RegistryError(
      `${file}: unparseable policy.yaml — ${err.message}`,
    );
  }
  const models = parsed?.models;
  if (models === undefined || models === null) return {};
  if (typeof models !== "object" || Array.isArray(models)) {
    throw new RegistryError(
      `${file}: "models" must map adapter names to tier maps (WM-135)`,
    );
  }
  for (const [adapter, tiers] of Object.entries(models)) {
    if (typeof tiers !== "object" || tiers === null || Array.isArray(tiers)) {
      throw new RegistryError(
        `${file}: models.${adapter} must map tiers to model values (WM-135)`,
      );
    }
    for (const [tier, value] of Object.entries(tiers)) {
      if (!MODEL_TIERS.includes(tier)) {
        throw new RegistryError(
          `${file}: models.${adapter}.${tier} is not a tier (${MODEL_TIERS.join(", ")})`,
        );
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

function loadAgentDef(pack, loader, entry, { builtIn = false } = {}) {
  const source = entry?.source ?? `${pack.name}: agent definition`;
  const def = entry?.definition;
  if (typeof def !== "object" || def === null || Array.isArray(def)) {
    throw new RegistryError(
      `${source}: loader returned a non-object agent definition`,
    );
  }
  for (const field of [
    "id",
    "version",
    ...PINNED_FIELDS,
    "workspace",
    "capabilities",
    "limits",
  ]) {
    if (def[field] === undefined)
      throw new RegistryError(`${source}: missing "${field}"`);
  }
  if (!builtIn && def.mutating === true) {
    throw new RegistryError(
      `${source}: config-listed pack "${pack.name}" may not declare mutating: true (WM-468 decision 4; non-bare packs are read-only)`,
    );
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
      Array.isArray(def.command) &&
      def.command.length > 0 &&
      def.command.every((e) => typeof e === "string");
    const closedActionRegistry =
      def.actionRegistry !== undefined &&
      def.hosts !== undefined &&
      Array.isArray(def.exec) &&
      Object.values(def.actionRegistry).every(
        (a) => typeof a?.remote === "string",
      ) &&
      Object.values(def.hosts).every((t) => typeof t === "string");
    // Item-list form (OPS-229): every registered action is a fixed local argv,
    // applied per approved item — closed by construction, same as the others.
    const closedItemList =
      def.actionRegistry !== undefined &&
      typeof def.itemsField === "string" &&
      typeof def.itemKey === "string" &&
      Object.values(def.actionRegistry).every(
        (a) =>
          Array.isArray(a?.argv) &&
          a.argv.length > 0 &&
          a.argv.every((e) => typeof e === "string"),
      );
    if (
      !closedArgv &&
      !closedActionRegistry &&
      !closedItemList &&
      !tier2Worktree
    ) {
      throw new RegistryError(
        `${source}: mutating agents are admitted only as closed command templates, closed action registries, or tier-2 worktree agents (docs/event-runtime.md §14; docs/event-runtime-dispatch.md §6; OPS-223/OPS-208/WM-108)`,
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
      Array.isArray(def.repos) &&
      def.repos.length > 0 &&
      def.repos.every((r) => typeof r === "string" && r.trim() !== "");
    if (!wellFormed) {
      throw new RegistryError(
        `${source}: "repos" must be a non-empty array of non-empty repo names (WM-64) — omit the field for an unrestricted agent`,
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
      `${source}: "model_tier" must be one of ${MODEL_TIERS.join(", ")} (got ${JSON.stringify(def.model_tier)}) — definitions declare intent, not model ids (WM-135)`,
    );
  }
  if (
    def.model !== undefined &&
    (typeof def.model !== "string" || def.model.trim() === "")
  ) {
    throw new RegistryError(
      `${source}: "model" must be a non-empty string model id — omit the field for tier/default routing (WM-135)`,
    );
  }
  if (
    def.chainCommandEdges !== undefined &&
    (!Array.isArray(def.chainCommandEdges) ||
      def.chainCommandEdges.length === 0 ||
      !def.chainCommandEdges.every(
        (type) => typeof type === "string" && type.trim() !== "",
      ))
  ) {
    throw new RegistryError(
      `${source}: "chainCommandEdges" must be a non-empty array of non-empty event type strings`,
    );
  }
  if (
    def.chainRepoMustMatchInput !== undefined &&
    def.chainRepoMustMatchInput !== true
  ) {
    throw new RegistryError(
      `${source}: "chainRepoMustMatchInput" must be true when present`,
    );
  }
  if (def.dispatchGateExempt !== undefined) {
    if (def.dispatchGateExempt !== true) {
      throw new RegistryError(
        `${source}: "dispatchGateExempt" must be true when present`,
      );
    }
    if (def.workspace?.type !== "worktree") {
      throw new RegistryError(
        `${source}: "dispatchGateExempt" is admissible only for workspace.type "worktree"`,
      );
    }
  }

  const resources = {};
  const pins = {};
  for (const field of PINNED_FIELDS) {
    const rel = def[field];
    const resource = loader.readPinned(rel, def);
    if (typeof resource !== "object" || resource === null) {
      throw new RegistryError(
        `${source}: loader returned no pinned resource for "${rel}"`,
      );
    }
    const resourceSource = resource.source ?? `${source}: ${rel}`;
    if (resource.bytes === null || resource.bytes === undefined) {
      throw new RegistryError(
        `${resourceSource}: pinned file "${rel}" does not exist`,
      );
    }
    const actual = hashBytes(resource.bytes);
    const pinCommand = builtIn
      ? "bun event-runtime/cli.mjs update-pins"
      : `bun event-runtime/cli.mjs update-pins --pack ${pack.name}`;
    if (!resource.expected)
      throw new RegistryError(
        `${source}: "${rel}" has no pin — run: ${pinCommand}`,
      );
    if (resource.expected !== actual) {
      throw new RegistryError(
        `${resourceSource}: "${rel}" content ${actual} does not match pin ${resource.expected} — bump the version (and re-pin) instead of editing in place`,
      );
    }
    pins[rel] = resource.expected;
    resources[field] = resource;
  }
  const promptPath = resources.prompt.path ?? resources.prompt.source;
  if (typeof promptPath !== "string" || promptPath === "") {
    throw new RegistryError(
      `${source}: loader returned no prompt path for "${def.prompt}"`,
    );
  }
  const localRef = `${def.id}@${def.version}`;
  const loaded = {
    ...def,
    pins,
    ref: pack.namespace ? `${pack.namespace}/${localRef}` : localRef,
    promptPath,
    inputSchema: parseJson(
      resources.input_schema.bytes,
      resources.input_schema.source ?? def.input_schema,
    ),
    outputSchema: parseJson(
      resources.output_schema.bytes,
      resources.output_schema.source ?? def.output_schema,
    ),
  };
  // Which pack supplied the definition is runtime provenance, not definition
  // content: it is loader-injected and identical for every built-in agent. It
  // is defined non-enumerably so `computeDefHash` (receipts.mjs), which strips
  // known runtime-injected fields and hashes the enumerable rest, never sees
  // it. Adding it enumerably would silently change the attested defHash of
  // every built-in agent on a zero-pack no-op, and `verifyDefHash` would then
  // terminally refuse those definitions with `agent_definition_mismatch`.
  // `def.pack` still reads normally for callers and tests.
  Object.defineProperty(loaded, "pack", {
    value: pack.name,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  // Prompt execution and publication must use the exact immutable bytes whose
  // digest was accepted above, never a later read through the mutable path.
  // Keep this runtime snapshot non-enumerable for receipt/registry identity.
  Object.defineProperty(loaded, "promptText", {
    value: Buffer.from(resources.prompt.bytes).toString("utf8"),
    enumerable: false,
  });
  // The definition's own JSON file, kept non-enumerably for the same reason as
  // `pack`: it is loader-injected filesystem provenance, not definition content
  // hashed into the defHash. Overlay promotion (gh-860) needs the owning file to
  // write a tracked model_tier/model default; `agentDefinitionFile` reads it.
  Object.defineProperty(loaded, "defSource", {
    value: entry?.source ?? null,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  if (def.memos !== undefined) {
    validateMemosDeclaration(def.memos, {
      source,
      inputSchema: loaded.inputSchema,
    });
  }
  return loaded;
}

const MEMO_INPUT_PATH =
  /^\$\.input\.([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)$/;
const MEMO_DECL_KEYS = new Set(["subject", "kinds", "max"]);
const MEMO_SUBJECT_KEYS = new Set(["type", "id"]);

/**
 * Does `dotted` (e.g. `ticket` or `runPin.transcript`) resolve against a JSON
 * Schema the way §4.1 requires: a load error, not a runtime surprise.
 * `additionalProperties: false` is closed; an object schema that allows extra
 * properties accepts any remaining segment.
 */
export function inputSchemaHasPath(schema, dotted) {
  if (typeof dotted !== "string" || dotted.length === 0) return false;
  const keys = dotted.split(".");
  let current = schema;
  for (const key of keys) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return false;
    }
    if (current.properties && Object.hasOwn(current.properties, key)) {
      current = current.properties[key];
      continue;
    }
    if (current.additionalProperties === false) return false;
    if (
      typeof current.additionalProperties === "object" &&
      current.additionalProperties !== null
    ) {
      current = current.additionalProperties;
      continue;
    }
    return true;
  }
  return true;
}

/**
 * Validate the optional definition `memos` block (docs/event-runtime-memos.md
 * §4.1). Unknown kinds, subject types, fields, or input paths that the input
 * schema cannot name fail at load.
 */
export function validateMemosDeclaration(memos, { source, inputSchema } = {}) {
  const at = source ? `${source}: "memos"` : `"memos"`;
  if (!Array.isArray(memos)) {
    throw new RegistryError(`${at} must be an array of subject declarations`);
  }
  for (const [index, entry] of memos.entries()) {
    const entryAt = `${at}[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new RegistryError(`${entryAt} must be an object`);
    }
    for (const key of Object.keys(entry)) {
      if (!MEMO_DECL_KEYS.has(key)) {
        throw new RegistryError(`${entryAt}: unknown field "${key}"`);
      }
    }
    const subject = entry.subject;
    if (!subject || typeof subject !== "object" || Array.isArray(subject)) {
      throw new RegistryError(`${entryAt}.subject must be { type, id }`);
    }
    for (const key of Object.keys(subject)) {
      if (!MEMO_SUBJECT_KEYS.has(key)) {
        throw new RegistryError(`${entryAt}.subject: unknown field "${key}"`);
      }
    }
    if (!SUBJECT_TYPES.includes(subject.type)) {
      throw new RegistryError(
        `${entryAt}.subject.type must be one of ${SUBJECT_TYPES.join(", ")} (got ${JSON.stringify(subject.type)})`,
      );
    }
    const pathMatch =
      typeof subject.id === "string" ? MEMO_INPUT_PATH.exec(subject.id) : null;
    if (!pathMatch) {
      throw new RegistryError(
        `${entryAt}.subject.id must be a $.input.<path> reference (got ${JSON.stringify(subject.id)})`,
      );
    }
    if (inputSchema && !inputSchemaHasPath(inputSchema, pathMatch[1])) {
      throw new RegistryError(
        `${entryAt}.subject.id "${subject.id}" does not resolve against the input schema`,
      );
    }
    if (entry.kinds !== undefined) {
      if (
        !Array.isArray(entry.kinds) ||
        entry.kinds.length === 0 ||
        !entry.kinds.every((kind) => typeof kind === "string")
      ) {
        throw new RegistryError(
          `${entryAt}.kinds must be a non-empty array of kind names`,
        );
      }
      for (const kind of entry.kinds) {
        if (!MEMO_KINDS.includes(kind)) {
          throw new RegistryError(
            `${entryAt}.kinds: unknown kind ${JSON.stringify(kind)} — must be one of ${MEMO_KINDS.join(", ")}`,
          );
        }
      }
    }
    if (entry.max !== undefined) {
      if (!Number.isInteger(entry.max) || entry.max < 1) {
        throw new RegistryError(
          `${entryAt}.max must be a positive integer (got ${JSON.stringify(entry.max)})`,
        );
      }
    }
  }
}

/**
 * Load the built-in registry first, then explicitly configured filesystem
 * packs in policy order. Validation below sees only the fully merged view, so
 * a pack event may route to an agent supplied by an earlier root.
 */
export function loadRegistry({
  root = RUNTIME_ROOT,
  packRoots,
  panelRoots = [],
  harnessRoots = [],
  modelTiers = loadModelTierMap(),
  trackedModelTiers = modelTiers,
  loaderFor = defaultLoaderFor,
  // Unit tests must describe the committed kernel unless they explicitly
  // pass an overlay fixture. Dispatched worktrees intentionally contain a
  // copy of the operator's ignored config/schedule.yaml; letting that ambient
  // instance state leak into `bun test` makes kernel expectations depend on
  // whichever loops the operator currently enabled. Operational processes do
  // not set NODE_ENV=test and continue to resolve the effective local config.
  scheduleConfigPath = process.env.NODE_ENV === "test"
    ? path.join(path.dirname(root), "config", ".test-no-schedule.yaml")
    : resolveConfigPath("schedule", {
        root: path.dirname(root),
        warn: false,
      }),
} = {}) {
  const configured =
    packRoots ??
    (path.resolve(root) === path.resolve(RUNTIME_ROOT) ? loadPackRoots() : []);
  if (!Array.isArray(configured))
    throw new RegistryError("packRoots must be an array");
  if (typeof loaderFor !== "function")
    throw new RegistryError("loaderFor must be a function");
  if (!Array.isArray(panelRoots))
    throw new RegistryError("panelRoots must be an array");
  if (!Array.isArray(harnessRoots))
    throw new RegistryError("harnessRoots must be an array");
  if (harnessRoots.length > 0) {
    try {
      verifyHarnessPins(harnessRoots, {
        file: path.join(path.resolve(root), "pins.json"),
      });
    } catch (err) {
      if (err instanceof HarnessPinError) throw new RegistryError(err.message);
      throw err;
    }
  }

  const builtIn = {
    kind: "fs",
    name: "event-runtime",
    path: path.resolve(root),
    root: path.resolve(root),
    namespace: "",
  };
  const packs = [
    builtIn,
    ...configured.map((pack) =>
      pack.kind === "fs" ? configuredPack(pack) : injectedPack(pack),
    ),
  ];
  const bare = packs.filter((pack) => pack.namespace === "");
  if (bare.length !== 1) {
    throw new RegistryError(
      `exactly one pack must own the bare namespace; found ${bare.length}: ${bare.map((p) => p.name).join(", ")}`,
    );
  }

  const agents = new Map();
  const agentSources = new Map();
  const views = new Map();
  const anomalies = [];
  // Panels (WM-840): one batch per contributor, merged after the loop so a
  // duplicate name is reported against the contributor that got there first.
  const panelBatches = [];
  const eventTypes = nullDict();
  const edges = nullDict();
  const schedules = nullDict();
  const eventSources = nullDict();
  const edgeSources = nullDict();
  const scheduleSources = nullDict();

  for (const [index, pack] of packs.entries()) {
    const builtInPack = index === 0;
    const loader = assertLoader(
      loaderFor(pack, { builtIn: builtInPack }),
      pack,
    );
    for (const entry of loader.listAgentDefs()) {
      const def = loadAgentDef(pack, loader, entry, { builtIn: builtInPack });
      if (agents.has(def.ref)) {
        throw new RegistryError(
          `duplicate agent ref ${JSON.stringify(def.ref)} from packs "${agentSources.get(def.ref)}" and "${pack.name}"`,
        );
      }
      agents.set(def.ref, def);
      agentSources.set(def.ref, pack.name);
      // Kept off the definition object so receipts' defHash and the pinned
      // identity never see the view (§2.3). Loaders that expose no sidecars
      // (non-fs packs) simply contribute no view.
      const { file, view, source, anomaly } = loader.readArtifactView?.(
        entry,
        def,
      ) ?? {
        file: null,
        view: null,
        source: null,
        anomaly: null,
      };
      if (anomaly) anomalies.push(anomaly);
      views.set(def.ref, { file, view, source: source ?? null });
    }
    if (typeof loader.listPanels === "function") {
      panelBatches.push(
        loader.listPanels(builtInPack ? "builtin" : `pack:${pack.namespace}`),
      );
    }
    mergeMap(
      eventTypes,
      eventSources,
      loader.readMap("event-types"),
      pack,
      "event type",
    );
    mergeMap(edges, edgeSources, loader.readMap("edges"), pack, "edge source");
    mergeMap(
      schedules,
      scheduleSources,
      loader.readMap("schedules"),
      pack,
      "schedule loop",
    );
  }

  // Keep kernel schedules separate from the effective runtime view: the
  // former is the pinned registry input, while the ignored local config is
  // deliberately instance state just like policy.yaml.
  const kernelSchedules = cloneSchedules(schedules);
  const overlaidSchedules = applyScheduleOverlay(
    kernelSchedules,
    loadScheduleOverlay(scheduleConfigPath),
    scheduleConfigPath,
  );
  const effectiveSchedules = overlaidSchedules.schedules;
  const effectiveScheduleSources = overlaidSchedules.sources;
  const effectiveScheduleOverlayFields = overlaidSchedules.overlayFields;

  // Extension-contributed panel directories (`contributes.panels`,
  // lib/extensions.mjs) load after every pack, so a pack panel outranks an
  // extension panel of the same name exactly as policy order says.
  // Harness roots (`contributes.harness`, WM-849) are stored for emit /
  // introspection and are not registry content — markdown skills and
  // commands are packaged by build/emit.mjs, not loaded as agents.
  for (const { dir, origin, base } of panelRoots) {
    if (typeof dir !== "string" || typeof origin !== "string") {
      throw new RegistryError("panelRoots entries must be { dir, origin }");
    }
    panelBatches.push(loadPanelDir(dir, { origin, base }));
  }
  const merged = mergePanels(panelBatches);
  anomalies.push(...merged.anomalies);
  const panels = merged.panels;

  for (const [type, mapping] of Object.entries(eventTypes)) {
    if (
      typeof mapping !== "object" ||
      mapping === null ||
      Array.isArray(mapping)
    ) {
      throw new RegistryError(`event type ${type} must map to an object`);
    }
    const agentRef = Object.hasOwn(mapping, "agent")
      ? mapping.agent
      : undefined;
    // Observe-only types (WM-75): admitted and recorded, resolved by the
    // planner as a typed NOOP — never a run, never a human_needed ask. They
    // name no agent, and naming one anyway is a config error, not a hint.
    if (Object.hasOwn(mapping, "observe") && mapping.observe === true) {
      if (agentRef) {
        throw new RegistryError(
          `event type ${type} is observe-only but names agent ${agentRef} — pick one`,
        );
      }
      continue;
    }
    if (!agentRef || !agents.has(agentRef)) {
      throw new RegistryError(
        `event type ${type} maps to unregistered agent ${agentRef}`,
      );
    }
    if (
      !Object.hasOwn(mapping, "idempotencyScope") ||
      !Array.isArray(mapping.idempotencyScope) ||
      mapping.idempotencyScope.length === 0
    ) {
      throw new RegistryError(
        `event type ${type} declares no idempotency scope (§5.4)`,
      );
    }
    // Model-tier routing (WM-135): every routed (agent, adapter) pair must
    // resolve NOW — a declared tier without a policy mapping is a load error,
    // never a silent fall-through to the adapter default at dispatch time.
    try {
      resolveModel(agents.get(agentRef), mapping.adapter, modelTiers);
    } catch (err) {
      throw new RegistryError(`event type ${type}: ${err.message}`);
    }
  }

  // Command-emitted chain edges are definition data, but they still target
  // the one merged event registry. Validate only after every pack's maps have
  // been merged so namespaced packs can target another loaded pack safely.
  for (const [agentRef, def] of agents) {
    for (const eventType of def.chainCommandEdges ?? []) {
      if (!Object.hasOwn(eventTypes, eventType)) {
        throw new RegistryError(
          `${agentSources.get(agentRef)} agent ${agentRef}: chainCommandEdges targets unregistered event type ${eventType}`,
        );
      }
    }
  }

  // Kernel envelopes are never supplied by packs. Agent I/O schemas are read
  // and pinned by each pack loader while definitions are loaded above.
  const schemas = {
    envelope: readJson(path.join(root, "schemas", "factory.event.v1.json")),
    agentResult: readJson(
      path.join(root, "schemas", "factory.agent-result.v1.json"),
    ),
  };

  // Recommendation edges (OPS-223): validated fail-closed at load — a chain
  // may only connect registered agents through registered event types, and
  // input mappings may only draw from the source run's input or artifact.
  for (const [agentRef, rule] of Object.entries(edges)) {
    if (!agents.has(agentRef))
      throw new RegistryError(
        `edges.json: unregistered source agent ${agentRef}`,
      );
    if (typeof rule !== "object" || rule === null || Array.isArray(rule)) {
      throw new RegistryError(`edges.json: ${agentRef} must map to an object`);
    }
    if (
      !Object.hasOwn(rule, "recommendationField") ||
      typeof rule.recommendationField !== "string" ||
      !rule.recommendationField
    ) {
      throw new RegistryError(
        `edges.json: ${agentRef} has no recommendationField`,
      );
    }
    if (Object.hasOwn(rule, "independent") && rule.independent !== true) {
      throw new RegistryError(
        `edges.json: ${agentRef}.independent must be true when present`,
      );
    }
    const ruleEdges = Object.hasOwn(rule, "edges") ? rule.edges : {};
    if (
      typeof ruleEdges !== "object" ||
      ruleEdges === null ||
      Array.isArray(ruleEdges)
    ) {
      throw new RegistryError(
        `edges.json: ${agentRef}.edges must be an object`,
      );
    }
    for (const [value, edge] of Object.entries(ruleEdges)) {
      if (typeof edge !== "object" || edge === null || Array.isArray(edge)) {
        throw new RegistryError(
          `edges.json: ${agentRef}.${value} must be an object`,
        );
      }
      if (rule.independent === true) {
        if (typeof edge.whenItemsField !== "string" || !edge.whenItemsField) {
          throw new RegistryError(
            `edges.json: ${agentRef}.${value} independent edge has no whenItemsField`,
          );
        }
        if (
          typeof edge.mixedEventId !== "string" ||
          !edge.mixedEventId.includes("${runId}")
        ) {
          throw new RegistryError(
            `edges.json: ${agentRef}.${value} independent edge needs a mixedEventId containing \${runId}`,
          );
        }
        if (
          edge.itemsField !== undefined &&
          !edge.mixedEventId.includes("${item.")
        ) {
          throw new RegistryError(
            `edges.json: ${agentRef}.${value} independent multi edge needs an item placeholder in mixedEventId`,
          );
        }
      }
      for (const field of ["eventId", "mixedEventId"]) {
        if (
          edge[field] !== undefined &&
          (typeof edge[field] !== "string" || edge[field].trim() === "")
        ) {
          throw new RegistryError(
            `edges.json: ${agentRef}.${value} ${field} must be a non-empty string`,
          );
        }
      }
      const edgeEventType = Object.hasOwn(edge, "eventType")
        ? edge.eventType
        : undefined;
      if (!edgeEventType || !Object.hasOwn(eventTypes, edgeEventType)) {
        throw new RegistryError(
          `edges.json: ${agentRef}.${value} targets unregistered event type ${edgeEventType}`,
        );
      }
      for (const expr of Object.values(edge.input ?? {})) {
        if (
          typeof expr === "string" &&
          expr.startsWith("$.") &&
          !/^\$\.(input|artifact|artifactHash)(\.|$)/.test(expr)
        ) {
          throw new RegistryError(
            `edges.json: ${agentRef}.${value} input path "${expr}" — only $.input.*, $.artifact.* and $.artifactHash.* are allowed`,
          );
        }
      }
    }
  }

  // Schedules (OPS-381): validated fail-closed at load — an unparseable
  // cadence or an unregistered event type must be a startup error, not a
  // surprise at 03:00 when nothing fires.
  for (const [loop, schedule] of Object.entries(effectiveSchedules)) {
    const scheduleFile = isOverlayScheduleSource(effectiveScheduleSources[loop])
      ? scheduleConfigPath
      : "schedules.json";
    if (!/^[a-z][a-z0-9-]*$/.test(loop))
      throw new RegistryError(`${scheduleFile}: bad loop name "${loop}"`);
    if (
      typeof schedule !== "object" ||
      schedule === null ||
      Array.isArray(schedule)
    ) {
      throw new RegistryError(`${scheduleFile}: ${loop} must map to an object`);
    }
    try {
      parseCadence(schedule.every);
    } catch (err) {
      throw new RegistryError(`${scheduleFile}: ${loop}: ${err.message}`);
    }
    const scheduleEventType = Object.hasOwn(schedule, "eventType")
      ? schedule.eventType
      : undefined;
    if (!scheduleEventType || !Object.hasOwn(eventTypes, scheduleEventType)) {
      throw new RegistryError(
        `${scheduleFile}: ${loop} fires unregistered event type ${scheduleEventType}`,
      );
    }
    const catchUp = schedule.catchUp ?? "none";
    if (!CATCH_UP_MODES.includes(catchUp)) {
      throw new RegistryError(
        `${scheduleFile}: ${loop} has unknown catchUp "${catchUp}" (${CATCH_UP_MODES.join(", ")})`,
      );
    }
    const approval = schedule.approval ?? "watched";
    if (!APPROVAL_MODES.includes(approval)) {
      throw new RegistryError(
        `${scheduleFile}: ${loop} has unknown approval "${approval}" (${APPROVAL_MODES.join(", ")})`,
      );
    }
    // Unattended approval on a kernel loop that is not even switched on is
    // almost certainly a half-finished edit; refuse it rather than let it
    // lurk. A local overlay may deliberately switch an auto kernel loop off:
    // it cannot make that loop run, and is the safe emergency-stop case. That
    // exemption only holds when the overlay's own override is what set
    // `enabled: false` — a payload- or cadence-only override riding on top
    // of an already-disabled kernel loop does not touch the approval
    // boundary and must still fail closed (WM-998 review).
    const overlayDisabledThisLoop =
      isOverlayScheduleSource(effectiveScheduleSources[loop]) &&
      Boolean(effectiveScheduleOverlayFields[loop]?.has("enabled"));
    if (approval === "auto" && !schedule.enabled && !overlayDisabledThisLoop) {
      throw new RegistryError(
        `${scheduleFile}: ${loop} declares approval "auto" but is not enabled — decide one`,
      );
    }
    // The ship chain's deploy-branch merge is PERMANENTLY watched: that
    // approval IS the human master decision, so the config that would
    // delete it cannot load, whoever writes it and however good the track
    // record looks (docs/event-runtime-dispatch.md §7, WM-111).
    const scheduledMapping = eventTypes[scheduleEventType];
    if (
      approval === "auto" &&
      Object.hasOwn(scheduledMapping, "humanApprovalOnly") &&
      scheduledMapping.humanApprovalOnly === true
    ) {
      throw new RegistryError(
        `${scheduleFile}: ${loop} declares approval "auto" but ${scheduleEventType} is humanApprovalOnly — the deploy-branch decision is permanently the human's watched approval (docs/event-runtime-dispatch.md §7, WM-111)`,
      );
    }
    // A static payload rides along on every tick (repo-scoped loops need
    // {repo}). Tick fields always win the merge, so a payload claiming
    // loop/slot identity is a config error, not a spoofing vector.
    if (schedule.payload !== undefined) {
      if (
        typeof schedule.payload !== "object" ||
        schedule.payload === null ||
        Array.isArray(schedule.payload)
      ) {
        throw new RegistryError(
          `${scheduleFile}: ${loop} payload must be a plain object`,
        );
      }
      for (const reserved of [
        "loop",
        "slot",
        "cadenceSeconds",
        "skippedSlots",
      ]) {
        if (reserved in schedule.payload) {
          throw new RegistryError(
            `${scheduleFile}: ${loop} payload must not set reserved tick field "${reserved}"`,
          );
        }
      }
    }
  }

  return {
    root,
    packs: packs.map(({ name, root: packRoot, namespace }) => ({
      name,
      root: packRoot,
      namespace,
    })),
    agents,
    views,
    panels,
    anomalies,
    eventTypes,
    schemas,
    edges,
    schedules: effectiveSchedules,
    kernelSchedules,
    scheduleSources: effectiveScheduleSources,
    modelTiers,
    trackedModelTiers,
    harnessRoots,
  };
}

/** The artifact view for a registered agent: `{ file, view, source }`, all null when the agent has none. */
export function getArtifactView(registry, ref) {
  return registry.views?.get(ref) ?? { file: null, view: null, source: null };
}

export function getAgent(registry, ref) {
  const def = registry.agents.get(ref);
  if (!def) throw new RegistryError(`unregistered agent ${ref}`);
  return def;
}

/**
 * The repo-relative JSON file that owns an agent's tracked defaults (gh-860).
 * Overlay promotion writes model_tier/model into this file inside an isolated
 * worktree; it never resolves against the live checkout. `root` defaults to the
 * registry root the definition was loaded from, so the returned `file` is the
 * path a `worktree_up` checkout of the same repo would carry.
 *
 * @returns {{ ref: string, file: string, absSource: string }}
 */
export function agentDefinitionFile(
  registry,
  ref,
  { root = registry.root } = {},
) {
  const def = registry.agents.get(ref);
  if (!def) throw new RegistryError(`unregistered agent ${ref}`);
  const absSource = def.defSource;
  if (typeof absSource !== "string" || absSource.trim() === "") {
    throw new RegistryError(
      `agent ${JSON.stringify(ref)} has no owning definition file (not a filesystem pack)`,
    );
  }
  if (!path.isAbsolute(absSource)) {
    throw new RegistryError(
      `agent ${JSON.stringify(ref)} definition source ${JSON.stringify(absSource)} is not an absolute path`,
    );
  }
  const file = path.relative(path.resolve(root), absSource);
  if (file.startsWith("..") || path.isAbsolute(file)) {
    throw new RegistryError(
      `agent ${JSON.stringify(ref)} definition ${JSON.stringify(absSource)} is outside root ${JSON.stringify(root)}`,
    );
  }
  return { ref: def.ref, file, absSource };
}

export function getEventType(registry, type) {
  return Object.hasOwn(registry.eventTypes, type)
    ? registry.eventTypes[type]
    : null;
}

/**
 * Serialize `value` as JSON exactly as Prettier 3 would under the repository
 * configuration for `file`, so a re-pin write leaves the definition canonical
 * (WM-1119). Prettier's formatter is async; `updatePins` awaits it. `file` is
 * only used to select the parser and resolve `.prettierrc`, not read or written.
 */
async function formatJsonCanonical(file, value) {
  const options = await resolveConfig(file);
  return prettierFormat(`${JSON.stringify(value)}\n`, {
    ...options,
    filepath: file,
  });
}

/**
 * Recompute pins deliberately. With no `pack`, this is byte-for-byte the
 * built-in behavior: inline pins in built-in definitions only. A configured
 * pack must be named explicitly and receives one root-level pins.json.
 * `check: true` reports the same changed names without writing (WM-811).
 * Changed built-in definitions are re-emitted in Prettier-canonical form so a
 * re-pin does not redden `format:check` (WM-1119); this makes `updatePins`
 * async — callers must await it.
 */
export async function updatePins({
  root = RUNTIME_ROOT,
  pack,
  check = false,
} = {}) {
  if (pack !== undefined) {
    let descriptor = pack;
    if (typeof pack === "string") {
      const policyPacks = loadPackRoots();
      descriptor = policyPacks.find((candidate) => candidate.name === pack);
      if (!descriptor) {
        // Extension-contributed packs (gh-857): metadata-only discovery so a
        // stale extension pins.json can be repaired without importing the
        // extension. Imported lazily — extensions.mjs depends on this module.
        const { discoverExtensionPackRoots } = await import("./extensions.mjs");
        [descriptor] = discoverExtensionPackRoots({
          packRoots: policyPacks,
          name: pack,
        });
      }
      if (!descriptor)
        throw new RegistryError(`unknown configured pack "${pack}"`);
    }
    const resolved = configuredPack(descriptor);
    const loader = createFsPackLoader(resolved, { ignorePins: true });
    const pins = {};
    for (const entry of loader.listAgentDefs()) {
      const def = entry.definition;
      for (const field of PINNED_FIELDS) {
        const rel = def[field];
        if (!rel) continue;
        const resource = loader.readPinned(rel, def);
        if (resource.bytes === null || resource.bytes === undefined) {
          throw new RegistryError(
            `${resource.source ?? entry.source}: pinned file "${rel}" does not exist`,
          );
        }
        pins[rel] = hashBytes(resource.bytes);
      }
    }
    const pinsFile = path.join(resolved.root, "pins.json");
    const serialized = `${JSON.stringify(pins, null, 2)}\n`;
    if (existsSync(pinsFile) && readFileSync(pinsFile, "utf8") === serialized)
      return [];
    if (!check) writeFileSync(pinsFile, serialized, "utf8");
    return [resolved.name];
  }

  const changed = [];
  const resolvedRoot = path.resolve(root);
  const canonicalRoot = realpathSync(resolvedRoot);
  const agentsDir = path.join(resolvedRoot, "agents");
  for (const name of readdirSync(agentsDir).filter(isDefinitionFile).sort()) {
    const file = path.join(agentsDir, name);
    const def = readJson(file);
    const pins = {};
    for (const field of PINNED_FIELDS) {
      if (!def[field]) continue;
      pins[def[field]] = hashBytes(
        readFileSync(
          resolvePackResource(resolvedRoot, canonicalRoot, def[field]),
        ),
      );
    }
    if (JSON.stringify(def.pins) !== JSON.stringify(pins)) {
      if (!check) {
        writeFileSync(
          file,
          await formatJsonCanonical(file, { ...def, pins }),
          "utf8",
        );
      }
      changed.push(name);
    }
  }
  return changed;
}
