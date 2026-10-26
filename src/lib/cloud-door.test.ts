import { createHash, createPublicKey, verify as nodeVerify } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StorageBlocked, StorageRefused, b64url, bindOf, bounceUrl, doorBrowser, doorErrorName, doorStorageTiming, ensureDevice, enteredOwnerState, enterWithTicket, forgetThisBrowser, fromB64url, homeMeta, listDevices, loadDevice, makeChatOnly, refreshMessage, refreshSession, reportDoorProblem, saveDevice, spkiToPem, ticketFromHash } from "./cloud-door";
import { SURFACE_SECRET_HEADER, setDesktopSurfaceSecretForTest } from "./live-events";
import { DOOR_BROWSERS, DOOR_OPEN_CAUSES, DOOR_PAGE_ERRORS, DOOR_PAGE_STAGES } from "../../server/cloud-home/door-log";

/** A tiny in-memory IndexedDB (one store, get/put/delete). `refuse` makes every write fail. */
const idb = { refuse: false, map: new Map<string, unknown>() };
const later = (fn: () => void) => setTimeout(fn, 0);
const fakeIndexedDb = {
  open() {
    const request: any = {};
    later(() => {
      request.result = { createObjectStore() {}, close() {}, transaction() {
        const tx: any = {};
        tx.objectStore = () => ({
          get(key: string) { const r: any = {}; later(() => { r.result = idb.map.get(key); r.onsuccess?.(); }); return r; },
          put(value: unknown, key: string) { later(() => { if (idb.refuse) { tx.error = new DOMException("full", "QuotaExceededError"); tx.onerror?.(); return; } idb.map.set(key, value); tx.oncomplete?.(); }); },
          delete(key: string) { later(() => { idb.map.delete(key); tx.oncomplete?.(); }); },
        });
        return tx;
      } };
      request.onupgradeneeded?.(); request.onsuccess?.();
    });
    return request;
  },
};
type Call = { url: string; init?: RequestInit };
function stubFetch(answer: (url: string, body: any) => { status: number; body?: unknown }): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const res = answer(url, init?.body ? JSON.parse(String(init.body)) : undefined);
    return { status: res.status, ok: res.status < 300, json: async () => res.body ?? {} };
  }));
  return calls;
}
const sentBodies = (calls: Call[], url: string) => calls.filter(call => call.url === url).map(call => JSON.parse(String(call.init!.body)));
beforeEach(() => { idb.refuse = false; idb.map.clear(); vi.stubGlobal("indexedDB", fakeIndexedDb); });
afterEach(() => { vi.unstubAllGlobals(); doorStorageTiming.stepMs = 5000; });

/** An IndexedDB whose opens follow a script: "hang" never answers, "blocked" fires onblocked, "late" succeeds after the step bound, "ok" is the working fake. */
function scriptedIdb(script: Array<"hang" | "blocked" | "late" | "ok">) {
  const state = { opens: 0, lateClosed: 0 };
  vi.stubGlobal("indexedDB", {
    open() {
      const mode = script[state.opens++] ?? "ok";
      if (mode === "ok") return fakeIndexedDb.open();
      const request: any = {};
      if (mode === "blocked") later(() => request.onblocked?.());
      if (mode === "late") setTimeout(() => { request.result = { close() { state.lateClosed++; } }; request.onsuccess?.(); }, doorStorageTiming.stepMs * 3);
      return request;
    },
  });
  return state;
}
const openReports = (calls: Call[]) => sentBodies(calls, "/api/cloud/enter/report").filter(body => body.stage === "device_open");
describe("every key store step is bounded", () => {
  beforeEach(() => { doorStorageTiming.stepMs = 20; vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15" }); });
  it("an open that never answers is tried once more, then refused as storage, reporting timeout twice", async () => {
    const calls = stubFetch(() => ({ status: 200 }));
    const opened = scriptedIdb(["hang", "hang"]);
    const err = await ensureDevice().catch((error: unknown) => error);
    expect(err).toBeInstanceOf(StorageRefused); expect(err).not.toBeInstanceOf(StorageBlocked);
    expect(opened.opens).toBe(2);
    expect(openReports(calls)).toEqual([{ stage: "device_open", cause: "timeout", browser: "safari" }, { stage: "device_open", cause: "timeout", browser: "safari" }]);
    expect(calls.filter(call => call.url !== "/api/cloud/enter/report")).toHaveLength(0);
  });
  it("a timed-out open that succeeds on the retry carries on and stores the keys", async () => {
    const calls = stubFetch(() => ({ status: 200 }));
    scriptedIdb(["hang"]);
    const device = await ensureDevice();
    expect(idb.map.get("this-home")).toMatchObject({ publicKey: device.publicKey });
    expect(openReports(calls)).toEqual([{ stage: "device_open", cause: "timeout", browser: "safari" }]);
  });
  it("blocked twice throws StorageBlocked and reports blocked; a later run after the other tab closes succeeds", async () => {
    const calls = stubFetch(() => ({ status: 200 }));
    scriptedIdb(["blocked", "blocked"]);
    await expect(ensureDevice()).rejects.toBeInstanceOf(StorageBlocked);
    expect(openReports(calls).map(body => body.cause)).toEqual(["blocked", "blocked"]);
    scriptedIdb([]);
    expect((await ensureDevice()).publicKey).toBeTruthy();
  });
  it("an open that lands after its bound is closed at once and the retry is used", async () => {
    stubFetch(() => ({ status: 200 }));
    const opened = scriptedIdb(["late"]);
    await ensureDevice();
    await new Promise(resolve => setTimeout(resolve, doorStorageTiming.stepMs * 4));
    expect(opened.lateClosed).toBe(1);
    expect(opened.opens).toBeGreaterThanOrEqual(2);
  });
  it("a read that never answers is refused as storage instead of making new keys over the stored ones", async () => {
    const calls = stubFetch(() => ({ status: 200 }));
    vi.stubGlobal("indexedDB", { open() {
      const request: any = {};
      later(() => { request.result = { close() {}, transaction: () => ({ objectStore: () => ({ get: () => ({}) }) }) }; request.onsuccess?.(); });
      return request;
    } });
    await expect(loadDevice()).rejects.toBeInstanceOf(StorageRefused);
    expect(sentBodies(calls, "/api/cloud/enter/report")).toEqual([{ stage: "device_load", error: "TimeoutError" }]);
  });
  it("names only a coarse browser family, from the fixed list", () => {
    const ua = {
      chrome: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
      edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0",
      firefox: "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
      safari: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      chromeIos: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0 Mobile/15E148 Safari/604.1",
    };
    expect(doorBrowser(ua.chrome)).toBe("chrome"); expect(doorBrowser(ua.edge)).toBe("edge"); expect(doorBrowser(ua.firefox)).toBe("firefox");
    expect(doorBrowser(ua.safari)).toBe("safari"); expect(doorBrowser(ua.chromeIos)).toBe("chrome");
    for (const v of ["", "curl/8.0", undefined, 5]) expect(doorBrowser(v)).toBe("other");
    for (const v of Object.values(ua)) expect(DOOR_BROWSERS as readonly string[]).toContain(doorBrowser(v));
    for (const cause of ["timeout", "blocked", "error"]) expect(DOOR_OPEN_CAUSES as readonly string[]).toContain(cause);
  });
});

describe("the bounce link", () => {
  const bind = "ab".repeat(32);
  it("is the site's open page with the home id and the key hash", () => {
    expect(bounceUrl("https://murage.ai", "home_1", bind)).toBe(`https://murage.ai/home/cloud/open?home=home_1&auto=1&k=${bind}`);
    expect(bounceUrl("https://murage-site-preview.vercel.app", "h-2", bind)).toBe(`https://murage-site-preview.vercel.app/home/cloud/open?home=h-2&auto=1&k=${bind}`);
  });
  it("is absent without a bare https origin, a plain home id or a 64-hex bind", () => {
    for (const site of [null, undefined, "", "http://murage.ai", "https://murage.ai/path", "https://u:p@murage.ai", "javascript:alert(1)", "https://murage.ai?x=1"]) expect(bounceUrl(site, "home-1", bind), String(site)).toBeNull();
    for (const id of [null, "", "a b", "../x", "a&b=c"]) expect(bounceUrl("https://murage.ai", id, bind)).toBeNull();
    for (const k of [null, "", "AB".repeat(32), "ab".repeat(31), "zz".repeat(32)]) expect(bounceUrl("https://murage.ai", "home-1", k)).toBeNull();
  });
  it("reads only the two meta values", () => {
    const doc = { querySelector: (q: string) => ({ getAttribute: () => (q.includes("home-id") ? "h1" : q.includes("site-origin") ? "https://murage.ai" : null) }) } as unknown as Document;
    expect(homeMeta(doc)).toEqual({ homeId: "h1", siteOrigin: "https://murage.ai" });
  });
});
describe("the device keys", () => {
  it("ensureDevice stores both pairs before any network call", async () => {
    const calls = stubFetch(() => ({ status: 200 }));
    const device = await ensureDevice();
    expect(device.deviceId).toBeNull();
    const stored = idb.map.get("this-home") as Record<string, CryptoKey>;
    for (const field of ["privateKey", "publicKey", "assertionPrivateKey", "assertionPublicKey"]) expect(stored[field], field).toBeTruthy();
    expect(stored.privateKey!.extractable).toBe(false); expect(stored.assertionPrivateKey!.extractable).toBe(false);
    expect(calls).toHaveLength(0);
    expect((await ensureDevice()).publicKey).toBe(stored.publicKey);
  });
  it("a failed store throws StorageRefused and never calls the network", async () => {
    const calls = stubFetch(() => ({ status: 200 }));
    idb.refuse = true;
    await expect(ensureDevice()).rejects.toBeInstanceOf(StorageRefused);
    await expect(enterWithTicket("a.b")).rejects.toBeInstanceOf(StorageRefused);
    expect(calls.filter(call => call.url !== "/api/cloud/enter/report")).toHaveLength(0);
  });
  it("a v1 record (no assertion pair) is deleted, replaced, and reported as v1_record", async () => {
    const calls = stubFetch(() => ({ status: 200 }));
    const v1 = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    idb.map.set("this-home", { deviceId: "old", privateKey: v1.privateKey, publicKey: v1.publicKey });
    const device = await ensureDevice();
    expect(device.deviceId).toBeNull();
    expect(device.publicKey).not.toBe(v1.publicKey);
    expect((idb.map.get("this-home") as any).assertionPrivateKey).toBeTruthy();
    expect(sentBodies(calls, "/api/cloud/enter/report")).toEqual([{ stage: "v1_record", error: "none" }]);
  });
  it("bindOf equals Node's sha256 over the SPKI DER", async () => {
    const device = await ensureDevice();
    const der = Buffer.from(await crypto.subtle.exportKey("spki", device.publicKey));
    expect(await bindOf(device)).toBe(createHash("sha256").update(der).digest("hex"));
    expect(await bindOf(device)).toMatch(/^[0-9a-f]{64}$/);
  });
});
describe("entering with a ticket", () => {
  it("sends both keys and a proof the home can verify, and stores the answered deviceId", async () => {
    const calls = stubFetch(url => url === "/api/cloud/enter" ? { status: 200, body: { state: "signed-in", reason: "first-device", deviceId: "dev_9", scope: "browser", expiresIn: 900 } } : { status: 200 });
    expect(await enterWithTicket("payload.sig")).toBe("signed-in");
    const [sent] = sentBodies(calls, "/api/cloud/enter");
    expect(sent.ticket).toBe("payload.sig");
    expect(sent.device.deviceId).toBeNull();
    const publicKey = createPublicKey(sent.device.publicKey);
    expect(createPublicKey(sent.device.assertionKey).export({ type: "spki", format: "pem" })).not.toBe(publicKey.export({ type: "spki", format: "pem" }));
    expect(nodeVerify("sha256", Buffer.from("murage-door-v2:payload.sig"), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(fromB64url(sent.device.proof)))).toBe(true);
    expect(nodeVerify("sha256", Buffer.from("murage-door-v2:other.sig"), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(fromB64url(sent.device.proof)))).toBe(false);
    // §4.2: the assertion key signs its own message, verifiable by node ieee-p1363.
    const assertionKey = createPublicKey(sent.device.assertionKey);
    expect(nodeVerify("sha256", Buffer.from("murage-door-v2-assertion:payload.sig"), { key: assertionKey, dsaEncoding: "ieee-p1363" }, Buffer.from(fromB64url(sent.device.assertionProof)))).toBe(true);
    expect(nodeVerify("sha256", Buffer.from("murage-door-v2:payload.sig"), { key: assertionKey, dsaEncoding: "ieee-p1363" }, Buffer.from(fromB64url(sent.device.assertionProof)))).toBe(false);
    expect((await loadDevice())?.deviceId).toBe("dev_9");
  });
  it("reads the owner state the home answers, and exports no signStepUp", async () => {
    stubFetch(url => url === "/api/cloud/enter" ? { status: 200, body: { state: "signed-in", reason: "first-device", deviceId: "dev_o", scope: "browser", expiresIn: 900, owner: true, ownerUntil: 123 } } : { status: 200 });
    expect(await enterWithTicket("p.s")).toBe("signed-in");
    expect(enteredOwnerState()).toEqual({ owner: true, ownerUntil: 123 });
    const mod = await import("./cloud-door");
    expect("signStepUp" in mod).toBe(false);
  });
  it("maps the home's answers to coarse results", async () => {
    const cases: Array<[number, unknown, string]> = [
      [403, { reason: "expired" }, "expired"], [429, {}, "expired"], [403, { reason: "too_many_devices" }, "too-many"],
      [403, { reason: "hold_required" }, "hold"], [403, { reason: "refused" }, "failed"], [500, {}, "failed"],
    ];
    for (const [status, body, expected] of cases) {
      stubFetch(() => ({ status, body }));
      expect(await enterWithTicket("a.b"), `${status} ${JSON.stringify(body)}`).toBe(expected);
    }
    expect((await loadDevice())?.deviceId).toBeNull();
  });
});
describe("refreshing the session", () => {
  it("returns false without a stored deviceId and makes no call", async () => {
    const calls = stubFetch(() => ({ status: 200 }));
    await ensureDevice();
    expect(await refreshSession()).toBe(false);
    expect(calls).toHaveLength(0);
  });
  it("signs the refresh with the session key", async () => {
    const device = await ensureDevice();
    await saveDevice({ ...device, deviceId: "dev_1" });
    const calls = stubFetch(url => url === "/api/cloud/challenge" ? { status: 200, body: { environmentId: "env", challenge: "ch" } } : { status: 200 });
    expect(await refreshSession()).toBe(true);
    const [sent] = sentBodies(calls, "/api/cloud/refresh");
    const spki = Buffer.from(await crypto.subtle.exportKey("spki", device.publicKey));
    expect(nodeVerify("sha256", Buffer.from(refreshMessage("env", "dev_1", "ch", sent.at)), { key: createPublicKey({ key: spki, format: "der", type: "spki" }), dsaEncoding: "ieee-p1363" }, Buffer.from(fromB64url(sent.signature)))).toBe(true);
  });
  it("a 403 from the challenge or the refresh clears only the deviceId", async () => {
    for (const refusing of ["/api/cloud/challenge", "/api/cloud/refresh"]) {
      idb.map.clear();
      const device = await ensureDevice();
      await saveDevice({ ...device, deviceId: "dev_1" });
      stubFetch(url => url === refusing ? { status: 403 } : { status: 200, body: { environmentId: "env", challenge: "ch" } });
      expect(await refreshSession()).toBe(false);
      const stored = idb.map.get("this-home") as Record<string, unknown>;
      expect(stored.deviceId, refusing).toBeNull();
      expect(stored.privateKey).toBe(device.privateKey); expect(stored.assertionPrivateKey).toBe(device.assertionPrivateKey);
    }
  });
  it("any other failure keeps everything", async () => {
    const device = await ensureDevice();
    await saveDevice({ ...device, deviceId: "dev_1" });
    stubFetch(() => ({ status: 500 }));
    expect(await refreshSession()).toBe(false);
    expect((idb.map.get("this-home") as any).deviceId).toBe("dev_1");
  });
});
describe("no passkeys", () => {
  it("the module never touches navigator.credentials and carries no passkey copy", () => {
    const source = readFileSync(new URL("./cloud-door.ts", import.meta.url), "utf8");
    expect(source).not.toContain("navigator.credentials");
    expect(source.toLowerCase()).not.toContain("passkey");
    expect(source).not.toContain("Continue from murage.ai");
  });
});
describe("ticket and wire helpers", () => {
  it("takes only #t=<payload>.<signature>", () => {
    expect(ticketFromHash("#t=abc_-.def")).toBe("abc_-.def");
    for (const h of ["", "#t=abc", "#x=a.b", "#t=a.b&next=https://evil", "#t=a.b.c", "#t=a b.c"]) expect(ticketFromHash(h), h).toBeNull();
  });
  it("round-trips base64url, builds PEM and the exact signed messages the home checks", () => {
    const bytes = Uint8Array.from([251, 255, 0, 1, 2]);
    expect(b64url(bytes)).toBe("-_8AAQI"); expect([...fromB64url("-_8AAQI")]).toEqual([...bytes]);
    expect(spkiToPem(bytes)).toMatch(/^-----BEGIN PUBLIC KEY-----\n.+\n-----END PUBLIC KEY-----\n$/s);
    expect(refreshMessage("env", "dev", "ch", 5)).toBe("murage:env:dev:refresh:ch:5");
  });
});
describe("problem reports", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it("send only a known error name: never a message, a key or a ticket", () => {
    expect(doorErrorName(undefined)).toBe("none");
    expect(doorErrorName(new DOMException("The operation either timed out or was not allowed. secret-ticket", "NotAllowedError"))).toBe("NotAllowedError");
    expect(doorErrorName(new TypeError("x"))).toBe("TypeError");
    for (const v of [null, "NotAllowedError", 5, new Error("eyJhbGciOiJFUzI1NiJ9.x.y"), { name: "a.b" }, { name: "x".repeat(500) }, Object.assign(new Error(), { name: "toString" })]) expect(doorErrorName(v)).toBe("unknown");
  });
  it("post {stage, error} to the report route, and never throw when the post fails", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => { throw new TypeError("offline"); });
    vi.stubGlobal("fetch", fetchMock);
    expect(() => reportDoorProblem("bounce", new DOMException("m", "NotAllowedError"))).not.toThrow();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/cloud/enter/report"); expect(init.method).toBe("POST"); expect(init.credentials).toBe("same-origin");
    expect(JSON.parse(String(init.body))).toEqual({ stage: "bounce", error: "NotAllowedError" });
    vi.stubGlobal("fetch", () => { throw new Error("no fetch"); });
    expect(() => reportDoorProblem("refresh")).not.toThrow();
  });
  it("use only stages and error names the home knows", () => {
    const source = readFileSync(new URL("./cloud-door.ts", import.meta.url), "utf8");
    const stages = /export type DoorStage = ([^;]+);/.exec(source)![1]!.match(/"([a-z_]+)"/g)!.map(v => v.slice(1, -1));
    for (const stage of stages) expect(DOOR_PAGE_STAGES).toContain(stage);
    const names = /const ERROR_NAMES = new Set\(\[([^\]]+)\]/.exec(source)![1]!.match(/"([A-Za-z]+)"/g)!.map(v => v.slice(1, -1));
    for (const name of [...names, "none", "unknown"]) expect(DOOR_PAGE_ERRORS).toContain(name);
  });
  it("replace every silent catch on the door page", () => {
    const door = readFileSync(new URL("../components/cloud/Door.tsx", import.meta.url), "utf8");
    expect(door).not.toMatch(/\.catch\(\(\) =>/);
    expect(door).toContain('reportDoorProblem("unexpected", error)');
    const lib = readFileSync(new URL("./cloud-door.ts", import.meta.url), "utf8");
    for (const stage of ["device_load", "device_forget", "device_save"]) expect(lib).toContain(`reportDoorProblem("${stage}", error)`);
    expect(lib).not.toContain("nothing stored");
  });
});

describe("door requests carry the desktop proof", () => {
  afterEach(() => { setDesktopSurfaceSecretForTest(""); vi.unstubAllGlobals(); });
  it("the problem report, a posted door step and the device list all send the surface mark and the launch secret", async () => {
    setDesktopSurfaceSecretForTest("launch-secret");
    const calls = stubFetch((url) => url === "/api/cloud/devices" ? { status: 200, body: { devices: [], self: null } } : { status: 500 });
    reportDoorProblem("bounce");
    await forgetThisBrowser();
    await listDevices();
    const urls = calls.map(call => call.url);
    expect(urls).toEqual(expect.arrayContaining(["/api/cloud/enter/report", "/api/cloud/devices/forget", "/api/cloud/devices"]));
    for (const call of calls) {
      const headers = call.init!.headers as Record<string, string>;
      expect(headers["x-murage-surface"], call.url).toBe("desktop");
      expect(headers[SURFACE_SECRET_HEADER], call.url).toBe("launch-secret");
    }
    const posted = calls.filter(call => call.init!.method === "POST");
    for (const call of posted) expect((call.init!.headers as Record<string, string>)["content-type"], call.url).toBe("application/json");
    for (const call of calls) expect(call.init!.redirect, call.url).toBe("error");
  });

  it("Make chat-only drives the home's own owner-factor revoke route, not a shortcut", async () => {
    setDesktopSurfaceSecretForTest("launch-secret");
    // The button calls makeChatOnly, which must POST the home's atomic owner-factor revoke route for that exact device id.
    const calls = stubFetch((url) => url === "/api/cloud/devices/dev-7/owner/revoke" ? { status: 200, body: { revoked: true } } : { status: 500 });
    expect(await makeChatOnly("dev-7")).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/cloud/devices/dev-7/owner/revoke");
    expect(calls[0]!.init!.method).toBe("POST");
    expect((calls[0]!.init!.headers as Record<string, string>)["x-murage-surface"]).toBe("desktop");
    const refused = stubFetch(() => ({ status: 403 }));
    expect(await makeChatOnly("dev-7")).toBe(false);
    expect(refused[0]!.url).toBe("/api/cloud/devices/dev-7/owner/revoke");
  });

  it("a redirect answer is refused, not followed: the proof never reaches the redirect target", async () => {
    // A real HTTP server: every door path answers 302 to /landing, which records what reached it.
    const landed: Array<Record<string, string | string[] | undefined>> = [];
    let redirected = 0;
    const server = createServer((req, res) => {
      if (req.url === "/landing") { landed.push(req.headers); res.writeHead(200, { "content-type": "application/json" }).end('{"devices":[],"self":null}'); return; }
      redirected++;
      req.resume();
      res.writeHead(302, { location: "/landing" }).end();
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const realFetch = globalThis.fetch;
    try {
      setDesktopSurfaceSecretForTest("launch-secret");
      // The page's relative door paths, sent to this server with the door's own request options.
      vi.stubGlobal("fetch", (url: string, init?: RequestInit) => realFetch(base + url, init));
      expect(await listDevices()).toBeNull();
      expect(await forgetThisBrowser()).toBe(false);
      reportDoorProblem("bounce");
      await vi.waitFor(() => expect(redirected).toBeGreaterThanOrEqual(3));
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(landed).toEqual([]);
      // Control: the same request without redirect "error" follows the 302 and carries the secret along.
      await realFetch(`${base}/api/cloud/devices`, { headers: { [SURFACE_SECRET_HEADER]: "launch-secret" } });
      expect(landed).toHaveLength(1);
      expect(landed[0][SURFACE_SECRET_HEADER.toLowerCase()]).toBe("launch-secret");
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});
