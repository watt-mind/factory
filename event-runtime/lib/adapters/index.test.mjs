/**
 * The adapter registry (WM-837): contract validation for every built-in and
 * for a minimal fixture, plus the property the sandbox seam depends on — no
 * caller can obtain an adapter from the registry that bypasses the
 * `def.sandbox` decision in sandboxed.mjs.
 *
 * Pure: nothing here spawns a process or touches the filesystem.
 */
import { describe, expect, test } from "bun:test";
import {
  ADAPTER_NAME_PATTERN,
  AdapterContractError,
  AdapterRegistrationError,
  builtinAdapters,
  createAdapterRegistry,
  isSandboxGuarded,
  validateAdapterContract,
} from "./index.mjs";
import { SandboxUnsupportedError } from "./sandboxed.mjs";

const BUILTIN_NAMES = [
  "actions",
  "agy",
  "claude",
  "command",
  "cursor",
  "fake",
  "hermes",
  "pi",
];

/** A minimal adapter that satisfies the contract and records what it was handed. */
function fixtureAdapter({ sandboxSupport = "unsupported" } = {}) {
  const calls = [];
  return {
    calls,
    module: {
      SANDBOX_SUPPORT: sandboxSupport,
      async execute(params) {
        calls.push(params);
        return { exitCode: 0, timedOut: false };
      },
    },
  };
}

describe("builtinAdapters", () => {
  test("returns exactly the eight shipped adapters, keyed by name", () => {
    expect(Object.keys(builtinAdapters()).sort()).toEqual(BUILTIN_NAMES);
  });

  test("every built-in satisfies the adapter contract", () => {
    for (const [name, mod] of Object.entries(builtinAdapters())) {
      const report = validateAdapterContract(name, mod);
      expect(report.name).toBe(name);
      expect(["gondolin", "unsupported"]).toContain(report.sandboxSupport);
    }
  });
});

describe("validateAdapterContract", () => {
  test("accepts a minimal fixture adapter", () => {
    const { module } = fixtureAdapter({ sandboxSupport: "gondolin" });
    expect(validateAdapterContract("fixture", module)).toEqual({
      name: "fixture",
      sandboxSupport: "gondolin",
    });
  });

  test("a module without the run entry point throws a typed error naming it", () => {
    let caught;
    try {
      validateAdapterContract("broken", { SANDBOX_SUPPORT: "unsupported" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AdapterContractError);
    expect(caught.code).toBe("adapter_contract_invalid");
    expect(caught.adapter).toBe("broken");
    expect(caught.missing).toBe("execute");
    expect(caught.message).toContain("execute");
  });

  test("a module without SANDBOX_SUPPORT throws a typed error naming it", () => {
    let caught;
    try {
      validateAdapterContract("broken", { execute: async () => ({}) });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AdapterContractError);
    expect(caught.missing).toBe("SANDBOX_SUPPORT");
    expect(caught.message).toContain("SANDBOX_SUPPORT");
  });

  test("an unknown SANDBOX_SUPPORT value is rejected — the sandbox seam only knows two answers", () => {
    expect(() =>
      validateAdapterContract("broken", {
        SANDBOX_SUPPORT: "maybe",
        execute: async () => ({}),
      }),
    ).toThrow(AdapterContractError);
  });

  test("names must match ^[a-z][a-z0-9-]*$", () => {
    const { module } = fixtureAdapter();
    for (const bad of ["", "Claude", "1pi", "my_adapter", "a b", "-x", "é"]) {
      let caught;
      try {
        validateAdapterContract(bad, module);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AdapterContractError);
      expect(caught.missing).toBe("name");
      expect(ADAPTER_NAME_PATTERN.test(bad)).toBe(false);
    }
    for (const good of ["a", "pi", "my-adapter", "x9", "claude-code2"]) {
      expect(validateAdapterContract(good, module).name).toBe(good);
    }
  });

  test("a non-object module is rejected", () => {
    expect(() => validateAdapterContract("x", null)).toThrow(
      AdapterContractError,
    );
    expect(() => validateAdapterContract("x", "claude")).toThrow(
      AdapterContractError,
    );
  });
});

describe("createAdapterRegistry", () => {
  test("registers the built-ins with source builtin by default", () => {
    const registry = createAdapterRegistry();
    expect(registry.list().map((a) => a.name)).toEqual(BUILTIN_NAMES);
    for (const entry of registry.list()) {
      expect(entry.source).toBe("builtin");
      expect(["gondolin", "unsupported"]).toContain(entry.sandboxSupport);
      expect(registry.has(entry.name)).toBe(true);
    }
    expect(registry.has("nope")).toBe(false);
    expect(registry.get("nope")).toBeUndefined();
  });

  test("an empty builtins map yields an empty registry", () => {
    const registry = createAdapterRegistry({ builtins: {} });
    expect(registry.list()).toEqual([]);
    expect(registry.toMap()).toEqual({});
  });

  test("register adds an adapter with its source; list is sorted by name", () => {
    const registry = createAdapterRegistry({ builtins: {} });
    const { module } = fixtureAdapter();
    const entry = registry.register("zeta", module, { source: "pack:x" });
    registry.register("alpha", module, { source: "pack:y" });
    expect(entry).toEqual({
      name: "zeta",
      source: "pack:x",
      sandboxSupport: "unsupported",
    });
    expect(registry.list()).toEqual([
      { name: "alpha", source: "pack:y", sandboxSupport: "unsupported" },
      { name: "zeta", source: "pack:x", sandboxSupport: "unsupported" },
    ]);
    expect(registry.has("alpha")).toBe(true);
    expect(typeof registry.get("alpha").execute).toBe("function");
  });

  test("register requires a source", () => {
    const registry = createAdapterRegistry({ builtins: {} });
    const { module } = fixtureAdapter();
    expect(() => registry.register("x", module)).toThrow(
      AdapterRegistrationError,
    );
    expect(() => registry.register("x", module, { source: "" })).toThrow(
      AdapterRegistrationError,
    );
  });

  test("register rejects an invalid module and leaves the registry unchanged", () => {
    const registry = createAdapterRegistry({ builtins: {} });
    expect(() =>
      registry.register(
        "broken",
        { SANDBOX_SUPPORT: "unsupported" },
        {
          source: "test",
        },
      ),
    ).toThrow(AdapterContractError);
    expect(registry.has("broken")).toBe(false);
    expect(registry.list()).toEqual([]);
  });

  test("duplicate names throw unless { replace: true }", () => {
    const registry = createAdapterRegistry();
    const { module } = fixtureAdapter();
    let caught;
    try {
      registry.register("claude", module, { source: "test" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AdapterRegistrationError);
    expect(caught.code).toBe("adapter_duplicate");
    expect(caught.adapter).toBe("claude");
    expect(caught.message).toContain("builtin");
    // The original stays in place after a refused duplicate.
    expect(registry.list().find((a) => a.name === "claude").source).toBe(
      "builtin",
    );

    registry.register("claude", module, { source: "test", replace: true });
    expect(registry.list().find((a) => a.name === "claude").source).toBe(
      "test",
    );
    expect(registry.list()).toHaveLength(BUILTIN_NAMES.length);
  });

  test("toMap is the worker's lookup shape: name → adapter with execute", () => {
    const registry = createAdapterRegistry();
    const map = registry.toMap();
    expect(Object.keys(map).sort()).toEqual(BUILTIN_NAMES);
    for (const name of BUILTIN_NAMES) {
      expect(map[name]).toBe(registry.get(name));
      expect(typeof map[name].execute).toBe("function");
      expect(map[name].name).toBe(name);
    }
    expect(Object.isFrozen(map)).toBe(true);
    // A snapshot: registering afterwards does not mutate a handed-out map.
    registry.register("later", fixtureAdapter().module, { source: "test" });
    expect(map.later).toBeUndefined();
    expect(registry.toMap().later).toBeDefined();
  });

  test("builtins are validated at construction, so a broken built-in fails fast", () => {
    expect(() =>
      createAdapterRegistry({
        builtins: { bad: { execute: async () => ({}) } },
      }),
    ).toThrow(AdapterContractError);
  });
});

describe("no unwrapped adapter escapes the registry (sandboxed.mjs is mandatory)", () => {
  test("every adapter handed out — via get() and toMap() — is the sandbox-guarded wrapper, never the raw module", () => {
    const registry = createAdapterRegistry();
    const raw = builtinAdapters();
    for (const name of BUILTIN_NAMES) {
      const viaGet = registry.get(name);
      expect(viaGet).not.toBe(raw[name]);
      expect(viaGet.execute).not.toBe(raw[name].execute);
      expect(isSandboxGuarded(viaGet)).toBe(true);
      expect(isSandboxGuarded(raw[name])).toBe(false);
      // Other exports still ride along for callers that read adapter constants.
      expect(viaGet.SANDBOX_SUPPORT).toBe(raw[name].SANDBOX_SUPPORT);
    }
    for (const adapter of Object.values(registry.toMap())) {
      expect(isSandboxGuarded(adapter)).toBe(true);
    }
    const { module } = fixtureAdapter();
    registry.register("fixture", module, { source: "test" });
    expect(registry.get("fixture")).not.toBe(module);
    expect(isSandboxGuarded(registry.get("fixture"))).toBe(true);
    expect(Object.isFrozen(registry.get("fixture"))).toBe(true);
  });

  test("an unsupported adapter that ignores def.sandbox is refused by the wrapper before its execute runs", async () => {
    const registry = createAdapterRegistry({ builtins: {} });
    const { module, calls } = fixtureAdapter({ sandboxSupport: "unsupported" });
    registry.register("careless", module, { source: "test" });
    const adapter = registry.get("careless");
    let caught = null;
    try {
      await adapter.execute({
        spec: { agent: "careless@1" },
        def: { ref: "careless@1", sandbox: { provider: "gondolin" } },
        workspaceDir: "/nonexistent",
        timeoutMs: 10,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SandboxUnsupportedError);
    expect(caught.adapter).toBe("careless");
    expect(calls).toHaveLength(0);
  });

  test("an ordinary definition passes straight through to the module's execute with the same params", async () => {
    const registry = createAdapterRegistry({ builtins: {} });
    const { module, calls } = fixtureAdapter({ sandboxSupport: "unsupported" });
    registry.register("plain", module, { source: "test" });
    const params = {
      spec: { agent: "plain@1" },
      def: { ref: "plain@1" },
      workspaceDir: "/nonexistent",
      timeoutMs: 10,
    };
    const outcome = await registry.get("plain").execute(params);
    expect(outcome).toEqual({ exitCode: 0, timedOut: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(params);
  });

  test("a gondolin adapter is delegated to for sandboxed definitions — the module owns the runSandboxed call", async () => {
    const registry = createAdapterRegistry({ builtins: {} });
    const { module, calls } = fixtureAdapter({ sandboxSupport: "gondolin" });
    registry.register("vm", module, { source: "test" });
    const params = {
      spec: { agent: "vm@1" },
      def: { ref: "vm@1", sandbox: { provider: "gondolin" } },
      workspaceDir: "/nonexistent",
      timeoutMs: 10,
    };
    await registry.get("vm").execute(params);
    expect(calls).toHaveLength(1);
  });
});
