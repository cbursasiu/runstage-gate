import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import type { RunRecord } from "@runstage-gate/core";
import {
  RunStore,
  aggregateFleet,
  buildFleetView,
  createHistoryServer,
  entitlementsFor,
  fleetStatus,
  providerLink,
  type FleetView,
  type HistoryAuthOptions,
} from "../src/index.ts";
import { parseNewRun } from "../src/validate.ts";

let seq = 0;
function run(over: Partial<RunRecord> = {}): RunRecord {
  seq += 1;
  return {
    id: `run-${seq}`,
    jobId: `job-${seq}`,
    repoFullName: "acme/app",
    prNumber: 1,
    headSha: "abcdef1234567",
    baseSha: "1234567",
    conclusion: "success",
    title: "3/3 checks passed",
    summary: "ok",
    checks: [],
    runnerId: "mac",
    approvedBy: null,
    createdAt: "2026-11-16T10:00:00.000Z",
    completedAt: "2026-11-16T10:00:05.000Z",
    ...over,
  };
}
const failed = (name: string, required = true) => ({
  name, kind: "script" as const, required, status: "failed" as const, reason: "x", exitCode: 1, durationMs: 1, output: "",
});

const free = entitlementsFor("free");
const plus = entitlementsFor("plus");

describe("fleet status mapping", () => {
  it("maps conclusions to red/green, with pending and neutral for anything else", () => {
    expect(fleetStatus({ conclusion: "success" })).toBe("passing");
    expect(fleetStatus({ conclusion: "failure" })).toBe("failing");
    expect(fleetStatus({ conclusion: "success", status: "in_progress" })).toBe("pending");
    expect(fleetStatus({ conclusion: "weird" as never })).toBe("neutral");
    const [row] = aggregateFleet([run({ conclusion: "failure" })]);
    expect(row).toMatchObject({ status: "failing", color: "red" });
    expect(aggregateFleet([run()])[0]).toMatchObject({ status: "passing", color: "green" });
  });

  it("keeps an approved override green and says who approved it", () => {
    const [row] = aggregateFleet([run({ conclusion: "success", approvedBy: "cbursasiu" })]);
    expect(row).toMatchObject({ status: "passing", color: "green", approvedBy: "cbursasiu" });
  });
});

describe("aggregateFleet", () => {
  it("returns the latest run per repo, newest activity first", () => {
    const rows = aggregateFleet([
      run({ id: "a1", repoFullName: "acme/a", completedAt: "2026-11-16T09:00:00.000Z", conclusion: "success" }),
      run({ id: "b1", repoFullName: "acme/b", completedAt: "2026-11-16T11:00:00.000Z", conclusion: "success" }),
      run({ id: "a2", repoFullName: "acme/a", completedAt: "2026-11-16T12:00:00.000Z", conclusion: "failure", checks: [failed("tests"), failed("lint", false)] }),
      run({ id: "a0", repoFullName: "acme/a", completedAt: "2026-11-16T08:00:00.000Z", conclusion: "success" }),
    ]);
    expect(rows.map((r) => [r.repo, r.runId, r.status])).toEqual([
      ["acme/a", "a2", "failing"],
      ["acme/b", "b1", "passing"],
    ]);
    expect(rows[0]).toMatchObject({ lastRunAt: "2026-11-16T12:00:00.000Z", runCount: 3, failingChecks: ["tests"] });
  });

  it("breaks timestamp ties by recording order, and falls back to createdAt", () => {
    const t = "2026-11-16T09:00:00.000Z";
    expect(aggregateFleet([run({ id: "x", completedAt: t }), run({ id: "y", completedAt: t })])[0]!.runId).toBe("y");
    expect(aggregateFleet([run({ id: "c", completedAt: "", createdAt: "2026-11-16T07:00:00.000Z" })])[0]!.lastRunAt).toBe(
      "2026-11-16T07:00:00.000Z",
    );
  });

  it("is empty with no runs", () => {
    expect(aggregateFleet([])).toEqual([]);
    expect(buildFleetView([], free)).toMatchObject({ repos: [], totalRepos: 0, hiddenRepos: 0, notice: null });
  });
});

describe("fleet links", () => {
  it("uses the recorded check URL", () => {
    const r = run({ provider: "github", externalCheckId: "77", checkUrl: "https://github.com/acme/app/runs/77" });
    expect(providerLink(r)).toEqual({ url: "https://github.com/acme/app/runs/77", kind: "github-check-run" });
    const g = run({ provider: "gitlab", checkUrl: "https://gitlab.com/grp/proj/-/merge_requests/3" });
    expect(providerLink(g)).toEqual({ url: "https://gitlab.com/grp/proj/-/merge_requests/3", kind: "gitlab-merge-request" });
  });

  it("derives the GitHub check run URL from the recorded check run id", () => {
    expect(providerLink(run({ externalCheckId: "4242" }))?.url).toBe("https://github.com/acme/app/runs/4242");
    expect(providerLink(run({ provider: "gitlab", externalCheckId: "4242" }))).toBeUndefined();
    expect(providerLink(run({ externalCheckId: "not-a-number" }))).toBeUndefined();
  });

  it("falls back to the history run detail page for older records", () => {
    const [row] = aggregateFleet([run({ id: "old/1" })]);
    expect(row!.link).toEqual({ url: "/runs/old%2F1", kind: "history-run" });
    expect(row!.detailUrl).toBe("/runs/old%2F1");
  });

  it("ignores unsafe recorded URLs", () => {
    expect(providerLink(run({ checkUrl: "javascript:alert(1)" }))).toBeUndefined();
    const bad = parseNewRun({ repoFullName: "a/b", headSha: "h", conclusion: "success", checkUrl: "javascript:alert(1)", provider: "bitbucket" });
    expect(bad.ok && "checkUrl" in bad.run).toBe(false);
    expect(bad.ok && "provider" in bad.run).toBe(false);
    const ok = parseNewRun({
      repoFullName: "a/b", headSha: "h", conclusion: "success", provider: "github", externalCheckId: "12", checkUrl: "https://github.com/a/b/runs/12",
    });
    expect(ok).toMatchObject({ ok: true, run: { provider: "github", externalCheckId: "12", checkUrl: "https://github.com/a/b/runs/12" } });
  });
});

describe("free / plus gate", () => {
  const runs = [
    run({ repoFullName: "acme/newer", createdAt: "2026-11-16T10:00:00.000Z", completedAt: "2026-11-16T12:00:00.000Z", conclusion: "failure" }),
    run({ repoFullName: "acme/first", createdAt: "2026-11-15T10:00:00.000Z", completedAt: "2026-11-15T10:00:05.000Z" }),
    run({ repoFullName: "acme/third", createdAt: "2026-11-16T11:00:00.000Z", completedAt: "2026-11-16T11:00:05.000Z" }),
  ];

  it("free shows exactly one repo: the first connected one", () => {
    const view = buildFleetView(runs, free);
    expect(view.repos.map((r) => r.repo)).toEqual(["acme/first"]);
    expect(view).toMatchObject({ plan: "free", maxRepos: 1, totalRepos: 3, hiddenRepos: 2 });
    expect(view.notice).toBe("2 more repos hidden. Upgrade to Plus to see every repo.");
  });

  it("free choice is stable when another repo gets newer runs", () => {
    const more = [...runs, run({ repoFullName: "acme/third", createdAt: "2026-11-17T00:00:00.000Z", completedAt: "2026-11-17T00:00:05.000Z" })];
    expect(buildFleetView(more, free).repos.map((r) => r.repo)).toEqual(["acme/first"]);
  });

  it("free ties on first-seen time go to repo name A-Z", () => {
    const t = { createdAt: "2026-11-16T10:00:00.000Z", completedAt: "2026-11-16T10:00:01.000Z" };
    const view = buildFleetView([run({ repoFullName: "z/z", ...t }), run({ repoFullName: "a/a", ...t })], free);
    expect(view.repos.map((r) => r.repo)).toEqual(["a/a"]);
    expect(view.notice).toBe("1 more repo hidden. Upgrade to Plus to see every repo.");
  });

  it("free with a single repo shows it and no notice", () => {
    const view = buildFleetView([runs[0]!], free);
    expect(view).toMatchObject({ totalRepos: 1, hiddenRepos: 0, notice: null });
  });

  it("plus shows every repo", () => {
    const view = buildFleetView(runs, plus);
    expect(view.repos.map((r) => r.repo)).toEqual(["acme/newer", "acme/third", "acme/first"]);
    expect(view).toMatchObject({ plan: "plus", maxRepos: null, hiddenRepos: 0, notice: null });
  });
});

const WRITE = "w-token-fleet";
const READ = "r-token-fleet";
const HTML = { accept: "text/html" };

async function listen(store: RunStore, auth: HistoryAuthOptions, plan: "free" | "plus") {
  const server = createHistoryServer(store, auth, { entitlements: entitlementsFor(plan) });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

function seed(): RunStore {
  const store = new RunStore();
  const base = { prNumber: 3, headSha: "abcdef1", baseSha: "1234567", title: "t", summary: "s", runnerId: "mac", approvedBy: null, jobId: "j" };
  store.add({ ...base, repoFullName: "acme/first", conclusion: "failure", checks: [failed("tests")], provider: "github", externalCheckId: "901", checkUrl: "https://github.com/acme/first/runs/901", createdAt: "2026-11-15T10:00:00.000Z", completedAt: "2026-11-15T10:00:05.000Z" });
  store.add({ ...base, repoFullName: "acme/second", conclusion: "success", checks: [], createdAt: "2026-11-16T10:00:00.000Z", completedAt: "2026-11-16T10:00:05.000Z" });
  store.add({ ...base, repoFullName: "secret-org/hidden-repo", conclusion: "success", checks: [], createdAt: "2026-11-16T11:00:00.000Z", completedAt: "2026-11-16T11:00:05.000Z" });
  return store;
}

describe("fleet routes", () => {
  it("requires auth for both the page and the API", async () => {
    const { server, url } = await listen(seed(), { writeToken: WRITE, readToken: READ }, "plus");
    try {
      const api = await fetch(`${url}/api/fleet`);
      expect(api.status).toBe(401);
      const page = await fetch(`${url}/fleet`, { headers: HTML, redirect: "manual" });
      expect(page.status).toBe(303);
      expect(page.headers.get("location")).toBe("/login?next=%2Ffleet");
      const wrong = await fetch(`${url}/api/fleet`, { headers: { authorization: "Bearer nope" } });
      expect(wrong.status).toBe(401);
      expect((await fetch(`${url}/api/fleet`, { headers: { authorization: `Bearer ${READ}` } })).status).toBe(200);
    } finally {
      server.close();
    }
  });

  it("accepts a browser session cookie", async () => {
    const { server, url } = await listen(seed(), { writeToken: WRITE, readToken: READ }, "free");
    try {
      const login = await fetch(`${url}/login`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: READ, next: "/fleet" }).toString(),
      });
      expect(login.status).toBe(303);
      expect(login.headers.get("location")).toBe("/fleet");
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      const page = await fetch(`${url}/fleet`, { headers: { ...HTML, cookie } });
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("Sign out");
    } finally {
      server.close();
    }
  });

  it("enforces the free plan in the JSON API without naming hidden repos", async () => {
    const { server, url } = await listen(seed(), { writeToken: WRITE, readToken: READ }, "free");
    try {
      const res = await fetch(`${url}/api/fleet`, { headers: { authorization: `Bearer ${READ}` } });
      expect(res.headers.get("content-type")).toContain("application/json");
      const raw = await res.text();
      expect(raw).not.toContain("hidden-repo");
      expect(raw).not.toContain("acme/second");
      const view = JSON.parse(raw) as FleetView;
      expect(view.repos).toHaveLength(1);
      expect(view.repos[0]).toMatchObject({
        repo: "acme/first",
        status: "failing",
        color: "red",
        lastRunAt: "2026-11-15T10:00:05.000Z",
        failingChecks: ["tests"],
        link: { url: "https://github.com/acme/first/runs/901", kind: "github-check-run" },
      });
      expect(view).toMatchObject({ plan: "free", totalRepos: 3, hiddenRepos: 2 });
    } finally {
      server.close();
    }
  });

  it("enforces the free plan in the page, with an upgrade notice and no payment link", async () => {
    const { server, url } = await listen(seed(), { writeToken: WRITE, readToken: READ }, "free");
    try {
      const res = await fetch(`${url}/fleet`, { headers: { ...HTML, authorization: `Bearer ${READ}` } });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
      const html = await res.text();
      expect(html).toContain('data-repo="acme/first"');
      expect(html).not.toContain("acme/second");
      expect(html).not.toContain("hidden-repo");
      expect(html).toContain("2 more repos hidden. Upgrade to Plus to see every repo.");
      expect(html).toContain('href="https://github.com/acme/first/runs/901"');
      expect(html).toContain("Failing: GitHub check run");
      expect(html).not.toMatch(/checkout|billing|stripe|pricing|\/upgrade/i);
    } finally {
      server.close();
    }
  });

  it("plus shows every repo in page and API, with history fallback links", async () => {
    const { server, url } = await listen(seed(), { writeToken: WRITE, readToken: READ }, "plus");
    try {
      const auth = { authorization: `Bearer ${READ}` };
      const view = (await (await fetch(`${url}/api/fleet`, { headers: auth })).json()) as FleetView;
      expect(view.repos.map((r) => r.repo)).toEqual(["secret-org/hidden-repo", "acme/second", "acme/first"]);
      expect(view.notice).toBeNull();
      const second = view.repos.find((r) => r.repo === "acme/second")!;
      expect(second.link.kind).toBe("history-run");
      expect(second.link.url).toBe(`/runs/${second.runId}`);
      const html = await (await fetch(`${url}/fleet`, { headers: { ...HTML, ...auth } })).text();
      for (const r of ["acme/first", "acme/second", "secret-org/hidden-repo"]) expect(html).toContain(`data-repo="${r}"`);
      expect(html).not.toContain("Upgrade to Plus");
      expect(html).toContain(`href="/runs/${second.runId}"`);
    } finally {
      server.close();
    }
  });

  it("defaults to the free plan when no entitlements are passed", async () => {
    const server = createHistoryServer(seed(), { writeToken: WRITE, readToken: READ });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const view = (await (await fetch(`${url}/api/fleet`, { headers: { authorization: `Bearer ${READ}` } })).json()) as FleetView;
      expect(view).toMatchObject({ plan: "free", hiddenRepos: 2 });
    } finally {
      server.close();
    }
  });

  it("escapes repo names and titles in the page", async () => {
    const store = new RunStore();
    store.add({
      jobId: "j", repoFullName: "acme/<b>x</b>", prNumber: null, headSha: "h", baseSha: "b", conclusion: "success",
      title: "<script>alert(1)</script>", summary: "", checks: [], runnerId: null, approvedBy: null,
      createdAt: "2026-11-16T10:00:00.000Z", completedAt: "2026-11-16T10:00:01.000Z",
    });
    const { server, url } = await listen(store, {}, "free");
    try {
      const html = await (await fetch(`${url}/fleet`, { headers: HTML })).text();
      expect(html).not.toContain("<script>alert(1)</script>");
      expect(html).not.toContain("<b>x</b>");
      expect(html).toContain("&lt;script&gt;");
    } finally {
      server.close();
    }
  });
});
