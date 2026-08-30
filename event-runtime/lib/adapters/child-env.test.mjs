import { afterEach, describe, expect, test } from "bun:test";
import {
  DISPATCH_IDENTITY_ENV,
  PROVIDER_CREDENTIAL_ENV,
  PUSH_CREDENTIAL_ENV,
  RUNTIME_IDENTITY_ENV,
  safeChildEnvironment,
} from "./child-env.mjs";
import { safeChildEnvironment as claudeEnvironment } from "./claude.mjs";
import { safeChildEnvironment as commandEnvironment } from "./command.mjs";
import { safeChildEnvironment as agyEnvironment } from "./agy.mjs";
import { safeChildEnvironment as cursorEnvironment } from "./cursor.mjs";
import { safeChildEnvironment as piEnvironment } from "./pi.mjs";

const keySet = (env) => Object.keys(env).sort();

describe("shared child environment", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
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
