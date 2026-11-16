import { hostname } from "node:os";
import type { GateJob, GateResult } from "@runstage-gate/core";
import { runGate } from "./execute.ts";

export interface PollOptions {
  server: string;
  token: string;
  /** Map "owner/name" -> local checkout path. A single `--repo` maps every job to that path. */
  repos: Record<string, string> | string;
  allowAgents?: boolean;
  once?: boolean;
  intervalMs?: number;
  /** How often to extend the job's lease while checks run. Default 60s. */
  heartbeatMs?: number;
  /** Informational only: the server identifies the runner by its token. */
  runnerId?: string;
  fetchImpl?: typeof fetch;
  /** Test seam: defaults to runGate. */
  runGateImpl?: typeof runGate;
  log?: (line: string) => void;
  signal?: AbortSignal;
  /**
   * Delay before retry number `attempt` (1-based) after the server is unreachable or returns 5xx,
   * e.g. while the App restarts. Default: 1s, 2s, 4s ... capped at 60s.
   */
  backoffMs?: (attempt: number) => number;
  /** Attempts to post a result before giving up on it (the job's lease then re-queues it). Default 6. */
  resultAttempts?: number;
}

const defaultBackoff = (attempt: number) => Math.min(1000 * 2 ** (attempt - 1), 60_000);

/** Network failure (fetch threw) or a 5xx: worth retrying. */
class TransientError extends Error {}

async function call(f: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await f(url, init);
  } catch (err) {
    throw new TransientError(`server unreachable: ${(err as Error).message}`);
  }
  if (res.status >= 500) throw new TransientError(`server error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res;
}

/** Ask the server for the next job, run it locally, post the result. Returns jobs processed. */
export async function poll(opts: PollOptions): Promise<number> {
  const f = opts.fetchImpl ?? fetch;
  const log = opts.log ?? ((l: string) => console.log(l));
  const runnerId = opts.runnerId ?? `${hostname()}-${process.pid}`;
  const headers = { authorization: `Bearer ${opts.token}`, "content-type": "application/json", "x-runner-id": runnerId };
  const server = opts.server.replace(/\/$/, "");
  let processed = 0;
  const backoff = opts.backoffMs ?? defaultBackoff;
  let failures = 0;

  while (!opts.signal?.aborted) {
    let res: Response;
    try {
      res = await call(f, `${server}/api/runner/jobs/next`, { method: "POST", headers, body: "{}" });
    } catch (err) {
      // Keep polling through App restarts and outages instead of exiting.
      if (!(err instanceof TransientError) || opts.once) throw err;
      failures++;
      const wait = backoff(failures);
      log(`${err.message}; retrying in ${Math.round(wait / 1000)}s`);
      await sleep(wait, opts.signal);
      continue;
    }
    if (failures) log(`server reachable again after ${failures} failed attempt(s)`);
    failures = 0;
    if (res.status === 401) throw new Error("server rejected the runner token");
    if (res.status === 204) {
      if (opts.once) return processed;
      await sleep(opts.intervalMs ?? 5000, opts.signal);
      continue;
    }
    if (!res.ok) throw new Error(`server error ${res.status}: ${await res.text()}`);
    const job = (await res.json()) as GateJob;
    log(`job ${job.id}: ${job.change.repoFullName}#${job.change.prNumber ?? "?"} ${job.change.headSha.slice(0, 7)}`);

    // Keep the claim alive while checks run; if the lease lapses the server re-queues the job.
    const heartbeat = setInterval(() => {
      f(`${server}/api/runner/jobs/${encodeURIComponent(job.id)}/heartbeat`, { method: "POST", headers, body: "{}" })
        .then((r) => {
          if (!r.ok) log(`job ${job.id}: heartbeat refused (${r.status})`);
        })
        .catch((err: Error) => log(`job ${job.id}: heartbeat failed: ${err.message}`));
    }, opts.heartbeatMs ?? 60_000);

    let result: GateResult;
    const repo = typeof opts.repos === "string" ? opts.repos : opts.repos[job.change.repoFullName];
    if (!repo) {
      result = errorResult(`runner has no local checkout for ${job.change.repoFullName}`);
    } else {
      try {
        result = await (opts.runGateImpl ?? runGate)({
          repo,
          base: job.change.baseSha,
          head: job.change.headSha,
          allowAgents: opts.allowAgents,
          change: job.change,
          // Jobs from the App must use the base commit's gate.yml; never the checkout's working tree.
          allowWorkingTreeConfig: false,
          fetch: true,
          log,
        });
      } catch (err) {
        result = errorResult((err as Error).message);
      }
    }
    clearInterval(heartbeat);
    log(`job ${job.id}: ${result.conclusion} - ${result.title}`);
    const post = await postResult(f, `${server}/api/runner/jobs/${encodeURIComponent(job.id)}/result`, headers, result, {
      attempts: opts.resultAttempts ?? 6,
      backoff,
      log: (l) => log(`job ${job.id}: ${l}`),
      signal: opts.signal,
    });
    if (post?.status === 401) throw new Error("server rejected the runner token");
    if (post && [403, 404, 409].includes(post.status)) {
      // The lease lapsed and another runner took the job, or it was already finished: not fatal.
      log(`job ${job.id}: server refused the result (${post.status}): ${await post.text()}`);
    } else if (post && !post.ok) {
      throw new Error(`posting result failed ${post.status}: ${await post.text()}`);
    }
    processed++;
    if (opts.once) return processed;
  }
  return processed;
}

/** Post a result, retrying transient failures. Returns undefined if every attempt failed. */
async function postResult(
  f: typeof fetch,
  url: string,
  headers: Record<string, string>,
  result: GateResult,
  o: { attempts: number; backoff: (attempt: number) => number; log: (line: string) => void; signal?: AbortSignal },
): Promise<Response | undefined> {
  for (let attempt = 1; attempt <= o.attempts; attempt++) {
    try {
      return await call(f, url, { method: "POST", headers, body: JSON.stringify(result) });
    } catch (err) {
      if (!(err instanceof TransientError)) throw err;
      if (attempt === o.attempts || o.signal?.aborted) {
        o.log(`posting result failed after ${attempt} attempt(s): ${err.message}. The job's lease will expire and it will be re-queued.`);
        return undefined;
      }
      const wait = o.backoff(attempt);
      o.log(`posting result: ${err.message}; retrying in ${Math.round(wait / 1000)}s`);
      await sleep(wait, o.signal);
    }
  }
  return undefined;
}

function errorResult(message: string): GateResult {
  return {
    conclusion: "failure",
    title: "Runner error",
    summary: `**Gate blocked**: the runner could not run the checks.\n\n\`${message}\``,
    checks: [],
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });
}
