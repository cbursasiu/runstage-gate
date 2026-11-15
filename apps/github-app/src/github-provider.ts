import { CHECK_NAME, type ChangeRef, type CheckProvider, type GateResult } from "@runstage-gate/core";

/** The slice of Octokit we use. Keeps tests and the demo free of real network calls. */
export interface ChecksClient {
  rest: {
    checks: {
      create(params: {
        owner: string;
        repo: string;
        name: string;
        head_sha: string;
        status: "queued" | "in_progress";
        started_at?: string;
        output?: { title: string; summary: string };
        external_id?: string;
      }): Promise<{ data: { id: number } }>;
      update(params: {
        owner: string;
        repo: string;
        check_run_id: number;
        status: "completed";
        conclusion: "success" | "failure" | "neutral";
        completed_at?: string;
        output: { title: string; summary: string };
      }): Promise<unknown>;
    };
  };
}

export type ChecksClientFactory = (installationId: number) => Promise<ChecksClient>;

const SUMMARY_LIMIT = 65_000; // GitHub caps output.summary at 65535 chars

export class GitHubCheckProvider implements CheckProvider {
  readonly name = "github" as const;
  constructor(private readonly clientFor: ChecksClientFactory) {}

  async startCheck(change: ChangeRef): Promise<string> {
    const { owner, repo } = split(change.repoFullName);
    const client = await this.clientFor(requireInstallation(change));
    const { data } = await client.rest.checks.create({
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
    return String(data.id);
  }

  async completeCheck(change: ChangeRef, externalCheckId: string, result: GateResult): Promise<void> {
    const { owner, repo } = split(change.repoFullName);
    const client = await this.clientFor(requireInstallation(change));
    await client.rest.checks.update({
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
