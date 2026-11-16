import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { CheckProvider, GateJob } from "@runstage-gate/core";
import { GateService, HttpHistorySink, JobQueue } from "../src/index.ts";
import type { CheckSuitePayload, PullRequestPayload } from "../src/handlers.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const provider: CheckProvider = { name: "github", startCheck: async () => "check-1", completeCheck: async () => {} };

function prPayload(): PullRequestPayload {
  const p = fixture("pull_request.opened") as PullRequestPayload;
  p.pull_request.title = "Refactor auth";
  p.pull_request.body = "Generated with Claude Code";
  p.pull_request.labels = [{ name: "ai-generated" }, { name: "auth" }];
  return p;
}

describe("PR metadata for AI detection", () => {
  it("captures head branch, labels, title and (capped) body from pull_request events", async () => {
    const queue = new JobQueue();
    const service = new GateService({ provider, queue });
    const p = prPayload();
    p.pull_request.body = "x".repeat(20_000);
    const job = await service.onPullRequest(p);
    expect(job!.change.pr).toMatchObject({ headRef: "ai/refactor-auth", title: "Refactor auth", labels: ["ai-generated", "auth"] });
    expect(job!.change.pr!.body!.length).toBe(10_000);
  });

  it("merges pull_request metadata into a queued job that check_suite created first", async () => {
    const queue = new JobQueue();
    const service = new GateService({ provider, queue });
    const suite = fixture("check_suite.requested") as CheckSuitePayload;
    suite.check_suite.head_branch = "ai/refactor-auth";
    const first = await service.onCheckSuite(suite);
    expect(first!.change.pr).toEqual({ headRef: "ai/refactor-auth" });
    const again = await service.onPullRequest(prPayload());
    expect(again!.id).toBe(first!.id);
    expect(queue.list()).toHaveLength(1);
    expect(queue.get(first!.id)!.change).toMatchObject({
      author: "octo-dev",
      pr: { headRef: "ai/refactor-auth", labels: ["ai-generated", "auth"], body: "Generated with Claude Code" },
    });
  });

  it("does not modify a job a runner already claimed", async () => {
    const queue = new JobQueue();
    const service = new GateService({ provider, queue });
    const first = await service.onCheckSuite(fixture("check_suite.requested") as CheckSuitePayload);
    queue.claimNext("r1");
    await service.onPullRequest(prPayload());
    expect(queue.get(first!.id)!.change.pr?.labels).toBeUndefined();
  });

  it("sends the AI verdict to history", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const job: GateJob = {
        id: "j", externalCheckId: "1", status: "completed", createdAt: "2026-11-16T00:00:00.000Z",
        change: { provider: "github", repoFullName: "a/b", headSha: "h", baseSha: "b", prNumber: 1 },
        result: { conclusion: "success", title: "ok", summary: "ok", checks: [], ai: { generated: true, signals: ["PR label \"ai-generated\""] } },
      };
      await new HttpHistorySink("http://history.test", "w").record(job);
      const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
      expect(body).toMatchObject({ aiGenerated: true, aiSignals: ['PR label "ai-generated"'] });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("sends the provider, check run id and check run URL to history (fleet links)", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const job: GateJob = {
        id: "j", externalCheckId: "314", status: "completed", createdAt: "2026-11-16T00:00:00.000Z",
        change: { provider: "github", repoFullName: "a/b", headSha: "h", baseSha: "b", prNumber: 1 },
        result: { conclusion: "failure", title: "1 failed", summary: "x", checks: [] },
      };
      await new HttpHistorySink("http://history.test", "w").record(job);
      const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
      expect(body).toMatchObject({ provider: "github", externalCheckId: "314", checkUrl: "https://github.com/a/b/runs/314" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
