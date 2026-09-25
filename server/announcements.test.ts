// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Announcements on the harness: the signature, the cache, the limits and the
// request itself, against a loopback stub feed signed with a key made fresh
// for each run. No real key exists anywhere in this file.
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ANNOUNCEMENT_PUBLIC_KEYS,
  Announcements,
  announcementKeys,
  announcementSource,
  fetchCapped,
  handleAnnouncementsApi,
  verifyAnnouncementSignature,
  type AnnouncementSource,
} from "./announcements.ts";

const keyPair = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, raw: Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url").toString("base64") };
};
const signed = (bytes: Uint8Array, privateKey: KeyObject) => sign(null, bytes, privateKey).toString("base64");
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

const A = keyPair();
const B = keyPair();

describe("the signature", () => {
  const bytes = Buffer.from('{"version":1}');
  it("checks a good signature over the exact bytes", () => {
    expect(verifyAnnouncementSignature(bytes, signed(bytes, A.privateKey), announcementKeys([A.raw]))).toBe(true);
    expect(verifyAnnouncementSignature(bytes, signed(bytes, A.privateKey) + "\n", announcementKeys([A.raw]))).toBe(true);
  });
  it("refuses one tampered byte", () => {
    const tampered = Buffer.from(bytes);
    tampered[3] = tampered[3]! ^ 1;
    expect(verifyAnnouncementSignature(tampered, signed(bytes, A.privateKey), announcementKeys([A.raw]))).toBe(false);
    expect(verifyAnnouncementSignature(Buffer.concat([bytes, Buffer.from(" ")]), signed(bytes, A.privateKey), announcementKeys([A.raw]))).toBe(false);
  });
  it("refuses the wrong key and junk signatures", () => {
    expect(verifyAnnouncementSignature(bytes, signed(bytes, B.privateKey), announcementKeys([A.raw]))).toBe(false);
    expect(verifyAnnouncementSignature(bytes, "not a signature", announcementKeys([A.raw]))).toBe(false);
    expect(verifyAnnouncementSignature(bytes, "", announcementKeys([A.raw]))).toBe(false);
  });
  it("takes either slot, so a key can be rotated", () => {
    expect(verifyAnnouncementSignature(bytes, signed(bytes, B.privateKey), announcementKeys([A.raw, B.raw]))).toBe(true);
    expect(verifyAnnouncementSignature(bytes, signed(bytes, A.privateKey), announcementKeys([A.raw, B.raw]))).toBe(true);
  });
  it("ships placeholder slots that verify nothing, so the app fetches nothing", () => {
    expect(announcementKeys(ANNOUNCEMENT_PUBLIC_KEYS)).toEqual([]);
    expect(ANNOUNCEMENT_PUBLIC_KEYS.every((slot) => slot.startsWith("PLACEHOLDER"))).toBe(true);
    expect(announcementSource({})).toBeNull();
  });
});

describe("where the feed comes from", () => {
  it("honours the test seam only on loopback, with its own key", () => {
    const local = announcementSource({ MURAGE_ANNOUNCEMENTS_URL: "http://127.0.0.1:9/murage/announcements.json", MURAGE_ANNOUNCEMENTS_TEST_KEY: A.raw });
    expect(local).toMatchObject({ feedUrl: "http://127.0.0.1:9/murage/announcements.json", signatureUrl: "http://127.0.0.1:9/murage/announcements.json.sig", imagePrefix: "http://127.0.0.1:9/murage/images/" });
    expect(announcementSource({ MURAGE_ANNOUNCEMENTS_URL: "off" }, [A.raw])).toBeNull();
    // off-box override: ignored, the real feed with the compiled keys
    const real = announcementSource({ MURAGE_ANNOUNCEMENTS_URL: "https://evil.example/a.json", MURAGE_ANNOUNCEMENTS_TEST_KEY: B.raw }, [A.raw]);
    expect(real?.feedUrl).toBe("https://updates.ferroxlabs.com/murage/announcements.json");
    expect(real?.imagePrefix).toBe("https://updates.ferroxlabs.com/murage/images/");
    expect(real?.keys).toHaveLength(1);
  });
});

// ── A loopback stub feed ───────────────────────────────────────────────────
let server: Server, origin: string;
const requests: Array<{ url: string; headers: IncomingHttpHeaders }> = [];
const routes = new Map<string, { status?: number; body: Buffer | string; headers?: Record<string, string> }>();
beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push({ url: req.url ?? "", headers: req.headers });
    const route = routes.get(req.url ?? "");
    if (!route) { res.writeHead(404); res.end(); return; }
    res.writeHead(route.status ?? 200, route.headers ?? {});
    res.end(route.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

let dir: string, source: AnnouncementSource;
const NOW = Date.parse("2026-09-25T12:00:00Z");
const publish = (items: unknown[], options: { issuedAt?: string; key?: KeyObject; tamper?: boolean } = {}) => {
  const bytes = Buffer.from(JSON.stringify({ version: 1, issuedAt: options.issuedAt ?? "2026-09-25T10:00:00Z", items }));
  const signature = signed(bytes, options.key ?? A.privateKey);
  if (options.tamper) bytes[bytes.length - 2] = 0x20;
  routes.set("/murage/announcements.json", { body: bytes });
  routes.set("/murage/announcements.json.sig", { body: signature });
};
const item = (extra: Record<string, unknown> = {}) => ({ id: "voice", kind: "info", title: "Voice calls", body: "Call any bot.", ...extra });
const service = () => new Announcements({ dir, source, now: () => NOW, platform: "darwin" });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "murage-announcements-"));
  routes.clear();
  requests.length = 0;
  source = announcementSource({ MURAGE_ANNOUNCEMENTS_URL: `${origin}/murage/announcements.json`, MURAGE_ANNOUNCEMENTS_TEST_KEY: A.raw })!;
});

describe("fetching", () => {
  it("asks with nothing that identifies the install: no query, no cookie, no version", async () => {
    publish([item()]);
    expect(await service().refresh()).toBe(true);
    expect(requests.map((request) => request.url).sort()).toEqual(["/murage/announcements.json", "/murage/announcements.json.sig"]);
    for (const { headers } of requests) {
      expect(headers.cookie).toBeUndefined();
      expect(headers.authorization).toBeUndefined();
      expect(headers.referer).toBeUndefined();
      expect(Object.keys(headers).filter((name) => name.startsWith("x-"))).toEqual([]);
      expect(headers["user-agent"]).toBe("Murage");
      expect(JSON.stringify({ ...headers, host: "" })).not.toMatch(/\d+\.\d+\.\d+/);
    }
  });

  it("stops at 64 KB even when the length is not declared", async () => {
    routes.set("/big", { body: Buffer.alloc(64 * 1024 + 1, 32), headers: { "transfer-encoding": "chunked" } });
    await expect(fetchCapped(`${origin}/big`, 64 * 1024)).rejects.toThrow("too large");
    routes.set("/ok", { body: Buffer.alloc(64 * 1024, 32) });
    expect((await fetchCapped(`${origin}/ok`, 64 * 1024)).byteLength).toBe(64 * 1024);
  });

  it("gives up after the timeout and does not follow redirects", async () => {
    const hang = createServer(() => {});
    await new Promise<void>((resolve) => hang.listen(0, "127.0.0.1", resolve));
    const port = (hang.address() as { port: number }).port;
    await expect(fetchCapped(`http://127.0.0.1:${port}/`, 1024, { timeoutMs: 150 })).rejects.toThrow();
    hang.closeAllConnections(); hang.close();
    routes.set("/moved", { status: 302, body: "", headers: { location: `${origin}/ok` } });
    await expect(fetchCapped(`${origin}/moved`, 1024)).rejects.toThrow();
  });
});

describe("the cache", () => {
  it("keeps the last good copy, owner-only, and reads it back after a restart", async () => {
    publish([item()]);
    await service().refresh();
    const cached = join(dir, "announcements-cache", "feed.json");
    if (process.platform !== "win32") expect(statSync(cached).mode & 0o777).toBe(0o600);
    routes.clear(); // the feed is down
    const restarted = service();
    expect(await restarted.refresh()).toBe(false);
    expect(restarted.visible("0.1.60").map((entry) => entry.id)).toEqual(["voice"]);
  });

  it("never lets a bad feed blank a good one: tampered, wrong key, older", async () => {
    publish([item()], { issuedAt: "2026-09-25T10:00:00Z" });
    const announcements = service();
    await announcements.refresh();
    publish([item({ id: "tampered" })], { issuedAt: "2026-09-26T10:00:00Z", tamper: true });
    expect(await announcements.refresh()).toBe(false);
    publish([item({ id: "wrong-key" })], { issuedAt: "2026-09-26T10:00:00Z", key: B.privateKey });
    expect(await announcements.refresh()).toBe(false);
    publish([item({ id: "older" })], { issuedAt: "2026-09-24T10:00:00Z" });
    expect(await announcements.refresh()).toBe(false);
    expect(announcements.visible("0.1.60").map((entry) => entry.id)).toEqual(["voice"]);
    // a newer good one replaces it, and a pulled notice goes
    publish([item({ id: "newer" })], { issuedAt: "2026-09-26T10:00:00Z" });
    expect(await announcements.refresh()).toBe(true);
    expect(announcements.visible("0.1.60").map((entry) => entry.id)).toEqual(["newer"]);
  });

  it("does not trust an edited cache", async () => {
    publish([item()]);
    await service().refresh();
    const cached = join(dir, "announcements-cache", "feed.json");
    writeFileSync(cached, readFileSync(cached, "utf8").replace("Call any bot.", "Call any bot now"));
    expect(service().visible("0.1.60")).toEqual([]);
  });
});

describe("images", () => {
  it("fetches an image from the feed's own host once and serves it from the cache", async () => {
    routes.set("/murage/images/voice.png", { body: PNG });
    publish([item({ layout: "hero", image: `${origin}/murage/images/voice.png`, imageAlt: "An orb" })]);
    const announcements = service();
    await announcements.refresh();
    const [view] = announcements.visible("0.1.60");
    expect(view?.image).toMatch(/^\/api\/announcements\/image\/[0-9a-f]{64}$/);
    const id = view!.image!.split("/").pop()!;
    expect(announcements.image(id)).toEqual({ bytes: PNG, contentType: "image/png" });
    const before = requests.filter((request) => request.url.includes("/images/")).length;
    await announcements.refresh();
    expect(requests.filter((request) => request.url.includes("/images/")).length).toBe(before);
  });

  it("drops a notice whose image is off our host or plain http, and hides a picture that is not one", async () => {
    routes.set("/murage/images/fake.png", { body: "<svg onload=alert(1)>" });
    publish([
      item({ id: "off-host", image: "https://evil.example/murage/images/x.png", imageAlt: "x" }),
      item({ id: "not-an-image", layout: "hero", image: `${origin}/murage/images/fake.png`, imageAlt: "x" }),
    ]);
    const announcements = service();
    await announcements.refresh();
    const views = announcements.visible("0.1.60");
    expect(views.map((entry) => entry.id)).toEqual(["not-an-image"]);
    expect(views[0]!.image).toBeUndefined();
    expect(requests.some((request) => request.url.includes("evil"))).toBe(false);
    expect(readdirSync(join(dir, "announcements-cache", "images"))).toEqual([]);
  });
});

describe("routes", () => {
  const call = async (announcements: Announcements, method: string, path: string, body?: unknown, version: string | null = "0.1.60") =>
    (await handleAnnouncementsApi({ method, path, version, readBody: async () => body }, announcements)) as { status: number; body?: unknown };

  it("lists, dismisses for good, and switches optional notices off but never security", async () => {
    publish([item({ id: "news" }), item({ id: "fix", kind: "security", title: "Install 0.1.61" })]);
    const announcements = service();
    await announcements.refresh();
    expect(await call(announcements, "GET", "/api/announcements")).toMatchObject({ status: 200, body: { show: true, items: [{ id: "fix" }, { id: "news" }] } });
    expect((await call(announcements, "POST", "/api/announcements/settings", { show: false })).body).toEqual({ show: false });
    expect(await call(announcements, "GET", "/api/announcements")).toMatchObject({ body: { show: false, items: [{ id: "fix" }] } });
    expect((await call(announcements, "POST", "/api/announcements/dismiss", { id: "fix" })).status).toBe(200);
    expect((await call(announcements, "GET", "/api/announcements")).body).toEqual({ show: false, items: [] });
    expect(existsSync(join(dir, "announcements.json"))).toBe(true);
    expect(service().readRecord()).toEqual({ dismissed: ["fix"], show: false });
  });

  it("refuses bad requests", async () => {
    const announcements = service();
    expect((await call(announcements, "GET", "/api/announcements", undefined, null)).status).toBe(400);
    expect((await call(announcements, "POST", "/api/announcements/dismiss", { id: 5 })).status).toBe(400);
    expect((await call(announcements, "POST", "/api/announcements/settings", { show: "yes" })).status).toBe(400);
    expect((await call(announcements, "GET", "/api/announcements/image/not-an-id")).status).toBe(404);
    expect((await call(announcements, "DELETE", "/api/announcements")).status).toBe(405);
    expect(await handleAnnouncementsApi({ method: "GET", path: "/api/other", readBody: async () => ({}) }, announcements)).toBeNull();
  });
});
