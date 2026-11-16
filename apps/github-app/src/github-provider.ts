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
};

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
  constructor(private readonly clientFor: ChecksClientFactory) {}

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
      output: { title: result.title.slice(0, 255), summary: result.summary.slice(0, SUMMARY_LIMIT) },
    });
  }
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
