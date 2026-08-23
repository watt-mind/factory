/**
 * Extensions — `factory-extension.json` (WM-838, docs/extensions.md).
 *
 * The factory has several extension surfaces but, before this module, no
 * extension *unit*: packs are allow-listed in `policy.yaml packs:` and loaded
 * by lib/registry.mjs, adapters are registered into the adapter registry
 * (lib/adapters/index.mjs), and nothing tied them together. An extension is
 * one directory with one manifest that declares what it contributes; this
 * loader feeds its packs into the existing pack machinery and its adapters
 * into the adapter registry. It builds no parallel path for either.
 *
 * Three properties this module owns:
 *
 *   1. **Discovery is allow-listed, never scanned.** Only the entries in
 *      `config/policy.yaml extensions:` are read, in policy order, mirroring
 *      `packs:` — an absent block loads nothing. Each entry is either a
 *      `path:` (directory) or a `package:` (an installed npm package resolved
 *      from the factory root). Nothing is auto-discovered from `node_modules`.
 *   2. **Failures are configuration anomalies, not crashes.** A missing or
 *      malformed manifest, a schema violation, a pack the registry would
 *      refuse, or an adapter that fails the contract records a
 *      `/status.anomalies.configuration` line (the artifact-view pattern,
 *      registry.mjs) and skips *that* extension whole — nothing of it is
 *      registered — while every other extension still loads. `serve`/`work`
 *      never fail to start because a third-party manifest is broken.
 *   3. **Reserved manifest keys are accepted, not rejected.** `views`
 *      belongs to a follow-up ticket; a manifest that carries it loads its
 *      packs, adapters, config, hooks, panels and connectors here and
 *      records a "not supported yet" anomaly for the rest. `panels` (WM-840)
 *      contributes directories of `*.panel.json`; the manifest check only
 *      proves they exist inside the extension, and lib/registry.mjs loads
 *      and validates the panels themselves (a bad panel is skipped alone,
 *      never the extension).
 *   4. **Config is declared, validated, defaulted (WM-841), with UI-hint
 *      `format` and env-backed secrets (WM-920).** An extension may declare
 *      `contributes.config: { namespace, schema }`; the operator's values live
 *      on the policy entry (`extensions[].config`). At load the schema is
 *      read, `default`s are applied, `format: "secret"` properties resolve
 *      from `FACTORY_EXT_<NAMESPACE>_<KEY>` (process env, then
 *      `~/.factory/secrets.env`) — never from `policy.yaml` — and the
 *      effective object is validated with lib/schema.mjs. A violation
 *      disables the extension. `getExtensionConfig(name)` hands the
 *      effective object (secrets included) to adapters/hooks/panels;
 *      `loadedExtensions()` is the snapshot `GET /config` publishes.
 *   5. **Hooks are registered, built-ins first (WM-842).** `contributes.hooks`
 *      maps a hook point to a module; each is imported and contract-checked
 *      (`default` function + string `id`, lib/hooks.mjs) before the extension
 *      is accepted, then registered with source `extension:<name>` and a
 *      getter for the extension's effective config as the hook's `ctx.config`.
 *      A module that fails the contract, or an id already registered, disables
 *      the extension. Each load replaces the extension hooks of the registry
 *      it is given, so the registry always mirrors the last accepted set.
 *   6. **Harness content is pack data, namespaced at emit (WM-849).**
 *      `contributes.harness = { floor?, commands?, skills?, subagents? }`
 *      lists markdown the emit pipeline packages for Claude/Codex/Gemini/
 *      Cursor/Pi. Paths are checked here (exist, stay inside the extension);
 *      `build/emit.mjs` is the consumer. `shared/` is the built-in
 *      `factory/core` pack and is not policy-listed — `collectHarnessRoots`
 *      always puts it first so `plugins/core/**` and `dist/**` stay
 *      byte-identical. Every other contributing root emits under its
 *      `publisher-extension` slug; a non-core pack may not take plugin name
 *      `core` or reuse another pack's slug (the later extension is skipped).
 *   7. **Connectors start after the registry, and may fail independently
 *      (WM-919).** `contributes.connectors` maps a name to a module; each is
 *      imported and contract-checked (`default` start function + string `id`,
 *      lib/connectors.mjs) before the extension is accepted — a bad module
 *      disables the extension, like a bad hook. `serve` then calls
 *      `startConnectors`: a `start()` that throws or overruns 10s is a
 *      configuration anomaly for *that connector* and the extension's other
 *      contributions stay loaded. `ctx.secrets` is resolved here from
 *      `format: "secret"` / env; `ctx.config` never contains those values.
 *
 * Ordering matters for callers: `adapterRegistry.toMap()` is a snapshot, so
 * `loadExtensions` must run before a CLI takes the map it hands to
 * lib/worker.mjs, and `result.packRoots` must be what `loadRegistry` is
 * given.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  ADAPTER_NAME_PATTERN,
  validateAdapterContract,
} from "./adapters/index.mjs";
import { RUNTIME_ROOT, environmentName, resolveConfigPath } from "./config.mjs";
import {
  CONNECTOR_NAME_PATTERN,
  setLoadedConnectors,
  splitConfigSecrets,
  validateConnectorModule,
} from "./connectors.mjs";
import {
  HOOK_POINTS,
  defaultHookRegistry,
  validateHookModule,
} from "./hooks.mjs";
import { RegistryError, loadPackRoots, loadRegistry } from "./registry.mjs";
import { expandHome, reposRoot } from "./repos.mjs";
import { validate } from "./schema.mjs";

export const EXTENSION_MANIFEST = "factory-extension.json";

/** Plugin directory of the built-in core harness pack (`plugins/core`). */
export const CORE_HARNESS_PLUGIN = "core";

/** Manifest `name` of `shared/factory-extension.json`. */
export const CORE_HARNESS_NAME = "factory/core";

const HARNESS_FILE_KEYS = ["floor"];
const HARNESS_DIR_KEYS = ["commands", "skills", "subagents"];

/**
 * Preserve a connector's loaded/status entry while only invoking its real
 * start function in the live runtime. `startConnectors` supplies the qualified
 * connector prefix, so a gated connector produces one informative serve-log
 * line while retaining a healthy status row.
 */
function environmentGatedConnectorModule(module) {
  return {
    ...module,
    async default(ctx) {
      if (environmentName() === "live") return module.default(ctx);
      ctx.log?.("not started: non-live environment");
      return {
        async stop() {},
        health() {
          return { ok: true, detail: "not started (non-live env)" };
        },
      };
    },
  };
}

export const EXTENSION_SCHEMA = JSON.parse(
  readFileSync(
    path.join(RUNTIME_ROOT, "schemas", "factory-extension.schema.json"),
    "utf8",
  ),
);

/** Manifest keys the schema accepts today but no ticket has implemented yet. */
export const RESERVED_CONTRIBUTIONS = Object.freeze(["views"]);

/** The `source` a hook registered by an extension carries (lib/hooks.mjs). */
export function extensionHookSource(name) {
  return `extension:${name}`;
}

/**
 * Pack / adapter / hook / panel / config contribution counts for CLI
 * `extensions list` and `extensions validate` (WM-865). Accepts either a
 * manifest (`contributes.*`) or a loaded extension (`packs`/`adapters`/
 * `hooks`/`panels` arrays plus `config`).
 *
 * `config` is 1 when the extension declares `contributes.config` (or a
 * loaded extension carries a config object), else 0 — one contribution,
 * not the number of schema properties.
 *
 * @param {object|null|undefined} source
 * @returns {{ packs: number, adapters: number, hooks: number, panels: number, config: number }}
 */
export function contributionCounts(source) {
  const empty = { packs: 0, adapters: 0, hooks: 0, panels: 0, config: 0 };
  if (!source || typeof source !== "object") return empty;
  const contributes = source.contributes;
  if (contributes && typeof contributes === "object") {
    return {
      packs: Array.isArray(contributes.packs) ? contributes.packs.length : 0,
      adapters: countKeysOrLength(contributes.adapters),
      hooks: countKeysOrLength(contributes.hooks),
      panels: Array.isArray(contributes.panels) ? contributes.panels.length : 0,
      config: contributes.config ? 1 : 0,
    };
  }
  return {
    packs: Array.isArray(source.packs) ? source.packs.length : 0,
    adapters: countKeysOrLength(source.adapters),
    hooks: countKeysOrLength(source.hooks),
    panels: Array.isArray(source.panels) ? source.panels.length : 0,
    config: source.config ? 1 : 0,
  };
}

function countKeysOrLength(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") return Object.keys(value).length;
  return 0;
}

function countBit(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** `1 pack, 2 adapters, 0 hooks, 1 panel, 1 config` — validate summary line. */
export function formatContributionCounts(counts) {
  const c = counts ?? contributionCounts(null);
  return [
    countBit(c.packs, "pack"),
    countBit(c.adapters, "adapter"),
    countBit(c.hooks, "hook"),
    countBit(c.panels, "panel"),
    countBit(c.config, "config"),
  ].join(", ");
}

/** Policy entry fields `extensions[]` accepts besides the locator. */
const ENTRY_FIELDS = new Set(["path", "package", "version", "config"]);

/** npm package name: `@scope/name` or `name` (no path separators). */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;

/**
 * The last `loadExtensions` result, kept so `getExtensionConfig` (adapters,
 * hooks, panels) and `GET /config` (lib/api-config.mjs) read the same effective
 * objects the loader validated. `serve` and `work` each load once at start.
 */
let LOADED = { extensions: [], disabled: [] };

/** Thrown only for a malformed `extensions:` policy block; per-extension faults are anomalies. */
export class ExtensionError extends Error {
  constructor(message) {
    super(message);
    this.name = "ExtensionError";
  }
}

/** True for `@scope/name` or unscoped `name`; false for filesystem paths. */
export function looksLikePackageName(value) {
  if (typeof value !== "string") return false;
  const name = value.trim();
  if (!name) return false;
  if (
    name.startsWith(".") ||
    name.startsWith("/") ||
    name.startsWith("~") ||
    name.includes("\\") ||
    name.includes("..")
  )
    return false;
  return PACKAGE_NAME.test(name);
}

function existingRealpath(p) {
  const missing = [];
  let current = path.resolve(p);
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(p);
    missing.unshift(path.basename(current));
    current = parent;
  }
  return path.join(realpathSync(current), ...missing);
}

/**
 * Resolve an installed npm package from the factory root to the directory
 * that contains `factory-extension.json`. Follows `node_modules` symlinks
 * with `realpath` so contributed paths cannot escape via a linked package.
 *
 * @param {string} packageName
 * @param {{ root?: string }} [options]
 * @returns {{ path: string, package: string, packageVersion: string|null, source: "package" }}
 */
export function resolveExtensionPackage(
  packageName,
  { root = reposRoot() } = {},
) {
  const name = String(packageName ?? "").trim();
  if (!looksLikePackageName(name)) {
    throw new ExtensionError(
      `package must be a package name (@scope/name or name), got "${packageName}"`,
    );
  }
  const require = createRequire(path.join(root, "package.json"));
  let pkgJsonPath;
  try {
    pkgJsonPath = require.resolve(`${name}/package.json`);
  } catch {
    throw new ExtensionError(
      `package "${name}" is not installed — npm i ${name}`,
    );
  }
  const pkgDir = path.dirname(pkgJsonPath);
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  } catch (err) {
    throw new ExtensionError(
      `package "${name}": unreadable package.json — ${err.message}`,
    );
  }
  const rel = pkg.factory?.extension;
  let extDir = pkgDir;
  if (rel !== undefined && rel !== null) {
    if (typeof rel !== "string" || rel.trim() === "") {
      throw new ExtensionError(
        `package "${name}": package.json factory.extension must be a relative path`,
      );
    }
    extDir = path.resolve(pkgDir, rel);
  }
  const realPkg = existingRealpath(pkgDir);
  const realExt = existingRealpath(extDir);
  if (!isInside(realPkg, realExt)) {
    throw new ExtensionError(
      `package "${name}": factory.extension "${rel}" escapes the package directory`,
    );
  }
  if (!existsSync(path.join(realExt, EXTENSION_MANIFEST))) {
    throw new ExtensionError(
      `package "${name}" has no ${EXTENSION_MANIFEST} in ${realExt}`,
    );
  }
  return {
    path: realExt,
    package: name,
    packageVersion: typeof pkg.version === "string" ? pkg.version : null,
    source: "package",
  };
}

/**
 * A CLI/`validate` target: an existing filesystem path, or a package name
 * resolved from the factory root.
 *
 * @param {string} spec
 * @param {{ root?: string }} [options]
 * @returns {{ path: string, source: "path"|"package", package?: string, packageVersion?: string|null }}
 */
export function resolveExtensionTarget(spec, { root = reposRoot() } = {}) {
  const trimmed = String(spec ?? "").trim();
  const asPath = path.resolve(expandHome(trimmed));
  if (trimmed && existsSync(asPath)) return { path: asPath, source: "path" };
  if (looksLikePackageName(trimmed))
    return resolveExtensionPackage(trimmed, { root });
  return { path: asPath, source: "path" };
}

function policyFile(root) {
  return resolveConfigPath("policy", { root });
}

function readPolicy(root) {
  const file = policyFile(root);
  if (!existsSync(file)) return {};
  try {
    return Bun.YAML.parse(readFileSync(file, "utf8")) ?? {};
  } catch (err) {
    throw new ExtensionError(
      `${file}: unparseable policy.yaml — ${err.message}`,
    );
  }
}

/**
 * Read the explicit extension allowlist from a parsed policy. No directory
 * discovery is ever performed: an absent block is the empty list. The block
 * itself must be well-formed (fail closed, like `packs:`); a malformed entry
 * is reported per entry so one typo does not hide the other extensions.
 *
 * @param {{ root?: string, policy?: object }} [options]
 * @returns {{ roots: Array<{ path: string, index: number, source: "path"|"package", package?: string, packageVersion?: string|null, config?: object }>, anomalies: string[] }}
 *   `config` is the operator's raw values for the extension (validated by
 *   `loadExtensions` against the schema the manifest declares).
 *   `source` is `"path"` or `"package"`; package rows also carry the name
 *   and the installed `package.json` version (`version:` on the entry is
 *   display-only and is not compared).
 */
export function loadExtensionRoots({ root = reposRoot(), policy } = {}) {
  const parsed = policy ?? readPolicy(root);
  const file = policyFile(root);
  const configured = parsed?.extensions;
  if (configured === undefined || configured === null)
    return { roots: [], anomalies: [] };
  if (!Array.isArray(configured))
    throw new ExtensionError(`${file}: "extensions" must be an array`);

  const roots = [];
  const anomalies = [];
  const seen = new Set();
  configured.forEach((entry, index) => {
    const at = `${file}: extensions[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      anomalies.push(
        `${at} must be an object with path or package (entry skipped)`,
      );
      return;
    }
    const unknown = Object.keys(entry).filter((key) => !ENTRY_FIELDS.has(key));
    if (unknown.length > 0) {
      anomalies.push(
        `${at}: unknown field${unknown.length > 1 ? "s" : ""} ${unknown.map((k) => `"${k}"`).join(", ")} (entry skipped)`,
      );
      return;
    }
    const hasPath = Object.hasOwn(entry, "path");
    const hasPackage = Object.hasOwn(entry, "package");
    if (hasPath && hasPackage) {
      anomalies.push(
        `${at} must have path or package, not both (entry skipped)`,
      );
      return;
    }
    if (!hasPath && !hasPackage) {
      anomalies.push(`${at} must have path or package (entry skipped)`);
      return;
    }
    if (
      Object.hasOwn(entry, "version") &&
      (typeof entry.version !== "string" || entry.version.trim() === "")
    ) {
      anomalies.push(
        `${at}.version must be a non-empty string (display only; entry skipped)`,
      );
      return;
    }
    if (
      Object.hasOwn(entry, "config") &&
      (typeof entry.config !== "object" ||
        entry.config === null ||
        Array.isArray(entry.config))
    ) {
      anomalies.push(`${at}.config must be an object (entry skipped)`);
      return;
    }

    let located;
    if (hasPath) {
      if (typeof entry.path !== "string" || entry.path.trim() === "") {
        anomalies.push(`${at}.path must be a non-empty string (entry skipped)`);
        return;
      }
      located = {
        path: path.resolve(root, expandHome(entry.path)),
        source: "path",
      };
    } else {
      if (typeof entry.package !== "string" || entry.package.trim() === "") {
        anomalies.push(
          `${at}.package must be a non-empty string (entry skipped)`,
        );
        return;
      }
      try {
        located = resolveExtensionPackage(entry.package, { root });
      } catch (err) {
        anomalies.push(`${at}: ${err.message} (entry skipped)`);
        return;
      }
    }

    if (seen.has(located.path)) {
      anomalies.push(
        `${at}: duplicate extension path ${located.path} (skipped)`,
      );
      return;
    }
    seen.add(located.path);
    roots.push({
      path: located.path,
      index,
      source: located.source,
      ...(located.package
        ? {
            package: located.package,
            packageVersion: located.packageVersion ?? null,
          }
        : {}),
      ...(Object.hasOwn(entry, "config") ? { config: entry.config } : {}),
    });
  });
  return { roots, anomalies };
}

/**
 * Read and validate one manifest without loading anything it points at.
 * Path existence is checked (a pack directory or adapter file that is not
 * there is a manifest error, not a runtime surprise), but no pack is loaded
 * and no adapter module is imported — that is what `extensions validate` in
 * the CLI promises.
 *
 * @param {string} dir - the extension directory (the manifest's parent), or a package name
 * @param {{ root?: string }} [options] - factory root used when `dir` is a package name
 * @returns {{ valid: boolean, errors: string[], warnings: string[], manifest: object|null, file: string }}
 */
export function validateExtensionManifest(dir, { root = reposRoot() } = {}) {
  const errors = [];
  const warnings = [];
  let resolvedDir;
  try {
    resolvedDir = resolveExtensionTarget(dir, { root }).path;
  } catch (err) {
    const file = String(dir);
    if (err instanceof ExtensionError) {
      errors.push(err.message);
      return { valid: false, errors, warnings, manifest: null, file };
    }
    throw err;
  }
  const file = path.join(resolvedDir, EXTENSION_MANIFEST);
  const result = (manifest) => ({
    valid: errors.length === 0,
    errors,
    warnings,
    manifest,
    file,
  });
  if (!existsSync(file)) {
    errors.push(`missing ${EXTENSION_MANIFEST} in ${resolvedDir}`);
    return result(null);
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    errors.push(`${file}: invalid JSON — ${err.message}`);
    return result(null);
  }
  const check = validate(EXTENSION_SCHEMA, manifest);
  if (!check.valid) {
    errors.push(...check.errors.map((e) => `${file}: ${e}`));
    return result(manifest);
  }

  const contributes = manifest.contributes ?? {};
  for (const key of RESERVED_CONTRIBUTIONS) {
    if (Object.hasOwn(contributes, key)) {
      warnings.push(
        `${file}: contributes.${key} is not supported yet (reserved; ignored)`,
      );
    }
  }
  const packs = new Set();
  for (const [i, rel] of (contributes.packs ?? []).entries()) {
    const abs = path.resolve(resolvedDir, rel);
    if (!isInside(resolvedDir, abs)) {
      errors.push(
        `${file}: contributes.packs[${i}] "${rel}" escapes the extension directory`,
      );
      continue;
    }
    if (packs.has(abs)) {
      errors.push(`${file}: contributes.packs[${i}] "${rel}" listed twice`);
      continue;
    }
    packs.add(abs);
    if (!existsSync(path.join(abs, "pack.json"))) {
      errors.push(
        `${file}: contributes.packs[${i}] "${rel}" has no pack.json (${abs})`,
      );
    }
  }
  for (const [name, rel] of Object.entries(contributes.adapters ?? {})) {
    if (!ADAPTER_NAME_PATTERN.test(name)) {
      errors.push(
        `${file}: contributes.adapters key "${name}" must match ${ADAPTER_NAME_PATTERN}`,
      );
      continue;
    }
    const abs = path.resolve(resolvedDir, rel);
    if (!isInside(resolvedDir, abs)) {
      errors.push(
        `${file}: contributes.adapters.${name} "${rel}" escapes the extension directory`,
      );
      continue;
    }
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      errors.push(
        `${file}: contributes.adapters.${name} "${rel}" is not a file (${abs})`,
      );
    }
  }
  for (const [name, rel] of Object.entries(contributes.connectors ?? {})) {
    if (!CONNECTOR_NAME_PATTERN.test(name)) {
      errors.push(
        `${file}: contributes.connectors key "${name}" must match ${CONNECTOR_NAME_PATTERN}`,
      );
      continue;
    }
    const abs = path.resolve(resolvedDir, rel);
    if (!isInside(resolvedDir, abs)) {
      errors.push(
        `${file}: contributes.connectors.${name} "${rel}" escapes the extension directory`,
      );
      continue;
    }
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      errors.push(
        `${file}: contributes.connectors.${name} "${rel}" is not a file (${abs})`,
      );
    }
  }
  for (const [point, rel] of Object.entries(contributes.hooks ?? {})) {
    if (!HOOK_POINTS.includes(point)) {
      errors.push(
        `${file}: contributes.hooks key "${point}" is not a hook point (known: ${HOOK_POINTS.join(", ")})`,
      );
      continue;
    }
    const abs = path.resolve(resolvedDir, rel);
    if (!isInside(resolvedDir, abs)) {
      errors.push(
        `${file}: contributes.hooks["${point}"] "${rel}" escapes the extension directory`,
      );
      continue;
    }
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      errors.push(
        `${file}: contributes.hooks["${point}"] "${rel}" is not a file (${abs})`,
      );
    }
  }
  if (contributes.config) {
    const rel = contributes.config.schema;
    const abs = path.resolve(resolvedDir, rel);
    if (!isInside(resolvedDir, abs)) {
      errors.push(
        `${file}: contributes.config.schema "${rel}" escapes the extension directory`,
      );
    } else if (!existsSync(abs) || !statSync(abs).isFile()) {
      errors.push(
        `${file}: contributes.config.schema "${rel}" is not a file (${abs})`,
      );
    }
  }
  errors.push(...panelDirErrors(resolvedDir, file, contributes.panels));
  errors.push(...harnessPathErrors(resolvedDir, file, contributes.harness));
  return result(manifest);
}

/** Deep-clone JSON data (schema defaults are shared with the effective object otherwise). */
function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Fill `default`s from a schema into a value, recursively through
 * `properties` and `items`. A nested object property with no value is only
 * created when a default inside it produces something — an empty object would
 * trip that property's own `required` where absence would not. Array elements
 * are filled from `schema.items` the same way (the array itself is not
 * invented unless the schema supplies a `default`).
 */
export function applyConfigDefaults(schema, value) {
  if (!isPlainObject(schema)) return cloneJson(value);
  let out = cloneJson(value);
  if (out === undefined) {
    if (Object.hasOwn(schema, "default")) out = cloneJson(schema.default);
    else if (schema.type === "object" || isPlainObject(schema.properties))
      out = {};
    else return undefined;
  }
  if (isPlainObject(out) && isPlainObject(schema.properties)) {
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (Object.hasOwn(out, key)) {
        out[key] = applyConfigDefaults(sub, out[key]);
        continue;
      }
      const filled = applyConfigDefaults(sub, undefined);
      if (filled === undefined) continue;
      if (isPlainObject(filled) && Object.keys(filled).length === 0) continue;
      out[key] = filled;
    }
  }
  if (Array.isArray(out) && isPlainObject(schema.items)) {
    out = out.map((item) => applyConfigDefaults(schema.items, item));
  }
  return out;
}

/** `default` is an annotation lib/schema.mjs does not know; strip it before validating. */
function withoutDefaults(schema) {
  if (Array.isArray(schema)) return schema.map(withoutDefaults);
  if (!isPlainObject(schema)) return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "default") continue;
    out[key] = withoutDefaults(value);
  }
  return out;
}

/** camelCase / kebab path segment → UPPER_SNAKE for FACTORY_EXT_* names. */
export function upperSnake(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

/** `FACTORY_EXT_<NAMESPACE>_<KEY>` for a secret property path. */
export function extensionSecretEnvVar(namespace, keyPath) {
  const parts = [namespace, ...(Array.isArray(keyPath) ? keyPath : [keyPath])]
    .map(upperSnake)
    .filter(Boolean);
  return `FACTORY_EXT_${parts.join("_")}`;
}

/**
 * Every `format: "secret"` property in a config schema, depth-first, with
 * the path used for env names and published `{ set, source }` overlays.
 */
export function collectSecretFields(schema, path = []) {
  if (!isPlainObject(schema) || !isPlainObject(schema.properties)) return [];
  const out = [];
  for (const [key, sub] of Object.entries(schema.properties)) {
    const next = [...path, key];
    if (isPlainObject(sub) && sub.format === "secret")
      out.push({ path: next, key });
    else out.push(...collectSecretFields(sub, next));
  }
  return out;
}

function hasAt(obj, keyPath) {
  let node = obj;
  for (const key of keyPath) {
    if (!isPlainObject(node) || !Object.hasOwn(node, key)) return false;
    node = node[key];
  }
  return true;
}

function setAt(obj, keyPath, value) {
  let node = obj;
  for (let i = 0; i < keyPath.length - 1; i++) {
    const key = keyPath[i];
    if (!isPlainObject(node[key])) node[key] = {};
    node = node[key];
  }
  node[keyPath[keyPath.length - 1]] = value;
}

function deleteAt(obj, keyPath) {
  let node = obj;
  for (let i = 0; i < keyPath.length - 1; i++) {
    const key = keyPath[i];
    if (!isPlainObject(node[key])) return;
    node = node[key];
  }
  delete node[keyPath[keyPath.length - 1]];
}

/** Public config vs secrets bag for a connector's `ctx`. */
function connectorCtxConfig(config) {
  if (!config) return { config: {}, secrets: {} };
  return splitConfigSecrets(
    config.values,
    collectSecretFields(config.schemaJson ?? {}),
  );
}

function parseDotenv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const line = trimmed.replace(/^export\s+/, "");
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

let secretsFileCache;

/** Drop the cached `~/.factory/secrets.env` parse so a test can reload. */
export function resetExtensionSecretsCache() {
  secretsFileCache = undefined;
}

function secretsFilePath() {
  return (
    process.env.FACTORY_EVENT_SECRETS_FILE ||
    path.join(homedir(), ".factory", "secrets.env")
  );
}

/**
 * Parse `~/.factory/secrets.env` once (dotenv, owner-only mode). A missing
 * file contributes nothing; a group/world-readable file also contributes
 * nothing — secrets then come only from `process.env` — but is not silent
 * about it: a one-line warning names the file and its mode so an operator
 * can `chmod 600` it, without failing the load.
 */
function loadSecretsFile() {
  if (secretsFileCache !== undefined) return secretsFileCache;
  const file = secretsFilePath();
  secretsFileCache = {};
  if (!existsSync(file)) return secretsFileCache;
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return secretsFileCache;
  }
  if (!stat.isFile()) return secretsFileCache;
  if ((stat.mode & 0o077) !== 0) {
    console.warn(
      `${file}: mode ${(stat.mode & 0o777).toString(8)} is group/world-readable — ignoring it for secrets (chmod 600 ${file})`,
    );
    return secretsFileCache;
  }
  try {
    secretsFileCache = parseDotenv(readFileSync(file, "utf8"));
  } catch {
    secretsFileCache = {};
  }
  return secretsFileCache;
}

function resolveSecretValue(envVar) {
  const fromEnv = process.env[envVar];
  if (typeof fromEnv === "string" && fromEnv.length > 0)
    return { value: fromEnv, source: "env" };
  const fromFile = loadSecretsFile()[envVar];
  if (typeof fromFile === "string" && fromFile.length > 0)
    return { value: fromFile, source: "secrets.env" };
  return { value: undefined, source: null };
}

/**
 * Resolve one extension's effective config: read the declared schema, apply
 * its defaults over the operator's values, pull `format: "secret"` properties
 * from env / secrets.env, validate the result. Returns `null` when the
 * manifest declares no config and the policy gives none; throws an
 * ExtensionError naming the fault (and the failing value path) otherwise,
 * which `loadExtensions` turns into a disabling anomaly.
 *
 * @param {string} dir - the extension directory
 * @param {object} manifest - a schema-valid manifest
 * @param {object|undefined} values - the policy entry's `config`
 * @returns {{ namespace: string, schema: string, schemaJson: object, values: object, secretMeta: Record<string, { set: boolean, source: "env"|"secrets.env"|null }> }|null}
 */
export function resolveExtensionConfig(dir, manifest, values) {
  const declared = manifest.contributes?.config;
  if (!declared) {
    if (values !== undefined) {
      throw new ExtensionError(
        "policy.yaml gives config values but the manifest declares no contributes.config",
      );
    }
    return null;
  }
  const schemaFile = path.resolve(dir, declared.schema);
  let schemaJson;
  try {
    schemaJson = JSON.parse(readFileSync(schemaFile, "utf8"));
  } catch (err) {
    throw new ExtensionError(
      `contributes.config.schema "${declared.schema}" is not valid JSON — ${err.message}`,
    );
  }
  const secrets = collectSecretFields(schemaJson);
  const operator = cloneJson(values ?? {});
  const policySecrets = secrets.filter((field) => hasAt(operator, field.path));
  if (policySecrets.length > 0) {
    throw new ExtensionError(
      policySecrets
        .map((field) => {
          const envVar = extensionSecretEnvVar(declared.namespace, field.path);
          return `config.${field.path.join(".")} must not be set in policy.yaml — use env ${envVar}`;
        })
        .join("; "),
    );
  }
  for (const field of secrets) deleteAt(operator, field.path);
  const effective = applyConfigDefaults(schemaJson, operator);
  const secretMeta = {};
  for (const field of secrets) {
    const envVar = extensionSecretEnvVar(declared.namespace, field.path);
    const resolved = resolveSecretValue(envVar);
    const key = field.path.join(".");
    secretMeta[key] = {
      set: resolved.value !== undefined,
      source: resolved.source,
    };
    deleteAt(effective, field.path);
    if (resolved.value !== undefined)
      setAt(effective, field.path, resolved.value);
  }
  const check = validate(withoutDefaults(schemaJson), effective);
  if (!check.valid) {
    throw new ExtensionError(
      `config does not match ${declared.schema} — ${check.errors.join("; ")}`,
    );
  }
  return {
    namespace: declared.namespace,
    schema: declared.schema,
    schemaJson,
    values: effective,
    secretMeta,
  };
}

/**
 * Replace every `format: "secret"` property with `{ set, source }` so a
 * published `/config` payload never carries the resolved value.
 */
export function maskExtensionSecrets(values, schemaJson, secretMeta = {}) {
  const out = cloneJson(values) ?? {};
  for (const field of collectSecretFields(schemaJson)) {
    const key = field.path.join(".");
    const meta = secretMeta[key] ?? { set: false, source: null };
    setAt(out, field.path, {
      set: Boolean(meta.set),
      source: meta.source ?? null,
    });
  }
  return out;
}

/**
 * The effective config object of a loaded extension — schema defaults applied
 * over the operator's policy values, validated at load. `undefined` when no
 * extension of that name loaded (unknown, or disabled by an anomaly).
 *
 * @param {string} name - the manifest `name` (`publisher/extension`)
 * @returns {object|undefined}
 */
export function getExtensionConfig(name) {
  return LOADED.extensions.find((e) => e.name === name)?.config?.values;
}

/**
 * Snapshot of the last `loadExtensions` run for read-only surfaces
 * (`GET /config`, lib/api-config.mjs): every accepted extension with its
 * config, and every extension a fault disabled with the reason.
 *
 * @returns {{
 *   extensions: Array<{ name: string, version: string, path: string, config: { namespace: string, schema: string, schemaJson: object, values: object }|null }>,
 *   disabled: Array<{ name: string|null, version: string|null, path: string, namespace: string|null, reason: string }>,
 * }}
 */
export function loadedExtensions() {
  return LOADED;
}

/**
 * `contributes.panels` (WM-840): relative directories of `*.panel.json`,
 * each inside the extension and existing. Only the directories are checked
 * here — panel documents are validated when the registry loads them, one
 * anomaly per bad panel, so `extensions validate` stays a manifest check.
 */
function panelDirErrors(root, file, panels) {
  const errors = [];
  const seen = new Set();
  for (const [i, rel] of (panels ?? []).entries()) {
    const abs = path.resolve(root, rel);
    if (!isInside(root, abs)) {
      errors.push(
        `${file}: contributes.panels[${i}] "${rel}" escapes the extension directory`,
      );
      continue;
    }
    if (seen.has(abs)) {
      errors.push(`${file}: contributes.panels[${i}] "${rel}" listed twice`);
      continue;
    }
    seen.add(abs);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      errors.push(
        `${file}: contributes.panels[${i}] "${rel}" is not a directory (${abs})`,
      );
    }
  }
  return errors;
}

/** The registry `panelRoots` entries for one accepted extension (lib/registry.mjs loadRegistry). */
function panelRootsFor(dir, manifest) {
  return (manifest.contributes?.panels ?? []).map((rel) => ({
    dir: path.resolve(dir, rel),
    origin: `extension:${manifest.name}`,
    base: dir,
  }));
}

function harnessPathErrors(root, file, harness) {
  if (!harness) return [];
  const errors = [];
  for (const key of HARNESS_FILE_KEYS) {
    if (!Object.hasOwn(harness, key)) continue;
    errors.push(
      ...harnessEntryError(root, file, key, harness[key], { file: true }),
    );
  }
  for (const key of HARNESS_DIR_KEYS) {
    if (!Object.hasOwn(harness, key)) continue;
    errors.push(
      ...harnessEntryError(root, file, key, harness[key], { file: false }),
    );
  }
  return errors;
}

function harnessEntryError(root, file, key, rel, { file: wantFile }) {
  const abs = path.resolve(root, rel);
  if (!isInside(root, abs)) {
    return [
      `${file}: contributes.harness.${key} "${rel}" escapes the extension directory`,
    ];
  }
  if (
    !existsSync(abs) ||
    (wantFile ? !statSync(abs).isFile() : !statSync(abs).isDirectory())
  ) {
    return [
      `${file}: contributes.harness.${key} "${rel}" is not a ${wantFile ? "file" : "directory"} (${abs})`,
    ];
  }
  return [];
}

/** Plugin directory name a harness pack emits into (`plugins/<plugin>/`). */
export function harnessPluginName(manifestName, { builtin = false } = {}) {
  if (builtin) return CORE_HARNESS_PLUGIN;
  return String(manifestName).replaceAll("/", "-");
}

/**
 * Resolve `contributes.harness` to absolute paths. `null` when the manifest
 * declares none (or an empty object).
 */
export function harnessRootFor(dir, manifest, { builtin = false } = {}) {
  const declared = manifest?.contributes?.harness;
  if (!declared) return null;
  if (
    !declared.floor &&
    !declared.commands &&
    !declared.skills &&
    !declared.subagents
  )
    return null;
  return {
    dir: path.resolve(dir),
    name: manifest.name,
    version: manifest.version,
    builtin,
    origin: builtin ? "builtin" : `extension:${manifest.name}`,
    plugin: harnessPluginName(manifest.name, { builtin }),
    prefix: builtin ? null : harnessPluginName(manifest.name),
    floor: declared.floor ? path.resolve(dir, declared.floor) : null,
    commands: declared.commands ? path.resolve(dir, declared.commands) : null,
    skills: declared.skills ? path.resolve(dir, declared.skills) : null,
    subagents: declared.subagents
      ? path.resolve(dir, declared.subagents)
      : null,
  };
}

/**
 * Built-in `shared/` first, then every policy-listed extension that
 * contributes harness content. A broken third-party manifest is an anomaly
 * (emit still writes the core pack); a broken builtin throws — that is our
 * own pack and emit must not invent it.
 *
 * @param {object} [options]
 * @param {string} [options.root] - checkout supplying `config/policy.yaml`
 * @param {string} [options.builtin] - absolute path of `shared/` (required for emit)
 * @param {object} [options.policy] - already-parsed policy; when given, policy.yaml is not read
 * @returns {{ roots: Array<object>, anomalies: string[] }}
 */
export function collectHarnessRoots({
  root = reposRoot(),
  builtin,
  policy,
} = {}) {
  const roots = [];
  const anomalies = [];
  const seenPaths = new Set();
  const seenNames = new Set();
  const seenPlugins = new Set();

  const add = (dir, { builtin: isBuiltin = false } = {}) => {
    const resolved = path.resolve(dir);
    if (seenPaths.has(resolved)) return;
    const checked = validateExtensionManifest(resolved);
    if (!checked.valid) {
      const reason = checked.errors.join("; ");
      if (isBuiltin) {
        throw new ExtensionError(
          `built-in harness pack ${resolved}: ${reason}`,
        );
      }
      anomalies.push(`extension ${resolved}: ${reason} (harness skipped)`);
      return;
    }
    const pack = harnessRootFor(resolved, checked.manifest, {
      builtin: isBuiltin,
    });
    if (!pack) {
      if (isBuiltin) {
        throw new ExtensionError(
          `built-in harness pack ${resolved}: ${EXTENSION_MANIFEST} declares no contributes.harness`,
        );
      }
      return;
    }
    if (!isBuiltin && pack.plugin === CORE_HARNESS_PLUGIN) {
      anomalies.push(
        `extension ${resolved}: harness plugin name "${pack.plugin}" is reserved for the built-in core pack (harness skipped)`,
      );
      return;
    }
    if (seenNames.has(pack.name)) {
      anomalies.push(
        `extension ${resolved}: harness name "${pack.name}" is already contributed (harness skipped)`,
      );
      return;
    }
    if (seenPlugins.has(pack.plugin)) {
      anomalies.push(
        `extension ${resolved}: harness plugin "${pack.plugin}" is already contributed (harness skipped)`,
      );
      return;
    }
    seenPaths.add(resolved);
    seenNames.add(pack.name);
    seenPlugins.add(pack.plugin);
    roots.push(pack);
  };

  if (builtin) add(builtin, { builtin: true });
  const loaded = loadExtensionRoots({ root, policy });
  anomalies.push(...loaded.anomalies);
  for (const { path: dir } of loaded.roots) add(dir);
  return { roots, anomalies };
}

function isInside(root, abs) {
  const rel = path.relative(existingRealpath(root), existingRealpath(abs));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Read the pack name out of `pack.json`; the registry validates the rest. */
function packRootFor(extensionRoot, rel) {
  const packDir = path.resolve(extensionRoot, rel);
  const manifestFile = path.join(packDir, "pack.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  } catch (err) {
    throw new RegistryError(`${manifestFile}: invalid JSON — ${err.message}`);
  }
  if (typeof manifest?.name !== "string" || manifest.name.trim() === "") {
    throw new RegistryError(`${manifestFile}: name must be a non-empty string`);
  }
  return { kind: "fs", name: manifest.name, path: packDir };
}

/**
 * Load every allow-listed extension: validate the manifest, prove its packs
 * load alongside everything accepted so far (a dry `loadRegistry`, so the
 * namespace/duplicate/pin/mutating rules of docs/kernel-and-packs.md apply
 * unchanged), import and contract-check its adapters, and only then — once
 * the whole extension is known good — register the adapters. A fault
 * anywhere skips the extension whole and records why.
 *
 * @param {object} [options]
 * @param {string} [options.root] - the checkout supplying `config/policy.yaml` (default: reposRoot())
 * @param {object} [options.policy] - an already-parsed policy object; when given, policy.yaml is not read
 * @param {ReturnType<import("./adapters/index.mjs").createAdapterRegistry>} [options.adapterRegistry] - where adapters go; when absent, adapters are validated but not registered
 * @param {ReturnType<import("./hooks.mjs").createHookRegistry>} [options.hookRegistry] - where hooks go (default: the process-wide `defaultHookRegistry()`); its extension hooks are replaced by this load
 * @param {Array<object>} [options.packRoots] - the policy `packs:` roots the extension packs join (default: loadPackRoots({ root }))
 * @param {string} [options.registryRoot] - the built-in registry root the dry load uses (tests point it at a copy)
 * @returns {Promise<{
 *   extensions: Array<{ name: string, version: string, path: string, packs: string[], adapters: string[], hooks: Array<{ point: string, id: string }>, connectors: Array<{ name: string, id: string }>, panels: string[], reserved: string[], config: { namespace: string, schema: string, values: object }|null }>,
 *   panelRoots: Array<{ dir: string, origin: string, base: string }>,
 *   harnessRoots: Array<object>,
 *   packRoots: Array<object>,
 *   anomalies: string[],
 *   disabled: Array<{ name: string|null, version: string|null, path: string, namespace: string|null, reason: string }>,
 * }>} `packRoots` is the full list — policy packs first, then every accepted
 *   extension pack in policy order — ready to hand to `loadRegistry`;
 *   `panelRoots` is every accepted extension's `contributes.panels`
 *   directories, in the same order, for `loadRegistry({ panelRoots })`.
 *   `harnessRoots` starts with the built-in core harness root, followed by
 *   every accepted extension's `contributes.harness` (WM-849), for
 *   `loadRegistry({ harnessRoots })` and `build/emit.mjs`.
 *   `disabled` lists every extension an anomaly skipped, for `/config`.
 */
export async function loadExtensions({
  root = reposRoot(),
  policy,
  adapterRegistry,
  hookRegistry = defaultHookRegistry(),
  packRoots,
  registryRoot,
} = {}) {
  const basePackRoots = packRoots ?? loadPackRoots({ root });
  // Last load wins for hooks, as it does for `LOADED`: drop what an earlier
  // load registered from extensions so a removed extension's hook cannot
  // linger, then re-register the accepted set below in policy order.
  for (const hook of hookRegistry.list()) {
    if (hook.source.startsWith(extensionHookSource("")))
      hookRegistry.unregister(hook.id);
  }
  setLoadedConnectors([]);
  const { roots, anomalies } = loadExtensionRoots({ root, policy });
  const extensions = [];
  const panelRoots = [];
  const coreHarnessDir = path.join(path.dirname(RUNTIME_ROOT), "shared");
  const core = validateExtensionManifest(coreHarnessDir);
  if (!core.valid) {
    throw new ExtensionError(
      `built-in harness pack ${coreHarnessDir}: ${core.errors.join("; ")}`,
    );
  }
  const coreHarness = harnessRootFor(coreHarnessDir, core.manifest, {
    builtin: true,
  });
  if (!coreHarness) {
    throw new ExtensionError(
      `built-in harness pack ${coreHarnessDir}: ${EXTENSION_MANIFEST} declares no contributes.harness`,
    );
  }
  const harnessRoots = [coreHarness];
  const accepted = [...basePackRoots];
  const acceptedPackNames = new Set(basePackRoots.map((p) => p.name));
  const acceptedAdapterNames = new Set();
  const acceptedNamespaces = new Map();
  const acceptedHarnessPlugins = new Set([coreHarness.plugin]);
  const acceptedHarnessNames = new Set([coreHarness.name]);
  const disabled = [];
  const loaded = [];
  const loadedConnectorModules = [];
  const dryLoad = (candidates) =>
    loadRegistry({
      ...(registryRoot ? { root: registryRoot } : {}),
      packRoots: candidates,
    });

  for (const {
    path: dir,
    config: values,
    source = "path",
    package: packageName,
    packageVersion,
  } of roots) {
    const checked = validateExtensionManifest(dir);
    const skip = (reason) => {
      anomalies.push(`extension ${dir}: ${reason} (extension skipped)`);
      disabled.push({
        name: checked.manifest?.name ?? null,
        version: checked.manifest?.version ?? null,
        path: dir,
        namespace: checked.manifest?.contributes?.config?.namespace ?? null,
        reason,
      });
    };
    if (!checked.valid) {
      skip(checked.errors.join("; "));
      continue;
    }
    const manifest = checked.manifest;
    const label = `${manifest.name}@${manifest.version}`;
    const contributes = manifest.contributes ?? {};

    // Config: schema + defaults + validation, before any extension code is
    // imported — misconfigured code must not run (WM-841).
    let config;
    try {
      config = resolveExtensionConfig(dir, manifest, values);
    } catch (err) {
      skip(`${label}: ${err.message}`);
      continue;
    }

    // Packs: resolve to pack roots and prove they load with everything
    // accepted so far. The registry's own errors identify both packs on a
    // collision, which is the message an operator needs.
    let extPackRoots;
    try {
      extPackRoots = (contributes.packs ?? []).map((rel) =>
        packRootFor(dir, rel),
      );
      for (const pack of extPackRoots) {
        if (acceptedPackNames.has(pack.name)) {
          throw new RegistryError(
            `pack name "${pack.name}" is already configured (policy packs: or an earlier extension)`,
          );
        }
      }
      if (extPackRoots.length > 0) dryLoad([...accepted, ...extPackRoots]);
    } catch (err) {
      skip(`${label}: pack rejected — ${err.message}`);
      continue;
    }

    // Adapters: import, contract-check, and refuse names already taken.
    // Nothing is registered until every adapter of the extension passed.
    const modules = [];
    let adapterFault = null;
    for (const [name, rel] of Object.entries(contributes.adapters ?? {})) {
      if (adapterRegistry?.has(name) || acceptedAdapterNames.has(name)) {
        adapterFault = `adapter "${name}" is already registered (extensions may not replace an existing adapter)`;
        break;
      }
      const file = path.resolve(dir, rel);
      let module;
      try {
        module = await import(pathToFileURL(file).href);
      } catch (err) {
        adapterFault = `adapter "${name}" failed to import from ${file}: ${err.message}`;
        break;
      }
      try {
        validateAdapterContract(name, module);
      } catch (err) {
        adapterFault = err.message;
        break;
      }
      modules.push({ name, module });
    }
    if (adapterFault) {
      skip(`${label}: ${adapterFault}`);
      continue;
    }

    // Hooks: import and contract-check (default function + id); an id the
    // registry already holds is refused. Registered only once accepted.
    const hookModules = [];
    let hookFault = null;
    for (const [point, rel] of Object.entries(contributes.hooks ?? {})) {
      const file = path.resolve(dir, rel);
      let module;
      try {
        module = await import(pathToFileURL(file).href);
      } catch (err) {
        hookFault = `hook "${point}" failed to import from ${file}: ${err.message}`;
        break;
      }
      let contract;
      try {
        contract = validateHookModule(module);
      } catch (err) {
        hookFault = `hook "${point}" (${rel}): ${err.message}`;
        break;
      }
      if (
        hookRegistry.has(contract.id) ||
        hookModules.some((h) => h.id === contract.id)
      ) {
        hookFault = `hook id "${contract.id}" is already registered (extensions may not replace an existing hook)`;
        break;
      }
      hookModules.push({ point, id: contract.id, module });
    }
    if (hookFault) {
      skip(`${label}: ${hookFault}`);
      continue;
    }

    // Connectors: import and contract-check (default start function + id).
    // Registered for serve to start only once the extension is accepted; a
    // later start() failure is a per-connector anomaly, not a skip here.
    const connectorModules = [];
    let connectorFault = null;
    for (const [name, rel] of Object.entries(contributes.connectors ?? {})) {
      const file = path.resolve(dir, rel);
      let module;
      try {
        module = await import(pathToFileURL(file).href);
      } catch (err) {
        connectorFault = `connector "${name}" failed to import from ${file}: ${err.message}`;
        break;
      }
      let contract;
      try {
        contract = validateConnectorModule(module);
      } catch (err) {
        connectorFault = `connector "${name}" (${rel}): ${err.message}`;
        break;
      }
      connectorModules.push({ name, id: contract.id, module });
    }
    if (connectorFault) {
      skip(`${label}: ${connectorFault}`);
      continue;
    }
    if (config && acceptedNamespaces.has(config.namespace)) {
      skip(
        `${label}: config namespace "${config.namespace}" is already used by ${acceptedNamespaces.get(config.namespace)}`,
      );
      continue;
    }

    const extHarness = harnessRootFor(dir, manifest);
    if (extHarness) {
      if (extHarness.plugin === CORE_HARNESS_PLUGIN) {
        skip(
          `${label}: harness plugin name "${extHarness.plugin}" is reserved for the built-in core pack`,
        );
        continue;
      }
      if (acceptedHarnessNames.has(extHarness.name)) {
        skip(
          `${label}: harness name "${extHarness.name}" is already contributed`,
        );
        continue;
      }
      if (acceptedHarnessPlugins.has(extHarness.plugin)) {
        skip(
          `${label}: harness plugin "${extHarness.plugin}" is already contributed`,
        );
        continue;
      }
    }

    // Accept: commit packs, register adapters, record the reserved keys.
    accepted.push(...extPackRoots);
    for (const pack of extPackRoots) acceptedPackNames.add(pack.name);
    for (const { name, module } of modules) {
      adapterRegistry?.register(name, module, { source: manifest.name });
      acceptedAdapterNames.add(name);
    }
    for (const { point, module } of hookModules) {
      hookRegistry.register(point, module, {
        source: extensionHookSource(manifest.name),
        config: () => getExtensionConfig(manifest.name),
      });
    }
    const { config: connectorConfig, secrets: connectorSecrets } =
      connectorCtxConfig(config);
    for (const { name, id, module } of connectorModules) {
      loadedConnectorModules.push({
        extension: manifest.name,
        name,
        id,
        module: environmentGatedConnectorModule(module),
        config: connectorConfig,
        secrets: connectorSecrets,
      });
    }
    for (const warning of checked.warnings) anomalies.push(warning);
    if (config) acceptedNamespaces.set(config.namespace, manifest.name);
    const { schemaJson, secretMeta, ...publicConfig } = config ?? {};
    const extPanelRoots = panelRootsFor(dir, manifest);
    panelRoots.push(...extPanelRoots);
    if (extHarness) {
      harnessRoots.push(extHarness);
      acceptedHarnessPlugins.add(extHarness.plugin);
      acceptedHarnessNames.add(extHarness.name);
    }
    extensions.push({
      name: manifest.name,
      version: manifest.version,
      path: dir,
      source,
      ...(source === "package"
        ? { package: packageName, packageVersion: packageVersion ?? null }
        : {}),
      packs: extPackRoots.map((p) => p.name),
      adapters: modules.map((m) => m.name),
      hooks: hookModules.map(({ point, id }) => ({ point, id })),
      connectors: connectorModules.map(({ name, id }) => ({ name, id })),
      panels: extPanelRoots.map((p) => p.dir),
      reserved: RESERVED_CONTRIBUTIONS.filter((key) =>
        Object.hasOwn(contributes, key),
      ),
      config: config ? publicConfig : null,
      ...(extHarness
        ? { harness: { plugin: extHarness.plugin, prefix: extHarness.prefix } }
        : {}),
    });
    loaded.push({
      name: manifest.name,
      version: manifest.version,
      path: dir,
      source,
      ...(source === "package"
        ? { package: packageName, packageVersion: packageVersion ?? null }
        : {}),
      config: config ? { ...publicConfig, schemaJson, secretMeta } : null,
    });
  }

  LOADED = { extensions: loaded, disabled };
  setLoadedConnectors(loadedConnectorModules);
  return {
    extensions,
    packRoots: accepted,
    panelRoots,
    harnessRoots,
    anomalies,
    disabled,
  };
}
