// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// Image POSTs and their connection (0.1.61, Sable, 2026-09-30): Flux edits
// failed "timed out" while Flux never saw the request, and the retry rendered
// in 40 to 81 s. Every test here runs undici for real against a local server:
// the service's own fetch and dispatcher, only the host rewritten.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer, type Socket } from "node:net";
import { afterEach, expect, it } from "vitest";
import * as generation from "./image-generation.ts";
import { ImageGenerationService } from "./image-generation.ts";
import * as dispatchers from "./provider-dispatcher.ts";
import { providerDispatcher } from "./provider-dispatcher.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");
const reference = { bytes: png, mime: "image/png" as const };
const edit = { connectionId: "flux", operation: "edit", prompt: "The same jacket in red" };
const answer = () => JSON.stringify({ data: [{ b64_json: png.toString("base64") }], model: "flux-image" });
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

/** A local server that counts connections and requests. */
async function fixtureServer(handler: (req: IncomingMessage, res: ServerResponse, n: number) => void) {
  const sockets: Socket[] = [];
  let requests = 0;
  const server = createServer((req, res) => { requests++; handler(req, res, requests); });
  server.keepAliveTimeout = 0; // the fixture never closes an idle socket itself
  server.on("connection", socket => sockets.push(socket));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind");
  cleanups.push(() => { for (const socket of sockets) socket.destroy(); server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  return { port: address.port, connections: () => sockets.length, requests: () => requests, sockets };
}
const drain = async (req: IncomingMessage) => { for await (const _chunk of req) { /* the whole upload */ } };
async function closedPort() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}
/** The service with the real fetch and dispatcher; each call goes to the port `route` names. */
function service(route: (call: number) => number, options: Record<string, unknown> = {}) {
  let calls = 0;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls++;
    const target = new URL(String(url));
    return fetch(`http://127.0.0.1:${route(calls)}${target.pathname}`, init);
  }) as typeof fetch;
  const images = new ImageGenerationService({ resolveConnection: () => ({ id: "flux", provider: "flux", apiKey: "FAKE_IMAGE_CONN_KEY", revision: "1" }), connectionIds: () => ["flux"], fetch: fetcher, ...options });
  const outcomes: string[] = [];
  const hooks = (signal?: AbortSignal) => ({ assertActive: () => {}, reserve: async () => ({ finish: (outcome: string) => { outcomes.push(outcome); } }), publish: async () => ({ id: "artifact" }), ...(signal ? { signal } : {}) });
  return { images, hooks, calls: () => calls, outcomes };
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

it("an image POST after an idle gap never rides the last render's connection, even one the far end dropped without a word", async () => {
  // Render 1 answers with a long Keep-Alive hint, then its socket goes dark:
  // no FIN, no RST, nothing read. That is a pooled connection that died idle.
  const fixture = await fixtureServer(async (req, res, n) => {
    await drain(req);
    res.writeHead(200, { "content-type": "application/json", "keep-alive": "timeout=600" });
    res.end(answer());
    if (n === 1) res.once("finish", () => req.socket.pause());
  });
  const f = service(() => fixture.port);
  await f.images.generate(edit, f.hooks(), [reference]);
  await sleep(1_500);
  const started = Date.now();
  // Bounded here so the old behaviour fails the test instead of hanging it.
  const second = await f.images.generate(edit, f.hooks(AbortSignal.timeout(5_000)), [reference]).then(() => "published", (error: Error) => `failed after ${Date.now() - started} ms: ${error.message}`);
  expect(second).toBe("published");
  expect(fixture.connections()).toBe(2);
  expect(fixture.requests()).toBe(2);
}, 20_000);

it("evidence: with no Keep-Alive hint the shared provider pool drops an idle socket after about 4 s, so gaps of minutes open a new connection", async () => {
  const fixture = await fixtureServer(async (req, res) => { await drain(req); res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
  const dispatcher = providerDispatcher(`http://127.0.0.1:${fixture.port}/`);
  const post = () => fetch(`http://127.0.0.1:${fixture.port}/v1/images/edits`, { method: "POST", body: "x", dispatcher } as RequestInit).then(response => response.text());
  await post(); await sleep(100); await post();
  expect(fixture.connections()).toBe(1); // 100 ms apart: the socket is reused
  await sleep(5_000);
  await post();
  expect(fixture.connections()).toBe(2); // after 5 s idle: undici had closed it
}, 20_000);

it("image POSTs ask for their own connection and close it after the answer", async () => {
  const seen: Array<string | undefined> = [];
  const fixture = await fixtureServer(async (req, res) => { seen.push(req.headers.connection); await drain(req); res.writeHead(200, { "content-type": "application/json" }); res.end(answer()); });
  const f = service(() => fixture.port);
  await f.images.generate(edit, f.hooks(), [reference]);
  await f.images.generate(edit, f.hooks(), [reference]);
  expect(seen).toEqual(["close", "close"]);
  expect(fixture.connections()).toBe(2);
});

it("a connection that could not be opened is tried once more on a new one: no request byte had left", async () => {
  const fixture = await fixtureServer(async (req, res) => { await drain(req); res.writeHead(200, { "content-type": "application/json" }); res.end(answer()); });
  const refused = await closedPort();
  const f = service(call => call === 1 ? refused : fixture.port);
  const result = await f.images.generate(edit, f.hooks(), [reference]);
  expect(result.artifact).toEqual({ id: "artifact" });
  expect(f.calls()).toBe(2);
  expect(fixture.requests()).toBe(1);
  expect(f.outcomes).toEqual(["published"]);
});

it("a connection lost after the request started is never retried: the provider may have it", async () => {
  const fixture = await fixtureServer(async (req) => { await drain(req); req.socket.destroy(); });
  const f = service(() => fixture.port);
  const error = await f.images.generate(edit, f.hooks(), [reference]).then(() => null, (e: unknown) => e as generation.ImageGenerationError);
  expect(error).toMatchObject({ code: "provider-unreachable", outcome: "uncertain" });
  expect(error!.message).toContain("No fallback or automatic retry was attempted.");
  expect(f.calls()).toBe(1);
  expect(fixture.requests()).toBe(1);
});

it("the retry happens once: two connections that cannot open end the attempt, said plainly", async () => {
  const refused = await closedPort();
  const f = service(() => refused);
  const error = await f.images.generate(edit, f.hooks(), [reference]).then(() => null, (e: unknown) => e as generation.ImageGenerationError);
  expect(error).toMatchObject({ code: "provider-unreachable" });
  expect(error!.message).toContain("tried once more on a new connection");
  expect(error!.message).not.toContain("No fallback or automatic retry was attempted.");
  expect(f.calls()).toBe(2);
});

it("HTTP 524 (the edge stopped waiting for the render) is never retried and says the render may still finish", async () => {
  const fixture = await fixtureServer(async (req, res) => { await drain(req); res.writeHead(524, { "content-type": "text/html" }); res.end("<html>A timeout occurred</html>"); });
  const f = service(() => fixture.port);
  const error = await f.images.generate(edit, f.hooks(), [reference]).then(() => null, (e: unknown) => e as generation.ImageGenerationError);
  expect(error).toMatchObject({ outcome: "uncertain" });
  expect(error!.message).toContain("HTTP 524");
  expect(error!.message).toContain("may still have finished");
  expect(error!.message).toContain("no automatic retry was attempted");
  expect(f.calls()).toBe(1);
  expect(fixture.requests()).toBe(1);
});

it("a Flux image POST gets 180 seconds for the whole answer, then stops with a plain line and no retry", async () => {
  expect((generation as Record<string, unknown>).FLUX_ANSWER_DEADLINE_MS).toBe(180_000);
  const fixture = await fixtureServer(async (req) => { await drain(req); /* never answers */ });
  const f = service(() => fixture.port, { answerDeadlineMs: 400 });
  const started = Date.now();
  const error = await f.images.generate(edit, f.hooks(AbortSignal.timeout(6_000)), [reference]).then(() => null, (e: unknown) => e as generation.ImageGenerationError);
  expect(Date.now() - started).toBeLessThan(4_000);
  expect(error).toMatchObject({ code: "provider-timeout", outcome: "uncertain" });
  expect(error!.message).toBe("Flux Router did not send the image within 180 seconds, so Murage stopped waiting. The render may still have finished on its side. Check before trying again; no automatic retry was attempted.");
  expect(f.calls()).toBe(1);
}, 20_000);

it("the image dispatcher bounds opening a connection and reports that nothing was written", async () => {
  // Accepts TCP and never answers the TLS hello: a route that died.
  const sockets: Socket[] = [];
  const silent = createNetServer(socket => { sockets.push(socket); });
  await new Promise<void>(resolve => silent.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => { for (const socket of sockets) socket.destroy(); return new Promise<void>(resolve => silent.close(() => resolve())); });
  const { port } = silent.address() as { port: number };
  const { imageDispatcher, watchRequestStart } = dispatchers as unknown as {
    imageDispatcher: (target: string, connectTimeoutMs?: number) => import("undici").Dispatcher;
    watchRequestStart: (base: import("undici").Dispatcher) => { dispatcher: import("undici").Dispatcher; reached: () => boolean; started: () => boolean };
  };
  const watch = watchRequestStart(imageDispatcher(`https://127.0.0.1:${port}/`, 300));
  const started = Date.now();
  const error = await fetch(`https://127.0.0.1:${port}/v1/images/edits`, { method: "POST", body: "x", dispatcher: watch.dispatcher } as RequestInit).then(() => null, (e: Error) => e);
  expect(Date.now() - started).toBeLessThan(3_000);
  expect((error?.cause as { code?: string } | undefined)?.code).toBe("UND_ERR_CONNECT_TIMEOUT");
  expect(watch.reached()).toBe(true);
  expect(watch.started()).toBe(false);
});

// Upload stall (Flux team, 2026-10-01: no Keep-Alive hint on api.fluxrouter.ai,
// so the open gap is an upload that stops before the edge has the whole body).
const bigReference = { bytes: Buffer.concat([png, Buffer.alloc(8 * 1024 * 1024)]), mime: "image/png" as const };

it("an upload that stops moving is ended after the stall limit, said plainly, and never retried", async () => {
  // Reads the first part of the body, then stops reading: the upload stalls.
  const fixture = await fixtureServer((req) => { req.once("data", () => req.socket.pause()); });
  const f = service(() => fixture.port, { uploadStallMs: 300 });
  const started = Date.now();
  const error = await f.images.generate(edit, f.hooks(AbortSignal.timeout(8_000)), [bigReference]).then(() => null, (e: unknown) => e as generation.ImageGenerationError);
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(error).toMatchObject({ code: "upload-stalled", outcome: "uncertain" });
  expect(error!.message).toBe("The upload to Flux Router stalled: no image data moved for 20 seconds, so Murage stopped. The image may not have reached Flux Router. Nothing was retried automatically.");
  expect(f.calls()).toBe(1);
  expect(fixture.requests()).toBe(1);
}, 20_000);

it("the stall clock stops once the upload is complete: a render slower than the limit still arrives", async () => {
  const fixture = await fixtureServer(async (req, res) => {
    await drain(req);
    await sleep(1_500); // the render, well past the 300 ms stall limit
    res.writeHead(200, { "content-type": "application/json" }); res.end(answer());
  });
  const f = service(() => fixture.port, { uploadStallMs: 300 });
  const result = await f.images.generate(edit, f.hooks(AbortSignal.timeout(8_000)), [bigReference]);
  expect(result.artifact).toEqual({ id: "artifact" });
  expect(f.calls()).toBe(1);
}, 20_000);
