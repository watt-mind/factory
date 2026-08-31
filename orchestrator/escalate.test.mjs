import { test, expect, afterAll } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  EXIT,
  checkoutFreshness,
  freshnessWarnings,
  matchEscalations,
  resolveChangedFiles,
  resolveEscalateGlobs,
} from "./escalate.mjs";
import { loadConfigYaml } from "../lib/schedule.mjs";

const globs = ["app/src/payment/**", "app/src/auth/**", "app/migrations/**"];

// Product-repo escalate_paths configs used to live inline in the tracked
// config/repos.yaml, so these tests read them straight off the real operator
// config. WM-794 moved that operator-owned config to an ignored local file
// (config/repos.yaml is no longer tracked; only the generic config/
// repos.example.yaml is), so these are now standalone fixtures — shaped like
// a Next.js SaaS app, a mobile app, a Vue app, and a Django app's boundaries —
// rather than a read of whichever product repos this checkout happens to
// have configured.
const nodeSaasGlobs = [
  "schema.prisma",
  "migrations/**",
  "src/auth/**",
  "src/admin/**",
  "*.wasp",
  "Dockerfile*",
  "docker-compose.yml",
  "nginx.conf",
  ".github/workflows/deploy.yml",
];
const mobileAppGlobs = [
  "src/features/subscriptions/**",
  "src/auth/**",
  "credentials/**",
  "eas.json",
  ".env.example",
  ".github/workflows/build.yml",
];
const vueSaasGlobs = [
  "server/api/stripe/**",
  "server/api/subscriptions/**",
  "server/api/auth/**",
  "server/api/oauth/**",
  "server/middleware/auth.ts",
  "server/middleware/session-impersonation.ts",
  "prisma/**",
  "docker-compose.yml",
  "Dockerfile",
  ".github/workflows/ci.yml",
];
const djangoSaasGlobs = [
  "**/urls.py",
  "**/decorators.py",
  "**/migrations/**",
  "**/settings*.py",
  "**/services/access_control.py",
  "**/mcp/**",
  "**/services/google_drive_tokens.py",
];
const prismaSaasGlobs = [
  "schema.prisma",
  "migrations/**",
  "Dockerfile",
  "docker-compose.yml",
  ".github/workflows/deploy.yml",
  ".env.example",
  "src/auth/**",
  "src/server/serverMiddleware.ts",
];

test("config reader prefers operator-local YAML, warns for an example, and fails closed", () => {
  const root = mkdtempSync(path.join(tmpdir(), "factory-config-fallback-"));
  try {
    const config = path.join(root, "config");
    mkdirSync(config);
    writeFileSync(
      path.join(config, "repos.example.yaml"),
      "repos: [example]\n",
    );

    const warnings = [];
    expect(
      loadConfigYaml("repos", {
        root,
        warn: (message) => warnings.push(message),
      }),
    ).toEqual({ repos: ["example"] });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("repos.example.yaml fallback");

    writeFileSync(path.join(config, "repos.yaml"), "repos: [local]\n");
    expect(
      loadConfigYaml("repos", {
        root,
        warn: (message) => warnings.push(message),
      }),
    ).toEqual({ repos: ["local"] });
    expect(warnings).toHaveLength(1);

    expect(() => loadConfigYaml("policy", { root })).toThrow(
      "neither it nor config/policy.example.yaml exists",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Node/SaaS app config protects its schema, auth, admin, and deployment boundaries", () => {
  const hits = matchEscalations(
    [
      "schema.prisma",
      "migrations/20260519140000_init/migration.sql",
      "src/auth/email.ts",
      "src/admin/operations.ts",
      "main.wasp",
      "Dockerfile",
      "Dockerfile.web",
      "docker-compose.yml",
      "nginx.conf",
      ".github/workflows/deploy.yml",
    ],
    nodeSaasGlobs,
  );

  expect(hits.map((hit) => hit.file)).toEqual([
    "schema.prisma",
    "migrations/20260519140000_init/migration.sql",
    "src/auth/email.ts",
    "src/admin/operations.ts",
    "main.wasp",
    "Dockerfile",
    "Dockerfile.web",
    "docker-compose.yml",
    "nginx.conf",
    ".github/workflows/deploy.yml",
  ]);
});

test("Node/SaaS app config leaves ordinary landing page and docs changes unflagged", () => {
  expect(
    matchEscalations(
      [
        "src/LandingPage.tsx",
        "src/components/Header.tsx",
        "README.md",
        "docs/setup.md",
      ],
      nodeSaasGlobs,
    ),
  ).toEqual([]);
});

test("mobile app config protects subscriptions, auth, credentials, and build configuration", () => {
  const hits = matchEscalations(
    [
      "src/features/subscriptions/revenueCat.ts",
      "src/auth/sessionStore.ts",
      "credentials/apple/distribution.p12",
      "eas.json",
      ".env.example",
      ".github/workflows/build.yml",
    ],
    mobileAppGlobs,
  );

  expect(hits.map((hit) => hit.file)).toEqual([
    "src/features/subscriptions/revenueCat.ts",
    "src/auth/sessionStore.ts",
    "credentials/apple/distribution.p12",
    "eas.json",
    ".env.example",
    ".github/workflows/build.yml",
  ]);
});

test("mobile app config leaves ordinary feature screens and components unflagged", () => {
  expect(
    matchEscalations(
      [
        "src/features/stats/StatsScreen.tsx",
        "src/components/Button.tsx",
        "README.md",
        "docs/setup.md",
      ],
      mobileAppGlobs,
    ),
  ).toEqual([]);
});

test("Vue/SaaS app config protects stripe, auth, prisma, and deployment boundaries", () => {
  const hits = matchEscalations(
    [
      "server/api/stripe/webhook.ts",
      "server/api/subscriptions/sync.ts",
      "server/api/auth/login.ts",
      "server/api/oauth/callback.ts",
      "server/middleware/auth.ts",
      "server/middleware/session-impersonation.ts",
      "prisma/schema.prisma",
      "prisma/migrations/20260223120700_init/migration.sql",
      "docker-compose.yml",
      "Dockerfile",
      ".github/workflows/ci.yml",
    ],
    vueSaasGlobs,
  );

  expect(hits.map((hit) => hit.file)).toEqual([
    "server/api/stripe/webhook.ts",
    "server/api/subscriptions/sync.ts",
    "server/api/auth/login.ts",
    "server/api/oauth/callback.ts",
    "server/middleware/auth.ts",
    "server/middleware/session-impersonation.ts",
    "prisma/schema.prisma",
    "prisma/migrations/20260223120700_init/migration.sql",
    "docker-compose.yml",
    "Dockerfile",
    ".github/workflows/ci.yml",
  ]);
});

test("Vue/SaaS app config leaves ordinary Vue pages and components unflagged", () => {
  expect(
    matchEscalations(
      [
        "app/pages/index.vue",
        "app/components/UserProfile.vue",
        "README.md",
        "docs/ARCHITECTURE.md",
      ],
      vueSaasGlobs,
    ),
  ).toEqual([]);
});

test("Django app config protects URL routing, auth decorators, migrations, settings, and MCP security boundaries", () => {
  const hits = matchEscalations(
    [
      "app/app/urls.py",
      "app/main/decorators.py",
      "app/main/migrations/0001_initial.py",
      "app/app/settings_prod.py",
      "app/main/services/access_control.py",
      "app/main/mcp/auth.py",
      "app/main/mcp/scopes.py",
      "app/main/mcp/security.py",
      "app/main/services/google_drive_tokens.py",
    ],
    djangoSaasGlobs,
  );

  expect(hits.map((hit) => hit.file)).toEqual([
    "app/app/urls.py",
    "app/main/decorators.py",
    "app/main/migrations/0001_initial.py",
    "app/app/settings_prod.py",
    "app/main/services/access_control.py",
    "app/main/mcp/auth.py",
    "app/main/mcp/scopes.py",
    "app/main/mcp/security.py",
    "app/main/services/google_drive_tokens.py",
  ]);
});

test("Django app config leaves ordinary document generation services and views unflagged", () => {
  expect(
    matchEscalations(
      [
        "app/main/services/document_generation.py",
        "app/main/views/home.py",
        "README.md",
        "docs/setup.md",
      ],
      djangoSaasGlobs,
    ),
  ).toEqual([]);
});

test("Prisma/SaaS app config protects its destructive, deployment, credential, and auth boundaries", () => {
  const hits = matchEscalations(
    [
      "schema.prisma",
      "migrations/20260804120000_remove_legacy_data/migration.sql",
      "Dockerfile",
      "docker-compose.yml",
      ".github/workflows/deploy.yml",
      ".env.example",
      "src/auth/verifyCurrentPassword.ts",
      "src/server/serverMiddleware.ts",
    ],
    prismaSaasGlobs,
  );

  expect(hits.map((hit) => hit.file)).toEqual([
    "schema.prisma",
    "migrations/20260804120000_remove_legacy_data/migration.sql",
    "Dockerfile",
    "docker-compose.yml",
    ".github/workflows/deploy.yml",
    ".env.example",
    "src/auth/verifyCurrentPassword.ts",
    "src/server/serverMiddleware.ts",
  ]);
});

test("Prisma/SaaS app config leaves ordinary dashboard, analytics, and docs changes unflagged", () => {
  expect(
    matchEscalations(
      [
        "src/dashboard/DashboardPage.tsx",
        "src/analytics/queries.ts",
        "docs/SESSION_HANDOFF.md",
        "README.md",
      ],
      prismaSaasGlobs,
    ),
  ).toEqual([]);
});

test("escalation stays any-depth for a bare name that also exists at the root", () => {
  // The ESCALATE gate deliberately does NOT root-anchor bare escalate_paths
  // entries. A client repo whose checkout root really holds `schema.prisma`
  // must still escalate a nested `prisma/schema.prisma`: a false escalation
  // costs one review, a missed one ships an unreviewed security change.
  const root = mkdtempSync(path.join(tmpdir(), "escalate-root-"));
  try {
    writeFileSync(path.join(root, "schema.prisma"), "// root\n");
    const files = ["schema.prisma", "prisma/schema.prisma", "docs/readme.md"];
    expect(matchEscalations(files, ["schema.prisma"])).toEqual([
      { file: "schema.prisma", globs: ["schema.prisma"] },
      { file: "prisma/schema.prisma", globs: ["schema.prisma"] },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("escalation matching never consults the process CWD", () => {
  // Run the same match from a directory that does hold a root `schema.prisma`
  // and from one that does not. Identical output proves the gate is pure text
  // and cannot be narrowed by wherever the orchestrator happens to run.
  const withFile = mkdtempSync(path.join(tmpdir(), "escalate-cwd-with-"));
  const withoutFile = mkdtempSync(path.join(tmpdir(), "escalate-cwd-without-"));
  try {
    writeFileSync(path.join(withFile, "schema.prisma"), "// root\n");
    const script = [
      `const { matchEscalations } = await import(${JSON.stringify(
        path.resolve(import.meta.dir, "escalate.mjs"),
      )});`,
      `console.log(JSON.stringify(matchEscalations(["schema.prisma", "prisma/schema.prisma"], ["schema.prisma"])));`,
    ].join("\n");
    const run = (cwd) =>
      Bun.spawnSync({
        cmd: [process.execPath, "-e", script],
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      })
        .stdout.toString()
        .trim();
    const expected = JSON.stringify([
      { file: "schema.prisma", globs: ["schema.prisma"] },
      { file: "prisma/schema.prisma", globs: ["schema.prisma"] },
    ]);
    expect(run(withFile)).toBe(expected);
    expect(run(withoutFile)).toBe(expected);
  } finally {
    rmSync(withFile, { recursive: true, force: true });
    rmSync(withoutFile, { recursive: true, force: true });
  }
});

test("flags a file under an escalate glob", () => {
  const hits = matchEscalations(["app/src/payment/stripe.ts"], globs);
  expect(hits.length).toBe(1);
  expect(hits[0].globs).toEqual(["app/src/payment/**"]);
});

test("clean diff passes", () => {
  expect(
    matchEscalations(["app/src/pages/Home.tsx", "README.md"], globs),
  ).toEqual([]);
});

test("a single protected file among many still escalates", () => {
  const hits = matchEscalations(
    [
      "docs/notes.md",
      "app/migrations/0042_add_index.sql",
      "app/src/ui/Button.tsx",
    ],
    globs,
  );
  expect(hits.map((h) => h.file)).toEqual([
    "app/migrations/0042_add_index.sql",
  ]);
});

test("settings glob with wildcard filename matches", () => {
  const hits = matchEscalations(
    ["app/app/settings_prod.py"],
    ["app/app/settings*.py"],
  );
  expect(hits.length).toBe(1);
});

test("empty glob list never escalates", () => {
  expect(matchEscalations(["anything.ts"], [])).toEqual([]);
});

test("a missing escalate_paths key is not an empty list", () => {
  expect(resolveEscalateGlobs({ name: "unguarded" }).ok).toBe(false);
  expect(
    resolveEscalateGlobs({ name: "nulled", escalate_paths: null }).ok,
  ).toBe(false);
  expect(
    resolveEscalateGlobs({ name: "bad", escalate_paths: "src/auth/**" }).ok,
  ).toBe(false);
  expect(
    resolveEscalateGlobs({ name: "declared", escalate_paths: [] }),
  ).toEqual({ ok: true, globs: [] });
});

test("a changed-file list only answers the question when it names a file", () => {
  expect(resolveChangedFiles("src/auth/session.ts\ndocs/notes.md\n")).toEqual({
    ok: true,
    files: ["src/auth/session.ts", "docs/notes.md"],
  });
  // No PR changes nothing, so these are all "the diff was not read".
  expect(resolveChangedFiles("").ok).toBe(false);
  expect(resolveChangedFiles("\n  \n").ok).toBe(false);
  expect(resolveChangedFiles(undefined).ok).toBe(false);
});

test("freshness warns when behind, when dirty, and when it cannot tell", () => {
  expect(
    freshnessWarnings({
      upstream: "origin/main",
      behind: 0,
      dirtyConfig: false,
    }),
  ).toEqual([]);

  const behind = freshnessWarnings({
    upstream: "origin/main",
    behind: 2,
    dirtyConfig: false,
  });
  expect(behind.length).toBe(1);
  expect(behind[0]).toContain("2 commit(s) behind origin/main");

  const dirty = freshnessWarnings({
    upstream: "origin/main",
    behind: 0,
    dirtyConfig: true,
  });
  expect(dirty.length).toBe(1);
  expect(dirty[0]).toContain("config/repos.yaml has uncommitted local changes");

  // A failed git command must read as "unknown", never as "clean".
  const unknown = freshnessWarnings({
    upstream: null,
    behind: null,
    dirtyConfig: null,
  });
  expect(unknown.length).toBe(2);
  expect(unknown[0]).toContain("cannot tell whether");
});

const tmp = mkdtempSync(path.join(tmpdir(), "factory-escalate-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const configPath = path.join(tmp, "repos.yaml");
writeFileSync(
  configPath,
  `repos:
  - name: guarded
    path: ~/Develop/guarded
    escalate_paths:
      - src/auth/**
      - migrations/**
  - name: declared-empty
    path: ~/Develop/declared-empty
    escalate_paths: []
  - name: unguarded
    path: ~/Develop/unguarded
  - name: stubbed
    path: ${tmp}
    escalate_paths:
      - src/auth/**
`,
);

// A `gh` that prints exactly what the test tells it to, so the CLI's real diff
// path can be exercised without the network — including the case that matters
// most here: exit 0 with no files named.
const stubBin = path.join(tmp, "stub-bin");
mkdirSync(stubBin, { recursive: true });
writeFileSync(
  path.join(stubBin, "gh"),
  `#!/bin/sh\nprintf '%s' "$FACTORY_TEST_GH_FILES"\n`,
  {
    mode: 0o755,
  },
);

test("checkoutFreshness sees a locally modified config wherever it sits in the checkout", () => {
  const repo = mkdtempSync(path.join(tmp, "checkout-"));
  const git = (...args) =>
    Bun.spawnSync({
      cmd: ["git", "-C", repo, ...args],
      stdout: "pipe",
      stderr: "pipe",
    });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  mkdirSync(path.join(repo, "config"));
  const cfg = path.join(repo, "config", "repos.yaml");
  writeFileSync(cfg, "repos: []\n");
  git("add", "-A");
  git("commit", "-qm", "init");

  expect(checkoutFreshness(cfg).dirtyConfig).toBe(false);
  appendFileSync(cfg, "# local edit\n");
  expect(checkoutFreshness(cfg).dirtyConfig).toBe(true);
  expect(freshnessWarnings(checkoutFreshness(cfg)).join("\n")).toContain(
    "uncommitted local changes",
  );
});

const CLI = path.join(import.meta.dir, "escalate.mjs");

function runCli(repo, files, env = {}) {
  const result = Bun.spawnSync({
    cmd: ["bun", CLI, "--repo", repo, "--pr", "123"],
    env: {
      ...process.env,
      FACTORY_ESCALATE_REPOS_YAML: configPath,
      FACTORY_ESCALATE_DIFF_FILES: files.join("\n"),
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

test("escalate_paths present and a file matches => exit 2", () => {
  const result = runCli("guarded", ["docs/notes.md", "src/auth/session.ts"]);
  expect(result.exitCode).toBe(EXIT.ESCALATE);
  expect(result.stdout).toContain("ESCALATE");
  expect(result.stdout).toContain("src/auth/session.ts");
});

test("escalate_paths present and nothing matches => exit 0", () => {
  const result = runCli("guarded", ["src/dashboard/Page.tsx", "README.md"]);
  expect(result.exitCode).toBe(EXIT.CLEAN);
  expect(result.stdout).toContain("mechanical check clean");
});

test("no escalate_paths key => cannot evaluate, never exit 0", () => {
  const result = runCli("unguarded", ["src/auth/session.ts"]);
  expect(result.exitCode).not.toBe(EXIT.CLEAN);
  expect(result.exitCode).toBe(EXIT.CANNOT_EVALUATE);
  expect(result.stderr).toContain("CANNOT EVALUATE");
  expect(result.stderr).toContain("ESCALATED");
});

test("an explicitly empty escalate_paths list is a real answer => exit 0", () => {
  const result = runCli("declared-empty", ["src/auth/session.ts"]);
  expect(result.exitCode).toBe(EXIT.CLEAN);
  expect(result.stdout).toContain("explicitly empty");
});

// The seam is empty in both, so these run the CLI's real `gh pr diff` branch
// against the stub — which is the point: an exported-but-empty seam must not
// short-circuit as "a diff with no files".
const withStubGh = (ghFiles) => ({
  PATH: `${stubBin}${path.delimiter}${process.env.PATH}`,
  FACTORY_TEST_GH_FILES: ghFiles,
});

test("a gh pr diff that names no files cannot be evaluated, never exit 0", () => {
  const result = runCli("stubbed", [], withStubGh(""));
  expect(result.exitCode).not.toBe(EXIT.CLEAN);
  expect(result.exitCode).toBe(EXIT.CANNOT_EVALUATE);
  expect(result.stderr).toContain("CANNOT EVALUATE");
  expect(result.stderr).toContain("changed-file list is empty");
  expect(result.stderr).toContain("ESCALATED");
});

test("an empty diff seam falls through to gh rather than passing as zero files", () => {
  const result = runCli("stubbed", [], withStubGh("src/dashboard/Page.tsx\n"));
  expect(result.exitCode).toBe(EXIT.CLEAN);
  expect(result.stdout).toContain("none of 1 changed file(s)");
});

test("a whitespace-only diff seam is not an injected answer either", () => {
  const result = runCli("stubbed", ["  ", ""], withStubGh(""));
  expect(result.exitCode).toBe(EXIT.CANNOT_EVALUATE);
  expect(result.stderr).toContain("changed-file list is empty");
});

test("an unknown repo cannot be evaluated either", () => {
  const result = runCli("not-a-repo", ["README.md"]);
  expect(result.exitCode).toBe(EXIT.CANNOT_EVALUATE);
  expect(result.stderr).toContain("CANNOT EVALUATE");
});
