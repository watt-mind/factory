import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

interface SectionCallsite {
  file: string;
  line: number;
}

/**
 * Static titles are the persistence fallback when a Section has no explicit id.
 * Keep those titles globally unique so unrelated views cannot share collapse state.
 */
describe("Section collapse keys (WM-192)", () => {
  test("every static title used as a collapse key is unique across the app", async () => {
    const callsites = new Map<string, SectionCallsite[]>();
    const srcDir = fileURLToPath(new URL("..", import.meta.url));
    const glob = new Bun.Glob("**/*.tsx");

    for await (const file of glob.scan({ cwd: srcDir, onlyFiles: true })) {
      if (file.includes(".test.")) continue;

      const source = readFileSync(`${srcDir}/${file}`, "utf8");
      for (const match of source.matchAll(/<Section\b([^>]*?)>/gs)) {
        const props = match[1];
        if (/\bid\s*=/.test(props)) continue;

        const title = props.match(/\btitle\s*=\s*(["'])(.*?)\1/s)?.[2];
        if (!title) continue;

        const line = source.slice(0, match.index).split("\n").length;
        const entries = callsites.get(title) ?? [];
        entries.push({ file: `src/${file}`, line });
        callsites.set(title, entries);
      }
    }

    const duplicates = [...callsites.entries()]
      .filter(([, entries]) => entries.length > 1)
      .map(
        ([title, entries]) =>
          `${JSON.stringify(title)}: ${entries.map(({ file, line }) => `${file}:${line}`).join(", ")}`,
      )
      .sort();

    expect(duplicates).toEqual([]);
  });
});
