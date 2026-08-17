import { describe, expect, test } from "bun:test";
import { REASONS, humanizeReason } from "./reasons";

describe("humanizeReason (WM-594)", () => {
  test("known planner and worker codes read as sentences and keep the raw code", () => {
    expect(humanizeReason("owned_paths_overlap")).toEqual({
      text: "Owned paths overlap",
      raw: "owned_paths_overlap",
    });
    expect(humanizeReason("needs_human").text).toBe("Needs human");
    expect(humanizeReason("ticket_security").text).toBe("Ticket is security-labelled");
    expect(humanizeReason("merge_fix_pr_moved").text).toBe("PR head moved since the plan");
    expect(humanizeReason("sandbox_unavailable").text).toBe("Sandbox unavailable");
    expect(humanizeReason("timeout").text).toBe("Timed out");
    expect(humanizeReason("contract_violation").text).toBe("Output contract violated");
    expect(humanizeReason("cli_not_found").text).toBe("Agent CLI not found");
  });

  test("the vocabulary the ticket names is all covered", () => {
    for (const code of [
      "owned_paths_overlap",
      "ticket_assigned",
      "ticket_dispatch_already_live",
      "ticket_security",
      "ticket_escalated",
      "owned_paths_unknown",
      "owned_paths_not_closed",
      "auto_approval_ineligible",
      "proposal_expired",
      "repo_unconfigured",
      "capacity_full",
      "merge_fix_pr_moved",
      "needs_human",
      "contract_violation",
      "timeout",
      "cli_not_found",
      "sandbox_unsupported",
      "sandbox_unavailable",
    ]) {
      expect(REASONS[code]).toBeTruthy();
    }
  });

  test("unknown codes fall back to the code with underscores dropped, suffix kept as detail", () => {
    expect(humanizeReason("some_new_code")).toEqual({ text: "some new code", raw: "some_new_code" });
    expect(humanizeReason("some_new_code:extra_detail").text).toBe("some new code — extra detail");
    // The message after the colon is one free-text fragment, colons and all.
    expect(humanizeReason("repo_unknown: no repo named x: y").text).toBe(
      "Repo is not configured — no repo named x: y",
    );
  });

  test("agent_exit_N is one family", () => {
    expect(humanizeReason("agent_exit_1").text).toBe("Agent exited with code 1");
    expect(humanizeReason("agent_exit_143").text).toBe("Agent exited with code 143");
  });

  test("chained codes humanize every known fragment", () => {
    expect(humanizeReason("auto_approval_ineligible:proposal_expired").text).toBe(
      "Not eligible for auto-approval — Proposal expired",
    );
    expect(
      humanizeReason("ticket_dispatch_already_live:run_6fe0cdb4-bb4b-4bcb-ae3a-638dd704a42d:same_ticket_worktree_held")
        .text,
    ).toBe(
      "A dispatch for this ticket is already live — run_6fe0cdb4-bb4b-4bcb-ae3a-638dd704a42d · its worktree is still held",
    );
    expect(humanizeReason("policy_denied:Bash").text).toBe("Policy denied tool — Bash");
  });

  test("extracts run, proposal and ticket references from the suffix", () => {
    const live = humanizeReason("ticket_dispatch_already_live:run_abc-123:same_ticket_worktree_held");
    expect(live.refs).toEqual({ runId: "run_abc-123" });
    // The identifier survives verbatim inside the sentence, so callers can link it.
    expect(live.text).toContain("run_abc-123");

    const held = humanizeReason("owned_paths_overlap:held by WM-544 (run_x9)");
    expect(held.refs).toEqual({ runId: "run_x9", ticket: "WM-544" });
    expect(held.text).toBe("Owned paths overlap — held by WM-544 (run_x9)");

    const prop = humanizeReason("auto_approval_ineligible:merge_barrier_uncertain:prop_0192abc");
    expect(prop.refs).toEqual({ proposalId: "prop_0192abc" });

    expect(humanizeReason("owned_paths_overlap").refs).toBeUndefined();
    expect(humanizeReason("run_cancelled").refs).toBeUndefined();
  });

  test("free-text reasons come back verbatim, still with refs", () => {
    const r = humanizeReason("WM-328 is already in flight (duplicate proposal)");
    expect(r.text).toBe("WM-328 is already in flight (duplicate proposal)");
    expect(r.raw).toBe("WM-328 is already in flight (duplicate proposal)");
    expect(r.refs).toEqual({ ticket: "WM-328" });
  });

  test("null, undefined and blank are empty, not 'null'", () => {
    expect(humanizeReason(null)).toEqual({ text: "", raw: null });
    expect(humanizeReason(undefined)).toEqual({ text: "", raw: null });
    expect(humanizeReason("   ")).toEqual({ text: "", raw: null });
  });
});
