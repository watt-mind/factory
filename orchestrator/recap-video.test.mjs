import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CANVAS,
  computeSlideTimings,
  formatCliUsage,
  renderRecapVideo,
  renderSlideHtml,
  runCli,
  validateStoryboard,
  verifyRenderedHoldDurations,
} from "./recap-video.mjs";

test("validateStoryboard enforces 1..10 slides, bans bullet-list/table layouts, and caps subtitle length", () => {
  expect(() => validateStoryboard({ takeaway: "Empty", slides: [] })).toThrow();

  const elevenSlides = Array.from({ length: 11 }, (_, i) => ({
    layout: "flow",
    subtitle: `Slide ${i + 1} shows one step.`,
    nodes: [{ id: "a", label: "Step one", state: "done" }],
  }));
  expect(() =>
    validateStoryboard({ takeaway: "Too many", slides: elevenSlides }),
  ).toThrow(/10/);

  expect(() =>
    validateStoryboard({
      takeaway: "Bad layout",
      slides: [
        {
          layout: "table",
          subtitle: "Status table is forbidden.",
          nodes: [{ id: "a", label: "Row", state: "done" }],
        },
      ],
    }),
  ).toThrow(/layout/i);

  expect(() =>
    validateStoryboard({
      takeaway: "Wordy subtitle",
      slides: [
        {
          layout: "flow",
          subtitle:
            "This subtitle has way too many words so it would wrap across three cramped lines inside the bottom strip today.",
          nodes: [{ id: "a", label: "Service", state: "done" }],
        },
      ],
    }),
  ).toThrow(/subtitle/i);
});

test("computeSlideTimings implements exact word-delta hold formula (addedWords / 3) and ignores screenshot pixels", () => {
  const spec = validateStoryboard({
    takeaway: "Search index landed and halved query latency.",
    slides: [
      {
        layout: "flow",
        // 6 subtitle words + (2 + 3) = 5 node label words = 11 added words -> 11/3 = 3.67s
        subtitle: "Requests hit Postgres without an index",
        nodes: [
          { id: "api", label: "Search route", state: "running" },
          { id: "db", label: "Full table scan", state: "failed" },
        ],
        edges: [{ from: "api", to: "db" }],
      },
      {
        layout: "flow",
        // 6 subtitle words + ONLY changed node ("Indexed lookup" = 2 words; "Search route" unchanged!) = 8 added words -> 8/3 = 2.67s
        subtitle: "New composite index removes the scan",
        nodes: [
          { id: "api", label: "Search route", state: "done" },
          {
            id: "db",
            label: "Indexed lookup",
            state: "done",
            highlight: true,
          },
        ],
        edges: [{ from: "api", to: "db" }],
      },
      {
        layout: "screenshot",
        // 6 subtitle words + 2 callout words = 8 added words (imagePath pixels add 0 words!)
        subtitle: "Updated filter bar is live now",
        imagePath: "/tmp/nonexistent-test-shot.png",
        callouts: [{ label: "Instant filter", x: 50, y: 40 }],
      },
    ],
  });

  const timings = computeSlideTimings(spec.slides, { transitionSeconds: 0.35 });
  expect(timings[0].addedWords).toBe(11);
  expect(timings[0].requiredHoldSeconds).toBeCloseTo(11 / 3, 2);
  expect(timings[0].holdSeconds).toBeGreaterThanOrEqual(11 / 3);
  expect(
    timings[0].pureHoldEnd - timings[0].pureHoldStart,
  ).toBeGreaterThanOrEqual(11 / 3 - 1e-6);

  expect(timings[1].addedWords).toBe(8);
  expect(timings[1].requiredHoldSeconds).toBeCloseTo(8 / 3, 2);
  expect(
    timings[1].pureHoldEnd - timings[1].pureHoldStart,
  ).toBeGreaterThanOrEqual(8 / 3 - 1e-6);

  expect(timings[2].addedWords).toBe(8);
});

test("renderSlideHtml separates 1280x624 visual stage from dedicated 1280x96 bottom subtitle strip", () => {
  expect(CANVAS).toEqual({
    width: 1280,
    height: 720,
    stageHeight: 624,
    subtitleStripHeight: 96,
  });

  const spec = validateStoryboard({
    takeaway: "UI change without screenshot marks it explicitly.",
    slides: [
      {
        layout: "screenshot",
        subtitle: "Mobile header spacing was tightened",
        noScreenshotNote: "No screenshot yet — tightened mobile header padding",
      },
    ],
  });

  const html = renderSlideHtml(spec.slides[0], 0, 1);
  expect(html).toContain("width: 1280px");
  expect(html).toContain("height: 624px");
  expect(html).toContain("height: 96px");
  expect(html).toContain("Mobile header spacing was tightened");
  expect(html).toContain("No screenshot yet");
});

test("verifyRenderedHoldDurations catches transitions eating into hold time via pixel comparison", () => {
  const spec = validateStoryboard({
    takeaway: "Two-slide pixel hold verification.",
    slides: [
      {
        layout: "flow",
        subtitle: "First slide holds long enough",
        nodes: [{ id: "n1", label: "Alpha node", state: "done" }],
      },
      {
        layout: "flow",
        subtitle: "Second slide changes label cleanly",
        nodes: [{ id: "n1", label: "Beta node", state: "done" }],
      },
    ],
  });
  const timings = computeSlideTimings(spec.slides, { transitionSeconds: 0.35 });
  const frameA = new Uint8Array([10, 20, 30, 10, 20, 30]);
  const frameB = new Uint8Array([200, 210, 220, 200, 210, 220]);

  const good = verifyRenderedHoldDurations({
    slides: spec.slides,
    timings,
    targetFramesRgb: [frameA, frameB],
    sampleFrameRgb: (ts) => (ts < timings[1].pureHoldStart ? frameA : frameB),
  });
  expect(good.ok).toBe(true);

  expect(() =>
    verifyRenderedHoldDurations({
      slides: spec.slides,
      timings,
      targetFramesRgb: [frameA, frameB],
      // Simulate premature transition bleeding Frame B into Slide 0's pure hold end:
      sampleFrameRgb: () => frameB,
    }),
  ).toThrow(/hold|pixel|mismatch/i);
});

test("renderRecapVideo orchestrates slide PNG generation, ffmpeg assembly, and post-render hold check", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "recap-video-"));
  const outPath = path.join(dir, "recap.mp4");
  const fakeRgb0 = new Uint8Array(1280 * 720 * 3).fill(24);
  const fakeRgb1 = new Uint8Array(1280 * 720 * 3).fill(180);

  try {
    const result = await renderRecapVideo(
      {
        takeaway: "Two PRs shipped and one auth PR needs your merge call.",
        slides: [
          {
            layout: "stack",
            subtitle: "Two harness PRs landed green on develop",
            nodes: [
              { id: "p1", label: "Garden command", state: "done" },
              { id: "p2", label: "Deploy verifier", state: "done" },
            ],
            edges: [{ from: "p1", to: "p2" }],
          },
          {
            layout: "options",
            subtitle: "Auth cookie PR waits on your merge call",
            options: [
              {
                title: "Merge PR #12",
                gain: "Blocks CSRF on login",
                cost: "Re-login once",
                recommended: true,
              },
              {
                title: "Hold for staging",
                gain: "Extra soak day",
                cost: "Leaves cookie lax",
              },
            ],
          },
        ],
      },
      {
        outPath,
        workDir: dir,
        renderHtmlToPng: async (_html, pngPath) => {
          writeFileSync(pngPath, "fake-png");
        },
        encodeVideo: async ({ outFile }) => {
          writeFileSync(outFile, "fake-mp4");
        },
        probeVideo: async () => ({
          width: 1280,
          height: 720,
          pixFmt: "yuv420p",
          durationSeconds: 12.5,
        }),
        loadTargetRgb: async (index) => (index === 0 ? fakeRgb0 : fakeRgb1),
        extractFrameRgb: async (_mp4, ts, timings) =>
          ts < timings[1].pureHoldStart ? fakeRgb0 : fakeRgb1,
      },
    );

    expect(result.outPath).toBe(outPath);
    expect(result.slideCount).toBe(2);
    expect(result.verified).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validateStoryboard rejects explicit holdSeconds below addedWords / 3 and forbidden list layouts", () => {
  expect(() =>
    validateStoryboard({
      takeaway: "Explicit hold too short.",
      slides: [
        {
          layout: "flow",
          subtitle: "Six words inside this subtitle line",
          nodes: [{ id: "a", label: "Three label words", state: "done" }],
          holdSeconds: 2.0, // 9 added words => requires 3.0s
        },
      ],
    }),
  ).toThrow(/addedWords \/ 3/);

  for (const badLayout of ["bullets", "list", "status-list"]) {
    expect(() =>
      validateStoryboard({
        takeaway: "Forbidden layout check.",
        slides: [{ layout: badLayout, subtitle: "One short subtitle" }],
      }),
    ).toThrow(/layout/i);
  }
});

test("computeSlideTimings pads middle and final slides so xfade never eats pureHoldSeconds", () => {
  const spec = validateStoryboard({
    takeaway: "Four-slide timeline invariant check.",
    slides: [
      {
        layout: "flow",
        subtitle: "Step one starts the pipeline",
        nodes: [{ id: "a", label: "Ingest", state: "done" }],
      },
      {
        layout: "before-after",
        subtitle: "Latency dropped from seconds to milliseconds",
        before: { title: "Unindexed scan", detail: "1.8s p95" },
        after: { title: "Composite index", detail: "42ms p95" },
      },
      {
        layout: "stack",
        subtitle: "Worker layer verified on staging",
        nodes: [
          { id: "s1", label: "API router", state: "done" },
          {
            id: "s2",
            label: "Queue worker",
            state: "running",
            badge: "canary",
          },
        ],
      },
      {
        layout: "options",
        subtitle: "Choose rollout pace for production",
        options: [
          {
            title: "Ship today",
            gain: "Immediate speedup",
            cost: "Watch logs",
            recommended: true,
          },
          {
            title: "Wait til Monday",
            gain: "Quiet weekend",
            cost: "Slow search stays",
          },
        ],
      },
    ],
  });

  const T = 0.4;
  const timings = computeSlideTimings(spec.slides, { transitionSeconds: T });
  expect(timings).toHaveLength(4);
  expect(timings[0].clipDurationSeconds).toBeCloseTo(
    timings[0].holdSeconds + T,
    5,
  );
  expect(timings[1].clipDurationSeconds).toBeCloseTo(
    T + timings[1].holdSeconds + T,
    5,
  );
  expect(timings[2].clipDurationSeconds).toBeCloseTo(
    T + timings[2].holdSeconds + T,
    5,
  );
  expect(timings[3].clipDurationSeconds).toBeCloseTo(
    T + timings[3].holdSeconds,
    5,
  );

  for (const t of timings) {
    expect(t.pureHoldEnd - t.pureHoldStart).toBeCloseTo(t.holdSeconds, 5);
    expect(t.pureHoldEnd - t.pureHoldStart).toBeGreaterThanOrEqual(
      t.requiredHoldSeconds - 1e-6,
    );
  }
});

test("renderSlideHtml escapes HTML entities and renderRecapVideo supports framesOnly + CLI --help", async () => {
  const spec = validateStoryboard({
    takeaway: "Safe HTML escaping & frames-only mode.",
    slides: [
      {
        layout: "before-after",
        subtitle: "Escapes <script> & \"quotes\" in 'subtitles'",
        before: { title: "Raw <tag> & Co", detail: "Unsafe 'input'" },
        after: { title: 'Escaped "output"', detail: "Clean & crisp" },
      },
    ],
  });

  const html = renderSlideHtml(spec.slides[0], 0, 1);
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("Raw &lt;tag&gt; &amp; Co");
  expect(html).toContain("1 / 1");

  expect(formatCliUsage()).toContain("factory recap-video");
  expect(await runCli(["--help"])).toBe(0);

  const dir = mkdtempSync(path.join(tmpdir(), "recap-frames-only-"));
  try {
    const res = await renderRecapVideo(spec, {
      framesOnly: true,
      framesDir: dir,
      renderHtmlToPng: async (_htmlPath, pngPath) => {
        writeFileSync(pngPath, "png-bytes");
      },
    });
    expect(res.verified).toBe(false);
    expect(res.slideCount).toBe(1);
    expect(res.framePaths).toHaveLength(1);
    expect(existsSync(res.framePaths[0])).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("end-to-end: headless Chrome + ffmpeg xfade renders a verified 1280x720 yuv420p MP4", async () => {
  const envWithPath = {
    ...process.env,
    PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}`,
  };
  const hasFfmpeg =
    spawnSync("ffmpeg", ["-version"], {
      stdio: "ignore",
      env: envWithPath,
    }).status === 0;
  const hasChrome =
    spawnSync(
      "bash",
      [
        path.resolve(import.meta.dir, "..", "bin", "chrome-headless.sh"),
        "--version",
      ],
      { stdio: "ignore", env: envWithPath },
    ).status === 0;
  if (!hasFfmpeg || !hasChrome) return;

  const dir = mkdtempSync(path.join(tmpdir(), "recap-e2e-"));
  const outPath = path.join(dir, "e2e-recap.mp4");
  try {
    const result = await renderRecapVideo(
      {
        takeaway: "Real Chrome + ffmpeg end-to-end verification.",
        slides: [
          {
            layout: "flow",
            subtitle: "Headless Chrome renders slide one",
            nodes: [
              { id: "a", label: "Storyboard JSON", state: "done" },
              {
                id: "b",
                label: "1280x720 PNG",
                state: "done",
                highlight: true,
              },
            ],
            edges: [{ from: "a", to: "b", label: "chrome" }],
          },
          {
            layout: "before-after",
            subtitle: "FFmpeg xfade pads transitions outside hold",
            before: {
              title: "Clipped transition",
              detail: "Ate hold time",
              state: "failed",
            },
            after: {
              title: "Padded clip window",
              detail: "Full hold intact",
              state: "done",
            },
          },
        ],
      },
      { outPath },
    );

    expect(result.verified).toBe(true);
    expect(result.slideCount).toBe(2);
    expect(existsSync(outPath)).toBe(true);
    expect(statSync(outPath).size).toBeGreaterThan(1000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);
