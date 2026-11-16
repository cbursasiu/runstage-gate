import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JobSignatureError, passthroughNames, poll, runGate, sandboxAvailable, sandboxProfile, sandboxSettingsFromEnv, scrubbedCheckEnv } from "../src/index.ts";
import { makeTempRepo, signedJobResponse } from "./helpers.ts";

const TOKEN = "runner-token-for-hardening-tests-0123";
const job = {
  id: "job-1", externalCheckId: "1", status: "claimed", createdAt: new Date().toISOString(),
  change: { provider: "github", repoFullName: "acme/x", headSha: "h", baseSha: "b", prNumber: 1 },
};
const ok = async () => ({ conclusion: "success" as const, title: "ok", summary: "ok", checks: [] });
const onMac = sandboxAvailable();

function fakeServer(next: () => Response) {
  const calls: string[] = [];
  const posted: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push(new URL(url).pathname);
    if (url.endsWith("/jobs/next")) return next();
    if (url.endsWith("/result")) posted.push(String(init!.body));
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return { calls, posted, fetchImpl };
}

describe("runner: signed jobs", () => {
  it("refuses an unsigned job without running anything", async () => {
    const s = fakeServer(() => new Response(JSON.stringify(job), { status: 200 }));
    let ran = false;
    const run = async () => { ran = true; return ok(); };
    await expect(poll({ server: "http://x", token: TOKEN, repos: "/repo", once: true, fetchImpl: s.fetchImpl, runGateImpl: run, log: () => {} }))
      .rejects.toThrow(JobSignatureError);
    expect(ran).toBe(false);
    expect(s.posted).toHaveLength(0);
  });

  it("refuses a job signed with another runner's key, or with a stale timestamp", async () => {
    for (const res of [() => signedJobResponse(job, "someone-elses-token-000000"), () => signedJobResponse(job, TOKEN, { now: Date.now() - 10 * 60_000 })]) {
      const s = fakeServer(res);
      await expect(poll({ server: "http://x", token: TOKEN, repos: "/repo", once: true, fetchImpl: s.fetchImpl, runGateImpl: ok, log: () => {} }))
        .rejects.toThrow(/refusing job: signature (bad_signature|expired)/);
    }
  });

  it("refuses a replayed job response", async () => {
    const replay = signedJobResponse(job, TOKEN, { nonce: "fixed-nonce-1234" });
    const text = await replay.text();
    const headers = Object.fromEntries(replay.headers);
    let n = 0;
    const s = fakeServer(() => { n++; return new Response(text, { status: 200, headers }); });
    const logs: string[] = [];
    await expect(poll({ server: "http://x", token: TOKEN, repos: "/repo", intervalMs: 1, fetchImpl: s.fetchImpl, runGateImpl: ok, log: (l) => logs.push(l) }))
      .rejects.toThrow(/signature replayed/);
    expect(n).toBe(2);
    expect(s.posted).toHaveLength(1);
  });

  it("runs a correctly signed job and redacts its own token and env secrets from the result and logs", async () => {
    const s = fakeServer(() => signedJobResponse(job, TOKEN));
    const leak = async () => ({
      conclusion: "failure" as const, title: `leak ${TOKEN}`, summary: `token=${TOKEN}`,
      checks: [{ name: "x", kind: "script" as const, required: true, status: "failed" as const, reason: TOKEN, exitCode: 1, durationMs: 1, output: TOKEN }],
    });
    const logs: string[] = [];
    await poll({ server: "http://x", token: TOKEN, repos: "/repo", once: true, fetchImpl: s.fetchImpl, runGateImpl: leak, log: (l) => logs.push(l) });
    expect(s.posted).toHaveLength(1);
    expect(s.posted[0]).not.toContain(TOKEN);
    expect(logs.join("\n")).not.toContain(TOKEN);
  });
});

describe("check environment", () => {
  it("passes an allowlist only, with HOME/TMPDIR in the job dir", () => {
    const env = scrubbedCheckEnv(
      { PATH: "/bin", LANG: "C", LC_ALL: "C", HOME: "/Users/me", RUNSTAGE_RUNNER_TOKEN: "x", GITHUB_TOKEN: "y", AWS_SECRET_ACCESS_KEY: "z", SSH_AUTH_SOCK: "/s", NODE_OPTIONS: "--x" },
      { home: "/tmp/job/home", tmp: "/tmp/job/tmp", gate: { RUNSTAGE_BASE: "b" } },
    );
    expect(env).toMatchObject({ PATH: "/bin", LANG: "C", LC_ALL: "C", HOME: "/tmp/job/home", TMPDIR: "/tmp/job/tmp", RUNSTAGE_BASE: "b", CI: "1" });
    for (const k of ["RUNSTAGE_RUNNER_TOKEN", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "SSH_AUTH_SOCK", "NODE_OPTIONS"]) expect(env[k]).toBeUndefined();
  });

  it("allows extra names via RUNSTAGE_CHECK_ENV_PASSTHROUGH but refuses secret-looking ones", () => {
    expect(passthroughNames({ RUNSTAGE_CHECK_ENV_PASSTHROUGH: "NODE_OPTIONS, JAVA_HOME" })).toContain("JAVA_HOME");
    for (const bad of ["GITHUB_TOKEN", "MY_SECRET", "RUNSTAGE_RUNNER_TOKEN", "AWS_REGION", "SSH_AUTH_SOCK", "bad-name"]) {
      expect(() => passthroughNames({ RUNSTAGE_CHECK_ENV_PASSTHROUGH: bad })).toThrow(/refusing/);
    }
  });

  it("a real check cannot see the runner's secrets", async () => {
    const repo = makeTempRepo("version: 1\nchecks:\n  - name: env\n    type: script\n    run: env; echo HOME=$HOME\n");
    const head = repo.commit({ "b.txt": "x\n" }, "head");
    const secret = "runner-env-secret-value-777";
    const r = await runGate({
      repo: repo.dir, base: repo.base, head,
      env: { PATH: process.env.PATH, RUNSTAGE_RUNNER_TOKEN: secret, GITHUB_TOKEN: secret, OTHER: secret },
      sandbox: { mode: "off", network: "none" },
    });
    const out = r.checks[0]!.output;
    expect(r.checks[0]!.status).toBe("passed");
    expect(out).not.toContain(secret);
    expect(out).toContain("RUNSTAGE_BASE=");
    expect(out).toMatch(/HOME=.*runstage-gate-.*\/home/);
  });
});

describe("sandbox", () => {
  it("settings come from the runner env and are validated", () => {
    expect(sandboxSettingsFromEnv({})).toEqual({ mode: "auto", network: "none" });
    expect(sandboxSettingsFromEnv({ RUNSTAGE_SANDBOX: "required", RUNSTAGE_SANDBOX_NETWORK: "loopback" })).toEqual({ mode: "required", network: "loopback" });
    expect(() => sandboxSettingsFromEnv({ RUNSTAGE_SANDBOX: "maybe" })).toThrow(/auto, required or off/);
    expect(() => sandboxSettingsFromEnv({ RUNSTAGE_SANDBOX_NETWORK: "some" })).toThrow(/none, loopback or all/);
  });

  it("profile denies writes and network by default", () => {
    const p = sandboxProfile({ writable: ["/w"], network: "none", protectedReads: ["/h/.ssh"] });
    expect(p).toContain("(deny network*)");
    expect(p).not.toContain("localhost");
    expect(p).toContain("(deny file-write*)");
    expect(p).toContain('(subpath "/w")');
    expect(p).toContain('(deny file-read* file-write* (subpath "/h/.ssh"))');
    expect(sandboxProfile({ writable: [], network: "loopback", protectedReads: [] })).toContain('remote ip "localhost:*"');
    expect(sandboxProfile({ writable: [], network: "all", protectedReads: [] })).not.toContain("network");
  });

  it.runIf(onMac)("blocks writes outside the job dir and outbound network; says so in the summary", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "rsg-outside-")));
    const target = join(outside, "pwned");
    const srv = createServer((_q, r) => r.end("ok"));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as AddressInfo).port;
    try {
      const yml =
        "version: 1\nchecks:\n" +
        `  - name: write\n    type: script\n    run: echo x > ${target}\n` +
        "  - name: write-inside\n    type: script\n    run: echo x > ok.txt && echo x > $HOME/h && echo x > $TMPDIR/t && git status --short >/dev/null\n" +
        `  - name: net\n    type: script\n    run: exec 3<>/dev/tcp/127.0.0.1/${port}\n`;
      const repo = makeTempRepo(yml);
      const head = repo.commit({ "b.txt": "x\n" }, "head");
      const sandboxed = await runGate({ repo: repo.dir, base: repo.base, head, sandbox: { mode: "auto", network: "none" } });
      expect(existsSync(target)).toBe(false);
      expect(sandboxed.checks.map((c) => [c.name, c.status])).toEqual([["write", "failed"], ["write-inside", "passed"], ["net", "failed"]]);
      expect(sandboxed.summary).toContain("Checks ran in a macOS sandbox");

      const loop = await runGate({ repo: repo.dir, base: repo.base, head, sandbox: { mode: "required", network: "loopback" } });
      expect(loop.checks.find((c) => c.name === "net")!.status).toBe("passed");

      const off = await runGate({ repo: repo.dir, base: repo.base, head, sandbox: { mode: "off", network: "none" } });
      expect(existsSync(target)).toBe(true);
      expect(off.summary).toContain("UNSANDBOXED");
    } finally {
      srv.close();
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
