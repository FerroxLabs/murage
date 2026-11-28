// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// 1.0.23 slice F6 (design 1023-phone-fslices 3.5, pack P20 / I10): the Vapi key goes to the configured vendor origin and nowhere
// else. A sentinel key runs a full place, result, cancel and settings save through the real service and adapter against the loopback
// vendor; the sentinel must appear only in the `authorization` header of requests to the configured origin, and never in a log line,
// a service answer, an owner route answer or an owner error line, even when the vendor's own 401 body carries it.
// Not in this file yet (HOLD, named in CHECKLIST.md): proxy trap, websocket frames, backup export, config.json, the spawned
// engine child's environment, and the `store_unavailable` route case (F5 route signature).
import { afterEach, describe, expect, it } from "vitest";
import { MemoryCallStore } from "./memory-store.ts";
import { phoneOwnerRoute } from "./owner-routes.ts";
import { _resetPhoneSecretsForTest, clearPhoneKey, PHONE_KEY_ORIGIN, setPhoneKeyFromShell } from "./phone-secrets.ts";
import { PhoneCallService } from "./service.ts";
import { defaultSettings, RevisionStore } from "./settings.ts";
import { startFakeVapi } from "./testing/fake-vapi-server.ts";
import { VapiAdapter, type FetchLike } from "./vapi-adapter.ts";

const SENTINEL = "sk-sentinel-3f9a7c1e5b2d4a60";
afterEach(() => _resetPhoneSecretsForTest());

interface Sent { url: string; init: Parameters<FetchLike>[1] }
function recording(inner: FetchLike): { fetchImpl: FetchLike; sent: Sent[] } {
  const sent: Sent[] = [];
  return { sent, fetchImpl: async (url, init) => { sent.push({ url, init }); return inner(url, init); } };
}
const without = (init: Sent["init"]) => JSON.stringify({ ...init, headers: { ...init.headers, authorization: undefined } });

describe("P20 the key goes to the configured vendor endpoint and nowhere else (I10)", () => {
  it("sends the sentinel only as the authorization header to the configured origin, asks for no redirect, and keeps it out of every answer and log", async () => {
    setPhoneKeyFromShell({ key: SENTINEL, origin: PHONE_KEY_ORIGIN });
    const vendor = await startFakeVapi();
    const { fetchImpl, sent } = recording(vendor.fetchImpl);
    const logs: unknown[] = [];
    const service = new PhoneCallService(new VapiAdapter(fetchImpl), new RevisionStore(), () => "en", (line) => logs.push(line), new MemoryCallStore());
    try {
      const answers: unknown[] = [];
      answers.push(await service.saveSettings(defaultSettings("number-1", "Sam")));
      const placed = await service.place({ to: "+12025550101", goal: "Ask about opening hours", when: "2026-12-01T10:00:00Z" });
      answers.push(placed);
      const call = String(placed.ok && placed.value.call);
      answers.push(await service.result({ call }));
      answers.push(await service.cancel(call));
      expect(sent.length, "the whole flow reached the vendor").toBeGreaterThan(3);
      for (const { url, init } of sent) {
        expect(new URL(url).origin, `origin of ${init.method} ${url}`).toBe(PHONE_KEY_ORIGIN);
        expect(init.headers.authorization).toBe(`Bearer ${SENTINEL}`);
        expect(without(init), `${init.method} ${url} carries the key outside authorization`).not.toContain(SENTINEL);
        expect(url).not.toContain(SENTINEL);
        expect(init.redirect, `${init.method} ${url} must refuse redirects`).toBe("error");
      }
      expect(JSON.stringify(answers), "service answers").not.toContain(SENTINEL);
      expect(JSON.stringify(logs), "log lines").not.toContain(SENTINEL);
    } finally { await vendor.close(); }
  });

  it("a 302 answer is an owner refusal and every request went only to the configured host", async () => {
    setPhoneKeyFromShell({ key: SENTINEL, origin: PHONE_KEY_ORIGIN });
    const hosts: string[] = [];
    const redirecting: FetchLike = async (url) => { hosts.push(new URL(url).host); return { status: 302, json: async () => ({ location: "https://other.invalid/steal" }) }; };
    const logs: unknown[] = [];
    const service = new PhoneCallService(new VapiAdapter(redirecting), new RevisionStore(), () => "en", (line) => logs.push(line), new MemoryCallStore());
    const outcome = await service.saveSettings(defaultSettings("number-1", "Sam")).then((v) => ({ ok: true, v }), (e: { code?: string }) => ({ ok: false, code: e.code }));
    expect(outcome).toEqual({ ok: false, code: "vendor_refused" });
    expect(new Set(hosts)).toEqual(new Set(["api.vapi.ai"]));
    expect(JSON.stringify(logs)).not.toContain(SENTINEL);
  });

  it("keeps the vendor's own 401 body, which carries the key, out of every owner line, route answer and log", async () => {
    setPhoneKeyFromShell({ key: SENTINEL, origin: PHONE_KEY_ORIGIN });
    const vendor401: FetchLike = async () => ({ status: 401, json: async () => ({ message: `invalid key ${SENTINEL}`, error: SENTINEL }) });
    const logs: unknown[] = [];
    const service = new PhoneCallService(new VapiAdapter(vendor401), new RevisionStore(), () => "en", (line) => logs.push(line), new MemoryCallStore());
    const answer = await phoneOwnerRoute(() => service, { method: "PUT", path: "/api/phone-calls/settings", body: defaultSettings("number-1", "Sam"), desktop: true, botCredential: false });
    expect(answer?.status).toBe(502);
    expect(answer?.body).toEqual({ error: "vendor_refused" });
    expect(JSON.stringify(answer), "owner error line").not.toContain(SENTINEL);
    const setup = await phoneOwnerRoute(() => service, { method: "POST", path: "/api/phone-calls/setup", body: {}, desktop: true, botCredential: false });
    expect(JSON.stringify(setup), "setup answer").not.toContain(SENTINEL);
    const placed = await service.place({ to: "+12025550101", goal: "Ask about opening hours" });
    expect(JSON.stringify(placed), "place answer").not.toContain(SENTINEL);
    expect(JSON.stringify(logs), "log lines").not.toContain(SENTINEL);
  });

  it("answers not_set_up once the key is removed, and that answer and the status hold no key text", async () => {
    setPhoneKeyFromShell({ key: SENTINEL, origin: PHONE_KEY_ORIGIN });
    clearPhoneKey(); // the owner removed the key: the shell still runs, nothing is held
    const service = new PhoneCallService(new VapiAdapter(async () => { throw new Error("must not be called"); }), new RevisionStore(), () => "en", () => {}, new MemoryCallStore());
    const status = await phoneOwnerRoute(() => service, { method: "GET", path: "/api/phone-calls/status", desktop: true, botCredential: false });
    expect(status).toEqual({ status: 200, body: { supported: true, keyPresent: false, active: null, olderScheduled: [] } });
    const refused = await phoneOwnerRoute(() => service, { method: "PUT", path: "/api/phone-calls/settings", body: defaultSettings("number-1", "Sam"), desktop: true, botCredential: false });
    expect(refused).toEqual({ status: 409, body: { error: "not_set_up" } });
    expect(JSON.stringify([status, refused])).not.toContain(SENTINEL);
    expect(await service.place({ to: "+12025550101", goal: "Ask about opening hours" })).toEqual({ ok: false, error: "not_set_up" });
  });
});
