import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-pack-authoring-test-mjs";
import { packCommand } from "../cli.mjs";
import { initPack } from "./pack-init.mjs";
import { validatePack } from "./pack-validate.mjs";

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

test("the first-party reference packs both pass authoring validation", () => {
  for (const name of ["example-hello", "ops-disk"]) {
    expect(validatePack(path.resolve("packs", name))).toMatchObject({
      name,
      agents: 1,
    });
  }
});
