/**
 * FieldValue — the shared formatter for generic (viewless) payload rendering.
 *
 * Both generic payload paths render through it — `EventPanel`'s field list
 * and `ArtifactView`'s `PayloadFields` — so an operator sees the same
 * ticket hover cards, PR/commit links and relative timestamps wherever an
 * event's payload is shown. It lives in its own module so neither renderer
 * has to import the other.
 */
import type { ReactNode } from "react";
import { TicketHoverCard } from "./TicketHoverCard";
import { Ago } from "./ui";

export function fieldText(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : null;
}

function commitHref(repo: string | null, sha: string) {
  return repo ? `https://github.com/${repo}/commit/${sha}` : null;
}

export function ExternalLink({
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

export function FieldValue({
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
  if (value === undefined) {
    return <span className="text-(--text-faint)">—</span>;
  }
  const valueText = fieldText(value);
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
