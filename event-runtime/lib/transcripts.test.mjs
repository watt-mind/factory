import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-transcripts-test-mjs";
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable, PassThrough } from "node:stream";
import { sha256Hex } from "./canonical.mjs";
import {
  computeTranscriptHash,
  createTranscriptCapture,
  flushAndStoreTranscript,
  TRANSCRIPT_FILENAME,
  waitForStreamFlush,
} from "./transcripts.mjs";

const tmpWs = () => tmpDir("evrt-transcript-");

describe("transcripts (OPS-426)", () => {
  test("waitForStreamFlush resolves immediately for null or already finished streams", async () => {
    await expect(waitForStreamFlush(null)).resolves.toBeUndefined();

    const ws = tmpWs();
    const { stream, endAndFlush } = createTranscriptCapture(ws);
    await endAndFlush();
    expect(stream.writableFinished).toBe(true);

    // Calling waitForStreamFlush on already finished stream
    await expect(waitForStreamFlush(stream)).resolves.toBeUndefined();
  });

  test("waitForStreamFlush awaits full stream flush on active write stream", async () => {
    const ws = tmpWs();
    const { stream, filePath } = createTranscriptCapture(ws);

    const chunk =
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "hello" }] },
      }) + "\n";
    stream.write(chunk);
    stream.end();

    await waitForStreamFlush(stream);
    expect(stream.writableFinished).toBe(true);

    const content = readFileSync(filePath, "utf8");
    expect(content).toBe(chunk);
  });

  test("computeTranscriptHash computes exact sha256 after flushing active stream", async () => {
    const ws = tmpWs();
    const { stream, filePath } = createTranscriptCapture(ws);

    const data =
      JSON.stringify({ type: "result", status: "success", count: 12345 }) +
      "\n";
    stream.write(data);
    stream.end();

    const result = await computeTranscriptHash(filePath, stream);
    expect(result.sizeBytes).toBe(Buffer.byteLength(data, "utf8"));
    expect(result.sha256).toBe(sha256Hex(Buffer.from(data, "utf8")));
    expect(result.bytes.toString("utf8")).toBe(data);
  });

  test("flushAndStoreTranscript stores artifact whose bytes and sha256 strictly match full output", async () => {
    const ws = tmpWs();
    const storeRoot = path.join(tmpWs(), "store");
    const { stream, filePath } = createTranscriptCapture(ws);

    const payload =
      JSON.stringify({ message: "stored artifact verification test" }) + "\n";
    stream.write(payload);

    const stored = await flushAndStoreTranscript({
      workspaceDir: ws,
      storeRoot,
      stream,
    });

    const expectedHash = sha256Hex(Buffer.from(payload, "utf8"));
    expect(stored.sha256).toBe(expectedHash);
    expect(stored.sizeBytes).toBe(Buffer.byteLength(payload, "utf8"));
    expect(existsSync(stored.storePath)).toBe(true);
    expect(statSync(stored.storePath).size).toBe(stored.sizeBytes);
    expect(sha256Hex(readFileSync(stored.storePath))).toBe(expectedHash);
  });

  test("stress test: stub emitting several MB of NDJSON produces exact size and sha256 over 20 repetitions", async () => {
    const REPETITIONS = 20;
    const storeRoot = path.join(tmpWs(), "store");

    // Generate ~2MB of NDJSON lines per run
    const lines = [];
    for (let i = 0; i < 5000; i++) {
      lines.push(
        JSON.stringify({
          seq: i,
          type: "assistant",
          payload: {
            text: `Line ${i} with substantial padding to generate realistic multi-megabyte agent NDJSON stream output: ${"x".repeat(300)}`,
          },
        }),
      );
    }
    const fullNdjson = lines.join("\n") + "\n";
    const expectedBuffer = Buffer.from(fullNdjson, "utf8");
    const expectedSha256 = sha256Hex(expectedBuffer);
    const expectedSize = expectedBuffer.byteLength;

    for (let rep = 0; rep < REPETITIONS; rep++) {
      const ws = tmpWs();
      const { stream, filePath, endAndFlush } = createTranscriptCapture(ws);

      // Create a readable stream emitting chunks
      const readable = Readable.from(
        (async function* () {
          const chunkSize = 64 * 1024;
          for (
            let offset = 0;
            offset < expectedBuffer.length;
            offset += chunkSize
          ) {
            yield expectedBuffer.subarray(
              offset,
              Math.min(offset + chunkSize, expectedBuffer.length),
            );
          }
        })(),
      );

      readable.pipe(stream);

      // Wait for readable to finish piping and stream to flush
      await new Promise((resolve) => readable.on("end", resolve));
      await endAndFlush();

      const stored = await flushAndStoreTranscript({
        workspaceDir: ws,
        storeRoot,
      });

      expect(stored.sizeBytes).toBe(expectedSize);
      expect(stored.sha256).toBe(expectedSha256);

      const onDiskBytes = readFileSync(filePath);
      expect(onDiskBytes.byteLength).toBe(expectedSize);
      expect(sha256Hex(onDiskBytes)).toBe(expectedSha256);

      const storedBytes = readFileSync(stored.storePath);
      expect(storedBytes.byteLength).toBe(expectedSize);
      expect(sha256Hex(storedBytes)).toBe(expectedSha256);
    }
  }, 30_000);

  test("negative testing / falsifiability: un-flushed stream flush guarantee prevents reading partial bytes", async () => {
    const ws = tmpWs();
    const { stream, filePath, endAndFlush } = createTranscriptCapture(ws);

    const bigData = "A".repeat(512 * 1024);
    stream.write(bigData);

    // End and flush ensures full completion
    await endAndFlush();
    expect(stream.writableFinished).toBe(true);

    const onDisk = readFileSync(filePath, "utf8");
    expect(onDisk.length).toBe(bigData.length);
  });

  test("timeout / kill / abort path safely finishes without hanging or unhandled rejection", async () => {
    const ws = tmpWs();
    const { stream } = createTranscriptCapture(ws);

    stream.write(JSON.stringify({ type: "system", status: "aborting" }) + "\n");
    // Simulate abrupt destroy
    stream.destroy();

    // waitForStreamFlush handles destroyed stream gracefully
    await expect(waitForStreamFlush(stream)).resolves.toBeUndefined();
    // The helper must await the destroyed stream's lifecycle to completion, not
    // short-circuit on `destroyed`. After it returns the stream is truly closed,
    // so no async open/close callback survives to fire (and error) after the
    // test's temp dir is removed.
    expect(stream.closed).toBe(true);
  });

  // Regression for the load-sensitive flake where a destroyed-but-not-yet-closed
  // fs.WriteStream emitted a late `error` (ENOENT, once the tracked temp dir was
  // removed by afterAll) with no listener attached, which Bun surfaces as a
  // process-level `1 error` / `0 fail` between tests. In-test assertions cannot
  // observe that between-tests signature, so this runs the probe in an isolated
  // Bun child process against the real `waitForStreamFlush` and gates on the
  // child's exit code and stderr. On the pre-fix implementation the child throws
  // an unhandled EventEmitter `error` and exits nonzero; on the fixed
  // implementation the late error is consumed through the awaited promise and the
  // child exits 0 with no unhandled-error output.
  test("destroyed-but-not-closed stream's late write error is consumed, not leaked (isolated process)", async () => {
    const moduleUrl = new URL("./transcripts.mjs", import.meta.url).href;
    const scriptDir = tmpWs();
    const scriptPath = path.join(scriptDir, "transcript-leak-probe.mjs");

    const script = `
import { EventEmitter } from "node:events";
import { waitForStreamFlush } from ${JSON.stringify(moduleUrl)};

// Mimic an fs.WriteStream that is destroyed but has not finished its async
// open/close: destroyed === true while closed === false, with a write error
// still to be emitted on a later tick.
class LateErrorStream extends EventEmitter {
  constructor() {
    super();
    this.writableFinished = false;
    this.closed = false;
    this.destroyed = true;
  }
}

const stream = new LateErrorStream();
let consumed = false;
const flushed = waitForStreamFlush(stream).then(
  () => {},
  (err) => {
    if (err && err.code === "ENOENT") consumed = true;
  },
);

setTimeout(() => {
  const err = new Error(
    "ENOENT: no such file or directory, open '.transcript.json'",
  );
  err.code = "ENOENT";
  // If waitForStreamFlush already removed its 'error' listener (pre-fix), this
  // throws as an unhandled EventEmitter error and crashes the process.
  stream.emit("error", err);
}, 0);

await flushed;
await new Promise((r) => setTimeout(r, 50));
if (!consumed) {
  console.error("late error was not consumed through the awaited promise");
  process.exit(2);
}
process.exit(0);
`;
    writeFileSync(scriptPath, script);

    const proc = Bun.spawnSync({
      cmd: ["bun", scriptPath],
      stdout: "pipe",
      stderr: "pipe",
    });

    const stderr = proc.stderr.toString();
    expect(stderr).not.toMatch(/Unhandled|uncaught|ENOENT/i);
    expect(proc.exitCode).toBe(0);
  });
});
