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
  parseVerificationCommand,
  effectiveOwnedPaths,
  globToRegExp,
  globsOverlap,
  isMatchEverythingGlob,
  OwnedPathsPatternError,
  OwnedPathsPolicyError,
  pathsCollide,
  nextDispatchable,
  readPinManifestRequirements,
  ownedPathsClosureGaps,
  formatOwnedPathClosureGaps,
  REGISTRY_INPUT_GLOBS,
  REGISTRY_DIGEST_BASELINE_PATH,
} from "./owned-paths.mjs";

test("parses the Owned Paths section of a real ticket", () => {
  const desc = `## Problem & Context

Something is broken.

## Owned Paths

- \`app/services/api.ts\`
- \`app/services/__tests__/*\`

## Verification Command

    npm test`;
  expectEqual(parseOwnedPaths(desc), [
    "app/services/api.ts",
    "app/services/__tests__/*",
  ]);
});

test("ignores intro prose that mentions Owned Paths before its heading", () => {
  const desc = `The Owned Paths section below identifies the safe files to change.

## Problem & Context

Something is broken.

## Owned Paths

- \`orchestrator/owned-paths.mjs\`
- \`orchestrator/owned-paths.test.mjs\`

## Verification Command

    bun test`;
  expectEqual(parseOwnedPaths(desc), [
    "orchestrator/owned-paths.mjs",
    "orchestrator/owned-paths.test.mjs",
  ]);
});

test("missing section yields no paths (caller decides what that means)", () => {
  expectEqual(parseOwnedPaths("## Problem\n\nno paths here"), []);
});

test("effectiveOwnedPaths turns unparseable into the maximal glob, not a skip", () => {
  expectEqual(effectiveOwnedPaths("## Problem\n\nno paths here"), ["**"]);
  expectEqual(effectiveOwnedPaths("## Owned Paths\n\n- `app/api.ts`"), [
    "app/api.ts",
  ]);
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

test("brace alternation compiles wildcard and nested branches (WM-951)", () => {
  // Before WM-951, the first matcher threw `Nothing to repeat`: its `*.png`
  // branch was escaped as a regex literal except for the leading `*`.
  const assetMatcher = globToRegExp("assets/{*.png,*.jpg}");
  expectTrue(assetMatcher.test("assets/x.png"));
  expectTrue(assetMatcher.test("assets/x.jpg"));
  expectTrue(!assetMatcher.test("assets/x.gif"));
  expectTrue(globsOverlap("assets/{*.png,*.jpg}", "assets/x.png"));
  expectTrue(!globsOverlap("assets/{*.png,*.jpg}", "assets/x.gif"));

  const nestedMatcher = globToRegExp("src/{a*,b{c,d}}.ts");
  expectTrue(nestedMatcher.test("src/anything.ts"));
  expectTrue(nestedMatcher.test("src/bc.ts"));
  expectTrue(nestedMatcher.test("src/bd.ts"));
  expectTrue(!nestedMatcher.test("src/be.ts"));
});

test("malformed brace globs are typed and fail closed for collision checks", () => {
  expect(() => globToRegExp("assets/{*.png")).toThrow(OwnedPathsPatternError);
  expectTrue(
    globsOverlap("assets/{*.png", "docs/unrelated.md"),
    "an invalid Owned Paths entry must serialize instead of terminating dispatch",
  );
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
  expectTrue(
    !pathsCollide(["app/ui/LoginButton.tsx"], ["server/auth/middleware.ts"]),
  );
  // Different vocabulary, same files: MUST collide.
  expectTrue(
    pathsCollide(
      ["app/pages/onboarding/**"],
      ["app/pages/onboarding/step2.tsx"],
    ),
  );
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
    { id: "C", ownedPaths: [] }, // unparseable, but nothing else queued ahead of it collides
    { id: "D", ownedPaths: ["docs/**"] }, // free
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
  const desc =
    "## Owned Paths\n\n    src/main.ts\n    src/**/*.test.ts\n\n## Next";
  expectEqual(parseOwnedPaths(desc), ["src/main.ts", "src/**/*.test.ts"]);
});

test("a trailing change-kind annotation doesn't sink the path (CLNT-765/768/764 shape)", () => {
  const desc =
    "## Owned Paths\n\n* `src/analytics/kpis/avgBasePriceByProduct.ts` (new)\n* `src/analytics/kpis/existing.ts` (modified)\n";
  expectEqual(parseOwnedPaths(desc), [
    "src/analytics/kpis/avgBasePriceByProduct.ts",
    "src/analytics/kpis/existing.ts",
  ]);
});

test("owned path closure flags missing required direct outputs", () => {
  const policy = {
    direct: [{ source: "shared/**", requires: ["dist/**", "plugins/core/**"] }],
  };
  expectEqual(
    ownedPathsClosureGaps({
      ownedPaths: ["shared/**"],
      ownedPathsPolicy: policy,
    }),
    [
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
    ],
  );
});

test("owned path closure passes when required paths are also owned", () => {
  const policy = {
    direct: [{ source: "shared/**", requires: ["dist/**", "plugins/core/**"] }],
  };
  expectEqual(
    ownedPathsClosureGaps({
      ownedPaths: ["shared/**", "dist/**", "plugins/core/**"],
      ownedPathsPolicy: policy,
    }),
    [],
  );
});

const registryDigestPolicy = {
  registryDigest: {
    inputs: REGISTRY_INPUT_GLOBS,
    baseline: REGISTRY_DIGEST_BASELINE_PATH,
  },
};

test("registry inputs require owning the zero-pack digest baseline when configured", () => {
  const ownedPaths = [
    "event-runtime/agents/triage-scan.md",
    "event-runtime/agents/triage-scan.json",
  ];
  const expectedGap = {
    rule: "registry-digest",
    requiredPath: REGISTRY_DIGEST_BASELINE_PATH,
    requiredBy: "event-runtime/agents/triage-scan.md",
  };

  expectEqual(
    ownedPathsClosureGaps({
      ownedPaths,
      ownedPathsPolicy: registryDigestPolicy,
    }),
    [expectedGap],
  );
  expectEqual(
    ownedPathsClosureGaps({
      ownedPaths: [...ownedPaths, REGISTRY_DIGEST_BASELINE_PATH],
      ownedPathsPolicy: registryDigestPolicy,
    }),
    [],
  );
  expectEqual(formatOwnedPathClosureGaps([expectedGap]), [
    "own event-runtime/lib/registry.test.mjs: registry input event-runtime/agents/triage-scan.md changes the zero-pack digest baseline",
  ]);
});

test("a present malformed registry digest policy fails closed", () => {
  const malformedPolicies = [
    { registryDigest: { inputs: ["event-runtime/agents/**"] } },
    {
      registryDigest: {
        inputs: "event-runtime/agents/**",
        baseline: REGISTRY_DIGEST_BASELINE_PATH,
      },
    },
    {
      registryDigest: {
        inputs: [],
        baseline: REGISTRY_DIGEST_BASELINE_PATH,
      },
    },
  ];

  for (const ownedPathsPolicy of malformedPolicies) {
    try {
      ownedPathsClosureGaps({ ownedPaths: [], ownedPathsPolicy });
      throw new Error("expected malformed registry digest policy to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(OwnedPathsPolicyError);
      expect(error.code).toBe("invalid_owned_paths_policy");
    }
  }

  expectEqual(
    ownedPathsClosureGaps({ ownedPaths: [], ownedPathsPolicy: {} }),
    [],
  );
  expectEqual(
    ownedPathsClosureGaps({
      ownedPaths: [],
      ownedPathsPolicy: { registryDigest: null },
    }),
    [],
  );
});

test("each registry data input requires the digest baseline, but unrelated paths do not", () => {
  for (const input of [
    "event-runtime/event-types.json",
    "event-runtime/edges.json",
    "event-runtime/schedules.json",
  ]) {
    expectEqual(
      ownedPathsClosureGaps({
        ownedPaths: [input],
        ownedPathsPolicy: registryDigestPolicy,
      }),
      [
        {
          rule: "registry-digest",
          requiredPath: REGISTRY_DIGEST_BASELINE_PATH,
          requiredBy: input,
        },
      ],
    );
  }

  expectEqual(
    ownedPathsClosureGaps({
      ownedPaths: ["event-runtime/lib/planner.mjs"],
      ownedPathsPolicy: registryDigestPolicy,
    }),
    [],
  );
});

test("a broad glob that owns the baseline satisfies registry digest closure", () => {
  expectEqual(
    ownedPathsClosureGaps({
      ownedPaths: ["event-runtime/**"],
      ownedPathsPolicy: registryDigestPolicy,
    }),
    [],
  );
});

test("registry digest closure is opt-in and ignores unanchored wildcards", () => {
  expectEqual(
    ownedPathsClosureGaps({
      ownedPaths: ["event-runtime/agents/foo.md"],
    }),
    [],
  );

  for (const ownedPath of ["*.json", "**/*.json"]) {
    expectEqual(
      ownedPathsClosureGaps({
        ownedPaths: [ownedPath],
        ownedPathsPolicy: registryDigestPolicy,
      }),
      [],
    );
  }

  expectEqual(
    ownedPathsClosureGaps({
      ownedPaths: ["event-runtime/**/*.json"],
      ownedPathsPolicy: registryDigestPolicy,
    }),
    [
      {
        rule: "registry-digest",
        requiredPath: REGISTRY_DIGEST_BASELINE_PATH,
        requiredBy: "event-runtime/**/*.json",
      },
    ],
  );
});

test("registry input overlap respects path segments and root-level inputs", () => {
  const policy = {
    registryDigest: {
      inputs: [
        "event-runtime/agents/*.md",
        "lib/foobar/*.json",
        "pins.json",
        "event-types.json",
      ],
      baseline: REGISTRY_DIGEST_BASELINE_PATH,
    },
  };
  const gap = (owned) =>
    ownedPathsClosureGaps({ ownedPaths: [owned], ownedPathsPolicy: policy });

  for (const owned of [
    "**/agents/*.md",
    "pins.json",
    "*.json",
    "**/pins.json",
  ]) {
    expectEqual(gap(owned), [
      {
        rule: "registry-digest",
        requiredPath: REGISTRY_DIGEST_BASELINE_PATH,
        requiredBy: owned,
      },
    ]);
  }
  expectEqual(gap("**/subagents/*.md"), []);
  expectEqual(gap("**/lib/foo*"), []);
  expectEqual(gap("**/*.json"), []);
  expectEqual(gap("event-runtime/**"), []);
});

test("pin manifests require owning generated output manifests", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "owned-paths-closure-"));
  try {
    mkdirSync(path.join(repo, "event-runtime/agents"), { recursive: true });
    writeFileSync(
      path.join(repo, "event-runtime/agents/triage-scan.json"),
      `${JSON.stringify({ pins: { "event-runtime/schemas/triage-scan.output.json": "factory" } })}\n`,
    );
    const requirements = readPinManifestRequirements(repo, [
      "event-runtime/agents/*.json",
    ]);
    expectEqual(requirements, [
      {
        manifestPath: "event-runtime/agents/triage-scan.json",
        pinnedPaths: ["event-runtime/schemas/triage-scan.output.json"],
      },
    ]);

    expectEqual(
      ownedPathsClosureGaps({
        ownedPaths: ["event-runtime/schemas/triage-scan.output.json"],
        ownedPathsPolicy: {
          direct: [],
          pinManifests: ["event-runtime/agents/*.json"],
        },
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

// WM-1002: the shipped manifests pin pack-root-relative keys (`agents/*.md`),
// but Owned Paths and the manifest path are repo-root-relative. Without
// normalization the closure guard compared mismatched namespaces and never
// flagged the missing JSON manifest, so a ticket could edit a pinned prompt
// while lacking ownership of the manifest needed to re-pin it.
test("pin-manifest gap: shipped layout (agents/*.md keys) flags the missing JSON manifest", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "owned-paths-closure-"));
  try {
    mkdirSync(path.join(repo, "event-runtime/agents"), { recursive: true });
    writeFileSync(
      path.join(repo, "event-runtime/agents/triage-scan.json"),
      `${JSON.stringify({
        pins: {
          "agents/triage-scan.md": "sha256:aaa",
          "schemas/triage-scan.input.json": "sha256:bbb",
        },
      })}\n`,
    );
    const requirements = readPinManifestRequirements(repo, [
      "event-runtime/agents/*.json",
    ]);
    // Pin keys are normalized to repo-root-relative before comparison.
    expectEqual(requirements, [
      {
        manifestPath: "event-runtime/agents/triage-scan.json",
        pinnedPaths: [
          "event-runtime/agents/triage-scan.md",
          "event-runtime/schemas/triage-scan.input.json",
        ],
      },
    ]);

    // Owning the prompt but not its JSON manifest is a pin-manifest gap.
    expectEqual(
      ownedPathsClosureGaps({
        ownedPaths: [
          "event-runtime/agents/triage-scan.md",
          REGISTRY_DIGEST_BASELINE_PATH,
        ],
        ownedPathsPolicy: {
          direct: [],
          pinManifests: ["event-runtime/agents/*.json"],
        },
        pinManifestRequirements: requirements,
      }),
      [
        {
          rule: "pin-manifest",
          requiredPath: "event-runtime/agents/triage-scan.json",
          requiredBy: "event-runtime/agents/triage-scan.md",
          manifestPath: "event-runtime/agents/triage-scan.json",
        },
      ],
    );

    // Owning both the prompt and its manifest satisfies closure.
    expectEqual(
      ownedPathsClosureGaps({
        ownedPaths: [
          "event-runtime/agents/triage-scan.md",
          "event-runtime/agents/triage-scan.json",
          REGISTRY_DIGEST_BASELINE_PATH,
        ],
        ownedPathsPolicy: {
          direct: [],
          pinManifests: ["event-runtime/agents/*.json"],
        },
        pinManifestRequirements: requirements,
      }),
      [],
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("pin-manifest normalization: already-root-relative keys are not double-prefixed", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "owned-paths-closure-"));
  try {
    mkdirSync(path.join(repo, "event-runtime/agents"), { recursive: true });
    writeFileSync(
      path.join(repo, "event-runtime/agents/triage-scan.json"),
      `${JSON.stringify({
        pins: { "event-runtime/schemas/triage-scan.output.json": "sha256:ccc" },
      })}\n`,
    );
    expectEqual(
      readPinManifestRequirements(repo, ["event-runtime/agents/*.json"]),
      [
        {
          manifestPath: "event-runtime/agents/triage-scan.json",
          pinnedPaths: ["event-runtime/schemas/triage-scan.output.json"],
        },
      ],
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("pin-manifest normalization: an escaping pin path fails closed", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "owned-paths-closure-"));
  try {
    mkdirSync(path.join(repo, "event-runtime/agents"), { recursive: true });
    writeFileSync(
      path.join(repo, "event-runtime/agents/triage-scan.json"),
      `${JSON.stringify({ pins: { "../../etc/passwd": "sha256:ddd" } })}\n`,
    );
    expect(() =>
      readPinManifestRequirements(repo, ["event-runtime/agents/*.json"]),
    ).toThrow(/outside the repository/);
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
    pathOverlaps(
      ["src/api/**", "docs/a.md"],
      ["src/api/routes.ts", "docs/a.md", "lib/x.mjs"],
    ),
    [
      { a: "src/api/**", b: "src/api/routes.ts" },
      { a: "docs/a.md", b: "docs/a.md" },
    ],
  );
  expectEqual(pathOverlaps(["a.md"], ["b.md"]), []);
});

test("match-everything globs recognize the fail-closed sentinel", () => {
  for (const glob of ["**", "**/*", "**/**", "**/**/*", "./**/**/"]) {
    expectTrue(isMatchEverythingGlob(glob), `${glob} matches every path`);
  }
  for (const glob of ["*", "*/**", "src/**", "**/*/*"]) {
    expectTrue(!isMatchEverythingGlob(glob), `${glob} is not whole-repo`);
  }
});

test("hardPathConflicts: whole-repo claim on either side — nothing else", () => {
  // Containment, shared-prefix, same-glob, and even the SAME concrete file are
  // NOT hard: same file is not same lines, and a rebase resolves it.
  expectEqual(hardPathConflicts(["src/api/**"], ["src/api/routes.ts"]), []);
  expectEqual(
    hardPathConflicts(["src/**/*.test.mjs"], ["src/lib/registry.test.mjs"]),
    [],
  );
  expectEqual(hardPathConflicts(["views/*.tsx"], ["views/*.tsx"]), []);
  expectEqual(hardPathConflicts(["docs/a.md"], ["docs/a.md"]), []);
  // Every spelling equivalent to `**` is hard against anything it reaches.
  for (const glob of ["**", "**/*", "**/**", "**/**/*"]) {
    expectTrue(hardPathConflicts([glob], ["docs/a.md"]).length === 1);
    expectTrue(hardPathConflicts(["docs/a.md"], [glob]).length === 1);
  }
});

// WM-718: the worker runs the ticket's own Verification Command at handoff, so
// it has to read the same section every agent has been reading by eye.
test("parseVerificationCommand: fenced block under '## Verification Command'", () => {
  expectEqual(
    parseVerificationCommand(
      "## Owned Paths\n- src/**\n\n## Verification Command\n\n```\ncd event-runtime/web && bun run build && bun test\n```\n\nPriority: High\n",
    ),
    "cd event-runtime/web && bun run build && bun test",
  );
});

test("parseVerificationCommand: '## Verification' heading, backticked single line, prose after it ignored", () => {
  expectEqual(
    parseVerificationCommand(
      "## Verification\n\n`bun test orchestrator/repos-config.test.mjs`\nAlso confirm bun 1.3.14 accepts `bun test event-runtime/lib`.\n",
    ),
    "bun test orchestrator/repos-config.test.mjs",
  );
});

test("parseVerificationCommand: multi-line fenced block joins with && and drops comments/continuations", () => {
  expectEqual(
    parseVerificationCommand(
      "### Verification Command\n```bash\n# unit slice first\n$ bun test event-runtime/lib \\\n    --timeout 20000\nbun build/emit.mjs --check\n```\n",
    ),
    "bun test event-runtime/lib --timeout 20000 && bun build/emit.mjs --check",
  );
});

test("parseVerificationCommand: bare command line accepted, prose and missing section rejected", () => {
  expectEqual(
    parseVerificationCommand("## Verification Command\nbun test\n"),
    "bun test",
  );
  expectEqual(
    parseVerificationCommand(
      "## Verification Command\nRun the usual suite and eyeball the output.\n",
    ),
    null,
  );
  expectEqual(parseVerificationCommand("## Owned Paths\n- a.mjs\n"), null);
  expectEqual(parseVerificationCommand("## Verification\n\n```\n```\n"), null);
  // "Verification Evidence"-style headings are not the command section.
  expectEqual(
    parseVerificationCommand("## Verification evidence\n`bun test`\n"),
    null,
  );
});
