import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { hiddenRoute, notImplemented, responseGone, sendDelegated, type DelegatedRequest, type DelegatedResult } from "./route-delegation.ts";
import { workspaceFilesRoute } from "./workspace-files.ts";
import { mediaAssetsRoute, resolveImageReferenceRoute } from "./media-assets.ts";
import { createOutputPublisher } from "./output-publication.ts";

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve)))); });

async function serve(method: string, result: () => DelegatedResult) {
  const server = createServer((_req, res) => sendDelegated(res, method, result())); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path: "/" }, res => {
      let body = ""; res.setEncoding("utf8"); res.on("data", chunk => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject); req.end();
  });
}

const deps = {} as never;
const call = (path: string, desktop: boolean, method = "GET"): DelegatedRequest => ({
  method, path, url: new URL(`http://127.0.0.1${path}`), headers: {}, desktop,
  readBody: () => { throw new Error("skeletons must not read bodies"); },
});

describe("route delegation writer", () => {
  it("writes JSON, headers and binary bodies, and omits bodies for HEAD", async () => {
    expect(await serve("GET", () => ({ status: 501, body: { code: "not-implemented" } }))).toMatchObject({ status: 501, body: '{"code":"not-implemented"}', headers: { "content-type": "application/json" } });
    expect(await serve("GET", () => ({ status: 206, headers: { "content-type": "audio/wav", "referrer-policy": "no-referrer" }, bytes: Buffer.from("RIFF") })))
      .toMatchObject({ status: 206, body: "RIFF", headers: { "content-type": "audio/wav", "referrer-policy": "no-referrer" } });
    expect(await serve("HEAD", () => ({ status: 200, body: { hidden: true } }))).toMatchObject({ status: 200, body: "" });
  });

  it("streams bodies and releases the stream for HEAD", async () => {
    expect(await serve("GET", () => ({ status: 200, stream: Readable.from(["ab", "cd"]) }))).toMatchObject({ status: 200, body: "abcd" });
    let destroyed = false;
    const stream = new Readable({ read() {}, destroy(error, callback) { destroyed = true; callback(error); } });
    expect(await serve("HEAD", () => ({ status: 200, stream }))).toMatchObject({ status: 200, body: "" });
    expect(destroyed).toBe(true);
  });

  it("destroys a stream whose client left before or during the response instead of piping into the void", async () => {
    // Before: the module answered after the client had gone (a player seek
    // aborting a range request during the file open). The stream must be
    // released right away; a pipe into a closed response never drains.
    let releasedBefore = false;
    const early = new Readable({ read() {}, destroy(error, callback) { releasedBefore = true; callback(error); } });
    let arrived!: () => void;
    const received = new Promise<void>(resolve => { arrived = resolve; });
    const beforeServer = createServer((_req, res) => {
      expect(responseGone(res)).toBe(false);
      res.once("close", () => { expect(responseGone(res)).toBe(true); sendDelegated(res, "GET", { status: 200, stream: early }); });
      arrived();
    });
    servers.push(beforeServer);
    await new Promise<void>(resolve => beforeServer.listen(0, "127.0.0.1", resolve));
    const abandoned = request({ host: "127.0.0.1", port: (beforeServer.address() as AddressInfo).port, method: "GET", path: "/" });
    abandoned.on("error", () => undefined); abandoned.end();
    await received;
    abandoned.destroy();
    await expect.poll(() => releasedBefore, { timeout: 5000 }).toBe(true);
    // During: the response is piped and the client leaves after the first chunk.
    let releasedDuring = false;
    const during = new Readable({ read() { this.push(Buffer.alloc(1024, 0x41)); }, destroy(error, callback) { releasedDuring = true; callback(error); } });
    const duringServer = createServer((_req, res) => { expect(responseGone(res)).toBe(false); sendDelegated(res, "GET", { status: 200, stream: during }); });
    servers.push(duringServer);
    await new Promise<void>(resolve => duringServer.listen(0, "127.0.0.1", resolve));
    await new Promise<void>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: (duringServer.address() as AddressInfo).port, method: "GET", path: "/" }, res => { res.once("data", () => { res.destroy(); resolve(); }); });
      req.on("error", reject); req.end();
    });
    await expect.poll(() => releasedDuring, { timeout: 5000 }).toBe(true);
  });

  it("uses the existing hidden-route answer and a coded 501", () => {
    expect(hiddenRoute()).toEqual({ status: 404, body: { error: "no such route" } });
    expect(notImplemented("later")).toEqual({ status: 501, body: { error: "later", code: "not-implemented" } });
  });
});

describe("K0 skeleton modules", () => {
  it("hide workspace-file and media routes from non-desktop callers and answer the desktop", async () => {
    for (const path of ["/api/workspace-files", "/api/workspace-files/list", "/api/workspace-files/write"]) {
      expect(await workspaceFilesRoute(call(path, false), deps)).toEqual(hiddenRoute());
    }
    // R3-T1 filled discovery (root/list/search, GET only); F4-T1 filled
    // editing, which refuses a save without a valid body.
    expect(await workspaceFilesRoute(call("/api/workspace-files/write", true, "POST"), deps)).toMatchObject({ status: 400, body: { code: "invalid-request" } });
    expect(await workspaceFilesRoute(call("/api/workspace-files/list", true, "POST"), deps)).toMatchObject({ status: 400, body: { code: "invalid-request" } });
    expect(await workspaceFilesRoute(call("/api/workspace-files", true, "POST"), deps)).toMatchObject({ status: 404, body: { code: "not-found" } });
    expect(await workspaceFilesRoute(call("/api/workspace-filesx", true), deps)).toEqual(hiddenRoute());
    // F5-T1 filled media: resolve is POST-only for the desktop, and bytes need
    // a capability issued by resolve (server/media-assets.test.ts).
    expect(await mediaAssetsRoute(call("/api/media/resolve", false), deps)).toEqual(hiddenRoute());
    expect(await mediaAssetsRoute(call("/api/media/resolve", true), deps)).toMatchObject({ status: 405 });
    expect(await mediaAssetsRoute(call("/api/media/resolve", true, "POST"), deps)).toMatchObject({ status: 400, body: { code: "invalid-request" } });
    for (const desktop of [false, true]) expect(await mediaAssetsRoute(call("/api/media/bytes/asset-1", desktop), deps)).toMatchObject({ ...hiddenRoute(), headers: { "referrer-policy": "no-referrer" } });
  });

  it("answers the internal reference route with 405/501 without reading the body", async () => {
    const claim = { botId: "bot", threadId: "thread", generation: "g1" };
    expect(await resolveImageReferenceRoute(call("/api/internal/resolve-image-reference", false), claim, deps)).toMatchObject({ status: 405 });
    expect(await resolveImageReferenceRoute(call("/api/internal/resolve-image-reference", false, "POST"), claim, deps)).toMatchObject({ status: 501, body: { code: "not-implemented" } });
  });

  it("starts with no-op output publication hooks that never throw", async () => {
    const publisher = createOutputPublisher(deps);
    expect(() => publisher.beforeDispatch({ botId: "bot", threadId: "thread", runId: "run", workspaceRoot: undefined, managed: false })).not.toThrow();
    await expect(publisher.publishTerminalOutputs({ type: "turn.completed", ok: true, threadId: "thread" } as never)).resolves.toBeUndefined();
  });
});
