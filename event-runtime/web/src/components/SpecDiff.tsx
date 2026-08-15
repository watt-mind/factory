// Line diff for two RunSpecs — the §12 replan path must show the operator
// exactly what changed before they approve the re-planned spec.

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, copyText } from "./ui";

export type DiffLine = { type: "same" | "del" | "add"; text: string };

/** Plain LCS line diff; specs are ~30 lines, so O(n·m) is nothing. */
export function diffLines(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "same", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ type: "del", text: a[i++] });
    } else {
      out.push({ type: "add", text: b[j++] });
    }
  }
  while (i < n) out.push({ type: "del", text: a[i++] });
  while (j < m) out.push({ type: "add", text: b[j++] });
  return out;
}

export function formatDiff(lines: DiffLine[]): string {
  return lines
    .map((l) => `${l.type === "del" ? "- " : l.type === "add" ? "+ " : "  "}${l.text}`)
    .join("\n");
}

function countLinesBelowViewport(scroller: HTMLElement): number {
  const scrollBottom = scroller.scrollTop + scroller.clientHeight;
  const lineEls = scroller.querySelectorAll("[data-diff-line]");
  let below = 0;
  for (const line of lineEls) {
    const el = line as HTMLElement;
    if (el.offsetTop + el.offsetHeight > scrollBottom + 1) below++;
  }
  return below;
}

export function SpecDiff({ before, after }: { before: unknown; after: unknown }) {
  const lines = diffLines(
    JSON.stringify(before, null, 2).split("\n"),
    JSON.stringify(after, null, 2).split("\n"),
  );
  const changed = lines.filter((l) => l.type !== "same").length;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [linesBelow, setLinesBelow] = useState(0);

  const updateOverflow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const hasOverflow = el.scrollHeight > el.clientHeight + 1;
    if (!hasOverflow) {
      setLinesBelow(0);
      return;
    }
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
    if (atBottom) {
      setLinesBelow(0);
      return;
    }
    let below = countLinesBelowViewport(el);
    if (below === 0) {
      const scrollable = el.scrollHeight - el.clientHeight;
      const remaining = scrollable - el.scrollTop;
      const totalLines = el.querySelectorAll("[data-diff-line]").length;
      below = Math.max(1, Math.ceil((remaining / scrollable) * totalLines));
    }
    setLinesBelow(below);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateOverflow();
    const ro = new ResizeObserver(updateOverflow);
    ro.observe(el);
    el.addEventListener("scroll", updateOverflow, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", updateOverflow);
    };
  }, [lines, updateOverflow]);

  if (changed === 0) {
    return (
      <div className="rounded-md border border-(--border) bg-(--surface-0) p-4 text-center text-[12px] text-(--text-faint)">
        No spec changes.
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      data-testid="spec-diff-scroll"
      className="mono relative max-h-80 overflow-auto rounded-md border border-(--border) bg-(--surface-0)"
    >
      <div
        data-testid="spec-diff-header"
        className="sticky top-0 z-10 flex items-center justify-between border-b border-(--border) bg-(--surface-0) px-3 py-1.5 text-[11px] text-(--text-faint)"
      >
        <span>{`${changed} changed line${changed === 1 ? "" : "s"}`}</span>
        <Button onClick={() => copyText(formatDiff(lines), "diff")}>
          Copy diff
        </Button>
      </div>
      <div data-testid="spec-diff-body" className="whitespace-pre-wrap p-3 leading-relaxed">
        {lines.map((l, idx) => (
          <div
            key={idx}
            data-diff-line
            style={
              l.type === "del"
                ? { color: "var(--hue-err)", background: "color-mix(in oklch, var(--hue-err) 8%, transparent)" }
                : l.type === "add"
                  ? { color: "var(--hue-ok)", background: "color-mix(in oklch, var(--hue-ok) 8%, transparent)" }
                  : undefined
            }
          >
            {l.type === "del" ? "- " : l.type === "add" ? "+ " : "  "}
            {l.text}
          </div>
        ))}
      </div>
      {linesBelow > 0 && (
        <>
          <div
            className="pointer-events-none sticky bottom-0 -mt-8 h-8 bg-linear-to-t from-(--surface-0) to-transparent"
            aria-hidden
          />
          <div className="sticky bottom-0 bg-(--surface-0) px-3 pb-2 pt-0.5 text-center text-[10px] text-(--text-faint)">
            {`${linesBelow} more line${linesBelow === 1 ? "" : "s"} below`}
          </div>
        </>
      )}
    </div>
  );
}
