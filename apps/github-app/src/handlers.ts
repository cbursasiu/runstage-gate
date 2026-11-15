import type { ChangeRef, CheckProvider, GateJob, GateResult } from "@runstage-gate/core";
import type { JobOutcome, JobStore } from "./queue.ts";

export interface HistorySink {
  record(job: GateJob): Promise<void>;
}

export interface GateServiceDeps {
  provider: CheckProvider;
  queue: JobStore;
  history?: HistorySink;
  log?: (line: string) => void;
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
    pull_requests: Array<{ number: number; base: { sha: string }; head: { sha: string } }>;
  };
}
export interface PullRequestPayload extends RepoPayload {
  action: string;
  number: number;
  pull_request: { number: number; draft?: boolean; base: { sha: string }; head: { sha: string }; user?: { login: string } };
}

/** Provider-neutral orchestration: start a check, queue a job, finish the check. */
export class GateService {
  constructor(private readonly deps: GateServiceDeps) {}

  private log(line: string) {
    (this.deps.log ?? (() => {}))(line);
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
      },
      p.action === "rerequested",
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
    });
  }

  /** Create the in-progress check run and queue a job, unless one is already active for this commit. */
  async requestGate(change: ChangeRef, force = false): Promise<GateJob | undefined> {
    const active = this.deps.queue.findActive(change.repoFullName, change.headSha);
    if (active && !force) {
      this.log(`${change.repoFullName}@${change.headSha.slice(0, 7)}: job ${active.id} already active`);
      return active;
    }
    const checkId = await this.deps.provider.startCheck(change);
    const job = this.deps.queue.enqueue(change, checkId);
    this.log(`queued job ${job.id} for ${change.repoFullName}#${change.prNumber} (check ${checkId})`);
    return job;
  }

  /** Called when a runner posts its result. Only the runner holding the claim may complete it. */
  async completeJob(jobId: string, runnerId: string, result: GateResult): Promise<JobOutcome> {
    const outcome = this.deps.queue.complete(jobId, runnerId, result);
    if (!outcome.ok) {
      this.log(`runner ${runnerId} result for job ${jobId} refused: ${outcome.reason}`);
      return outcome;
    }
    const job = outcome.job;
    await this.deps.provider.completeCheck(job.change, job.externalCheckId, result);
    this.log(`completed job ${job.id}: ${result.conclusion} (${result.title})`);
    if (this.deps.history) {
      await this.deps.history.record(job).catch((err) => this.log(`history: ${(err as Error).message}`));
    }
    return outcome;
  }
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
        approvedBy: null,
        createdAt: job.createdAt,
        completedAt: job.completedAt ?? new Date().toISOString(),
      }),
    });
    if (!res.ok) throw new Error(`history POST ${res.status}`);
  }
}
