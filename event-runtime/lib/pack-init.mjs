/** Create the smallest data-only filesystem pack accepted by the registry. */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { hashBytes } from "./canonical.mjs";

export const PACK_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

export function assertPackName(name) {
  if (typeof name !== "string" || !PACK_NAME_PATTERN.test(name)) {
    throw new Error(
      "pack name must match ^[a-z][a-z0-9-]*$ (lowercase letters, digits, and hyphens)",
    );
  }
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * Scaffold a self-contained, pinned, non-mutating pack. The return value is
 * intentionally useful to both the CLI and tests without parsing stdout.
 */
export function initPack(name, { dir = path.resolve("packs", name) } = {}) {
  assertPackName(name);
  const root = path.resolve(dir);
  if (existsSync(root)) throw new Error(`destination already exists: ${root}`);

  const prompt = "Return a friendly greeting using the supplied name.\n";
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    required: ["name"],
    properties: { name: { type: "string", minLength: 1 } },
    additionalProperties: false,
  };
  const schemaBytes = `${JSON.stringify(schema, null, 2)}\n`;
  const definition = {
    id: "hello",
    version: 1,
    prompt: "agents/hello.md",
    input_schema: "schemas/hello.input.json",
    output_schema: "schemas/hello.output.json",
    workspace: { type: "ephemeral", retainOnFailure: false },
    capabilities: { filesystem: "read-only", services: [] },
    limits: { timeout_seconds: 30, attempts: 1 },
    mutating: false,
  };

  mkdirSync(path.join(root, "agents"), { recursive: true });
  mkdirSync(path.join(root, "schemas"), { recursive: true });
  writeJson(path.join(root, "pack.json"), {
    name,
    version: "0.1.0",
    namespace: name,
  });
  writeFileSync(path.join(root, "agents", "hello.md"), prompt, "utf8");
  writeJson(path.join(root, "agents", "hello.json"), definition);
  writeFileSync(
    path.join(root, "schemas", "hello.input.json"),
    schemaBytes,
    "utf8",
  );
  writeFileSync(
    path.join(root, "schemas", "hello.output.json"),
    schemaBytes,
    "utf8",
  );
  writeJson(path.join(root, "event-types.json"), {
    [`${name}.hello.requested`]: {
      agent: `${name}/hello@1`,
      adapter: "fake",
      idempotencyScope: ["correlationId"],
    },
  });
  writeJson(path.join(root, "pins.json"), {
    "agents/hello.md": hashBytes(prompt),
    "schemas/hello.input.json": hashBytes(schemaBytes),
    "schemas/hello.output.json": hashBytes(schemaBytes),
  });
  return { name, root };
}
