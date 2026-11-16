import { createServer, type Server, type ServerResponse } from "node:http";
import type { GateConclusion } from "@runstage-gate/core";
import type { RunStore, NewRun, RunListFilter } from "./store.ts";
import { renderDetailPage, renderListPage, renderNotFoundPage, wantsHtml } from "./html.ts";

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
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (req.method === "GET" && path === "/") {
      const filter = listFilter(url);
      return sendHtml(res, 200, renderListPage(store.list(filter), { repo: filter.repo, verdict: filter.verdict }));
    }

    if (req.method === "GET" && (path === "/runs" || path === "/api/runs")) {
      return sendJson(res, 200, store.list(listFilter(url)));
    }

    const runPath = /^\/(?:api\/)?runs\/([^/]+)$/.exec(path);
    if (req.method === "GET" && runPath) {
      const id = decodeURIComponent(runPath[1]!);
      const run = store.get(id);
      const html = path.startsWith("/api/") ? false : wantsHtml(req.headers.accept);
      if (!run) return html ? sendHtml(res, 404, renderNotFoundPage()) : sendJson(res, 404, { error: "not found" });
      return html ? sendHtml(res, 200, renderDetailPage(run)) : sendJson(res, 200, run);
    }

    if (req.method === "POST" && path === "/runs") {
      if (token && req.headers.authorization !== `Bearer ${token}`) return sendJson(res, 401, { error: "unauthorized" });
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const run = JSON.parse(body) as NewRun;
          if (!run.repoFullName || !run.headSha || !run.conclusion) return sendJson(res, 400, { error: "missing fields" });
          sendJson(res, 201, store.add(run));
        } catch {
          sendJson(res, 400, { error: "invalid JSON" });
        }
      });
      return;
    }

    if (wantsHtml(req.headers.accept) && req.method === "GET") return sendHtml(res, 404, renderNotFoundPage());
    sendJson(res, 404, { error: "not found" });
  });
}

function listFilter(url: URL): RunListFilter {
  const pr = url.searchParams.get("pr");
  const verdict = url.searchParams.get("verdict");
  return {
    repo: url.searchParams.get("repo") ?? undefined,
    pr: pr ? Number(pr) : undefined,
    verdict: parseVerdict(verdict),
  };
}

function parseVerdict(value: string | null): GateConclusion | undefined {
  return value === "success" || value === "failure" ? value : undefined;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(body);
}

