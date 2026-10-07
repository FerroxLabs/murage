// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { classifyFloor, type FloorFacts } from "./browser-floor.ts";

const click = (name: string, extra: Partial<FloorFacts> = {}): FloorFacts => ({ operation: "click", tag: "button", name, ...extra });

describe("CLS bounded floor matching", () => {
  it.each([
    ["Pay " + "a".repeat(100), "payment"],
    ["a".repeat(200) + " Pay now", "payment"],
    ["I agree " + "a".repeat(492), "consent"],
    ["Pagar " + "a".repeat(100), "payment"],
    ["J'accepte " + "a".repeat(200), "consent"],
    ["Alle akzeptieren " + "a".repeat(200), "consent"],
    ["同意します" + "a".repeat(200), "consent"],
    ["我同意" + "a".repeat(200), "consent"],
    ["मैं सहमत हूँ " + "a".repeat(200), "consent"],
    ["続行Pay now继续", "payment"],
    ["继续I agree続行", "consent"],
  ])("classifies the bounded label %s", (name, floor) => {
    expect(classifyFloor(click(name)).floor).toBe(floor);
  });

  it.each(["\u0000", "\u0008", "\u200b", "\u200d", "\u202e", "\u2066", "\u2069", "\u034f", "\ufe0f"])("matches through invisible character %j", hidden => {
    expect(classifyFloor(click(`P${hidden}ay now`)).floor).toBe("payment");
    expect(classifyFloor(click(`I ag${hidden}ree`)).floor).toBe("consent");
  });

  it.each(["Pаy now", "Рay now", "I agrеe"])("hands mixed-script lookalikes to the owner: %s", name => {
    expect(classifyFloor(click(name))).toMatchObject({ unsure: true });
    expect(classifyFloor(click(name)).floor).not.toBeNull();
  });

  it.each([
    ["name", 500], ["description", 500], ["text", 500], ["buttonValue", 200],
    ["title", 200], ["ariaLabel", 200], ["alt", 200], ["placeholder", 200], ["fieldName", 160],
  ] as const)("treats a collector-capped %s as unsure", (field, cap) => {
    const facts = click("Next", { [field]: "x".repeat(cap) });
    expect(classifyFloor(facts)).toMatchObject({ unsure: true });
    expect(classifyFloor(facts).floor).not.toBeNull();
  });

  it("does not accept a benign prefix when the dangerous suffix was clipped", () => {
    const full = "Next " + "x".repeat(495) + " Pay now";
    expect(classifyFloor(click(full.slice(0, 500)))).toMatchObject({ unsure: true });
    expect(classifyFloor(click(full))).toMatchObject({ unsure: true });
    expect(classifyFloor(click("Reject all " + "x".repeat(490), { signatures: { consentManager: true } }))).toMatchObject({ unsure: true });
  });

  it("matches long credential and upload labels", () => {
    expect(classifyFloor({ operation: "fill", tag: "input", name: "x".repeat(180) + " Password" }).floor).toBe("credentials");
    expect(classifyFloor({ operation: "upload", tag: "input", name: "x".repeat(180) + " Passport" }).floor).toBe("credentials");
  });

  it("recognises name-only chips including consent in context", () => {
    expect(classifyFloor({ operation: "click", name: "Pay now" }).floor).toBe("payment");
    expect(classifyFloor({ operation: "click", name: "Continue", page: { urlPath: "/oauth/authorize" } }).floor).toBe("consent");
    expect(classifyFloor({ operation: "click", name: "Join", snippets: { form: "By clicking Join you agree to the terms." } }).floor).toBe("consent");
    expect(classifyFloor({ operation: "click", tag: "span", name: "Continue", page: { urlPath: "/oauth/authorize" } }).floor).toBe("consent");
    expect(classifyFloor(click("Pay " + "a".repeat(100), { frame: { host: "embedded.example.test", readable: false } })).floor).toBe("payment");
  });
});
