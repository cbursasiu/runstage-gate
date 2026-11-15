import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Webhooks } from "@octokit/webhooks";
import { vi } from "vitest";
import type { ChecksClient } from "../src/index.ts";

export function mockChecksClient() {
  const create = vi.fn(async (_p: Parameters<ChecksClient["rest"]["checks"]["create"]>[0]) => ({ data: { id: 314 } }));
  const update = vi.fn(async (_p: Parameters<ChecksClient["rest"]["checks"]["update"]>[0]) => ({}));
  const client: ChecksClient = { rest: { checks: { create, update } } };
  const factory = vi.fn(async (_installationId: number) => client);
  return { client, create, update, factory };
}

export async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export async function sendWebhook(url: string, secret: string, event: string, payload: unknown, signature?: string) {
  const body = JSON.stringify(payload);
  const sig = signature ?? (await new Webhooks({ secret }).sign(body));
  return fetch(`${url}/webhooks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": `test-${Math.random()}`,
      "x-hub-signature-256": sig,
    },
    body,
  });
}
