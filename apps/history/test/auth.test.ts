import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { HistoryAuth, RunStore, SESSION_COOKIE, createHistoryServer, safeNext, type HistoryAuthOptions } from "../src/index.ts";

const WRITE = "write-tok-123";
const READ = "read-tok-456";

function sampleRun() {
  return {
    jobId: "job-1",
    repoFullName: "acme/demo-app",
    prNumber: 42,
    headSha: "abcdef1",
    baseSha: "1234567",
    conclusion: "success" as const,
    title: "1/1 checks passed",
    summary: "ok",
    checks: [],
    runnerId: "mac-dev",
    approvedBy: null,
    createdAt: "2026-11-16T02:00:00.000Z",
    completedAt: "2026-11-16T02:00:05.000Z",
  };
}

async function listen(opts: HistoryAuthOptions | HistoryAuth, store = new RunStore()) {
  const server = createHistoryServer(store, opts);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, store };
}

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const login = (url: string, token: string, next = "/") =>
  fetch(`${url}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token, next }).toString(),
  });

describe("history auth", () => {
  it("is open when no token is configured (local dev)", async () => {
    const { server, url } = await listen({});
    try {
      expect((await fetch(`${url}/`)).status).toBe(200);
      expect((await fetch(`${url}/runs`)).status).toBe(200);
      expect((await fetch(`${url}/runs`, { method: "POST", body: JSON.stringify(sampleRun()) })).status).toBe(201);
      const l = await fetch(`${url}/login`, { redirect: "manual" });
      expect(l.status).toBe(303);
    } finally {
      server.close();
    }
  });

  it("fails closed on every read route without credentials", async () => {
    const { server, url, store } = await listen({ writeToken: WRITE, readToken: READ });
    const run = store.add(sampleRun());
    try {
      for (const path of ["/runs", "/api/runs", `/runs/${run.id}`, `/api/runs/${run.id}`, "/runs/missing"]) {
        const res = await fetch(`${url}${path}`, { redirect: "manual" });
        expect(res.status, path).toBe(401);
        expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
        expect(await res.text()).not.toContain("acme");
      }
      for (const path of ["/", "/?repo=acme/demo-app", `/runs/${run.id}`]) {
        const res = await fetch(`${url}${path}`, { redirect: "manual", headers: { accept: "text/html" } });
        expect(res.status, path).toBe(303);
        expect(res.headers.get("location")).toBe(`/login?next=${encodeURIComponent(path)}`);
      }
      // Unknown routes do not render pages (or leak data) to anonymous browsers.
      const unknown = await fetch(`${url}/nope`, { headers: { accept: "text/html" } });
      expect(unknown.status).toBe(404);
      expect(unknown.headers.get("content-type")).toBe("application/json");
    } finally {
      server.close();
    }
  });

  it("accepts the read or write token as a bearer for reads; only the write token may POST", async () => {
    const { server, url, store } = await listen({ writeToken: WRITE, readToken: READ });
    store.add(sampleRun());
    try {
      expect((await fetch(`${url}/runs`, { headers: bearer(READ) })).status).toBe(200);
      expect((await fetch(`${url}/runs`, { headers: bearer(WRITE) })).status).toBe(200);
      expect((await fetch(`${url}/`, { headers: bearer(READ) })).status).toBe(200);
      expect((await fetch(`${url}/runs`, { headers: bearer("nope") })).status).toBe(401);
      const post = (t: string) => fetch(`${url}/runs`, { method: "POST", headers: bearer(t), body: JSON.stringify(sampleRun()) });
      expect((await post(READ)).status).toBe(401);
      expect((await post("nope")).status).toBe(401);
      expect((await post(WRITE)).status).toBe(201);
    } finally {
      server.close();
    }
  });

  it("refuses writes when only a read token is configured", async () => {
    const { server, url } = await listen({ readToken: READ });
    try {
      const res = await fetch(`${url}/runs`, { method: "POST", headers: bearer(READ), body: JSON.stringify(sampleRun()) });
      expect(res.status).toBe(403);
      expect((await fetch(`${url}/runs`)).status).toBe(401);
    } finally {
      server.close();
    }
  });

  it("signs a browser in with an HttpOnly SameSite=Strict cookie and out again", async () => {
    const { server, url, store } = await listen({ writeToken: WRITE, readToken: READ });
    const run = store.add(sampleRun());
    try {
      const form = await fetch(`${url}/login?next=/runs/${run.id}`);
      expect(form.status).toBe(200);
      expect(await form.text()).toContain(`value="/runs/${run.id}"`);

      const bad = await login(url, "wrong");
      expect(bad.status).toBe(401);
      expect(bad.headers.get("set-cookie")).toBeNull();
      expect(await bad.text()).toContain("not valid");

      const ok = await login(url, READ, `/runs/${run.id}`);
      expect(ok.status).toBe(303);
      expect(ok.headers.get("location")).toBe(`/runs/${run.id}`);
      const setCookie = ok.headers.get("set-cookie")!;
      expect(setCookie).toMatch(new RegExp(`^${SESSION_COOKIE}=v1\\.`));
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Strict");
      expect(setCookie).toContain("Path=/");
      expect(setCookie).not.toContain(READ);
      expect(setCookie).not.toContain("Secure");
      const cookie = setCookie.split(";")[0]!;

      const page = await fetch(`${url}/`, { headers: { cookie } });
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("acme/demo-app");
      expect(html).toContain('action="/logout"');
      expect((await fetch(`${url}/runs`, { headers: { cookie } })).status).toBe(200);

      // A session never authorises writes.
      expect((await fetch(`${url}/runs`, { method: "POST", headers: { cookie }, body: JSON.stringify(sampleRun()) })).status).toBe(401);

      const out = await fetch(`${url}/logout`, { method: "POST", redirect: "manual", headers: { cookie } });
      expect(out.status).toBe(303);
      expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
      expect((await fetch(`${url}/logout`, { redirect: "manual" })).status).toBe(405);
    } finally {
      server.close();
    }
  });

  it("rejects forged, tampered, expired and rotated-token sessions", async () => {
    let now = 1_000_000;
    const auth = new HistoryAuth({ writeToken: WRITE, readToken: READ, sessionTtlMs: 1000, now: () => now });
    const session = auth.issueSession();
    expect(auth.verifySession(session)).toBe(true);
    expect(auth.verifySession(session.replace(/.$/, (c) => (c === "A" ? "B" : "A")))).toBe(false);
    expect(auth.verifySession(session.replace(/^v1\.\d+/, `v1.${now + 999_999}`))).toBe(false);
    expect(auth.verifySession("v1.99999999999.xxxx")).toBe(false);
    expect(auth.verifySession(undefined)).toBe(false);
    const rotated = new HistoryAuth({ writeToken: WRITE, readToken: "new-read", sessionTtlMs: 1000, now: () => now });
    expect(rotated.verifySession(session)).toBe(false);
    now += 1001;
    expect(auth.verifySession(session)).toBe(false);
  });

  it("only redirects to same-origin paths after login", async () => {
    expect(safeNext("/runs/abc?x=1")).toBe("/runs/abc?x=1");
    expect(safeNext("https://evil.example/")).toBe("/");
    expect(safeNext("//evil.example/")).toBe("/");
    expect(safeNext("/\\evil.example")).toBe("/");
    expect(safeNext("/login")).toBe("/");
    expect(safeNext(null)).toBe("/");
    const { server, url } = await listen({ readToken: READ });
    try {
      const res = await login(url, READ, "//evil.example/");
      expect(res.headers.get("location")).toBe("/");
    } finally {
      server.close();
    }
  });

  it("rate-limits repeated failed sign-ins", async () => {
    const { server, url } = await listen({ readToken: READ, maxLoginFailures: 3 });
    try {
      for (let i = 0; i < 3; i++) expect((await login(url, "wrong")).status).toBe(401);
      expect((await login(url, "wrong")).status).toBe(429);
      expect((await login(url, READ)).status).toBe(429);
    } finally {
      server.close();
    }
  });

  it("marks the cookie Secure when configured", () => {
    const auth = new HistoryAuth({ readToken: READ, cookieSecure: true });
    expect(auth.sessionCookie(auth.issueSession())).toContain("; Secure");
  });

  it("escapes the next value on the login page", async () => {
    const { server, url } = await listen({ readToken: READ });
    try {
      const html = await (await fetch(`${url}/login?next=${encodeURIComponent('/"><script>x</script>')}`)).text();
      expect(html).not.toContain("<script>x");
    } finally {
      server.close();
    }
  });
});
