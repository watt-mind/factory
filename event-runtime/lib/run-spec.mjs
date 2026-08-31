/** Pure RunSpec assembly shared by initial planning and proposal re-planning. */
import path from "node:path";

import { hashJson } from "./canonical.mjs";
import { FACTORY_ROOT } from "./config.mjs";
import { hashHarnessRoots } from "./pins.mjs";
import { getAgent, MODEL_ADAPTERS, resolveModel } from "./registry.mjs";
import { pinRepo } from "./repository.mjs";
import { reposRoot } from "./repos.mjs";
import { computeDefHash } from "./receipts.mjs";
import { plannedDef } from "./runtime-overrides.mjs";
import { policyDispatchSecurity } from "./runtime-policy.mjs";

/** §5.4 idempotency key: definition, contract, then declared scope fields. */
export function idempotencyKeyFor(mapping, def, envelope, inputHash) {
  const parts = mapping.idempotencyScope.map((field) => {
    switch (field) {
      case "correlationId":
        return envelope.correlationId ?? envelope.eventId;
      case "subject":
        return envelope.subject ?? "";
      case "inputHash":
        return inputHash;
      default:
        throw new Error(
          `unknown idempotency scope field "${field}" (docs/event-runtime.md §5.4 — fail closed)`,
        );
    }
  });
  return `${def.ref}:${def.output_contract}:${parts.join(":")}`;
}

/** Return a typed mismatch when a tier model belongs to another adapter. */
export function modelAdapterMismatch(
  spec,
  modelTiers,
  adapter,
  { explicitPin } = {},
) {
  if (spec?.model == null || explicitPin === true) return null;
  if (!MODEL_ADAPTERS.has(adapter)) return null;
  const allowed = Object.values(modelTiers?.[adapter] ?? {});
  if (allowed.includes(spec.model)) return null;
  if (explicitPin === undefined) {
    const foreignTierValue = Object.entries(modelTiers ?? {}).some(
      ([name, tiers]) =>
        name !== adapter && Object.values(tiers ?? {}).includes(spec.model),
    );
    if (!foreignTierValue) return null;
  }
  return `model_adapter_mismatch: model ${JSON.stringify(spec.model)} is not configured for adapter ${JSON.stringify(adapter)}`;
}

/** Closed identifiers for `def.harness.{skills,commands,subagents}` (WM-851). */
export const HARNESS_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
export const HARNESS_KINDS = Object.freeze(["skills", "commands", "subagents"]);

export function harnessFromDef(def) {
  if (def?.harness === undefined) return undefined;
  return normalizeHarness(def.harness, def.ref ?? def.id ?? "harness");
}

function harnessRootsForSpec(registry) {
  if (Array.isArray(registry?.harnessRoots) && registry.harnessRoots.length) {
    return registry.harnessRoots;
  }
  const dir = path.join(FACTORY_ROOT, "shared");
  return [
    {
      dir,
      plugin: "core",
      origin: "builtin",
      name: "factory/core",
      version: "0.1.0",
      floor: path.join(dir, "floor.md"),
      commands: path.join(dir, "commands"),
      skills: path.join(dir, "skills"),
      subagents: path.join(dir, "agents"),
    },
  ];
}

/** Pin only source files selected by the definition's harness declaration. */
export function harnessPinsForSpec(registry, harness) {
  if (!harness || typeof harness !== "object") return undefined;
  const roots = harnessRootsForSpec(registry);
  const catalogPins = hashHarnessRoots(roots);
  const selected = {};

  for (const root of roots) {
    const files = catalogPins[root.plugin]?.files ?? {};
    const picked = {};
    for (const kind of HARNESS_KINDS) {
      const dir = root[kind];
      const names = Array.isArray(harness[kind]) ? harness[kind] : [];
      if (typeof dir !== "string") continue;
      for (const name of names) {
        const source = path.relative(
          root.dir,
          path.join(dir, kind === "skills" ? name : `${name}.md`),
        );
        for (const [file, hash] of Object.entries(files)) {
          if (file === source || file.startsWith(`${source}/`)) {
            picked[file] = hash;
          }
        }
      }
    }
    if (Object.keys(picked).length > 0) {
      selected[root.plugin] = { ...catalogPins[root.plugin], files: picked };
    }
  }
  return Object.keys(selected).length > 0 ? selected : undefined;
}

export function normalizeHarness(raw, source = "harness") {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `${source}: "harness" must be an object { skills?, commands?, subagents? }`,
    );
  }
  const allowed = new Set(HARNESS_KINDS);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new Error(
        `${source}: "harness" unknown key "${key}" (allowed: ${HARNESS_KINDS.join(", ")})`,
      );
    }
  }
  const out = {};
  for (const kind of HARNESS_KINDS) {
    if (raw[kind] === undefined) continue;
    const names = raw[kind];
    const wellFormed =
      Array.isArray(names) &&
      names.every((name) =>
        typeof name === "string" ? HARNESS_NAME_PATTERN.test(name) : false,
      );
    if (!wellFormed) {
      throw new Error(
        `${source}: "harness.${kind}" must be an array of names matching ${HARNESS_NAME_PATTERN}`,
      );
    }
    out[kind] = [...names];
  }
  return out;
}

/** Pure assembly of the §5.2 RunSpec from a registered mapping. */
export function buildRunSpec(
  registry,
  envelope,
  mapping,
  {
    runId,
    policyVersion,
    adapterOverride,
    approvalPolicy = null,
    modelTierOverride,
    modelOverride,
    configSnapshot = null,
  } = {},
) {
  const def = getAgent(registry, mapping.agent);
  const planned = plannedDef(def, { modelTierOverride, modelOverride });
  let payload = envelope.payload;
  if (def.workspace?.type === "repository" && payload?.repo) {
    try {
      payload = {
        ...payload,
        repoPin: pinRepo(payload.repo, payload.ref ?? undefined),
      };
    } catch (err) {
      if (!payload?.repoPin) throw err;
    }
  }
  if (mapping.agent?.startsWith("work-scan") && payload?.repo) {
    payload = {
      ...payload,
      dispatchSecurity: policyDispatchSecurity(
        configSnapshot?.root ?? reposRoot(),
        configSnapshot,
      ),
    };
  }
  const inputHash = hashJson(payload);
  const placement = def.placement ?? mapping.placement ?? undefined;
  const specEnvelope =
    payload === envelope.payload ? envelope : { ...envelope, payload };
  let idempotencyKey = idempotencyKeyFor(mapping, def, specEnvelope, inputHash);
  const correlation = envelope.correlationId ?? envelope.eventId ?? null;
  if (
    correlation &&
    !mapping.idempotencyScope.includes("correlationId") &&
    !mapping.idempotencyScope.includes("eventId")
  ) {
    idempotencyKey = `${idempotencyKey}:${correlation}`;
  }
  return {
    schemaVersion: "factory.run-spec/v1",
    runId,
    agent: mapping.agent,
    input: payload,
    inputHash,
    workspace: def.workspace,
    adapter: adapterOverride ?? mapping.adapter,
    promptVersion: policyVersion,
    policyVersion,
    outputContract: def.output_contract,
    defHash: computeDefHash(def),
    capabilities: def.capabilities.services,
    ...(def.mutating === false &&
    def.capabilities.filesystem === "workspace-only"
      ? { filesystem: "workspace-only" }
      : {}),
    ...(def.repos ? { repos: def.repos } : {}),
    ...(def.harness !== undefined
      ? (() => {
          const harness = harnessFromDef(def);
          const harnessPins = harnessPinsForSpec(registry, harness);
          return { harness, ...(harnessPins ? { harnessPins } : {}) };
        })()
      : {}),
    ...(modelTierOverride !== undefined ||
    planned.model_tier !== undefined ||
    planned.model !== undefined
      ? {
          modelTier: modelTierOverride ?? planned.model_tier ?? null,
          model: resolveModel(planned, mapping.adapter, registry.modelTiers),
        }
      : {}),
    timeoutSeconds: def.limits.timeout_seconds,
    maxAttempts: def.limits.attempts,
    ...(approvalPolicy ? { approvalPolicy } : {}),
    idempotencyKey,
    ...(placement ? { placement } : {}),
  };
}
