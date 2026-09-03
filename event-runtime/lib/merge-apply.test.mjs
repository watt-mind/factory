import "../test-helpers.mjs";
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  commandFixture,
  runCommand,
  writeExecutable,
} from "../test-support/command-fixture.mjs";

const BASE_SHA = "b".repeat(40);
const HEAD_SHA = "a".repeat(40);

function installFakes(fixture) {
  writeExecutable(
    fixture.bin,
    "factory",
    [
      'echo "factory $*" >> "$COMMAND_LOG"',
      'printf \'{"state":{"name":"In Progress"},"labels":{"nodes":[{"name":"ai:escalated"}]}}\\n\'',
    ].join("\n"),
  );
  writeExecutable(
    fixture.bin,
    "gh",
    [
      'echo "gh $*" >> "$COMMAND_LOG"',
      'case "$*" in',
      '  *"pr view"*) printf \'{"state":"OPEN","isDraft":false,"mergeable":"MERGEABLE","headRefOid":"%s","headRefName":"feat/test","baseRefName":"develop","labels":[]}\\n\' "$FAKE_HEAD_SHA" ;;',
      '  *"git/ref/heads/develop"*) printf "%s\\n" "$FAKE_BASE_SHA" ;;',
      '  *) printf "unexpected gh command: %s\\n" "$*" >&2; exit 64 ;;',
      "esac",
    ].join("\n"),
  );
}

function runApply(ticket) {
  const fixture = commandFixture("merge-apply-linear-repo-");
  installFakes(fixture);
  writeFileSync(
    path.join(fixture.root, "input.json"),
    `${JSON.stringify({
      repo: "bj29",
      github: "watt-mind/bj29",
      base: "develop",
      plan: [
        {
          pr: 42,
          headSha: HEAD_SHA,
          baseSha: BASE_SHA,
          headRef: "feat/test",
          ticket,
        },
      ],
    })}\n`,
  );
  const result = runCommand(
    [
      process.execPath,
      path.join(process.cwd(), "event-runtime/lib/merge-apply.mjs"),
    ],
    fixture,
    { FAKE_BASE_SHA: BASE_SHA, FAKE_HEAD_SHA: HEAD_SHA },
  );
  expect(result.status, result.stderr).toBe(0);
  return existsSync(fixture.log) ? readFileSync(fixture.log, "utf8") : "";
}

describe("merge-apply Linear repo routing", () => {
  test.each(["CLNT-616", "owner/repo#616"])(
    "passes the batch repo to Linear get for %s",
    (ticket) => {
      expect(runApply(ticket)).toContain(
        `factory linear get ${ticket} --json --repo bj29`,
      );
    },
  );
});
