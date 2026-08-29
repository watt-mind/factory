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
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmSync } from "node:fs";
import {
  buildAppJwt,
  mintInstallationToken,
  readCachedAppToken,
  resolveGhToken,
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
