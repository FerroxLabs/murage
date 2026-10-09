// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Behaviour adapted from OpenMausBot #2394 (Apache-2.0).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { listenWebhookIngress, type WebhookIngress } from "./webhook-ingress.ts";
import { WebhookManager } from "./webhooks.ts";

let dir: string;
let ingress: WebhookIngress;
let manager: WebhookManager;
let endpointId: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "murage-webhook-flood-"));
  manager = new WebhookManager({ file: join(dir, "webhooks.json"), botState: () => "ready", enqueue: () => ({ id: "run-1" }) });
  const created = manager.create({ name: "Flood", prompt: "Review", botId: "bot-1" });
  endpointId = created.webhook.endpointId;
  ingress = await listenWebhookIngress(manager, { port: 0 });
});
afterAll(async () => {
  await new Promise<void>((resolve) => ingress.server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

it("folds wrong-secret requests into one rolling record and does not rewrite the file", async () => {
  const file = join(dir, "webhooks.json");
  const before = readFileSync(file, "utf8");
  for (let i = 0; i < 30; i++) {
    const res = await fetch(`${ingress.baseUrl}/hooks/${endpointId}/wrong-${i}`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  }
  const rejected = manager.listAttempts().filter((a) => a.outcome === "rejected" && a.statusCode === 401);
  expect(rejected).toHaveLength(1);
  expect(rejected[0]!.reason).toContain("30 requests");
  expect(readFileSync(file, "utf8")).toBe(before);
});

it("answers 401, not 500, for a malformed escape in the secret", async () => {
  const res = await fetch(`${ingress.baseUrl}/hooks/${endpointId}/%E0%A4%A`, { method: "POST", body: "{}" });
  expect(res.status).toBe(401);
});
