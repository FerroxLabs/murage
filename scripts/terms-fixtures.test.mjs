// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Every script or spec that launches a fresh profile with a UI must either
// accept the terms through the screen (exactly one packaged smoke) or seed the
// acceptance, else it stalls behind the terms gate waiting for a control.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { termsVersion } from "./terms-fixture.mjs";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

describe("fresh-profile UI fixtures get past the terms gate", () => {
  it("smoke-mvp-mac accepts through the UI and proves the gate", () => {
    const text = read("scripts/smoke-mvp-mac.mjs");
    expect(text).toContain("[data-terms-checkbox]");
    expect(text).toContain("[data-terms-accept]");
    expect(text).toContain("termsGateAccepted");
    // the one that proves the gate must not also seed it
    expect(text).not.toContain("seedTermsAccepted");
  });
  it("smoke-memory-desktop seeds the acceptance", () => {
    const text = read("scripts/smoke-memory-desktop.mjs");
    expect(text).toContain("seedTermsAccepted(data)");
    expect(text.indexOf("seedTermsAccepted(data)")).toBeLessThan(text.indexOf("_electron.launch"));
  });
  it.each([
    "src/e2e/user-smoke-0152-r2.human.spec.ts", "src/e2e/image-settings-capability.human.spec.ts",
    "src/e2e/composer-size-limit.human.spec.ts", "src/e2e/memory-provenance-fuigo.human.spec.ts",
  ])("%s declares the current terms accepted", (file) => {
    expect(read(file)).toContain("MURAGE_TERMS_ACCEPTED: TERMS_VERSION");
  });
  it("the helper reads the live version", () => {
    expect(termsVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
