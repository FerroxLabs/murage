// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// AT-S1 / AT-05: the integer-only JCS profile and body_digest recompute every Flux FINAL vector byte for byte, and
// refuse what the profile refuses. A digest that differed from Flux by one byte would make every idempotent replay a
// conflict and every delivery digest a mismatch, so a connected-app event could never be acknowledged.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bodyDigest, canonicalize, JcsError, parseStrictJson, parseStrictJsonBytes } from "./app-trigger-canonical.mjs";

const root = new URL("../test/fixtures/flux-app-events-v1/", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root));
const json = <T,>(path: string) => JSON.parse(read(path).toString("utf8")) as T;

interface JcsCase { name: string; input_json: string; expect: string; layer: "parsed-value" | "number-token"; canonical?: string; digest?: string }
const cases = json<JcsCase[]>("jcs/cases.json");

const codeOf = (work: () => unknown): string => {
  try { work(); return "ok"; }
  catch (error) { if (error instanceof JcsError) return error.code; throw error; }
};

describe("Flux jcs/cases.json (FINAL)", () => {
  it("is the copied fixture set and covers every layer", () => {
    expect(cases.length).toBeGreaterThanOrEqual(23);
    expect(new Set(cases.map(c => c.layer))).toEqual(new Set(["parsed-value", "number-token"]));
  });
  for (const c of cases) {
    it(`${c.name}: ${c.expect}`, () => {
      if (c.expect === "ok") {
        const parsed = JSON.parse(c.input_json);
        expect(canonicalize(parsed)).toBe(c.canonical);
        expect(bodyDigest(parsed)).toBe(c.digest);
        // the strict reader reaches the same bytes
        expect(canonicalize(parseStrictJson(c.input_json))).toBe(c.canonical);
        return;
      }
      // the strict reader refuses with the expected code at either layer
      expect(codeOf(() => canonicalize(parseStrictJson(c.input_json)))).toBe(c.expect);
      // a value that got past JSON.parse is refused by the canonicalizer itself
      if (c.layer === "parsed-value") expect(codeOf(() => canonicalize(JSON.parse(c.input_json)))).toBe(c.expect);
    });
  }
});

describe("Flux jcs input/output vectors (cyberphone, FINAL)", () => {
  const source = json<{ files: Record<string, { input_sha256: string; output_sha256: string }> }>("jcs/SOURCE.json");
  for (const [name, hashes] of Object.entries(source.files)) {
    it(`${name}: canonical output is byte-identical`, () => {
      const input = read(`jcs/input/${name}.json`), output = read(`jcs/output/${name}.json`);
      expect(createHash("sha256").update(input).digest("hex")).toBe(hashes.input_sha256);
      expect(createHash("sha256").update(output).digest("hex")).toBe(hashes.output_sha256);
      // SOURCE.json: an integral float literal (56.0) is read as the integer JSON.parse yields
      expect(Buffer.from(canonicalize(JSON.parse(input.toString("utf8"))), "utf8").equals(output)).toBe(true);
    });
  }
});

describe("Flux idempotency/cases.json digests (FINAL)", () => {
  const file = json<{ cases: Array<{ name: string; request: { body: unknown; bodyDigest: string; bodyText?: string }; priorReceipts?: Array<{ body: unknown; bodyDigest: string }> }> }>("idempotency/cases.json");
  it("has its cases", () => expect(file.cases.length).toBe(20));
  for (const c of file.cases) {
    it(`${c.name}: every body digest recomputes`, () => {
      expect(bodyDigest(c.request.body)).toBe(c.request.bodyDigest);
      for (const prior of c.priorReceipts ?? []) expect(bodyDigest(prior.body)).toBe(prior.bodyDigest);
      // reordered members and whitespace digest the same (the strict reader reads the raw text)
      if (c.request.bodyText !== undefined) expect(bodyDigest(parseStrictJson(c.request.bodyText))).toBe(c.request.bodyDigest);
    });
  }
  it("same key, different body: the digests differ, so the replay is a conflict", () => {
    const conflict = file.cases.find(c => c.name === "conflict-same-key-different-body")!;
    expect(conflict.request.bodyDigest).not.toBe(conflict.priorReceipts![0]!.bodyDigest);
  });
});

describe("refusals outside the integer-only profile", () => {
  it("fractions and exponents refuse, even when integral", () => {
    for (const text of ["1.5", "1.0", "1e2", "-0.0", "{\"a\":2E3}"]) expect(codeOf(() => parseStrictJson(text))).toBe("float");
    expect(codeOf(() => canonicalize(0.5))).toBe("float");
    expect(codeOf(() => canonicalize(Number.NaN))).toBe("float");
    expect(codeOf(() => canonicalize(Number.POSITIVE_INFINITY))).toBe("float");
  });
  it("duplicate members refuse (JSON.parse would keep the last one silently)", () => {
    expect(codeOf(() => parseStrictJson("{\"a\":1,\"a\":2}"))).toBe("duplicate_member");
    expect(codeOf(() => parseStrictJson("{\"x\":{\"b\":1,\"b\":1}}"))).toBe("duplicate_member");
  });
  it("lone surrogates refuse in values and in names", () => {
    expect(codeOf(() => parseStrictJson("\"\\ud800x\""))).toBe("lone_surrogate");
    expect(codeOf(() => canonicalize({ ["\udc00"]: 1 }))).toBe("lone_surrogate");
    expect(codeOf(() => canonicalize(["ok", "\ud83d"]))).toBe("lone_surrogate");
  });
  it("precision loss refuses: a digit string past 2^53 never reads as a nearby safe number", () => {
    expect(codeOf(() => parseStrictJson("9007199254740993"))).toBe("int_range");
    expect(codeOf(() => parseStrictJson("-9007199254740993"))).toBe("int_range");
    expect(codeOf(() => canonicalize(JSON.parse("9007199254740993")))).toBe("int_range");
    expect(codeOf(() => parseStrictJson("12345678901234567890123"))).toBe("int_range");
  });
  it("a byte order mark and malformed UTF-8 refuse", () => {
    expect(codeOf(() => parseStrictJson("\ufeff{}"))).toBe("invalid_json");
    expect(codeOf(() => parseStrictJsonBytes(Uint8Array.from([0x22, 0xc3, 0x28, 0x22])))).toBe("invalid_utf8");
    expect(parseStrictJsonBytes(Buffer.from("{\"k\":\"é\"}", "utf8"))).toEqual({ k: "é" });
  });
  it("only plain data canonicalizes", () => {
    expect(codeOf(() => canonicalize({ a: undefined }))).toBe("invalid_value");
    expect(codeOf(() => canonicalize(new Date(0)))).toBe("invalid_value");
    expect(codeOf(() => canonicalize(10n))).toBe("invalid_value");
    // eslint-disable-next-line no-sparse-arrays
    expect(codeOf(() => canonicalize([1, , 2]))).toBe("invalid_value");
  });
  it("a __proto__ member is an ordinary member, not a prototype", () => {
    const value = parseStrictJson("{\"__proto__\":{\"polluted\":1},\"a\":1}") as Record<string, unknown>;
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(canonicalize(value)).toBe("{\"__proto__\":{\"polluted\":1},\"a\":1}");
  });
  it("digests are 43 unpadded base64url characters", () => {
    expect(bodyDigest({ version: 1 })).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
