#!/usr/bin/env bun
/**
 * factory infra — audited one-shot recovery verbs for the legal-dev stack.
 *
 *   factory infra rotate-driver-digest --digest sha256:<64hex> --repos legalease,lawz
 *   factory infra discard-unprepared-transaction --role research-runner
 *   factory infra sweep-evicted-pods --namespaces 'office-*,legal-research-dev'
 *
 * WHY THIS EXISTS (WM-1105). Each of these three recoveries is documented,
 * low-risk and mechanical, and each was blocked by the coding agent's
 * permission classifier during the 2026-09-15 release because the shape an
 * agent had to type was `ssh … sudo rm -rf …` / `kubectl delete pods …` /
 * `gh variable set …`. Every block cost a round-trip to the human for a
 * decision they had already made. Wrapping them puts the preconditions in code
 * rather than in a human's memory of the runbook, and gives the operator one
 * plan to read before approving. It does not make `--yes` safe to allow
 * blanket: a prefix rule cannot tell `sweep-evicted-pods` from
 * `sweep-evicted-pods --yes`, so the prompt on a mutating run stays. See
 * docs/infra-recovery.md.
 *
 * The incidents, one per verb: OPS-694 (a rotated driver left the repo
 * variables stale), CLNT-3170 (a failed lawz publish stranded an unprepared
 * transaction directory and every legalease publisher exited 3 behind it),
 * CLNT-3167 (runner disk pressure evicted dev-cluster pods, whose `Failed`
 * husks then failed the qualify gate). See docs/infra-recovery.md.
 *
 * SAFETY MODEL
 *  - Dry run is the default. `--yes` is required before anything mutates;
 *    `--dry-run` is accepted as an explicit spelling of the default.
 *  - Preconditions are evaluated in pure functions (`evaluate*`, `select*`)
 *    over data the adapters fetched, so every refusal path is unit-testable
 *    with fake adapter output and no live cluster.
 *  - A refusal is exit 2 and is never "probably fine"; an adapter that could
 *    not answer is exit 3 and never silently reads as a pass.
 *
 * Exit 0 — evaluated clean: acted (with --yes), or printed the plan (dry run)
 * Exit 2 — REFUSED: a precondition says no; nothing was mutated
 * Exit 3 — CANNOT EVALUATE: an adapter failed, or the flags are unusable
 *
 * House style per docs/event-runtime-conventions.md: data in, data out;
 * effects (`ssh`, `kubectl`, `gh`, `sha256sum`, clock, log sink, ticket
 * comment) arrive through a trailing options object and default to the real
 * implementations only at the boundary.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const EXIT = { OK: 0, REFUSED: 2, CANNOT_EVALUATE: 3 };

export const VERBS = [
  "rotate-driver-digest",
  "discard-unprepared-transaction",
  "sweep-evicted-pods",
];

/** The legal-dev runner (Tailscale address; see hdkiller docs/servers). */
export const DEFAULT_HOST = "hdkiller@100.74.142.98";

export const DRIVER_PATH =
  "/usr/local/libexec/legalease/dev-qualification-driver";
export const DRIVER_CONFIG = "/etc/legalease/dev-qualification/config.json";
export const PROMOTION_ROOT = "/var/lib/legal-dev-runtime-promotion";
export const PROMOTION_LOCK = `${PROMOTION_ROOT}/legal-dev-runtime-promotion.lock`;
export const EXCHANGE_DIR = "/var/lib/legalease/dev-qualification/exchange";
export const JOURNAL_DIR = "/var/lib/legalease/dev-qualification/journal";

/** Transaction directory roles under `$PROMOTION_ROOT/active/`. */
export const ROLES = ["research-runner", "case-agent"];

export const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * Repositories whose `DEV_QUALIFICATION_DRIVER_SHA256` this verb may rotate.
 *
 * An allow-list rather than `--repos <anything>` over an owner default: the
 * value lands in `gh variable set -R <slug>`, and the point of the verb is that
 * running it is running *these two rotations*. Adding a repo is a code change
 * that goes through review — the same bar the runbook has.
 */
export const DRIVER_DIGEST_REPOS = [
  { name: "legalease", slug: "watt-mind/legalease" },
  { name: "lawz", slug: "watt-mind/lawz" },
];

/** The slug for one `--repos` entry, or null when it is not on the list. */
export function resolveDriverDigestRepo(repo) {
  const value = String(repo ?? "").trim();
  const entry = DRIVER_DIGEST_REPOS.find(
    (r) => r.name === value || r.slug === value,
  );
  return entry ? entry.slug : null;
}

/*
 * Shapes for every value that reaches the runner's shell or ssh's argv.
 *
 * Quoting alone is one missed interpolation away from `; touch /tmp/PWNED #` —
 * which is exactly what the cold review of WM-1105 proved through
 * `--candidate-role`. So each value is checked against a shape *before* any
 * string is built, and quoted as well. Host-read values are checked too: the
 * runner's own files are a lower-trust input than the operator's flags, not a
 * higher one.
 */

/**
 * ssh destination: `host` or `user@host`.
 *
 * The first character is deliberately narrower than the rest. `-oProxyCommand`
 * is a plausible-looking hostname to a character-class regex, and ssh reads a
 * leading dash as an option rather than a destination.
 */
export const HOST_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]*(@[A-Za-z0-9.:_-]+)?$/;

/** Publisher role inside the exchange candidate filename (`research_runner`). */
export const CANDIDATE_ROLE_RE = /^[a-z0-9_]+$/;

/** `qualification-stage.binding`, in the shape the driver writes it. */
export const BINDING_RE = /^sha256:[0-9a-f]{64}$/;

/** A Kubernetes namespace or object name (RFC 1123), read off the host. */
export const K8S_NAME_RE = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;

/**
 * A `metadata.resourceVersion`, which Kubernetes defines as opaque: never
 * parsed here, only compared and quoted, so this is a charset floor rather than
 * a claim about its meaning.
 */
export const RESOURCE_VERSION_RE = /^[A-Za-z0-9._-]+$/;

/** An ownerless evicted pod is only swept once it is this old. */
export const ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/** Pod-level `status.reason` values this sweep treats as disposable husks. */
export const SWEEPABLE_REASONS = ["Evicted", "ContainerStatusUnknown"];

export const DEFAULT_NAMESPACES = "office-*,legal-research-dev,legalease-pii";

export const LOG_DIR = path.join(homedir(), ".factory/logs/infra");

/**
 * Adapter output ceiling. Node's 1 MB `spawnSync` default is not a limit these
 * verbs can live with: `kubectl get pods -A -o json` on the dev cluster is
 * ~2.4 MB, and hitting the default surfaces as a bare `ssh` exit 255 with an
 * empty stderr — which reads like an unreachable host rather than a truncated
 * answer. Caught by the first live dry run (WM-1105).
 */
export const MAX_ADAPTER_OUTPUT = 64 * 1024 * 1024;

/**
 * Pod listing, projected on the host down to the fields the sweep decides on.
 *
 * The projection is not only about size. It fixes what this verb can possibly
 * look at: namespace, name, phase, reason, owners and age. Nothing about a
 * pod's spec, env or secrets crosses the ssh boundary into a log file.
 */
export const POD_PROJECTION = `set -euo pipefail
kubectl get pods -A -o json | python3 -c '
import json, sys
src = json.load(sys.stdin)
out = []
for pod in src.get("items", []):
    meta = pod.get("metadata", {})
    status = pod.get("status", {})
    out.append({
        "metadata": {
            "namespace": meta.get("namespace"),
            "name": meta.get("name"),
            "creationTimestamp": meta.get("creationTimestamp"),
            "ownerReferences": [
                {"kind": o.get("kind"), "name": o.get("name"), "uid": o.get("uid")}
                for o in meta.get("ownerReferences", [])
            ],
        },
        "status": {"phase": status.get("phase"), "reason": status.get("reason")},
    })
json.dump({"items": out}, sys.stdout)
'
`;

// ---------------------------------------------------------------------------
// Pure decision functions
// ---------------------------------------------------------------------------

/** `YYYYMMDD-HHMMSS` in local time, matching the reaper's log-file stamps. */
export function logStamp(ms) {
  const d = new Date(ms);
  const p2 = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-` +
    `${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`
  );
}

/** Split a comma-separated flag value into trimmed, non-empty entries. */
export function splitList(value) {
  return String(value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Does a namespace match one of the `office-*`-style patterns? `*` is the only
 * metacharacter and it does not cross nothing in particular — namespaces have
 * no separator structure to protect, so `*` is a plain "any run of characters".
 */
export function namespaceMatches(namespace, patterns) {
  const ns = String(namespace ?? "");
  return patterns.some((pattern) => {
    const rx = new RegExp(
      `^${String(pattern)
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*")}$`,
    );
    return rx.test(ns);
  });
}

/**
 * Is the passed digest the one actually installed on the host?
 *
 * Both the binary's own `sha256sum` and the `driver_sha256` recorded in the
 * install config must agree with it. Rotating the repo variables to a digest
 * that matches neither is how OPS-694 happened in the first place; rotating to
 * one that matches only the config would pin CI to a driver nobody installed.
 */
export function evaluateDigestRotation({ digest, binaryDigest, configDigest }) {
  if (!DIGEST_RE.test(String(digest ?? ""))) {
    return {
      ok: false,
      exitCode: EXIT.CANNOT_EVALUATE,
      reason: `--digest must look like sha256:<64 hex chars>, got ${JSON.stringify(digest ?? null)}`,
    };
  }
  const mismatches = [];
  if (binaryDigest !== digest) {
    mismatches.push(
      `${DRIVER_PATH} hashes to ${binaryDigest ?? "(unreadable)"}`,
    );
  }
  if (configDigest !== digest) {
    mismatches.push(
      `${DRIVER_CONFIG} records driver_sha256 ${configDigest ?? "(unreadable)"}`,
    );
  }
  if (mismatches.length) {
    return {
      ok: false,
      exitCode: EXIT.REFUSED,
      reason: `digest ${digest} is not what is installed: ${mismatches.join("; ")}`,
      mismatches,
    };
  }
  return { ok: true, exitCode: EXIT.OK, digest };
}

/**
 * The `resourceVersion` the transaction's JSON Patch was built against, from
 * its leading `{"op":"test","path":"/metadata/resourceVersion"}` op.
 *
 * Returns `null` when the patch has no such op — which is not "no precondition
 * to check", it is "this is not a patch this verb understands", and the caller
 * turns it into CANNOT EVALUATE rather than a pass.
 */
export function patchResourceVersionPrecondition(patch) {
  if (!Array.isArray(patch)) return null;
  const op = patch.find(
    (entry) =>
      entry?.op === "test" && entry?.path === "/metadata/resourceVersion",
  );
  const value = op?.value;
  return value === undefined || value === null ? null : String(value);
}

/**
 * Is this transaction directory safe to discard?
 *
 * "Unprepared" is the whole precondition. A transaction that has written
 * `promotion.state` or `coordinator.phase` has told the coordinator it owns
 * the promotion, and discarding it behind the coordinator's back is how you
 * turn a stuck publisher into a half-applied rollout. A transaction whose
 * deployment has moved past the `resourceVersion` it tested against has
 * already applied something to the cluster; the directory is then evidence,
 * not garbage. Both are hard refusals (CLNT-3170).
 */
export function evaluateDiscard({ role, probe }) {
  if (!ROLES.includes(role)) {
    return {
      ok: false,
      exitCode: EXIT.CANNOT_EVALUATE,
      reason: `--role must be one of ${ROLES.join("|")}, got ${JSON.stringify(role ?? null)}`,
    };
  }
  if (!probe?.dirExists) {
    return {
      ok: true,
      exitCode: EXIT.OK,
      nothingToDo: true,
      reason: `${PROMOTION_ROOT}/active/${role} does not exist — nothing is stranded`,
    };
  }
  const present = [];
  if (probe.promotionState) present.push("promotion.state");
  if (probe.coordinatorPhase) present.push("coordinator.phase");
  if (present.length) {
    return {
      ok: false,
      exitCode: EXIT.REFUSED,
      reason:
        `active/${role} is PREPARED, not stranded: ${present.join(" and ")} present. ` +
        `Discarding it would strand the coordinator mid-promotion — recover the transaction instead.`,
    };
  }
  const expected = patchResourceVersionPrecondition(probe.patch);
  if (expected !== null && !RESOURCE_VERSION_RE.test(expected)) {
    return {
      ok: false,
      exitCode: EXIT.CANNOT_EVALUATE,
      reason: `active/${role}/deployment-patch.json tests resourceVersion ${JSON.stringify(expected)}, which is not a value this verb will put in a shell comparison`,
    };
  }
  if (expected === null) {
    return {
      ok: false,
      exitCode: EXIT.CANNOT_EVALUATE,
      reason: `active/${role}/deployment-patch.json has no {"op":"test","path":"/metadata/resourceVersion"} precondition — cannot prove nothing was applied`,
    };
  }
  const live = probe.liveResourceVersion;
  if (!live) {
    return {
      ok: false,
      exitCode: EXIT.CANNOT_EVALUATE,
      reason: `could not read the live resourceVersion of ${probe.target ?? "the target deployment"} — cannot prove nothing was applied`,
    };
  }
  if (String(live) !== expected) {
    return {
      ok: false,
      exitCode: EXIT.REFUSED,
      reason:
        `deployment ${probe.target} has moved: patch tested resourceVersion ${expected}, live is ${live}. ` +
        `Something was applied after this patch was built — this is not an unprepared transaction.`,
    };
  }
  if (!probe.binding) {
    return {
      ok: false,
      exitCode: EXIT.CANNOT_EVALUATE,
      reason: `active/${role}/qualification-stage.binding is missing or empty — the driver has no binding to --recover`,
    };
  }
  if (!BINDING_RE.test(String(probe.binding))) {
    return {
      ok: false,
      exitCode: EXIT.CANNOT_EVALUATE,
      reason:
        `active/${role}/qualification-stage.binding is ${JSON.stringify(String(probe.binding))}, not the sha256:<64hex> the driver emits. ` +
        "That value would become an argument to sudo on the runner — refusing to pass it on.",
    };
  }
  return {
    ok: true,
    exitCode: EXIT.OK,
    role,
    binding: probe.binding,
    resourceVersion: expected,
    target: probe.target,
  };
}

/**
 * Which evicted pods are husks of something that already recovered?
 *
 * The owner test is the safety property: an evicted pod whose ReplicaSet has a
 * Running replica has been replaced and is pure garbage, while one whose owner
 * has nothing Running may be the only record of why a workload is down. The
 * Running sibling is read out of the same pod list — no second cluster call,
 * so the decision is a pure function of one snapshot.
 *
 * Fixture pods in the dev cluster have no controller at all (CLNT-3167), so an
 * ownerless evicted pod is swept only once it is older than a day.
 */
export function selectEvictedPods(
  items,
  { patterns, nowMs, orphanMinAgeMs = ORPHAN_MIN_AGE_MS } = {},
) {
  const pods = Array.isArray(items) ? items : [];
  const runningOwnerUids = new Set();
  for (const pod of pods) {
    if (pod?.status?.phase !== "Running") continue;
    for (const owner of pod?.metadata?.ownerReferences ?? []) {
      if (owner?.uid)
        runningOwnerUids.add(`${pod.metadata.namespace}/${owner.uid}`);
    }
  }

  const selected = [];
  const skipped = [];
  for (const pod of pods) {
    const namespace = pod?.metadata?.namespace ?? "";
    const name = pod?.metadata?.name ?? "";
    if (!namespaceMatches(namespace, patterns ?? [])) continue;
    const phase = pod?.status?.phase;
    if (phase !== "Failed") continue;
    // The pair becomes two arguments in a shell command on the runner. The API
    // server will not mint a name outside RFC 1123, so anything else means the
    // snapshot is not what this verb thinks it is — keep, never delete.
    if (!K8S_NAME_RE.test(namespace) || !K8S_NAME_RE.test(name)) {
      skipped.push({
        namespace,
        name,
        reason: pod?.status?.reason ?? null,
        why: "namespace or name is not an RFC 1123 Kubernetes name",
      });
      continue;
    }
    const reason = pod?.status?.reason ?? null;
    if (!SWEEPABLE_REASONS.includes(reason)) {
      skipped.push({
        namespace,
        name,
        reason,
        why: `phase Failed but reason ${reason ?? "(none)"} is not ${SWEEPABLE_REASONS.join("/")}`,
      });
      continue;
    }
    const owners = pod?.metadata?.ownerReferences ?? [];
    if (owners.length) {
      const alive = owners.some((owner) =>
        runningOwnerUids.has(`${namespace}/${owner?.uid}`),
      );
      if (!alive) {
        const label = owners
          .map((o) => `${o?.kind ?? "?"}/${o?.name ?? "?"}`)
          .join(", ");
        skipped.push({
          namespace,
          name,
          reason,
          why: `owner ${label} has no Running replica — this husk may be the only evidence`,
        });
        continue;
      }
      selected.push({
        namespace,
        name,
        reason,
        why: `owner ${owners[0]?.kind ?? "?"}/${owners[0]?.name ?? "?"} has a Running replica`,
      });
      continue;
    }
    const created = Date.parse(pod?.metadata?.creationTimestamp ?? "");
    const ageMs = Number.isNaN(created)
      ? null
      : (nowMs ?? Date.now()) - created;
    if (ageMs === null) {
      skipped.push({
        namespace,
        name,
        reason,
        why: "ownerless and has no readable creationTimestamp",
      });
      continue;
    }
    if (ageMs < orphanMinAgeMs) {
      skipped.push({
        namespace,
        name,
        reason,
        why: `ownerless and only ${Math.round(ageMs / 3600000)}h old (< ${Math.round(orphanMinAgeMs / 3600000)}h)`,
      });
      continue;
    }
    selected.push({
      namespace,
      name,
      reason,
      why: `ownerless and ${Math.round(ageMs / 3600000)}h old`,
    });
  }
  return { selected, skipped };
}

// ---------------------------------------------------------------------------
// Adapters (the imperative shell)
// ---------------------------------------------------------------------------

/**
 * Run a bounded shell script on the host over ssh.
 *
 * `BatchMode=yes` because an infra verb that sits on a password prompt inside
 * an unattended run is worse than one that fails.
 */
/**
 * Why did an adapter fail, in one line?
 *
 * `spawnSync`'s own failures (ENOBUFS, ETIMEDOUT, ENOENT) arrive on `.error`
 * with an empty stderr and a generic status, so reporting stderr alone turns a
 * truncated answer into what looks like an unreachable host.
 */
export function adapterFailure(result) {
  const stderr = String(result?.stderr ?? "").trim();
  const spawnError = result?.error?.message ? `${result.error.message}` : null;
  return (
    [spawnError, stderr].filter(Boolean).join(" — ") ||
    `exit ${result?.status ?? "(none)"}`
  );
}

export function defaultSsh(host, script, { timeoutMs = 120_000 } = {}) {
  // The chokepoint every verb goes through, so the destination is checked here
  // as well as at the flag: a bad host reads as a failed adapter (exit 3),
  // never as an argv entry ssh gets to interpret.
  if (!HOST_RE.test(String(host ?? ""))) {
    return {
      status: 1,
      stdout: "",
      stderr: `refusing to ssh to ${JSON.stringify(host ?? null)}: not a plain [user@]host`,
    };
  }
  return spawnSync(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, "bash -s"],
    {
      input: script,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: MAX_ADAPTER_OUTPUT,
    },
  );
}

/** Run `gh` locally. */
export function defaultGh(args, { timeoutMs = 60_000 } = {}) {
  return spawnSync("gh", args, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: MAX_ADAPTER_OUTPUT,
  });
}

/**
 * `kubectl get pods -A -o json` on the host.
 *
 * kubectl runs over ssh rather than locally: the dev cluster is k3s on the
 * runner and its kubeconfig lives there, so "the host" is the single place
 * that is always right.
 */
export function defaultKubectlPods(host, { ssh = defaultSsh } = {}) {
  return ssh(host, POD_PROJECTION, { timeoutMs: 120_000 });
}

/** Append one line to this verb's log file. Never throws: logging is not the job. */
export function makeLogger(
  verb,
  { nowMs = Date.now(), logDir = LOG_DIR } = {},
) {
  const file = path.join(logDir, `${verb}-${logStamp(nowMs)}.log`);
  let usable = true;
  try {
    // 0700: the log records which host was touched and what was removed.
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
  } catch {
    usable = false;
  }
  const write = (line) => {
    if (!usable) return;
    try {
      appendFileSync(file, `${line}\n`);
    } catch {
      usable = false;
    }
  };
  write(`# ${verb} ${new Date(nowMs).toISOString()}`);
  return { file, write };
}

/** Post one line on the ticket through the same CLI every other stage uses. */
export function defaultComment(ticket, body, { repo = null } = {}) {
  const root = process.env.FACTORY_ROOT || path.resolve(import.meta.dir, "..");
  const args = [path.join(root, "tools/ticket.mjs"), "comment", ticket];
  if (repo) args.push("--repo", repo);
  args.push(body);
  return spawnSync("bun", args, { encoding: "utf8", timeout: 60_000 });
}

// ---------------------------------------------------------------------------
// Verb: rotate-driver-digest
// ---------------------------------------------------------------------------

const DIGEST_PROBE = `set -euo pipefail
printf 'binary\\t'
sha256sum ${DRIVER_PATH} | awk '{print "sha256:" $1}'
printf 'config\\t'
sudo -n cat ${DRIVER_CONFIG} | python3 -c 'import json,sys; print(json.load(sys.stdin).get("driver_sha256",""))'
`;

/** Parse the two `key\tvalue` lines the probe emits. */
export function parseDigestProbe(stdout) {
  const out = { binaryDigest: null, configDigest: null };
  for (const line of String(stdout ?? "").split("\n")) {
    const [key, value] = line.split("\t");
    if (key === "binary") out.binaryDigest = (value ?? "").trim() || null;
    if (key === "config") out.configDigest = (value ?? "").trim() || null;
  }
  return out;
}

export function rotateDriverDigest(
  { digest, repos, host = DEFAULT_HOST, yes = false },
  {
    ssh = defaultSsh,
    gh = defaultGh,
    out = console.log,
    err = console.error,
  } = {},
) {
  if (!repos?.length) {
    err("CANNOT EVALUATE — --repos is required (e.g. --repos legalease,lawz)");
    return { exitCode: EXIT.CANNOT_EVALUATE, actions: 0 };
  }
  const slugs = [];
  for (const repo of repos) {
    const slug = resolveDriverDigestRepo(repo);
    if (!slug) {
      err(
        `CANNOT EVALUATE — ${JSON.stringify(String(repo))} is not a repository this verb rotates ` +
          `(allowed: ${DRIVER_DIGEST_REPOS.map((r) => `${r.name} (${r.slug})`).join(", ")})`,
      );
      return { exitCode: EXIT.CANNOT_EVALUATE, actions: 0 };
    }
    slugs.push(slug);
  }
  const probe = ssh(host, DIGEST_PROBE);
  if (probe?.status !== 0) {
    err(
      `CANNOT EVALUATE — reading the installed driver on ${host} failed: ${adapterFailure(probe)}`,
    );
    return { exitCode: EXIT.CANNOT_EVALUATE, actions: 0 };
  }
  const { binaryDigest, configDigest } = parseDigestProbe(probe.stdout);
  const verdict = evaluateDigestRotation({
    digest,
    binaryDigest,
    configDigest,
  });
  if (!verdict.ok) {
    err(
      verdict.exitCode === EXIT.REFUSED
        ? `REFUSED — ${verdict.reason}`
        : `CANNOT EVALUATE — ${verdict.reason}`,
    );
    err("no repository variable was changed.");
    return { exitCode: verdict.exitCode, actions: 0 };
  }
  out(`installed driver on ${host} verified: ${digest}`);
  out(`  ${DRIVER_PATH} sha256sum      ✓`);
  out(`  ${DRIVER_CONFIG} driver_sha256 ✓`);

  const rotated = [];
  for (const slug of slugs) {
    const read = gh([
      "variable",
      "get",
      "DEV_QUALIFICATION_DRIVER_SHA256",
      "-R",
      slug,
    ]);
    const before =
      read?.status === 0 ? String(read.stdout ?? "").trim() : "(unset)";
    if (before === digest) {
      out(`${slug}: ${before} — already current, skipped`);
      continue;
    }
    if (!yes) {
      out(`${slug}: ${before} -> ${digest}   [dry run — pass --yes to apply]`);
      continue;
    }
    const write = gh([
      "variable",
      "set",
      "DEV_QUALIFICATION_DRIVER_SHA256",
      "-R",
      slug,
      "--body",
      digest,
    ]);
    if (write?.status !== 0) {
      err(
        `CANNOT EVALUATE — gh variable set failed for ${slug}: ${adapterFailure(write)}`,
      );
      // Which repos are already on the new digest is the first thing the
      // operator needs: a half-rotated pair is a split qualify gate, and
      // "actions: 1" without names does not say which half.
      err(
        rotated.length
          ? `already rotated to ${digest}: ${rotated.join(", ")}. ${slug} and any repo after it are unchanged — re-run to finish.`
          : "no repository variable was changed.",
      );
      return { exitCode: EXIT.CANNOT_EVALUATE, actions: rotated.length };
    }
    const after = gh([
      "variable",
      "get",
      "DEV_QUALIFICATION_DRIVER_SHA256",
      "-R",
      slug,
    ]);
    const now =
      after?.status === 0 ? String(after.stdout ?? "").trim() : "(unreadable)";
    out(`${slug}: ${before} -> ${now}`);
    rotated.push(slug);
  }
  return { exitCode: EXIT.OK, actions: rotated.length, digest };
}

// ---------------------------------------------------------------------------
// Verb: discard-unprepared-transaction
// ---------------------------------------------------------------------------

/**
 * Read the whole transaction directory under the promotion lock, in one ssh.
 *
 * `flock -w 30 -x` is the same lock the publishers take, so the probe cannot
 * race a publisher that is mid-transaction. Output is one JSON object because
 * the decision belongs in `evaluateDiscard`, not in this shell.
 */
export function discardProbeScript(role) {
  return `set -euo pipefail
exec 9>${PROMOTION_LOCK}
flock -w 30 -x 9 || { echo "lock-timeout" >&2; exit 75; }
DIR='${PROMOTION_ROOT}/active/${role}'
python3 - "$DIR" <<'PY'
import json, os, sys
d = sys.argv[1]
def read(name):
    try:
        with open(os.path.join(d, name)) as fh:
            return fh.read()
    except OSError:
        return None
patch = read("deployment-patch.json")
live = read("live-deployment.json")
target = None
if live:
    try:
        meta = json.loads(live)["metadata"]
        target = {"namespace": meta.get("namespace"), "name": meta.get("name")}
    except Exception:
        target = None
binding = read("qualification-stage.binding")
print(json.dumps({
    "dirExists": os.path.isdir(d),
    "promotionState": os.path.exists(os.path.join(d, "promotion.state")),
    "coordinatorPhase": os.path.exists(os.path.join(d, "coordinator.phase")),
    "patch": json.loads(patch) if patch else None,
    "target": target,
    "binding": (binding or "").strip() or None,
    "entries": sorted(os.listdir(d)) if os.path.isdir(d) else [],
    "exchange": sorted(os.listdir("${EXCHANGE_DIR}")) if os.path.isdir("${EXCHANGE_DIR}") else [],
}))
PY
`;
}

/**
 * The line the act script crosses from "nothing has happened" to "the
 * transaction is gone". Everything after it is durability and reporting.
 */
export const DISCARD_POINT_OF_NO_RETURN =
  "# --- point of no return: the transaction directory is gone ---";

/**
 * Discard the directory, under the lock, re-asserting every precondition.
 *
 * The lock is released between the probe and this script (two ssh sessions),
 * so the preconditions are re-checked here in shell before anything is
 * removed — including the live `resourceVersion`, which is the one that can
 * change without leaving a file behind. Exit 9 means the world changed under
 * us and the caller reports a refusal rather than a success; exit 10 means the
 * re-check itself could not be made, which is not a pass either.
 *
 * Errexit is deliberately never enabled. Before the point of no return every
 * step carries its own `|| exit`; after it, a failing fsync or journal tail is
 * a warning on stdout, because a caller told "CANNOT EVALUATE — actions: 0"
 * about a removal that already happened goes looking for a directory that no
 * longer exists (cold review of WM-1105).
 */
export function discardActScript(
  role,
  { binding, candidateRole, target, resourceVersion },
) {
  // These are assertions, not validation: every caller has already refused on
  // these shapes. Reaching here with a bad one means a new call path skipped
  // the check, and building the script anyway is how the injection lands.
  const assertShape = (label, value, re) => {
    if (!re.test(String(value ?? ""))) {
      throw new Error(
        `refusing to build a discard script: ${label} ${JSON.stringify(value ?? null)} does not match ${re}`,
      );
    }
  };
  if (!ROLES.includes(role)) {
    throw new Error(
      `refusing to build a discard script for role ${JSON.stringify(role ?? null)}`,
    );
  }
  assertShape("binding", binding, BINDING_RE);
  assertShape("candidate role", candidateRole, CANDIDATE_ROLE_RE);
  assertShape("target namespace", target?.namespace, K8S_NAME_RE);
  assertShape("target name", target?.name, K8S_NAME_RE);
  assertShape("resourceVersion", resourceVersion, RESOURCE_VERSION_RE);

  const dir = `${PROMOTION_ROOT}/active/${role}`;
  const candidateFile = `${EXCHANGE_DIR}/publisher-${candidateRole}-candidate.json`;
  const ref = `${target.namespace}/${target.name}`;
  return `set -uo pipefail
exec 9>${PROMOTION_LOCK}
flock -w 30 -x 9 || { echo "lock-timeout" >&2; exit 75; }
DIR='${dir}'
[ -d "$DIR" ] || { echo "transaction directory vanished" >&2; exit 9; }
[ -e "$DIR/promotion.state" ] && { echo "promotion.state appeared" >&2; exit 9; }
[ -e "$DIR/coordinator.phase" ] && { echo "coordinator.phase appeared" >&2; exit 9; }
LIVE=$(kubectl -n '${target.namespace}' get deployment '${target.name}' -o jsonpath='{.metadata.resourceVersion}') || { echo "could not re-read the resourceVersion of ${ref} under the lock" >&2; exit 10; }
[ "$LIVE" = '${resourceVersion}' ] || { echo "deployment ${ref} moved to $LIVE, patch tested ${resourceVersion}" >&2; exit 9; }
echo "== ${ref} still at resourceVersion ${resourceVersion}"
echo "== driver --recover ${binding}"
sudo -n ${DRIVER_PATH} --recover '${binding}'
RECOVER_STATUS=$?
echo "== driver --recover exit $RECOVER_STATUS"
rm -f '${candidateFile}' || { echo "could not remove ${candidateFile}" >&2; exit 1; }
rm -rf "$DIR" || { echo "could not remove $DIR" >&2; exit 1; }
${DISCARD_POINT_OF_NO_RETURN}
if python3 -c 'import os,sys; fd=os.open(sys.argv[1], os.O_RDONLY); os.fsync(fd); os.close(fd)' '${PROMOTION_ROOT}/active'; then
  echo "== removed ${dir} (fsynced)"
else
  echo "== removed ${dir}; WARNING: fsync of ${PROMOTION_ROOT}/active failed (exit $?)"
fi
echo "== journal tail"
if sudo -n sh -c 'ls ${JOURNAL_DIR}/*.json 2>/dev/null | sort | tail -4 | xargs -r cat'; then
  echo
else
  echo "== WARNING: journal tail failed (exit $?); the discard itself completed"
fi
exit 0
`;
}

/** The live `metadata.resourceVersion` of one deployment, or null. */
export function defaultDeploymentResourceVersion(
  host,
  { namespace, name },
  { ssh = defaultSsh } = {},
) {
  const run = ssh(
    host,
    `kubectl -n '${namespace}' get deployment '${name}' -o jsonpath='{.metadata.resourceVersion}'\n`,
  );
  return run?.status === 0 ? String(run.stdout ?? "").trim() || null : null;
}

export function discardUnpreparedTransaction(
  { role, host = DEFAULT_HOST, yes = false, candidateRole = null },
  {
    ssh = defaultSsh,
    deploymentResourceVersion = defaultDeploymentResourceVersion,
    out = console.log,
    err = console.error,
  } = {},
) {
  const roleValid = ROLES.includes(role);
  if (!roleValid) {
    const verdict = evaluateDiscard({ role, probe: null });
    err(`CANNOT EVALUATE — ${verdict.reason}`);
    return { exitCode: EXIT.CANNOT_EVALUATE, actions: 0 };
  }
  // The publisher spells its roles with underscores, so the default is derived
  // from --role; either way the value becomes a path inside a script that runs
  // as root on the runner, and it is checked before the host is touched at all.
  const candidate = candidateRole ?? role.replace(/-/g, "_");
  if (!CANDIDATE_ROLE_RE.test(String(candidate))) {
    err(
      `CANNOT EVALUATE — --candidate-role must be lower-case letters, digits and underscores, got ${JSON.stringify(candidateRole ?? null)}`,
    );
    return { exitCode: EXIT.CANNOT_EVALUATE, actions: 0 };
  }
  const probeRun = ssh(host, discardProbeScript(role));
  if (probeRun?.status !== 0) {
    err(
      `CANNOT EVALUATE — probing ${PROMOTION_ROOT}/active/${role} on ${host} failed: ${adapterFailure(probeRun)}`,
    );
    return { exitCode: EXIT.CANNOT_EVALUATE, actions: 0 };
  }
  let probe;
  try {
    probe = JSON.parse(String(probeRun.stdout ?? "").trim());
  } catch (e) {
    err(`CANNOT EVALUATE — unreadable probe output: ${e.message}`);
    return { exitCode: EXIT.CANNOT_EVALUATE, actions: 0 };
  }

  let targetRef = null;
  if (probe.dirExists) {
    out(`active/${role} contains: ${probe.entries.join(", ") || "(empty)"}`);
    const target = probe.target;
    if (target?.namespace && target?.name) {
      if (
        !K8S_NAME_RE.test(String(target.namespace)) ||
        !K8S_NAME_RE.test(String(target.name))
      ) {
        err(
          `CANNOT EVALUATE — active/${role}/live-deployment.json names ${JSON.stringify(`${target.namespace}/${target.name}`)}, which is not a namespace/name pair this verb will put in a kubectl command`,
        );
        return { exitCode: EXIT.CANNOT_EVALUATE, actions: 0 };
      }
      targetRef = {
        namespace: String(target.namespace),
        name: String(target.name),
      };
      probe.liveResourceVersion = deploymentResourceVersion(host, targetRef, {
        ssh,
      });
      probe.target = `${targetRef.namespace}/${targetRef.name}`;
    } else {
      probe.target = null;
    }
  }

  const verdict = evaluateDiscard({ role, probe });
  if (!verdict.ok) {
    err(
      verdict.exitCode === EXIT.REFUSED
        ? `REFUSED — ${verdict.reason}`
        : `CANNOT EVALUATE — ${verdict.reason}`,
    );
    err("nothing was removed.");
    return { exitCode: verdict.exitCode, actions: 0 };
  }
  if (verdict.nothingToDo) {
    out(verdict.reason);
    return { exitCode: EXIT.OK, actions: 0 };
  }

  out(
    `unprepared: no promotion.state / coordinator.phase, and ${verdict.target} is still at resourceVersion ${verdict.resourceVersion}`,
  );
  out(`plan:`);
  out(`  sudo ${DRIVER_PATH} --recover ${verdict.binding}`);
  out(`  rm -f ${EXCHANGE_DIR}/publisher-${candidate}-candidate.json`);
  out(`  rm -rf ${PROMOTION_ROOT}/active/${role}   (then fsync active/)`);
  if (probe.exchange?.length) {
    out(`  exchange currently holds: ${probe.exchange.join(", ")}`);
  } else {
    out(`  exchange is currently empty`);
  }
  if (!yes) {
    out("[dry run — pass --yes to apply]");
    return { exitCode: EXIT.OK, actions: 0 };
  }

  const act = ssh(
    host,
    discardActScript(role, {
      binding: verdict.binding,
      candidateRole: candidate,
      target: targetRef,
      resourceVersion: verdict.resourceVersion,
    }),
    {
      timeoutMs: 20 * 60_000,
    },
  );
  if (act?.status === 9) {
    err(
      `REFUSED — the transaction changed between probe and act: ${String(act.stderr ?? "").trim()}`,
    );
    return { exitCode: EXIT.REFUSED, actions: 0 };
  }
  if (act?.status !== 0) {
    err(`CANNOT EVALUATE — discard failed on ${host}: ${adapterFailure(act)}`);
    return { exitCode: EXIT.CANNOT_EVALUATE, actions: 0 };
  }
  out(String(act.stdout ?? "").trimEnd());
  return { exitCode: EXIT.OK, actions: 1 };
}

// ---------------------------------------------------------------------------
// Verb: sweep-evicted-pods
// ---------------------------------------------------------------------------

export function sweepEvictedPods(
  { namespaces = DEFAULT_NAMESPACES, host = DEFAULT_HOST, yes = false },
  {
    ssh = defaultSsh,
    kubectlPods = defaultKubectlPods,
    now = () => Date.now(),
    out = console.log,
    err = console.error,
  } = {},
) {
  const patterns = splitList(namespaces);
  if (!patterns.length) {
    err("CANNOT EVALUATE — --namespaces is empty");
    return { exitCode: EXIT.CANNOT_EVALUATE, actions: 0 };
  }
  const listed = kubectlPods(host, { ssh });
  if (listed?.status !== 0) {
    err(
      `CANNOT EVALUATE — kubectl get pods on ${host} failed: ${adapterFailure(listed)}`,
    );
    return { exitCode: EXIT.CANNOT_EVALUATE, actions: 0 };
  }
  let items;
  try {
    items = JSON.parse(String(listed.stdout ?? "")).items;
  } catch (e) {
    err(`CANNOT EVALUATE — unreadable kubectl JSON: ${e.message}`);
    return { exitCode: EXIT.CANNOT_EVALUATE, actions: 0 };
  }
  const { selected, skipped } = selectEvictedPods(items, {
    patterns,
    nowMs: now(),
  });

  out(`namespaces: ${patterns.join(", ")}`);
  out(`${selected.length} pod(s) to delete, ${skipped.length} kept:`);
  for (const pod of selected) {
    out(`  DELETE ${pod.namespace}/${pod.name}  (${pod.reason}; ${pod.why})`);
  }
  for (const pod of skipped) {
    out(`  keep   ${pod.namespace}/${pod.name}  (${pod.why})`);
  }
  if (!selected.length) return { exitCode: EXIT.OK, actions: 0 };
  if (!yes) {
    out("[dry run — pass --yes to delete]");
    return { exitCode: EXIT.OK, actions: 0 };
  }

  let actions = 0;
  for (const pod of selected) {
    const del = ssh(
      host,
      `kubectl delete pod -n '${pod.namespace}' '${pod.name}'\n`,
      { timeoutMs: 120_000 },
    );
    if (del?.status !== 0) {
      err(`  failed ${pod.namespace}/${pod.name}: ${adapterFailure(del)}`);
      continue;
    }
    out(`  deleted ${pod.namespace}/${pod.name}`);
    actions += 1;
  }
  if (actions === 0) {
    // Every delete failed. Exit 0 here would read as "the sweep ran and the
    // husks are gone", and the qualify gate this verb exists to unblock would
    // still be red with nobody looking (cold review of WM-1105).
    err(
      `CANNOT EVALUATE — all ${selected.length} delete(s) failed; nothing was swept`,
    );
    return { exitCode: EXIT.CANNOT_EVALUATE, actions: 0 };
  }
  return { exitCode: EXIT.OK, actions };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export const USAGE = `usage: factory infra <verb> [flags]

  rotate-driver-digest --digest sha256:<64hex> --repos legalease,lawz [--host user@host]
      (--repos accepts only legalease and lawz)
      Verify the digest against the driver installed on the runner (binary
      sha256sum AND config.json driver_sha256), then set
      DEV_QUALIFICATION_DRIVER_SHA256 in each repo. (OPS-694)

  discard-unprepared-transaction --role research-runner|case-agent [--host user@host]
      Under the promotion lock, discard a transaction directory that was never
      prepared: refuses if promotion.state or coordinator.phase exists, or if
      the target deployment moved past the patch's resourceVersion. (CLNT-3170)

  sweep-evicted-pods [--namespaces 'office-*,legal-research-dev,legalease-pii'] [--host user@host]
      Delete Failed/Evicted pod husks whose owner already has a Running
      replica (or which are ownerless and older than 24h). (CLNT-3167)

Common flags:
  --yes            actually do it; without it every verb is a dry run
  --dry-run        explicit spelling of the default; refuses with --yes
  --ticket <ID>    post a one-line result comment on that ticket
  --ticket-repo <name>  route the comment through a specific configured repo
  --help           this text

Exit 0 evaluated clean · 2 REFUSED (nothing mutated) · 3 CANNOT EVALUATE`;

/** Parse argv into `{ verb, flags }`; repeated flags take the last value. */
export function parseArgs(argv) {
  const [verb, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (eq !== -1) {
      flags[key] = arg.slice(eq + 1);
      continue;
    }
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    i += 1;
  }
  return { verb: verb ?? null, flags };
}

export function runCli(argv, deps = {}) {
  const { out = console.log, err = console.error } = deps;
  const { verb, flags } = parseArgs(argv);
  if (!verb || verb === "--help" || verb === "help") {
    out(USAGE);
    return verb ? EXIT.OK : EXIT.CANNOT_EVALUATE;
  }
  if (!VERBS.includes(verb)) {
    err(`factory infra: unknown verb '${verb}' (want: ${VERBS.join(", ")})`);
    err(USAGE);
    return EXIT.CANNOT_EVALUATE;
  }
  if (flags.help === true) {
    out(USAGE);
    return EXIT.OK;
  }

  // Flag validation runs before the logger and before any adapter: an
  // invocation this CLI will not carry out should leave no log file behind and
  // must never reach the runner. Each of these values ends up in ssh's argv or
  // in a script that runs as root on the other side.
  const yes = flags.yes === true || flags.yes === "true";
  // Any spelling of --dry-run is a dry run unless it is literally "false":
  // the parser lets a flag swallow the next bare token, and "--yes --dry-run
  // now" must not become an apply.
  const dryRun = flags["dry-run"] !== undefined && flags["dry-run"] !== "false";
  if (yes && dryRun) {
    err(
      "CANNOT EVALUATE — contradictory flags: --yes says apply, --dry-run says do not. Pass exactly one.",
    );
    return EXIT.CANNOT_EVALUATE;
  }
  if (
    flags.host !== undefined &&
    (typeof flags.host !== "string" || !HOST_RE.test(flags.host))
  ) {
    err(
      `CANNOT EVALUATE — --host must be a plain [user@]host, got ${JSON.stringify(flags.host)}. It becomes ssh's destination argument, where a leading dash is read as an option.`,
    );
    return EXIT.CANNOT_EVALUATE;
  }
  if (
    flags["candidate-role"] !== undefined &&
    (typeof flags["candidate-role"] !== "string" ||
      !CANDIDATE_ROLE_RE.test(flags["candidate-role"]))
  ) {
    err(
      `CANNOT EVALUATE — --candidate-role must be lower-case letters, digits and underscores, got ${JSON.stringify(flags["candidate-role"])}. It is interpolated into a path inside a script that runs on the runner.`,
    );
    return EXIT.CANNOT_EVALUATE;
  }
  const host = typeof flags.host === "string" ? flags.host : DEFAULT_HOST;

  const nowMs = deps.now ? deps.now() : Date.now();
  const logger =
    deps.logger ?? makeLogger(verb, { nowMs, logDir: deps.logDir });
  const tee =
    (sink) =>
    (...args) => {
      const line = args.join(" ");
      sink(line);
      logger.write(line);
    };
  const verbDeps = { ...deps, out: tee(out), err: tee(err) };

  let result;
  if (verb === "rotate-driver-digest") {
    result = rotateDriverDigest(
      {
        digest: typeof flags.digest === "string" ? flags.digest : null,
        repos: splitList(flags.repos),
        host,
        yes,
      },
      verbDeps,
    );
  } else if (verb === "discard-unprepared-transaction") {
    result = discardUnpreparedTransaction(
      {
        role: typeof flags.role === "string" ? flags.role : null,
        host,
        yes,
        candidateRole:
          typeof flags["candidate-role"] === "string"
            ? flags["candidate-role"]
            : null,
      },
      verbDeps,
    );
  } else {
    result = sweepEvictedPods(
      {
        namespaces:
          typeof flags.namespaces === "string"
            ? flags.namespaces
            : DEFAULT_NAMESPACES,
        host,
        yes,
      },
      verbDeps,
    );
  }

  const verdict =
    result.exitCode === EXIT.OK
      ? yes
        ? `applied ${result.actions} action(s)`
        : "dry run — nothing changed"
      : result.exitCode === EXIT.REFUSED
        ? "REFUSED"
        : "CANNOT EVALUATE";
  verbDeps.out(`log: ${logger.file}`);

  if (typeof flags.ticket === "string") {
    const comment = deps.comment ?? defaultComment;
    comment(
      flags.ticket,
      `factory infra ${verb} on ${host} — ${verdict} (log ${logger.file})`,
      {
        repo:
          typeof flags["ticket-repo"] === "string"
            ? flags["ticket-repo"]
            : null,
      },
    );
  }
  return result.exitCode;
}

if (import.meta.main) {
  process.exit(runCli(process.argv.slice(2)));
}
