import { tmpDir } from "../test-support/tmp.mjs?file=event-runtime-lib-disk-test-mjs";
import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_MIN_FREE_BYTES,
  DEFAULT_REFUSE_USAGE_RATIO,
  DEFAULT_WARN_USAGE_RATIO,
  DiskSpaceError,
  assertDiskSpaceForArtifacts,
  assertDiskSpaceForWorkspace,
  checkDiskSpace,
  getDiskSpace,
} from "./disk.mjs";

const tmp = (p) => tmpDir(p);

describe("DiskSpaceError", () => {
  test("creates error with proper message and properties", () => {
    const err = new DiskSpaceError("out of space", {
      path: "/tmp",
      availableBytes: 100,
      requiredBytes: 500,
      totalBytes: 1000,
      usageRatio: 0.9,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("DiskSpaceError");
    expect(err.message).toBe("out of space");
    expect(err.path).toBe("/tmp");
    expect(err.availableBytes).toBe(100);
    expect(err.requiredBytes).toBe(500);
    expect(err.totalBytes).toBe(1000);
    expect(err.usageRatio).toBe(0.9);
  });
});

describe("getDiskSpace", () => {
  test("returns disk space metrics for an existing directory", () => {
    const dir = tmp("disk-test-");
    try {
      const stats = getDiskSpace(dir);
      expect(stats.totalBytes).toBeGreaterThan(0);
      expect(stats.availableBytes).toBeGreaterThan(0);
      expect(stats.freeBytes).toBeGreaterThan(0);
      expect(stats.usageRatio).toBeGreaterThanOrEqual(0);
      expect(stats.usageRatio).toBeLessThanOrEqual(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("handles non-existent paths by checking closest existing ancestor", () => {
    const dir = tmp("disk-test-");
    const nonExistentSub = path.join(
      dir,
      "nested",
      "path",
      "does",
      "not",
      "exist",
    );
    try {
      const stats = getDiskSpace(nonExistentSub);
      expect(stats.totalBytes).toBeGreaterThan(0);
      expect(stats.availableBytes).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("uses injected statfsFn if provided", () => {
    const mockStatfs = () => ({
      bsize: 4096,
      blocks: 1000,
      bfree: 200,
      bavail: 100,
    });
    const stats = getDiskSpace("/mock/path", { statfsFn: mockStatfs });
    expect(stats.totalBytes).toBe(4096000);
    expect(stats.freeBytes).toBe(819200);
    expect(stats.availableBytes).toBe(409600);
    expect(stats.usageRatio).toBeCloseTo(0.8, 5);
  });
});

describe("checkDiskSpace", () => {
  test("passes when available space exceeds threshold", () => {
    const mockStatfs = () => ({
      bsize: 1024 * 1024,
      blocks: 2000,
      bfree: 1000,
      bavail: 1000, // 1000 MB available
    });
    const result = checkDiskSpace("/mock/path", {
      minFreeBytes: 500 * 1024 * 1024, // 500 MB
      statfsFn: mockStatfs,
    });
    expect(result.ok).toBe(true);
    expect(result.availableBytes).toBe(1000 * 1024 * 1024);
  });

  test("throws DiskSpaceError when available space is below minFreeBytes", () => {
    const mockStatfs = () => ({
      bsize: 1024 * 1024,
      blocks: 2000,
      bfree: 400,
      bavail: 400, // 400 MB available (< 500 MB)
    });
    expect(() =>
      checkDiskSpace("/mock/path", {
        minFreeBytes: 500 * 1024 * 1024,
        statfsFn: mockStatfs,
      }),
    ).toThrow(DiskSpaceError);

    try {
      checkDiskSpace("/mock/path", {
        minFreeBytes: 500 * 1024 * 1024,
        statfsFn: mockStatfs,
      });
    } catch (err) {
      expect(err.availableBytes).toBe(400 * 1024 * 1024);
      expect(err.requiredBytes).toBe(500 * 1024 * 1024);
    }
  });

  test("throws DiskSpaceError when usage ratio exceeds maxUsageRatio", () => {
    const mockStatfs = () => ({
      bsize: 1024 * 1024,
      blocks: 10000,
      bfree: 400, // 96% used
      bavail: 400, // 400MB
    });
    expect(() =>
      checkDiskSpace("/mock/path", {
        minFreeBytes: 100 * 1024 * 1024, // 100 MB required
        maxUsageRatio: 0.95, // 95% max
        statfsFn: mockStatfs,
      }),
    ).toThrow(DiskSpaceError);
  });
});

describe("helpers", () => {
  test("assertDiskSpaceForWorkspace uses default 500MB min free bytes", () => {
    const mockStatfs = () => ({
      bsize: 1024 * 1024,
      blocks: 1000,
      bfree: 600,
      bavail: 600, // 600 MB
    });
    const res = assertDiskSpaceForWorkspace("/tmp/ws", {
      statfsFn: mockStatfs,
    });
    expect(res.ok).toBe(true);
  });

  test("assertDiskSpaceForWorkspace rejects when under 500MB", () => {
    const mockStatfs = () => ({
      bsize: 1024 * 1024,
      blocks: 1000,
      bfree: 450,
      bavail: 450, // 450 MB < 500 MB
    });
    expect(() =>
      assertDiskSpaceForWorkspace("/tmp/ws", { statfsFn: mockStatfs }),
    ).toThrow(DiskSpaceError);
  });

  test("assertDiskSpaceForArtifacts uses default 500MB min free bytes", () => {
    const mockStatfs = () => ({
      bsize: 1024 * 1024,
      blocks: 1000,
      bfree: 600,
      bavail: 600,
    });
    const res = assertDiskSpaceForArtifacts("/tmp/artifacts", {
      statfsFn: mockStatfs,
    });
    expect(res.ok).toBe(true);
  });

  test("assertDiskSpaceForArtifacts rejects when under 500MB", () => {
    const mockStatfs = () => ({
      bsize: 1024 * 1024,
      blocks: 1000,
      bfree: 300,
      bavail: 300, // 300 MB < 500 MB
    });
    expect(() =>
      assertDiskSpaceForArtifacts("/tmp/artifacts", { statfsFn: mockStatfs }),
    ).toThrow(DiskSpaceError);
  });

  test("defaults verify constants", () => {
    expect(DEFAULT_MIN_FREE_BYTES).toBe(500 * 1024 * 1024);
    expect(DEFAULT_WARN_USAGE_RATIO).toBe(0.85);
    expect(DEFAULT_REFUSE_USAGE_RATIO).toBe(0.95);
  });
});
