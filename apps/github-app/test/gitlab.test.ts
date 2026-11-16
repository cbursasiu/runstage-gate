import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChangeRef, CheckProvider, GateResult } from "@runstage-gate/core";
import {
  GateService,
  GitLabStatusProvider,
  JobQueue,
  ProviderRouter,
  RunnerRegistry,
  changeFromMergeRequest,
  createAppServer,
  hashToken,
  verifyGitLabToken,
  type GitLabMergeRequestPayload,
} from "../src/index.ts";
import { listen } from "./helpers.ts";

const HEAD = "a".repeat(40);
const TARGET = "b".repeat(40);
const change: ChangeRef = {
  provider: "gitlab", repoFullName: "acme/backend", headSha: HEAD, baseSha: TARGET, prNumber: 5, pr: { headRef: "feature/x" },
};
const failing: GateResult = { conclusion: "failure", title: "1 required check failed: lint", summary: "s", checks: [] };

/** Fake GitLab API. Records calls; branch lookups return TARGET. */
function fakeGitLab(status = 201) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: Record<string, string> }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({
      url: u,
      method: init?.method ?? "GET",
      headers: init?.headers as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (status >= 400) return new Response(JSON.stringify({ message: "403 Forbidden" }), { status });
    if (u.includes("/repository/branches/")) return new Response(JSON.stringify({ name: "main", commit: { id: TARGET } }), { status: 200 });
    return new Response(JSON.stringify({ id: 9001, status: "running" }), { status: 201 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("GitLabStatusProvider", () => {
  it("posts a running commit status named RunStage Gate, then success/failed with the title", async () => {
    const gl = fakeGitLab();
    const p = new GitLabStatusProvider({ baseUrl: "https://gitlab.example.com/", token: "glpat-test", targetUrl: "http://localhost:3100/", fetchImpl: gl.fetchImpl });
    expect(await p.startCheck(change)).toBe("9001");
    await p.completeCheck(change, "9001", failing);
    await p.completeCheck(change, "9001", { ...failing, conclusion: "success", title: "x".repeat(400) });
    expect(gl.calls.map((c) => [c.method, c.url])).toEqual(
      Array(3).fill(["POST", `https://gitlab.example.com/api/v4/projects/acme%2Fbackend/statuses/${HEAD}`]),
    );
    expect(gl.calls[0]!.headers["private-token"]).toBe("glpat-test");
    expect(gl.calls[0]!.body).toEqual({ state: "running", name: "RunStage Gate", description: "Waiting for a runner", ref: "feature/x", target_url: "http://localhost:3100/" });
    expect(gl.calls[1]!.body).toMatchObject({ state: "failed", description: "1 required check failed: lint" });
    expect(gl.calls[2]!.body!.state).toBe("success");
    expect(gl.calls[2]!.body!.description).toHaveLength(255);
  });

  it("throws on GitLab errors (so the App retries the report)", async () => {
    const p = new GitLabStatusProvider({ baseUrl: "https://gitlab.com", token: "t", fetchImpl: fakeGitLab(403).fetchImpl });
    await expect(p.completeCheck(change, "1", failing)).rejects.toThrow(/GitLab POST \/projects\/acme%2Fbackend\/statuses\/a+ -> 403/);
  });

  it("looks up a branch head", async () => {
    const gl = fakeGitLab();
    const p = new GitLabStatusProvider({ baseUrl: "https://gitlab.com", token: "t", fetchImpl: gl.fetchImpl });
    expect(await p.branchHead("acme/backend", "release/1.0")).toBe(TARGET);
    expect(gl.calls[0]!.url).toBe("https://gitlab.com/api/v4/projects/acme%2Fbackend/repository/branches/release%2F1.0");
  });
});

function mrPayload(over: Partial<GitLabMergeRequestPayload["object_attributes"]> = {}): GitLabMergeRequestPayload {
  return {
    object_kind: "merge_request",
    user: { username: "dev1" },
    project: { path_with_namespace: "acme/backend", git_http_url: "https://gitlab.com/acme/backend.git" },
    object_attributes: {
      iid: 5, action: "open", title: "Add x", description: "Generated with Claude Code", source_branch: "claude/add-x",
      target_branch: "main", last_commit: { id: HEAD }, source_project_id: 1, target_project_id: 1, ...over,
    },
    labels: [{ title: "ai-generated" }],
  };
}

describe("changeFromMergeRequest", () => {
  const head = async () => TARGET;
  it("maps open/reopen/update-with-commits to a gitlab ChangeRef", async () => {
    const { change: c } = await changeFromMergeRequest(mrPayload(), head);
    expect(c).toEqual({
      provider: "gitlab", repoFullName: "acme/backend", cloneUrl: "https://gitlab.com/acme/backend.git", headSha: HEAD, baseSha: TARGET,
      prNumber: 5, author: "dev1", pr: { headRef: "claude/add-x", title: "Add x", body: "Generated with Claude Code", labels: ["ai-generated"] },
    });
    expect((await changeFromMergeRequest(mrPayload({ action: "reopen" }), head)).change).toBeDefined();
    expect((await changeFromMergeRequest(mrPayload({ action: "update", oldrev: "c".repeat(40) }), head)).change).toBeDefined();
  });

  it("skips title-only updates, closes, merges, forks and other kinds", async () => {
    expect((await changeFromMergeRequest(mrPayload({ action: "update" }), head)).skip).toBe("update without new commits");
    expect((await changeFromMergeRequest(mrPayload({ action: "close" }), head)).skip).toBe("action close");
    expect((await changeFromMergeRequest(mrPayload({ action: "merge" }), head)).skip).toBe("action merge");
    expect((await changeFromMergeRequest(mrPayload({ source_project_id: 2 }), head)).skip).toMatch(/fork/);
    expect((await changeFromMergeRequest({ ...mrPayload(), object_kind: "push" }, head)).skip).toBe("object_kind push");
  });
});

describe("verifyGitLabToken", () => {
  it("compares in constant time and rejects missing values", () => {
    expect(verifyGitLabToken("s3cret", "s3cret")).toBe(true);
    expect(verifyGitLabToken("s3cre", "s3cret")).toBe(false);
    expect(verifyGitLabToken(undefined, "s3cret")).toBe(false);
    expect(verifyGitLabToken("x", "")).toBe(false);
  });
});

describe("ProviderRouter", () => {
  it("dispatches by change.provider and errors for unconfigured providers", async () => {
    const gh: CheckProvider = { name: "github", startCheck: vi.fn(async () => "gh-1"), completeCheck: vi.fn(async () => {}) };
    const gl: CheckProvider = { name: "gitlab", startCheck: vi.fn(async () => "gl-1"), completeCheck: vi.fn(async () => {}) };
    const router = new ProviderRouter({ github: gh, gitlab: gl });
    expect(await router.startCheck(change)).toBe("gl-1");
    expect(await router.startCheck({ ...change, provider: "github" })).toBe("gh-1");
    await expect(new ProviderRouter({ github: gh }).startCheck(change)).rejects.toThrow("no gitlab provider configured");
  });
});

let server: Server | undefined;
afterEach(() => server?.close());

describe("POST /webhooks/gitlab", () => {
  const SECRET = "gitlab-hook-secret";
  const TOKEN = "gitlab-runner-token";
  async function setup(enabled = true) {
    const gl = fakeGitLab();
    const provider = new GitLabStatusProvider({ baseUrl: "https://gitlab.com", token: "t", fetchImpl: gl.fetchImpl });
    const queue = new JobQueue();
    const service = new GateService({ provider: new ProviderRouter({ gitlab: provider }), queue, reportRetryDelaysMs: [] });
    const runners = RunnerRegistry.fromEntries([{ id: "r1", tokenSha256: hashToken(TOKEN) }]);
    server = createAppServer({ webhookSecret: "gh", runners, service, queue, gitlab: enabled ? { webhookSecret: SECRET, provider } : undefined });
    const url = await listen(server);
    const hook = (payload: unknown, token = SECRET, uuid = `u-${Math.random()}`, event = "Merge Request Hook") =>
      fetch(`${url}/webhooks/gitlab`, {
        method: "POST",
        headers: { "x-gitlab-token": token, "x-gitlab-event": event, "x-gitlab-event-uuid": uuid, "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    const runner = (path: string, body: unknown = {}) =>
      fetch(`${url}${path}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) });
    return { gl, queue, hook, runner };
  }

  it("is 404 when GitLab is not configured", async () => {
    const { hook } = await setup(false);
    expect((await hook(mrPayload())).status).toBe(404);
  });

  it("rejects a bad token", async () => {
    const { hook, queue } = await setup();
    expect((await hook(mrPayload(), "wrong")).status).toBe(401);
    expect(queue.list()).toHaveLength(0);
  });

  it("queues a job for an opened MR, de-duplicates deliveries, and reports the result as a commit status", async () => {
    const { gl, queue, hook, runner } = await setup();
    expect((await hook(mrPayload(), SECRET, "same")).status).toBe(202);
    expect((await hook(mrPayload(), SECRET, "same")).status).toBe(200);
    expect(queue.list()).toHaveLength(1);
    expect(queue.list()[0]!.change).toMatchObject({ provider: "gitlab", repoFullName: "acme/backend", headSha: HEAD, baseSha: TARGET, prNumber: 5 });
    expect(gl.calls.map((c) => c.body?.state ?? "branch")).toEqual(["branch", "running"]);

    const job = (await (await runner("/api/runner/jobs/next")).json()) as { id: string };
    expect((await runner(`/api/runner/jobs/${job.id}/result`, failing)).status).toBe(200);
    expect(gl.calls.at(-1)!.body).toMatchObject({ state: "failed", name: "RunStage Gate", description: failing.title });
  });

  it("acknowledges but ignores other events and actions", async () => {
    const { queue, hook } = await setup();
    expect((await hook({ object_kind: "push" }, SECRET, "p1", "Push Hook")).status).toBe(202);
    expect((await hook(mrPayload({ action: "close" }))).status).toBe(202);
    expect(queue.list()).toHaveLength(0);
  });
});
