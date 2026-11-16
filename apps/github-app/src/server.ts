import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Webhooks } from "@octokit/webhooks";
import { JOB_SIGNATURE_HEADER, signJob, type GateResult } from "@runstage-gate/core";
import { GateService, type CheckRunPayload, type CheckSuitePayload, type IssueCommentPayload, type PullRequestPayload } from "./handlers.ts";
import type { JobRefusal, JobStore } from "./queue.ts";
import type { RunnerRegistry } from "./runners.ts";
import { changeFromMergeRequest, verifyGitLabToken, type GitLabMergeRequestPayload, type GitLabStatusProvider } from "./gitlab.ts";

export interface AppServerOptions {
  webhookSecret: string;
  /** Registered runners (per-runner tokens, stored as SHA-256 hashes). */
  runners: RunnerRegistry;
  service: GateService;
  queue: JobStore;
  log?: (line: string) => void;
  /** GitLab merge_request webhooks at POST /webhooks/gitlab. Omit to disable (404). */
  gitlab?: { webhookSecret: string; provider: Pick<GitLabStatusProvider, "branchHead"> };
}

const MAX_BODY = 5 * 1024 * 1024;

export function createWebhooks(secret: string, service: GateService): Webhooks {
  const webhooks = new Webhooks({ secret });
  webhooks.on("check_suite", async ({ payload }) => {
    await service.onCheckSuite(payload as unknown as CheckSuitePayload);
  });
  webhooks.on("check_run", async ({ payload }) => {
    await service.onCheckRun(payload as unknown as CheckRunPayload);
  });
  webhooks.on("pull_request", async ({ payload }) => {
    await service.onPullRequest(payload as unknown as PullRequestPayload);
  });
  webhooks.on("issue_comment", async ({ payload }) => {
    await service.onIssueComment(payload as unknown as IssueCommentPayload);
  });
  return webhooks;
}

/**
 * HTTP surface:
 *   POST /webhooks                       GitHub webhooks (signature verified)
 *   POST /webhooks/gitlab                GitLab merge_request webhooks (X-Gitlab-Token), when configured
 *   POST /api/runner/jobs/next           runner claims a job under a lease (204 when none)
 *   POST /api/runner/jobs/:id/heartbeat  runner extends its lease while checks run
 *   POST /api/runner/jobs/:id/result     runner posts a GateResult (only the claiming runner)
 * Runner calls authenticate with `Authorization: Bearer <per-runner token>`; the runner id comes
 * from the token, never from a header. Claimed jobs carry an `x-runstage-job-signature` HMAC
 * (key derived from the runner's token, timestamp + nonce) that the runner verifies before running.
 * GitHub webhooks: X-Hub-Signature-256 (HMAC-SHA256, constant-time compare in @octokit/webhooks).
 * GitLab webhooks: X-Gitlab-Token (constant-time compare). Missing or bad -> 400/401, never handled.
 *   GET  /healthz
 */
export function createAppServer(opts: AppServerOptions): Server {
  const log = opts.log ?? (() => {});
  const webhooks = createWebhooks(opts.webhookSecret, opts.service);

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true });

      if (req.method === "POST" && url.pathname === "/webhooks") {
        const body = await readBody(req);
        const signature = header(req, "x-hub-signature-256");
        const name = header(req, "x-github-event");
        const delivery = header(req, "x-github-delivery");
        const id = delivery ?? "unknown";
        if (!signature || !name) return send(res, 400, { error: "missing GitHub headers" });
        if (!(await webhooks.verify(body, signature))) return send(res, 401, { error: "bad signature" });
        if (delivery && opts.queue.hasDelivery(delivery)) {
          log(`webhook ${name} ${id}: duplicate delivery, ignored`);
          return send(res, 200, { ok: true, duplicate: true });
        }
        log(`webhook ${name} ${id}`);
        await webhooks.receive({ id, name: name as never, payload: JSON.parse(body) });
        // Recorded only after handling succeeded, so a failed delivery can be retried.
        if (delivery) opts.queue.markDelivery(delivery);
        return send(res, 202, { ok: true });
      }

      if (req.method === "POST" && url.pathname === "/webhooks/gitlab") {
        if (!opts.gitlab) return send(res, 404, { error: "not found" });
        const body = await readBody(req);
        if (!verifyGitLabToken(header(req, "x-gitlab-token"), opts.gitlab.webhookSecret)) return send(res, 401, { error: "bad token" });
        const event = header(req, "x-gitlab-event") ?? "?";
        const uuid = header(req, "x-gitlab-event-uuid");
        const delivery = uuid ? `gitlab:${uuid}` : undefined;
        if (delivery && opts.queue.hasDelivery(delivery)) {
          log(`gitlab webhook ${event} ${uuid}: duplicate delivery, ignored`);
          return send(res, 200, { ok: true, duplicate: true });
        }
        log(`gitlab webhook ${event} ${uuid ?? "unknown"}`);
        const payload = JSON.parse(body) as GitLabMergeRequestPayload;
        if (event !== "Merge Request Hook" || payload.object_kind !== "merge_request") return send(res, 202, { ok: true, ignored: true });
        const { change, skip } = await changeFromMergeRequest(payload, (p, b) => opts.gitlab!.provider.branchHead(p, b));
        if (change) await opts.service.requestGate(change);
        else log(`gitlab merge_request !${payload.object_attributes?.iid ?? "?"}: skipped (${skip})`);
        if (delivery) opts.queue.markDelivery(delivery);
        return send(res, 202, { ok: true, ...(skip ? { ignored: true } : {}) });
      }

      if (url.pathname.startsWith("/api/runner/")) {
        const bearer = /^Bearer\s+(.+)$/i.exec(header(req, "authorization") ?? "")?.[1]?.trim();
        const runner = opts.runners.authenticate(bearer);
        if (!runner) return send(res, 401, { error: "bad runner token" });
        if (req.method === "POST" && url.pathname === "/api/runner/jobs/next") {
          const job = opts.queue.claimNext(runner.id, runner.repos);
          if (!job) {
            res.writeHead(204).end();
            return;
          }
          log(`runner ${runner.id} claimed job ${job.id} (attempt ${job.attempts ?? 1})`);
          // Signed, so the runner can verify the job really came from this App (core/signing.ts).
          const body = JSON.stringify(job);
          res.writeHead(200, { "content-type": "application/json", [JOB_SIGNATURE_HEADER]: signJob(body, runner.signingKey) }).end(body);
          return;
        }
        const m = /^\/api\/runner\/jobs\/([^/]+)\/(result|heartbeat)$/.exec(url.pathname);
        if (req.method === "POST" && m) {
          const jobId = decodeURIComponent(m[1]!);
          if (m[2] === "heartbeat") {
            const hb = opts.queue.heartbeat(jobId, runner.id);
            if (!hb.ok) return refuse(res, hb.reason);
            return send(res, 200, { ok: true, leaseExpiresAt: hb.job.leaseExpiresAt });
          }
          const result = JSON.parse(await readBody(req)) as GateResult;
          if (result.conclusion !== "success" && result.conclusion !== "failure") {
            return send(res, 400, { error: "conclusion must be success or failure" });
          }
          const outcome = await opts.service.completeJob(jobId, runner.id, result);
          if (!outcome.ok) return refuse(res, outcome.reason);
          return send(res, 200, { ok: true });
        }
      }
      send(res, 404, { error: "not found" });
    } catch (err) {
      log(`error: ${(err as Error).message}`);
      if (!res.headersSent) send(res, 500, { error: "internal error" });
    }
  });
}

const REFUSALS: Record<JobRefusal, [number, string]> = {
  not_found: [404, "unknown or already completed job"],
  already_completed: [404, "unknown or already completed job"],
  claimed_by_other_runner: [403, "job is claimed by another runner"],
  not_claimed: [409, "job is not claimed by you (lease expired?)"],
};

function refuse(res: ServerResponse, reason: JobRefusal): void {
  const [status, error] = REFUSALS[reason];
  send(res, status, { error, reason });
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}
