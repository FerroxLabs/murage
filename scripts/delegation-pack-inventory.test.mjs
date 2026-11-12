// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { collectInventory, checkInventory, inventorySources } from "./delegation-pack-inventory.mjs";

describe("delegation pack inventory CI check", () => {
  it("matches generated surfaces and rejects one stale entry; kills unchecked inventory", () => {
    const sources = inventorySources();
    const generated = collectInventory(sources);
    const saved = JSON.parse(readFileSync(new URL("../server/delegation-pack.inventory.json", import.meta.url), "utf8"));
    expect(generated.map(row => row.kind).sort()).toEqual(["chip", "line", "owner-route", "prompt-part", "sheet"]);
    expect(() => checkInventory(generated, saved)).not.toThrow();
    expect(() => checkInventory(generated, saved.slice(1))).toThrow(/inventory/);
  });

  it("detects an undeclared component; kills fixed list of known surfaces", () => {
    const sources = inventorySources();
    expect(() => collectInventory(sources)).not.toThrow();
    const file = "src/components/DelegationPack.tsx";
    const changed = new Map(sources);
    changed.set(file, `${changed.get(file)}\nexport function DelegationPackExtra() { return null; }\n`);
    expect(() => collectInventory(changed)).toThrow(/DelegationPackExtra/);
  });

  it("runs in the blocking CI quality job; kills unwired check", () => {
    const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    expect(ci.slice(ci.indexOf("  quality:"), ci.indexOf("  vitest:"))).toContain("node scripts/delegation-pack-inventory.mjs --check");
    const gate = readFileSync(new URL("../ci/gate-tests.txt", import.meta.url), "utf8");
    for (const file of ["scripts/delegation-pack-inventory.test.mjs", "server/delegation-pack-routes.test.ts", "src/components/DelegationPack.test.ts", "src/components/DelegationPack.dom.test.ts"]) {
      expect(gate).toContain(`${file}\tall\t`);
    }
  });
});
