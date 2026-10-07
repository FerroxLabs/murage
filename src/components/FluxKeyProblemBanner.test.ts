// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A Flux key that Flux refuses, or a value that is not a Flux key at all,
// used to fail in silence: the app kept asking Flux every minute and the
// owner saw nothing. The owner is now told, in plain words, with a way to
// fix it.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { fluxKeyProblemNotice } from "./FluxKeyProblemBanner";

describe("what the owner is told about the Flux key", () => {
  it("says nothing when the key is fine or simply not there", () => {
    expect(fluxKeyProblemNotice(undefined)).toBeNull();
    expect(fluxKeyProblemNotice({ configured: true, keyState: "ok" })).toBeNull();
    expect(fluxKeyProblemNotice({ configured: false, keyState: "missing" })).toBeNull();
  });

  it("says Flux refused the key", () => {
    expect(fluxKeyProblemNotice({ configured: true, keyState: "refused" })).toBe("Flux Router refused your key. Paste a current key from your Flux Router account.");
  });

  it("says a saved value is not a Flux key", () => {
    expect(fluxKeyProblemNotice({ configured: false, keyState: "not-flux" })).toMatch(/not a Flux Router key/);
  });

  it("never claims Murage stopped using a refused key", () => {
    expect(fluxKeyProblemNotice({ configured: true, keyState: "refused" })).not.toMatch(/stopped using|not using/i);
  });

  it("keeps its strings in the catalogue, translated in every pack with a source hash", () => {
    const dir = fileURLToPath(new URL("../locales/", import.meta.url));
    const read = (file: string) => JSON.parse(readFileSync(dir + file, "utf8")) as Record<string, any>;
    const en = read("en.json"), hashes = read("source-hashes.json").locales as Record<string, Record<string, string>>;
    const keys = ["fluxKeyBanner.refused", "fluxKeyBanner.notFlux", "fluxKeyBanner.fix"];
    for (const locale of ["de", "es", "fr", "hi", "ja", "pt-br", "zh"]) {
      const pack = read(`${locale}.json`);
      for (const key of keys) {
        expect(pack[key], `${locale} ${key}`).toBeTruthy();
        expect(pack[key], `${locale} ${key} is translated`).not.toBe(en[key]);
        expect(hashes[locale]![key], `${locale} ${key} hash`).toBe(createHash("sha256").update(en[key]).digest("hex"));
        expect(pack[key]).not.toMatch(/—|Composio/);
      }
    }
    const source = readFileSync(fileURLToPath(new URL("./FluxKeyProblemBanner.tsx", import.meta.url)), "utf8");
    for (const key of keys) expect(source).toContain(`"${key}"`);
  });

  it("follows the copy rules", () => {
    const source = readFileSync(fileURLToPath(new URL("./FluxKeyProblemBanner.tsx", import.meta.url)), "utf8");
    for (const text of [fluxKeyProblemNotice({ configured: true, keyState: "refused" }), fluxKeyProblemNotice({ configured: false, keyState: "not-flux" }), source]) {
      expect(text).not.toMatch(/—|\bsafe(ly|ty)?\b|\bunsafe\b|Composio/i);
    }
    expect(readFileSync(fileURLToPath(new URL("../locales/en.json", import.meta.url)), "utf8")).toMatch(/"fluxKeyBanner.fix": "Fix the key"/);
  });
});
