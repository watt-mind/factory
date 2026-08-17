// Agents rides `g t` ("what is this agent?"): o/e/p/r are taken, and `g a`
// would double-fire the proposals view's `a` (approve) list key. Artifacts uses
// `g y` (the last sound in "artifact") so it does not compete with list `k`.
// Workers keeps its natural `g w`: `w` is no view's list verb. Inbox takes
// `g n` ("needs you"): `n` is no view's list verb either, and `g i` is the
// In-flight context chord (WM-235).
export const NAV = [
  { key: "overview", label: "Overview", go: "o" },
  { key: "inbox", label: "Inbox", go: "n" },
  { key: "events", label: "Events", go: "e" },
  { key: "proposals", label: "Proposals", go: "p" },
  { key: "runs", label: "Runs", go: "r" },
  { key: "tickets", label: "Tickets", go: "k" },
  { key: "projects", label: "Projects", go: "f" },
  { key: "agents", label: "Agents", go: "t" },
  { key: "artifacts", label: "Artifacts", go: "y" },
  { key: "schedules", label: "Schedules", go: "s" },
  { key: "workers", label: "Workers", go: "w" },
  { key: "graph", label: "Graph", go: "g" },
] as const;

export type NavItem = (typeof NAV)[number];
export type NavKey = NavItem["key"];
