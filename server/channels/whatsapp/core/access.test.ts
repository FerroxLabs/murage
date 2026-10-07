// Copyright 2026 Ferrox Labs
// Cases follow Hermes Agent scripts/whatsapp-bridge/bridge.js (self-chat gates, bug #8389) and
// OpenClaw extensions/whatsapp/src/inbound/access-control.ts (pairing; MIT, both).
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  approvePairing, decide, mentionsSelf, newPairingCode, PAIRING_ALPHABET, PAIRING_MAX_PENDING, PAIRING_TTL_MS, pairingReplyText, prunePairing, upsertPairing,
  type AccessPolicy, type InboundCandidate, type PairingRequest,
} from "./access.ts";
import { createEchoLedger } from "./echo.ts";
import type { LidMapping } from "./lid.ts";

const NOW = 1_800_000_000_000;
const self = { pn: "15550001111:7@s.whatsapp.net", lid: "99887766:7@lid" };
const mapping: LidMapping = {
  lidForPn: (pn) => (pn === "19175395595@s.whatsapp.net" ? "267383306489914@lid" : undefined),
  pnForLid: (lid) => (lid === "267383306489914@lid" ? "19175395595@s.whatsapp.net" : undefined),
};
const newLedger = () => { let n = 0; return createEchoLedger({ generateId: () => `OURS${++n}`, now: () => NOW }); };
const policy = (patch: Partial<AccessPolicy> = {}): AccessPolicy => ({ mode: "self-chat", self, allowFrom: [], echo: newLedger(), nowMs: NOW, ...patch });
const msg = (patch: Partial<InboundCandidate> = {}): InboundCandidate => ({ id: "M1", chatJid: "15550001111@s.whatsapp.net", fromMe: true, timestampMs: NOW - 1000, upsertType: "notify", ...patch });

describe("self-chat mode", () => {
  it("accepts the owner typing in their own chat, by PN or LID", async () => {
    for (const chatJid of ["15550001111@s.whatsapp.net", "99887766@lid", "15550001111:3@s.whatsapp.net"]) {
      const d = await decide(msg({ chatJid }), policy());
      expect(d).toMatchObject({ decision: "accept", role: "owner", userId: "15550001111@s.whatsapp.net" });
    }
  });
  it("drops a stranger's message and never pairs (bug #8389)", async () => {
    expect(await decide(msg({ fromMe: false, chatJid: "19175395595@s.whatsapp.net" }), policy())).toEqual({ decision: "drop", reason: "not-self-chat" });
  });
  it("drops the owner's messages to other chats", async () => {
    expect(await decide(msg({ chatJid: "19175395595@s.whatsapp.net" }), policy())).toEqual({ decision: "drop", reason: "not-self-chat" });
  });
  it("drops the echo of our own reply", async () => {
    const echo = newLedger();
    const { id } = echo.reserve({ chatJid: "15550001111@s.whatsapp.net", text: "reply" });
    expect(await decide(msg({ id }), policy({ echo }))).toEqual({ decision: "drop", reason: "echo" });
    // The same text under a new id is the owner typing, never an echo.
    expect((await decide(msg({ id: "TYPED" }), policy({ echo }))).decision).toBe("accept");
  });
  it("accepts append upserts (self messages arrive as append) but not stale ones", async () => {
    expect((await decide(msg({ upsertType: "append", timestampMs: NOW - 30_000 }), policy())).decision).toBe("accept");
    expect(await decide(msg({ upsertType: "append", timestampMs: NOW - 61_000 }), policy())).toEqual({ decision: "drop", reason: "stale-append" });
    expect((await decide(msg({ upsertType: "notify", timestampMs: NOW - 3_600_000 }), policy())).decision).toBe("accept");
  });
  it("drops status, broadcast, newsletter and group chats", async () => {
    for (const chatJid of ["status@broadcast", "1234@broadcast", "1@newsletter"]) expect(await decide(msg({ chatJid }), policy())).toEqual({ decision: "drop", reason: "ignored-chat" });
    expect(await decide(msg({ chatJid: "123-456@g.us" }), policy())).toEqual({ decision: "drop", reason: "group-not-allowed" });
    expect(await decide(msg({ chatJid: "123-456@g.us", fromMe: false }), policy({ mode: "contacts" }))).toEqual({ decision: "drop", reason: "group-not-allowed" });
  });
});

describe("contacts mode", () => {
  const contacts = (patch: Partial<AccessPolicy> = {}) => policy({ mode: "contacts", ...patch });
  const stranger = (patch: Partial<InboundCandidate> = {}) => msg({ fromMe: false, chatJid: "19175395595@s.whatsapp.net", ...patch });

  it("keeps self-chat working", async () => {
    expect((await decide(msg(), contacts())).decision).toBe("accept");
  });
  it("accepts an allowlisted number", async () => {
    expect(await decide(stranger(), contacts({ allowFrom: ["+19175395595"] }))).toMatchObject({ decision: "accept", role: "contact", userId: "19175395595@s.whatsapp.net" });
  });
  it("accepts a LID sender whose phone is allowlisted, and keys the human by PN", async () => {
    const d = await decide(stranger({ chatJid: "267383306489914@lid" }), contacts({ allowFrom: ["19175395595"] }), mapping);
    expect(d).toMatchObject({ decision: "accept", role: "contact", userId: "19175395595@s.whatsapp.net" });
  });
  it("starts pairing for an unknown sender, with the push name", async () => {
    expect(await decide(stranger({ pushName: " Ada " }), contacts())).toEqual({
      decision: "pair", chatJid: "19175395595@s.whatsapp.net", senderJid: "19175395595@s.whatsapp.net", userId: "19175395595@s.whatsapp.net", pushName: "Ada",
      conversationKey: "dm:19175395595@s.whatsapp.net", principal: { kind: "sender", userId: "19175395595@s.whatsapp.net" }, notOwnerAudience: true,
    });
  });
  it("keys an unmapped LID sender with the lid: prefix", async () => {
    expect(await decide(stranger({ chatJid: "555@lid" }), contacts(), mapping)).toMatchObject({ decision: "pair", userId: "lid:555@lid" });
  });
  it("does not honour a * wildcard from config", async () => {
    expect((await decide(stranger(), contacts({ allowFrom: ["*"] }))).decision).toBe("pair");
  });
  it("suppresses pairing replies for messages older than connect time minus 30 s", async () => {
    const connectedAtMs = NOW - 5_000;
    expect(await decide(stranger({ timestampMs: connectedAtMs - 31_000 }), contacts({ connectedAtMs }))).toEqual({ decision: "drop", reason: "pairing-backlog" });
    expect((await decide(stranger({ timestampMs: connectedAtMs - 29_000 }), contacts({ connectedAtMs }))).decision).toBe("pair");
  });
  it("never auto-pairs a fromMe message to another chat", async () => {
    expect(await decide(msg({ chatJid: "19175395595@s.whatsapp.net" }), contacts())).toEqual({ decision: "drop", reason: "from-me-other-chat" });
  });
});

describe("owner, principals and conversations (0a W2.2)", () => {
  it("only the linked number is the owner: owner-self principal, owner audience", async () => {
    expect(await decide(msg(), policy())).toMatchObject({
      decision: "accept", role: "owner", conversationKey: "self:15550001111@s.whatsapp.net", principal: { kind: "owner-self" }, notOwnerAudience: false,
    });
  });
  it("a contact is a sender principal in its own conversation, never the owner audience", async () => {
    const d = await decide(msg({ fromMe: false, chatJid: "19175395595@s.whatsapp.net" }), policy({ mode: "contacts", allowFrom: ["19175395595"] }));
    expect(d).toMatchObject({ decision: "accept", role: "contact", conversationKey: "dm:19175395595@s.whatsapp.net", principal: { kind: "sender", userId: "19175395595@s.whatsapp.net" }, notOwnerAudience: true });
  });
  it("the owner typing in a contact's DM is dropped, never a trigger", async () => {
    expect(await decide(msg({ chatJid: "19175395595@s.whatsapp.net" }), policy({ mode: "contacts", allowFrom: ["19175395595"] }))).toEqual({ decision: "drop", reason: "from-me-other-chat" });
  });
  it("selfChat off drops the owner's own self-chat lines", async () => {
    expect(await decide(msg(), policy({ selfChat: false }))).toEqual({ decision: "drop", reason: "self-chat-off" });
  });
  it("a self-chat that arrives as the LID twin is still the owner's", async () => {
    expect(await decide(msg({ chatJid: "42@lid", chatJidAlt: "15550001111:3@s.whatsapp.net" }), policy())).toMatchObject({ decision: "accept", role: "owner" });
  });
  it("the echo of our own send arriving under the LID is dropped", async () => {
    const echo = newLedger();
    echo.reserve({ chatJid: "15550001111@s.whatsapp.net", text: "x" });
    expect(await decide(msg({ id: "OURS1", chatJid: "99887766@lid" }), policy({ echo }))).toEqual({ decision: "drop", reason: "echo" });
  });
});

describe("offline catch-up of append upserts (design 5.5)", () => {
  it("accepts append rows at or after lastSeenAt minus 60 s and drops older history", async () => {
    const lastSeenAtMs = NOW - 8 * 3_600_000;
    expect((await decide(msg({ upsertType: "append", timestampMs: lastSeenAtMs - 59_000 }), policy({ lastSeenAtMs }))).decision).toBe("accept");
    expect(await decide(msg({ upsertType: "append", timestampMs: lastSeenAtMs - 61_000 }), policy({ lastSeenAtMs }))).toEqual({ decision: "drop", reason: "stale-append" });
  });
});

describe("alternate JIDs in access checks (Hermes 3926c4209c)", () => {
  const contacts = (patch: Partial<AccessPolicy> = {}) => policy({ mode: "contacts", allowFrom: ["19175395595"], ...patch });
  const stranger = (patch: Partial<InboundCandidate> = {}) => msg({ fromMe: false, chatJid: "777@lid", ...patch });
  it("a LID sender with no mapping yet is allowed through its remoteJidAlt, and keyed by the phone", async () => {
    expect(await decide(stranger({ chatJidAlt: "19175395595:2@s.whatsapp.net" }), contacts())).toMatchObject({ decision: "accept", role: "contact", userId: "19175395595@s.whatsapp.net", displayPn: "19175395595@s.whatsapp.net" });
  });
  it("without the alt and without a mapping the same sender must pair", async () => {
    expect(await decide(stranger(), contacts())).toMatchObject({ decision: "pair", userId: "lid:777@lid" });
  });
  it("a binding already keyed by lid: stays keyed by it once the phone is learned", async () => {
    const d = await decide(stranger({ chatJidAlt: "19175395595@s.whatsapp.net" }), contacts({ knownUserIds: new Set(["lid:777@lid"]) }));
    expect(d).toMatchObject({ decision: "accept", userId: "lid:777@lid", displayPn: "19175395595@s.whatsapp.net" });
  });
});

describe("groups (design 5.4)", () => {
  const GROUP = "120363000000000000@g.us";
  const groups = (patch: Partial<NonNullable<AccessPolicy["groups"]>> = {}): NonNullable<AccessPolicy["groups"]> => ({ policy: "allowlist", allow: [{ jid: GROUP, activation: "mention" }], senders: "members", ...patch });
  const inGroup = (patch: Partial<InboundCandidate> = {}) => msg({ fromMe: false, chatJid: GROUP, participant: "19175395595@s.whatsapp.net", mentionedJids: [], ...patch });

  it("drops a group that is not enabled, and every group while the policy is disabled", async () => {
    expect(await decide(inGroup({ chatJid: "999@g.us" }), policy({ groups: groups() }))).toEqual({ decision: "drop", reason: "group-not-allowed" });
    expect(await decide(inGroup(), policy({ groups: groups({ policy: "disabled" }) }))).toEqual({ decision: "drop", reason: "group-not-allowed" });
  });
  it("answers a mention with a guest principal and a non-owner audience", async () => {
    const d = await decide(inGroup({ mentionedJids: ["15550001111@s.whatsapp.net"] }), policy({ groups: groups() }));
    expect(d).toMatchObject({ decision: "accept", role: "group", activation: "mention", conversationKey: `group:${GROUP}`, principal: { kind: "group-guest", groupJid: GROUP }, notOwnerAudience: true, userId: "19175395595@s.whatsapp.net" });
  });
  it("matches the mention by LID, with the device suffix on our id and none on theirs", async () => {
    // The old ":" to "@" swap made "99887766:7@lid" into "99887766@7@lid", which never matched.
    expect((await decide(inGroup({ mentionedJids: ["99887766@lid"] }), policy({ groups: groups() }))).decision).toBe("accept");
    expect((await decide(inGroup({ mentionedJids: ["99887766:12@lid"] }), policy({ groups: groups() }))).decision).toBe("accept");
    expect(mentionsSelf(["15550001111@hosted"], self)).toBe(true);
    expect(mentionsSelf(["15550001112@s.whatsapp.net"], self)).toBe(false);
  });
  it("requires a group-scoped outbound id for reply activation", async () => {
    const echo = newLedger();
    const { id } = echo.reserve({ chatJid: GROUP, text: "earlier" });
    expect(await decide(inGroup({ quotedMessageId: id }), policy({ groups: groups(), echo }))).toMatchObject({ decision: "accept", activation: "reply" });
    expect(await decide(inGroup({ quotedMessageId: "NOT-OURS", quotedParticipant: "99887766:7@lid" }), policy({ groups: groups() }))).toEqual({ decision: "drop", reason: "group-not-addressed" });
    expect(await decide(inGroup({ quotedMessageId: "NOT-OURS", quotedParticipant: "5@lid" }), policy({ groups: groups() }))).toEqual({ decision: "drop", reason: "group-not-addressed" });
  });
  it("answers the linked number's digits in text unless someone else is mentioned", async () => {
    expect(await decide(inGroup({ text: "hey +1 555 000 1111 are you there" }), policy({ groups: groups() }))).toMatchObject({ decision: "accept", activation: "digits" });
    expect(await decide(inGroup({ text: "hey 15550001111", mentionedJids: ["777@lid"] }), policy({ groups: groups() }))).toEqual({ decision: "drop", reason: "group-not-addressed" });
  });
  it("ignores unaddressed chatter in mention mode and answers everything in always mode", async () => {
    expect(await decide(inGroup({ text: "lunch?" }), policy({ groups: groups() }))).toEqual({ decision: "drop", reason: "group-not-addressed" });
    expect(await decide(inGroup({ text: "lunch?" }), policy({ groups: groups({ allow: [{ jid: GROUP, activation: "always" }] }) }))).toMatchObject({ decision: "accept", activation: "always" });
  });
  it("senders:allowlist requires the participant on the allowlist, through the alt JID too", async () => {
    const p = (allowFrom: string[]) => policy({ groups: groups({ senders: "allowlist", allow: [{ jid: GROUP, activation: "always" }] }), allowFrom });
    expect(await decide(inGroup({ participant: "55@lid", participantAlt: "19175395595@s.whatsapp.net" }), p(["19175395595"]))).toMatchObject({ decision: "accept" });
    expect(await decide(inGroup({ participant: "55@lid" }), p(["19175395595"]))).toEqual({ decision: "drop", reason: "group-sender" });
    expect(await decide(inGroup(), p([]))).toEqual({ decision: "drop", reason: "group-sender" });
  });
  it("drops the bot's own echo in a group but admits the owner typing from the phone as a guest turn", async () => {
    const echo = newLedger();
    const { id } = echo.reserve({ chatJid: GROUP, text: "bot reply" });
    const base = { fromMe: true, participant: undefined, mentionedJids: ["15550001111@s.whatsapp.net"] };
    expect(await decide(inGroup({ ...base, id }), policy({ groups: groups(), echo }))).toEqual({ decision: "drop", reason: "echo" });
    const typed = await decide(inGroup({ ...base, id: "TYPED" }), policy({ groups: groups(), echo }));
    expect(typed).toMatchObject({ decision: "accept", role: "group", principal: { kind: "group-guest", groupJid: GROUP }, notOwnerAudience: true });
  });
  it("an echo reserved for one group is not an echo in another", async () => {
    const echo = newLedger();
    const { id } = echo.reserve({ chatJid: GROUP, text: "x" });
    const other = "120363111111111111@g.us";
    const p = policy({ groups: groups({ allow: [{ jid: other, activation: "always" }] }), echo });
    expect((await decide(inGroup({ chatJid: other, fromMe: true, participant: undefined, id }), p)).decision).toBe("accept");
  });
  it("a group message with no participant is dropped", async () => {
    expect(await decide(inGroup({ participant: undefined }), policy({ groups: groups({ allow: [{ jid: GROUP, activation: "always" }] }) }))).toEqual({ decision: "drop", reason: "group-sender" });
  });
});

describe("pairing requests", () => {
  const rng = (seq: number[]) => { let i = 0; return () => seq[i++ % seq.length]; };
  const sender = { userId: "1@s.whatsapp.net", senderJid: "1@s.whatsapp.net", name: "Ada" };

  it("makes a 6 character code from the unambiguous alphabet", () => {
    const code = newPairingCode(rng([0, 1, 2, 3, 4, 5]));
    expect(code).toHaveLength(6);
    expect([...code].every((c) => PAIRING_ALPHABET.includes(c))).toBe(true);
    expect(PAIRING_ALPHABET).not.toMatch(/[01OIL]/);
  });
  it("creates once, then reports the existing request without a second reply", () => {
    const first = upsertPairing([], sender, NOW, rng([1]));
    expect(first.kind).toBe("created");
    const again = upsertPairing(first.requests, sender, NOW + 1000, rng([2]));
    expect(again.kind).toBe("existing");
    expect(again.requests).toHaveLength(1);
  });
  it("allows at most 3 pending requests", () => {
    let requests: PairingRequest[] = [];
    for (let i = 0; i < PAIRING_MAX_PENDING; i++) {
      const r = upsertPairing(requests, { userId: `${i}@s.whatsapp.net`, senderJid: `${i}@s.whatsapp.net` }, NOW, rng([i, i + 3]));
      expect(r.kind).toBe("created");
      requests = r.requests;
    }
    expect(upsertPairing(requests, { userId: "9@s.whatsapp.net", senderJid: "9@s.whatsapp.net" }, NOW, rng([9])).kind).toBe("limited");
  });
  it("expires requests after an hour, freeing the slot", () => {
    const created = upsertPairing([], sender, NOW, rng([1]));
    expect(prunePairing(created.requests, NOW + PAIRING_TTL_MS - 1)).toHaveLength(1);
    expect(prunePairing(created.requests, NOW + PAIRING_TTL_MS)).toHaveLength(0);
    expect(upsertPairing(created.requests, sender, NOW + PAIRING_TTL_MS, rng([4])).kind).toBe("created");
  });
  it("approves by code, case-insensitively, once", () => {
    const created = upsertPairing([], sender, NOW, rng([1]));
    if (created.kind !== "created") throw new Error("expected created");
    const code = created.request.code;
    const approved = approvePairing(created.requests, ` ${code.toLowerCase()} `, NOW + 1000);
    expect(approved?.request.userId).toBe(sender.userId);
    expect(approved?.requests).toHaveLength(0);
    expect(approvePairing(created.requests, "NOPE12", NOW)).toBeNull();
    expect(approvePairing(created.requests, code, NOW + PAIRING_TTL_MS)).toBeNull();
  });
  it("words the one unsolicited reply as designed", () => {
    expect(pairingReplyText("ABC123")).toBe("This number is linked to a Murage assistant. Ask its owner to approve code ABC123 in Murage to start.");
  });
});
