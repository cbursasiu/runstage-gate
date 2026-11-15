/**
 * End-to-end demo with no GitHub account and no network:
 *   fake signed webhook -> App creates check run (mocked Octokit) -> job queued
 *   -> real `runstage-gate poll --once` CLI runs the example check in a temp git repo
 *   -> App completes the check run (mocked Octokit) -> run lands in the history stub.
 * Round 1 adds a TODO (blocked), round 2 removes it (passes).
 */
import { rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Webhooks } from "@octokit/webhooks";
import { GateService, GitHubCheckProvider, HttpHistorySink, JobQueue, createAppServer, type ChecksClient } from "../apps/github-app/src/index.ts";
import { RunStore, createHistoryServer } from "../apps/history/src/index.ts";
import { makeTempRepo } from "../packages/runner/test/helpers.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const c = { dim: "\x1b[2m", bold: "\x1b[1m", green: "\x1b[32m", red: "\x1b[31m", cyan: "\x1b[36m", reset: "\x1b[0m" };
const step = (s: string) => console.log(`\n${c.bold}${c.cyan}== ${s}${c.reset}`);

// Throwaway, per-run secrets for the demo only.
const WEBHOOK_SECRET = randomBytes(16).toString("hex");
const RUNNER_TOKEN = randomBytes(16).toString("hex");

// Mocked GitHub: records what the App would send to the Checks API.
let nextCheckId = 1000;
const githubCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
const mockGitHub: ChecksClient = {
  rest: {
    checks: {
      async create(params) {
        githubCalls.push({ method: "checks.create", params });
        console.log(`${c.dim}[mock GitHub] checks.create name="${params.name}" status=${params.status} head=${params.head_sha.slice(0, 7)}${c.reset}`);
        return { data: { id: ++nextCheckId } };
      },
      async update(params) {
        githubCalls.push({ method: "checks.update", params });
        const color = params.conclusion === "success" ? c.green : c.red;
        console.log(`${c.dim}[mock GitHub]${c.reset} checks.update id=${params.check_run_id} ${color}conclusion=${params.conclusion}${c.reset} title="${params.output.title}"`);
        return {};
      },
    },
  },
};

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function main() {
  step("Start history stub and GitHub App server (Octokit mocked)");
  const history = createHistoryServer(new RunStore());
  const historyUrl = await listen(history);
  const queue = new JobQueue();
  const service = new GateService({
    provider: new GitHubCheckProvider(async () => mockGitHub),
    queue,
    history: new HttpHistorySink(historyUrl),
    log: (l) => console.log(`${c.dim}[app] ${l}${c.reset}`),
  });
  const app = createAppServer({ webhookSecret: WEBHOOK_SECRET, runnerToken: RUNNER_TOKEN, service, queue });
  const appUrl = await listen(app);
  console.log(`app ${appUrl}, history ${historyUrl}`);

  step("Create a temp repo with .runstage/gate.yml and the no-todo-in-diff check");
  const repo = makeTempRepo();
  console.log(`repo ${repo.dir} base ${repo.base.slice(0, 7)}`);

  const webhooks = new Webhooks({ secret: WEBHOOK_SECRET });
  async function deliver(event: string, payload: object) {
    const body = JSON.stringify(payload);
    const res = await fetch(`${appUrl}/webhooks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": randomBytes(8).toString("hex"),
        "x-hub-signature-256": await webhooks.sign(body),
      },
      body,
    });
    console.log(`POST /webhooks (${event}.${(payload as { action: string }).action}) -> ${res.status}`);
  }
  const prPayload = (action: string, head: string) => ({
    action,
    number: 7,
    pull_request: { number: 7, head: { sha: head }, base: { sha: repo.base }, user: { login: "ai-agent-bot" } },
    repository: { full_name: "acme/demo-app" },
    installation: { id: 1 },
    sender: { login: "ai-agent-bot" },
  });

  /** The real CLI, exactly as a developer would run it (async: the App server lives in this process). */
  function runRunner(): Promise<void> {
    const args = [join(ROOT, "packages/runner/bin/runstage-gate.js"), "poll", "--server", appUrl, "--repo", repo.dir, "--once"];
    console.log(`$ runstage-gate poll --server ${appUrl} --repo <tmp repo> --once`);
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, { env: { ...process.env, RUNSTAGE_RUNNER_TOKEN: RUNNER_TOKEN } });
      child.stdout.on("data", (d: Buffer) => process.stdout.write(d.toString().replace(/^(?=.)/gm, "[runner] ")));
      child.stderr.on("data", (d: Buffer) => process.stderr.write(d));
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`runner exited ${code}`))));
    });
  }

  step("Round 1: an AI agent opens a PR that adds a TODO");
  const head1 = repo.commit({ "app.js": "export const x = 1;\n// TODO: add input validation\n" }, "ai: add feature");
  await deliver("pull_request", prPayload("opened", head1));
  console.log(`queue: ${queue.list().map((j) => `${j.id.slice(0, 8)}=${j.status}`).join(", ")}`);
  await runRunner();

  step("Round 2: the agent pushes a fix (pull_request.synchronize)");
  const head2 = repo.commit({ "app.js": "export const x = 1;\nexport const validate = (v) => v != null;\n" }, "ai: resolve TODO");
  await deliver("pull_request", prPayload("synchronize", head2));
  await runRunner();

  step("Hosted history (GET /runs)");
  const runs = (await (await fetch(`${historyUrl}/runs`)).json()) as Array<{ headSha: string; conclusion: string; title: string }>;
  for (const r of runs) console.log(`${r.headSha.slice(0, 7)}  ${r.conclusion.padEnd(7)}  ${r.title}`);

  step("Result");
  const updates = githubCalls.filter((x) => x.method === "checks.update").map((x) => x.params.conclusion);
  const ok = updates.length === 2 && updates[0] === "failure" && updates[1] === "success" && runs.length === 2;
  console.log(ok ? `${c.green}${c.bold}DEMO OK${c.reset}: blocked the TODO, passed the fix, recorded 2 runs.` : `${c.red}DEMO FAILED${c.reset} ${JSON.stringify(updates)}`);

  rmSync(repo.dir, { recursive: true, force: true });
  app.close();
  history.close();
  process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
