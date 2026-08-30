import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { factoryRoot } from "./factory-root.mjs";

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function checkoutAt(root) {
  mkdirSync(path.join(root, "tools"), { recursive: true });
  writeFileSync(path.join(root, "tools", "linear.mjs"), "");
}

test("factoryRoot prefers a valid env override, then its running checkout", () => {
  const previousFactoryRoot = process.env.FACTORY_ROOT;
  const previousHome = process.env.HOME;
  const tempRoot = mkdtempSync(path.join(tmpdir(), "factory-root-"));
  const envRoot = path.join(tempRoot, "env-root");
  const fakeHome = path.join(tempRoot, "home");
  const runningRoot = path.resolve(import.meta.dir, "..");

  try {
    checkoutAt(envRoot);
    checkoutAt(path.join(fakeHome, "Develop", "factory"));

    process.env.FACTORY_ROOT = envRoot;
    expect(factoryRoot()).toBe(envRoot);

    delete process.env.FACTORY_ROOT;
    process.env.HOME = fakeHome;
    expect(factoryRoot()).toBe(runningRoot);
  } finally {
    restoreEnv("FACTORY_ROOT", previousFactoryRoot);
    restoreEnv("HOME", previousHome);
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
