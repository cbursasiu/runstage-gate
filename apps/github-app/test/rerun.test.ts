import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { GateResult } from "@runstage-gate/core";
import { GateService, GitHubCheckProvider, JobQueue, RunnerRegistry, createAppServer, hashToken } from "../src/index.ts";
import { listen, mockChecksClient, sendWebhook } from "./helpers.ts";

const SECRET = "test-webhook-secret";
const TOKEN = "rerun-runner-token";
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const passing: GateResult = { conclusion: "success", title: "ok", summary: "ok", checks: [] };

let server: Server | undefined;
afterEach(() => server?.close());

async function setup(appId?: number) {
  const gh = mockChecksClient();
  let next = 314;
  gh.create.mockImplementation(async () => ({ data: { id: next++ } }));
  const queue = new JobQueue();
  const service = new GateService({ provider: new GitHubCheckProvider(gh.factory), queue, appId });
  const runners = RunnerRegistry.fromEntries([{ id: "r1", tokenSha256: hashToken(TOKEN) }]);
  server = createAppServer({ webhookSecret: SECRET, runners, service, queue });
  const url = await listen(server);
  const runner = (path: string, body: unknown = {}) =>
    fetch(`${url}${path}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) });
  /** Open a PR and let the runner finish its job, leaving a completed check run 314. */
  async function completeFirstRun() {
    await sendWebhook(url, SECRET, "pull_request", fixture("pull_request.opened"));
    const job = (await (await runner("/api/runner/jobs/next")).json()) as { id: string };
    expect((await runner(`/api/runner/jobs/${job.id}/result`, passing)).status).toBe(200);
    return job;
  }
  return { gh, queue, url, runner, completeFirstRun };
}

describe("re-running the RunStage Gate check", () => {
  it("check_run.rerequested creates a fresh check run and a new job keyed by it", async () => {
    const { gh, queue, url, runner, completeFirstRun } = await setup(4242);
    const first = await completeFirstRun();

    const res = await sendWebhook(url, SECRET, "check_run", fixture("check_run.rerequested"));
    expect(res.status).toBe(202);
    expect(gh.create).toHaveBeenCalledTimes(2);
    expect(gh.create.mock.calls[1]![0]).toMatchObject({ name: "RunStage Gate", head_sha: "1".repeat(40), status: "in_progress" });

    const jobs = queue.list();
    expect(jobs).toHaveLength(2);
    const rerun = jobs.find((j) => j.id !== first.id)!;
    expect(rerun).toMatchObject({
      status: "queued",
      externalCheckId: "315",
      change: { repoFullName: "acme/demo-app", prNumber: 42, baseSha: "0".repeat(40), headSha: "1".repeat(40), installationId: 777 },
    });

    const claimed = (await (await runner("/api/runner/jobs/next")).json()) as { id: string };
    expect(claimed.id).toBe(rerun.id);
    await runner(`/api/runner/jobs/${claimed.id}/result`, passing);
    expect(gh.update.mock.calls.at(-1)![0]).toMatchObject({ check_run_id: 315, conclusion: "success" });
  });

  it("does not create a second job while a re-run is already queued for that commit", async () => {
    const { gh, queue, url, completeFirstRun } = await setup();
    await completeFirstRun();
    await sendWebhook(url, SECRET, "check_run", fixture("check_run.rerequested"));
    await sendWebhook(url, SECRET, "check_run", fixture("check_run.rerequested")); // clicked twice (new delivery id)
    await sendWebhook(url, SECRET, "check_suite", { ...fixture("check_suite.requested"), action: "rerequested" });
    expect(gh.create).toHaveBeenCalledTimes(2);
    expect(queue.list().filter((j) => j.status === "queued")).toHaveLength(1);
  });

  it.each([
    ["another check's name", (p: any) => (p.check_run.name = "lint")],
    ["another app's check run", (p: any) => (p.check_run.app.id = 9999)],
    ["a non-rerequest action", (p: any) => (p.action = "completed")],
    ["a check run with no pull request", (p: any) => (p.check_run.pull_requests = [])],
  ])("ignores %s", async (_label, mutate) => {
    const { gh, queue, url } = await setup(4242);
    const payload = fixture("check_run.rerequested");
    mutate(payload);
    expect((await sendWebhook(url, SECRET, "check_run", payload)).status).toBe(202);
    expect(gh.create).not.toHaveBeenCalled();
    expect(queue.list()).toHaveLength(0);
  });

  it("check_suite.rerequested after completion still starts a new check run and job", async () => {
    const { gh, queue, url, completeFirstRun } = await setup();
    await completeFirstRun();
    await sendWebhook(url, SECRET, "check_suite", { ...fixture("check_suite.requested"), action: "rerequested" });
    expect(gh.create).toHaveBeenCalledTimes(2);
    expect(queue.list().map((j) => [j.externalCheckId, j.status])).toEqual([
      ["314", "completed"],
      ["315", "queued"],
    ]);
  });
});
