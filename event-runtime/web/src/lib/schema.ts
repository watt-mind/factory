/**
 * Minimal JSON Schema validator — browser port of event-runtime/lib/schema.mjs
 * (WM-76). Keep the two in sync: this file mirrors the runtime validator
 * line-for-line so what the form flags matches what the contract gate flags.
 * Contracts fail closed (docs/event-runtime.md §5): an unsupported schema
 * keyword is an error in the schema, not a silently-passing check.
 */

const SUPPORTED = new Set([
  "type",
  "enum",
  "const",
  "required",
  "properties",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "description",
  "title",
  "format",
  "$schema",
]);

/** Closed UI/validation hints (WM-920). Unknown values fail closed. */
export const SCHEMA_FORMATS = Object.freeze([
  "secret",
  "uri",
  "channel-id",
  "ticket",
  "duration",
  "multiline",
  "email",
]);
const FORMAT_SET = new Set(SCHEMA_FORMATS);
const DURATION_PATTERN = /^\d+(ms|s|m|h|d)$/;

const hasOwn = (obj: unknown, key: string): boolean =>
  obj !== null &&
  typeof obj === "object" &&
  Object.prototype.hasOwnProperty.call(obj, key);

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validate(
  schema: unknown,
  value: unknown,
  path = "$",
): ValidationResult {
  const errors: string[] = [];
  check(schema, value, path, errors);
  return { valid: errors.length === 0, errors };
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number")
    return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function matchesType(declared: string, actual: string): boolean {
  return declared === actual || (declared === "number" && actual === "integer");
}

function check(
  schema: unknown,
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (schema === undefined || schema === null) {
    errors.push(`${path}: schema is missing`);
    return;
  }
  if (typeof schema !== "object" || Array.isArray(schema)) {
    errors.push(`${path}: schema must be an object`);
    return;
  }
  const s = schema as Record<string, unknown>;
  for (const key of Object.keys(s)) {
    if (!SUPPORTED.has(key)) {
      errors.push(
        `${path}: unsupported schema keyword "${key}" — contracts fail closed`,
      );
      return;
    }
  }

  if (hasOwn(s, "format")) {
    if (typeof s.format !== "string" || !FORMAT_SET.has(s.format)) {
      errors.push(
        `${path}: unsupported format ${JSON.stringify(s.format)} — contracts fail closed`,
      );
      return;
    }
  }

  const actual = typeOf(value);

  if (hasOwn(s, "type") && s.type !== undefined) {
    const declared = Array.isArray(s.type)
      ? (s.type as string[])
      : [s.type as string];
    if (!declared.some((t) => matchesType(t, actual))) {
      errors.push(
        `${path}: expected type ${declared.join("|")}, got ${actual}`,
      );
      return;
    }
  }

  if (hasOwn(s, "const") && JSON.stringify(value) !== JSON.stringify(s.const)) {
    errors.push(`${path}: expected const ${JSON.stringify(s.const)}`);
  }
  if (
    hasOwn(s, "enum") &&
    Array.isArray(s.enum) &&
    !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))
  ) {
    errors.push(`${path}: value not in enum ${JSON.stringify(s.enum)}`);
  }

  if (actual === "string") {
    const str = value as string;
    if (
      hasOwn(s, "minLength") &&
      typeof s.minLength === "number" &&
      str.length < s.minLength
    ) {
      errors.push(`${path}: shorter than minLength ${s.minLength}`);
    }
    if (
      hasOwn(s, "maxLength") &&
      typeof s.maxLength === "number" &&
      str.length > s.maxLength
    ) {
      errors.push(`${path}: longer than maxLength ${s.maxLength}`);
    }
    if (hasOwn(s, "pattern") && typeof s.pattern === "string") {
      let pattern: RegExp;
      try {
        pattern = new RegExp(s.pattern);
      } catch {
        errors.push(`${path}: invalid pattern`);
        return;
      }
      if (!pattern.test(str)) {
        errors.push(`${path}: does not match pattern ${s.pattern}`);
      }
    }
    if (s.format === "uri" && !URL.canParse(str)) {
      errors.push(`${path}: format "uri" value is not a valid URI`);
    }
    if (s.format === "duration" && !DURATION_PATTERN.test(str)) {
      errors.push(`${path}: format "duration" must match ${DURATION_PATTERN}`);
    }
  }

  if (actual === "integer" || actual === "number") {
    const num = value as number;
    if (
      hasOwn(s, "minimum") &&
      typeof s.minimum === "number" &&
      num < s.minimum
    ) {
      errors.push(`${path}: below minimum ${s.minimum}`);
    }
    if (
      hasOwn(s, "maximum") &&
      typeof s.maximum === "number" &&
      num > s.maximum
    ) {
      errors.push(`${path}: above maximum ${s.maximum}`);
    }
  }

  if (actual === "array") {
    const arr = value as unknown[];
    if (
      hasOwn(s, "minItems") &&
      typeof s.minItems === "number" &&
      arr.length < s.minItems
    ) {
      errors.push(`${path}: fewer than minItems ${s.minItems}`);
    }
    if (
      hasOwn(s, "maxItems") &&
      typeof s.maxItems === "number" &&
      arr.length > s.maxItems
    ) {
      errors.push(`${path}: more than maxItems ${s.maxItems}`);
    }
    if (hasOwn(s, "items")) {
      arr.forEach((item, i) => check(s.items, item, `${path}[${i}]`, errors));
    }
  }

  if (actual === "object") {
    const obj = value as Record<string, unknown>;
    if (hasOwn(s, "required") && Array.isArray(s.required)) {
      for (const key of s.required as string[]) {
        if (!hasOwn(obj, key))
          errors.push(`${path}: missing required property "${key}"`);
      }
    }
    const properties: Record<string, unknown> =
      hasOwn(s, "properties") &&
      s.properties &&
      typeof s.properties === "object"
        ? (s.properties as Record<string, unknown>)
        : {};
    for (const [key, propSchema] of Object.entries(properties)) {
      if (hasOwn(obj, key))
        check(propSchema, obj[key], `${path}.${key}`, errors);
    }
    if (hasOwn(s, "additionalProperties")) {
      if (s.additionalProperties === false) {
        for (const key of Object.keys(obj)) {
          if (!hasOwn(properties, key))
            errors.push(`${path}: unknown property "${key}"`);
        }
      } else if (
        typeof s.additionalProperties === "object" &&
        s.additionalProperties !== null
      ) {
        for (const key of Object.keys(obj)) {
          if (!hasOwn(properties, key))
            check(s.additionalProperties, obj[key], `${path}.${key}`, errors);
        }
      }
    }
  }
}
