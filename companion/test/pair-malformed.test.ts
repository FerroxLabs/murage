// Release finding 10-1: `POST /api/pair` is answered before any credential exists, and it coerced the presented credential
// with String(). A body of {"credential":{"toString":null}} made that throw inside the body handler: an unhandled rejection,
// which ends a Node process, so any peer that could reach the device port could stop the companion with one request.
// The credential must be a string (or a typed number), and nothing a body makes pairing throw may escape the handler.
import { rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createSignInLimiter } from "../src/browser.ts";
import { DeviceRegistry } from "../src/devices.ts";
import { createProxyHandler, type ProxyOptions } from "../src/proxy.ts";
import { DATA_DIR } from "../src/state.ts";

let open: Server[] = [];
const rejections: unknown[] = [];
const onRejection = (reason: unknown) => { rejections.push(reason); };

afterEach(async () => {
  process.off("unhandledRejection", onRejection);
  for (const server of open) await new Promise<void>((r) => server.close(() => r()));
  open = [];
  rejections.length = 0;
});

const door = async (redeem: ProxyOptions["redeem"]) => {
  const server = createServer(createProxyHandler({ harnessPort: 1, authenticate: () => null, serverName: () => "Ada's computer", signInLimiter: createSignInLimiter(), redeem }));
  open.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return async (raw: string) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: raw, signal: AbortSignal.timeout(5000) });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
};

describe("a malformed pairing request", () => {
  it("is refused with a 400, never reaches redeem, and leaves the companion answering", async () => {
    process.on("unhandledRejection", onRejection);
    const presented: string[] = [];
    const pair = await door((code) => { presented.push(code); return { error: "that pairing code is not right", reason: "wrong" }; });
    for (const raw of ['{"credential":{"toString":null}}', '{"code":{"toString":null,"valueOf":null}}', '{"credential":["123456"]}', '{"credential":true}']) {
      const answer = await pair(raw);
      expect(answer.status, raw).toBe(400);
      expect(answer.body.error).toBe("That pairing request is not valid.");
    }
    expect(presented).toEqual([]);
    // each was charged like a wrong guess: this client is now locked out, by a companion that is still answering
    expect((await pair('{"code":"000000"}')).status).toBe(429);
    expect(presented).toEqual([]);
    // with a clean limiter, ordinary attempts still reach redeem (a typed number is the code it spells)
    const fresh = await door((code) => { presented.push(code); return { error: "that pairing code is not right", reason: "wrong" }; });
    expect((await fresh('{"code":"000000"}')).status).toBe(401);
    expect((await fresh('{"code":123456}')).status).toBe(401);
    expect(presented).toEqual(["000000", "123456"]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(rejections).toEqual([]);
  });

  it("answers a 500 rather than ending the process when redeem itself throws", async () => {
    process.on("unhandledRejection", onRejection);
    const pair = await door(() => { throw new Error("registry exploded"); });
    const answer = await pair('{"code":"000000"}');
    expect(answer.status).toBe(500);
    expect(answer.body.error).toBe("Pairing could not be completed. Try again.");
    await new Promise((resolve) => setImmediate(resolve));
    expect(rejections).toEqual([]);
  });

  // Low finding: with the RIGHT credential and a deviceName String() cannot coerce, the registry spent the window ("used")
  // before cleanDeviceName threw, so the person holding the real code had to open a new one. The name is checked before it.
  it("leaves the pairing window open when the right credential arrives with a bad deviceName", async () => {
    process.on("unhandledRejection", onRejection);
    rmSync(join(DATA_DIR, "devices.json"), { force: true });
    const registry = new DeviceRegistry();
    const window = registry.openPairing();
    const pair = await door((code, deviceName, pairRequestId, clientIp) => registry.redeem(code, deviceName, pairRequestId, undefined, undefined, undefined, clientIp));
    for (const deviceName of [{ toString: null }, ["Ada's phone"], true]) {
      const answer = await pair(JSON.stringify({ credential: window.token, deviceName }));
      expect(answer.status, JSON.stringify(deviceName)).toBe(400);
    }
    expect(registry.list()).toEqual([]);
    // the same code still pairs, the first time it is presented well
    const paired = await pair(JSON.stringify({ credential: window.token, deviceName: "Ada's phone" }));
    expect(paired.status).toBe(201);
    expect(registry.list().map((device) => device.name)).toEqual(["Ada's phone"]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(rejections).toEqual([]);
  });

  it("the registry names the device before spending the window, so a name that throws leaves the code live", () => {
    rmSync(join(DATA_DIR, "devices.json"), { force: true });
    const registry = new DeviceRegistry();
    const window = registry.openPairing();
    expect(() => registry.redeem(window.token, { toString: null })).toThrow();
    const result = registry.redeem(window.token, "Ada's phone");
    expect("device" in result && result.device.name).toBe("Ada's phone");
  });
});
