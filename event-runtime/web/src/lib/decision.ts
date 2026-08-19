/**
 * Browser port of event-runtime/lib/decision.mjs response validation and
 * request hashing. Keep the validation rules in sync with the runtime.
 */
import type {
  DecisionField,
  DecisionRequest,
  DecisionResponse,
} from "../types";
import { validate, type ValidationResult } from "./schema";

const ID_SCHEMA = { type: "string", pattern: "^[a-z][a-z0-9_-]{0,31}$" };
const CHOICE_SCHEMA = {
  type: "object",
  required: ["id", "label"],
  additionalProperties: false,
  properties: {
    id: ID_SCHEMA,
    label: { type: "string", minLength: 1, maxLength: 60 },
    description: { type: "string", maxLength: 280 },
  },
};
const DECISION_REQUEST_SCHEMA = {
  type: "object",
  required: ["schemaVersion", "question", "options"],
  additionalProperties: false,
  properties: {
    schemaVersion: { const: "factory.decision-request/v1" },
    question: { type: "string", minLength: 1, maxLength: 280 },
    context: { type: "string", maxLength: 8192 },
    recommended: ID_SCHEMA,
    options: {
      type: "array",
      minItems: 1,
      maxItems: 6,
      items: {
        type: "object",
        required: ["id", "label", "effect"],
        additionalProperties: false,
        properties: {
          id: ID_SCHEMA,
          label: { type: "string", minLength: 1, maxLength: 60 },
          description: { type: "string", maxLength: 280 },
          effect: {
            enum: [
              "authorise",
              "send_to_triage",
              "answer",
              "requeue",
              "approve_proposal",
              "reject_proposal",
              "dismiss",
            ],
          },
          tone: { enum: ["primary", "danger", "neutral"] },
          scope: {
            type: "object",
            required: ["paths", "summary"],
            additionalProperties: false,
            properties: {
              paths: {
                type: "array",
                minItems: 1,
                maxItems: 32,
                items: { type: "string", minLength: 1 },
              },
              summary: { type: "string", minLength: 1, maxLength: 500 },
            },
          },
        },
      },
    },
    fields: {
      type: "array",
      minItems: 0,
      maxItems: 6,
      items: {
        type: "object",
        required: ["id", "kind", "label"],
        additionalProperties: false,
        properties: {
          id: ID_SCHEMA,
          kind: {
            enum: [
              "text",
              "single-choice",
              "multi-choice",
              "confirm",
              "number",
            ],
          },
          label: { type: "string", minLength: 1, maxLength: 60 },
          required: { type: "boolean" },
          whenOption: {
            type: "array",
            minItems: 1,
            maxItems: 6,
            items: ID_SCHEMA,
          },
          placeholder: { type: "string", maxLength: 280 },
          maxLength: { type: "integer", minimum: 1, maximum: 8192 },
          choices: {
            type: "array",
            minItems: 1,
            maxItems: 24,
            items: CHOICE_SCHEMA,
          },
          minItems: { type: "integer", minimum: 0, maximum: 24 },
          maxItems: { type: "integer", minimum: 0, maximum: 24 },
          minimum: { type: "number" },
          maximum: { type: "number" },
          integer: { type: "boolean" },
        },
      },
    },
  },
};

const DECISION_RESPONSE_SCHEMA = {
  type: "object",
  required: [
    "schemaVersion",
    "requestHash",
    "optionId",
    "fields",
    "decidedBy",
    "decidedAt",
  ],
  additionalProperties: false,
  properties: {
    schemaVersion: { const: "factory.decision-response/v1" },
    requestHash: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
    optionId: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,31}$" },
    fields: { type: "object", additionalProperties: {} },
    decidedBy: { type: "string", minLength: 1, maxLength: 120 },
    decidedAt: {
      type: "string",
      pattern:
        "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$",
    },
  },
};

const hasOwn = (value: unknown, key: string): boolean =>
  value !== null &&
  typeof value === "object" &&
  Object.prototype.hasOwnProperty.call(value, key);

const COMMON_FIELD_KEYS = new Set([
  "id",
  "kind",
  "label",
  "required",
  "whenOption",
]);
const FIELD_KEYS: Record<DecisionField["kind"], Set<string>> = {
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

function result(errors: string[]): ValidationResult {
  return { valid: errors.length === 0, errors };
}

function duplicateValues(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

/** The response port re-checks the semantic request rules needed at answer time. */
export function checkRequest(request: DecisionRequest): ValidationResult {
  const shape = validate(DECISION_REQUEST_SCHEMA, request);
  if (!shape.valid) return shape;
  const errors: string[] = [];
  if (
    request.context !== undefined &&
    new TextEncoder().encode(request.context).byteLength > 8 * 1024
  ) {
    errors.push("$.context: longer than 8192 bytes when encoded as UTF-8");
  }
  const optionIds = request.options.map((option) => option.id);
  const optionIdSet = new Set(optionIds);
  for (const id of duplicateValues(optionIds))
    errors.push(`$.options: duplicate option id "${id}"`);
  if (
    request.recommended !== undefined &&
    !optionIdSet.has(request.recommended)
  )
    errors.push(`$.recommended: unknown option id "${request.recommended}"`);

  for (const [index, option] of request.options.entries()) {
    const path = `$.options[${index}]`;
    const hasScope = hasOwn(option, "scope");
    if (option.effect === "authorise" && !hasScope)
      errors.push(`${path}.scope: required for effect "authorise"`);
    else if (option.effect !== "authorise" && hasScope)
      errors.push(`${path}.scope: only allowed for effect "authorise"`);
    if (option.effect === "authorise" && option.scope) {
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
  }

  const fields = request.fields ?? [];
  for (const id of duplicateValues(fields.map((field) => field.id)))
    errors.push(`$.fields: duplicate field id "${id}"`);
  for (const [index, field] of fields.entries()) {
    const path = `$.fields[${index}]`;
    for (const key of Object.keys(field)) {
      if (!FIELD_KEYS[field.kind].has(key))
        errors.push(`${path}.${key}: not allowed for kind "${field.kind}"`);
    }
    if (field.whenOption !== undefined) {
      for (const id of duplicateValues(field.whenOption))
        errors.push(`${path}.whenOption: duplicate option id "${id}"`);
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
        if (field.choices.length < minimum || field.choices.length > maximum)
          errors.push(
            `${path}.choices: ${field.kind} requires ${minimum}–${maximum} choices`,
          );
        for (const id of duplicateValues(
          field.choices.map((choice) => choice.id),
        ))
          errors.push(`${path}.choices: duplicate choice id "${id}"`);
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
      field.maximum !== undefined &&
      field.minimum > field.maximum
    )
      errors.push(`${path}: minimum cannot exceed maximum`);
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
    if (!textField) errors.push(`option_requires_text:${option.id}`);
  }
  return result(errors);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value, "$"));
}

function sortValue(value: unknown, path: string): unknown {
  if (value === undefined)
    throw new TypeError(
      `undefined at ${path} is not representable in canonical JSON`,
    );
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value))
      throw new TypeError(
        `non-finite number at ${path} is not representable in canonical JSON`,
      );
    if (typeof value === "bigint")
      throw new TypeError(
        `bigint at ${path} is not representable in canonical JSON`,
      );
    return value;
  }
  if (Array.isArray(value))
    return value.map((entry, index) => sortValue(entry, `${path}[${index}]`));
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const entry = (value as Record<string, unknown>)[key];
    if (entry === undefined) continue;
    sorted[key] = sortValue(entry, `${path}.${key}`);
  }
  return sorted;
}

const SHA256_INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
  0x1f83d9ab, 0x5be0cd19,
];
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const rotateRight = (value: number, bits: number): number =>
  (value >>> bits) | (value << (32 - bits));

function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLength = bytes.length * 8;
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  const hash = [...SHA256_INITIAL];
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 =
        rotateRight(words[i - 15], 7) ^
        rotateRight(words[i - 15], 18) ^
        (words[i - 15] >>> 3);
      const s1 =
        rotateRight(words[i - 2], 17) ^
        rotateRight(words[i - 2], 19) ^
        (words[i - 2] >>> 10);
      words[i] = (words[i - 16] + s0 + words[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let i = 0; i < 64; i++) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + choice + SHA256_K[i] + words[i]) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }
  return hash.map((word) => word.toString(16).padStart(8, "0")).join("");
}

/** The identity a response binds to: canonical-JSON sha256. */
export function decisionRequestHash(request: DecisionRequest): string {
  return `sha256:${sha256Hex(canonicalJson(request))}`;
}

function validateFieldValue(
  field: DecisionField,
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (field.kind === "text") {
    if (typeof value !== "string") {
      errors.push(`${path}: expected string`);
      return;
    }
    const maximum = field.maxLength ?? 2000;
    if (field.required === true && value.length === 0)
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
    if (!field.choices.some((choice) => choice.id === value))
      errors.push(`${path}: unknown choice id "${value}"`);
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
    for (const id of duplicateValues(value))
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
  if (field.minimum !== undefined && value < field.minimum)
    errors.push(`${path}: below minimum ${field.minimum}`);
  if (field.maximum !== undefined && value > field.maximum)
    errors.push(`${path}: above maximum ${field.maximum}`);
  if (field.integer === true && !Number.isInteger(value))
    errors.push(`${path}: expected an integer`);
}

/** Validate one operator response against the exact request it answers. */
export function validateDecisionResponse(
  response: DecisionResponse,
  request: DecisionRequest,
): ValidationResult {
  const responseShape = validate(DECISION_RESPONSE_SCHEMA, response);
  if (!responseShape.valid) return responseShape;
  const requestCheck = checkRequest(request);
  if (!requestCheck.valid)
    return result(requestCheck.errors.map((error) => `request ${error}`));

  const errors: string[] = [];
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
  const applicable = (request.fields ?? []).filter(
    (field) =>
      field.whenOption === undefined || field.whenOption.includes(option.id),
  );
  const applicableIds = new Set(applicable.map((field) => field.id));
  for (const key of Object.keys(response.fields)) {
    if (!declaredFields.has(key))
      errors.push(`$.fields.${key}: undeclared field`);
    else if (!applicableIds.has(key))
      errors.push(
        `$.fields.${key}: field does not apply to option "${option.id}"`,
      );
  }
  for (const field of applicable) {
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
