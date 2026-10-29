// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// FUIGO-SCOPE-1010 section 5, House rule 7: every built-in engine declares how its reads reach the key guard.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { BUILT_IN_DRIVERS } from "./builtIn.ts";
import { READ_GUARD_INVENTORY } from "./read-guard-inventory.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));

describe("the read-guard inventory", () => {
  it("has exactly one row per built-in driver, each naming code that exists", () => {
    const kinds = BUILT_IN_DRIVERS.map((driver) => driver.driverKind).sort();
    expect(Object.keys(READ_GUARD_INVENTORY).sort()).toEqual([...new Set(kinds)].sort());
    for (const [kind, row] of Object.entries(READ_GUARD_INVENTORY)) {
      expect(row.route.trim(), kind).not.toBe("");
      const file = row.where.split(/[ ,]/)[0]!;
      expect(existsSync(`${repo}${file}`), `${kind}: ${file}`).toBe(true);
    }
  });

  it("Hermes reads are a visible, named gap until their own lane lands; never marked fixed", () => {
    const hermes = READ_GUARD_INVENTORY.hermesAgent;
    expect(hermes.route).toContain("reads (read_file, search_files) reach no guard: HERMES-READS-1010");
    expect(hermes.p7.nativeRead).toBe("fail:HERMES-READS-1010");
  });

  it("Fuigo and Grok reads reach the guard by both routes", () => {
    for (const kind of ["fuigoAgent", "grokAgent"] as const) expect(READ_GUARD_INVENTORY[kind].p7).toEqual({ shell: "pass", nativeRead: "pass" });
  });
});
