import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-worker-handoff-test-mjs";
import "../test-helpers.mjs";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { insideHandoffSandbox } from "./verify.mjs";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { hashJson } from "./canonical.mjs";
import { openDb } from "./db.mjs";
import { lifecycleOf } from "./lifecycle.mjs";
import {
  defaultReturnHandoffTicket,
  defaultUnclaimTicket,
  classifyFailureCause,
  runOnce,
  ticketHandoffContext,
} from "./worker.mjs";
import { registerTestProcessCleanup } from "./test-helpers-process.mjs";
import { opts, queueRun, registry } from "./worker-test-helpers.mjs";

registerTestProcessCleanup(import.meta.url);

let seq = 0;

describe("post-claim ticket command capture (GH-967)", () => {
  const description =
    "## Owned Paths\n- event-runtime/lib/worker.mjs\n\n" +
    "## Verification Command\n\n```bash\nbun test focused.test.mjs\n```\n";

  test("a Linear description hash is pinned from admission through post-claim capture", () => {
    const captured = ticketHandoffContext(
      "WM-967",
      () => ({ description }),
      "factory",
      { descriptionHash: hashJson(description) },
    );
    expect(captured).toMatchObject({
      ok: true,
      handoff: {
        verificationCommand: "bun test focused.test.mjs",
        descriptionHash: hashJson(description),
      },
    });

    const changed = ticketHandoffContext(
      "WM-967",
      () => ({ description: description.replace("focused", "attacker") }),
      "factory",
      { descriptionHash: hashJson(description) },
    );
    expect(changed.ok).toBe(false);
    expect(changed.reasonCode).toBe("ticket_body_changed_post_claim");
    expect(changed.handoff).toBeUndefined();
  });

  test("GitHub trust and ready pin are revalidated on the same read that captures the command", () => {
    let reads = 0;
    const fetchTicket = () => {
      reads += 1;
      return {
        description,
        controlPlaneKind: "github",
        authorAssociation: "OWNER",
        lastEditorAssociation: "MEMBER",
        readyPinHash: hashJson(description),
      };
    };
    expect(
      ticketHandoffContext("watt-mind/factory#967", fetchTicket, "factory", {
        descriptionHash: hashJson(description),
      }).ok,
    ).toBe(true);
    expect(reads).toBe(1);

    for (const override of [
      { lastEditorAssociation: "NONE" },
      { readyPinHash: null },
      { readyPinHash: hashJson("older body") },
    ]) {
      const rejected = ticketHandoffContext(
        "watt-mind/factory#967",
        () => ({
          description,
          controlPlaneKind: "github",
          authorAssociation: "OWNER",
          lastEditorAssociation: "MEMBER",
          readyPinHash: hashJson(description),
          ...override,
        }),
        "factory",
        { descriptionHash: hashJson(description) },
      );
      expect(rejected.ok).toBe(false);
      expect(rejected.handoff).toBeUndefined();
    }
  });

  test("an unavailable post-claim read fails closed without a command", () => {
    const result = ticketHandoffContext(
      "WM-967",
      () => {
        throw new Error("tracker unavailable");
      },
      "factory",
      { descriptionHash: hashJson(description) },
    );
    expect(result).toMatchObject({
      ok: false,
      reasonCode: "ticket_post_claim_read_failed",
    });
    expect(result.handoff).toBeUndefined();
  });
});

describe("handoff verification gate (WM-718)", () => {
  let factoryRoot;
  let repoDir;
  let wtRoot;
  let previousReposRoot;

  const OWNED = "## Owned Paths\n- src/feature/**\n- event-runtime/web/**\n\n";
  const withCommand = (cmd) =>
    `${OWNED}## Verification Command\n\n\`\`\`\n${cmd}\n\`\`\`\n`;

  beforeAll(() => {
    factoryRoot = tmpDir("evrt-handoff-factory-");
    repoDir = tmpDir("evrt-handoff-repo-");
    wtRoot = tmpDir("evrt-handoff-trees-");
    mkdirSync(path.join(repoDir, "bin"), { recursive: true });
    // A real git worktree with an `origin/develop` ref, so the gate can diff
    // merge-base..HEAD exactly as it does for a repo-owned worktree_up.
    writeFileSync(
      path.join(repoDir, "bin", "worktree-up.sh"),
      [
        "#!/bin/bash",
        "set -e",
        `WT="${wtRoot}/$1"`,
        'mkdir -p "$WT" && cd "$WT"',
        "git init -q -b develop",
        "git config user.email factory@test && git config user.name factory",
        "mkdir -p src/feature event-runtime/web/src",
        "echo base > src/feature/base.txt",
        `printf '%s\\n' '{"name":"web","private":true,"scripts":{"build":"echo web_built:$PWD"}}' > event-runtime/web/package.json`,
        "echo 'export const x = 1;' > event-runtime/web/src/index.ts",
        "git add -A && git commit -qm base",
        "git update-ref refs/remotes/origin/develop HEAD",
        'git checkout -qb "feat/$1"',
        "",
      ].join("\n"),
    );
    writeFileSync(
      path.join(repoDir, "bin", "worktree-down.sh"),
      `#!/bin/bash\nrm -rf "${wtRoot}/$1"\n`,
    );
    mkdirSync(path.join(factoryRoot, "config"), { recursive: true });
    writeFileSync(path.join(factoryRoot, "config", "policy.yaml"), "{}\n");
    writeFileSync(
      path.join(factoryRoot, "config", "repos.yaml"),
      `repos:\n` +
        `  - name: wt-handoff\n    path: ${repoDir}\n    github: watt-mind/wt-handoff\n    base: develop\n` +
        `    team: WM\n    project: Factory\n    max_in_flight: 2\n` +
        `    worktree_up: bin/worktree-up.sh\n    worktree_down: bin/worktree-down.sh\n` +
        `    worktree_root: ${wtRoot}\n    verify: echo repo_verified\n    escalate_paths: []\n` +
        `  - name: wt-handoff-noverify\n    path: ${repoDir}\n    github: watt-mind/wt-handoff-noverify\n    base: develop\n` +
        `    team: WM\n    project: Factory\n    max_in_flight: 2\n` +
        `    worktree_up: bin/worktree-up.sh\n    worktree_down: bin/worktree-down.sh\n` +
        `    worktree_root: ${wtRoot}\n    escalate_paths: []\n`,
    );
    previousReposRoot = process.env.FACTORY_REPOS_ROOT;
    process.env.FACTORY_REPOS_ROOT = factoryRoot;
  });

  afterAll(() => {
    if (previousReposRoot === undefined) delete process.env.FACTORY_REPOS_ROOT;
    else process.env.FACTORY_REPOS_ROOT = previousReposRoot;
  });

  const setPolicy = (yaml) =>
    writeFileSync(path.join(factoryRoot, "config", "policy.yaml"), yaml);

  function handoffSpec({ repo = "wt-handoff", ticket }) {
    const runId = `run_handoff_${++seq}_${Math.random().toString(36).slice(2)}`;
    const input = { repo, ticket };
    return {
      schemaVersion: "factory.run-spec/v1",
      runId,
      agent: "dispatch@1",
      input,
      inputHash: hashJson(input),
      workspace: {
        type: "worktree",
        checkoutDir: "repo",
        retainOnFailure: true,
      },
      adapter: "fake",
      promptVersion: "git:test",
      policyVersion: "git:test",
      outputContract: "factory.dispatch-result/v1",
      capabilities: ["tracker:write", "repo:write", "github:write"],
      timeoutSeconds: 5,
      maxAttempts: 1,
      idempotencyKey: `idem-${runId}`,
    };
  }

  /** A fake dispatch agent: writes files, commits, claims whatever it likes. */
  function agent({ files = {}, claim = {}, prNumber = 77 }) {
    return {
      async execute({ spec, workspaceDir }) {
        writeFileSync(
          path.join(workspaceDir, ".transcript.json"),
          `{"fake":"handoff transcript"}\n`,
        );
        const repo = path.join(workspaceDir, "repo");
        for (const [rel, content] of Object.entries(files)) {
          mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
          writeFileSync(path.join(repo, rel), content);
        }
        execFileSync("git", ["add", "-A"], { cwd: repo });
        execFileSync(
          "git",
          ["commit", "-qm", `implement ${spec.input.ticket}`],
          {
            cwd: repo,
          },
        );
        writeFileSync(
          path.join(workspaceDir, "result.json"),
          `${JSON.stringify({
            schemaVersion: "factory.agent-result/v1",
            terminalState: "completed",
            reasonCode: "ok",
            artifact: {
              outcome: "PR_OPEN",
              repo: spec.input.repo,
              ticket: spec.input.ticket,
              prUrl: `https://github.com/watt-mind/${spec.input.repo}/pull/${prNumber}`,
              prNumber,
              verification: {
                command: "bash run-tests.sh",
                passed: true,
                output: "all green",
                ...claim,
              },
              summary: `implemented ${spec.input.ticket}`,
              uxCritique: {
                status: "skipped",
                verdict: null,
                evidence: [],
                rounds: 0,
                prReady: true,
              },
            },
            evidence: { commands: ["bash run-tests.sh"] },
          })}\n`,
        );
        return { exitCode: 0, timedOut: false };
      },
    };
  }

  async function dispatch({ spec, adapter, description, hooks = {} }) {
    const db = openDb(":memory:");
    queueRun(db, spec);
    const calls = { unclaim: [], returned: [], held: [], comments: [] };
    const summary = await runOnce(
      db,
      registry,
      { fake: adapter },
      opts({
        dispatch: {
          locksDir: tmpDir("evrt-handoff-locks-"),
          leasesDir: tmpDir("evrt-handoff-leases-"),
          fetchTicket: () => ({
            identifier: spec.input.ticket,
            state: { name: "Todo" },
            assignee: null,
            labels: { nodes: [{ name: "ai:agent-ready" }] },
            description,
          }),
          fetchInFlight: () => [],
          countLeases: () => 0,
          claimTicket: () => ({ ok: true }),
          unclaimTicket: (p) => (calls.unclaim.push(p), false),
          returnHandoffTicket: (p) => (calls.returned.push(p), true),
          holdPullRequest: (p) => (calls.held.push(p), true),
          commentTicket: (p) => (calls.comments.push(p), true),
          // A live PR read always carries the body; an empty one is refused
          // as a missing Fixes line, so the fixture supplies the minimum.
          fetchHandoffPullRequest: () => ({
            baseRefName: "develop",
            body: `Fixes ${spec.input.ticket}`,
          }),
          ...hooks,
        },
      }),
    );
    return { db, summary, calls };
  }

  test("a fake agent that leaves a failing test is refused handoff_verification_failed: no result row, ticket back to Todo + agent-ready, PR held, tail in the receipt", async () => {
    const spec = handoffSpec({ ticket: "WM-7181" });
    const { db, summary, calls } = await dispatch({
      spec,
      description: withCommand("bash run-tests.sh"),
      adapter: agent({
        files: {
          "src/feature/impl.txt": "done\n",
          "run-tests.sh":
            'echo "suite start"\necho "(fail) totals > rejects an invalid total"\necho "1 fail" >&2\nexit 1\n',
        },
      }),
    });

    expect(summary.terminalState).toBe("FAILED");
    expect(summary.reasonCode).toBe("handoff_verification_failed");
    expect(summary.detail).toContain("ticket_verify_failed");
    expect(summary.handoff.verification.command).toBe("bash run-tests.sh");
    expect(summary.handoff.verification.exitCode).toBe(1);
    expect(summary.handoff.verification.tail).toContain(
      "(fail) totals > rejects an invalid total",
    );
    // The repo verify passed; the ticket's own command is what caught it.
    expect(summary.handoff.repoVerify.passed).toBe(true);

    // No PR_OPEN result was published — nothing downstream chains a review.
    expect(
      db
        .query(`SELECT COUNT(*) AS n FROM results WHERE run_id = ?`)
        .get(spec.runId).n,
    ).toBe(0);
    expect(
      db
        .query(`SELECT reason_code FROM attempts WHERE run_id = ?`)
        .get(spec.runId).reason_code,
    ).toBe("handoff_verification_failed");
    const journal = lifecycleOf(db, spec.runId)
      .map((row) => row.reason)
      .join("\n");
    expect(journal).toContain("(fail) totals > rejects an invalid total");
    expect(classifyFailureCause("handoff_verification_failed")).toBe(
      "agent_error",
    );

    // Ticket returned (Todo + agent-ready), never Blocked, never the plain unclaim.
    expect(calls.returned).toHaveLength(1);
    expect(calls.returned[0].ticket).toBe("WM-7181");
    expect(calls.returned[0].body).toContain(
      "## Handoff verification (worker-observed)",
    );
    expect(calls.returned[0].body).toContain(
      "(fail) totals > rejects an invalid total",
    );
    expect(calls.returned[0].body).toContain("Todo + ai:agent-ready");
    expect(calls.unclaim).toHaveLength(0);
    // The agent's PR is converted to draft with the observed failure quoted.
    expect(calls.held).toHaveLength(1);
    expect(calls.held[0]).toMatchObject({
      prNumber: 77,
      github: "watt-mind/wt-handoff",
    });
    expect(calls.held[0].body).toContain("exit 1 (FAIL)");
    expect(calls.comments).toHaveLength(0);
  });

  test("no Verification Command and no repo verify: refused handoff_verification_unspecified (fail-closed)", async () => {
    const spec = handoffSpec({
      repo: "wt-handoff-noverify",
      ticket: "WM-7182",
    });
    const { summary, calls } = await dispatch({
      spec,
      description: OWNED,
      adapter: agent({ files: { "src/feature/impl.txt": "done\n" } }),
    });
    expect(summary.terminalState).toBe("FAILED");
    expect(summary.reasonCode).toBe("handoff_verification_unspecified");
    expect(calls.returned).toHaveLength(1);
    expect(calls.held).toHaveLength(1);
    expect(calls.returned[0].body).toContain("Verification: NONE");
  });

  test("without a Verification Command the repo verify stands in and the run completes with a worker-observed line", async () => {
    const spec = handoffSpec({ ticket: "WM-7183" });
    const { db, summary, calls } = await dispatch({
      spec,
      description: OWNED,
      adapter: agent({ files: { "src/feature/impl.txt": "done\n" } }),
    });
    expect(summary.terminalState).toBe("COMPLETED");
    const result = JSON.parse(
      db
        .query(`SELECT result_json FROM results WHERE run_id = ?`)
        .get(spec.runId).result_json,
    );
    expect(result.verification.checks).toContain("repo_verify_passed");
    expect(result.verification.checks).not.toContain("ticket_verify_passed");
    expect(calls.comments).toHaveLength(1);
    expect(calls.comments[0].body).toContain(
      "- Verification: `echo repo_verified` — exit 0 (pass)",
    );
    expect(calls.comments[0].body).toContain("repo `verify:` command stood in");
  });

  test("a PR targeting the wrong base fails handoff verification and is returned", async () => {
    const spec = handoffSpec({ ticket: "WM-9381" });
    const { summary, calls } = await dispatch({
      spec,
      description: OWNED,
      adapter: agent({ files: { "src/feature/impl.txt": "done\n" } }),
      hooks: {
        fetchHandoffPullRequest: () => ({ baseRefName: "main" }),
      },
    });

    expect(summary.terminalState).toBe("FAILED");
    expect(summary.reasonCode).toBe("handoff_verification_failed");
    expect(summary.detail).toContain(
      "PR #77 targets main, expected configured base develop",
    );
    expect(calls.held).toHaveLength(1);
    expect(calls.returned).toHaveLength(1);
  });

  test("a change under event-runtime/web/src/** runs the web build and a red build refuses the handoff", async () => {
    const description = withCommand("bash run-tests.sh");
    const files = {
      "run-tests.sh": "echo ok\n",
      "event-runtime/web/src/index.ts": "export const x: number = 2;\n",
    };
    // Green build: gate runs it (marker written) and records the check.
    const green = handoffSpec({ ticket: "WM-7184" });
    const g = await dispatch({
      spec: green,
      description,
      adapter: agent({ files }),
    });
    expect(g.summary.terminalState).toBe("COMPLETED");
    // The chroot maps the worktree at /workspace; when this suite itself runs
    // inside a handoff sandbox the command is passed through and keeps the
    // real path. Either way the build ran in the web directory, not the root.
    expect(g.summary.handoff.webBuild.tail).toContain(
      `web_built:${insideHandoffSandbox() ? "" : "/workspace"}`,
    );
    expect(g.summary.handoff.webBuild.tail).toContain("/event-runtime/web");
    const result = JSON.parse(
      g.db
        .query(`SELECT result_json FROM results WHERE run_id = ?`)
        .get(green.runId).result_json,
    );
    expect(result.verification.checks).toEqual(
      expect.arrayContaining(["ticket_verify_passed", "web_build_passed"]),
    );
    expect(g.calls.comments[0].body).toContain(
      "- Web build (event-runtime/web/src/** changed): `cd event-runtime/web && bun run build` — exit 0 (pass)",
    );

    // Red build (tsc-style error) even though the ticket's command is green.
    const red = handoffSpec({ ticket: "WM-7185" });
    const r = await dispatch({
      spec: red,
      description,
      adapter: agent({
        files: {
          ...files,
          "event-runtime/web/package.json":
            '{"name":"web","private":true,"scripts":{"build":"echo \'src/index.ts(1,14): error TS6133: unused local\' >&2; exit 2"}}\n',
        },
      }),
    });
    expect(r.summary.terminalState).toBe("FAILED");
    expect(r.summary.reasonCode).toBe("handoff_verification_failed");
    expect(r.summary.detail).toContain("web_build_failed");
    expect(r.summary.detail).toContain("error TS6133");
    expect(r.summary.handoff.webBuild.exitCode).toBe(2);
    expect(r.calls.held).toHaveLength(1);
    expect(r.calls.returned).toHaveLength(1);

    // No web/src change: the build is not run at all.
    const skip = handoffSpec({ ticket: "WM-7186" });
    const s = await dispatch({
      spec: skip,
      description,
      adapter: agent({
        files: { "run-tests.sh": "echo ok\n", "src/feature/x.txt": "x\n" },
      }),
    });
    expect(s.summary.terminalState).toBe("COMPLETED");
    expect(s.summary.handoff.webBuild).toBeNull();
    expect(s.calls.comments[0].body).toContain("- Web build: skipped");
  });

  test("the Handoff Verification line is worker-authored: the agent's 'pass' claim cannot override an observed red, and rides below labelled agent-reported", async () => {
    const description = withCommand("bash run-tests.sh");
    const failing = handoffSpec({ ticket: "WM-7187" });
    const f = await dispatch({
      spec: failing,
      description,
      adapter: agent({
        files: { "run-tests.sh": 'echo "regression in totals"; exit 3\n' },
        claim: {
          command: "bash run-tests.sh",
          passed: true,
          output: "pass, 2045 tests green",
        },
      }),
    });
    expect(f.summary.terminalState).toBe("FAILED");
    const body = f.calls.returned[0].body;
    const verificationLine = body
      .split("\n")
      .find((l) => l.startsWith("- Verification:"));
    expect(verificationLine).toBe(
      "- Verification: `bash run-tests.sh` — exit 3 (FAIL)",
    );
    expect(body).toContain("regression in totals");
    expect(body).toContain(
      "- agent-reported: `bash run-tests.sh` — pass, pass, 2045 tests green",
    );
    expect(body).not.toContain("- Verification: `bash run-tests.sh` — pass");

    // Green run: the line still comes from the worker's observation, and a
    // claim naming a different command is quoted only as agent-reported.
    const passing = handoffSpec({ ticket: "WM-7188" });
    const p = await dispatch({
      spec: passing,
      description,
      adapter: agent({
        files: { "run-tests.sh": 'echo "42 tests, 0 failures"\n' },
        claim: {
          command: "bun test --only-my-file",
          passed: true,
          output: "green",
        },
      }),
    });
    expect(p.summary.terminalState).toBe("COMPLETED");
    const okBody = p.calls.comments[0].body;
    expect(
      okBody.split("\n").find((l) => l.startsWith("- Verification:")),
    ).toBe("- Verification: `bash run-tests.sh` — exit 0 (pass)");
    expect(okBody).toContain("42 tests, 0 failures");
    expect(okBody).toContain(
      "- agent-reported: `bun test --only-my-file` — pass, green",
    );
  });

  test("Owned Paths deviations are computed from the diff: listed under advisory (default), refused under strict", async () => {
    const description = withCommand("bash run-tests.sh");
    const files = {
      "run-tests.sh": "echo ok\n",
      "src/feature/impl.txt": "done\n",
      "docs/stray.md": "out of scope reflow\n",
      "orchestrator/tick.mjs": "// out of scope\n",
    };
    setPolicy("{}\n"); // key absent → advisory
    const adv = handoffSpec({ ticket: "WM-7189" });
    const a = await dispatch({
      spec: adv,
      description,
      adapter: agent({ files }),
    });
    expect(a.summary.terminalState).toBe("COMPLETED");
    expect(a.summary.handoff.ownedPathsDeviations).toEqual([
      "docs/stray.md",
      "orchestrator/tick.mjs",
      "run-tests.sh",
    ]);
    const result = JSON.parse(
      a.db
        .query(`SELECT result_json FROM results WHERE run_id = ?`)
        .get(adv.runId).result_json,
    );
    expect(result.verification.checks).toContain(
      "owned_paths_deviations_advisory",
    );
    const body = a.calls.comments[0].body;
    expect(body).toContain("- Files: 4 changed vs origin/develop");
    expect(body).toContain("- Owned Paths deviations (advisory): 3 file(s)");
    expect(body).toContain("  - `docs/stray.md`");
    expect(body).toContain("  - `orchestrator/tick.mjs`");
    expect(body).toContain("  - `run-tests.sh`");
    expect(body).not.toContain("  - `src/feature/impl.txt`");

    setPolicy("dispatch:\n  owned_paths_conformance: strict\n");
    try {
      const strict = handoffSpec({ ticket: "WM-7190" });
      const s = await dispatch({
        spec: strict,
        description,
        adapter: agent({ files }),
      });
      expect(s.summary.terminalState).toBe("FAILED");
      expect(s.summary.reasonCode).toBe("handoff_owned_paths_violation");
      expect(s.summary.detail).toContain("docs/stray.md");
      expect(s.calls.returned).toHaveLength(1);
      expect(s.calls.held).toHaveLength(1);
      expect(s.calls.returned[0].body).toContain(
        "Owned Paths deviations (strict): 3 file(s)",
      );
    } finally {
      setPolicy("{}\n");
    }

    // Conformant diff: no deviations, the check is recorded.
    const clean = handoffSpec({ ticket: "WM-7191" });
    const c = await dispatch({
      spec: clean,
      description: `## Owned Paths\n- src/feature/**\n- run-tests.sh\n\n## Verification Command\n\n\`\`\`\nbash run-tests.sh\n\`\`\`\n`,
      adapter: agent({
        files: { "run-tests.sh": "echo ok\n", "src/feature/y.txt": "y\n" },
      }),
    });
    expect(c.summary.terminalState).toBe("COMPLETED");
    expect(c.calls.comments[0].body).toContain(
      "- Owned Paths deviations: none",
    );
  });
});

// The describe block above only exercises the handoff gate through mocked
// hooks (claimTicket/returnHandoffTicket/etc all stubbed by `dispatch()`).
// `defaultReturnHandoffTicket` is the one production path none of that
// touches, and it has a real bug shape: the combined
// state+unassign+removes+add-label Linear call can fail on the label half
// alone (WM-718 F2). These tests drive the real function with a `runCli`
// stub that fails on cue, never mocking the function itself.
describe("defaultReturnHandoffTicket (WM-718 F2)", () => {
  const COMBINED_ARGS = [
    "state",
    "WM-9001",
    "Todo",
    "--unassign",
    "--add",
    "ai:agent-ready",
    "--remove",
    "ai:in-progress",
    "--remove",
    "ai:needs-review",
  ];
  const BASE_ARGS = [
    "state",
    "WM-9001",
    "Todo",
    "--unassign",
    "--remove",
    "ai:in-progress",
    "--remove",
    "ai:needs-review",
  ];

  test("retries as two separate calls and restores ai:agent-ready when the combined call fails", () => {
    const calls = [];
    const runCli = (args) => {
      calls.push(args);
      if (calls.length === 1) throw new Error("linear: rate limited");
      return "";
    };
    const result = defaultReturnHandoffTicket({
      ticket: "WM-9001",
      body: "handoff refused",
      fetchTicket: () => ({ state: { name: "In Review" } }),
      runCli,
    });
    expect(result).toEqual({
      ok: true,
      agentReadyRestored: true,
      warning: null,
    });
    // The first (failed) combined attempt, then the state move split from
    // the label add, then the comment — never a silent drop of the label.
    expect(calls).toEqual([
      COMBINED_ARGS,
      BASE_ARGS,
      ["labels", "WM-9001", "--add", "ai:agent-ready"],
      ["comment", "WM-9001", "handoff refused"],
    ]);
  });

  test("surfaces the failure loudly when the label restore also fails", () => {
    const calls = [];
    const runCli = (args) => {
      calls.push([...args]);
      if (args[0] === "state" && args.includes("--add")) {
        throw new Error("combined call failed");
      }
      if (args[0] === "labels") {
        throw new Error("labels endpoint down");
      }
      return "";
    };
    const loud = [];
    const originalConsoleError = console.error;
    console.error = (...args) => loud.push(args.join(" "));
    let result;
    try {
      result = defaultReturnHandoffTicket({
        ticket: "WM-9001",
        body: "handoff refused",
        fetchTicket: () => ({ state: { name: "In Progress" } }),
        runCli,
      });
    } finally {
      console.error = originalConsoleError;
    }
    // Never silent: the run's own return value says so...
    expect(result.ok).toBe(true);
    expect(result.agentReadyRestored).toBe(false);
    expect(result.warning).toContain("labels endpoint down");
    // ...the worker's own log says so...
    expect(
      loud.some((line) => line.includes("ai:agent-ready NOT restored")),
    ).toBe(true);
    // ...and the ticket itself still moved to Todo (unassigned, un-labeled)
    // rather than being stranded In Progress/In Review.
    expect(calls).toContainEqual(BASE_ARGS);
    const commentCall = calls.find((c) => c[0] === "comment");
    expect(commentCall).toBeDefined();
    expect(commentCall[2]).toContain("ai:agent-ready NOT restored");
  });

  test("is a no-op when the ticket already left In Progress/In Review", () => {
    const calls = [];
    const result = defaultReturnHandoffTicket({
      ticket: "WM-9001",
      body: "handoff refused",
      fetchTicket: () => ({ state: { name: "Done" } }),
      runCli: (args) => (calls.push(args), ""),
    });
    expect(result).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

// `defaultUnclaimTicket` is the worker's NOT_CLAIMED release: when a dispatch
// run never reached handoff (the claim was lost, or the run failed while the
// ticket still sat In Progress), the slot has to go back on the board. The
// bug this guards (WM-1024) was that dropping `ai:in-progress` and stopping
// left the ticket `Todo`/unassigned but WITHOUT `ai:agent-ready` — the board
// read Todo, yet the dispatch predicate (Todo + ai:agent-ready + unassigned)
// never matched again, so nothing redispatched it. These drive the real
// function through injected `fetchTicket`/`runCli` seams, never mocking it.
describe("defaultUnclaimTicket (NOT_CLAIMED release)", () => {
  test("restores Todo + ai:agent-ready, strips ai:in-progress and the stale agent label", () => {
    const calls = [];
    const result = defaultUnclaimTicket({
      repo: "factory",
      ticket: "WM-9001",
      why: "ticket_claim_lost",
      fetchTicket: () => ({
        state: { name: "In Progress" },
        labels: {
          nodes: [{ name: "ai:in-progress" }, { name: "agent:claude-code" }],
        },
      }),
      runCli: (args) => (calls.push(args), ""),
    });
    expect(result).toBe(true);
    // The state move re-adds ai:agent-ready (so the ticket is dispatchable
    // again), unassigns, and strips the lifecycle + stale agent labels.
    expect(calls[0]).toEqual([
      "state",
      "WM-9001",
      "Todo",
      "--unassign",
      "--add",
      "ai:agent-ready",
      "--remove",
      "ai:in-progress",
      "--remove",
      "ai:blocked",
      "--remove",
      "agent:claude-code",
    ]);
    // ...and a comment records the release and its cause.
    const comment = calls.find((c) => c[0] === "comment");
    expect(comment).toBeDefined();
    expect(comment[2]).toContain("released back to Todo + ai:agent-ready");
    expect(comment[2]).toContain("ticket_claim_lost");
  });

  test("folds an absolute log path down to ~ in the release comment", () => {
    const calls = [];
    defaultUnclaimTicket({
      repo: "factory",
      ticket: "WM-9001",
      why: "agent_exit_1",
      log: `${homedir()}/.factory/runs/run-9001.log`,
      fetchTicket: () => ({
        state: { name: "In Progress" },
        labels: { nodes: [{ name: "ai:in-progress" }] },
      }),
      runCli: (args) => (calls.push(args), ""),
    });
    const comment = calls.find((c) => c[0] === "comment");
    expect(comment[2]).toContain("~/.factory/runs/run-9001.log");
    expect(comment[2]).not.toContain(homedir());
  });

  test("is a no-op when the ticket is no longer In Progress", () => {
    const calls = [];
    const result = defaultUnclaimTicket({
      repo: "factory",
      ticket: "WM-9001",
      why: "ticket_claim_lost",
      fetchTicket: () => ({
        state: { name: "Todo" },
        labels: { nodes: [{ name: "ai:agent-ready" }] },
      }),
      runCli: (args) => (calls.push(args), ""),
    });
    expect(result).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("is a no-op when In Progress but the ai:in-progress label is already gone", () => {
    const calls = [];
    const result = defaultUnclaimTicket({
      repo: "factory",
      ticket: "WM-9001",
      why: "ticket_claim_lost",
      fetchTicket: () => ({
        state: { name: "In Progress" },
        labels: { nodes: [{ name: "agent:claude-code" }] },
      }),
      runCli: (args) => (calls.push(args), ""),
    });
    expect(result).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("swallows a mutation failure and reports false rather than throwing", () => {
    const result = defaultUnclaimTicket({
      repo: "factory",
      ticket: "WM-9001",
      why: "ticket_claim_lost",
      fetchTicket: () => ({
        state: { name: "In Progress" },
        labels: { nodes: [{ name: "ai:in-progress" }] },
      }),
      runCli: () => {
        throw new Error("linear: rate limited");
      },
    });
    expect(result).toBe(false);
  });
});
