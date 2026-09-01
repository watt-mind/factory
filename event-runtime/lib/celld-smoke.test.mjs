import { describe, it, beforeAll, afterAll, expect } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, cpSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CellClient, VersionConflictError } from "./cell-client.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const CELLS_DIR = path.resolve(REPO_ROOT, "cells");
const TMP_TEST_DIR = path.resolve(
  REPO_ROOT,
  ".factory/test-celld-smoke-" + Date.now(),
);

// Select an ephemeral port
const TEST_PORT = 9975;
const TEST_ENDPOINT = `http://127.0.0.1:${TEST_PORT}`;

let celldProcess = null;

function startCelld(customPort = TEST_PORT, storageProjectDir = TMP_TEST_DIR) {
  // celld dev [PROJECT] --host 127.0.0.1 --port PORT
  const proc = spawn(
    "celld",
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
      },
    },
  );

  return proc;
}

async function waitForHealth(endpoint = TEST_ENDPOINT, maxAttempts = 30) {
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

describe.skipIf(!Bun.which("celld"))(
  "celld structured REST/RPC & multi-agent durability",
  () => {
    beforeAll(async () => {
      if (existsSync(TMP_TEST_DIR)) {
        rmSync(TMP_TEST_DIR, { recursive: true, force: true });
      }
      mkdirSync(TMP_TEST_DIR, { recursive: true });

      // Copy cells project files into the test storage dir so celld dev finds wrangler.jsonc & src
      cpSync(CELLS_DIR, TMP_TEST_DIR, { recursive: true });

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
      const client = new CellClient({ endpoint: TEST_ENDPOINT });
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
