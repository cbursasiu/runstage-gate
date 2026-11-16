import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { GateConclusion } from "@runstage-gate/core";
import type { RunStore, RunListFilter } from "./store.ts";
import { renderDetailPage, renderListPage, renderLoginPage, renderNotFoundPage, wantsHtml } from "./html.ts";
import { HistoryAuth, safeNext, type HistoryAuthOptions } from "./auth.ts";
import { parseNewRun } from "./validate.ts";

/** POST /login bodies larger than this are refused. */
const MAX_LOGIN_BODY_BYTES = 8 * 1024;

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
 * POST /runs                         record a run (write token)
 * GET  /login, POST /login           browser sign-in with a read or write token (sets a session cookie)
 * POST /logout                       clear the session cookie
 *
 * When a token is configured, every read route needs `Authorization: Bearer <token>` or a session
 * cookie; browsers are redirected to /login, API clients get 401. See auth.ts.
 *
 * The second argument is the write token (legacy signature) or full auth options.
 */
export function createHistoryServer(store: RunStore, auth?: string | HistoryAuthOptions | HistoryAuth): Server {
  const access =
    auth instanceof HistoryAuth ? auth : new HistoryAuth(typeof auth === "string" ? { writeToken: auth } : (auth ?? {}));
  return createServer((req, res) => {
    try {
      handle(store, access, req, res);
    } catch (err) {
      console.error(`[history] ${req.method} ${req.url}: ${(err as Error).message}`);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      else res.destroy();
    }
  });
}

function handle(store: RunStore, auth: HistoryAuth, req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const isRead = req.method === "GET" || req.method === "HEAD";

  if (path === "/login") return handleLogin(auth, req, res, url);
  if (path === "/logout") {
    if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
    res.setHeader("set-cookie", auth.clearCookie());
    return redirect(res, auth.open ? "/" : "/login");
  }

  if (req.method === "POST" && path === "/runs") {
    if (!auth.writesEnabled) return sendJson(res, 403, { error: "writes disabled: RUNSTAGE_HISTORY_TOKEN is not set" });
    if (!auth.canWrite(req)) return sendJson(res, 401, { error: "unauthorized" }, { "www-authenticate": 'Bearer realm="runstage-history"' });
    return readBody(req, res, MAX_BODY_BYTES, (body) => {
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

  const isUiRoute = path === "/";
  const runPath = /^\/(?:api\/)?runs\/([^/]+)$/.exec(path);
  const isApiRoute = path === "/runs" || path === "/api/runs" || !!runPath;
  if (!isRead || (!isUiRoute && !isApiRoute)) {
    if (isRead && wantsHtml(req.headers.accept) && auth.canRead(req)) return sendHtml(res, 404, renderNotFoundPage());
    return sendJson(res, 404, { error: "not found" });
  }

  // Every read route below needs read access once a token is configured (fail closed).
  const html = isUiRoute || (!!runPath && !path.startsWith("/api/") && wantsHtml(req.headers.accept));
  if (runPath) res.setHeader("vary", "Accept");
  if (!auth.canRead(req)) {
    if (html) return redirect(res, `/login?next=${encodeURIComponent(path + url.search)}`);
    return sendJson(res, 401, { error: "unauthorized" }, { "www-authenticate": 'Bearer realm="runstage-history"' });
  }
  const page = { signOut: auth.hasSession(req) };

  if (isUiRoute) {
    const filter = listFilter(url);
    return sendHtml(res, 200, renderListPage(store.list(filter), { repo: filter.repo, verdict: filter.verdict }, page));
  }
  if (!runPath) return sendJson(res, 200, store.list(listFilter(url)));

  const id = safeDecode(runPath[1]!);
  const run = id === undefined ? undefined : store.get(id);
  if (!run) return html ? sendHtml(res, 404, renderNotFoundPage(page)) : sendJson(res, 404, { error: "not found" });
  return html ? sendHtml(res, 200, renderDetailPage(run, page)) : sendJson(res, 200, run);
}

function handleLogin(auth: HistoryAuth, req: IncomingMessage, res: ServerResponse, url: URL) {
  if (req.method === "GET" || req.method === "HEAD") {
    const next = safeNext(url.searchParams.get("next"));
    if (auth.open || auth.canRead(req)) return redirect(res, next);
    return sendHtml(res, 200, renderLoginPage(next));
  }
  if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
  const client = req.socket.remoteAddress ?? "unknown";
  if (!auth.open && !auth.loginAllowed(client)) {
    req.resume();
    return sendHtml(res, 429, renderLoginPage("/", "Too many failed sign-ins. Wait a few minutes and try again."));
  }
  return readBody(req, res, MAX_LOGIN_BODY_BYTES, (body) => {
    const form = new URLSearchParams(body);
    const next = safeNext(form.get("next"));
    if (auth.open) return redirect(res, next);
    if (!auth.isReadToken(form.get("token") ?? undefined)) {
      auth.recordLoginFailure(client);
      return sendHtml(res, 401, renderLoginPage(next, "That token is not valid."));
    }
    auth.clearLoginFailures(client);
    res.setHeader("set-cookie", auth.sessionCookie(auth.issueSession()));
    redirect(res, next);
  });
}

function redirect(res: ServerResponse, location: string) {
  res.writeHead(303, { location, "cache-control": "no-store" }).end();
}

function readBody(req: IncomingMessage, res: ServerResponse, limit: number, onBody: (body: string) => void) {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > limit) {
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
    if (size > limit) {
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
      console.error(`[history] ${req.method} ${req.url}: ${(err as Error).message}`);
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

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  res
    .writeHead(status, { "content-type": "application/json", "x-content-type-options": "nosniff", "cache-control": "no-store", ...extra })
    .end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...HTML_SECURITY_HEADERS }).end(body);
}
