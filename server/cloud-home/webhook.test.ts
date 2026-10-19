import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { createWebhookIngressHandler } from "../webhook-ingress.ts";
import type { WebhookManager } from "../webhooks.ts";
afterEach(() => vi.unstubAllEnvs());
it("routes home hooks through existing secret authentication and limits each endpoint to 60 per minute", async () => {
  vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
  const manager = { authorize: (id: string, secret: string) => ["wh_one", "wh_two"].includes(id) && secret === "fixture-only", recordRejected: vi.fn(), recordUnauthorized: vi.fn(), receive: vi.fn(() => ({ queued: true })) } as unknown as WebhookManager;
  const server = createServer(createWebhookIngressHandler(manager));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture address missing");
  const request = (id: string, secret: string) => fetch(`http://127.0.0.1:${address.port}/hooks/${id}`, { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: "{}" });
  try {
    expect((await request("wh_one", "wrong")).status).toBe(401);
    for (let i = 0; i < 60; i++) expect((await request("wh_one", "fixture-only")).status).toBe(202);
    expect((await request("wh_one", "fixture-only")).status).toBe(429);
    expect((await request("wh_two", "fixture-only")).status).toBe(202);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
