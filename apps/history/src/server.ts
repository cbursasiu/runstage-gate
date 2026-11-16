import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { GateConclusion } from "@runstage-gate/core";
import type { RunStore, RunListFilter } from "./store.ts";
import { renderDetailPage, renderListPage, renderNotFoundPage, wantsHtml } from "./html.ts";
import { parseNewRun } from "./validate.ts";

/** POST /runs bodies larger than this are refused with 413. Diffs are capped separately by the store. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** Locks HTML pages down: no scripts, no external loads, no framing, inline CSS only. */
const HTML_SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

/**
 * GET  /                             HTML run list (filters: ?repo=&verdict=)
 * GET  /runs?repo=&pr=&verdict=      list runs as JSON, newest first
 * GET  /api/runs                     JSON alias of GET /runs
 * GET  /runs/:id                     one run (JSON by default; HTML when Accept prefers text/html)
 * GET  /api/runs/:id                 one run as JSON
 * POST /runs                         record a run (bearer token when HISTORY token is set)
 */
export function createHistoryServer(store: RunStore, token?: string): Server {
  return createServer((req, res) => {
    try {
      handle(store, token, req, res);
    } catch (err) {
      console.error(`[history] ${req.method} ${req.url}: ${(err as Error).message}`);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      else res.destroy();
    }
  });
}

function handle(store: RunStore, token: string | undefined, req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const isRead = req.method === "GET" || req.method === "HEAD";

  if (isRead && path === "/") {
    const filter = listFilter(url);
    return sendHtml(res, 200, renderListPage(store.list(filter), { repo: filter.repo, verdict: filter.verdict }));
  }

  if (isRead && (path === "/runs" || path === "/api/runs")) {
    return sendJson(res, 200, store.list(listFilter(url)));
  }

  const runPath = /^\/(?:api\/)?runs\/([^/]+)$/.exec(path);
  if (isRead && runPath) {
    const id = safeDecode(runPath[1]!);
    const html = path.startsWith("/api/") ? false : wantsHtml(req.headers.accept);
    res.setHeader("vary", "Accept");
    const run = id === undefined ? undefined : store.get(id);
    if (!run) return html ? sendHtml(res, 404, renderNotFoundPage()) : sendJson(res, 404, { error: "not found" });
    return html ? sendHtml(res, 200, renderDetailPage(run)) : sendJson(res, 200, run);
  }

  if (req.method === "POST" && path === "/runs") {
    if (token && req.headers.authorization !== `Bearer ${token}`) return sendJson(res, 401, { error: "unauthorized" });
    return readBody(req, res, (body) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return sendJson(res, 400, { error: "invalid JSON" });
      }
      const result = parseNewRun(parsed);
      if (!result.ok) return sendJson(res, 400, { error: result.error });
      sendJson(res, 201, store.add(result.run));
    });
  }

  if (isRead && wantsHtml(req.headers.accept)) return sendHtml(res, 404, renderNotFoundPage());
  sendJson(res, 404, { error: "not found" });
}

function readBody(req: IncomingMessage, res: ServerResponse, onBody: (body: string) => void) {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > MAX_BODY_BYTES) {
    // Drain the upload (instead of resetting the socket) so the client reliably sees the 413.
    req.resume();
    req.on("end", () => sendJson(res, 413, { error: "body too large" }));
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let aborted = false;
  req.on("data", (c: Buffer) => {
    if (aborted) return;
    size += c.length;
    if (size > MAX_BODY_BYTES) {
      aborted = true;
      chunks.length = 0;
      return;
    }
    chunks.push(c);
  });
  req.on("end", () => {
    if (aborted) return sendJson(res, 413, { error: "body too large" });
    try {
      onBody(Buffer.concat(chunks).toString("utf8"));
    } catch (err) {
      console.error(`[history] POST /runs: ${(err as Error).message}`);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
    }
  });
  req.on("error", () => {
    if (!res.headersSent) sendJson(res, 400, { error: "bad request" });
  });
}

/** decodeURIComponent throws on malformed escapes (e.g. "%E0%A4%A"); treat those as not found. */
function safeDecode(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

function listFilter(url: URL): RunListFilter {
  const pr = url.searchParams.get("pr");
  const prNumber = pr !== null && /^\d+$/.test(pr) ? Number(pr) : undefined;
  const repo = url.searchParams.get("repo")?.trim();
  return {
    repo: repo ? repo : undefined,
    // An unparseable pr filter matches nothing rather than silently listing everything.
    pr: pr !== null && pr !== "" ? (prNumber ?? -1) : undefined,
    verdict: parseVerdict(url.searchParams.get("verdict")),
  };
}

function parseVerdict(value: string | null): GateConclusion | undefined {
  return value === "success" || value === "failure" ? value : undefined;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res
    .writeHead(status, { "content-type": "application/json", "x-content-type-options": "nosniff", "cache-control": "no-store" })
    .end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...HTML_SECURITY_HEADERS }).end(body);
}
