import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { GateResult } from "@runstage-gate/core";
import { GateService, GitHubCheckProvider, JobQueue, RunnerRegistry, createAppServer, hashToken } from "../src/index.ts";
import { listen, mockChecksClient, sendWebhook } from "./helpers.ts";

const SECRET = "test-webhook-secret";
const RUNNER_TOKEN = "test-runner-token";
const OTHER_TOKEN = "test-other-runner-token";
const SCOPED_TOKEN = "test-scoped-runner-token";
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

let server: Server | undefined;
afterEach(() => server?.close());

const runners = RunnerRegistry.fromEntries([
  { id: "runner-a", tokenSha256: hashToken(RUNNER_TOKEN) },
  { id: "runner-b", tokenSha256: hashToken(OTHER_TOKEN) },
  { id: "runner-scoped", tokenSha256: hashToken(SCOPED_TOKEN), repos: ["acme/other-repo"] },
]);

async function setup(queue = new JobQueue()) {
  const gh = mockChecksClient();
  const service = new GateService({ provider: new GitHubCheckProvider(gh.factory), queue });
  server = createAppServer({ webhookSecret: SECRET, runners, service, queue });
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

  it("requires a registered runner token", async () => {
    const { runner } = await setup();
    expect((await runner("/api/runner/jobs/next", {}, "wrong")).status).toBe(401);
    expect((await runner("/api/runner/jobs/next", {}, "")).status).toBe(401);
  });
});

describe("per-runner tokens and the durable queue", () => {
  it("records the claiming runner from its token and rejects another runner's result", async () => {
    const { gh, queue, url, runner } = await setup();
    await sendWebhook(url, SECRET, "pull_request", fixture("pull_request.opened"));
    // a spoofed x-runner-id header does not change who claimed it: identity comes from the token
    const claim = await fetch(`${url}/api/runner/jobs/next`, {
      method: "POST",
      headers: { authorization: `Bearer ${RUNNER_TOKEN}`, "x-runner-id": "runner-b" },
      body: "{}",
    });
    const job = (await claim.json()) as { id: string; runnerId: string; leaseExpiresAt: string };
    expect(job).toMatchObject({ runnerId: "runner-a", status: "claimed" });
    expect(job.leaseExpiresAt).toBeTruthy();

    const stolen = await runner(`/api/runner/jobs/${job.id}/result`, passing, OTHER_TOKEN);
    expect(stolen.status).toBe(403);
    expect((await runner(`/api/runner/jobs/${job.id}/heartbeat`, {}, OTHER_TOKEN)).status).toBe(403);
    expect(gh.update).not.toHaveBeenCalled();

    expect((await runner(`/api/runner/jobs/${job.id}/heartbeat`)).status).toBe(200);
    expect((await runner(`/api/runner/jobs/${job.id}/result`, passing)).status).toBe(200);
    expect(queue.get(job.id)).toMatchObject({ status: "completed", runnerId: "runner-a" });
  });

  it("a repo-scoped runner only gets jobs for its repos", async () => {
    const { url, runner } = await setup();
    await sendWebhook(url, SECRET, "pull_request", fixture("pull_request.opened")); // acme/demo-app
    expect((await runner("/api/runner/jobs/next", {}, SCOPED_TOKEN)).status).toBe(204);
    expect((await runner("/api/runner/jobs/next", {}, RUNNER_TOKEN)).status).toBe(200);
  });

  it("ignores a redelivered webhook (same delivery id), even after the job completed", async () => {
    const { gh, queue, url, runner } = await setup();
    const payload = fixture("pull_request.opened");
    const deliver = () =>
      sendWebhook(url, SECRET, "pull_request", payload, undefined, "delivery-123");
    expect((await deliver()).status).toBe(202);
    const job = (await (await runner("/api/runner/jobs/next")).json()) as { id: string };
    await runner(`/api/runner/jobs/${job.id}/result`, passing);
    const again = await deliver();
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ duplicate: true });
    expect(gh.create).toHaveBeenCalledTimes(1);
    expect(queue.list()).toHaveLength(1);
  });

  it("keeps queued jobs across an App restart", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "rsg-app-")), "queue.json");
    const first = await setup(JobQueue.file(file));
    await sendWebhook(first.url, SECRET, "pull_request", fixture("pull_request.opened"));
    server!.close();

    const second = await setup(JobQueue.file(file)); // new process, same file
    const claim = await second.runner("/api/runner/jobs/next");
    expect(claim.status).toBe(200);
    const job = (await claim.json()) as { id: string; externalCheckId: string };
    expect(job.externalCheckId).toBe("314");
    expect((await second.runner(`/api/runner/jobs/${job.id}/result`, failing)).status).toBe(200);
    expect(second.gh.update.mock.calls[0]![0]).toMatchObject({ check_run_id: 314, conclusion: "failure" });
  });
});
