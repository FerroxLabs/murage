// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.18 ERRORS-NAME scope B: what the provider said is kept as one short clean line, with no key, link path, email or
// invisible character left in it.
import { describe, expect, it } from "vitest";
import { PROVIDER_SAID_MAX } from "../shared/provider-error.ts";
import { clampProviderSaid, providerSaidText, providerTeam, withProviderSaid } from "./provider-said.ts";

const XAI = "Your team 0a1b2c3d-1111-2222-3333-444455556666 has either used all available credits or reached its monthly spending limit.";

describe("providerSaidText", () => {
  it("keeps xAI's sentence and its team id", () => {
    expect(providerSaidText(XAI)).toBe(XAI);
    expect(providerTeam(XAI)).toBe("0a1b2c3d-1111-2222-3333-444455556666");
    expect(providerTeam("no team here")).toBeUndefined();
  });
  it("a link keeps only its host, whole, even when its query holds a token and a signature", () => {
    const said = providerSaidText("See https://host.invalid/?token=abcdefghijklmnop&sig=opaqueSignedValue for details") ?? "";
    expect(said).toBe("See host.invalid link for details");
    expect(said).not.toMatch(/opaqueSignedValue|abcdefghijklmnop/);
  });
  it("removes keys, bearer strings and emails", () => {
    const said = providerSaidText("Key xai-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd refused; Bearer sk-ABCDEFGHIJKLMNOPQRSTUVWX0123; mail ops@example.com") ?? ""; // secret-scan: fixture
    expect(said).not.toMatch(/xai-ABCDEFGHIJ|sk-ABCDEFGHIJ|ops@example\.com/);
    expect(said).toContain("«email»");
  });
  it("drops control, zero-width, separator, bidi and BOM characters", () => {
    const hidden = [0x07, 0x200b, 0x2028, 0x202e, 0x2066, 0x2069, 0xfeff].map((c) => String.fromCharCode(c)).join("");
    expect(providerSaidText(`pay${hidden}ment needed`)).toBe("pay ment needed");
  });
  it("reads the envelope sentence of a JSON body, and nothing from a body that is not an envelope", () => {
    expect(providerSaidText(JSON.stringify({ error: { message: "Insufficient credit." } }))).toBe("Insufficient credit.");
    expect(providerSaidText(JSON.stringify({ nothing: 1 }))).toBeUndefined();
  });
  it("is at most PROVIDER_SAID_MAX characters, and a 16 KiB+ input is cut first", () => {
    const said = providerSaidText(`${"word ".repeat(5_000)}end`) ?? "";
    expect(said.length).toBeLessThanOrEqual(PROVIDER_SAID_MAX);
    expect(said.endsWith("…")).toBe(true);
  });
  it("withProviderSaid reads error.data.message; clampProviderSaid re-cleans a stored copy and drops a bad team id", () => {
    const info = withProviderSaid({ kind: "payment" } as never, { data: { message: XAI } });
    expect(info).toMatchObject({ providerSaid: XAI, providerTeam: "0a1b2c3d-1111-2222-3333-444455556666" });
    const clamped = clampProviderSaid({ kind: "payment", providerSaid: "see https://h.invalid/p?k=secretvalue", providerTeam: "not-a-uuid" } as never);
    expect(clamped).toMatchObject({ providerSaid: "see h.invalid link" });
    expect(clamped).not.toHaveProperty("providerTeam");
  });
});
