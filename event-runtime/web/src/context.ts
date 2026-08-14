/**
 * Operator context tabs (OPS-356): All / a factory-repo filter / In flight.
 * The strip is session chrome; the hash still names view + selection.
 */

export const CONTEXT_STORAGE_KEY = "factory.contextTabs";
export const INFLIGHT = "inflight";

export type OperatorContext =
  | { kind: "all" }
  | { kind: "inflight" }
  | { kind: "repo"; name: string };

export type ContextTabsPersisted = {
  openRepos: string[];
  active: string;
};

export function contextFromProject(project: string | null | undefined): OperatorContext {
  if (!project || project === "all") return { kind: "all" };
  if (project === INFLIGHT) return { kind: "inflight" };
  return { kind: "repo", name: project };
}

export function projectFromContext(ctx: OperatorContext): string | null {
  if (ctx.kind === "all") return null;
  if (ctx.kind === "inflight") return INFLIGHT;
  return ctx.name;
}

/** A repo tab filters to rows that name that repo. All and In flight do not. */
export function matchesRepo(repos: string[] | undefined, ctx: OperatorContext): boolean {
  if (ctx.kind !== "repo") return true;
  return (repos ?? []).includes(ctx.name);
}

export function matchesInFlight(state: string, ctx: OperatorContext): boolean {
  if (ctx.kind !== "inflight") return true;
  return state === "LEASED" || state === "RUNNING";
}

/** In flight is a toggle: clicking it while active exits to All (WM-91). */
export function toggleInflight(active: OperatorContext): OperatorContext {
  return active.kind === "inflight" ? { kind: "all" } : { kind: "inflight" };
}

export function readContextTabs(raw: string | null): ContextTabsPersisted {
  if (!raw) return { openRepos: [], active: "all" };
  try {
    const value = JSON.parse(raw) as { openRepos?: unknown; active?: unknown };
    const openRepos = Array.isArray(value.openRepos)
      ? value.openRepos.filter(
          (name): name is string =>
            typeof name === "string" && name !== "" && name !== "all" && name !== INFLIGHT,
        )
      : [];
    // Dedup while preserving order — sessionStorage can be written twice in Strict Mode.
    const seen = new Set<string>();
    const unique = openRepos.filter((name) => (seen.has(name) ? false : (seen.add(name), true)));
    let active = typeof value.active === "string" ? value.active : "all";
    if (active !== "all" && active !== INFLIGHT && !unique.includes(active)) active = "all";
    return { openRepos: unique, active };
  } catch {
    return { openRepos: [], active: "all" };
  }
}

export function rememberOpenRepo(openRepos: string[], name: string): string[] {
  if (!name || name === "all" || name === INFLIGHT || openRepos.includes(name)) return openRepos;
  return [...openRepos, name];
}
