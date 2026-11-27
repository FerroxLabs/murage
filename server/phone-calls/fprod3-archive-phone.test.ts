// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// FPROD3 Archive, phone side: a bot's vendor calls are cancelled with the vendor's answer checked (T-sched), `place` makes a last
// fence check before any vendor request (T-place), and legacy calls without a bot id are held for the owner (Q6). Fake vendor only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CREATE_CALL_RESPONSE } from "./fixtures/vapi-pinned.ts";
import { _resetPhoneSecretsForTest, setPhoneKeyFromShell } from "./phone-secrets.ts";
import { phoneOwnerRoute } from "./owner-routes.ts";
import { PhoneCallService } from "./service.ts";
import { RevisionStore, defaultSettings } from "./settings.ts";
import { VapiAdapter, type FetchLike } from "./vapi-adapter.ts";

const WHEN = "2026-12-01T10:00:00Z";
function vendor(opts: { cancelFails?: boolean; state?: string } = {}) {
  const sent: string[] = [];
  let created = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    sent.push(`${init.method} ${path}`);
    const reply = (status: number, body: unknown) => ({ status, json: async () => body });
    if (init.method === "POST" && path === "/assistant") return reply(201, { id: "asst-1" });
    if (init.method === "POST" && path === "/call") return reply(201, { ...CREATE_CALL_RESPONSE, id: `vc-${++created}`, status: "scheduled" });
    if (init.method === "GET" && path.startsWith("/call/")) return reply(200, { ...CREATE_CALL_RESPONSE, id: path.slice(6), status: opts.state ?? "scheduled" });
    if (init.method === "DELETE" && path.startsWith("/call/")) return reply(opts.cancelFails ? 400 : 200, {});
    return reply(404, {});
  };
  return { fetchImpl, sent, posts: () => sent.filter((s) => s === "POST /call").length, deletes: () => sent.filter((s) => s.startsWith("DELETE /call/")).length };
}
async function ready(opts: Parameters<typeof vendor>[0] = {}) {
  const v = vendor(opts);
  const service = new PhoneCallService(new VapiAdapter(v.fetchImpl), new RevisionStore(), () => "en");
  await service.saveSettings(defaultSettings("pn-1", "Sam"));
  return { v, service };
}
const args = { to: "+12025550123", goal: "book a table", when: WHEN };
const id = (out: { ok: boolean; value?: Record<string, unknown> }) => String(out.value?.call);

beforeEach(() => setPhoneKeyFromShell({ key: "fake-vapi-key-0000", origin: "https://api.vapi.ai" }));
afterEach(() => _resetPhoneSecretsForTest());

describe("T-sched: cancelForBot", () => {
  it("cancels the bot's scheduled calls at the vendor and leaves another bot's call alone", async () => {
    const { v, service } = await ready();
    const mine = await service.place(args, { botId: "bot-a" });
    const theirs = await service.place({ ...args, to: "+12025550124" }, { botId: "bot-b" });
    expect(await service.cancelForBot("bot-a")).toEqual([{ call: id(mine), status: "confirmed" }]);
    expect(v.deletes()).toBe(1);
    expect(service._row(id(mine))?.status).toBe("cancelled");
    expect(service._row(id(theirs))?.status).toBe("scheduled");
  });

  it("a cancel the vendor refuses, with the call still scheduled, is unconfirmed", async () => {
    const { service } = await ready({ cancelFails: true });
    const mine = await service.place(args, { botId: "bot-a" });
    expect(await service.cancelForBot("bot-a")).toEqual([{ call: id(mine), status: "unconfirmed" }]);
  });

  it("a failed cancel whose call reads ended is confirmed", async () => {
    const ended = await ready({ cancelFails: true, state: "ended" });
    const call = await ended.service.place({ ...args }, { botId: "bot-a" });
    expect(await ended.service.cancelForBot("bot-a")).toEqual([{ call: id(call), status: "confirmed" }]);
  });
});

describe("T-place: the last fence check", () => {
  it("a fence that lands after the entry check makes no vendor request", async () => {
    const { v, service } = await ready();
    let reads = 0;
    const out = await service.place(args, { botId: "bot-a", fenced: () => ++reads > 1 });
    expect(out).toEqual({ ok: false, error: "refused" });
    expect(v.posts()).toBe(0);
  });
  it("a fenced bot never reaches the vendor", async () => {
    const { v, service } = await ready();
    expect(await service.place(args, { botId: "bot-a", fenced: () => true })).toEqual({ ok: false, error: "refused" });
    expect(v.sent.filter((s) => s.includes("/call"))).toEqual([]);
  });
});

describe("Q6: held legacy calls", () => {
  it("a scheduled legacy call is cancelled at the vendor and held; a bot's own call is not touched", async () => {
    const { v, service } = await ready();
    const legacy = await service.place(args);
    const own = await service.place({ ...args, to: "+12025550124" }, { botId: "bot-b" });
    expect(await service.holdLegacyCalls()).toEqual({ held: [id(legacy)], live: [], failed: [] });
    expect(v.deletes()).toBe(1);
    expect(service._row(id(legacy))).toMatchObject({ status: "cancelled", held: "held" });
    expect(service._row(id(own))?.status).toBe("scheduled");
    expect(service.ownerCard(id(legacy))).toMatchObject({ held: "held" });
  });
  it("Keep places it again; Cancel leaves it cancelled and dials nothing", async () => {
    const { v, service } = await ready();
    const a = await service.place(args);
    const b = await service.place({ ...args, to: "+12025550124" });
    await service.holdLegacyCalls();
    const before = v.posts();
    expect((await service.decideHeld(id(b), "cancel")).ok).toBe(true);
    expect(v.posts()).toBe(before);
    expect(service._row(id(b))?.held).toBe("cancelled");
    expect((await service.decideHeld(id(a), "keep")).ok).toBe(true);
    expect(v.posts()).toBe(before + 1);
    expect(service._row(id(a))?.held).toBe("kept");
    expect((await service.decideHeld(id(a), "keep")).ok).toBe(false);
  });
  it("a legacy call already in progress is reported live, not held", async () => {
    const { v, service } = await ready({ state: "in-progress" });
    const legacy = await service.place({ to: "+12025550123", goal: "x" });
    expect(await service.holdLegacyCalls()).toEqual({ held: [], live: [id(legacy)], failed: [] });
    expect(v.deletes()).toBe(0);
  });
  it("a hold whose vendor cancel fails is reported failed", async () => {
    const { service } = await ready({ cancelFails: true });
    const legacy = await service.place(args);
    expect(await service.holdLegacyCalls()).toEqual({ held: [], live: [], failed: [id(legacy)] });
  });
  it("the owner routes carry Keep and Cancel for a held call", async () => {
    const { v, service } = await ready();
    const a = await service.place(args);
    await service.holdLegacyCalls();
    const route = (path: string) => phoneOwnerRoute(() => service, { method: "POST", path, desktop: true, botCredential: false });
    const before = v.posts();
    expect((await route(`/api/phone-calls/${id(a)}/keep`))?.status).toBe(200);
    expect(v.posts()).toBe(before + 1);
    expect((await route(`/api/phone-calls/${id(a)}/keep`))?.status).toBe(404);
  });
});
