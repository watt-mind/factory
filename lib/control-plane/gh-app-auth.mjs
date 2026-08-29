/**
 * GitHub App authentication for the factory stack (WM-1137, Phase 2 of #1136).
 *
 * `gh` honours the `GH_TOKEN` env var over its own config, so to give the
 * factory its own rate budget we feed it a **GitHub App installation token**
 * via `GH_TOKEN`, refreshed hourly (installation tokens expire in 1h). See
 * epic #1136 §6 "Design A".
 *
 * This module is deliberately made of small, pure, injectable pieces so the
 * whole flow is unit-testable against mocks — no real GitHub App exists yet:
 *   - `buildAppJwt` signs a short-lived RS256 JWT from the App private key.
 *   - `mintInstallationToken` exchanges that JWT for an installation token over
 *     REST (unaffected by the GraphQL rate limit), via an injected `fetchImpl`.
 *   - `resolveGhToken` reads a cached token file and re-mints only when it is
 *     missing or near expiry, rewriting the file atomically with mode 0600.
 *   - `readCachedAppToken` is the SYNC read `github.mjs` uses per `gh` spawn:
 *     it returns the cached token when App auth is configured and the file is
 *     fresh, and otherwise stays out of the way (see its contract below).
 *   - `runDaemon` is the supervised refresher (`--daemon`).
 *
 * Security: the token and the private key must NEVER appear in a log line, an
 * error message, or a thrown value. Every error here is phrased from status
 * codes and file paths only.
 */
import { createSign } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** Installation tokens live 1h; re-mint when this close to expiry. */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;
/** Daemon refresh cadence — comfortably inside the 1h token lifetime. */
const REFRESH_INTERVAL_MS = 45 * 60 * 1000;
/** JWTs GitHub accepts must expire within 10 min; back-date `iat` for skew. */
const JWT_LIFETIME_S = 9 * 60;
const JWT_BACKDATE_S = 60;

const b64url = (input) => Buffer.from(input).toString("base64url");

/**
 * A short-lived RS256 JWT authenticating as the App itself (`iss=appId`).
 * Pure and testable: pass a fixed `now` and verify the signature with the
 * matching public key. `iat` is back-dated 60s to tolerate clock skew and
 * `exp` is kept under GitHub's 10-minute ceiling.
 *
 * @param {{ appId: string|number, privateKeyPem: string, now?: () => number }} args
 * @returns {string} `header.payload.signature`, base64url, RS256.
 */
export function buildAppJwt({ appId, privateKeyPem, now = () => Date.now() }) {
  if (!appId) throw new Error("buildAppJwt requires appId");
  if (!privateKeyPem) throw new Error("buildAppJwt requires privateKeyPem");
  const nowS = Math.floor(now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: nowS - JWT_BACKDATE_S,
    exp: nowS + JWT_LIFETIME_S,
    iss: String(appId),
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(
    JSON.stringify(payload),
  )}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(privateKeyPem).toString("base64url");
  return `${signingInput}.${signature}`;
}

/**
 * Exchange an App JWT for an installation access token over REST.
 *
 * REST is used deliberately — this path is unaffected by the GraphQL rate
 * limit. `fetchImpl` defaults to the global `fetch` so tests can inject a mock
 * and no real network call is made.
 *
 * @param {{
 *   appId: string|number,
 *   installationId: string|number,
 *   privateKeyPem: string,
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 * }} args
 * @returns {Promise<{ token: string, expiresAt: string|null }>}
 */
export async function mintInstallationToken({
  appId,
  installationId,
  privateKeyPem,
  fetchImpl = fetch,
  now = () => Date.now(),
}) {
  if (!installationId)
    throw new Error("mintInstallationToken requires installationId");
  const jwt = buildAppJwt({ appId, privateKeyPem, now });
  let res;
  try {
    res = await fetchImpl(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "watt-mind-factory",
        },
      },
    );
  } catch {
    // Never surface the underlying error verbatim: it could carry the request
    // (and thus the Bearer JWT) in some runtimes. Report only that it failed.
    throw new Error("installation-token request failed to reach GitHub");
  }
  if (!res?.ok)
    throw new Error(
      `installation-token request rejected (status ${res?.status ?? "?"})`,
    );
  const data = await res.json();
  if (!data?.token)
    throw new Error("installation-token response contained no token");
  return { token: data.token, expiresAt: data.expires_at ?? null };
}

/** Parse an ISO-8601 or epoch-ms expiry into epoch ms, or null. */
function expiryMs(expiresAt) {
  if (expiresAt == null) return null;
  if (typeof expiresAt === "number") return expiresAt;
  const ms = Date.parse(expiresAt);
  return Number.isNaN(ms) ? null : ms;
}

/** A cached record is usable when it has a token and enough life left. */
function tokenIsFresh(cached, nowMs) {
  if (!cached?.token) return false;
  const exp = expiryMs(cached.expiresAt);
  // No/unparseable expiry is treated as stale — safer to re-mint than to feed
  // `gh` a token that may already be dead.
  if (exp == null) return false;
  return exp - nowMs > EXPIRY_SKEW_MS;
}

/** Read and parse the cached `{ token, expiresAt }` file, or null on any error. */
function readTokenFile(tokenFile) {
  let raw;
  try {
    raw = readFileSync(tokenFile, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.token === "string")
      return { token: parsed.token, expiresAt: parsed.expiresAt ?? null };
    return null;
  } catch {
    return null;
  }
}

/** Write `{ token, expiresAt }` atomically (tmp+rename) with mode 0600. */
function writeTokenFileAtomic(tokenFile, record) {
  mkdirSync(path.dirname(tokenFile), { recursive: true });
  const tmp = `${tokenFile}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(
    tmp,
    JSON.stringify({ token: record.token, expiresAt: record.expiresAt }),
    { mode: 0o600 },
  );
  // writeFileSync's mode only applies on create; enforce it before the rename
  // in case the tmp path somehow pre-existed with looser perms.
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // Best effort — the create-time mode already covers the common case.
  }
  renameSync(tmp, tokenFile);
}

/**
 * Resolve a usable installation token, minting and caching only when needed.
 *
 * Reads the cached `{ token, expiresAt }` JSON from `tokenFile`; if it is
 * missing or within the 5-minute expiry skew, calls `mint()`, writes the file
 * atomically (tmp+rename, 0600), and returns the fresh token. Never logs the
 * token.
 *
 * @param {{ tokenFile: string, now?: () => number, mint: () => Promise<{token:string,expiresAt:string|null}> }} args
 * @returns {Promise<string>} the installation token.
 */
export async function resolveGhToken({
  tokenFile,
  now = () => Date.now(),
  mint,
}) {
  if (!tokenFile) throw new Error("resolveGhToken requires tokenFile");
  const cached = readTokenFile(tokenFile);
  if (tokenIsFresh(cached, now())) return cached.token;
  if (typeof mint !== "function")
    throw new Error("resolveGhToken requires mint() to refresh the token");
  const minted = await mint();
  if (!minted?.token) throw new Error("mint() returned no token");
  writeTokenFileAtomic(tokenFile, minted);
  return minted.token;
}

/** The default cached-token path when `FACTORY_GH_APP_TOKEN_FILE` is unset. */
export function defaultTokenFile(home = homedir()) {
  return path.join(home, ".factory", "gh-app-token.json");
}

/**
 * The App-auth config from env, or null when App auth is not configured.
 *
 * "Configured" requires the App id, installation id, and private-key path to
 * all be present; the token file has a default. Absence of any of the three
 * means the factory keeps running on its existing gh-config PAT — this is the
 * no-op path callers must preserve.
 */
export function readAppConfig(env = process.env) {
  const appId = env.FACTORY_GH_APP_ID;
  const installationId = env.FACTORY_GH_APP_INSTALLATION_ID;
  const privateKeyPath = env.FACTORY_GH_APP_PRIVATE_KEY_PATH;
  if (!appId || !installationId || !privateKeyPath) return null;
  return {
    appId,
    installationId,
    privateKeyPath,
    tokenFile: env.FACTORY_GH_APP_TOKEN_FILE || defaultTokenFile(),
  };
}

/**
 * The SYNC per-spawn token read used by `github.mjs`.
 *
 * Contract, chosen so wiring into a synchronous `spawnSync` path is safe:
 *   - App auth NOT configured (env vars absent) → returns `null` WITHOUT
 *     throwing. Callers add no `GH_TOKEN` and behave exactly as today.
 *   - App auth configured but the cached file is missing, unreadable, or
 *     expired → THROWS. The caller logs a single warning and falls back to the
 *     default `gh` credentials. Minting is the daemon's job, never a `gh`
 *     call's — a synchronous spawn path must not block on the network.
 *
 * The error text names only status/state, never the token.
 *
 * @param {{ env?: NodeJS.ProcessEnv, now?: () => number }} [args]
 * @returns {string|null}
 */
export function readCachedAppToken({
  env = process.env,
  now = () => Date.now(),
} = {}) {
  const config = readAppConfig(env);
  if (!config) return null;
  const cached = readTokenFile(config.tokenFile);
  if (!cached) throw new Error("gh App token file is missing or unreadable");
  if (!tokenIsFresh(cached, now()))
    throw new Error("gh App token is expired or near expiry");
  return cached.token;
}

/**
 * The supervised refresher (`--daemon`). Mints once on startup, then every
 * ~45 min, and exits cleanly on SIGTERM/SIGINT. Reads config from env and the
 * private key from `FACTORY_GH_APP_PRIVATE_KEY_PATH`. Logs only paths and
 * expiry timestamps — never the token or the key.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 *   log?: { log?: Function, warn?: Function },
 *   signals?: { on?: Function },
 *   intervalMs?: number,
 * }} [args]
 */
export async function runDaemon({
  env = process.env,
  fetchImpl = fetch,
  now = () => Date.now(),
  log = console,
  signals = process,
  intervalMs = REFRESH_INTERVAL_MS,
} = {}) {
  const config = readAppConfig(env);
  if (!config)
    throw new Error(
      "gh App auth not configured: set FACTORY_GH_APP_ID, " +
        "FACTORY_GH_APP_INSTALLATION_ID and FACTORY_GH_APP_PRIVATE_KEY_PATH",
    );
  const privateKeyPem = readFileSync(config.privateKeyPath, "utf8");
  const mint = () =>
    mintInstallationToken({
      appId: config.appId,
      installationId: config.installationId,
      privateKeyPem,
      fetchImpl,
      now,
    });

  const refresh = async () => {
    try {
      await resolveGhToken({ tokenFile: config.tokenFile, now, mint });
      log.log?.(`[gh-app-auth] installation token ready (${config.tokenFile})`);
    } catch (err) {
      // `err.message` is deliberately status/path-only (see mint/resolve).
      log.warn?.(`[gh-app-auth] token refresh failed: ${err?.message ?? err}`);
    }
  };

  await refresh();
  await new Promise((resolve) => {
    let timer = null;
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      resolve();
    };
    signals.on?.("SIGTERM", stop);
    signals.on?.("SIGINT", stop);
    timer = setInterval(() => {
      refresh();
    }, intervalMs);
    if (typeof timer?.unref === "function") timer.unref();
  });
}

if (import.meta.main) {
  const daemon = process.argv.includes("--daemon");
  const config = readAppConfig(process.env);
  if (!config) {
    process.stderr.write(
      "gh-app-auth: not configured — set FACTORY_GH_APP_ID, " +
        "FACTORY_GH_APP_INSTALLATION_ID and FACTORY_GH_APP_PRIVATE_KEY_PATH\n",
    );
    process.exit(2);
  }
  if (daemon) {
    await runDaemon().catch((err) => {
      process.stderr.write(`gh-app-auth: ${err?.message ?? err}\n`);
      process.exit(1);
    });
  } else {
    // One-shot: ensure a fresh cached token exists. Print only the file path
    // and expiry — never the token itself.
    try {
      const privateKeyPem = readFileSync(config.privateKeyPath, "utf8");
      await resolveGhToken({
        tokenFile: config.tokenFile,
        mint: () =>
          mintInstallationToken({
            appId: config.appId,
            installationId: config.installationId,
            privateKeyPem,
          }),
      });
      const cached = readTokenFile(config.tokenFile);
      process.stdout.write(
        `gh-app-auth: token cached at ${config.tokenFile}` +
          `${cached?.expiresAt ? ` (expires ${cached.expiresAt})` : ""}\n`,
      );
    } catch (err) {
      process.stderr.write(`gh-app-auth: ${err?.message ?? err}\n`);
      process.exit(1);
    }
  }
}
