import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
vi.mock("@/state/store", () => ({ api: {}, useStore: () => ({ state: { bots: [] }, dispatch: vi.fn() }) }));
import { phoneCallsCardShown, ResultCard, SettingsSteps } from "./PhoneCallsSettings";
import { defaultPhoneSettings, type PhoneCallCard, type PhoneCopy } from "@/lib/phone-calls";
it("renders Cancel on a current-revision scheduled result card, but not an ended card", () => {
  const card = { id: "call", call: "call", status: "scheduled", to: "+15550123456", settings_revision: 1, language: "en", dashboard: "https://dashboard.vapi.ai/calls/vendor" } as PhoneCallCard;
  const copy: PhoneCopy = key => key;
  const html = renderToStaticMarkup(createElement(ResultCard, { card, copy }));
  expect(html).toMatch(/<button[^>]*>phoneCalls.cancel<\/button>/);
  expect(renderToStaticMarkup(createElement(ResultCard, { card: { ...card, status: "ended" }, copy }))).not.toContain("phoneCalls.cancel");
});

it("renders the localized abandonment explanation without offering Cancel again", () => {
  const card = { id: "call", call: "call", status: "abandoned", to: "+15550123456",
    settings_revision: 1, language: "en", dashboard: "" } as PhoneCallCard;
  const html = renderToStaticMarkup(createElement(ResultCard, { card, copy: key => key }));
  expect(html).toContain("phoneCalls.status.abandoned");
  expect(html).not.toContain("phoneCalls.cancel");
});

// G9 Calls ruling (MAIN 2026-11-17T13:06Z, bar 1): the saved-settings counter is internal and is not rendered.
it("renders the saved call settings without the settings-version counter", () => {
  const copy: PhoneCopy = (key, params) => `${key}${params ? JSON.stringify(params) : ""}`;
  const status = { supported: true, keyPresent: true, active: { revision: 4242, settings: defaultPhoneSettings("pn-1", "Sam") }, olderScheduled: [] };
  const html = renderToStaticMarkup(createElement(SettingsSteps, { copy, status, ownerName: "Sam", onChanged: async () => {} }));
  expect(html).toContain("phoneCalls.form.save");
  expect(html).not.toContain("4242");
  expect(html).not.toContain("phoneCalls.form.inUse");
});

// 1.0.21 polish (STANDING, Sean's live 1.0.20 walk): Calls and Connected apps both showed the same Vapi setup card for a
// voice account nobody connected. The card is invisible unless the account is connected (its key is saved).
it("shows the phone calls card only once a voice account is connected or the owner still holds a call history", () => {
  const bridge = {} as Parameters<typeof phoneCallsCardShown>[1];
  const status = (keyPresent: boolean) => ({ supported: true, keyPresent, active: null, olderScheduled: [] });
  expect(phoneCallsCardShown({ kind: "loading" }, bridge)).toBe(false);
  expect(phoneCallsCardShown({ kind: "failed" }, bridge)).toBe(false);
  expect(phoneCallsCardShown({ kind: "ready", status: null }, bridge)).toBe(false);
  expect(phoneCallsCardShown({ kind: "ready", status: status(false) }, bridge)).toBe(false);
  // 1.0.23 F4 (FABLE-DESIGN 2060 H1, W10): without a key the card shows only while the store holds calls (hasCalls)
  expect(phoneCallsCardShown({ kind: "ready", status: { ...status(false), hasCalls: false } }, bridge)).toBe(false);
  expect(phoneCallsCardShown({ kind: "ready", status: { ...status(false), hasCalls: true } }, bridge)).toBe(true);
  expect(phoneCallsCardShown({ kind: "ready", status: { ...status(false), hasCalls: true, supported: false } }, bridge)).toBe(false);
  expect(phoneCallsCardShown({ kind: "ready", status: { ...status(false), hasCalls: true } }, undefined)).toBe(false);
  expect(phoneCallsCardShown({ kind: "ready", status: { ...status(true), supported: false } }, bridge)).toBe(false);
  expect(phoneCallsCardShown({ kind: "ready", status: status(true) }, undefined)).toBe(false);
  expect(phoneCallsCardShown({ kind: "ready", status: status(true) }, bridge)).toBe(true);
});
