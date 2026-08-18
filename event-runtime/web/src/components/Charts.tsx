import { Fragment, type ReactNode } from "react";

const finite = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value);

function scale(values: number[], height: number, pad: number) {
  const min = values.length > 0 ? Math.min(...values) : 0;
  const max = values.length > 0 ? Math.max(...values) : 0;
  const y = (value: number) =>
    max === min
      ? height / 2
      : pad + ((max - value) / (max - min)) * (height - pad * 2);
  return { min, max, y };
}

function pointX(index: number, count: number, width: number, pad: number) {
  return count <= 1
    ? width / 2
    : pad + (index / (count - 1)) * (width - pad * 2);
}

export type ChartLink = {
  href: string;
  label: string;
};

function LinkedMark({
  link,
  children,
}: {
  link?: ChartLink | null;
  children: ReactNode;
}) {
  if (!link) return <>{children}</>;
  return (
    <a href={link.href} aria-label={link.label}>
      {children}
    </a>
  );
}

export function Sparkline({
  values,
  label,
  hue = "var(--hue-info)",
  width = 600,
  height = 180,
  linkForPoint,
}: {
  values: number[];
  label: string;
  hue?: string;
  width?: number;
  height?: number;
  linkForPoint?: (index: number, value: number) => ChartLink | null;
}) {
  const points = values.filter(finite);
  const pad = 4;
  const { y } = scale(points, height, pad);
  const polyline = values
    .map(
      (value, index) =>
        `${pointX(index, values.length, width, pad)},${y(value)}`,
    )
    .join(" ");

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="h-44 w-full overflow-visible"
      data-empty={values.length === 0 ? "true" : undefined}
    >
      {values.length > 1 && (
        <polyline
          points={polyline}
          fill="none"
          stroke={hue}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
      {values.map((value, index) => {
        const x = pointX(index, values.length, width, pad);
        const cy = y(value);
        const link = linkForPoint?.(index, value);
        return (
          <LinkedMark key={index} link={link}>
            <g
              data-point={index}
              className={link ? "cursor-pointer" : undefined}
            >
              {link && <circle cx={x} cy={cy} r="6" fill="transparent" />}
              <circle cx={x} cy={cy} r="2.5" fill={hue} />
            </g>
          </LinkedMark>
        );
      })}
    </svg>
  );
}

export interface StackedBarSegment {
  key: string;
  label: string;
  value: number;
  hue: string;
  link?: ChartLink | null;
}

export interface StackedBarDatum {
  key: string;
  label: string;
  segments: StackedBarSegment[];
}

export function StackedBars({
  bars,
  label,
  width = 600,
  height = 180,
}: {
  bars: StackedBarDatum[];
  label: string;
  width?: number;
  height?: number;
}) {
  const padX = 8;
  const padY = 8;
  const gap = 3;
  const totals = bars.map((bar) =>
    bar.segments.reduce((sum, segment) => sum + Math.max(0, segment.value), 0),
  );
  const max = Math.max(0, ...totals);
  const slot =
    bars.length > 0 ? (width - padX * 2) / bars.length : width - padX * 2;
  const barWidth = Math.max(1, slot - gap);
  const drawableHeight = height - padY * 2;

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="h-44 w-full"
      data-empty={bars.length === 0 || max === 0 ? "true" : undefined}
    >
      {bars.map((bar, index) => {
        const x = padX + index * slot + gap / 2;
        let used = 0;
        return (
          <g key={bar.key} data-bar={bar.key}>
            {bar.segments.map((segment) => {
              const value = Math.max(0, segment.value);
              if (value === 0 || max === 0) return null;
              const segmentHeight = (value / max) * drawableHeight;
              const y = height - padY - used - segmentHeight;
              used += segmentHeight;
              return (
                <LinkedMark key={segment.key} link={segment.link}>
                  <rect
                    data-segment={segment.key}
                    x={x}
                    y={y}
                    width={barWidth}
                    height={segmentHeight}
                    rx="1.5"
                    fill={segment.hue}
                    className={
                      segment.link
                        ? "cursor-pointer hover:opacity-80"
                        : undefined
                    }
                  >
                    <title>{`${bar.label} · ${segment.label}: ${segment.value}`}</title>
                  </rect>
                </LinkedMark>
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}

export interface BandDatum {
  p50: number | null;
  p95: number | null;
}

function bandRuns(values: BandDatum[]) {
  const runs: Array<Array<{ index: number; p50: number; p95: number }>> = [];
  let current: Array<{ index: number; p50: number; p95: number }> = [];
  values.forEach((value, index) => {
    if (finite(value.p50) && finite(value.p95)) {
      current.push({ index, p50: value.p50, p95: value.p95 });
      return;
    }
    if (current.length > 0) runs.push(current);
    current = [];
  });
  if (current.length > 0) runs.push(current);
  return runs;
}

export function Band({
  values,
  label,
  hue = "var(--hue-verify)",
  width = 600,
  height = 160,
  linkForPoint,
}: {
  values: BandDatum[];
  label: string;
  hue?: string;
  width?: number;
  height?: number;
  linkForPoint?: (index: number, value: BandDatum) => ChartLink | null;
}) {
  const runs = bandRuns(values);
  const samples = runs.flatMap((run) =>
    run.flatMap((point) => [point.p50, point.p95]),
  );
  const pad = 8;
  const { y } = scale(samples, height, pad);
  const x = (index: number) => pointX(index, values.length, width, pad);

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="h-40 w-full"
      data-empty={runs.length === 0 ? "true" : undefined}
    >
      {runs.map((run, runIndex) => {
        const upper = run.map((point) => `${x(point.index)},${y(point.p95)}`);
        const lower = run
          .slice()
          .reverse()
          .map((point) => `${x(point.index)},${y(point.p50)}`);
        const median = run
          .map((point) => `${x(point.index)},${y(point.p50)}`)
          .join(" ");
        return (
          <Fragment key={runIndex}>
            <polygon
              data-band-segment={runIndex}
              points={[...upper, ...lower].join(" ")}
              fill={`color-mix(in oklch, ${hue} 18%, transparent)`}
              stroke="none"
            />
            {run.length > 1 && (
              <polyline
                data-median-segment={runIndex}
                points={median}
                fill="none"
                stroke={hue}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </Fragment>
        );
      })}
      {runs.flatMap((run) =>
        run.map((point) => {
          const datum = values[point.index]!;
          const link = linkForPoint?.(point.index, datum);
          return (
            <LinkedMark key={point.index} link={link}>
              <g
                data-point={point.index}
                className={link ? "cursor-pointer" : undefined}
              >
                {link && (
                  <circle
                    cx={x(point.index)}
                    cy={y(point.p50)}
                    r="7"
                    fill="transparent"
                  />
                )}
                <circle
                  cx={x(point.index)}
                  cy={y(point.p50)}
                  r="3"
                  fill={hue}
                />
              </g>
            </LinkedMark>
          );
        }),
      )}
    </svg>
  );
}
