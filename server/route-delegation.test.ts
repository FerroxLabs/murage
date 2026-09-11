import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { hiddenRoute, notImplemented, sendDelegated, type DelegatedRequest, type DelegatedResult } from "./route-delegation.ts";
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

  it("uses the existing hidden-route answer and a coded 501", () => {
    expect(hiddenRoute()).toEqual({ status: 404, body: { error: "no such route" } });
    expect(notImplemented("later")).toEqual({ status: 501, body: { error: "later", code: "not-implemented" } });
  });
});

describe("K0 skeleton modules", () => {
  it("hide workspace-file and media routes from non-desktop callers and answer 501 to the desktop", async () => {
    for (const path of ["/api/workspace-files", "/api/workspace-files/list", "/api/workspace-files/write"]) {
      expect(await workspaceFilesRoute(call(path, false), deps)).toEqual(hiddenRoute());
      expect(await workspaceFilesRoute(call(path, true, "POST"), deps)).toMatchObject({ status: 501, body: { code: "not-implemented" } });
    }
    expect(await workspaceFilesRoute(call("/api/workspace-filesx", true), deps)).toEqual(hiddenRoute());
    for (const path of ["/api/media/resolve", "/api/media/bytes/asset-1"]) {
      expect(await mediaAssetsRoute(call(path, false), deps)).toEqual(hiddenRoute());
      expect(await mediaAssetsRoute(call(path, true), deps)).toMatchObject({ status: 501, body: { code: "not-implemented" } });
    }
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
