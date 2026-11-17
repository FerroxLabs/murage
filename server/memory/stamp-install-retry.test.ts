// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-fix-c (stamp installation). Consumer owner: recall-fix-c (recall cache recovery).
import { afterEach, expect, it, vi } from "vitest";
import { BgDeferred } from "../bg-admission.ts";
import { DatabaseBusyError } from "../database.ts";
import { bumpAuthorityHard } from "./authority-epoch.ts";
import { provenanceTriggersInstalled, provenanceStamp } from "./provenance-stamp.ts";
import { WritetimeFixture } from "./testing/writetime-fixture.ts";

const fixtures: WritetimeFixture[] = [];
afterEach(() => {vi.restoreAllMocks();for(const f of fixtures.splice(0))f.close();});
for (const family of ["authority", "provenance"] as const) {
  for (const refusal of ["admission", "lock"] as const) {
    it(`${family} retries a temporary ${refusal} refusal and restores withdrawal invalidation`, () => {
      const f = new WritetimeFixture(); fixtures.push(f);
      const db = f.db, exec = db.exec.bind(db);
      let held = true;
      vi.spyOn(db,"exec").mockImplementation(sql => {
        if(held && sql.includes(`CREATE TEMP TABLE IF NOT EXISTS ${family}_epoch`)) {
          held = false;
          throw refusal === "admission" ? new BgDeferred(10) : new DatabaseBusyError("fixture-install",0);
        }
        return exec(sql);
      });
      const install = () => family === "authority" ? bumpAuthorityHard(db) : provenanceTriggersInstalled(db);
      const installed = () => !!db.prepare("SELECT 1 FROM sqlite_temp_schema WHERE name=?").get(family === "authority" ? "authority_meta_u" : "prov_meta_u");
      install();expect(installed()).toBe(false);
      install();expect(installed()).toBe(true);
      const stamp = () => family === "authority" ? Number(db.prepare("SELECT n FROM temp.authority_epoch").get()!.n) : provenanceStamp(db);
      const before = stamp();expect(before).toBeDefined();
      db.exec("UPDATE memory_meta SET policy_revision=policy_revision+1");
      expect(stamp()).not.toBe(before);
    });
  }
}
