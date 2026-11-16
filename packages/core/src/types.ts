/** Outcome of a single check after the runner executed (or skipped) it. */
export type CheckStatus = "passed" | "failed" | "skipped" | "error";

export interface CheckResult {
  name: string;
  /** "policy" marks a synthetic result added by gate policy (e.g. ai-approval). */
  kind: "script" | "agent" | "policy";
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
  /** AI-generated detection, when `ai_detection.enabled` is on in gate.yml. */
  ai?: { generated: boolean; signals: string[] };
}

/** PR metadata the code host gives us, used for AI-generated detection. */
export interface PullRequestMeta {
  headRef?: string;
  labels?: string[];
  title?: string;
  body?: string;
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
  /** PR metadata when the webhook carried it (labels, body, head branch). */
  pr?: PullRequestMeta;
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
  /** When the provider check was last updated with the final result. */
  reportedAt?: string;
  /**
   * True while the final provider update (e.g. GitHub check run PATCH) is still owed: the
   * runner's result is stored, but reporting it failed. The App retries in the background.
   */
  reportPending?: boolean;
  /** Failed attempts to report the final result to the provider. */
  reportAttempts?: number;
  /** Last reporting error (for logs and inspection). */
  reportError?: string;
  /** Who overrode a failed gate (GitHub login), when, and how. */
  approvedBy?: string;
  approvedAt?: string;
  approvedVia?: "check_run_action" | "comment";
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
  /** Optional PR diff. Omitted on older records; the history service may truncate it. */
  diff?: string;
  /** AI-generated detection result, when enabled in gate.yml. */
  aiGenerated?: boolean;
  aiSignals?: string[];
}
