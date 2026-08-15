import { Dialog } from "./ui";
import { NAV } from "../nav";

const ACTIONS: { keys: string; does: string }[] = [
  { keys: "⌘K", does: "command palette" },
  { keys: "⌘K", does: "copy link to this page" },
  { keys: "⌘K · footer theme", does: "cycle theme (dark → light → contrast)" },
  { keys: "i", does: "inject event" },
  { keys: "/", does: "focus filter (Events, if none on this view)" },
  { keys: "j k  ↑↓", does: "move list (or graph) selection" },
  { keys: "[ ]", does: "previous / next status tab" },
  { keys: "Enter / o", does: "open detail · full run view on Runs" },
  { keys: "Esc", does: "close panel, clear filter, or close dialog" },
  { keys: "⌘↵", does: "confirm inject" },
  { keys: "c", does: "copy selected id" },
  { keys: "a", does: "approve selected proposal" },
  { keys: "x", does: "reject proposal / cancel run" },
  { keys: "q", does: "requeue dead-lettered / human_needed event" },
  { keys: "?", does: "this list" },
];

const CONTEXT_STRIP: { keys: string; does: string }[] = [
  { keys: "Tab", does: "focus context strip (single stop, roving tabindex)" },
  { keys: "← →", does: "move focus among All / repos / In flight tabs" },
  { keys: "Home / End", does: "first / last context tab" },
  { keys: "Enter / Space", does: "activate focused filter" },
  { keys: "Delete / ⌫", does: "close focused repo tab (focus returns to active tab)" },
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
      </div>
    </Dialog>
  );
}

