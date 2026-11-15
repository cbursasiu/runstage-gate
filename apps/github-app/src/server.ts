import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Webhooks } from "@octokit/webhooks";
import type { GateResult } from "@runstage-gate/core";
import { GateService, type CheckSuitePayload, type PullRequestPayload } from "./handlers.ts";
import type { JobQueue } from "./queue.ts";

export interface AppServerOptions {
  webhookSecret: string;
  runnerToken: string;
  service: GateService;
  queue: JobQueue;
  log?: (line: string) => void;
}

const MAX_BODY = 5 * 1024 * 1024;

export function createWebhooks(secret: string, service: GateService): Webhooks {
  const webhooks = new Webhooks({ secret });
  webhooks.on("check_suite", async ({ payload }) => {
    await service.onCheckSuite(payload as unknown as CheckSuitePayload);
  });
  webhooks.on("pull_request", async ({ payload }) => {
    await service.onPullRequest(payload as unknown as PullRequestPayload);
  });
  return webhooks;
}

/**
 * HTTP surface:
 *   POST /webhooks                       GitHub webhooks (signature verified)
 *   POST /api/runner/jobs/next           runner claims a job (204 when none)
 *   POST /api/runner/jobs/:id/result     runner posts a GateResult
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
        const id = header(req, "x-github-delivery") ?? "unknown";
        if (!signature || !name) return send(res, 400, { error: "missing GitHub headers" });
        if (!(await webhooks.verify(body, signature))) return send(res, 401, { error: "bad signature" });
        log(`webhook ${name} ${id}`);
        await webhooks.receive({ id, name: name as never, payload: JSON.parse(body) });
        return send(res, 202, { ok: true });
      }

      if (url.pathname.startsWith("/api/runner/")) {
        if (!runnerAuthorized(req, opts.runnerToken)) return send(res, 401, { error: "bad runner token" });
        if (req.method === "POST" && url.pathname === "/api/runner/jobs/next") {
          const job = opts.queue.claimNext(header(req, "x-runner-id") ?? "unknown-runner");
          if (!job) {
            res.writeHead(204).end();
            return;
          }
          log(`runner claimed job ${job.id}`);
          return send(res, 200, job);
        }
        const m = /^\/api\/runner\/jobs\/([^/]+)\/result$/.exec(url.pathname);
        if (req.method === "POST" && m) {
          const result = JSON.parse(await readBody(req)) as GateResult;
          if (result.conclusion !== "success" && result.conclusion !== "failure") {
            return send(res, 400, { error: "conclusion must be success or failure" });
          }
          const job = await opts.service.completeJob(decodeURIComponent(m[1]!), result);
          if (!job) return send(res, 404, { error: "unknown or already completed job" });
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

function runnerAuthorized(req: IncomingMessage, token: string): boolean {
  const got = (header(req, "authorization") ?? "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(got);
  const b = Buffer.from(token);
  return token.length > 0 && a.length === b.length && timingSafeEqual(a, b);
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
