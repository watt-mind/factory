/**
 * Render an agent's `subject` template over a RunSpec (WM-897).
 *
 * Pure: looks the view up on the registry, substitutes `{/pointer}` from
 * `spec.input` and `{agent|model|adapter|repo}` from the spec itself, and
 * returns null when the agent has no `subject`. A placeholder that does not
 * resolve in this spec becomes `""` — the template is a hint, not a
 * validator; drift was already closed at registry load.
 */
import {
  SUBJECT_FIELDS,
  resolvePointer,
  subjectPlaceholders,
} from "./artifact-view.mjs";
import { getArtifactView } from "./registry.mjs";

const isObject = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v);

function fieldValue(spec, token) {
  if (token === "repo" && (spec.repo === undefined || spec.repo === null)) {
    const input = spec.input;
    if (isObject(input) && typeof input.repo === "string") return input.repo;
  }
  const value = spec[token];
  return value === undefined || value === null ? "" : String(value);
}

/**
 * Substitute one `subject` template against a spec. Exported for tests;
 * production callers go through `specSubject` so a missing view is null.
 */
export function renderSubject(template, spec) {
  if (typeof template !== "string" || !spec || typeof spec !== "object")
    return null;
  return template.replace(/\{([^{}]+)\}/g, (_, token) => {
    if (token.startsWith("/")) {
      const value = resolvePointer(spec.input, token);
      return value === undefined || value === null ? "" : String(value);
    }
    if (SUBJECT_FIELDS.includes(token)) return fieldValue(spec, token);
    return `{${token}}`;
  });
}

/**
 * `specSubject(registry, spec) → string | null`
 *
 * Looks up the agent's view by `spec.agent` (the `@version` ref). No view,
 * no `subject`, or a non-object spec → null. Never throws.
 */
export function specSubject(registry, spec) {
  if (!spec || typeof spec !== "object" || typeof spec.agent !== "string")
    return null;
  const view = getArtifactView(registry, spec.agent).view;
  if (typeof view?.subject !== "string") return null;
  // Defensive: a view that passed registry load has only legal placeholders,
  // but a hand-built registry in a test might not. Unknown tokens stay
  // unsubstituted rather than crashing the API.
  const unknown = subjectPlaceholders(view.subject).filter(
    (t) => !t.startsWith("/") && !SUBJECT_FIELDS.includes(t),
  );
  if (unknown.length) return null;
  return renderSubject(view.subject, spec);
}
