// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
vi.mock("@/state/store", () => ({ api: vi.fn() }));
import { en } from "@/locales";
import { normalizeWhatsAppNumber, whatsappMessage, whatsappStatusFrom } from "./WhatsAppSettings";

const base = {
  state: "idle", linked: false, enabled: false, busy: false, error: null, blockedReason: null, nextRetryAt: null,
  pending: 0, uncertain: 0, rejected: 0, needsReview: 0, ingressWriteFailed: false, catchUpTruncated: false, number: null, pairing: [],
  settings: { mode: "self-chat", allowFrom: [], groups: { policy: "disabled", allow: [], senders: "members" }, readReceipts: false, quoteReplies: "groups" },
};
const status = (extra: Record<string, unknown> = {}) => whatsappStatusFrom({ ...base, ...extra });

it("rejects malformed status payloads and drops undeclared fields", () => {
  expect(status({ authKey: "canary", creds: { me: "x" } })).not.toHaveProperty("authKey");
  expect(status({ authKey: "canary" })).not.toHaveProperty("creds");
  for (const bad of [null, {}, { ...base, state: "unknown" }, { ...base, pending: -1 }, { ...base, linked: "yes" }, { ...base, settings: undefined },
    { ...base, settings: { ...base.settings, mode: "everyone" } }, { ...base, pairing: [{ id: "a", number: "+•••• 1", expiresAt: "soon" }] }])
    expect(() => whatsappStatusFrom(bad)).toThrow();
});

it("keeps a QR and a pairing code only in the shapes the server sends", () => {
  expect(status({ state: "linking", qr: { text: "2@abc", version: 3 } }).qr).toEqual({ text: "2@abc", version: 3 });
  expect(status({ state: "linking", pairingCode: { code: "ABCD2345", phone: "15551234567" } }).pairingCode?.code).toBe("ABCD2345");
  expect(status({ state: "linking", pairingCode: { code: "bad code!", phone: "1" } }).pairingCode).toBeUndefined();
  expect(status({ state: "linking", qr: { text: "x".repeat(5000), version: 1 } }).qr).toBeUndefined();
});

it("describes each link state in plain words", () => {
  expect(whatsappMessage(null)).toContain("Checking");
  expect(whatsappMessage(status({ state: "linking" }))).toBe("Scan this code with the phone that owns the number.");
  expect(whatsappMessage(status({ state: "linking", pairingCode: { code: "ABCD2345", phone: "1" } }))).toContain("Enter this code");
  expect(whatsappMessage(status({ state: "restarting" }))).toContain("restart");
  expect(whatsappMessage(status({ state: "connected", linked: true, number: "+•••• 1234" }))).toBe("Linked to +•••• 1234 as Murage Desktop.");
  expect(whatsappMessage(status({ state: "retry" }))).toBe("WhatsApp is reconnecting.");
  expect(whatsappMessage(status({ state: "logged-out" }))).toContain("Relink");
  expect(whatsappMessage(status({ state: "conflict" }))).toContain("Another WhatsApp Web session");
  expect(whatsappMessage(status({ state: "blocked", blockedReason: "forbidden" }))).toContain("declined");
  expect(whatsappMessage(status({ state: "blocked", blockedReason: "retry-limit" }))).toContain("Resume");
  expect(whatsappMessage(status({ state: "blocked", blockedReason: "credential-store" }))).toContain("Restart Murage");
  expect(whatsappMessage(status({ state: "blocked", blockedReason: "key-missing" }))).toContain("cannot be opened");
  expect(whatsappMessage(status({ state: "blocked", blockedReason: "raw-secret-canary" }))).not.toContain("canary");
});

it("stores allowlist numbers as digits with a country code", () => {
  expect(normalizeWhatsAppNumber("+1 (555) 123-4567")).toBe("15551234567");
  expect(normalizeWhatsAppNumber("0123456789")).toBeNull();
  expect(normalizeWhatsAppNumber("12345")).toBeNull();
  expect(normalizeWhatsAppNumber("not a number")).toBeNull();
});

it("carries the risk card and obeys the copy rules", () => {
  expect(en["whatsapp.risk.unofficial"]).toContain("may restrict or remove a number");
  expect(en["whatsapp.risk.unofficial"]).toContain("spare number");
  expect(en["whatsapp.risk.local"]).toContain("Replies go only to chats that message first");
  const keys = Object.keys(en).filter(key => key.startsWith("whatsapp."));
  expect(keys.length).toBeGreaterThan(60);
  for (const key of keys) {
    const text = en[key as keyof typeof en];
    expect(text, key).not.toMatch(/—|\s[–−]\s/);
    expect(text, key).not.toMatch(/\b(safe|safely|safety|unsafe)\b/i);
    expect(text, key).not.toMatch(/composio|always-on|always on|\$|price|plan/i);
  }
  const source = readFileSync(new URL("./WhatsAppSettings.tsx", import.meta.url), "utf8");
  expect(source).not.toMatch(/coming soon/i);
});

it("describes the exact group activation rule and complete linking help", async () => {
  expect(en["whatsapp.groups.help"]).toContain("replies to a message the bot sent");
  expect(en["whatsapp.groups.help"]).toContain("digits without mentioning anyone else");
  const source = readFileSync(new URL("../../shared/help-index.ts", import.meta.url), "utf8");
  const entry = source.slice(source.indexOf('"id": "features/messaging-apps#whatsapp-set-up"')).split('\n  },')[0];
  expect(entry).toContain("QR or phone code"); expect(entry).toContain("Chosen contacts"); expect(entry).toContain("Groups start disabled");
});
