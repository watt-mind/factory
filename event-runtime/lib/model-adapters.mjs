/**
 * Adapters that accept a model at all (GH-1736).
 *
 * This is a leaf module on purpose: it imports nothing. `adapters/sandboxed.mjs`
 * evaluates `MODEL_BACKED_ADAPTERS` from this set at load time, and every
 * adapter module imports `sandboxed.mjs`. While the set lived in
 * `registry.mjs`, any module in the registry's static import subtree that
 * reached `lib/adapters` (directly or via planner/proposals/runtime-overrides)
 * closed a cycle `registry → … → adapters/index → sandboxed → registry` and
 * hit `MODEL_ADAPTERS` in its temporal dead zone — a ReferenceError that took
 * down every lib test file at import. Keeping the set here means the sandbox
 * seam never depends on the registry loader, so no future registry dependency
 * can reintroduce that cycle. `registry.mjs` re-exports it for its callers.
 *
 * command/actions/fake take no model: a declared tier there resolves to null
 * (not applicable), never an error.
 */
export const MODEL_ADAPTERS = new Set(["claude", "pi", "agy", "cursor"]);
