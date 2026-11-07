// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// BOT-CALLS-1020 item 5: the owner routes answer the desktop app only, report key-present but never the key, list the older-settings
// scheduled calls, and the Ask card line carries the resolved language and revision. A fake adapter only: no real calls.
import { afterEach, expect, it } from "vitest";
import { phoneAskLine, setPhoneAskPreview } from "../drivers/phone-tool-schemas.ts";
import { phoneOwnerRoute, parseOwnerSettings } from "./owner-routes.ts";
import { PHONE_SECRETS_ENV, _resetPhoneSecretsForTest, loadPhoneSecretsFromEnv } from "./phone-secrets.ts";
import { MemoryCallStore, PhoneCallService } from "./service.ts";
import { RevisionStore, defaultSettings } from "./settings.ts";
import { ALL_SETTINGS, type PhoneAdapter } from "./vapi-adapter.ts";

const KEY = "fake-key-SECRET-7731";
const desktopWithKey = () => loadPhoneSecretsFromEnv({ [PHONE_SECRETS_ENV]: JSON.stringify({ key: KEY, origin: "https://api.vapi.ai" }) });
let n = 0;
const adapter = {
  vendor: "vapi", supportedLanguages: ["en", "de"], capabilities: Object.fromEntries(ALL_SETTINGS.map((k) => [k, true])),
  setup: async () => ({ numbers: [{ id: "num-1", number: "+15550100", canCallOut: true }] }),
  applySettings: async () => `asst-${++n}`, deleteAssistant: async () => {}, cancel: async () => {},
} as unknown as PhoneAdapter;
const make = () => new PhoneCallService(adapter, new RevisionStore(), () => "en", () => {}, new MemoryCallStore());
const ask = (svc: PhoneCallService, method: string, path: string, body?: unknown, desktop = true, botCredential = false) =>
  phoneOwnerRoute(() => svc, { method, path, body, desktop, botCredential });

afterEach(() => { _resetPhoneSecretsForTest(); setPhoneAskPreview(null); });

it("anyone but the desktop app, and any bot credential, gets 404; other paths are not ours", async () => {
  desktopWithKey();
  const svc = make();
  expect((await ask(svc, "GET", "/api/phone-calls/status", undefined, false))?.status).toBe(404);
  expect((await ask(svc, "GET", "/api/phone-calls/status", undefined, true, true))?.status).toBe(404);
  expect(await ask(svc, "GET", "/api/phone-callsX")).toBeNull();
});

it("status reports key-present only, never the key", async () => {
  const svc = make();
  expect((await ask(svc, "GET", "/api/phone-calls/status"))?.body).toMatchObject({ supported: false, keyPresent: false });
  desktopWithKey();
  const answer = await ask(svc, "GET", "/api/phone-calls/status");
  expect(answer?.body).toMatchObject({ supported: true, keyPresent: true, active: null });
  expect(JSON.stringify(answer)).not.toContain(KEY);
});

it("setup reads numbers, settings save a revision, older scheduled calls are listed, and the Ask line shows language and revision", async () => {
  desktopWithKey();
  const svc = make();
  expect((await ask(svc, "POST", "/api/phone-calls/setup"))?.body).toEqual({ numbers: [{ id: "num-1", number: "+15550100", canCallOut: true }] });
  const settings = defaultSettings("num-1", "Sean");
  expect(parseOwnerSettings({ ...settings, maxSeconds: 5 })).toBeNull();
  expect((await ask(svc, "PUT", "/api/phone-calls/settings", { ...settings, language: "xx" }))?.status).toBe(400);
  expect((await ask(svc, "PUT", "/api/phone-calls/settings", settings))?.body).toEqual({ revision: 1 });
  (svc as unknown as { rows: MemoryCallStore }).rows.put({ id: "c-old", vendorId: "v-old", revision: 1, assistantId: "asst-1", createdAt: 1, status: "scheduled", language: "en", to: "+15550199", goal: "g", details: "", limits: "", when: "2026-11-09T10:00:00Z" });
  expect((await ask(svc, "PUT", "/api/phone-calls/settings", { ...settings, recordAudio: true }))?.body).toEqual({ revision: 2 });
  const status = await ask(svc, "GET", "/api/phone-calls/status");
  expect(status?.body.olderScheduled).toEqual([{ id: "c-old", revision: 1, to: "+15550199", when: "2026-11-09T10:00:00Z" }]);
  expect((await ask(svc, "POST", "/api/phone-calls/c-old/cancel"))?.body).toEqual({ status: "cancelled" });
  expect((await ask(svc, "GET", "/api/phone-calls/status"))?.body.olderScheduled).toEqual([]);

  setPhoneAskPreview((args) => svc.askPreview(args));
  const line = phoneAskLine("mcp__agents__phone_call_place", { to: "+15550100", goal: "Book a table", details: "", limits: "No deposit" });
  expect(line).toContain("Language: en");
  expect(line).toContain("Settings revision 2");
  expect(phoneAskLine("mcp__agents__phone_call_result", { id: "x" })).toBeNull();
});

it("owner Cancel reports abandonment and a later list refresh cancels the identified call once", async () => {
  desktopWithKey();
  const rows = new MemoryCallStore();
  rows.put({ id: "lost", vendorId: "", revision: 1, assistantId: "a", createdAt: 1,
    status: "uncertain", language: "en", to: "+15550123456", goal: "book", details: "", limits: "" });
  let found = false;
  const deleted: string[] = [];
  const svc = new PhoneCallService({
    ...adapter,
    reconcile: async id => { expect(id).toBe("lost"); return found ? { vendorId: "identified", status: "scheduled" } : undefined; },
    cancel: async id => { deleted.push(id); },
  }, new RevisionStore(), () => "en", () => {}, rows);
  expect(await ask(svc, "POST", "/api/phone-calls/lost/cancel")).toEqual({ status: 200, body: { status: "abandoned" } });
  expect(deleted).toEqual([]);
  found = true;
  expect(await ask(svc, "GET", "/api/phone-calls")).toMatchObject({ body: { calls: [{ status: "abandoned" }] } });
  await ask(svc, "GET", "/api/phone-calls");
  expect(deleted).toEqual(["identified"]);
  expect(rows.get("lost")?.abandonCancel).toBe("confirmed");
});
