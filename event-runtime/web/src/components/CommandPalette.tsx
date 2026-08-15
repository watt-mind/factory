import { useQuery } from "@tanstack/react-query";
import { Command } from "cmdk";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { GO_CHORD_MS, goPrefix, goSequence } from "../goSequence";
import { keyGuard, modal, registerFocusReturnScope } from "../hooks";
import { useContextActions } from "../palette";
import { health } from "../workerHealth";
import { tabCycle } from "./ui";

export interface PaletteAction {
  label: string;
  hint?: string;
  group?: "Go" | "Commands";
  run: () => void;
}

/** ⌘K palette (webui spec §5): navigation, selection verbs, jump-to-ID. */
export function CommandPalette({
  actions,
  onJumpRun,
  onJumpProposal,
  onJumpEvent,
  onJumpAgent,
  onJumpWorker,
  onJumpProject,
}: {
  actions: PaletteAction[];
  onJumpRun: (runId: string) => void;
  onJumpProposal: (id: string) => void;
  onJumpEvent: (source: string, eventId: string) => void;
  onJumpAgent: (ref: string) => void;
  onJumpWorker: (id: string) => void;
  onJumpProject?: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const contextActions = useContextActions();

  // Capture the trigger before autoFocus moves into the search box. CommandPalette
  // stays mounted while closed, so Dialog's mount/unmount useFocusReturn would
  // restore on the wrong lifetime.
  if (open && !wasOpenRef.current) {
    const active = document.activeElement;
    previousFocusRef.current = active instanceof HTMLElement ? active : null;
  }
  wasOpenRef.current = open;

  // Jump targets load only while the palette is open; cache keys shared with
  // the views, so this is usually a cache hit, not a request.
  const runs = useQuery({ queryKey: ["runs", "ALL"], queryFn: () => api.runs(), enabled: open });
  const proposals = useQuery({
    queryKey: ["proposals", "history"],
    queryFn: () => api.proposalHistory("all"),
    enabled: open,
  });
  const events = useQuery({ queryKey: ["events", "all"], queryFn: () => api.events(), enabled: open });
  const agents = useQuery({ queryKey: ["agents"], queryFn: api.agents, enabled: open });
  const workers = useQuery({ queryKey: ["workers"], queryFn: api.workers, enabled: open });
  const repos = useQuery({ queryKey: ["repos"], queryFn: api.repos, enabled: open });

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "k" || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      setOpen((o) => {
        if (o) return modal.depth > 1;
        if (modal.depth > 0) return false;
        return true;
      });
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    modal.depth += 1;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
      else if (e.key === "Tab" && panelRef.current) tabCycle(panelRef.current, e);
    };
    window.addEventListener("keydown", onKey);
    const root = panelRef.current;
    const unregisterFocusReturn = root
      ? registerFocusReturnScope(root, previousFocusRef.current)
      : () => {};
    const input = root?.querySelector<HTMLElement>("input");
    (input ?? root)?.focus();
    return () => {
      modal.depth -= 1;
      window.removeEventListener("keydown", onKey);
      unregisterFocusReturn();
      const active = document.activeElement;
      const claimed =
        active instanceof HTMLElement && active !== document.body && active.isConnected;
      if (claimed) return;
      const previous = previousFocusRef.current;
      if (previous && (previous.isConnected ?? document.contains(previous))) {
        try {
          previous.focus();
        } catch {
          // detached or unfocusable
        }
      }
    };
  }, [open]);

  if (!open) return null;
  return (
    <div
      data-testid="palette-overlay"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[16vh]"
      onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}
    >
      <Command
        className="w-[560px] overflow-hidden rounded-lg border border-(--border-strong) bg-(--surface-1) shadow-2xl"
        loop
        label="Command palette"
      >
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-label="Command palette"
          tabIndex={-1}
        >
        <Command.Input
          autoFocus
          placeholder="Type a command…"
          className="w-full border-b border-(--border) bg-transparent px-4 py-3 text-[14px] text-(--text) outline-none placeholder:text-(--text-faint) focus:border-(--accent)"
        />
        <Command.List className="max-h-72 overflow-auto p-1.5">
          <Command.Empty className="px-3 py-6 text-center text-(--text-faint)">
            No matching command
          </Command.Empty>
          {contextActions.length > 0 && (
            <Command.Group heading="This item">
              {contextActions.map((a) => (
                <Command.Item
                  key={a.label}
                  onSelect={() => {
                    setOpen(false);
                    a.run();
                  }}
                  className="flex cursor-pointer items-center justify-between rounded-md px-3 py-2 text-[13px] data-[selected=true]:bg-(--surface-3)"
                >
                  <span>{a.label}</span>
                  {a.hint && <span className="mono text-[11px] text-(--text-faint)">{a.hint}</span>}
                </Command.Item>
              ))}
            </Command.Group>
          )}
          <Command.Group heading="Go">
            {actions
              .filter((a) => a.group === "Go")
              .map((a) => (
                <Command.Item
                  key={a.label}
                  onSelect={() => {
                    setOpen(false);
                    a.run();
                  }}
                  className="flex cursor-pointer items-center justify-between rounded-md px-3 py-2 text-[13px] data-[selected=true]:bg-(--surface-3)"
                >
                  <span>{a.label}</span>
                  {a.hint && <span className="mono text-[11px] text-(--text-faint)">{a.hint}</span>}
                </Command.Item>
              ))}
          </Command.Group>
          <Command.Group heading="Commands">
            {actions
              .filter((a) => a.group !== "Go")
              .map((a) => (
                <Command.Item
                  key={a.label}
                  onSelect={() => {
                    setOpen(false);
                    a.run();
                  }}
                  className="flex cursor-pointer items-center justify-between rounded-md px-3 py-2 text-[13px] data-[selected=true]:bg-(--surface-3)"
                >
                  <span>{a.label}</span>
                  {a.hint && <span className="mono text-[11px] text-(--text-faint)">{a.hint}</span>}
                </Command.Item>
              ))}
          </Command.Group>
          {(proposals.data?.proposals ?? []).length > 0 && (
            <Command.Group heading="Proposals">
          {(proposals.data?.proposals ?? []).map((p) => (
            <Command.Item
              key={p.id}
              value={`proposal ${p.id} ${p.agent ?? ""} ${p.status} ${p.decision}`}
              onSelect={() => {
                setOpen(false);
                onJumpProposal(p.id);
              }}
              className="flex cursor-pointer items-center justify-between rounded-md px-3 py-2 text-[13px] data-[selected=true]:bg-(--surface-3)"
            >
              <span className="mono truncate">{p.id}</span>
              <span className="ml-3 shrink-0 text-[11px] text-(--text-faint)">
                proposal · {p.status}
                {p.status === "open" ? ` · ${p.agent ?? p.decision}` : ` · ${p.decision}`}
              </span>
            </Command.Item>
          ))}
            </Command.Group>
          )}
          {(events.data?.events ?? []).length > 0 && (
            <Command.Group heading="Events">
          {(events.data?.events ?? []).map((e) => (
            <Command.Item
              key={`${e.source}:${e.eventId}`}
              value={`event ${e.source} ${e.eventId} ${e.type} ${e.status}`}
              onSelect={() => {
                setOpen(false);
                onJumpEvent(e.source, e.eventId);
              }}
              className="flex cursor-pointer items-center justify-between rounded-md px-3 py-2 text-[13px] data-[selected=true]:bg-(--surface-3)"
            >
              <span className="mono truncate">{e.eventId}</span>
              <span className="ml-3 shrink-0 text-[11px] text-(--text-faint)">
                event · {e.source} · {e.status}
              </span>
            </Command.Item>
          ))}
            </Command.Group>
          )}
          {(runs.data?.runs ?? []).length > 0 && (
            <Command.Group heading="Runs">
          {(runs.data?.runs ?? []).map((r) => (
            <Command.Item
              key={r.runId}
              value={`run ${r.runId} ${r.state} ${r.agent}`}
              onSelect={() => {
                setOpen(false);
                onJumpRun(r.runId);
              }}
              className="flex cursor-pointer items-center justify-between rounded-md px-3 py-2 text-[13px] data-[selected=true]:bg-(--surface-3)"
            >
              <span className="mono truncate">{r.runId}</span>
              <span className="ml-3 shrink-0 text-[11px] text-(--text-faint)">run · {r.state}</span>
            </Command.Item>
          ))}
            </Command.Group>
          )}
          {(agents.data?.agents ?? []).length > 0 && (
            <Command.Group heading="Agents">
          {(agents.data?.agents ?? []).map((a) => (
            <Command.Item
              key={a.ref}
              value={`agent ${a.ref} ${a.id} ${a.outputContract}`}
              onSelect={() => {
                setOpen(false);
                onJumpAgent(a.ref);
              }}
              className="flex cursor-pointer items-center justify-between rounded-md px-3 py-2 text-[13px] data-[selected=true]:bg-(--surface-3)"
            >
              <span className="mono truncate">{a.ref}</span>
              <span className="ml-3 shrink-0 text-[11px] text-(--text-faint)">agent · {a.outputContract}</span>
            </Command.Item>
          ))}
            </Command.Group>
          )}
          {(workers.data?.workers ?? []).length > 0 && (
            <Command.Group heading="Workers">
          {(workers.data?.workers ?? []).map((w) => {
            const state = health(w);
            return (
            <Command.Item
              key={w.workerId}
              value={`worker ${w.workerId} ${w.host} ${state}`}
              onSelect={() => {
                setOpen(false);
                onJumpWorker(w.workerId);
              }}
              className="flex cursor-pointer items-center justify-between rounded-md px-3 py-2 text-[13px] data-[selected=true]:bg-(--surface-3)"
            >
              <span className="mono truncate">{w.workerId}</span>
              <span className="ml-3 shrink-0 text-[11px] text-(--text-faint)">
                worker · {w.host} · {state}
              </span>
            </Command.Item>
            );
          })}
            </Command.Group>
          )}
          {(repos.data?.repos ?? []).length > 0 && (
            <Command.Group heading="Projects">
              {(repos.data?.repos ?? []).map((r) => (
                <Command.Item
                  key={r.name}
                  value={`project repo ${r.name} ${r.team ?? ""} ${r.project ?? ""} ${r.github ?? ""}`}
                  onSelect={() => {
                    setOpen(false);
                    onJumpProject?.(r.name);
                  }}
                  className="flex cursor-pointer items-center justify-between rounded-md px-3 py-2 text-[13px] data-[selected=true]:bg-(--surface-3)"
                >
                  <span className="mono truncate">
                    {r.name}
                    {r.project ? <span className="ml-2 font-sans text-(--text-dim)">{r.project}</span> : null}
                  </span>
                  <span className="ml-3 shrink-0 text-[11px] text-(--text-faint)">
                    project · {r.reportOnly ? "report-only" : "dispatchable"}
                  </span>
                </Command.Item>
              ))}
            </Command.Group>
          )}
        </Command.List>
        <div className="flex items-center justify-between border-t border-(--border) px-4 py-2 text-[11px] text-(--text-faint)">
          <span><span className="mono font-medium">↑↓</span> Navigate</span>
          <span><span className="mono font-medium">↵</span> Select</span>
          <span><span className="mono font-medium">ESC</span> Close</span>
        </div>
        </div>
      </Command>
    </div>
  );
}

/**
 * g-then-letter navigation sequences (spec §5): g g, g o, g p, g r, g e.
 *
 * Returns whether a `g` is currently waiting for its suffix, so the caller can
 * show that the chord is armed — without it, a `g` plus any hesitation looks
 * like a dropped keystroke, and the suffix that follows a lapsed window fires
 * as a bare list verb instead.
 */
export function useGoSequences(map: Record<string, () => void>): boolean {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const chord = goSequence((key) => Object.hasOwn(map, key));
    // The window closes on its own, with nothing to press: the only way the
    // affordance can follow it is a timer of the same length.
    let lapse: ReturnType<typeof setTimeout> | undefined;
    function onKey(e: KeyboardEvent) {
      if (keyGuard(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      // A held `g` auto-repeats: without this, resting on the key would arm
      // the prefix and then immediately spend it on the Graph view.
      if (e.repeat) return;
      // Arm the shared flag so list verbs (o, w, …) stand down (goSequence.ts).
      if (e.key === "g") goPrefix.armedAt = Date.now();
      const fired = chord.press(e.key);
      clearTimeout(lapse);
      setArmed(chord.armed());
      if (chord.armed()) lapse = setTimeout(() => setArmed(false), GO_CHORD_MS);
      if (!fired) return;
      e.preventDefault();
      map[e.key]();
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearTimeout(lapse);
      // This listener carried the chord; a remount mid-window would otherwise
      // leave the indicator on with nothing left to resolve it.
      setArmed(false);
    };
  }, [map]);
  return armed;
}
