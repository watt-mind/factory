/**
 * Shared approval risk surface (WM-505).
 *
 * Approving a proposal is irreversible: it launches a real agent that spends
 * money and can push code. The Proposals view and the Runs view both approve
 * the *same* proposal, so they must show the *same* risk context — capabilities,
 * mutating/read-only, blast radius, target, budget, and the immutable RunSpec.
 *
 * Everything an approval path needs lives here so the two paths cannot drift
 * apart again. Do not inline a second confirmation body in a view.
 */
import { useQuery } from "@tanstack/react-query";
import { useMemo, type ReactNode } from "react";
import { api } from "../api";
import type { AgentDef, Proposal } from "../types";
import { Countdown, Disclosure, JsonBlock, KV } from "./ui";

export type BlastLevel = "LOW" | "MEDIUM" | "HIGH";

export type ApprovalRisk = {
  /** True when the agent can mutate state (write/exec capabilities). */
  mutating: boolean;
  blast: BlastLevel;
  blastHue: string;
  repo: string;
  branch: string;
  issue: string;
  host: string;
  egress: string[];
  caps: string[];
  adapter: string;
  timeoutSeconds: number;
  maxAttempts: number;
};

/** Branches where a mutating run has outsized reach. */
const PROTECTED_BRANCHES = ["main", "master", "develop"];

/**
 * Derive the blast-radius summary for a proposal. Pure and exported so the
 * scoring stays testable independently of the rendering.
 */
export function computeApprovalRisk(p: Proposal, ag?: AgentDef): ApprovalRisk | null {
  if (!p.spec) return null;
  const spec = p.spec;
  const inp = (typeof spec.input === "object" && spec.input ? spec.input : {}) as Record<string, unknown>;
  const repo = p.repos.length ? p.repos.join(", ") : String(inp.repo || inp.repository || "unscoped");
  const branch = String(inp.branch || inp.targetBranch || inp.base || "default");
  const issue = String(inp.issueId || inp.issue || inp.ticket || p.eventId || "—");
  const host = spec.placement
    ? Object.entries(spec.placement).map(([k, v]) => `${k}=${v}`).join(", ")
    : ag?.hosts?.length
      ? ag.hosts.join(", ")
      : "any worker";
  const mutating = ag ? ag.mutating : (spec.capabilities?.some((c) => /write|mutate|exec/i.test(c)) ?? false);
  const egress = ag?.capabilities?.services ?? spec.capabilities?.filter((c) => /net|http|api/i.test(c)) ?? [];
  const caps = spec.capabilities ?? [];

  const score =
    (mutating ? 2 : 0) +
    (PROTECTED_BRANCHES.includes(branch.toLowerCase()) ? 1 : 0) +
    (egress.length ? 1 : 0) +
    (spec.timeoutSeconds > 300 ? 1 : 0);
  const blast: BlastLevel = score >= 3 ? "HIGH" : score >= 1 ? "MEDIUM" : "LOW";
  const blastHue =
    blast === "HIGH" ? "var(--hue-err)" : blast === "MEDIUM" ? "var(--hue-warn)" : "var(--hue-ok)";

  return {
    mutating,
    blast,
    blastHue,
    repo,
    branch,
    issue,
    host,
    egress,
    caps,
    adapter: spec.adapter,
    timeoutSeconds: spec.timeoutSeconds,
    maxAttempts: spec.maxAttempts,
  };
}

/**
 * Resolve the `AgentDef` behind a proposal. Shares the `["agents"]` query key
 * with every other consumer, so mounting this in a dialog costs no extra fetch.
 */
export function useProposalAgent(p: Proposal | null | undefined): AgentDef | undefined {
  const agentsQ = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.agents(),
    staleTime: 30_000,
  });
  return useMemo(() => {
    if (!p) return undefined;
    const list = agentsQ.data?.agents ?? [];
    return list.find((a) => a.id === p.agent || a.ref === p.agent || a.id === p.spec?.agent);
  }, [agentsQ.data, p]);
}

/**
 * The "what am I actually unleashing" card: mutating/read-only, blast radius,
 * target repo/branch/issue/host, budget, egress, and the capability list.
 */
export function ApprovalSafetyCard({
  proposal,
  agent,
  footer,
}: {
  proposal: Proposal;
  agent?: AgentDef;
  /** Optional extra row rendered inside the card (e.g. historical comparison). */
  footer?: ReactNode;
}) {
  const risk = computeApprovalRisk(proposal, agent);
  if (!risk) return null;
  const mutHue = risk.mutating ? "var(--hue-err)" : "var(--hue-ok)";

  return (
    <div className="mb-3 rounded-md border border-(--border) bg-(--surface-0) p-3 text-[12px]">
      <div className="mb-2 flex items-center justify-between border-b border-(--border) pb-2">
        <div className="flex gap-2">
          <span
            className="rounded px-2 py-0.5 text-[11px] font-semibold uppercase"
            style={{ color: mutHue, background: `color-mix(in oklch, ${mutHue} 12%, transparent)` }}
          >
            {risk.mutating ? "Mutating" : "Read-Only"}
          </span>
          <span
            className="rounded px-2 py-0.5 text-[11px] font-semibold uppercase"
            style={{
              color: risk.blastHue,
              background: `color-mix(in oklch, ${risk.blastHue} 12%, transparent)`,
            }}
          >
            Radar: {risk.blast} Risk
          </span>
        </div>
        <span className="mono text-[11px] text-(--text-faint)">{risk.adapter}</span>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div>
          <div className="text-[11px] uppercase text-(--text-faint)">Target Repo</div>
          <div className="mono truncate text-(--text-dim)" title={risk.repo}>{risk.repo}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase text-(--text-faint)">Target Branch</div>
          <div className="mono truncate text-(--text-dim)" title={risk.branch}>{risk.branch}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase text-(--text-faint)">Issue ID</div>
          <div className="mono truncate text-(--text-dim)" title={risk.issue}>{risk.issue}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase text-(--text-faint)">Host</div>
          <div className="mono truncate text-(--text-dim)" title={risk.host}>{risk.host}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase text-(--text-faint)">Budget</div>
          <div className="mono text-(--text-dim)">
            {risk.timeoutSeconds}s · max {risk.maxAttempts} att
          </div>
        </div>
        <div>
          <div className="text-[11px] uppercase text-(--text-faint)">Egress</div>
          <div className="mono truncate text-(--text-dim)">
            {risk.egress.length ? risk.egress.join(", ") : "none"}
          </div>
        </div>
        <div className="sm:col-span-2">
          <div className="text-[11px] uppercase text-(--text-faint)">Capabilities</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {risk.caps.length ? (
              risk.caps.map((c) => (
                <span
                  key={c}
                  className="rounded bg-(--surface-2) px-1.5 py-0.5 mono text-[11.5px] text-(--text-dim)"
                >
                  {c}
                </span>
              ))
            ) : (
              <span className="text-[11px] text-(--text-faint)">none (sandboxed)</span>
            )}
          </div>
        </div>
      </div>
      {footer && <div className="mt-2.5 border-t border-(--border) pt-2 text-[11px]">{footer}</div>}
    </div>
  );
}

/**
 * Body of an approve confirmation dialog. Rendered identically by the Proposals
 * view and the Runs view — that equivalence is the point of this component.
 */
export function ApprovalRiskDetails({ proposal, agent }: { proposal: Proposal; agent?: AgentDef }) {
  if (!proposal.spec) {
    return (
      <div className="mb-3 text-[12px]" style={{ color: "var(--hue-warn)" }}>
        This proposal carries no RunSpec — its capabilities and blast radius cannot be shown.
      </div>
    );
  }
  return (
    <>
      <div className="mb-3">
        <KV k="agent" v={proposal.spec.agent} />
        <KV k="adapter" v={proposal.spec.adapter} />
        <KV k="capabilities" v={proposal.spec.capabilities.join(", ") || "none"} />
        <KV k="timeout" v={`${proposal.spec.timeoutSeconds}s`} />
        <KV k="attempts" v={String(proposal.spec.maxAttempts)} />
        <KV k="ttl" v={<Countdown createdAt={proposal.created_at} ttlSeconds={proposal.ttl_seconds} />} />
      </div>
      <ApprovalSafetyCard proposal={proposal} agent={agent} />
      <div className="mb-3 max-h-[38vh] overflow-auto">
        <Disclosure label="immutable RunSpec" defaultOpen>
          <JsonBlock value={proposal.spec} />
        </Disclosure>
      </div>
    </>
  );
}
