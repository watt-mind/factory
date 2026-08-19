/**
 * Read-only settings form driven by a JSON Schema (WM-920). Widgets follow
 * `type` / `enum` / bounds and the closed `format` set; nothing here writes.
 */
import type { ReactNode } from "react";
import { TicketHoverCard } from "./TicketHoverCard";

export type JsonSchema = {
  type?: string | string[];
  title?: string;
  description?: string;
  format?: string;
  enum?: unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  properties?: Record<string, JsonSchema>;
};

export type SecretState = {
  set: boolean;
  source: "env" | "secrets.env" | null;
};

const DURATION_RE = /^(\d+)(ms|s|m|h|d)$/;
const UNIT_WORD: Record<string, string> = {
  ms: "millisecond",
  s: "second",
  m: "minute",
  h: "hour",
  d: "day",
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function upperSnake(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

/** `FACTORY_EXT_<NAMESPACE>_<KEY>` — same rule the loader uses. */
export function secretEnvVar(
  namespace: string | null | undefined,
  keyPath: string[],
): string {
  const parts = [namespace ?? "", ...keyPath].map(upperSnake).filter(Boolean);
  return `FACTORY_EXT_${parts.join("_")}`;
}

export function humanizeDuration(value: string): string {
  const match = DURATION_RE.exec(value);
  if (!match) return value;
  const count = Number(match[1]);
  const word = UNIT_WORD[match[2] ?? ""] ?? match[2];
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function secretState(value: unknown): SecretState {
  if (isObject(value) && "set" in value)
    return {
      set: Boolean(value.set),
      source:
        value.source === "env" || value.source === "secrets.env"
          ? value.source
          : null,
    };
  if (typeof value === "string" && value.length > 0)
    return { set: true, source: null };
  return { set: false, source: null };
}

function declaredType(schema: JsonSchema): string | undefined {
  if (Array.isArray(schema.type))
    return schema.type.find((t) => t !== "null") ?? schema.type[0];
  return schema.type;
}

function isDefaultValue(value: unknown, fallback: unknown): boolean {
  if (fallback === undefined) return false;
  try {
    return JSON.stringify(value) === JSON.stringify(fallback);
  } catch {
    return value === fallback;
  }
}

function rangeHint(schema: JsonSchema): string | null {
  const hasMin = typeof schema.minimum === "number";
  const hasMax = typeof schema.maximum === "number";
  if (hasMin && hasMax) return `${schema.minimum}–${schema.maximum}`;
  if (hasMin) return `≥ ${schema.minimum}`;
  if (hasMax) return `≤ ${schema.maximum}`;
  return null;
}

function DisabledSwitch({
  checked,
  label,
}: {
  checked: boolean;
  label: string;
}) {
  return (
    <span
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-disabled="true"
      className="relative inline-block h-4 w-7 rounded-full opacity-40"
      style={{ background: checked ? "var(--accent)" : "var(--surface-3)" }}
    >
      <span
        aria-hidden
        className={`absolute top-0.5 size-3 rounded-full bg-(--contrast) ${
          checked ? "translate-x-3.5" : "translate-x-0.5"
        }`}
        style={checked ? { background: "var(--on-accent)" } : undefined}
      />
    </span>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="mono inline-block rounded border border-(--border) bg-(--surface-2) px-1.5 py-0.5 text-[12px] text-(--text-dim)">
      {children}
    </span>
  );
}

function FieldValue({
  schema,
  value,
  namespace,
  keyPath,
}: {
  schema: JsonSchema;
  value: unknown;
  namespace: string | null;
  keyPath: string[];
}) {
  if (schema.format === "secret") {
    const state = secretState(value);
    const envVar = secretEnvVar(namespace, keyPath);
    if (!state.set) {
      return (
        <span className="mono rounded border border-(--border) px-1.5 py-0.5 text-xs text-(--text-faint)">
          unset
        </span>
      );
    }
    return (
      <span className="text-[12px] text-(--text-dim)">
        set via env <span className="mono">{envVar}</span>
      </span>
    );
  }

  if (value === undefined || value === null || value === "") {
    return <span className="text-(--text-faint)">—</span>;
  }

  if (schema.format === "uri" && typeof value === "string") {
    return (
      <a
        href={value}
        className="text-(--accent) hover:underline"
        rel="noreferrer"
      >
        {value}
      </a>
    );
  }

  if (schema.format === "ticket" && typeof value === "string") {
    return (
      <Chip>
        <TicketHoverCard ticketId={value} />
      </Chip>
    );
  }

  if (schema.format === "channel-id" && typeof value === "string") {
    return <Chip>{value}</Chip>;
  }

  if (schema.format === "duration" && typeof value === "string") {
    return (
      <span className="text-[12px] text-(--text-dim)" title={value}>
        {humanizeDuration(value)}
      </span>
    );
  }

  if (schema.format === "multiline" && typeof value === "string") {
    return (
      <pre className="mono whitespace-pre-wrap text-[12px] text-(--text-dim)">
        {value}
      </pre>
    );
  }

  if (declaredType(schema) === "boolean" || typeof value === "boolean") {
    const checked = Boolean(value);
    const label = schema.title ?? keyPath[keyPath.length - 1] ?? "flag";
    return <DisabledSwitch checked={checked} label={label} />;
  }

  if (Array.isArray(schema.enum)) {
    return (
      <select
        disabled
        value={String(value)}
        aria-label={schema.title ?? keyPath.join(".")}
        className="mono rounded border border-(--border) bg-(--surface-2) px-1.5 py-0.5 text-[12px] text-(--text-dim) opacity-70"
      >
        {schema.enum.map((option) => (
          <option key={String(option)} value={String(option)}>
            {String(option)}
          </option>
        ))}
      </select>
    );
  }

  const numeric =
    declaredType(schema) === "integer" ||
    declaredType(schema) === "number" ||
    typeof value === "number";
  if (numeric) {
    const hint = rangeHint(schema);
    return (
      <span className="text-[12px] text-(--text-dim)">
        <span className="mono">{String(value)}</span>
        {hint && (
          <span className="ml-2 text-xs text-(--text-faint)">{hint}</span>
        )}
      </span>
    );
  }

  if (typeof value === "string") {
    return <span className="text-[12px] text-(--text-dim)">{value}</span>;
  }

  return (
    <pre className="mono whitespace-pre-wrap text-[12px] text-(--text-dim)">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function SchemaFields({
  schema,
  values,
  namespace,
  keyPath,
}: {
  schema: JsonSchema;
  values: Record<string, unknown> | null;
  namespace: string | null;
  keyPath: string[];
}) {
  const properties = schema.properties ?? {};
  return (
    <>
      {Object.entries(properties).map(([key, prop]) => {
        const path = [...keyPath, key];
        const value =
          values && Object.hasOwn(values, key) ? values[key] : undefined;
        const nested =
          declaredType(prop) === "object" || isObject(prop.properties);
        if (nested) {
          return (
            <div
              key={path.join(".")}
              className="border-b border-(--border) px-3 py-2 last:border-b-0"
            >
              <div className="mono mb-1 text-[12px] text-(--text)">
                {prop.title ?? key}
              </div>
              {prop.description && (
                <div className="mb-1 text-xs text-(--text-faint)">
                  {prop.description}
                </div>
              )}
              <div className="overflow-hidden rounded border border-(--border)">
                <SchemaFields
                  schema={prop}
                  values={isObject(value) ? value : null}
                  namespace={namespace}
                  keyPath={path}
                />
              </div>
            </div>
          );
        }
        const usingDefault = isDefaultValue(value, prop.default);
        return (
          <div
            key={path.join(".")}
            className="grid min-w-0 gap-2 border-b border-(--border) px-3 py-2 last:border-b-0 md:grid-cols-[minmax(10rem,0.8fr)_minmax(12rem,1.4fr)]"
          >
            <div className="min-w-0">
              <div className="mono break-words text-[12px] text-(--text)">
                {prop.title ?? key}
              </div>
              {usingDefault && value !== undefined && (
                <span className="mt-0.5 inline-block text-xs tracking-wide text-(--text-faint) uppercase">
                  default
                </span>
              )}
            </div>
            <div className="min-w-0 overflow-x-auto">
              <FieldValue
                schema={prop}
                value={value}
                namespace={namespace}
                keyPath={path}
              />
              {prop.description && (
                <div className="mt-1 text-xs text-(--text-faint)">
                  {prop.description}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}

/** Collect `title` and `description` of every property, for Settings search. */
export function schemaSearchText(
  schema: JsonSchema | null | undefined,
): string {
  const acc: string[] = [];
  const walk = (node: JsonSchema | undefined) => {
    if (!node?.properties) return;
    for (const prop of Object.values(node.properties)) {
      if (typeof prop.title === "string") acc.push(prop.title);
      if (typeof prop.description === "string") acc.push(prop.description);
      walk(prop);
    }
  };
  walk(schema ?? undefined);
  return acc.join("\n");
}

export function SchemaForm({
  schema,
  values,
  namespace,
}: {
  schema: JsonSchema | null;
  values: Record<string, unknown> | null;
  namespace?: string | null;
}) {
  const properties = schema?.properties ?? {};
  const keys = Object.keys(properties);
  if (!schema || keys.length === 0) {
    return (
      <div className="px-3 py-2 text-xs text-(--text-faint)">
        No values set and the schema declares no defaults.
      </div>
    );
  }
  return (
    <div data-testid="schema-form">
      <SchemaFields
        schema={schema}
        values={values}
        namespace={namespace ?? null}
        keyPath={[]}
      />
    </div>
  );
}
