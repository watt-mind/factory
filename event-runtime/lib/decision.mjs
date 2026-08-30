/**
 * Decision contracts — `factory.decision-request/v1` and
 * `factory.decision-response/v1` (docs/event-runtime-inbox.md §2, §3).
 *
 * A decision request is a bounded question an agent (or the runtime) puts to
 * the operator: 1–6 options each carrying a runtime effect, plus 0–6 gated
 * fields from a closed widget vocabulary. A response is the operator's answer,
 * hash-bound to the exact request it was looking at. Both go through the same
 * closed-keyword `lib/schema.mjs` as every other contract; the rules JSON
 * Schema cannot express (id references, effect↔refs legality, per-kind field
 * keys, per-option field applicability) live here, as `lib/artifact-view.mjs`
 * does for views. Pure and fail-closed: `{ valid, errors }`, never throws on
 * data, no I/O beyond loading the schemas once.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { hashJson } from "./canonical.mjs";
import { RUNTIME_ROOT } from "./config.mjs";
import { validate } from "./schema.mjs";

export const DECISION_REQUEST_SCHEMA_VERSION = "factory.decision-request/v1";
export const DECISION_RESPONSE_SCHEMA_VERSION = "factory.decision-response/v1";
export const DECISION_REQUEST_SCHEMA = JSON.parse(
  readFileSync(
    path.join(RUNTIME_ROOT, "schemas", "factory.decision-request.v1.json"),
    "utf8",
  ),
);
export const DECISION_RESPONSE_SCHEMA = JSON.parse(
  readFileSync(
    path.join(RUNTIME_ROOT, "schemas", "factory.decision-response.v1.json"),
    "utf8",
  ),
);

/** §2.1 `context` bound is a byte size, not a code-unit count. */
export const CONTEXT_MAX_BYTES = 8 * 1024;
/** §2.3 `text` defaults. */
export const TEXT_DEFAULT_MAX_LENGTH = 2000;
export const WIDGET_KINDS = [
  "text",
  "single-choice",
  "multi-choice",
  "confirm",
  "number",
];
export const EFFECTS = [
  "authorise",
  "send_to_triage",
  "answer",
  "requeue",
  "approve_proposal",
  "reject_proposal",
  "dismiss",
];

const hasOwn = (value, key) =>
  value !== null &&
  typeof value === "object" &&
  Object.prototype.hasOwnProperty.call(value, key);

/** Keys every field may carry, plus the per-`kind` extras (§2.3 "Extra keys"). */
const COMMON_FIELD_KEYS = new Set([
  "id",
  "kind",
  "label",
  "required",
  "whenOption",
]);
const FIELD_KEYS = {
  text: new Set([...COMMON_FIELD_KEYS, "placeholder", "maxLength"]),
  "single-choice": new Set([...COMMON_FIELD_KEYS, "choices"]),
  "multi-choice": new Set([
    ...COMMON_FIELD_KEYS,
    "choices",
    "minItems",
    "maxItems",
  ]),
  confirm: COMMON_FIELD_KEYS,
  number: new Set([...COMMON_FIELD_KEYS, "minimum", "maximum", "integer"]),
};

/** §3 legality table: refs an item must carry for each effect to be offered. */
export const EFFECT_REFS = {
  authorise: ["issue", "repo", "runId"],
  send_to_triage: ["issue"],
  answer: ["issue"],
  requeue: ["eventSource", "eventId"],
  approve_proposal: ["proposalId"],
  reject_proposal: ["proposalId"],
  dismiss: [],
};
function result(errors) {
  return { valid: errors.length === 0, errors };
}

function usableRef(refs, key) {
  return (
    hasOwn(refs, key) &&
    typeof refs[key] === "string" &&
    refs[key].trim().length > 0
  );
}

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

/**
 * Validate the bounded request contract and the cross-field/effect rules that
 * the runtime's deliberately small JSON Schema subset cannot express.
 *
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateDecisionRequest(request, { refs = {} } = {}) {
  return checkRequest(request, { refs, checkEffectLegality: true });
}

/**
 * Shared body: the response validator re-checks the request it is answering
 * (a malformed request cannot be answered correctly) but effect legality is a
 * creation-time concern (§3) — the refs are not on hand at answer time.
 */
function checkRequest(request, { refs, checkEffectLegality }) {
  const shape = validate(DECISION_REQUEST_SCHEMA, request);
  if (!shape.valid) return shape;

  const errors = [];
  if (
    request.context !== undefined &&
    Buffer.byteLength(request.context, "utf8") > CONTEXT_MAX_BYTES
  ) {
    errors.push(
      `$.context: longer than ${CONTEXT_MAX_BYTES} bytes when encoded as UTF-8`,
    );
  }
  const optionIds = request.options.map((option) => option.id);
  const optionIdSet = new Set(optionIds);

  for (const id of duplicateValues(optionIds))
    errors.push(`$.options: duplicate option id "${id}"`);
  if (
    request.recommended !== undefined &&
    !optionIdSet.has(request.recommended)
  ) {
    errors.push(`$.recommended: unknown option id "${request.recommended}"`);
  }

  for (const [index, option] of request.options.entries()) {
    const path = `$.options[${index}]`;
    const hasScope = hasOwn(option, "scope");
    if (option.effect === "authorise" && !hasScope) {
      errors.push(`${path}.scope: required for effect "authorise"`);
    } else if (option.effect !== "authorise" && hasScope) {
      errors.push(`${path}.scope: only allowed for effect "authorise"`);
    }
    if (option.effect === "authorise" && hasScope) {
      for (const scopedPath of option.scope.paths) {
        const segments = scopedPath.split(/[\\/]/);
        if (
          scopedPath.startsWith("/") ||
          scopedPath.startsWith("\\") ||
          /^[a-zA-Z]:[\\/]/.test(scopedPath) ||
          segments.includes("..")
        ) {
          errors.push(
            `${path}.scope.paths: path must be repo-relative: "${scopedPath}"`,
          );
        }
      }
    }

    if (checkEffectLegality) {
      for (const ref of EFFECT_REFS[option.effect]) {
        if (!usableRef(refs, ref))
          errors.push(
            `${path}.effect: "${option.effect}" requires refs.${ref}`,
          );
      }
    }
  }

  const fields = request.fields ?? [];
  for (const id of duplicateValues(fields.map((field) => field.id))) {
    errors.push(`$.fields: duplicate field id "${id}"`);
  }

  for (const [index, field] of fields.entries()) {
    const path = `$.fields[${index}]`;
    for (const key of Object.keys(field)) {
      if (!FIELD_KEYS[field.kind].has(key))
        errors.push(`${path}.${key}: not allowed for kind "${field.kind}"`);
    }

    if (field.whenOption !== undefined) {
      for (const id of duplicateValues(field.whenOption)) {
        errors.push(`${path}.whenOption: duplicate option id "${id}"`);
      }
      for (const id of field.whenOption) {
        if (!optionIdSet.has(id))
          errors.push(`${path}.whenOption: unknown option id "${id}"`);
      }
    }

    if (field.kind === "single-choice" || field.kind === "multi-choice") {
      if (field.choices === undefined) {
        errors.push(`${path}.choices: required for kind "${field.kind}"`);
      } else {
        const minimum = field.kind === "single-choice" ? 2 : 1;
        const maximum = field.kind === "single-choice" ? 12 : 24;
        if (field.choices.length < minimum || field.choices.length > maximum) {
          errors.push(
            `${path}.choices: ${field.kind} requires ${minimum}–${maximum} choices`,
          );
        }
        for (const id of duplicateValues(
          field.choices.map((choice) => choice.id),
        )) {
          errors.push(`${path}.choices: duplicate choice id "${id}"`);
        }
      }
    }

    if (field.kind === "multi-choice" && field.choices !== undefined) {
      const minimum = field.minItems ?? 0;
      const maximum = field.maxItems ?? field.choices.length;
      if (minimum > maximum)
        errors.push(`${path}: minItems cannot exceed maxItems`);
      if (minimum > field.choices.length)
        errors.push(`${path}.minItems: cannot exceed the number of choices`);
      if (maximum > field.choices.length)
        errors.push(`${path}.maxItems: cannot exceed the number of choices`);
    }

    if (
      field.kind === "number" &&
      field.minimum !== undefined &&
      field.maximum !== undefined
    ) {
      if (field.minimum > field.maximum)
        errors.push(`${path}: minimum cannot exceed maximum`);
    }
  }

  for (const option of request.options) {
    if (option.effect !== "answer" && option.effect !== "reject_proposal")
      continue;
    const textField = fields.some(
      (field) =>
        field.kind === "text" &&
        field.required === true &&
        (field.whenOption === undefined ||
          field.whenOption.includes(option.id)),
    );
    if (!textField) {
      errors.push(`option_requires_text:${option.id}`);
    }
  }

  return result(errors);
}

/** The identity a response binds to (§2.2 `requestHash`): canonical-JSON sha256. */
export function decisionRequestHash(request) {
  return hashJson(request);
}

function validateFieldValue(field, value, path, errors) {
  if (field.kind === "text") {
    if (typeof value !== "string") {
      errors.push(`${path}: expected string`);
      return;
    }
    const maximum = field.maxLength ?? TEXT_DEFAULT_MAX_LENGTH;
    if (field.required === true && value.trim().length === 0)
      errors.push(`${path}: required text must not be empty`);
    if (value.length > maximum)
      errors.push(`${path}: longer than maxLength ${maximum}`);
    return;
  }

  if (field.kind === "single-choice") {
    if (typeof value !== "string") {
      errors.push(`${path}: expected a choice id string`);
      return;
    }
    if (!field.choices.some((choice) => choice.id === value)) {
      errors.push(`${path}: unknown choice id "${value}"`);
    }
    return;
  }

  if (field.kind === "multi-choice") {
    if (!Array.isArray(value)) {
      errors.push(`${path}: expected an array of choice ids`);
      return;
    }
    if (!value.every((entry) => typeof entry === "string")) {
      errors.push(`${path}: every choice id must be a string`);
      return;
    }
    const duplicates = duplicateValues(value);
    for (const id of duplicates)
      errors.push(`${path}: duplicate choice id "${id}"`);
    const choices = new Set(field.choices.map((choice) => choice.id));
    for (const id of value) {
      if (!choices.has(id)) errors.push(`${path}: unknown choice id "${id}"`);
    }
    const minimum = field.minItems ?? (field.required === true ? 1 : 0);
    const maximum = field.maxItems ?? field.choices.length;
    if (value.length < minimum)
      errors.push(`${path}: fewer than minItems ${minimum}`);
    if (value.length > maximum)
      errors.push(`${path}: more than maxItems ${maximum}`);
    return;
  }

  if (field.kind === "confirm") {
    if (typeof value !== "boolean") errors.push(`${path}: expected boolean`);
    else if (field.required === true && value !== true)
      errors.push(`${path}: required confirmation must be true`);
    return;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push(`${path}: expected a finite number`);
    return;
  }
  if (field.minimum !== undefined && value < field.minimum) {
    errors.push(`${path}: below minimum ${field.minimum}`);
  }
  if (field.maximum !== undefined && value > field.maximum) {
    errors.push(`${path}: above maximum ${field.maximum}`);
  }
  if (field.integer === true && !Number.isInteger(value))
    errors.push(`${path}: expected an integer`);
}

/**
 * Validate one operator response against the exact request it answers.
 *
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateDecisionResponse(response, request) {
  const responseShape = validate(DECISION_RESPONSE_SCHEMA, response);
  if (!responseShape.valid) return responseShape;

  const requestCheck = checkRequest(request, {
    refs: {},
    checkEffectLegality: false,
  });
  if (!requestCheck.valid) {
    return result(requestCheck.errors.map((error) => `request ${error}`));
  }

  const errors = [];
  if (response.requestHash !== decisionRequestHash(request))
    errors.push("$.requestHash: does not match request");

  const option = request.options.find(
    (candidate) => candidate.id === response.optionId,
  );
  if (option === undefined) {
    errors.push(`$.optionId: unknown option id "${response.optionId}"`);
    return result(errors);
  }

  const declaredFields = new Map(
    (request.fields ?? []).map((field) => [field.id, field]),
  );
  const applicableFields = (request.fields ?? []).filter(
    (field) =>
      field.whenOption === undefined || field.whenOption.includes(option.id),
  );
  const applicableIds = new Set(applicableFields.map((field) => field.id));

  for (const key of Object.keys(response.fields)) {
    if (!declaredFields.has(key))
      errors.push(`$.fields.${key}: undeclared field`);
    else if (!applicableIds.has(key))
      errors.push(
        `$.fields.${key}: field does not apply to option "${option.id}"`,
      );
  }

  for (const field of applicableFields) {
    const present = hasOwn(response.fields, field.id);
    if (!present) {
      if (field.required === true)
        errors.push(`$.fields.${field.id}: required field is missing`);
      continue;
    }
    validateFieldValue(
      field,
      response.fields[field.id],
      `$.fields.${field.id}`,
      errors,
    );
  }

  return result(errors);
}
