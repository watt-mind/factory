#!/usr/bin/env bun
/**
 * Remote ticket handoff over a dedicated OpenSSH forced-command boundary.
 *
 * Client: `factory handoff [--repo <short-name>] [--host <ssh-alias>] <ticket>`
 * Server: `factory handoff accept` (the only authorized_keys command)
 */
import { createHmac, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { resolveConfigPath } from "../event-runtime/lib/config.mjs";
import { loadRepos, reposRoot } from "../event-runtime/lib/repos.mjs";

export const HANDOFF_SCHEMA_VERSION = "factory.handoff/v1";
export const HANDOFF_RECEIPT_VERSION = "factory.handoff-receipt/v1";
export const HANDOFF_MAX_BYTES = 4096;
const REQUEST_FIELDS = new Set([
  "schemaVersion",
  "requestId",
  "repo",
  "ticket",
]);
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LINEAR_TICKET = /^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,9}$/;
const GITHUB_TICKET = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#[1-9][0-9]{0,9}$/;

export class HandoffError extends Error {
  constructor(code, message = code, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "HandoffError";
    this.code = code;
  }
}

export function fail(code, message, cause) {
  throw new HandoffError(code, message, cause);
}

export function handoffErrorBody(err) {
  const body = {
    schemaVersion: "factory.handoff-error/v1",
    error: err?.code ?? "handoff_failed",
    message: String(err?.message ?? err),
  };
  if (err?.cause !== undefined) body.cause = String(err.cause);
  return body;
}

export function createHandoffRequest({ requestId, repo, ticket }) {
  return {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    requestId,
    repo,
    ticket,
  };
}

/** Strict, bounded request parsing. Unknown fields are protocol errors. */
export function validateHandoffRequest(
  raw,
  { maxBytes = HANDOFF_MAX_BYTES } = {},
) {
  if (typeof raw !== "string") return { ok: false, error: "request_not_text" };
  if (Buffer.byteLength(raw) > maxBytes)
    return { ok: false, error: "request_too_large" };
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, error: "invalid_json" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { ok: false, error: "request_not_object" };
  const keys = Object.keys(value);
  if (
    keys.length !== REQUEST_FIELDS.size ||
    keys.some((key) => !REQUEST_FIELDS.has(key))
  ) {
    return { ok: false, error: "request_fields_invalid" };
  }
  if (value.schemaVersion !== HANDOFF_SCHEMA_VERSION)
    return { ok: false, error: "schema_version_invalid" };
  if (typeof value.requestId !== "string" || !REQUEST_ID.test(value.requestId))
    return { ok: false, error: "request_id_invalid" };
  if (typeof value.repo !== "string" || !REPO_NAME.test(value.repo))
    return { ok: false, error: "repo_invalid" };
  if (
    typeof value.ticket !== "string" ||
    (!LINEAR_TICKET.test(value.ticket) && !GITHUB_TICKET.test(value.ticket))
  ) {
    return { ok: false, error: "ticket_invalid" };
  }
  return { ok: true, value };
}

function directoryContains(directory, cwd) {
  if (!directory) return false;
  const root = path.resolve(directory);
  const here = path.resolve(cwd);
  return here === root || here.startsWith(`${root}${path.sep}`);
}

/** Resolve the configured short repo name, with an explicit flag taking priority. */
export function resolveHandoffRepo({ repos, cwd = process.cwd(), repo } = {}) {
  const registry = repos ?? loadRepos();
  if (repo) {
    if (!registry.has(repo))
      fail("repo_unconfigured", `unconfigured repo ${JSON.stringify(repo)}`);
    return repo;
  }
  let best = null;
  for (const configured of registry.values()) {
    for (const directory of [configured.path, configured.worktreeRoot]) {
      if (!directoryContains(directory, cwd)) continue;
      const length = path.resolve(directory).length;
      if (!best || length > best.length)
        best = { name: configured.name, length };
    }
  }
  if (!best)
    fail(
      "repo_unresolved",
      "cwd is not inside a configured repository; pass --repo <short-name>",
    );
  return best.name;
}

function nonemptyString(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

function handoffHostFromConfig(config, { directHost = false } = {}) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return null;
  }
  return (
    nonemptyString(config.handoff?.host) ??
    nonemptyString(config.handoff_host) ??
    (directHost ? nonemptyString(config.host) : null)
  );
}

function parseJsonFile(file, readFile) {
  try {
    return JSON.parse(readFile(file, "utf8"));
  } catch {
    return null;
  }
}

function parseDotenvFile(file, readFile) {
  let text;
  try {
    text = readFile(file, "utf8");
  } catch {
    return {};
  }
  const values = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const entry = line.replace(/^export\s+/, "");
    const equals = entry.indexOf("=");
    if (equals <= 0) continue;
    const key = entry.slice(0, equals).trim();
    let value = entry.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function loadHandoffConfig({ root, readFile }) {
  let repos = null;
  let policy = null;
  try {
    repos = Bun.YAML.parse(
      readFile(resolveConfigPath("repos", { root }), "utf8"),
    );
  } catch {
    // An unavailable optional source must not prevent lower-precedence defaults.
  }
  try {
    policy = Bun.YAML.parse(
      readFile(resolveConfigPath("policy", { root }), "utf8"),
    );
  } catch {
    // An unavailable optional source must not prevent lower-precedence defaults.
  }
  return { repos, policy };
}

/**
 * Resolve the SSH destination without exposing configuration contents in errors.
 * The result is validated by sendHandoff immediately before spawning ssh.
 */
export function resolveHandoffHost({
  host,
  env = process.env,
  repo,
  home = homedir(),
  root = reposRoot(),
  readFile = readFileSync,
  repoConfig,
  policy,
} = {}) {
  const configured =
    repoConfig === undefined || policy === undefined
      ? loadHandoffConfig({ root, readFile })
      : null;
  const configuredRepo =
    repoConfig ??
    configured?.repos?.repos?.find((entry) => entry?.name === repo);
  const configuredPolicy = policy ?? configured?.policy;
  const localConfig = parseJsonFile(
    path.join(home, ".factory", "config.json"),
    readFile,
  );
  const localHandoff = parseJsonFile(
    path.join(home, ".factory", "handoff.json"),
    readFile,
  );
  const localSecrets = parseDotenvFile(
    path.join(home, ".factory", "secrets.env"),
    readFile,
  );

  return (
    nonemptyString(host) ??
    nonemptyString(env.FACTORY_HANDOFF_SSH_HOST) ??
    nonemptyString(env.FACTORY_HANDOFF_HOST) ??
    handoffHostFromConfig(localConfig) ??
    handoffHostFromConfig(localHandoff, { directHost: true }) ??
    nonemptyString(localSecrets.FACTORY_HANDOFF_SSH_HOST) ??
    nonemptyString(localSecrets.FACTORY_HANDOFF_HOST) ??
    nonemptyString(configuredRepo?.handoff_host) ??
    handoffHostFromConfig(configuredPolicy) ??
    "factory-runner"
  );
}

function validateTicketForRepo(ticket, repo) {
  const github = ticket.match(GITHUB_TICKET);
  if (repo.controlPlane === "github") {
    if (!github || !repo.github)
      fail("ticket_invalid_for_repo", "GitHub repos require OWNER/REPO#N");
    if (github[1].toLowerCase() !== repo.github.toLowerCase())
      fail("ticket_repo_mismatch", "ticket does not belong to requested repo");
    return;
  }
  if (github) {
    if (!repo.github || github[1].toLowerCase() !== repo.github.toLowerCase())
      fail("ticket_repo_mismatch", "ticket does not belong to requested repo");
    return;
  }
  if (!LINEAR_TICKET.test(ticket))
    fail("ticket_invalid_for_repo", "invalid ticket identifier");
  if (repo.team && !ticket.startsWith(`${repo.team}-`))
    fail("ticket_repo_mismatch", "ticket does not belong to requested repo");
}

async function responseJson(response, code) {
  let text;
  try {
    text = await response.text();
  } catch (err) {
    fail(code, `${code}: runtime response could not be read`, err);
  }
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Never forward the SyntaxError: engines embed a prefix of the body in it.
    fail(
      code,
      `${code}: runtime returned non-JSON`,
      new Error(`invalid JSON body (${Buffer.byteLength(text, "utf8")} bytes)`),
    );
  }
  if (!response.ok) {
    const reason =
      body?.error ?? body?.errors?.join("; ") ?? `HTTP ${response.status}`;
    fail(code, `${code}: ${reason}`, new Error(`HTTP ${response.status}`));
  }
  return body;
}

async function runtimeState(fetchImpl, eventUrl, eventId, controlApiToken) {
  const auth = controlApiToken
    ? { headers: { authorization: `Bearer ${controlApiToken}` } }
    : undefined;
  let before = null;
  const seenCursors = new Set();
  let event;
  while (true) {
    const suffix = before ? `&before=${encodeURIComponent(before)}` : "";
    const list = await responseJson(
      await fetchImpl(`${eventUrl}/events?limit=100${suffix}`, auth),
      "runtime_status_failed",
    );
    event = list?.events?.find(
      (item) => item.source === "handoff" && item.eventId === eventId,
    );
    if (event) break;
    if (!list?.nextBefore || seenCursors.has(list.nextBefore)) return null;
    seenCursors.add(list.nextBefore);
    before = list.nextBefore;
  }

  let proposalState = null;
  let runState = null;
  if (event.proposalId) {
    const detail = await responseJson(
      await fetchImpl(
        `${eventUrl}/proposals/${encodeURIComponent(event.proposalId)}`,
        auth,
      ),
      "runtime_status_failed",
    );
    proposalState = detail?.proposal?.status ?? null;
  }
  if (event.runId) {
    const detail = await responseJson(
      await fetchImpl(
        `${eventUrl}/runs/${encodeURIComponent(event.runId)}`,
        auth,
      ),
      "runtime_status_failed",
    );
    runState = detail?.run?.state ?? null;
  }
  return { event, proposalState, runState };
}

function sameHandoffEnvelope(stored, expected) {
  return Boolean(
    stored &&
    stored.schemaVersion === expected.schemaVersion &&
    stored.eventId === expected.eventId &&
    stored.type === expected.type &&
    stored.source === expected.source &&
    stored.subject === expected.subject &&
    stored.correlationId === expected.correlationId &&
    (stored.causationId ?? null) === (expected.causationId ?? null) &&
    stored.payload?.repo === expected.payload.repo &&
    stored.payload?.ticket === expected.payload.ticket,
  );
}

/** Forced-command server core: validate, derive, sign, and POST exact bytes. */
export async function acceptHandoff(
  raw,
  {
    repos = loadRepos(),
    secret = process.env.FACTORY_EVENT_SECRET || null,
    eventUrl = process.env.FACTORY_EVENT_URL ||
      `http://127.0.0.1:${process.env.FACTORY_EVENT_PORT || "7381"}`,
    dashboardUrl = process.env.FACTORY_DASHBOARD_URL || null,
    controlApiToken = process.env.FACTORY_CONTROL_API_TOKEN || null,
    fetchImpl = fetch,
    now = Date.now(),
  } = {},
) {
  const parsed = validateHandoffRequest(raw);
  if (!parsed.ok) fail(parsed.error, parsed.error);
  const request = parsed.value;
  const repo = repos.get(request.repo);
  if (!repo) fail("repo_unconfigured", `unconfigured repo ${request.repo}`);
  if (repo.reportOnly)
    fail("repo_report_only", `repo ${request.repo} is report-only`);
  validateTicketForRepo(request.ticket, repo);
  if (!secret)
    fail(
      "event_secret_missing",
      "FACTORY_EVENT_SECRET is required by the forced-command server",
    );

  const nowMs = typeof now === "function" ? now() : now;
  const envelope = {
    schemaVersion: "factory.event/v1",
    eventId: request.requestId,
    type: "factory.dispatch.requested",
    source: "handoff",
    subject: request.ticket,
    occurredAt: new Date(nowMs).toISOString(),
    correlationId: request.requestId,
    causationId: null,
    payload: { repo: request.repo, ticket: request.ticket },
  };
  // These exact bytes are both signed and posted. Never canonicalize or rebuild
  // the body after computing the signature.
  const body = JSON.stringify(envelope);
  const timestamp = String(nowMs);
  const signature = `sha256=${createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex")}`;
  const admission = await responseJson(
    await fetchImpl(`${eventUrl}/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-factory-timestamp": timestamp,
        "x-factory-signature": signature,
      },
      body,
    }),
    "runtime_admission_failed",
  );
  if (
    typeof admission?.admitted !== "boolean" ||
    typeof admission?.duplicate !== "boolean" ||
    admission.eventId !== request.requestId
  ) {
    fail("runtime_receipt_invalid", "runtime admission receipt is invalid");
  }

  let state = null;
  let stateLookupFailed = false;
  const warnings = [];
  try {
    state = await runtimeState(
      fetchImpl,
      eventUrl,
      request.requestId,
      controlApiToken,
    );
  } catch (err) {
    // Fresh admission is already durable; state enrichment is best-effort.
    // A duplicate must be bound to its original request, so lookup failures
    // fail closed instead of returning a misleading retry receipt.
    if (admission.duplicate) throw err;
    stateLookupFailed = true;
    const warning = `state_unavailable: ${String(err?.message ?? err)}`;
    warnings.push(warning);
    console.error(warning);
  }
  if (!state?.event && !admission.duplicate && !stateLookupFailed) {
    const warning = "state_unavailable: event not found";
    warnings.push(warning);
    console.error(warning);
  }
  if (admission.duplicate) {
    if (!state?.event)
      fail(
        "duplicate_state_unavailable",
        "duplicate_state_unavailable: original event could not be loaded",
      );
    if (!sameHandoffEnvelope(state.event.envelope, envelope))
      fail(
        "idempotency_conflict",
        "idempotency_conflict: requestId belongs to a different handoff",
      );
  }
  return {
    schemaVersion: HANDOFF_RECEIPT_VERSION,
    requestId: request.requestId,
    admitted: admission.admitted,
    duplicate: admission.duplicate,
    event: {
      id: request.requestId,
      state: state?.event?.status ?? "unknown",
    },
    proposal: state?.event?.proposalId
      ? { id: state.event.proposalId, state: state.proposalState }
      : null,
    run: state?.event?.runId
      ? { id: state.event.runId, state: state.runState }
      : null,
    ...(warnings.length > 0 ? { warnings } : {}),
    dashboardUrl,
  };
}

const RECEIPT_WARNING_MAX_LENGTH = 512;

function validReceiptWarnings(warnings) {
  if (warnings === undefined) return true;
  return (
    Array.isArray(warnings) &&
    warnings.length <= 32 &&
    warnings.every(
      (warning) =>
        typeof warning === "string" &&
        warning.length > 0 &&
        warning.length <= RECEIPT_WARNING_MAX_LENGTH &&
        // eslint-disable-next-line no-control-regex
        !/[\0-\x1f\x7f]/.test(warning),
    )
  );
}

function validReceipt(value, requestId) {
  return Boolean(
    value &&
    typeof value === "object" &&
    value.schemaVersion === HANDOFF_RECEIPT_VERSION &&
    value.requestId === requestId &&
    typeof value.admitted === "boolean" &&
    typeof value.duplicate === "boolean" &&
    value.event?.id === requestId &&
    typeof value.event?.state === "string" &&
    validReceiptWarnings(value.warnings),
  );
}

function validateSshHost(host) {
  if (
    typeof host !== "string" ||
    host.length === 0 ||
    host.startsWith("-") ||
    host.trim() !== host ||
    /[\0\r\n]/.test(host)
  ) {
    fail("ssh_host_invalid", "ssh_host_invalid");
  }
}

export function sshProcess(host, input) {
  validateSshHost(host);
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", ["--", host], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (exitCode) =>
      resolve({ exitCode: exitCode ?? 1, stdout, stderr }),
    );
    child.stdin.end(input);
  });
}

/** Send one strict request. No remote command is supplied: sshd forces accept. */
export async function sendHandoff(request, { host, ssh = sshProcess } = {}) {
  validateSshHost(host);
  const validation = validateHandoffRequest(JSON.stringify(request));
  if (!validation.ok) fail(validation.error, validation.error);
  const result = await ssh(host, JSON.stringify(request));
  let parsed;
  try {
    parsed = result.stdout ? JSON.parse(result.stdout) : null;
  } catch {
    fail("receipt_invalid", "invalid receipt from handoff server");
  }
  if (result.exitCode !== 0) {
    const message =
      parsed?.error ??
      parsed?.message ??
      result.stderr?.trim() ??
      "remote handoff failed";
    fail("remote_handoff_failed", message);
  }
  if (!validReceipt(parsed, request.requestId))
    fail("receipt_invalid", "invalid receipt from handoff server");
  return parsed;
}

async function readBoundedStdin(limit = HANDOFF_MAX_BYTES) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > limit) fail("request_too_large", "request_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const HELP = `factory handoff — send one agent-ready ticket to central Factory

Usage:
  factory handoff [--repo <short-name>] [--host <ssh-alias>] [--request-id <id>] <ticket>
  factory handoff accept

The client sends only factory.handoff/v1 JSON through SSH. The accept form is
for a dedicated authorized_keys forced command and reads one bounded document
from stdin.

SSH host resolution (highest precedence first): --host, FACTORY_HANDOFF_SSH_HOST,
FACTORY_HANDOFF_HOST, ~/.factory/config.json or handoff.json, ~/.factory/secrets.env,
config/repos.yaml handoff_host, config/policy.yaml handoff.host or handoff_host,
then the factory-runner alias.
`;

export function assertForcedCommandEnvironment(env = process.env) {
  if (
    typeof env.SSH_ORIGINAL_COMMAND === "string" &&
    env.SSH_ORIGINAL_COMMAND
  ) {
    fail(
      "ssh_original_command_forbidden",
      "ssh_original_command_forbidden: the handoff client must not supply a remote command",
    );
  }
}

export function printReceipt(receipt, log = console.log) {
  const disposition = receipt.duplicate ? "duplicate" : "admitted";
  log(`Handoff ${disposition}: ${receipt.requestId}`);
  log(`Event: ${receipt.event.state}`);
  for (const warning of receipt.warnings ?? []) log(`Warning: ${warning}`);
  if (receipt.proposal)
    log(
      `Proposal: ${receipt.proposal.id} (${receipt.proposal.state ?? "pending"})`,
    );
  if (receipt.run)
    log(`Run: ${receipt.run.id} (${receipt.run.state ?? "pending"})`);
  if (receipt.dashboardUrl) log(`Dashboard: ${receipt.dashboardUrl}`);
}

async function main(argv = process.argv.slice(2)) {
  if (argv[0] === "accept") {
    if (argv.length !== 1)
      fail("accept_arguments_forbidden", "accept takes no arguments");
    assertForcedCommandEnvironment();
    const receipt = await acceptHandoff(await readBoundedStdin());
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    return;
  }
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      repo: { type: "string" },
      host: { type: "string" },
      "request-id": { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  if (positionals.length !== 1)
    fail("ticket_required", "exactly one ticket identifier is required");
  const repos = loadRepos();
  const repo = resolveHandoffRepo({ repos, repo: values.repo });
  const request = createHandoffRequest({
    requestId: values["request-id"] ?? `handoff-${randomUUID()}`,
    repo,
    ticket: positionals[0],
  });
  const receipt = await sendHandoff(request, {
    host: resolveHandoffHost({ host: values.host, repo }),
  });
  if (values.json) {
    console.log(JSON.stringify(receipt));
    return;
  }
  printReceipt(receipt);
}

if (import.meta.main) {
  main().catch((err) => {
    const body = handoffErrorBody(err);
    // Forced-command clients need one machine-readable failure. No environment
    // values (especially the signing secret) are projected into this object.
    process.stdout.write(`${JSON.stringify(body)}\n`);
    process.exitCode = 1;
  });
}
