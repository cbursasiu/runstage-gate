import { createServer, type Server, type ServerResponse } from "node:http";
import type { RunStore, NewRun } from "./store.ts";

/**
 * GET  /runs?repo=owner/name&pr=12   list runs, newest first
 * GET  /runs/:id                     one run
 * POST /runs                         record a run (bearer token when HISTORY token is set)
 */
export function createHistoryServer(store: RunStore, token?: string): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/runs") {
      const pr = url.searchParams.get("pr");
      return send(res, 200, store.list({ repo: url.searchParams.get("repo") ?? undefined, pr: pr ? Number(pr) : undefined }));
    }
    const m = /^\/runs\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && m) {
      const run = store.get(decodeURIComponent(m[1]!));
      return run ? send(res, 200, run) : send(res, 404, { error: "not found" });
    }
    if (req.method === "POST" && url.pathname === "/runs") {
      if (token && req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { error: "unauthorized" });
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const run = JSON.parse(body) as NewRun;
          if (!run.repoFullName || !run.headSha || !run.conclusion) return send(res, 400, { error: "missing fields" });
          send(res, 201, store.add(run));
        } catch {
          send(res, 400, { error: "invalid JSON" });
        }
      });
      return;
    }
    send(res, 404, { error: "not found" });
  });
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}
