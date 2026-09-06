import { afterEach, describe, expect, test } from "bun:test";
import {
  CELL_CAPABILITY_ENV,
  DISPATCH_IDENTITY_ENV,
  HARNESS_LAYOUT,
  KILL_GRACE_MS,
  PROMPT_SUFFIX,
  PROVIDER_CREDENTIAL_ENV,
  PUSH_CREDENTIAL_ENV,
  RUNTIME_IDENTITY_ENV,
  safeChildEnvironment,
  verifiedPrompt,
} from "./child-env.mjs";
import {
  HARNESS_LAYOUT as acpHarnessLayout,
  KILL_GRACE_MS as acpKillGraceMs,
  PROMPT_SUFFIX as acpPromptSuffix,
  verifiedPrompt as acpVerifiedPrompt,
} from "./acp.mjs";
import { dispatchIdentityEnv } from "../worker.mjs";
import { safeChildEnvironment as claudeEnvironment } from "./claude.mjs";
import {
  HARNESS_LAYOUT as claudeHarnessLayout,
  KILL_GRACE_MS as claudeKillGraceMs,
  PROMPT_SUFFIX as claudePromptSuffix,
  verifiedPrompt as claudeVerifiedPrompt,
} from "./claude.mjs";
import { safeChildEnvironment as commandEnvironment } from "./command.mjs";
import {
  HARNESS_LAYOUT as agyHarnessLayout,
  KILL_GRACE_MS as agyKillGraceMs,
  safeChildEnvironment as agyEnvironment,
} from "./agy.mjs";
import {
  HARNESS_LAYOUT as cursorHarnessLayout,
  KILL_GRACE_MS as cursorKillGraceMs,
  safeChildEnvironment as cursorEnvironment,
} from "./cursor.mjs";
import {
  HARNESS_LAYOUT as hermesHarnessLayout,
  KILL_GRACE_MS as hermesKillGraceMs,
} from "./hermes.mjs";
import {
  HARNESS_LAYOUT as piHarnessLayout,
  KILL_GRACE_MS as piKillGraceMs,
  safeChildEnvironment as piEnvironment,
} from "./pi.mjs";

const keySet = (env) => Object.keys(env).sort();

describe("shared child environment", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("shares harness packaging and prompt contracts with ACP and Claude", () => {
    expect(acpHarnessLayout).toBe(HARNESS_LAYOUT);
    expect(claudeHarnessLayout).toBe(HARNESS_LAYOUT);
    expect(acpKillGraceMs).toBe(KILL_GRACE_MS);
    expect(claudeKillGraceMs).toBe(KILL_GRACE_MS);
    expect(acpPromptSuffix).toBe(PROMPT_SUFFIX);
    expect(claudePromptSuffix).toBe(PROMPT_SUFFIX);
    expect(acpVerifiedPrompt).toBe(verifiedPrompt);
    expect(claudeVerifiedPrompt).toBe(verifiedPrompt);
  });

  test("exports the shared kill grace period from every standard adapter", () => {
    for (const adapterKillGraceMs of [
      acpKillGraceMs,
      agyKillGraceMs,
      claudeKillGraceMs,
      cursorKillGraceMs,
      hermesKillGraceMs,
      piKillGraceMs,
    ]) {
      expect(adapterKillGraceMs).toBe(KILL_GRACE_MS);
    }
  });

  test("keeps every private harness layout leaf on the shared contract shape", () => {
    for (const layout of [
      agyHarnessLayout,
      cursorHarnessLayout,
      hermesHarnessLayout,
      piHarnessLayout,
    ]) {
      for (const entry of Object.values(layout)) {
        expect(Object.keys(entry).sort()).toEqual(["dest", "source", "type"]);
        expect(typeof entry.source).toBe("function");
        expect(typeof entry.dest).toBe("function");
        expect(typeof entry.type).toBe("string");
      }
    }
  });

  test("keeps adapter differences explicit while stripping all credentials", () => {
    for (const key of RUNTIME_IDENTITY_ENV) {
      process.env[key] = `ambient-${key}`;
    }
    const supplied = Object.fromEntries(
      [
        ...PUSH_CREDENTIAL_ENV,
        ...PROVIDER_CREDENTIAL_ENV,
        ...DISPATCH_IDENTITY_ENV,
        "ANTIGRAVITY_AGENT",
        "ANTIGRAVITY_LS_ADDRESS",
        "CURSOR_API_ENDPOINT",
        "CUSTOM_SETTING",
      ].map((key) => [key, `supplied-${key}`]),
    );
    const outputs = {
      claude: claudeEnvironment(supplied, { mutating: false }),
      command: commandEnvironment(supplied, { mutating: false }),
      agy: agyEnvironment(supplied, { mutating: false }),
      cursor: cursorEnvironment(supplied, { mutating: false }),
      pi: piEnvironment(supplied, { mutating: false }),
    };

    for (const output of Object.values(outputs)) {
      for (const key of [...PUSH_CREDENTIAL_ENV, ...PROVIDER_CREDENTIAL_ENV]) {
        expect(output[key]).toBeUndefined();
      }
      for (const key of DISPATCH_IDENTITY_ENV) {
        expect(output[key]).toBe(`supplied-${key}`);
      }
    }
    expect(keySet(outputs.command)).toEqual(
      [...keySet(outputs.claude), ...RUNTIME_IDENTITY_ENV].sort(),
    );
    expect(keySet(outputs.agy)).toEqual(
      keySet(outputs.claude).filter((key) => !key.startsWith("ANTIGRAVITY_")),
    );
    expect(keySet(outputs.cursor)).toEqual(
      keySet(outputs.claude).filter((key) => key !== "CURSOR_API_ENDPOINT"),
    );
    expect(keySet(outputs.pi)).toEqual(keySet(outputs.claude));
  });

  test("states a result location every agent can honour, dispatched or not", () => {
    // The suffix is appended to EVERY agent's prompt, but FACTORY_RESULT_PATH
    // is only exported for dispatch@ agents. It must therefore name the
    // workspace-relative path unconditionally and the variable only as an
    // override, or a non-dispatch agent is told to write to an empty string.
    expect(PROMPT_SUFFIX).toContain("./result.json");
    expect(PROMPT_SUFFIX).toContain("$FACTORY_RESULT_PATH when set");

    const def = { ref: "review@1", promptText: "You are a test agent." };
    const prompt = verifiedPrompt(def, "claude");
    const resultPath = "/workspace/result.json";

    for (const agent of ["review@1", "dispatch@1"]) {
      const env = dispatchIdentityEnv({
        spec: { agent },
        env: { FACTORY_ROOT: "/factory-root" },
        resultPath,
      });
      const dispatched = agent.startsWith("dispatch@");
      expect(env.FACTORY_RESULT_PATH).toBe(dispatched ? resultPath : undefined);
      // Whichever half of the instruction applies, the agent can resolve it.
      const referenced = env.FACTORY_RESULT_PATH ?? "./result.json";
      expect(referenced.length).toBeGreaterThan(0);
      expect(prompt).toContain(
        dispatched ? "$FACTORY_RESULT_PATH" : "./result.json",
      );
    }
  });

  test("carries FACTORY_RESULT_PATH through the child environment", () => {
    expect(DISPATCH_IDENTITY_ENV).toContain("FACTORY_RESULT_PATH");
    const supplied = { FACTORY_RESULT_PATH: "/workspace/result.json" };
    for (const environment of [
      claudeEnvironment,
      commandEnvironment,
      agyEnvironment,
      cursorEnvironment,
      piEnvironment,
    ]) {
      expect(
        environment(supplied, { mutating: false }).FACTORY_RESULT_PATH,
      ).toBe("/workspace/result.json");
    }
    // Even under the aggressive FACTORY_ prefix strip the adapters apply.
    expect(
      safeChildEnvironment(supplied, false, {
        extraStrip: ["FACTORY_RESULT_PATH"],
        stripPrefixes: ["FACTORY_"],
      }).FACTORY_RESULT_PATH,
    ).toBe("/workspace/result.json");
  });

  test("dispatch identity survives extraStrip and FACTORY_ prefix stripping", () => {
    const supplied = Object.fromEntries(
      [...DISPATCH_IDENTITY_ENV, "FACTORY_OTHER"].map((key) => [
        key,
        `supplied-${key}`,
      ]),
    );
    const output = safeChildEnvironment(
      supplied,
      { mutating: false },
      {
        factoryRoot: "/factory-root",
        extraStrip: [...DISPATCH_IDENTITY_ENV],
        stripPrefixes: ["FACTORY_"],
      },
    );
    for (const key of DISPATCH_IDENTITY_ENV) {
      expect(output[key]).toBe(`supplied-${key}`);
    }
    expect(output.FACTORY_OTHER).toBeUndefined();
    expect(output.FACTORY_ROOT).toBeUndefined();

    const absent = safeChildEnvironment({}, false, {
      stripPrefixes: ["FACTORY_"],
    });
    for (const key of DISPATCH_IDENTITY_ENV) {
      expect(absent[key]).toBeUndefined();
    }
  });

  test("cell credentials reach a definition that declares capabilities.cells", () => {
    const supplied = Object.fromEntries(
      CELL_CAPABILITY_ENV.map((key) => [key, `supplied-${key}`]),
    );
    const def = {
      mutating: false,
      capabilities: {
        filesystem: "workspace-only",
        cells: [{ binding: "GENERIC_CELL", access: "read-write" }],
      },
    };
    const output = safeChildEnvironment(supplied, def, {
      extraStrip: [...CELL_CAPABILITY_ENV],
      stripPrefixes: ["FACTORY_", "CELL_"],
    });
    for (const key of CELL_CAPABILITY_ENV) {
      expect(output[key]).toBe(`supplied-${key}`);
    }
  });

  test("cell credentials are withheld from definitions without cells", () => {
    const supplied = Object.fromEntries(
      CELL_CAPABILITY_ENV.map((key) => [key, `supplied-${key}`]),
    );
    for (const def of [
      { mutating: false },
      { mutating: true, capabilities: { filesystem: "workspace-only" } },
      { mutating: false, capabilities: { cells: [] } },
      true,
      false,
    ]) {
      const output = safeChildEnvironment(supplied, def);
      for (const key of CELL_CAPABILITY_ENV) {
        expect(output[key]).toBeUndefined();
      }
    }
  });

  test("does not grant push credentials to non-boolean mutating values", () => {
    const supplied = Object.fromEntries(
      PUSH_CREDENTIAL_ENV.map((key) => [key, `supplied-${key}`]),
    );
    for (const environment of [
      claudeEnvironment,
      commandEnvironment,
      agyEnvironment,
      cursorEnvironment,
      piEnvironment,
    ]) {
      const output = environment(supplied, { mutating: "yes" });
      for (const key of PUSH_CREDENTIAL_ENV) {
        expect(output[key]).toBeUndefined();
      }
    }
  });

  test("inherits the control bearer only with runtime identity", () => {
    process.env.FACTORY_CONTROL_API_TOKEN = "worker-control-bearer";

    expect(
      safeChildEnvironment({}, false, { inheritRuntimeIdentity: true })
        .FACTORY_CONTROL_API_TOKEN,
    ).toBe("worker-control-bearer");
    expect(
      safeChildEnvironment({}, false).FACTORY_CONTROL_API_TOKEN,
    ).toBeUndefined();

    for (const environment of [claudeEnvironment, agyEnvironment]) {
      expect(
        environment({}, { mutating: false }).FACTORY_CONTROL_API_TOKEN,
      ).toBeUndefined();
    }
  });

  test("applies shared options after the caller environment", () => {
    process.env.FACTORY_EVENT_PORT = "17381";
    const output = safeChildEnvironment(
      {
        ANTHROPIC_API_KEY: "provider-secret",
        EXTRA_SECRET: "extra-secret",
        ADAPTER_SECRET: "prefix-secret",
      },
      true,
      {
        factoryRoot: "/tmp/factory-root",
        inheritRuntimeIdentity: true,
        extraStrip: ["EXTRA_SECRET"],
        stripPrefixes: ["ADAPTER_"],
      },
    );

    expect(output.FACTORY_ROOT).toBe("/tmp/factory-root");
    expect(output.FACTORY_EVENT_PORT).toBe("17381");
    expect(output.ANTHROPIC_API_KEY).toBeUndefined();
    expect(output.EXTRA_SECRET).toBeUndefined();
    expect(output.ADAPTER_SECRET).toBeUndefined();
  });
});
