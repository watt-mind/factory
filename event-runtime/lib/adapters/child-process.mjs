/** Spawn options that make a child its own process group on POSIX hosts. */
export const DETACHED_SPAWN_OPTIONS = Object.freeze({ detached: true });

const terminations = new WeakMap();

function sendSignal(child, signal, kill) {
  try {
    kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already terminated
    }
  }
}

/**
 * Terminate a detached child and every subprocess in its process group.
 *
 * A second request for the same child is intentionally a no-op: timeout and
 * abort handlers can race, but only one TERM→KILL escalation should be armed.
 * The returned function cancels the pending escalation when the child closes.
 */
export function killProcessGroup(
  child,
  {
    killGraceMs,
    signal = "SIGTERM",
    kill = process.kill,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = {},
) {
  if (!child?.pid) return undefined;

  const existing = terminations.get(child);
  if (existing) return existing.cancel;

  sendSignal(child, signal, kill);

  let timer = null;
  const cancel = () => {
    if (timer) clearTimeoutFn(timer);
    timer = null;
  };
  terminations.set(child, { cancel });

  if (signal === "SIGTERM" && Number.isFinite(killGraceMs)) {
    timer = setTimeoutFn(() => sendSignal(child, "SIGKILL", kill), killGraceMs);
    timer.unref?.();
    child.once?.("close", cancel);
  }

  return cancel;
}
