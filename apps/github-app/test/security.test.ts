import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { JOB_SIGNATURE_HEADER, NonceCache, Redactor, jobSigningKeyFromToken, verifyJobSignature } from "@runstage-gate/core";
import { GateService, GitHubCheckProvider, JobQueue, RunnerRegistry, createAppServer, hashToken, verifyGitLabToken } from "../src/index.ts";
import { listen, mockChecksClient, sendWebhook } from "./helpers.ts";

const SECRET = "test-webhook-secret";
const GL_SECRET = "test-gitlab-secret";
const RUNNER_TOKEN = "test-runner-token-for-security";
const runners = RunnerRegistry.fromEntries([{ id: "runner-a", tokenSha256: hashToken(RUNNER_TOKEN) }]);
const suite = {
  action: "requested",
  installation: { id: 777 },
  repository: { full_name: "acme/demo-app", name: "demo-app", owner: { login: "acme" } },
  check_suite: {
    head_sha: "1".repeat(40),
    pull_requests: [{ number: 7, base: { sha: "2".repeat(40), ref: "main" }, head: { sha: "1".repeat(40), ref: "f" } }],
  },
};

let server: Server | undefined;
afterEach(() => server?.close());

async function setup(redactor?: Redactor) {
  const gh = mockChecksClient();
  const queue = new JobQueue();
  const service = new GateService({ provider: new GitHubCheckProvider(gh.factory), queue, redactor });
  const provider = { branchHead: async () => "3".repeat(40) };
  server = createAppServer({ webhookSecret: SECRET, runners, service, queue, gitlab: { webhookSecret: GL_SECRET, provider } });
  return { gh, queue, url: await listen(server) };
}

describe("webhook authentication", () => {
  it("GitHub: rejects unsigned, mis-signed and wrong-secret deliveries without handling them", async () => {
    const { gh, queue, url } = await setup();
    const body = JSON.stringify(suite);
    const post = (headers: Record<string, string>) =>
      fetch(`${url}/webhooks`, { method: "POST", headers: { "content-type": "application/json", "x-github-delivery": `d-${Math.random()}`, ...headers }, body });
    expect((await post({ "x-github-event": "check_suite" })).status).toBe(400);
    expect((await post({ "x-github-event": "check_suite", "x-hub-signature-256": "sha256=deadbeef" })).status).toBe(401);
    const wrong = `sha256=${createHmac("sha256", "not-the-secret").update(body).digest("hex")}`;
    expect((await post({ "x-github-event": "check_suite", "x-hub-signature-256": wrong })).status).toBe(401);
    // A valid signature for a different body does not authorize this one.
    const other = `sha256=${createHmac("sha256", SECRET).update(body + " ").digest("hex")}`;
    expect((await post({ "x-github-event": "check_suite", "x-hub-signature-256": other })).status).toBe(401);
    // sha1 header alone is not accepted
    expect((await post({ "x-github-event": "check_suite", "x-hub-signature": "sha1=abc" })).status).toBe(400);
    expect(gh.create).not.toHaveBeenCalled();
    expect(queue.list()).toHaveLength(0);
    // The correctly signed one is handled.
    expect((await sendWebhook(url, SECRET, "check_suite", suite)).status).toBe(202);
    expect(queue.list()).toHaveLength(1);
  });

  it("GitLab: rejects missing and wrong tokens; compares in constant time", async () => {
    const { queue, url } = await setup();
    const post = (token?: string) =>
      fetch(`${url}/webhooks/gitlab`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-gitlab-event": "Merge Request Hook", ...(token ? { "x-gitlab-token": token } : {}) },
        body: "{}",
      });
    expect((await post()).status).toBe(401);
    expect((await post("wrong")).status).toBe(401);
    expect((await post(GL_SECRET + "x")).status).toBe(401);
    expect(queue.list()).toHaveLength(0);
    expect(verifyGitLabToken(GL_SECRET, GL_SECRET)).toBe(true);
    expect(verifyGitLabToken(undefined, GL_SECRET)).toBe(false);
    expect(verifyGitLabToken("x", "")).toBe(false);
  });
});

describe("runner channel", () => {
  it("signs every claimed job with the claiming runner's key; the runner can verify it once", async () => {
    const { url } = await setup();
    await sendWebhook(url, SECRET, "check_suite", suite);
    const res = await fetch(`${url}/api/runner/jobs/next`, { method: "POST", headers: { authorization: `Bearer ${RUNNER_TOKEN}` }, body: "{}" });
    expect(res.status).toBe(200);
    const sig = res.headers.get(JOB_SIGNATURE_HEADER);
    const body = await res.text();
    const nonces = new NonceCache();
    expect(verifyJobSignature(body, sig, jobSigningKeyFromToken(RUNNER_TOKEN), { nonces })).toEqual({ ok: true });
    expect(verifyJobSignature(body, sig, jobSigningKeyFromToken(RUNNER_TOKEN), { nonces })).toEqual({ ok: false, reason: "replayed" });
    expect(verifyJobSignature(body, sig, jobSigningKeyFromToken("some-other-runner-token"))).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("redacts secrets in runner results before posting them to GitHub", async () => {
    const leaked = "app-side-secret-value-123456";
    const { gh, url } = await setup(new Redactor([leaked]));
    await sendWebhook(url, SECRET, "check_suite", suite);
    const auth = { authorization: `Bearer ${RUNNER_TOKEN}`, "content-type": "application/json" };
    const job = (await (await fetch(`${url}/api/runner/jobs/next`, { method: "POST", headers: auth, body: "{}" })).json()) as { id: string };
    const ghToken = "ghp_" + "Z9y8X7w6V5".repeat(4);
    const result = {
      conclusion: "failure",
      title: "1 required check failed: env",
      summary: `out ${leaked} and ${ghToken}`,
      checks: [{ name: "env", kind: "script", required: true, status: "failed", reason: leaked, exitCode: 1, durationMs: 1, output: ghToken }],
    };
    expect((await fetch(`${url}/api/runner/jobs/${job.id}/result`, { method: "POST", headers: auth, body: JSON.stringify(result) })).status).toBe(200);
    const posted = JSON.stringify(gh.update.mock.calls.at(-1)![0]);
    expect(posted).not.toContain(leaked);
    expect(posted).not.toContain(ghToken);
    expect(posted).toContain("[REDACTED]");
  });
});
