import { readdirSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { GateService, GitHubCheckProvider, JobQueue, RunnerRegistry, createAppServer, hashToken } from "../src/index.ts";
import { listen, mockChecksClient, sendWebhook } from "./helpers.ts";

const ROOT = new URL("../../../", import.meta.url);

describe("local-only principle", () => {
  it("every GitHub Actions job runs on the self-hosted macOS ARM64 runner, never a GitHub-hosted one", () => {
    const dir = new URL(".github/workflows/", ROOT);
    const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const wf = parse(readFileSync(new URL(f, dir), "utf8")) as { jobs: Record<string, { "runs-on"?: unknown; uses?: string }> };
      for (const [name, job] of Object.entries(wf.jobs)) {
        expect(job.uses, `${f}:${name} must not call a reusable workflow (could run hosted)`).toBeUndefined();
        expect(job["runs-on"], `${f}:${name}`).toEqual(["self-hosted", "macOS", "ARM64"]);
      }
    }
  });

  let server: Server | undefined;
  afterEach(() => server?.close());

  it("with no runner online, the job stays queued and the check stays in progress: nothing else runs it", async () => {
    const gh = mockChecksClient();
    const queue = new JobQueue();
    const service = new GateService({ provider: new GitHubCheckProvider(gh.factory), queue });
    server = createAppServer({ webhookSecret: "s", runners: RunnerRegistry.fromEntries([{ id: "r", tokenSha256: hashToken("tok") }]), service, queue });
    const url = await listen(server);
    const suite = {
      action: "requested",
      installation: { id: 1 },
      repository: { full_name: "acme/x", name: "x", owner: { login: "acme" } },
      check_suite: { head_sha: "1".repeat(40), pull_requests: [{ number: 1, base: { sha: "2".repeat(40), ref: "main" }, head: { sha: "1".repeat(40), ref: "f" } }] },
    };
    expect((await sendWebhook(url, "s", "check_suite", suite)).status).toBe(202);
    expect(gh.create.mock.calls[0]![0]).toMatchObject({ status: "in_progress" });
    expect(gh.update).not.toHaveBeenCalled();
    expect(queue.list().map((j) => j.status)).toEqual(["queued"]);
  });
});
