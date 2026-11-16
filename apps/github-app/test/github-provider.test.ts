import { describe, expect, it, vi } from "vitest";
import type { ChangeRef, GateResult } from "@runstage-gate/core";
import { GitHubCheckProvider, type ChecksClient } from "../src/index.ts";

/**
 * @octokit/app v16's installation client is @octokit/core: it has `request()`, not `rest.checks`.
 * The production crash was `Cannot read properties of undefined (reading 'checks')` when the
 * provider assumed the REST plugin was present.
 */
function requestOnlyClient() {
  const request = vi.fn<ChecksClient["request"]>(async (route) => {
    if (route === "POST /repos/{owner}/{repo}/check-runs") return { data: { id: 9001 } };
    if (route === "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}") return { data: {} };
    throw new Error(`unexpected route ${route satisfies never}`);
  });
  const client: ChecksClient = { request };
  // Explicitly the production shape: no `rest`.
  expect(client).not.toHaveProperty("rest");
  return { client, request };
}

const change: ChangeRef = {
  provider: "github",
  repoFullName: "acme/demo-app",
  headSha: "1".repeat(40),
  baseSha: "0".repeat(40),
  prNumber: 42,
  installationId: 777,
};

const result: GateResult = {
  conclusion: "failure",
  title: ".runstage/gate.yml not found on the base commit",
  summary: "missing on base",
  checks: [],
};

describe("GitHubCheckProvider talks to GitHub via octokit.request", () => {
  it("startCheck creates an in-progress check run and returns its id", async () => {
    const { client, request } = requestOnlyClient();
    const provider = new GitHubCheckProvider(async (id) => {
      expect(id).toBe(777);
      return client;
    });

    const id = await provider.startCheck(change);

    expect(id).toBe("9001");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![0]).toBe("POST /repos/{owner}/{repo}/check-runs");
    expect(request.mock.calls[0]![1]).toMatchObject({
      owner: "acme",
      repo: "demo-app",
      name: "RunStage Gate",
      head_sha: change.headSha,
      status: "in_progress",
      output: { title: "Waiting for a runner" },
    });
  });

  it("completeCheck patches the check run with the gate result", async () => {
    const { client, request } = requestOnlyClient();
    const provider = new GitHubCheckProvider(async () => client);

    await provider.completeCheck(change, "9001", result);

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![0]).toBe("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}");
    expect(request.mock.calls[0]![1]).toMatchObject({
      owner: "acme",
      repo: "demo-app",
      check_run_id: 9001,
      status: "completed",
      conclusion: "failure",
      output: { title: result.title, summary: result.summary },
    });
  });

  it("throws when the change has no installationId", async () => {
    const { client, request } = requestOnlyClient();
    const provider = new GitHubCheckProvider(async () => client);
    const { installationId: _, ...noInstall } = change;
    await expect(provider.startCheck(noInstall)).rejects.toThrow(/installationId/);
    expect(request).not.toHaveBeenCalled();
  });
});
