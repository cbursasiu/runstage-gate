import { readdirSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { GateService, GitHubCheckProvider, JobQueue, RunnerRegistry, createAppServer, hashToken } from "../src/index.ts";
import { listen, mockChecksClient, sendWebhook } from "./helpers.ts";

const ROOT = new URL("../../../", import.meta.url);

/**
 * GitHub-hosted runner labels: ubuntu-*, macos-*, windows-*, *-latest. Bare "macOS", "Linux",
 * "ARM64" are the standard self-hosted runner labels and are fine next to "self-hosted".
 */
const HOSTED_LABEL = /^(ubuntu|macos|windows)-|-latest$/i;

/** Problems with one job's `runs-on`: must name `self-hosted` and no GitHub-hosted label. */
export function runsOnProblems(runsOn: unknown): string[] {
  let labels: unknown[];
  if (typeof runsOn === "string") labels = [runsOn];
  else if (Array.isArray(runsOn)) labels = runsOn;
  else if (runsOn && typeof runsOn === "object" && "labels" in runsOn) {
    const l = (runsOn as { labels: unknown }).labels;
    labels = Array.isArray(l) ? l : [l];
  } else return [`runs-on missing or unsupported (${JSON.stringify(runsOn)}); runner groups and expressions are not allowed`];
  const problems: string[] = [];
  if (labels.some((l) => typeof l !== "string" || l.includes("${{"))) problems.push("runs-on uses a non-literal label or expression");
  if (!labels.includes("self-hosted")) problems.push("runs-on lacks self-hosted");
  for (const l of labels) if (typeof l === "string" && HOSTED_LABEL.test(l)) problems.push(`GitHub-hosted label "${l}"`);
  return problems;
}

describe("local-only principle", () => {
  it("rejects GitHub-hosted or non-self-hosted runs-on values", () => {
    expect(runsOnProblems(["self-hosted", "macOS", "ARM64"])).toEqual([]);
    expect(runsOnProblems("ubuntu-latest")).toEqual(expect.arrayContaining(["runs-on lacks self-hosted", 'GitHub-hosted label "ubuntu-latest"']));
    expect(runsOnProblems(["self-hosted", "macos-14"])).toEqual(['GitHub-hosted label "macos-14"']);
    expect(runsOnProblems(["self-hosted", "windows-2022"])).toHaveLength(1);
    expect(runsOnProblems(["self-hosted", "foo-latest"])).toHaveLength(1);
    expect(runsOnProblems(["macOS", "ARM64"])).toEqual(["runs-on lacks self-hosted"]);
    expect(runsOnProblems("${{ matrix.os }}")).toEqual(expect.arrayContaining(["runs-on uses a non-literal label or expression"]));
    expect(runsOnProblems({ group: "default" })).toHaveLength(1);
    expect(runsOnProblems(undefined)).toHaveLength(1);
  });

  it("every job in .github/workflows/*.yml runs self-hosted only, and ci.yml stays on [self-hosted, macOS, ARM64]", () => {
    const dir = new URL(".github/workflows/", ROOT);
    const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const wf = parse(readFileSync(new URL(f, dir), "utf8")) as { jobs: Record<string, { "runs-on"?: unknown; uses?: string }> };
      for (const [name, job] of Object.entries(wf.jobs)) {
        expect(job.uses, `${f}:${name} must not call a reusable workflow (it could run on hosted runners)`).toBeUndefined();
        expect(runsOnProblems(job["runs-on"]), `${f}:${name}`).toEqual([]);
        if (f === "ci.yml") expect(job["runs-on"], `${f}:${name}`).toEqual(["self-hosted", "macOS", "ARM64"]);
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
