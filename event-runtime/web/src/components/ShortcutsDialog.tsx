import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog } from "./ui";
import { NAV } from "../nav";

const CONTEXT_CHORDS: { chord: string; label: string }[] = [
  { chord: "g 0", label: "All context" },
  { chord: "g 1–9", label: "1st–9th repo tab" },
  { chord: "g i", label: "In flight context" },
];

const ACTIONS: { keys: string; does: string }[] = [
  { keys: "⌘K", does: "command palette" },
  { keys: "c l", does: "copy link to this page" },
  { keys: "footer theme button", does: "cycle theme (dark → light → contrast)" },
  { keys: "i", does: "inject event" },
  { keys: "/", does: "focus this view's filter (Artifacts, Events, Runs, and other lists)" },
  { keys: "v", does: "display options" },
  { keys: "j k  ↑↓", does: "move list (or graph) selection" },
  { keys: "[ ]", does: "previous / next status tab" },
  { keys: "1–N", does: "switch status tab" },
  { keys: "Enter", does: "open detail" },
  { keys: "o", does: "open current run (Workers) · full run view (Runs)" },
  { keys: "r", does: "run schedule now (Schedules)" },
  { keys: "a", does: "approve proposal (Proposals) · ack item (Inbox)" },
  { keys: "x", does: "reject proposal (Proposals) · cancel run (Runs) · resolve item (Inbox)" },
  { keys: "Space / Shift+Space", does: "toggle highlighted proposal selection" },
  { keys: "* a / ⌘A", does: "select all actionable proposals" },
  { keys: "* n / Esc", does: "clear proposal selection" },
  { keys: "A / X", does: "approve / reject selected proposals" },
  { keys: "q", does: "requeue event (Events)" },
  { keys: "p", does: "pin / unpin selected run (Runs)" },
  { keys: "z / Enter", does: "reveal selected node on canvas (Graph)" },
  { keys: "c", does: "copy selected id / name / ref" },
  { keys: "c i / c c", does: "copy CLI inspect command (Runs)" },
  { keys: "c p", does: "copy repo path (Projects)" },
  { keys: "d t", does: "dispatch triage scan (Projects)" },
  { keys: "d s", does: "dispatch status report (Projects)" },
  { keys: "d j", does: "dispatch janitor scan (Projects)" },
  { keys: "g h", does: "open repository on GitHub (Projects)" },
  { keys: "⌘+Shift+F", does: "format JSON (Inject dialog)" },
  { keys: "⌘↵", does: "confirm inject (Inject dialog) · confirm reject (Proposals)" },
  { keys: "Esc", does: "close panel, clear filter, or close dialog" },
  { keys: "?", does: "this list" },
];

const OVERVIEW_KEYS: { keys: string; does: string }[] = [
  { keys: "1–5", does: "open pipeline stage views (Events, Proposals, queued, running, outcomes)" },
  { keys: ".", does: "focus next anomaly" },
  { keys: "r", does: "requeue focused dead-letter event" },
];

const CONTEXT_STRIP: { keys: string; does: string }[] = [
  { keys: "Tab", does: "focus context strip (single stop, roving tabindex)" },
  { keys: "← →", does: "move focus among All / repos / In flight tabs" },
  { keys: "Home / End", does: "first / last context tab" },
  { keys: "Enter / Space", does: "activate focused filter" },
  { keys: "Delete / ⌫", does: "close focused repo tab (focus returns to active tab)" },
];

const TRACE_KEYS: { keys: string; does: string }[] = [
  { keys: "1–5", does: "switch trace kind (All, Tools, Reasoning, Errors, Usage)" },
  { keys: "[ ]", does: "previous / next trace filter tab (on run view)" },
  { keys: "/", does: "focus trace search" },
  { keys: "e", does: "toggle expand / collapse trace details" },
  { keys: "l", does: "toggle follow live trace" },
  { keys: "G", does: "jump to latest trace entry" },
  { keys: ".", does: "jump to next error entry" },
  { keys: "c", does: "copy run id" },
  { keys: "c i", does: "copy CLI inspect command" },
  { keys: "c l", does: "copy link to run" },
];

/** Keyboard cheatsheet (Linear's `?`). Spec §5 is the contract; this is the reminder. */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [hasMoreBelow, setHasMoreBelow] = useState(false);

  const updateOverflow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setHasMoreBelow(el.scrollHeight - el.scrollTop - el.clientHeight > 4);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateOverflow();
    const resizeObserver = new ResizeObserver(updateOverflow);
    resizeObserver.observe(el);
    el.addEventListener("scroll", updateOverflow, { passive: true });
    return () => {
      resizeObserver.disconnect();
      el.removeEventListener("scroll", updateOverflow);
    };
  }, [updateOverflow]);

  return (
    <Dialog title="Keyboard" onClose={onClose}>
      <div className="-mt-9 mb-3 flex justify-end">
        <button
          type="button"
          autoFocus
          ref={(node) => node?.setAttribute("autofocus", "")}
          onClick={onClose}
          className="rounded-md border border-(--border-strong) bg-(--surface-2) px-2.5 py-1 text-[12px] font-medium text-(--text) transition-colors hover:bg-(--surface-3) focus-visible:outline-2 focus-visible:outline-(--accent)"
        >
          Close
        </button>
      </div>
      <div className="relative">
        <div
          ref={scrollRef}
          data-testid="shortcuts-scroll"
          className="max-h-[calc(85vh-5rem)] space-y-5 overflow-y-auto pr-2 pb-8 text-[12px] text-(--text-dim)"
        >
        <section aria-label="Navigation chords">
          <div className="mb-2 text-[11px] font-medium tracking-wide text-(--text-faint) uppercase">
            Navigation chords
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4">
            {NAV.map((n) => (
              <div
                key={n.key}
                className="flex items-baseline justify-between gap-2 border-b border-(--border) py-1.5"
              >
                <span className="mono text-(--text)">g {n.go}</span>
                <span className="text-right text-(--text-faint)">{n.label}</span>
              </div>
            ))}
            {CONTEXT_CHORDS.map((c) => (
              <div
                key={c.chord}
                className="flex items-baseline justify-between gap-2 border-b border-(--border) py-1.5"
              >
                <span className="mono text-(--text)">{c.chord}</span>
                <span className="text-right text-(--text-faint)">{c.label}</span>
              </div>
            ))}
          </div>
        </section>

        <section aria-label="Actions">
          <div className="mb-2 text-[11px] font-medium tracking-wide text-(--text-faint) uppercase">
            Actions
          </div>
          <div>
            {ACTIONS.map((r) => (
              <div
                key={`${r.keys}::${r.does}`}
                className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-1 sm:gap-4 border-b border-(--border) py-1.5 last:border-0"
              >
                <span className="mono text-(--text)">{r.keys}</span>
                <span className="text-left sm:text-right text-(--text-faint)">{r.does}</span>
              </div>
            ))}
          </div>
        </section>

        <section aria-label="Overview">
          <div className="mb-2 text-[11px] font-medium tracking-wide text-(--text-faint) uppercase">
            Overview
          </div>
          <div>
            {OVERVIEW_KEYS.map((r) => (
              <div
                key={`${r.keys}::${r.does}`}
                className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-1 sm:gap-4 border-b border-(--border) py-1.5 last:border-0"
              >
                <span className="mono text-(--text)">{r.keys}</span>
                <span className="text-left sm:text-right text-(--text-faint)">{r.does}</span>
              </div>
            ))}
          </div>
        </section>

        <section aria-label="Context strip">
          <div className="mb-2 text-[11px] font-medium tracking-wide text-(--text-faint) uppercase">
            Context strip
          </div>
          <div>
            {CONTEXT_STRIP.map((r) => (
              <div
                key={`${r.keys}::${r.does}`}
                className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-1 sm:gap-4 border-b border-(--border) py-1.5 last:border-0"
              >
                <span className="mono text-(--text)">{r.keys}</span>
                <span className="text-left sm:text-right text-(--text-faint)">{r.does}</span>
              </div>
            ))}
          </div>
        </section>

        <section aria-label="Run & Trace">
          <div className="mb-2 text-[11px] font-medium tracking-wide text-(--text-faint) uppercase">
            Run & Trace
          </div>
          <div>
            {TRACE_KEYS.map((r) => (
              <div
                key={`${r.keys}::${r.does}`}
                className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-1 sm:gap-4 border-b border-(--border) py-1.5 last:border-0"
              >
                <span className="mono text-(--text)">{r.keys}</span>
                <span className="text-left sm:text-right text-(--text-faint)">{r.does}</span>
              </div>
            ))}
          </div>
        </section>
        </div>
        <div
          data-testid="shortcuts-scroll-fade"
          aria-hidden="true"
          className={`pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-linear-to-t from-(--surface-1) to-transparent transition-opacity ${hasMoreBelow ? "opacity-100" : "opacity-0"}`}
        />
      </div>
    </Dialog>
  );
}

