import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { ChangeRef, GateJob, GateResult } from "@runstage-gate/core";
import { writeJsonAtomic } from "./fsutil.ts";

/** Why completing or heartbeating a job was refused. */
export type JobRefusal = "not_found" | "already_completed" | "not_claimed" | "claimed_by_other_runner";
export type JobOutcome = { ok: true; job: GateJob } | { ok: false; reason: JobRefusal; job?: GateJob };

/** What the App needs from a job queue. Storage is pluggable (see QueueStorage). */
export interface JobStore {
  /** Idempotent on (repo, head sha, check id): a repeat returns the existing job. */
  enqueue(change: ChangeRef, externalCheckId: string): GateJob;
  /** A queued or claimed job for the same commit, used to de-duplicate check_suite + pull_request. */
  findActive(repoFullName: string, headSha: string): GateJob | undefined;
  /** Hand the oldest queued job (optionally only for `repos`) to `runnerId` under a lease. */
  claimNext(runnerId: string, repos?: readonly string[] | null): GateJob | undefined;
  /** Extend the lease. Only the runner holding the claim may do this. */
  heartbeat(id: string, runnerId: string): JobOutcome;
  /** Store the result. Only the runner holding the claim may do this. */
  complete(id: string, runnerId: string, result: GateResult): JobOutcome;
  /** Record the outcome of reporting a completed job's result to the provider. */
  setReportState(id: string, state: { ok: boolean; error?: string; giveUp?: boolean }): GateJob | undefined;
  /** Completed jobs whose final provider update is still owed. */
  pendingReports(): GateJob[];
  /** Remember a webhook delivery id; returns false if it was already seen. */
  markDelivery(deliveryId: string): boolean;
  hasDelivery(deliveryId: string): boolean;
  get(id: string): GateJob | undefined;
  list(): GateJob[];
}

/** Serialized queue state. */
export interface QueueState {
  version: 1;
  jobs: GateJob[];
  deliveries: string[];
}

/** Where the queue state lives. Swap this for a database-backed store later. */
export interface QueueStorage {
  load(): QueueState | undefined;
  save(state: QueueState): void;
}

export class MemoryStorage implements QueueStorage {
  private state?: QueueState;
  load() {
    return this.state ? structuredClone(this.state) : undefined;
  }
  save(state: QueueState) {
    this.state = structuredClone(state);
  }
}

/**
 * The whole queue in one JSON file, rewritten atomically (temp file + fsync + rename) on every
 * change. Zero dependencies and works on Node 20. Assumes one App process owns the file.
 */
export class JsonFileStorage implements QueueStorage {
  constructor(readonly file: string) {}
  load(): QueueState | undefined {
    if (!existsSync(this.file)) return undefined;
    let raw: QueueState;
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8")) as QueueState;
    } catch (err) {
      // Never silently start empty: that would drop queued jobs.
      throw new Error(`queue file ${this.file} is not valid JSON: ${(err as Error).message}`);
    }
    if (raw.version !== 1 || !Array.isArray(raw.jobs)) throw new Error(`queue file ${this.file} has an unknown format`);
    return { version: 1, jobs: raw.jobs, deliveries: raw.deliveries ?? [] };
  }
  save(state: QueueState): void {
    writeJsonAtomic(this.file, state);
  }
}

export interface JobQueueOptions {
  storage?: QueueStorage;
  /** How long a claim lasts without a heartbeat before the job is re-queued. Default 15 min. */
  leaseMs?: number;
  /** Completed jobs kept for inspection. Default 500. */
  keepCompleted?: number;
  /** Webhook delivery ids remembered for de-duplication. Default 2000. */
  keepDeliveries?: number;
  now?: () => number;
}

export const DEFAULT_LEASE_MS = 15 * 60 * 1000;

/** Job queue with leases. In memory by default; pass `storage` to make it durable. */
export class JobQueue implements JobStore {
  private jobs: GateJob[];
  private deliveries: string[];
  private readonly storage: QueueStorage;
  private readonly leaseMs: number;
  private readonly keepCompleted: number;
  private readonly keepDeliveries: number;
  private readonly now: () => number;

  constructor(opts: JobQueueOptions = {}) {
    this.storage = opts.storage ?? new MemoryStorage();
    this.leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
    this.keepCompleted = opts.keepCompleted ?? 500;
    this.keepDeliveries = opts.keepDeliveries ?? 2000;
    this.now = opts.now ?? Date.now;
    const state = this.storage.load();
    this.jobs = state?.jobs ?? [];
    this.deliveries = state?.deliveries ?? [];
  }

  /** Convenience: a durable queue backed by a JSON file. */
  static file(file: string, opts: Omit<JobQueueOptions, "storage"> = {}): JobQueue {
    return new JobQueue({ ...opts, storage: new JsonFileStorage(file) });
  }

  enqueue(change: ChangeRef, externalCheckId: string): GateJob {
    const existing = this.jobs.find(
      (j) => j.change.repoFullName === change.repoFullName && j.change.headSha === change.headSha && j.externalCheckId === externalCheckId,
    );
    if (existing) return existing;
    const job: GateJob = { id: randomUUID(), change, externalCheckId, status: "queued", createdAt: this.iso(), attempts: 0 };
    this.jobs.push(job);
    this.persist();
    return job;
  }

  findActive(repoFullName: string, headSha: string): GateJob | undefined {
    this.requeueExpired();
    return this.jobs.find((j) => j.status !== "completed" && j.change.repoFullName === repoFullName && j.change.headSha === headSha);
  }

  claimNext(runnerId: string, repos?: readonly string[] | null): GateJob | undefined {
    this.requeueExpired();
    const job = this.jobs.find((j) => j.status === "queued" && (!repos || repos.includes(j.change.repoFullName)));
    if (!job) return undefined;
    job.status = "claimed";
    job.runnerId = runnerId;
    job.claimedAt = this.iso();
    job.leaseExpiresAt = this.iso(this.now() + this.leaseMs);
    job.attempts = (job.attempts ?? 0) + 1;
    this.persist();
    return job;
  }

  heartbeat(id: string, runnerId: string): JobOutcome {
    const check = this.checkClaim(id, runnerId);
    if (!check.ok) return check;
    check.job.leaseExpiresAt = this.iso(this.now() + this.leaseMs);
    this.persist();
    return check;
  }

  complete(id: string, runnerId: string, result: GateResult): JobOutcome {
    const check = this.checkClaim(id, runnerId);
    if (!check.ok) return check;
    const job = check.job;
    job.status = "completed";
    job.completedAt = this.iso();
    job.result = result;
    delete job.leaseExpiresAt;
    this.pruneCompleted();
    this.persist();
    return { ok: true, job };
  }

  setReportState(id: string, state: { ok: boolean; error?: string; giveUp?: boolean }): GateJob | undefined {
    const job = this.jobs.find((j) => j.id === id);
    if (!job || job.status !== "completed") return undefined;
    if (state.ok) {
      job.reportedAt = this.iso();
      delete job.reportPending;
      delete job.reportError;
    } else {
      job.reportAttempts = (job.reportAttempts ?? 0) + 1;
      job.reportError = (state.error ?? "unknown error").slice(0, 500);
      if (state.giveUp) delete job.reportPending;
      else job.reportPending = true;
    }
    this.persist();
    return job;
  }

  pendingReports(): GateJob[] {
    return this.jobs.filter((j) => j.status === "completed" && j.reportPending);
  }

  markDelivery(deliveryId: string): boolean {
    if (this.deliveries.includes(deliveryId)) return false;
    this.deliveries.push(deliveryId);
    if (this.deliveries.length > this.keepDeliveries) this.deliveries.splice(0, this.deliveries.length - this.keepDeliveries);
    this.persist();
    return true;
  }

  hasDelivery(deliveryId: string): boolean {
    return this.deliveries.includes(deliveryId);
  }

  get(id: string): GateJob | undefined {
    this.requeueExpired();
    return this.jobs.find((j) => j.id === id);
  }

  list(): GateJob[] {
    this.requeueExpired();
    return [...this.jobs];
  }

  private checkClaim(id: string, runnerId: string): JobOutcome {
    this.requeueExpired();
    const job = this.jobs.find((j) => j.id === id);
    if (!job) return { ok: false, reason: "not_found" };
    if (job.status === "completed") return { ok: false, reason: "already_completed", job };
    if (job.status !== "claimed") return { ok: false, reason: "not_claimed", job };
    if (job.runnerId !== runnerId) return { ok: false, reason: "claimed_by_other_runner", job };
    return { ok: true, job };
  }

  /** A claim whose lease ran out (runner crashed or went offline) goes back to the queue. */
  private requeueExpired(): void {
    const now = this.now();
    let changed = false;
    for (const j of this.jobs) {
      if (j.status === "claimed" && j.leaseExpiresAt && Date.parse(j.leaseExpiresAt) <= now) {
        j.status = "queued";
        delete j.runnerId;
        delete j.claimedAt;
        delete j.leaseExpiresAt;
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  private pruneCompleted(): void {
    // Jobs still owing a provider update are never pruned.
    const completed = this.jobs.filter((j) => j.status === "completed" && !j.reportPending);
    const drop = new Set(completed.slice(0, Math.max(0, completed.length - this.keepCompleted)));
    if (drop.size) this.jobs = this.jobs.filter((j) => !drop.has(j));
  }

  private persist(): void {
    this.storage.save({ version: 1, jobs: this.jobs, deliveries: this.deliveries });
  }

  private iso(ms = this.now()): string {
    return new Date(ms).toISOString();
  }
}
