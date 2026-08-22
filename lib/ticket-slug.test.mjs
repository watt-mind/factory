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
import { readdirSync, readFileSync } from "node:fs";
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

/**
 * A ticket id reaching a path or filename un-slugged. Covers both shapes that
 * have bitten: `path.join(..., <id>)` and a template literal ending in a file
 * extension. Deliberately ignores `<id>` in log lines and map keys — an
 * invariant that flags correct code gets disabled.
 */
const RAW_TICKET_PATH =
  /path\.join\(.*,\s*(ticket|ticketIdentifier|[A-Za-z_$][\w$]*\.identifier)\s*\)|`[^`]*\$\{(ticket|ticketIdentifier|[A-Za-z_$][\w$]*\.identifier)\}[^`]*\.[a-z]+`/;

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

  test("no site builds a path or filename from a raw ticket id", () => {
    // Scans in JS with the SAME pattern the guards below pin, rather than a
    // second regex passed to `git grep -E`. Two patterns is how the first
    // version drifted; POSIX ERE also lacks \\w and \\b, which is how the
    // `gql` invariant in tools/ticket.test.mjs stayed vacuous for months.
    const root = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
    );
    const dirs = ["lib", "orchestrator", "event-runtime/lib"];
    const hits = [];
    for (const dir of dirs) {
      const walk = (d) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, e.name);
          if (e.isDirectory()) {
            if (e.name !== "node_modules") walk(full);
            continue;
          }
          if (!e.name.endsWith(".mjs") || e.name.endsWith(".test.mjs"))
            continue;
          readFileSync(full, "utf8")
            .split("\n")
            .forEach((line, i) => {
              if (line.trim().startsWith("*") || line.trim().startsWith("//"))
                return;
              if (RAW_TICKET_PATH.test(line))
                hits.push(
                  `${path.relative(root, full)}:${i + 1}: ${line.trim()}`,
                );
            });
        }
      };
      walk(path.join(root, dir));
    }
    expect(hits).toEqual([]);
  });

  test("the pattern flags EVERY site that has historically regressed", () => {
    // A single probe string is what let this recur five times: each new site
    // used a spelling the previous pattern did not cover. Pin all of them.
    const HISTORICAL = [
      // #887 — worktree path, tick.mjs
      "const wt = path.join(expand(repo.worktree_root), t.identifier);",
      // #884 — worker lease file
      "return path.join(dir, `${repo}-${ticket}.json`);",
      // #884 — workspace worktree path
      "const worktreePath = path.join(repo.worktreeRoot, ticket);",
      // #891 — wip patch in tmpdir
      "const patchPath = path.join(tmpdir(), `${ticketIdentifier}-wip.patch`);",
      // #891 — transcript log, a template literal no path pattern matched
      "`${repo.name}-${t.identifier}-${stamp}.jsonl`",
    ];
    for (const line of HISTORICAL) {
      expect({ line, flagged: RAW_TICKET_PATH.test(line) }).toEqual({
        line,
        flagged: true,
      });
    }
  });

  test("the pattern does not flag correct, slugged construction", () => {
    // An invariant that flags the fix as well as the bug gets disabled.
    for (const line of [
      "const wt = path.join(root, ticketSlug(t.identifier));",
      'ticketFileName(t.identifier, { prefix: repo.name, ext: "jsonl" })',
      "console.log(`${t.identifier} worktree ready`);",
      "const key = `${t.identifier}:blocked`;",
    ]) {
      expect({ line, flagged: RAW_TICKET_PATH.test(line) }).toEqual({
        line,
        flagged: false,
      });
    }
  });
});
