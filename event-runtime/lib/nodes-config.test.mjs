import { test, expect, describe } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_REMOTE_WORKER_REPO_URL,
  loadNodesConfig,
  NodeConfigError,
} from "./nodes-config.mjs";

function withNodesConfig(yaml, assert) {
  const dir = path.join(tmpdir(), `test-nodes-${Date.now()}`);
  mkdirSync(path.join(dir, "config"), { recursive: true });
  writeFileSync(path.join(dir, "config", "nodes.yaml"), yaml);
  try {
    assert(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("nodes config loader", () => {
  test("parses a configured remote worker repository URL", () => {
    withNodesConfig(
      `
nodes:
  mac-mini:
    host: "mac-mini.local"
    repo_url: "ssh://git@example.test/factory.git"
`,
      (root) => {
        const node = loadNodesConfig({ root }).get("mac-mini");
        expect(node.repoUrl).toBe("ssh://git@example.test/factory.git");
      },
    );
  });

  test("defaults the remote worker repository URL", () => {
    withNodesConfig(
      `
nodes:
  mac-mini:
    host: "mac-mini.local"
`,
      (root) => {
        const node = loadNodesConfig({ root }).get("mac-mini");
        expect(node.repoUrl).toBe(DEFAULT_REMOTE_WORKER_REPO_URL);
      },
    );
  });

  test("handles missing files and rejects invalid node definitions", () => {
    expect(
      loadNodesConfig({ configPath: "/nonexistent/nodes.yaml" }).size,
    ).toBe(0);
    withNodesConfig(
      `
nodes:
  bad-node:
    port: "invalid"
`,
      (root) => {
        expect(() => loadNodesConfig({ root })).toThrow(NodeConfigError);
      },
    );
  });
});
