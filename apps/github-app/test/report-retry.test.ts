import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ChangeRef, CheckProvider, GateResult } from "@runstage-gate/core";
import { GateService, JobQueue, loadRunnerRegistry, mintRunnerToken } from "../src/index.ts";

const change: ChangeRef = { provider: "github", repoFullName: "acme/demo-app", headSha: "a".repeat(40), baseSha: "b".repeat(40), prNumber: 7, installationId: 1 };
const result: GateResult = { conclusion: "success", title: "1/1 checks passed", summary: "ok", checks: [] };

function setup(failures: number, opts: { maxReportAttempts?: number } = {}) {
  let calls = 0;
  const completeCheck = vi.fn(async () => {
    calls += 1;
    if (calls <= failures) throw new Error(`github 502 (#${calls})`);
  });
  const provider: CheckProvider = { name: "github", startCheck: async () => "check-1", completeCheck };
  const queue = new JobQueue();
  const sleeps: number[] = [];
  const history = { record: vi.fn(async () => {}) };
  const logs: string[] = [];
  const service = new GateService({
    provider,
    queue,
    history,
    reportRetryDelaysMs: [10, 20],
    sleep: async (ms) => void sleeps.push(ms),
    log: (l) => logs.push(l),
    ...opts,
  });
  const job = queue.enqueue(change, "check-1");
  queue.claimNext("runner-1");
  return { service, queue, job, completeCheck, sleeps, history, logs };
}

describe("reporting the final check result", () => {
  it("retries the check update with backoff and succeeds inline", async () => {
    const { service, queue, job, completeCheck, sleeps } = setup(2);
    const outcome = await service.completeJob(job.id, "runner-1", result);
    expect(outcome.ok).toBe(true);
    expect(completeCheck).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([10, 20]);
    const stored = queue.get(job.id)!;
    expect(stored.status).toBe("completed");
    expect(stored.reportPending).toBeUndefined();
    expect(stored.reportedAt).toBeTruthy();
  });

  it("keeps the result and marks the report pending when GitHub keeps failing, then a background retry completes the check", async () => {
    const { service, queue, job, completeCheck, history, logs } = setup(4);
    const outcome = await service.completeJob(job.id, "runner-1", result);
    // The runner's result is accepted (not a 500), stored, and recorded in history.
    expect(outcome.ok).toBe(true);
    expect(completeCheck).toHaveBeenCalledTimes(3);
    expect(history.record).toHaveBeenCalledTimes(1);
    const pending = queue.get(job.id)!;
    expect(pending).toMatchObject({ status: "completed", reportPending: true, reportAttempts: 3, reportError: "github 502 (#3)" });
    expect(pending.result).toEqual(result);
    expect(queue.pendingReports().map((j) => j.id)).toEqual([job.id]);
    expect(logs.some((l) => l.includes("check update pending retry"))).toBe(true);

    // A second post of the same result is still refused (no double completion).
    expect((await service.completeJob(job.id, "runner-1", result)).ok).toBe(false);

    expect(await service.retryPendingReports()).toBe(0); // 4th failure
    expect(queue.get(job.id)!.reportAttempts).toBe(4);
    expect(await service.retryPendingReports()).toBe(1); // 5th call succeeds
    expect(completeCheck).toHaveBeenCalledTimes(5);
    expect(completeCheck).toHaveBeenLastCalledWith(change, "check-1", result);
    expect(queue.pendingReports()).toHaveLength(0);
    expect(queue.get(job.id)!.reportedAt).toBeTruthy();
  });

  it("gives up after maxReportAttempts and logs it", async () => {
    const { service, queue, job, completeCheck, logs } = setup(100, { maxReportAttempts: 2 });
    await service.completeJob(job.id, "runner-1", result);
    expect(completeCheck).toHaveBeenCalledTimes(2);
    expect(queue.pendingReports()).toHaveLength(0);
    expect(queue.get(job.id)!.reportAttempts).toBe(2);
    expect(logs.some((l) => l.includes("giving up after 2 attempts"))).toBe(true);
    expect(await service.retryPendingReports()).toBe(0);
    expect(completeCheck).toHaveBeenCalledTimes(2);
  });

  it("never prunes completed jobs that still owe a report", () => {
    const queue = new JobQueue({ keepCompleted: 1 });
    const finish = (sha: string, check: string) => {
      const j = queue.enqueue({ ...change, headSha: sha.repeat(40) }, check);
      queue.claimNext("r");
      queue.complete(j.id, "r", result);
      return j;
    };
    const owed = finish("c", "check-10");
    queue.setReportState(owed.id, { ok: false, error: "github down" });
    const b = finish("d", "check-11");
    finish("e", "check-12"); // prunes b (oldest reported/unflagged job), never the owed one
    expect(queue.get(owed.id)?.reportPending).toBe(true);
    expect(queue.get(b.id)).toBeUndefined();
  });
});

describe("runner registry loading (legacy shared token removed)", () => {
  it("requires the runners file even when RUNSTAGE_RUNNER_TOKEN is set", () => {
    const dir = mkdtempSync(join(tmpdir(), "rsg-reg-"));
    const prev = process.env.RUNSTAGE_RUNNER_TOKEN;
    process.env.RUNSTAGE_RUNNER_TOKEN = "shared-old-token";
    try {
      expect(() => loadRunnerRegistry(join(dir, "missing.json"))).toThrow(/no runners registered: .*missing\.json not found.*no longer accepts a shared RUNSTAGE_RUNNER_TOKEN/);
    } finally {
      if (prev === undefined) delete process.env.RUNSTAGE_RUNNER_TOKEN;
      else process.env.RUNSTAGE_RUNNER_TOKEN = prev;
    }
  });

  it("rejects an empty runners file and loads a minted one", () => {
    const dir = mkdtempSync(join(tmpdir(), "rsg-reg-"));
    const empty = join(dir, "empty.json");
    writeFileSync(empty, JSON.stringify({ version: 1, runners: [] }));
    expect(() => loadRunnerRegistry(empty)).toThrow(/no runners registered in/);
    const file = join(dir, "runners.json");
    const token = mintRunnerToken(file, "mac");
    expect(loadRunnerRegistry(file).authenticate(token)?.id).toBe("mac");
    expect(loadRunnerRegistry(file).authenticate("shared-old-token")).toBeUndefined();
  });
});
