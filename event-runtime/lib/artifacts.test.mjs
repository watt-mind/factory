import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-artifacts-test-mjs";
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  artifactPath,
  findArtifact,
  hashFile,
  materializeArtifact,
  pinRunArtifact,
  pruneArtifacts,
  referencedHashes,
  storeCollected,
  storeStats,
} from "./artifacts.mjs";
import { sha256Hex } from "./canonical.mjs";
import { openDb } from "./db.mjs";

const tmp = (p) => tmpDir(p);

function makeStore(bytes, storeRoot = tmp("evrt-store-")) {
  mkdirSync(storeRoot, { recursive: true });
  const hash = sha256Hex(Buffer.from(bytes));
  writeFileSync(path.join(storeRoot, hash), bytes);
  return { storeRoot, hash };
}

describe("artifactPath", () => {
  test("resolves a valid 64-hex SHA", () => {
    const hash = "a".repeat(64);
    expect(artifactPath("/store", hash)).toBe(path.join("/store", hash));
  });

  test("rejects malformed hashes", () => {
    expect(() => artifactPath("/store", "../etc/passwd")).toThrow(
      /invalid artifact hash/,
    );
    expect(() => artifactPath("/store", "abc")).toThrow(
      /invalid artifact hash/,
    );
    expect(() => artifactPath("/store", null)).toThrow(/invalid artifact hash/);
  });
});

describe("findArtifact", () => {
  test("finds artifact when present and returns null when absent or malformed", () => {
    const { storeRoot, hash } = makeStore("test-content");
    const found = findArtifact(storeRoot, hash);
    expect(found).not.toBeNull();
    expect(found.file).toBe(path.join(storeRoot, hash));
    expect(found.sizeBytes).toBe(12);

    expect(findArtifact(storeRoot, "b".repeat(64))).toBeNull();
    expect(findArtifact(storeRoot, "invalid")).toBeNull();
  });
});

describe("storeCollected (OPS-406)", () => {
  test("copies collected artifacts into the store", () => {
    const storeRoot = tmp("evrt-store-");
    const workspaceDir = tmp("evrt-ws-");
    const file = path.join(workspaceDir, "out.log");
    writeFileSync(file, "hello world");
    const hash = sha256Hex(Buffer.from("hello world"));

    const entries = [{ kind: "log", uri: `file://${file}`, sha256: hash }];
    const stored = storeCollected({ entries, storeRoot });
    expect(stored[0].uri).toBe(`file://${path.join(storeRoot, hash)}`);
    expect(stored[0].sizeBytes).toBe(11);
    expect(readFileSync(path.join(storeRoot, hash), "utf8")).toBe(
      "hello world",
    );
  });

  test("rejects symlinked artifact source file", () => {
    const storeRoot = tmp("evrt-store-");
    const outsideDir = tmp("evrt-outside-");
    const secretFile = path.join(outsideDir, "secret.key");
    writeFileSync(secretFile, "secret-data");

    const workspaceDir = tmp("evrt-ws-");
    const symlinkFile = path.join(workspaceDir, "symlink.key");
    symlinkSync(secretFile, symlinkFile);

    const hash = sha256Hex(Buffer.from("secret-data"));
    const entries = [
      { kind: "key", uri: `file://${symlinkFile}`, sha256: hash },
    ];

    expect(() => storeCollected({ entries, storeRoot })).toThrow(
      /cannot store symlinked artifact/,
    );
  });

  test("rejects non-existent source file", () => {
    const storeRoot = tmp("evrt-store-");
    const workspaceDir = tmp("evrt-ws-");
    const missingFile = path.join(workspaceDir, "missing.log");
    const hash = "c".repeat(64);
    const entries = [
      { kind: "log", uri: `file://${missingFile}`, sha256: hash },
    ];
    expect(() => storeCollected({ entries, storeRoot })).toThrow(
      /does not exist/,
    );
  });

  test("rejects source file when content hash does not match declared sha256 (OPS-439)", () => {
    const storeRoot = tmp("evrt-store-");
    const workspaceDir = tmp("evrt-ws-");
    const file = path.join(workspaceDir, "out.log");
    writeFileSync(file, "actual content");
    const wrongHash = sha256Hex(Buffer.from("expected different content"));

    const entries = [{ kind: "log", uri: `file://${file}`, sha256: wrongHash }];
    expect(() => storeCollected({ entries, storeRoot })).toThrow(
      /hash mismatch/,
    );
    expect(existsSync(path.join(storeRoot, wrongHash))).toBe(false);
  });

  test("replaces corrupted existing store artifact when storing valid source (OPS-439)", () => {
    const storeRoot = tmp("evrt-store-");
    mkdirSync(storeRoot, { recursive: true });
    const workspaceDir = tmp("evrt-ws-");
    const file = path.join(workspaceDir, "valid.log");
    writeFileSync(file, "complete valid content");
    const hash = sha256Hex(Buffer.from("complete valid content"));

    // Pre-populate store with corrupted/truncated artifact
    const dest = path.join(storeRoot, hash);
    writeFileSync(dest, "truncated");

    const entries = [{ kind: "log", uri: `file://${file}`, sha256: hash }];
    const stored = storeCollected({ entries, storeRoot });
    expect(stored[0].uri).toBe(`file://${dest}`);
    expect(stored[0].sizeBytes).toBe(
      Buffer.byteLength("complete valid content"),
    );
    expect(readFileSync(dest, "utf8")).toBe("complete valid content");
  });

  test("skips rewriting when destination already holds verified matching content", () => {
    const storeRoot = tmp("evrt-store-");
    mkdirSync(storeRoot, { recursive: true });
    const workspaceDir = tmp("evrt-ws-");
    const file = path.join(workspaceDir, "valid.log");
    writeFileSync(file, "identical content");
    const hash = sha256Hex(Buffer.from("identical content"));

    const dest = path.join(storeRoot, hash);
    writeFileSync(dest, "identical content");

    const entries = [{ kind: "log", uri: `file://${file}`, sha256: hash }];
    const stored = storeCollected({ entries, storeRoot });
    expect(stored[0].uri).toBe(`file://${dest}`);
    expect(stored[0].sizeBytes).toBe(Buffer.byteLength("identical content"));
  });

  test("interrupted or failed write leaves no tmp files and no readable entry (OPS-439)", () => {
    const storeRoot = tmp("evrt-store-");
    const workspaceDir = tmp("evrt-ws-");
    const file = path.join(workspaceDir, "data.bin");
    writeFileSync(file, "some data");
    const hash = sha256Hex(Buffer.from("some data"));

    // Cause a failure by passing an invalid declared sha256
    const entries = [
      { kind: "bin", uri: `file://${file}`, sha256: "0".repeat(64) },
    ];
    expect(() => storeCollected({ entries, storeRoot })).toThrow();

    // Verify store directory has neither destination nor tmp files
    const remainingFiles = readdirSync(storeRoot);
    expect(remainingFiles).toEqual([]);
    expect(existsSync(path.join(storeRoot, hash))).toBe(false);
  });
});

describe("hashFile", () => {
  test("computes SHA256 of file on disk", () => {
    const dir = tmp("evrt-hash-");
    const file = path.join(dir, "sample.txt");
    writeFileSync(file, "hello crypto world");
    const expected = sha256Hex(Buffer.from("hello crypto world"));
    expect(hashFile(file)).toBe(expected);
  });
});

describe("materializeArtifact (OPS-406)", () => {
  test("writes stored bytes into workspace under relative path", () => {
    const { storeRoot, hash } = makeStore("test data");
    const workspaceDir = tmp("evrt-ws-");
    const res = materializeArtifact({
      storeRoot,
      sha256hex: hash,
      workspaceDir,
      as: "subdir/file.txt",
    });
    expect(res.sha256).toBe(hash);
    expect(
      readFileSync(path.join(workspaceDir, "subdir/file.txt"), "utf8"),
    ).toBe("test data");
  });

  test("rejects absolute paths and path escapes", () => {
    const { storeRoot, hash } = makeStore("test data");
    const workspaceDir = tmp("evrt-ws-");
    expect(() =>
      materializeArtifact({
        storeRoot,
        sha256hex: hash,
        workspaceDir,
        as: "/abs/path",
      }),
    ).toThrow();
    expect(() =>
      materializeArtifact({
        storeRoot,
        sha256hex: hash,
        workspaceDir,
        as: "../outside",
      }),
    ).toThrow();
  });

  test("rejects symlinked destination directory pointing outside workspace", () => {
    const { storeRoot, hash } = makeStore("test data");
    const outsideDir = tmp("evrt-outside-");
    const workspaceDir = tmp("evrt-ws-");

    const symlinkDir = path.join(workspaceDir, "symdir");
    symlinkSync(outsideDir, symlinkDir, "dir");

    expect(() =>
      materializeArtifact({
        storeRoot,
        sha256hex: hash,
        workspaceDir,
        as: "symdir/pwned.txt",
      }),
    ).toThrow(/escapes the workspace/);
  });

  test("rejects if destination file already exists as a symlink", () => {
    const { storeRoot, hash } = makeStore("test data");
    const outsideDir = tmp("evrt-outside-");
    const targetFile = path.join(outsideDir, "target.txt");
    writeFileSync(targetFile, "original");

    const workspaceDir = tmp("evrt-ws-");
    const symlinkFile = path.join(workspaceDir, "link.txt");
    symlinkSync(targetFile, symlinkFile);

    expect(() =>
      materializeArtifact({
        storeRoot,
        sha256hex: hash,
        workspaceDir,
        as: "link.txt",
      }),
    ).toThrow(/symlink/);
  });

  test("fails loudly and removes corrupt store entry when stored bytes do not match expected hash (OPS-439)", () => {
    const storeRoot = tmp("evrt-store-");
    mkdirSync(storeRoot, { recursive: true });
    const fullContent = "full complete transcript data";
    const hash = sha256Hex(Buffer.from(fullContent));
    const storeFile = path.join(storeRoot, hash);

    // Simulate truncated/corrupted write in store
    writeFileSync(storeFile, "full complete");

    const workspaceDir = tmp("evrt-ws-");
    expect(() =>
      materializeArtifact({
        storeRoot,
        sha256hex: hash,
        workspaceDir,
        as: "transcript.json",
      }),
    ).toThrow(/corrupt/);

    // Corrupt entry must be removed from store
    expect(existsSync(storeFile)).toBe(false);
  });
});

describe("store maintenance: referencedHashes, storeStats, pruneArtifacts, pinRunArtifact", () => {
  test("storeStats and pruneArtifacts manage referenced vs unreferenced artifacts", () => {
    const db = openDb(":memory:");
    const { storeRoot, hash: hash1 } = makeStore("content 1");
    const { hash: hash2 } = makeStore("content 2", storeRoot);

    db.query(
      `INSERT INTO results (run_id, attempt, result_json, artifact_hash, verification_json, receipt_json, accepted_at)
       VALUES (?, 1, ?, 'sha256:x', '{}', '{}', ?)`,
    ).run(
      "run_1",
      JSON.stringify({
        artifacts: [{ kind: "ci-log", sha256: hash1, uri: "file:///x" }],
      }),
      new Date().toISOString(),
    );

    const referenced = referencedHashes(db);
    expect(referenced.has(hash1)).toBe(true);
    expect(referenced.has(hash2)).toBe(false);

    const stats = storeStats(db, storeRoot);
    expect(stats.files).toBe(2);
    expect(stats.orphans).toBe(1);

    const pruned = pruneArtifacts(db, storeRoot, { olderThanMs: -1000 });
    expect(pruned.deleted).toBe(1);
    expect(findArtifact(storeRoot, hash1)).not.toBeNull();
    expect(findArtifact(storeRoot, hash2)).toBeNull();
  });

  test("pinRunArtifact retrieves artifact hash by kind", () => {
    const db = openDb(":memory:");
    const hash = "d".repeat(64);
    db.query(
      `INSERT INTO runs (run_id, idempotency_key, spec_json, spec_hash, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'COMPLETED', ?, ?)`,
    ).run(
      "run_100",
      "idem_100",
      JSON.stringify({ agent: "test-agent" }),
      "hash_100",
      new Date().toISOString(),
      new Date().toISOString(),
    );

    db.query(
      `INSERT INTO results (run_id, attempt, result_json, artifact_hash, verification_json, receipt_json, accepted_at)
       VALUES (?, 1, ?, 'sha256:x', '{}', '{}', ?)`,
    ).run(
      "run_100",
      JSON.stringify({
        artifacts: [{ kind: "transcript", sha256: hash, uri: "file:///x" }],
      }),
      new Date().toISOString(),
    );

    const pinned = pinRunArtifact(db, "run_100", { kind: "transcript" });
    expect(pinned.transcript).toBe(hash);
    expect(pinned.agent).toBe("test-agent");

    expect(() => pinRunArtifact(db, "run_unknown")).toThrow(/unknown run/);
    expect(() => pinRunArtifact(db, "run_100", { kind: "other" })).toThrow(
      /stored no "other" artifact/,
    );
  });
});
