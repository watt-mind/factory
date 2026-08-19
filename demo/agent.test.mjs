import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyStarterPatch } from "./agent.mjs";
import { greet } from "./fixtures/greet.mjs";

test("fixture greet() matches the starter ticket", () => {
  expect(greet("Ada")).toBe("Hello, Ada!");
  expect(() => greet("")).toThrow("greet requires a name");
});

test("applyStarterPatch writes greet and re-exports it", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "factory-demo-agent-"));
  const src = path.join(dir, "src");
  mkdirSync(src, { recursive: true });
  writeFileSync(
    path.join(src, "index.mjs"),
    'export const VERSION = "0.1.0";\n',
  );
  applyStarterPatch(dir);
  expect(readFileSync(path.join(src, "index.mjs"), "utf8")).toContain(
    'from "./greet.mjs"',
  );
  expect(readFileSync(path.join(src, "greet.mjs"), "utf8")).toContain(
    "export function greet",
  );
});
