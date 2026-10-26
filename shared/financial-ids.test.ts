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
// A namespace import too, so a build without financialRuleOffsets fails only
// the test that needs it.
import * as financialIds from "./financial-ids.ts";

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

  it("every vector only replaces ASCII letters or digits with stars and leaves no rule matches", () => {
    for (const row of vectors.mask) {
      const once = maskFinancialIdentifiers(row.input);
      for (let i = 0; i < row.input.length; i++) {
        if (once[i] === row.input[i]) continue;
        expect(once[i], `${row.id} at ${i}`).toBe("*");
        expect(/[A-Za-z0-9]/.test(row.input[i]), `${row.id} at ${i}`).toBe(true);
      }
      for (const [rule, offsets] of Object.entries(financialIds.financialRuleOffsets(once))) {
        expect(offsets, `${row.id}: ${rule}`).toEqual([]);
      }
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

describe("maskFinancialIdentifiers: v4 follow-up regressions", () => {
  function check(input: string, expected: string): void {
    const once = maskFinancialIdentifiers(input);
    expect(once, input).toBe(expected);
    expect(maskFinancialIdentifiers(once), input).toBe(once);
    expect(bytes(once), input).toBe(bytes(input));
    for (const [rule, offsets] of Object.entries(financialIds.financialRuleOffsets(once))) {
      expect(offsets, `${input}: ${rule}`).toEqual([]);
    }
    if (once !== input) {
      expect(passesFinancialFastPath(input), input).toBe(true);
      expect(hasFinancialIdentifier(input), input).toBe(true);
    }
  }

  it("masks one- and two-letter IBAN tail groups before stars or an adjacent card", () => {
    for (const tail of ["UR", "U R"]) {
      for (const lower of [false, true]) {
        const raw = `MU17 BOMM 0101 1010 3030 0200 000M ${tail}`;
        const iban = lower ? raw.toLowerCase() : raw;
        const masked = iban.slice(0, 2) + iban.slice(2).replace(/[A-Za-z0-9]/g, "*");
        for (const suffix of ["*", "**", "*note", "4111111111111111", "4111.1111.1111.1111"]) {
          const expectedSuffix = suffix.startsWith("*") ? suffix : suffix.replace(/\d/g, "*");
          check(iban + suffix, masked + expectedSuffix);
        }
      }
    }
  });

  it("keeps every v3 mask when two valid IBANs overlap at a country code", () => {
    const input = "GB13 WEST 1234 5698 7654 DE89 3704 0044 0532 0130 00";
    const before = "GB13 WEST 1234 5698 7654 DE** **** **** **** **** **";
    const expected = "GB** **** **** **** **** **** **** **** **** **** **";
    check(input, expected);
    for (let i = 0; i < before.length; i++) {
      if (before[i] === "*") expect(expected[i]).toBe("*");
    }
    expect(expected).not.toBe(before);
  });

  it("accepts every one- or two-character GROUP_SEP combination in codes, routing and SSNs", () => {
    const chars = [" ", "\t", ".", "/", "-"];
    const separators = [...chars, ...chars.flatMap((a) => chars.map((b) => a + b))];
    for (const a of separators) {
      check(`bsb 062${a}000`, `bsb ***${a}***`);
      for (const b of separators) {
        check(`sort code 40${a}47${b}84`, `sort code **${a}**${b}**`);
        check(`routing 021${a}000${b}021`, `routing ***${a}***${b}***`);
        check(`SSN 123${a}45${b}6789`, `SSN ***${a}**${b}****`);
        check(`ITIN 912${a}70${b}1234`, `ITIN ***${a}**${b}****`);
      }
    }
    for (const a of ["", " ", "-"]) for (const b of ["", " ", "-"]) {
      check(`routing 021${a}000${b}021`, `routing ***${a}***${b}***`);
      check(`SSN 123${a}45${b}6789`, `SSN ***${a}**${b}****`);
    }
    check("sort code 404784, bsb 062000", "sort code ******, bsb ******");
  });

  it("retains context, checksum, group-shape and line boundaries", () => {
    for (const input of [
      "sort code 2026.10.24", "routing 123.456.789", "ref 123.45.6789",
      "SSN 000..45..6789", "SSN 123..00..6789", "SSN 123..45..0000",
      "SSN 912..70..1234", "ITIN 912..89..1234", "bsb 062..000x",
    ]) check(input, input);
    for (const sep of ["*", ",", "+", ":", "\n", "\r", "   "]) {
      for (const input of [
        `sort code 40${sep}47${sep}84`, `bsb 062${sep}000`,
        `routing 021${sep}000${sep}021`, `SSN 123${sep}45${sep}6789`,
      ]) check(input, input);
    }
  });

  it("masks account-window digit tokens at and beyond 20 characters, without a length ceiling", () => {
    for (const word of ["account", "acct", "a/c"]) {
      for (const length of [20, 21, 22, 64, 4096, 65536]) {
        const digits = "1".repeat(length);
        const prefix = `${word} 12*`;
        const once = maskFinancialIdentifiers(prefix + digits);
        expect(once, `${word}, ${length} digits`).toBe(prefix + "*".repeat(length));
        expect(maskFinancialIdentifiers(once)).toBe(once);
        expect(bytes(once)).toBe(bytes(prefix + digits));
      }
    }
    const digits = "1".repeat(21);
    check(`account${"*".repeat(31)}${digits}`, `account${"*".repeat(52)}`);
    for (const input of [
      `account${"*".repeat(32)}${digits}`, `account\n12*${digits}`, `account\r12*${digits}`,
      `account 12*${digits}x`, `account 12*${digits}_`,
    ]) check(input, input);
    check(`account 12*${digits}*`, `account 12${"*".repeat(23)}`);
  });

  it("preserves account qualifiers and handles long whitespace gaps and overlapping code groups", () => {
    for (const qualifier of ["", "number", "num", "nr", "no.", "#"]) {
      check(`account ${qualifier} : 123456`, `account ${qualifier} : ******`);
    }
    const gap = " ".repeat(65536);
    check(`account${gap}123456`, `account${gap}******`);
    // Keep four digits elsewhere so the fast path cannot hide gap backtracking.
    const noRun = `account${gap}x 1234`;
    check(noRun, noRun);
    const codes = "40. 47/-84 ".repeat(2048);
    const input = `sort code ${codes}`;
    const expected = `sort code ${codes.replace(/\d/g, "*")}`;
    expect(maskFinancialIdentifiers(input)).toBe(expected);
    expect(maskFinancialIdentifiers(expected)).toBe(expected);
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

  it("byte length holds and a second pass changes nothing on 4,000 random texts", () => {
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

describe("maskFinancialIdentifiers: property over digit groups and separators", () => {
  // FluxMain's fuzz found a long card before a grouped one (the shape of
  // "checking\t4222222222222 4111 1111 1111 1111", published test numbers):
  // the first pass masked the four-group card and left the long card
  // beside it, which only a second pass masked. These texts are runs of digit
  // groups joined by the separators a card, an account or a list is typed
  // with, before and between the words that gate the other rules, which is
  // where two more such gaps were found (a routing number read across a
  // masked one, an id read from after a masked "ending NNNN"). No word here
  // guards a phone number and no group is glued to a letter after it, so the
  // module's own card rule applies to every group of 13 to 19 digits.
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }
  const luhnSum = (digits: string) => {
    let sum = 0;
    let double = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let d = digits.charCodeAt(i) - 48;
      if (double) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
      sum += d;
      double = !double;
    }
    return sum % 10;
  };
  /** The card test of the module, written out again: 13 to 19 digits, a
   * first digit of 2 to 6, a valid Luhn check digit. */
  const isCard = (digits: string) => digits.length >= 13 && digits.length <= 19 && digits[0] >= "2" && digits[0] <= "6" && luhnSum(digits) === 0;
  const prefixes = [
    "", "checking\t", "savings ", "card ", "ref ", "the ", "account ", "acct: ", "account number ", "a/c no. ", "SSN ", "ITIN ", "tin ",
    "VAT ", "EIN ", "tax id ", "PAN ", "passport no. ", "ID number ", "IBAN ", "iban DE", "GB", "routing ", "aba ", "transit ",
    "sort code ", "bsb ", "ending ", "ending in ", "last four ", "card ending ",
  ];
  const seps = [" ", " ", "-", "-", "\t", ", ", "  ", " / ", ""];
  const suffixes = ["", "", " 12/27", " thanks", "."];

  function text(next: () => number): string {
    let out = prefixes[Math.floor(next() * prefixes.length)];
    const groups = 1 + Math.floor(next() * 7);
    for (let g = 0; g < groups; g++) {
      const r = next();
      // Mostly four digit groups, some card-group lengths, some long ones.
      const len = r < 0.5 ? 4 : r < 0.6 ? 3 + Math.floor(next() * 4) : 1 + Math.floor(next() * 20);
      let d = String(2 + Math.floor(next() * 5));
      while (d.length < len - 1) d += String(Math.floor(next() * 10));
      if (len > 1) {
        // Half the time, a check digit that makes the group pass Luhn alone.
        if (next() < 0.5) {
          let c = 0;
          while (luhnSum(d + c) !== 0) c++;
          d += c;
        } else d += String(Math.floor(next() * 10));
      }
      out += d.slice(0, len);
      if (g === groups - 1) break;
      const sep = seps[Math.floor(next() * seps.length)];
      out += sep;
      // Now and then a context word between groups ("... card ending 3595-..."),
      // never glued to the group before it.
      if (sep !== "" && next() < 0.15) out += prefixes[Math.floor(next() * prefixes.length)];
    }
    return out + suffixes[Math.floor(next() * suffixes.length)];
  }

  // FINANCIAL_IDS_CASES raises the case count for a long fuzz run on a runner.
  const CASES = Number(process.env.FINANCIAL_IDS_CASES) || 100000;

  it("P1: on 100,000 texts the first pass is final and leaves no card of 13 to 19 digits", () => {
    const next = rng(20261024);
    let longCards = 0;
    for (let n = 0; n < CASES; n++) {
      const input = text(next);
      const once = maskFinancialIdentifiers(input);
      const label = `case ${n}: ${JSON.stringify(input)} -> ${JSON.stringify(once)}`;
      expect(maskFinancialIdentifiers(once), label).toBe(once);
      expect(bytes(once), label).toBe(bytes(input));
      for (const m of input.matchAll(/(?<![A-Za-z0-9_*])\d{13,19}(?![A-Za-z0-9_*])/g)) if (isCard(m[0])) longCards++;
      for (const m of once.matchAll(/(?<![A-Za-z0-9_*])\d{13,19}(?![A-Za-z0-9_*])/g)) {
        expect(isCard(m[0]), `${label}: ${m[0]} survived the first pass`).toBe(false);
      }
    }
    // The generator does reach the case: thousands of long cards, not a few.
    expect(longCards).toBeGreaterThan(5000);
  });

  it("P2: the reported text is masked whole on the first pass", () => {
    const input = "checking\t4222222222222 4111 1111 1111 1111";
    const once = maskFinancialIdentifiers(input);
    expect(once).toBe("checking\t************* **** **** **** ****");
    expect(maskFinancialIdentifiers(once)).toBe(once);
  });

  // A context word before a run that mixes cards and an id (GrokBuild on
  // af91e9734: "EIN 4111 1111 1111 1111 12-3456789" kept the EIN, because the
  // masked card was read as digits of the id). Cards are published test
  // numbers in the groupings people type; ids are synthetic. Every card is
  // masked whole, and every id that starts inside the 32 character window
  // after the word is masked whole, before or after a card, on the first pass.
  const CARDS = [
    "4111 1111 1111 1111", "4111-1111-1111-1111", "4111111111111111", "5555 5555 5555 4444", "5555555555554444",
    "4012888888881881", "4242 4242 4242 4242", "378282246310005", "3782 822463 10005", "6011111111111117", "4222222222222",
  ];
  const ID_WORDS = ["EIN", "VAT", "tax id", "PAN", "passport no", "ID number", "SIN", "national id"];
  const SSN_WORDS = ["SSN", "TIN"];
  const JOINS = [" ", "/", "-", " / ", ", "];
  // Between two cards, and after an SSN whose last group has four digits, a
  // join the card rule does not read across: with a space or a dash the
  // grouped-card window could take digits from both sides, which is the card
  // rule's own choice and not what this property tests.
  const APART = ["/", " / ", ", "];
  const digits = (next: () => number, n: number) => {
    let out = "";
    for (let k = 0; k < n; k++) out += String(Math.floor(next() * 10));
    return out;
  };
  /** An SSN shape the SSN rule accepts: area 100 to 599, group and serial not zero. */
  const ssn = (next: () => number) =>
    `${100 + Math.floor(next() * 500)}-${10 + Math.floor(next() * 90)}-${1000 + Math.floor(next() * 9000)}`;
  function idFor(word: string, next: () => number): string {
    if (SSN_WORDS.includes(word)) return ssn(next);
    const r = next();
    if (r < 0.3) return `${digits(next, 2)}-${digits(next, 7)}`;
    if (r < 0.5) return ssn(next);
    if (r < 0.7) return `X${digits(next, 7)}`;
    if (r < 0.85) return `AB${digits(next, 7)}`;
    return digits(next, 7 + Math.floor(next() * 3));
  }

  it("P3: after a context word, an id beside a card is masked on the first pass and the card is never part of it", () => {
    const next = rng(20261025);
    let idsChecked = 0;
    for (let n = 0; n < CASES; n++) {
      const word = next() < 0.15 ? SSN_WORDS[Math.floor(next() * SSN_WORDS.length)] : ID_WORDS[Math.floor(next() * ID_WORDS.length)];
      let input = `${word} `;
      const wordEnd = word.length;
      const cards: [number, number][] = [];
      const ids: [number, number][] = [];
      const items = 2 + Math.floor(next() * 3);
      let last = "";
      let lastWasId = false;
      for (let k = 0; k < items; k++) {
        // At least one id; never two ids side by side (two ids joined by a
        // space are one longer run, which is no id).
        const wantId = ids.length === 0 && k === items - 1 ? true : !lastWasId && next() < 0.45;
        if (k > 0) {
          const apart = (!wantId && !lastWasId) || (!wantId && /(?:^|\D)\d{4,6}$/.test(last));
          input += apart ? APART[Math.floor(next() * APART.length)] : JOINS[Math.floor(next() * JOINS.length)];
        }
        const item = wantId ? idFor(word, next) : CARDS[Math.floor(next() * CARDS.length)];
        (wantId ? ids : cards).push([input.length, input.length + item.length]);
        input += item;
        last = item;
        lastWasId = wantId;
      }
      if (cards.length === 0) {
        input += APART[0] + CARDS[0];
        cards.push([input.length - CARDS[0].length, input.length]);
      }
      const once = maskFinancialIdentifiers(input);
      const label = `case ${n}: ${JSON.stringify(input)} -> ${JSON.stringify(once)}`;
      expect(maskFinancialIdentifiers(once), label).toBe(once);
      expect(bytes(once), label).toBe(bytes(input));
      for (const [a, b] of cards) expect(/\d/.test(once.slice(a, b)), `${label}: card at ${a}`).toBe(false);
      for (const [a, b] of ids) {
        if (a >= wordEnd + 32) continue; // past the window: no id rule reads it
        idsChecked++;
        expect(/\d/.test(once.slice(a, b)), `${label}: id at ${a}`).toBe(false);
      }
    }
    expect(idsChecked).toBeGreaterThan(CASES / 2);
  });

  // FluxMain's differential fuzz (seed 2) on af91e9734:
  // "ITIN-NINO_465718_\t-VAT / 58419*phone, 399413872035997-..." masked
  // "58419*phone" as a VAT id on the first pass, which took away the phone
  // word that kept the 15 digit card beside it, and a second pass masked the
  // card. Here ids, guard words (also inside an id, "CALL1234567"), typed
  // stars and cards sit side by side: the first pass is final, and no card
  // group of 13 to 19 digits survives it, guard word or not.
  const GUARDS = ["phone", "tel", "call", "cell", "fax", "mobile", "tel:", "+", "#", "CALL1234567", "TEL4567890", "58419*phone"];
  const P4_WORDS = ["VAT", "EIN", "ITIN", "NINO", "PAN", "SSN", "tax id", "ID number", "account", "card ending"];
  const P4_SEPS = [" ", " ", "\t", " / ", ", ", "-", "_", "*", ": "];

  it("P4: ids beside guard words: the first pass is final and leaves no long card", () => {
    const next = rng(20261026);
    const pick = <T,>(list: readonly T[]) => list[Math.floor(next() * list.length)];
    for (let n = 0; n < CASES; n++) {
      let input = "";
      const cards: [number, number][] = [];
      const parts = 2 + Math.floor(next() * 6);
      for (let k = 0; k < parts; k++) {
        const r = next();
        let part: string;
        if (r < 0.25) part = pick(GUARDS);
        else if (r < 0.45) part = pick(P4_WORDS);
        else if (r < 0.65) {
          part = pick(CARDS);
          // A card not glued to a letter, digit or `_` before it (GrokBuild r3
          // Low: a grouped card after a guard word must be masked whole).
          if (!/[A-Za-z0-9_]$/.test(input)) cards.push([input.length, input.length + part.length]);
        } else if (r < 0.85) part = idFor(pick(ID_WORDS), next);
        else part = digits(next, 1 + Math.floor(next() * 19));
        input += part;
        if (k < parts - 1) input += pick(P4_SEPS);
      }
      const once = maskFinancialIdentifiers(input);
      const label = `case ${n}: ${JSON.stringify(input)} -> ${JSON.stringify(once)}`;
      expect(maskFinancialIdentifiers(once), label).toBe(once);
      expect(bytes(once), label).toBe(bytes(input));
      for (const [a, b] of cards) {
        // A card followed by a glued character is no card (hex, a hash).
        if (/[A-Za-z0-9_]/.test(input[b] ?? "")) continue;
        expect(/\d/.test(once.slice(a, b)), `${label}: card at ${a}`).toBe(false);
      }
      for (const m of once.matchAll(/(?<![A-Za-z0-9_*])\d{13,19}(?![A-Za-z0-9_*])/g)) {
        expect(isCard(m[0]), `${label}: ${m[0]} survived the first pass`).toBe(false);
      }
    }
  });
});

describe("maskFinancialIdentifiers: v3, one pass from the original text", () => {
  // designs/FINANCIAL-IDS-V3-ONEPASS.md. The fixed reads include the original
  // text and the masks are a union; there is no convergence loop. These properties hold the
  // design to its three claims: the first pass is final, no rule finds
  // anything on its output, and a number that passes the card test never
  // survives, whatever stands beside it.
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }
  const luhnSum = (digits: string) => {
    let sum = 0;
    let double = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let d = digits.charCodeAt(i) - 48;
      if (double) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
      sum += d;
      double = !double;
    }
    return sum % 10;
  };
  /** The card test, written out again: 13 to 19 digits, first digit 2 to 6, Luhn. */
  const isCard = (digits: string) => digits.length >= 13 && digits.length <= 19 && digits[0] >= "2" && digits[0] <= "6" && luhnSum(digits) === 0;
  const CASES = Number(process.env.FINANCIAL_IDS_CASES) || 100000;

  /** A random card number: first digit 2 to 6, 13 to 19 digits, Luhn valid. */
  function card(next: () => number): string {
    const len = 13 + Math.floor(next() * 7);
    let d = String(2 + Math.floor(next() * 5));
    while (d.length < len - 1) d += String(Math.floor(next() * 10));
    let c = 0;
    while (luhnSum(d + c) !== 0) c++;
    return d + c;
  }
  /** The card typed whole, in 3 to 5 groups of 4 to 6 digits with one
   * separator, or (GrokBuild design review) in groups of any size joined by
   * one or two spaces or dashes in any mix. */
  const MIXED = [" ", "-", "  ", " -", "- ", "--", ".", "\t", "/", ". ", " /"];
  function grouped(digits: string, next: () => number): string {
    const r0 = next();
    if (r0 < 0.25) return digits;
    if (r0 < 0.55) {
      let out = "";
      let at = 0;
      while (at < digits.length) {
        const n = 1 + Math.floor(next() * 8);
        if (at > 0) out += MIXED[Math.floor(next() * MIXED.length)];
        out += digits.slice(at, at + n);
        at += n;
      }
      return out;
    }
    const sep = next() < 0.6 ? " " : "-";
    for (let tries = 0; tries < 8; tries++) {
      const k = 3 + Math.floor(next() * 3);
      const sizes: number[] = [];
      let left = digits.length;
      for (let g = 0; g < k; g++) {
        const rest = k - g - 1;
        const lo = Math.max(4, left - 6 * rest);
        const hi = Math.min(6, left - 4 * rest);
        if (lo > hi) break;
        const size = g === k - 1 ? left : lo + Math.floor(next() * (hi - lo + 1));
        sizes.push(size);
        left -= size;
      }
      if (sizes.length === k && left === 0 && sizes.every((n) => n >= 4 && n <= 6)) {
        const parts: string[] = [];
        let at = 0;
        for (const n of sizes) { parts.push(digits.slice(at, at + n)); at += n; }
        return parts.join(sep);
      }
    }
    return digits;
  }

  // Words of every rule, guard words the old code had, ids, IBANs, kept-prefix
  // shapes and typed stars, joined by the separators people type.
  const WORDS = [
    "call", "phone", "tel:", "fax", "mobile", "+", "#", "+1", "(", "ref", "card", "Visa", "account", "acct:", "a/c no.", "sort code",
    "bsb", "routing", "ABA", "transit", "ending", "ending in", "last four", "card ending", "SSN", "ITIN", "TIN", "taxpayer id", "EIN", "VAT",
    "tax id", "BN", "Steuer-ID", "org.nr", "org.", "acct*", "account 12*", "PAN", "NINO", "NI number", "SIN", "passport no.", "ID number", "IBAN", "the", "and", "is", "été",
  ];
  const IBANS = ["nrDE89 3704 0044 0532 0130 00", "XDE89370400440532013000", "DE89 3704 0044 0532 0130 00", "DE89370400440532013000", "GB29 NWBK 6016 1331 9268 19", "GB13 WEST 1234 5698 7654 DE", "FR14 2004 1010 0505 0001 3M02 606", "MU17 BOMM 0101 1010 3030 0200 000M UR", "MU17 BOMM 0101 1010 3030 0200 000M U R*"];
  const IDS = ["12-3456789", "123-45-6789", "912-70-1234", "DE123456789", "X1234567", "AB123456C", "BN12345678", "AB 12 34 56 C", "021000021", "40-47-84", "4471", "123456789012345678901", "40. 47/-84", "062--000", "021.000.021", "123\t/45--6789"];
  const SEPS = [" ", " ", "  ", "\t", "-", "/", " / ", ", ", ": ", "*", "_", ".", ". ", "/-", "--", "\n", ""];
  const pick = <T,>(next: () => number, list: readonly T[]) => list[Math.floor(next() * list.length)];

  function text(next: () => number): { input: string; cards: [number, number][] } {
    let input = "";
    const cards: [number, number][] = [];
    const parts = 1 + Math.floor(next() * 7);
    for (let k = 0; k < parts; k++) {
      const r = next();
      let part: string;
      if (r < 0.3) part = pick(next, WORDS);
      else if (r < 0.55) {
        part = grouped(card(next), next);
        cards.push([input.length, input.length + part.length]);
      } else if (r < 0.65) part = pick(next, IBANS);
      else if (r < 0.85) part = pick(next, IDS);
      else {
        const len = 1 + Math.floor(next() * 20);
        part = "";
        for (let i = 0; i < len; i++) part += String(Math.floor(next() * 10));
      }
      input += part;
      if (k < parts - 1) input += pick(next, SEPS);
    }
    return { input, cards };
  }
  const UNGLUED_RUN = /(?<![A-Za-z0-9_])\d{13,19}(?![A-Za-z0-9_])/g;
  const glued = (ch: string | undefined) => ch !== undefined && /[A-Za-z0-9_]/.test(ch);

  it("P5: mask(mask(x)) === mask(x), and no single rule finds anything on mask(x)", () => {
    const ruleOffsets = financialIds.financialRuleOffsets;
    expect(typeof ruleOffsets).toBe("function");
    const next = rng(20261027);
    for (let n = 0; n < CASES; n++) {
      const { input } = text(next);
      const once = maskFinancialIdentifiers(input);
      const label = `case ${n}: ${JSON.stringify(input)} -> ${JSON.stringify(once)}`;
      expect(maskFinancialIdentifiers(once), label).toBe(once);
      expect(bytes(once), label).toBe(bytes(input));
      const left = ruleOffsets(once);
      for (const [rule, offsets] of Object.entries(left)) expect(offsets, `${label}: rule ${rule} on the output`).toEqual([]);
    }
  });

  it("P6: no number that passes the card test survives, in any grouping beside any word, id, IBAN, `+`, `#` or `*`", () => {
    const next = rng(20261028);
    let checked = 0;
    for (let n = 0; n < CASES; n++) {
      const { input, cards } = text(next);
      const once = maskFinancialIdentifiers(input);
      const label = `case ${n}: ${JSON.stringify(input)} -> ${JSON.stringify(once)}`;
      for (const [a, b] of cards) {
        // Glued to a letter, digit or `_` on either side, it is part of
        // something else (hex, a hash, a longer number) and is no card.
        if (glued(input[a - 1]) || glued(input[b])) continue;
        checked++;
        expect(/\d/.test(once.slice(a, b)), `${label}: card at ${a}`).toBe(false);
      }
      for (const m of once.matchAll(UNGLUED_RUN)) expect(isCard(m[0]), `${label}: ${m[0]} survived`).toBe(false);
    }
    expect(checked).toBeGreaterThan(CASES / 4);
  });

  it("the GrokBuild r1 to r3 and design-review findings, each as a fixed case", () => {
    const cases: [string, string][] = [
      // r1 High: a masked card is never read as digits of the id beside it.
      ["EIN 4111 1111 1111 1111 12-3456789", "EIN **** **** **** **** **-*******"],
      ["EIN 12-3456789 4111 1111 1111 1111", "EIN **-******* **** **** **** ****"],
      // r1 Medium, r3 High: a phone word, `+` or `#` never keeps a card.
      ["call 4111111111111111", "call ****************"],
      ["+4111111111111111", "+****************"],
      ["call 4111 1111 1111 1111", "call **** **** **** ****"],
      ["card #4111 1111 1111 1111", "card #**** **** **** ****"],
      ["tel: +1 4111-1111-1111-1111", "tel: +1 ****-****-****-****"],
      // r1 Medium, r2 High: every ABA in the window after the routing word.
      ["routing 021000021 011000015-4811832", "routing ********* *********-4811832"],
      ["routing 4111111111111111 021000021", "routing **************** *********"],
      // r2 High: an id chain past 20 characters masks both parts.
      ["EIN 12-3456789 123456789012", "EIN **-******* ************"],
      // r3 Medium and the pre-existing `ref*`: a typed `*` is a separator.
      ["VAT 12*4111111111111111", "VAT 12*****************"],
      ["ref*4111111111111111", "ref*****************"],
      // Design review (financial-ids-v3-design): any grouping, a glued tail
      // beside an account run, a context word before a typed `*`, a date
      // after "sort code".
      ["4111 1111-1111 1111", "**** ****-**** ****"],
      ["4222 2222 2222 2", "**** **** **** *"],
      ["41111111 11111111", "******** ********"],
      ["4111  1111  1111  1111", "****  ****  ****  ****"],
      ["acct 123456 4111111111111111 1_", "acct ****** **************** 1_"],
      ["SSN* 123-45-6789", "SSN* ***-**-****"],
      ["routing* 021000021", "routing* *********"],
      ["sort code 2026-10-24", "sort code 2026-10-24"],
      // Design review r2: dots, tabs and double spaces between groups, a
      // sort code after a card, a short tax word before a typed `*`.
      ["4111.1111.1111.1111", "****.****.****.****"],
      ["4111\t1111\t1111\t1111", "****\t****\t****\t****"],
      ["DE89  3704  0044  0532  0130  00", "DE**  ****  ****  ****  ****  **"],
      ["sort code 4111111111111111 40-47-84", "sort code **************** **-**-**"],
      ["bsb 12 062-000", "bsb 12 ***-***"],
      ["BN* 809123456", "BN* *********"],
      // Lane review v3 r1: an IBAN behind a short tail, a typed `*` after an
      // account word, an account number not right after the word.
      ["org.nrDE89370400440532013000", "org.************************"],
      ["acct*4090983240 301831084", "acct*********** *********"],
      ["sort code*40-47-84", "sort code***-**-**"],
      ["account 12*345678901234", "account 12*************"],
      // Lane review v3 r2 follow-ups: an IBAN ending in letters before `*` or
      // digits, dots and double separators in codes, routing and SSN, and an
      // account number of more than 20 digits in the account window.
      ["MU17 BOMM 0101 1010 3030 0200 000M UR*", "MU** **** **** **** **** **** **** ***"],
      ["MU17 BOMM 0101 1010 3030 0200 000M UR4111111111111111", "MU** **** **** **** **** **** **** ******************"],
      ["sort code 40.47.84", "sort code **.**.**"],
      ["sort code 40  47  84", "sort code **  **  **"],
      ["bsb 062  000", "bsb ***  ***"],
      ["routing 021.000.021", "routing ***.***.***"],
      ["SSN 123.45.6789", "SSN ***.**.****"],
      ["account 12*123456789012345678901", "account 12**********************"],
    ];
    for (const [input, expected] of cases) {
      const once = maskFinancialIdentifiers(input);
      expect(once, input).toBe(expected);
      expect(maskFinancialIdentifiers(once), input).toBe(once);
    }
    // r2 High: the rule version moved, so stored rows are scrubbed again.
    expect(FINANCIAL_RULE_VERSION).toBe(4);
  });
});
