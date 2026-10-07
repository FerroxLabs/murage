// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { MAX_FRAME_BYTES, parseChildMessage, parseHostMessage, PROTOCOL_VERSION, redactForLog, respawnDelay, type InboundEnvelope } from "./protocol.ts";

const KEY_HEX = "ab".repeat(32);
const init = { kind: "init", v: PROTOCOL_VERSION, connectionId: "c1", dataDir: "/data/whatsapp", authKeyHex: KEY_HEX, mode: "self-chat", appVersion: "0.1.64" };
const envelope: InboundEnvelope = { messageId: "3EB0A", chatJid: "15550001111@s.whatsapp.net", fromMe: true, timestampMs: 1_800_000_000_000, upsertType: "notify", mentionedJids: [] };

describe("parseHostMessage", () => {
  it("accepts a well formed init, with options, a last-good version and dryRun", () => {
    expect(parseHostMessage(init)).toEqual(init);
    const full = { ...init, lastGoodWebVersion: [2, 3000, 1], lastSeenAtMs: 5, options: { readReceipts: true, quoteReplies: "groups", enableWatchdog: false }, dryRun: true };
    expect(parseHostMessage(full)).toEqual(full);
  });
  it("rejects a bad init", () => {
    for (const patch of [{ v: 2 }, { authKeyHex: "short" }, { mode: "open" }, { dataDir: 5 }, { dataDir: "" }, { appVersion: "x".repeat(100) }, { connectionId: "../x" }, { options: { quoteReplies: "some" } }, { options: 5 }]) {
      expect(parseHostMessage({ ...init, ...patch })).toBeNull();
    }
  });
  it("accepts link, stop, logout, replay, ack and ping", () => {
    expect(parseHostMessage({ kind: "link", method: "qr" })).toEqual({ kind: "link", method: "qr" });
    expect(parseHostMessage({ kind: "link", method: "code", phone: "15550001111" })).toEqual({ kind: "link", method: "code", phone: "15550001111" });
    expect(parseHostMessage({ kind: "link", method: "code", phone: "+1 555" })).toBeNull();
    expect(parseHostMessage({ kind: "link", method: "code" })).toBeNull();
    expect(parseHostMessage({ kind: "stop" })).toEqual({ kind: "stop" });
    expect(parseHostMessage({ kind: "logout" })).toEqual({ kind: "logout" });
    expect(parseHostMessage({ kind: "replay" })).toEqual({ kind: "replay" });
    expect(parseHostMessage({ kind: "ack", seq: 7 })).toEqual({ kind: "ack", seq: 7 });
    expect(parseHostMessage({ kind: "ack", seq: -1 })).toBeNull();
    expect(parseHostMessage({ kind: "ack", seq: "7" })).toBeNull();
    expect(parseHostMessage({ kind: "ping", n: 3 })).toEqual({ kind: "ping", n: 3 });
  });
  it("accepts reserve and send, and refuses a send with no reserved ids", () => {
    expect(parseHostMessage({ kind: "reserve", reqId: "r1", chatId: "1@s.whatsapp.net", payload: { type: "text", text: "hi" } })).toMatchObject({ kind: "reserve" });
    expect(parseHostMessage({ kind: "reserve", reqId: "r1", chatId: "c", payload: { type: "audio" } })).toMatchObject({ payload: { type: "audio" } });
    expect(parseHostMessage({ kind: "reserve", reqId: "r1", chatId: "c", payload: { type: "text", text: 5 } })).toBeNull();
    const send = { kind: "send", reqId: "r1", chatId: "1@s.whatsapp.net", ids: ["A", "B"], payload: { type: "text", text: "hi", quote: { remoteJid: "1@s.whatsapp.net", id: "Q", text: "earlier" } } };
    expect(parseHostMessage(send)).toEqual(send);
    expect(parseHostMessage({ ...send, ids: [] })).toBeNull();
    expect(parseHostMessage({ ...send, ids: undefined })).toBeNull();
    expect(parseHostMessage({ ...send, payload: { type: "text", text: "hi", quote: { id: "Q" } } })).toBeNull();
    expect(parseHostMessage({ kind: "send", reqId: "r2", chatId: "c", ids: ["A"], payload: { type: "audio", name: "v.ogg", mime: "audio/ogg", bytesBase64: "AAAA" } })).toMatchObject({ payload: { type: "audio" } });
    expect(parseHostMessage({ kind: "send", reqId: "r2", chatId: "c", ids: ["A"], payload: { type: "audio", name: "v", mime: "m", bytesBase64: "A".repeat(MAX_FRAME_BYTES + 1) } })).toBeNull();
    expect(parseHostMessage({ kind: "send", reqId: "r2", chatId: "c", ids: ["A"], payload: { type: "video" } })).toBeNull();
  });
  it("accepts presence, read, groups and resolve", () => {
    expect(parseHostMessage({ kind: "presence", chatId: "c", state: "composing" })).toEqual({ kind: "presence", chatId: "c", state: "composing" });
    expect(parseHostMessage({ kind: "presence", chatId: "c", state: "typing" })).toBeNull();
    expect(parseHostMessage({ kind: "read", keys: [{ remoteJid: "c", id: "1" }] })).toMatchObject({ kind: "read" });
    expect(parseHostMessage({ kind: "read", keys: [{ remoteJid: "c" }] })).toBeNull();
    expect(parseHostMessage({ kind: "groups", reqId: "g" })).toEqual({ kind: "groups", reqId: "g" });
    expect(parseHostMessage({ kind: "resolve", reqId: "r", op: "pn-for-lid", jid: "1@lid" })).toMatchObject({ op: "pn-for-lid" });
  });
  it("returns null for non-objects and unknown kinds (including the retired v1 kinds)", () => {
    for (const bad of [null, undefined, 5, "init", [], { kind: "nope" }, {}, { kind: "send-text" }, { kind: "unlink" }]) expect(parseHostMessage(bad)).toBeNull();
  });
});

describe("parseChildMessage", () => {
  it("accepts ready, pong, qr, pairing-code and connection", () => {
    expect(parseChildMessage({ kind: "ready", v: PROTOCOL_VERSION })).toEqual({ kind: "ready", v: PROTOCOL_VERSION });
    expect(parseChildMessage({ kind: "ready", v: 99 })).toBeNull();
    expect(parseChildMessage({ kind: "pong", n: 1 })).toEqual({ kind: "pong", n: 1 });
    expect(parseChildMessage({ kind: "qr", text: "2@abc", version: 2, issuedAt: 5 })).toEqual({ kind: "qr", text: "2@abc", version: 2, issuedAt: 5 });
    expect(parseChildMessage({ kind: "qr", text: "2@abc", version: 1.5, issuedAt: 5 })).toBeNull();
    expect(parseChildMessage({ kind: "pairing-code", code: "ABCD1234", phone: "15550001111" })).toMatchObject({ code: "ABCD1234" });
    expect(parseChildMessage({ kind: "pairing-code", code: "short", phone: "1" })).toBeNull();
    const connection = { kind: "connection", state: "retry", self: { pn: "1@s.whatsapp.net", lid: "2@lid" }, attempt: 3, retryInMs: 4000, lastSeenAtMs: 9, webVersion: [2, 3000, 1] };
    expect(parseChildMessage(connection)).toEqual(connection);
    expect(parseChildMessage({ kind: "connection", state: "exploded" })).toBeNull();
  });
  it("accepts an inbound with a sequence number and a validated envelope", () => {
    expect(parseChildMessage({ kind: "inbound", seq: 4, envelope })).toEqual({ kind: "inbound", seq: 4, envelope });
    const rich: InboundEnvelope = {
      ...envelope, chatJid: "120@g.us", chatJidAlt: "1@s.whatsapp.net", fromMe: false, pushName: "Ada", participant: "9@lid", participantAlt: "9@s.whatsapp.net", text: "hi",
      mentionedJids: ["1@s.whatsapp.net"], quoted: { id: "Q", participant: "1@lid", text: "t" }, media: { kind: "audio", mime: "audio/ogg; codecs=opus", bytes: 5, seconds: 2, ptt: true, path: "/m/x.ogg" },
    };
    expect(parseChildMessage({ kind: "inbound", seq: 5, envelope: rich })).toEqual({ kind: "inbound", seq: 5, envelope: rich });
    for (const bad of [{ seq: -1 }, { seq: 1.5 }, { envelope: { ...envelope, mentionedJids: undefined } }, { envelope: { ...envelope, upsertType: "x" } }, { envelope: { ...envelope, media: { kind: "hologram" } } }, { envelope: { ...envelope, text: 5 } }, { envelope: undefined }]) {
      expect(parseChildMessage({ kind: "inbound", seq: 1, envelope, ...bad })).toBeNull();
    }
  });
  it("accepts reserved, send-result, dry-run and result", () => {
    expect(parseChildMessage({ kind: "reserved", reqId: "r", ids: ["A", "B"] })).toEqual({ kind: "reserved", reqId: "r", ids: ["A", "B"] });
    expect(parseChildMessage({ kind: "reserved", reqId: "r", ids: [] })).toBeNull();
    expect(parseChildMessage({ kind: "send-result", reqId: "r", ok: true, ids: ["A"] })).toEqual({ kind: "send-result", reqId: "r", ok: true, ids: ["A"] });
    const failed = { kind: "send-result", reqId: "r", ok: false, error: { code: "timeout", message: "late", uncertain: true }, sentIds: ["A"] };
    expect(parseChildMessage(failed)).toEqual(failed);
    expect(parseChildMessage({ ...failed, sentIds: undefined })).toBeNull();
    expect(parseChildMessage({ ...failed, error: { code: "weird", message: "x" } })).toBeNull();
    expect(parseChildMessage({ kind: "dry-run", reqId: "r", chatId: "c", ids: ["A"], chunks: ["hello"] })).toMatchObject({ kind: "dry-run" });
    expect(parseChildMessage({ kind: "result", reqId: "r", ok: true, value: { pn: "1@s.whatsapp.net" } })).toEqual({ kind: "result", reqId: "r", ok: true, value: { pn: "1@s.whatsapp.net" } });
    expect(parseChildMessage({ kind: "result", reqId: "r", ok: false, error: { code: "offline", message: "x" } })).toMatchObject({ ok: false });
    expect(parseChildMessage({ kind: "result", reqId: "r", ok: false })).toBeNull();
  });
  it("accepts status, fatal and log", () => {
    expect(parseChildMessage({ kind: "status", ingressWriteFailed: { remoteJid: "c", id: "1" }, catchUpTruncated: true, credsPersisted: true, replayed: 3 })).toEqual({ kind: "status", ingressWriteFailed: { remoteJid: "c", id: "1" }, catchUpTruncated: true, credsPersisted: true, replayed: 3 });
    expect(parseChildMessage({ kind: "status" })).toEqual({ kind: "status" });
    expect(parseChildMessage({ kind: "status", ingressWriteFailed: { remoteJid: "c" } })).toBeNull();
    expect(parseChildMessage({ kind: "fatal", message: "boom" })).toEqual({ kind: "fatal", message: "boom" });
    expect(parseChildMessage({ kind: "log", level: "warn", message: "hi" })).toEqual({ kind: "log", level: "warn", message: "hi" });
    expect(parseChildMessage({ kind: "log", level: "trace", message: "hi" })).toBeNull();
  });
  it("returns null for junk and retired kinds", () => {
    for (const bad of [null, 1, "x", [], { kind: "qr" }, { kind: "unknown" }, { kind: "sent-id", id: "A", at: 5 }]) expect(parseChildMessage(bad)).toBeNull();
  });
});

describe("redactForLog", () => {
  it("removes QR text, the pairing code, the auth key, audio bytes and message bodies", () => {
    const out = JSON.stringify([
      redactForLog({ kind: "qr", text: "2@SECRET-QR", version: 1, issuedAt: 1 }),
      redactForLog({ kind: "pairing-code", code: "ABCD1234", phone: "1" }),
      redactForLog(init),
      redactForLog({ kind: "send", reqId: "r", chatId: "c", ids: ["A"], payload: { type: "audio", name: "n", mime: "m", bytesBase64: "AUDIOBYTES" } }),
      redactForLog({ kind: "reserve", reqId: "r", chatId: "c", payload: { type: "text", text: "private words" } }),
      redactForLog({ kind: "dry-run", reqId: "r", chatId: "c", ids: ["A"], chunks: ["private chunk"] }),
      redactForLog({ kind: "inbound", seq: 1, envelope: { ...envelope, text: "inbound words", pushName: "Pushy", quoted: { id: "Q", text: "quoted words" } }, creds: { noiseKey: "NOISE" } }),
    ]);
    for (const secret of ["SECRET-QR", "ABCD1234", KEY_HEX, "AUDIOBYTES", "private words", "private chunk", "inbound words", "Pushy", "quoted words", "NOISE"]) expect(out).not.toContain(secret);
    expect(out).toContain("[redacted]");
    expect(out).toContain("/data/whatsapp");
  });
  it("keeps non-secret fields, truncates long strings and bounds depth", () => {
    expect(redactForLog({ kind: "connection", state: "retry" })).toEqual({ kind: "connection", state: "retry" });
    expect(redactForLog({ kind: "log", level: "info", message: "x".repeat(500) })).toMatchObject({ message: `${"x".repeat(200)}...` });
    let deep: unknown = "end";
    for (let i = 0; i < 10; i++) deep = { n: deep };
    expect(JSON.stringify(redactForLog(deep))).toContain("[deep]");
  });
});

describe("respawnDelay", () => {
  it("doubles from 5 s to a 30 minute cap", () => {
    expect([1, 2, 3, 4].map(respawnDelay)).toEqual([5000, 10000, 20000, 40000]);
    expect(respawnDelay(20)).toBe(30 * 60_000);
    expect(respawnDelay(0)).toBe(5000);
  });
});

it("preserves the packaged Electron version through the ready protocol", () => {
  expect(parseChildMessage({ kind: "ready", v: 1, electronVersion: "43.4.0" })).toMatchObject({ electronVersion: "43.4.0" });
});
