import { describe, expect, it } from "vitest";
import { poll } from "../src/index.ts";

const job = {
  id: "job-1",
  externalCheckId: "1",
  status: "claimed",
  createdAt: new Date().toISOString(),
  change: { provider: "github", repoFullName: "acme/x", headSha: "h", baseSha: "b", prNumber: 1 },
};
const ok = async () => ({ conclusion: "success" as const, title: "ok", summary: "ok", checks: [] });

describe("poll resilience", () => {
  it("keeps polling while the server is down (App restart) and recovers", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    let nextCalls = 0;
    const fetchImpl = (async (url: string) => {
      const path = new URL(url).pathname;
      calls.push(path);
      if (path.endsWith("/jobs/next")) {
        nextCalls++;
        if (nextCalls === 1) throw new TypeError("fetch failed");
        if (nextCalls === 2) return new Response("bad gateway", { status: 502 });
        if (nextCalls === 3) return new Response(JSON.stringify(job), { status: 200 });
        controller.abort();
        return new Response(null, { status: 204 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const logs: string[] = [];
    const n = await poll({
      server: "http://x", token: "t", repos: "/repo", intervalMs: 1, backoffMs: () => 1,
      fetchImpl, runGateImpl: ok, log: (l) => logs.push(l), signal: controller.signal,
    });
    expect(n).toBe(1);
    expect(calls.filter((c) => c.endsWith("/result"))).toHaveLength(1);
    const text = logs.join("\n");
    expect(text).toContain("server unreachable: fetch failed");
    expect(text).toContain("server error 502");
    expect(text).toContain("server reachable again after 2 failed attempt(s)");
  });

  it("passes increasing attempt numbers to the backoff", async () => {
    const controller = new AbortController();
    const attempts: number[] = [];
    let n = 0;
    const fetchImpl = (async () => {
      if (++n > 4) controller.abort();
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await poll({
      server: "http://x", token: "t", repos: "/repo", fetchImpl, log: () => {}, signal: controller.signal,
      backoffMs: (a) => { attempts.push(a); return 1; },
    });
    expect(attempts.slice(0, 4)).toEqual([1, 2, 3, 4]);
  });

  it("still fails fast in --once mode and on a rejected token", async () => {
    const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    await expect(poll({ server: "http://x", token: "t", repos: "/repo", once: true, fetchImpl: down, log: () => {} }))
      .rejects.toThrow(/server unreachable/);
    const unauthorized = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    await expect(poll({ server: "http://x", token: "t", repos: "/repo", fetchImpl: unauthorized, log: () => {} }))
      .rejects.toThrow(/runner token/);
  });

  it("retries posting a result through transient failures", async () => {
    let posts = 0;
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/jobs/next")) return new Response(JSON.stringify(job), { status: 200 });
      if (url.endsWith("/result")) {
        posts++;
        if (posts === 1) throw new TypeError("fetch failed");
        if (posts === 2) return new Response("unavailable", { status: 503 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const logs: string[] = [];
    const n = await poll({ server: "http://x", token: "t", repos: "/repo", once: true, backoffMs: () => 1, fetchImpl, runGateImpl: ok, log: (l) => logs.push(l) });
    expect(n).toBe(1);
    expect(posts).toBe(3);
    expect(logs.join("\n")).toContain("posting result: server unreachable");
  });

  it("gives up on a result after the configured attempts without crashing", async () => {
    let posts = 0;
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/jobs/next")) return new Response(JSON.stringify(job), { status: 200 });
      if (url.endsWith("/result")) { posts++; throw new TypeError("fetch failed"); }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const logs: string[] = [];
    const n = await poll({ server: "http://x", token: "t", repos: "/repo", once: true, backoffMs: () => 1, resultAttempts: 3, fetchImpl, runGateImpl: ok, log: (l) => logs.push(l) });
    expect(n).toBe(1);
    expect(posts).toBe(3);
    expect(logs.join("\n")).toContain("will be re-queued");
  });
});
