import { test } from "bun:test";
import { handoffSandboxSkipReason } from "../lib/verify.mjs";

/**
 * Cases that only mean something on a host that can build the handoff sandbox
 * (GH-2267).
 *
 * A large family of worker/verify tests drives a dispatch run all the way
 * through the verified-PR handoff and asserts a COMPLETED terminal state. That
 * state is reachable only where the worker can actually enter an unprivileged
 * user+mount namespace. On a host without one the run legitimately terminates
 * FAILED / `sandbox_unavailable` — an environment fault, not the branch's red.
 * GitHub-hosted runners are exactly such a host, and they carry every fork and
 * Dependabot pull request, so before this seam existed the cloud lane could
 * only be made green by dropping the whole suite — which took lint, format,
 * build and every non-sandbox unit test down with it.
 *
 * `sandboxTest` skips just those cases, and only where the sandbox is genuinely
 * absent. The rest of each suite still runs on the cloud lane.
 *
 * The verdict comes from `handoffSandboxSkipReason`, i.e. from the same real
 * `unshare` probe the production handoff gate uses, and from nothing else.
 * There is deliberately no environment variable or CI marker in this path: a
 * skip a pull request could switch on for itself would let a fork shed exactly
 * the coverage it is meant to be held to.
 */
export const sandboxSkipReason = handoffSandboxSkipReason();

if (sandboxSkipReason) {
  // Logged once per test file that imports this, so a skipped case is visible
  // in the CI log as a named environment limitation rather than as silence.
  console.warn(`sandbox-dependent cases skipped — ${sandboxSkipReason}`);
}

/** `test`, but skipped when this host cannot create the handoff sandbox. */
export const sandboxTest = test.skipIf(Boolean(sandboxSkipReason));
