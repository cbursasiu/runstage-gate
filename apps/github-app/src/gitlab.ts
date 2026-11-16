import { createHash, timingSafeEqual } from "node:crypto";
import { CHECK_NAME, type ChangeRef, type CheckProvider, type GateResult } from "@runstage-gate/core";

/**
 * GitLab support: reports the gate as an external commit status
 * (POST /projects/:id/statuses/:sha, name "RunStage Gate") and turns merge_request webhooks
 * into gate jobs. Enabled by RUNSTAGE_GITLAB_TOKEN + RUNSTAGE_GITLAB_WEBHOOK_SECRET.
 * See docs/gitlab.md.
 */
export interface GitLabOptions {
  /** e.g. https://gitlab.com or https://gitlab.example.com (no trailing /api/v4). */
  baseUrl: string;
  /** Project or group access token with the `api` scope (Developer role or higher). */
  token: string;
  /** Link shown on the status, e.g. the history UI. */
  targetUrl?: string;
  fetchImpl?: typeof fetch;
}

export type GitLabState = "pending" | "running" | "success" | "failed" | "canceled";

const DESCRIPTION_LIMIT = 255;

export class GitLabStatusProvider implements CheckProvider {
  readonly name = "gitlab" as const;
  constructor(private readonly opts: GitLabOptions) {}

  async startCheck(change: ChangeRef): Promise<string> {
    const data = await this.postStatus(change, "running", "Waiting for a runner");
    // GitLab keeps one status per (sha, name, ref); later posts update it. The id is informational.
    return String((data as { id?: number }).id ?? `${change.headSha}:${CHECK_NAME}`);
  }

  async completeCheck(change: ChangeRef, _externalCheckId: string, result: GateResult): Promise<void> {
    await this.postStatus(change, result.conclusion === "success" ? "success" : "failed", result.title);
  }

  /** Head sha of a branch, used when a merge_request hook has no base sha. */
  async branchHead(projectPath: string, branch: string): Promise<string> {
    const data = (await this.api("GET", `/projects/${encodeURIComponent(projectPath)}/repository/branches/${encodeURIComponent(branch)}`)) as {
      commit?: { id?: string };
    };
    if (!data.commit?.id) throw new Error(`GitLab branch ${projectPath}:${branch} has no commit id`);
    return data.commit.id;
  }

  private postStatus(change: ChangeRef, state: GitLabState, description: string): Promise<unknown> {
    const body: Record<string, string> = {
      state,
      name: CHECK_NAME,
      description: description.slice(0, DESCRIPTION_LIMIT),
    };
    if (change.pr?.headRef) body.ref = change.pr.headRef;
    if (this.opts.targetUrl) body.target_url = this.opts.targetUrl;
    return this.api("POST", `/projects/${encodeURIComponent(change.repoFullName)}/statuses/${encodeURIComponent(change.headSha)}`, body);
  }

  private async api(method: "GET" | "POST", path: string, body?: Record<string, string>): Promise<unknown> {
    const f = this.opts.fetchImpl ?? fetch;
    const res = await f(`${this.opts.baseUrl.replace(/\/+$/, "")}/api/v4${path}`, {
      method,
      headers: { "private-token": this.opts.token, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw Object.assign(new Error(`GitLab ${method} ${path.split("?")[0]} -> ${res.status}: ${text.slice(0, 200)}`), { status: res.status });
    return text ? (JSON.parse(text) as unknown) : {};
  }
}

/** Subset of the GitLab "Merge Request Hook" payload we read. */
export interface GitLabMergeRequestPayload {
  object_kind: string;
  user?: { username?: string };
  project: { path_with_namespace: string; git_http_url?: string };
  object_attributes: {
    iid: number;
    action?: string;
    state?: string;
    draft?: boolean;
    work_in_progress?: boolean;
    title?: string;
    description?: string | null;
    source_branch?: string;
    target_branch: string;
    /** Set on "update" when new commits were pushed. */
    oldrev?: string;
    last_commit: { id: string };
    source_project_id?: number;
    target_project_id?: number;
  };
  labels?: Array<{ title: string }>;
}

/** Constant-time check of the X-Gitlab-Token header against the configured secret. */
export function verifyGitLabToken(header: string | undefined, secret: string): boolean {
  if (!header || !secret) return false;
  const a = createHash("sha256").update(header).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}

const GATED_ACTIONS = new Set(["open", "reopen", "update"]);
const MAX_BODY = 10_000;

/**
 * Turn a merge_request hook into a ChangeRef, or a reason to skip it. "update" only counts when
 * it carries new commits (oldrev). The base sha is the target branch head (looked up via the API).
 */
export async function changeFromMergeRequest(
  p: GitLabMergeRequestPayload,
  branchHead: (project: string, branch: string) => Promise<string>,
): Promise<{ change?: ChangeRef; skip?: string }> {
  if (p.object_kind !== "merge_request") return { skip: `object_kind ${p.object_kind}` };
  const mr = p.object_attributes;
  const action = mr.action ?? "";
  if (!GATED_ACTIONS.has(action)) return { skip: `action ${action || "?"}` };
  if (action === "update" && !mr.oldrev) return { skip: "update without new commits" };
  if (mr.source_project_id !== undefined && mr.target_project_id !== undefined && mr.source_project_id !== mr.target_project_id) {
    return { skip: "merge request from a fork (not supported yet)" };
  }
  const project = p.project.path_with_namespace;
  const baseSha = await branchHead(project, mr.target_branch);
  return {
    change: {
      provider: "gitlab",
      repoFullName: project,
      cloneUrl: p.project.git_http_url,
      headSha: mr.last_commit.id,
      baseSha,
      prNumber: mr.iid,
      author: p.user?.username,
      pr: {
        headRef: mr.source_branch,
        title: mr.title,
        body: mr.description ? mr.description.slice(0, MAX_BODY) : undefined,
        labels: p.labels?.map((l) => l.title),
      },
    },
  };
}

/** Routes CheckProvider calls to the provider for each change (GitHub, GitLab). */
export class ProviderRouter implements CheckProvider {
  readonly name: ChangeRef["provider"];
  constructor(private readonly providers: Partial<Record<ChangeRef["provider"], CheckProvider>>) {
    this.name = providers.github ? "github" : "gitlab";
  }
  private for(change: ChangeRef): CheckProvider {
    const p = this.providers[change.provider];
    if (!p) throw new Error(`no ${change.provider} provider configured`);
    return p;
  }
  async startCheck(change: ChangeRef): Promise<string> {
    return this.for(change).startCheck(change);
  }
  async completeCheck(change: ChangeRef, externalCheckId: string, result: GateResult): Promise<void> {
    return this.for(change).completeCheck(change, externalCheckId, result);
  }
}
