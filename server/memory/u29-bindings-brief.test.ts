// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.4 U29: a bot deletion revokes its scopes' bindings through an index by scope (registered optional index, dropped by the downgrade),
// and the owner's continuity brief is read on its own lineage budget, with a log line when it is left out. (The room pre-submit check
// honouring a Stop is provider-route-submission-join.test.ts.)
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { setObserveSink, resetObserveWindows } from "../observe.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { memoryAccess, reconcileMemoryRoster } from "./policy.ts";
import { writeBotIdentity, type IdentityWrite } from "./identity.ts";
import { briefBudget, buildMemoryBundle } from "./bundle.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { OPTIONAL_INDEXES, buildOptionalIndexOffThread, optionalIndexReady } from "./optional-index.ts";
import { BINDINGS_SCOPE, BINDINGS_SCOPE_INDEX, downgradeMemorySchema, migrateMemorySchema, validateMemorySchema } from "./schema.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const roster = { bots: [{ id: "moss", threadId: "private" }], groups: [] };
const ticket = ownerMemoryTicket();
const emptyBridge = { search: async () => ({ hits: [], vectorRows: 0 }) };
const brief = (text = "Moss keeps the harbour log."): IdentityWrite =>
  ({ action: "identity-write", botId: "moss", kind: "continuity-brief", key: "core", expectedVersion: 0, text, basis: "fiction", audience: "owner-private" });
function access() {
  const registry = new InternalCapabilities(), generation = registry.begin("moss", "private");
  const token = registry.mint({ botId: "moss", threadId: "private", generation, depth: 0, kind: "memory", skillAuthoring: false });
  return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
}
const lines: string[] = [];
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); reconcileMemoryRoster(roster); lines.length = 0; resetObserveWindows(); setObserveSink(line => { lines.push(line); }); });
afterEach(() => { setObserveSink(undefined); });

describe("U29: bindings by scope", () => {
  it("is a registered optional index the deletion's revoke reads through, and the downgrade drops it", async () => {
    expect(OPTIONAL_INDEXES.some(index => index.name === BINDINGS_SCOPE_INDEX && index.table === "memory_scope_bindings")).toBe(true);
    const db = new DatabaseSync(join(DATA_DIR, "u29.db"));
    try {
      db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON");
      migrateMemorySchema(db, "active");
      const revoke = "EXPLAIN QUERY PLAN UPDATE memory_scope_bindings SET state='revoked' WHERE scope_id IN (SELECT value FROM json_each(?)) AND NOT (subject_type='system' AND subject_id=?)";
      expect(JSON.stringify(db.prepare(revoke).all("[\"s\"]", "x"))).not.toContain(BINDINGS_SCOPE_INDEX);
      expect(await buildOptionalIndexOffThread(db, BINDINGS_SCOPE, { inline: true })).toBe(true);
      expect(optionalIndexReady(db, BINDINGS_SCOPE_INDEX)).toBe(true);
      expect(JSON.stringify(db.prepare(revoke).all("[\"s\"]", "x"))).toContain(`USING INDEX ${BINDINGS_SCOPE_INDEX}`);
      expect(() => validateMemorySchema(db, { structuralOnly: true })).not.toThrow();
      downgradeMemorySchema(db, 1);
      expect(optionalIndexReady(db, BINDINGS_SCOPE_INDEX)).toBe(false);
    } finally { db.close(); }
  });
});

describe("U29: the owner's continuity brief", () => {
  it("is read on its own budget: a turn allowance spent before it does not leave it out", async () => {
    writeBotIdentity(ticket, brief(), roster);
    expect((await buildMemoryBundle("harbour", access(), emptyBridge, { allowance: LineageAllowance.tool() })).text).toContain("Moss keeps the harbour log.");
    const spent = LineageAllowance.tool(); spent.close();
    expect((await buildMemoryBundle("harbour", access(), emptyBridge, { allowance: spent })).text).toContain("Moss keeps the harbour log.");
    expect(briefBudget()).not.toBe(briefBudget());
  });

  it("left out, says so in the log (cause and stage), once per window", async () => {
    writeBotIdentity(ticket, brief(), roster);
    const id = String(database().prepare("SELECT id FROM memory_records WHERE kind='continuity-brief'").get()!.id);
    database().prepare("INSERT INTO memory_tombstones(id,target_type,target_id,revision,content_hash,epoch,reason,created_at) VALUES('t-brief','record',?,NULL,NULL,0,'test',0)").run(id);
    const spentBrief = LineageAllowance.tool(); spentBrief.close();
    for (let n = 0; n < 2; n++) expect((await buildMemoryBundle("harbour", access(), emptyBridge, { allowance: LineageAllowance.tool(), briefAllowance: spentBrief })).text).not.toContain("harbour log");
    const logged = lines.filter(line => line.startsWith("[memory] continuity brief left out bot=moss stage=read"));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/cause=(limit|MEMORY_RECORD_UNAVAILABLE)/);
  });
});
