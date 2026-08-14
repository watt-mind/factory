import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cpSync } from "node:fs";
import { RUNTIME_ROOT } from "./config.mjs";
import { RegistryError, getAgent, getEventType, loadRegistry, updatePins } from "./registry.mjs";

/** Copy the real registry into a temp root so tests can corrupt it safely. */
function tempRegistry() {
  const root = mkdtempSync(path.join(tmpdir(), "event-registry-"));
  for (const dir of ["agents", "schemas"]) {
    cpSync(path.join(RUNTIME_ROOT, dir), path.join(root, dir), { recursive: true });
  }
  cpSync(path.join(RUNTIME_ROOT, "event-types.json"), path.join(root, "event-types.json"));
  return root;
}

describe("registry", () => {
  test("loads the committed registry (pins verified)", () => {
    const registry = loadRegistry();
    const def = getAgent(registry, "factory-status-report@1");
    expect(def.outputSchema.required).toContain("recommendedAction");
    expect(getEventType(registry, "factory.status-report.requested").agent).toBe("factory-status-report@1");
    expect(getEventType(registry, "unknown.event")).toBeNull();
  });

  test("editing a pinned file without re-pinning fails closed", () => {
    const root = tempRegistry();
    const promptFile = path.join(root, "agents", "factory-status-report.md");
    writeFileSync(promptFile, `${readFileSync(promptFile, "utf8")}\n<!-- drift -->\n`);
    expect(() => loadRegistry({ root })).toThrow(RegistryError);
    updatePins({ root });
    expect(() => loadRegistry({ root })).not.toThrow();
  });

  test("mutating agents are refused in the MVP", () => {
    const root = tempRegistry();
    const defFile = path.join(root, "agents", "factory-status-report.json");
    const def = JSON.parse(readFileSync(defFile, "utf8"));
    writeFileSync(defFile, JSON.stringify({ ...def, mutating: true }));
    expect(() => loadRegistry({ root })).toThrow(/mutating/);
  });

  test("a mutating LLM agent over a tier-2 worktree workspace is admitted (dispatch design §6, WM-108)", () => {
    const registry = loadRegistry();
    const def = getAgent(registry, "dispatch@1");
    expect(def.mutating).toBe(true);
    expect(def.workspace.type).toBe("worktree");
    expect(getEventType(registry, "factory.dispatch.requested").agent).toBe("dispatch@1");
    // The carve-out is the workspace type, nothing wider: the same def on an
    // ephemeral workspace must still fail closed.
    const root = tempRegistry();
    const defFile = path.join(root, "agents", "dispatch.json");
    const raw = JSON.parse(readFileSync(defFile, "utf8"));
    writeFileSync(defFile, JSON.stringify({ ...raw, workspace: { type: "ephemeral" } }));
    expect(() => loadRegistry({ root })).toThrow(/mutating/);
  });

  test("schedule payload must be a plain object without reserved tick fields (WM-72)", () => {
    const root = tempRegistry();
    const withPayload = (payload) =>
      writeFileSync(
        path.join(root, "schedules.json"),
        JSON.stringify({
          "reconcile-x": { every: "10m", eventType: "factory.reconcile.requested", payload, enabled: false },
        }),
      );
    withPayload(["bj29"]);
    expect(() => loadRegistry({ root })).toThrow(/plain object/);
    withPayload({ slot: "2026-01-01T00:00:00.000Z" });
    expect(() => loadRegistry({ root })).toThrow(/reserved tick field/);
    withPayload({ repo: "bj29" });
    expect(() => loadRegistry({ root })).not.toThrow();
  });

  test("repos scope: malformed values fail closed at load, well-formed ones load (WM-64)", () => {
    const root = tempRegistry();
    const defFile = path.join(root, "agents", "factory-status-report.json");
    const def = JSON.parse(readFileSync(defFile, "utf8"));
    const withRepos = (repos) => writeFileSync(defFile, JSON.stringify({ ...def, repos }));

    withRepos("bj29"); // not an array
    expect(() => loadRegistry({ root })).toThrow(/"repos"/);
    withRepos([]); // half-finished edit, not a deny-all
    expect(() => loadRegistry({ root })).toThrow(/"repos"/);
    withRepos(["bj29", ""]); // empty string member
    expect(() => loadRegistry({ root })).toThrow(/"repos"/);
    withRepos(["bj29", 7]); // non-string member
    expect(() => loadRegistry({ root })).toThrow(/"repos"/);

    // Well-formed loads, and membership is deliberately NOT checked against
    // config/repos.yaml here — the planner owns that at plan time.
    withRepos(["bj29", "not-in-repos-yaml"]);
    const registry = loadRegistry({ root });
    expect(getAgent(registry, "factory-status-report@1").repos).toEqual(["bj29", "not-in-repos-yaml"]);
  });

  test("event type mapped to an unregistered agent fails closed", () => {
    const root = tempRegistry();
    writeFileSync(
      path.join(root, "event-types.json"),
      JSON.stringify({ "x.y": { agent: "ghost@9", idempotencyScope: ["correlationId"] } }),
    );
    expect(() => loadRegistry({ root })).toThrow(/unregistered agent/);
  });
});
