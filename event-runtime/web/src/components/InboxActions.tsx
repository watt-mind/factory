import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { AdmittedEvent, InboxItem } from "../types";
import { Button, JumpLink, VerbError } from "./ui";

type ActionApi = Pick<
  typeof api,
  "events" | "replay" | "triggerSchedule" | "repos" | "schedules"
>;

const PLAIN_ACTION_KINDS = new Set([
  "human_needed",
  "CI RED",
  "RC READY",
  "ESCALATED",
  "SMOKE RED",
  "CIRCUIT BREAKER",
]);

const REFERENCED_EVENT_PAGE_LIMIT = 200;
const REFERENCED_EVENT_MAX_PAGES = 5;

// Jump chips read as links, not stray mono text: pill border + underline on hover.
const CHIP_CLASS =
  "inline-flex items-center rounded-full border border-(--border-strong) px-2 py-0.5 text-[11px] text-(--text) hover:border-(--accent) hover:underline";

export function hasInboxPlainActions(kind: string): boolean {
  return PLAIN_ACTION_KINDS.has(kind);
}

function referencedEvent(
  events: AdmittedEvent[],
  item: InboxItem,
): AdmittedEvent | null {
  if (!item.refs.eventSource || !item.refs.eventId) return null;
  return (
    events.find(
      (event) =>
        event.source === item.refs.eventSource &&
        event.eventId === item.refs.eventId,
    ) ?? null
  );
}

function payloadOf(event: AdmittedEvent | null): Record<string, unknown> {
  const payload = event?.envelope?.payload;
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function freshId(item: InboxItem, now: number): string {
  return `inbox-${item.id}-${now}`;
}

export function replayEnvelope(
  item: InboxItem,
  event: AdmittedEvent,
  now = Date.now(),
): Record<string, unknown> {
  return {
    ...event.envelope,
    eventId: freshId(item, now),
    source: "inbox",
    occurredAt: new Date(now).toISOString(),
    correlationId: item.id,
    causationId: event.eventId,
  };
}

/**
 * `factory.ci-rerun.requested` wants the GitHub `owner/name` slug, not the
 * config/repos.yaml short name most inbox refs carry; `slugFor` maps one to
 * the other (from `GET /repos`) when the referenced event has no slug of its
 * own.
 */
export function ciRerunEnvelope(
  item: InboxItem,
  event: AdmittedEvent | null,
  now = Date.now(),
  slugFor: (repo: string) => string | null = (repo) =>
    repo.includes("/") ? repo : null,
): Record<string, unknown> {
  const original = payloadOf(event);
  const ref = original.repo ?? item.refs.repo;
  if (typeof ref !== "string" || ref === "")
    throw new Error("Rerun CI needs a repository reference");
  const repo = ref.includes("/") ? ref : slugFor(ref);
  if (!repo)
    throw new Error(
      `Rerun CI needs the GitHub owner/name for "${ref}" — config/repos.yaml declares no github remote for it`,
    );
  const runId = original.runId ?? item.refs.runId;
  if (
    (typeof runId !== "string" && typeof runId !== "number") ||
    String(runId).trim() === ""
  ) {
    throw new Error("Rerun CI needs the failed workflow run reference");
  }
  const eventId = freshId(item, now);
  return {
    schemaVersion: "factory.event/v1",
    eventId,
    type: "factory.ci-rerun.requested",
    source: "inbox",
    subject: repo,
    occurredAt: new Date(now).toISOString(),
    correlationId: item.id,
    causationId: item.refs.eventId ?? null,
    payload: { repo, runId },
  };
}

export function InboxActions({
  item,
  connected,
  prUrl,
  onResolve,
  onItemChange,
  apiCalls = api,
  now = Date.now,
}: {
  item: InboxItem;
  connected: boolean;
  prUrl?: string | null;
  onResolve: () => void;
  onItemChange: () => void;
  apiCalls?: ActionApi;
  now?: () => number;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [completed, setCompleted] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const itemSnapshot = JSON.stringify(item);
  const previousItemSnapshot = useRef(itemSnapshot);

  useEffect(() => {
    if (previousItemSnapshot.current === itemSnapshot) return;
    previousItemSnapshot.current = itemSnapshot;
    setCompleted(null);
  }, [itemSnapshot]);

  const run = async (label: string, action: () => Promise<unknown>) => {
    setPending(label);
    setError(null);
    try {
      await action();
      setCompleted(label);
    } catch (err) {
      setError(err);
    } finally {
      setPending(null);
      onItemChange();
    }
  };

  const loadReferencedEvent = async () => {
    const status = item.kind === "human_needed" ? "human_needed" : undefined;
    let before: string | undefined;
    for (let page = 0; page < REFERENCED_EVENT_MAX_PAGES; page += 1) {
      const response = await apiCalls.events(status, {
        limit: REFERENCED_EVENT_PAGE_LIMIT,
        before,
      });
      const event = referencedEvent(response.events, item);
      if (event) return event;
      if (!response.nextBefore) break;
      before = response.nextBefore;
    }
    return null;
  };

  const replay = () =>
    run("Replay", async () => {
      const event = await loadReferencedEvent();
      if (!event)
        throw new Error(
          `Referenced event was not found within the ${REFERENCED_EVENT_MAX_PAGES}-page lookup bound`,
        );
      await apiCalls.replay(replayEnvelope(item, event, now()));
    });

  const rerunCi = () =>
    run("Rerun CI", async () => {
      const event =
        item.refs.eventSource && item.refs.eventId
          ? await loadReferencedEvent()
          : null;
      const { repos } = await apiCalls.repos();
      const slugFor = (name: string) =>
        repos.find((repo) => repo.name === name)?.github ?? null;
      await apiCalls.replay(ciRerunEnvelope(item, event, now(), slugFor));
    });

  const ship = () =>
    run("Ship", async () => {
      if (!item.refs.repo) throw new Error("Ship needs a repository reference");
      const loop = `ship-${item.refs.repo}`;
      const { schedules } = await apiCalls.schedules();
      if (!schedules.some((schedule) => schedule.loop === loop))
        throw new Error(
          `No ship schedule is configured for "${item.refs.repo}" (expected "${loop}" in event-runtime/schedules.json) — this repo cannot be shipped from the inbox`,
        );
      await apiCalls.triggerSchedule(loop);
    });

  const issueUrl = item.refs.issue
    ? `https://linear.app/watt-mind/issue/${encodeURIComponent(item.refs.issue)}`
    : null;
  const jumpChips =
    item.kind === "ESCALATED" ||
    item.kind === "SMOKE RED" ||
    item.kind === "CIRCUIT BREAKER";

  if (!hasInboxPlainActions(item.kind)) return null;

  const proposalCreated = completed !== null || Boolean(item.refs.proposalId);

  return (
    <div className="space-y-2 rounded-md border border-(--border) bg-(--surface-0) px-3 py-2.5">
      {item.kind === "ESCALATED" && (
        <p className="text-[12px] leading-relaxed text-(--text-dim)">
          This escalation must be reviewed at its source. The inbox deliberately
          cannot merge{" "}
          {prUrl ? "the pull request." : "or approve anything on its behalf."}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {jumpChips && prUrl && (
          <JumpLink
            href={prUrl}
            title="Open pull request"
            className={CHIP_CLASS}
          >
            Open PR
          </JumpLink>
        )}
        {jumpChips && issueUrl && (
          <JumpLink
            href={issueUrl}
            title="Open issue in Linear"
            className={CHIP_CLASS}
          >
            Open issue
          </JumpLink>
        )}
        {item.kind === "human_needed" && (
          <Button
            disabled={!connected || pending !== null || completed === "Replay"}
            onClick={() => void replay()}
          >
            {pending === "Replay"
              ? "Replaying…"
              : completed === "Replay"
                ? "Replayed"
                : "Replay"}
          </Button>
        )}
        {item.kind === "CI RED" && !proposalCreated && (
          <Button
            variant="primary"
            disabled={!connected || pending !== null}
            onClick={() => void rerunCi()}
          >
            {pending === "Rerun CI" ? "Injecting…" : "Rerun CI"}
          </Button>
        )}
        {item.kind === "RC READY" && !proposalCreated && (
          <Button
            variant="primary"
            disabled={!connected || pending !== null}
            onClick={() => void ship()}
          >
            {pending === "Ship" ? "Starting…" : "Ship"}
          </Button>
        )}
        {(item.kind === "CI RED" || item.kind === "RC READY") &&
          proposalCreated &&
          (item.refs.proposalId ? (
            <JumpLink
              href={`#/proposals/${encodeURIComponent(item.refs.proposalId)}`}
              title="Open the watched proposal"
              className={CHIP_CLASS}
            >
              Open proposal
            </JumpLink>
          ) : (
            <span className="text-[12px] font-medium text-(--hue-ok)">
              Request created
            </span>
          ))}
        {(item.kind === "SMOKE RED" || item.kind === "CIRCUIT BREAKER") && (
          <Button disabled={!connected || pending !== null} onClick={onResolve}>
            Resolve…
          </Button>
        )}
      </div>
      {error != null && <VerbError error={error} />}
    </div>
  );
}
