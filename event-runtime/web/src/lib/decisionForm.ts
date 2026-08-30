/** Pure field gating and validation for the closed decision widget vocabulary. */
import type { DecisionField, DecisionRequest } from "../types";

export type DecisionValues = Record<string, unknown>;
export type DecisionFieldErrors = Record<string, string>;

export function applicableFields(
  request: DecisionRequest,
  optionId: string,
): DecisionField[] {
  return (request.fields ?? []).filter(
    (field) =>
      field.whenOption === undefined || field.whenOption.includes(optionId),
  );
}

export function initialValues(request: DecisionRequest): DecisionValues {
  return Object.fromEntries(
    (request.fields ?? []).map((field) => {
      switch (field.kind) {
        case "text":
        case "single-choice":
        case "number":
          return [field.id, ""];
        case "multi-choice":
          return [field.id, []];
        case "confirm":
          return [field.id, false];
      }
    }),
  );
}

export function fieldErrors(
  request: DecisionRequest,
  optionId: string,
  values: DecisionValues,
): DecisionFieldErrors {
  const errors: DecisionFieldErrors = {};
  for (const field of applicableFields(request, optionId)) {
    const value = values[field.id];
    if (field.kind === "text") {
      if (typeof value !== "string") errors[field.id] = "Enter text.";
      else if (field.required && value.trim().length === 0)
        errors[field.id] = `${field.label} is required.`;
      else if (value.length > (field.maxLength ?? 2000))
        errors[field.id] =
          `${field.label} must be at most ${field.maxLength ?? 2000} characters.`;
      continue;
    }

    if (field.kind === "single-choice") {
      if (field.required && (typeof value !== "string" || value === ""))
        errors[field.id] = `Choose one option for ${field.label}.`;
      else if (
        value !== "" &&
        (typeof value !== "string" ||
          !field.choices.some((choice) => choice.id === value))
      )
        errors[field.id] = `Choose a valid option for ${field.label}.`;
      continue;
    }

    if (field.kind === "multi-choice") {
      if (!Array.isArray(value)) {
        errors[field.id] = `Choose options for ${field.label}.`;
        continue;
      }
      const minimum = field.minItems ?? (field.required ? 1 : 0);
      const maximum = field.maxItems ?? field.choices.length;
      if (value.length < minimum)
        errors[field.id] = `Choose at least ${minimum} for ${field.label}.`;
      else if (value.length > maximum)
        errors[field.id] = `Choose no more than ${maximum} for ${field.label}.`;
      else if (
        value.some(
          (id) =>
            typeof id !== "string" ||
            !field.choices.some((choice) => choice.id === id),
        )
      )
        errors[field.id] = `Choose valid options for ${field.label}.`;
      continue;
    }

    if (field.kind === "confirm") {
      if (field.required && value !== true)
        errors[field.id] = `${field.label} must be confirmed.`;
      continue;
    }

    if (value === "" || value === undefined) {
      if (field.required) errors[field.id] = `${field.label} is required.`;
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value))
      errors[field.id] = `${field.label} must be a number.`;
    else if (field.minimum !== undefined && value < field.minimum)
      errors[field.id] = `${field.label} must be at least ${field.minimum}.`;
    else if (field.maximum !== undefined && value > field.maximum)
      errors[field.id] = `${field.label} must be at most ${field.maximum}.`;
    else if (field.integer && !Number.isInteger(value))
      errors[field.id] = `${field.label} must be a whole number.`;
  }
  return errors;
}
