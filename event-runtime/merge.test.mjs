/**
 * Merge chain (WM-109): merge-scan@1 reviews a repo's open PRs cold and emits
 * a typed, head-SHA-pinned plan; merge-apply@1 executes the approved plan via
 * the closed actions registry; ESCALATE routes to the merge-notify push.
 * Follows the triage-scan → triage-apply precedent (OPS-229) and the
 * ci-doctor verdict edges (OPS-223).
 */
import { describe, expect, test } from "bun:test";
import { loadRegistry } from "./lib/registry.mjs";

const registry = loadRegistry();

describe("merge-scan registration (WM-109)", () => {
  test("merge-scan@1 is a read-only claude agent with no repository workspace", () => {
    const def = registry.agents.get("merge-scan@1");
    expect(def.mutating).toBe(false);
    // It reads PRs via gh, not a source tree — ephemeral, like the other
    // pure-CLI readers (factory-status-report), never a repository checkout.
    expect(def.workspace.type).toBe("ephemeral");
    expect(def.output_contract).toBe("factory.merge-plan/v1");
    expect(def.capabilities.services).toContain("gh:read");
  });

  test("factory.merge.requested maps to merge-scan@1 on the claude adapter, deduped by inputHash", () => {
    const mapping = registry.eventTypes["factory.merge.requested"];
    expect(mapping).toEqual({
      agent: "merge-scan@1",
      adapter: "claude",
      idempotencyScope: ["inputHash"],
      proposalTtlSeconds: 1800,
    });
  });

  test("the plan item shape pins {pr, headSha, ticket} — a moved head is detectable at apply time", () => {
    const item = registry.agents.get("merge-scan@1").outputSchema.properties.plan.items;
    expect(item.required).toEqual(["pr", "headSha", "ticket", "action", "reason"]);
    expect(item.properties.headSha.pattern).toBe("^[0-9a-f]{40}$");
    expect(item.properties.action.enum).toEqual(["merge_pr", "ticket_done"]);
  });
});
