// Copyright 2026 Ferrox Labs
// Fixtures ported from Hermes Agent scripts/whatsapp-bridge/outbound_ids.test.mjs and
// owner_message_gate.test.mjs (MIT, Nous Research); ring persistence is Murage's.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { classifyOwnerGate, createEchoLedger, createSentRing, deliveryIdFor, SENT_RING_MAX, SENT_RING_TTL_MS, webhookIdFor, type ReservedRecord } from "./echo.ts";

describe("sent ring (Hermes outbound_ids)", () => {
  it("remembers and recognises an outbound id", () => {
    const ring = createSentRing();
    ring.remember("msg-1");
    expect(ring.has("msg-1")).toBe(true);
    expect(ring.has("msg-2")).toBe(false);
  });
  it("ignores empty ids", () => {
    const ring = createSentRing();
    ring.remember(undefined);
    ring.remember("");
    ring.remember(null);
    expect(ring.size()).toBe(0);
    expect(ring.has("")).toBe(false);
    expect(ring.has(undefined)).toBe(false);
  });
  it("evicts the oldest entry once the cap is exceeded", () => {
    const ring = createSentRing({ max: 3 });
    for (const id of ["a", "b", "c", "d"]) ring.remember(id);
    expect(ring.has("a")).toBe(false);
    expect(["b", "c", "d"].every((id) => ring.has(id))).toBe(true);
    expect(ring.size()).toBe(3);
  });
  it("holds its cap across many inserts", () => {
    const ring = createSentRing({ max: 8 });
    for (let i = 0; i < 100; i += 1) ring.remember(`id-${i}`);
    expect(ring.size()).toBe(8);
    expect(ring.has("id-91")).toBe(false);
    expect(ring.has("id-92")).toBe(true);
    expect(ring.has("id-99")).toBe(true);
  });
  it("is FIFO, not LRU: re-remembering does not promote", () => {
    const ring = createSentRing({ max: 2 });
    ring.remember("a");
    ring.remember("b");
    ring.remember("a");
    ring.remember("c");
    expect(ring.has("a")).toBe(false);
    expect(ring.has("b")).toBe(true);
    expect(ring.has("c")).toBe(true);
  });
  it("rejects a non-positive max", () => {
    expect(() => createSentRing({ max: 0 })).toThrow(RangeError);
    expect(() => createSentRing({ max: -1 })).toThrow(RangeError);
    expect(() => createSentRing({ max: 1.5 })).toThrow(RangeError);
  });
  it("forgets ids after the time limit (7 days)", () => {
    let now = 1_000;
    const ring = createSentRing({ ttlMs: 20 * 60_000, now: () => now });
    ring.remember("x");
    now += 20 * 60_000 - 1;
    expect(ring.has("x")).toBe(true);
    now += 1;
    expect(ring.has("x")).toBe(false);
  });
  it("round-trips through snapshot so a restart keeps the echo guard", () => {
    let now = 5_000;
    const first = createSentRing({ now: () => now });
    first.remember("a");
    now += 1000;
    first.remember("b");
    const snapshot = JSON.parse(JSON.stringify(first.snapshot()));
    const second = createSentRing({ now: () => now, initial: snapshot });
    expect(second.has("a")).toBe(true);
    expect(second.has("b")).toBe(true);
    expect(second.snapshot().map((e) => e.id)).toEqual(["a", "b"]);
    now += SENT_RING_TTL_MS;
    expect(createSentRing({ now: () => now, initial: snapshot }).size()).toBe(0);
  });
  it("ignores malformed initial entries", () => {
    const ring = createSentRing({ initial: [{ id: "", at: 1 }, { id: "ok", at: Date.now() }, { id: "nan", at: Number.NaN }] });
    expect(ring.snapshot().map((e) => e.id)).toEqual(["ok"]);
  });
});

const recentlySent = (ids: string[] = []) => { const set = new Set(ids); return { has: (id: string) => set.has(id) }; };
const allowlist = (ids: string[] | "*") => (ids === "*" ? () => true : (id: string) => ids.includes(id));

describe("owner gate (Hermes owner_message_gate)", () => {
  const base = { fromOwnerEnabled: true, messageId: "M1", chatId: "6281234567890@s.whatsapp.net" };
  it("non-fromMe messages always pass", () => {
    expect(classifyOwnerGate({ ...base, fromMe: false, recentlySent: recentlySent(), allowlistMatches: allowlist([]) })).toEqual({ action: "pass" });
  });
  it("drops the echo of our own send", () => {
    expect(classifyOwnerGate({ ...base, fromMe: true, messageId: "M-OWN-1", recentlySent: recentlySent(["M-OWN-1"]), allowlistMatches: allowlist("*") })).toEqual({ action: "drop_echo" });
  });
  it("drops fromMe when forwarding is disabled", () => {
    expect(classifyOwnerGate({ ...base, fromMe: true, fromOwnerEnabled: false, recentlySent: recentlySent(), allowlistMatches: allowlist("*") })).toEqual({ action: "drop_disabled" });
  });
  it("drops fromMe when the customer chat is not on the allowlist (regression)", () => {
    expect(classifyOwnerGate({ ...base, fromMe: true, chatId: "111600547700784@lid", recentlySent: recentlySent(), allowlistMatches: allowlist(["6281234567890@s.whatsapp.net"]) })).toEqual({ action: "drop_allowlist" });
  });
  it("forwards as owner when the chat is allowlisted", () => {
    expect(classifyOwnerGate({ ...base, fromMe: true, recentlySent: recentlySent(), allowlistMatches: allowlist(["6281234567890@s.whatsapp.net"]) })).toEqual({ action: "forward_owner" });
  });
  it("forwards when the allowlist matcher is open", () => {
    expect(classifyOwnerGate({ ...base, fromMe: true, chatId: "111600547700784@lid", recentlySent: recentlySent(), allowlistMatches: () => true })).toEqual({ action: "forward_owner" });
  });
  it("checks echo before the allowlist and the disabled flag before the allowlist", () => {
    expect(classifyOwnerGate({ ...base, fromMe: true, messageId: "M-ECHO-1", chatId: "111600547700784@lid", recentlySent: recentlySent(["M-ECHO-1"]), allowlistMatches: allowlist([]) })).toEqual({ action: "drop_echo" });
    expect(classifyOwnerGate({ ...base, fromMe: true, fromOwnerEnabled: false, chatId: "111600547700784@lid", recentlySent: recentlySent(), allowlistMatches: allowlist([]) })).toEqual({ action: "drop_disabled" });
  });
});

describe("echo ledger, reserve first (design 5.5)", () => {
  const PN = "15550001111@s.whatsapp.net";
  const LID = "99887766@lid";
  let counter = 0;
  const make = (extra: Partial<Parameters<typeof createEchoLedger>[0]> = {}) => {
    counter = 0;
    const persisted: ReservedRecord[][] = [];
    const clock = { t: 1_800_000_000_000 };
    const ledger = createEchoLedger({
      generateId: () => `3EB0${++counter}`,
      aliasesOf: (jid) => (jid === PN ? [LID] : jid === LID ? [PN] : []),
      persist: async (records) => { persisted.push([...records]); },
      now: () => clock.t,
      ...extra,
    });
    return { ledger, persisted, clock };
  };

  it("knows the id the moment it is reserved, before persistence resolves and before any send", async () => {
    const { ledger, persisted } = make();
    const reserved = ledger.reserve({ chatJid: PN, text: "hello" });
    expect(reserved.id).toBe("3EB01");
    expect(ledger.classify({ fromMe: true, chatKind: "self", id: reserved.id, chatJid: PN })).toBe("echo");
    await reserved.persisted;
    expect(persisted.at(-1)?.map((row) => row.id)).toEqual(["3EB01"]);
  });
  it("classifies fromMe messages that are not ours by chat kind", () => {
    const { ledger } = make();
    expect(ledger.classify({ fromMe: true, chatKind: "self", id: "TYPED", chatJid: PN })).toBe("owner-self");
    expect(ledger.classify({ fromMe: true, chatKind: "group", id: "TYPED", chatJid: "120@g.us" })).toBe("owner-group-participant");
    expect(ledger.classify({ fromMe: true, chatKind: "dm", id: "TYPED", chatJid: "777@s.whatsapp.net" })).toBe("owner-typed-dm-drop");
    expect(ledger.classify({ fromMe: false, chatKind: "dm", id: "TYPED", chatJid: "777@s.whatsapp.net" })).toBe("other");
  });
  it("never matches on text: repeated identical text with a new id is the owner typing", () => {
    const { ledger } = make();
    ledger.reserve({ chatJid: PN, text: "ok" });
    expect(ledger.classify({ fromMe: true, chatKind: "self", id: "SOMEONE-ELSE", chatJid: PN })).toBe("owner-self");
    expect(ledger.classify({ fromMe: true, chatKind: "self", id: "ok", chatJid: PN })).toBe("owner-self");
  });
  it("finds the echo when it arrives under the LID or the alt JID of a PN reservation", () => {
    const { ledger } = make();
    const { id } = ledger.reserve({ chatJid: PN, text: "x" });
    expect(ledger.classify({ fromMe: true, chatKind: "self", id, chatJid: LID })).toBe("echo");
    const second = make({ aliasesOf: () => [] });
    const other = second.ledger.reserve({ chatJid: PN, text: "x" });
    expect(second.ledger.classify({ fromMe: true, chatKind: "self", id: other.id, chatJid: "4242@lid", chatAltJid: "15550001111:7@s.whatsapp.net" })).toBe("echo");
    expect(second.ledger.classify({ fromMe: true, chatKind: "self", id: other.id, chatJid: "4242@lid" })).toBe("echo");
  });
  it("matches a group echo only in that group", () => {
    const { ledger } = make();
    const { id } = ledger.reserve({ chatJid: "120@g.us", text: "x" });
    expect(ledger.classify({ fromMe: true, chatKind: "group", id, chatJid: "120@g.us" })).toBe("echo");
    expect(ledger.classify({ fromMe: true, chatKind: "group", id, chatJid: "999@g.us" })).toBe("owner-group-participant");
    expect(ledger.classify({ fromMe: true, chatKind: "dm", id, chatJid: PN })).toBe("owner-typed-dm-drop");
  });
  it("keeps the id after a failed or uncertain send, and reports the unsettled ones", () => {
    const { ledger } = make();
    const a = ledger.reserve({ chatJid: PN, text: "a" }).id;
    const b = ledger.reserve({ chatJid: PN, text: "b" }).id;
    const c = ledger.reserve({ chatJid: PN, text: "c" }).id;
    expect(ledger.stateOf(a)).toBe("reserved");
    ledger.settle(a, { ok: true });
    expect(ledger.stateOf(a)).toBe("sent");
    ledger.settle(b, { ok: false, uncertain: true });
    expect(ledger.uncertainIds()).toEqual([b, c]);
    expect(ledger.classify({ fromMe: true, chatKind: "self", id: b, chatJid: PN })).toBe("echo");
    expect(ledger.textFor(a)).toBe("a");
  });
  it("holds 5000 ids or 7 days, whichever ends first", () => {
    expect(SENT_RING_MAX).toBe(5000);
    expect(SENT_RING_TTL_MS).toBe(7 * 24 * 60 * 60_000);
    const { ledger, clock } = make({ max: 3 });
    const ids = [1, 2, 3, 4].map((n) => ledger.reserve({ chatJid: PN, text: String(n) }).id);
    expect(ledger.isOutbound(ids[0], PN)).toBe(false);
    expect(ledger.isOutbound(ids[3], PN)).toBe(true);
    clock.t += SENT_RING_TTL_MS - 1;
    expect(ledger.isOutbound(ids[3], PN)).toBe(true);
    clock.t += 1;
    expect(ledger.isOutbound(ids[3], PN)).toBe(false);
  });
  it("restores from persisted records, so a restart still knows every bot id", async () => {
    const first = make();
    const { id, persisted } = first.ledger.reserve({ chatJid: PN, text: "x" });
    await persisted;
    const records = first.ledger.records();
    const restarted = make({ initial: records });
    expect(restarted.ledger.classify({ fromMe: true, chatKind: "self", id, chatJid: PN })).toBe("echo");
    expect(restarted.ledger.reserve({ chatJid: PN, text: "y" }).id).not.toBe(id);
  });
  it("surfaces a failed persist to the caller so the send does not happen", async () => {
    const { ledger } = make({ persist: async () => { throw new Error("disk full"); } });
    await expect(ledger.reserve({ chatJid: PN, text: "x" }).persisted).rejects.toThrow("disk full");
  });
  it("rejects a non-positive max", () => {
    expect(() => createEchoLedger({ generateId: () => "x", max: 0 })).toThrow(RangeError);
  });
});

describe("ledger keys", () => {
  it("builds the webhook and delivery ids of design 5.5", () => {
    expect(webhookIdFor("abc")).toBe("whatsapp:abc");
    expect(deliveryIdFor("1@s.whatsapp.net", "3EB0")).toBe("1@s.whatsapp.net:3EB0");
    expect(deliveryIdFor("", "x")).toBeNull();
    expect(deliveryIdFor("1@lid", "unknown")).toBeNull();
  });
  it("keys a LID chat by its phone twin so one message dedupes under either address", () => {
    expect(deliveryIdFor("777@lid", "M1", "1555:3@s.whatsapp.net")).toBe("1555@s.whatsapp.net:M1");
    expect(deliveryIdFor("1555:3@s.whatsapp.net", "M1")).toBe("1555@s.whatsapp.net:M1");
    expect(deliveryIdFor("120@g.us", "M1", "1555@s.whatsapp.net")).toBe("120@g.us:M1");
  });
});

it("rejects malformed journal timestamps, duplicate ids and mixed group aliases", async () => {
  const { parseOutboundJournal } = await import("./echo.ts");
  const row = { id: "BOT", at: 123, chats: ["123@g.us"], state: "reserved" };
  for (const records of [[{ ...row, at: -1 }], [row, row], [{ ...row, chats: ["123@g.us", "456@g.us"] }]]) {
    expect(() => parseOutboundJournal({ records })).toThrow("needs recovery");
  }
});
