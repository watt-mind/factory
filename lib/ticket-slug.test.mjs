/**
 * ticketSlug must agree with bash, exactly (#884).
 *
 * bin/worktree-up.sh CREATES the worktree directory; event-runtime looks it
 * up. Two implementations of the same naming rule in two languages is a drift
 * risk, so this test does not restate the rule — it invokes the bash function
 * and compares. If either side changes, this fails.
 */
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isSluggableTicket, ticketSlug } from "./ticket-slug.mjs";

const COMMON = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "bin",
  "worktree-common.sh",
);
const bashSlug = (id) => {
  const r = Bun.spawnSync({
    cmd: [
      "bash",
      "-c",
      `source ${JSON.stringify(COMMON)}; ticket_slug ${JSON.stringify(id)}`,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  return r.stdout.toString().trim();
};

const CASES = [
  "OPS-123",
  "OPS-123-scratch",
  "watt-mind/factory#884",
  "#884",
  "gh-884",
];

describe("ticketSlug", () => {
  test("matches bin/worktree-common.sh byte for byte", () => {
    for (const id of CASES) {
      expect({ id, js: ticketSlug(id) }).toEqual({ id, js: bashSlug(id) });
    }
  });

  test("GitHub ids lose the path-hostile characters", () => {
    const s = ticketSlug("watt-mind/factory#884");
    expect(s).toBe("gh-884");
    expect(s).not.toContain("/");
    expect(s).not.toContain("#");
  });

  test("tracker-key ids are unchanged, so existing paths keep working", () => {
    // The cutover must not rename any Linear worktree or lease file.
    expect(ticketSlug("OPS-123")).toBe("OPS-123");
    expect(ticketSlug("OPS-123-scratch")).toBe("OPS-123-scratch");
  });

  test("is idempotent", () => {
    for (const id of CASES)
      expect(ticketSlug(ticketSlug(id))).toBe(ticketSlug(id));
  });

  test("the two GitHub forms agree", () => {
    expect(ticketSlug("watt-mind/factory#884")).toBe(ticketSlug("#884"));
  });

  test("rejects what it cannot name, rather than inventing a path", () => {
    for (const bad of ["", "not a ticket", "OPS-", "../escape"]) {
      expect(() => ticketSlug(bad)).toThrow();
      expect(isSluggableTicket(bad)).toBe(false);
    }
  });

  test("no site builds a lease or worktree path from a raw ticket id", () => {
    // The defect was a call shape; the next site added would reintroduce it.
    const root = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
    );
    const proc = Bun.spawnSync({
      cmd: [
        "git",
        "grep",
        "-nE",
        String.raw`path\.join\([^)]*, *ticket *\)|-\$\{ticket\}\.json`,
        "--",
        "lib",
        "event-runtime/lib",
        "orchestrator",
      ],
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const hits = (proc.stdout?.toString() || "")
      .split("\n")
      .filter(Boolean)
      .filter((l) => !l.split(":")[0].endsWith(".test.mjs"));
    expect(hits).toEqual([]);
  });
});
