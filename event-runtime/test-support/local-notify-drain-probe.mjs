/**
 * Isolated probe for the worker's drain-on-throw behaviour (GH-2011).
 *
 * `executeClaimed` must drain a worktree agent's retained local-notify outbox
 * from its adapter `finally`, so an adapter that throws can never strand an
 * escalation. Exercising that end to end needs a claimed run, a worktree
 * workspace, a throwing adapter and a control-plane inbox — enough moving
 * parts that, inside the shared worker suite, the scenario was load- and
 * order-sensitive: four dispatch-worktree repo-verify gates failed on it in a
 * single morning while every isolated re-run passed, because the surrounding
 * suite mutates module-level fixtures (the shared `worker-test-helpers`
 * temp-dir tracker, tracked child processes, frozen clocks) that this scenario
 * reads through `executeClaimed`.
 *
 * So it runs here, as its own process, spawned by
 * `worker.test.mjs`. This process owns all of that state, and the only thing
 * the assertions can observe is the drain itself. Each assertion carries its
 * own message and exits non-zero, so a failure names the invariant that broke.
 *
 * Usage: `bun event-runtime/test-support/local-notify-drain-probe.mjs <port>`
 * — the caller allocates an ephemeral port and passes it in, so the probe
 * never depends on a fixed local port being free. Prints `PROBE_OK` and exits
 * 0 when every invariant holds.
 */
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { claimNext, executeClaimed } from "../lib/worker.mjs";
import { openDb } from "../lib/db.mjs";
import { createRun, transition } from "../lib/lifecycle.mjs";
import { canonicalJson, hashJson } from "../lib/canonical.mjs";
import { loadRegistry } from "../lib/registry.mjs";

const PORT = String(process.argv[2] ?? "").trim();
assert.match(PORT, /^[1-9]\d*$/, "probe requires an ephemeral port argument");

const T0 = Date.parse("2026-08-12T10:00:00Z");
const tmpDirs = [];
const tmp = (prefix) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
};
process.on("exit", () => {
  for (const dir of tmpDirs.reverse())
    rmSync(dir, { recursive: true, force: true });
});

const registry = loadRegistry();
const db = openDb(":memory:");
const home = tmp("evrt-local-notify-throw-");
const runId = "run_local_notify_adapter_throw";
const ticket = "watt-mind/factory#1973";
const input = { repo: "factory", ticket };
const spec = {
  schemaVersion: "factory.run-spec/v1",
  runId,
  agent: "factory-status-report@1",
  input,
  inputHash: hashJson(input),
  workspace: { type: "worktree" },
  adapter: "fake",
  promptVersion: "git:test",
  policyVersion: "git:test",
  outputContract: "factory.status-report/v1",
  capabilities: ["tracker:read"],
  timeoutSeconds: 5,
  maxAttempts: 1,
  idempotencyKey: `idem-${runId}`,
};
createRun(db, {
  runId: spec.runId,
  idempotencyKey: spec.idempotencyKey,
  spec,
  specJson: canonicalJson(spec),
  specHash: hashJson(spec),
  actor: "test",
  policyVersion: "test",
  now: T0,
});
transition(db, { runId, to: "APPROVED", actor: "test", now: T0 });
transition(db, { runId, to: "QUEUED", actor: "test", now: T0 });

const opts = (extra = {}) => ({
  owner: "w1",
  workspacesRoot: tmp("evrt-worker-"),
  now: T0,
  policyVersion: "test",
  policyRoot: tmp("evrt-worker-empty-policy-"),
  ...extra,
});

const claim = claimNext(db, opts());
const materializeCalls = [];
const posted = [];
const comments = [];
// The delivery seam is injected, never a global fetch spy: the first POST is
// accepted (201) and the second refused (503), so one notification is
// delivered and one stays undelivered.
const localNotifyFetch = async (url, init) => {
  posted.push({ url, init });
  return new Response("{}", { status: posted.length === 1 ? 201 : 503 });
};
const description = "## Owned Paths\n- event-runtime/lib/worker.mjs\n";
const dispatch = {
  locksDir: tmp("evrt-local-notify-throw-locks-"),
  leasesDir: tmp("evrt-local-notify-throw-leases-"),
  fetchTicket: () => ({
    identifier: ticket,
    state: { name: "Todo" },
    assignee: null,
    labels: { nodes: [{ name: "ai:agent-ready" }] },
    description,
  }),
  fetchInFlight: () => [],
  countLeases: () => 0,
  budgetRefusal: () => null,
  claimTicket: () => ({ ok: true }),
  commentTicket: (args) => comments.push(args),
};
const throwingAdapter = {
  async execute() {
    const outbox = path.join(home, "outbox", `${runId}.jsonl`);
    mkdirSync(path.dirname(outbox), { recursive: true });
    writeFileSync(
      outbox,
      ["delivered notification", "retained notification"]
        .map((title) =>
          JSON.stringify({
            schemaVersion: "factory.local-notify-outbox/v1",
            runId,
            kind: "BLOCKED",
            title: `BLOCKED watt-mind/factory#1973: ${title}`,
            refs: { issue: ticket, repo: "factory" },
            source: `agent:${runId}`,
          }),
        )
        .join("\n") + "\n",
    );
    throw new Error("adapter threw");
  },
};

const summary = await executeClaimed(
  db,
  registry,
  { fake: throwingAdapter },
  claim,
  opts({
    dispatch,
    env: {
      FACTORY_EVENT_HOME: home,
      FACTORY_EVENT_PORT: PORT,
      FACTORY_CONTROL_API_TOKEN: "worker-token",
    },
    materializeWorktree: (args) => {
      materializeCalls.push(args);
      return { injected: true };
    },
    localNotifyFetch,
  }),
);

assert.equal(
  summary?.terminalState,
  "FAILED",
  `an adapter throw must still terminate FAILED, got ${JSON.stringify(summary)}`,
);
assert.equal(
  materializeCalls.length,
  1,
  `the worktree must be materialized exactly once, got ${materializeCalls.length}`,
);
assert.equal(
  posted.length,
  2,
  `both retained notifications must be attempted, got ${posted.length}`,
);
assert.equal(
  posted[0].url,
  `http://127.0.0.1:${PORT}/inbox`,
  "delivery must target the worker's control-plane inbox",
);
assert.deepEqual(
  (({ title, refs }) => ({ title, refs }))(JSON.parse(posted[0].init.body)),
  {
    title: "BLOCKED watt-mind/factory#1973: delivered notification",
    refs: { issue: ticket, repo: "factory" },
  },
  "the first POST carries the first retained notification verbatim",
);
assert.equal(
  comments.length,
  1,
  `exactly one ticket comment is expected, got ${comments.length}`,
);
assert.equal(comments[0].repo, "factory");
assert.equal(comments[0].ticket, ticket);
assert.ok(
  comments[0].body.includes(
    "BLOCKED watt-mind/factory#1973: retained notification",
  ),
  `the undelivered title must reach the ticket, got ${comments[0].body}`,
);
const retained = readFileSync(
  path.join(home, "outbox", `${runId}.jsonl`),
  "utf8",
);
assert.ok(
  retained.includes("BLOCKED watt-mind/factory#1973: retained notification"),
  `the undelivered line must stay on disk as the recovery source, got ${retained}`,
);

console.log("PROBE_OK");
process.exit(0);
