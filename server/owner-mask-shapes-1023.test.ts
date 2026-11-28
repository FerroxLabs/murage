// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// q1023-ownermask (MAIN PREPARED OPTION B): the owner's own direct chat masks only high-precision credential shapes in place
// (redact.ts redactCredentialShapesInText); an unsure value is shown. Owners: lane q1023-ownermask (this file, the shape list);
// the real reply route is witnessed in owner-mask-1023.test.ts. Here the store's own write scrub cannot stand in for the owner mask,
// which it does on the route (every stored row also passes redactSecretsInText).
import { describe, expect, it } from "vitest";
import * as redact from "./redact.ts";
import * as ownerDisplay from "./owner-display.ts";

// The pre-fix sha (1f7c2c4f4c) has neither export: there the owner's chat has no in-place shape mask (text unchanged) and no owner
// switch (today's outcome, undefined). So a base run fails at each behavioural assertion below, never at a TypeError or a missing module.
const redactCredentialShapesInText: (text: string) => string =
  (redact as { redactCredentialShapesInText?: (text: string) => string }).redactCredentialShapesInText ?? (text => text);
const ownerMaskedReplyText: (displayed: string | undefined, raw: unknown, ownerOnly: () => boolean) => string | undefined =
  (ownerDisplay as { ownerMaskedReplyText?: typeof ownerMaskedReplyText }).ownerMaskedReplyText ?? (() => undefined);

// generated fixture values, assembled at run time
const SK = ["sk", "proj", "FIXTURE0wnerMask7731abQZx0Lm4Nb7Vc2Xd9"].join("-");
const GH = ["ghp", "FIXTURE0wnerMask7731abQZx0Lm4N"].join("_");
const SLACK = ["xoxb", "FIXTURE0wnerMask7731abQZx0"].join("-");
const PEM = ["-----BEGIN PRIVATE", "KEY-----\nMIIFIXTURE0wnerMask7731abQZ\n-----END PRIVATE", "KEY-----"].join(" ");
const BEARER_TOKEN = ["FIXTURE0wnerMask", "7731abQZx0Lm4Nb7"].join("");
const JWT_TOKEN = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJmaXh0dXJlIn0", "FIXTURE0wnerMask7731abQZx0Lm4Nb7"].join(".");
const mark = (value: string) => `«redacted ${value.length} chars»`;

describe("q1023-ownermask shapes: only credential shapes are masked in place; everything else is shown word for word", () => {
  it.each([
    ["sk- key", SK],
    ["ghp_ token", GH],
    ["xox token", SLACK],
  ])("S1 a %s is masked in place as «redacted N chars», the words around it stay", (_name, value) => {
    expect(redactCredentialShapesInText(`Your key is ${value}. Keep it safe.`)).toBe(`Your key is ${mark(value)}. Keep it safe.`);
  });

  // q1023-ownermask r3 (self-review M: no row pinned BEARER or JWT in the shape list, redact.ts CREDENTIAL_SHAPE_RULES)
  it.each([
    ["Bearer token", "Authorization: Bearer ", BEARER_TOKEN],
    ["JWT", "The session is ", JWT_TOKEN],
  ])("S1b a %s is masked in place, the words around it stay", (_name, lead, value) => {
    expect(redactCredentialShapesInText(`${lead}${value} for now.`)).toBe(`${lead}${mark(value)} for now.`);
  });

  it("S2 a PEM private-key block is masked in place", () => {
    const out = redactCredentialShapesInText(`Here:\n${PEM}\nDone.`);
    expect(out.startsWith("Here:\n")).toBe(true);
    expect(out.endsWith("\nDone.")).toBe(true);
    expect(out).not.toContain("MIIFIXTURE0wnerMask7731abQZ");
  });

  it.each([
    ["a label value", "The database password is quietharbor7731."],
    ["key=value", "Set DB_PASSWORD=harbor in the file."],
    ["a 1567-char plain value", "x".repeat(1567)],
    ["a card-like number", "Order 4111 1111 1111 1111 shipped."],
  ])("S3 %s is not a credential shape: shown word for word (unsure means show)", (_name, text) => {
    expect(redactCredentialShapesInText(text)).toBe(text);
  });

  it("S4 the switch: a shared audience or a clean projection keeps today's outcome (undefined); the owner gets the shape mask", () => {
    const raw = `Your key is ${SK}.`;
    expect(ownerMaskedReplyText("«redacted»", raw, () => false)).toBeUndefined();
    expect(ownerMaskedReplyText("A clean projection.", raw, () => true)).toBeUndefined();
    expect(ownerMaskedReplyText("«redacted»", raw, () => true)).toBe(`Your key is ${mark(SK)}.`);
    expect(ownerMaskedReplyText(undefined, raw, () => true)).toBe(`Your key is ${mark(SK)}.`);
  });
});
