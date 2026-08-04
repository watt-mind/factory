/**
 * bun test
 *
 * Collision detection is the one piece of the dispatcher that causes silent
 * data loss when wrong — two agents editing one file — so it gets real tests.
 */
import { test, expect } from "bun:test";

const expectEqual = (a, b, msg) => expect(a, msg).toEqual(b);
const expectTrue = (v, msg) => expect(v, msg).toBeTruthy();
import { parseOwnedPaths, globsOverlap, pathsCollide, nextDispatchable } from "./owned-paths.mjs";

test("parses the Owned Paths section of a real ticket", () => {
  const desc = `## Problem & Context

Something is broken.

## Owned Paths

- \`app/services/api.ts\`
- \`app/services/__tests__/*\`

## Verification Command

    npm test`;
  expectEqual(parseOwnedPaths(desc), ["app/services/api.ts", "app/services/__tests__/*"]);
});

test("missing section yields no paths (caller treats as not-dispatchable)", () => {
  expectEqual(parseOwnedPaths("## Problem\n\nno paths here"), []);
});

test("identical and nested globs overlap", () => {
  expectTrue(globsOverlap("app/api.ts", "app/api.ts"));
  expectTrue(globsOverlap("app/**", "app/services/api.ts"));
  expectTrue(globsOverlap("bin/worktree-*.sh", "bin/worktree-up.sh"));
  expectTrue(globsOverlap("AGENTS.md", "AGENTS.md"));
});

test("disjoint directories do not overlap", () => {
  expectTrue(!globsOverlap("app/services/**", "docs/**"));
  expectTrue(!globsOverlap("bin/worktree-*.sh", "AGENTS.md"));
  expectTrue(!globsOverlap(".github/workflows/*", "app/src/main.ts"));
});

test("extensionless concrete files (Dockerfile, Makefile) match themselves", () => {
  expectTrue(globsOverlap("Dockerfile", "Dockerfile"));
  expectTrue(globsOverlap("Dockerfile", "./Dockerfile"));
  expectTrue(globsOverlap("./Dockerfile", "Dockerfile"));
  expectTrue(globsOverlap("Makefile", "Makefile"));
  // still owns everything beneath it, same as before
  expectTrue(globsOverlap("app/services", "app/services/api.ts"));
  // but a sibling file sharing the prefix is a different filesystem entity
  expectTrue(!globsOverlap("app/src/auth", "app/src/auth.ts"));
});

test("the case keyword matching gets wrong", () => {
  // Same vocabulary, unrelated files: must NOT collide.
  expectTrue(!pathsCollide(["app/ui/LoginButton.tsx"], ["server/auth/middleware.ts"]));
  // Different vocabulary, same files: MUST collide.
  expectTrue(pathsCollide(["app/pages/onboarding/**"], ["app/pages/onboarding/step2.tsx"]));
});

test("CW-363 and CLNT-609 are concurrent-safe (different repos, same globs)", () => {
  // Both own bin/worktree-*.sh and AGENTS.md, but in different repos. The
  // dispatcher scopes collision checks per repo; within one repo they'd block.
  const a = ["bin/worktree-*.sh", "AGENTS.md"];
  const b = ["bin/worktree-*.sh", "AGENTS.md"];
  expectTrue(pathsCollide(a, b), "same repo: must serialize");
});

test("nextDispatchable skips collisions and tickets without Owned Paths", () => {
  const inFlight = [{ id: "A", ownedPaths: ["app/services/**"] }];
  const candidates = [
    { id: "B", ownedPaths: ["app/services/api.ts"] }, // collides
    { id: "C", ownedPaths: [] },                       // not agent-ready
    { id: "D", ownedPaths: ["docs/**"] },              // free
  ];
  expectEqual(nextDispatchable(candidates, inFlight)?.id, "D");
});

test("nothing dispatchable returns undefined rather than throwing", () => {
  expectEqual(nextDispatchable([], []), undefined);
});

test("accepts fenced code blocks, not just bullets (real CLNT-616 shape)", () => {
  const desc = `## Source File Pointers

Read-only reference.

## Owned Paths

\`\`\`
app/src/landing-page/components/Hero.tsx
\`\`\`

Plus, only if you add the recommended coverage below:

\`\`\`
app/src/landing-page/components/Hero.test.tsx
\`\`\`

## Verification Command

    npm test`;
  expectEqual(parseOwnedPaths(desc), [
    "app/src/landing-page/components/Hero.tsx",
    "app/src/landing-page/components/Hero.test.tsx",
  ]);
});

test("prose inside the section is not mistaken for a path", () => {
  const desc = `## Owned Paths

Only touch these:

- \`app/api.ts\`

Everything else is off limits.`;
  expectEqual(parseOwnedPaths(desc), ["app/api.ts"]);
});

test("indented code blocks work too", () => {
  const desc = "## Owned Paths\n\n    src/main.ts\n    src/**/*.test.ts\n\n## Next";
  expectEqual(parseOwnedPaths(desc), ["src/main.ts", "src/**/*.test.ts"]);
});

test("a trailing change-kind annotation doesn't sink the path (CLNT-765/768/764 shape)", () => {
  const desc = "## Owned Paths\n\n* `src/analytics/kpis/avgBasePriceByProduct.ts` (new)\n* `src/analytics/kpis/existing.ts` (modified)\n";
  expectEqual(parseOwnedPaths(desc), [
    "src/analytics/kpis/avgBasePriceByProduct.ts",
    "src/analytics/kpis/existing.ts",
  ]);
});
