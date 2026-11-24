import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  formatPrMediaMarkdown,
  loadArtifactConfig,
  parseEnvFile,
  resolveContentType,
  runArtifactCli,
  upsertUxEvidenceBlock,
  UX_EVIDENCE_END,
  UX_EVIDENCE_START,
} from "./artifact.mjs";

const tmpDirs = [];
function makeTmpDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "factory-artifact-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

// Minimal valid 1x1 PNG header bytes
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52,
]);

// Minimal MP4 ftyp header bytes
const MP4_BYTES = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32,
]);

describe("tools/artifact.mjs", () => {
  test("parseEnvFile and loadArtifactConfig honor env overrides over config file", () => {
    const dir = makeTmpDir();
    const cfg = path.join(dir, "artifacts.env");
    writeFileSync(
      cfg,
      [
        "# comment",
        "FACTORY_ARTIFACT_URL=https://artifacts.watt-mind.com/",
        'FACTORY_ARTIFACT_TOKEN="file-secret"',
      ].join("\n"),
    );

    expect(parseEnvFile(readFileSync(cfg, "utf8"))).toEqual({
      FACTORY_ARTIFACT_URL: "https://artifacts.watt-mind.com/",
      FACTORY_ARTIFACT_TOKEN: "file-secret",
    });

    const fromFile = loadArtifactConfig({ env: {}, configPath: cfg });
    expect(fromFile.baseUrl).toBe("https://artifacts.watt-mind.com");
    expect(fromFile.token).toBe("file-secret");

    const fromEnv = loadArtifactConfig({
      env: {
        FACTORY_ARTIFACT_URL: "https://custom.example.com/",
        FACTORY_ARTIFACT_TOKEN: "env-secret",
      },
      configPath: cfg,
    });
    expect(fromEnv.baseUrl).toBe("https://custom.example.com");
    expect(fromEnv.token).toBe("env-secret");
  });

  test("resolveContentType detects PNG and MP4 by magic bytes", () => {
    const dir = makeTmpDir();
    const png = path.join(dir, "shot.png");
    const mp4 = path.join(dir, "clip.mp4");
    writeFileSync(png, PNG_BYTES);
    writeFileSync(mp4, MP4_BYTES);
    expect(resolveContentType(png)).toBe("image/png");
    expect(resolveContentType(mp4)).toBe("video/mp4");
  });

  test("formatPrMediaMarkdown renders Before/After table, images, and video thumbnails", () => {
    const md = formatPrMediaMarkdown({
      before: {
        url: "https://artifacts.watt-mind.com/a/aaa.png",
        caption: "Before",
      },
      after: {
        url: "https://artifacts.watt-mind.com/a/bbb.png",
        caption: "After",
      },
      items: [
        {
          mediaType: "image",
          caption: "Modal open",
          url: "https://artifacts.watt-mind.com/a/ccc.png",
        },
        {
          mediaType: "video",
          caption: "Drag and drop",
          url: "https://artifacts.watt-mind.com/a/ddd.mp4",
          posterUrl: "https://artifacts.watt-mind.com/a/eee.png",
        },
      ],
    });
    expect(md).toContain("| Before | After |");
    expect(md).toContain(
      "| ![Before](https://artifacts.watt-mind.com/a/aaa.png) | ![After](https://artifacts.watt-mind.com/a/bbb.png) |",
    );
    expect(md).toContain(
      "![Modal open](https://artifacts.watt-mind.com/a/ccc.png)",
    );
    expect(md).toContain(
      "[![▶ Drag and drop](https://artifacts.watt-mind.com/a/eee.png)](https://artifacts.watt-mind.com/a/ddd.mp4)",
    );
  });

  test("upsertUxEvidenceBlock appends once and replaces cleanly on re-run", () => {
    const first = upsertUxEvidenceBlock(
      "## Summary\nHello\n\nFixes CLNT-1",
      "![v1](https://example.com/1.png)",
    );
    expect(first).toContain(UX_EVIDENCE_START);
    expect(first).toContain("![v1](https://example.com/1.png)");
    expect(first).toContain(UX_EVIDENCE_END);

    const second = upsertUxEvidenceBlock(
      first,
      "![v2](https://example.com/2.png)",
    );
    expect(second).not.toContain("v1");
    expect(second).toContain("![v2](https://example.com/2.png)");
    expect(second.split(UX_EVIDENCE_START).length).toBe(2);
  });

  test("put + get + ls + rm round-trip with local store and mocked Worker API", async () => {
    const dir = makeTmpDir();
    const storeRoot = path.join(dir, "store");
    const sample = path.join(dir, "demo.png");
    writeFileSync(sample, PNG_BYTES);
    const sha = createHash("sha256").update(PNG_BYTES).digest("hex");

    const remoteBlobs = new Map();
    const mockFetch = async (url, init = {}) => {
      const u = new URL(url);
      if (init.method === "PUT" && u.pathname === `/api/artifacts/${sha}`) {
        expect(init.headers.Authorization).toBe("Bearer tok");
        expect(init.headers["Content-Type"]).toBe("image/png");
        remoteBlobs.set(sha, Buffer.from(init.body));
        return new Response(
          JSON.stringify({
            ok: true,
            deduplicated: false,
            sha256: sha,
            bytes: PNG_BYTES.length,
            url: `https://artifacts.watt-mind.com/a/${sha}.png`,
          }),
          { status: 201 },
        );
      }
      if (
        (!init.method || init.method === "GET") &&
        u.pathname === "/api/artifacts"
      ) {
        return new Response(
          JSON.stringify({
            artifacts: [
              {
                sha256: sha,
                bytes: PNG_BYTES.length,
                kind: "ux-screenshot",
                url: `https://artifacts.watt-mind.com/a/${sha}.png`,
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (init.method === "DELETE" && u.pathname === `/api/artifacts/${sha}`) {
        remoteBlobs.delete(sha);
        return new Response(
          JSON.stringify({ ok: true, sha256: sha, deleted: [`public/${sha}`] }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    };

    const env = {
      FACTORY_ARTIFACT_URL: "https://artifacts.watt-mind.com",
      FACTORY_ARTIFACT_TOKEN: "tok",
    };

    const putOut = [];
    const code = await runArtifactCli(
      [
        "put",
        sample,
        "--kind",
        "ux-screenshot",
        "--repo",
        "watt-mind/factory",
        "--json",
      ],
      {
        env,
        storeRoot,
        configPath: path.join(dir, "missing.env"),
        fetchImpl: mockFetch,
        stdout: (s) => putOut.push(s),
      },
    );
    expect(code).toBe(0);
    const parsedPut = JSON.parse(putOut.join("\n"));
    expect(parsedPut.sha256).toBe(sha);
    expect(parsedPut.url).toBe(`https://artifacts.watt-mind.com/a/${sha}.png`);
    expect(existsSync(path.join(storeRoot, sha))).toBe(true);

    const lsOut = [];
    await runArtifactCli(["ls", "--local", "--remote", "--json"], {
      env,
      storeRoot,
      configPath: path.join(dir, "missing.env"),
      fetchImpl: mockFetch,
      stdout: (s) => lsOut.push(s),
    });
    const parsedLs = JSON.parse(lsOut.join("\n"));
    expect(parsedLs.local.length).toBe(1);
    expect(parsedLs.remote.length).toBe(1);

    const outCopy = path.join(dir, "copied.png");
    const getOut = [];
    await runArtifactCli(["get", sha, "-o", outCopy], {
      env,
      storeRoot,
      configPath: path.join(dir, "missing.env"),
      fetchImpl: mockFetch,
      stdout: (s) => getOut.push(s),
    });
    expect(readFileSync(outCopy)).toEqual(PNG_BYTES);

    await runArtifactCli(["rm", sha, "--local", "--remote"], {
      env,
      storeRoot,
      configPath: path.join(dir, "missing.env"),
      fetchImpl: mockFetch,
      stdout: () => {},
    });
    expect(existsSync(path.join(storeRoot, sha))).toBe(false);
    expect(remoteBlobs.has(sha)).toBe(false);
  });

  test("pr-media rejects git-tracked files by default and posts Before/After markdown to PR", async () => {
    const dir = makeTmpDir();
    const storeRoot = path.join(dir, "store");
    const beforeFile = path.join(dir, "before.png");
    const afterFile = path.join(dir, "after.png");
    writeFileSync(beforeFile, PNG_BYTES);
    writeFileSync(afterFile, Buffer.concat([PNG_BYTES, Buffer.from([1])]));

    const env = {
      FACTORY_ARTIFACT_URL: "https://artifacts.watt-mind.com",
      FACTORY_ARTIFACT_TOKEN: "tok",
    };

    // Simulate git-tracked file -> must reject
    await expect(
      runArtifactCli(["pr-media", beforeFile], {
        env,
        storeRoot,
        configPath: path.join(dir, "missing.env"),
        runCmd: () => ({ status: 0, stdout: "", stderr: "" }),
      }),
    ).rejects.toThrow("refusing git-tracked file");

    // Now simulate untracked files + gh pr comment + labels
    const ghCalls = [];
    const mockRunCmd = (cmd, args) => {
      if (cmd === "git") return { status: 1, stdout: "", stderr: "" };
      ghCalls.push([cmd, ...args]);
      return { status: 0, stdout: "", stderr: "" };
    };
    const mockFetch = async (url) => {
      const sha = new URL(url).pathname.split("/").pop();
      return new Response(
        JSON.stringify({
          ok: true,
          deduplicated: false,
          sha256: sha,
          url: `https://artifacts.watt-mind.com/a/${sha}.png`,
        }),
        { status: 201 },
      );
    };

    const out = [];
    const code = await runArtifactCli(
      [
        "pr-media",
        "--before",
        beforeFile,
        "--after",
        afterFile,
        "--pr",
        "3887",
        "--repo",
        "watt-mind/legalease",
        "--comment",
      ],
      {
        env,
        storeRoot,
        configPath: path.join(dir, "missing.env"),
        fetchImpl: mockFetch,
        runCmd: mockRunCmd,
        stdout: (s) => out.push(s),
      },
    );
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("| Before | After |");
    expect(
      ghCalls.some((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "comment"),
    ).toBe(true);
    expect(ghCalls.some((c) => c.includes("has-screenshots"))).toBe(true);
    expect(ghCalls.some((c) => c.includes("type:ui-ux"))).toBe(true);
  });
});
