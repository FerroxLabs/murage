// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Sentinel fingerprints (GAP-SENTINEL-109 section 6.1): SHA-256 over a versioned fixed tuple. No text, timestamps,
// paths, record ids or thread names enter it, and the same tuple always gives the same fingerprint.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FINGERPRINT_VERSION, fingerprint, type FingerprintTuple } from "./types.ts";

const tuple: FingerprintTuple = {
  installationId: "0123456789abcdef0123456789abcdef", detectorId: "extraction", subsystem: "memory", engineKind: "claude", sourceKey: "fedcba9876543210", errorClass: "not-json",
};

describe("fingerprint", () => {
  it("is lowercase SHA-256 hex over the documented versioned tuple", () => {
    const expected = createHash("sha256").update(JSON.stringify(["murage-sentinel-fingerprint", 1, tuple.installationId, "extraction", "memory", "claude", "fedcba9876543210", "not-json"])).digest("hex");
    expect(FINGERPRINT_VERSION).toBe(1);
    expect(fingerprint(tuple)).toBe(expected);
    expect(fingerprint(tuple)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across calls and object copies", () => {
    const first = fingerprint(tuple);
    for (let i = 0; i < 5; i++) expect(fingerprint({ ...tuple })).toBe(first);
    // key order does not matter
    const reordered = { errorClass: "not-json", sourceKey: tuple.sourceKey, engineKind: tuple.engineKind, subsystem: tuple.subsystem, detectorId: tuple.detectorId, installationId: tuple.installationId } as FingerprintTuple;
    expect(fingerprint(reordered)).toBe(first);
  });

  it("no text, timestamp, path or thread name enters it", () => {
    const first = fingerprint(tuple);
    const noisy = { ...tuple, at: Date.now(), firstSeenAt: 1, message: "the owner's words", path: "/Users/sam/Murage", threadName: "Sales", recordId: 42, title: "Learning stalled" };
    expect(fingerprint(noisy as FingerprintTuple)).toBe(first);
  });

  it("every tuple field changes it, and null differs from a value", () => {
    const first = fingerprint(tuple);
    const variants: FingerprintTuple[] = [
      { ...tuple, installationId: "1123456789abcdef0123456789abcdef" },
      { ...tuple, detectorId: "backup" },
      { ...tuple, subsystem: "storage" },
      { ...tuple, engineKind: "codex" },
      { ...tuple, engineKind: null },
      { ...tuple, sourceKey: null },
      { ...tuple, errorClass: "schema" },
    ];
    const seen = new Set([first]);
    for (const variant of variants) seen.add(fingerprint(variant));
    expect(seen.size).toBe(variants.length + 1);
  });

  it("field boundaries cannot be shifted to forge a collision", () => {
    const a = fingerprint({ ...tuple, sourceKey: "ab", errorClass: "c" });
    const b = fingerprint({ ...tuple, sourceKey: "a", errorClass: "bc" });
    expect(a).not.toBe(b);
  });
});
