/**
 * bun test
 *
 * spliceFloor writes into OTHER repos' AGENTS.md — files this repo does not own
 * and that carry a human's own content. Getting it wrong either destroys that
 * content or silently fails to deliver the floor, and the second failure mode is
 * the one that already happened: for a day the floor reached none of the four
 * configured repos while `--check` reported green.
 */
import { test, expect } from "bun:test";
import { spliceFloor } from "./floor.mjs";

const FLOOR = "<!-- FACTORY:FLOOR:BEGIN -->\n## Agent operating floor\n\nrule one.\n<!-- FACTORY:FLOOR:END -->";
const FLOOR_V2 = "<!-- FACTORY:FLOOR:BEGIN -->\n## Agent operating floor\n\nrule one.\nrule two.\n<!-- FACTORY:FLOOR:END -->";

test("appends the floor to a repo that has none, keeping the repo's own content", () => {
  const out = spliceFloor("# bj29\n\nRun `npm test` before pushing.\n", FLOOR);
  expect(out).toContain("Run `npm test` before pushing.");
  expect(out).toContain("## Agent operating floor");
  // The repo's own orientation must stay at the top; the floor is boilerplate.
  expect(out.indexOf("bj29")).toBeLessThan(out.indexOf("Agent operating floor"));
});

test("creates a usable file when AGENTS.md is empty or absent", () => {
  expect(spliceFloor("", FLOOR).trim()).toBe(FLOOR);
  expect(spliceFloor(null, FLOOR).trim()).toBe(FLOOR);
});

test("is idempotent — syncing twice changes nothing", () => {
  const once = spliceFloor("# repo\n\nlocal notes.\n", FLOOR);
  expect(spliceFloor(once, FLOOR)).toBe(once);
});

test("replaces a stale floor in place rather than appending a second copy", () => {
  const stale = spliceFloor("# repo\n\nlocal notes.\n", FLOOR);
  const fresh = spliceFloor(stale, FLOOR_V2);
  expect(fresh).toContain("rule two.");
  expect(fresh.match(/FACTORY:FLOOR:BEGIN/g)).toHaveLength(1);
  expect(fresh).toContain("local notes.");
});

test("preserves repo content written AFTER the floor block", () => {
  const body = `# repo\n\nintro.\n\n${FLOOR}\n\n## Repo-specific\n\nNEVER run prisma db push.\n`;
  const out = spliceFloor(body, FLOOR_V2);
  expect(out).toContain("NEVER run prisma db push.");
  expect(out).toContain("intro.");
  expect(out).toContain("rule two.");
});

test("a truncated marker pair is treated as absent rather than corrupting the file", () => {
  // A half-written file (BEGIN but no END) must not swallow the rest of the doc.
  const body = "# repo\n\n<!-- FACTORY:FLOOR:BEGIN -->\n\n## Repo-specific\n\nkeep me.\n";
  const out = spliceFloor(body, FLOOR);
  expect(out).toContain("keep me.");
});
