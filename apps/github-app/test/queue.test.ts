import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChangeRef, GateResult } from "@runstage-gate/core";
import { JobQueue } from "../src/index.ts";

const change = (headSha = "a".repeat(40), repoFullName = "acme/demo-app"): ChangeRef => ({
  provider: "github", repoFullName, headSha, baseSha: "0".repeat(40), prNumber: 1, installationId: 7,
});
const result: GateResult = { conclusion: "success", title: "ok", summary: "ok", checks: [] };
const tmpFile = () => join(mkdtempSync(join(tmpdir(), "rsg-queue-")), "queue.json");

describe("JobQueue", () => {
  it("survives an App restart: reopening the file keeps queued and claimed jobs", () => {
    const file = tmpFile();
    const q1 = JobQueue.file(file);
    const a = q1.enqueue(change("a".repeat(40)), "1");
    const b = q1.enqueue(change("b".repeat(40)), "2");
    expect(q1.claimNext("r1")?.id).toBe(a.id);

    const q2 = JobQueue.file(file); // "restart"
    expect(q2.get(a.id)).toMatchObject({ status: "claimed", runnerId: "r1", attempts: 1 });
    expect(q2.get(b.id)).toMatchObject({ status: "queued" });
    expect(q2.claimNext("r2")?.id).toBe(b.id);
    expect(q2.complete(a.id, "r1", result)).toMatchObject({ ok: true });
    expect(JobQueue.file(file).get(a.id)).toMatchObject({ status: "completed", result });
  });

  it("writes the file atomically with 0600 permissions and refuses to start on a corrupt file", () => {
    const file = tmpFile();
    JobQueue.file(file).enqueue(change(), "1");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ version: 1, jobs: [{ externalCheckId: "1" }] });
    writeFileSync(file, "{not json");
    expect(() => JobQueue.file(file)).toThrow(/not valid JSON/);
  });

  it("re-queues a job when the claim's lease expires, and heartbeats extend it", () => {
    let now = Date.parse("2026-11-15T10:00:00Z");
    const q = new JobQueue({ leaseMs: 60_000, now: () => now });
    const job = q.enqueue(change(), "1");
    q.claimNext("crashed-runner");
    now += 30_000;
    expect(q.heartbeat(job.id, "crashed-runner")).toMatchObject({ ok: true });
    now += 59_000; // still inside the extended lease
    expect(q.claimNext("r2")).toBeUndefined();
    now += 2_000; // lease ran out
    const reclaimed = q.claimNext("r2");
    expect(reclaimed).toMatchObject({ id: job.id, runnerId: "r2", attempts: 2 });
    // the crashed runner coming back late can no longer report
    expect(q.complete(job.id, "crashed-runner", result)).toEqual({ ok: false, reason: "claimed_by_other_runner", job: reclaimed });
    expect(q.complete(job.id, "r2", result)).toMatchObject({ ok: true });
  });

  it("re-queues an expired claim found after a restart", () => {
    const file = tmpFile();
    let now = Date.parse("2026-11-15T10:00:00Z");
    const job = JobQueue.file(file, { leaseMs: 1000, now: () => now }).enqueue(change(), "1");
    JobQueue.file(file, { leaseMs: 1000, now: () => now }).claimNext("r1");
    now += 5000;
    expect(JobQueue.file(file, { leaseMs: 1000, now: () => now }).claimNext("r2")).toMatchObject({ id: job.id, runnerId: "r2" });
  });

  it("only the claiming runner can complete, and only once", () => {
    const q = new JobQueue();
    const job = q.enqueue(change(), "1");
    expect(q.complete(job.id, "r1", result)).toMatchObject({ ok: false, reason: "not_claimed" });
    q.claimNext("r1");
    expect(q.complete(job.id, "r2", result)).toMatchObject({ ok: false, reason: "claimed_by_other_runner" });
    expect(q.complete(job.id, "r1", result)).toMatchObject({ ok: true });
    expect(q.complete(job.id, "r1", result)).toMatchObject({ ok: false, reason: "already_completed" });
    expect(q.complete("nope", "r1", result)).toEqual({ ok: false, reason: "not_found" });
  });

  it("is idempotent on (repo, head sha, check run) and remembers webhook deliveries", () => {
    const file = tmpFile();
    const q = JobQueue.file(file);
    const a = q.enqueue(change(), "1");
    expect(q.enqueue(change(), "1").id).toBe(a.id);
    expect(q.list()).toHaveLength(1);
    expect(q.markDelivery("d-1")).toBe(true);
    expect(q.markDelivery("d-1")).toBe(false);
    expect(JobQueue.file(file).hasDelivery("d-1")).toBe(true);
  });

  it("only hands a repo-scoped runner jobs for its repos", () => {
    const q = new JobQueue();
    q.enqueue(change("a".repeat(40), "acme/other"), "1");
    const mine = q.enqueue(change("b".repeat(40), "acme/demo-app"), "2");
    expect(q.claimNext("scoped", ["acme/demo-app"])?.id).toBe(mine.id);
    expect(q.claimNext("scoped", ["acme/demo-app"])).toBeUndefined();
  });
});
