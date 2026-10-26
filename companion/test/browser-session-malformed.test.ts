// Release finding 10-A1: `POST /session` on the browser door is answered before any credential exists, and it coerced the
// presented credential with String(). A body of {"credential":{"toString":null}} made that throw inside the body handler: an
// unhandled rejection, which ends a Node process. The credential must be a string (or a typed number), and nothing a body
// makes sign-in throw may escape the handler. The device door got the same guard earlier (pair-malformed.test.ts).
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { createBrowserHandler, createSignInLimiter, type BoundIdentity, type BrowserDeviceStore } from "../src/browser.ts";

const identity: BoundIdentity = { scheme: "http", hosts: new Set(["macbook.tailexample.ts.net", "127.0.0.1"]) };

let open: Server[] = [];
const rejections: unknown[] = [];
const onRejection = (reason: unknown) => { rejections.push(reason); };

afterEach(async () => {
  process.off("unhandledRejection", onRejection);
  for (const server of open) {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  }
  open = [];
  rejections.length = 0;
});

const door = async (redeem: (credential: string) => unknown) => {
  const devices = { redeem } as unknown as BrowserDeviceStore;
  const server = createServer(createBrowserHandler({ harnessPort: 1, identity: () => identity, devices, signInLimiter: createSignInLimiter() }));
  open.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return (raw: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
        { hostname: "127.0.0.1", port, path: "/session", method: "POST", headers: { host: `macbook.tailexample.ts.net:${port}`, "sec-fetch-site": "same-origin", origin: `http://macbook.tailexample.ts.net:${port}`, "content-type": "application/json" } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        },
      );
      req.on("error", reject);
      req.write(raw);
      req.end();
    });
};

describe("a malformed browser sign-in request", () => {
  it("is refused with a 400, never reaches redeem, and leaves the process alive", async () => {
    process.on("unhandledRejection", onRejection);
    const presented: string[] = [];
    const post = await door((code) => { presented.push(code); return { error: "wrong", reason: "wrong" }; });
    for (const raw of ['{"credential":{"toString":null}}', '{"credential":["123456"]}', '{"credential":true}']) {
      const answer = await post(raw);
      expect(answer.status, raw).toBe(400);
    }
    expect(presented).toEqual([]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(rejections).toEqual([]);
  });

  it("answers a 500 rather than ending the process when redeem itself throws", async () => {
    process.on("unhandledRejection", onRejection);
    const post = await door(() => { throw new Error("boom"); });
    expect((await post('{"credential":"000000"}')).status).toBe(500);
    await new Promise((resolve) => setImmediate(resolve));
    expect(rejections).toEqual([]);
  });

  it("still lets a typed number through as the code it spells", async () => {
    const presented: string[] = [];
    const post = await door((code) => { presented.push(code); return { error: "wrong", reason: "wrong" }; });
    expect((await post('{"credential":123456}')).status).toBe(401);
    expect(presented).toEqual(["123456"]);
  });
});
