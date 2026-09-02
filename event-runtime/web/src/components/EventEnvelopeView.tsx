import { useState } from "react";
import {
  ArtifactPanel,
  RawToggle,
  loadArtifactRaw,
  saveArtifactRaw,
} from "./ArtifactView";
import { FieldValue } from "./FieldValue";
import { JsonBlock } from "./ui";
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
  // Payload is only a nested record. Falling back to the envelope itself
  // would print schemaVersion / eventId / type as if they were payload fields.
  const payload = asRecord(asRecord(envelope)?.payload);

  if (inputView && payload) {
    return (
      <ArtifactPanel
        artifact={payload}
        view={inputView}
        raw={raw}
        onRawChange={setRaw}
        rawFallback={<JsonBlock value={envelope} />}
      />
    );
  }

  // No payload record: the envelope is the thing to read, not a field list
  // that relabels metadata as payload.
  if (!payload) return <JsonBlock value={envelope} />;
  const fields = payload;
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
        <dl className="space-y-1.5 text-[12px]" aria-label="Payload">
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
