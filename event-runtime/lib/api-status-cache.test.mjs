import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  GH_SECRET,
  PV,
  SECRET,
  apiClient,
  deregisterWorker,
  envelope,
  existsSync,
  fake,
  heartbeat,
  http,
  isLoopbackHost,
  isLoopbackOrigin,
  janitorArgv,
  loadRegistry,
  loadRepos,
  makeServer,
  mkdirSync,
  mkdtempSync,
  observedModelFromTranscript,
  openDb,
  os,
  path,
  planAdmittedEvents,
  readFileSync,
  registerWorker,
  rejection,
  repoNamesFromInput,
  registry,
  runOnce,
  sign,
  startApi,
  utimesSync,
  writeFileSync,
} from "./api-test-helpers.mjs";

describe("status artifact store stats caching (OPS-456)", () => {
  test("GET /status caches storeStats across repeated calls within TTL", async () => {
    let nowMs = 1000000;
    const home = mkdtempSync(path.join(os.tmpdir(), "evrt-status-cache-"));
    const s = await makeServer({
      env: { name: "test-env", home, adapter: null },
      now: () => nowMs,
    });
    try {
      // Create an artifact file in the store
      const storeDir = path.join(home, "artifacts");
      mkdirSync(storeDir, { recursive: true });
      const hash1 = "a".repeat(64);
      writeFileSync(path.join(storeDir, hash1), "hello", "utf8");

      const res1 = await fetch(s.url("/status"));
      const body1 = await res1.json();
      expect(body1.artifacts.files).toBe(1);
      expect(body1.artifacts.at).toBe(new Date(nowMs).toISOString());

      // Add another file in the store while within TTL
      nowMs += 2000; // 2 seconds later (within 10s TTL)
      const hash2 = "b".repeat(64);
      writeFileSync(path.join(storeDir, hash2), "world", "utf8");

      const res2 = await fetch(s.url("/status"));
      const body2 = await res2.json();
      // Should still return cached stats from T=1000000 (files: 1, same timestamp)
      expect(body2.artifacts.files).toBe(1);
      expect(body2.artifacts.at).toBe(new Date(1000000).toISOString());

      // Advance time past 10s TTL
      nowMs += 11000;
      const res3 = await fetch(s.url("/status"));
      const body3 = await res3.json();
      // Should now refresh cache and see both files
      expect(body3.artifacts.files).toBe(2);
      expect(body3.artifacts.at).toBe(new Date(nowMs).toISOString());
    } finally {
      s.close();
    }
  });

  test("statusView resolves artifacts root from env.home", async () => {
    const customHome = mkdtempSync(path.join(os.tmpdir(), "evrt-custom-home-"));
    const storeDir = path.join(customHome, "artifacts");
    mkdirSync(storeDir, { recursive: true });
    const hash = "c".repeat(64);
    writeFileSync(path.join(storeDir, hash), "custom-home-content", "utf8");

    const s = await makeServer({
      env: { name: "custom-env", home: customHome, adapter: null },
    });
    try {
      const res = await fetch(s.url("/status"));
      const body = await res.json();
      expect(body.artifacts.files).toBe(1);
      expect(body.artifacts.bytes).toBe(19);
    } finally {
      s.close();
    }
  });
});
