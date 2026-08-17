import { describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";

export interface OklchColor {
  l: number;
  c: number;
  h: number;
}

export function parseOklch(str: string): OklchColor {
  const m = str.match(/oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)/);
  if (!m) throw new Error(`Cannot parse oklch: "${str}"`);
  return { l: parseFloat(m[1]), c: parseFloat(m[2]), h: parseFloat(m[3]) };
}

export function oklchToLinearRgb(c: OklchColor): [number, number, number] {
  const hRad = (c.h * Math.PI) / 180;
  const a = c.c * Math.cos(hRad);
  const b = c.c * Math.sin(hRad);

  const l_ = c.l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = c.l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = c.l - 0.0894841775 * a - 1.2914855480 * b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  const rLin = Math.min(Math.max(0, +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), 1);
  const gLin = Math.min(Math.max(0, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), 1);
  const bLin = Math.min(Math.max(0, -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s), 1);

  return [rLin, gLin, bLin];
}

export function relativeLuminance(c: OklchColor): number {
  const [r, g, b] = oklchToLinearRgb(c);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(c1: OklchColor, c2: OklchColor): number {
  const lum1 = relativeLuminance(c1);
  const lum2 = relativeLuminance(c2);
  const l1 = Math.max(lum1, lum2);
  const l2 = Math.min(lum1, lum2);
  return (l1 + 0.05) / (l2 + 0.05);
}

export function mixOklch(c1: OklchColor, c2: OklchColor, p1: number): OklchColor {
  const p2 = 1 - p1;
  const h1Rad = (c1.h * Math.PI) / 180;
  const a1 = c1.c * Math.cos(h1Rad);
  const b1 = c1.c * Math.sin(h1Rad);

  const h2Rad = (c2.h * Math.PI) / 180;
  const a2 = c2.c * Math.cos(h2Rad);
  const b2 = c2.c * Math.sin(h2Rad);

  const L = c1.l * p1 + c2.l * p2;
  const a = a1 * p1 + a2 * p2;
  const b = b1 * p1 + b2 * p2;

  const C = Math.sqrt(a * a + b * b);
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { l: L, c: C, h: C === 0 ? 0 : h };
}

interface ParsedTheme {
  base: OklchColor;
  contrast: OklchColor;
  accent: OklchColor;
  onAccent: OklchColor;
  text: OklchColor;
  textDim: OklchColor;
  textFaint: OklchColor;
  surface0: OklchColor;
  surface1: OklchColor;
  surface2: OklchColor;
  surface3: OklchColor;
  hueAccent: OklchColor;
  hueWarn: OklchColor;
  border: OklchColor;
  borderStrong: OklchColor;
}

function resolveThemesFromCss(): Record<"dark" | "light" | "contrast", ParsedTheme> {
  const cssPath = path.resolve(__dirname, "theme.css");
  const css = fs.readFileSync(cssPath, "utf-8");

  function extractBlock(selector: string): string {
    const startIdx = css.indexOf(selector);
    if (startIdx === -1) throw new Error(`Selector ${selector} not found in theme.css`);
    const openBrace = css.indexOf("{", startIdx);
    const closeBrace = css.indexOf("}", openBrace);
    return css.slice(openBrace + 1, closeBrace);
  }

  function extractVar(block: string, name: string): string | null {
    const regex = new RegExp(`--${name}:\\s*([^;]+);`);
    const m = block.match(regex);
    return m ? m[1].trim() : null;
  }

  function extractAllBlocks(selector: string): string {
    const blocks: string[] = [];
    let from = 0;
    while (true) {
      const startIdx = css.indexOf(selector, from);
      if (startIdx === -1) break;
      const openBrace = css.indexOf("{", startIdx);
      const closeBrace = css.indexOf("}", openBrace);
      blocks.push(css.slice(openBrace + 1, closeBrace));
      from = closeBrace + 1;
    }
    return blocks.join("\n");
  }

  const rootBlock = extractBlock(":root");
  const lightBlock = extractAllBlocks('[data-theme="light"]');
  const contrastBlock = extractBlock('[data-theme="contrast"]');
  const sharedBlock = extractBlock("[data-theme]");

  function parseMixPct(val: string, primaryVar: string): number {
    const match = val.match(new RegExp(`var\\(--${primaryVar}\\)\\s*(\\d+)%`));
    if (!match) throw new Error(`Cannot parse mix percentage for var(--${primaryVar}) in "${val}"`);
    return parseInt(match[1], 10) / 100;
  }

  const textPct = parseMixPct(extractVar(sharedBlock, "text")!, "contrast");
  const textDimPct = parseMixPct(extractVar(sharedBlock, "text-dim")!, "contrast");
  const textFaintPct = parseMixPct(extractVar(sharedBlock, "text-faint")!, "contrast");
  const borderPct = parseMixPct(extractVar(sharedBlock, "border")!, "base");
  const borderStrongPct = parseMixPct(extractVar(sharedBlock, "border-strong")!, "base");
  const surfacePcts = {
    surface1: parseMixPct(extractVar(sharedBlock, "surface-1")!, "base"),
    surface2: parseMixPct(extractVar(sharedBlock, "surface-2")!, "base"),
    surface3: parseMixPct(extractVar(sharedBlock, "surface-3")!, "base"),
  };

  function buildTheme(block: string, defaultOnAccent: string): ParsedTheme {
    const baseStr = extractVar(block, "base")!;
    const contrastStr = extractVar(block, "contrast")!;
    const accentStr = extractVar(block, "accent")!;
    const onAccentStr = extractVar(block, "on-accent") ?? defaultOnAccent;

    const base = parseOklch(baseStr);
    const contrast = parseOklch(contrastStr);
    const accent = parseOklch(accentStr);
    let onAccent: OklchColor;
    if (onAccentStr === "var(--base)") {
      onAccent = base;
    } else if (onAccentStr === "var(--contrast)") {
      onAccent = contrast;
    } else if (onAccentStr === "#ffffff" || onAccentStr === "white") {
      onAccent = { l: 1, c: 0, h: 0 };
    } else {
      onAccent = parseOklch(onAccentStr);
    }

    const surface = (name: "surface-0" | "surface-1" | "surface-2" | "surface-3"): OklchColor => {
      const explicit = extractVar(block, name);
      if (explicit) return parseOklch(explicit);
      if (name === "surface-0") return base;
      return mixOklch(base, contrast, surfacePcts[name.replace("-", "") as keyof typeof surfacePcts]);
    };

    return {
      base,
      contrast,
      accent,
      onAccent,
      surface0: surface("surface-0"),
      surface1: surface("surface-1"),
      surface2: surface("surface-2"),
      surface3: surface("surface-3"),
      hueAccent: accent,
      hueWarn: { ...accent, h: 75 },
      text: mixOklch(contrast, base, textPct),
      textDim: mixOklch(contrast, base, textDimPct),
      textFaint: mixOklch(contrast, base, textFaintPct),
      border: mixOklch(base, contrast, borderPct),
      borderStrong: mixOklch(base, contrast, borderStrongPct),
    };
  }

  return {
    dark: buildTheme(rootBlock, "white"),
    light: buildTheme(lightBlock, "white"),
    contrast: buildTheme(contrastBlock, "white"),
  };
}

describe("Theme contrast & accessibility (OPS-447, OPS-338)", () => {
  const themes = resolveThemesFromCss();

  for (const themeName of ["dark", "light", "contrast"] as const) {
    const t = themes[themeName];

    test(`${themeName}: --text clears WCAG AA (>= 4.5:1) against --surface-0`, () => {
      const cr = contrastRatio(t.text, t.surface0);
      expect(cr).toBeGreaterThanOrEqual(4.5);
    });

    test(`${themeName}: --text-dim clears WCAG AA (>= 4.5:1) against --surface-0`, () => {
      const cr = contrastRatio(t.textDim, t.surface0);
      expect(cr).toBeGreaterThanOrEqual(4.5);
    });

    test(`${themeName}: --text-faint clears WCAG AA (>= 4.5:1) against --surface-0`, () => {
      const cr = contrastRatio(t.textFaint, t.surface0);
      expect(cr).toBeGreaterThanOrEqual(4.5);
    });

    test(`${themeName}: primary button foreground clears WCAG AA (>= 4.5:1) on --accent`, () => {
      const cr = contrastRatio(t.onAccent, t.accent);
      expect(cr).toBeGreaterThanOrEqual(4.5);
    });

    test(`${themeName}: --border-strong has higher contrast than --border`, () => {
      const borderCr = contrastRatio(t.border, t.surface0);
      const borderStrongCr = contrastRatio(t.borderStrong, t.surface0);
      expect(borderStrongCr).toBeGreaterThan(borderCr);
    });
  }

  test("contrast theme primary button has >= contrast than dark or light", () => {
    const contrastBtnCr = contrastRatio(themes.contrast.onAccent, themes.contrast.accent);
    const darkBtnCr = contrastRatio(themes.dark.onAccent, themes.dark.accent);
    const lightBtnCr = contrastRatio(themes.light.onAccent, themes.light.accent);

    expect(contrastBtnCr).toBeGreaterThanOrEqual(darkBtnCr);
    expect(contrastBtnCr).toBeGreaterThanOrEqual(lightBtnCr);
  });

  test("light theme has white main between soft-grey chrome and deeper raised surfaces (WM-558)", () => {
    const light = themes.light;
    expect(light.surface0.l).toBeCloseTo(0.965, 3);
    expect(light.surface0.c).toBeCloseTo(0.003, 3);
    expect(light.surface1.l).toBe(1);
    expect(light.surface2.l).toBeLessThan(light.surface0.l);
    expect(light.surface0.l).toBeLessThan(light.surface1.l);
  });

  test("light theme chips and zebra-row content clear non-text contrast (>= 3:1) (WM-558)", () => {
    const light = themes.light;
    // These percentages mirror App's LIVE and nav count recipes, ContextTabs'
    // active In flight token, and theme.css's zebra row recipe.
    const liveWash = mixOklch(light.hueWarn, light.surface1, 0.15);
    const inFlightWash = mixOklch(light.hueAccent, light.base, 0.25);
    const sidebarAccentWash = mixOklch(light.hueAccent, light.surface1, 0.12);
    const sidebarWarnWash = mixOklch(light.hueWarn, light.surface1, 0.12);
    const zebra = mixOklch(light.surface2, light.surface1, 0.7);

    expect(contrastRatio(light.hueWarn, liveWash)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(light.text, inFlightWash)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(light.hueAccent, sidebarAccentWash)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(light.hueWarn, sidebarWarnWash)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(light.textDim, zebra)).toBeGreaterThanOrEqual(3);
  });

  test("row treatments use semantic zebra surfaces and accent-hued 2px selection (WM-558)", () => {
    const css = fs.readFileSync(path.resolve(__dirname, "theme.css"), "utf-8");
    expect(css).toMatch(/tbody\s*>\s*tr:nth-child\(even\)[^{]*\{[^}]*var\(--surface-2\)/s);
    expect(css).toMatch(/\.row-selected\s*\{[^}]*var\(--hue-accent\)\s+1[2-6]%,\s*transparent[^}]*inset\s+2px\s+0\s+0\s+var\(--hue-accent\)/s);
  });
});
