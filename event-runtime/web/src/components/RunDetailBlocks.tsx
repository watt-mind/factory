import { useState, type ReactNode } from "react";
import { artifactUrl } from "../api";
import { hashPath, hashProject, withProject } from "../hash";
import { dur } from "../heartbeat";
import type { ArtifactRef, Attempt, LifecycleEvent, RunDetail, RunSpec, RunState } from "../types";
import {
  Ago,
  Disclosure,
  humanSize,
  JsonBlock,
  JumpLink,
  KV,
  ModelCell,
  Section,
  STATE_HUES,
  StateBadge,
  VerbError,
  copyText,
  shortId,
} from "./ui";
import { AgentHoverCard } from "./AgentHoverCard";
import { attrIcon } from "./attrIcons";

export const TERMINAL: RunState[] = ["COMPLETED", "REFUSED", "FAILED", "TIMED_OUT", "CANCELLED"];
export const isCancellable = (state: RunState) => !TERMINAL.includes(state) && state !== "VERIFYING";

/**
 * The states `reapExpiredLeases` sweeps (lib/worker.mjs) — exactly the states
 * where the current attempt is still racing its attempt and lease deadlines.
 */
export const IN_FLIGHT: RunState[] = ["LEASED", "RUNNING", "VERIFYING"];

/** `off`: no deadline running yet. `spent`: the deadline passed; the runtime has not caught up. */
export type Clock = { kind: "off" } | { kind: "live"; leftMs: number } | { kind: "spent" };

/** A deadline we cannot read is no deadline: better silent than counting down to NaN. */
export const clockTo = (iso: string, offsetMs: number, now: number): Clock => {
  const deadline = Date.parse(iso) + offsetMs;
  if (Number.isNaN(deadline)) return { kind: "off" };
  // Whole seconds, rounded up: the last fraction of a second reads 0:01, so
  // only a genuinely spent deadline reads `spent`.
  const left = Math.ceil((deadline - now) / 1000) * 1000;
  return left <= 0 ? { kind: "spent" } : { kind: "live", leftMs: left };
};

/**
 * The two deadlines an in-flight attempt is racing, both from what the API
 * already serves:
 *
 * - the agent's budget — the worker hands `spec.timeoutSeconds` to the adapter
 *   when it starts the attempt and records TIMED_OUT if the child outlives it,
 *   so the deadline is `started_at + timeoutSeconds`, a shade early because
 *   workspace setup happens between the two;
 * - the lease — minted once at claim for the budget plus a fixed grace and
 *   never renewed, so when it passes `reapExpiredLeases` re-queues the run
 *   whatever the worker believes it is doing.
 */
export function deadlinesOf(a: Attempt, timeoutSeconds: number, now: number): { timeout: Clock; lease: Clock } {
  return {
    timeout: a.started_at ? clockTo(a.started_at, timeoutSeconds * 1000, now) : { kind: "off" },
    lease: a.lease_expires_at ? clockTo(a.lease_expires_at, 0, now) : { kind: "off" },
  };
}

/** One hue per clock, so the countdown and the meter never disagree. */
const budgetHue = (c: Clock, timeoutSeconds: number): string | undefined => {
  if (c.kind === "spent") return "var(--hue-err)";
  // The last tenth of the declared budget — long enough to notice on a long run.
  if (c.kind === "live" && c.leftMs <= timeoutSeconds * 100) return "var(--hue-warn)";
  return undefined;
};

/**
 * How long this agent has left before the worker stops it. The arithmetic is
 * local and the verdict stays the runtime's: a spent budget says so rather than
 * claiming the run is TIMED_OUT, which is the state badge's call on the next poll.
 */
export function BudgetClock({ c, timeoutSeconds }: { c: Clock; timeoutSeconds: number }) {
  const budget = `${timeoutSeconds}s budget`;
  if (c.kind === "off")
    return (
      <span className="text-(--text-faint)" title={`${budget}, not started`}>
        {budget}, not started
      </span>
    );
  const hue = budgetHue(c, timeoutSeconds);
  if (c.kind === "spent")
    return (
      <span style={{ color: hue }} title="budget spent">
        budget spent
      </span>
    );
  return (
    <span style={{ color: hue }} title={`timeout in ${dur(c.leftMs)}`}>
      timeout in {dur(c.leftMs)}
    </span>
  );
}

export function LeaseClock({ c, urgent }: { c: Clock; urgent: boolean }) {
  if (c.kind === "off") return <span title="no lease">no lease</span>;
  if (c.kind === "spent")
    return (
      <span style={{ color: "var(--hue-err)" }} title="reap due">
        reap due
      </span>
    );
  return (
    <span style={urgent ? { color: "var(--hue-warn)" } : undefined} title={`reaped in ${dur(c.leftMs)}`}>
      reaped in {dur(c.leftMs)}
    </span>
  );
}

/** How much of the budget is spent — the glance; `BudgetClock` is the number. */
function BudgetMeter({ c, timeoutSeconds }: { c: Clock; timeoutSeconds: number }) {
  if (c.kind === "off" || timeoutSeconds <= 0) return null;
  const spent = c.kind === "spent" ? 1 : 1 - c.leftMs / (timeoutSeconds * 1000);
  return (
    <div
      className="mt-2 h-1 overflow-hidden rounded-full bg-(--surface-2)"
      aria-hidden="true"
      title="share of the attempt budget already spent"
    >
      <div
        className="h-full rounded-full transition-[width,background-color] duration-1000 ease-linear"
        style={{
          width: `${Math.min(100, Math.max(2, spent * 100))}%`,
          background: budgetHue(c, timeoutSeconds) ?? "var(--hue-ok)",
        }}
      />
    </div>
  );
}

/** Terminal states whose reason is a failure the operator reads first (WM-93). */
const ERROR_STATES: RunState[] = ["FAILED", "TIMED_OUT", "REFUSED"];

/**
 * Why the run ended badly, surfaced first (WM-93): a FAILED/TIMED_OUT/REFUSED
 * run's reason used to live only in the last LIFECYCLE row, below the spec
 * JSON. Derived from the same lifecycle data the LIFECYCLE section renders —
 * the last transition into the current terminal state — no new API surface.
 * Renders nothing for any other state.
 */
export function RunFailureBanner({
  state,
  lifecycle,
  className = "mb-4",
}: {
  state: RunState;
  lifecycle: LifecycleEvent[];
  className?: string;
}) {
  if (!ERROR_STATES.includes(state)) return null;
  const terminal = [...lifecycle].reverse().find((e) => e.to_state === state);
  const reason = terminal?.reason ?? null;
  const hue = state === "REFUSED" ? "var(--hue-warn)" : "var(--hue-err)";
  return (
    <div
      role="alert"
      className={`rounded-md border p-3 ${className}`}
      style={{ borderColor: hue, background: `color-mix(in oklch, ${hue} 8%, var(--surface-1))` }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <div
          className="mono text-[12px] leading-relaxed break-words whitespace-pre-wrap font-medium flex-1"
          style={{ color: hue }}
        >
          {reason ?? "No reason recorded on the terminal transition."}
        </div>
        {reason && (
          <button
            type="button"
            onClick={() => copyText(reason, "failure reason")}
            className="shrink-0 cursor-pointer text-[11px] text-(--text-faint) hover:text-(--text) hover:underline"
          >
            Copy reason
          </button>
        )}
      </div>
    </div>
  );
}

export function isWorkerId(actor: string): boolean {
  return /^worker_.+/.test(actor);
}

export function ActorRef({
  actor,
  className,
  title = actor,
}: {
  actor: string;
  className?: string;
  title?: string;
}) {
  if (!isWorkerId(actor)) return <span title={title}>{actor}</span>;
  return (
    <JumpLink
      onClick={() => {
        window.location.hash = `#/${withProject(hashPath("workers", actor), hashProject(window.location.hash))}`;
      }}
      title={title}
      className={className}
    >
      {shortId(actor)}
    </JumpLink>
  );
}

const isTextArtifact = (k: string) =>
  /^(transcript|diff|report|evidence)$/i.test(k) || /\.(txt|json|jsonl|md|log)$/i.test(k);

export function ArtifactRow({ a }: { a: ArtifactRef }) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textFriendly = isTextArtifact(a.kind);

  const togglePreview = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (content === null && !loading) {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(artifactUrl(a.sha256));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const txt = await res.text();
        setContent(txt);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    }
  };

  return (
    <div className="border-b border-(--border) py-1.5 last:border-0">
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate">
          {a.kind}
          <span className="mono ml-2 text-[11px] text-(--text-faint)" title={a.sha256}>
            {a.sha256.slice(0, 12)}
          </span>
        </span>
        <span className="flex shrink-0 items-baseline gap-3">
          <span className="tabular-nums text-(--text-faint)">{humanSize(a.sizeBytes)}</span>
          {textFriendly && (
            <button
              type="button"
              onClick={togglePreview}
              className="text-[12px] text-(--text-dim) hover:text-(--accent)"
            >
              {open ? "Hide" : "Preview"}
            </button>
          )}
          <a
            href={artifactUrl(a.sha256, a.kind)}
            target="_blank"
            rel="noreferrer"
            className="text-(--accent) hover:underline"
          >
            Open
          </a>
        </span>
      </div>
      {open && (
        <div className="mt-2">
          {loading && <div className="text-[11px] text-(--text-faint)">Loading artifact preview…</div>}
          {error && (
            <div className="text-[11px] text-(--hue-err)">
              Failed to load preview: {error}
            </div>
          )}
          {content !== null && (
            <pre className="mono max-h-64 overflow-auto rounded-md border border-(--border) bg-(--surface-0) p-2.5 text-[11.5px] leading-relaxed whitespace-pre-wrap">
              {content}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The adapters that take a model at all — the web-side mirror of
 * `MODEL_ADAPTERS` in `event-runtime/lib/registry.mjs` (WM-135), same set the
 * Agents view mirrors for its Model column (WM-211).
 */
export const MODEL_ADAPTERS = new Set(["claude", "pi"]);

/**
 * The sentinel a tier resolves to when the answer is "let the CLI decide"
 * (`config/policy.yaml` models map). Both adapters treat it as "pass no
 * `--model`", so it is a real pin with an unknowable value, not a missing one.
 */
export const DEFAULT_MODEL = "default";

/** Rendered for the sentinel and for a spec that pins nothing: same outcome. */
const DEFAULT_MODEL_TEXT = "default (CLI)";

/**
 * What the spec pinned, as an operator reads it (WM-221). Every branch renders
 * a word: an empty model cell is the ambiguity this row exists to remove.
 *
 * - a non-model adapter has no model *by construction* → `n/a`
 * - the `default` sentinel, and a spec that declares nothing at all, both mean
 *   the CLI chose → `default (CLI)`; `model (observed)` is what it chose
 */
export const pinnedModelText = (adapter: string, model: string | null | undefined): string => {
  if (!MODEL_ADAPTERS.has(adapter)) return "n/a";
  return model == null || model === DEFAULT_MODEL ? DEFAULT_MODEL_TEXT : model;
};

/**
 * Declared intent — same split as `tierText` in the Agents view (WM-211): an
 * exact-id override answers for a definition that names no tier.
 */
export const modelTierText = (spec: Pick<RunSpec, "adapter" | "modelTier" | "model">): string => {
  if (spec.modelTier) return spec.modelTier;
  if (!MODEL_ADAPTERS.has(spec.adapter)) return "n/a";
  return spec.model ? "override" : "not declared";
};

/** Model detail rows need enough label width for `model (observed)` plus its icon. */
function ModelDetailRow({ label, value }: { label: string; value: ReactNode }) {
  const icon = attrIcon(label);
  return (
    <div className="grid grid-cols-[minmax(0,9.25rem)_minmax(0,1fr)] items-baseline gap-3 py-[3px]">
      <div className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-(--text-faint)" title={label}>
        <i className="inline-flex size-3.5 shrink-0 items-center justify-center not-italic [&>svg]:size-3.5" aria-hidden="true">
          {icon}
        </i>
        <span>{label}</span>
      </div>
      <div className="min-w-0 text-(--text-dim)">{value}</div>
    </div>
  );
}

/**
 * The model rows, next to `adapter` (WM-221): tier and pinned come from the
 * spec, observed from the transcript the runtime stored. A non-model adapter
 * collapses to one honest `n/a` row rather than three — a declared tier that
 * the adapter cannot use is named in its tooltip rather than dropped.
 */
function ModelRows({ spec, observed }: { spec: RunSpec; observed: string | null }) {
  if (!MODEL_ADAPTERS.has(spec.adapter)) {
    return (
      <KV
        k="model"
        v={
          <span
            className="text-(--text-dim)"
            title={
              spec.modelTier
                ? `Declared model_tier "${spec.modelTier}", but the ${spec.adapter} adapter runs a fixed argv, not a model.`
                : `The ${spec.adapter} adapter runs a fixed argv, not a model.`
            }
          >
            n/a
          </span>
        }
      />
    );
  }
  const pinned = pinnedModelText(spec.adapter, spec.model);
  return (
    <>
      <ModelDetailRow
        label="model tier"
        value={
          <span
            title={
              spec.modelTier
                ? "Declared intent, resolved to a model at plan time (WM-135)."
                : spec.model
                  ? "This definition names an exact model instead of a tier."
                  : "This definition declares no tier, so dispatch rides the CLI's own default."
            }
          >
            {modelTierText(spec)}
          </span>
        }
      />
      <ModelDetailRow
        label="model (pinned)"
        value={
          <ModelCell
            model={pinned}
            className={pinned === DEFAULT_MODEL_TEXT ? "" : "text-(--text-dim)"}
            title={
              pinned !== DEFAULT_MODEL_TEXT
                ? pinned
                : spec.model === DEFAULT_MODEL
                  ? "The tier resolved to the `default` sentinel: no --model is passed and the CLI picks."
                  : "This spec pins nothing, so no --model was passed and the CLI picked."
            }
          />
        }
      />
      <ModelDetailRow
        label="model (observed)"
        value={
          observed ? (
            <ModelCell model={observed} className="text-(--text-dim)" />
          ) : (
            <span className="text-(--text-faint)" title="No model id in this run's transcript — it may predate the capture, or none was stored.">
              not recorded
            </span>
          )
        }
      />
    </>
  );
}

/** A deep value on a glance row earns ~one line, no more; the RunSpec JSON has the rest. */
const compactValue = (v: unknown): string => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 120 ? `${s.slice(0, 117)}…` : s;
};

/**
 * `spec.input` promoted to first-class rows — it answers the glance question
 * "what is this run working on?" (repo, ticket, …), which used to be buried
 * two levels deep in the collapsed RunSpec JSON (WM-129). Flat object inputs
 * get one row per key; anything else gets a single `input` row.
 */
function InputRows({ input }: { input: unknown }) {
  if (input === undefined || input === null) return null;
  if (typeof input === "object" && !Array.isArray(input)) {
    const entries = Object.entries(input as Record<string, unknown>);
    if (entries.length === 0) return null;
    return (
      <>
        {entries.map(([k, v]) => (
          <KV key={k} k={`input.${k}`} v={compactValue(v)} />
        ))}
      </>
    );
  }
  return <KV k="input" v={compactValue(input)} />;
}

/**
 * The run detail blocks, shared verbatim between the Runs side panel and the
 * `#/run/:id` full page (WM-129) — one renderer, so the two views cannot
 * drift. Fields are tiered for glanceability: visible rows answer "what / for
 * what / how's it going" (agent, input, origin, clocks); hashes, keys, and
 * paths answer "prove it / debug it" and live in a collapsed `internals`
 * disclosure. Nothing is removed, only demoted — the immutable RunSpec JSON
 * stays as ground truth.
 */
export function RunDetailBlocks({
  d,
  now,
  origin,
  onJumpAgent,
  onJumpEvent,
  verbError,
  afterLifecycle,
}: {
  d: RunDetail;
  now: number;
  connected?: boolean;
  /** Origin event from the list join (not served by GET /runs/:id). */
  origin: { eventId?: string | null; eventSource?: string | null } | null;
  onJumpAgent: (ref: string) => void;
  onJumpEvent: (source: string, eventId: string) => void;
  onCancel?: () => void;
  onRetry?: () => void;
  onForceRetry?: () => void;
  retryPending?: boolean;
  verbError?: unknown;
  /** Panel slot for the inline RunTrace; the full page renders its trace in the main column. */
  afterLifecycle?: ReactNode;
}) {

  // The reaper keys off the run's current attempt (`a.attempt = r.attempts`),
  // so that is the only attempt whose deadlines are still running.
  const current = IN_FLIGHT.includes(d.run.state)
    ? (d.attempts.find((a) => a.attempt === d.run.attempts) ?? null)
    : null;
  const clocks = current ? deadlinesOf(current, d.run.spec.timeoutSeconds, now) : null;

  return (
    <>
      <Section title="Run" icons>
        <KV
          k="agent"
          v={
            <AgentHoverCard
              agentRef={d.run.spec.agent}
              onJumpAgent={onJumpAgent}
            />
          }
        />
        <KV k="adapter" v={d.run.spec.adapter} />
        {/* The harness is only half the answer: which model it ran is the
            other half, and it used to appear nowhere on the page (WM-221). */}
        <ModelRows spec={d.run.spec} observed={d.observedModel ?? null} />
        {/* A count, not an identifier — mono bought it nothing but a mismatched
            font next to "any worker" and "26m ago" on the rows around it. */}
        <KV k="attempts" v={`${d.run.attempts}/${d.run.spec.maxAttempts}`} mono={false} />
        <InputRows input={d.run.spec.input} />
        {origin?.eventId && (
          <KV
            k="origin event"
            v={
              origin.eventSource ? (
                <JumpLink
                  onClick={() => onJumpEvent(origin.eventSource!, origin.eventId!)}
                  title={origin.eventId}
                >
                  {`${origin.eventSource} · ${shortId(origin.eventId)}`}
                </JumpLink>
              ) : (
                <span title={origin.eventId}>{shortId(origin.eventId)}</span>
              )
            }
          />
        )}
        <KV k="created" v={<Ago iso={d.run.created_at} now={now} />} />
        <KV k="updated" v={<Ago iso={d.run.updated_at} now={now} />} />
        <KV k="placement" v={d.run.spec.placement ? JSON.stringify(d.run.spec.placement) : "any worker"} />
        <Disclosure label="internals — ids, hashes, paths">
          <KV k="run" v={d.run.runId} />
          <KV k="idempotencyKey" v={d.run.idempotencyKey} />
          <KV k="specHash" v={d.run.specHash} />
          <KV k="inputHash" v={d.run.spec.inputHash} />
          {d.workspace && <KV k="workspace" v={d.workspace} />}
          <KV k="promptVersion" v={d.run.spec.promptVersion} />
          <KV k="policyVersion" v={d.run.spec.policyVersion} />
        </Disclosure>
        <Disclosure label="immutable RunSpec">
          <JsonBlock value={d.run.spec} />
        </Disclosure>
      </Section>

      {/* What a live run is racing, above the verbs: cancelling is the
          answer to a budget about to be spent on a hung agent. */}
      {current && clocks && (
        <Section title="Deadlines">
          <div className="py-1 tabular-nums" aria-live="off">
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-(--text-faint)">
                attempt #{current.attempt}{" "}
                {current.started_at ? (
                  <>
                    started <Ago iso={current.started_at} now={now} className="text-(--text-dim)" />
                  </>
                ) : (
                  "not started"
                )}
              </span>
              <BudgetClock c={clocks.timeout} timeoutSeconds={d.run.spec.timeoutSeconds} />
            </div>
            <BudgetMeter c={clocks.timeout} timeoutSeconds={d.run.spec.timeoutSeconds} />
            <div className="mt-2 flex items-baseline justify-between gap-4 text-[11px] text-(--text-faint)">
              <span className="flex items-baseline gap-1.5 truncate">
                lease owner
                {current.lease_owner ? (
                  <ActorRef actor={current.lease_owner} />
                ) : (
                  <span className="mono">unclaimed</span>
                )}
              </span>
              <LeaseClock c={clocks.lease} urgent={clocks.timeout.kind === "spent"} />
            </div>
            <div className="mt-2 text-[11px] text-(--text-faint)">
              The lease outlasts the budget by a fixed grace and is never renewed.
            </div>
          </div>
        </Section>
      )}

      <VerbError error={verbError} />

      <Section title="Lifecycle">
        <ol className="m-0 list-none p-0">
          {d.lifecycle.map((e, i) => {
            const prev = i > 0 ? d.lifecycle[i - 1] : null;
            // The lifecycle is a chain, so `from` is the previous row's `to` and
            // printing it on every line was pure redundancy — and, since state
            // names differ in length, it pushed each badge to a different x and
            // made the column look ragged. Only an actual break in the chain is
            // worth spelling out (WM-136).
            const jumped = prev != null && e.from_state !== prev.to_state;
            const hue = STATE_HUES[e.to_state] ?? "var(--hue-idle)";
            const time = new Date(e.at).toLocaleTimeString([], { hour12: false });
            const prevTime = prev ? new Date(prev.at).toLocaleTimeString([], { hour12: false }) : null;
            const isSameTime = prevTime !== null && time === prevTime;
            const deltaSeconds = prev
              ? Math.max(0, Math.round((new Date(e.at).getTime() - new Date(prev.at).getTime()) / 1000))
              : 0;
            return (
              <li key={e.seq} className="flex gap-2.5 py-1">
                <span className="mono w-[52px] shrink-0 pt-0.5 text-[11px] tabular-nums text-(--text-faint)" title={e.at}>
                  {isSameTime ? <span className="opacity-60">+{deltaSeconds}s</span> : time}
                </span>
                {/* Rail: a dot per transition, joined to the next one. */}
                <span className="relative flex w-2 shrink-0 justify-center" aria-hidden="true">
                  {i < d.lifecycle.length - 1 && (
                    <span className="absolute top-2.5 bottom-[-4px] w-px bg-(--border)" />
                  )}
                  <span className="relative mt-[7px] size-1.5 shrink-0 rounded-full" style={{ background: hue }} />
                </span>
                <span className="flex min-w-0 flex-1 items-start gap-x-2">
                  <span className="flex w-[100px] shrink-0 items-center gap-1">
                    {jumped && (
                      <span className="shrink-0 text-[10px] text-(--text-faint)" title={`from ${e.from_state ?? "·"}`}>
                        {e.from_state ?? "·"}→
                      </span>
                    )}
                    <StateBadge state={e.to_state} />
                  </span>
                  {/* WM-145: wrap the reason; title includes it, not actor alone. */}
                  <span
                    className="min-w-0 flex-1 break-words whitespace-pre-wrap text-[11.5px] leading-relaxed text-(--text-faint)"
                    title={e.reason ? `${e.actor} · ${e.reason}` : e.actor}
                  >
                    <ActorRef
                      actor={e.actor}
                      className="text-[11.5px]"
                      title={e.reason ? `${e.actor} · ${e.reason}` : e.actor}
                    />
                    {e.reason ? ` · ${e.reason}` : ""}
                  </span>
                </span>
              </li>
            );
          })}
        </ol>
      </Section>

      {afterLifecycle}

      {d.attempts.length > 0 && (
        <Section title="Attempts" card={false}>
          {d.attempts.map((a) => (
            <div key={a.attempt} className="mb-1.5 rounded-md border border-(--border) bg-(--surface-0) px-3 py-2 last:mb-0">
              <div className="flex items-center justify-between gap-2">
                <span className="mono text-[12px] font-medium text-(--text)">#{a.attempt}</span>
                {a.terminal_state ? (
                  <StateBadge state={a.terminal_state} />
                ) : (
                  <span className="text-[11px] text-(--text-faint)">in flight</span>
                )}
              </div>
              {a.reason_code && (
                <div className="mono mt-1 truncate text-[11px] text-(--hue-err)" title={a.reason_code}>
                  {a.reason_code}
                </div>
              )}
              {/* Label/value pairs at the panel's rhythm — the fields used to run
                  together on one faint line where the workspace path pushed the
                  owner off the edge (WM-136). */}
              <div className="mt-1.5 grid grid-cols-[minmax(0,4.5rem)_minmax(0,1fr)] items-baseline gap-x-3 gap-y-0.5 text-[11px] text-(--text-faint)">
                <span>owner</span>
                <span className="min-w-0 truncate" title={a.lease_owner ?? "unclaimed"}>
                  {a.lease_owner ? <ActorRef actor={a.lease_owner} /> : <span className="mono">unclaimed</span>}
                </span>
                {a.workspace_path && (
                  <>
                    <span>workspace</span>
                    <span className="mono min-w-0 truncate" title={a.workspace_path}>
                      {a.workspace_path}
                    </span>
                  </>
                )}
                {a.started_at && (
                  <>
                    <span>started</span>
                    <span className="min-w-0 truncate">
                      <Ago iso={a.started_at} now={now} />
                    </span>
                  </>
                )}
                {a.finished_at && (
                  <>
                    <span>finished</span>
                    <span className="min-w-0 truncate">
                      <Ago iso={a.finished_at} now={now} />
                    </span>
                  </>
                )}
              </div>
            </div>
          ))}
        </Section>
      )}

      {d.result && (
        <Section
          id="run-result"
          title={`Result · ${d.result.terminalState}${d.result.reasonCode ? ` · ${d.result.reasonCode}` : ""}`}
        >
          {d.result.artifact !== undefined ? (
            <Disclosure label="artifact" defaultOpen>
              <JsonBlock value={d.result.artifact} />
            </Disclosure>
          ) : (
            <Disclosure label="result" defaultOpen>
              <JsonBlock value={d.result} />
            </Disclosure>
          )}
          {d.result.evidence !== undefined && (
            <Disclosure label="evidence — what the agent claims it verified">
              <JsonBlock value={d.result.evidence} />
            </Disclosure>
          )}
        </Section>
      )}

      {d.result && (
        <Section title="Artifacts">
          {(d.result.artifacts ?? []).length === 0 ? (
            <div className="text-(--text-faint)">No stored artifacts.</div>
          ) : (
            <div>
              {(d.result.artifacts ?? []).map((a) => (
                <ArtifactRow key={a.sha256} a={a} />
              ))}
            </div>
          )}
        </Section>
      )}

      {d.receipt && (
        <Section title="Receipt">
          {Object.entries(d.receipt).map(([k, v]) => (
            <KV key={k} k={k} v={v} />
          ))}
        </Section>
      )}
    </>
  );
}
