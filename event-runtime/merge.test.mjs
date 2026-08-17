import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { substituteArgv } from "./lib/adapters/actions.mjs";
import { resolveTemplate } from "./lib/adapters/command.mjs";
import { resolveChains } from "./lib/chain.mjs";
import { canonicalJson } from "./lib/canonical.mjs";
import { openDb } from "./lib/db.mjs";
import { admitEvent as persistEvent } from "./lib/intake.mjs";
import { planAdmittedEvents } from "./lib/planner.mjs";
import { approveProposal, openProposals } from "./lib/proposals.mjs";
import { loadRegistry } from "./lib/registry.mjs";
import { validate } from "./lib/schema.mjs";
import { runOnce } from "./lib/worker.mjs";
import {
  commandFixture,
  runCommand,
  writeExecutable,
} from "./test-support/command-fixture.mjs";

const registry = loadRegistry();
const SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const MERGE_SHA = "c".repeat(40);
const FINDING_HASH = "d".repeat(64);
const PV = "git:test";

const candidate = (pr = 42, ticket = "WM-500") => ({
  pr,
  headSha: SHA,
  baseSha: BASE_SHA,
  headRef: `feat/${ticket}`,
  ticket,
  action: "merge_pr",
  reason: "cold review passed",
  checksGreen: true,
  mergeable: true,
  ownedPathsValid: true,
  handoffValid: true,
  testsFalsifiable: true,
  policySafe: true,
  sensitive: false,
  ambiguous: false,
});

const applyPayload = (pr = 42, ticket = "WM-500") => ({
  repo: "factory",
  github: "watt-mind/factory",
  base: "develop",
  deployBranch: "master",
  plan: [candidate(pr, ticket)],
});

function envelope(type, payload, id) {
  return {
    schemaVersion: "factory.event/v1",
    eventId: id,
    type,
    source: "chain",
    subject: payload.repo,
    occurredAt: "2026-08-16T12:00:00.000Z",
    correlationId: id,
    causationId: "parent-run",
    payload,
  };
}

function installMergeCommandFakes(fixture) {
  writeExecutable(
    fixture.bin,
    "factory",
    [
      'echo "factory $*" >> "$COMMAND_LOG"',
      'if [ "${1:-}" = linear ] && [ "${2:-}" = get ]; then',
      '  case "${FAKE_LINEAR_MODE:-valid}" in',
      '    error) exit 3 ;;',
      '    empty) exit 0 ;;',
      "    malformed) printf 'not-json\\n'; exit 0 ;;",
      "    security) printf '{\"state\":{\"name\":\"In Progress\"},\"labels\":{\"nodes\":[{\"name\":\"type:security\"}]}}\\n'; exit 0 ;;",
      "    *) printf '{\"state\":{\"name\":\"In Progress\"},\"labels\":{\"nodes\":[]}}\\n'; exit 0 ;;",
      '  esac',
      'fi',
      'if [ "${1:-}" = branch-guard ]; then',
      '  exit "${FAKE_BRANCH_GUARD_STATUS:-2}"',
      'fi',
      'exit 0',
    ].join("\n"),
  );
  writeExecutable(
    fixture.bin,
    "sleep",
    String.raw`exit 0`,
  );
  writeExecutable(
    fixture.bin,
    "gh",
    [
      'echo "gh $*" >> "$COMMAND_LOG"',
      'case "$*" in',
      '  *"pr view"*"state,isDraft,mergeable,headRefOid,headRefName,baseRefName,labels"*)',
      "    printf '{\"state\":\"OPEN\",\"isDraft\":false,\"mergeable\":\"MERGEABLE\",\"headRefOid\":\"%s\",\"headRefName\":\"%s\",\"baseRefName\":\"develop\",\"labels\":[]}\\n' \"$FAKE_HEAD_SHA\" \"$FAKE_HEAD_REF\" ;;",
      "  *\"git/ref/heads/develop\"*) printf '%s\\n' \"$FAKE_BASE_SHA\" ;;",
      '  *"pr checks"*"--required --json name,bucket,state"*)',
      '    case "${FAKE_REQUIRED_MODE:-empty}" in',
      "      green) printf '[{\"name\":\"Protected Verify\",\"bucket\":\"pass\",\"state\":\"SUCCESS\"}]\\n' ;;",
      "      pending) printf '[{\"name\":\"Protected Verify\",\"bucket\":\"pending\",\"state\":\"PENDING\"}]\\n' ;;",
      "      duplicate) printf '[{\"name\":\"Protected Verify\",\"bucket\":\"pass\",\"state\":\"SUCCESS\"},{\"name\":\"Protected Verify\",\"bucket\":\"pass\",\"state\":\"SUCCESS\"}]\\n' ;;",
      "      status-zero-empty) printf '[]\\n' ;;",
      "      unquoted) printf 'no required checks reported on the %s branch\\n' \"$FAKE_HEAD_REF\"; exit 1 ;;",
      "      *) printf \"no required checks reported on the '%s' branch\\n\" \"$FAKE_HEAD_REF\"; exit 1 ;;",
      '    esac ;;',
      '  *"pr merge"*) : ;;',
      "  *\"pr view\"*\"--json headRefOid --jq .headRefOid\"*) printf '%s\\n' \"$FAKE_HEAD_SHA\" ;;",
      "  *\"pr view\"*\"select(.state\"*) printf '%s\\n' \"$FAKE_MERGE_SHA\" ;;",
      "  *\"pr view\"*\"@tsv\"*) printf 'MERGED\\t%s\\n' \"$FAKE_MERGE_SHA\" ;;",
      "  *\"pr view\"*\"--jq .state\"*) printf 'MERGED\\n' ;;",
      "  *\"pr view\"*\"--jq .mergeCommit.oid\"*) printf '%s\\n' \"$FAKE_MERGE_SHA\" ;;",
      "  *\"pr checks\"*\"--json name,bucket,state,workflow\"*) printf '[{\"name\":\"Shadow runner fleet available\",\"bucket\":\"pass\",\"state\":\"SUCCESS\",\"workflow\":\"CI\"},{\"name\":\"Verify\",\"bucket\":\"pass\",\"state\":\"SUCCESS\",\"workflow\":\"CI\"}]\\n' ;;",
      '  *"run list"*"--workflow CI"*"--event pull_request"*)',
      "    printf '[{\"databaseId\":81,\"status\":\"completed\",\"conclusion\":\"success\",\"headSha\":\"%s\",\"workflowName\":\"CI\"}]\\n' \"$FAKE_HEAD_SHA\" ;;",
      '  *"run list"*"--workflow CI"*"--event push"*)',
      "    if [ \"${FAKE_CI_MODE:-success}\" = auxiliary ]; then printf '[]\\n'; else printf '[{\"databaseId\":91,\"status\":\"completed\",\"conclusion\":\"success\",\"headSha\":\"%s\",\"workflowName\":\"CI\"}]\\n' \"$FAKE_MERGE_SHA\"; fi ;;",
      '  *"run view 81"*|*"run view 91"*)',
      "    if [ \"${FAKE_CI_MODE:-success}\" = shadow-only ]; then printf '[{\"name\":\"Shadow runner fleet available\",\"status\":\"completed\",\"conclusion\":\"success\"}]\\n'; else printf '[{\"name\":\"Shadow runner fleet available\",\"status\":\"completed\",\"conclusion\":\"success\"},{\"name\":\"Verify\",\"status\":\"completed\",\"conclusion\":\"success\"}]\\n'; fi ;;",
      "  *\"commits/\"*\"/check-runs\"*) printf '[[\"completed\",\"success\"]]\\n' ;;",
      "  *\"git/ref/heads/\"*) printf '%s\\n' \"$FAKE_HEAD_SHA\" ;;",
      '  *"git/refs/heads/"*) : ;;',
      '  *) echo "unexpected gh command: $*" >&2; exit 64 ;;',
      'esac',
    ].join("\n"),
  );
}

function installBunGateFake(fixture) {
  writeExecutable(
    fixture.bin,
    "bun",
    [
      'case "$*" in',
      '  *"r.mergeCi"*) printf \'{"workflow":"CI","requiredChecks":["Shadow runner fleet available","Verify"]}\' ;;',
      '  *) exit 0 ;;',
      'esac',
    ].join("\n"),
  );
}

function applyCommand(input) {
  const def = registry.agents.get("merge-apply@2");
  const item = input.plan[0];
  return substituteArgv(def.actionRegistry.merge_pr.argv, {
    ...input,
    ...item,
    factoryRoot: process.cwd(),
  });
}

function verifyCommand(input) {
  return resolveTemplate(registry.agents.get("merge-verify@1").command, input);
}

function commandEnv(overrides = {}) {
  return {
    FAKE_HEAD_SHA: SHA,
    FAKE_BASE_SHA: BASE_SHA,
    FAKE_HEAD_REF: "feat/WM-500",
    FAKE_MERGE_SHA: MERGE_SHA,
    ...overrides,
  };
}

function admitEvent(db, registryForAdmission, env) {
  const parent = `parent-${env.eventId}`;
  if (env.type === "factory.merge-landed") {
    const p = env.payload;
    seedCompleted(db, {
      runId: parent,
      agent: "merge-apply@2",
      input: {
        repo: p.repo,
        github: p.github,
        base: p.base,
        deployBranch: "master",
        plan: [
          {
            ...candidate(p.pr, p.ticket),
            headSha: p.headSha,
            headRef: p.headRef,
          },
        ],
      },
      artifact: {
        repo: p.repo,
        applied: [{ issueId: p.ticket, action: "merge_pr" }],
      },
    });
  } else {
    const recommendation =
      env.type === "factory.merge-apply.requested"
        ? "MERGE"
        : env.type === "factory.merge-fix.requested"
          ? "FIX"
          : "UPDATED";
    let artifact;
    if (recommendation === "MERGE") {
      artifact = {
        recommendation,
        ...env.payload,
        fix: [],
        escalate: [],
        summary: "one selected merge",
      };
    } else if (recommendation === "FIX") {
      const { repo, github, base, deployBranch = "master", ...fixItem } =
        env.payload;
      artifact = {
        recommendation,
        repo,
        github,
        base,
        deployBranch,
        plan: [],
        fix: [fixItem],
        escalate: [],
        summary: "one selected fix",
      };
    } else {
      artifact = {
        recommendation,
        outcome: recommendation,
        repo: env.payload.repo,
      };
    }
    seedCompleted(db, {
      runId: parent,
      agent: recommendation === "UPDATED" ? "merge-fix@1" : "merge-scan@2",
      input: env.payload,
      artifact,
    });
  }
  return persistEvent(
    db,
    registryForAdmission,
    { ...env, causationId: parent },
  );
}

function seedCompleted(db, { runId, agent, input, artifact }) {
  const now = "2026-08-16T12:00:00.000Z";
  const eventId = `event-${runId}`;
  db.query(
    `INSERT INTO events (source,event_id,type,subject,occurred_at,received_at,correlation_id,envelope_json,payload_hash,status,admitted_at)
     VALUES ('operator',?,'test.event','test',?,?,?,?,'hash','planned',?)`,
  ).run(eventId, now, now, eventId, canonicalJson({ payload: input }), now);
  db.query(
    `INSERT INTO runs (run_id,idempotency_key,spec_json,spec_hash,state,attempts,created_at,updated_at)
     VALUES (?,?,?,'hash','COMPLETED',1,?,?)`,
  ).run(runId, `idem-${runId}`, canonicalJson({ agent, input }), now, now);
  db.query(
    `INSERT INTO proposals (id,event_source,event_id,run_id,decision,spec_json,status,created_at,ttl_seconds)
     VALUES (?,'operator',?,?,'run',?,'approved',?,1800)`,
  ).run(
    `proposal-${runId}`,
    eventId,
    runId,
    canonicalJson({ agent, input }),
    now,
  );
  db.query(
    `INSERT INTO results (run_id,attempt,result_json,artifact_hash,verification_json,receipt_json,accepted_at)
     VALUES (?,1,?,'hash','{}','{}',?)`,
  ).run(runId, canonicalJson({ artifact }), now);
}

describe("merge-fix result contract (WM-447)", () => {
  test("UPDATED and BLOCKED prompt artifacts exactly match the registered schema", () => {
    const def = registry.agents.get("merge-fix@1");
    const schema = def.outputSchema;
    const prompt = readFileSync(def.promptPath, "utf8");
    const declaration = prompt.match(
      /Both artifacts must\s+contain exactly these properties, in this order:([\s\S]*?)\. Do not add/,
    );

    expect(declaration).not.toBeNull();
    expect(
      [...declaration[1].matchAll(/`([^`]+)`/g)].map((match) => match[1]),
    ).toEqual(schema.required);

    for (const outcome of ["UPDATED", "BLOCKED"]) {
      const example = prompt.match(
        new RegExp(
          `### ${outcome} artifact[\\s\\S]*?` +
            "```json\\n([\\s\\S]*?)\\n```",
        ),
      );

      expect(example).not.toBeNull();
      const artifact = JSON.parse(example[1]);
      expect(Object.keys(artifact)).toEqual(schema.required);
      expect(artifact.outcome).toBe(outcome);
      expect(validate(schema, artifact)).toEqual({ valid: true, errors: [] });
    }
  });

  test("BLOCKED explicitly retains the pinned input head SHA", () => {
    const prompt = readFileSync(
      registry.agents.get("merge-fix@1").promptPath,
      "utf8",
    );

    expect(prompt).toMatch(
      /Use the pinned `input\.json` `headSha` as the required `headSha`, including when\s+the live PR head moved/,
    );
  });
});

describe("durable autonomous merge registry (WM-398/WM-403)", () => {
  test("central mappings register scan, bounded fix, deterministic apply, landed verify, and explicit verify", () => {
    expect(registry.eventTypes["factory.merge.requested"]).toMatchObject({
      agent: "merge-scan@2",
      adapter: "cursor",
    });
    expect(registry.eventTypes["factory.merge-fix.requested"]).toMatchObject({
      agent: "merge-fix@1",
      adapter: "cursor",
    });
    expect(registry.eventTypes["factory.merge-apply.requested"].agent).toBe(
      "merge-apply@2",
    );
    expect(registry.eventTypes["factory.merge-landed"].agent).toBe(
      "merge-verify@1",
    );
    expect(registry.eventTypes["factory.merge-verify.requested"].agent).toBe(
      "merge-verify@1",
    );
    expect(
      registry.agents.get("merge-fix@1").inputSchema.properties.round.maximum,
    ).toBe(2);
  });

  test("cold plan pins head and base, permits one PR, and records every policy proof", () => {
    const plan =
      registry.agents.get("merge-scan@2").outputSchema.properties.plan;
    expect(plan.maxItems).toBe(1);
    expect(plan.items.required).toContain("baseSha");
    expect(plan.items.required).toContain("testsFalsifiable");
    expect(plan.items.properties.sensitive.const).toBe(false);
    expect(plan.items.properties.ambiguous.const).toBe(false);
  });

  test("apply has one action and cannot mark Done or delete a branch", () => {
    const def = registry.agents.get("merge-apply@2");
    expect(Object.keys(def.actionRegistry)).toEqual(["merge_pr"]);
    const script = def.actionRegistry.merge_pr.argv[2];
    expect(script).toContain("--match-head-commit");
    expect(script).toContain("actual_base");
    expect(script).toContain("isDraft");
    expect(script).toContain("--required --json name,bucket,state");
    expect(script).toContain("mergeCi");
    expect(script).toContain("factory.merge-landed");
    expect(script).toContain("{repo:p.REPO,prNumbers:[Number(p.PR)]}");
    expect(script).toContain("`merge-refresh:${p.REPO}:${p.PR}:${p.HEAD}`");
    expect(script).not.toContain("--delete-branch");
    expect(script).not.toContain(" Done ");
  });

  test("merge verifier command loads and resolves only declared input templates", () => {
    const def = registry.agents.get("merge-verify@1");
    expect(def).toBeTruthy();
    expect([...def.command[2].matchAll(/\{([A-Za-z0-9_]+)\}/g)]).toEqual([]);
    expect(
      resolveTemplate(def.command, {
        repo: "factory",
        github: "watt-mind/factory",
        base: "develop",
        pr: 398,
        ticket: "WM-398",
        headSha: SHA,
        headRef: "feat/WM-398",
        mergeCommitSha: MERGE_SHA,
      }),
    ).toHaveLength(def.command.length);
  });

  test("verify waits on exact merge SHA, blocks and notifies red, then performs exact cleanup and Done", () => {
    const script = registry.agents.get("merge-verify@1").command[2];
    expect(script).toContain('--workflow "$workflow" --event push');
    expect(script).toContain('run view "$run_id"');
    expect(script).toContain('--commit "$merge"');
    expect(script).toContain("CI RED");
    expect(script).toContain("SMOKE RED");
    expect(script).toContain("git/ref/heads/$headref");
    expect(script).toContain("HTTP 404"); // exact prior cleanup is replay-safe
    expect(script).toContain('linear state "$ticket" Done');
    expect(script.indexOf('linear state "$ticket" Done')).toBeGreaterThan(
      script.indexOf('run view "$run_id"'),
    );
  });

  test("all enabled merge schedules are singleton autonomous cold scans", () => {
    const schedules = Object.entries(registry.schedules).filter(
      ([name, schedule]) => name.startsWith("merge-") && schedule.enabled,
    );
    expect(schedules.map(([name]) => name)).toEqual(["merge-factory"]);
    for (const [, schedule] of schedules) {
      expect(schedule).toMatchObject({
        every: "15m",
        eventType: "factory.merge.requested",
        singleton: true,
        approval: "auto",
        enabled: true,
      });
    }
  });
});

describe("merge-scan selected PR contract (WM-426)", () => {
  test("the input schema declares an optional nonempty list of positive PR numbers", () => {
    const prNumbers = registry.agents.get("merge-scan@2").inputSchema.properties.prNumbers;
    expect(prNumbers.type).toBe("array");
    expect(prNumbers.minItems).toBe(1);
    expect(prNumbers.items).toEqual({ type: "integer", minimum: 1 });
    expect(registry.agents.get("merge-scan@2").inputSchema.required).not.toContain("prNumbers");
  });

  test("the prompt scopes selected scans exactly and fails invalid targets closed", () => {
    const prompt = readFileSync(registry.agents.get("merge-scan@2").promptPath, "utf8");
    expect(prompt).toContain("`prNumbers` is absent");
    expect(prompt).toContain("exactly those PR numbers");
    expect(prompt).toMatch(/missing, closed, draft, or targets a\s+base other than/);
    expect(prompt).toContain('"terminalState": "refused"');
    expect(prompt).toMatch(/evidence clearly naming every invalid\s+selected PR/);
    expect(prompt).toMatch(/Do not\s+emit a merge-plan artifact/);
  });
});

describe("merge-scan required-context resolution (WM-433)", () => {
  test("scan uses the supported PR query through the deterministic resolver", () => {
    const prompt = readFileSync(
      registry.agents.get("merge-scan@2").promptPath,
      "utf8",
    );

    expect(prompt).toContain(
      'gh pr checks "$pr" --repo "$github" --required --json name,bucket,state',
    );
    expect(prompt).toContain(
      'bun "$FACTORY_ROOT/event-runtime/lib/merge-ci-proof.mjs" resolve-required-contexts',
    );
    expect(prompt).not.toContain(
      "./repo/event-runtime/lib/merge-ci-proof.mjs",
    );
    expect(prompt).toMatch(
      /Status 1 with exactly\s+`no required checks reported on the '<headRef>' branch`/,
    );
    expect(prompt).toContain("`proveMergeCiFallback`");
    expect(prompt).toContain("Do not query");
    expect(prompt).toContain("branches/{branch}/protection");
    expect(prompt).not.toContain(
      "First query GitHub's branch-protection required contexts",
    );
  });

  test("the resolver executes when the selected non-Factory repo has no event-runtime tree", () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), "merge-scan-cross-repo-"));
    const target = path.join(fixture, "repo");
    mkdirSync(target);
    writeFileSync(path.join(target, "README.md"), "# non-Factory fixture\n");

    try {
      const output = execFileSync(
        "sh",
        [
          "-c",
          'bun "$FACTORY_ROOT/event-runtime/lib/merge-ci-proof.mjs" resolve-required-contexts 1 "feat/WM-243"',
        ],
        {
          cwd: fixture,
          encoding: "utf8",
          env: { ...process.env, FACTORY_ROOT: process.cwd() },
          input:
            "no required checks reported on the 'feat/WM-243' branch",
        },
      );

      expect(output).toBe("[]\n");
      expect(existsSync(path.join(target, "event-runtime"))).toBe(false);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe("merge-scan repository workspace and result contract (WM-425)", () => {
  test("the definition and prompt declare the pinned repository contract", () => {
    const def = registry.agents.get("merge-scan@2");
    expect(def.workspace).toEqual({
      type: "repository",
      checkoutDir: "repo",
      retainOnFailure: true,
    });
    expect(def.capabilities.services).toContain("repo:read");
    expect(def.inputSchema.properties.repoPin.required).toEqual(["repo", "sha"]);
    expect(def.inputSchema.properties.repoPin.properties.sha.pattern).toBe(
      "^[0-9a-f]{40}$",
    );

    const prompt = readFileSync(def.promptPath, "utf8");
    expect(prompt).toContain("./repo/config/repos.yaml");
    expect(prompt).toContain("./repo/config/policy.yaml");
    expect(prompt).toContain('"terminalState": "completed"');
    expect(prompt).toContain('"artifact": {');
    expect(prompt).toContain('"terminalState": "refused"');
  });

  test("a planned scan reads pinned config and a schema-valid fail-closed result is refused, not contract-invalid", async () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), "evrt-merge-scan-"));
    const source = path.join(fixture, "source");
    const eventHome = path.join(fixture, "event-home");
    const workspaces = path.join(fixture, "workspaces");
    const previousReposRoot = process.env.FACTORY_REPOS_ROOT;
    const previousEventHome = process.env.FACTORY_EVENT_HOME;
    const git = (args) =>
      execFileSync(
        "git",
        [
          "-c",
          "commit.gpgsign=false",
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "commit.template=",
          ...args,
        ],
        { cwd: source, encoding: "utf8" },
      ).trim();

    try {
      mkdirSync(path.join(source, "config"), { recursive: true });
      mkdirSync(eventHome, { recursive: true });
      mkdirSync(workspaces, { recursive: true });
      git(["init", "--quiet", "--initial-branch=develop"]);
      git(["config", "user.email", "test@example.com"]);
      git(["config", "user.name", "Test"]);
      writeFileSync(
        path.join(source, "config", "repos.yaml"),
        `repos:\n  - name: mergefixture\n    path: ${source}\n    github: watt-mind/mergefixture\n    base: develop\n    deploy_branch: master\n`,
      );
      writeFileSync(
        path.join(source, "config", "policy.yaml"),
        "merge_fixture_policy: pinned\n",
      );
      git(["add", "config"]);
      git(["commit", "--quiet", "-m", "pinned config"]);
      const pinnedSha = git(["rev-parse", "HEAD"]);

      process.env.FACTORY_REPOS_ROOT = source;
      process.env.FACTORY_EVENT_HOME = eventHome;

      const db = openDb(path.join(fixture, "runtime.db"));
      persistEvent(
        db,
        registry,
        envelope(
          "factory.merge.requested",
          { repo: "mergefixture" },
          "merge-scan-workspace",
        ),
      );
      planAdmittedEvents(db, registry, { policyVersion: PV });
      const proposal = openProposals(db, {})[0];

      expect(registry.agents.get("merge-scan@2").workspace).toEqual({
        type: "repository",
        checkoutDir: "repo",
        retainOnFailure: true,
      });
      expect(proposal.spec.input.repoPin).toEqual({
        repo: "mergefixture",
        ref: "develop",
        sha: pinnedSha,
        github: "watt-mind/mergefixture",
      });

      writeFileSync(
        path.join(source, "config", "policy.yaml"),
        "merge_fixture_policy: moved\n",
      );
      git(["add", "config/policy.yaml"]);
      git(["commit", "--quiet", "-m", "move config after planning"]);

      approveProposal(db, registry, proposal.id, {
        actor: "operator",
        policyVersion: PV,
      });
      let observed = null;
      const adapter = {
        async execute({ workspaceDir }) {
          observed = {
            repos: readFileSync(
              path.join(workspaceDir, "repo", "config", "repos.yaml"),
              "utf8",
            ),
            policy: readFileSync(
              path.join(workspaceDir, "repo", "config", "policy.yaml"),
              "utf8",
            ),
          };
          writeFileSync(
            path.join(workspaceDir, "result.json"),
            `${JSON.stringify({
              schemaVersion: "factory.agent-result/v1",
              terminalState: "refused",
              reasonCode: "needs_human",
            })}\n`,
          );
          return { exitCode: 0, timedOut: false };
        },
      };
      const summary = await runOnce(
        db,
        registry,
        { cursor: adapter },
        { workspacesRoot: workspaces, owner: "merge-test", policyVersion: PV },
      );

      expect(observed.repos).toContain("name: mergefixture");
      expect(observed.policy).toBe("merge_fixture_policy: pinned\n");
      expect(summary).toMatchObject({
        terminalState: "REFUSED",
        reasonCode: "needs_human",
      });
      expect(
        JSON.parse(
          db
            .query("SELECT result_json FROM results WHERE run_id = ?")
            .get(proposal.run_id).result_json,
        ),
      ).toMatchObject({
        terminalState: "refused",
        reasonCode: "needs_human",
        verification: { status: "passed", checks: ["schema_valid"] },
      });
      db.close();
    } finally {
      if (previousReposRoot === undefined) delete process.env.FACTORY_REPOS_ROOT;
      else process.env.FACTORY_REPOS_ROOT = previousReposRoot;
      if (previousEventHome === undefined) delete process.env.FACTORY_EVENT_HOME;
      else process.env.FACTORY_EVENT_HOME = previousEventHome;
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe("executable merge command safety (WM-412)", () => {
  test("merge-apply fails before merge when Linear lookup errors, is empty, or is malformed", () => {
    for (const mode of ["error", "empty", "malformed"]) {
      const fixture = commandFixture(`merge-apply-linear-${mode}-`);
      installMergeCommandFakes(fixture);
      const result = runCommand(
        applyCommand(applyPayload()),
        fixture,
        commandEnv({ FAKE_LINEAR_MODE: mode }),
      );
      expect(result.status, `${mode}: ${result.stderr}`).not.toBe(0);
      const log = existsSync(fixture.log) ? readFileSync(fixture.log, "utf8") : "";
      expect(log).not.toContain("gh pr merge");
    }
  });

  test("merge-apply executes the configured fallback and requires every exact workflow job", () => {
    for (const [mode, shouldMerge] of [["success", true], ["shadow-only", false]]) {
      const fixture = commandFixture(`merge-apply-config-${mode}-`);
      installMergeCommandFakes(fixture);
      installBunGateFake(fixture);
      const result = runCommand(
        applyCommand(applyPayload()),
        fixture,
        commandEnv({ FAKE_CI_MODE: mode }),
      );
      expect(result.status, `${mode}: ${result.stderr}`).toBe(0);
      const log = readFileSync(fixture.log, "utf8");
      expect(log).toContain("--event pull_request");
      expect(log.includes("gh pr merge")).toBe(shouldMerge);
    }
  });

  test("merge-apply accepts only the exact quoted no-required-checks diagnostic", () => {
    for (const [mode, shouldMerge] of [
      ["empty", true],
      ["unquoted", false],
      ["status-zero-empty", false],
    ]) {
      const fixture = commandFixture(`merge-apply-empty-${mode}-`);
      installMergeCommandFakes(fixture);
      installBunGateFake(fixture);
      const result = runCommand(
        applyCommand(applyPayload()),
        fixture,
        commandEnv({ FAKE_REQUIRED_MODE: mode }),
      );
      expect(result.status, `${mode}: ${result.stderr}`).toBe(0);
      const log = readFileSync(fixture.log, "utf8");
      expect(log.includes("gh pr merge")).toBe(shouldMerge);
    }
  });

  test("merge-apply prefers nonempty GitHub required contexts and rejects pending ones", () => {
    for (const [mode, shouldMerge] of [["green", true], ["pending", false], ["duplicate", false]]) {
      const fixture = commandFixture(`merge-apply-required-${mode}-`);
      installMergeCommandFakes(fixture);
      installBunGateFake(fixture);
      const result = runCommand(
        applyCommand(applyPayload()),
        fixture,
        commandEnv({ FAKE_REQUIRED_MODE: mode, FAKE_CI_MODE: "auxiliary" }),
      );
      expect(result.status, `${mode}: ${result.stderr}`).toBe(0);
      const log = readFileSync(fixture.log, "utf8");
      expect(log.includes("gh pr merge")).toBe(shouldMerge);
      expect(log).not.toContain("--event pull_request");
    }
  });

  test("real merge-apply command causally admits landed state that queues exact verification", () => {
    const fixture = commandFixture("merge-apply-causal-");
    installMergeCommandFakes(fixture);
    const db = openDb(`${fixture.root}/runtime.db`);
    seedCompleted(db, {
      runId: "causal-scan",
      agent: "merge-scan@2",
      input: { repo: "factory" },
      artifact: {
        recommendation: "MERGE",
        ...applyPayload(),
        fix: [],
        escalate: [],
        summary: "causal fixture",
      },
    });
    expect(resolveChains(db, registry).emitted).toBe(1);
    planAdmittedEvents(db, registry, { policyVersion: PV });
    const apply = db.query(
      `SELECT run_id FROM runs WHERE json_extract(spec_json,'$.agent')='merge-apply@2'`,
    ).get();
    db.query(`UPDATE runs SET state='RUNNING' WHERE run_id=?`).run(apply.run_id);

    const result = runCommand(
      applyCommand(applyPayload()),
      fixture,
      commandEnv({ FACTORY_EVENT_HOME: fixture.root }),
    );
    expect(result.status, result.stderr).toBe(0);
    const landed = db.query(
      `SELECT causation_id FROM events WHERE type='factory.merge-landed'`,
    ).get();
    expect(landed.causation_id).toBe(apply.run_id);

    db.query(`UPDATE runs SET state='COMPLETED', attempts=1 WHERE run_id=?`).run(
      apply.run_id,
    );
    db.query(
      `INSERT INTO results (run_id,attempt,result_json,artifact_hash,verification_json,receipt_json,accepted_at)
       VALUES (?,1,?,'hash','{}','{}',?)`,
    ).run(
      apply.run_id,
      canonicalJson({
        artifact: {
          repo: "factory",
          applied: [{ issueId: "WM-500", action: "merge_pr" }],
        },
      }),
      new Date().toISOString(),
    );
    planAdmittedEvents(db, registry, { policyVersion: PV });
    expect(
      db.query(
        `SELECT state FROM runs WHERE json_extract(spec_json,'$.agent')='merge-verify@1'`,
      ).get().state,
    ).toBe("QUEUED");
    db.close();
  });

  test("merge-verify compares state and exact SHA separately and executes the configured CI workflow jobs", () => {
    const fixture = commandFixture("merge-verify-success-");
    installMergeCommandFakes(fixture);
    installBunGateFake(fixture);
    const result = runCommand(
      verifyCommand({
        repo: "factory",
        github: "watt-mind/factory",
        base: "develop",
        pr: 42,
        ticket: "WM-500",
        headSha: SHA,
        headRef: "feat/WM-500",
        mergeCommitSha: MERGE_SHA,
      }),
      fixture,
      commandEnv(),
    );
    expect(result.status, result.stderr).toBe(0);
    const log = readFileSync(fixture.log, "utf8");
    expect(log).toContain("--jq .state");
    expect(log).toContain("--jq .mergeCommit.oid");
    expect(log).toContain("run list");
    expect(log).toContain("run view 91");
    expect(log).not.toContain("git/refs/heads/feat/WM-500");
  });

  test("an auxiliary check without the configured base-push workflow never passes verification", () => {
    const fixture = commandFixture("merge-verify-auxiliary-");
    installMergeCommandFakes(fixture);
    installBunGateFake(fixture);
    const result = runCommand(
      verifyCommand({
        repo: "factory",
        github: "watt-mind/factory",
        base: "develop",
        pr: 42,
        ticket: "WM-500",
        headSha: SHA,
        headRef: "feat/WM-500",
        mergeCommitSha: MERGE_SHA,
      }),
      fixture,
      commandEnv({ FAKE_CI_MODE: "auxiliary" }),
    );
    expect(result.status).not.toBe(0);
    const log = readFileSync(fixture.log, "utf8");
    expect(log).toContain("run list");
    expect(log).not.toContain("linear state WM-500 Done");
  });

  test("merge-verify cannot pass the early Shadow-only window before Verify appears and succeeds", () => {
    const fixture = commandFixture("merge-verify-shadow-only-");
    installMergeCommandFakes(fixture);
    installBunGateFake(fixture);
    const result = runCommand(
      verifyCommand({
        repo: "factory",
        github: "watt-mind/factory",
        base: "develop",
        pr: 42,
        ticket: "WM-500",
        headSha: SHA,
        headRef: "feat/WM-500",
        mergeCommitSha: MERGE_SHA,
      }),
      fixture,
      commandEnv({ FAKE_CI_MODE: "shadow-only" }),
    );
    expect(result.status).not.toBe(0);
    const log = readFileSync(fixture.log, "utf8");
    expect(log).toContain("run view 91");
    expect(log).not.toContain("linear state WM-500 Done");
  }, 15_000);

  test("factory branch-guard rejects protected refs and another open PR holder", () => {
    const fixture = commandFixture("branch-guard-");
    const repos = `${fixture.root}/repos.yaml`;
    writeFileSync(
      repos,
      `repos:\n  - name: fixture\n    path: ${fixture.root}\n    base: develop\n    deploy_branch: main\n`,
      "utf8",
    );
    const protectedResult = runCommand(
      ["bun", `${process.cwd()}/orchestrator/branch-guard.mjs`, "--repo", "fixture", "--pr", "1", "--head", "develop"],
      fixture,
      {
        PATH: process.env.PATH,
        FACTORY_BRANCH_GUARD_REPOS_YAML: repos,
        FACTORY_BRANCH_GUARD_OPEN_PRS_JSON: "[]",
      },
    );
    expect(protectedResult.status).toBe(2);

    const heldResult = runCommand(
      ["bun", `${process.cwd()}/orchestrator/branch-guard.mjs`, "--repo", "fixture", "--pr", "1", "--head", "feat/shared"],
      fixture,
      {
        PATH: process.env.PATH,
        FACTORY_BRANCH_GUARD_REPOS_YAML: repos,
        FACTORY_BRANCH_GUARD_OPEN_PRS_JSON: JSON.stringify([
          { number: 1, headRefName: "feat/shared" },
          { number: 2, headRefName: "feat/shared" },
        ]),
      },
    );
    expect(heldResult.status).toBe(2);
    expect(heldResult.stderr).toContain("#2");
  });
});

describe("merge transition chains", () => {
  test("MERGE emits one SHA-pinned apply event", () => {
    const db = openDb(":memory:");
    seedCompleted(db, {
      runId: "scan-merge",
      agent: "merge-scan@2",
      input: { repo: "factory" },
      artifact: {
        recommendation: "MERGE",
        ...applyPayload(),
        fix: [],
        escalate: [],
        summary: "one merge",
      },
    });
    expect(resolveChains(db, registry)).toEqual({
      emitted: 1,
      skipped: 0,
      errors: [],
    });
    const event = db
      .query(`SELECT event_id,envelope_json FROM events WHERE source='chain'`)
      .get();
    expect(event.event_id).toBe("chain-scan-merge");
    expect(JSON.parse(event.envelope_json).payload).toEqual(applyPayload());
  });

  test("FIX fans out one durable request per PR with round and finding hash", () => {
    const db = openDb(":memory:");
    const fix = ["WM-501", "WM-502"].map((ticket, index) => ({
      pr: 50 + index,
      headSha: SHA,
      baseSha: BASE_SHA,
      headRef: `feat/${ticket}`,
      ticket,
      finding: `mechanical ${index}`,
      findingHash: FINDING_HASH,
      round: 1,
      mechanical: true,
      withinOwnedPaths: true,
      ownedPaths: [`src/${index}.mjs`],
    }));
    seedCompleted(db, {
      runId: "scan-fix",
      agent: "merge-scan@2",
      input: { repo: "factory" },
      artifact: {
        recommendation: "FIX",
        repo: "factory",
        github: "watt-mind/factory",
        base: "develop",
        deployBranch: "master",
        plan: [],
        fix,
        escalate: [],
        summary: "two fixes",
      },
    });
    expect(resolveChains(db, registry).emitted).toBe(2);
    const rows = db
      .query(
        `SELECT event_id,envelope_json FROM events WHERE source='chain' ORDER BY event_id`,
      )
      .all();
    expect(rows.map((row) => row.event_id)).toEqual([
      "chain-scan-fix-WM-501",
      "chain-scan-fix-WM-502",
    ]);
    expect(
      rows.map((row) => JSON.parse(row.envelope_json).payload.ticket),
    ).toEqual(["WM-501", "WM-502"]);
    expect(JSON.parse(rows[0].envelope_json).payload).toMatchObject({
      round: 1,
      findingHash: FINDING_HASH,
      mechanical: true,
    });
  });

  test("duplicate fix tickets still derive one stable event per accepted item", () => {
    const db = openDb(":memory:");
    const fix = [61, 62].map((pr, index) => ({
      pr,
      headSha: SHA,
      baseSha: BASE_SHA,
      headRef: `feat/WM-560-${index}`,
      ticket: "WM-560",
      finding: `mechanical ${index}`,
      findingHash: String(index + 1).repeat(64),
      round: 1,
      mechanical: true,
      withinOwnedPaths: true,
      ownedPaths: [`src/${index}.mjs`],
    }));
    seedCompleted(db, {
      runId: "scan-duplicate-fix-ticket",
      agent: "merge-scan@2",
      input: { repo: "factory" },
      artifact: {
        recommendation: "FIX",
        repo: "factory",
        github: "watt-mind/factory",
        base: "develop",
        deployBranch: "master",
        plan: [],
        fix,
        escalate: [],
        summary: "two fixes share one ticket",
      },
    });

    expect(resolveChains(db, registry)).toEqual({
      emitted: 2,
      skipped: 0,
      errors: [],
    });
    expect(
      db
        .query(`SELECT event_id FROM events WHERE source='chain' ORDER BY event_id`)
        .all()
        .map((row) => row.event_id),
    ).toEqual([
      `chain-scan-duplicate-fix-ticket-fix-61-${"1".repeat(64)}`,
      `chain-scan-duplicate-fix-ticket-fix-62-${"2".repeat(64)}`,
    ]);
  });

  test("a legacy aggregate event prevents stale mixed-action backfill after routing changes", () => {
    const db = openDb(":memory:");
    seedCompleted(db, {
      runId: "scan-historical-mixed",
      agent: "merge-scan@2",
      input: { repo: "factory" },
      artifact: {
        recommendation: "ESCALATE",
        ...applyPayload(63, "WM-563"),
        fix: [],
        escalate: [
          {
            pr: 64,
            headSha: SHA,
            ticket: "WM-564",
            reason: "historical hold",
          },
        ],
        summary: "historical aggregate escalation",
      },
    });
    expect(
      persistEvent(db, registry, {
        schemaVersion: "factory.event/v1",
        eventId: "chain-scan-historical-mixed",
        type: "factory.merge-escalate.requested",
        source: "chain",
        subject: "merge-scan@2",
        occurredAt: "2026-08-16T12:00:00.000Z",
        correlationId: "historical-mixed",
        causationId: "scan-historical-mixed",
        payload: {
          repo: "factory",
          summary: "historical aggregate escalation",
        },
      }).admitted,
    ).toBe(true);

    expect(resolveChains(db, registry)).toEqual({
      emitted: 0,
      skipped: 0,
      errors: [],
    });
    expect(
      db.query(`SELECT COUNT(*) AS n FROM events WHERE source='chain'`).get().n,
    ).toBe(1);
  });

  test("a mixed scan independently emits escalation, bounded fixes, and one globally serialized merge", () => {
    const db = openDb(":memory:");
    const fix = ["WM-511", "WM-512"].map((ticket, index) => ({
      pr: 51 + index,
      headSha: SHA,
      baseSha: BASE_SHA,
      headRef: `feat/${ticket}`,
      ticket,
      finding: `mechanical ${index}`,
      findingHash: FINDING_HASH,
      round: 1,
      mechanical: true,
      withinOwnedPaths: true,
      ownedPaths: [`src/${index}.mjs`],
    }));
    seedCompleted(db, {
      runId: "scan-mixed",
      agent: "merge-scan@2",
      input: { repo: "factory" },
      artifact: {
        recommendation: "ESCALATE",
        ...applyPayload(53, "WM-513"),
        fix,
        escalate: [
          {
            pr: 54,
            headSha: SHA,
            ticket: "WM-514",
            reason: "draft hold remains visible",
          },
        ],
        summary: "one hold, two mechanical fixes, and one safe merge",
      },
    });

    expect(resolveChains(db, registry)).toEqual({
      emitted: 4,
      skipped: 0,
      errors: [],
    });
    const events = db
      .query(`SELECT event_id,type FROM events WHERE source='chain' ORDER BY event_id`)
      .all();
    expect(events.map((event) => event.type).sort()).toEqual([
      "factory.merge-apply.requested",
      "factory.merge-escalate.requested",
      "factory.merge-fix.requested",
      "factory.merge-fix.requested",
    ]);
    expect(events.map((event) => event.event_id)).toEqual([
      "chain-scan-mixed-escalate",
      `chain-scan-mixed-fix-51-${FINDING_HASH}`,
      `chain-scan-mixed-fix-52-${FINDING_HASH}`,
      "chain-scan-mixed-merge",
    ]);

    // A process interruption after one admission must not suppress the other
    // three actions when the same accepted result is resolved again.
    db.query(
      `DELETE FROM events WHERE source='chain' AND event_id != 'chain-scan-mixed-escalate'`,
    ).run();
    expect(resolveChains(db, registry)).toEqual({
      emitted: 3,
      skipped: 0,
      errors: [],
    });
    expect(
      db.query(`SELECT COUNT(*) AS n FROM events WHERE source='chain'`).get().n,
    ).toBe(4);

    planAdmittedEvents(db, registry, { policyVersion: PV });
    expect(
      db.query(
        `SELECT COUNT(*) AS n FROM runs WHERE state='QUEUED' AND json_extract(spec_json,'$.agent')='merge-apply@2'`,
      ).get().n,
    ).toBe(1);
    expect(resolveChains(db, registry)).toEqual({
      emitted: 0,
      skipped: 0,
      errors: [],
    });
  });

  test("a fixer can only request a fresh independent scan, never apply", () => {
    const db = openDb(":memory:");
    seedCompleted(db, {
      runId: "fix-done",
      agent: "merge-fix@1",
      input: { repo: "factory" },
      artifact: {
        outcome: "UPDATED",
        repo: "factory",
        ticket: "WM-501",
        pr: 50,
        headSha: SHA,
        round: 1,
        summary: "pushed",
      },
    });
    expect(resolveChains(db, registry).emitted).toBe(1);
    const row = db
      .query(`SELECT type,envelope_json FROM events WHERE source='chain'`)
      .get();
    expect(row.type).toBe("factory.merge.requested");
    expect(JSON.parse(row.envelope_json).payload).toEqual({ repo: "factory" });
  });
});

describe("policy approval and global merge barrier", () => {
  test("an ordinary policy-safe develop apply auto-queues, while main and sensitive plans remain open", () => {
    const db = openDb(":memory:");
    admitEvent(
      db,
      registry,
      envelope("factory.merge-apply.requested", applyPayload(), "safe"),
    );
    admitEvent(
      db,
      registry,
      envelope(
        "factory.merge-apply.requested",
        { ...applyPayload(43, "WM-503"), base: "main" },
        "main",
      ),
    );
    admitEvent(
      db,
      registry,
      envelope(
        "factory.merge-apply.requested",
        {
          ...applyPayload(44, "WM-504"),
          plan: [
            { ...candidate(44, "WM-504"), sensitive: true, policySafe: false },
          ],
        },
        "sensitive",
      ),
    );
    planAdmittedEvents(db, registry, { policyVersion: PV });
    expect(
      db
        .query(
          `SELECT state FROM runs WHERE json_extract(spec_json,'$.agent')='merge-apply@2' AND json_extract(spec_json,'$.input.plan[0].pr')=42`,
        )
        .get().state,
    ).toBe("QUEUED");
    const reasons = openProposals(db, {})
      .map((p) => p.reason)
      .join(" ");
    expect(reasons).toContain("merge_base_not_allowed");
    expect(reasons).toContain("invalid_input");
  });

  test("only one merge apply queues globally; a second remains durably watched", () => {
    const db = openDb(":memory:");
    admitEvent(
      db,
      registry,
      envelope(
        "factory.merge-apply.requested",
        applyPayload(60, "WM-560"),
        "first",
      ),
    );
    admitEvent(
      db,
      registry,
      envelope(
        "factory.merge-apply.requested",
        applyPayload(61, "WM-561"),
        "second",
      ),
    );
    planAdmittedEvents(db, registry, { policyVersion: PV });
    expect(
      db.query(`SELECT COUNT(*) n FROM runs WHERE state='QUEUED'`).get().n,
    ).toBe(1);
    expect(openProposals(db, {})).toHaveLength(1);
    expect(openProposals(db, {})[0].reason).toContain("merge_barrier_active");
  });

  test("a landed event queues deterministic verification, and failed verification holds every next merge", () => {
    const db = openDb(":memory:");
    const landed = {
      repo: "factory",
      github: "watt-mind/factory",
      base: "develop",
      pr: 70,
      ticket: "WM-570",
      headSha: SHA,
      headRef: "feat/WM-570",
      mergeCommitSha: MERGE_SHA,
    };
    admitEvent(
      db,
      registry,
      envelope("factory.merge-landed", landed, "landed"),
    );
    planAdmittedEvents(db, registry, { policyVersion: PV });
    const verify = db
      .query(
        `SELECT run_id,state FROM runs WHERE json_extract(spec_json,'$.agent')='merge-verify@1'`,
      )
      .get();
    expect(verify.state).toBe("QUEUED");
    db.query(`UPDATE runs SET state='FAILED' WHERE run_id=?`).run(
      verify.run_id,
    );

    admitEvent(
      db,
      registry,
      envelope(
        "factory.merge-apply.requested",
        applyPayload(71, "WM-571"),
        "after-red",
      ),
    );
    planAdmittedEvents(db, registry, { policyVersion: PV });
    const proposal = openProposals(db, {}).find(
      (p) => p.spec?.agent === "merge-apply@2",
    );
    expect(proposal.reason).toContain("merge_barrier_unverified");
  });

  test("durable fix history is monotonic and replayed round one cannot enqueue a third fix", () => {
    const db = openDb(":memory:");
    const payload = (round) => ({
      repo: "factory",
      github: "watt-mind/factory",
      base: "develop",
      pr: 88,
      headSha: SHA,
      baseSha: BASE_SHA,
      headRef: "feat/WM-588",
      ticket: "WM-588",
      finding: `mechanical round ${round}`,
      findingHash: FINDING_HASH,
      round,
      mechanical: true,
      withinOwnedPaths: true,
      ownedPaths: ["event-runtime/merge.test.mjs"],
    });
    for (const [id, round] of [["fix-1", 1], ["fix-2", 2]]) {
      admitEvent(
        db,
        registry,
        envelope("factory.merge-fix.requested", payload(round), id),
      );
      planAdmittedEvents(db, registry, { policyVersion: PV });
    }
    admitEvent(
      db,
      registry,
      envelope("factory.merge-fix.requested", payload(1), "fix-3-replay"),
    );
    planAdmittedEvents(db, registry, { policyVersion: PV });

    const third = openProposals(db, {}).find(
      (proposal) => proposal.event_id === "fix-3-replay",
    );
    expect(third.reason).toContain("merge_fix_round_not_durable");
    expect(
      db.query(
        `SELECT COUNT(*) AS n FROM runs WHERE state='QUEUED' AND json_extract(spec_json,'$.agent')='merge-fix@1'`,
      ).get().n,
    ).toBe(2);
  });

  test("mechanical fix rounds are bounded and exhausted rounds fail schema/policy closed", () => {
    const schema = registry.agents.get("merge-fix@1").inputSchema;
    expect(schema.properties.round.maximum).toBe(2);
    const prompt = registry.agents.get("merge-fix@1").promptPath;
    expect(prompt).toContain("merge-fix.md");
  });
});
