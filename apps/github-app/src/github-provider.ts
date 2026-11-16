import { CHECK_NAME, type ChangeRef, type CheckProvider, type GateResult } from "@runstage-gate/core";

/**
 * The slice of Octokit we use.
 *
 * `@octokit/app` v16's installation client is `@octokit/core`, which exposes `request()`
 * and does not include the REST plugin (`octokit.rest.checks`). Call the Check Runs API
 * by route so this matches the real client (and stays easy to mock in tests and the demo).
 */
export type CreateCheckParams = {
  owner: string;
  repo: string;
  name: string;
  head_sha: string;
  status: "queued" | "in_progress";
  started_at?: string;
  output?: { title: string; summary: string };
  external_id?: string;
};

export type UpdateCheckParams = {
  owner: string;
  repo: string;
  check_run_id: number;
  status: "completed";
  conclusion: "success" | "failure" | "neutral";
  completed_at?: string;
  output: { title: string; summary: string };
  /** Check-run buttons (GitHub "requested actions"). Max 3; label <= 20, description <= 40, identifier <= 20 chars. */
  actions?: Array<{ label: string; description: string; identifier: string }>;
};

/** Identifier of the "Approve override" check-run button (check_run.requested_action). */
export const APPROVE_ACTION_ID = "rsg-approve";
export const APPROVE_ACTION = { label: "Approve override", description: "Pass the gate (write access needed)", identifier: APPROVE_ACTION_ID };

export type CheckRunRoute =
  | "POST /repos/{owner}/{repo}/check-runs"
  | "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}";

/** Installation Octokit from `@octokit/app` v16: `request()` only, no `rest`. */
export interface ChecksClient {
  request(route: CheckRunRoute, params: CreateCheckParams | UpdateCheckParams): Promise<{ data: { id?: number } }>;
}

export type ChecksClientFactory = (installationId: number) => Promise<ChecksClient>;

const SUMMARY_LIMIT = 65_000; // GitHub caps output.summary at 65535 chars

export class GitHubCheckProvider implements CheckProvider {
  readonly name = "github" as const;
  constructor(
    private readonly clientFor: ChecksClientFactory,
    private readonly opts: { approvalButton?: boolean } = {},
  ) {}

  async startCheck(change: ChangeRef): Promise<string> {
    const { owner, repo } = split(change.repoFullName);
    const client = await this.clientFor(requireInstallation(change));
    const { data } = await client.request("POST /repos/{owner}/{repo}/check-runs", {
      owner,
      repo,
      name: CHECK_NAME,
      head_sha: change.headSha,
      status: "in_progress",
      started_at: new Date().toISOString(),
      output: {
        title: "Waiting for a runner",
        summary: "RunStage Gate queued this change. A runner on your team's machine will run the checks in `.runstage/gate.yml`.",
      },
    });
    if (data.id === undefined) throw new Error("GitHub check-runs API returned no id");
    return String(data.id);
  }

  async completeCheck(change: ChangeRef, externalCheckId: string, result: GateResult): Promise<void> {
    const { owner, repo } = split(change.repoFullName);
    const client = await this.clientFor(requireInstallation(change));
    await client.request("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", {
      owner,
      repo,
      check_run_id: Number(externalCheckId),
      status: "completed",
      conclusion: result.conclusion,
      completed_at: new Date().toISOString(),
      output: { title: result.title.slice(0, 255), summary: summaryFor(result, !!this.opts.approvalButton).slice(0, SUMMARY_LIMIT) },
      ...(this.opts.approvalButton && result.conclusion === "failure" ? { actions: [APPROVE_ACTION] } : {}),
    });
  }
}

/** Minimal Octokit surface for approvals (collaborator permission and PR lookup). */
export interface ApprovalClient {
  request(route: string, params: Record<string, unknown>): Promise<{ data: unknown }>;
}
export type ApprovalClientFactory = (installationId: number) => Promise<ApprovalClient>;

/** GitHub lookups for the approval flow. Needs only Metadata: read and Pull requests: read. */
export class GitHubApprovals {
  constructor(private readonly clientFor: ApprovalClientFactory) {}

  /** The user's effective permission on the repo: admin, maintain, write, triage, read or none. */
  async permissionOf(change: ChangeRef, login: string): Promise<string> {
    const { owner, repo } = split(change.repoFullName);
    const client = await this.clientFor(requireInstallation(change));
    try {
      const { data } = await client.request("GET /repos/{owner}/{repo}/collaborators/{username}/permission", { owner, repo, username: login });
      const d = data as { permission?: string; role_name?: string };
      // role_name distinguishes maintain/triage; permission is the legacy admin/write/read/none.
      return d.role_name || d.permission || "none";
    } catch (err) {
      if ((err as { status?: number }).status === 404) return "none";
      throw err;
    }
  }

  async pullRequest(change: Pick<ChangeRef, "repoFullName" | "installationId">, number: number): Promise<{ headSha: string; baseSha: string; author?: string }> {
    const { owner, repo } = split(change.repoFullName);
    const client = await this.clientFor(requireInstallation(change as ChangeRef));
    const { data } = await client.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { owner, repo, pull_number: number });
    const d = data as { head: { sha: string }; base: { sha: string }; user?: { login: string } };
    return { headSha: d.head.sha, baseSha: d.base.sha, author: d.user?.login };
  }
}

export const APPROVAL_HINT =
  "\n\n---\nSomeone with write access can override this failure with **Approve override** (top of this check) or a `/runstage approve` PR comment.";

function summaryFor(result: GateResult, approvals: boolean): string {
  return approvals && result.conclusion === "failure" ? result.summary + APPROVAL_HINT : result.summary;
}

function split(full: string): { owner: string; repo: string } {
  const [owner, repo] = full.split("/");
  if (!owner || !repo) throw new Error(`bad repo name ${full}`);
  return { owner, repo };
}

function requireInstallation(change: ChangeRef): number {
  if (!change.installationId) throw new Error("GitHub change is missing installationId");
  return change.installationId;
}
