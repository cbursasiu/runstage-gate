import type { RunRecord } from "@runstage-gate/core";
import type { Entitlements, Plan } from "./entitlements.ts";
import { webUrl } from "./validate.ts";

/**
 * Fleet view: one row per connected repo, built only from the run records already in the store.
 *
 * A repo counts as connected once it has at least one run in history. Each row shows the repo's
 * latest run (by completedAt, falling back to createdAt; ties go to the later-recorded run).
 */

/**
 * Status colours. History only receives finished runs, so `pending` (queued / in progress) never
 * comes from today's records; it is part of the mapping so a future record that carries an
 * in-progress state renders correctly. `neutral` covers anything unrecognised.
 */
export type FleetStatus = "passing" | "failing" | "pending" | "neutral";
export type FleetColor = "green" | "red" | "yellow" | "grey";

export const STATUS_COLOR: Record<FleetStatus, FleetColor> = {
  passing: "green",
  failing: "red",
  pending: "yellow",
  neutral: "grey",
};

export type FleetLinkKind = "github-check-run" | "gitlab-merge-request" | "history-run";

export interface FleetRepo {
  repo: string;
  provider: "github" | "gitlab";
  status: FleetStatus;
  color: FleetColor;
  /** Set when a failed gate was approved / overridden, so the run is green. */
  approvedBy: string | null;
  /** When the latest run finished (ISO 8601, UTC). */
  lastRunAt: string;
  prNumber: number | null;
  headSha: string;
  title: string;
  /** Names of required checks that failed or errored in the latest run. */
  failingChecks: string[];
  runId: string;
  /** History run detail page for the latest run (always present). */
  detailUrl: string;
  /** Best link for the latest run: the provider check when known, else the history detail page. */
  link: { url: string; kind: FleetLinkKind };
  runCount: number;
  /** When the repo's first run was recorded; drives the free-plan choice. */
  firstSeenAt: string;
}

export interface FleetView {
  plan: Plan;
  maxRepos: number | null;
  /** Total connected repos, including any hidden by the plan. */
  totalRepos: number;
  hiddenRepos: number;
  /** Rule used to pick the visible repo on a limited plan. */
  selection: string;
  repos: FleetRepo[];
  /** Shown when repos are hidden. Deliberately has no payment link. */
  notice: string | null;
}

export const FREE_SELECTION_RULE =
  "free plan shows the first connected repo: the one whose earliest run is oldest (ties: repo name A-Z)";

export function fleetStatus(run: Pick<RunRecord, "conclusion"> & { status?: string }): FleetStatus {
  if (run.status === "queued" || run.status === "in_progress" || run.status === "pending") return "pending";
  if (run.conclusion === "success") return "passing";
  if (run.conclusion === "failure") return "failing";
  return "neutral";
}

function runTime(run: RunRecord): number {
  const t = Date.parse(run.completedAt || run.createdAt);
  return Number.isFinite(t) ? t : 0;
}

function startTime(run: RunRecord): number {
  const t = Date.parse(run.createdAt || run.completedAt);
  return Number.isFinite(t) ? t : 0;
}

const GITHUB_REPO_RE = /^(?!\.+\/)[A-Za-z0-9_.-]+\/(?!\.+$)[A-Za-z0-9_.-]+$/;

/** Provider link for a run: recorded checkUrl, else derived from the GitHub check run id. */
export function providerLink(run: RunRecord): { url: string; kind: FleetLinkKind } | undefined {
  const provider = run.provider ?? "github";
  const recorded = webUrl(run.checkUrl);
  if (recorded) return { url: recorded, kind: provider === "gitlab" ? "gitlab-merge-request" : "github-check-run" };
  if (provider === "github" && run.externalCheckId && /^\d{1,20}$/.test(run.externalCheckId) && GITHUB_REPO_RE.test(run.repoFullName)) {
    return { url: `https://github.com/${run.repoFullName}/runs/${run.externalCheckId}`, kind: "github-check-run" };
  }
  return undefined;
}

export function detailPath(run: RunRecord): string {
  return `/runs/${encodeURIComponent(run.id)}`;
}

/**
 * Latest run per repo, newest activity first (ties: repo name A-Z). `runs` may be in any order;
 * for equal timestamps the run that appears later in `runs` (recorded later) wins.
 */
export function aggregateFleet(runs: readonly RunRecord[]): FleetRepo[] {
  type Acc = { latest: RunRecord; latestAt: number; latestIdx: number; count: number; firstAt: number };
  const byRepo = new Map<string, Acc>();
  runs.forEach((run, idx) => {
    const at = runTime(run);
    const acc = byRepo.get(run.repoFullName);
    if (!acc) {
      byRepo.set(run.repoFullName, { latest: run, latestAt: at, latestIdx: idx, count: 1, firstAt: startTime(run) });
      return;
    }
    acc.count += 1;
    acc.firstAt = Math.min(acc.firstAt, startTime(run));
    if (at > acc.latestAt || (at === acc.latestAt && idx > acc.latestIdx)) {
      acc.latest = run;
      acc.latestAt = at;
      acc.latestIdx = idx;
    }
  });
  const rows = [...byRepo.entries()].map(([repo, acc]): FleetRepo & { _at: number } => {
    const run = acc.latest;
    const status = fleetStatus(run);
    const detailUrl = detailPath(run);
    return {
      repo,
      provider: run.provider ?? "github",
      status,
      color: STATUS_COLOR[status],
      approvedBy: run.approvedBy ?? null,
      lastRunAt: new Date(acc.latestAt).toISOString(),
      prNumber: run.prNumber,
      headSha: run.headSha,
      title: run.title,
      failingChecks: (run.checks ?? []).filter((c) => c.required && (c.status === "failed" || c.status === "error")).map((c) => c.name),
      runId: run.id,
      detailUrl,
      link: providerLink(run) ?? { url: detailUrl, kind: "history-run" },
      runCount: acc.count,
      firstSeenAt: new Date(acc.firstAt).toISOString(),
      _at: acc.latestAt,
    };
  });
  rows.sort((a, b) => b._at - a._at || a.repo.localeCompare(b.repo));
  return rows.map(({ _at, ...row }) => row);
}

/** Applies the plan's repo limit. Hidden repos are counted but never named. */
export function buildFleetView(runs: readonly RunRecord[], ent: Entitlements): FleetView {
  const all = aggregateFleet(runs);
  let visible = all;
  if (ent.maxFleetRepos !== null && all.length > ent.maxFleetRepos) {
    const keep = new Set(
      [...all]
        .sort((a, b) => Date.parse(a.firstSeenAt) - Date.parse(b.firstSeenAt) || a.repo.localeCompare(b.repo))
        .slice(0, ent.maxFleetRepos)
        .map((r) => r.repo),
    );
    visible = all.filter((r) => keep.has(r.repo));
  }
  const hidden = all.length - visible.length;
  return {
    plan: ent.plan,
    maxRepos: ent.maxFleetRepos,
    totalRepos: all.length,
    hiddenRepos: hidden,
    selection: ent.maxFleetRepos === null ? "plus plan shows every connected repo" : FREE_SELECTION_RULE,
    repos: visible,
    notice: hidden > 0 ? `${hidden} more ${hidden === 1 ? "repo" : "repos"} hidden. Upgrade to Plus to see every repo.` : null,
  };
}
