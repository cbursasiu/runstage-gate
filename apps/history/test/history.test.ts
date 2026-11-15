import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { RunStore, createHistoryServer } from "../src/index.ts";

describe("history stub", () => {
  it("stores runs and lists them newest first via GET /runs", async () => {
    const server = createHistoryServer(new RunStore(), "hist-token");
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const post = (body: object, token = "hist-token") =>
        fetch(`${url}/runs`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
      const run = { repoFullName: "acme/demo-app", prNumber: 42, headSha: "abc", baseSha: "def", conclusion: "failure", checks: [] };
      expect((await post(run, "nope")).status).toBe(401);
      expect((await post(run)).status).toBe(201);
      expect((await post({ ...run, prNumber: 43, conclusion: "success" })).status).toBe(201);

      const all = (await (await fetch(`${url}/runs`)).json()) as Array<{ prNumber: number }>;
      expect(all.map((r) => r.prNumber)).toEqual([43, 42]);
      const one = (await (await fetch(`${url}/runs?pr=42`)).json()) as Array<{ id: string }>;
      expect(one).toHaveLength(1);
      expect((await fetch(`${url}/runs/${one[0]!.id}`)).status).toBe(200);
    } finally {
      server.close();
    }
  });
});
