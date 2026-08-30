import { useEffect, useId, useMemo, useState } from "react";
import { keyGuard, modal } from "../hooks";
import { goPrefixActive } from "../goSequence";
import {
  ApiError,
  decideInboxItem,
  getInboxItem,
  retryInboxDecision,
} from "../api";
import type {
  DecisionField,
  DecisionRequest,
  DecisionResponseInput,
  InboxDecisionResponse,
  InboxItem,
  InboxRefs,
} from "../types";
import {
  applicableFields,
  fieldErrors,
  initialValues,
  type DecisionValues,
} from "../lib/decisionForm";
import { decisionRequestHash } from "../lib/decision";
import { MarkdownView } from "./RunTrace";
import { Button, JumpLink, shortId } from "./ui";

const LINEAR_ISSUE_URL = "https://linear.app/watt-mind/issue/";

export interface DecisionCardProps {
  itemId: string;
  request: DecisionRequest;
  response?: InboxDecisionResponse | null;
  refs?: InboxRefs;
  onJumpProposal?: (id: string) => void;
  connected?: boolean;
  onItemChange?: (item: InboxItem) => void;
  apiCalls?: {
    get: typeof getInboxItem;
    decide: typeof decideInboxItem;
    retry: typeof retryInboxDecision;
  };
}

const controlClass =
  "w-full rounded-md border border-(--border-strong) bg-(--surface-0) px-2.5 py-1.5 text-[12px] text-(--text) outline-none placeholder:text-(--text-faint) focus:border-(--accent)";

function DecisionCardRefs({
  refs,
  onJumpProposal,
}: {
  refs: InboxRefs;
  onJumpProposal?: (id: string) => void;
}) {
  if (!refs.issue && !refs.proposalId) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
      {refs.issue && (
        <JumpLink
          href={`${LINEAR_ISSUE_URL}${encodeURIComponent(refs.issue)}`}
          title="Open in Linear"
        >
          {refs.issue}
        </JumpLink>
      )}
      {refs.proposalId &&
        (onJumpProposal ? (
          <JumpLink
            onClick={() => onJumpProposal(refs.proposalId!)}
            title={`Open proposal ${refs.proposalId}`}
          >
            {shortId(refs.proposalId)}
          </JumpLink>
        ) : (
          <span className="mono text-(--text-dim)" title={refs.proposalId}>
            {shortId(refs.proposalId)}
          </span>
        ))}
    </div>
  );
}

function responseFields(
  request: DecisionRequest,
  optionId: string,
  values: DecisionValues,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const field of applicableFields(request, optionId)) {
    const value = values[field.id];
    const empty =
      value === "" ||
      value === undefined ||
      (Array.isArray(value) && value.length === 0) ||
      (field.kind === "confirm" && value === false);
    if (!empty || field.required) fields[field.id] = value;
  }
  return fields;
}

function displayValue(
  field: DecisionField | undefined,
  value: unknown,
): string {
  if (field?.kind === "single-choice")
    return (
      field.choices.find((choice) => choice.id === value)?.label ??
      String(value)
    );
  if (field?.kind === "multi-choice" && Array.isArray(value))
    return value
      .map(
        (id) =>
          field.choices.find((choice) => choice.id === id)?.label ?? String(id),
      )
      .join(", ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

export function DecisionCard({
  itemId,
  request,
  response = null,
  refs = {},
  onJumpProposal,
  connected = true,
  onItemChange,
  apiCalls = {
    get: getInboxItem,
    decide: decideInboxItem,
    retry: retryInboxDecision,
  },
}: DecisionCardProps) {
  const requestHash = decisionRequestHash(request);
  const [currentRequest, setCurrentRequest] = useState(request);
  const [currentResponse, setCurrentResponse] = useState(response);
  const [selected, setSelected] = useState<string | null>(null);
  const [values, setValues] = useState<DecisionValues>(() =>
    initialValues(request),
  );
  const [touchedFields, setTouchedFields] = useState<Set<string>>(
    () => new Set(),
  );
  const [pending, setPending] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Reset the card when it is pointed at a different item, a changed request,
  // or a fresh response from the parent's refetch — during render, per the
  // React "adjusting state when a prop changes" pattern, not in an effect.
  const [tracked, setTracked] = useState({ itemId, requestHash, response });
  if (
    tracked.itemId !== itemId ||
    tracked.requestHash !== requestHash ||
    tracked.response !== response
  ) {
    setTracked({ itemId, requestHash, response });
    setCurrentRequest(request);
    setCurrentResponse(response);
    setSelected(null);
    setValues(initialValues(request));
    setTouchedFields(new Set());
    setMessage(null);
  }

  const options = useMemo(() => {
    const recommended = currentRequest.recommended;
    return [...currentRequest.options].sort((left, right) => {
      if (left.id === recommended) return -1;
      if (right.id === recommended) return 1;
      return 0;
    });
  }, [currentRequest]);
  const visibleFields = selected
    ? applicableFields(currentRequest, selected)
    : [];
  const errors = selected ? fieldErrors(currentRequest, selected, values) : {};
  const invalidReason = !selected
    ? "Choose an option to continue."
    : (Object.values(errors)[0] ?? null);
  // Text-field errors are shown inline once the field is touched; keep them
  // out of the status line only while that inline hint is actually rendered.
  const statusReason = !selected
    ? invalidReason
    : (visibleFields
        .filter(
          (field) => !(field.kind === "text" && touchedFields.has(field.id)),
        )
        .map((field) => errors[field.id])
        .find((error) => error !== undefined) ?? null);

  const refresh = async (): Promise<InboxItem> => {
    const { item } = await apiCalls.get(itemId);
    if (item.decision) setCurrentRequest(item.decision);
    setCurrentResponse(item.response ?? null);
    onItemChange?.(item);
    return item;
  };

  const submit = async () => {
    if (!selected || invalidReason || pending || !connected) return;
    setPending(true);
    setMessage(null);
    const body: DecisionResponseInput = {
      schemaVersion: "factory.decision-response/v1",
      requestHash: decisionRequestHash(currentRequest),
      optionId: selected,
      fields: responseFields(currentRequest, selected, values),
    };
    try {
      await apiCalls.decide(itemId, body);
      await refresh();
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.status === 409 &&
        error.message === "stale_request"
      ) {
        const item = await refresh();
        const nextRequest = item.decision ?? currentRequest;
        setSelected(null);
        setValues(initialValues(nextRequest));
        setTouchedFields(new Set());
        setMessage("This question changed — please re-read");
      } else {
        setMessage((error as Error).message);
      }
    } finally {
      setPending(false);
    }
  };

  const retry = async () => {
    if (retrying || !connected) return;
    setRetrying(true);
    setMessage(null);
    try {
      await apiCalls.retry(itemId);
      await refresh();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setRetrying(false);
    }
  };

  const update = (id: string, value: unknown) => {
    setTouchedFields((previous) => new Set(previous).add(id));
    setValues((previous) => ({ ...previous, [id]: value }));
  };

  // While an undecided card is on screen:
  // - Number keys 1–6 pick options from anywhere in the view (when not editing an input).
  // - Enter (outside multiline textarea) or Cmd+Enter / Ctrl+Enter submits the decision when valid.
  // Capture phase on window so the Inbox status-tab binding (bubble phase on window) never sees them;
  // text fields, modifiers and the `g` prefix still win for single-key number shortcuts.
  const undecided = !currentResponse;
  useEffect(() => {
    if (!undecided) return;
    function onKey(event: KeyboardEvent) {
      if (modal.depth > 0 || goPrefixActive()) return;

      const isModEnter =
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        event.key === "Enter";
      const isPlainEnter =
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        event.key === "Enter";

      if (isModEnter || isPlainEnter) {
        const target = event.target as HTMLElement | null;
        const isTextarea = Boolean(
          target?.closest("textarea, [contenteditable='true']"),
        );
        if (isPlainEnter && isTextarea) return;
        if (!selected || invalidReason !== null || pending || !connected)
          return;
        event.preventDefault();
        event.stopPropagation();
        void submit();
        return;
      }

      if (keyGuard(event)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const number = Number(event.key);
      if (number < 1 || number > 6 || !options[number - 1]) return;
      event.preventDefault();
      event.stopPropagation();
      setSelected(options[number - 1].id);
      setMessage(null);
    }
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, [
    undecided,
    options,
    selected,
    invalidReason,
    pending,
    connected,
    currentRequest,
    values,
  ]);

  if (currentResponse) {
    if ("superseded" in currentResponse) {
      return (
        <section
          aria-label="Decision record"
          className="rounded-md border border-(--border) bg-(--surface-0) p-3"
        >
          <h2 className="text-[14px] font-semibold text-(--text)">
            {currentRequest.question}
          </h2>
          <DecisionCardRefs refs={refs} onJumpProposal={onJumpProposal} />
          <div className="mt-3 rounded-md bg-(--surface-1) p-3 text-[12px]">
            <div className="font-semibold text-(--text)">
              This question no longer needs an answer.
            </div>
            <div className="mt-1 text-(--text-dim)">
              Superseded by {currentResponse.decidedBy} ·{" "}
              {new Date(currentResponse.decidedAt).toLocaleString()}
            </div>
            <div className="mono mt-2 text-[11px] text-(--text-faint)">
              {currentResponse.reason}
            </div>
          </div>
        </section>
      );
    }
    const option = currentRequest.options.find(
      (candidate) => candidate.id === currentResponse.optionId,
    );
    const fieldsById = new Map(
      (currentRequest.fields ?? []).map((field) => [field.id, field]),
    );
    // Anything the runtime did not apply is retryable (the server's own rule
    // for /decide/retry is "not already applied"), so gate on that rather
    // than the single "failed" value — WM-390's stub still answers
    // "unsupported" for most effects until WM-391 lands.
    const failed =
      currentResponse.effect !== undefined &&
      currentResponse.effect !== null &&
      currentResponse.effect.outcome !== "applied";
    return (
      <section
        aria-label="Decision record"
        className="rounded-md border border-(--border) bg-(--surface-0) p-3"
      >
        <h2 className="text-[14px] font-semibold text-(--text)">
          {currentRequest.question}
        </h2>
        <DecisionCardRefs refs={refs} onJumpProposal={onJumpProposal} />
        <div className="mt-3 rounded-md bg-(--surface-1) p-3 text-[12px]">
          <div className="font-semibold text-(--text)">
            {option?.label ?? currentResponse.optionId}
          </div>
          <div className="mt-1 text-(--text-dim)">
            Decided by {currentResponse.decidedBy} ·{" "}
            {new Date(currentResponse.decidedAt).toLocaleString()}
          </div>
          {Object.entries(currentResponse.fields).length > 0 && (
            <dl className="mt-3 space-y-1.5">
              {Object.entries(currentResponse.fields).map(([id, value]) => (
                <div key={id}>
                  <dt className="text-[11px] text-(--text-faint)">
                    {fieldsById.get(id)?.label ?? id}
                  </dt>
                  <dd className="whitespace-pre-wrap break-words text-(--text)">
                    {displayValue(fieldsById.get(id), value)}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {currentResponse.effect && (
            <div
              className="mt-3 rounded border px-2.5 py-2"
              style={{
                borderColor: failed ? "var(--hue-err)" : "var(--hue-ok)",
                color: failed ? "var(--hue-err)" : "var(--hue-ok)",
              }}
            >
              Effect {currentResponse.effect.outcome}
              {currentResponse.effect.error
                ? ` — ${currentResponse.effect.error}`
                : ""}
            </div>
          )}
          {failed && (
            <div className="mt-3">
              <Button
                variant="danger"
                disabled={!connected || retrying}
                onClick={() => void retry()}
              >
                {retrying ? "Retrying…" : "Retry"}
              </Button>
            </div>
          )}
          {message && <div className="mt-2 text-(--hue-err)">{message}</div>}
        </div>
      </section>
    );
  }

  return (
    <section
      aria-label="Decision"
      className="rounded-md border border-(--border) bg-(--surface-0) p-3"
    >
      <h2 className="text-[14px] font-semibold text-(--text)">
        {currentRequest.question}
      </h2>
      <DecisionCardRefs refs={refs} onJumpProposal={onJumpProposal} />
      {currentRequest.context && (
        <MarkdownView
          text={currentRequest.context}
          allowToggle={false}
          className="mt-2"
        />
      )}

      <div className="mt-3 space-y-1.5" role="group" aria-label="Options">
        {options.map((option, index) => {
          const chosen = option.id === selected;
          const tone = option.tone ?? "neutral";
          const hue =
            tone === "primary"
              ? "var(--accent)"
              : tone === "danger"
                ? "var(--hue-err)"
                : "var(--border-strong)";
          return (
            <button
              key={option.id}
              type="button"
              aria-pressed={chosen}
              onClick={() => {
                setSelected(option.id);
                setMessage(null);
              }}
              className="flex w-full cursor-pointer items-start gap-2 rounded-md border bg-(--surface-1) px-2.5 py-2 text-left text-[12px] outline-none hover:bg-(--surface-2) focus-visible:ring-2 focus-visible:ring-(--accent)"
              style={{
                borderColor: chosen ? hue : "var(--border)",
                boxShadow: chosen ? `inset 3px 0 ${hue}` : undefined,
              }}
            >
              <span className="mono mt-0.5 text-xs text-(--text-faint)">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="font-medium text-(--text)">
                  <span
                    style={{
                      color:
                        tone === "primary"
                          ? "var(--accent)"
                          : tone === "danger"
                            ? "var(--hue-err)"
                            : "var(--text)",
                    }}
                  >
                    {option.label}
                  </span>
                </span>
                {option.id === currentRequest.recommended && (
                  <span className="ml-2 rounded bg-(--surface-3) px-1.5 py-0.5 text-xs text-(--accent)">
                    suggested
                  </span>
                )}
                {option.description && (
                  <span className="mt-0.5 block text-(--text-dim)">
                    {option.description}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>

      {selected && visibleFields.length > 0 && (
        <div className="mt-4 space-y-3">
          {visibleFields.map((field) => (
            <DecisionFieldControl
              key={field.id}
              field={field}
              value={values[field.id]}
              error={touchedFields.has(field.id) ? errors[field.id] : undefined}
              onChange={(value) => update(field.id, value)}
            />
          ))}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          disabled={!connected || pending || invalidReason !== null}
          onClick={() => void submit()}
        >
          {pending ? (
            "Submitting…"
          ) : selected ? (
            <>
              {
                currentRequest.options.find((option) => option.id === selected)
                  ?.label
              }
              <span className="mono ml-1 text-xs opacity-75" aria-hidden="true">
                ↵
              </span>
            </>
          ) : (
            "Choose an option"
          )}
        </Button>
        {statusReason && (
          <span className="text-[11px] text-(--text-faint)" role="status">
            {statusReason}
          </span>
        )}
      </div>
      {message && (
        <div
          className="mt-3 rounded border border-(--hue-warn) px-2.5 py-2 text-[12px] text-(--hue-warn)"
          role="alert"
        >
          {message}
        </div>
      )}
    </section>
  );
}

function DecisionFieldControl({
  field,
  value,
  error,
  onChange,
}: {
  field: DecisionField;
  value: unknown;
  error?: string;
  onChange: (value: unknown) => void;
}) {
  const required = field.required ? " *" : "";
  const hintId = useId();
  if (field.kind === "confirm") {
    return (
      <label className="flex cursor-pointer items-start gap-2 text-[12px] text-(--text)">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
          className="mt-0.5"
        />
        <span>
          {field.label}
          {required}
        </span>
      </label>
    );
  }
  if (field.kind === "multi-choice") {
    const chosen = Array.isArray(value) ? (value as string[]) : [];
    return (
      <fieldset>
        <legend className="mb-1 text-[12px] font-medium text-(--text)">
          {field.label}
          {required}
        </legend>
        <div className="space-y-1">
          {field.choices.map((choice) => (
            <label
              key={choice.id}
              className="flex cursor-pointer items-start gap-2 rounded px-1 py-0.5 text-[12px] hover:bg-(--surface-1)"
            >
              <input
                type="checkbox"
                checked={chosen.includes(choice.id)}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...chosen, choice.id]
                      : chosen.filter((id) => id !== choice.id),
                  )
                }
                className="mt-0.5"
              />
              <span>
                <span className="text-(--text)">{choice.label}</span>
                {choice.description && (
                  <span className="block text-(--text-dim)">
                    {choice.description}
                  </span>
                )}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
    );
  }
  if (field.kind === "single-choice" && field.choices.length <= 5) {
    return (
      <fieldset>
        <legend className="mb-1 text-[12px] font-medium text-(--text)">
          {field.label}
          {required}
        </legend>
        <div className="space-y-1">
          {field.choices.map((choice) => (
            <label
              key={choice.id}
              className="flex cursor-pointer gap-2 text-[12px]"
            >
              <input
                type="radio"
                name={field.id}
                value={choice.id}
                checked={value === choice.id}
                onChange={() => onChange(choice.id)}
              />
              <span>{choice.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
    );
  }
  if (field.kind === "single-choice") {
    return (
      <label className="block text-[12px] font-medium text-(--text)">
        {field.label}
        {required}
        <select
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
          className={`${controlClass} mt-1`}
        >
          <option value="">Choose…</option>
          {field.choices.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {choice.label}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (field.kind === "number") {
    return (
      <label className="block text-[12px] font-medium text-(--text)">
        {field.label}
        {required}
        <input
          type="number"
          value={typeof value === "number" ? String(value) : ""}
          min={field.minimum}
          max={field.maximum}
          step={field.integer ? 1 : "any"}
          onChange={(event) =>
            onChange(
              event.target.value === "" ? "" : event.target.valueAsNumber,
            )
          }
          className={`${controlClass} mt-1`}
        />
      </label>
    );
  }
  const common = {
    value: typeof value === "string" ? value : "",
    placeholder: field.placeholder,
    maxLength: field.maxLength,
    "aria-describedby": error ? hintId : undefined,
    "aria-invalid": error ? true : undefined,
    onChange: (
      event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => onChange(event.target.value),
    className: `${controlClass} mt-1`,
  };
  return (
    <label className="block text-[12px] font-medium text-(--text)">
      {field.label}
      {required}
      {field.maxLength !== undefined && field.maxLength <= 120 ? (
        <input type="text" {...common} />
      ) : (
        <textarea rows={3} {...common} />
      )}
      {error && (
        <span
          id={hintId}
          className="mt-1 block text-[11px] text-(--hue-err)"
          aria-live="polite"
        >
          {error}
        </span>
      )}
    </label>
  );
}
