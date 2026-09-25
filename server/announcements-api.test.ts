// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Announcements through the real routes: a real server with its own data
// directory (launchVerificationServer) reading a loopback stub feed through
// the MURAGE_ANNOUNCEMENTS_URL seam, signed by a key made for this run. The
// stub records every request, so what leaves the machine is checked too.
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const TEST_KEY = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url").toString("base64");

let stub: Server, stubOrigin: string, fixture: VerificationServer, headers: Record<string, string>;
let feedUp = true;
const requests: Array<{ url: string; headers: IncomingHttpHeaders }> = [];

function feed() {
  return Buffer.from(JSON.stringify({
    version: 1,
    issuedAt: "2026-09-25T10:00:00Z",
    items: [
      { id: "flux-voice", kind: "info", layout: "split", accent: "blue", title: "Voice through Flux", body: "Calls now run through **Flux**.", image: `${stubOrigin}/murage/images/voice.png`, imageAlt: "A glowing orb" },
      { id: "old-app", kind: "important", title: "Only for old apps", body: "Update soon.", appVersions: "<0.1.0" },
    ],
  }));
}

const api = async (method: string, path: string, body?: unknown, extra: Record<string, string> = headers) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, type: response.headers.get("content-type"), bytes: Buffer.from(await response.arrayBuffer()) };
};
const list = async () => JSON.parse((await api("GET", "/api/announcements?version=0.1.60")).bytes.toString("utf8")) as { show: boolean; items: Array<{ id: string; image?: string; layout: string; accent: string }> };

describe.skipIf(process.platform === "win32")("announcement routes", () => {
  beforeAll(async () => {
    stub = createServer((req, res) => {
      requests.push({ url: req.url ?? "", headers: req.headers });
      if (!feedUp) { res.writeHead(503); res.end(); return; }
      const bytes = feed();
      if (req.url === "/murage/announcements.json") { res.writeHead(200, { "content-type": "application/json" }); res.end(bytes); return; }
      if (req.url === "/murage/announcements.json.sig") { res.writeHead(200); res.end(sign(null, bytes, privateKey).toString("base64")); return; }
      if (req.url === "/murage/images/voice.png") { res.writeHead(200, { "content-type": "image/png" }); res.end(PNG); return; }
      res.writeHead(404); res.end();
    });
    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
    stubOrigin = `http://127.0.0.1:${(stub.address() as { port: number }).port}`;
    fixture = await launchVerificationServer(process.env, undefined, {
      env: { MURAGE_ANNOUNCEMENTS_URL: `${stubOrigin}/murage/announcements.json`, MURAGE_ANNOUNCEMENTS_TEST_KEY: TEST_KEY },
    });
    const secret = (await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string }).secret;
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
  }, 60000);
  afterAll(async () => {
    await fixture?.close();
    await new Promise<void>((resolve) => stub?.close(() => resolve()));
  });

  it("is desktop only", async () => {
    expect((await api("GET", "/api/announcements?version=0.1.60", undefined, {})).status).toBe(404);
    expect((await api("POST", "/api/announcements/dismiss", { id: "x" }, {})).status).toBe(404);
    expect((await api("GET", "/api/announcements/settings", undefined, {})).status).toBe(404);
  });

  it("fetches the stub at launch, filters locally, and serves the image from its cache", async () => {
    await expect.poll(async () => (await list()).items.map((item) => item.id), { timeout: 15000 }).toEqual(["flux-voice"]);
    const [item] = (await list()).items;
    expect(item).toMatchObject({ layout: "split", accent: "blue" });
    expect(item!.image).toMatch(/^\/api\/announcements\/image\/[0-9a-f]{64}$/);
    const image = await api("GET", item!.image!);
    expect(image.status).toBe(200);
    expect(image.type).toBe("image/png");
    expect(image.bytes.equals(PNG)).toBe(true);
    // what left the machine: three plain GETs with nothing identifying
    expect([...new Set(requests.map((request) => request.url))].sort()).toEqual(["/murage/announcements.json", "/murage/announcements.json.sig", "/murage/images/voice.png"]);
    for (const request of requests) {
      expect(request.url).not.toContain("?");
      expect(request.headers.cookie).toBeUndefined();
      expect(request.headers.authorization).toBeUndefined();
      expect(Object.keys(request.headers).filter((name) => name.startsWith("x-"))).toEqual([]);
      expect(request.headers["user-agent"]).toBe("Murage");
    }
  });

  it("keeps the cached copy when the feed is down after a restart", async () => {
    feedUp = false;
    requests.length = 0;
    await fixture.restart();
    const secret = (await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string }).secret;
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
    await expect.poll(() => requests.length, { timeout: 15000 }).toBeGreaterThan(0);
    expect((await list()).items.map((item) => item.id)).toEqual(["flux-voice"]);
    feedUp = true;
  }, 60000);

  it("remembers a dismissal and the switch in the data dir", async () => {
    expect((await api("POST", "/api/announcements/settings", { show: false })).status).toBe(200);
    expect(await list()).toEqual({ show: false, items: [] });
    expect((await api("POST", "/api/announcements/settings", { show: true })).status).toBe(200);
    expect((await api("POST", "/api/announcements/dismiss", { id: "flux-voice" })).status).toBe(200);
    expect(await list()).toEqual({ show: true, items: [] });
  });
});
