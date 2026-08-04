/**
 * bun test
 *
 * The label logic is the dangerous part. Linear's issueUpdate takes the
 * COMPLETE label set rather than a delta, so a function that returns "the
 * labels to add" instead of "the labels the ticket should end up with" silently
 * strips every other label on the ticket. That is data loss with no error, on
 * tickets a human curated — so it gets real tests.
 */
import { test, expect } from "bun:test";
import { resolveLabelIds, claimLabels, validateLabels, formatTicket, agentLabel, TYPE_LABELS } from "./linear.mjs";

const LABELS = [
  { id: "l-ready", name: "ai:agent-ready" },
  { id: "l-prog", name: "ai:in-progress" },
  { id: "l-claude", name: "agent:claude-code" },
  { id: "l-codex", name: "agent:codex" },
  { id: "l-bug", name: "type:bug" },
  { id: "l-area", name: "area:api" },
  { id: "l-review", name: "ai:needs-review" },
];

// ------------------------------------------------------------ label math ---
test("adding a label KEEPS the labels already on the ticket", () => {
  const ids = resolveLabelIds(["type:bug", "area:api"], { add: ["ai:needs-review"] }, LABELS);
  expect(ids).toContain("l-bug");
  expect(ids).toContain("l-area");
  expect(ids).toContain("l-review");
  expect(ids).toHaveLength(3);
});

test("removing takes out only the named label", () => {
  const ids = resolveLabelIds(["type:bug", "ai:agent-ready"], { remove: ["ai:agent-ready"] }, LABELS);
  expect(ids).toEqual(["l-bug"]);
});

test("unknown label names are dropped rather than sent as undefined ids", () => {
  // A stale label removed from the workspace must not become `undefined` in the
  // mutation array — Linear rejects the whole update, losing the state change.
  const ids = resolveLabelIds(["type:bug", "area:deleted-label"], { add: [] }, LABELS);
  expect(ids).toEqual(["l-bug"]);
});

test("the result never contains duplicates", () => {
  const ids = resolveLabelIds(["type:bug"], { add: ["type:bug"] }, LABELS);
  expect(ids).toEqual(["l-bug"]);
});

// ----------------------------------------------------------------- claim ---
test("the claude harness maps to the label that actually exists in Linear", () => {
  // `claude` on the CLI is `agent:claude-code` in the workspace. Getting this
  // wrong fails silently: unresolved ids are filtered out, so the ticket simply
  // never records which harness holds it.
  expect(agentLabel("claude")).toBe("agent:claude-code");
  expect(agentLabel("codex")).toBe("agent:codex");
  expect(agentLabel("gemini")).toBe("agent:gemini");
});

test("claiming drops agent-ready and adds in-progress plus the harness label", () => {
  const { add, remove } = claimLabels(["ai:agent-ready", "type:bug"], "claude");
  expect(add).toEqual(["ai:in-progress", "agent:claude-code"]);
  expect(remove).toContain("ai:agent-ready");

  const ids = resolveLabelIds(["ai:agent-ready", "type:bug"], { add, remove }, LABELS);
  expect(ids).toContain("l-prog");
  expect(ids).toContain("l-claude");
  expect(ids).toContain("l-bug");           // curated label survives
  expect(ids).not.toContain("l-ready");     // lifecycle flag replaced
});

test("re-claiming on a different harness does not leave two agent:* labels", () => {
  const { add, remove } = claimLabels(["agent:codex", "ai:in-progress"], "claude");
  expect(remove).toContain("agent:codex");
  const ids = resolveLabelIds(["agent:codex", "ai:in-progress"], { add, remove }, LABELS);
  expect(ids).toContain("l-claude");
  expect(ids).not.toContain("l-codex");
});

// ------------------------------------------------------------ validation ---
test("type:chore is rejected with the list of values that work", () => {
  const bad = validateLabels(["type:chore"]);
  expect(bad).toHaveLength(1);
  expect(bad[0]).toContain("maintenance");
});

test("every documented type:* value passes", () => {
  expect(validateLabels(TYPE_LABELS.map((t) => `type:${t}`))).toEqual([]);
});

test("an unknown source:* is rejected; area:* is free-form and is not", () => {
  expect(validateLabels(["source:invented"])).toHaveLength(1);
  expect(validateLabels(["source:agent", "area:anything-goes"])).toEqual([]);
});

// -------------------------------------------------------------- rendering ---
test("formatTicket shows the fields the protocol acts on", () => {
  const text = formatTicket({
    identifier: "CLNT-616", title: "Fix login", url: "https://linear.app/x/CLNT-616",
    state: { name: "Todo" }, assignee: null,
    labels: { nodes: [{ name: "ai:agent-ready" }] },
  });
  expect(text).toContain("CLNT-616");
  expect(text).toContain("Todo");
  expect(text).toContain("(unassigned)");
  expect(text).toContain("ai:agent-ready");
});
