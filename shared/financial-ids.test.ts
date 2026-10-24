// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FINANCIAL_RULE_VERSION,
  hasFinancialIdentifier,
  maskFinancialIdentifiers,
  passesFinancialFastPath,
} from "./financial-ids.ts";

interface Vectors {
  ruleVersion: number;
  mask: { id: string; input: string; expect: string }[];
  hasFinancialIdentifier: string[];
}

// The same file the Flux Memory port tests against.
const vectors = JSON.parse(readFileSync(new URL("./financial-ids.vectors.json", import.meta.url), "utf8")) as Vectors;
const bytes = (s: string) => Buffer.byteLength(s, "utf8");

describe("maskFinancialIdentifiers: the shared vectors", () => {
  it("the vectors are for this rule version", () => {
    expect(vectors.ruleVersion).toBe(FINANCIAL_RULE_VERSION);
    expect(vectors.mask.length).toBeGreaterThan(80);
  });

  for (const row of vectors.mask) {
    it(`${row.id}: ${row.expect === row.input ? "unchanged" : "masked"}`, () => {
      expect(maskFinancialIdentifiers(row.input)).toBe(row.expect);
    });
  }

  it("M17/T12: every row twice through the function is byte for byte the same as once", () => {
    for (const row of vectors.mask) {
      const once = maskFinancialIdentifiers(row.input);
      expect(maskFinancialIdentifiers(once), row.id).toBe(once);
    }
  });

  it("M18/T13: every row keeps its UTF-8 byte length", () => {
    for (const row of vectors.mask) {
      expect(bytes(maskFinancialIdentifiers(row.input)), row.id).toBe(bytes(row.input));
    }
  });

  it("F1: every row that masks passes the fast path alone", () => {
    const masked = vectors.mask.filter((row) => row.expect !== row.input);
    expect(masked.length).toBeGreaterThan(40);
    for (const row of masked) expect(passesFinancialFastPath(row.input), row.id).toBe(true);
  });

  it("F2: hasFinancialIdentifier is true for the short shapes and for a bare year", () => {
    for (const text of vectors.hasFinancialIdentifier) expect(hasFinancialIdentifier(text), text).toBe(true);
    expect(maskFinancialIdentifiers("the 2026 budget")).toBe("the 2026 budget");
    expect(hasFinancialIdentifier("no numbers here at all")).toBe(false);
    expect(hasFinancialIdentifier("call at 3pm")).toBe(false);
  });
});

describe("maskFinancialIdentifiers: shapes inside longer text", () => {
  it("masks inside a paragraph and leaves the rest as typed", () => {
    const text = "Bank: Frost Bank, deposits go to the account ending 4471\nCard 4111 1111 1111 1111, IBAN DE89 3704 0044 0532 0130 00.";
    expect(maskFinancialIdentifiers(text)).toBe(
      "Bank: Frost Bank, deposits go to the account ending ****\nCard **** **** **** ****, IBAN DE** **** **** **** **** **.",
    );
  });

  it("keeps non-ASCII text around a masked number and its byte length", () => {
    const text = "Konto für Miete: account number: 12345678 · danke 🙂";
    const out = maskFinancialIdentifiers(text);
    expect(out).toBe("Konto für Miete: account number: ******** · danke 🙂");
    expect(bytes(out)).toBe(bytes(text));
  });

  it("a context word on another line does not gate a number", () => {
    expect(maskFinancialIdentifiers("SSN\n123-45-6789")).toBe("SSN\n123-45-6789");
    expect(maskFinancialIdentifiers("my card\nending 4471")).toBe("my card\nending 4471");
  });

  it("non-strings come back as they are", () => {
    expect(maskFinancialIdentifiers("")).toBe("");
    expect(maskFinancialIdentifiers(undefined as unknown as string)).toBe(undefined);
  });
});

describe("maskFinancialIdentifiers: fuzz over digit runs", () => {
  // A small deterministic generator, so a failure names its seed.
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }
  const words = ["account", "card", "ending", "SSN", "VAT", "IBAN", "routing", "passport no.", "sort code", "the", "and", "été", "漢字", "+", "#", "x"];
  const seps = [" ", "-", "", ".", "/", ": ", "\n"];

  it("byte length and idempotence hold on 4,000 random texts", () => {
    const next = rng(20261023);
    for (let n = 0; n < 4000; n++) {
      let text = "";
      const parts = 1 + Math.floor(next() * 8);
      for (let p = 0; p < parts; p++) {
        if (next() < 0.5) text += words[Math.floor(next() * words.length)];
        else {
          const len = 1 + Math.floor(next() * 20);
          for (let k = 0; k < len; k++) text += String(Math.floor(next() * 10));
        }
        text += seps[Math.floor(next() * seps.length)];
      }
      const once = maskFinancialIdentifiers(text);
      expect(bytes(once), `seed ${n}: ${JSON.stringify(text)}`).toBe(bytes(text));
      expect(maskFinancialIdentifiers(once), `seed ${n}: ${JSON.stringify(text)}`).toBe(once);
      // Only ASCII letters and digits ever change, and only into `*`.
      for (let i = 0; i < text.length; i++) {
        if (once[i] !== text[i]) expect(/[A-Za-z0-9]/.test(text[i]) && once[i] === "*", `seed ${n} at ${i}`).toBe(true);
      }
    }
  });
});
