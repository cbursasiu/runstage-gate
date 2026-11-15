import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { GateResult } from "@runstage-gate/core";
import { GateService, GitHubCheckProvider, JobQueue, createAppServer } from "../src/index.ts";
import { listen, mockChecksClient, sendWebhook } from "./helpers.ts";

const SECRET = "test-webhook-secret";
const RUNNER_TOKEN = "test-runner-token";
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

let server: Server | undefined;
afterEach(() => server?.close());

async function setup() {
  const gh = mockChecksClient();
  const queue = new JobQueue();
  const service = new GateService({ provider: new GitHubCheckProvider(gh.factory), queue });
  server = createAppServer({ webhookSecret: SECRET, runnerToken: RUNNER_TOKEN, service, queue });
  const url = await listen(server);
  const runner = (path: string, body: unknown = {}, token = RUNNER_TOKEN) =>
    fetch(`${url}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { gh, queue, url, runner };
}

const passing: GateResult = { conclusion: "success", title: "1/1 checks passed", summary: "**Gate passed**", checks: [] };
const failing: GateResult = {
  conclusion: "failure",
  title: "1 required check failed: no-todo-in-diff",
  summary: "**Gate blocked**: app.js:2: // TODO",
  checks: [],
};

describe("GitHub webhook handling", () => {
  it("check_suite.requested creates an in-progress 'RunStage Gate' check run and queues a job", async () => {
    const { gh, queue, url } = await setup();
    const res = await sendWebhook(url, SECRET, "check_suite", fixture("check_suite.requested"));
    expect(res.status).toBe(202);
    expect(gh.factory).toHaveBeenCalledWith(777);
    expect(gh.create).toHaveBeenCalledTimes(1);
    expect(gh.create.mock.calls[0]![0]).toMatchObject({
      owner: "acme",
      repo: "demo-app",
      name: "RunStage Gate",
      head_sha: "1111111111111111111111111111111111111111",
      status: "in_progress",
    });
    const [job] = queue.list();
    expect(job).toMatchObject({
      status: "queued",
      externalCheckId: "314",
      change: { repoFullName: "acme/demo-app", prNumber: 42, baseSha: "0".repeat(40), headSha: "1".repeat(40) },
    });
  });

  it("pull_request.opened for the same commit does not create a duplicate check", async () => {
    const { gh, queue, url } = await setup();
    await sendWebhook(url, SECRET, "check_suite", fixture("check_suite.requested"));
    await sendWebhook(url, SECRET, "pull_request", fixture("pull_request.opened"));
    expect(gh.create).toHaveBeenCalledTimes(1);
    expect(queue.list()).toHaveLength(1);
  });

  it("ignores irrelevant actions and check suites without a pull request", async () => {
    const { gh, url } = await setup();
    await sendWebhook(url, SECRET, "pull_request", { ...fixture("pull_request.opened"), action: "labeled" });
    const cs = fixture("check_suite.requested");
    cs.check_suite.pull_requests = [];
    await sendWebhook(url, SECRET, "check_suite", cs);
    expect(gh.create).not.toHaveBeenCalled();
  });

  it("rejects a bad signature", async () => {
    const { gh, url } = await setup();
    const res = await sendWebhook(url, SECRET, "check_suite", fixture("check_suite.requested"), "sha256=" + "0".repeat(64));
    expect(res.status).toBe(401);
    expect(gh.create).not.toHaveBeenCalled();
  });

  it.each([
    ["success", passing],
    ["failure", failing],
  ] as const)("completes the check run with %s and the summary when the runner reports", async (conclusion, result) => {
    const { gh, url, runner } = await setup();
    await sendWebhook(url, SECRET, "pull_request", fixture("pull_request.opened"));

    const claim = await runner("/api/runner/jobs/next");
    expect(claim.status).toBe(200);
    const job = (await claim.json()) as { id: string };
    expect((await runner("/api/runner/jobs/next")).status).toBe(204);

    const done = await runner(`/api/runner/jobs/${job.id}/result`, result);
    expect(done.status).toBe(200);
    expect(gh.update).toHaveBeenCalledTimes(1);
    expect(gh.update.mock.calls[0]![0]).toMatchObject({
      owner: "acme",
      repo: "demo-app",
      check_run_id: 314,
      status: "completed",
      conclusion,
      output: { title: result.title, summary: result.summary },
    });
    // a second report for the same job is rejected
    expect((await runner(`/api/runner/jobs/${job.id}/result`, result)).status).toBe(404);
  });

  it("requires the runner token", async () => {
    const { runner } = await setup();
    expect((await runner("/api/runner/jobs/next", {}, "wrong")).status).toBe(401);
  });
});
