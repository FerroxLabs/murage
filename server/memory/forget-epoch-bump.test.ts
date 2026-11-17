// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// A forget moves the deletion epoch and the policy revision, once each, in its own commit (forget.ts forgetInTransaction): every
// receipt and session stamped before it is then older than the forget (resume-after-recall, memory-continuation-api), and the forget's
// own tombstone and result carry the new epoch. Direct calls to forgetMemory, for a record and for a source.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { appendMessage } from "../message-db.ts";
import { WORKSPACE_OWNER } from "../human-principals.ts";
import { ensureScope, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { claimMemoryJob, publishMemoryWork } from "./jobs.ts";
import { captureWork } from "./chunks.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { forgetMemory } from "./forget.ts";
import { runRevocationJobsNow } from "./memory-revocation.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });

const roster = { memoryRosterRevision: 1, bots: [{ id: "bot", threadId: "thread" }], groups: [] } as unknown as MemoryRoster;
const owner = ownerMemoryTicket();
const meta = () => {
  const row = database().prepare("SELECT deletion_epoch AS epoch,policy_revision AS policy FROM memory_meta WHERE id=1").get()!;
  return { epoch: Number(row.epoch), policy: Number(row.policy) };
};
const ownerForgetEpoch = (kind: "record" | "source", id: string) =>
  database().prepare("SELECT epoch FROM memory_tombstones WHERE reason='owner-forget' AND target_type=? AND target_id=?").all(kind, id).map(row => Number(row.epoch));

describe("a forget moves the deletion epoch and the policy revision", () => {
  it("E1: forgetting a record moves each counter by exactly one and stamps the new epoch", () => {
    reconcileMemoryRoster(roster); setMemoryMode("active");
    const id = randomUUID(), scope = ensureScope("preferences", "person:" + WORKSPACE_OWNER);
    database().prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,'owner-statement','active',0,?,NULL,NULL,?)").run(id, scope, "the gate code is four digits", Date.now(), Date.now());
    const before = meta();
    const result = forgetMemory(owner, { kind: "record", id });
    expect(meta()).toEqual({ epoch: before.epoch + 1, policy: before.policy + 1 });
    expect(result.deletionEpoch).toBe(before.epoch + 1);
    expect(ownerForgetEpoch("record", id)).toEqual([before.epoch + 1]);
    runRevocationJobsNow(database());
    // the job the forget left does not move them again
    expect(meta()).toEqual({ epoch: before.epoch + 1, policy: before.policy + 1 });
  });

  it("E2: forgetting a captured source moves each counter by exactly one and stamps the new epoch", () => {
    reconcileMemoryRoster(roster); setMemoryMode("capture");
    appendMessage("thread", { id: "m", at: 1, role: "user", kind: "text", text: "the shed is painted blue" });
    const work = claimMemoryJob("fixture")!; publishMemoryWork(work, "fixture", captureWork(work));
    setMemoryMode("active");
    const source = String(database().prepare("SELECT id FROM memory_sources WHERE thread_id='thread' LIMIT 1").get()!.id);
    const before = meta();
    const result = forgetMemory(owner, { kind: "source", id: source });
    expect(meta()).toEqual({ epoch: before.epoch + 1, policy: before.policy + 1 });
    expect(result.deletionEpoch).toBe(before.epoch + 1);
    expect(ownerForgetEpoch("source", source)).toEqual([before.epoch + 1]);
  });
});
