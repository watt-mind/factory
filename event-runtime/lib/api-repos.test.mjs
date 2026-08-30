import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-api-repos-test-mjs";
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  HostConfigConflictError,
  readHostConfig,
  writeHostConfig,
} from "./api-repos.mjs";
import { makeServer } from "./api-test-helpers.mjs";
import { loadRepos, reposView } from "./repos.mjs";

/**
 * A factory checkout whose config/repos.yaml holds one host repo whose
 * checkout exists (so an in-repo overlay can be planted there) plus, when
 * asked, extra entries.
 */
function factoryRoot({ extraYaml = "" } = {}) {
  const root = tmpDir("api-repos-");
  const checkout = path.join(root, "checkouts", "existing");
  mkdirSync(checkout, { recursive: true });
  mkdirSync(path.join(root, "config"));
  writeFileSync(
    path.join(root, "config", "repos.yaml"),
    `# operator comment
repos:
  - name: existing
    path: ${checkout}
    github: watt-mind/existing
    base: develop
    max_in_flight: 2
    control_plane: github
    team: platform
${extraYaml}`,
  );
  return { root, checkout };
}

function server(root, options = {}) {
  return makeServer({
    repos: () => loadRepos({ root }),
    configRoot: root,
    ...options,
  });
}

function insertRun(db, spec, state = "RUNNING") {
  db.query(
    `INSERT INTO runs (run_id, idempotency_key, spec_json, spec_hash, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `run-${Math.random().toString(36).slice(2)}`,
    `key-${Math.random().toString(36).slice(2)}`,
    spec,
    "hash",
    state,
    new Date().toISOString(),
    new Date().toISOString(),
  );
}

describe("repository management API", () => {
  test("GET /repos keeps the inventory projection and adds per-repo details", async () => {
    const { root, checkout } = factoryRoot();
    const api = await server(root);
    try {
      const listed = await api.request("/repos");
      expect(listed.status).toBe(200);
      const body = await listed.json();
      // The legacy projection is untouched: same key, same rows.
      expect(body.repos).toEqual(
        JSON.parse(JSON.stringify(reposView(loadRepos({ root })))),
      );
      expect(body.details).toEqual([
        expect.objectContaining({
          name: "existing",
          configSource: "host",
          overlay: { status: "absent", error: null },
          health: { status: "healthy", path: checkout },
          inFlight: 0,
        }),
      ]);

      const one = await api.request("/repos/existing");
      expect(one.status).toBe(200);
      expect((await one.json()).repo).toMatchObject({
        name: "existing",
        github: "watt-mind/existing",
        maxInFlight: 2,
        runnerLabels: [],
      });

      const missing = await api.request("/repos/nope");
      expect(missing.status).toBe(404);
    } finally {
      api.close();
    }
  });

  test("POST/PATCH/DELETE write through to config/repos.yaml and survive a restart", async () => {
    const { root } = factoryRoot();
    const runtimePath = path.join(root, "checkouts", "runtime-repo");
    let api = await server(root);
    try {
      const created = await api.request("/repos", {
        method: "POST",
        body: JSON.stringify({
          name: "runtime-repo",
          github: "watt-mind/runtime-repo",
          path: runtimePath,
          controlPlane: "linear",
          maxInFlight: 4,
        }),
      });
      expect(created.status).toBe(201);
      expect((await created.json()).repo).toMatchObject({
        name: "runtime-repo",
        configSource: "host",
        controlPlane: "linear",
        maxInFlight: 4,
        health: { status: "missing_checkout", path: runtimePath },
      });

      const duplicate = await api.request("/repos", {
        method: "POST",
        body: JSON.stringify({
          name: "runtime-repo",
          github: "watt-mind/runtime-repo",
          path: runtimePath,
        }),
      });
      expect(duplicate.status).toBe(409);

      const patched = await api.request("/repos/runtime-repo", {
        method: "PATCH",
        body: JSON.stringify({
          reportOnly: true,
          runnerLabels: ["linux"],
          maxInFlight: 1,
        }),
      });
      expect(patched.status).toBe(200);
      expect((await patched.json()).repo).toMatchObject({
        reportOnly: true,
        runnerLabels: ["linux"],
        maxInFlight: 1,
      });
    } finally {
      api.close();
    }

    // The file is the registry: the real loader sees the mutation, and the
    // host's other keys survived the rewrite.
    const reloaded = loadRepos({ root });
    expect(reloaded.get("runtime-repo")).toMatchObject({
      github: "watt-mind/runtime-repo",
      controlPlane: "linear",
      reportOnly: true,
      maxInFlight: 1,
    });
    expect(reloaded.get("existing")).toMatchObject({
      team: "platform",
      maxInFlight: 2,
    });

    api = await server(root);
    try {
      const after = await api.request("/repos/runtime-repo");
      expect(after.status).toBe(200);
      expect((await after.json()).repo).toMatchObject({
        reportOnly: true,
        runnerLabels: ["linux"],
        maxInFlight: 1,
      });

      const deleted = await api.request("/repos/runtime-repo", {
        method: "DELETE",
      });
      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toEqual({ deleted: "runtime-repo" });
      expect((await api.request("/repos/runtime-repo")).status).toBe(404);
      expect(
        (await api.request("/repos/runtime-repo", { method: "DELETE" })).status,
      ).toBe(404);
    } finally {
      api.close();
    }
    expect(loadRepos({ root }).has("runtime-repo")).toBe(false);
    expect(loadRepos({ root }).has("existing")).toBe(true);
  });

  test("a write the loader rejects returns 422 and leaves the registry untouched", async () => {
    const { root } = factoryRoot();
    const file = path.join(root, "config", "repos.yaml");
    const before = readFileSync(file, "utf8");
    const api = await server(root);
    try {
      // Passes the API's field validation; the loader requires a path.
      const created = await api.request("/repos", {
        method: "POST",
        body: JSON.stringify({
          name: "pathless",
          github: "watt-mind/pathless",
        }),
      });
      expect(created.status).toBe(422);
      expect((await created.json()).error).toContain("pathless has no path");
      expect((await api.request("/repos/pathless")).status).toBe(404);
      expect(readFileSync(file, "utf8")).toBe(before);

      const invalid = await api.request("/repos", {
        method: "POST",
        body: JSON.stringify({ name: "bad name", github: "not-a-slug" }),
      });
      expect(invalid.status).toBe(422);

      const unknown = await api.request("/repos/existing", {
        method: "PATCH",
        body: JSON.stringify({ base: "main" }),
      });
      expect(unknown.status).toBe(422);
      expect(readFileSync(file, "utf8")).toBe(before);
    } finally {
      api.close();
    }
  });

  test("rejects relative checkout paths before writing", async () => {
    const { root } = factoryRoot();
    const api = await server(root);
    try {
      const created = await api.request("/repos", {
        method: "POST",
        body: JSON.stringify({
          name: "relative",
          github: "watt-mind/relative",
          path: "checkouts/relative",
        }),
      });
      expect(created.status).toBe(422);
      expect((await created.json()).error).toBe(
        "path must be absolute or ~-prefixed",
      );
    } finally {
      api.close();
    }
  });

  test("forks an example fallback into repos.yaml without modifying the example", async () => {
    const { root } = factoryRoot();
    const configDir = path.join(root, "config");
    const local = path.join(configDir, "repos.yaml");
    const example = path.join(configDir, "repos.example.yaml");
    chmodSync(local, 0o600);
    renameSync(local, example);
    const exampleContents = readFileSync(example, "utf8");
    const api = await server(root);
    try {
      const patched = await api.request("/repos/existing", {
        method: "PATCH",
        body: JSON.stringify({ maxInFlight: 3 }),
      });
      expect(patched.status).toBe(200);
    } finally {
      api.close();
    }
    expect(readFileSync(example, "utf8")).toBe(exampleContents);
    expect(statSync(local).mode & 0o777).toBe(0o600);
    expect(loadRepos({ root }).get("existing")?.maxInFlight).toBe(3);
  });

  test("returns 409 instead of clobbering an external registry writer", async () => {
    const { root } = factoryRoot();
    const file = path.join(root, "config", "repos.yaml");
    const contents = readFileSync(file, "utf8");
    const config = readHostConfig(root);
    writeFileSync(file, contents + "\n# external edit\n");
    expect(() => writeHostConfig(root, config)).toThrow(
      HostConfigConflictError,
    );
    expect(() => writeHostConfig(root, config)).toThrow(
      "config/repos.yaml changed while this request was pending; retry the request",
    );
  });

  test("sync re-reads the in-repo overlay and reports whether it applies", async () => {
    const { root, checkout } = factoryRoot();
    const api = await server(root);
    try {
      writeFileSync(
        path.join(checkout, ".factory.yaml"),
        "schemaVersion: factory.repo/v1\nbase: release\n",
      );
      const synced = await api.request("/repos/existing/sync", {
        method: "POST",
        body: "{}",
      });
      expect(synced.status).toBe(200);
      const body = await synced.json();
      expect(body.refreshed).toBe(true);
      expect(body.overlay).toEqual({ status: "applied", error: null });
      expect(body.repo).toMatchObject({
        configSource: "in-repo",
        base: "release",
        sync: { overlay: { status: "applied", error: null } },
      });

      // A host-owned key in the overlay is ignored, and sync says so.
      writeFileSync(
        path.join(checkout, ".factory.yaml"),
        "schemaVersion: factory.repo/v1\nmax_in_flight: 9\n",
      );
      const ignored = await api.request("/repos/existing/sync", {
        method: "POST",
        body: "{}",
      });
      expect(ignored.status).toBe(200);
      const ignoredBody = await ignored.json();
      expect(ignoredBody.overlay.status).toBe("ignored");
      expect(ignoredBody.overlay.error).toContain("host-owned");
      expect(ignoredBody.repo).toMatchObject({
        configSource: "host",
        maxInFlight: 2,
      });

      expect(
        (await api.request("/repos/nope/sync", { method: "POST", body: "{}" }))
          .status,
      ).toBe(404);
    } finally {
      api.close();
    }
  });

  test("mutating routes require the control bearer", async () => {
    const { root } = factoryRoot();
    const api = await server(root, { autoAuthorize: false });
    try {
      for (const [target, method] of [
        ["/repos", "POST"],
        ["/repos/existing", "PATCH"],
        ["/repos/existing", "DELETE"],
        ["/repos/existing/sync", "POST"],
      ]) {
        const missing = await fetch(api.url(target), { method, body: "{}" });
        expect([target, method, missing.status]).toEqual([target, method, 401]);
        const wrong = await fetch(api.url(target), {
          method,
          body: "{}",
          headers: { authorization: "Bearer not-the-token" },
        });
        expect([target, method, wrong.status]).toEqual([target, method, 401]);
      }
      // Nothing leaked through: the host entry is still intact.
      expect(loadRepos({ root }).get("existing")?.maxInFlight).toBe(2);
    } finally {
      api.close();
    }
  });

  test("active runs are counted per repo in SQL and block deletion", async () => {
    const { root } = factoryRoot({
      extraYaml: `  - name: other
    path: /missing/other
    github: watt-mind/other
`,
    });
    const api = await server(root);
    try {
      insertRun(api.db, JSON.stringify({ input: { repo: "existing" } }));
      insertRun(
        api.db,
        JSON.stringify({ input: { repoPin: { repo: "existing" } } }),
      );
      insertRun(
        api.db,
        JSON.stringify({ input: { repos: ["other", { name: "existing" }] } }),
      );
      insertRun(
        api.db,
        JSON.stringify({ input: { repo: "existing" } }),
        "DONE",
      );
      insertRun(api.db, "{not json");

      const existing = await api.request("/repos/existing");
      expect((await existing.json()).repo.inFlight).toBe(3);
      const other = await api.request("/repos/other");
      expect((await other.json()).repo.inFlight).toBe(1);
      const listed = await (await api.request("/repos")).json();
      expect(
        Object.fromEntries(listed.details.map((r) => [r.name, r.inFlight])),
      ).toEqual({ existing: 3, other: 1 });

      const blocked = await api.request("/repos/existing", {
        method: "DELETE",
      });
      expect(blocked.status).toBe(409);
      expect((await blocked.json()).error).toContain("3 active run(s)");
      expect(loadRepos({ root }).has("existing")).toBe(true);
    } finally {
      api.close();
    }
  });
});
