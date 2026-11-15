import { randomUUID } from "node:crypto";
import type { ChangeRef, GateJob, GateResult } from "@runstage-gate/core";

/** In-memory job queue. v1 only: jobs are lost on restart. */
export class JobQueue {
  private jobs = new Map<string, GateJob>();

  enqueue(change: ChangeRef, externalCheckId: string): GateJob {
    const job: GateJob = {
      id: randomUUID(),
      change,
      externalCheckId,
      status: "queued",
      createdAt: new Date().toISOString(),
    };
    this.jobs.set(job.id, job);
    return job;
  }

  /** A queued or running job for the same commit, used to de-duplicate check_suite + pull_request. */
  findActive(repoFullName: string, headSha: string): GateJob | undefined {
    for (const j of this.jobs.values()) {
      if (j.status !== "completed" && j.change.repoFullName === repoFullName && j.change.headSha === headSha) return j;
    }
    return undefined;
  }

  claimNext(runnerId: string): GateJob | undefined {
    for (const j of this.jobs.values()) {
      if (j.status === "queued") {
        j.status = "running";
        j.claimedAt = new Date().toISOString();
        j.runnerId = runnerId;
        return j;
      }
    }
    return undefined;
  }

  complete(id: string, result: GateResult): GateJob | undefined {
    const j = this.jobs.get(id);
    if (!j || j.status === "completed") return undefined;
    j.status = "completed";
    j.completedAt = new Date().toISOString();
    j.result = result;
    return j;
  }

  get(id: string): GateJob | undefined {
    return this.jobs.get(id);
  }

  list(): GateJob[] {
    return [...this.jobs.values()];
  }
}
