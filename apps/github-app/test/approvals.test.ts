import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GateResult } from "@runstage-gate/core";
import {
  APPROVE_ACTION_ID,
  GateService,
  GitHubApprovals,
  GitHubCheckProvider,
  JobQueue,
  RunnerRegistry,
  approvedResult,
  createAppServer,
  hashToken,
  type ApprovalDeps,
  type HistorySink,
} from "../src/index.ts";
import { listen, mockChecksClient, sendWebhook } from "./helpers.ts";

const SECRET = "approvals-webhook-secret";
const TOKEN = "approvals-runner-token";
const HEAD = "1".repeat(40);
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const failing: GateResult = {
  conclusion: "failure",
  title: "1 required check failed: no-todo-in-diff",
  summary: "Gate blocked",
  checks: [{ name: "no-todo-in-diff", kind: "script", required: true, status: "failed", reason: "exit 1", exitCode: 1, durationMs: 5, output: "x" }],
};
const passing: GateResult = { conclusion: "success", title: "ok", summary: "ok", checks: [] };

let server: Server | undefined;
afterEach(() => server?.close());

async function setup(opts: { roles?: Record<string, string>; allowSelfApproval?: boolean; approvals?: boolean } = {}) {
  const gh = mockChecksClient();
  let next = 314;
  gh.create.mockImplementation(async () => ({ data: { id: next++ } }));
  const roles = opts.roles ?? { maintainer: "maintain", writer: "write", reader: "read", "octo-dev": "write" };
  const permissionOf = vi.fn(async (_c: unknown, login: string) => roles[login] ?? "none");
  const pullRequest = vi.fn(async () => ({ headSha: HEAD, baseSha: "0".repeat(40), author: "octo-dev" }));
  const approvals: ApprovalDeps | undefined =
    opts.approvals === false ? undefined : { permissionOf, pullRequest, allowSelfApproval: opts.allowSelfApproval };
  const records: Array<Parameters<HistorySink["record"]>[0]> = [];
  const history: HistorySink = { record: async (job) => void records.push(structuredClone(job)) };
  const queue = new JobQueue();
  const service = new GateService({
    provider: new GitHubCheckProvider(gh.factory, { approvalButton: true }),
    queue,
    appId: 4242,
    approvals,
    history,
    reportRetryDelaysMs: [],
  });
  const runners = RunnerRegistry.fromEntries([{ id: "r1", tokenSha256: hashToken(TOKEN) }]);
  server = createAppServer({ webhookSecret: SECRET, runners, service, queue });
  const url = await listen(server);
  const runner = (path: string, body: unknown = {}) =>
    fetch(`${url}${path}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) });
  async function finishRun(result: GateResult) {
    await sendWebhook(url, SECRET, "pull_request", fixture("pull_request.opened"));
    const job = (await (await runner("/api/runner/jobs/next")).json()) as { id: string; externalCheckId: string };
    expect((await runner(`/api/runner/jobs/${job.id}/result`, result)).status).toBe(200);
    return job;
  }
  const clickApprove = (login: string, checkId: number, identifier = APPROVE_ACTION_ID) => {
    const payload = fixture("check_run.rerequested");
    payload.action = "requested_action";
    payload.requested_action = { identifier };
    payload.check_run.id = checkId;
    payload.sender = { login };
    return sendWebhook(url, SECRET, "check_run", payload);
  };
  const comment = (login: string, body: string, extra: Record<string, unknown> = {}) =>
    sendWebhook(url, SECRET, "issue_comment", {
      action: "created",
      issue: { number: 42, pull_request: { url: "x" } },
      comment: { id: 1, body, user: { login, type: "User" } },
      repository: { full_name: "acme/demo-app" },
      installation: { id: 777 },
      sender: { login },
      ...extra,
    });
  return { gh, queue, service, url, runner, finishRun, clickApprove, comment, permissionOf, pullRequest, records };
}

describe("approvals: Approve override button", () => {
  it("adds the button and a hint to failed checks only", async () => {
    const { gh, finishRun } = await setup();
    await finishRun(failing);
    const failed = gh.update.mock.calls.at(-1)![0];
    expect(failed.conclusion).toBe("failure");
    expect(failed.actions).toEqual([{ label: "Approve override", description: expect.any(String), identifier: APPROVE_ACTION_ID }]);
    expect(failed.actions![0]!.label.length).toBeLessThanOrEqual(20);
    expect(failed.actions![0]!.description.length).toBeLessThanOrEqual(40);
    expect(failed.output.summary).toContain("/runstage approve");
  });

  it("a maintainer's click re-completes the check as success with an Approved-by note and records approvedBy", async () => {
    const { gh, queue, finishRun, clickApprove, permissionOf, records } = await setup();
    const job = await finishRun(failing);
    expect((await clickApprove("maintainer", Number(job.externalCheckId))).status).toBe(202);

    expect(permissionOf).toHaveBeenCalledWith(expect.objectContaining({ repoFullName: "acme/demo-app" }), "maintainer");
    const last = gh.update.mock.calls.at(-1)![0];
    expect(last).toMatchObject({ check_run_id: Number(job.externalCheckId), status: "completed", conclusion: "success" });
    expect(last.actions).toBeUndefined();
    expect(last.output.title).toMatch(/^Approved by maintainer \(override\): 1 required check failed/);
    expect(last.output.summary).toContain("**Approved by @maintainer** via the **Approve override** button");
    expect(last.output.summary).toContain("Gate blocked");

    expect(queue.get(job.id)).toMatchObject({ approvedBy: "maintainer", approvedVia: "check_run_action", result: { conclusion: "failure" } });
    expect(records.at(-1)).toMatchObject({ approvedBy: "maintainer", result: { conclusion: "success" } });
  });

  it("refuses users without write access, other buttons, passing gates, and double approval", async () => {
    const { gh, queue, service, finishRun, clickApprove } = await setup();
    const job = await finishRun(failing);
    const updates = () => gh.update.mock.calls.length;
    const before = updates();
    await clickApprove("reader", Number(job.externalCheckId));
    await clickApprove("stranger", Number(job.externalCheckId));
    await clickApprove("maintainer", Number(job.externalCheckId), "something-else");
    expect(updates()).toBe(before);
    expect(queue.get(job.id)!.approvedBy).toBeUndefined();

    await clickApprove("writer", Number(job.externalCheckId));
    expect(queue.get(job.id)!.approvedBy).toBe("writer");
    expect(await service.approve(queue.get(job.id)!, "maintainer", "check_run_action")).toEqual({ ok: false, reason: "already_approved" });
  });

  it("does not approve a passing gate or a stale check run after a re-run", async () => {
    const { queue, service, finishRun } = await setup();
    const ok = await finishRun(passing);
    expect(await service.approve(queue.get(ok.id)!, "maintainer", "check_run_action")).toEqual({ ok: false, reason: "not_failed" });
    const stale = queue.get(ok.id)!;
    queue.enqueue(stale.change, "999"); // a newer job (re-run) for the same commit
    expect(await service.approve(stale, "maintainer", "check_run_action")).toEqual({ ok: false, reason: "stale" });
  });

  it("can forbid self-approval", async () => {
    const { queue, service, finishRun } = await setup({ allowSelfApproval: false });
    const job = await finishRun(failing);
    // pull_request.opened fixture's author is octo-dev (write access)
    expect(await service.approve(queue.get(job.id)!, "octo-dev", "comment")).toEqual({ ok: false, reason: "self_approval" });
    expect((await service.approve(queue.get(job.id)!, "maintainer", "comment")).ok).toBe(true);
  });

  it("is a no-op when approvals are disabled", async () => {
    const { queue, service, finishRun, gh } = await setup({ approvals: false });
    const job = await finishRun(failing);
    expect(await service.approve(queue.get(job.id)!, "maintainer", "comment")).toEqual({ ok: false, reason: "disabled" });
    expect(gh.update).toHaveBeenCalledTimes(1);
  });
});

describe("approvals: /runstage approve comment", () => {
  it("approves the latest failed run for the PR head", async () => {
    const { gh, queue, finishRun, comment, pullRequest } = await setup();
    const job = await finishRun(failing);
    expect((await comment("writer", "/runstage approve\nlooks fine, flaky check")).status).toBe(202);
    expect(pullRequest).toHaveBeenCalledWith({ repoFullName: "acme/demo-app", installationId: 777 }, 42);
    expect(queue.get(job.id)).toMatchObject({ approvedBy: "writer", approvedVia: "comment" });
    expect(gh.update.mock.calls.at(-1)![0].output.summary).toContain("via a `/runstage approve` comment");
  });

  it("ignores other comments, bots, issues and edits; refuses readers", async () => {
    const { queue, finishRun, comment } = await setup();
    const job = await finishRun(failing);
    await comment("writer", "please /runstage approve");
    await comment("writer", "/runstage approved");
    await comment("dependabot[bot]", "/runstage approve", { comment: { id: 2, body: "/runstage approve", user: { login: "dependabot[bot]", type: "Bot" } } });
    await comment("writer", "/runstage approve", { issue: { number: 42 } });
    await comment("writer", "/runstage approve", { action: "edited" });
    await comment("reader", "/runstage approve");
    expect(queue.get(job.id)!.approvedBy).toBeUndefined();
  });
});

describe("approvedResult", () => {
  it("keeps the checks and wraps the original verdict", () => {
    const r = approvedResult({
      id: "j", externalCheckId: "1", status: "completed", createdAt: "", result: failing,
      change: { provider: "github", repoFullName: "a/b", headSha: HEAD, baseSha: HEAD, prNumber: 1 },
      approvedBy: "m", approvedAt: "2026-11-16T03:00:00.000Z", approvedVia: "comment",
    });
    expect(r.conclusion).toBe("success");
    expect(r.checks).toEqual(failing.checks);
    expect(r.summary).toContain("2026-11-16T03:00:00.000Z");
  });
});

describe("GitHubApprovals", () => {
  it("reads role_name (maintain) or permission, treats 404 as none, and looks up PR heads", async () => {
    const request = vi.fn(async (route: string, params: Record<string, unknown>) => {
      if (route.includes("/permission")) {
        if (params.username === "ghost") throw Object.assign(new Error("Not Found"), { status: 404 });
        return { data: params.username === "m" ? { permission: "write", role_name: "maintain" } : { permission: "read" } };
      }
      return { data: { head: { sha: "h" }, base: { sha: "b" }, user: { login: "u" } } };
    });
    const gh = new GitHubApprovals(async () => ({ request }));
    const change = { provider: "github" as const, repoFullName: "a/b", headSha: "h", baseSha: "b", prNumber: 1, installationId: 9 };
    expect(await gh.permissionOf(change, "m")).toBe("maintain");
    expect(await gh.permissionOf(change, "r")).toBe("read");
    expect(await gh.permissionOf(change, "ghost")).toBe("none");
    expect(await gh.pullRequest(change, 1)).toEqual({ headSha: "h", baseSha: "b", author: "u" });
    expect(request).toHaveBeenCalledWith("GET /repos/{owner}/{repo}/collaborators/{username}/permission", { owner: "a", repo: "b", username: "m" });
  });
});
