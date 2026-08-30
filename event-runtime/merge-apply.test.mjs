// Side effect: pins FACTORY_EVENT_HOME to a temp dir before any spawned CLI
// (merge-apply.mjs) can resolve the operator's live runtime home.
import "./test-helpers.mjs";
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  commandFixture,
  runCommand,
  writeExecutable,
} from "./test-support/command-fixture.mjs";

const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const MERGE_SHA = "c".repeat(40);
const HEAD_REF = "feat/WM-432";

function applyInput(overrides = {}) {
  return {
    repo: "factory",
    github: "watt-mind/factory",
    base: "develop",
    deployBranch: "master",
    plan: [
      {
        pr: 432,
        headSha: HEAD_SHA,
        baseSha: BASE_SHA,
        headRef: HEAD_REF,
        ticket: "WM-432",
        action: "merge_pr",
        reason: "green",
        checksGreen: true,
        mergeable: true,
        ownedPathsValid: true,
        handoffValid: true,
        testsFalsifiable: true,
        policySafe: true,
        sensitive: false,
        ambiguous: false,
      },
    ],
    ...overrides,
  };
}

function applyCommand(fixture, overrides = {}) {
  writeFileSync(
    path.join(fixture.root, "input.json"),
    `${JSON.stringify(applyInput(overrides), null, 2)}\n`,
  );
  return [
    process.execPath,
    path.join(process.cwd(), "event-runtime/lib/merge-apply.mjs"),
  ];
}

function installFakes(fixture) {
  writeExecutable(
    fixture.bin,
    "factory",
    [
      'echo "factory $*" >> "$COMMAND_LOG"',
      'if [ "${1:-}" = linear ] && [ "${2:-}" = get ]; then',
      '  printf \'{"state":{"name":"In Progress"},"labels":{"nodes":[]}}\\n\'',
      "  exit 0",
      "fi",
      "exit 64",
    ].join("\n"),
  );
  writeExecutable(
    fixture.bin,
    "gh",
    [
      'echo "gh $*" >> "$COMMAND_LOG"',
      'case "$*" in',
      '  *"pr view"*"state,isDraft,mergeable,headRefOid,headRefName,baseRefName,labels"*)',
      '    printf \'{"state":"OPEN","isDraft":false,"mergeable":"MERGEABLE","headRefOid":"%s","headRefName":"%s","baseRefName":"develop","labels":[]}\\n\' "$FAKE_HEAD_SHA" "$FAKE_HEAD_REF" ;;',
      '  *"git/ref/heads/develop"*) printf \'%s\\n\' "$FAKE_BASE_SHA" ;;',
      '  *"pr checks"*"--required --json name,bucket,state"*)',
      '    case "$FAKE_REQUIRED_MODE" in',
      '      no-required) printf "no required checks reported on the \'%s\' branch\\n" "$FAKE_HEAD_REF" >&2; exit 1 ;;',
      "      error) printf 'HTTP 502: upstream unavailable\\n' >&2; exit 1 ;;",
      '      green) printf \'[{"name":"Verify","bucket":"pass","state":"SUCCESS"}]\\n\' ;;',
      "      *) exit 65 ;;",
      "    esac ;;",
      '  *"run list"*"--workflow CI"*"--event pull_request"*)',
      '    case "$FAKE_RUN_MODE" in',
      '      cancelled-live) printf \'[{"databaseId":80,"status":"completed","conclusion":"cancelled","headSha":"%s","workflowName":"CI"},{"databaseId":81,"status":"in_progress","conclusion":null,"headSha":"%s","workflowName":"CI"}]\\n\' "$FAKE_HEAD_SHA" "$FAKE_HEAD_SHA" ;;',
      '      no-live) printf \'[{"databaseId":80,"status":"completed","conclusion":"cancelled","headSha":"%s","workflowName":"CI"}]\\n\' "$FAKE_HEAD_SHA" ;;',
      '      *) printf \'[{"databaseId":81,"status":"completed","conclusion":"success","headSha":"%s","workflowName":"CI"}]\\n\' "$FAKE_HEAD_SHA" ;;',
      "    esac ;;",
      '  *"run view 80"*)',
      '    printf \'[{"name":"Shadow runner fleet available","status":"completed","conclusion":"success"},{"name":"Verify","status":"completed","conclusion":"success"}]\\n\' ;;',
      '  *"run view 81"*)',
      '    if [ "$FAKE_CI_MODE" = missing-job ]; then',
      '      printf \'[{"name":"Shadow runner fleet available","status":"completed","conclusion":"success"}]\\n\'',
      '    elif [ "$FAKE_CI_MODE" = pending-job ]; then',
      '      printf \'[{"name":"Shadow runner fleet available","status":"completed","conclusion":"success"},{"name":"Verify","status":"in_progress","conclusion":null}]\\n\'',
      "    else",
      '      printf \'[{"name":"Shadow runner fleet available","status":"completed","conclusion":"success"},{"name":"Verify","status":"completed","conclusion":"success"}]\\n\'',
      "    fi ;;",
      '  *"pr view"*"--json headRefOid --jq .headRefOid"*) printf \'%s\\n\' "$FAKE_HEAD_SHA" ;;',
      '  *"pr merge"*) : ;;',
      '  *"pr view"*"select(.state"*) printf \'%s\\n\' "$FAKE_MERGE_SHA" ;;',
      "  *) printf 'unexpected gh command: %s\\n' \"$*\" >&2; exit 64 ;;",
      "esac",
    ].join("\n"),
  );
}

function commandEnv(overrides = {}) {
  return {
    FAKE_HEAD_SHA: HEAD_SHA,
    FAKE_BASE_SHA: BASE_SHA,
    FAKE_HEAD_REF: HEAD_REF,
    FAKE_MERGE_SHA: MERGE_SHA,
    FAKE_REQUIRED_MODE: "no-required",
    FAKE_CI_MODE: "success",
    FAKE_RUN_MODE: "single",
    ...overrides,
  };
}

function commandLog(fixture) {
  return existsSync(fixture.log) ? readFileSync(fixture.log, "utf8") : "";
}

function applyResult(fixture) {
  return JSON.parse(
    readFileSync(path.join(fixture.root, "result.json"), "utf8"),
  );
}

describe("merge-apply required-check fallback (WM-432)", () => {
  test("nonzero no-required-checks diagnostic runs the configured workflow and exact-job fallback", () => {
    for (const [ciMode, shouldMerge] of [
      ["success", true],
      ["missing-job", false],
    ]) {
      const fixture = commandFixture(`merge-apply-no-required-${ciMode}-`);
      installFakes(fixture);

      const result = runCommand(
        applyCommand(fixture),
        fixture,
        commandEnv({ FAKE_CI_MODE: ciMode }),
      );

      expect(result.status, `${ciMode}: ${result.stderr}`).toBe(0);
      const log = commandLog(fixture);
      expect(log).toContain("pr checks");
      expect(log).toContain("--required");
      expect(log).toContain("run list");
      expect(log.includes("pr merge")).toBe(shouldMerge);
    }
  });

  test("a different nonzero diagnostic fails closed before fallback or merge", () => {
    const fixture = commandFixture("merge-apply-required-error-");
    installFakes(fixture);

    const result = runCommand(
      applyCommand(fixture),
      fixture,
      commandEnv({ FAKE_REQUIRED_MODE: "error" }),
    );

    expect(result.status, result.stderr).toBe(0);
    const log = commandLog(fixture);
    expect(log).toContain("pr checks");
    expect(log).not.toContain("run list");
    expect(log).not.toContain("pr merge");
  });
});

describe("merge-apply configured workflow proof", () => {
  test("required contexts cannot merge on a cancelled run's stale green while the live run is pending", () => {
    const fixture = commandFixture("merge-apply-cancelled-live-pending-");
    installFakes(fixture);

    const result = runCommand(
      applyCommand(fixture),
      fixture,
      commandEnv({
        FAKE_REQUIRED_MODE: "green",
        FAKE_RUN_MODE: "cancelled-live",
        FAKE_CI_MODE: "pending-job",
      }),
    );

    expect(result.status, result.stderr).toBe(0);
    const log = commandLog(fixture);
    expect(log).toContain("run view 81");
    expect(log).not.toContain("run view 80");
    expect(log).not.toContain("pr merge");
    expect(applyResult(fixture).artifact.skipped[0].reason).toContain(
      "configured CI run 81: required job Verify is not completed successfully",
    );
  });

  test("required contexts and the live run's successful jobs permit merge", () => {
    const fixture = commandFixture("merge-apply-cancelled-live-green-");
    installFakes(fixture);

    const result = runCommand(
      applyCommand(fixture),
      fixture,
      commandEnv({
        FAKE_REQUIRED_MODE: "green",
        FAKE_RUN_MODE: "cancelled-live",
      }),
    );

    expect(result.status, result.stderr).toBe(0);
    const log = commandLog(fixture);
    expect(log).toContain("run view 81");
    expect(log).not.toContain("run view 80");
    expect(log).toContain("pr merge");
  });

  test("green required contexts skip an unconfigured repo instead of aborting the apply run", () => {
    const fixture = commandFixture("merge-apply-green-unconfigured-repo-");
    installFakes(fixture);

    const result = runCommand(
      applyCommand(fixture, { repo: "not-in-repos-yaml" }),
      fixture,
      commandEnv({ FAKE_REQUIRED_MODE: "green" }),
    );

    expect(result.status, result.stderr).toBe(0);
    const log = commandLog(fixture);
    expect(log).toContain("pr checks");
    expect(log).not.toContain("run list");
    expect(log).not.toContain("pr merge");
    const reason = applyResult(fixture).artifact.skipped[0].reason;
    expect(reason).toContain("merge_ci repo record unavailable:");
    expect(reason).toContain(
      'repo "not-in-repos-yaml" is not in config/repos.yaml',
    );
  });

  test("green required contexts fail closed without a non-cancelled configured run", () => {
    const fixture = commandFixture("merge-apply-green-no-live-");
    installFakes(fixture);

    const result = runCommand(
      applyCommand(fixture),
      fixture,
      commandEnv({
        FAKE_REQUIRED_MODE: "green",
        FAKE_RUN_MODE: "no-live",
      }),
    );

    expect(result.status, result.stderr).toBe(0);
    const log = commandLog(fixture);
    expect(log).toContain("run list");
    expect(log).not.toContain("run view");
    expect(log).not.toContain("pr merge");
    expect(applyResult(fixture).artifact.skipped[0].reason).toContain(
      "configured non-cancelled workflow run is missing or ambiguous",
    );
  });
});
