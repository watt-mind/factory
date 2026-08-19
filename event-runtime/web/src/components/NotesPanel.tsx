/**
 * Read-only Notes panel (docs/event-runtime-memos.md §8, WM-814).
 *
 * Live memos for a subject (ticket / repo / PR / run), with provenance,
 * bindings, use counts, and an expired toggle that reveals retired and
 * superseded rows struck through. There is no write control here.
 */
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { refetchIntervals, useNow } from "../hooks";
import { Ago, JumpLink, Section, shortId } from "./ui";

export type MemoSubject = { type: string; id: string };

export interface MemoUse {
  runId: string;
  verdict: string | null;
  runState: string;
  at: string;
}

export interface MemoEntry {
  sha256: string;
  subject: MemoSubject;
  kind: string;
  live: boolean;
  body: string | null;
  claim?: { kind: string; text: string } | null;
  evidence?: string | null;
  precedentOnly?: boolean;
  bindings?: {
    descriptionHash?: string;
    headSha?: string;
    expiresAt?: string;
  } | null;
  provenance?: {
    runId?: string | null;
    agent?: string | null;
    createdAt?: string;
  } | null;
  runId?: string | null;
  inboxItemId?: string | null;
  createdAt?: string;
  expiresAt?: string | null;
  supersededBy?: string | null;
  retiredAt?: string | null;
  retiredReason?: string | null;
  usefulCount?: number;
  wrongCount?: number;
  uses?: MemoUse[];
}

/** Subjects the run detail pane should query: ticket, repo, then the run itself. */
export function subjectsFromRunInput(
  input: unknown,
  runId: string,
): MemoSubject[] {
  const subjects: MemoSubject[] = [];
  const rec =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  if (typeof rec.ticket === "string" && rec.ticket.trim()) {
    subjects.push({ type: "ticket", id: rec.ticket.trim() });
  }
  if (typeof rec.repo === "string" && rec.repo.trim()) {
    subjects.push({ type: "repo", id: rec.repo.trim() });
  }
  if (typeof rec.pr === "string" && rec.pr.trim()) {
    subjects.push({ type: "pr", id: rec.pr.trim() });
  }
  subjects.push({ type: "run", id: runId });
  return subjects;
}

export function memoPinShas(input: unknown): string[] {
  const rec =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const pin = rec.memoPin;
  if (!pin || typeof pin !== "object" || Array.isArray(pin)) return [];
  const entries = (pin as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (entry && typeof entry === "object" && "sha256" in entry) {
        const sha = (entry as { sha256?: unknown }).sha256;
        return typeof sha === "string" ? sha : "";
      }
      return "";
    })
    .filter((sha) => sha.length > 0);
}

async function fetchMemos(
  subject: MemoSubject,
  live: boolean,
): Promise<MemoEntry[]> {
  const query = new URLSearchParams({
    subjectType: subject.type,
    subjectId: subject.id,
    live: live ? "true" : "false",
  });
  try {
    const res = await fetch(`/api/memos?${query.toString()}`, {
      cache: "no-store",
    });
    if (!res.ok) return [];
    const json: unknown = await res.json();
    const memos =
      json && typeof json === "object" && "memos" in json
        ? (json as { memos?: unknown }).memos
        : null;
    return Array.isArray(memos) ? (memos as MemoEntry[]) : [];
  } catch {
    return [];
  }
}

function provenanceLabel(memo: MemoEntry): string {
  const agent = memo.provenance?.agent;
  if (memo.inboxItemId && (!memo.runId || agent === "runtime:inbox")) {
    return `operator decision, inbox item ${memo.inboxItemId}`;
  }
  if (agent && memo.runId) return `${agent}`;
  if (agent) return agent;
  return "unknown producer";
}

function bindingState(memo: MemoEntry): string | null {
  if (memo.retiredReason) return memo.retiredReason.replaceAll("_", " ");
  if (memo.supersededBy) return "superseded";
  if (!memo.live && memo.expiresAt) return "expired";
  return null;
}

function MemoCard({
  memo,
  read,
  wrote,
  now,
}: {
  memo: MemoEntry;
  read: boolean;
  wrote: boolean;
  now: number;
}) {
  const dead = !memo.live;
  const state = bindingState(memo);
  const sha = memo.sha256.slice(0, 12);
  return (
    <article
      className={`border-b border-(--border) py-2 last:border-b-0 ${dead ? "opacity-70" : ""}`}
    >
      <div
        className={`flex flex-wrap items-baseline gap-x-2 gap-y-0.5 ${dead ? "line-through" : ""}`}
      >
        <span className="text-[11px] font-medium tracking-wide text-(--text-faint) uppercase">
          {memo.kind}
        </span>
        <span className="mono text-[11px] text-(--text-dim)">
          {memo.subject.type}:{memo.subject.id}
        </span>
        {read && (
          <span className="text-[11px] tracking-wide text-(--text-faint) uppercase">
            read
          </span>
        )}
        {wrote && (
          <span className="text-[11px] tracking-wide text-(--text-faint) uppercase">
            wrote
          </span>
        )}
        {memo.precedentOnly && (
          <span className="text-[11px] tracking-wide text-(--hue-warn) uppercase">
            precedent only
          </span>
        )}
      </div>
      <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-[11px] text-(--text-dim)">
        <span>{provenanceLabel(memo)}</span>
        {memo.runId && (
          <JumpLink
            href={`#/runs/${encodeURIComponent(memo.runId)}`}
            title={memo.runId}
          >
            {shortId(memo.runId)}
          </JumpLink>
        )}
        {memo.createdAt && <Ago iso={memo.createdAt} now={now} />}
        <span className="mono text-(--text-faint)" title={memo.sha256}>
          {sha}
        </span>
      </div>
      <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-(--text-faint)">
        <span>
          {memo.usefulCount ?? 0} useful · {memo.wrongCount ?? 0} wrong
        </span>
        {memo.expiresAt && (
          <span title={memo.expiresAt}>
            expires {memo.expiresAt.slice(0, 10)}
          </span>
        )}
        {state && <span>{state}</span>}
      </div>
      {memo.body && (
        <p
          className={`mt-1 whitespace-pre-wrap text-[12px] text-(--text) ${dead ? "line-through" : ""}`}
        >
          {memo.body}
        </p>
      )}
      {memo.claim?.text && memo.claim.text !== memo.body && (
        <p className="mt-1 text-[12px] text-(--text-dim)">{memo.claim.text}</p>
      )}
    </article>
  );
}

export function NotesPanel({
  subjects: explicitSubjects,
  readShas: explicitReadShas,
  wroteRunId,
  runInput,
  runId,
}: {
  subjects?: readonly MemoSubject[];
  /** Memo hashes this run read (`memoPin`); tagged "read" when present. */
  readShas?: readonly string[];
  /** Producer run id; matching memos are tagged "wrote". */
  wroteRunId?: string | null;
  /** Run spec input — used to derive subjects and readShas when subjects are not passed. */
  runInput?: unknown;
  /** Run id — used to derive subjects when runInput is passed. */
  runId?: string;
}) {
  const now = useNow();
  const [showExpired, setShowExpired] = useState(false);
  const subjects = useMemo(() => {
    if (explicitSubjects) return explicitSubjects;
    if (runInput !== undefined && runId !== undefined) {
      return subjectsFromRunInput(runInput, runId);
    }
    return [];
  }, [explicitSubjects, runInput, runId]);

  const readShas = useMemo(() => {
    if (explicitReadShas) return explicitReadShas;
    if (runInput !== undefined) {
      return memoPinShas(runInput);
    }
    return [];
  }, [explicitReadShas, runInput]);

  const key = subjects.map((s) => `${s.type}:${s.id}`).join("|");
  const query = useQuery({
    queryKey: ["memos", key, showExpired],
    queryFn: async () => {
      const batches = await Promise.all(
        subjects.map((subject) => fetchMemos(subject, !showExpired)),
      );
      const seen = new Set<string>();
      const merged: MemoEntry[] = [];
      for (const batch of batches) {
        for (const memo of batch) {
          if (!memo?.sha256 || seen.has(memo.sha256)) continue;
          seen.add(memo.sha256);
          merged.push(memo);
        }
      }
      merged.sort((a, b) => {
        const useful = (b.usefulCount ?? 0) - (a.usefulCount ?? 0);
        if (useful !== 0) return useful;
        return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
      });
      return merged;
    },
    enabled: subjects.length > 0,
    ...refetchIntervals.secondary,
  });

  const read = useMemo(() => new Set(readShas), [readShas]);
  const memos = query.data ?? [];

  if (subjects.length === 0) return null;

  return (
    <Section title="Notes" id="notes">
      <label className="mb-2 flex cursor-pointer items-center gap-2 py-1 text-[12px] text-(--text-dim)">
        <input
          type="checkbox"
          checked={showExpired}
          onChange={(e) => setShowExpired(e.target.checked)}
          aria-label="Show expired and superseded notes"
        />
        Show expired
      </label>
      {query.isPending && memos.length === 0 ? (
        <div className="py-1 text-[11px] text-(--text-faint)">
          Loading notes…
        </div>
      ) : memos.length === 0 ? (
        <div className="py-1 text-[11px] text-(--text-faint)">
          {showExpired ? "No notes for this subject." : "No live notes."}
        </div>
      ) : (
        memos.map((memo) => (
          <MemoCard
            key={memo.sha256}
            memo={memo}
            read={read.has(memo.sha256)}
            wrote={Boolean(wroteRunId) && memo.runId === wroteRunId}
            now={now}
          />
        ))
      )}
    </Section>
  );
}
