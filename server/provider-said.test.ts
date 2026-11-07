// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.18 ERRORS-NAME scope B: what the provider said is kept only as the reviewed wording of a recognised account sentence.
// No provider text is copied, so no key, link, host, email, marker or invisible character can be left in it.
import { describe, expect, it } from "vitest";
import { PROVIDER_SAID_MAX } from "../shared/provider-error.ts";
import { clampProviderSaid, providerSaidText, providerTeam, withProviderSaid } from "./provider-said.ts";

const XAI = "Your team 0a1b2c3d-1111-2222-3333-444455556666 has either used all available credits or reached its monthly spending limit.";
const LEAK = /fake-secret-canary|billing\.invalid|fluxrouter\.ai|private|opaqueSignedValue|abcdefghijklmnop|ops@example\.com|xai-ABCDEFGHIJ|sk-ABCDEFGHIJ/;

describe("providerSaidText", () => {
  it("keeps xAI's sentence and its team id", () => {
    expect(providerSaidText(XAI)).toBe(XAI);
    expect(providerTeam(XAI)).toBe("0a1b2c3d-1111-2222-3333-444455556666");
    expect(providerTeam("no team here")).toBeUndefined();
  });
  it("a team id is read only from xAI's spend-limit line", () => {
    expect(providerTeam("team 0a1b2c3d-1111-2222-3333-444455556666 private response")).toBeUndefined();
  });
  it("keeps the reviewed wording, never the provider's text around it", () => {
    expect(providerSaidText("API error (status 402 Payment Required): Your credit balance is exhausted. https://billing.invalid/?token=fake-secret-canary"))
      .toBe("Your credit balance is exhausted.");
    expect(providerSaidText("Billing failed: insufficient credits for fake-secret-canary at https://billing.invalid/(private)/x?q=opaqueSignedValue"))
      .toBe("Insufficient credit.");
    expect(providerSaidText("Key xai-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd refused; Bearer sk-ABCDEFGHIJKLMNOPQRSTUVWX0123; mail ops@example.com; you exceeded your current quota")).toBe("The usage quota was reached."); // secret-scan: fixture
  });
  it("drops every sentence it does not recognise, even an account-sounding one", () => {
    for (const raw of [
      "private response fake-secret-canary https://billing.invalid/private",
      "Account access unavailable. https://fluxrouter.ai/home/billing?token=fake-secret-canary",
      "Billing failed. private response fake-secret-canary",
      "See https://host.invalid/?token=abcdefghijklmnop&sig=opaqueSignedValue for details",
    ]) expect(providerSaidText(raw)).toBeUndefined();
  });
  it("reads through control, zero-width, separator, bidi and BOM characters", () => {
    const hidden = [0x07, 0x200b, 0x2028, 0x202e, 0x2066, 0x2069, 0xfeff].map((c) => String.fromCharCode(c)).join("");
    expect(providerSaidText(`insufficient${hidden}credit`)).toBe("Insufficient credit.");
  });
  it("reads the envelope sentence of a JSON body, and nothing from a body that is not an envelope", () => {
    expect(providerSaidText(JSON.stringify({ error: { message: "Insufficient credit." } }))).toBe("Insufficient credit.");
    expect(providerSaidText(JSON.stringify({ nothing: 1, note: "insufficient credit" }))).toBeUndefined();
  });
  it("is at most PROVIDER_SAID_MAX characters, and a 16 KiB+ input is read only up to the cut", () => {
    expect((providerSaidText(XAI) ?? "").length).toBeLessThanOrEqual(PROVIDER_SAID_MAX);
    expect(providerSaidText(`${"word ".repeat(5_000)}insufficient credit`)).toBeUndefined();
  });
  it("no recognised sentence carries any provider data", () => {
    const inputs = ["Your credit balance is exhausted. fake-secret-canary", "payment required https://billing.invalid/?k=opaqueSignedValue", `${XAI} https://billing.invalid/private`];
    for (const raw of inputs) expect(providerSaidText(raw) ?? "").not.toMatch(LEAK);
  });
  it("withProviderSaid reads error.data.message; clampProviderSaid re-reads a stored copy and drops a team id it cannot vouch for", () => {
    const info = withProviderSaid({ kind: "payment" } as never, { data: { message: XAI } });
    expect(info).toMatchObject({ providerSaid: XAI, providerTeam: "0a1b2c3d-1111-2222-3333-444455556666" });
    const clamped = clampProviderSaid({ kind: "payment", providerSaid: "spend limit: see https://h.invalid/p?k=secretvalue; spending limit reached", providerTeam: "not-a-uuid" } as never);
    expect(clamped).toMatchObject({ providerSaid: "The spending limit was reached." });
    expect(clamped).not.toHaveProperty("providerTeam");
    expect(clampProviderSaid({ kind: "payment", providerSaid: "private response fake-secret-canary" } as never)).not.toHaveProperty("providerSaid");
    expect(clampProviderSaid({ kind: "payment", providerSaid: XAI, providerTeam: "0a1b2c3d-1111-2222-3333-444455556666" } as never)).toMatchObject({ providerTeam: "0a1b2c3d-1111-2222-3333-444455556666" });
  });
});
