// Copyright 2026 Ferrox Labs
// Fixtures ported from Hermes Agent scripts/whatsapp-bridge/allowlist.test.mjs (MIT, Nous Research).
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { canonicalJid, displayPn, expandIdentifiers, humanUserId, isSelfChat, jidKind, matchesAllowList, matchesAllowListWithAlt, maskNumber, sameJid, normalizeIdentifier, parseAllowList, stripDevice, type LidMapping } from "./lid.ts";

// Same pair Hermes writes as lid-mapping files, here behind the injected mapping.
const mapping: LidMapping = {
  lidForPn: (pn) => (pn === "19175395595@s.whatsapp.net" ? "267383306489914@lid" : undefined),
  pnForLid: (lid) => (lid === "267383306489914@lid" ? "19175395595@s.whatsapp.net" : undefined),
};

describe("normalizeIdentifier", () => {
  it("strips jid syntax and plus prefix", () => {
    expect(normalizeIdentifier("+19175395595@s.whatsapp.net")).toBe("19175395595");
    expect(normalizeIdentifier("267383306489914@lid")).toBe("267383306489914");
    expect(normalizeIdentifier("19175395595:12@s.whatsapp.net")).toBe("19175395595");
    expect(normalizeIdentifier(undefined)).toBe("");
  });
});

describe("jid helpers", () => {
  it("classifies jids and strips the device suffix", () => {
    expect(jidKind("1@s.whatsapp.net")).toBe("pn");
    expect(jidKind("1@lid")).toBe("lid");
    expect(jidKind("1-2@g.us")).toBe("group");
    expect(jidKind("status@broadcast")).toBe("broadcast");
    expect(jidKind("1@newsletter")).toBe("newsletter");
    expect(jidKind("19175395595")).toBe("bare");
    expect(stripDevice("123:4@s.whatsapp.net")).toBe("123@s.whatsapp.net");
  });
  it("matches self by PN or LID with device suffixes ignored", () => {
    const self = { pn: "111:5@s.whatsapp.net", lid: "222:5@lid" };
    expect(isSelfChat("111@s.whatsapp.net", self)).toBe(true);
    expect(isSelfChat("222@lid", self)).toBe(true);
    expect(isSelfChat("333@s.whatsapp.net", self)).toBe(false);
    expect(isSelfChat("", self)).toBe(false);
  });
  it("masks numbers to the last four digits", () => {
    expect(maskNumber("19175395595@s.whatsapp.net")).toBe("+•••• 5595");
    expect(maskNumber("")).toBe("");
  });
});

describe("expandIdentifiers", () => {
  it("resolves phone and lid aliases through the injected mapping", async () => {
    expect([...(await expandIdentifiers("267383306489914@lid", mapping))].sort()).toEqual(["19175395595", "267383306489914"]);
    expect([...(await expandIdentifiers("+19175395595", mapping))].sort()).toEqual(["19175395595", "267383306489914"]);
  });
  it("returns only the identifier when nothing maps, and survives a throwing mapping", async () => {
    expect([...(await expandIdentifiers("1@lid"))]).toEqual(["1"]);
    const broken: LidMapping = { pnForLid: () => { throw new Error("boom"); }, lidForPn: async () => { throw new Error("boom"); } };
    expect([...(await expandIdentifiers("1@lid", broken))]).toEqual(["1"]);
    expect((await expandIdentifiers("", mapping)).size).toBe(0);
  });
  it("accepts async mappings", async () => {
    const async_: LidMapping = { pnForLid: async () => "5@s.whatsapp.net", lidForPn: async () => undefined };
    expect([...(await expandIdentifiers("9@lid", async_))].sort()).toEqual(["5", "9"]);
  });
});

describe("matchesAllowList", () => {
  it("accepts a mapped lid sender when the allowlist only has the phone number", async () => {
    const allowed = parseAllowList("+19175395595");
    expect(await matchesAllowList("267383306489914@lid", allowed, mapping)).toBe(true);
    expect(await matchesAllowList("188012763865257@lid", allowed, mapping)).toBe(false);
  });
  it("treats * as the allow-all wildcard (Hermes), which access.ts never passes in", async () => {
    const allowed = parseAllowList("*");
    expect(await matchesAllowList("19175395595@s.whatsapp.net", allowed, mapping)).toBe(true);
    expect(await matchesAllowList("267383306489914@lid", allowed, mapping)).toBe(true);
  });
  it("rejects everyone when the allowlist is empty or missing (#8389)", async () => {
    const empty = parseAllowList("");
    expect(empty.size).toBe(0);
    expect(await matchesAllowList("19175395595@s.whatsapp.net", empty, mapping)).toBe(false);
    expect(await matchesAllowList("267383306489914@lid", empty, mapping)).toBe(false);
    expect(await matchesAllowList("19175395595@s.whatsapp.net", null as unknown as Set<string>, mapping)).toBe(false);
    expect(await matchesAllowList("19175395595@s.whatsapp.net", undefined as unknown as Set<string>, mapping)).toBe(false);
  });
  it("parses arrays and comma lists the same way", () => {
    expect([...parseAllowList(["+1 ", "2@s.whatsapp.net", ""])]).toEqual(["1", "2"]);
    expect([...parseAllowList("1, 2,,3")]).toEqual(["1", "2", "3"]);
  });
});

describe("humanUserId", () => {
  it("uses the PN jid, resolving a lid when it can", async () => {
    expect(await humanUserId("19175395595:3@s.whatsapp.net", mapping)).toBe("19175395595@s.whatsapp.net");
    expect(await humanUserId("267383306489914@lid", mapping)).toBe("19175395595@s.whatsapp.net");
  });
  it("keeps an unmapped lid under the lid: prefix", async () => {
    expect(await humanUserId("999:2@lid", mapping)).toBe("lid:999@lid");
  });
});

describe("device suffix and hosted domains (Hermes 6bf1032609, OpenClaw dedupe)", () => {
  it("strips :device from user and lid ids and never builds user@device@server", () => {
    expect(stripDevice("123:4@lid")).toBe("123@lid");
    expect(stripDevice("123:4")).toBe("123");
    expect(normalizeIdentifier("123:4@lid")).toBe("123");
  });
  it("collapses hosted PN and LID domains and the legacy c.us server", () => {
    expect(canonicalJid("123:9@hosted")).toBe("123@s.whatsapp.net");
    expect(canonicalJid("123@c.us")).toBe("123@s.whatsapp.net");
    expect(canonicalJid("55:2@hosted.lid")).toBe("55@lid");
    expect(canonicalJid("120363@g.us")).toBe("120363@g.us");
    expect(sameJid("123:4@s.whatsapp.net", "123@hosted")).toBe(true);
    expect(sameJid("123@s.whatsapp.net", "123@lid")).toBe(false);
    expect(canonicalJid(undefined)).toBe("");
  });
  it("does not confuse a PN and a LID that share digits", () => {
    expect(isSelfChat("111@lid", { pn: "111@s.whatsapp.net" })).toBe(false);
  });
});

describe("alternate JIDs (Hermes 3926c4209c, remoteJidAlt / participantAlt)", () => {
  it("matches an allowlist through the phone twin before any lid mapping exists", async () => {
    const allowed = parseAllowList(["19175395595"]);
    expect(await matchesAllowListWithAlt("777@lid", "19175395595@s.whatsapp.net", allowed)).toBe(true);
    expect(await matchesAllowListWithAlt("777@lid", undefined, allowed)).toBe(false);
    expect(await matchesAllowListWithAlt("777@lid", "555@s.whatsapp.net", allowed)).toBe(false);
  });
  it("uses the alt PN as the human id and as the display number", async () => {
    expect(await humanUserId("777@lid", undefined, { altJid: "19175395595:2@s.whatsapp.net" })).toBe("19175395595@s.whatsapp.net");
    expect(await displayPn("777@lid", undefined, "19175395595@s.whatsapp.net")).toBe("19175395595@s.whatsapp.net");
    expect(await displayPn("777@lid")).toBeUndefined();
  });
  it("never re-keys a binding first seen as a bare lid, even once the phone is learned", async () => {
    const existing = new Set(["lid:267383306489914@lid"]);
    expect(await humanUserId("267383306489914@lid", mapping, { existing })).toBe("lid:267383306489914@lid");
    expect(await humanUserId("267383306489914@lid", mapping, { existing, altJid: "19175395595@s.whatsapp.net" })).toBe("lid:267383306489914@lid");
    expect(await humanUserId("267383306489914@lid", mapping)).toBe("19175395595@s.whatsapp.net");
  });
});

it("keeps a stored LID principal when the delivery uses its resolved PN", async () => {
  const existing = new Set(["lid:267383306489914@lid"]);
  expect(await humanUserId("19175395595@s.whatsapp.net", mapping, { existing })).toBe("lid:267383306489914@lid");
});
