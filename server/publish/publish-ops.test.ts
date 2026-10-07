// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase } from "../database.ts";
import { Store } from "../store.ts";
import { PublishOperations, PUBLISH_APPROVAL_TIMEOUT_MS, expectedFingerprint, publishAnswerAllowed, siteSlug } from "./publish-ops.ts";

const TOKEN = "nfp_SECRET_TOKEN_123";
let workspace = "";
beforeEach(() => {
  closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true });
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "publish-ops-"))); mkdirSync(join(workspace, "site"));
  writeFileSync(join(workspace, "site", "index.html"), "<html><title>My Shop</title></html>"); writeFileSync(join(workspace, "site", "style.css"), "b{}");
  writeFileSync(join(workspace, "site", ".env"), `KEY=${TOKEN}`);
});
afterEach(() => { closeDatabase(); rmSync(workspace, { recursive: true, force: true }); });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** A Netlify that records every call. */
function netlify(opts: { deploy?: Response; live?: Response; deploySite?: string } = {}) {
  const calls: string[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input), method = init?.method ?? "GET"; calls.push(`${method} ${url}`);
    if (url.startsWith("https://api.netlify.com")) {
      if (method === "POST" && url.endsWith("/sites")) return json(201, { id: "site-1", ssl_url: "https://my-shop.netlify.app" });
      if (method === "POST" && url.endsWith("/deploys")) return opts.deploy ?? json(200, { id: "dep-1", site_id: "site-1", ssl_url: "https://my-shop.netlify.app" });
      if (method === "GET" && url.includes("/deploys/")) return json(200, { id: "dep-77", site_id: opts.deploySite ?? "4f9b2c1e-1111-2222-3333-444455556666" });
      if (method === "GET") return json(200, { id: "site-1", ssl_url: "https://my-shop.netlify.app" });
      return new Response(null, { status: 204 });
    }
    return opts.live ?? new Response("<html><title>My Shop</title></html>", { status: 200 });
  });
  return { calls, fetchImpl };
}
const SITE_ID = "4f9b2c1e-1111-2222-3333-444455556666";
const owned = (siteId = SITE_ID, origin: "created" | "assigned" = "created") => ({ siteId, name: "my-shop", url: "https://my-shop.netlify.app", lastPublishedAt: 1, lastFileCount: 2, origin });
function fixture(opts: { token?: string | undefined; net?: ReturnType<typeof netlify>; sites?: ReturnType<typeof owned>[] } = {}) {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" })); const bot = store.createBot();
  if (opts.sites) store.patchBot(bot.id, { publishedSites: opts.sites });
  const controller = new AbortController();
  const net = opts.net ?? netlify(); const waiting = vi.fn();
  const operations = new PublishOperations({ store, waiting, token: () => ("token" in opts ? opts.token : TOKEN), fetchImpl: net.fetchImpl, sleep: async () => {}, workspaceFor: () => workspace });
  const actor = { botId: bot.id, threadId: bot.threadId, generation: randomUUID(), signal: controller.signal, assertActive: () => {} };
  const card = async () => { await vi.waitFor(() => expect(store.messagesFor(bot.threadId).some(m => m.card?.tool === "publish_site" && !m.card.answered)).toBe(true)); return store.messagesFor(bot.threadId).find(m => m.card?.tool === "publish_site" && !m.card.answered)!; };
  return { store, bot, actor, controller, operations, net, waiting, card };
}

it("slugs a site name into a Netlify address and fingerprints the index", () => {
  expect(siteSlug("  My Shop! 2026 ")).toBe("my-shop-2026");
  expect(siteSlug("!!!")).toBe("");
  expect(expectedFingerprint(Buffer.from("<html><title> My Shop </title></html>"))).toBe("My Shop");
  expect(expectedFingerprint(Buffer.from("<h1>Hello there</h1>"))).toBe("<h1>Hello there</h1>");
});

it("raises a publish card with the files, the size, the address and the public notice, and publishes nothing until allowed", async () => {
  const f = fixture();
  const job = f.operations.publish(f.actor, { folder: "site", name: "My Shop" });
  const message = await f.card();
  expect(message.kind).toBe("options");
  expect(message.card).toMatchObject({ kind: "publish", tool: "publish_site", options: ["Allow", "Deny"] });
  expect(message.card!.requestId).toMatch(/^publish-/);
  expect(message.card!.publish).toMatchObject({ action: "publish", siteName: "my-shop", url: "https://my-shop.netlify.app", totalBytes: 35 + 3, files: [{ path: "index.html", size: 35 }, { path: "style.css", size: 3 }], skipped: [".env"] });
  expect(message.card!.subtitle).toContain("Anyone with the link can see this");
  expect(message.card!.subtitle).toContain("https://my-shop.netlify.app");
  expect(message.card!.held).toContain("index.html");
  expect(message.card!.held).not.toContain("KEY=");
  expect(f.net.calls.filter(call => call.startsWith("POST"))).toEqual([]);
  f.operations.resolve(f.actor.threadId, message.card!.requestId!, "allow");
  const result = await job;
  expect(result).toMatchObject({ status: "live", url: "https://my-shop.netlify.app", siteId: "site-1", deployId: "dep-1", fileCount: 2 });
  expect(result.phases).toEqual(["Uploading 2 files", "Checking it loads", "Live at https://my-shop.netlify.app"]);
  expect(f.net.calls.filter(call => call.startsWith("POST"))).toEqual(["POST https://api.netlify.com/api/v1/sites", "POST https://api.netlify.com/api/v1/sites/site-1/deploys"]);
  // The progress lives on the card itself, so the owner watches one thing change.
  expect(f.store.messagesFor(f.bot.threadId).find(m => m.id === message.id)!.card!.publish!.progress).toEqual({ step: "live", fileCount: 2 });
});

it("deny means nothing is sent, and the bot is told", async () => {
  const f = fixture();
  const job = f.operations.publish(f.actor, { folder: "site", name: "shop" });
  f.operations.resolve(f.actor.threadId, (await f.card()).card!.requestId!, "deny");
  await expect(job).rejects.toMatchObject({ code: "declined" });
  expect(f.net.calls.filter(call => call.startsWith("POST"))).toEqual([]);
});

it("never auto-approves: no hook exists and a bot on Full access still gets the card", async () => {
  const f = fixture();
  f.store.patchBot?.(f.bot.id, { permissionMode: "full", autoApprove: true } as never);
  const job = f.operations.publish(f.actor, { folder: "site", name: "shop" });
  const message = await f.card();
  expect(message.card!.answered).toBeUndefined();
  expect(f.net.calls.filter(call => call.startsWith("POST"))).toEqual([]);
  expect(f.waiting).toHaveBeenCalledWith(f.actor.threadId, true, message.card!.requestId, message.id, f.bot.id);
  f.controller.abort(); await expect(job).rejects.toBeTruthy();
});

it("a card nobody answers closes after the wait and sends nothing", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    const job = f.operations.publish(f.actor, { folder: "site", name: "shop" }); const settled = job.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(PUBLISH_APPROVAL_TIMEOUT_MS + 1);
    expect(await settled).toMatchObject({ code: "unanswered" });
    expect(f.net.calls.filter(call => call.startsWith("POST"))).toEqual([]);
  } finally { vi.useRealTimers(); }
});

it("an answer for another thread or an unknown id does nothing", async () => {
  const f = fixture();
  const job = f.operations.publish(f.actor, { folder: "site", name: "shop" });
  const message = await f.card();
  expect(f.operations.resolve("other-thread", message.card!.requestId!, "allow")).toBe("unavailable");
  expect(f.operations.resolve(f.actor.threadId, "publish-unknown", "allow")).toBe("unavailable");
  expect(f.operations.resolve(f.actor.threadId, "image-1", "allow")).toBeNull();
  f.operations.cancelThread(f.actor.threadId); await expect(job).rejects.toBeTruthy();
});

it("with no token it asks to connect before any approval card appears", async () => {
  const f = fixture({ token: undefined });
  await expect(f.operations.publish(f.actor, { folder: "site", name: "shop" })).rejects.toMatchObject({ code: "reconnect" });
  expect(f.store.messagesFor(f.bot.threadId).some(m => m.card?.tool === "publish_site")).toBe(false);
});

it("refuses a bad folder or site problem before any card appears", async () => {
  const f = fixture();
  await expect(f.operations.publish(f.actor, { folder: "../elsewhere", name: "shop" })).rejects.toMatchObject({ code: "outside" });
  rmSync(join(workspace, "site", "index.html"));
  await expect(f.operations.publish(f.actor, { folder: "site", name: "shop" })).rejects.toMatchObject({ code: "no-index" });
  await expect(f.operations.publish(f.actor, { folder: "site", name: "!!!" })).rejects.toMatchObject({ code: "bad-name" });
  expect(f.store.messagesFor(f.bot.threadId).some(m => m.card?.tool === "publish_site")).toBe(false);
});

it("an update deploys to the existing site and shows its current address on the card", async () => {
  const f = fixture({ sites: [owned()] });
  const job = f.operations.publish(f.actor, { folder: "site", name: "ignored-for-update", siteId: SITE_ID });
  const message = await f.card();
  expect(message.card!.publish).toMatchObject({ action: "update", url: "https://my-shop.netlify.app" });
  f.operations.resolve(f.actor.threadId, message.card!.requestId!, "allow");
  const result = await job;
  expect(result.status).toBe("live");
  expect(f.net.calls.filter(call => call.startsWith("POST"))).toEqual(["POST https://api.netlify.com/api/v1/sites/4f9b2c1e-1111-2222-3333-444455556666/deploys"]);
});

it("a Netlify 401 after approval is a plain reconnect and a new site is rolled back", async () => {
  const net = netlify({ deploy: json(401, {}) });
  const f = fixture({ net });
  const job = f.operations.publish(f.actor, { folder: "site", name: "shop" });
  f.operations.resolve(f.actor.threadId, (await f.card()).card!.requestId!, "allow");
  await expect(job).rejects.toMatchObject({ code: "reconnect" });
  expect(net.calls).toContain("DELETE https://api.netlify.com/api/v1/sites/site-1");
});

it("429 and 5xx on the deploy give plain, retryable errors", async () => {
  for (const [status, code] of [[429, "rate-limited"], [500, "host-down"]] as const) {
    const f = fixture({ net: netlify({ deploy: json(status, {}) }) });
    const job = f.operations.publish(f.actor, { folder: "site", name: "shop" });
    f.operations.resolve(f.actor.threadId, (await f.card()).card!.requestId!, "allow");
    await expect(job).rejects.toMatchObject({ code });
  }
});

it("a site that does not load is reported plainly and a new site is rolled back", async () => {
  const net = netlify({ live: new Response("nope", { status: 404 }) });
  const f = fixture({ net });
  const job = f.operations.publish(f.actor, { folder: "site", name: "shop" });
  f.operations.resolve(f.actor.threadId, (await f.card()).card!.requestId!, "allow");
  await expect(job).rejects.toMatchObject({ code: "not-live" });
  expect(net.calls).toContain("DELETE https://api.netlify.com/api/v1/sites/site-1");
});

it("take-down raises its own publish card, then deletes the site by id; a deploy id deletes just that deploy", async () => {
  const f = fixture({ sites: [owned()] });
  const job = f.operations.takeDown(f.actor, { siteId: "4f9b2c1e-1111-2222-3333-444455556666" });
  const message = await f.card();
  expect(message.card).toMatchObject({ kind: "publish", publish: { action: "take-down", siteId: "4f9b2c1e-1111-2222-3333-444455556666" } });
  expect(message.card!.subtitle).toMatch(/removes/);
  expect(f.net.calls.filter(call => call.startsWith("DELETE"))).toEqual([]);
  f.operations.resolve(f.actor.threadId, message.card!.requestId!, "allow");
  expect(await job).toMatchObject({ status: "taken-down", siteId: "4f9b2c1e-1111-2222-3333-444455556666" });
  expect(f.net.calls.filter(call => call.startsWith("DELETE"))).toEqual(["DELETE https://api.netlify.com/api/v1/sites/4f9b2c1e-1111-2222-3333-444455556666"]);
  const g = fixture({ sites: [owned()] });
  const second = g.operations.takeDown(g.actor, { siteId: "4f9b2c1e-1111-2222-3333-444455556666", deployId: "dep-77" });
  g.operations.resolve(g.actor.threadId, (await g.card()).card!.requestId!, "allow");
  await second;
  expect(g.net.calls.filter(call => call.startsWith("DELETE"))).toEqual(["DELETE https://api.netlify.com/api/v1/deploys/dep-77"]);
});

it("the token never appears in the transcript, the results, the card, or the console", async () => {
  const spies = (["log", "info", "warn", "error", "debug"] as const).map(name => vi.spyOn(console, name).mockImplementation(() => {}));
  const f = fixture();
  const job = f.operations.publish(f.actor, { folder: "site", name: "shop" });
  const message = await f.card();
  f.operations.resolve(f.actor.threadId, message.card!.requestId!, "allow");
  const result = await job;
  const everything = JSON.stringify({ result, messages: f.store.messagesFor(f.bot.threadId), logged: spies.map(spy => spy.mock.calls) });
  expect(everything).not.toContain(TOKEN);
  expect(everything).not.toContain("KEY=");
  spies.forEach(spy => spy.mockRestore());
});

it("a version that belongs to another site is not removed", async () => {
  const f = fixture({ net: netlify({ deploySite: "someone-elses-site" }), sites: [owned()] });
  await expect(f.operations.takeDown(f.actor, { siteId: "4f9b2c1e-1111-2222-3333-444455556666", deployId: "dep-77" })).rejects.toMatchObject({ code: "bad-id" });
  expect(f.store.messagesFor(f.bot.threadId).some(m => m.card?.tool === "publish_site")).toBe(false);
  expect(f.net.calls.filter(call => call.startsWith("DELETE"))).toEqual([]);
});

it("uploads the bytes that were approved, even if the file changes while the card is open", async () => {
  const f = fixture();
  let uploaded = "";
  const original = f.net.fetchImpl.getMockImplementation()!;
  f.net.fetchImpl.mockImplementation(async (input, init) => { if (init?.body instanceof Buffer) uploaded = init.body.toString("utf8"); return original(input, init); });
  const job = f.operations.publish(f.actor, { folder: "site", name: "shop" });
  const message = await f.card();
  writeFileSync(join(workspace, "site", "index.html"), "<html><title>My Shop</title>SWAPPED</html>");
  f.operations.resolve(f.actor.threadId, message.card!.requestId!, "allow");
  await job;
  expect(uploaded).toContain("<title>My Shop</title></html>");
  expect(uploaded).not.toContain("SWAPPED");
});

it("a turn stopped after the site was created removes it and does not upload", async () => {
  const f = fixture();
  let created: () => void = () => {};
  const original = f.net.fetchImpl.getMockImplementation()!;
  f.net.fetchImpl.mockImplementation(async (input, init) => { const r = await original(input, init); if (String(input).endsWith("/sites") && init?.method === "POST") created(); return r; });
  created = () => f.controller.abort();
  const job = f.operations.publish(f.actor, { folder: "site", name: "shop" });
  f.operations.resolve(f.actor.threadId, (await f.card()).card!.requestId!, "allow");
  await expect(job).rejects.toMatchObject({ code: "cancelled" });
  expect(f.net.calls.filter(call => call.includes("/deploys") && call.startsWith("POST"))).toEqual([]);
  expect(f.net.calls).toContain("DELETE https://api.netlify.com/api/v1/sites/site-1");
});

// ---- P2: site records, ownership, progress on the card, failure copy ----
const progressOf = (f: ReturnType<typeof fixture>, id: string) => f.store.messagesFor(f.bot.threadId).find(m => m.id === id)!.card!.publish!.progress;
const publishAndAllow = async (f: ReturnType<typeof fixture>, input: Parameters<PublishOperations["publish"]>[1]) => {
  const job = f.operations.publish(f.actor, input); const settled = job.catch((e: unknown) => e);
  const message = await f.card(); f.operations.resolve(f.actor.threadId, message.card!.requestId!, "allow");
  return { message, result: await settled };
};

it("writes a site record after a publish: id, name, address, when, and how many files", async () => {
  const f = fixture();
  const before = Date.now();
  await publishAndAllow(f, { folder: "site", name: "shop" });
  const [site] = f.store.bot(f.bot.id)!.publishedSites!;
  expect(site).toMatchObject({ siteId: "site-1", name: "shop", url: "https://my-shop.netlify.app", lastFileCount: 2, origin: "created" });
  expect(site.lastPublishedAt).toBeGreaterThanOrEqual(before);
});

it("a failed or declined publish writes no record", async () => {
  const f = fixture({ net: netlify({ deploy: json(500, {}) }) });
  const { result } = await publishAndAllow(f, { folder: "site", name: "shop" });
  expect(result).toMatchObject({ code: "host-down" });
  expect(f.store.bot(f.bot.id)!.publishedSites ?? []).toEqual([]);
});

it("publishing again with the same name updates the same site, not a new one", async () => {
  const f = fixture();
  await publishAndAllow(f, { folder: "site", name: "shop" });
  f.net.calls.length = 0;
  const { message } = await publishAndAllow(f, { folder: "site", name: "Shop" });
  expect(message.card!.publish).toMatchObject({ action: "update", siteId: "site-1" });
  expect(message.card!.title).toBe("Update your live site?");
  expect(f.net.calls.filter(call => call.startsWith("POST"))).toEqual(["POST https://api.netlify.com/api/v1/sites/site-1/deploys"]);
  expect(f.store.bot(f.bot.id)!.publishedSites).toHaveLength(1);
});

it("'update my site' with no name or id redeploys the bot's only site", async () => {
  const f = fixture({ sites: [owned("site-1")] });
  const { message, result } = await publishAndAllow(f, { folder: "site" });
  expect(message.card!.publish).toMatchObject({ action: "update", siteId: "site-1" });
  expect(result).toMatchObject({ status: "live", siteId: "site-1" });
});

it("with several sites and no name or id it asks which one, before any card", async () => {
  const f = fixture({ sites: [owned("site-1"), owned("site-2")] });
  await expect(f.operations.publish(f.actor, { folder: "site" })).rejects.toMatchObject({ code: "bad-name" });
  expect(f.store.messagesFor(f.bot.threadId).some(m => m.card?.tool === "publish_site")).toBe(false);
});

it("a bot cannot update or take down a site it did not create, and nothing is asked of Netlify", async () => {
  const f = fixture();
  await expect(f.operations.publish(f.actor, { folder: "site", name: "x", siteId: SITE_ID })).rejects.toMatchObject({ code: "not-yours" });
  await expect(f.operations.takeDown(f.actor, { siteId: SITE_ID })).rejects.toMatchObject({ code: "not-yours" });
  expect(f.net.calls).toEqual([]);
  expect(f.store.messagesFor(f.bot.threadId).some(m => m.card?.tool === "publish_site")).toBe(false);
});

it("a site recorded for another bot is refused for this one", async () => {
  const f = fixture();
  const other = f.store.createBot(); f.store.patchBot(other.id, { publishedSites: [owned()] });
  await expect(f.operations.takeDown(f.actor, { siteId: SITE_ID })).rejects.toMatchObject({ code: "not-yours" });
  await expect(f.operations.publish(f.actor, { folder: "site", name: "x", siteId: SITE_ID })).rejects.toMatchObject({ code: "not-yours" });
  expect(f.net.calls).toEqual([]);
});

it("a site the owner assigned to the bot can be updated and taken down", async () => {
  const f = fixture({ sites: [owned(SITE_ID, "assigned")] });
  const { result } = await publishAndAllow(f, { folder: "site", siteId: SITE_ID });
  expect(result).toMatchObject({ status: "live" });
  expect(f.store.bot(f.bot.id)!.publishedSites![0]).toMatchObject({ siteId: SITE_ID, origin: "assigned", lastFileCount: 2 });
});

it("the owner can assign an existing site to a bot, and only then can it update it", async () => {
  const f = fixture();
  const site = await f.operations.assignSite(f.bot.id, SITE_ID);
  expect(site).toMatchObject({ siteId: SITE_ID, origin: "assigned", url: "https://my-shop.netlify.app" });
  expect(f.operations.sitesFor(f.bot.id)).toHaveLength(1);
  const { result } = await publishAndAllow(f, { folder: "site", siteId: SITE_ID });
  expect(result).toMatchObject({ status: "live" });
});

it("a take-down removes the record; removing one saved version keeps it", async () => {
  const f = fixture({ sites: [owned()] });
  const job = f.operations.takeDown(f.actor, { siteId: SITE_ID, deployId: "dep-77" });
  const first = await f.card(); f.operations.resolve(f.actor.threadId, first.card!.requestId!, "allow"); await job;
  expect(f.store.bot(f.bot.id)!.publishedSites).toHaveLength(1);
  const g = fixture({ sites: [owned()] });
  const second = g.operations.takeDown(g.actor, { siteId: SITE_ID });
  const card = await g.card(); g.operations.resolve(g.actor.threadId, card.card!.requestId!, "allow"); await second;
  expect(g.store.bot(g.bot.id)!.publishedSites ?? []).toEqual([]);
  expect(progressOf(g, card.id)).toMatchObject({ step: "taken-down" });
});

it("the take-down card names the address and says the files stay", async () => {
  const f = fixture({ sites: [owned()] });
  const job = f.operations.takeDown(f.actor, { siteId: SITE_ID }); const message = await f.card();
  expect(message.card!.title).toBe("Take this site down?");
  expect(message.card!.subtitle).toContain("https://my-shop.netlify.app");
  expect(message.card!.options).toEqual(["Allow", "Deny"]);
  f.operations.cancelThread(f.actor.threadId); await expect(job).rejects.toBeTruthy();
});

it("the card moves through uploading, checking and live, in that order", async () => {
  const f = fixture(); const steps: string[] = [];
  const patch = f.store.patchMessage.bind(f.store);
  vi.spyOn(f.store, "patchMessage").mockImplementation((threadId, id, update) => { const step = (update as { card?: { publish?: { progress?: { step: string } } } }).card?.publish?.progress?.step; if (step) steps.push(step); return patch(threadId, id, update); });
  await publishAndAllow(f, { folder: "site", name: "shop" });
  expect(steps).toEqual(["uploading", "checking", "live"]);
});

it("says what went wrong in one plain code and keeps the card as the record", async () => {
  for (const [deploy, failure] of [[json(401, {}), "reconnect"], [json(429, {}), "wait"], [json(500, {}), "wait"]] as const) {
    const f = fixture({ net: netlify({ deploy }) });
    const { message } = await publishAndAllow(f, { folder: "site", name: "shop" });
    expect(progressOf(f, message.id)).toEqual({ step: "failed", failure });
  }
  const g = fixture({ net: netlify({ live: new Response("nope", { status: 404 }) }) });
  const { message } = await publishAndAllow(g, { folder: "site", name: "shop" });
  expect(progressOf(g, message.id)).toEqual({ step: "failed", failure: "not-live" });
});

it("a site that is too big gets a failure card the owner sees, with no buttons waiting on them", async () => {
  const f = fixture();
  for (let i = 0; i < 501; i++) writeFileSync(join(workspace, "site", `f${i}.txt`), "x");
  await expect(f.operations.publish(f.actor, { folder: "site", name: "shop" })).rejects.toMatchObject({ code: "too-many-files" });
  const card = f.store.messagesFor(f.bot.threadId).find(m => m.card?.kind === "publish")!.card!;
  expect(card.publish).toMatchObject({ action: "publish", progress: { step: "failed", failure: "too-big" } });
  expect(card.requestId).toBeUndefined();
  expect(card.answered).toBeTruthy();
  expect(f.waiting).not.toHaveBeenCalled();
});

it("not connected shows one Connect Netlify card, not a failure, and not a second one on the next try", async () => {
  const f = fixture({ token: undefined });
  await expect(f.operations.publish(f.actor, { folder: "site", name: "shop" })).rejects.toMatchObject({ code: "reconnect" });
  await expect(f.operations.publish(f.actor, { folder: "site", name: "shop" })).rejects.toMatchObject({ code: "reconnect" });
  const cards = f.store.messagesFor(f.bot.threadId).filter(m => m.card?.kind === "publish");
  expect(cards).toHaveLength(1);
  expect(cards[0]!.card!.publish).toMatchObject({ action: "connect", host: "netlify", connect: { state: "needed" } });
  expect(cards[0]!.card!.requestId).toBeUndefined();
  expect(JSON.stringify(cards[0])).not.toContain(TOKEN);
});

it("the error the bot reads says a Connect Netlify card is showing and to wait for the owner", async () => {
  const f = fixture({ token: undefined });
  const error = await f.operations.publish(f.actor, { folder: "site", name: "shop" }).catch((e: Error) => e);
  expect((error as Error).message).toContain("Connect Netlify");
});

it("a token Netlify rejects after approval keeps the failure on the approval card and also offers Connect Netlify", async () => {
  const f = fixture({ net: netlify({ deploy: json(401, {}) }) });
  const { message } = await publishAndAllow(f, { folder: "site", name: "shop" });
  expect(progressOf(f, message.id)).toEqual({ step: "failed", failure: "reconnect" });
  expect(f.store.messagesFor(f.bot.threadId).filter(m => m.card?.publish?.action === "connect")).toHaveLength(1);
});

it("a connect card is settled when Netlify is connected, and a later need raises a fresh one", async () => {
  const f = fixture({ token: undefined });
  await f.operations.publish(f.actor, { folder: "site", name: "shop" }).catch(() => {});
  const card = f.store.messagesFor(f.bot.threadId).find(m => m.card?.publish?.action === "connect")!;
  expect(f.operations.markConnected(f.bot.threadId, card.id)).toBe(true);
  expect(f.store.messagesFor(f.bot.threadId).find(m => m.id === card.id)!.card!.publish!.connect).toEqual({ state: "connected", botId: f.bot.id });
  await f.operations.publish(f.actor, { folder: "site", name: "shop" }).catch(() => {});
  expect(f.store.messagesFor(f.bot.threadId).filter(m => m.card?.publish?.action === "connect")).toHaveLength(2);
});

it("no access mode, remembered grant or allow key lets a publish card skip the owner", async () => {
  for (const patch of [{ permissionMode: "full" }, { fullAccess: true }, { noLimits: true }, { autoApprove: true }, { alwaysAllow: ["publish_site", "*"] }] as const) {
    const f = fixture(); f.store.patchBot(f.bot.id, patch as never);
    const job = f.operations.publish(f.actor, { folder: "site", name: "shop" }); const settled = job.catch(() => {});
    const message = await f.card();
    expect(message.card).not.toHaveProperty("allowKey"); expect(message.card).not.toHaveProperty("taskAllowKey"); expect(message.card).not.toHaveProperty("exactAllowKey"); expect(message.card).not.toHaveProperty("routineAllowKey");
    expect(message.card!.answered).toBeUndefined();
    expect(f.net.calls.filter(call => call.startsWith("POST"))).toEqual([]);
    f.controller.abort(); await settled;
  }
});

it("the owner can take a site down from settings: only a site this bot has, and the record goes", async () => {
  const f = fixture({ sites: [owned()] });
  await expect(f.operations.ownerTakeDown(f.bot.id, "someone-elses")).rejects.toMatchObject({ code: "not-yours" });
  expect(f.net.calls).toEqual([]);
  await f.operations.ownerTakeDown(f.bot.id, SITE_ID);
  expect(f.net.calls).toEqual([`DELETE https://api.netlify.com/api/v1/sites/${SITE_ID}`]);
  expect(f.operations.sitesFor(f.bot.id)).toEqual([]);
});

it("only the computer can say yes to a publish; any door can say no", () => {
  expect(publishAnswerAllowed("publish-1", "allow", "desktop")).toBe(true);
  expect(publishAnswerAllowed("publish-1", "allow", "elsewhere")).toBe(false);
  expect(publishAnswerAllowed("publish-1", "deny", "elsewhere")).toBe(true);
  expect(publishAnswerAllowed("tool-1", "allow", "elsewhere")).toBe(true);
});

it("an owner take-down while the bot is publishing waits its turn, and a removed site is not brought back", async () => {
  const f = fixture({ sites: [owned()] });
  const job = f.operations.publish(f.actor, { folder: "site", siteId: SITE_ID }); const settled = job.catch((e: unknown) => e);
  const message = await f.card();
  await expect(f.operations.ownerTakeDown(f.bot.id, SITE_ID)).rejects.toMatchObject({ code: "cancelled" });
  f.operations.resolve(f.actor.threadId, message.card!.requestId!, "allow"); await settled;
  const g = fixture({ sites: [owned()] });
  const second = g.operations.publish(g.actor, { folder: "site", siteId: SITE_ID }); const done = second.catch((e: unknown) => e);
  const card = await g.card();
  g.store.patchBot(g.bot.id, { publishedSites: [] });
  g.operations.resolve(g.actor.threadId, card.card!.requestId!, "allow");
  expect(await done).toMatchObject({ code: "not-yours" });
  expect(g.store.bot(g.bot.id)!.publishedSites).toEqual([]);
});

// ---- P3: assign an existing site by URL or name ----
it("assigns an existing site from a pasted address, a bare name or an id, looked up with the owner's token", async () => {
  for (const reference of ["https://my-shop.netlify.app/", "http://my-shop.netlify.app/some/page?x=1", "my-shop.netlify.app", "my-shop", "  My-Shop  ", SITE_ID]) {
    const net = netlify(); const f = fixture({ net });
    const site = await f.operations.assignSite(f.bot.id, reference);
    expect(site).toMatchObject({ origin: "assigned", url: "https://my-shop.netlify.app" });
    expect(net.calls.filter(call => call.startsWith("GET")).length).toBe(1);
    expect(net.calls[0]).toMatch(/^GET https:\/\/api\.netlify\.com\/api\/v1\/sites\/(my-shop(\.netlify\.app)?|4f9b2c1e-1111-2222-3333-444455556666)$/);
  }
});

it("records the id Netlify reports for a looked-up name, so later updates use the real id", async () => {
  const net = netlify(); const f = fixture({ net });
  const site = await f.operations.assignSite(f.bot.id, "my-shop");
  expect(site.siteId).toBe("site-1");
  expect(f.operations.sitesFor(f.bot.id)[0]!.siteId).toBe("site-1");
});

it("refuses an address that is not a Netlify site or a plain name, before any call", async () => {
  for (const reference of ["", "   ", "https://evil.example/", "javascript:alert(1)", "http://localhost:3000", "a b c", "../../etc", "x".repeat(300)]) {
    const net = netlify(); const f = fixture({ net });
    await expect(f.operations.assignSite(f.bot.id, reference)).rejects.toMatchObject({ code: expect.stringMatching(/bad-name|bad-id/) });
    expect(net.calls).toEqual([]);
    expect(f.operations.sitesFor(f.bot.id)).toEqual([]);
  }
});

it("a site Netlify does not know is a plain not-found and nothing is assigned", async () => {
  const net = { calls: [] as string[], fetchImpl: vi.fn<typeof fetch>(async () => json(404, {})) };
  const f = fixture({ net });
  await expect(f.operations.assignSite(f.bot.id, "nope")).rejects.toMatchObject({ code: "not-found" });
  expect(f.operations.sitesFor(f.bot.id)).toEqual([]);
});

it("with no token, assigning asks to connect and does not look anything up", async () => {
  const net = netlify(); const f = fixture({ token: undefined, net });
  await expect(f.operations.assignSite(f.bot.id, "my-shop")).rejects.toMatchObject({ code: "reconnect" });
  expect(net.calls).toEqual([]);
});

// ---- P3: the rollback orphan ----
/** Netlify where the new site is created, the deploy fails, and the clean-up delete fails too. */
function netlifyWhereDeleteFails() {
  const calls: string[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input), method = init?.method ?? "GET"; calls.push(`${method} ${url}`);
    if (method === "POST" && url.endsWith("/sites")) return json(201, { id: "site-9", ssl_url: "https://shop.netlify.app" });
    if (method === "POST") return json(500, {});
    if (method === "DELETE") return json(500, {});
    return json(200, {});
  });
  return { calls, fetchImpl };
}

it("when a new site was created and publishing fails, the new site is deleted and not recorded", async () => {
  const net = netlify({ deploy: json(500, {}) }); const f = fixture({ net });
  await publishAndAllow(f, { folder: "site", name: "shop" });
  expect(net.calls).toContain("DELETE https://api.netlify.com/api/v1/sites/site-1");
  expect(f.operations.sitesFor(f.bot.id)).toEqual([]);
});

it("when that delete fails too, the site is listed as needing attention so it is never public and untracked", async () => {
  const net = netlifyWhereDeleteFails(); const f = fixture({ net });
  const { message } = await publishAndAllow(f, { folder: "site", name: "shop" });
  expect(progressOf(f, message.id)).toMatchObject({ step: "failed" });
  expect(f.operations.sitesFor(f.bot.id)).toEqual([expect.objectContaining({ siteId: "site-9", url: "https://shop.netlify.app", origin: "created", needsAttention: true })]);
});

it("a site that needs attention can be taken down from the list, and then it is gone from the list", async () => {
  const net = netlifyWhereDeleteFails(); const f = fixture({ net });
  await publishAndAllow(f, { folder: "site", name: "shop" });
  const healthy = netlify(); const g = new PublishOperations({ store: f.store, waiting: vi.fn(), token: () => TOKEN, fetchImpl: healthy.fetchImpl, workspaceFor: () => workspace });
  await g.ownerTakeDown(f.bot.id, "site-9");
  expect(healthy.calls).toContain("DELETE https://api.netlify.com/api/v1/sites/site-9");
  expect(g.sitesFor(f.bot.id)).toEqual([]);
});

it("the needs-attention note is dropped by a later successful publish to that site", async () => {
  const f = fixture({ sites: [{ ...owned("site-1"), needsAttention: true } as never] });
  await publishAndAllow(f, { folder: "site", siteId: "site-1" });
  expect(f.operations.sitesFor(f.bot.id)[0]).not.toHaveProperty("needsAttention");
});

// ---- P3: restored records ----
it("records that came back from a restore stay as they are, and every operation on them still waits for the owner", async () => {
  const f = fixture({ sites: [owned(), { ...owned("site-7"), name: "other", url: "https://other.netlify.app", origin: "assigned" } as never] });
  const reopened = f.operations.sitesFor(f.bot.id);
  expect(reopened).toHaveLength(2);
  const job = f.operations.publish(f.actor, { folder: "site", siteId: SITE_ID }); const settled = job.catch(() => {});
  const card = await f.card();
  expect(card.card!.requestId).toMatch(/^publish-/);
  expect(f.net.calls.filter(call => call.startsWith("POST"))).toEqual([]);
  f.controller.abort(); await settled;
  expect(f.operations.sitesFor(f.bot.id)).toEqual(reopened);
});

it("the connect card remembers which bot asked, so a group chat can resume that bot", async () => {
  const f = fixture({ token: undefined });
  await f.operations.publish(f.actor, { folder: "site", name: "shop" }).catch(() => {});
  const card = f.store.messagesFor(f.bot.threadId).find(m => m.card?.publish?.action === "connect")!;
  expect(f.operations.connectBot(f.bot.threadId, card.id)).toBe(f.bot.id);
  expect(f.operations.connectBot(f.bot.threadId, "nope")).toBeUndefined();
});

// ---- P3 cross-review fixes ----
it("when saving the site record fails after a new site went live, the new site is removed", async () => {
  const net = netlify(); const f = fixture({ net });
  const patch = vi.spyOn(f.store, "patchBot").mockImplementation(() => { throw new Error("disk full"); });
  const { message } = await publishAndAllow(f, { folder: "site", name: "shop" });
  patch.mockRestore();
  expect(net.calls).toContain("DELETE https://api.netlify.com/api/v1/sites/site-1");
  expect(progressOf(f, message.id)).toMatchObject({ step: "failed" });
});

it("a bot whose site list is full is refused before a new site is made", async () => {
  const sites = Array.from({ length: 200 }, (_, i) => ({ ...owned(`id-${i}`), name: `s${i}` }));
  const net = netlify(); const f = fixture({ net, sites });
  await expect(f.operations.publish(f.actor, { folder: "site", name: "brand-new" })).rejects.toMatchObject({ code: "bad-name" });
  expect(net.calls).toEqual([]);
});
