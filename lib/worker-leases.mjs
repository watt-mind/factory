/**
 * Local, durable capacity leases for dispatched ticket workers.
 *
 * Linear remains the durable ownership record. A lease answers the narrower,
 * operational question: "is a worker on this machine still consuming a slot?"
 * Files live under ~/.factory so independent supervisor processes see the same
 * answer. Leases expire when their owner stops renewing them, which prevents a
 * dead dispatcher from filling the capacity counter forever.
 */
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ticketSlug } from "./ticket-slug.mjs";

export const LEASE_TTL_MS = 90_000;
export const LEASE_HEARTBEAT_MS = 20_000;

export function leaseDir(root = path.join(homedir(), ".factory")) {
  return path.join(root, "worker-leases");
}

function leaseFile(repo, ticket, dir) {
  // Slug, not the raw id: a GitHub identifier (`owner/repo#123`) contains a
  // `/`, so the raw form nests a directory that does not exist and the write
  // dies with ENOENT after the claim has already landed (#884).
  return path.join(dir, `${repo}-${ticketSlug(ticket)}.json`);
}

function readLease(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Write or refresh a ticket's lease. `owner` prevents another run deleting it. */
export function writeWorkerLease({
  repo,
  ticket,
  owner,
  pid = process.pid,
  dir = leaseDir(),
  now = Date.now(),
}) {
  mkdirSync(dir, { recursive: true });
  const file = leaseFile(repo, ticket, dir);
  const prior = readLease(file);
  const lease = {
    repo,
    ticket,
    owner,
    pid,
    startedAt: prior?.owner === owner ? prior.startedAt : now,
    heartbeatAt: now,
  };
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(temp, `${JSON.stringify(lease)}\n`, "utf8");
  renameSync(temp, file);
  return lease;
}

/** Refresh without changing the worker pid recorded when the child started. */
export function renewWorkerLease({
  repo,
  ticket,
  owner,
  dir = leaseDir(),
  now = Date.now(),
}) {
  const prior = readLease(leaseFile(repo, ticket, dir));
  if (!prior || prior.owner !== owner) return false;
  writeWorkerLease({ repo, ticket, owner, pid: prior.pid, dir, now });
  return true;
}

export function releaseWorkerLease({ repo, ticket, owner, dir = leaseDir() }) {
  const file = leaseFile(repo, ticket, dir);
  const prior = readLease(file);
  if (!prior || prior.owner !== owner) return false;
  try {
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Live means both recently heartbeating and backed by a local process. The
 * process check makes a killed agent release capacity immediately; the TTL
 * handles a supervisor that vanished while its child was still around.
 */
export function liveWorkerLeases(
  repo,
  {
    dir = leaseDir(),
    now = Date.now(),
    ttlMs = LEASE_TTL_MS,
    pidAlive = isAlive,
  } = {},
) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith(`${repo}-`) && name.endsWith(".json"))
    .map((name) => readLease(path.join(dir, name)))
    .filter((lease) => lease?.repo === repo && typeof lease.ticket === "string")
    .filter(
      (lease) =>
        Number.isFinite(lease.heartbeatAt) && now - lease.heartbeatAt < ttlMs,
    )
    .filter((lease) => pidAlive(lease.pid));
}
