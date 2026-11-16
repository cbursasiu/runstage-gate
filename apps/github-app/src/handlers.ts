import { CHECK_NAME, Redactor, secretValuesFromEnv, type ChangeRef, type CheckProvider, type GateJob, type GateResult } from "@runstage-gate/core";
import type { JobOutcome, JobStore } from "./queue.ts";
import { APPROVE_ACTION_ID } from "./github-provider.ts";

export interface HistorySink {
  record(job: GateJob): Promise<void>;
}

export interface GateServiceDeps {
  provider: CheckProvider;
  queue: JobStore;
  history?: HistorySink;
  log?: (line: string) => void;
  /** This GitHub App's id. When set, check_run events for other apps' check runs are ignored. */
  appId?: number;
  /**
   * Delays between inline attempts to report a finished job to the provider (completeCheck).
   * Default [1000, 4000]: three attempts within ~5s before handing over to background retries.
   */
  reportRetryDelaysMs?: number[];
  /** Total failed report attempts (inline + background) before giving up on a job. Default 50. */
  maxReportAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Enables approvals (override a failed gate). See docs/approvals.md. */
  approvals?: ApprovalDeps;
  /**
   * Scrubs secrets from runner results before they are stored, posted to the provider or sent
   * to history, and from log lines. Default: token patterns plus secret-looking env values.
   */
  redactor?: Redactor;
}

export interface ApprovalDeps {
  /** The user's role on the repo: admin, maintain, write, triage, read or none. */
  permissionOf(change: ChangeRef, login: string): Promise<string>;
  /** Needed for `/runstage approve` comments, which do not carry the head sha. */
  pullRequest?(change: Pick<ChangeRef, "repoFullName" | "installationId">, number: number): Promise<{ headSha: string; baseSha: string; author?: string }>;
  /** Let a PR's author approve their own PR. Default true (solo repos). */
  allowSelfApproval?: boolean;
}

/** Roles allowed to approve. "maintain" and "admin" include write. */
export const APPROVER_ROLES: ReadonlySet<string> = new Set(["admin", "maintain", "write"]);

export type ApprovalRefusal = "disabled" | "no_job" | "stale" | "still_running" | "not_failed" | "already_approved" | "self_approval" | "forbidden";
export type ApprovalOutcome = { ok: true; job: GateJob } | { ok: false; reason: ApprovalRefusal };

/** The command recognised in PR comments. Must start the comment (after whitespace). */
export const APPROVE_COMMAND = /^\s*\/runstage\s+approve\b/i;

/** The result reported for an approved job: success, with who approved and the original verdict. */
export function approvedResult(job: GateJob): GateResult {
  const original = job.result!;
  const when = job.approvedAt ?? new Date().toISOString();
  const via = job.approvedVia === "comment" ? "a `/runstage approve` comment" : "the **Approve override** button";
  return {
    ...original,
    conclusion: "success",
    title: `Approved by ${job.approvedBy} (override): ${original.title}`.slice(0, 255),
    summary:
      `> **Approved by @${job.approvedBy}** via ${via} at ${when}.\n` +
      `> The gate had failed (${original.title}); this override marks it as passed. A new push re-runs the gate.\n\n` +
      original.summary,
  };
}

/** Minimal shapes of the webhook payloads we read (subset of @octokit/webhooks types). */
interface RepoPayload {
  repository: { full_name: string; clone_url?: string };
  installation?: { id: number };
  sender?: { login: string };
}
export interface CheckSuitePayload extends RepoPayload {
  action: string;
  check_suite: {
    head_sha: string;
    head_branch?: string | null;
    pull_requests: Array<{ number: number; base: { sha: string }; head: { sha: string } }>;
  };
}
export interface CheckRunPayload extends RepoPayload {
  action: string;
  /** Present when action is "requested_action" (a check-run button was clicked). */
  requested_action?: { identifier: string };
  check_run: {
    id: number;
    name: string;
    head_sha: string;
    app?: { id: number };
    external_id?: string;
    pull_requests: Array<{ number: number; base: { sha: string }; head: { sha: string } }>;
  };
}
export interface IssueCommentPayload extends RepoPayload {
  action: string;
  issue: { number: number; pull_request?: unknown };
  comment: { id: number; body: string; user: { login: string; type?: string } };
}
export interface PullRequestPayload extends RepoPayload {
  action: string;
  number: number;
  pull_request: {
    number: number;
    draft?: boolean;
    title?: string;
    body?: string | null;
    labels?: Array<{ name: string }>;
    base: { sha: string };
    head: { sha: string; ref?: string };
    user?: { login: string };
  };
}

/** Provider-neutral orchestration: start a check, queue a job, finish the check. */
export class GateService {
  /**
   * In-flight startCheck+enqueue work, keyed by repo+headSha. Concurrent webhooks for the
   * same commit (check_suite and pull_request arriving together) share one promise so only
   * one check run and one job are created. Single-process only.
   */
  private readonly inFlight = new Map<string, Promise<GateJob>>();

  private readonly redactor: Redactor;

  constructor(private readonly deps: GateServiceDeps) {
    this.redactor = deps.redactor ?? new Redactor(secretValuesFromEnv());
  }

  private log(line: string) {
    (this.deps.log ?? (() => {}))(this.redactor.redact(line));
  }

  async onCheckSuite(p: CheckSuitePayload): Promise<GateJob | undefined> {
    if (p.action !== "requested" && p.action !== "rerequested") return undefined;
    const pr = p.check_suite.pull_requests[0];
    if (!pr) {
      this.log(`check_suite ${p.check_suite.head_sha.slice(0, 7)}: no pull request, skipping`);
      return undefined;
    }
    return this.requestGate(
      {
        provider: "github",
        repoFullName: p.repository.full_name,
        cloneUrl: p.repository.clone_url,
        headSha: p.check_suite.head_sha,
        baseSha: pr.base.sha,
        prNumber: pr.number,
        installationId: p.installation?.id,
        author: p.sender?.login,
        ...(p.check_suite.head_branch ? { pr: { headRef: p.check_suite.head_branch } } : {}),
      },
    );
  }

  /**
   * "Re-run" on the RunStage Gate check run. Creates a fresh in-progress check run for the same
   * commit and queues a new job keyed by it, so it is never de-duplicated against the old,
   * completed job. Only our own check runs (name, and app id when configured) are handled.
   */
  async onCheckRun(p: CheckRunPayload): Promise<GateJob | undefined> {
    if (p.action !== "rerequested" && p.action !== "requested_action") return undefined;
    const cr = p.check_run;
    if (cr.name !== CHECK_NAME) return undefined;
    if (this.deps.appId !== undefined && cr.app?.id !== this.deps.appId) {
      this.log(`check_run ${cr.id}: owned by app ${cr.app?.id ?? "?"}, not us, skipping`);
      return undefined;
    }
    if (p.action === "requested_action") {
      if (p.requested_action?.identifier !== APPROVE_ACTION_ID) return undefined;
      const outcome = await this.onApproveButton(p);
      return outcome.ok ? outcome.job : undefined;
    }
    const pr = cr.pull_requests.find((x) => x.head.sha === cr.head_sha) ?? cr.pull_requests[0];
    if (!pr) {
      this.log(`check_run ${cr.id} ${cr.head_sha.slice(0, 7)}: no pull request (fork?), skipping re-run`);
      return undefined;
    }
    this.log(`check_run ${cr.id} re-run requested by ${p.sender?.login ?? "?"}`);
    return this.requestGate(
      {
        provider: "github",
        repoFullName: p.repository.full_name,
        cloneUrl: p.repository.clone_url,
        headSha: cr.head_sha,
        baseSha: pr.base.sha,
        prNumber: pr.number,
        installationId: p.installation?.id,
        author: p.sender?.login,
      },
    );
  }

  async onPullRequest(p: PullRequestPayload): Promise<GateJob | undefined> {
    if (!["opened", "synchronize", "reopened"].includes(p.action)) return undefined;
    return this.requestGate({
      provider: "github",
      repoFullName: p.repository.full_name,
      cloneUrl: p.repository.clone_url,
      headSha: p.pull_request.head.sha,
      baseSha: p.pull_request.base.sha,
      prNumber: p.pull_request.number,
      installationId: p.installation?.id,
      author: p.pull_request.user?.login ?? p.sender?.login,
      pr: prMeta(p.pull_request),
    });
  }

  /**
   * Create the in-progress check run and queue a job keyed by it, unless a job for this commit is
   * still queued or claimed (then that job is reused). Concurrent requests for the same commit
   * share one in-flight start, so check_suite and pull_request webhooks that arrive together
   * produce one check run and one job. Completed jobs never block a new run, so re-runs always
   * get a fresh check run and job; a crashed runner's claim is re-queued by its lease. A failure
   * in startCheck clears the in-flight entry so a later request can retry.
   */
  async requestGate(change: ChangeRef): Promise<GateJob | undefined> {
    const key = `${change.repoFullName}@${change.headSha}`;
    const pending = this.inFlight.get(key);
    if (pending) {
      const job = await pending;
      this.log(`${change.repoFullName}@${change.headSha.slice(0, 7)}: job ${job.id} already active`);
      return this.mergeChangeInfo(job, change);
    }
    const active = this.deps.queue.findActive(change.repoFullName, change.headSha);
    if (active) {
      this.log(`${change.repoFullName}@${change.headSha.slice(0, 7)}: job ${active.id} already active`);
      return this.mergeChangeInfo(active, change);
    }
    const work = this.startAndEnqueue(change).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, work);
    return work;
  }

  private async startAndEnqueue(change: ChangeRef): Promise<GateJob> {
    const checkId = await this.deps.provider.startCheck(change);
    const job = this.deps.queue.enqueue(change, checkId);
    this.log(`queued job ${job.id} for ${change.repoFullName}#${change.prNumber} (check ${checkId})`);
    return job;
  }

  /** Called when a runner posts its result. Only the runner holding the claim may complete it. */
  async completeJob(jobId: string, runnerId: string, rawResult: GateResult): Promise<JobOutcome> {
    // Defense in depth: the runner already redacts; the App redacts again with its own secrets.
    const result = this.redactor.redactResult(rawResult);
    const outcome = this.deps.queue.complete(jobId, runnerId, result);
    if (!outcome.ok) {
      this.log(`runner ${runnerId} result for job ${jobId} refused: ${outcome.reason}`);
      return outcome;
    }
    const job = outcome.job;
    // The result is stored first, so a provider outage never loses it or leaves the job
    // completable twice. Reporting is retried inline, then in the background.
    const reported = await this.reportInline(job, result);
    this.log(`completed job ${job.id}: ${result.conclusion} (${result.title})${reported ? "" : " - check update pending retry"}`);
    if (this.deps.history) {
      await this.deps.history.record(job).catch((err) => this.log(`history: ${(err as Error).message}`));
    }
    return outcome;
  }
  private retrying = false;

  /**
   * check_suite often creates the job before pull_request arrives; pull_request carries the PR
   * author, labels and body that AI detection needs. Merge them into a job no runner has claimed yet.
   */
  private mergeChangeInfo(job: GateJob, change: ChangeRef): GateJob {
    if (job.status !== "queued" || (!change.pr && !change.author)) return job;
    const pr = { ...job.change.pr, ...change.pr };
    return this.deps.queue.updateChange(job.id, { pr, ...(change.pr && change.author ? { author: change.author } : {}) }) ?? job;
  }

  /** "Approve override" button on a failed RunStage Gate check run. */
  async onApproveButton(p: CheckRunPayload): Promise<ApprovalOutcome> {
    const login = p.sender?.login ?? "";
    const checkId = String(p.check_run.id);
    const job = this.deps.queue
      .list()
      .filter((j) => j.change.repoFullName === p.repository.full_name && j.externalCheckId === checkId)
      .pop();
    if (!job) return this.refuseApproval("no_job", `check ${checkId}`, login);
    return this.approve(job, login, "check_run_action");
  }

  /** `/runstage approve` as a PR comment. Needs the Issue comment event (see docs/approvals.md). */
  async onIssueComment(p: IssueCommentPayload): Promise<ApprovalOutcome | undefined> {
    if (p.action !== "created" || !p.issue.pull_request || !APPROVE_COMMAND.test(p.comment.body)) return undefined;
    if (p.comment.user.type === "Bot") return undefined;
    const login = p.comment.user.login;
    const where = `${p.repository.full_name}#${p.issue.number}`;
    if (!this.deps.approvals?.pullRequest) return this.refuseApproval("disabled", where, login);
    const pr = await this.deps.approvals.pullRequest({ repoFullName: p.repository.full_name, installationId: p.installation?.id }, p.issue.number);
    const job = this.deps.queue.latestFor(p.repository.full_name, pr.headSha);
    if (!job) return this.refuseApproval("no_job", `${where}@${pr.headSha.slice(0, 7)}`, login);
    return this.approve(job, login, "comment");
  }

  /**
   * Override a failed gate: verifies the approver has write, maintain or admin on the repo,
   * re-completes the check as success with an "Approved by" note, and records it (queue + history).
   */
  async approve(job: GateJob, login: string, via: NonNullable<GateJob["approvedVia"]>): Promise<ApprovalOutcome> {
    const where = `job ${job.id} (${job.change.repoFullName}@${job.change.headSha.slice(0, 7)})`;
    const approvals = this.deps.approvals;
    if (!approvals) return this.refuseApproval("disabled", where, login);
    const latest = this.deps.queue.latestFor(job.change.repoFullName, job.change.headSha);
    if (latest && latest.id !== job.id) return this.refuseApproval("stale", where, login);
    if (job.status !== "completed" || !job.result) return this.refuseApproval("still_running", where, login);
    if (job.approvedBy) return this.refuseApproval("already_approved", where, login);
    if (job.result.conclusion !== "failure") return this.refuseApproval("not_failed", where, login);
    if (!login) return this.refuseApproval("forbidden", where, login);
    if (approvals.allowSelfApproval === false && job.change.author && job.change.author === login) {
      return this.refuseApproval("self_approval", where, login);
    }
    const role = await approvals.permissionOf(job.change, login);
    if (!APPROVER_ROLES.has(role)) return this.refuseApproval("forbidden", `${where}, role ${role}`, login);

    const approved = this.deps.queue.approve(job.id, login, via) ?? job;
    const result = approvedResult(approved);
    this.log(`${where}: approved by ${login} (${role}) via ${via}`);
    const reported = await this.reportInline(approved, result);
    if (!reported) this.log(`${where}: approval recorded; check update pending retry`);
    if (this.deps.history) {
      await this.deps.history.record({ ...approved, result }).catch((err) => this.log(`history: ${(err as Error).message}`));
    }
    return { ok: true, job: approved };
  }

  private refuseApproval(reason: ApprovalRefusal, where: string, login: string): ApprovalOutcome {
    this.log(`approval by ${login || "?"} refused for ${where}: ${reason}`);
    return { ok: false, reason };
  }

  /** Report a finished job to the provider, retrying with backoff. Records the outcome on the job. */
  private async reportInline(job: GateJob, result: GateResult): Promise<boolean> {
    const delays = this.deps.reportRetryDelaysMs ?? [1000, 4000];
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      if (attempt > 0) await sleep(delays[attempt - 1]!);
      if (await this.tryReport(job, result, `attempt ${attempt + 1}`)) return true;
      if (!this.deps.queue.get(job.id)?.reportPending) return false; // gave up
    }
    return false;
  }

  /** One provider update. On failure the job is marked reportPending (or given up after maxReportAttempts). */
  private async tryReport(job: GateJob, result: GateResult, label: string): Promise<boolean> {
    try {
      await this.deps.provider.completeCheck(job.change, job.externalCheckId, result);
      this.deps.queue.setReportState(job.id, { ok: true });
      return true;
    } catch (err) {
      const message = (err as Error).message;
      const max = this.deps.maxReportAttempts ?? 50;
      const attempts = (this.deps.queue.get(job.id)?.reportAttempts ?? 0) + 1;
      const giveUp = attempts >= max;
      this.deps.queue.setReportState(job.id, { ok: false, error: message, giveUp });
      this.log(`job ${job.id}: updating check ${job.externalCheckId} failed (${label}): ${message}${giveUp ? ` - giving up after ${max} attempts` : ""}`);
      return false;
    }
  }

  /**
   * Retry the final check update for completed jobs whose report failed (e.g. GitHub was down),
   * so a check is never left "in progress" after its result arrived. main.ts runs this on a timer.
   * Returns how many checks were updated.
   */
  async retryPendingReports(): Promise<number> {
    if (this.retrying) return 0;
    this.retrying = true;
    let done = 0;
    try {
      for (const job of this.deps.queue.pendingReports()) {
        if (!job.result) {
          this.deps.queue.setReportState(job.id, { ok: false, error: "no stored result", giveUp: true });
          continue;
        }
        const final = job.approvedBy ? approvedResult(job) : job.result;
        if (await this.tryReport(job, final, "background retry")) {
          this.log(`job ${job.id}: check ${job.externalCheckId} updated on retry`);
          done++;
        }
      }
    } finally {
      this.retrying = false;
    }
    return done;
  }
}

const MAX_PR_BODY = 10_000;

function prMeta(pr: PullRequestPayload["pull_request"]): ChangeRef["pr"] {
  return {
    headRef: pr.head.ref,
    title: pr.title,
    body: pr.body ? pr.body.slice(0, MAX_PR_BODY) : undefined,
    labels: pr.labels?.map((l) => l.name),
  };
}

/** Posts finished jobs to the history service (apps/history). */
export class HttpHistorySink implements HistorySink {
  constructor(private readonly url: string, private readonly token?: string) {}

  async record(job: GateJob): Promise<void> {
    if (!job.result) return;
    const res = await fetch(`${this.url.replace(/\/$/, "")}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify({
        jobId: job.id,
        repoFullName: job.change.repoFullName,
        prNumber: job.change.prNumber,
        headSha: job.change.headSha,
        baseSha: job.change.baseSha,
        conclusion: job.result.conclusion,
        title: job.result.title,
        summary: job.result.summary,
        checks: job.result.checks,
        runnerId: job.runnerId ?? null,
        approvedBy: job.approvedBy ?? null,
        ...(job.result.ai ? { aiGenerated: job.result.ai.generated, aiSignals: job.result.ai.signals } : {}),
        createdAt: job.createdAt,
        completedAt: job.completedAt ?? new Date().toISOString(),
      }),
    });
    if (!res.ok) throw new Error(`history POST ${res.status}`);
  }
}
