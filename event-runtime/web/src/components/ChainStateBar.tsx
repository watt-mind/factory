import { STATE_HUES } from "./ui";

const STATE_ORDER = Object.keys(STATE_HUES);

function chainStateSegments(
  states: Record<string, number>,
): { state: string; count: number }[] {
  return STATE_ORDER.flatMap((state) => {
    const count = states[state] ?? 0;
    return count > 0 ? [{ state, count }] : [];
  });
}

export function ChainStateBar({
  states,
  runCount,
}: {
  states: Record<string, number>;
  runCount?: number;
}) {
  const parts = chainStateSegments(states);
  const empty =
    (runCount !== undefined && runCount === 0) || parts.length === 0;
  const summary = parts
    .map(({ state, count }) => `${state} ${count}`)
    .join(", ");
  return (
    <div
      className="flex h-1.5 w-24 overflow-hidden rounded-full bg-(--surface-2)"
      role="img"
      aria-label={empty ? "no runs" : summary}
      title={empty ? "no runs" : summary}
    >
      {!empty &&
        parts.map(({ state, count }) => (
          <span
            key={state}
            data-state={state}
            className="h-full min-w-[2px]"
            style={{
              flexGrow: count,
              flexBasis: 0,
              background: STATE_HUES[state] ?? "var(--hue-idle)",
            }}
          />
        ))}
    </div>
  );
}
