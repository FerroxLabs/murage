// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase } from "../database.ts";
import { Store } from "../store.ts";
import { validInstallationMessagePayload } from "../installation-message-validation.ts";
import { readPublishCard } from "../../shared/publish-card.ts";
import { PublishOperations } from "./publish-ops.ts";

let workspace = "";
beforeEach(() => {
  closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true });
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "publish-persist-"))); mkdirSync(join(workspace, "site"));
  writeFileSync(join(workspace, "site", "index.html"), "<html><title>My Shop</title></html>");
});
afterEach(() => { closeDatabase(); rmSync(workspace, { recursive: true, force: true }); });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const netlify = vi.fn<typeof fetch>(async (input, init) => {
  const url = String(input), method = init?.method ?? "GET";
  if (url.startsWith("https://api.netlify.com")) {
    if (method === "POST" && url.endsWith("/sites")) return json(201, { id: "site-1", ssl_url: "https://shop.netlify.app" });
    if (method === "POST") return json(200, { id: "dep-1", site_id: "site-1", ssl_url: "https://shop.netlify.app" });
    return json(200, { id: "site-1", ssl_url: "https://shop.netlify.app" });
  }
  return new Response("<html><title>My Shop</title></html>", { status: 200 });
});

it("a publish card, with its progress, is a valid stored message and survives a restart", async () => {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" })); const bot = store.createBot();
  const operations = new PublishOperations({ store, waiting: () => {}, token: () => "tok", fetchImpl: netlify, sleep: async () => {}, workspaceFor: () => workspace });
  const actor = { botId: bot.id, threadId: bot.threadId, generation: randomUUID(), signal: new AbortController().signal, assertActive: () => {} };
  const job = operations.publish(actor, { folder: "site", name: "shop" });
  await vi.waitFor(() => expect(store.messagesFor(bot.threadId).some(m => m.card?.kind === "publish")).toBe(true));
  const pendingCard = store.messagesFor(bot.threadId).find(m => m.card?.kind === "publish")!;
  expect(validInstallationMessagePayload(pendingCard)).toBe(true);
  operations.resolve(bot.threadId, pendingCard.card!.requestId!, "allow");
  await job;
  closeDatabase();
  const reopened = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const restored = reopened.messagesFor(bot.threadId).find(m => m.card?.kind === "publish")!;
  expect(validInstallationMessagePayload(restored)).toBe(true);
  const data = readPublishCard(restored.card)!;
  expect(data).toMatchObject({ action: "publish", url: "https://shop.netlify.app", progress: { step: "live", fileCount: 1 }, files: [{ path: "index.html" }] });
  expect(reopened.bot(bot.id)!.publishedSites).toHaveLength(1);
});

it("a malformed publish payload is refused, not repaired", () => {
  const base = { kind: "options", card: { title: "Publish this site?", options: ["Allow", "Deny"], kind: "publish", publish: { action: "publish", host: "netlify", url: "https://shop.netlify.app" } } };
  expect(validInstallationMessagePayload(base)).toBe(true);
  expect(validInstallationMessagePayload({ ...base, card: { ...base.card, publish: { ...base.card.publish, action: "delete-everything" } } })).toBe(false);
  expect(validInstallationMessagePayload({ ...base, card: { ...base.card, publish: { ...base.card.publish, progress: { step: "teleporting" } } } })).toBe(false);
  expect(readPublishCard({ ...base.card, publish: { ...base.card.publish, url: "javascript:alert(1)" } })).toBeNull();
});
