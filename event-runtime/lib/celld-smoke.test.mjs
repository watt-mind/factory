import { describe, it, beforeAll, afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CellClient, VersionConflictError } from "./cell-client.mjs";
import { validate } from "./schema.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const CELLS_DIR = path.resolve(REPO_ROOT, "cells");
const TMP_TEST_DIR = path.resolve(
  REPO_ROOT,
  ".factory/test-celld-smoke-" + Date.now(),
);

test("celld-smoke documented artifact validates its output schema", () => {
  const prompt = readFileSync(
    path.join(REPO_ROOT, "event-runtime", "agents", "celld-smoke.md"),
    "utf8",
  );
  const example = prompt.match(/```json\n([\s\S]*?)\n```/);
  expect(example).not.toBeNull();

  const artifact = JSON.parse(example[1]).artifact;
  const schema = JSON.parse(
    readFileSync(
      path.join(
        REPO_ROOT,
        "event-runtime",
        "schemas",
        "celld-smoke.output.json",
      ),
      "utf8",
    ),
  );

  expect(artifact).toMatchObject({
    endpoint: "http://127.0.0.1:9876",
    migrationId: "001_celld_smoke_init",
    collection: "smoke_tests",
    entityId: "<input.json's testKey>",
    cellVersionAfterMigration: 2,
  });
  expect(validate(schema, artifact)).toEqual({ valid: true, errors: [] });
});

// `celld` is a local developer daemon; it is not provisioned in CI or in the
// sandbox, so the whole suite is gated on the binary being present.
const CELLD_BIN = Bun.which("celld");

// wrangler.jsonc is JSONC: strip comments and trailing commas before parsing.
function parseJsonc(text) {
  const withoutComments = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'\\])\/\/.*$/gm, "$1");
  return JSON.parse(withoutComments.replace(/,(\s*[}\]])/g, "$1"));
}

// Pick a free port at run time — a hardcoded port collides on shared runners.
async function pickFreePort() {
  return await new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const TEST_TOKEN = "celld-smoke-" + Math.random().toString(36).slice(2);

let TEST_PORT = 0;
let TEST_ENDPOINT = "";
let celldProcess = null;

function startCelld(customPort, storageProjectDir = TMP_TEST_DIR) {
  // celld dev [PROJECT] --host 127.0.0.1 --port PORT
  const proc = spawn(
    CELLD_BIN,
    [
      "dev",
      storageProjectDir,
      "--host",
      "127.0.0.1",
      "--port",
      String(customPort),
    ],
    {
      cwd: REPO_ROOT,
      stdio: "pipe",
      env: {
        ...process.env,
        CELL_AUTH_TOKEN: TEST_TOKEN,
      },
    },
  );

  return proc;
}

async function waitForHealth(endpoint = TEST_ENDPOINT, maxAttempts = 30) {
  endpoint = endpoint || TEST_ENDPOINT;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`${endpoint}/health`);
      if (res.ok) {
        const data = await res.json();
        if (data.status === "healthy") return true;
      }
    } catch {
      // ignore retry
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function stopProcess(proc) {
  if (!proc) return;
  try {
    proc.kill("SIGTERM");
  } catch {
    // ignore
  }
}

describe.skipIf(!CELLD_BIN)(
  "celld structured REST/RPC & multi-agent durability",
  () => {
    beforeAll(async () => {
      TEST_PORT = await pickFreePort();
      TEST_ENDPOINT = `http://127.0.0.1:${TEST_PORT}`;

      if (existsSync(TMP_TEST_DIR)) {
        rmSync(TMP_TEST_DIR, { recursive: true, force: true });
      }
      mkdirSync(TMP_TEST_DIR, { recursive: true });

      // Copy the whole cells project into the test storage dir so celld dev
      // finds wrangler.jsonc and every module the worker entrypoint imports.
      cpSync(CELLS_DIR, TMP_TEST_DIR, { recursive: true });

      // Inject the shared-secret binding the worker requires (see the deployment
      // warning in cells/src/index.mjs); the daemon reads it from wrangler vars.
      const wranglerPath = path.join(TMP_TEST_DIR, "wrangler.jsonc");
      const wranglerConfig = parseJsonc(await Bun.file(wranglerPath).text());
      wranglerConfig.vars = {
        ...(wranglerConfig.vars || {}),
        CELL_AUTH_TOKEN: TEST_TOKEN,
      };
      await Bun.write(wranglerPath, JSON.stringify(wranglerConfig, null, 2));

      celldProcess = startCelld(TEST_PORT, TMP_TEST_DIR);

      const healthy = await waitForHealth();
      expect(healthy).toBe(true);
    });

    afterAll(() => {
      stopProcess(celldProcess);
      if (existsSync(TMP_TEST_DIR)) {
        rmSync(TMP_TEST_DIR, { recursive: true, force: true });
      }
    });

    it("proves health check and empty initial cell schema", async () => {
      const client = new CellClient({
        endpoint: TEST_ENDPOINT,
        authToken: TEST_TOKEN,
      });
      const healthy = await client.checkHealth();
      expect(healthy).toBe(true);

      const articleCell = client.forCell("article:01J_SMOKE_TEST");
      const schema = await articleCell.getSchema();
      expect(schema.cellVersion).toBe(1);
      expect(schema.migrations.length).toBe(0);
      expect(schema.tables.some((t) => t.name === "_cell_entities")).toBe(true);
    });

    it("allows Agent 1 to initialize sources and record research", async () => {
      const agent1 = new CellClient({
        endpoint: TEST_ENDPOINT,
        authToken: TEST_TOKEN,
        cellId: "article:01J_SMOKE_TEST",
      });

      // Agent 1 applies initial domain migration
      const migRes = await agent1.migrate({
        migrationId: "001_init_research_notes",
        sql: "CREATE TABLE research_notes (id TEXT PRIMARY KEY, note TEXT);",
        description: "Initial research notes table",
      });

      expect(migRes.ok).toBe(true);
      expect(migRes.applied).toBe(true);
      expect(migRes.cellVersion).toBe(2);

      // Agent 1 saves research source entity
      const putRes = await agent1.putEntity(
        "sources",
        "src-intervals-101",
        {
          title: "Intervals ICU API Documentation",
          url: "https://intervals.icu/api/v1",
          relevanceScore: 0.95,
          claims: [
            "OAuth token refresh is supported",
            "Webhook cadence is 60s",
          ],
        },
        { expectedVersion: 0 },
      );

      expect(putRes.ok).toBe(true);
      expect(putRes.created).toBe(true);
      expect(putRes.version).toBe(1);
      expect(putRes.cellVersion).toBe(3);

      // Verify entity read
      const entity = await agent1.getEntity("sources", "src-intervals-101");
      expect(entity).not.toBeNull();
      expect(entity.id).toBe("src-intervals-101");
      expect(entity.version).toBe(1);
      expect(entity.data.title).toBe("Intervals ICU API Documentation");
    });

    it("allows Agent 2 to read Agent 1 sources and evolve the cell schema", async () => {
      // Agent 2 runs in a separate context / client instance
      const agent2 = new CellClient({
        endpoint: TEST_ENDPOINT,
        authToken: TEST_TOKEN,
        cellId: "article:01J_SMOKE_TEST",
      });

      // 1. Agent 2 reads sources populated by Agent 1
      const sources = await agent2.listEntities("sources");
      expect(sources.count).toBe(1);
      expect(sources.entities[0].id).toBe("src-intervals-101");

      // 2. Agent 2 evolves the cell schema (alters cell) by adding revisions table
      const migRes = await agent2.migrate({
        migrationId: "002_add_revisions_table",
        sql: "CREATE TABLE revisions (id TEXT PRIMARY KEY, hash TEXT NOT NULL, word_count INTEGER);",
        description: "Article revisions table",
      });

      expect(migRes.ok).toBe(true);
      expect(migRes.applied).toBe(true);

      // 3. Agent 2 writes draft revision 1 entity
      const revRes = await agent2.putEntity(
        "revisions",
        "rev-001",
        {
          hash: "sha256:abcd1234ef5678",
          wordCount: 1650,
          title: "Optimizing Intervals.icu Integration in Coach Watts",
          status: "draft",
        },
        { expectedVersion: 0 },
      );

      expect(revRes.ok).toBe(true);
      expect(revRes.version).toBe(1);

      // Verify the schema reflects both migrations
      const schema = await agent2.getSchema();
      expect(schema.migrations.length).toBe(2);
      expect(schema.migrations[0].id).toBe("001_init_research_notes");
      expect(schema.migrations[1].id).toBe("002_add_revisions_table");
      expect(schema.tables.some((t) => t.name === "revisions")).toBe(true);
    });

    it("enforces optimistic concurrency and rejects stale writes with VersionConflictError", async () => {
      const agent1 = new CellClient({
        endpoint: TEST_ENDPOINT,
        authToken: TEST_TOKEN,
        cellId: "article:01J_SMOKE_TEST",
      });

      // Agent 1 tries to update sources with outdated expectedVersion: 0 (current is 1)
      let conflictThrown = false;
      try {
        await agent1.putEntity(
          "sources",
          "src-intervals-101",
          {
            title: "Stale Overwrite Attempt",
          },
          { expectedVersion: 0 },
        );
      } catch (err) {
        if (err instanceof VersionConflictError) {
          conflictThrown = true;
          expect(err.status).toBe(409);
          expect(err.currentVersion).toBe(1);
        }
      }
      expect(conflictThrown).toBe(true);

      // Agent 1 updates with matching expectedVersion: 1
      const updateRes = await agent1.putEntity(
        "sources",
        "src-intervals-101",
        {
          title: "Intervals ICU API Documentation (Verified)",
          url: "https://intervals.icu/api/v1",
          relevanceScore: 0.98,
        },
        { expectedVersion: 1 },
      );

      expect(updateRes.ok).toBe(true);
      expect(updateRes.version).toBe(2);
    });

    it("supports read-only SQL queries via /v1/query and rejects unsafe writes", async () => {
      const client = new CellClient({
        endpoint: TEST_ENDPOINT,
        authToken: TEST_TOKEN,
        cellId: "article:01J_SMOKE_TEST",
      });

      // 1. Safe query
      const queryRes = await client.query(
        "SELECT id, version FROM _cell_entities WHERE collection = ? ORDER BY id ASC;",
        ["sources"],
      );
      expect(queryRes.count).toBe(1);
      expect(queryRes.rows[0].id).toBe("src-intervals-101");
      expect(queryRes.rows[0].version).toBe(2);

      // 2. Unsafe write statement in query endpoint is forbidden
      let forbiddenCaught = false;
      try {
        await client.query("DROP TABLE _cell_entities;");
      } catch (err) {
        if (err.status === 403) {
          forbiddenCaught = true;
        }
      }
      expect(forbiddenCaught).toBe(true);

      // 3. A write statement smuggled behind a read-only leading keyword is also
      // forbidden (single-statement guard).
      let injectionCaught = false;
      try {
        await client.query("SELECT 1; DROP TABLE _cell_entities;");
      } catch (err) {
        if (err.status === 403) {
          injectionCaught = true;
        }
      }
      expect(injectionCaught).toBe(true);

      // The table is still there.
      const stillThere = await client.query(
        "SELECT COUNT(*) AS n FROM _cell_entities;",
      );
      expect(stillThere.rows[0].n).toBeGreaterThan(0);
    });

    it("rejects requests without a valid bearer token", async () => {
      const res = await fetch(
        `${TEST_ENDPOINT}/cells/${encodeURIComponent("article:01J_SMOKE_TEST")}/v1/schema`,
      );
      expect(res.status).toBe(401);

      const badRes = await fetch(
        `${TEST_ENDPOINT}/cells/${encodeURIComponent("article:01J_SMOKE_TEST")}/v1/schema`,
        {
          headers: { Authorization: "Bearer not-the-token" },
        },
      );
      expect(badRes.status).toBe(401);
    });

    it("survives daemon process restart and preserves all data and migrations", async () => {
      // 1. Stop celld daemon
      stopProcess(celldProcess);

      // Small delay to ensure process termination
      await new Promise((r) => setTimeout(r, 500));

      // 2. Restart celld daemon against same storage dir
      celldProcess = startCelld(TEST_PORT, TMP_TEST_DIR);
      const healthy = await waitForHealth();
      expect(healthy).toBe(true);

      // 3. Connect client and verify everything persisted
      const client = new CellClient({
        endpoint: TEST_ENDPOINT,
        authToken: TEST_TOKEN,
        cellId: "article:01J_SMOKE_TEST",
      });

      const schema = await client.getSchema();
      expect(schema.migrations.length).toBe(2);
      expect(schema.tables.some((t) => t.name === "revisions")).toBe(true);

      const sourceEntity = await client.getEntity(
        "sources",
        "src-intervals-101",
      );
      expect(sourceEntity).not.toBeNull();
      expect(sourceEntity.version).toBe(2);
      expect(sourceEntity.data.title).toBe(
        "Intervals ICU API Documentation (Verified)",
      );

      const revEntity = await client.getEntity("revisions", "rev-001");
      expect(revEntity).not.toBeNull();
      expect(revEntity.version).toBe(1);
      expect(revEntity.data.wordCount).toBe(1650);
    });
  },
);
