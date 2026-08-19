import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUNDLED_REPO,
  HARNESSES,
  loadStarterTicket,
  parseArgs,
  runDemo,
  STARTER_TICKET,
} from "./run.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FACTORY = path.join(ROOT, "bin", "factory");

function cli(args) {
  return spawnSync("bash", [FACTORY, "demo", ...args], {
    encoding: "utf8",
    cwd: ROOT,
    env: { ...process.env, FACTORY_ROOT: ROOT },
  });
}

describe("parseArgs", () => {
  test("defaults to fake harness, not dry", () => {
    expect(parseArgs([])).toEqual({ dry: false, harness: "fake", help: false });
  });

  test("accepts --dry and --harness", () => {
    expect(parseArgs(["--dry", "--harness", "claude"])).toEqual({
      dry: true,
      harness: "claude",
      help: false,
    });
  });

  test("rejects an unknown harness", () => {
    expect(() => parseArgs(["--harness", "nope"])).toThrow(/unknown harness/);
  });

  test("rejects an unknown flag", () => {
    expect(() => parseArgs(["--wat"])).toThrow(/unknown option/);
  });
});

describe("starter ticket", () => {
  test("parses Owned Paths and Verification Command", () => {
    const ticket = loadStarterTicket();
    expect(ticket.identifier).toBe(STARTER_TICKET);
    expect(ticket.ownedPaths).toContain("src/greet.mjs");
    expect(ticket.ownedPaths).toContain("src/greet.test.mjs");
    expect(ticket.verification).toBe("bun test src/greet.test.mjs");
    expect(ticket.title.length).toBeGreaterThan(0);
  });

  test("bundled repo ships worktree scripts", () => {
    expect(BUNDLED_REPO.endsWith(`${path.sep}demo${path.sep}repo`)).toBe(true);
  });
});

describe("bin/factory demo --dry", () => {
  test("prints the plan and exits 0", () => {
    const result = cli(["--dry"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(STARTER_TICKET);
    expect(result.stdout).toContain("memory");
    expect(result.stdout).toContain("bun test src/greet.test.mjs");
    expect(result.stdout).toContain("dry-run ok");
  });

  test("records --harness on the plan", () => {
    const result = cli(["--dry", "--harness", "codex"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("harness:    codex");
  });

  test("--help lists every known harness", () => {
    const result = cli(["--help"]);
    expect(result.status, result.stderr).toBe(0);
    for (const name of HARNESSES) expect(result.stdout).toContain(name);
  });

  test("unknown harness exits 2", () => {
    const result = cli(["--harness", "nope"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown harness");
  });
});

describe("runDemo end-to-end", () => {
  test("claims, implements, verifies, and merges on the memory forge", async () => {
    const result = await runDemo({ harness: "fake" });
    expect(result.dry).toBe(false);
    expect(result.pr.state).toBe("MERGED");
    expect(result.pr.number).toBe(1);
    expect(result.ticketState).toBe("Done");
    expect(result.files).toContain("src/greet.mjs");
    expect(result.verification.passed).toBe(true);
    expect(result.plane.kind).toBe("memory");
    expect(result.forge.kind).toBe("memory");
    const claims = result.plane.calls.filter((c) => c.op === "claim");
    expect(claims).toHaveLength(1);
    const comments = await result.plane.listComments(STARTER_TICKET);
    expect(comments.some((c) => c.body.includes("## Handoff"))).toBe(true);
  }, 30_000);
});
