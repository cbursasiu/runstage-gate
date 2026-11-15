/** Outcome of a single check after the runner executed (or skipped) it. */
export type CheckStatus = "passed" | "failed" | "skipped" | "error";

export interface CheckResult {
  name: string;
  kind: "script" | "agent";
  required: boolean;
  status: CheckStatus;
  /** Human-readable reason, shown in the GitHub check summary. */
  reason: string;
  exitCode: number | null;
  durationMs: number;
  /** Tail of combined stdout/stderr, truncated. */
  output: string;
}

export type GateConclusion = "success" | "failure";

export interface GateResult {
  conclusion: GateConclusion;
  /** One-line title for the check run. */
  title: string;
  /** Markdown summary for the check run. */
  summary: string;
  checks: CheckResult[];
}

/**
 * Provider-neutral reference to "the thing we report on".
 * GitHub: a check run on a commit. GitLab (later): an external commit status.
 */
export interface ChangeRef {
  provider: "github" | "gitlab";
  /** "owner/name" on GitHub, project path on GitLab. */
  repoFullName: string;
  cloneUrl?: string;
  headSha: string;
  baseSha: string;
  prNumber: number | null;
  /** Provider-specific auth context (GitHub installation id, etc.). */
  installationId?: number;
  author?: string;
}

/** A unit of work handed to a runner. */
export interface GateJob {
  id: string;
  change: ChangeRef;
  /** Provider-specific id of the in-progress check (GitHub check run id). */
  externalCheckId: string;
  status: "queued" | "claimed" | "completed";
  createdAt: string;
  claimedAt?: string;
  /** While claimed: when the claim lapses and the job goes back to the queue unless the runner heartbeats. */
  leaseExpiresAt?: string;
  /** How many times a runner has claimed this job. */
  attempts?: number;
  completedAt?: string;
  runnerId?: string;
  result?: GateResult;
}

/** Record kept by the hosted history service (the paid part). */
export interface RunRecord {
  id: string;
  jobId: string;
  repoFullName: string;
  prNumber: number | null;
  headSha: string;
  baseSha: string;
  conclusion: GateConclusion;
  title: string;
  summary: string;
  checks: CheckResult[];
  runnerId: string | null;
  /** Who approved / overrode the gate. Approval flow is stubbed in v1. */
  approvedBy: string | null;
  createdAt: string;
  completedAt: string;
}
