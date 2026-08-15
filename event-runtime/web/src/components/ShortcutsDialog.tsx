import { Dialog } from "./ui";
import { NAV } from "../nav";

const CONTEXT_CHORDS: { chord: string; label: string }[] = [
  { chord: "g 0", label: "All context" },
  { chord: "g 1–9", label: "1st–9th repo tab" },
  { chord: "g i", label: "In flight context" },
];

const ACTIONS: { keys: string; does: string }[] = [
  { keys: "⌘K", does: "command palette" },
  { keys: "⌘K", does: "copy link to this page" },
  { keys: "⌘K · footer theme", does: "cycle theme (dark → light → contrast)" },
  { keys: "i", does: "inject event" },
  { keys: "/", does: "focus this view's filter (Artifacts, Events, Runs, and other lists)" },
  { keys: "v", does: "display options" },
  { keys: "j k  ↑↓", does: "move list (or graph) selection" },
  { keys: "[ ]", does: "previous / next status tab" },
  { keys: "1–N", does: "switch status tab" },
  { keys: "Enter", does: "open detail" },
  { keys: "o", does: "open current run (Workers) · full run view (Runs)" },
  { keys: "r", does: "run schedule now (Schedules)" },
  { keys: "a", does: "approve proposal (Proposals)" },
  { keys: "x", does: "reject proposal (Proposals) · cancel run (Runs)" },
  { keys: "q", does: "requeue event (Events)" },
  { keys: "c", does: "copy selected id / name / ref" },
  { keys: "c l", does: "copy link to clipboard" },
  { keys: "c i / c c", does: "copy CLI inspect command (Runs)" },
  { keys: "c p", does: "copy repo path (Projects)" },
  { keys: "⌘+Shift+F", does: "format JSON (Inject dialog)" },
  { keys: "⌘↵", does: "confirm inject (Inject dialog) · confirm reject (Proposals)" },
  { keys: "Esc", does: "close panel, clear filter, or close dialog" },
  { keys: "?", does: "this list" },
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
  return (
    <Dialog title="Keyboard" onClose={onClose}>
      <div className="space-y-5 text-[12px] text-(--text-dim)">
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
    </Dialog>
  );
}

