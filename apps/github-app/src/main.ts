import { existsSync, readFileSync } from "node:fs";
import { App } from "@octokit/app";
import { GitHubCheckProvider, type ChecksClient } from "./github-provider.ts";
import { GateService, HttpHistorySink } from "./handlers.ts";
import { JobQueue } from "./queue.ts";
import { loadRunnerRegistry, type RunnerRegistry } from "./runners.ts";
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

const log = (l: string) => console.log(`[app] ${l}`);

// Durable queue: one JSON file, rewritten atomically. Survives restarts; claims have a lease.
const queueFile = process.env.RUNSTAGE_QUEUE_FILE ?? ".runstage-gate-data/queue.json";
const leaseSeconds = Number(process.env.RUNSTAGE_JOB_LEASE_SECONDS ?? 900);
if (!Number.isFinite(leaseSeconds) || leaseSeconds < 30) {
  console.error("RUNSTAGE_JOB_LEASE_SECONDS must be a number >= 30");
  process.exit(2);
}
const queue = JobQueue.file(queueFile, { leaseMs: leaseSeconds * 1000 });

// Per-runner tokens: a JSON file of runner ids and SHA-256 token hashes (npm run -s runner-token -- mint --id <id>).
const runnersFile = process.env.RUNSTAGE_RUNNERS_FILE ?? ".runstage-gate-data/runners.json";
let runners: RunnerRegistry;
try {
  runners = loadRunnerRegistry(runnersFile);
} catch (err) {
  console.error((err as Error).message);
  process.exit(2);
}
const service = new GateService({
  provider: new GitHubCheckProvider(async (id) => (await app.getInstallationOctokit(id)) as ChecksClient),
  queue,
  appId: Number(env("GITHUB_APP_ID")),
  history: process.env.RUNSTAGE_HISTORY_URL
    ? new HttpHistorySink(process.env.RUNSTAGE_HISTORY_URL, process.env.RUNSTAGE_HISTORY_TOKEN)
    : undefined,
  log,
});

// Check runs whose final update failed after the job completed are retried in the background.
const retryTimer = setInterval(() => {
  void service.retryPendingReports();
}, Number(process.env.RUNSTAGE_REPORT_RETRY_SECONDS ?? 60) * 1000);
retryTimer.unref();
void service.retryPendingReports();

const port = Number(process.env.PORT ?? 3000);
createAppServer({
  webhookSecret: env("GITHUB_WEBHOOK_SECRET"),
  runners,
  service,
  queue,
  log,
}).listen(port, () =>
  log(`RunStage Gate App listening on :${port} (POST /webhooks); queue ${queueFile}, ${runners.list().length} runner(s), lease ${leaseSeconds}s`),
);
