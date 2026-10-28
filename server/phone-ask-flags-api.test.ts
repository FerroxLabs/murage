// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.9 share and ask, Opus S2 H1 and M2 through the real server.
// H1: the two flags stand alone. With only phoneShareAsk on, the companion door's ask mint report (POST /api/phones/minted) must be
// answered by the ask family, or the door reads a 404 as "not offered" and throws the new token away. With only phoneTools on, the
// jobs mint still works.
// M2: the commit section checks the offer against the config as it is NOW, not as it was when the upload began.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const posixOnly = describe.skipIf(process.platform === "win32");
const DOOR = "c".repeat(64);
const DEVICE = "22222222-2222-4222-8222-222222222222";
const ask = { "x-test-bare-loopback": "1", "x-murage-door-token": DOOR, "x-murage-phone-device": DEVICE, "x-murage-phone-scope": "ask", "x-murage-phone-ask-gen": "1" };
const companion = { "x-test-bare-loopback": "1", "x-murage-companion": "1", "x-murage-companion-token": DOOR };

let fixture: VerificationServer;
let desktop: Record<string, string> = {};
const api = async (method: string, path: string, headers: Record<string, string>, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as any };
};
const boot = async (features: Record<string, boolean>) => {
  fixture = await launchVerificationServer(process.env);
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  expect((await api("PATCH", "/api/config", desktop, { features })).status).toBe(200);
};

posixOnly("phoneShareAsk on, phoneTools off (H1)", () => {
  beforeAll(() => boot({ phoneShareAsk: true }), 90000);
  afterAll(async () => { await fixture?.close(); });

  it("the ask mint report is answered 200, then the ask token reaches targets (the door keeps the token)", async () => {
    const minted = await api("POST", "/api/phones/minted", companion, { deviceId: DEVICE, scope: "ask" });
    expect(minted).toMatchObject({ status: 200, body: { ok: true } });
    expect((await api("GET", "/api/phones/self/targets", ask)).status).toBe(200);
  });

  it("a mint report needs the companion, a body it can read, and a jobs mint is not offered", async () => {
    // an earlier gate may answer first (403 or 404); what matters is that neither is a 200
    for (const who of [{ "x-test-bare-loopback": "1" }, desktop]) expect([403, 404]).toContain((await api("POST", "/api/phones/minted", who, { deviceId: DEVICE, scope: "ask" })).status);
    expect((await api("POST", "/api/phones/minted", companion, { deviceId: DEVICE, scope: "ask", extra: 1 })).status).toBe(400);
    expect((await api("POST", "/api/phones/minted", companion, { deviceId: "bad id" })).status).toBe(400);
    expect((await api("POST", "/api/phones/minted", companion, { deviceId: DEVICE, scope: "jobs" })).status).toBe(404);
    expect((await api("POST", "/api/phones/minted", companion, { deviceId: DEVICE })).status).toBe(404);
  });
});

posixOnly("phoneTools on, phoneShareAsk off (H1 mirror)", () => {
  beforeAll(() => boot({ phoneTools: true }), 90000);
  afterAll(async () => { await fixture?.close(); });

  it("the jobs mint report is still answered 200 and the ask paths stay absent", async () => {
    expect(await api("POST", "/api/phones/minted", companion, { deviceId: DEVICE, scope: "jobs" })).toMatchObject({ status: 200, body: { ok: true } });
    expect(await api("POST", "/api/phones/minted", companion, { deviceId: DEVICE })).toMatchObject({ status: 200, body: { ok: true } });
    expect((await api("GET", "/api/phones/self/targets", ask)).status).toBe(404);
  });

  it("an ask mint report is 404 when phoneShareAsk is off (Grok S2 M)", async () => {
    expect((await api("POST", "/api/phones/minted", companion, { deviceId: DEVICE, scope: "ask" })).status).toBe(404);
  });
});

posixOnly("both flags on (Grok S2 M)", () => {
  beforeAll(() => boot({ phoneTools: true, phoneShareAsk: true }), 90000);
  afterAll(async () => { await fixture?.close(); });

  it("the ask mint report is answered 200 and a jobs mint still is too", async () => {
    expect(await api("POST", "/api/phones/minted", companion, { deviceId: DEVICE, scope: "ask" })).toMatchObject({ status: 200, body: { ok: true } });
    expect(await api("POST", "/api/phones/minted", companion, { deviceId: DEVICE, scope: "jobs" })).toMatchObject({ status: 200, body: { ok: true } });
  });
});

posixOnly("the offer is read fresh in the commit section (M2)", () => {
  beforeAll(() => boot({ phoneShareAsk: true }), 90000);
  afterAll(async () => { await fixture?.close(); });

  it("turning phoneShareAsk off while a share uploads refuses the commit and queues nothing", async () => {
    const created = await api("POST", "/api/bots", desktop);
    expect(created.status).toBe(201);
    const bot = created.body.bot as { id: string; threadId: string };
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png m2")]);
    const B = "m2-boundary";
    const manifest = { shareId: "share_m2_world_abcdefgh", botId: bot.id, threadId: bot.threadId, note: "late", items: [{ n: 1, name: "a.png", mime: "image/png", bytes: png.length, sha256: createHash("sha256").update(png).digest("hex") }] };
    const head = Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="manifest"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(manifest)}\r\n--${B}\r\nContent-Disposition: form-data; name="item-1"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`);
    const tail = Buffer.concat([png, Buffer.from(`\r\n--${B}--\r\n`)]);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const body = new ReadableStream<Uint8Array>({
      async start(controller) { controller.enqueue(head); await gate; controller.enqueue(tail); controller.close(); },
    });
    const sent = fetch(`${fixture.info.url}/api/phones/self/share`, { method: "POST", headers: { ...ask, "content-type": `multipart/form-data; boundary=${B}` }, body, duplex: "half" } as RequestInit);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect((await api("PATCH", "/api/config", desktop, { features: { phoneShareAsk: false } })).status).toBe(200);
    release();
    const response = await sent;
    const answered = (await response.json()) as { code?: string };
    expect(response.status).toBe(409);
    expect(answered.code).toBe("target_gone");
  });
});
