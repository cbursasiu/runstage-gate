import { readFileSync } from "node:fs";
import { App } from "@octokit/app";
import { GitHubCheckProvider, type ChecksClient } from "./github-provider.ts";
import { GateService, HttpHistorySink } from "./handlers.ts";
import { JobQueue } from "./queue.ts";
import { createAppServer } from "./server.ts";

function env(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`missing env ${name} (see .env.example)`);
    process.exit(2);
  }
  return v;
}

const app = new App({
  appId: env("GITHUB_APP_ID"),
  privateKey: readFileSync(env("GITHUB_PRIVATE_KEY_PATH"), "utf8"),
  webhooks: { secret: env("GITHUB_WEBHOOK_SECRET") },
});

const queue = new JobQueue();
const log = (l: string) => console.log(`[app] ${l}`);
const service = new GateService({
  provider: new GitHubCheckProvider(async (id) => (await app.getInstallationOctokit(id)) as unknown as ChecksClient),
  queue,
  history: process.env.RUNSTAGE_HISTORY_URL
    ? new HttpHistorySink(process.env.RUNSTAGE_HISTORY_URL, process.env.RUNSTAGE_HISTORY_TOKEN)
    : undefined,
  log,
});

const port = Number(process.env.PORT ?? 3000);
createAppServer({
  webhookSecret: env("GITHUB_WEBHOOK_SECRET"),
  runnerToken: env("RUNSTAGE_RUNNER_TOKEN"),
  service,
  queue,
  log,
}).listen(port, () => log(`RunStage Gate App listening on :${port} (POST /webhooks)`));
