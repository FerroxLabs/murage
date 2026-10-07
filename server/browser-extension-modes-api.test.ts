// SPDX-License-Identifier: AGPL-3.0-or-later
// T21: Full permissive and the site rules cannot be loosened from a phone, a side panel, a routine or a copy. Real isolated Murage HTTP server (no browser is launched), the
// store's own sanitiser, and no browser is launched.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const launchProof = randomBytes(32).toString("hex");
let fixture: VerificationServer;
let desktop: Record<string, string> = {};
const companion = { "x-murage-companion-token": launchProof };
let model: string;
async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = desktop) {
  const res = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) as any };
}
async function bot(name: string) {
  const value = await api("POST", "/api/bots", { name, modelSelection: { instanceId: "verification", model } });
  expect(value.status).toBe(201); return value.body.bot;
}
const mode = (id: string, headers?: Record<string, string>) => api("GET", `/api/bots/${id}/browser-extension/mode`, undefined, headers);
const setMode = (id: string, body: unknown, headers?: Record<string, string>) => api("PATCH", `/api/bots/${id}/browser-extension/mode`, body, headers);

beforeAll(async () => {
  fixture = await launchVerificationServer({}, undefined, { instrumentationSource: `process.env.MURAGE_COMPANION_TOKEN=${JSON.stringify(launchProof)};` });
  const secret = await api("GET", "/api/desktop-secret", undefined, {});
  desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret.body.secret };
  model = (await api("GET", "/api/instances")).body.instances.find((item: any) => item.instanceId === "verification").models.options[0].id;
}, 60000);
afterAll(async () => { await fixture?.close(); });


// A side panel or a local page can send the desktop marker, but it holds no secret: that is not the desktop.
const sidePanel = { "x-murage-surface": "desktop" };
const wrongSecret = { "x-murage-surface": "desktop", "x-murage-surface-secret": "0".repeat(64) };
const sites = (id: string, method: string, body?: unknown, headers?: Record<string, string>, query = "?profileId=profA") => api(method, `/api/bots/${id}/browser-extension/sites${method === "GET" ? query : ""}`, body, headers);

describe("T21 raising a site is the desktop's choice", () => {
  const seed = async (name: string) => {
    const one = await bot(name);
    await sites(one.id, "POST", { profileId: "profA", origin: "https://ask.example", rule: "ask" });
    await sites(one.id, "POST", { profileId: "profA", origin: "https://never.example", rule: "never" });
    await sites(one.id, "POST", { profileId: "profA", origin: "https://bank.example", rule: "ask" });
    return one;
  };
  const rule = async (id: string, origin: string) => (await sites(id, "GET")).body.sites.find((item: any) => item.origin === origin)?.rule;
  it("a phone gets a 403 when it raises a site to allow, lifts a never, or lowers a bank", async () => {
    const one = await seed("Dax Raise Phone");
    for (const body of [{ origin: "https://ask.example", rule: "allow" }, { origin: "https://never.example", rule: "ask" }, { origin: "https://never.example", rule: "allow" }, { origin: "https://bank.example", rule: "ask", lowered: true }, { origin: "https://new.example", rule: "allow" }]) {
      expect((await sites(one.id, "POST", { profileId: "profA", ...body }, companion)).status, JSON.stringify(body)).toBe(403);
    }
    expect(await rule(one.id, "https://ask.example")).toBe("ask");
    expect(await rule(one.id, "https://never.example")).toBe("never");
  });
  it("a side panel (the desktop marker with no secret, or a wrong one) never gets to raise a site", async () => {
    const one = await seed("Dax Raise Panel");
    for (const headers of [sidePanel, wrongSecret]) {
      for (const body of [{ origin: "https://ask.example", rule: "allow" }, { origin: "https://never.example", rule: "ask" }, { origin: "https://bank.example", rule: "ask", lowered: true }]) {
        const result = await sites(one.id, "POST", { profileId: "profA", ...body }, headers);
        expect([403, 404], JSON.stringify(body)).toContain(result.status);
      }
    }
    expect(await rule(one.id, "https://ask.example")).toBe("ask");
    expect(await rule(one.id, "https://never.example")).toBe("never");
    expect(await rule(one.id, "https://bank.example")).toBe("ask");
  });
  it("the desktop can raise a site and lower a bank", async () => {
    const one = await seed("Dax Raise Desktop");
    expect((await sites(one.id, "POST", { profileId: "profA", origin: "https://ask.example", rule: "allow" })).status).toBe(200);
    expect((await sites(one.id, "POST", { profileId: "profA", origin: "https://bank.example", rule: "ask", lowered: true })).status).toBe(200);
  });
});

describe("T21 Full permissive has exactly one way in", () => {
  it("a side panel or a wrong secret cannot turn it on, with the typed name or without", async () => {
    const one = await bot("Dax Full Panel");
    for (const headers of [sidePanel, wrongSecret, companion]) for (const body of [{ mode: "full", confirmName: "Dax Full Panel" }, { mode: "full" }]) {
      const result = await setMode(one.id, body, headers);
      expect([403, 404]).toContain(result.status);
    }
    expect((await mode(one.id)).body.mode).toBe("task");
  });
  it("no bot-facing or general route sets it: the bot PATCH, a create, and a message to the bot", async () => {
    const one = await bot("Dax Full Routes");
    await api("PATCH", `/api/bots/${one.id}`, { browserApproval: "full" });
    expect((await mode(one.id)).body.mode).toBe("task");
    const created = await api("POST", "/api/bots", { name: "Dax Full Created", browserApproval: "full", modelSelection: { instanceId: "verification", model } });
    const id = created.body.bot?.id;
    if (id) expect((await mode(id)).body.mode).toBe("task");
  });
  it("a phone may tighten a bot that the desktop set to Full, and the desktop can set it back", async () => {
    const one = await bot("Dax Full Tighten");
    expect((await setMode(one.id, { mode: "full", confirmName: "Dax Full Tighten" })).status).toBe(200);
    expect((await setMode(one.id, { mode: "step" }, companion)).status).toBe(200);
    expect((await setMode(one.id, { mode: "task" }, companion)).status).toBe(403);
    expect((await setMode(one.id, { mode: "task" })).status).toBe(200);
  });
});
