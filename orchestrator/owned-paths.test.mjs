/**
 * bun test
 *
 * Collision detection is the one piece of the dispatcher that causes silent
 * data loss when wrong — two agents editing one file — so it gets real tests.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect } from "bun:test";

const expectEqual = (a, b, msg) => expect(a, msg).toEqual(b);
const expectTrue = (v, msg) => expect(v, msg).toBeTruthy();
import {
  hardPathConflicts,
  pathOverlaps,
  parseOwnedPaths,
  effectiveOwnedPaths,
  globsOverlap,
  pathsCollide,
  nextDispatchable,
  readPinManifestRequirements,
  ownedPathsClosureGaps,
} from "./owned-paths.mjs";

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

test("missing section yields no paths (caller decides what that means)", () => {
  expectEqual(parseOwnedPaths("## Problem\n\nno paths here"), []);
});

test("effectiveOwnedPaths turns unparseable into the maximal glob, not a skip", () => {
  expectEqual(effectiveOwnedPaths("## Problem\n\nno paths here"), ["**"]);
  expectEqual(effectiveOwnedPaths("## Owned Paths\n\n- `app/api.ts`"), ["app/api.ts"]);
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

test("nextDispatchable skips collisions but still picks up unparseable Owned Paths", () => {
  const inFlight = [{ id: "A", ownedPaths: ["app/services/**"] }];
  const candidates = [
    { id: "B", ownedPaths: ["app/services/api.ts"] }, // collides
    { id: "C", ownedPaths: [] },                       // unparseable, but nothing else queued ahead of it collides
    { id: "D", ownedPaths: ["docs/**"] },              // free
  ];
  // C is treated as owning everything, so it collides with A (in flight) too — D is next in queue order and free.
  expectEqual(nextDispatchable(candidates, inFlight)?.id, "D");
});

test("unparseable Owned Paths still dispatches when nothing is in flight", () => {
  const candidates = [{ id: "C", ownedPaths: [] }];
  expectEqual(nextDispatchable(candidates, [])?.id, "C");
});

test("two unparseable-Owned-Paths tickets serialize against each other", () => {
  const inFlight = [{ id: "A", ownedPaths: [] }];
  const candidates = [{ id: "B", ownedPaths: [] }];
  expectEqual(nextDispatchable(candidates, inFlight), undefined);
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

test("owned path closure flags missing required direct outputs", () => {
  const policy = {
    direct: [{ source: "shared/**", requires: ["dist/**", "plugins/core/**"] }],
  };
  expectEqual(ownedPathsClosureGaps({
    ownedPaths: ["shared/**"],
    ownedPathsPolicy: policy,
  }), [
    {
      rule: "direct",
      requiredPath: "dist/**",
      requiredBy: "shared/**",
    },
    {
      rule: "direct",
      requiredPath: "plugins/core/**",
      requiredBy: "shared/**",
    },
  ]);
});

test("owned path closure passes when required paths are also owned", () => {
  const policy = {
    direct: [{ source: "shared/**", requires: ["dist/**", "plugins/core/**"] }],
  };
  expectEqual(ownedPathsClosureGaps({
    ownedPaths: ["shared/**", "dist/**", "plugins/core/**"],
    ownedPathsPolicy: policy,
  }), []);
});

test("pin manifests require owning generated output manifests", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "owned-paths-closure-"));
  try {
    mkdirSync(path.join(repo, "event-runtime/agents"), { recursive: true });
    writeFileSync(
      path.join(repo, "event-runtime/agents/triage-scan.json"),
      `${JSON.stringify({ pins: { "event-runtime/schemas/triage-scan.output.json": "factory" } })}\n`,
    );
    const requirements = readPinManifestRequirements(repo, ["event-runtime/agents/*.json"]);
    expectEqual(requirements, [
      {
        manifestPath: "event-runtime/agents/triage-scan.json",
        pinnedPaths: ["event-runtime/schemas/triage-scan.output.json"],
      },
    ]);

    expectEqual(
      ownedPathsClosureGaps({
        ownedPaths: ["event-runtime/schemas/triage-scan.output.json"],
        ownedPathsPolicy: { direct: [], pinManifests: ["event-runtime/agents/*.json"] },
        pinManifestRequirements: requirements,
      }),
      [
        {
          rule: "pin-manifest",
          requiredPath: "event-runtime/agents/triage-scan.json",
          requiredBy: "event-runtime/schemas/triage-scan.output.json",
          manifestPath: "event-runtime/agents/triage-scan.json",
        },
      ],
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("supports level 3 numbered headers (### 2. Owned Paths) and colons", () => {
  const desc = `## 1. Problem & Context

Some background.

### 2. Owned Paths:

- \`orchestrator/owned-paths.mjs\`
- \`orchestrator/owned-paths.test.mjs\`

### 3. Verification Command

    bun test`;
  expectEqual(parseOwnedPaths(desc), [
    "orchestrator/owned-paths.mjs",
    "orchestrator/owned-paths.test.mjs",
  ]);
});

test("supports level 2 numbered header (## 2. Owned Paths)", () => {
  const desc = `## 2. Owned Paths

- \`orchestrator/owned-paths.mjs\``;
  expectEqual(parseOwnedPaths(desc), ["orchestrator/owned-paths.mjs"]);
});

test("supports colon in level 2 header (## Owned Paths:)", () => {
  const desc = `## Owned Paths:

- \`app/services/api.ts\`
- \`app/services/auth.ts\``;
  expectEqual(parseOwnedPaths(desc), [
    "app/services/api.ts",
    "app/services/auth.ts",
  ]);
});

test("supports level 4 numbered headers (#### 4. Owned Paths)", () => {
  const desc = `#### 4. Owned Paths

- \`event-runtime/cli.mjs\``;
  expectEqual(parseOwnedPaths(desc), ["event-runtime/cli.mjs"]);
});

// WM-677: advisory mode needs the overlap as pairs (to record it) and a narrow
// hard-conflict predicate (to still refuse). These pin the boundary between
// "textual overlap a rebase resolves" and "the same file, or everything".
test("pathOverlaps returns every overlapping pair, in order", () => {
  expectEqual(
    pathOverlaps(["src/api/**", "docs/a.md"], ["src/api/routes.ts", "docs/a.md", "lib/x.mjs"]),
    [
      { a: "src/api/**", b: "src/api/routes.ts" },
      { a: "docs/a.md", b: "docs/a.md" },
    ],
  );
  expectEqual(pathOverlaps(["a.md"], ["b.md"]), []);
});

test("hardPathConflicts: ** on either side — nothing else", () => {
  // Containment, shared-prefix, same-glob, and even the SAME concrete file are
  // NOT hard: same file is not same lines, and a rebase resolves it.
  expectEqual(hardPathConflicts(["src/api/**"], ["src/api/routes.ts"]), []);
  expectEqual(hardPathConflicts(["src/**/*.test.mjs"], ["src/lib/registry.test.mjs"]), []);
  expectEqual(hardPathConflicts(["views/*.tsx"], ["views/*.tsx"]), []);
  expectEqual(hardPathConflicts(["docs/a.md"], ["docs/a.md"]), []);
  // `**` on either side is hard against anything it reaches.
  expectTrue(hardPathConflicts(["**"], ["docs/a.md"]).length === 1);
  expectTrue(hardPathConflicts(["docs/a.md"], ["**"]).length === 1);
});
