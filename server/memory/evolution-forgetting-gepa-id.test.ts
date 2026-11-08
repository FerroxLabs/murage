import { mkdirSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { ensureScope, reconcileMemoryRoster } from "./policy.ts";
import { purgeEvolutionBinding } from "./evolution-forgetting.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

// A job row's id is the key its receipts carry as subject_id. Real GEPA jobs are `gepa-job:<hash>`
// (gepa-ledger.ts); any other id on a gepa-job row must never select another subject's rows.
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); reconcileMemoryRoster({ bots: [{ id: "bot", threadId: "thread" }], groups: [] }); });

const revokedJob = (extra: Record<string, unknown> = {}) => JSON.stringify({ evidence: "damaged", revoked: true, ...extra });
const insert = (id: string, scopeId: string, subject: string, intent: string) =>
  database().prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system',?,1,'granted',?)").run(id, scopeId, subject, intent);
const read = (id: string) => database().prepare("SELECT id,subject_id,state,intent FROM memory_scope_bindings WHERE id=?").get(id)!;

describe("evolution-forgetting gepa-job receipt scrub", () => {
  it("a crafted job row whose id names another subject revokes none of that subject's rows", () => {
    const scopeId = ensureScope("bot", "bot");
    const stance = JSON.stringify({ stance: "keep", value: "private stance words" });
    insert("stance:1", scopeId, "pip-stance", stance);
    insert("stance:2", scopeId, "pip-stance", stance);
    insert("pip-stance", scopeId, "gepa-job", revokedJob());
    purgeEvolutionBinding(database(), read("pip-stance"));
    for (const id of ["stance:1", "stance:2"]) expect(read(id)).toMatchObject({ subject_id: "pip-stance", state: "granted", intent: stance });
    // the damaged job row itself is still revoked
    expect(read("pip-stance")).toMatchObject({ state: "revoked" });
  });

  it("a real gepa job still revokes its own receipts and strips their copied text, and nothing else", () => {
    const scopeId = ensureScope("bot", "bot"), jobKey = "gepa-job:" + "c".repeat(16);
    const receipt = JSON.stringify({ callId: "j:reflect:1", state: "complete", value: "private clause", inputHash: "d".repeat(64) });
    const stance = JSON.stringify({ stance: "keep", value: "private stance words" });
    insert(jobKey, scopeId, "gepa-job", revokedJob());
    insert("gepa-call:1", scopeId, jobKey, receipt);
    insert("gepa-call:2", scopeId, jobKey, receipt);
    insert("stance:1", scopeId, "pip-stance", stance);
    purgeEvolutionBinding(database(), read(jobKey));
    for (const id of ["gepa-call:1", "gepa-call:2"]) {
      const row = read(id);
      expect(row.state).toBe("revoked");
      expect(String(row.intent)).not.toContain("private clause");
      expect(JSON.parse(String(row.intent))).toMatchObject({ callId: "j:reflect:1", state: "revoked" });
    }
    expect(read(jobKey)).toMatchObject({ state: "revoked" });
    expect(read("stance:1")).toMatchObject({ state: "granted", intent: stance });
  });

  // Each half of the fix is also enough on its own to keep the crafted id harmless, so a behaviour test
  // cannot tell them apart; these pins fail when either half is dropped.
  it("pins both halves of the guard in the source", () => {
    const source = readFileSync(new URL("./evolution-forgetting.ts", import.meta.url), "utf8");
    expect(source).toMatch(/startsWith\("gepa-job:"\)/);
    expect(source).toMatch(/subject_id LIKE 'gepa-job:%'/);
  });
});
