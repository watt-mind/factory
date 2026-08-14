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

  test("event type mapped to an unregistered agent fails closed", () => {
    const root = tempRegistry();
    writeFileSync(
      path.join(root, "event-types.json"),
      JSON.stringify({ "x.y": { agent: "ghost@9", idempotencyScope: ["correlationId"] } }),
    );
    expect(() => loadRegistry({ root })).toThrow(/unregistered agent/);
  });
});
