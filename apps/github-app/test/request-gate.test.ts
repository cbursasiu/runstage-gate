import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ChangeRef, CheckProvider, GateResult } from "@runstage-gate/core";
import { GateService, JobQueue } from "../src/index.ts";
import type { CheckSuitePayload, PullRequestPayload } from "../src/handlers.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeProvider(startCheck: CheckProvider["startCheck"]): CheckProvider {
  return {
    name: "github",
    startCheck,
    completeCheck: async (_change: ChangeRef, _id: string, _result: GateResult) => {},
  };
}

describe("requestGate concurrent de-duplication", () => {
  it("concurrent check_suite and pull_request for the same commit create one check run and one job", async () => {
    const started = deferred<void>();
    const proceed = deferred<string>();
    let startCheckCalls = 0;
    const provider = fakeProvider(async () => {
      startCheckCalls += 1;
      started.resolve();
      return proceed.promise;
    });
    const queue = new JobQueue();
    const service = new GateService({ provider, queue });

    const suite = service.onCheckSuite(fixture("check_suite.requested") as CheckSuitePayload);
    const pr = service.onPullRequest(fixture("pull_request.opened") as PullRequestPayload);
    await started.promise;
    expect(startCheckCalls).toBe(1);

    proceed.resolve("check-1");
    const [fromSuite, fromPr] = await Promise.all([suite, pr]);

    expect(startCheckCalls).toBe(1);
    expect(fromSuite?.id).toBe(fromPr?.id);
    expect(fromSuite?.externalCheckId).toBe("check-1");
    expect(queue.list()).toHaveLength(1);
    expect(queue.list()[0]).toMatchObject({
      id: fromSuite!.id,
      status: "queued",
      externalCheckId: "check-1",
      change: { repoFullName: "acme/demo-app", headSha: "1".repeat(40), prNumber: 42 },
    });
  });

  it("clears the in-flight entry when startCheck fails so a later request can start a new check", async () => {
    let startCheckCalls = 0;
    const provider = fakeProvider(async () => {
      startCheckCalls += 1;
      if (startCheckCalls === 1) throw new Error("github down");
      return "check-2";
    });
    const queue = new JobQueue();
    const service = new GateService({ provider, queue });
    const payload = fixture("pull_request.opened") as PullRequestPayload;

    await expect(service.onPullRequest(payload)).rejects.toThrow("github down");
    expect(queue.list()).toHaveLength(0);

    const job = await service.onPullRequest(payload);
    expect(startCheckCalls).toBe(2);
    expect(job?.externalCheckId).toBe("check-2");
    expect(queue.list()).toHaveLength(1);
    expect(queue.list()[0]!.id).toBe(job!.id);
  });
});
