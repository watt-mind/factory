import { describe, expect, test } from "bun:test";
import { openDb } from "./db.mjs";
import { loadRegistry } from "./registry.mjs";
import {
  KIND_AGENT,
  KIND_EVENT_TYPE,
  OverlayError,
  deleteOverride,
  knownAdapters,
  listOverrideJournal,
  listOverrides,
  mergeAgentPatch,
  plannedDef,
  putOverride,
  validateAgentPatch,
  validateEventTypePatch,
} from "./runtime-overrides.mjs";

const registry = loadRegistry();

describe("runtime-overrides (WM-887)", () => {
  test("put, get, delete, and journal an event-type adapter overlay", () => {
    const db = openDb(":memory:");
    const type = "factory.status-report.requested";
    putOverride(db, {
      kind: KIND_EVENT_TYPE,
      key: type,
      patch: { adapter: "cursor" },
      actor: "operator",
      now: Date.parse("2026-08-19T10:00:00Z"),
    });
    expect(listOverrides(db).eventTypes[type]).toEqual({ adapter: "cursor" });
    const gone = deleteOverride(db, {
      kind: KIND_EVENT_TYPE,
      key: type,
      actor: "operator",
      now: Date.parse("2026-08-19T10:01:00Z"),
    });
    expect(gone.deleted).toBe(true);
    expect(listOverrides(db).eventTypes[type]).toBeUndefined();
    const journal = listOverrideJournal(db);
    expect(journal).toHaveLength(2);
    expect(journal[0].after).toBeNull();
    expect(journal[1].after).toEqual({ adapter: "cursor" });
    db.close();
  });

  test("validateEventTypePatch refuses unknown type, unknown adapter, extra keys", () => {
    expect(() =>
      validateEventTypePatch(registry, "nope.requested", { adapter: "pi" }),
    ).toThrow(OverlayError);
    expect(() =>
      validateEventTypePatch(registry, "factory.status-report.requested", {
        adapter: "nope",
      }),
    ).toThrow(/unknown adapter/);
    expect(() =>
      validateEventTypePatch(registry, "factory.status-report.requested", {
        adapter: "pi",
        extra: true,
      }),
    ).toThrow(/only adapter/);
    const patch = validateEventTypePatch(
      registry,
      "factory.status-report.requested",
      { adapter: "cursor" },
    );
    expect(patch).toEqual({ adapter: "cursor" });
    expect(knownAdapters(registry).has("pi")).toBe(true);
  });

  test("validateAgentPatch refuses unknown ref and invalid tier; merge keeps independent fields", () => {
    expect(() =>
      validateAgentPatch(registry, "missing@1", { modelTier: "light" }),
    ).toThrow(/unknown agent/);
    expect(() =>
      validateAgentPatch(registry, "factory-status-report@1", {
        modelTier: "turbo",
      }),
    ).toThrow(/modelTier/);
    const incoming = validateAgentPatch(registry, "factory-status-report@1", {
      model: "cursor-grok-4.6-high",
    });
    expect(mergeAgentPatch({ modelTier: "light" }, incoming)).toEqual({
      modelTier: "light",
      model: "cursor-grok-4.6-high",
    });
    expect(
      mergeAgentPatch({ modelTier: "light", model: "x" }, { model: null }),
    ).toEqual({
      modelTier: "light",
      model: null,
    });
    expect(
      mergeAgentPatch({ modelTier: "light" }, { modelTier: null }),
    ).toBeNull();
  });

  test("plannedDef: null model overlay drops the git pin so the tier map wins", () => {
    const planned = plannedDef(
      { model_tier: "standard", model: "pinned-id" },
      { modelOverride: null },
    );
    expect(planned.model).toBeUndefined();
    expect(planned.model_tier).toBe("standard");
  });
});
