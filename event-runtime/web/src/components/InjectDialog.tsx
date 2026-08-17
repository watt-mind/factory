import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { api } from "../api";
import { buildTemplates, groupTemplates, triggerId, type TriggerTemplate } from "../templates";
import { validate } from "../lib/schema";
import {
  PLANNER_FIELDS,
  errorsByField,
  fieldErrorVisible,
  isAtField,
  isIdField,
  placeholderFor,
  repoSuggestions,
  schemaFields,
  unknownKeys,
  type FieldSpec,
} from "../lib/injectForm";
import {
  Button,
  ChipInput,
  Dialog,
  Disclosure,
  JsonBlock,
  Pill,
  SuggestInput,
  Tabs,
  VerbError,
  notify,
} from "./ui";

const REQUIRED = ["schemaVersion", "eventId", "type", "source", "occurredAt"];

export const INJECT_DRAFT_KEY = "factory.injectDraft";
export const INJECT_RECENT_STORAGE_KEY = "factory.injectRecent";
export const INJECT_LAST_TEMPLATE_KEY = "factory.injectLastTemplate";
export const MAX_RECENT_EVENTS = 5;

export interface InjectDraft {
  selected: string | null;
  tab: EditorTab;
  text: string;
  formBase: Record<string, unknown>;
  formPayload: Record<string, unknown>;
  subJson: Record<string, string>;
}

export interface RecentAdmittedEvent {
  eventId: string;
  type: string;
  occurredAt?: string;
  admittedAt: number;
  envelope: Record<string, unknown>;
}

function getSessionStorage(): Storage | null {
  try {
    return typeof window !== "undefined" && window.sessionStorage ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

function getLocalStorage(): Storage | null {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function loadDraft(): InjectDraft | null {
  try {
    const storage = getSessionStorage();
    if (!storage) return null;
    const raw = storage.getItem(INJECT_DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return {
        selected: typeof parsed.selected === "string" ? parsed.selected : null,
        tab: parsed.tab === "form" ? "form" : "json",
        text: typeof parsed.text === "string" ? parsed.text : "",
        formBase: isPlainObject(parsed.formBase) ? parsed.formBase : {},
        formPayload: isPlainObject(parsed.formPayload) ? parsed.formPayload : {},
        subJson: isPlainObject(parsed.subJson) ? parsed.subJson : {},
      };
    }
  } catch {}
  return null;
}

export function saveDraft(draft: InjectDraft | null) {
  try {
    const storage = getSessionStorage();
    if (!storage) return;
    if (draft === null) {
      storage.removeItem(INJECT_DRAFT_KEY);
    } else {
      storage.setItem(INJECT_DRAFT_KEY, JSON.stringify(draft));
    }
  } catch {}
}

export function clearDraft() {
  saveDraft(null);
}

export function loadRecentEvents(): RecentAdmittedEvent[] {
  try {
    const storage = getLocalStorage();
    if (!storage) return [];
    const raw = storage.getItem(INJECT_RECENT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is RecentAdmittedEvent =>
        !!item &&
        typeof item === "object" &&
        typeof item.type === "string" &&
        isPlainObject(item.envelope),
    );
  } catch {
    return [];
  }
}

export function saveRecentEvent(envelope: Record<string, unknown>, eventId: string): RecentAdmittedEvent[] {
  try {
    const storage = getLocalStorage();
    const prev = loadRecentEvents();
    const type = typeof envelope.type === "string" ? envelope.type : "";
    const newEntry: RecentAdmittedEvent = {
      eventId,
      type,
      occurredAt: typeof envelope.occurredAt === "string" ? envelope.occurredAt : undefined,
      admittedAt: Date.now(),
      envelope: { ...envelope, eventId },
    };
    const next = [
      newEntry,
      ...prev.filter((p) => p.eventId !== eventId),
    ].slice(0, MAX_RECENT_EVENTS);
    if (storage) {
      storage.setItem(INJECT_RECENT_STORAGE_KEY, JSON.stringify(next));
    }
    return next;
  } catch {
    return [];
  }
}

export function clearRecentEvents() {
  try {
    const storage = getLocalStorage();
    if (storage) {
      storage.removeItem(INJECT_RECENT_STORAGE_KEY);
    }
  } catch {}
}

export function loadLastTemplate(): string | null {
  try {
    const storage = getLocalStorage();
    if (!storage) return null;
    const raw = storage.getItem(INJECT_LAST_TEMPLATE_KEY);
    if (raw === null) return null;
    if (raw === "") return null;
    return raw;
  } catch {
    return null;
  }
}

export function saveLastTemplate(eventType: string | null) {
  try {
    const storage = getLocalStorage();
    if (!storage) return;
    if (eventType === null || eventType === "" || eventType.startsWith("__")) {
      storage.setItem(INJECT_LAST_TEMPLATE_KEY, "");
      return;
    }
    storage.setItem(INJECT_LAST_TEMPLATE_KEY, eventType);
  } catch {}
}

function summarizePayload(env: Record<string, unknown> | undefined): string {
  if (!env || !isPlainObject(env.payload)) return "no payload";
  const payload = env.payload as Record<string, unknown>;
  const entries = Object.entries(payload).filter(([, v]) => v !== undefined && v !== "");
  if (entries.length === 0) return "empty payload";
  if (typeof payload.repo === "string") return `repo: ${payload.repo}`;
  if (typeof payload.host === "string") return `host: ${payload.host}`;
  return entries.map(([k]) => k).slice(0, 3).join(", ") + (entries.length > 3 ? "…" : "");
}

/** Blank slate for an unregistered/hand-written envelope (the escape hatch). */
function blankEnvelope(nowMs: number) {
  const id = triggerId(nowMs);
  return {
    schemaVersion: "factory.event/v1",
    eventId: id,
    type: "",
    source: "web-trigger",
    subject: "factory",
    occurredAt: new Date(nowMs).toISOString(),
    correlationId: id,
    payload: {},
  };
}

const pretty = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

function omitKey(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const next = { ...obj };
  delete next[key];
  return next;
}

const parses = (raw: string): boolean => {
  try {
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
};

export interface JsonEnvelopeStatus {
  syntaxValid: boolean;
  envelopeValid: boolean;
  label: string;
}

/** Distinguish syntactically valid JSON from an envelope that is ready to inject. */
export function jsonEnvelopeStatus(raw: string): JsonEnvelopeStatus {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { syntaxValid: false, envelopeValid: false, label: "Invalid JSON syntax" };
  }
  if (!isPlainObject(value)) {
    return { syntaxValid: true, envelopeValid: false, label: "JSON ok · envelope must be an object" };
  }
  for (const field of ["type", "source", "subject"] as const) {
    if (typeof value[field] !== "string" || value[field].trim() === "") {
      return { syntaxValid: true, envelopeValid: false, label: `JSON ok · ${field} missing` };
    }
  }
  return { syntaxValid: true, envelopeValid: true, label: "Valid JSON" };
}

const warnStyle = {
  color: "var(--hue-warn)",
  background: "color-mix(in oklch, var(--hue-warn) 10%, transparent)",
};

const inputCls =
  "mono w-full rounded-md border border-(--border) bg-(--surface-0) px-2 py-1 text-[12px] text-(--text) outline-none focus:border-(--border-strong)";

type EditorTab = "form" | "json";

export function humanizeSchemaErrors(errs: string[], fields?: FieldSpec[] | null): string[] {
  const byName = new Map((fields ?? []).map((f) => [f.name, f]));
  return errs.map((err) => {
    if (!/does not match pattern/.test(err)) return err;
    const fielded = err.match(/^\$\.([A-Za-z0-9_$-]+)((?:[.[])[^:]*)?: (.*)$/);
    if (fielded) {
      const name = fielded[1];
      const subpath = fielded[2] ?? "";
      const message = fielded[3];
      const spec = byName.get(name);
      const example = !subpath && spec ? placeholderFor(name, spec.schema) : null;
      const hint = example ? ` (e.g. ${example})` : "";
      const humanizedMsg = message.replace(
        /does not match pattern[\s\S]*$/,
        `does not match expected format${hint}`,
      );
      return `$.${name}${subpath}: ${humanizedMsg}`;
    }
    return err.replace(/does not match pattern[\s\S]*$/, "does not match expected format");
  });
}


/**
 * Inject dialog (webui spec §4.4, templates per OPS-214, confirm per OPS-230,
 * format OPS-361, 2-column sidebar OPS-363, schema-driven Form view WM-76,
 * autosave & recent history OPS-507).
 *
 * Left sidebar lists registered templates and recent history with instant search.
 * The right side has two tabs: a Form view rendered from the selected event type's
 * input schema (payload-only; the envelope is generated exactly as templates do)
 * and the raw-JSON full-envelope escape hatch. Both validate the payload with the
 * ported fail-closed validator (lib/schema.ts); invalid payloads warn and need
 * an explicit acknowledgement, but are never hard-blocked — the runtime
 * deliberately admits them and parks them human_needed.
 */
export function InjectDialog({
  onClose,
  onAdmitted,
  initialEnvelope,
}: {
  onClose: () => void;
  onAdmitted?: (source: string, eventId: string) => void;
  initialEnvelope?: Record<string, unknown>;
}) {
  const queryClient = useQueryClient();
  const registry = useQuery({ queryKey: ["agents"], queryFn: api.agents });
  const registryView = useMemo(
    () =>
      isPlainObject(registry.data) &&
      Array.isArray(registry.data.agents) &&
      Array.isArray(registry.data.eventTypes)
        ? registry.data
        : null,
    [registry.data],
  );
  const reposQ = useQuery({ queryKey: ["repos"], queryFn: api.repos });
  const repoItems = reposQ.data?.repos ?? [];

  const openedAt = useMemo(() => Date.now(), []);
  const initialDraft = useMemo(() => (initialEnvelope ? null : loadDraft()), [initialEnvelope]);
  const [recentEvents, setRecentEvents] = useState<RecentAdmittedEvent[]>(() => loadRecentEvents());
  const submittedRef = useRef(false);

  const templates = useMemo(() => buildTemplates(registryView, openedAt), [registryView, openedAt]);

  const [search, setSearch] = useState("");
  const lastTemplateRef = useRef(false);
  const [selected, setSelected] = useState<string | null>(() => {
    if (initialEnvelope) return "__given__";
    if (initialDraft?.selected !== undefined) return initialDraft.selected;
    return loadLastTemplate();
  });
  const [text, setText] = useState<string>(() => {
    if (initialEnvelope) return pretty(initialEnvelope);
    if (initialDraft?.text) return initialDraft.text;
    return pretty(blankEnvelope(openedAt));
  });
  const [clientError, setClientError] = useState<string | null>(null);
  const [unregisteredAck, setUnregisteredAck] = useState(false);
  const [schemaAck, setSchemaAck] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // WM-76 Form view state. The base is the envelope minus payload (generated
  // exactly as templates do); the form edits payload only. Nested object /
  // array-of-object fields keep their raw text in subJson (a per-field JSON
  // sub-editor); formPayload holds their last successfully parsed value.
  const [tab, setTab] = useState<EditorTab>(() => {
    if (initialEnvelope) return "json";
    if (initialDraft?.tab) return initialDraft.tab;
    return "json";
  });
  const [formBase, setFormBase] = useState<Record<string, unknown>>(() => {
    if (initialDraft?.formBase) return initialDraft.formBase;
    return {};
  });
  const [formPayload, setFormPayload] = useState<Record<string, unknown>>(() => {
    if (initialDraft?.formPayload) return initialDraft.formPayload;
    return {};
  });
  const [subJson, setSubJson] = useState<Record<string, string>>(() => {
    if (initialDraft?.subJson) return initialDraft.subJson;
    return {};
  });
  const [tabNotice, setTabNotice] = useState<string | null>(null);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const fieldIdBase = useId();

  // Autosave draft to sessionStorage (OPS-507)
  useEffect(() => {
    if (initialEnvelope || submittedRef.current) return;
    saveDraft({
      selected,
      tab,
      text,
      formBase,
      formPayload,
      subJson,
    });
  }, [selected, tab, text, formBase, formPayload, subJson, initialEnvelope]);

  const filteredRecent = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return recentEvents;
    return recentEvents.filter((r) => {
      if (r.type?.toLowerCase().includes(q)) return true;
      if (r.eventId?.toLowerCase().includes(q)) return true;
      if (r.envelope && isPlainObject(r.envelope.payload)) {
        try {
          if (JSON.stringify(r.envelope.payload).toLowerCase().includes(q)) return true;
        } catch {}
      }
      return false;
    });
  }, [recentEvents, search]);

  const filteredTemplates = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return templates;
    return templates.filter(
      (t) =>
        (t.eventType?.toLowerCase().includes(q) ?? false) ||
        (t.agent?.toLowerCase().includes(q) ?? false) ||
        (t.summary?.toLowerCase().includes(q) ?? false),
    );
  }, [templates, search]);
  const groupedTemplates = useMemo(() => groupTemplates(filteredTemplates), [filteredTemplates]);

  const inject = useMutation({
    mutationFn: (envelope: Record<string, unknown>) => api.replay(envelope),
    onSuccess: (data, envelope) => {
      queryClient.invalidateQueries();
      setConfirming(false);
      notify(
        data.duplicate ? `Duplicate event ${data.eventId}` : `Admitted event ${data.eventId}`,
        data.duplicate ? "info" : "ok",
      );
      const source = typeof envelope.source === "string" ? envelope.source : "web-trigger";
      if (!data.duplicate) {
        const updated = saveRecentEvent(envelope, data.eventId);
        setRecentEvents(updated);
      }
      submittedRef.current = true;
      clearDraft();
      onAdmitted?.(source, data.eventId);
    },
  });

  /** The registered input schema for an event type, or null. */
  function schemaFor(type: string): Record<string, unknown> | null {
    const route = registryView?.eventTypes.find((r) => r.type === type);
    if (!route) return null;
    const agent = registryView?.agents.find((a) => a.ref === route.agent);
    const s = agent?.inputSchema;
    return isPlainObject(s) ? s : null;
  }

  function initFormFromEnvelope(env: Record<string, unknown>, fields: FieldSpec[] | null) {
    const { payload, ...base } = env;
    const pay = isPlainObject(payload) ? { ...payload } : {};
    setFormBase(base);
    setFormPayload(pay);
    const sub: Record<string, string> = {};
    for (const f of fields ?? []) {
      if (f.kind === "json") sub[f.name] = f.name in pay ? JSON.stringify(pay[f.name], null, 2) : "";
    }
    setSubJson(sub);
    setTouched({});
    setSubmitAttempted(false);
  }

  function resetAcks() {
    setClientError(null);
    setUnregisteredAck(false);
    setSchemaAck(false);
    setConfirming(false);
  }

  function choose(template: TriggerTemplate) {
    setSelected(template.eventType);
    saveLastTemplate(template.eventType);
    setText(pretty(template.envelope));
    const fields = schemaFields(schemaFor(template.eventType));
    initFormFromEnvelope(template.envelope, fields);
    setTab(fields ? "form" : "json");
    setTabNotice(null);
    resetAcks();
    inject.reset();
  }

  function chooseRecent(item: RecentAdmittedEvent) {
    const recentId = `__recent_${item.eventId}__`;
    setSelected(recentId);
    const nowMs = Date.now();
    const env: Record<string, unknown> = {
      ...item.envelope,
      eventId: triggerId(nowMs),
      occurredAt: new Date(nowMs).toISOString(),
      correlationId: triggerId(nowMs),
    };
    setText(pretty(env));
    const type = typeof env.type === "string" ? env.type : "";
    const fields = schemaFields(schemaFor(type));
    initFormFromEnvelope(env, fields);
    setTab(fields ? "form" : "json");
    setTabNotice(null);
    resetAcks();
    inject.reset();
  }

  function applySelection(next: string | null) {
    if (next === checkedId) return;
    if (next === null) {
      const env = blankEnvelope(openedAt);
      setSelected(null);
      saveLastTemplate(null);
      setText(pretty(env));
      initFormFromEnvelope(env, null);
      setTab("json");
      setTabNotice(null);
      resetAcks();
      inject.reset();
      return;
    }
    if (next === "__given__" && initialEnvelope) {
      const type = typeof initialEnvelope.type === "string" ? initialEnvelope.type : "";
      setSelected("__given__");
      setText(pretty(initialEnvelope));
      initFormFromEnvelope(initialEnvelope, schemaFields(schemaFor(type)));
      setTab("json");
      setTabNotice(null);
      resetAcks();
      inject.reset();
      return;
    }
    if (next.startsWith("__recent_")) {
      const eventId = next.slice("__recent_".length, -2);
      const item = recentEvents.find((x) => x.eventId === eventId) ?? filteredRecent.find((x) => x.eventId === eventId);
      if (item) {
        chooseRecent(item);
        return;
      }
    }
    const t = templates.find((x) => x.eventType === next);
    if (t) choose(t);
  }

  useLayoutEffect(() => {
    if (initialEnvelope || initialDraft) return;
    if (lastTemplateRef.current) return;
    if (!selected) return;
    const t = templates.find((x) => x.eventType === selected);
    if (!t) return;
    lastTemplateRef.current = true;
    choose(t);
  }, [templates, selected, initialEnvelope, initialDraft]);

  function templateIds(): Array<string | null> {
    return [
      ...(initialEnvelope ? ["__given__"] : []),
      ...filteredRecent.map((r) => `__recent_${r.eventId}__`),
      ...groupedTemplates.flatMap((group) => group.templates.map((t) => t.eventType)),
      null,
    ];
  }

  const checkedId = templateIds().includes(selected) ? selected : null;

  function radioA11y(id: string | null) {
    const checked = checkedId === id;
    return {
      role: "radio" as const,
      "aria-checked": checked,
      tabIndex: checked ? 0 : -1,
    };
  }

  function onTemplateKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
    if (!keys.includes(e.key)) return;
    if (!(e.target instanceof HTMLElement) || e.target.getAttribute("role") !== "radio") return;
    e.preventDefault();
    const radios = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]'));
    const idx = radios.indexOf(e.target);
    if (e.key === "ArrowUp" && idx === 0) {
      searchRef.current?.focus();
      return;
    }
    const ids = templateIds();
    const selectedIdx = checkedId === null ? ids.length - 1 : Math.max(ids.indexOf(checkedId), 0);
    const delta = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1;
    const nextIdx = (selectedIdx + delta + ids.length) % ids.length;
    applySelection(ids[nextIdx]);
    radios[nextIdx]?.focus();
  }

  // ---------------------------------------------------------------------------
  // Form model (WM-76)

  const formSchema = useMemo(
    () => (typeof formBase.type === "string" ? schemaFor(formBase.type) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- schemaFor reads registryView
    [formBase, registryView],
  );
  const formFields = useMemo(() => schemaFields(formSchema) ?? [], [formSchema]);
  const requiredFields = formFields.filter((f) => f.required);
  const optionalFields = formFields.filter((f) => !f.required);

  const formEnvelope = useMemo(
    (): Record<string, unknown> => ({ ...formBase, payload: formPayload }),
    [formBase, formPayload],
  );

  const formValidation = useMemo(
    () => (formSchema ? validate(formSchema, formPayload) : { valid: true, errors: [] as string[] }),
    [formSchema, formPayload],
  );
  const fieldErrors = useMemo(
    () => errorsByField(formValidation.errors, formFields),
    [formValidation, formFields],
  );
  const knownNames = useMemo(() => new Set(formFields.map((f) => f.name)), [formFields]);
  const formLevelErrors = useMemo(() => {
    const out: string[] = [];
    for (const [k, msgs] of fieldErrors) {
      if (k === "") out.push(...msgs);
      else if (!knownNames.has(k)) {
        const where = PLANNER_FIELDS.has(k)
          ? ` — ${k} is a planner field; edit it in the JSON tab`
          : " — edit in the JSON tab";
        out.push(...msgs.map((m) => `${k}: ${m}${where}`));
      }
    }
    return out;
  }, [fieldErrors, knownNames]);
  const unknown = useMemo(
    () => (formSchema ? unknownKeys(formSchema, formPayload) : []),
    [formSchema, formPayload],
  );
  const invalidSubs = formFields
    .filter((f) => f.kind === "json")
    .map((f) => f.name)
    .filter((name) => (subJson[name] ?? "").trim() !== "" && !parses(subJson[name]));

  function setField(name: string, v: unknown) {
    setFormPayload((p) => ({ ...p, [name]: v }));
    resetAcks();
  }
  function clearField(name: string) {
    setFormPayload((p) => omitKey(p, name));
    resetAcks();
  }
  function setSub(name: string, raw: string) {
    setSubJson((s) => ({ ...s, [name]: raw }));
    const trimmed = raw.trim();
    if (!trimmed) {
      setFormPayload((p) => omitKey(p, name));
    } else if (parses(trimmed)) {
      setFormPayload((p) => ({ ...p, [name]: JSON.parse(trimmed) }));
    }
    resetAcks();
  }

  /**
   * Whether the current JSON text can open in the Form view (WM-76 decision 7).
   * `disabled` marks identity-level impossibility (no schema to render);
   * a `reason` with disabled=false is a fixable state (bad JSON, odd payload).
   */
  const formAvailability = useMemo((): { disabled: boolean; reason: string | null } => {
    if (checkedId === "__given__") {
      return {
        disabled: true,
        reason: "Trigger again re-sends the captured envelope as-is — no schema to render.",
      };
    }
    let env: unknown;
    try {
      env = JSON.parse(text);
    } catch (err) {
      return {
        disabled: false,
        reason: `the envelope is not valid JSON (${(err as Error).message}) — fix it or reselect a template to revert`,
      };
    }
    if (!isPlainObject(env)) {
      return {
        disabled: false,
        reason: "the envelope must be a JSON object — fix it or reselect a template to revert",
      };
    }
    const type = typeof env.type === "string" ? env.type : "";
    const schema = schemaFor(type);
    if (!schema || !schemaFields(schema)) {
      return {
        disabled: true,
        reason: `"${type || "(empty type)"}" is not a registered event type with an input schema — no schema to render`,
      };
    }
    if (env.payload !== undefined && !isPlainObject(env.payload)) {
      return {
        disabled: false,
        reason: "payload is not a JSON object, which the form cannot represent — fix it or reselect a template to revert",
      };
    }
    return { disabled: false, reason: null };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- schemaFor reads registryView
  }, [checkedId, text, registryView]);

  function selectTab(next: string) {
    if (next === tab) return;
    if (next === "json") {
      if (invalidSubs.length > 0) {
        setTabNotice(
          `Cannot switch to JSON: field ${invalidSubs.join(", ")} holds invalid JSON — fix it first so nothing is lost.`,
        );
        return;
      }
      setText(pretty(formEnvelope));
      setTab("json");
      setTabNotice(null);
      return;
    }
    if (formAvailability.reason) {
      setTabNotice(`Cannot switch to Form: ${formAvailability.reason}.`);
      return;
    }
    const env = JSON.parse(text) as Record<string, unknown>;
    initFormFromEnvelope(env, schemaFields(schemaFor(typeof env.type === "string" ? env.type : "")));
    setTab("form");
    setTabNotice(null);
  }

  // ---------------------------------------------------------------------------

  function formatJson() {
    try {
      const parsed = JSON.parse(text);
      setText(pretty(parsed));
      setClientError(null);
      notify("Formatted JSON envelope", "info");
    } catch (err) {
      setClientError(`Cannot format: ${(err as Error).message}`);
    }
  }

  const formatJsonRef = useRef(formatJson);
  formatJsonRef.current = formatJson;

  /** Warn-and-ack for a schema-invalid payload; returns true when submission should pause. */
  function needsSchemaAck(type: string, errs: string[]): boolean {
    if (errs.length === 0 || schemaAck) return false;
    const fields = schemaFields(schemaFor(type));
    const humanized = humanizeSchemaErrors(errs, fields);
    const summary = humanized.slice(0, 3).join("; ") + (humanized.length > 3 ? ` (+${humanized.length - 3} more)` : "");
    setClientError(
      `payload does not validate against the "${type}" input schema: ${summary}. Intake will admit it, but planning will park it human_needed. Inject anyway to proceed.`,
    );
    setSchemaAck(true);
    setConfirming(true);
    return true;
  }

  function submitForm() {
    setClientError(null);
    setSubmitAttempted(true);
    if (invalidSubs.length > 0) {
      setClientError(`field ${invalidSubs.join(", ")}: not valid JSON`);
      setConfirming(false);
      return;
    }
    const missing = REQUIRED.filter((k) => typeof formEnvelope[k] !== "string" || !formEnvelope[k]);
    if (missing.length) {
      setClientError(`missing required string field${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`);
      setConfirming(false);
      return;
    }
    const type = typeof formBase.type === "string" ? formBase.type : "";
    if (needsSchemaAck(type, formValidation.errors)) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    inject.mutate(formEnvelope);
  }

  function submitJson() {
    setClientError(null);
    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(text);
    } catch (err) {
      setClientError(`not valid JSON: ${(err as Error).message}`);
      setConfirming(false);
      return;
    }
    const missing = REQUIRED.filter((k) => typeof envelope[k] !== "string" || !envelope[k]);
    if (missing.length) {
      setClientError(`missing required string field${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`);
      setConfirming(false);
      return;
    }
    const registered = registryView?.eventTypes.some((r) => r.type === envelope.type) ?? true;
    if (!registered && !unregisteredAck) {
      setClientError(
        `"${envelope.type}" is not a registered event type — it will be admitted, but planning will park it as human_needed. Confirm inject to proceed.`,
      );
      setUnregisteredAck(true);
      setConfirming(true);
      return;
    }
    if (registered && typeof envelope.type === "string") {
      const schema = schemaFor(envelope.type);
      if (schema) {
        const errs = validate(schema, envelope.payload ?? {}).errors;
        if (needsSchemaAck(envelope.type, errs)) return;
      }
    }
    if (!confirming) {
      setConfirming(true);
      return;
    }
    inject.mutate(envelope);
  }

  function submit() {
    if (tab === "form") submitForm();
    else submitJson();
  }

  const submitRef = useRef(submit);
  submitRef.current = submit;
  const tabRef = useRef(tab);
  tabRef.current = tab;

  useLayoutEffect(() => {
    searchRef.current?.setAttribute("autofocus", "");
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "f" || e.key === "F")) {
        if (tabRef.current !== "json") return;
        e.preventDefault();
        formatJsonRef.current();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        submitRef.current();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const jsonStatus = useMemo(() => jsonEnvelopeStatus(text), [text]);

  /** Live JSON-tab error summary: payload vs the registered schema of the typed event type. */
  const jsonSchemaErrors = useMemo(() => {
    if (tab !== "json") return [];
    let env: unknown;
    try {
      env = JSON.parse(text);
    } catch {
      return [];
    }
    if (!isPlainObject(env) || typeof env.type !== "string") return [];
    const schema = schemaFor(env.type);
    if (!schema) return [];
    const rawErrs = validate(schema, env.payload ?? {}).errors;
    return humanizeSchemaErrors(rawErrs, schemaFields(schema));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- schemaFor reads registryView
  }, [tab, text, registryView]);

  // ---------------------------------------------------------------------------
  // Form field rendering

  function renderField(f: FieldSpec) {
    const fid = `${fieldIdBase}-${f.name}`;
    const value = formPayload[f.name];
    const errs =
      fieldErrorVisible(f.name, touched, submitAttempted) ? (fieldErrors.get(f.name) ?? []) : [];
    const suggestions = repoSuggestions(f.name, f.schema, f.kind, repoItems);

    let control: React.ReactNode;
    switch (f.kind) {
      case "const":
        control = <Pill title="Fixed by the schema">{JSON.stringify(f.schema.const)}</Pill>;
        break;
      case "enum": {
        const options = (f.schema.enum as unknown[]) ?? [];
        control = (
          <select
            id={fid}
            value={value === undefined ? "" : String(value)}
            onChange={(e) => {
              const raw = e.target.value;
              if (raw === "" && !f.required) clearField(f.name);
              else setField(f.name, options.find((o) => String(o) === raw) ?? raw);
            }}
            className={inputCls}
          >
            {!f.required && <option value="">—</option>}
            {options.map((o) => (
              <option key={String(o)} value={String(o)}>
                {typeof o === "string" ? o : JSON.stringify(o)}
              </option>
            ))}
          </select>
        );
        break;
      }
      case "boolean":
        control = (
          <input
            id={fid}
            type="checkbox"
            checked={value === true}
            onChange={(e) => setField(f.name, e.target.checked)}
            className="size-3.5 accent-(--accent)"
          />
        );
        break;
      case "number":
        control = (
          <input
            id={fid}
            type="number"
            step="any"
            min={typeof f.schema.minimum === "number" ? f.schema.minimum : undefined}
            max={typeof f.schema.maximum === "number" ? f.schema.maximum : undefined}
            aria-valuemin={typeof f.schema.minimum === "number" ? f.schema.minimum : undefined}
            aria-valuemax={typeof f.schema.maximum === "number" ? f.schema.maximum : undefined}
            value={typeof value === "number" || typeof value === "string" ? String(value) : ""}
            onChange={(e) => {
              const raw = e.target.value;
              if (raw === "") clearField(f.name);
              else {
                const n = Number(raw);
                setField(f.name, Number.isNaN(n) ? raw : n);
              }
            }}
            className={inputCls}
          />
        );
        break;
      case "string-array":
        control = (
          <ChipInput
            id={fid}
            values={Array.isArray(value) ? value.map(String) : []}
            onChange={(vals) => {
              if (vals.length === 0 && !f.required) clearField(f.name);
              else setField(f.name, vals);
            }}
            suggestions={suggestions}
          />
        );
        break;
      case "json": {
        const raw = subJson[f.name] ?? "";
        const state = raw.trim() === "" ? "empty" : parses(raw) ? "valid" : "invalid";
        control = (
          <>
            <textarea
              id={fid}
              value={raw}
              onChange={(e) => setSub(f.name, e.target.value)}
              rows={4}
              spellCheck={false}
              placeholder="JSON…"
              className={`${inputCls} resize-y leading-relaxed`}
            />
            <div className="mt-0.5 flex items-center gap-1.5 text-[10px]">
              <span
                className="size-1.5 rounded-full"
                style={{
                  background:
                    state === "invalid" ? "var(--hue-err)" : state === "valid" ? "var(--hue-ok)" : "var(--hue-idle)",
                }}
              />
              <span
                className="text-(--text-faint)"
                style={state === "invalid" ? { color: "var(--hue-err)" } : undefined}
              >
                {state === "invalid"
                  ? "Invalid JSON — fix before injecting"
                  : state === "valid"
                    ? "Valid JSON"
                    : f.required
                      ? "required — enter JSON"
                      : "not set"}
              </span>
            </div>
          </>
        );
        break;
      }
      default:
        control = (
          <SuggestInput
            id={fid}
            value={typeof value === "string" ? value : value === undefined ? "" : String(value)}
            onChange={(v) => {
              if (v === "" && !f.required) clearField(f.name);
              else setField(f.name, v);
            }}
            suggestions={suggestions}
            placeholder={placeholderFor(f.name, f.schema) ?? undefined}
          />
        );
    }

    return (
      <div
        key={f.name}
        className="mb-2.5 last:mb-0"
        onBlur={() => setTouched((t) => (t[f.name] ? t : { ...t, [f.name]: true }))}
      >
        <div className="mb-0.5 flex items-center gap-2">
          <label
            htmlFor={f.kind === "const" ? undefined : fid}
            className="mono text-[11px] font-medium text-(--text-dim)"
          >
            {f.name}
          </label>
          {f.required && <span className="text-[10px] text-(--text-faint)">required</span>}
          <span className="flex-1" />
          {f.kind === "string" && isAtField(f.name) && (
            <button
              type="button"
              onClick={() => setField(f.name, new Date().toISOString())}
              className="rounded border border-(--border) px-1.5 py-0.5 text-[10px] text-(--text-dim) hover:bg-(--surface-2)"
              title="Write the current time as an ISO timestamp"
            >
              Now
            </button>
          )}
          {f.kind === "string" && isIdField(f.name) && (
            <button
              type="button"
              onClick={() => setField(f.name, triggerId(Date.now()))}
              className="rounded border border-(--border) px-1.5 py-0.5 text-[10px] text-(--text-dim) hover:bg-(--surface-2)"
              title="Generate a fresh web-trigger id"
            >
              Generate
            </button>
          )}
        </div>
        {f.description && <div className="mb-1 text-[10px] text-(--text-faint)">{f.description}</div>}
        {control}
        {errs.map((e, i) => (
          <div key={i} className="mt-0.5 text-[11px]" style={{ color: "var(--hue-err)" }}>
            {e}
          </div>
        ))}
      </div>
    );
  }

  const outcome = inject.data;
  const seeded = Boolean(initialEnvelope);
  return (
    <Dialog
      title={seeded ? "Trigger again — inject with a fresh event id" : "Inject event"}
      onClose={onClose}
      extraWide
    >
      <div className="mb-3 text-[12px] text-(--text-dim)">
        {seeded
          ? "Trigger again copies this envelope with a new event id so intake admits it as a new event."
          : "Templates come from the agent registry. Select an event type on the left to load its schema-driven form, or paste a custom envelope in the JSON tab."}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
        {/* Left Column: Template Selection Sidebar */}
        <div className="md:col-span-5 flex flex-col min-h-0 border-b md:border-b-0 md:border-r border-(--border) pb-3 md:pb-0 md:pr-3">
          <div className="mb-2">
            <input
              ref={searchRef}
              type="text"
              placeholder="Search event types / agents…"
              value={search}
              aria-label="Search event types"
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "ArrowDown") return;
                const first = listRef.current?.querySelector<HTMLElement>('[role="radio"]');
                if (!first) return;
                e.preventDefault();
                first.focus();
              }}
              className="w-full rounded-md border border-(--border) bg-(--surface-0) px-2.5 py-1.5 text-[12px] text-(--text) outline-none focus:border-(--border-strong)"
            />
          </div>

          {registry.isPending && !registryView && (
            <div className="py-2 text-[12px] text-(--text-faint)">Loading templates…</div>
          )}
          {registry.isError && !registryView && (
            <div className="py-2 text-[12px] text-(--text-faint)">
              Cannot reach control API — templates will appear when it is up.
            </div>
          )}

          <div
            ref={listRef}
            className="max-h-[380px] overflow-y-auto space-y-1 pr-1"
            role="radiogroup"
            aria-label="Event type templates"
            onKeyDown={onTemplateKeyDown}
          >
            {initialEnvelope && (
              <button
                type="button"
                {...radioA11y("__given__")}
                onClick={() => applySelection("__given__")}
                className={`w-full rounded-md border p-2 text-left transition-colors ${
                  checkedId === "__given__"
                    ? "border-(--accent) bg-(--surface-3) text-(--text)"
                    : "border-(--border) text-(--text-dim) hover:bg-(--surface-2)"
                }`}
              >
                <div className="font-medium text-[12px]">this envelope</div>
                <div className="text-[11px] text-(--text-faint) truncate">original triggering payload</div>
              </button>
            )}

            {filteredRecent.length > 0 && (
              <div className="pt-1 pb-1">
                <div className="px-1 text-[10px] font-semibold uppercase tracking-wider text-(--text-faint)">
                  Recent
                </div>
                <div className="mt-1 space-y-1">
                  {filteredRecent.map((r) => {
                    const id = `__recent_${r.eventId}__`;
                    const summary = summarizePayload(r.envelope);
                    return (
                      <button
                        key={r.eventId || id}
                        type="button"
                        {...radioA11y(id)}
                        onClick={() => applySelection(id)}
                        className={`w-full rounded-md border p-2 text-left transition-colors ${
                          checkedId === id
                            ? "border-(--accent) bg-(--surface-3) text-(--text)"
                            : "border-(--border) text-(--text-dim) hover:bg-(--surface-2)"
                        }`}
                      >
                        <div className="mono font-medium text-[12px] truncate">{r.type || "untyped event"}</div>
                        <div className="mt-0.5 flex items-center justify-between text-[11px] text-(--text-faint)">
                          <span className="truncate">recent</span>
                          <span className="ml-1 shrink-0 opacity-75">{summary}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {groupedTemplates.length > 0 && (
              <div className={filteredRecent.length > 0 ? "pt-1" : ""}>
                {filteredRecent.length > 0 && (
                  <div className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-(--text-faint)">
                    Templates
                  </div>
                )}
                <div className="space-y-2">
                  {groupedTemplates.map((group) => (
                    <div key={group.domain} data-template-domain={group.domain}>
                      <div className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-(--text-faint)">
                        {group.domain}
                      </div>
                      <div className="space-y-1">
                        {group.templates.map((t) => {
                          const summary = t.summary || "no params";
                          return (
                            <button
                              key={t.eventType}
                              type="button"
                              {...radioA11y(t.eventType)}
                              onClick={() => applySelection(t.eventType)}
                              className={`w-full overflow-hidden rounded-md border p-2 text-left transition-colors ${
                                checkedId === t.eventType
                                  ? "border-(--accent) bg-(--surface-3) text-(--text)"
                                  : "border-(--border) text-(--text-dim) hover:bg-(--surface-2)"
                              }`}
                            >
                              <div className="mono truncate text-[12px] font-medium">{t.eventType}</div>
                              <div className="mt-0.5 flex min-w-0 items-center justify-between text-[11px] text-(--text-faint)">
                                <span className="min-w-0 truncate">{t.agent}</span>
                                <span title={summary} className="ml-1 min-w-0 max-w-[55%] truncate opacity-75">
                                  {summary}
                                </span>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {filteredTemplates.length === 0 && filteredRecent.length === 0 && search && (
              <div className="py-3 text-center text-[12px] text-(--text-faint)">
                No templates or recent payloads matching &quot;{search}&quot;
              </div>
            )}

            <button
              type="button"
              {...radioA11y(null)}
              onClick={() => applySelection(null)}
              className={`w-full rounded-md border p-2 text-left transition-colors ${
                checkedId === null
                  ? "border-(--accent) bg-(--surface-3) text-(--text)"
                  : "border-(--border) text-(--text-faint) hover:bg-(--surface-2)"
              }`}
            >
              <div className="font-medium text-[12px]">blank envelope</div>
              <div className="text-[11px] text-(--text-faint)">empty starter envelope</div>
            </button>
          </div>
        </div>

        {/* Right Column: Form / JSON editor */}
        <div className="md:col-span-7 flex flex-col min-h-0">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <Tabs
              label="Envelope editor mode"
              active={tab}
              onSelect={selectTab}
              tabs={[
                {
                  id: "form",
                  label: "Form",
                  disabled: tab === "json" && formAvailability.disabled,
                  title: formAvailability.reason ?? undefined,
                },
                { id: "json", label: "JSON" },
              ]}
            />
            {tab === "json" && (
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2 text-[11px]">
                  <span
                    className="size-1.5 rounded-full"
                    style={{
                      background: jsonStatus.envelopeValid
                        ? "var(--hue-ok)"
                        : jsonStatus.syntaxValid
                          ? "var(--text-muted, var(--text-faint))"
                          : "var(--hue-err)",
                    }}
                  />
                  <span
                    style={{
                      color: jsonStatus.envelopeValid || !jsonStatus.syntaxValid
                        ? "var(--text-faint)"
                        : "var(--text-muted, var(--text-faint))",
                    }}
                  >
                    {jsonStatus.label}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={formatJson}
                  className="text-[11px] text-(--text-dim) hover:text-(--accent)"
                  title="Format JSON (⌘⇧F)"
                >
                  Format JSON <span className="mono ml-1 text-(--text-faint)" aria-hidden="true">⌘⇧F</span>
                </button>
              </div>
            )}
          </div>

          {tabNotice && (
            <div className="mb-2 rounded-md px-2.5 py-1.5 text-[12px]" style={warnStyle}>
              {tabNotice}
            </div>
          )}

          {/* Form view: payload-only, schema-driven (WM-76). */}
          <div hidden={tab !== "form"}>
            {formFields.length === 0 ? (
              <div className="rounded-md border border-(--border) bg-(--surface-0) p-3 text-[12px] text-(--text-faint)">
                {String(formBase.type ?? "this event type")} takes no payload fields — inject as-is, or switch to
                the JSON tab.
              </div>
            ) : (
              <div className="max-h-[340px] overflow-y-auto rounded-md border border-(--border) bg-(--surface-0) p-3">
                {requiredFields.map(renderField)}
                {optionalFields.length > 0 && (
                  <div className="mt-2 border-t border-(--border) pt-2">
                    <Disclosure label={`Optional fields (${optionalFields.length})`}>
                      {optionalFields.map(renderField)}
                    </Disclosure>
                  </div>
                )}
              </div>
            )}

            {unknown.length > 0 && (
              <div className="mt-2 rounded-md px-2.5 py-1.5 text-[11px]" style={warnStyle}>
                Unknown payload key{unknown.length > 1 ? "s" : ""} kept: {unknown.join(", ")} — the schema does
                not declare {unknown.length > 1 ? "them" : "it"}; edit or remove in the JSON tab.
              </div>
            )}
            {formLevelErrors.length > 0 && (
              <div className="mt-2 rounded-md px-2.5 py-1.5 text-[11px]" style={warnStyle}>
                {formLevelErrors.map((e, i) => (
                  <div key={i}>{e}</div>
                ))}
              </div>
            )}

            <div className="mt-2">
              <Disclosure label="Envelope preview — the exact envelope that will be sent">
                <JsonBlock value={formEnvelope} />
              </Disclosure>
            </div>
          </div>

          {/* JSON view: full-envelope escape hatch. */}
          <div hidden={tab !== "json"}>
            <textarea
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                resetAcks();
              }}
              spellCheck={false}
              rows={15}
              aria-label="Event envelope JSON"
              className="mono w-full resize-y rounded-md border border-(--border) bg-(--surface-0) p-3 text-[12px] leading-relaxed text-(--text) outline-none focus:border-(--border-strong)"
            />
            {jsonSchemaErrors.length > 0 && (
              <div className="mt-2 rounded-md px-2.5 py-1.5 text-[11px]" style={warnStyle}>
                <div className="mb-0.5 font-medium">
                  payload does not validate against the registered input schema (
                  {jsonSchemaErrors.length} issue{jsonSchemaErrors.length > 1 ? "s" : ""}):
                </div>
                {jsonSchemaErrors.slice(0, 6).map((e, i) => (
                  <div key={i} className="mono">
                    {e}
                  </div>
                ))}
                {jsonSchemaErrors.length > 6 && <div>… and {jsonSchemaErrors.length - 6} more</div>}
              </div>
            )}
          </div>

          {clientError && <VerbError error={new Error(clientError)} />}
          <VerbError error={inject.error} />
          {outcome && (
            <div
              className="mt-2 rounded-md px-2.5 py-1.5 text-[12px]"
              style={{
                color: outcome.duplicate ? "var(--hue-warn)" : "var(--hue-ok)",
                background: `color-mix(in oklch, ${outcome.duplicate ? "var(--hue-warn)" : "var(--hue-ok)"} 10%, transparent)`,
              }}
            >
              {outcome.duplicate
                ? `duplicate — event ${outcome.eventId} was already admitted (dedup working as designed)`
                : `admitted event ${outcome.eventId} — the planner proposes next`}
            </div>
          )}

          {confirming && !outcome && (
            <div className="mt-2 text-[12px] text-(--text-dim)">
              Confirm sends this envelope through intake. A known event id is reported as a duplicate and
              does nothing — that is Replay&apos;s demo, not a new event. Use Trigger again for a fresh id.
            </div>
          )}

          <div className="mt-3 flex justify-end gap-2">
            <Button onClick={onClose}>Close</Button>
            {confirming ? (
              <>
                <Button onClick={() => setConfirming(false)}>Back</Button>
                <Button
                  variant={schemaAck ? "danger" : "primary"}
                  onClick={submit}
                  disabled={inject.isPending}
                  autoFocus
                >
                  {schemaAck ? "Inject anyway" : "Confirm inject"}
                </Button>
              </>
            ) : (
              <Button variant="primary" onClick={submit} disabled={inject.isPending}>
                Inject… <span className="mono ml-1 text-(--text-faint)" aria-hidden="true">⌘↵</span>
              </Button>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
