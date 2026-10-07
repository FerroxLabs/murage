// Copyright 2026 Ferrox Labs
// Nested-envelope cases follow Hermes bridge_helpers.js; contextInfo cases follow bridge.native.test.mjs (MIT, Nous Research).
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { contextInfoOf, envelopeOf, mediaOf, textOf, timestampMsOf, unwrapContent } from "./content.ts";

const NOW = 1_800_000_000_000;

describe("unwrapContent", () => {
  it("peels nested ephemeral, view-once and document-with-caption wrappers", () => {
    const inner = { conversation: "hello" };
    const nested = { ephemeralMessage: { message: { viewOnceMessageV2: { message: { documentWithCaptionMessage: { message: inner } } } } } };
    expect(unwrapContent(nested)).toBe(inner);
    expect(textOf(unwrapContent(nested))).toBe("hello");
  });
  it("stops after 8 levels instead of looping on a hostile chain", () => {
    let message: Record<string, unknown> = { conversation: "deep" };
    for (let i = 0; i < 12; i++) message = { ephemeralMessage: { message } };
    expect(textOf(unwrapContent(message))).toBe("");
  });
  it("returns an empty object for junk and the message itself when nothing wraps it", () => {
    expect(unwrapContent(undefined)).toEqual({});
    expect(unwrapContent("x")).toEqual({});
    const plain = { conversation: "a" };
    expect(unwrapContent(plain)).toBe(plain);
  });
});

describe("textOf and mediaOf", () => {
  it("reads text from the shapes WhatsApp uses", () => {
    expect(textOf({ conversation: "a" })).toBe("a");
    expect(textOf({ extendedTextMessage: { text: "b" } })).toBe("b");
    expect(textOf({ imageMessage: { caption: "c" } })).toBe("c");
    expect(textOf({ buttonsResponseMessage: { selectedDisplayText: "d" } })).toBe("d");
    expect(textOf({})).toBe("");
  });
  it("describes media without downloading it", () => {
    expect(mediaOf({ audioMessage: { mimetype: "audio/ogg; codecs=opus", seconds: 4, ptt: true, fileLength: { low: 2048, high: 0 } } })).toEqual({ kind: "audio", mime: "audio/ogg; codecs=opus", bytes: 2048, seconds: 4, ptt: true });
    expect(mediaOf({ documentMessage: { mimetype: "application/pdf", fileName: "a.pdf", fileLength: "1200", caption: "see" } })).toEqual({ kind: "document", mime: "application/pdf", bytes: 1200, name: "a.pdf", caption: "see" });
    expect(mediaOf({ contactMessage: { displayName: "Ada" } })).toEqual({ kind: "contact", name: "Ada" });
    expect(mediaOf({ conversation: "x" })).toBeUndefined();
  });
});

describe("timestampMsOf", () => {
  it("reads numbers, numeric strings and Long objects as seconds", () => {
    expect(timestampMsOf(1_800_000_000, 5)).toBe(1_800_000_000_000);
    expect(timestampMsOf("1800000000", 5)).toBe(1_800_000_000_000);
    expect(timestampMsOf({ low: 1_800_000_000, high: 0 }, 5)).toBe(1_800_000_000_000);
    expect(timestampMsOf({ toNumber: () => 1_800_000_000 }, 5)).toBe(1_800_000_000_000);
    expect(timestampMsOf(undefined, 5)).toBe(5);
    expect(timestampMsOf(0, 5)).toBe(5);
  });
});

describe("envelopeOf", () => {
  const base = { key: { remoteJid: "120@g.us", id: "M1", fromMe: false, participant: "9:3@lid", participantAlt: "19175395595@s.whatsapp.net" }, pushName: "Ada", messageTimestamp: 1_800_000_000 };

  it("carries alt JIDs, the push name, mentions with device suffixes stripped, and the quote", () => {
    const env = envelopeOf({
      ...base,
      message: { extendedTextMessage: { text: "hi @bot", contextInfo: { mentionedJid: ["99887766:7@lid", 5, ""], stanzaId: "Q1", participant: "99887766:7@lid", quotedMessage: { conversation: "earlier words" } } } },
    }, "notify", NOW);
    expect(env).toEqual({
      messageId: "M1", chatJid: "120@g.us", fromMe: false, timestampMs: 1_800_000_000_000, upsertType: "notify", pushName: "Ada",
      participant: "9:3@lid", participantAlt: "19175395595@s.whatsapp.net", text: "hi @bot", mentionedJids: ["99887766@lid"],
      quoted: { id: "Q1", participant: "99887766:7@lid", text: "earlier words" },
    });
  });
  it("finds the text inside a disappearing-message wrapper", () => {
    const env = envelopeOf({ ...base, message: { ephemeralMessage: { message: { viewOnceMessage: { message: { extendedTextMessage: { text: "secret" } } } } } } }, "append", NOW);
    expect(env).toMatchObject({ text: "secret", upsertType: "append" });
  });
  it("reads the DM alt JID and a media descriptor with no text", () => {
    const env = envelopeOf({ key: { remoteJid: "777@lid", remoteJidAlt: "19175395595@s.whatsapp.net", id: "M2", fromMe: false }, message: { audioMessage: { mimetype: "audio/ogg", ptt: true } } }, "notify", NOW);
    expect(env).toMatchObject({ chatJid: "777@lid", chatJidAlt: "19175395595@s.whatsapp.net", media: { kind: "audio", ptt: true }, timestampMs: NOW });
    expect(env).not.toHaveProperty("text");
  });
  it("caps quoted text at 500 characters and tolerates a quote with no body", () => {
    const long = envelopeOf({ ...base, message: { extendedTextMessage: { text: "x", contextInfo: { stanzaId: "Q", quotedMessage: { conversation: "y".repeat(900) } } } } }, "notify", NOW);
    expect(long?.quoted?.text).toHaveLength(500);
    const bare = envelopeOf({ ...base, message: { extendedTextMessage: { text: "x", contextInfo: { stanzaId: "Q" } } } }, "notify", NOW);
    expect(bare?.quoted).toEqual({ id: "Q" });
  });
  it("returns null without a chat or an id", () => {
    expect(envelopeOf({ key: { id: "x" }, message: {} }, "notify", NOW)).toBeNull();
    expect(envelopeOf({ key: { remoteJid: "1@s.whatsapp.net" }, message: {} }, "notify", NOW)).toBeNull();
    expect(envelopeOf({}, "notify", NOW)).toBeNull();
  });
  it("finds contextInfo under whichever message type carries it", () => {
    expect(contextInfoOf({ imageMessage: { contextInfo: { stanzaId: "Z" } } })).toEqual({ stanzaId: "Z" });
    expect(contextInfoOf({})).toEqual({});
  });
});
