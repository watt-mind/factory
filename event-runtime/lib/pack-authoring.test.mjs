import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-pack-authoring-test-mjs";
import { packCommand } from "../cli.mjs";
import { initPack } from "./pack-init.mjs";
import { validatePack } from "./pack-validate.mjs";
import { idempotencyKeyFor } from "./run-spec.mjs";
import { validate } from "./schema.mjs";

test("pack init creates a pinned pack the registry loader accepts", () => {
  const root = path.join(tmpDir("pack-init-"), "author-kit");
  const created = initPack("author-kit", { dir: root });

  expect(created).toEqual({ name: "author-kit", root });
  expect(existsSync(path.join(root, "pack.json"))).toBe(true);
  expect(existsSync(path.join(root, "pins.json"))).toBe(true);
  expect(validatePack(root)).toMatchObject({
    name: "author-kit",
    root,
    namespace: "author-kit",
    agents: 1,
  });
});

test("pack validate uses registry pin checks rather than accepting drift", () => {
  const root = path.join(tmpDir("pack-validate-"), "pinned-kit");
  initPack("pinned-kit", { dir: root });
  const prompt = path.join(root, "agents", "hello.md");
  writeFileSync(prompt, `${readFileSync(prompt, "utf8")}drift\n`, "utf8");

  expect(() => validatePack(root)).toThrow(/does not match pin/);
});

test("pack command supports explicit init destinations and validation", () => {
  const root = path.join(tmpDir("pack-command-"), "cli-kit");

  expect(packCommand(["init", "cli-kit", root])).toEqual({
    name: "cli-kit",
    root,
  });
  expect(packCommand(["validate", root])).toMatchObject({
    name: "cli-kit",
    root,
    agents: 1,
  });
});

test("the first-party reference packs all pass authoring validation", () => {
  const expectedAgents = {
    "example-hello": 1,
    "ops-disk": 1,
    editorial: 4,
  };
  for (const [name, agents] of Object.entries(expectedAgents)) {
    expect(validatePack(path.resolve("packs", name))).toMatchObject({
      name,
      agents,
    });
  }
});

test("editorial documented result envelopes validate their output schemas", () => {
  const root = path.resolve("packs", "editorial");
  const agentResultSchema = JSON.parse(
    readFileSync(
      path.resolve("event-runtime/schemas/factory.agent-result.v1.json"),
      "utf8",
    ),
  );
  const examples = ["topic-scan", "research", "draft", "review"];

  for (const name of examples) {
    const prompt = readFileSync(
      path.join(root, "agents", `${name}.md`),
      "utf8",
    );
    const output = prompt.slice(prompt.indexOf("## Output"));
    const completed = [...output.matchAll(/```json\n([\s\S]*?)\n```/g)]
      .map(([, source]) => JSON.parse(source))
      .filter((example) => example.terminalState === "completed");
    const outputSchema = JSON.parse(
      readFileSync(path.join(root, "schemas", `${name}.output.json`), "utf8"),
    );

    expect(
      completed,
      `${name} must document one completed result envelope`,
    ).toHaveLength(1);
    expect(validate(agentResultSchema, completed[0])).toEqual({
      valid: true,
      errors: [],
    });
    expect(validate(outputSchema, completed[0].artifact)).toEqual({
      valid: true,
      errors: [],
    });
  }
});

/**
 * Walks every subschema node (the object itself, each `properties` value, and
 * `items`) so a keyword buried under a nested property is checked too —
 * `validate` returns at the first node that fails, and only descends into
 * subschemas the sample value reaches.
 */
function schemaNodes(node, at, out = []) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return out;
  out.push([at, node]);
  if (node.properties && typeof node.properties === "object") {
    for (const [key, child] of Object.entries(node.properties)) {
      schemaNodes(child, `${at}.${key}`, out);
    }
  }
  if (node.items) schemaNodes(node.items, `${at}[]`, out);
  return out;
}

test("first-party pack schemas use only keywords lib/schema.mjs supports", () => {
  const packs = readdirSync(path.resolve("packs"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  expect(packs.length).toBeGreaterThan(0);

  const offenders = [];
  for (const pack of packs) {
    const dir = path.resolve("packs", pack, "schemas");
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      const source = path.join(dir, file);
      const schema = JSON.parse(readFileSync(source, "utf8"));
      for (const [at, node] of schemaNodes(schema, "$")) {
        // The contract validator fails closed on unknown keywords and formats;
        // an undefined value never masks that check, which runs first.
        for (const error of validate(node, undefined, at).errors) {
          if (error.includes("unsupported")) {
            offenders.push(`packs/${pack}/schemas/${file} ${error}`);
          }
        }
      }
    }
  }
  expect(offenders).toEqual([]);
});

/**
 * The supported scope vocabulary is `idempotencyKeyFor`'s switch in
 * run-spec.mjs (docs/event-runtime.md §5.4): `correlationId`, `subject`,
 * `inputHash`. Rather than restate that trio here and let the copy drift, the
 * check asks the runtime itself — one probe call per declared field, which
 * throws on anything the switch does not know. A pack that declares an
 * envelope-payload field (`siteId`, `articleId`, …) fails closed at plan time
 * and dead-letters the event, so catch it in the tree instead.
 */
function unsupportedScopeField(field) {
  try {
    idempotencyKeyFor(
      { idempotencyScope: [field] },
      { ref: "probe/scope@1", output_contract: "probe.output@1" },
      { eventId: "evt-probe", correlationId: "corr-probe", subject: "probe" },
      "sha256:probe",
    );
    return null;
  } catch (error) {
    return error.message;
  }
}

test("first-party pack idempotency scopes use only §5.4 fields", () => {
  const packs = readdirSync(path.resolve("packs"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  expect(packs.length).toBeGreaterThan(0);

  const offenders = [];
  let checked = 0;
  for (const pack of packs) {
    const source = path.resolve("packs", pack, "event-types.json");
    if (!existsSync(source)) continue;
    const mappings = JSON.parse(readFileSync(source, "utf8"));
    for (const [eventType, mapping] of Object.entries(mappings)) {
      expect(mapping.idempotencyScope?.length ?? 0).toBeGreaterThan(0);
      for (const field of mapping.idempotencyScope) {
        checked += 1;
        const failure = unsupportedScopeField(field);
        if (failure) {
          offenders.push(
            `packs/${pack}/event-types.json ${eventType}: ${failure}`,
          );
        }
      }
    }
  }
  expect(checked).toBeGreaterThan(0);
  expect(offenders).toEqual([]);
});

test("the scope probe rejects an envelope-payload field", () => {
  expect(unsupportedScopeField("siteId")).toMatch(
    /unknown idempotency scope field "siteId"/,
  );
  expect(unsupportedScopeField("correlationId")).toBeNull();
  expect(unsupportedScopeField("subject")).toBeNull();
  expect(unsupportedScopeField("inputHash")).toBeNull();
});
