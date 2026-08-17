import type { ReactNode } from "react";
import {
  ArchiveIcon,
  ChatBubbleIcon,
  CheckCircledIcon,
  ClockIcon,
  CodeIcon,
  CommitIcon,
  Component1Icon,
  Crosshair2Icon,
  CubeIcon,
  DesktopIcon,
  EnterIcon,
  EyeOpenIcon,
  FileTextIcon,
  GearIcon,
  GitHubLogoIcon,
  LapTimerIcon,
  LightningBoltIcon,
  ListBulletIcon,
  LockClosedIcon,
  LoopIcon,
  PaperPlaneIcon,
  Pencil1Icon,
  PersonIcon,
  PlayIcon,
  ReloadIcon,
  SewingPinIcon,
  TargetIcon,
  TimerIcon,
  UpdateIcon,
} from "@radix-ui/react-icons";

/**
 * Attribute icon registry — §5.2 tier 4 (WM-482, WM-483).
 *
 * One glyph, one meaning, app-wide: every `KV` row that names an attribute
 * resolves its icon HERE, by label, so `adapter` on the Runs panel and
 * `adapter` on the Agents panel cannot drift. Views never pick a glyph.
 *
 * Keys are normalised labels (`normalizeAttr`): lower-case, everything but
 * `[a-z0-9]` dropped, so `modelTier`, `model tier`, and `model-tier` are one
 * key. `input.<field>` rows share the `input` glyph. Identity rows (ids,
 * hashes, versions, contracts, keys) are deliberately absent — an identifier
 * is text and a word already fits; in an iconed section they reserve the
 * slot and stay blank.
 *
 * Adding an attribute: add the row here AND to the tier-4 table in
 * `docs/event-runtime-webui.md` in the same PR.
 */
const REGISTRY: Record<string, () => ReactNode> = {
  // ── definition / execution ────────────────────────────────────────────
  agent: () => <PersonIcon />,
  adapter: () => <Component1Icon />,
  mutating: () => <Pencil1Icon />,
  workspace: () => <CubeIcon />,
  capabilities: () => <LockClosedIcon />,
  hosts: () => <DesktopIcon />,
  host: () => <DesktopIcon />,
  command: () => <CodeIcon />,
  actionregistry: () => <ListBulletIcon />,
  execution: () => <PlayIcon />,
  executionmode: () => <PlayIcon />,
  placement: () => <SewingPinIcon />,
  worker: () => <GearIcon />,
  target: () => <TargetIcon />,

  // ── model ─────────────────────────────────────────────────────────────
  modeltier: () => <LightningBoltIcon />,
  model: () => <Crosshair2Icon />,
  modeloverride: () => <Crosshair2Icon />,
  modelpinned: () => <Crosshair2Icon />,
  modelobserved: () => <EyeOpenIcon />,

  // ── limits / retries ──────────────────────────────────────────────────
  timeout: () => <TimerIcon />,
  attempts: () => <ReloadIcon />,
  ttl: () => <LapTimerIcon />,
  proposalttl: () => <LapTimerIcon />,
  cadence: () => <LapTimerIcon />,

  // ── payload / provenance ──────────────────────────────────────────────
  input: () => <FileTextIcon />,
  originevent: () => <PaperPlaneIcon />,
  eventtype: () => <PaperPlaneIcon />,
  type: () => <PaperPlaneIcon />,
  // `source` sits next to `type` on Events/Proposals; it must not share the
  // event glyph — "where it came in from" vs "what it is" (ux-critic, WM-483).
  source: () => <EnterIcon />,
  plannedevents: () => <PaperPlaneIcon />,
  admittedevents: () => <PaperPlaneIcon />,
  reason: () => <ChatBubbleIcon />,
  proposalreason: () => <ChatBubbleIcon />,
  plannerreason: () => <ChatBubbleIcon />,
  decidedby: () => <PersonIcon />,
  approval: () => <CheckCircledIcon />,

  // ── clocks (points in time — `timeout`/`ttl` are durations, above) ────
  created: () => <ClockIcon />,
  updated: () => <ClockIcon />,
  occurredat: () => <ClockIcon />,
  receivedat: () => <ClockIcon />,
  admittedat: () => <ClockIcon />,
  startedat: () => <ClockIcon />,
  stoppedat: () => <ClockIcon />,
  decidedat: () => <ClockIcon />,
  lastfire: () => <ClockIcon />,
  lastcompleted: () => <ClockIcon />,
  nextdue: () => <ClockIcon />,

  // ── schedules ─────────────────────────────────────────────────────────
  loop: () => <LoopIcon />,
  loopname: () => <LoopIcon />,
  catchup: () => <UpdateIcon />,

  // ── projects / repos ──────────────────────────────────────────────────
  repository: () => <ArchiveIcon />,
  github: () => <GitHubLogoIcon />,
  basebranch: () => <CommitIcon />,
  deploybranch: () => <CommitIcon />,
};

export const normalizeAttr = (label: string): string => {
  const base = label.startsWith("input.") ? "input" : label;
  return base.toLowerCase().replace(/[^a-z0-9]/g, "");
};

/** The registered glyph for a `KV` label, or `null` when the label is identity/unmapped. */
export function attrIcon(label: string): ReactNode {
  const make = REGISTRY[normalizeAttr(label)];
  return make ? make() : null;
}

/** For tests and the doc table: the normalised keys this registry knows. */
export const ATTR_ICON_KEYS: readonly string[] = Object.keys(REGISTRY);
