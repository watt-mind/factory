#!/usr/bin/env bun
/**
 * Silent architecture & status recap video generator (`factory recap-video`).
 *
 * Renders a validated storyboard spec (1..10 visual slides, no text-heavy
 * bullet/table slides) into crisp 1280x720 HTML -> PNG frames using headless
 * Chromium (`bin/chrome-headless.sh`), stitches them into a silent H.264
 * `yuv420p` MP4 with `ffmpeg` `xfade` transitions padded outside pure hold
 * windows, and verifies via pixel comparison that every slide remains visibly
 * static for at least `addedWords / 3` seconds.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { factoryRoot } from "../lib/factory-root.mjs";

export const CANVAS = Object.freeze({
  width: 1280,
  height: 720,
  stageHeight: 624,
  subtitleStripHeight: 96,
});

export const ALLOWED_LAYOUTS = Object.freeze([
  "flow",
  "stack",
  "before-after",
  "screenshot",
  "options",
]);

const ALLOWED_LAYOUT_SET = new Set(ALLOWED_LAYOUTS);

const ALLOWED_STATES = new Set([
  "done",
  "running",
  "failed",
  "blocked",
  "escalated",
  "not-checked",
  "neutral",
]);

const MAX_TAKEAWAY_WORDS = 35;
const MAX_SLIDES = 10;
const MAX_SUBTITLE_WORDS = 18;
const MAX_NODE_LABEL_WORDS = 10;
const MAX_FLOW_STACK_NODES = 6;
const MAX_SCREENSHOT_CALLOUTS = 4;

const STATE_PALETTE = Object.freeze({
  done: {
    accent: "#10b981",
    bg: "rgba(16, 185, 129, 0.14)",
    border: "#10b981",
    pillText: "#6ee7b7",
    tag: "DONE",
    glyph: "✓",
  },
  running: {
    accent: "#f59e0b",
    bg: "rgba(245, 158, 11, 0.14)",
    border: "#f59e0b",
    pillText: "#fcd34d",
    tag: "RUNNING",
    glyph: "●",
  },
  failed: {
    accent: "#ef4444",
    bg: "rgba(239, 68, 68, 0.16)",
    border: "#ef4444",
    pillText: "#fca5a5",
    tag: "FAILED",
    glyph: "✕",
  },
  blocked: {
    accent: "#ef4444",
    bg: "rgba(239, 68, 68, 0.16)",
    border: "#ef4444",
    pillText: "#fca5a5",
    tag: "BLOCKED",
    glyph: "!",
  },
  escalated: {
    accent: "#a855f7",
    bg: "rgba(168, 85, 247, 0.16)",
    border: "#a855f7",
    pillText: "#d8b4fe",
    tag: "ESCALATED",
    glyph: "▲",
  },
  "not-checked": {
    accent: "#94a3b8",
    bg: "rgba(148, 163, 184, 0.12)",
    border: "#64748b",
    pillText: "#cbd5e1",
    tag: "NOT CHECKED",
    glyph: "◌",
  },
  neutral: {
    accent: "#64748b",
    bg: "rgba(30, 41, 59, 0.86)",
    border: "#334155",
    pillText: "#cbd5e1",
    tag: "STEP",
    glyph: "•",
  },
});

/**
 * Count whitespace-delimited words in a label or subtitle.
 */
export function countWords(text) {
  if (typeof text !== "string") return 0;
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).filter(Boolean).length;
}

function normalizeLabelKey(text) {
  return String(text ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function roundTime(seconds) {
  return Math.round(seconds * 1_000_000) / 1_000_000;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function validateOptionalState(state, context) {
  if (state === undefined || state === null || state === "") return "neutral";
  if (typeof state !== "string" || !ALLOWED_STATES.has(state)) {
    throw new Error(
      `${context}: invalid state "${String(state)}" (expected one of ${Array.from(ALLOWED_STATES).join(", ")})`,
    );
  }
  return state;
}

/**
 * Extract visible stage text labels for a slide. Screenshot image pixels add 0
 * words; only explicit text labels/callouts/notes on the stage are counted.
 */
export function extractVisibleLabels(slide) {
  if (!slide || typeof slide !== "object") return [];
  switch (slide.layout) {
    case "flow":
    case "stack": {
      const labels = [];
      for (const node of slide.nodes ?? []) {
        if (typeof node?.label === "string" && node.label.trim()) {
          labels.push(node.label.trim());
        }
        if (typeof node?.badge === "string" && node.badge.trim()) {
          labels.push(node.badge.trim());
        }
      }
      for (const edge of slide.edges ?? []) {
        if (typeof edge?.label === "string" && edge.label.trim()) {
          labels.push(edge.label.trim());
        }
      }
      return labels;
    }
    case "before-after": {
      if (!slide.before && !slide.after && Array.isArray(slide.nodes)) {
        return slide.nodes
          .flatMap((n) => [n?.label, n?.badge])
          .filter((item) => typeof item === "string" && item.trim().length > 0)
          .map((item) => item.trim());
      }
      return [
        slide.before?.title,
        slide.before?.detail,
        slide.after?.title,
        slide.after?.detail,
      ]
        .filter((item) => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim());
    }
    case "screenshot": {
      const labels = [];
      if (
        typeof slide.noScreenshotNote === "string" &&
        slide.noScreenshotNote.trim()
      ) {
        labels.push(slide.noScreenshotNote.trim());
      }
      for (const callout of slide.callouts ?? []) {
        if (typeof callout?.label === "string" && callout.label.trim()) {
          labels.push(callout.label.trim());
        }
      }
      return labels;
    }
    case "options": {
      const labels = [];
      for (const opt of slide.options ?? []) {
        for (const field of [opt?.title, opt?.gain, opt?.cost]) {
          if (typeof field === "string" && field.trim()) {
            labels.push(field.trim());
          }
        }
      }
      return labels;
    }
    default:
      return [];
  }
}

function computeAddedWordsForSlide(slide, prevVisibleLabels) {
  const visibleLabels = slide.visibleLabels ?? extractVisibleLabels(slide);
  const subtitleWords = countWords(slide.subtitle);
  if (!prevVisibleLabels) {
    const labelWords = visibleLabels.reduce(
      (sum, label) => sum + countWords(label),
      0,
    );
    return { visibleLabels, addedWords: subtitleWords + labelWords };
  }
  const prevSet = new Set(prevVisibleLabels.map(normalizeLabelKey));
  let changedLabelWords = 0;
  for (const label of visibleLabels) {
    if (!prevSet.has(normalizeLabelKey(label))) {
      changedLabelWords += countWords(label);
    }
  }
  return { visibleLabels, addedWords: subtitleWords + changedLabelWords };
}

/**
 * Validate a recap storyboard specification and normalize slide fields.
 */
export function validateStoryboard(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new Error("Storyboard spec must be a JSON object.");
  }

  const takeawayWords = countWords(spec.takeaway);
  if (typeof spec.takeaway !== "string" || takeawayWords < 1) {
    throw new Error("Storyboard takeaway must be a non-empty string.");
  }
  if (takeawayWords > MAX_TAKEAWAY_WORDS) {
    throw new Error(
      `Storyboard takeaway exceeds ${MAX_TAKEAWAY_WORDS} words (${takeawayWords} words).`,
    );
  }

  if (!Array.isArray(spec.slides)) {
    throw new Error("Storyboard slides must be an array of 1..10 slides.");
  }
  if (spec.slides.length < 1 || spec.slides.length > MAX_SLIDES) {
    throw new Error(
      `Storyboard slides must contain 1..${MAX_SLIDES} slides (got ${spec.slides.length}; max ${MAX_SLIDES} slides).`,
    );
  }

  const normalizedSlides = [];
  let prevVisibleLabels = null;

  for (let i = 0; i < spec.slides.length; i += 1) {
    const raw = spec.slides[i];
    const prefix = `Slide ${i + 1}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`${prefix} must be an object.`);
    }

    if (typeof raw.layout !== "string" || !ALLOWED_LAYOUT_SET.has(raw.layout)) {
      throw new Error(
        `${prefix} has unsupported layout "${String(raw.layout)}". Allowed layouts: ${ALLOWED_LAYOUTS.join(", ")} (text-heavy table/bullet/list layouts are forbidden).`,
      );
    }

    const subtitleWords = countWords(raw.subtitle);
    if (typeof raw.subtitle !== "string" || subtitleWords < 1) {
      throw new Error(`${prefix} subtitle must be a non-empty string.`);
    }
    if (subtitleWords > MAX_SUBTITLE_WORDS) {
      throw new Error(
        `${prefix} subtitle has ${subtitleWords} words; max ${MAX_SUBTITLE_WORDS} words so the 96px subtitle strip never overflows.`,
      );
    }

    const normalized = {
      layout: raw.layout,
      subtitle: raw.subtitle.trim(),
    };

    if (raw.title !== undefined) {
      if (typeof raw.title !== "string" || countWords(raw.title) > 10) {
        throw new Error(`${prefix} title must be a string of <= 10 words.`);
      }
      normalized.title = raw.title.trim();
    }

    if (raw.layout === "flow" || raw.layout === "stack") {
      if (
        !Array.isArray(raw.nodes) ||
        raw.nodes.length < 1 ||
        raw.nodes.length > MAX_FLOW_STACK_NODES
      ) {
        throw new Error(
          `${prefix} (${raw.layout}) requires 1..${MAX_FLOW_STACK_NODES} nodes.`,
        );
      }
      const seenIds = new Set();
      normalized.nodes = raw.nodes.map((node, nIdx) => {
        if (!node || typeof node !== "object") {
          throw new Error(`${prefix} node ${nIdx + 1} must be an object.`);
        }
        if (typeof node.id !== "string" || !node.id.trim()) {
          throw new Error(`${prefix} node ${nIdx + 1} requires a string id.`);
        }
        const id = node.id.trim();
        if (seenIds.has(id)) {
          throw new Error(`${prefix} has duplicate node id "${id}".`);
        }
        seenIds.add(id);

        const labelWords = countWords(node.label);
        if (typeof node.label !== "string" || labelWords < 1) {
          throw new Error(`${prefix} node "${id}" requires a non-empty label.`);
        }
        if (labelWords > MAX_NODE_LABEL_WORDS) {
          throw new Error(
            `${prefix} node "${id}" label has ${labelWords} words (max ${MAX_NODE_LABEL_WORDS} words).`,
          );
        }

        const cleanNode = {
          id,
          label: node.label.trim(),
          state: validateOptionalState(node.state, `${prefix} node "${id}"`),
          highlight: Boolean(node.highlight),
        };
        if (typeof node.badge === "string" && node.badge.trim()) {
          cleanNode.badge = node.badge.trim();
        }
        return cleanNode;
      });

      normalized.edges = [];
      if (raw.edges !== undefined) {
        if (!Array.isArray(raw.edges)) {
          throw new Error(`${prefix} edges must be an array when provided.`);
        }
        normalized.edges = raw.edges.map((edge, eIdx) => {
          if (
            !edge ||
            typeof edge !== "object" ||
            typeof edge.from !== "string" ||
            !edge.from.trim() ||
            typeof edge.to !== "string" ||
            !edge.to.trim()
          ) {
            throw new Error(
              `${prefix} edge ${eIdx + 1} requires string "from" and "to" node ids.`,
            );
          }
          const cleanEdge = {
            from: edge.from.trim(),
            to: edge.to.trim(),
          };
          if (typeof edge.label === "string" && edge.label.trim()) {
            cleanEdge.label = edge.label.trim();
          }
          return cleanEdge;
        });
      }
    } else if (raw.layout === "before-after") {
      const beforeInput =
        raw.before ??
        (Array.isArray(raw.nodes) && raw.nodes[0]
          ? {
              title: raw.nodes[0].label,
              detail: raw.nodes[0].badge,
              state: raw.nodes[0].state,
            }
          : null);
      const afterInput =
        raw.after ??
        (Array.isArray(raw.nodes) && raw.nodes[1]
          ? {
              title: raw.nodes[1].label,
              detail: raw.nodes[1].badge,
              state: raw.nodes[1].state,
              highlight: raw.nodes[1].highlight,
            }
          : null);

      for (const [side, panel] of [
        ["before", beforeInput],
        ["after", afterInput],
      ]) {
        if (
          !panel ||
          typeof panel !== "object" ||
          typeof panel.title !== "string" ||
          countWords(panel.title) < 1
        ) {
          throw new Error(
            `${prefix} (before-after) requires "${side}.title" to be a non-empty string.`,
          );
        }
      }
      normalized.before = {
        title: beforeInput.title.trim(),
        state: validateOptionalState(beforeInput.state, `${prefix} before`),
      };
      if (typeof beforeInput.detail === "string" && beforeInput.detail.trim()) {
        normalized.before.detail = beforeInput.detail.trim();
      }
      if (
        typeof beforeInput.imagePath === "string" &&
        beforeInput.imagePath.trim()
      ) {
        normalized.before.imagePath = beforeInput.imagePath.trim();
      }

      normalized.after = {
        title: afterInput.title.trim(),
        state: validateOptionalState(
          afterInput.state ?? "done",
          `${prefix} after`,
        ),
        highlight:
          afterInput.highlight === undefined
            ? true
            : Boolean(afterInput.highlight),
      };
      if (typeof afterInput.detail === "string" && afterInput.detail.trim()) {
        normalized.after.detail = afterInput.detail.trim();
      }
      if (
        typeof afterInput.imagePath === "string" &&
        afterInput.imagePath.trim()
      ) {
        normalized.after.imagePath = afterInput.imagePath.trim();
      }
    } else if (raw.layout === "screenshot") {
      const hasImage =
        typeof raw.imagePath === "string" && raw.imagePath.trim().length > 0;
      const hasNote =
        typeof raw.noScreenshotNote === "string" &&
        raw.noScreenshotNote.trim().length > 0;
      if (!hasImage && !hasNote) {
        throw new Error(
          `${prefix} (screenshot) requires either "imagePath" or "noScreenshotNote".`,
        );
      }
      if (hasImage) normalized.imagePath = raw.imagePath.trim();
      if (hasNote) normalized.noScreenshotNote = raw.noScreenshotNote.trim();

      normalized.callouts = [];
      if (raw.callouts !== undefined) {
        if (
          !Array.isArray(raw.callouts) ||
          raw.callouts.length > MAX_SCREENSHOT_CALLOUTS
        ) {
          throw new Error(
            `${prefix} (screenshot) supports 0..${MAX_SCREENSHOT_CALLOUTS} callouts.`,
          );
        }
        normalized.callouts = raw.callouts.map((callout, cIdx) => {
          if (
            !callout ||
            typeof callout !== "object" ||
            typeof callout.label !== "string" ||
            countWords(callout.label) < 1 ||
            typeof callout.x !== "number" ||
            !Number.isFinite(callout.x) ||
            typeof callout.y !== "number" ||
            !Number.isFinite(callout.y)
          ) {
            throw new Error(
              `${prefix} callout ${cIdx + 1} requires { label, x, y }.`,
            );
          }
          return {
            label: callout.label.trim(),
            x: callout.x,
            y: callout.y,
          };
        });
      }
    } else if (raw.layout === "options") {
      if (
        !Array.isArray(raw.options) ||
        raw.options.length < 2 ||
        raw.options.length > 3
      ) {
        throw new Error(`${prefix} (options) requires 2..3 option cards.`);
      }
      normalized.options = raw.options.map((opt, oIdx) => {
        if (
          !opt ||
          typeof opt !== "object" ||
          typeof opt.title !== "string" ||
          !opt.title.trim() ||
          typeof opt.gain !== "string" ||
          !opt.gain.trim() ||
          typeof opt.cost !== "string" ||
          !opt.cost.trim()
        ) {
          throw new Error(
            `${prefix} option ${oIdx + 1} requires non-empty title, gain, and cost.`,
          );
        }
        const card = {
          title: opt.title.trim(),
          gain: opt.gain.trim(),
          cost: opt.cost.trim(),
          recommended: Boolean(opt.recommended),
        };
        if (typeof opt.state === "string" && opt.state.trim()) {
          card.state = opt.state.trim();
        }
        return card;
      });
    }

    const { visibleLabels, addedWords } = computeAddedWordsForSlide(
      normalized,
      prevVisibleLabels,
    );
    normalized.visibleLabels = visibleLabels;
    prevVisibleLabels = visibleLabels;

    if (raw.holdSeconds !== undefined) {
      if (
        typeof raw.holdSeconds !== "number" ||
        !Number.isFinite(raw.holdSeconds) ||
        raw.holdSeconds <= 0
      ) {
        throw new Error(`${prefix} holdSeconds must be a positive number.`);
      }
      const minRequired = addedWords / 3;
      if (raw.holdSeconds < minRequired - 1e-9) {
        throw new Error(
          `${prefix} holdSeconds (${raw.holdSeconds}s) is below addedWords / 3 (${minRequired.toFixed(2)}s for ${addedWords} added words).`,
        );
      }
      normalized.holdSeconds = raw.holdSeconds;
    }

    normalizedSlides.push(normalized);
  }

  return {
    takeaway: spec.takeaway.trim(),
    slides: normalizedSlides,
  };
}

/**
 * Compute per-slide hold durations and transition-padded clip/timeline bounds
 * so `xfade` crossfades never eat into any slide's pure hold window.
 */
export function computeSlideTimings(
  slides,
  { minHoldSeconds = 2.0, transitionSeconds = 0.35 } = {},
) {
  if (!Array.isArray(slides) || slides.length < 1) {
    throw new Error("computeSlideTimings requires at least 1 slide.");
  }
  const T = slides.length > 1 ? Math.max(0, transitionSeconds) : 0;
  const total = slides.length;
  const timings = [];
  let prevVisibleLabels = null;

  for (let index = 0; index < total; index += 1) {
    const slide = slides[index];
    const { visibleLabels, addedWords } = computeAddedWordsForSlide(
      slide,
      prevVisibleLabels,
    );
    prevVisibleLabels = visibleLabels;

    const requiredHoldSeconds = addedWords / 3;
    const roundedRequired = Math.ceil(requiredHoldSeconds * 100) / 100;
    const holdSeconds = roundTime(
      Math.max(
        minHoldSeconds,
        requiredHoldSeconds,
        roundedRequired,
        slide.holdSeconds ?? 0,
      ),
    );

    let clipDurationSeconds;
    let xfadeOffsetSeconds = null;
    let pureHoldStart;
    let pureHoldEnd;

    if (total === 1) {
      clipDurationSeconds = holdSeconds;
      pureHoldStart = 0;
      pureHoldEnd = holdSeconds;
    } else if (index === 0) {
      clipDurationSeconds = roundTime(holdSeconds + T);
      pureHoldStart = 0;
      pureHoldEnd = holdSeconds;
    } else if (index < total - 1) {
      xfadeOffsetSeconds = timings[index - 1].pureHoldEnd;
      clipDurationSeconds = roundTime(T + holdSeconds + T);
      pureHoldStart = roundTime(xfadeOffsetSeconds + T);
      pureHoldEnd = roundTime(pureHoldStart + holdSeconds);
    } else {
      xfadeOffsetSeconds = timings[index - 1].pureHoldEnd;
      clipDurationSeconds = roundTime(T + holdSeconds);
      pureHoldStart = roundTime(xfadeOffsetSeconds + T);
      pureHoldEnd = roundTime(pureHoldStart + holdSeconds);
    }

    timings.push({
      slideIndex: index,
      visibleLabels,
      addedWords,
      requiredHoldSeconds,
      holdSeconds,
      transitionSeconds: T,
      clipDurationSeconds,
      xfadeOffsetSeconds,
      pureHoldStart,
      pureHoldEnd,
    });
  }

  return timings;
}

function sniffImageMime(buf) {
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    buf.length >= 3 &&
    buf[0] === 0xff &&
    buf[1] === 0xd8 &&
    buf[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (buf.length >= 6 && buf.subarray(0, 3).toString("ascii") === "GIF") {
    return "image/gif";
  }
  return "image/png";
}

function resolveImageUrl(imagePath) {
  if (!imagePath) return "";
  if (/^(data:|file:|https?:)/i.test(imagePath)) return imagePath;
  const expanded = imagePath.startsWith("~/")
    ? path.join(homedir(), imagePath.slice(2))
    : imagePath;
  const absPath = path.resolve(expanded);
  if (
    !/\.(png|jpe?g|webp|gif|svg)$/i.test(absPath) &&
    existsSync(absPath) &&
    statSync(absPath).isFile()
  ) {
    const bytes = readFileSync(absPath);
    return `data:${sniffImageMime(bytes)};base64,${bytes.toString("base64")}`;
  }
  return pathToFileURL(absPath).href;
}

function stateStyle(state) {
  return STATE_PALETTE[state] ?? STATE_PALETTE.neutral;
}

function layoutBadgeText(layout) {
  switch (layout) {
    case "flow":
      return "ARCHITECTURE FLOW";
    case "stack":
      return "SYSTEM STACK";
    case "before-after":
      return "BEFORE → AFTER";
    case "screenshot":
      return "UI SNAPSHOT";
    case "options":
      return "DECISION OPTIONS";
    default:
      return "RECAP";
  }
}

function renderFlowStage(slide) {
  const nodes = slide.nodes ?? [];
  const count = nodes.length;
  const coords = new Map();
  const positioned = [];

  if (count <= 4) {
    const cardWidth =
      count === 1 ? 380 : count === 2 ? 360 : count === 3 ? 300 : 244;
    const cardHeight = 168;
    const totalCardsWidth = count * cardWidth;
    const sideMargin = 88;
    const usable = CANVAS.width - sideMargin * 2;
    const gap =
      count > 1
        ? Math.max(28, Math.floor((usable - totalCardsWidth) / (count - 1)))
        : 0;
    const rowWidth = totalCardsWidth + gap * (count - 1);
    const startX = Math.round((CANVAS.width - rowWidth) / 2);
    const centerY = 332;

    nodes.forEach((node, idx) => {
      const x = startX + idx * (cardWidth + gap);
      const y = Math.round(centerY - cardHeight / 2);
      const item = {
        node,
        x,
        y,
        w: cardWidth,
        h: cardHeight,
        cx: x + cardWidth / 2,
        cy: centerY,
      };
      coords.set(node.id, item);
      positioned.push(item);
    });
  } else {
    const topCount = Math.ceil(count / 2);
    const bottomCount = count - topCount;
    const cardWidth = 310;
    const cardHeight = 148;
    const gapX = 56;
    const rows = [
      { items: nodes.slice(0, topCount), cy: 224 },
      { items: nodes.slice(topCount), cy: 444 },
    ];
    for (const row of rows) {
      const rCount = row.items.length || bottomCount;
      const rowWidth = rCount * cardWidth + (rCount - 1) * gapX;
      const startX = Math.round((CANVAS.width - rowWidth) / 2);
      row.items.forEach((node, idx) => {
        const x = startX + idx * (cardWidth + gapX);
        const y = Math.round(row.cy - cardHeight / 2);
        const item = {
          node,
          x,
          y,
          w: cardWidth,
          h: cardHeight,
          cx: x + cardWidth / 2,
          cy: row.cy,
        };
        coords.set(node.id, item);
        positioned.push(item);
      });
    }
  }

  const edges =
    slide.edges && slide.edges.length > 0
      ? slide.edges
      : nodes.slice(0, -1).map((n, i) => ({ from: n.id, to: nodes[i + 1].id }));

  const svgLines = [];
  const edgeBadges = [];

  for (const edge of edges) {
    const src = coords.get(edge.from);
    const dst = coords.get(edge.to);
    if (!src || !dst || src === dst) continue;

    let x1 = src.cx;
    let y1 = src.cy;
    let x2 = dst.cx;
    let y2 = dst.cy;
    const sameRow = Math.abs(src.cy - dst.cy) < 20;

    if (sameRow && src.cx < dst.cx) {
      x1 = src.x + src.w + 6;
      x2 = dst.x - 10;
    } else if (sameRow && src.cx > dst.cx) {
      x1 = src.x - 6;
      x2 = dst.x + dst.w + 10;
    } else if (src.cy < dst.cy) {
      y1 = src.y + src.h + 6;
      y2 = dst.y - 10;
    } else {
      y1 = src.y - 6;
      y2 = dst.y + dst.h + 10;
    }

    const midX = Math.round((x1 + x2) / 2);
    const midY = Math.round((y1 + y2) / 2);
    const adjacentSameRow =
      sameRow && Math.abs(dst.x - (src.x + src.w)) < 180 && src.cx < dst.cx;

    if (adjacentSameRow || !sameRow) {
      svgLines.push(
        `<path d="M ${x1} ${y1} L ${x2} ${y2}" stroke="#64748b" stroke-width="3.5" fill="none" marker-end="url(#arrowhead)" />`,
      );
    } else {
      const curveY = Math.max(92, src.y - 54);
      svgLines.push(
        `<path d="M ${src.cx} ${src.y - 4} Q ${midX} ${curveY} ${dst.cx} ${dst.y - 8}" stroke="#64748b" stroke-width="3.5" fill="none" marker-end="url(#arrowhead)" />`,
      );
    }

    if (edge.label) {
      edgeBadges.push(
        `<div class="edge-label" style="left:${midX}px;top:${midY - 22}px;">${escapeHtml(edge.label)}</div>`,
      );
    }
  }

  const cardsHtml = positioned
    .map(({ node, x, y, w, h }) => {
      const palette = stateStyle(node.state);
      const borderColor = node.highlight ? "#38bdf8" : palette.border;
      const glow = node.highlight
        ? "0 0 0 3px rgba(56, 189, 248, 0.30), 0 18px 38px rgba(8, 145, 178, 0.28)"
        : "0 14px 30px rgba(2, 6, 23, 0.55)";
      const badgeHtml = node.badge
        ? `<span class="node-extra-badge">${escapeHtml(node.badge)}</span>`
        : "";
      return `<div class="flow-card" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;border-color:${borderColor};box-shadow:${glow};">
        <div class="node-meta-row">
          <span class="state-pill" style="background:${palette.bg};color:${palette.pillText};border-color:${palette.accent};">
            <span class="state-glyph">${palette.glyph}</span> ${palette.tag}
          </span>
          ${badgeHtml}
        </div>
        <div class="node-label">${escapeHtml(node.label)}</div>
      </div>`;
    })
    .join("\n");

  return `<svg class="connector-layer" width="${CANVAS.width}" height="${CANVAS.stageHeight}" viewBox="0 0 ${CANVAS.width} ${CANVAS.stageHeight}">
    <defs>
      <marker id="arrowhead" markerWidth="10" markerHeight="8" refX="8" refY="4" orient="auto">
        <polygon points="0 0, 10 4, 0 8" fill="#94a3b8" />
      </marker>
    </defs>
    ${svgLines.join("\n")}
  </svg>
  ${cardsHtml}
  ${edgeBadges.join("\n")}`;
}

function renderStackStage(slide) {
  const nodes = slide.nodes ?? [];
  const count = nodes.length;
  const topStart = 96;
  const bottomEnd = 590;
  const available = bottomEnd - topStart;
  const gap =
    count > 1 ? Math.min(26, Math.max(12, Math.floor(110 / count))) : 0;
  const cardHeight = Math.min(
    116,
    Math.floor((available - gap * (count - 1)) / count),
  );
  const totalHeight = count * cardHeight + (count - 1) * gap;
  const startY = Math.round(topStart + (available - totalHeight) / 2);
  const cardWidth = 760;
  const cardX = Math.round((CANVAS.width - cardWidth) / 2);

  const coords = new Map();
  const cards = nodes.map((node, idx) => {
    const y = startY + idx * (cardHeight + gap);
    const palette = stateStyle(node.state);
    const borderColor = node.highlight ? "#38bdf8" : palette.border;
    const glow = node.highlight
      ? "0 0 0 3px rgba(56, 189, 248, 0.30), 0 16px 34px rgba(8, 145, 178, 0.25)"
      : "0 10px 24px rgba(2, 6, 23, 0.5)";
    coords.set(node.id, { x: cardX, y, w: cardWidth, h: cardHeight });
    const badgeHtml = node.badge
      ? `<span class="node-extra-badge">${escapeHtml(node.badge)}</span>`
      : "";
    return `<div class="stack-card" style="left:${cardX}px;top:${y}px;width:${cardWidth}px;height:${cardHeight}px;border-color:${borderColor};box-shadow:${glow};">
      <div class="stack-left">
        <span class="state-dot" style="background:${palette.accent};">${palette.glyph}</span>
        <span class="stack-label">${escapeHtml(node.label)}</span>
      </div>
      <div class="stack-right">
        ${badgeHtml}
        <span class="state-pill" style="background:${palette.bg};color:${palette.pillText};border-color:${palette.accent};">${palette.tag}</span>
      </div>
    </div>`;
  });

  const svgArrows = [];
  for (const edge of slide.edges ?? []) {
    const src = coords.get(edge.from);
    const dst = coords.get(edge.to);
    if (!src || !dst || src === dst) continue;
    const x = Math.round(CANVAS.width / 2);
    const y1 = src.y < dst.y ? src.y + src.h + 2 : src.y - 2;
    const y2 = src.y < dst.y ? dst.y - 6 : dst.y + dst.h + 6;
    svgArrows.push(
      `<path d="M ${x} ${y1} L ${x} ${y2}" stroke="#64748b" stroke-width="3.5" fill="none" marker-end="url(#stack-arrow)" />`,
    );
  }

  return `<svg class="connector-layer" width="${CANVAS.width}" height="${CANVAS.stageHeight}" viewBox="0 0 ${CANVAS.width} ${CANVAS.stageHeight}">
    <defs>
      <marker id="stack-arrow" markerWidth="9" markerHeight="7" refX="7" refY="3.5" orient="auto">
        <polygon points="0 0, 9 3.5, 0 7" fill="#94a3b8" />
      </marker>
    </defs>
    ${svgArrows.join("\n")}
  </svg>
  ${cards.join("\n")}`;
}

function renderBeforeAfterStage(slide) {
  const renderPanel = (panel, heading, isAfter) => {
    const palette = stateStyle(panel.state ?? (isAfter ? "done" : "neutral"));
    const borderColor = isAfter && panel.highlight ? "#38bdf8" : palette.border;
    const glow =
      isAfter && panel.highlight
        ? "0 0 0 3px rgba(56, 189, 248, 0.28), 0 18px 40px rgba(8, 145, 178, 0.24)"
        : "0 14px 30px rgba(2, 6, 23, 0.5)";
    const detailHtml = panel.detail
      ? `<div class="ba-detail">${escapeHtml(panel.detail)}</div>`
      : "";
    const imageHtml = panel.imagePath
      ? `<div class="ba-image-wrap"><img src="${escapeHtml(resolveImageUrl(panel.imagePath))}" alt="${escapeHtml(heading)}" /></div>`
      : "";
    return `<div class="ba-panel" style="border-color:${borderColor};box-shadow:${glow};">
      <div class="ba-header">
        <span class="ba-tag">${escapeHtml(heading)}</span>
        <span class="state-pill" style="background:${palette.bg};color:${palette.pillText};border-color:${palette.accent};">${palette.glyph} ${palette.tag}</span>
      </div>
      <div class="ba-title">${escapeHtml(panel.title)}</div>
      ${detailHtml}
      ${imageHtml}
    </div>`;
  };

  return `<div class="ba-grid">
    ${renderPanel(slide.before, "BEFORE", false)}
    <div class="ba-arrow-badge">→</div>
    ${renderPanel(slide.after, "AFTER", true)}
  </div>`;
}

function normalizePercentCoord(value, maxPixels) {
  if (value >= 0 && value <= 100) return value;
  return Math.max(4, Math.min(96, (value / maxPixels) * 100));
}

function renderScreenshotStage(slide) {
  const callouts = (slide.callouts ?? []).map((callout, idx) => {
    const pctX = normalizePercentCoord(callout.x, CANVAS.width);
    const pctY = normalizePercentCoord(callout.y, CANVAS.stageHeight);
    return `<div class="callout-pin" style="left:${pctX}%;top:${pctY}%;">
      <span class="callout-num">${idx + 1}</span>
      <span class="callout-text">${escapeHtml(callout.label)}</span>
    </div>`;
  });

  if (slide.imagePath) {
    const imgSrc = resolveImageUrl(slide.imagePath);
    const noteBanner = slide.noScreenshotNote
      ? `<div class="shot-note-banner">${escapeHtml(slide.noScreenshotNote)}</div>`
      : "";
    return `<div class="shot-frame">
      <img class="shot-img" src="${escapeHtml(imgSrc)}" alt="Slide screenshot" />
      ${noteBanner}
      ${callouts.join("\n")}
    </div>`;
  }

  return `<div class="shot-frame shot-missing-frame">
    <div class="shot-missing-card">
      <div class="shot-missing-badge">NO SCREENSHOT CAPTURED</div>
      <div class="shot-missing-text">${escapeHtml(slide.noScreenshotNote)}</div>
    </div>
    ${callouts.join("\n")}
  </div>`;
}

function renderOptionsStage(slide) {
  const cards = (slide.options ?? []).map((opt, idx) => {
    const borderColor = opt.recommended ? "#38bdf8" : "#334155";
    const glow = opt.recommended
      ? "0 0 0 3px rgba(56, 189, 248, 0.30), 0 20px 44px rgba(8, 145, 178, 0.25)"
      : "0 14px 30px rgba(2, 6, 23, 0.5)";
    const recPill = opt.recommended
      ? `<span class="opt-rec-pill">RECOMMENDED</span>`
      : `<span class="opt-idx-pill">OPTION ${idx + 1}</span>`;
    return `<div class="opt-card" style="border-color:${borderColor};box-shadow:${glow};">
      <div class="opt-top">${recPill}</div>
      <div class="opt-title">${escapeHtml(opt.title)}</div>
      <div class="opt-row opt-gain">
        <span class="opt-row-tag">GAIN</span>
        <span class="opt-row-val">${escapeHtml(opt.gain)}</span>
      </div>
      <div class="opt-row opt-cost">
        <span class="opt-row-tag">TRADE-OFF</span>
        <span class="opt-row-val">${escapeHtml(opt.cost)}</span>
      </div>
    </div>`;
  });

  return `<div class="opt-grid">${cards.join("\n")}</div>`;
}

/**
 * Render a deterministic 1280x720 HTML document for one slide, strictly
 * separating the 1280x624 visual stage from the dedicated 1280x96 bottom
 * subtitle strip.
 */
export function renderSlideHtml(slide, index = 0, total = 1) {
  let stageBody;
  switch (slide.layout) {
    case "flow":
      stageBody = renderFlowStage(slide);
      break;
    case "stack":
      stageBody = renderStackStage(slide);
      break;
    case "before-after":
      stageBody = renderBeforeAfterStage(slide);
      break;
    case "screenshot":
      stageBody = renderScreenshotStage(slide);
      break;
    case "options":
      stageBody = renderOptionsStage(slide);
      break;
    default:
      throw new Error(`Unsupported slide layout "${String(slide?.layout)}".`);
  }

  const headerTitle = slide.title
    ? `<span class="stage-heading">${escapeHtml(slide.title)}</span>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
  html, body {
    width: 1280px;
    height: 720px;
    margin: 0;
    padding: 0;
    overflow: hidden;
    background: #0b1020;
    color: #f8fafc;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .stage {
    position: absolute;
    top: 0;
    left: 0;
    width: 1280px;
    height: 624px;
    overflow: hidden;
    background:
      radial-gradient(circle at 18% 16%, rgba(56, 189, 248, 0.11), transparent 46%),
      radial-gradient(circle at 82% 80%, rgba(16, 185, 129, 0.09), transparent 48%),
      #0b1020;
    box-sizing: border-box;
  }
  .stage-chrome {
    position: absolute;
    top: 22px;
    left: 36px;
    right: 36px;
    height: 40px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    z-index: 5;
  }
  .stage-chrome-left {
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .layout-eyebrow {
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.1em;
    color: #94a3b8;
    background: rgba(15, 23, 42, 0.85);
    border: 1px solid #1e293b;
    border-radius: 999px;
    padding: 6px 14px;
  }
  .stage-heading {
    font-size: 20px;
    font-weight: 700;
    color: #e2e8f0;
  }
  .progress-pill {
    font-size: 14px;
    font-weight: 700;
    color: #cbd5e1;
    background: rgba(15, 23, 42, 0.88);
    border: 1px solid #334155;
    border-radius: 999px;
    padding: 6px 14px;
    font-variant-numeric: tabular-nums;
  }
  .connector-layer {
    position: absolute;
    top: 0;
    left: 0;
    z-index: 1;
    pointer-events: none;
  }
  .flow-card {
    position: absolute;
    z-index: 2;
    background: rgba(15, 23, 42, 0.94);
    border: 2.5px solid #334155;
    border-radius: 18px;
    padding: 20px 22px;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
  }
  .node-meta-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .state-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.06em;
    padding: 4px 10px;
    border-radius: 999px;
    border: 1px solid #475569;
    white-space: nowrap;
  }
  .state-glyph {
    font-size: 13px;
    line-height: 1;
  }
  .node-extra-badge {
    font-size: 12px;
    font-weight: 700;
    color: #38bdf8;
    background: rgba(56, 189, 248, 0.14);
    border: 1px solid rgba(56, 189, 248, 0.4);
    border-radius: 999px;
    padding: 3px 9px;
    white-space: nowrap;
  }
  .node-label {
    font-size: 25px;
    font-weight: 700;
    color: #f8fafc;
    line-height: 1.24;
    letter-spacing: -0.01em;
  }
  .edge-label {
    position: absolute;
    transform: translate(-50%, -50%);
    z-index: 3;
    background: #0f172a;
    border: 1px solid #475569;
    color: #cbd5e1;
    font-size: 13px;
    font-weight: 600;
    padding: 3px 10px;
    border-radius: 999px;
    white-space: nowrap;
  }
  .stack-card {
    position: absolute;
    z-index: 2;
    background: rgba(15, 23, 42, 0.94);
    border: 2.5px solid #334155;
    border-radius: 16px;
    padding: 0 26px;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 18px;
  }
  .stack-left {
    display: flex;
    align-items: center;
    gap: 16px;
  }
  .state-dot {
    width: 30px;
    height: 30px;
    border-radius: 999px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #060913;
    font-weight: 800;
    font-size: 15px;
    flex-shrink: 0;
  }
  .stack-label {
    font-size: 25px;
    font-weight: 700;
    color: #f8fafc;
  }
  .stack-right {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .ba-grid {
    position: absolute;
    top: 86px;
    left: 56px;
    right: 56px;
    bottom: 36px;
    display: grid;
    grid-template-columns: 1fr 64px 1fr;
    align-items: stretch;
    gap: 16px;
  }
  .ba-panel {
    background: rgba(15, 23, 42, 0.94);
    border: 2.5px solid #334155;
    border-radius: 20px;
    padding: 28px;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  .ba-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .ba-tag {
    font-size: 14px;
    font-weight: 800;
    letter-spacing: 0.1em;
    color: #94a3b8;
  }
  .ba-title {
    font-size: 30px;
    font-weight: 700;
    color: #f8fafc;
    line-height: 1.24;
  }
  .ba-detail {
    font-size: 21px;
    font-weight: 500;
    color: #cbd5e1;
    line-height: 1.38;
  }
  .ba-image-wrap {
    flex: 1;
    min-height: 0;
    border-radius: 12px;
    overflow: hidden;
    background: #060913;
    border: 1px solid #1e293b;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .ba-image-wrap img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
  .ba-arrow-badge {
    align-self: center;
    justify-self: center;
    width: 52px;
    height: 52px;
    border-radius: 999px;
    background: rgba(56, 189, 248, 0.16);
    border: 2px solid #38bdf8;
    color: #38bdf8;
    font-size: 28px;
    font-weight: 800;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .shot-frame {
    position: absolute;
    top: 78px;
    left: 64px;
    right: 64px;
    bottom: 28px;
    background: #060913;
    border: 2px solid #334155;
    border-radius: 18px;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .shot-img {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  .shot-missing-frame {
    border: 2.5px dashed #38bdf8;
    background: rgba(15, 23, 42, 0.88);
  }
  .shot-missing-card {
    max-width: 780px;
    padding: 36px 44px;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
  }
  .shot-missing-badge {
    font-size: 13px;
    font-weight: 800;
    letter-spacing: 0.1em;
    color: #38bdf8;
    background: rgba(56, 189, 248, 0.14);
    border: 1px solid rgba(56, 189, 248, 0.45);
    border-radius: 999px;
    padding: 6px 16px;
  }
  .shot-missing-text {
    font-size: 28px;
    font-weight: 700;
    color: #f8fafc;
    line-height: 1.32;
  }
  .shot-note-banner {
    position: absolute;
    bottom: 16px;
    left: 24px;
    right: 24px;
    background: rgba(6, 9, 19, 0.88);
    border: 1px solid #38bdf8;
    border-radius: 12px;
    padding: 10px 18px;
    font-size: 18px;
    font-weight: 600;
    color: #e2e8f0;
    text-align: center;
  }
  .callout-pin {
    position: absolute;
    transform: translate(-50%, -50%);
    z-index: 4;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    background: rgba(6, 9, 19, 0.94);
    border: 2px solid #38bdf8;
    box-shadow: 0 8px 22px rgba(2, 6, 23, 0.75);
    border-radius: 999px;
    padding: 6px 14px 6px 8px;
    white-space: nowrap;
  }
  .callout-num {
    width: 24px;
    height: 24px;
    border-radius: 999px;
    background: #38bdf8;
    color: #060913;
    font-size: 14px;
    font-weight: 800;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .callout-text {
    font-size: 17px;
    font-weight: 700;
    color: #f8fafc;
  }
  .opt-grid {
    position: absolute;
    top: 86px;
    left: 56px;
    right: 56px;
    bottom: 34px;
    display: flex;
    align-items: stretch;
    gap: 26px;
  }
  .opt-card {
    flex: 1;
    background: rgba(15, 23, 42, 0.94);
    border: 2.5px solid #334155;
    border-radius: 20px;
    padding: 26px;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  .opt-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .opt-rec-pill {
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0.08em;
    color: #060913;
    background: #38bdf8;
    border-radius: 999px;
    padding: 5px 12px;
  }
  .opt-idx-pill {
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0.08em;
    color: #94a3b8;
    background: rgba(30, 41, 59, 0.9);
    border: 1px solid #475569;
    border-radius: 999px;
    padding: 5px 12px;
  }
  .opt-title {
    font-size: 28px;
    font-weight: 700;
    color: #f8fafc;
    line-height: 1.24;
  }
  .opt-row {
    border-radius: 14px;
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .opt-gain {
    background: rgba(16, 185, 129, 0.12);
    border: 1px solid rgba(16, 185, 129, 0.4);
  }
  .opt-cost {
    background: rgba(245, 158, 11, 0.11);
    border: 1px solid rgba(245, 158, 11, 0.36);
  }
  .opt-row-tag {
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.09em;
    color: #94a3b8;
  }
  .opt-row-val {
    font-size: 20px;
    font-weight: 600;
    color: #f8fafc;
    line-height: 1.3;
  }
  .subtitle-strip {
    position: absolute;
    top: 624px;
    left: 0;
    width: 1280px;
    height: 96px;
    background: #060913;
    border-top: 2px solid #1e293b;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 48px;
    box-sizing: border-box;
  }
  .subtitle-text {
    font-size: 28px;
    font-weight: 600;
    color: #f8fafc;
    text-align: center;
    line-height: 1.28;
    max-width: 1184px;
  }
</style>
</head>
<body>
  <div class="stage">
    <div class="stage-chrome">
      <div class="stage-chrome-left">
        <span class="layout-eyebrow">${escapeHtml(layoutBadgeText(slide.layout))}</span>
        ${headerTitle}
      </div>
      <span class="progress-pill">${index + 1} / ${total}</span>
    </div>
    ${stageBody}
  </div>
  <div class="subtitle-strip">
    <div class="subtitle-text">${escapeHtml(slide.subtitle)}</div>
  </div>
</body>
</html>`;
}

function computeHoldSamplePoints(timing) {
  const span = roundTime(timing.pureHoldEnd - timing.pureHoldStart);
  const holdSeconds = timing.holdSeconds ?? span;
  const margin = Math.min(0.12, holdSeconds * 0.15);
  return {
    tStart: roundTime(timing.pureHoldStart + margin),
    tEnd: roundTime(timing.pureHoldEnd - margin),
  };
}

function meanAbsoluteByteDiff(actual, expected) {
  if (
    !(actual instanceof Uint8Array) ||
    !(expected instanceof Uint8Array) ||
    actual.length === 0 ||
    actual.length !== expected.length
  ) {
    return Number.POSITIVE_INFINITY;
  }
  let sum = 0;
  for (let i = 0; i < expected.length; i += 1) {
    sum += Math.abs(actual[i] - expected[i]);
  }
  return sum / expected.length;
}

/**
 * Synchronously verify that every slide's pure hold interval satisfies the
 * `addedWords / 3` minimum AND that sampled video frames at the start and end
 * of each slide's pure hold window match the un-transitioned target slide RGB.
 */
export function verifyRenderedHoldDurations({
  slides,
  timings,
  sampleFrameRgb,
  targetFramesRgb,
  maxMeanAbsDiff = 14,
}) {
  if (!Array.isArray(timings) || timings.length < 1) {
    throw new Error("verifyRenderedHoldDurations requires non-empty timings.");
  }
  if (Array.isArray(slides) && slides.length !== timings.length) {
    throw new Error(
      `Slide count (${slides.length}) does not match timings length (${timings.length}).`,
    );
  }
  if (
    !Array.isArray(targetFramesRgb) ||
    targetFramesRgb.length !== timings.length
  ) {
    throw new Error(
      `targetFramesRgb length (${targetFramesRgb?.length ?? 0}) does not match timings length (${timings.length}).`,
    );
  }
  if (typeof sampleFrameRgb !== "function") {
    throw new Error("verifyRenderedHoldDurations requires sampleFrameRgb(ts).");
  }

  const samples = [];
  for (let k = 0; k < timings.length; k += 1) {
    const timing = timings[k];
    const pureSpan = timing.pureHoldEnd - timing.pureHoldStart;
    if (pureSpan < timing.requiredHoldSeconds - 1e-6) {
      throw new Error(
        `Slide ${k + 1} pure hold duration (${pureSpan.toFixed(2)}s) is below required ${timing.requiredHoldSeconds.toFixed(2)}s.`,
      );
    }

    const { tStart, tEnd } = computeHoldSamplePoints(timing);
    const target = targetFramesRgb[k];
    const startRgb = sampleFrameRgb(tStart);
    const startDiff = meanAbsoluteByteDiff(startRgb, target);
    if (startDiff > maxMeanAbsDiff) {
      throw new Error(
        `Slide ${k + 1} hold pixel mismatch at ${tStart.toFixed(3)}s (meanAbsDiff=${startDiff.toFixed(2)} > ${maxMeanAbsDiff}); transition bled into pure hold.`,
      );
    }

    const endRgb = sampleFrameRgb(tEnd);
    const endDiff = meanAbsoluteByteDiff(endRgb, target);
    if (endDiff > maxMeanAbsDiff) {
      throw new Error(
        `Slide ${k + 1} hold pixel mismatch at ${tEnd.toFixed(3)}s (meanAbsDiff=${endDiff.toFixed(2)} > ${maxMeanAbsDiff}); transition bled into pure hold.`,
      );
    }

    samples.push({
      slideIndex: k,
      tStart,
      tEnd,
      startMeanAbsDiff: startDiff,
      endMeanAbsDiff: endDiff,
    });
  }

  return { ok: true, samples };
}

function buildToolEnv() {
  const currentPath = process.env.PATH ?? "";
  const parts = currentPath.split(path.delimiter).filter(Boolean);
  for (const extra of ["/opt/homebrew/bin", "/usr/local/bin"]) {
    if (!parts.includes(extra)) parts.push(extra);
  }
  return {
    ...process.env,
    PATH: parts.join(path.delimiter),
  };
}

function resolveChromeHeadlessScript() {
  const localCandidate = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../bin/chrome-headless.sh",
  );
  if (existsSync(localCandidate)) return localCandidate;
  return path.join(factoryRoot(), "bin/chrome-headless.sh");
}

function runCommandBuffer(cmd, args, { timeoutMs = 60_000, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: env ?? buildToolEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      reject(
        new Error(
          `Command timed out after ${timeoutMs}ms: ${cmd} ${args.join(" ")}`,
        ),
      );
    }, timeoutMs);

    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Failed to spawn ${cmd}: ${err.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code !== 0) {
        reject(
          new Error(
            `${cmd} exited with code ${code}: ${stderr.trim() || "(no stderr)"}`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function defaultRenderHtmlToPng(htmlPath, pngPath) {
  const wrapper = resolveChromeHeadlessScript();
  const profileDir = mkdtempSync(path.join(tmpdir(), "factory-recap-chrome-"));
  try {
    await runCommandBuffer(
      wrapper,
      [
        `--user-data-dir=${profileDir}`,
        `--window-size=${CANVAS.width},${CANVAS.height}`,
        "--force-device-scale-factor=1",
        "--hide-scrollbars",
        "--default-background-color=0b1020ff",
        `--screenshot=${pngPath}`,
        pathToFileURL(path.resolve(htmlPath)).href,
      ],
      { timeoutMs: 30_000 },
    );
    if (!existsSync(pngPath) || statSync(pngPath).size === 0) {
      throw new Error(
        `Headless browser failed to produce screenshot at ${pngPath}.`,
      );
    }
  } finally {
    if (profileDir.includes("factory-recap-chrome-")) {
      try {
        spawnSync(
          "pkill",
          ["-9", "-f", "--", `--user-data-dir=${profileDir}`],
          {
            stdio: "ignore",
            timeout: 2000,
          },
        );
      } catch {
        /* ignore */
      }
    }
    rmSync(profileDir, { recursive: true, force: true });
  }
}

export function buildFfmpegEncodeArgs({
  framePaths,
  timings,
  transitionSeconds,
  outFile,
  fps = 30,
}) {
  const args = ["-y", "-v", "error"];
  for (let i = 0; i < framePaths.length; i += 1) {
    args.push(
      "-loop",
      "1",
      "-framerate",
      String(fps),
      "-t",
      timings[i].clipDurationSeconds.toFixed(4),
      "-i",
      framePaths[i],
    );
  }

  if (framePaths.length === 1) {
    args.push(
      "-vf",
      `scale=${CANVAS.width}:${CANVAS.height}:flags=lanczos,fps=${fps},format=yuv420p`,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-r",
      String(fps),
      "-movflags",
      "+faststart",
      "-an",
      outFile,
    );
    return args;
  }

  const filterParts = [];
  for (let i = 0; i < framePaths.length; i += 1) {
    filterParts.push(
      `[${i}:v]scale=${CANVAS.width}:${CANVAS.height}:flags=lanczos,fps=${fps},format=yuv420p,settb=AVTB[v${i}]`,
    );
  }

  let prevLabel = "v0";
  for (let i = 1; i < framePaths.length; i += 1) {
    const outLabel = `x${i}`;
    const offset = timings[i].xfadeOffsetSeconds.toFixed(4);
    const dur = transitionSeconds.toFixed(4);
    filterParts.push(
      `[${prevLabel}][v${i}]xfade=transition=fade:duration=${dur}:offset=${offset}[${outLabel}]`,
    );
    prevLabel = outLabel;
  }

  args.push(
    "-filter_complex",
    filterParts.join(";"),
    "-map",
    `[${prevLabel}]`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(fps),
    "-movflags",
    "+faststart",
    "-an",
    outFile,
  );
  return args;
}

async function defaultEncodeVideo({
  framePaths,
  timings,
  transitionSeconds,
  outFile,
  fps = 30,
}) {
  mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  const args = buildFfmpegEncodeArgs({
    framePaths,
    timings,
    transitionSeconds,
    outFile,
    fps,
  });
  await runCommandBuffer("ffmpeg", args, { timeoutMs: 120_000 });
}

async function defaultProbeVideo(outFile) {
  const { stdout } = await runCommandBuffer(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,pix_fmt,duration:format=duration",
      "-of",
      "json",
      outFile,
    ],
    { timeoutMs: 20_000 },
  );
  const parsed = JSON.parse(stdout.toString("utf8"));
  const stream = parsed?.streams?.[0] ?? {};
  const durationRaw = parsed?.format?.duration ?? stream?.duration ?? 0;
  return {
    width: Number(stream.width ?? 0),
    height: Number(stream.height ?? 0),
    pixFmt: String(stream.pix_fmt ?? ""),
    durationSeconds: Number(durationRaw),
  };
}

async function defaultLoadTargetRgb(_index, pngPath) {
  const { stdout } = await runCommandBuffer(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      pngPath,
      "-vf",
      `scale=${CANVAS.width}:${CANVAS.height}:flags=lanczos`,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ],
    { timeoutMs: 20_000 },
  );
  return new Uint8Array(stdout);
}

async function defaultExtractFrameRgb(mp4Path, timestampSeconds) {
  const { stdout } = await runCommandBuffer(
    "ffmpeg",
    [
      "-v",
      "error",
      "-ss",
      timestampSeconds.toFixed(4),
      "-i",
      mp4Path,
      "-vf",
      `scale=${CANVAS.width}:${CANVAS.height}:flags=lanczos`,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ],
    { timeoutMs: 20_000 },
  );
  return new Uint8Array(stdout);
}

/**
 * Validate storyboard, render 1280x720 HTML -> PNG slides, encode silent H.264
 * MP4 with `xfade`, probe stream metadata, and verify rendered pure-hold frames.
 */
export async function renderRecapVideo(rawSpec, options = {}) {
  const spec = validateStoryboard(rawSpec);
  const transitionSeconds =
    options.transitionSeconds === undefined ? 0.35 : options.transitionSeconds;
  const minHoldSeconds =
    options.minHoldSeconds === undefined ? 2.0 : options.minHoldSeconds;
  const fps = options.fps ?? 30;
  const framesOnly = Boolean(options.framesOnly);

  if (
    !framesOnly &&
    (!options.outPath || typeof options.outPath !== "string")
  ) {
    throw new Error("renderRecapVideo requires options.outPath.");
  }

  const timings = computeSlideTimings(spec.slides, {
    minHoldSeconds,
    transitionSeconds,
  });
  const totalDurationSeconds = timings[timings.length - 1].pureHoldEnd;

  const renderHtmlToPng = options.renderHtmlToPng ?? defaultRenderHtmlToPng;
  const encodeVideo = options.encodeVideo ?? defaultEncodeVideo;
  const probeVideo = options.probeVideo ?? defaultProbeVideo;
  const loadTargetRgb = options.loadTargetRgb ?? defaultLoadTargetRgb;
  const extractFrameRgb = options.extractFrameRgb ?? defaultExtractFrameRgb;

  const callerDir = options.framesDir ?? options.workDir;
  const createdTempDir = !callerDir;
  const workDir = callerDir
    ? path.resolve(callerDir)
    : mkdtempSync(path.join(tmpdir(), "factory-recap-work-"));

  mkdirSync(workDir, { recursive: true });

  try {
    const htmlPaths = [];
    const framePaths = [];

    for (let i = 0; i < spec.slides.length; i += 1) {
      const num = String(i + 1).padStart(2, "0");
      const htmlPath = path.join(workDir, `slide-${num}.html`);
      const pngPath = path.join(workDir, `slide-${num}.png`);
      const html = renderSlideHtml(spec.slides[i], i, spec.slides.length);
      writeFileSync(htmlPath, html, "utf8");
      await renderHtmlToPng(htmlPath, pngPath, { slideIndex: i, html });
      htmlPaths.push(htmlPath);
      framePaths.push(pngPath);
    }

    if (framesOnly) {
      return {
        slideCount: spec.slides.length,
        takeaway: spec.takeaway,
        totalDurationSeconds,
        timings,
        framePaths,
        htmlPaths,
        verified: false,
      };
    }

    const outFile = path.resolve(options.outPath);
    await encodeVideo({
      framePaths,
      timings,
      transitionSeconds: timings[0].transitionSeconds,
      outFile,
      outPath: outFile,
      fps,
    });

    if (!existsSync(outFile) || statSync(outFile).size === 0) {
      throw new Error(
        `Rendered recap video is missing or empty at ${outFile}.`,
      );
    }

    const probe = await probeVideo(outFile);
    if (probe.width !== CANVAS.width || probe.height !== CANVAS.height) {
      throw new Error(
        `Rendered video dimensions ${probe.width}x${probe.height} do not match ${CANVAS.width}x${CANVAS.height}.`,
      );
    }
    if (probe.pixFmt !== "yuv420p") {
      throw new Error(
        `Rendered video pix_fmt "${probe.pixFmt}" must be "yuv420p".`,
      );
    }
    if (
      !Number.isFinite(probe.durationSeconds) ||
      probe.durationSeconds < totalDurationSeconds - 0.25
    ) {
      throw new Error(
        `Rendered video duration (${probe.durationSeconds}s) is shorter than expected ${totalDurationSeconds}s.`,
      );
    }

    const targetFramesRgb = [];
    for (let i = 0; i < framePaths.length; i += 1) {
      targetFramesRgb.push(await loadTargetRgb(i, framePaths[i]));
    }

    const sampledFrames = new Map();
    for (const timing of timings) {
      const { tStart, tEnd } = computeHoldSamplePoints(timing);
      if (!sampledFrames.has(tStart)) {
        sampledFrames.set(
          tStart,
          await extractFrameRgb(outFile, tStart, timings),
        );
      }
      if (!sampledFrames.has(tEnd)) {
        sampledFrames.set(tEnd, await extractFrameRgb(outFile, tEnd, timings));
      }
    }

    const verification = verifyRenderedHoldDurations({
      slides: spec.slides,
      timings,
      targetFramesRgb,
      sampleFrameRgb: (ts) => sampledFrames.get(ts),
      maxMeanAbsDiff: options.maxMeanAbsDiff ?? 14,
    });

    return {
      outPath: options.outPath,
      slideCount: spec.slides.length,
      takeaway: spec.takeaway,
      totalDurationSeconds,
      probedDurationSeconds: probe.durationSeconds,
      timings,
      verification,
      verified: true,
    };
  } finally {
    if (createdTempDir && !framesOnly && !options.keepWorkDir) {
      rmSync(workDir, { recursive: true, force: true });
    }
  }
}

export function formatCliUsage() {
  return [
    "Usage: factory recap-video <spec.json|-> --out <output.mp4> [--frames-only <dir>] [--json] [--help]",
    "",
    "Render a silent 1280x720 architecture/status recap MP4 from a validated storyboard JSON spec.",
    "",
    "Options:",
    "  --out <path>          Output MP4 path (required unless --frames-only is set)",
    "  --frames-only <dir>   Render HTML + 1280x720 PNG slides into <dir> without encoding MP4",
    "  --transition <sec>    Crossfade duration in seconds (default: 0.35)",
    "  --min-hold <sec>      Minimum pure hold per slide in seconds (default: 2.0)",
    "  --json                Emit machine-readable JSON summary",
    "  -h, --help            Show this help message",
  ].join("\n");
}

export async function runCli(argv = process.argv.slice(2)) {
  let specArg = null;
  let outPath = null;
  let framesOnlyDir = null;
  let transitionSeconds;
  let minHoldSeconds;
  let jsonOutput = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${formatCliUsage()}\n`);
      return 0;
    }
    if (arg === "--json") {
      jsonOutput = true;
      continue;
    }
    if (arg === "--out") {
      outPath = argv[++i] ?? null;
      continue;
    }
    if (arg.startsWith("--out=")) {
      outPath = arg.slice("--out=".length);
      continue;
    }
    if (arg === "--frames-only") {
      framesOnlyDir = argv[++i] ?? null;
      continue;
    }
    if (arg.startsWith("--frames-only=")) {
      framesOnlyDir = arg.slice("--frames-only=".length);
      continue;
    }
    if (arg === "--transition") {
      transitionSeconds = Number(argv[++i]);
      continue;
    }
    if (arg === "--min-hold") {
      minHoldSeconds = Number(argv[++i]);
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") {
      throw new Error(`Unknown option "${arg}".\n\n${formatCliUsage()}`);
    }
    if (!specArg) {
      specArg = arg;
    } else {
      throw new Error(`Unexpected positional argument "${arg}".`);
    }
  }

  if (!specArg) {
    throw new Error(`Missing <spec.json|-> argument.\n\n${formatCliUsage()}`);
  }
  if (!framesOnlyDir && !outPath) {
    throw new Error(
      `Missing --out <output.mp4> (or --frames-only <dir>).\n\n${formatCliUsage()}`,
    );
  }

  const rawText =
    specArg === "-"
      ? readFileSync(0, "utf8")
      : readFileSync(path.resolve(specArg), "utf8");
  const rawSpec = JSON.parse(rawText);

  const result = await renderRecapVideo(rawSpec, {
    outPath,
    framesOnly: Boolean(framesOnlyDir),
    framesDir: framesOnlyDir ?? undefined,
    transitionSeconds,
    minHoldSeconds,
  });

  if (jsonOutput) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.verified) {
    process.stdout.write(
      `Recap video verified: ${result.outPath} (${result.slideCount} slides, ${result.totalDurationSeconds.toFixed(2)}s)\n`,
    );
  } else {
    process.stdout.write(
      `Rendered ${result.slideCount} slide PNG frame(s) into ${framesOnlyDir}\n`,
    );
  }
  return 0;
}

if (import.meta.main) {
  runCli().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`recap-video error: ${err?.message ?? err}\n`);
      process.exitCode = 1;
    },
  );
}
