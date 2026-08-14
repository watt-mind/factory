/**
 * Ship chain (WM-111): ship-scan@1 assembles the release candidate — base
 * ahead of the deploy branch, real checks green on the head commit, changelog
 * of shipped tickets — and emits a typed, double-SHA-pinned plan. The watched
 * approval of the chained ship-apply proposal IS the human deploy-branch
 * decision (docs/event-runtime-dispatch.md §7): it is permanently watched,
 * structurally — auto approval of the ship-apply event type cannot load and
 * cannot execute. Follows the merge chain precedent (WM-109).
 */
import { describe, expect, test } from "bun:test";
import { loadRegistry } from "./lib/registry.mjs";

const registry = loadRegistry();

describe("ship-scan registration (WM-111)", () => {
  test("ship-scan@1 is a read-only claude agent with no repository workspace", () => {
    const def = registry.agents.get("ship-scan@1");
    expect(def.mutating).toBe(false);
    // It reads branches and CI via gh, not a source tree — ephemeral, like
    // merge-scan, never a repository checkout.
    expect(def.workspace.type).toBe("ephemeral");
    expect(def.output_contract).toBe("factory.ship-plan/v1");
    expect(def.capabilities.services).toContain("gh:read");
  });

  test("factory.ship.requested maps to ship-scan@1 on the claude adapter, deduped by inputHash", () => {
    expect(registry.eventTypes["factory.ship.requested"]).toEqual({
      agent: "ship-scan@1",
      adapter: "claude",
      idempotencyScope: ["inputHash"],
      proposalTtlSeconds: 1800,
    });
  });

  test("the artifact pins BOTH branch tips — a moved base or deploy head is detectable at apply time", () => {
    const props = registry.agents.get("ship-scan@1").outputSchema.properties;
    expect(props.headSha.pattern).toBe("^[0-9a-f]{40}$");
    expect(props.deployHeadSha.pattern).toBe("^[0-9a-f]{40}$");
    expect(props.recommendation.enum).toEqual(["SHIP", "NOOP"]);
    // The plan is the closed ship set, nothing else nameable.
    expect(props.plan.items.properties.action.enum).toEqual(["open_rc_pr", "merge_rc_pr", "smoke_check"]);
    // NOOP is typed: not ahead, CI red/pending, no real checks, or no deploy config.
    expect(props.noopReason.enum).toEqual(["not_ahead", "ci_red", "ci_pending", "no_checks", "no_deploy_config"]);
  });
});
