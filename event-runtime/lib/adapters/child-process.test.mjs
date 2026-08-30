import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { tmpDir } from "../../test-support/tmp.mjs?file=event-runtime-lib-adapters-child-process-test-mjs";
import {
  DEFAULT_TRANSCRIPT_MAX_BYTES,
  transcriptMaxBytes,
} from "../config.mjs";
import {
  boundedTranscriptStream,
  DETACHED_SPAWN_OPTIONS,
  killProcessGroup,
} from "./child-process.mjs";

describe("child process helpers", () => {
  test("keeps spawned children in their own process group", () => {
    expect(DETACHED_SPAWN_OPTIONS).toEqual({ detached: true });
  });

  test("reads a positive transcript cap from the environment", () => {
    expect(
      transcriptMaxBytes({ FACTORY_EVENT_TRANSCRIPT_MAX_BYTES: "1234" }),
    ).toBe(1234);
    expect(
      transcriptMaxBytes({ FACTORY_EVENT_TRANSCRIPT_MAX_BYTES: "0" }),
    ).toBe(DEFAULT_TRANSCRIPT_MAX_BYTES);
  });

  test("signals the process group when it exists", () => {
    const groupSignals = [];
    const childSignals = [];
    const child = {
      pid: 42,
      kill: (signal) => childSignals.push(signal),
    };

    killProcessGroup(child, {
      signal: "SIGTERM",
      kill: (pid, signal) => groupSignals.push([pid, signal]),
    });

    expect(groupSignals).toEqual([[-42, "SIGTERM"]]);
    expect(childSignals).toEqual([]);
  });

  test("falls back to the direct child when the group is already gone", () => {
    const childSignals = [];
    const child = {
      pid: 42,
      kill: (signal) => childSignals.push(signal),
    };

    killProcessGroup(child, {
      kill: () => {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      },
    });

    expect(childSignals).toEqual(["SIGTERM"]);
  });

  test("escalates to SIGKILL after the configured grace period", () => {
    const signals = [];
    const timers = [];
    const child = { pid: 42, kill: () => {} };

    killProcessGroup(child, {
      killGraceMs: 25,
      kill: (pid, signal) => signals.push([pid, signal]),
      setTimeoutFn: (callback, delay) => {
        timers.push({ callback, delay });
        return { unref: () => {} };
      },
    });

    expect(signals).toEqual([[-42, "SIGTERM"]]);
    expect(timers).toHaveLength(1);
    expect(timers[0].delay).toBe(25);
    timers[0].callback();
    expect(signals).toEqual([
      [-42, "SIGTERM"],
      [-42, "SIGKILL"],
    ]);
  });

  test("does not arm duplicate termination sequences", () => {
    const signals = [];
    const timers = [];
    const child = { pid: 42, kill: () => {} };
    const options = {
      killGraceMs: 25,
      kill: (pid, signal) => signals.push([pid, signal]),
      setTimeoutFn: (callback) => {
        timers.push(callback);
        return { unref: () => {} };
      },
    };

    killProcessGroup(child, options);
    killProcessGroup(child, options);

    expect(signals).toEqual([[-42, "SIGTERM"]]);
    expect(timers).toHaveLength(1);
  });

  test("caps transcript bytes, writes an NDJSON truncation marker, and keeps accepting output", async () => {
    const transcriptPath = `${tmpDir("evrt-bounded-transcript-")}/.transcript.json`;
    const transcript = boundedTranscriptStream(transcriptPath, { maxBytes: 7 });

    transcript.write("abcd");
    transcript.write("efghijkl");
    transcript.end();
    await finished(transcript);

    expect(transcript.truncated).toBe(true);
    expect(transcript.bytes).toBe(7);
    expect(readFileSync(transcriptPath, "utf8")).toBe(
      'abcdefg\n{"type":"factory","subtype":"transcript_truncated","bytes":7}\n',
    );
  });

  test("preserves under-cap transcript bytes exactly", async () => {
    const transcriptPath = `${tmpDir("evrt-bounded-transcript-")}/.transcript.json`;
    const transcript = boundedTranscriptStream(transcriptPath, {
      maxBytes: 64,
    });
    const output = '{"type":"result","text":"complete"}\n';

    transcript.end(output);
    await finished(transcript);

    expect(transcript.truncated).toBe(false);
    expect(readFileSync(transcriptPath, "utf8")).toBe(output);
  });

  test("keeps draining when the transcript destination fails", async () => {
    const destination = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        callback(new Error("disk full"));
      },
    });
    destination.on("error", () => {});
    const transcript = boundedTranscriptStream("unused", {
      maxBytes: 64,
      createDestination: () => destination,
    });

    transcript.write("first chunk");
    transcript.write("output after destination failure");
    transcript.end();
    await finished(transcript);

    expect(transcript.destroyed).toBe(true);
  });
});
