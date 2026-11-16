import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import type { CheckResult, RunRecord } from "@runstage-gate/core";
import { RunStore, createHistoryServer, MAX_DIFF_CHARS, MAX_BODY_BYTES } from "../src/index.ts";
import { escapeHtml, wantsHtml } from "../src/html.ts";

const HTML = { accept: "text/html" };

function sampleCheck(over: Partial<CheckResult> = {}): CheckResult {
  return {
    name: "no-todo-in-diff",
    kind: "script",
    required: true,
    status: "failed",
    reason: "new leftover markers",
    exitCode: 1,
    durationMs: 120,
    output: "README.md:3: leftover marker",
    ...over,
  };
}

function sampleRun(over: Partial<RunRecord> = {}): Omit<RunRecord, "id"> {
  return {
    jobId: "job-1",
    repoFullName: "acme/demo-app",
    prNumber: 42,
    headSha: "abcdef1",
    baseSha: "1234567",
    conclusion: "failure",
    title: "1 required check failed: no-todo-in-diff",
    summary: "Gate blocked",
    checks: [sampleCheck()],
    runnerId: "mac-dev",
    approvedBy: null,
    createdAt: "2026-11-16T02:00:00.000Z",
    completedAt: "2026-11-16T02:00:05.000Z",
    ...over,
  };
}

async function listen(store = new RunStore(), token?: string) {
  const server = createHistoryServer(store, token);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, url };
}

describe("history stub", () => {
  it("stores runs and lists them newest first via GET /runs", async () => {
    const { server, url } = await listen(new RunStore(), "hist-token");
    try {
      const post = (body: object, token = "hist-token") =>
        fetch(`${url}/runs`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
      const run = { repoFullName: "acme/demo-app", prNumber: 42, headSha: "abc", baseSha: "def", conclusion: "failure", checks: [] };
      expect((await post(run, "nope")).status).toBe(401);
      expect((await post(run)).status).toBe(201);
      expect((await post({ ...run, prNumber: 43, conclusion: "success" })).status).toBe(201);

      // Reads fail closed once a token is configured.
      expect((await fetch(`${url}/runs`)).status).toBe(401);
      const auth = { headers: { authorization: "Bearer hist-token" } };
      const all = (await (await fetch(`${url}/runs`, auth)).json()) as Array<{ prNumber: number }>;
      expect(all.map((r) => r.prNumber)).toEqual([43, 42]);
      const one = (await (await fetch(`${url}/runs?pr=42`, auth)).json()) as Array<{ id: string }>;
      expect(one).toHaveLength(1);
      expect((await fetch(`${url}/runs/${one[0]!.id}`, auth)).status).toBe(200);
    } finally {
      server.close();
    }
  });
});

describe("history JSON API", () => {
  it("keeps GET /runs and GET /runs/:id as JSON, with /api aliases", async () => {
    const store = new RunStore();
    const saved = store.add(sampleRun());
    const { server, url } = await listen(store);
    try {
      const list = await fetch(`${url}/runs`);
      expect(list.headers.get("content-type")).toBe("application/json");
      const listed = (await list.json()) as RunRecord[];
      expect(listed).toHaveLength(1);
      expect(listed[0]!.id).toBe(saved.id);

      const alias = await fetch(`${url}/api/runs`);
      expect(alias.headers.get("content-type")).toBe("application/json");
      expect(await alias.json()).toEqual(listed);

      const one = await fetch(`${url}/runs/${saved.id}`);
      expect(one.headers.get("content-type")).toBe("application/json");
      expect(await one.json()).toEqual(saved);

      const oneAlias = await fetch(`${url}/api/runs/${saved.id}`, { headers: HTML });
      expect(oneAlias.headers.get("content-type")).toBe("application/json");
      expect(await oneAlias.json()).toEqual(saved);

      const filtered = (await (await fetch(`${url}/runs?repo=acme/demo-app&verdict=failure`)).json()) as RunRecord[];
      expect(filtered).toHaveLength(1);
      expect((await (await fetch(`${url}/runs?verdict=success`)).json()) as unknown[]).toHaveLength(0);
    } finally {
      server.close();
    }
  });

  it("returns JSON 404 for an unknown run and truncates an oversized diff", async () => {
    const store = new RunStore();
    const saved = store.add(sampleRun({ diff: `${"a".repeat(MAX_DIFF_CHARS + 50)}` }));
    expect(saved.diff?.endsWith("…(truncated)")).toBe(true);
    expect(saved.diff!.length).toBe(MAX_DIFF_CHARS + "\n…(truncated)".length);

    const { server, url } = await listen(store);
    try {
      const missing = await fetch(`${url}/runs/does-not-exist`);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ error: "not found" });
    } finally {
      server.close();
    }
  });
});

describe("history HTML UI", () => {
  it("renders the run list with links, badges, duration and query filters", async () => {
    const store = new RunStore();
    const failed = store.add(sampleRun());
    store.add(
      sampleRun({
        jobId: "job-2",
        prNumber: 7,
        conclusion: "success",
        title: "1/1 checks passed",
        checks: [sampleCheck({ status: "passed", reason: "clean", exitCode: 0, output: "" })],
        runnerId: "mac-dev",
        createdAt: "2026-11-16T03:00:00.000Z",
        completedAt: "2026-11-16T03:00:02.500Z",
      }),
    );
    const { server, url } = await listen(store);
    try {
      const res = await fetch(`${url}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      const html = await res.text();
      expect(html).toContain("RunStage Gate");
      expect(html).toContain("acme/demo-app");
      expect(html).toContain("https://github.com/acme/demo-app/pull/42");
      expect(html).toContain("https://github.com/acme/demo-app/commit/abcdef1");
      expect(html).toContain("/runs/" + failed.id);
      expect(html).toContain("1 required check failed: no-todo-in-diff");
      expect(html).toContain("1/1 checks passed");
      expect(html).toContain("mac-dev");
      expect(html).toContain("5.0s");
      expect(html).toContain("2.5s");
      // newest first: success (03:00) before failure (02:00)
      expect(html.indexOf("1/1 checks passed")).toBeLessThan(html.indexOf("1 required check failed"));

      const onlyFail = await (await fetch(`${url}/?repo=acme/demo-app&verdict=failure`)).text();
      expect(onlyFail).toContain("1 required check failed");
      expect(onlyFail).not.toContain("1/1 checks passed");
      expect(onlyFail).toContain('value="acme/demo-app"');
    } finally {
      server.close();
    }
  });

  it("renders a run detail page with checks, failing output and GitHub diff links", async () => {
    const store = new RunStore();
    const run = store.add(sampleRun({ diff: "diff --git a/README.md b/README.md\n+leftover" }));
    const { server, url } = await listen(store);
    try {
      const res = await fetch(`${url}/runs/${run.id}`, { headers: HTML });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      const html = await res.text();
      expect(html).toContain("acme/demo-app");
      expect(html).toContain("https://github.com/acme/demo-app/pull/42");
      expect(html).toContain("https://github.com/acme/demo-app/commit/abcdef1");
      expect(html).toContain("https://github.com/acme/demo-app/commit/1234567");
      expect(html).toContain("https://github.com/acme/demo-app/compare/1234567...abcdef1");
      expect(html).toContain("https://github.com/acme/demo-app/pull/42/files");
      expect(html).toContain("no-todo-in-diff");
      expect(html).toContain("script");
      expect(html).toContain("yes");
      expect(html).toContain("new leftover markers");
      expect(html).toContain("120ms");
      expect(html).toContain("README.md:3: leftover marker");
      expect(html).toContain("diff --git a/README.md b/README.md");
      expect(html).toContain("mac-dev");
      expect(html).toContain("/api/runs/" + run.id);
    } finally {
      server.close();
    }
  });

  it("escapes untrusted run data on list and detail pages", async () => {
    const xss = `<script>alert(1)</script>`;
    const store = new RunStore();
    const run = store.add(
      sampleRun({
        repoFullName: "acme/demo-app",
        title: xss,
        runnerId: xss,
        approvedBy: xss,
        summary: xss,
        diff: `</pre>${xss}`,
        checks: [
          sampleCheck({
            name: xss,
            reason: xss,
            output: `</pre>${xss}`,
          }),
        ],
      }),
    );
    const { server, url } = await listen(store);
    try {
      const list = await (await fetch(`${url}/`)).text();
      expect(list).toContain(escapeHtml(xss));
      expect(list).not.toContain(xss);

      const detail = await (await fetch(`${url}/runs/${run.id}`, { headers: HTML })).text();
      expect(detail).toContain(escapeHtml(xss));
      expect(detail).toContain(escapeHtml(`</pre>${xss}`));
      expect(detail).not.toContain(xss);
      expect(detail).not.toContain("</pre><script>");
    } finally {
      server.close();
    }
  });

  it("returns an HTML 404 for an unknown run when the client prefers HTML", async () => {
    const { server, url } = await listen();
    try {
      const res = await fetch(`${url}/runs/missing`, { headers: HTML });
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      expect(await res.text()).toContain("Run not found");
    } finally {
      server.close();
    }
  });
});

describe("history hardening (PR #7 review)", () => {
  it("does not crash on malformed percent-encoding in a run id", async () => {
    const { server, url } = await listen();
    try {
      const bad = await fetch(`${url}/runs/%E0%A4%A`);
      expect(bad.status).toBe(404);
      const badHtml = await fetch(`${url}/runs/%`, { headers: HTML });
      expect(badHtml.status).toBe(404);
      // still alive
      expect((await fetch(`${url}/runs`)).status).toBe(200);
    } finally {
      server.close();
    }
  });

  it("ignores a client-supplied id and drops unknown fields", async () => {
    const store = new RunStore();
    const { server, url } = await listen(store);
    try {
      const res = await fetch(`${url}/runs`, {
        method: "POST",
        body: JSON.stringify({ ...sampleRun(), id: "chosen-id", extra: "x" }),
      });
      expect(res.status).toBe(201);
      const saved = (await res.json()) as RunRecord & { extra?: string };
      expect(saved.id).not.toBe("chosen-id");
      expect(saved.extra).toBeUndefined();
      expect(store.get("chosen-id")).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it("rejects malformed run bodies instead of storing records that break the UI", async () => {
    const { server, url } = await listen();
    try {
      const post = (body: unknown) => fetch(`${url}/runs`, { method: "POST", body: JSON.stringify(body) });
      expect((await post([])).status).toBe(400);
      expect((await post({ ...sampleRun(), conclusion: "maybe" })).status).toBe(400);
      expect((await post({ ...sampleRun(), checks: "nope" })).status).toBe(400);
      expect((await post({ ...sampleRun(), checks: [{ name: "x", status: "weird" }] })).status).toBe(400);
      expect((await post({ ...sampleRun(), prNumber: "42" })).status).toBe(400);
      const ok = await post({ repoFullName: "acme/x", headSha: "abc", conclusion: "success" });
      expect(ok.status).toBe(201);
      const saved = (await ok.json()) as RunRecord;
      expect(saved.checks).toEqual([]);
      const page = await fetch(`${url}/runs/${saved.id}`, { headers: HTML });
      expect(page.status).toBe(200);
    } finally {
      server.close();
    }
  });

  it("refuses oversized POST bodies with 413", async () => {
    const { server, url } = await listen();
    try {
      const res = await fetch(`${url}/runs`, {
        method: "POST",
        body: JSON.stringify({ ...sampleRun(), summary: "x".repeat(MAX_BODY_BYTES + 10) }),
      });
      expect(res.status).toBe(413);
    } finally {
      server.close();
    }
  });

  it("sends a strict CSP and nosniff on HTML pages, and Vary: Accept on negotiated routes", async () => {
    const store = new RunStore();
    const run = store.add(sampleRun());
    const { server, url } = await listen(store);
    try {
      const page = await fetch(`${url}/`);
      expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(page.headers.get("x-content-type-options")).toBe("nosniff");
      expect(page.headers.get("x-frame-options")).toBe("DENY");
      const detail = await fetch(`${url}/runs/${run.id}`, { headers: HTML });
      expect(detail.headers.get("vary")).toBe("Accept");
    } finally {
      server.close();
    }
  });

  it("negotiates HTML only when text/html is explicitly preferred", () => {
    expect(wantsHtml(undefined)).toBe(false);
    expect(wantsHtml("*/*")).toBe(false);
    expect(wantsHtml("application/json")).toBe(false);
    expect(wantsHtml("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")).toBe(true);
    expect(wantsHtml("text/html;q=0")).toBe(false);
    expect(wantsHtml("application/json, text/html;q=0.5")).toBe(false);
    expect(wantsHtml("text/html, application/json;q=0.9")).toBe(true);
    expect(wantsHtml("text/htmlx")).toBe(false);
  });

  it("treats a non-numeric pr filter as matching nothing", async () => {
    const store = new RunStore();
    store.add(sampleRun());
    const { server, url } = await listen(store);
    try {
      expect(((await (await fetch(`${url}/runs?pr=abc`)).json()) as unknown[]).length).toBe(0);
      expect(((await (await fetch(`${url}/runs?pr=42`)).json()) as unknown[]).length).toBe(1);
      expect(((await (await fetch(`${url}/runs?pr=`)).json()) as unknown[]).length).toBe(1);
    } finally {
      server.close();
    }
  });

  it("does not build GitHub links from dot-only repo segments", async () => {
    const store = new RunStore();
    const run = store.add(sampleRun({ repoFullName: "../.." }));
    const { server, url } = await listen(store);
    try {
      const html = await (await fetch(`${url}/runs/${run.id}`, { headers: HTML })).text();
      expect(html).not.toContain("https://github.com/../");
    } finally {
      server.close();
    }
  });
});

describe("history AI-generated field", () => {
  it("stores and shows the AI verdict and signals (escaped), and accepts policy checks", async () => {
    const store = new RunStore();
    const { server, url } = await listen(store);
    try {
      const res = await fetch(`${url}/runs`, {
        method: "POST",
        body: JSON.stringify({
          ...sampleRun(),
          aiGenerated: true,
          aiSignals: ['branch "cursor/x" starts with "cursor/"', "<b>x</b>", 5],
          checks: [sampleCheck({ name: "ai-approval", kind: "policy" as never })],
        }),
      });
      const saved = (await res.json()) as RunRecord;
      expect(saved.aiGenerated).toBe(true);
      expect(saved.aiSignals).toEqual(['branch "cursor/x" starts with "cursor/"', "<b>x</b>"]);
      expect(saved.checks[0]!.kind).toBe("policy");
      const html = await (await fetch(`${url}/runs/${saved.id}`, { headers: HTML })).text();
      expect(html).toContain("AI-generated</dt><dd>yes");
      expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
      expect(html).not.toContain("<b>x</b>");
    } finally {
      server.close();
    }
  });
});
