/**
 * Minimal JSON Schema validator — the subset the runtime's contracts actually
 * use, implemented here rather than pulled in as a dependency. Contracts fail
 * closed (docs/event-runtime.md §5): an unsupported schema keyword is an error
 * in the schema, not a silently-passing check.
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

const hasOwn = (obj, key) =>
  obj !== null &&
  typeof obj === "object" &&
  Object.prototype.hasOwnProperty.call(obj, key);

/**
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validate(schema, value, path = "$") {
  const errors = [];
  check(schema, value, path, errors);
  return { valid: errors.length === 0, errors };
}

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number")
    return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function matchesType(declared, actual) {
  return declared === actual || (declared === "number" && actual === "integer");
}

function check(schema, value, path, errors) {
  if (schema === undefined || schema === null) {
    errors.push(`${path}: schema is missing`);
    return;
  }
  if (typeof schema !== "object" || Array.isArray(schema)) {
    errors.push(`${path}: schema must be an object`);
    return;
  }
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED.has(key)) {
      errors.push(
        `${path}: unsupported schema keyword "${key}" — contracts fail closed`,
      );
      return;
    }
  }

  if (hasOwn(schema, "format")) {
    if (typeof schema.format !== "string" || !FORMAT_SET.has(schema.format)) {
      errors.push(
        `${path}: unsupported format ${JSON.stringify(schema.format)} — contracts fail closed`,
      );
      return;
    }
  }

  const actual = typeOf(value);

  if (hasOwn(schema, "type") && schema.type !== undefined) {
    const declared = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!declared.some((t) => matchesType(t, actual))) {
      errors.push(
        `${path}: expected type ${declared.join("|")}, got ${actual}`,
      );
      return;
    }
  }

  if (
    hasOwn(schema, "const") &&
    JSON.stringify(value) !== JSON.stringify(schema.const)
  ) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
  }
  if (
    hasOwn(schema, "enum") &&
    Array.isArray(schema.enum) &&
    !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))
  ) {
    errors.push(`${path}: value not in enum ${JSON.stringify(schema.enum)}`);
  }

  if (actual === "string") {
    if (
      hasOwn(schema, "minLength") &&
      typeof schema.minLength === "number" &&
      value.length < schema.minLength
    ) {
      errors.push(`${path}: shorter than minLength ${schema.minLength}`);
    }
    if (
      hasOwn(schema, "maxLength") &&
      typeof schema.maxLength === "number" &&
      value.length > schema.maxLength
    ) {
      errors.push(`${path}: longer than maxLength ${schema.maxLength}`);
    }
    if (
      hasOwn(schema, "pattern") &&
      typeof schema.pattern === "string" &&
      !new RegExp(schema.pattern).test(value)
    ) {
      errors.push(`${path}: does not match pattern ${schema.pattern}`);
    }
    if (schema.format === "uri" && !URL.canParse(value)) {
      errors.push(`${path}: format "uri" value is not a valid URI`);
    }
    if (schema.format === "duration" && !DURATION_PATTERN.test(value)) {
      errors.push(`${path}: format "duration" must match ${DURATION_PATTERN}`);
    }
  }

  if (actual === "integer" || actual === "number") {
    if (
      hasOwn(schema, "minimum") &&
      typeof schema.minimum === "number" &&
      value < schema.minimum
    ) {
      errors.push(`${path}: below minimum ${schema.minimum}`);
    }
    if (
      hasOwn(schema, "maximum") &&
      typeof schema.maximum === "number" &&
      value > schema.maximum
    ) {
      errors.push(`${path}: above maximum ${schema.maximum}`);
    }
  }

  if (actual === "array") {
    if (
      hasOwn(schema, "minItems") &&
      typeof schema.minItems === "number" &&
      value.length < schema.minItems
    ) {
      errors.push(`${path}: fewer than minItems ${schema.minItems}`);
    }
    if (
      hasOwn(schema, "maxItems") &&
      typeof schema.maxItems === "number" &&
      value.length > schema.maxItems
    ) {
      errors.push(`${path}: more than maxItems ${schema.maxItems}`);
    }
    if (hasOwn(schema, "items")) {
      value.forEach((item, i) =>
        check(schema.items, item, `${path}[${i}]`, errors),
      );
    }
  }

  if (actual === "object") {
    if (hasOwn(schema, "required") && Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!hasOwn(value, key))
          errors.push(`${path}: missing required property "${key}"`);
      }
    }
    const properties =
      hasOwn(schema, "properties") &&
      schema.properties &&
      typeof schema.properties === "object"
        ? schema.properties
        : {};
    for (const [key, propSchema] of Object.entries(properties)) {
      if (hasOwn(value, key))
        check(propSchema, value[key], `${path}.${key}`, errors);
    }
    if (hasOwn(schema, "additionalProperties")) {
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!hasOwn(properties, key))
            errors.push(`${path}: unknown property "${key}"`);
        }
      } else if (
        typeof schema.additionalProperties === "object" &&
        schema.additionalProperties !== null
      ) {
        for (const key of Object.keys(value)) {
          if (!hasOwn(properties, key))
            check(
              schema.additionalProperties,
              value[key],
              `${path}.${key}`,
              errors,
            );
        }
      }
    }
  }
}
