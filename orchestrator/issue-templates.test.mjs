/**
 * The agent-ready issue form must produce Owned Paths the real parser accepts
 * (WM-1013).
 *
 * This is not a formality. `parseOwnedPaths` keeps only bullet lines, fenced
 * blocks, and indented blocks — a plain unindented list is silently dropped.
 * The first draft of this form used plain lines, and every task filed through
 * it would have parsed to zero Owned Paths: undispatchable, or worse,
 * dispatched with a narrower scope than the author wrote. The form and the
 * parser have to be checked against each other, not assumed compatible.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseOwnedPaths } from "./owned-paths.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FORM = path.join(
  ROOT,
  ".github",
  "ISSUE_TEMPLATE",
  "agent_ready_task.yml",
);

/** How GitHub renders a completed issue form: "### <label>\n\n<value>". */
function renderedIssueBody(ownedPathsValue) {
  return [
    "### Problem & Context",
    "",
    "Doctor reports a missing CLI as an unknown error.",
    "",
    "### Acceptance Criteria",
    "",
    "- [ ] names the missing binary",
    "",
    "### Source File Pointers",
    "",
    "* `orchestrator/doctor.mjs` — the check",
    "",
    "### Owned Paths",
    "",
    ownedPathsValue,
    "",
    "### Verification Command",
    "",
    "```",
    "bun test --timeout 20000 event-runtime/lib && bun run lint",
    "```",
    "",
  ].join("\n");
}

describe("agent-ready issue form", () => {
  const form = readFileSync(FORM, "utf8");

  test("carries all five protocol sections", () => {
    for (const label of [
      "Problem & Context",
      "Acceptance Criteria",
      "Source File Pointers",
      "Owned Paths",
      "Verification Command",
    ]) {
      expect(form).toContain(`label: ${label}`);
    }
  });

  test("its Owned Paths output parses to the paths the author typed", () => {
    const body = renderedIssueBody(
      ["- orchestrator/doctor.mjs", "- docs/quickstart.md"].join("\n"),
    );
    expect(parseOwnedPaths(body)).toEqual([
      "orchestrator/doctor.mjs",
      "docs/quickstart.md",
    ]);
  });

  test("the field pre-seeds bullets, because plain lines parse to nothing", () => {
    // Guards the exact regression this test was written for.
    expect(
      parseOwnedPaths(renderedIssueBody("orchestrator/doctor.mjs")),
    ).toEqual([]);
    // ...so the form must hand the author a bullet to type after.
    const ownedBlock = form.slice(form.indexOf("id: owned_paths"));
    expect(ownedBlock.slice(0, ownedBlock.indexOf("validations"))).toContain(
      "value: |",
    );
  });

  test("globs survive, since tight globs are the documented norm", () => {
    expect(
      parseOwnedPaths(renderedIssueBody("- event-runtime/agents/*.json")),
    ).toEqual(["event-runtime/agents/*.json"]);
  });

  test("does not apply ai:agent-ready — dispatch stays maintainer-gated", () => {
    // On a public repo only users with triage permission can set labels, so
    // "anyone files, only a maintainer queues" is enforced by GitHub itself.
    // The form must not undo that by requesting the label up front.
    expect(form).not.toContain("ai:agent-ready\n");
    expect(form).toContain("source:human");
  });
});
