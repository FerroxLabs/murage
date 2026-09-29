// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
// Image operations v2: several images from one approval, each retained and
// resumable; a provider job kept on the operation row and resumed by the
// same request_id without a second render or a second card.
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { Store } from "./store.ts";
import { ImageOperations } from "./image-operations.ts";
import { ImageGenerationService, type ImageProvider } from "./image-generation.ts";

const faults = vi.hoisted(() => ({ saveImage: 0 }));
vi.mock("./attachments.ts", async importOriginal => {
  const actual = await importOriginal<typeof import("./attachments.ts")>();
  return { ...actual, saveImage: (...args: Parameters<typeof actual.saveImage>) => {
    if (faults.saveImage > 0) { faults.saveImage--; throw Object.assign(new Error("attachments storage is full"), { status: 507 }); }
    return actual.saveImage(...args);
  } };
});
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PNG_B = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=";
beforeEach(() => { faults.saveImage = 0; closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => closeDatabase());

const json = (value: unknown, init?: ResponseInit) => new Response(JSON.stringify(value), init);
function fixture(provider: ImageProvider, fetcher: ReturnType<typeof vi.fn<typeof fetch>>, options: { fluxCatalogue?: boolean } = {}) {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" })); const bot = store.createBot();
  const controller = new AbortController();
  const actor = { botId: bot.id, threadId: bot.threadId, generation: randomUUID(), signal: controller.signal, assertActive: () => {} };
  const waiting = vi.fn(), operations = new ImageOperations({ store, waiting });
  let now = 0;
  const service = new ImageGenerationService({ resolveConnection: () => ({ id: provider, provider, apiKey: "FAKE_OPS_V2", revision: "1" }), connectionIds: () => [provider], fetch: fetcher,
    fluxCatalogue: options.fluxCatalogue, sleep: async ms => { now += ms; }, now: () => now });
  const run = (id: string, request: Record<string, unknown>) => operations.execute(actor, id, request, (reserve, publish, context) =>
    service.generate(request, { reserve, publish, assertActive: actor.assertActive, signal: actor.signal, operationId: context.operationId, resumeJob: context.resumeJob, jobStarted: context.jobStarted }));
  const cards = () => store.messagesFor(bot.threadId).filter(message => message.card?.tool === "generate_image");
  const approve = async () => { await vi.waitFor(() => expect(cards().some(message => !message.card!.answered)).toBe(true)); const card = cards().find(message => !message.card!.answered)!; operations.resolve(bot.threadId, card.card!.requestId!, "allow"); return card; };
  const images = () => store.messagesFor(bot.threadId).filter(message => message.role === "bot" && message.attachments?.some(item => item.kind === "image"));
  const row = () => database().prepare("SELECT state,result FROM image_operations WHERE generation=?").get(actor.generation) as { state: string; result: string | null };
  return { store, actor, operations, run, cards, approve, images, row };
}

it("publishes every image of one approved n > 1 render as its own conversation image", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => json({ data: [{ b64_json: PNG }, { b64_json: PNG_B }] }));
  const f = fixture("openai", fetcher);
  const job = f.run("two", { connectionId: "openai", prompt: "Two versions", n: 2 });
  const card = await f.approve();
  expect(card.card!.subtitle).toContain("2 images · openai · gpt-image-2");
  const result = await job as { artifacts: unknown[] };
  expect(result.artifacts).toHaveLength(2); expect(f.images()).toHaveLength(2);
  expect(f.images()[1]!.text).toContain("(image 2 of 2)");
  expect(fetcher).toHaveBeenCalledOnce(); expect(f.row().state).toBe("published");
});

it("keeps every image of a multi-image render when publishing one fails, and finishes all of them on the same request_id", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => json({ data: [{ b64_json: PNG }, { b64_json: PNG_B }] }));
  const f = fixture("openai", fetcher);
  faults.saveImage = 1;
  const job = f.run("kept", { connectionId: "openai", prompt: "Two versions", n: 2 }), refusal = expect(job).rejects.toThrow("kept locally");
  await f.approve(); await refusal;
  expect(f.row().state).toBe("publish-pending");
  expect(JSON.parse(f.row().result!).pending.receiptIds).toHaveLength(2);
  const resumed = await f.run("kept", { connectionId: "openai", prompt: "Two versions", n: 2 }) as { artifacts: Array<{ artifactId?: string }> };
  expect(resumed.artifacts).toHaveLength(2); expect(resumed.artifacts.every(artifact => artifact.artifactId)).toBe(true);
  expect(f.images()).toHaveLength(2); expect(fetcher).toHaveBeenCalledOnce(); expect(f.cards()).toHaveLength(1);
  expect(f.row().state).toBe("published");
});

it("stores a provider job id before polling and resumes the same job on the same request_id, with no second render or card", async () => {
  const catalogue = { contract: 1, kind: "image-catalogue", data: [{ id: "flux-image-gpt25-sunburst", operations: ["generate"], maxPromptChars: 32000,
    sizeRule: { kind: "list", sizes: ["1024x1024"] }, qualities: ["high", "xhigh"], qualityMode: "param", maxReferences: 4, supports: { n: 1 }, delivery: { jobs: true }, expectedSeconds: { xhigh: 120 } }] };
  let pollsWork = false;
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/v1/images/models")) return json(catalogue);
    if (init?.method === "POST") return json({ contract: 1, kind: "image-job", id: "imgjob_42", status: "queued", poll_after_s: 5 }, { status: 202 });
    if (!pollsWork) throw new Error("ECONNRESET");
    return json({ contract: 1, kind: "image-job", id: "imgjob_42", status: "succeeded", data: [{ b64_json: PNG }] });
  });
  const f = fixture("flux", fetcher, { fluxCatalogue: true });
  const request = { connectionId: "flux", model: "flux-image-gpt25-sunburst", quality: "xhigh", prompt: "A slow render" };
  const first = f.run("slow", request), refusal = expect(first).rejects.toMatchObject({ code: "job-uncertain", message: expect.stringContaining("imgjob_42") });
  await f.approve(); await refusal;
  expect(f.row().state).toBe("uncertain"); expect(JSON.parse(f.row().result!).job).toEqual({ id: "imgjob_42" });
  pollsWork = true;
  const posts = () => fetcher.mock.calls.filter(([, init]) => init?.method === "POST").length;
  expect(posts()).toBe(1);
  const resumed = await f.run("slow", request) as { metadata: { jobId: string } };
  expect(resumed.metadata.jobId).toBe("imgjob_42");
  expect(posts()).toBe(1); expect(f.cards()).toHaveLength(1); expect(f.images()).toHaveLength(1); expect(f.row().state).toBe("published");
});

it("review: a provider job started in an earlier turn is found again by request_id in a later turn, with no second render or card", async () => {
  const catalogue = { contract: 1, kind: "image-catalogue", data: [{ id: "flux-image-gpt25-sunburst", operations: ["generate"], maxPromptChars: 32000,
    sizeRule: { kind: "list", sizes: ["1024x1024"] }, qualities: ["high", "xhigh"], qualityMode: "param", maxReferences: 4, supports: { n: 1 }, delivery: { jobs: true }, expectedSeconds: { xhigh: 120 } }] };
  let pollsWork = false;
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    if (String(input).endsWith("/v1/images/models")) return json(catalogue);
    if (init?.method === "POST") return json({ contract: 1, kind: "image-job", id: "imgjob_77", status: "queued", poll_after_s: 5 }, { status: 202 });
    if (!pollsWork) throw new Error("ECONNRESET");
    return json({ contract: 1, kind: "image-job", id: "imgjob_77", status: "succeeded", data: [{ b64_json: PNG }] });
  });
  const f = fixture("flux", fetcher, { fluxCatalogue: true });
  const request = { connectionId: "flux", model: "flux-image-gpt25-sunburst", quality: "xhigh", prompt: "A slow render" };
  const first = f.run("later", request), refusal = expect(first).rejects.toMatchObject({ code: "job-uncertain" });
  await f.approve(); await refusal;
  pollsWork = true;
  (f.actor as { generation: string }).generation = randomUUID();
  const resumed = await f.run("later", request) as { metadata: { jobId: string } };
  expect(resumed.metadata.jobId).toBe("imgjob_77");
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  expect(f.cards()).toHaveLength(1); expect(f.images()).toHaveLength(1);
});

it("review: a resumed multi-image render keeps each image's own facts and the whole render's", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => json({ data: [{ b64_json: PNG }, { b64_json: PNG_B }] }));
  const f = fixture("openai", fetcher);
  faults.saveImage = 1;
  const job = f.run("facts", { connectionId: "openai", prompt: "Two versions", n: 2 }), refusal = expect(job).rejects.toThrow("kept locally");
  await f.approve(); await refusal;
  const pending = JSON.parse(f.row().result!).pending;
  expect(pending.items).toHaveLength(2); expect(pending.items[1].imageIndex).toBe(1); expect(pending.metadata.delivered).toHaveLength(2);
  const resumed = await f.run("facts", { connectionId: "openai", prompt: "Two versions", n: 2 }) as { metadata: { delivered: unknown[] } };
  expect(resumed.metadata.delivered).toHaveLength(2);
  expect(f.images().map(message => message.text).sort()).toEqual([expect.stringContaining("(image 1 of 2)"), expect.stringContaining("(image 2 of 2)")]);
});
