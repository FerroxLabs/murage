// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// Images made without an approval card (server/image-approval.ts decides when).
// ImageOperations is handed that decision; these tests pin what it does with
// it: no card, a compact record with the full prompt, Stop still cancels, the
// library still gets the image and its kept prompt, and a decision that says
// "ask" leaves the card exactly as it was.
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { Store } from "./store.ts";
import { ImageOperations, type ImageAutoApproval, type ImageAutoAsk } from "./image-operations.ts";
import { decideImageApproval } from "./image-approval.ts";
import { ImageGenerationService } from "./image-generation.ts";
import { renderPrompt } from "./image-library.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");
const LONG = "A very long image prompt. ".repeat(40).trim();
beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => closeDatabase());

function fixture(decide: (ask: ImageAutoAsk) => ImageAutoApproval | null, extra: { speaker?: ConstructorParameters<typeof ImageOperations>[0]["speaker"] } = {}) {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" })); const bot = store.createBot();
  const controller = new AbortController();
  const actor = { botId: bot.id, threadId: bot.threadId, generation: randomUUID(), signal: controller.signal, assertActive: () => {} };
  const waiting = vi.fn();
  const asked = vi.fn((_actor: unknown, ask: ImageAutoAsk) => decide(ask));
  const logged = vi.fn();
  const operations = new ImageOperations({ store, waiting, autoApproval: asked, autoApprovalLogged: logged, ...extra });
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] })));
  const service = new ImageGenerationService({ resolveConnection: () => ({ id: "flux", provider: "flux", apiKey: "FAKE_AUTO", revision: "1" }), connectionIds: () => ["flux"], fetch: fetcher });
  const run = (id: string, request: Record<string, unknown> = { connectionId: "flux", prompt: LONG }) =>
    operations.execute(actor, id, request, (reserve, publish, context) => service.generate(request, { reserve, publish, assertActive: actor.assertActive, signal: actor.signal, operationId: context.operationId }, []));
  const cards = () => store.messagesFor(bot.threadId).filter(m => m.card?.tool === "generate_image");
  const records = () => store.messagesFor(bot.threadId).filter(m => m.tool?.imageRecord);
  return { store, bot, actor, controller, operations, waiting, asked, logged, fetcher, service, run, cards, records };
}

it("makes the image with no card when the decision says so, and keeps the record, the library entry and the image", async () => {
  const f = fixture(() => ({ basis: "Full access" }));
  const result = await f.run("auto");
  expect(f.fetcher).toHaveBeenCalledOnce();
  expect(f.cards()).toHaveLength(0);
  expect(f.waiting.mock.calls.filter(call => call[1] === true)).toHaveLength(0);
  // the image lands in the conversation and in Files, as an approved one does
  expect(result.artifact.url).toMatch(/^\/api\/attachments\//);
  expect(result.artifact.artifactId).toBeTruthy();
  expect(f.store.messagesFor(f.actor.threadId).some(m => m.attachments?.some(a => a.kind === "image"))).toBe(true);
  // the full prompt is kept for the library, exactly as after an approval
  const op = database().prepare("SELECT id FROM image_operations WHERE generation=?").get(f.actor.generation) as { id: string };
  expect(renderPrompt(database(), op.id)?.prompt).toContain(LONG);
});

it("posts a compact record: what was asked for, the basis, and the whole prompt", async () => {
  const f = fixture(() => ({ basis: "No limits" }));
  await f.run("record");
  const [record] = f.records();
  expect(f.records()).toHaveLength(1);
  expect(record.role).toBe("bot");
  expect(record.kind).toBe("activity");
  expect(record.tool?.name).toBe("Making an image without asking (No limits)");
  expect(record.tool?.ok).toBe(true);
  expect(record.tool?.imageRecord?.prompt).toContain(LONG);
  expect(record.tool?.imageRecord?.summary).toMatch(/^One image · /);
});

it("never records a secret the prompt carried", async () => {
  const f = fixture(() => ({ basis: "Full access" }));
  const tail = "ABCDEFGHIJKLMNOPQRSTUVWX1234567890", key = ["sk", "proj", tail].join("-");
  await f.run("secret", { connectionId: "flux", prompt: `a logo, key ${key}` });
  expect(JSON.stringify(f.records()[0]?.tool)).not.toContain(tail);
});

it("a record in a channel carries its sender like the approval card does", async () => {
  const f = fixture(() => ({ basis: "Full access" }), { speaker: () => ({ botId: "b1", name: "Pax", color: "blue" } as never) });
  await f.run("room");
  expect(f.records()[0]?.from).toMatchObject({ name: "Pax" });
});

it("still raises the card when the decision says ask", async () => {
  const f = fixture(() => null);
  const job = f.run("asks");
  await vi.waitFor(() => expect(f.cards()).toHaveLength(1));
  expect(f.records()).toHaveLength(0);
  expect(f.fetcher).not.toHaveBeenCalled();
  f.operations.resolve(f.actor.threadId, f.cards()[0].card!.requestId!, "allow"); await job;
  expect(f.fetcher).toHaveBeenCalledOnce();
});

it("asks with the request's own image count and what this turn already made, so a guard can see both", async () => {
  const seen: ImageAutoAsk[] = [];
  const f = fixture(ask => { seen.push(ask); return null; });
  const detail = { connectionId: "flux", provider: "flux" as const, model: "m", operation: "generate" as const, count: 4, referenceCount: 0 };
  const job = f.operations.execute(f.actor, "count", { prompt: "four" }, async reserve => { await reserve(detail, { prompt: "four" }); }).catch(() => undefined);
  await vi.waitFor(() => expect(f.cards()).toHaveLength(1));
  expect(seen.filter(ask => ask.count === 4)).toEqual([{ count: 4, madeThisTurn: 0 }]);
  f.operations.resolve(f.actor.threadId, f.cards()[0].card!.requestId!, "deny"); await job;
});

it("Stop still cancels: a turn stopped before the render starts makes nothing", async () => {
  const f = fixture(() => ({ basis: "Full access" }));
  f.controller.abort();
  await expect(f.run("stopped")).rejects.toThrow();
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(f.cards()).toHaveLength(0);
});

it("a turn stopped while the render is under way makes no image", async () => {
  const f = fixture(() => ({ basis: "Full access" }));
  f.fetcher.mockImplementationOnce(async (_input, init) => { f.controller.abort(); if (init?.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" }); return new Response("{}"); });
  await expect(f.run("stopped-mid")).rejects.toThrow();
  expect(f.store.messagesFor(f.actor.threadId).some(m => m.attachments?.some(a => a.kind === "image"))).toBe(false);
});

it("a decision that throws asks instead of making the image", async () => {
  const f = fixture(() => { throw new Error("level unreadable"); });
  const job = f.run("throws");
  await vi.waitFor(() => expect(f.cards()).toHaveLength(1));
  expect(f.fetcher).not.toHaveBeenCalled();
  f.operations.resolve(f.actor.threadId, f.cards()[0].card!.requestId!, "deny"); await job.catch(() => undefined);
});

it("a repeated request_id is not decided twice", async () => {
  const f = fixture(() => ({ basis: "Full access" }));
  await f.run("again");
  const before = f.asked.mock.calls.length;
  await f.run("again");
  expect(f.asked.mock.calls.length).toBe(before);
});

// Gap B: several images in one turn, on the no-card path only.
const FULL = { autoApprove: true, fullAccess: true };
const level = (askAfter?: number) => (ask: ImageAutoAsk): ImageAutoApproval | null => {
  const d = decideImageApproval({ level: FULL, origin: "owner", ownerAudience: true, askAfter, ...ask });
  return d.ask ? null : { basis: d.basis };
};
const request = (n: number, extra: Record<string, unknown> = {}) => ({ connectionId: "flux", prompt: `scene ${n}`, ...extra });

it("two sequential automatic requests in one turn both render, with no card", async () => {
  const f = fixture(level());
  const first = await f.run("one", request(1));
  const second = await f.run("two", request(2));
  expect(first.artifact.id).not.toBe(second.artifact.id);
  expect(f.fetcher).toHaveBeenCalledTimes(2);
  expect(f.cards()).toHaveLength(0);
  expect(f.records()).toHaveLength(2);
  // the second decision saw the first image
  expect(f.asked.mock.calls.map(call => call[1])).toContainEqual({ count: 1, madeThisTurn: 1 });
});

it("a repeat of an automatic request_id still resumes the same render and makes no second one", async () => {
  const f = fixture(level());
  await f.run("same", request(1));
  await f.run("same", request(1));
  expect(f.fetcher).toHaveBeenCalledOnce();
});

it("a second request while the first is uncertain is refused with 409 and no provider call", async () => {
  const f = fixture(level());
  f.fetcher.mockImplementationOnce(async () => { throw Error("lost response"); });
  await expect(f.run("lost", request(1))).rejects.toThrow();
  const sent = f.fetcher.mock.calls.length;
  expect(() => f.run("fresh-id", request(2))).toThrow(/earlier image request|billing/i);
  try { f.run("fresh-id", request(2)); } catch (error) { expect((error as { status?: number }).status).toBe(409); }
  expect(f.fetcher.mock.calls.length).toBe(sent);
});

it("a second request after the first never reached a provider (not dispatched) is allowed", async () => {
  const f = fixture(level());
  await expect(f.operations.execute(f.actor, "no-send", request(1), async () => { throw new Error("failed before any provider request"); })).rejects.toThrow();
  const row = database().prepare("SELECT state FROM image_operations WHERE generation=?").get(f.actor.generation) as { state: string };
  expect(row.state).toBe("not-dispatched");
  await f.run("after", request(2));
  expect(f.fetcher).toHaveBeenCalledOnce();
});

it("a guard of 3 lets 2 images through and brings the card back for the next 2", async () => {
  const f = fixture(level(3));
  const batch = (id: string, count: number) => f.operations.execute(f.actor, id, { prompt: id }, async (reserve, publish) => {
    const detail = { connectionId: "flux", provider: "flux" as const, model: "m", operation: "generate" as const, count, referenceCount: 0 };
    const ticket = await reserve(detail, { prompt: id });
    const artifacts = [];
    for (let i = 0; i < count; i++) artifacts.push(await publish({ bytes: png, mime: "image/png" }, { ...detail, imageIndex: i } as never));
    ticket.finish("published");
    return { artifact: artifacts[0], artifacts, metadata: detail };
  });
  await batch("a", 2);
  expect(f.cards()).toHaveLength(0);
  const job = batch("b", 2);
  await vi.waitFor(() => expect(f.cards()).toHaveLength(1));
  expect(f.cards()[0].card?.title).toBe("Approve image generation");
  expect(f.asked.mock.calls.map(call => call[1])).toContainEqual({ count: 2, madeThisTurn: 2 });
  f.operations.resolve(f.actor.threadId, f.cards()[0].card!.requestId!, "allow");
  await job;
  expect(f.records()).toHaveLength(1);
});

it("on the card path (Ask level) the second request is still refused with 429", async () => {
  const f = fixture(() => null);
  const first = f.run("one", request(1));
  await vi.waitFor(() => expect(f.cards()).toHaveLength(1));
  f.operations.resolve(f.actor.threadId, f.cards()[0].card!.requestId!, "allow");
  await first;
  try { f.run("two", request(2)); throw new Error("not refused"); } catch (error) {
    expect((error as { status?: number }).status).toBe(429);
    expect((error as Error).message).toContain("One image attempt");
  }
  expect(f.fetcher).toHaveBeenCalledOnce();
});

it("the 429 says what applies on each path", async () => {
  const f = fixture(() => null);
  const first = f.run("one", request(1));
  await vi.waitFor(() => expect(f.cards()).toHaveLength(1));
  f.operations.resolve(f.actor.threadId, f.cards()[0].card!.requestId!, "allow");
  await first;
  expect(() => f.run("two", request(2))).toThrow(/without asking/);
});

it("writes the decision log once the image is really going ahead, never for a turn already stopped", async () => {
  const f = fixture(() => ({ basis: "Full access" }));
  await f.run("logged", request(1));
  expect(f.logged).toHaveBeenCalledOnce();
  expect(f.logged.mock.calls[0][2]).toEqual({ basis: "Full access" });
  const stopped = fixture(() => ({ basis: "Full access" }));
  stopped.controller.abort();
  await expect(stopped.run("stopped", request(1))).rejects.toThrow();
  expect(stopped.logged).not.toHaveBeenCalled();
});
