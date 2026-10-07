// While demo redemption is refused (budget spent, unsaved or invalid), the
// demo code must be indistinguishable from any wrong guess on both doors.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBrowserHandler, type BoundIdentity, type BrowserDeviceStore } from "../src/browser.ts";
import { DEMO_BUDGET_FILE, DEMO_HOST_MARKER, DEMO_HOUR_FAILURES, DeviceRegistry } from "../src/devices.ts";
import { createProxyHandler } from "../src/proxy.ts";
import { DATA_DIR } from "../src/state.ts";

const CODE = "483920";
const WRONG = "271828";
const servers: Server[] = [];

type Mode = "exhausted" | "invalid-state" | "persist-failure";

/** A registry on a demo host whose demo redemption is refused. */
function refusedRegistry(mode: Mode): DeviceRegistry {
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(join(DATA_DIR, DEMO_HOST_MARKER), "demo\n", { mode: 0o600 });
  vi.stubEnv("MURAGE_DEMO_HOST", "1");
  vi.stubEnv("MURAGE_DEMO_PAIRING_CODE", CODE);
  if (mode === "invalid-state") {
    writeFileSync(join(DATA_DIR, DEMO_BUDGET_FILE), "{ broken", { mode: 0o600 });
    return new DeviceRegistry();
  }
  const r = new DeviceRegistry();
  if (mode === "persist-failure") {
    // a directory where the budget file goes: every save fails
    mkdirSync(join(DATA_DIR, DEMO_BUDGET_FILE));
    r.redeem("111112", "x", undefined, undefined, undefined, undefined, "10.50.0.1");
    return r;
  }
  for (let i = 0; i < DEMO_HOUR_FAILURES; i++) r.redeem("111112", "x", undefined, undefined, undefined, undefined, `10.50.${i}.1`);
  return r;
}

const post = (port: number, path: string, body: string, headers: Record<string, string>) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json", ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });

const listen = async (s: Server): Promise<number> => {
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return (s.address() as AddressInfo).port;
};

/** Three submissions of `code` to the device endpoint; the responses. */
async function deviceDoor(mode: Mode, windowOpen: boolean, code: string) {
  const registry = refusedRegistry(mode);
  if (windowOpen) registry.openPairing();
  const port = await listen(
    createServer(
      createProxyHandler({
        harnessPort: 1,
        authenticate: (t) => registry.authenticate(t ?? undefined),
        redeem: (c, name, id, ip) => registry.redeem(c, name, id, undefined, undefined, undefined, ip),
        serverName: () => "x",
      }),
    ),
  );
  const out = [];
  for (let i = 0; i < 3; i++) out.push(await post(port, "/api/pair", JSON.stringify({ code, deviceName: "Phone" }), {}));
  return { out, registry };
}

async function browserDoor(mode: Mode, windowOpen: boolean, code: string) {
  const registry = refusedRegistry(mode);
  if (windowOpen) registry.openPairing();
  const store = {
    redeem: (c: string, n: string, id: unknown, i: unknown, k: unknown, st: unknown, ip?: string) =>
      registry.redeem(c, n, id, i as string, k as string, st as string, ip),
    openSession: (d: string, l: string) => registry.openSession(d, l),
    resolveSession: (v: string) => registry.resolveSession(v),
    sessionDeadline: (s: string) => registry.sessionDeadline(s),
    closeSession: (v: string) => registry.closeSession(v),
    renewSession: (v: string) => registry.renewSession(v),
    signOutDevice: (v: string) => registry.signOutDevice(v),
    issuePushTokens: (d: string, b: string) => registry.issuePushTokens(d, b),
    pushBinding: (d: string) => registry.pushBinding(d),
    approvalIdentity: (d: string) => registry.approvalIdentity(d),
    authenticatePush: (t: string, s: Parameters<typeof registry.authenticatePush>[1]) => registry.authenticatePush(t, s),
    wasReplay: (r: object) => registry.wasReplay(r),
    onDeviceRemoved: (l: (id: string) => void) => registry.onDeviceRemoved(l),
    onSessionEnded: (l: never) => registry.onSessionEnded(l),
  } as unknown as BrowserDeviceStore;
  const identity: BoundIdentity = { scheme: "http", hosts: new Set(["127.0.0.1"]) };
  const port = await listen(createServer(createBrowserHandler({ harnessPort: 1, identity: () => identity, devices: store, disconnectDevice: () => {} })));
  const out = [];
  for (let i = 0; i < 3; i++) {
    out.push(
      await post(port, "/session", JSON.stringify({ credential: code }), {
        host: `127.0.0.1:${port}`,
        "sec-fetch-site": "same-origin",
        origin: `http://127.0.0.1:${port}`,
      }),
    );
  }
  return { out, registry };
}

describe("a refused demo code is indistinguishable from a wrong guess", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); })));
  });

  for (const mode of ["exhausted", "invalid-state", "persist-failure"] as const) {
    for (const windowOpen of [false, true]) {
      it(`device endpoint, ${mode}, window ${windowOpen ? "open" : "closed"}`, async () => {
        const demo = await deviceDoor(mode, windowOpen, CODE);
        const wrong = await deviceDoor(mode, windowOpen, WRONG);
        expect(JSON.stringify(demo.out)).toBe(JSON.stringify(wrong.out));
        expect(demo.out.every((r) => r.status === 401)).toBe(true);
        expect(demo.registry.list()).toHaveLength(0);
      });

      it(`browser endpoint, ${mode}, window ${windowOpen ? "open" : "closed"}`, async () => {
        const demo = await browserDoor(mode, windowOpen, CODE);
        const wrong = await browserDoor(mode, windowOpen, WRONG);
        expect(JSON.stringify(demo.out)).toBe(JSON.stringify(wrong.out));
        expect(demo.out.every((r) => r.status === 401)).toBe(true);
        expect(demo.registry.list()).toHaveLength(0);
      });
    }
  }

  it("the registry never answers the demo code with a distinct reason", () => {
    const r = refusedRegistry("exhausted");
    const a = r.redeem(CODE, "x", undefined, undefined, undefined, undefined, "10.60.0.1");
    const b = r.redeem(WRONG, "x", undefined, undefined, undefined, undefined, "10.60.0.2");
    expect(a).toEqual(b);
  });
});
