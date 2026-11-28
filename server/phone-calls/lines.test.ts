// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// D5 P17, P17c, P17d: the opening obeys the owner's two checkboxes; the call conduct rules (never human, voicemail, phone menu,
// done means confirmed) are in every assistant whatever the checkboxes say; an owner who never re-saves gets them after upgrade.
import { afterEach, expect, it } from "vitest";
import { CALL_TEMPLATE_VERSION } from "./contracts.ts";
import { MemoryCallStore } from "./memory-store.ts";
import { _resetPhoneSecretsForTest, PHONE_KEY_ORIGIN, setPhoneKeyFromShell } from "./phone-secrets.ts";
import { engineResult, PhoneCallService } from "./service.ts";
import { defaultSettings, RevisionStore, SHIPPED_AI_LINE, SHIPPED_NOTICE, type PhoneCallSettings, type RevisionState } from "./settings.ts";
import { CALL_LANGUAGES } from "./tables.ts";
import { startFakeVapi } from "./testing/fake-vapi-server.ts";
import { ANALYSIS_SCHEMA, VapiAdapter, vapiAssistantBody } from "./vapi-adapter.ts";

afterEach(() => _resetPhoneSecretsForTest());

type Vendor = Awaited<ReturnType<typeof startFakeVapi>>;
const NEVER_HUMAN = "Never say or suggest you are a human. If asked, say you are an AI assistant calling for the owner.";
const VOICEMAIL = "If you reach voicemail or an answering machine, end the call without leaving a message. The outcome is voicemail.";
const MENU = "If an automated menu answers, say the option you need, or ask for a person. If no person answers within 60 seconds, end the call. The outcome is not_done with reason phone_menu.";

function systemOf(body: Record<string, unknown> | undefined): string {
  const model = body?.model as { messages: { role: string; content: string }[] };
  return model.messages.find(m => m.role === "system")!.content;
}

async function service(vendor: Vendor, settings: Partial<PhoneCallSettings> = {}) {
  setPhoneKeyFromShell({ key: "fixture", origin: PHONE_KEY_ORIGIN });
  const svc = new PhoneCallService(new VapiAdapter(vendor.fetchImpl), new RevisionStore(), () => "en", () => {}, new MemoryCallStore());
  await svc.saveSettings({ ...defaultSettings("number-1", "Sam"), ...settings });
  return svc;
}

function lastCreate(vendor: Vendor) {
  return [...vendor.requests].reverse().find(r => r.method === "POST" && r.path === "/call")!.body!.assistantOverrides as Record<string, unknown>;
}

it("P17 the AI line and notice are on by default and obey the owner both ways", async () => {
  const ai = SHIPPED_AI_LINE.de.split("{owner}").join("Sam");
  const cases: [Partial<PhoneCallSettings>, Record<string, unknown>][] = [
    [{}, { firstMessageMode: "assistant-speaks-first", firstMessage: `${ai} ${SHIPPED_NOTICE.de}` }],
    [{ aiLine: { on: false, edits: {} } }, { firstMessageMode: "assistant-speaks-first", firstMessage: SHIPPED_NOTICE.de }],
    [{ notice: { on: false, edits: {} } }, { firstMessageMode: "assistant-speaks-first", firstMessage: ai }],
    [{ aiLine: { on: false, edits: {} }, notice: { on: false, edits: {} } }, { firstMessageMode: "assistant-waits-for-user" }],
  ];
  for (const [settings, opening] of cases) {
    const vendor = await startFakeVapi();
    try {
      const svc = await service(vendor, { language: "de", ...settings });
      expect((await svc.place({ to: "+4930100001", goal: "Ask about opening hours" })).ok).toBe(true);
      const overrides = lastCreate(vendor);
      expect({ firstMessageMode: overrides.firstMessageMode, ...("firstMessage" in overrides ? { firstMessage: overrides.firstMessage } : {}) }).toEqual(opening);
    } finally { await vendor.close(); }
  }
  expect(defaultSettings("number-1", "Sam")).toMatchObject({ aiLine: { on: true }, notice: { on: true } });
});

it("P17c call conduct: never human, voicemail, phone menu, done means confirmed", async () => {
  for (const language of CALL_LANGUAGES) for (const aiOn of [true, false]) for (const noticeOn of [true, false]) {
    const settings = { ...defaultSettings("number-1", "Sam"), language, aiLine: { on: aiOn, edits: {} }, notice: { on: noticeOn, edits: {} } };
    const system = systemOf(vapiAssistantBody({ number: 1, settings, state: "pending" }));
    expect(system).toContain(NEVER_HUMAN);
    expect(system).toContain(VOICEMAIL);
    expect(system).toContain(MENU);
  }
  expect(ANALYSIS_SCHEMA.properties.reason.enum).toContain("phone_menu");
  expect(ANALYSIS_SCHEMA.properties.outcome).toMatchObject({ description: "done only if the business clearly confirmed the booking or cancellation in this call" });

  // A menu that nobody answered reaches the engine and the owner card as the phone_menu reason, never dropped as unknown.
  const vendor = await startFakeVapi();
  try {
    const svc = await service(vendor);
    const placed = await svc.place({ to: "+12025550101", goal: "Ask about opening hours" });
    const call = String(placed.ok && placed.value.call);
    const fake = vendor.calls.get("fixture-call-1")!;
    vendor.calls.set(fake.id, { ...fake, status: "ended", endedReason: "customer-ended-call", analysis: { structuredData: { outcome: "not_done", reason: "phone_menu" } } });
    const result = await svc.result({ call });
    expect(result).toMatchObject({ ok: true, value: { status: "ended", outcome: "not_done", reason: "phone_menu" } });
    expect(svc.ownerCard(call)).toMatchObject({ outcome: "not_done", reason: "phone_menu" });
    expect(engineResult(svc._row(call)!)).toMatchObject({ reason: "phone_menu" });
  } finally { await vendor.close(); }
});

function preUpgradeState(): RevisionState {
  // Saved by 1.0.20: no template version, AI line off, confirmed on the vendor as assistant-old.
  const settings = { ...defaultSettings("number-1", "Sam"), aiLine: { on: false, edits: {} } };
  return { next: 2, active: 1, revisions: [{ number: 1, settings, assistantId: "assistant-old", state: "active" }] };
}

it("P17d an owner who never re-saves gets the new conduct rules on the first call after upgrade", async () => {
  const vendor = await startFakeVapi();
  try {
    setPhoneKeyFromShell({ key: "fixture", origin: PHONE_KEY_ORIGIN });
    const revisions = new RevisionStore(preUpgradeState());
    const svc = new PhoneCallService(new VapiAdapter(vendor.fetchImpl), revisions, () => "en", () => {}, new MemoryCallStore());
    await svc.upgradeTemplate(); // the start pass, off any turn
    const placed = await svc.place({ to: "+12025550101", goal: "Ask about opening hours" });
    expect(placed.ok).toBe(true);
    const create = [...vendor.requests].reverse().find(r => r.method === "POST" && r.path === "/call")!.body!;
    expect(create.assistantId).not.toBe("assistant-old");
    const system = systemOf(vendor.assistants.get(String(create.assistantId)));
    for (const rule of [NEVER_HUMAN, VOICEMAIL, MENU]) expect(system).toContain(rule);
    const active = revisions.activeForCall();
    expect(active.ok && active.revision.template).toBe(CALL_TEMPLATE_VERSION);
    expect(svc.activeSettings()?.settings).toEqual(preUpgradeState().revisions[0]!.settings);
    expect(svc.upgradeError()).toBeNull();
  } finally { await vendor.close(); }
});

it("P17d a refused upgrade pauses calls, tells the owner, and retries on the next owner refresh", async () => {
  let refuse = true;
  const vendor = await startFakeVapi({ beforeBody: ({ method, path }) => (refuse && method === "POST" && path === "/assistant" ? 503 : undefined) });
  try {
    setPhoneKeyFromShell({ key: "fixture", origin: PHONE_KEY_ORIGIN });
    const svc = new PhoneCallService(new VapiAdapter(vendor.fetchImpl), new RevisionStore(preUpgradeState()), () => "en", () => {}, new MemoryCallStore());
    await svc.upgradeTemplate();
    expect(await svc.place({ to: "+12025550101", goal: "Ask about opening hours" })).toEqual({ ok: false, error: "not_set_up" });
    expect(vendor.creates).toBe(0);
    expect(svc.upgradeError()).toBe("phoneCalls.error.upgrade");
    const tries = () => vendor.requests.filter(r => r.method === "POST" && r.path === "/assistant").length;
    expect(tries()).toBe(1);
    refuse = false;
    await svc.refreshOwnerCalls();
    expect(tries()).toBe(2);
    expect(svc.upgradeError()).toBeNull();
    expect((await svc.place({ to: "+12025550101", goal: "Ask about opening hours" })).ok).toBe(true);
    const create = [...vendor.requests].reverse().find(r => r.method === "POST" && r.path === "/call")!.body!;
    expect(systemOf(vendor.assistants.get(String(create.assistantId)))).toContain(NEVER_HUMAN);
    await svc.refreshOwnerCalls();
    expect(tries()).toBe(2);
  } finally { await vendor.close(); }
});
