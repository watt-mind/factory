#!/usr/bin/env bun
/**
 * Kill Chrome instances orphaned by dead agent runs.
 *
 *   bun orchestrator/chrome-sweep.mjs           # dry run
 *   bun orchestrator/chrome-sweep.mjs --apply
 *
 * Every agent session gets its own Chrome via chrome-devtools-mcp --isolated
 * (config/mcp/claude.json). When a run is killed at the wall-clock cap — or the
 * harness crashes — the MCP server dies without closing its browser, and the
 * Chrome reparents to launchd and keeps running: memory held, and for the
 * legacy shared profile, a SingletonLock that blocks every later launch. One
 * such lock sat under ~/.cache/chrome-devtools-mcp for hours on 2026-08-04.
 *
 * SAFETY: this must never touch the human's actual Chrome. Three fences, all
 * required to match:
 *   1. the command line names a chrome-devtools-mcp or puppeteer profile dir —
 *      a normal Chrome never does;
 *   2. it is the browser MAIN process (no --type= flag), so helpers go down
 *      with their parent rather than being shot individually;
 *   3. it has reparented to PID 1 — its owning MCP server is dead. A live
 *      agent's Chrome still has its MCP server as parent and is left alone.
 */
import { execSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readdirSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const APPLY = process.argv.includes("--apply");
const SHARED_PROFILE = path.join(
  homedir(),
  ".cache/chrome-devtools-mcp/chrome-profile",
);

/** Does this ps line look like an agent-launched Chrome profile? */
const AGENT_PROFILE =
  /--user-data-dir=[^ ]*(chrome-devtools-mcp|pi-chrome-devtools|puppeteer_dev_(chrome|firefox)_profile)/;

export const TMP_PREFIXES = [
  "evrt-",
  "wm334-real-",
  "pi-chrome-devtools-",
  "puppeteer_dev_chrome_profile-",
  "factory-wt-",
];
const TMP_MIN_AGE_MS = 30 * 60 * 1000;

/** Find stale factory-owned temp directories without following symlinks. */
export function staleTmpDirectories({
  root = tmpdir(),
  nowMs = Date.now(),
  inUsePaths = [],
} = {}) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) return [];
    if (!TMP_PREFIXES.some((prefix) => entry.name.startsWith(prefix)))
      return [];
    const candidate = path.join(root, entry.name);
    if (inUsePaths.includes(candidate)) return [];
    try {
      return nowMs - lstatSync(candidate).mtimeMs > TMP_MIN_AGE_MS
        ? [candidate]
        : [];
    } catch {
      return [];
    }
  });
}

/**
 * Pure classifier over `ps -axo pid=,ppid=,command=` rows so the kill logic is
 * testable without killing anything. Returns { orphans, live }.
 */
export function classify(rows) {
  const orphans = [],
    live = [];
  for (const r of rows) {
    if (!AGENT_PROFILE.test(r.command)) continue; // fence 1: agent profile only
    if (/--type=/.test(r.command)) continue; // fence 2: main process only
    (r.ppid === 1 ? orphans : live).push(r); // fence 3: dead parent = orphan
  }
  return { orphans, live };
}

export function parsePs(text) {
  return text.split("\n").flatMap((line) => {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }] : [];
  });
}

if (import.meta.main) {
  const rows = parsePs(
    execSync("ps -axo pid=,ppid=,command=", {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    }),
  );
  const { orphans, live } = classify(rows);
  const inUsePaths = rows.flatMap((row) => {
    const profile = row.command.match(/--user-data-dir=([^ ]+)/)?.[1];
    return profile ? [profile] : [];
  });

  if (live.length)
    console.log(
      `${live.length} agent Chrome(s) with a living MCP server — left alone`,
    );

  if (!orphans.length) {
    console.log("no orphaned agent Chromes");
  } else {
    for (const o of orphans) {
      const profile =
        (o.command.match(/--user-data-dir=([^ ]+)/) ?? [])[1] ?? "?";
      console.log(
        `  ${APPLY ? "killing" : "would kill"} pid ${o.pid}  ${profile}`,
      );
      if (!APPLY) continue;
      try {
        process.kill(o.pid, "SIGTERM");
      } catch {
        /* intentionally ignored */
      }
    }
    if (APPLY) {
      // TERM first so Chrome flushes its profile; KILL whatever ignores it.
      await Bun.sleep(5000);
      for (const o of orphans) {
        try {
          process.kill(o.pid, 0);
          process.kill(o.pid, "SIGKILL");
          console.log(`  SIGKILL pid ${o.pid} (survived TERM)`);
        } catch {
          /* already gone — the normal case */
        }
      }
    }
  }

  // The legacy shared profile's Singleton* symlinks outlive a killed Chrome and
  // block the next non-isolated launch. Only removed when NO process — orphan
  // or live — is still using that profile dir.
  const sharedInUse = rows.some((r) => r.command.includes(SHARED_PROFILE));
  if (!sharedInUse && existsSync(SHARED_PROFILE)) {
    for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
      const p = path.join(SHARED_PROFILE, f);
      try {
        lstatSync(p); // throws when absent — symlinks to dead sockets need lstat
        console.log(`  ${APPLY ? "removing" : "would remove"} stale ${f}`);
        if (APPLY) unlinkSync(p);
      } catch {
        /* not present */
      }
    }
  }

  for (const dir of staleTmpDirectories({ inUsePaths })) {
    console.log(`  ${APPLY ? "removing" : "would remove"} stale ${dir}`);
    if (APPLY) rmSync(dir, { recursive: true, force: true });
  }

  if (!APPLY && orphans.length)
    console.log("\ndry run — re-run with --apply to kill them");
}
