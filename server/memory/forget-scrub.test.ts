// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Forget scrubs the words (r3 C3): every record a forget ends loses its text in
// the step that marks it deleted, on every live forget path (a Settings forget
// of a record or a source, a job resumed after a restart, an owner identity delete).
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, transaction } from "../database.ts";
import { appendMessage } from "../message-db.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { WORKSPACE_OWNER } from "../human-principals.ts";
import { ensureScope, memoryAccess, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { claimMemoryJob, publishMemoryWork } from "./jobs.ts";
import { captureWork } from "./chunks.ts";
import { correctMemory, ownerMemoryTicket } from "./authority.ts";
import { forgetMemory } from "./forget.ts";
import { applyForgetTombstones } from "./restore.ts";
import { runRevocationJobsNow } from "./memory-revocation.ts";
import { readableMemoryRecord } from "./readable.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { deleteBotIdentity, writeBotIdentity } from "./identity.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });

const roster = { bots: [{ id: "bot", threadId: "thread" }], groups: [] } as unknown as MemoryRoster;
const owner = ownerMemoryTicket();
const holding = (word: string) => Number(database().prepare("SELECT count(*) AS n FROM memory_records WHERE text LIKE ?").get(`%${word}%`)!.n);
/** One active owner memory, written the way an owner-authored record is (no source, no evidence). */
function ownerMemory(text: string): string {
  reconcileMemoryRoster(roster); setMemoryMode("active");
  const id = randomUUID(), scope = ensureScope("preferences", "person:" + WORKSPACE_OWNER);
  database().prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,'owner-statement','active',0,?,NULL,NULL,?)").run(id, scope, text, Date.now(), Date.now());
  return id;
}
function access() {
  const registry = new InternalCapabilities(); registry.begin("bot", "thread", "generation");
  const token = registry.mint({ botId: "bot", threadId: "thread", generation: "generation", depth: 99, kind: "memory", skillAuthoring: false });
  return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
}
const readable = (id: string, version = 1) => { try { return typeof readableMemoryRecord(id, version, access(), { allowance: LineageAllowance.tool() }) !== "string"; } catch { return false; } };

describe("Forget scrubs the words", () => {
  it("S1: a forgotten owner memory keeps no copy of its words", () => {
    const id = ownerMemory("SENTINEL-1 my locker code");
    forgetMemory(owner, { kind: "record", id }); runRevocationJobsNow(database());
    expect(database().prepare("SELECT state FROM memory_records WHERE id=?").get(id)?.state).toBe("deleted");
    expect(holding("SENTINEL-1")).toBe(0);
  });

  it("S2: every version of a corrected memory is blank after Forget", () => {
    const id = ownerMemory("SENTINEL-2 first wording");
    correctMemory(owner, id, 1, "SENTINEL-2 second wording");
    forgetMemory(owner, { kind: "record", id }); runRevocationJobsNow(database());
    expect(database().prepare("SELECT version,text,state FROM memory_records WHERE id=? ORDER BY version").all(id).map(row => ({ ...row })))
      .toEqual([{ version: 1, text: "", state: "deleted" }, { version: 2, text: "", state: "deleted" }]);
  });

  it("S3: a forget whose job is left for the runner is unreadable at once and blank once the job resumes after a restart", () => {
    const id = ownerMemory("SENTINEL-3 resumable");
    expect(readable(id)).toBe(true);
    transaction(db => {
      db.exec("UPDATE memory_meta SET deletion_epoch=deletion_epoch+1,policy_revision=policy_revision+1 WHERE id=1");
      const epoch = Number(db.prepare("SELECT deletion_epoch FROM memory_meta WHERE id=1").get()!.deletion_epoch);
      db.prepare("INSERT INTO memory_tombstones VALUES(?,'record',?,NULL,NULL,?,'owner-forget',?)").run(randomUUID(), id, epoch, Date.now());
      applyForgetTombstones(db, { sources: [], records: [{ id, revision: null }] }, { inline: { rows: 0, ms: 0 } });
    });
    expect(readable(id)).toBe(false);
    closeDatabase();
    runRevocationJobsNow(database());
    expect(holding("SENTINEL-3")).toBe(0);
  });

  it("S4: a fact captured from a conversation and forgotten as a record is blank too", () => {
    reconcileMemoryRoster(roster); setMemoryMode("capture");
    appendMessage("thread", { id: "m", at: 1, role: "user", kind: "text", text: "SENTINEL-4 the deploy window is Tuesday" });
    const work = claimMemoryJob("fixture")!; publishMemoryWork(work, "fixture", captureWork(work));
    setMemoryMode("active");
    const id = String(database().prepare("SELECT id FROM memory_records WHERE text LIKE '%SENTINEL-4%'").get()!.id);
    forgetMemory(owner, { kind: "record", id }); runRevocationJobsNow(database());
    expect(holding("SENTINEL-4")).toBe(0);
  });

  it("S5: an owner identity delete leaves no copy of the words", () => {
    reconcileMemoryRoster(roster); setMemoryMode("active");
    const brief = writeBotIdentity(owner, { action: "identity-write", botId: "bot", kind: "continuity-brief", key: "core", expectedVersion: 0, text: "SENTINEL-5 finish the lighthouse story", basis: "fiction", audience: "owner-private" }, roster);
    deleteBotIdentity(owner, { action: "identity-delete", botId: "bot", kind: "continuity-brief", key: "core", expectedVersion: 1, expectedId: brief.id }, roster);
    expect(holding("SENTINEL-5")).toBe(0);
  });
});
