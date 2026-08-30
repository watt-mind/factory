import { describe, expect, test } from "bun:test";
import { makeServer } from "./api-test-helpers.mjs";

function repo(name = "existing") {
  return {
    name,
    github: `watt-mind/${name}`,
    path: "/missing/checkout",
    controlPlane: "github",
    base: "develop",
    reportOnly: false,
    maxInFlight: 2,
  };
}

describe("repository management API", () => {
  test("lists host state, registers runtime repos, patches flags, and syncs", async () => {
    const api = await makeServer({
      repos: () => new Map([["existing", repo()]]),
    });
    try {
      const listed = await api.request("/repos/existing");
      expect(listed.status).toBe(200);
      expect((await listed.json()).repo).toMatchObject({
        name: "existing",
        configSource: "host",
        health: { status: "missing_checkout" },
        inFlight: 0,
      });

      const created = await api.request("/repos", {
        method: "POST",
        body: JSON.stringify({
          name: "runtime-repo",
          github: "watt-mind/runtime-repo",
          path: "/runtime/repo",
          controlPlane: "github",
          maxInFlight: 4,
        }),
      });
      expect(created.status).toBe(201);
      expect((await created.json()).repo).toMatchObject({
        name: "runtime-repo",
        configSource: "runtime",
        maxInFlight: 4,
      });

      const patched = await api.request("/repos/runtime-repo", {
        method: "PATCH",
        body: JSON.stringify({ reportOnly: true, runnerLabels: ["linux"] }),
      });
      expect(patched.status).toBe(200);
      expect((await patched.json()).repo).toMatchObject({
        reportOnly: true,
        runnerLabels: ["linux"],
      });

      const synced = await api.request("/repos/runtime-repo/sync", {
        method: "POST",
        body: "{}",
      });
      expect(synced.status).toBe(200);
      expect((await synced.json()).invalidated).toBe(true);
    } finally {
      api.close();
    }
  });

  test("validates registrations, requires bearer authentication, and blocks active deletion", async () => {
    const api = await makeServer({
      autoAuthorize: false,
      repos: () => new Map([["existing", repo()]]),
    });
    try {
      const unauthorized = await fetch(api.url("/repos"), { method: "POST" });
      expect(unauthorized.status).toBe(401);

      const invalid = await api.request("/repos", {
        method: "POST",
        body: JSON.stringify({ name: "bad name", github: "not-a-slug" }),
      });
      expect(invalid.status).toBe(422);

      api.db
        .query(
          `INSERT INTO runs (run_id, idempotency_key, spec_json, spec_hash, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "run-active",
          "active-key",
          JSON.stringify({ input: { repo: "existing" } }),
          "hash",
          "RUNNING",
          new Date().toISOString(),
          new Date().toISOString(),
        );
      const blocked = await api.request("/repos/existing", {
        method: "DELETE",
      });
      expect(blocked.status).toBe(409);
      expect((await blocked.json()).error).toContain("active run");
    } finally {
      api.close();
    }
  });
});
