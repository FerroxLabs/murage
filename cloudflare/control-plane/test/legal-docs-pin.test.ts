// SPDX-License-Identifier: AGPL-3.0-or-later
// Pins the generated legal texts to what murage.ai publishes (murage-site 03478d48, release/1018-post). Regenerating legal-docs.generated.ts
// without meaning to change a text, or hand-editing it, fails here. When the site really changes: regenerate, update the pins below, and
// follow the rules in refund-identity.ts and home-terms-map.ts (append ids, never drop old ones).
import { describe, expect, it } from "vitest";
import { LEGAL_DOCS } from "../src/legal-docs.generated";
import { HOME_TERMS_MAP, coversHome, knownHomeAcceptance } from "../src/home-terms-map";
import { REFUND_LIMIT_V2_CLOUD_TERMS_IDS } from "../src/refund-identity";

const PINS = {
  cloudTerms: { versionId: "cloud-terms-d5a2fc1a2a13", sha256: "d5a2fc1a2a13911e3dabb443144e3f0f91c44be872c5401e55ff32d189bd4845", line: "Effective October 18, 2026 · Last updated October 18, 2026" },
  termsOfService: { versionId: "terms-of-service-949a14d6cb42", sha256: "949a14d6cb429182e2f615c75331af6736c35cd72b943d736579f3460ead7a0b", line: "Effective October 18, 2026 · Last updated October 18, 2026" },
  privacyPolicy: { versionId: "privacy-policy-7411767ea8a3", sha256: "7411767ea8a3622efd2fd89ef3925fa942ff503ef26d4af64ea57cb6a4c34b0d", line: "Effective October 18, 2026 · Last updated October 26, 2026" },
} as const;

const sha256Hex = async (s: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");

describe("LEGAL_DOCS equals the live site texts", () => {
  for (const key of ["cloudTerms", "termsOfService", "privacyPolicy"] as const) {
    it(`${key}: version id, sha256, date line, and sha256 is the hash of the text`, async () => {
      const d = LEGAL_DOCS[key];
      const pin = PINS[key];
      expect(d.versionId).toBe(pin.versionId);
      expect(d.sha256).toBe(pin.sha256);
      expect(d.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(d.versionId.endsWith(d.sha256.slice(0, 12))).toBe(true);
      expect(await sha256Hex(d.text)).toBe(d.sha256);
      expect(d.text.split("\n")).toContain(pin.line);
    });
  }

  it("the Cloud terms carry the one-per-person text and the Privacy Policy reads Last updated October 26, 2026", () => {
    expect(LEGAL_DOCS.cloudTerms.text).toContain("once per person or payment method");
    expect(LEGAL_DOCS.privacyPolicy.text).toContain("Last updated October 26, 2026");
  });
});

describe("earlier texts stay resolvable for past buyers", () => {
  it("the earlier ToS and Privacy ids still cover home version 2026-10-10, and so do the new ones", () => {
    expect(coversHome("2026-10-10", "terms-of-service-f2a10ce6b0ef", "privacy-policy-2f6c539d1989")).toBe(true);
    expect(knownHomeAcceptance("terms-of-service-f2a10ce6b0ef", "privacy-policy-2f6c539d1989")).toBe(true);
    expect(coversHome("2026-10-10", PINS.termsOfService.versionId, PINS.privacyPolicy.versionId)).toBe(true);
    expect(HOME_TERMS_MAP.length).toBeGreaterThanOrEqual(2);
  });
  it("the earlier Cloud terms id still binds the one-per-person limit", () => {
    expect(REFUND_LIMIT_V2_CLOUD_TERMS_IDS).toContain("cloud-terms-964155e36e8b");
    expect(REFUND_LIMIT_V2_CLOUD_TERMS_IDS).toContain(PINS.cloudTerms.versionId);
  });
});
