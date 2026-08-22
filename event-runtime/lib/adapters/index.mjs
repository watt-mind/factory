/**
 * The adapter registry (WM-837).
 *
 * Harness adapters share one contract — an exported async `execute()` (the
 * entry point lib/worker.mjs calls) plus a `SANDBOX_SUPPORT` verdict for the
 * sandbox seam in sandboxed.mjs — but until this module the set of adapters
 * was an object literal duplicated in cli/work.mjs and cli/serve.mjs. Adding
 * one meant editing two CLIs, and nothing outside the repo could contribute
 * one. The registry gives the follow-up extension loader something to
 * register into, and it validates the contract at registration time so a
 * malformed adapter fails at startup, typed and named, rather than as an
 * `unknown_adapter` or a TypeError mid-run.
 *
 * Two properties this module owns:
 *
 *   1. **Contract validation.** `register()` (and therefore construction,
 *      which registers the built-ins) refuses a module that lacks `execute`
 *      or `SANDBOX_SUPPORT`, carries an unknown support value, or has a name
 *      outside `^[a-z][a-z0-9-]*$` — with `AdapterContractError` naming the
 *      missing export. Duplicate names are `AdapterRegistrationError` unless
 *      `{ replace: true }` says the caller means it.
 *   2. **The sandbox seam is mandatory.** Everything the registry hands out
 *      (`get()`, `toMap()`) is a frozen wrapper whose `execute` consults
 *      sandboxed.mjs first: an adapter that declares `unsupported` is refused
 *      with `SandboxUnsupportedError` for a sandboxed definition before its own
 *      code runs, so even an adapter that forgets `refuseSandbox()` cannot
 *      execute on the host. `gondolin` adapters are delegated to and own the
 *      `runSandboxed()` call; sandboxed.test.mjs proves each built-in reaches
 *      the VM boundary. No code path yields the raw module — index.test.mjs
 *      asserts that.
 *
 * The registry is not a class hierarchy (docs/event-runtime-conventions.md):
 * it is a closure over a Map with a handful of functions, and the worker keeps
 * consuming the plain `name → adapter` object it always has, obtained via
 * `toMap()`.
 */
import * as actions from "./actions.mjs";
import * as agy from "./agy.mjs";
import * as claude from "./claude.mjs";
import * as command from "./command.mjs";
import * as cursor from "./cursor.mjs";
import * as fake from "./fake.mjs";
import * as hermes from "./hermes.mjs";
import * as pi from "./pi.mjs";
import { refuseSandbox } from "./sandboxed.mjs";

/** Adapter names are lower-case identifiers; they appear in labels, specs, and CLI flags. */
export const ADAPTER_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/** The only two answers the sandbox seam accepts (sandboxed.mjs, WM-313). */
export const SANDBOX_SUPPORT_VALUES = Object.freeze([
  "gondolin",
  "unsupported",
]);

/** The export lib/worker.mjs invokes: `adapters[adapterKey].execute({...})`. */
export const ADAPTER_ENTRY_POINT = "execute";

/** Source label for the adapters shipped in this directory. */
export const BUILTIN_SOURCE = "builtin";

const SANDBOX_GUARDED = Symbol.for("factory.adapter.sandbox-guarded");

export class AdapterContractError extends Error {
  /**
   * @param {string} adapter - the name being registered
   * @param {string} missing - which part of the contract failed: `name`, `module`, `execute`, or `SANDBOX_SUPPORT`
   * @param {string} detail
   */
  constructor(adapter, missing, detail) {
    super(
      `adapter "${adapter}" does not satisfy the adapter contract (${missing}): ${detail}`,
    );
    this.name = "AdapterContractError";
    this.code = "adapter_contract_invalid";
    this.adapter = adapter;
    this.missing = missing;
  }
}

export class AdapterRegistrationError extends Error {
  /**
   * @param {string} adapter
   * @param {string} code - `adapter_duplicate` or `adapter_source_missing`
   * @param {string} detail
   */
  constructor(adapter, code, detail) {
    super(`adapter "${adapter}" cannot be registered: ${detail}`);
    this.name = "AdapterRegistrationError";
    this.code = code;
    this.adapter = adapter;
  }
}

/**
 * The adapters shipped with the runtime, keyed by the name a run spec's
 * `adapter` field carries. A fresh, frozen object each call so no caller can
 * mutate the built-in set for the next one.
 */
export function builtinAdapters() {
  return Object.freeze({
    actions,
    agy,
    claude,
    command,
    cursor,
    fake,
    hermes,
    pi,
  });
}

/**
 * Check one module against the adapter contract. Returns the normalized
 * summary the registry stores; throws `AdapterContractError` naming the
 * missing piece otherwise. Exported so a loader can validate before it
 * decides whether to register (e.g. to report every broken adapter in a
 * pack at once instead of stopping at the first).
 *
 * @param {string} name
 * @param {unknown} module - an ES module namespace or any object with the same exports
 * @returns {{ name: string, sandboxSupport: "gondolin"|"unsupported" }}
 */
export function validateAdapterContract(name, module) {
  if (typeof name !== "string" || !ADAPTER_NAME_PATTERN.test(name)) {
    throw new AdapterContractError(
      String(name),
      "name",
      `adapter names must match ${ADAPTER_NAME_PATTERN} (got ${JSON.stringify(name)})`,
    );
  }
  if (
    module === null ||
    (typeof module !== "object" && typeof module !== "function")
  ) {
    throw new AdapterContractError(
      name,
      "module",
      `expected a module namespace, got ${module === null ? "null" : typeof module}`,
    );
  }
  if (typeof module[ADAPTER_ENTRY_POINT] !== "function") {
    throw new AdapterContractError(
      name,
      ADAPTER_ENTRY_POINT,
      `missing export "${ADAPTER_ENTRY_POINT}" — the async run entry point lib/worker.mjs invokes`,
    );
  }
  if (!SANDBOX_SUPPORT_VALUES.includes(module.SANDBOX_SUPPORT)) {
    throw new AdapterContractError(
      name,
      "SANDBOX_SUPPORT",
      `missing or invalid export "SANDBOX_SUPPORT" — must be one of ${SANDBOX_SUPPORT_VALUES.join(" | ")} (got ${JSON.stringify(module.SANDBOX_SUPPORT ?? null)}); see lib/adapters/sandboxed.mjs`,
    );
  }
  return { name, sandboxSupport: module.SANDBOX_SUPPORT };
}

/** True when `adapter` came out of a registry (i.e. its execute goes through the sandbox seam). */
export function isSandboxGuarded(adapter) {
  return adapter?.[SANDBOX_GUARDED] === true;
}

/**
 * The wrapper the registry hands out. Spreads the module's exports so callers
 * that read adapter constants keep working, then replaces `execute` with one
 * that makes the sandbox decision before delegating. Frozen: nobody can swap
 * `execute` back afterwards.
 */
function guardAdapter(name, module, sandboxSupport) {
  const reason =
    `Adapter "${name}" declares SANDBOX_SUPPORT="${sandboxSupport}", so the registry refuses ` +
    `the run before the adapter is invoked (lib/adapters/index.mjs).`;
  const execute = async (params) => {
    if (sandboxSupport !== "gondolin") refuseSandbox(name, params?.def, reason);
    return module.execute(params);
  };
  return Object.freeze({
    ...module,
    name,
    SANDBOX_SUPPORT: sandboxSupport,
    execute,
    [SANDBOX_GUARDED]: true,
  });
}

/**
 * Create a registry. The built-ins are registered first with source
 * `builtin`; anything else arrives through `register()`.
 *
 * @param {{ builtins?: Record<string, unknown> }} [options]
 */
export function createAdapterRegistry({ builtins = builtinAdapters() } = {}) {
  /** @type {Map<string, { name: string, source: string, sandboxSupport: string, adapter: object }>} */
  const entries = new Map();

  const summary = (entry) => ({
    name: entry.name,
    source: entry.source,
    sandboxSupport: entry.sandboxSupport,
  });

  /**
   * Validate and add one adapter.
   *
   * @param {string} name
   * @param {unknown} module
   * @param {{ source: string, replace?: boolean }} options - `source` is
   *   mandatory so `adapters` can always say where an adapter came from
   *   (`builtin`, a pack name, an extension path); `replace` permits
   *   overriding an existing name on purpose.
   * @returns {{ name: string, source: string, sandboxSupport: string }}
   */
  function register(name, module, { source, replace = false } = {}) {
    const validated = validateAdapterContract(name, module);
    if (typeof source !== "string" || source === "") {
      throw new AdapterRegistrationError(
        name,
        "adapter_source_missing",
        "register() needs { source } saying where the adapter came from",
      );
    }
    const existing = entries.get(name);
    if (existing && !replace) {
      throw new AdapterRegistrationError(
        name,
        "adapter_duplicate",
        `already registered from ${existing.source}; pass { replace: true } to override it deliberately`,
      );
    }
    const entry = {
      ...validated,
      source,
      adapter: guardAdapter(name, module, validated.sandboxSupport),
    };
    entries.set(name, entry);
    return summary(entry);
  }

  for (const [name, module] of Object.entries(builtins ?? {})) {
    register(name, module, { source: BUILTIN_SOURCE });
  }

  return Object.freeze({
    register,
    /** The sandbox-guarded adapter, or undefined. */
    get: (name) => entries.get(name)?.adapter,
    has: (name) => entries.has(name),
    /** Sorted by name; what `bun event-runtime/cli.mjs adapters` prints. */
    list: () =>
      [...entries.values()]
        .map(summary)
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    /**
     * A frozen `name → adapter` snapshot — the shape lib/worker.mjs consumes
     * (`runOnce(db, registry, adapters, opts)` → `adapters[adapterKey]`).
     */
    toMap: () =>
      Object.freeze(
        Object.fromEntries(
          [...entries.values()].map((entry) => [entry.name, entry.adapter]),
        ),
      ),
  });
}
