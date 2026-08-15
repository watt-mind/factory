import type { Worker, WorkerState } from "./types";
import { WORKER_HUES as UI_WORKER_HUES } from "./components/ui";

export type WorkerHealth = WorkerState | "stale";

/** Four mutually exclusive tokens; `stale` is the loudest because it is a lie detector (re-exported from centralized ui.tsx). */
export const WORKER_HUES: Record<WorkerHealth, string> = UI_WORKER_HUES as Record<WorkerHealth, string>;

/**
 * A stale heartbeat outranks whatever the row claims: a stale busy worker is
 * gone, not busy. `listWorkers` never marks a cleanly stopped worker stale, so
 * these four are disjoint.
 */
export const health = (w: Worker): WorkerHealth => (w.stale ? "stale" : w.state);
