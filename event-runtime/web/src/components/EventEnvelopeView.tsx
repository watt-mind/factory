import { useState, type ReactNode } from "react";
import {
  ArtifactPanel,
  RawToggle,
  loadArtifactRaw,
  saveArtifactRaw,
} from "./ArtifactView";
import { TicketHoverCard } from "./TicketHoverCard";
import { Ago, JsonBlock } from "./ui";
import type { ArtifactView } from "../types";

type Envelope = Record<string, unknown>;

function asRecord(value: unknown): Envelope | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Envelope)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : null;
}

function commitHref(repo: string | null, sha: string) {
  return repo ? `https://github.com/${repo}/commit/${sha}` : null;
}

function ExternalLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="mono text-(--accent) hover:underline"
    >
      {children}
    </a>
  );
}

/**
 * Operator-facing rendering for an admitted event's input envelope. Routes
 * with a declared input view keep the agent-authored presentation; all other
 * events get a compact formatter for the identifiers operators follow most.
 */
export function EventEnvelopeView({
  envelope,
  inputView,
  now,
}: {
  envelope: unknown;
  inputView?: ArtifactView | null;
  now: number;
}) {
  const [raw, setRawState] = useState(loadArtifactRaw);
  const setRaw = (next: boolean) => {
    saveArtifactRaw(next);
    setRawState(next);
  };
  const payload = asRecord(envelope)?.payload ?? envelope;

  if (inputView) {
    return (
      <ArtifactPanel
        artifact={payload}
        view={inputView}
        raw={raw}
        onRawChange={setRaw}
      />
    );
  }

  const fields = asRecord(payload);
  if (!fields) return <JsonBlock value={envelope} />;
  const repo = text(fields.repo);
  const runId = text(fields.runId);

  return (
    <div>
      <div className="mb-2 flex justify-end">
        <RawToggle raw={raw} onChange={setRaw} />
      </div>
      {raw ? (
        <JsonBlock value={envelope} />
      ) : (
        <dl className="space-y-1.5 text-[12px]">
          {Object.entries(fields).map(([key, value]) => (
            <div
              key={key}
              className="grid grid-cols-[minmax(0,9rem)_1fr] gap-x-3"
            >
              <dt className="truncate text-(--text-faint)" title={key}>
                {key}
              </dt>
              <dd className="min-w-0 break-words text-(--text-dim)">
                <FieldValue
                  field={key}
                  value={value}
                  repo={repo}
                  runId={runId}
                  now={now}
                />
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function FieldValue({
  field,
  value,
  repo,
  runId,
  now,
}: {
  field: string;
  value: unknown;
  repo: string | null;
  runId: string | null;
  now: number;
}) {
  const valueText = text(value);
  if (valueText === null) {
    return (
      <span className="mono whitespace-pre-wrap">{JSON.stringify(value)}</span>
    );
  }

  if (field === "repo") {
    return (
      <span className="flex flex-wrap gap-x-2">
        <ExternalLink href={`https://github.com/${valueText}`}>
          {valueText}
        </ExternalLink>
        {runId && (
          <ExternalLink
            href={`https://github.com/${valueText}/actions/runs/${runId}`}
          >
            run #{runId}
          </ExternalLink>
        )}
      </span>
    );
  }
  if (["ticket", "issue", "issueId"].includes(field))
    return <TicketHoverCard ticketId={valueText} />;
  if (["pr", "pullRequest", "prNumber"].includes(field)) {
    const number = valueText.replace(/^#/, "");
    return repo ? (
      <ExternalLink href={`https://github.com/${repo}/pull/${number}`}>
        #{number}
      </ExternalLink>
    ) : (
      valueText
    );
  }
  if (["commit", "sha", "headSha"].includes(field)) {
    const href = commitHref(repo, valueText);
    const label = valueText.slice(0, 8);
    return href ? <ExternalLink href={href}>{label}</ExternalLink> : label;
  }
  if (
    (field.endsWith("At") || field.endsWith("Time")) &&
    !Number.isNaN(Date.parse(valueText))
  )
    return <Ago iso={valueText} now={now} />;
  return valueText;
}
