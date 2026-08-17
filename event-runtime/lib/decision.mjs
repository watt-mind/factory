import { readFileSync } from "node:fs";
import { hashJson } from "./canonical.mjs";
import { validate } from "./schema.mjs";

const requestSchema = JSON.parse(
  readFileSync(new URL("../schemas/factory.decision-request.v1.json", import.meta.url), "utf8"),
);
const responseSchema = JSON.parse(
  readFileSync(new URL("../schemas/factory.decision-response.v1.json", import.meta.url), "utf8"),
);

const hasOwn = (value, key) =>
  value !== null && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key);

const COMMON_FIELD_KEYS = new Set(["id", "kind", "label", "required", "whenOption"]);
const FIELD_KEYS = {
  text: new Set([...COMMON_FIELD_KEYS, "placeholder", "maxLength"]),
  "single-choice": new Set([...COMMON_FIELD_KEYS, "choices"]),
  "multi-choice": new Set([...COMMON_FIELD_KEYS, "choices", "minItems", "maxItems"]),
  confirm: COMMON_FIELD_KEYS,
  number: new Set([...COMMON_FIELD_KEYS, "minimum", "maximum", "integer"]),
};

const EFFECT_REFS = {
  authorise: ["issue", "repo", "runId"],
  send_to_triage: ["issue"],
  answer: ["issue"],
  requeue: ["eventSource", "eventId"],
  approve_proposal: ["proposalId"],
  reject_proposal: ["proposalId"],
  dismiss: [],
};
const RESPONSE_VALIDATION_REFS = Object.fromEntries(
  [...new Set(Object.values(EFFECT_REFS).flat())].map((key) => [key, "response-validation"]),
);

function result(errors) {
  return { valid: errors.length === 0, errors };
}

function usableRef(refs, key) {
  return hasOwn(refs, key) && typeof refs[key] === "string" && refs[key].trim().length > 0;
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
  const shape = validate(requestSchema, request);
  if (!shape.valid) return shape;

  const errors = [];
  if (request.context !== undefined && Buffer.byteLength(request.context, "utf8") > 8192) {
    errors.push("$.context: longer than 8 KiB when encoded as UTF-8");
  }
  const optionIds = request.options.map((option) => option.id);
  const optionIdSet = new Set(optionIds);

  for (const id of duplicateValues(optionIds)) errors.push(`$.options: duplicate option id "${id}"`);
  if (request.recommended !== undefined && !optionIdSet.has(request.recommended)) {
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
          errors.push(`${path}.scope.paths: path must be repo-relative: "${scopedPath}"`);
        }
      }
    }

    for (const ref of EFFECT_REFS[option.effect]) {
      if (!usableRef(refs, ref)) errors.push(`${path}.effect: "${option.effect}" requires refs.${ref}`);
    }
  }

  const fields = request.fields ?? [];
  for (const id of duplicateValues(fields.map((field) => field.id))) {
    errors.push(`$.fields: duplicate field id "${id}"`);
  }

  for (const [index, field] of fields.entries()) {
    const path = `$.fields[${index}]`;
    for (const key of Object.keys(field)) {
      if (!FIELD_KEYS[field.kind].has(key)) errors.push(`${path}.${key}: not allowed for kind "${field.kind}"`);
    }

    if (field.whenOption !== undefined) {
      for (const id of duplicateValues(field.whenOption)) {
        errors.push(`${path}.whenOption: duplicate option id "${id}"`);
      }
      for (const id of field.whenOption) {
        if (!optionIdSet.has(id)) errors.push(`${path}.whenOption: unknown option id "${id}"`);
      }
    }

    if (field.kind === "single-choice" || field.kind === "multi-choice") {
      if (field.choices === undefined) {
        errors.push(`${path}.choices: required for kind "${field.kind}"`);
      } else {
        const minimum = field.kind === "single-choice" ? 2 : 1;
        const maximum = field.kind === "single-choice" ? 12 : 24;
        if (field.choices.length < minimum || field.choices.length > maximum) {
          errors.push(`${path}.choices: ${field.kind} requires ${minimum}–${maximum} choices`);
        }
        for (const id of duplicateValues(field.choices.map((choice) => choice.id))) {
          errors.push(`${path}.choices: duplicate choice id "${id}"`);
        }
      }
    }

    if (field.kind === "multi-choice" && field.choices !== undefined) {
      const minimum = field.minItems ?? 0;
      const maximum = field.maxItems ?? field.choices.length;
      if (minimum > maximum) errors.push(`${path}: minItems cannot exceed maxItems`);
      if (minimum > field.choices.length) errors.push(`${path}.minItems: cannot exceed the number of choices`);
      if (maximum > field.choices.length) errors.push(`${path}.maxItems: cannot exceed the number of choices`);
    }

    if (field.kind === "number" && field.minimum !== undefined && field.maximum !== undefined) {
      if (field.minimum > field.maximum) errors.push(`${path}: minimum cannot exceed maximum`);
    }
  }

  for (const [index, option] of request.options.entries()) {
    if (option.effect !== "reject_proposal") continue;
    const reasonField = fields.some(
      (field) =>
        field.kind === "text" &&
        field.required === true &&
        (field.whenOption === undefined || field.whenOption.includes(option.id)),
    );
    if (!reasonField) {
      errors.push(
        `$.options[${index}].effect: "reject_proposal" requires an applicable required text field`,
      );
    }
  }

  return result(errors);
}

/** Return the canonical identity a response must bind to. */
export function decisionRequestHash(request) {
  return hashJson(request);
}

function validateFieldValue(field, value, path, errors) {
  if (field.kind === "text") {
    if (typeof value !== "string") {
      errors.push(`${path}: expected string`);
      return;
    }
    const maximum = field.maxLength ?? 2000;
    if (field.required === true && value.length === 0) errors.push(`${path}: required text must not be empty`);
    if (value.length > maximum) errors.push(`${path}: longer than maxLength ${maximum}`);
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
    for (const id of duplicates) errors.push(`${path}: duplicate choice id "${id}"`);
    const choices = new Set(field.choices.map((choice) => choice.id));
    for (const id of value) {
      if (!choices.has(id)) errors.push(`${path}: unknown choice id "${id}"`);
    }
    const minimum = field.minItems ?? (field.required === true ? 1 : 0);
    const maximum = field.maxItems ?? field.choices.length;
    if (value.length < minimum) errors.push(`${path}: fewer than minItems ${minimum}`);
    if (value.length > maximum) errors.push(`${path}: more than maxItems ${maximum}`);
    return;
  }

  if (field.kind === "confirm") {
    if (typeof value !== "boolean") errors.push(`${path}: expected boolean`);
    else if (field.required === true && value !== true) errors.push(`${path}: required confirmation must be true`);
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
  if (field.integer === true && !Number.isInteger(value)) errors.push(`${path}: expected an integer`);
}

/**
 * Validate one operator response against the exact request it answers.
 *
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateDecisionResponse(response, request) {
  const responseShape = validate(responseSchema, response);
  if (!responseShape.valid) return responseShape;

  const requestCheck = validateDecisionRequest(request, { refs: RESPONSE_VALIDATION_REFS });
  if (!requestCheck.valid) {
    return result(requestCheck.errors.map((error) => `request ${error}`));
  }

  const errors = [];
  if (response.requestHash !== decisionRequestHash(request)) errors.push("$.requestHash: does not match request");

  const option = request.options.find((candidate) => candidate.id === response.optionId);
  if (option === undefined) {
    errors.push(`$.optionId: unknown option id "${response.optionId}"`);
    return result(errors);
  }

  const declaredFields = new Map((request.fields ?? []).map((field) => [field.id, field]));
  const applicableFields = (request.fields ?? []).filter(
    (field) => field.whenOption === undefined || field.whenOption.includes(option.id),
  );
  const applicableIds = new Set(applicableFields.map((field) => field.id));

  for (const key of Object.keys(response.fields)) {
    if (!declaredFields.has(key)) errors.push(`$.fields.${key}: undeclared field`);
    else if (!applicableIds.has(key)) errors.push(`$.fields.${key}: field does not apply to option "${option.id}"`);
  }

  for (const field of applicableFields) {
    const present = hasOwn(response.fields, field.id);
    if (!present) {
      if (field.required === true) errors.push(`$.fields.${field.id}: required field is missing`);
      continue;
    }
    validateFieldValue(field, response.fields[field.id], `$.fields.${field.id}`, errors);
  }

  return result(errors);
}
