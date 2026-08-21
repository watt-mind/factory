/**
 * Clean-room OSS smoke (WM-952).
 *
 * This stays offline: it exercises the commands an adopter runs from a fresh
 * clone without reading the caller's home directory, credentials, or local
 * Factory configuration.
 */
import { afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FACTORY = path.join(ROOT, "bin", "factory");
const cleanRoots = [];

function cleanRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "factory-clean-room-"));
  cleanRoots.push(root);
  cpSync(path.join(ROOT, "config"), path.join(root, "config"), {
    recursive: true,
    filter: (src) =>
      !src.endsWith(".yaml") ||
      src.endsWith(".example.yaml") ||
      path.basename(src) === "nodes.yaml",
  });
  return root;
}

function run(args, root) {
  return Bun.spawnSync({
    cmd: ["bash", FACTORY, ...args],
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: path.join(root, "home-without-factory-state"),
      // A fresh install has neither an inherited checkout nor Linear token.
      FACTORY_ROOT: "",
      LINEAR_API_KEY: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

afterEach(() => {
  for (const root of cleanRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clean-room initialization scaffolds config and GitHub control-plane defaults", () => {
  const root = cleanRoot();

  const initial = run(["init", "--root", root], root);
  expect(initial.exitCode, initial.stderr.toString()).toBe(0);
  expect(initial.stdout.toString()).toContain("created config/repos.yaml");
  expect(existsSync(path.join(root, "config", "repos.yaml"))).toBe(true);
  expect(existsSync(path.join(root, "config", "policy.yaml"))).toBe(true);
  expect(existsSync(path.join(root, "config", "schedule.yaml"))).toBe(true);

  const github = run(
    [
      "init",
      "--control-plane",
      "github",
      "--root",
      root,
      "--repo",
      "acme/sample",
      "--team",
      "SAMPLE",
    ],
    root,
  );
  expect(github.exitCode, github.stderr.toString()).toBe(0);
  expect(github.stdout.toString()).toContain("controlPlane.kind=github");
  expect(github.stdout.toString()).toContain("gh auth login");

  const policy = Bun.YAML.parse(
    readFileSync(path.join(root, "config", "policy.yaml"), "utf8"),
  );
  expect(policy.controlPlane).toMatchObject({
    kind: "github",
    github: { repo: "acme/sample", teams: { SAMPLE: "acme/sample" } },
  });
});

test("clean-room documentation names supported tools and a GitHub-first path", () => {
  const setup = readFileSync(path.join(ROOT, "SETUP.md"), "utf8");
  const quickstart = readFileSync(
    path.join(ROOT, "docs", "quickstart.md"),
    "utf8",
  );
  const docs = `${setup}\n${quickstart}`;

  expect(docs).toContain("macOS");
  expect(docs).toContain("Linux");
  expect(docs).toContain("Bun >= 1.3");
  expect(docs).toContain("GitHub CLI");
  expect(docs).toContain("gh auth login");
  expect(docs).toContain("factory init --control-plane github");
  expect(docs).toContain("factory doctor");
  expect(docs).not.toMatch(/\/home\/[^/]+\/(?:Develop|\.factory)/);
  expect(docs).not.toContain("hdkiller");
});
