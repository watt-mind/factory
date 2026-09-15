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
 *    selected, namespace filtering
 *  - dry run is the default for all three: zero mutating adapter calls
 */
import { test, expect, describe } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  EXIT,
  ROLES,
  DRIVER_PATH,
  DRIVER_CONFIG,
  DEFAULT_NAMESPACES,
  ORPHAN_MIN_AGE_MS,
  evaluateDigestRotation,
  evaluateDiscard,
  patchResourceVersionPrecondition,
  selectEvictedPods,
  namespaceMatches,
  splitList,
  parseArgs,
  parseDigestProbe,
  logStamp,
  makeLogger,
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
    expect(scripts[0]).toBe("kubectl delete pod -n office-abc husk-a\n");
    expect(scripts[1]).toBe("kubectl delete pod -n office-abc husk-b\n");
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
