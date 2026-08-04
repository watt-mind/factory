import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { matchEscalations } from "./escalate.mjs";

const globs = ["app/src/payment/**", "app/src/auth/**", "app/migrations/**"];
const repos = Bun.YAML.parse(
  readFileSync(new URL("../config/repos.yaml", import.meta.url), "utf8"),
).repos;
const cashsaasGlobs = repos.find((repo) => repo.name === "cashsaas")?.escalate_paths;

test("cashsaas config protects its destructive, deployment, credential, and auth boundaries", () => {
  expect(cashsaasGlobs).toBeDefined();

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
    cashsaasGlobs,
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

test("cashsaas config leaves ordinary dashboard, analytics, and docs changes unflagged", () => {
  expect(
    matchEscalations(
      [
        "src/dashboard/DashboardPage.tsx",
        "src/analytics/queries.ts",
        "docs/SESSION_HANDOFF.md",
        "README.md",
      ],
      cashsaasGlobs,
    ),
  ).toEqual([]);
});

test("flags a file under an escalate glob", () => {
  const hits = matchEscalations(["app/src/payment/stripe.ts"], globs);
  expect(hits.length).toBe(1);
  expect(hits[0].globs).toEqual(["app/src/payment/**"]);
});

test("clean diff passes", () => {
  expect(matchEscalations(["app/src/pages/Home.tsx", "README.md"], globs)).toEqual([]);
});

test("a single protected file among many still escalates", () => {
  const hits = matchEscalations(
    ["docs/notes.md", "app/migrations/0042_add_index.sql", "app/src/ui/Button.tsx"],
    globs,
  );
  expect(hits.map((h) => h.file)).toEqual(["app/migrations/0042_add_index.sql"]);
});

test("settings glob with wildcard filename matches", () => {
  const hits = matchEscalations(
    ["legalease/legalease/settings_prod.py"],
    ["legalease/legalease/settings*.py"],
  );
  expect(hits.length).toBe(1);
});

test("empty glob list never escalates", () => {
  expect(matchEscalations(["anything.ts"], [])).toEqual([]);
});
