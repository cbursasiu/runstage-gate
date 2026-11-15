import { describe, expect, it } from "vitest";
import { poll } from "../src/index.ts";

const job = {
  id: "job-1",
  externalCheckId: "1",
  status: "claimed",
  createdAt: new Date().toISOString(),
  change: { provider: "github", repoFullName: "acme/x", headSha: "h", baseSha: "b", prNumber: 1 },
};

describe("poll", () => {
  it("does not crash when the server refuses a result because the lease moved to another runner", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(new URL(url).pathname);
      if (url.endsWith("/jobs/next")) return new Response(JSON.stringify(job), { status: 200 });
      return new Response(JSON.stringify({ error: "job is claimed by another runner" }), { status: 403 });
    }) as typeof fetch;
    const logs: string[] = [];
    // repo map without this repo -> runner posts an error result immediately
    const n = await poll({ server: "http://x", token: "t", repos: {}, once: true, fetchImpl, log: (l) => logs.push(l) });
    expect(n).toBe(1);
    expect(calls).toEqual(["/api/runner/jobs/next", "/api/runner/jobs/job-1/result"]);
    expect(logs.join("\n")).toContain("server refused the result (403)");
  });

  it("sends heartbeats while a job runs and stops after posting the result", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(new URL(url).pathname);
      if (url.endsWith("/jobs/next")) return new Response(JSON.stringify(job), { status: 200 });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const runGateImpl = async () => {
      await new Promise((r) => setTimeout(r, 80));
      return { conclusion: "success" as const, title: "ok", summary: "ok", checks: [] };
    };
    await poll({ server: "http://x", token: "t", repos: "/repo", once: true, heartbeatMs: 20, fetchImpl, runGateImpl, log: () => {} });
    const beats = calls.filter((c) => c.endsWith("/heartbeat")).length;
    expect(beats).toBeGreaterThanOrEqual(2);
    expect(calls.at(-1)).toBe("/api/runner/jobs/job-1/result");
    await new Promise((r) => setTimeout(r, 60));
    expect(calls.filter((c) => c.endsWith("/heartbeat")).length).toBe(beats);
  });
});
