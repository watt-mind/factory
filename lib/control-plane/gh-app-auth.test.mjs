/**
 * GitHub App auth unit suite (WM-1137, Phase 2 of #1136).
 *
 * No real GitHub App exists yet, so everything is exercised against mocks:
 * a locally-generated RSA test keypair for the JWT, an injected `fetchImpl`
 * for the token exchange, and a temp file for the token cache. No real network
 * or `gh` calls are made.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmSync } from "node:fs";
import {
  buildAppJwt,
  DAEMON_ALREADY_RUNNING_EXIT_CODE,
  mintInstallationToken,
  readCachedAppToken,
  resolveGhToken,
  runDaemon,
  runLockedDaemon,
} from "./gh-app-auth.mjs";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const tmpDirs = [];
function tmp(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function decodeSegment(seg) {
  return JSON.parse(Buffer.from(seg, "base64url").toString("utf8"));
}

/** A deterministic, awaitable setTimeout replacement for daemon tests. */
function fakeTimers(startMs) {
  let nowMs = startMs;
  let nextId = 0;
  const timers = new Map();
  const setTimeoutImpl = (callback, delayMs) => {
    const id = ++nextId;
    timers.set(id, { callback, at: nowMs + delayMs, delayMs });
    return id;
  };
  const clearTimeoutImpl = (id) => timers.delete(id);
  const next = () =>
    [...timers.entries()].sort(([, a], [, b]) => a.at - b.at)[0] ?? null;
  return {
    now: () => nowMs,
    setTimeoutImpl,
    clearTimeoutImpl,
    nextDelay: () => next()?.[1].delayMs ?? null,
    async advanceBy(ms) {
      const target = nowMs + ms;
      while (next()?.[1].at <= target) {
        const [id, timer] = next();
        timers.delete(id);
        nowMs = timer.at;
        await timer.callback();
      }
      nowMs = target;
    },
  };
}

function daemonSignals() {
  const handlers = new Map();
  return {
    on(signal, handler) {
      handlers.set(signal, handler);
    },
    stop() {
      handlers.get("SIGTERM")?.();
    },
  };
}

async function flushDaemon() {
  // A failed mint crosses several promise boundaries (resolve → mint → fetch).
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe("buildAppJwt", () => {
  test("produces a verifiable RS256 JWT with iss/iat/exp", () => {
    const now = () => 1_700_000_000_000; // fixed clock
    const jwt = buildAppJwt({
      appId: "123456",
      privateKeyPem: privateKey,
      now,
    });
    const [h, p, sig] = jwt.split(".");
    expect(h && p && sig).toBeTruthy();

    const header = decodeSegment(h);
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });

    const payload = decodeSegment(p);
    const nowS = Math.floor(now() / 1000);
    expect(payload.iss).toBe("123456");
    expect(payload.iat).toBe(nowS - 60); // back-dated for clock skew
    expect(payload.exp).toBeGreaterThan(nowS);
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600); // <=10 min

    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${h}.${p}`);
    verifier.end();
    const ok = verifier.verify(publicKey, Buffer.from(sig, "base64url"));
    expect(ok).toBe(true);
  });

  test("a tampered payload fails verification", () => {
    const jwt = buildAppJwt({ appId: "1", privateKeyPem: privateKey });
    const [h, , sig] = jwt.split(".");
    const forged = Buffer.from(JSON.stringify({ iss: "999" })).toString(
      "base64url",
    );
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${h}.${forged}`);
    verifier.end();
    expect(verifier.verify(publicKey, Buffer.from(sig, "base64url"))).toBe(
      false,
    );
  });
});

describe("mintInstallationToken", () => {
  test("POSTs to the installation endpoint with a Bearer JWT and returns token+expiry", async () => {
    const seen = {};
    const fetchImpl = async (url, init) => {
      seen.url = url;
      seen.init = init;
      return {
        ok: true,
        status: 201,
        json: async () => ({
          token: "ghs_installationtoken",
          expires_at: "2026-08-29T13:00:00Z",
        }),
      };
    };
    const res = await mintInstallationToken({
      appId: "42",
      installationId: "9001",
      privateKeyPem: privateKey,
      fetchImpl,
    });
    expect(res).toEqual({
      token: "ghs_installationtoken",
      expiresAt: "2026-08-29T13:00:00Z",
    });
    expect(seen.url).toBe(
      "https://api.github.com/app/installations/9001/access_tokens",
    );
    expect(seen.init.method).toBe("POST");
    expect(seen.init.headers.Accept).toBe("application/vnd.github+json");
    expect(seen.init.headers.Authorization).toMatch(/^Bearer .+\..+\..+$/);
  });

  test("a non-ok response throws with status only (no token/key leak)", async () => {
    const fetchImpl = async () => ({
      ok: false,
      status: 403,
      json: async () => ({ message: "Bad credentials" }),
    });
    await expect(
      mintInstallationToken({
        appId: "42",
        installationId: "9001",
        privateKeyPem: privateKey,
        fetchImpl,
      }),
    ).rejects.toThrow(/status 403/);
  });

  test("times out a fetch implementation that never settles", async () => {
    let seenSignal;
    await expect(
      mintInstallationToken({
        appId: "42",
        installationId: "9001",
        privateKeyPem: privateKey,
        fetchImpl: (_url, init) => {
          seenSignal = init.signal;
          return new Promise(() => {});
        },
        timeoutMs: 20,
      }),
    ).rejects.toThrow("installation-token request failed to reach GitHub");
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal.aborted).toBe(true);
  }, 1_000);
});

describe("runLockedDaemon", () => {
  test("forwards repeated SIGTERM while retaining the wrapper until child exit", async () => {
    const handlers = new Map();
    const forwarded = [];
    const selfKills = [];
    let exit;
    const child = {
      kill(signal) {
        forwarded.push(signal);
      },
      once(event, handler) {
        if (event === "exit") exit = handler;
      },
    };
    const signals = {
      on(signal, handler) {
        handlers.set(signal, handler);
      },
      removeListener(signal, handler) {
        if (handlers.get(signal) === handler) handlers.delete(signal);
      },
    };

    const daemon = runLockedDaemon(
      { tokenFile: path.join(tmp("gh-app-lock-signals-"), "token.json") },
      {
        spawnImpl: () => child,
        signals,
        selfKill(pid, signal) {
          selfKills.push({ pid, signal });
        },
      },
    );
    handlers.get("SIGTERM")();
    handlers.get("SIGTERM")();
    expect(forwarded).toEqual(["SIGTERM", "SIGTERM"]);
    expect(selfKills).toEqual([]);

    exit(0, null);
    await daemon;
    expect(selfKills).toEqual([{ pid: process.pid, signal: "SIGTERM" }]);
    expect(handlers.size).toBe(0);
  });
});

describe("resolveGhToken", () => {
  test("mints, writes the cache 0600, and returns the token when no file exists", async () => {
    const dir = tmp("gh-app-token-");
    const tokenFile = path.join(dir, "gh-app-token.json");
    let mints = 0;
    const mint = async () => {
      mints += 1;
      return { token: "ghs_fresh", expiresAt: "2026-08-29T13:00:00Z" };
    };
    const token = await resolveGhToken({
      tokenFile,
      now: () => Date.parse("2026-08-29T12:00:00Z"),
      mint,
    });
    expect(token).toBe("ghs_fresh");
    expect(mints).toBe(1);
    const onDisk = JSON.parse(readFileSync(tokenFile, "utf8"));
    expect(onDisk).toEqual({
      token: "ghs_fresh",
      expiresAt: "2026-08-29T13:00:00Z",
    });
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
  });

  test("a cached, unexpired token is returned without minting", async () => {
    const dir = tmp("gh-app-token-");
    const tokenFile = path.join(dir, "gh-app-token.json");
    writeFileSync(
      tokenFile,
      JSON.stringify({
        token: "ghs_cached",
        expiresAt: "2026-08-29T13:00:00Z",
      }),
    );
    let mints = 0;
    const token = await resolveGhToken({
      tokenFile,
      now: () => Date.parse("2026-08-29T12:00:00Z"),
      mint: async () => {
        mints += 1;
        return { token: "ghs_new", expiresAt: "2026-08-29T14:00:00Z" };
      },
    });
    expect(token).toBe("ghs_cached");
    expect(mints).toBe(0);
  });

  test("a near-expiry token triggers exactly one re-mint and rewrites the file", async () => {
    const dir = tmp("gh-app-token-");
    const tokenFile = path.join(dir, "gh-app-token.json");
    writeFileSync(
      tokenFile,
      JSON.stringify({ token: "ghs_old", expiresAt: "2026-08-29T12:03:00Z" }),
    );
    let mints = 0;
    const mint = async () => {
      mints += 1;
      return { token: "ghs_reminted", expiresAt: "2026-08-29T13:00:00Z" };
    };
    const token = await resolveGhToken({
      tokenFile,
      // 12:00, token expires 12:03 — inside the 5-min skew, so stale.
      now: () => Date.parse("2026-08-29T12:00:00Z"),
      mint,
    });
    expect(token).toBe("ghs_reminted");
    expect(mints).toBe(1);
    const onDisk = JSON.parse(readFileSync(tokenFile, "utf8"));
    expect(onDisk.token).toBe("ghs_reminted");
  });
});

describe("readCachedAppToken", () => {
  const appEnv = (dir) => ({
    FACTORY_GH_APP_ID: "42",
    FACTORY_GH_APP_INSTALLATION_ID: "9001",
    FACTORY_GH_APP_PRIVATE_KEY_PATH: "/does/not/matter.pem",
    FACTORY_GH_APP_TOKEN_FILE: path.join(dir, "gh-app-token.json"),
  });

  test("returns null (no throw) when App auth is not configured", () => {
    expect(readCachedAppToken({ env: {} })).toBeNull();
  });

  test("returns the cached token when configured and fresh", () => {
    const dir = tmp("gh-app-token-");
    const env = appEnv(dir);
    writeFileSync(
      env.FACTORY_GH_APP_TOKEN_FILE,
      JSON.stringify({ token: "ghs_live", expiresAt: "2026-08-29T13:00:00Z" }),
    );
    expect(
      readCachedAppToken({
        env,
        now: () => Date.parse("2026-08-29T12:00:00Z"),
      }),
    ).toBe("ghs_live");
  });

  test("throws (never returns a stale token) when configured but the file is missing", () => {
    const dir = tmp("gh-app-token-");
    expect(() => readCachedAppToken({ env: appEnv(dir) })).toThrow();
  });

  test("throws when configured but the cached token is expired", () => {
    const dir = tmp("gh-app-token-");
    const env = appEnv(dir);
    writeFileSync(
      env.FACTORY_GH_APP_TOKEN_FILE,
      JSON.stringify({ token: "ghs_dead", expiresAt: "2026-08-29T11:00:00Z" }),
    );
    expect(() =>
      readCachedAppToken({
        env,
        now: () => Date.parse("2026-08-29T12:00:00Z"),
      }),
    ).toThrow();
  });
});

describe("runDaemon", () => {
  const appEnv = (dir) => ({
    FACTORY_GH_APP_ID: "42",
    FACTORY_GH_APP_INSTALLATION_ID: "9001",
    FACTORY_GH_APP_PRIVATE_KEY_PATH: path.join(dir, "app-key.pem"),
    FACTORY_GH_APP_TOKEN_FILE: path.join(dir, "gh-app-token.json"),
  });

  const daemonOptions = (env, timers, signals, fetchImpl) => ({
    env,
    fetchImpl,
    now: timers.now,
    signals,
    log: { log() {}, warn() {} },
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });

  test("a second CLI daemon exits 75 with the lock-holder message", async () => {
    const dir = tmp("gh-app-daemon-lock-");
    const env = appEnv(dir);
    writeFileSync(env.FACTORY_GH_APP_PRIVATE_KEY_PATH, privateKey);
    writeFileSync(
      env.FACTORY_GH_APP_TOKEN_FILE,
      JSON.stringify({
        token: "ghs_cached",
        expiresAt: "2099-01-01T00:00:00Z",
      }),
    );
    const script = path.join(import.meta.dir, "gh-app-auth.mjs");
    const first = Bun.spawn({
      cmd: [process.execPath, script, "--daemon"],
      env: { ...process.env, ...env },
      stdout: "ignore",
      stderr: "ignore",
    });
    const lockFile = `${env.FACTORY_GH_APP_TOKEN_FILE}.lock`;
    try {
      const deadline = Date.now() + 2_000;
      while (
        Date.now() < deadline &&
        (!existsSync(lockFile) ||
          readFileSync(lockFile, "utf8").trim() !== String(first.pid))
      ) {
        await Bun.sleep(5);
      }
      expect(readFileSync(lockFile, "utf8").trim()).toBe(String(first.pid));

      const second = Bun.spawnSync({
        cmd: [process.execPath, script, "--daemon"],
        env: { ...process.env, ...env },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(second.exitCode).toBe(DAEMON_ALREADY_RUNNING_EXIT_CODE);
      expect(second.stderr.toString().trim()).toBe(
        `[gh-app-auth] another daemon holds ${lockFile}`,
      );
    } finally {
      first.kill("SIGTERM");
      await first.exited;
    }
  });

  test("SIGTERM waits for an in-flight refresh before daemon shutdown", async () => {
    const start = Date.parse("2026-08-29T12:00:00Z");
    const dir = tmp("gh-app-daemon-stop-refresh-");
    const env = appEnv(dir);
    writeFileSync(env.FACTORY_GH_APP_PRIVATE_KEY_PATH, privateKey);
    const timers = fakeTimers(start);
    const signals = daemonSignals();
    let settleFetch;
    const fetchImpl = () =>
      new Promise((resolve) => {
        settleFetch = resolve;
      });
    let settled = false;
    const daemon = runDaemon(
      daemonOptions(env, timers, signals, fetchImpl),
    ).then(() => {
      settled = true;
    });
    await flushDaemon();

    signals.stop();
    await flushDaemon();
    expect(settled).toBe(false);

    settleFetch({
      ok: true,
      status: 201,
      json: async () => ({
        token: "ghs_after_stop",
        expires_at: new Date(start + 60 * 60 * 1000).toISOString(),
      }),
    });
    await daemon;
    expect(settled).toBe(true);
  });

  test("re-mints a cached token before its seven-minute expiry", async () => {
    const start = Date.parse("2026-08-29T12:00:00Z");
    const dir = tmp("gh-app-daemon-");
    const env = appEnv(dir);
    writeFileSync(env.FACTORY_GH_APP_PRIVATE_KEY_PATH, privateKey);
    writeFileSync(
      env.FACTORY_GH_APP_TOKEN_FILE,
      JSON.stringify({
        token: "ghs_cached",
        expiresAt: new Date(start + 7 * 60 * 1000).toISOString(),
      }),
    );
    const timers = fakeTimers(start);
    const signals = daemonSignals();
    let mints = 0;
    const daemon = runDaemon(
      daemonOptions(env, timers, signals, async () => {
        mints += 1;
        return {
          ok: true,
          status: 201,
          json: async () => ({
            token: "ghs_reminted",
            expires_at: new Date(timers.now() + 60 * 60 * 1000).toISOString(),
          }),
        };
      }),
    );
    await flushDaemon();

    // Seven minutes minus the five-minute safety skew is two minutes.
    expect(timers.nextDelay()).toBe(2 * 60 * 1000);
    await timers.advanceBy(2 * 60 * 1000 - 1);
    expect(mints).toBe(0);
    await timers.advanceBy(1);
    expect(mints).toBe(1);

    signals.stop();
    await daemon;
  });

  test("keeps the 45-minute cadence for a fresh one-hour cached token", async () => {
    const start = Date.parse("2026-08-29T12:00:00Z");
    const dir = tmp("gh-app-daemon-");
    const env = appEnv(dir);
    writeFileSync(env.FACTORY_GH_APP_PRIVATE_KEY_PATH, privateKey);
    writeFileSync(
      env.FACTORY_GH_APP_TOKEN_FILE,
      JSON.stringify({
        token: "ghs_cached",
        expiresAt: new Date(start + 60 * 60 * 1000).toISOString(),
      }),
    );
    const timers = fakeTimers(start);
    const signals = daemonSignals();
    const daemon = runDaemon(
      daemonOptions(env, timers, signals, async () => {
        throw new Error("a fresh cache must not mint on startup");
      }),
    );
    await flushDaemon();

    expect(timers.nextDelay()).toBe(45 * 60 * 1000);
    signals.stop();
    await daemon;
  });

  test("keeps the fresh-cache wakeup timer ref'd so the daemon can sleep", async () => {
    const start = Date.parse("2026-08-29T12:00:00Z");
    const dir = tmp("gh-app-daemon-");
    const env = appEnv(dir);
    writeFileSync(env.FACTORY_GH_APP_PRIVATE_KEY_PATH, privateKey);
    writeFileSync(
      env.FACTORY_GH_APP_TOKEN_FILE,
      JSON.stringify({
        token: "ghs_cached",
        expiresAt: new Date(start + 60 * 60 * 1000).toISOString(),
      }),
    );
    const timers = fakeTimers(start);
    const signals = daemonSignals();
    let unrefCalls = 0;
    const setTimeoutImpl = (callback, delayMs) => {
      const id = timers.setTimeoutImpl(callback, delayMs);
      return {
        id,
        unref() {
          unrefCalls += 1;
        },
      };
    };
    const daemon = runDaemon({
      ...daemonOptions(env, timers, signals, async () => {
        throw new Error("a fresh cache must not mint on startup");
      }),
      setTimeoutImpl,
      clearTimeoutImpl: (timer) => timers.clearTimeoutImpl(timer.id),
    });
    await flushDaemon();

    expect(timers.nextDelay()).toBe(45 * 60 * 1000);
    expect(unrefCalls).toBe(0);

    signals.stop();
    await daemon;
  });

  test("retries failed refreshes with bounded backoff", async () => {
    const start = Date.parse("2026-08-29T12:00:00Z");
    const dir = tmp("gh-app-daemon-");
    const env = appEnv(dir);
    writeFileSync(env.FACTORY_GH_APP_PRIVATE_KEY_PATH, privateKey);
    const timers = fakeTimers(start);
    const signals = daemonSignals();
    let attempts = 0;
    const daemon = runDaemon(
      daemonOptions(env, timers, signals, async () => {
        attempts += 1;
        return { ok: false, status: 503, json: async () => ({}) };
      }),
    );
    await flushDaemon();

    expect(attempts).toBe(1);
    expect(timers.nextDelay()).toBe(60 * 1000);
    await timers.advanceBy(60 * 1000);
    expect(attempts).toBe(2);
    expect(timers.nextDelay()).toBe(2 * 60 * 1000);
    await timers.advanceBy(2 * 60 * 1000);
    expect(attempts).toBe(3);
    expect(timers.nextDelay()).toBe(4 * 60 * 1000);

    signals.stop();
    await daemon;
  });

  test("a successful mint without a usable expiry keeps the interval and warns once", async () => {
    const start = Date.parse("2026-08-29T12:00:00Z");
    const dir = tmp("gh-app-daemon-");
    const env = appEnv(dir);
    writeFileSync(env.FACTORY_GH_APP_PRIVATE_KEY_PATH, privateKey);
    const timers = fakeTimers(start);
    const signals = daemonSignals();
    const warnings = [];
    let mints = 0;
    const daemon = runDaemon({
      ...daemonOptions(env, timers, signals, async () => {
        mints += 1;
        return {
          ok: true,
          status: 201,
          // No expires_at at all on the first mint, garbage on the second.
          json: async () =>
            mints === 1
              ? { token: "ghs_no_expiry" }
              : { token: "ghs_bad_expiry", expires_at: "not-a-date" },
        };
      }),
      log: {
        log() {},
        warn(message) {
          warnings.push(message);
        },
      },
    });
    await flushDaemon();

    // Not a failure: the fixed cadence applies, not the 60s→5m backoff.
    expect(mints).toBe(1);
    expect(timers.nextDelay()).toBe(45 * 60 * 1000);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("no usable expires_at");
    expect(warnings[0]).not.toContain("ghs_");

    await timers.advanceBy(45 * 60 * 1000);
    expect(mints).toBe(2);
    expect(timers.nextDelay()).toBe(45 * 60 * 1000);
    // The warning is emitted once, not on every tick.
    expect(warnings).toHaveLength(1);

    signals.stop();
    await daemon;
  });

  test("a throw outside refresh() re-arms with backoff instead of killing the chain", async () => {
    const start = Date.parse("2026-08-29T12:00:00Z");
    const dir = tmp("gh-app-auth-daemon-");
    const env = appEnv(dir);
    writeFileSync(env.FACTORY_GH_APP_PRIVATE_KEY_PATH, privateKey);
    const timers = fakeTimers(start);
    const signals = daemonSignals();
    const warnings = [];
    let mints = 0;
    const daemon = runDaemon({
      ...daemonOptions(env, timers, signals, async () => {
        mints += 1;
        return {
          ok: true,
          status: 201,
          json: async () => ({
            token: "ghs_no_expiry",
            expires_at:
              mints === 1
                ? null
                : new Date(timers.now() + 60 * 60 * 1000).toISOString(),
          }),
        };
      }),
      log: {
        log() {},
        // The no-expiry warning is raised outside refresh(); make it throw
        // once so the scheduling body itself fails.
        warn(message) {
          warnings.push(message);
          if (warnings.length === 1) throw new Error("logger exploded");
        },
      },
    });
    await flushDaemon();

    expect(mints).toBe(1);
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain("refresh scheduling failed: logger exploded");
    expect(timers.nextDelay()).toBe(60 * 1000);

    // The chain survived: the next tick mints again and returns to cadence.
    await timers.advanceBy(60 * 1000);
    expect(mints).toBe(2);
    expect(timers.nextDelay()).toBe(45 * 60 * 1000);

    signals.stop();
    await daemon;
  });
});
