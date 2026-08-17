// How the proxy prepares a response body, against a stub harness.
//
// proxy.test.ts boots the real harness and is the right place for anything
// about the seam between the two. This file is the opposite: a harness stub
// that can be made to return exactly the pathological body a test needs,
// which is the only way to reach the failure branches below.
import { createServer, type Server, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createProxyHandler } from "../src/proxy.ts";

const TOKEN = "omb_test_token";

let harness: Server;
let sidecar: Server;
let sidecarPort = 0;
/** What the stub harness answers with next. Set per test. */
let respond: (res: ServerResponse) => void = (res) => res.end();

const listen = (server: Server): Promise<number> =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));

const close = (server: Server | undefined): Promise<void> =>
  new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));

/** A request as a paired device makes it. */
const device = async (path = "/api/bots"): Promise<{ status: number; text: string }> => {
  const res = await fetch(`http://127.0.0.1:${sidecarPort}${path}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  return { status: res.status, text: await res.text() };
};

beforeAll(async () => {
  harness = createServer((_req, res) => respond(res));
  const harnessPort = await listen(harness);

  sidecar = createServer(
    createProxyHandler({
      harnessPort,
      authenticate: (t) => t === TOKEN,
      redeem: () => ({ error: "not used here" }),
      serverName: () => "Test computer",
    }),
  );
  sidecarPort = await listen(sidecar);
});

afterAll(async () => {
  await close(sidecar);
  await close(harness);
});

describe("preparing a harness response for a device", () => {
  it("never forwards a body it could not scrub", async () => {
    // `scrub` recurses once per level, so a deeply nested body throws
    // RangeError while JSON.parse handles it without complaint. That gap is
    // the whole bug: parse-then-scrub under one try/catch treated the throw
    // as "not JSON after all" and sent the untouched body on to the phone.
    let body = JSON.stringify({ resumeCursors: { agent: "cursor-value" } });
    for (let i = 0; i < 6_000; i++) body = `{"a":${body}}`;

    respond = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
    };

    const { status, text } = await device();

    // The invariant, stated so it holds on any stack size: whatever comes
    // back, it is not a success carrying the field the scrubber removes. On
    // a runtime deep enough to scrub this, that is a scrubbed 200; on one
    // that throws, a 502. Never the raw body.
    expect(status === 200 && text.includes("resumeCursors")).toBe(false);
    expect(status).toBe(502);
  });

  it("passes a body through untouched when it was never JSON", async () => {
    // The tolerant half of the same branch, and the reason it cannot simply
    // fail closed on everything: a content-type that lies is common enough,
    // and there is nothing to redact in bytes we cannot read as an object.
    respond = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("this is not JSON at all");
    };

    const { status, text } = await device();
    expect(status).toBe(200);
    expect(text).toBe("this is not JSON at all");
  });

  it("scrubs a well-formed body and re-frames it", async () => {
    respond = (res) => {
      res.writeHead(200, { "content-type": "application/json", "transfer-encoding": "chunked" });
      res.end(JSON.stringify({ bots: [{ id: "b1" }], resumeCursors: { agent: "cursor-value" } }));
    };

    const { status, text } = await device();
    expect(status).toBe(200);
    expect(JSON.parse(text)).toEqual({ bots: [{ id: "b1" }] });
    expect(text).not.toContain("cursor-value");
  });
});
