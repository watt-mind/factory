/**
 * One-line subject for a proposal / run spec (WM-896 / WM-897).
 *
 * Prefers the agent's `factory.artifact-view/v1` `subject` template when the
 * view defines one (`specSubject`). Dispatch keeps a hard-coded fallback so
 * a missing sidecar still reads as "Dispatch TICKET · repo · model" on the
 * inbox card and Telegram — the same line WM-896 shipped before the view
 * existed.
 */
import { specSubject } from "./spec-subject.mjs";

function isDispatch(agent) {
  return typeof agent === "string" && agent.split("@")[0] === "dispatch";
}

function dispatchFallback(spec) {
  const input = spec?.input && typeof spec.input === "object" ? spec.input : {};
  const ticket = typeof input.ticket === "string" ? input.ticket : "?";
  const repo = typeof input.repo === "string" ? input.repo : "?";
  const model =
    typeof spec?.model === "string" && spec.model ? spec.model : "default";
  return `Dispatch ${ticket} · ${repo} · ${model}`;
}

/**
 * `proposalSubject(registry, spec) → string | null`
 *
 * View `subject` wins. Dispatch without a subject still gets the fallback.
 * Every other agent without a subject returns null. Never throws.
 */
export function proposalSubject(registry, spec) {
  const fromView = specSubject(registry, spec);
  if (fromView) return fromView;
  if (isDispatch(spec?.agent)) return dispatchFallback(spec);
  return null;
}
