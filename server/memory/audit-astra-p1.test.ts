// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Astra's cross-audit of the write-time lane (int102-gate/audit-astra/REPORT.md): seven P1s, each reproduced here first and fixed after.
// 1-5 are leaks (a line, a note, a card or a prompt shown after the owner forgot what it rests on); 6-7 are over-withholds (a clean later
// reply withheld by a revoke that never reached it). Each test is the report's reproduction in the form the production writers produce it.
import { mkdirSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { appendMessage, closeMessageDb } from "../message-db.ts";
import type { Message } from "../store.ts";
import { denyLookup, memoryLookup } from "./deny-read.ts";
import { lineageBackfillSlice, lineageCertProgress, resetLineageBackfillForTest } from "./lineage-backfill.ts";
import { addTurnParents, closeTurnLineage, openTurnLineage } from "./lineage-write.ts";
import type { LineageReader, LineageRef, MemoryRef } from "./lineage-types.ts";
import { drainRevokeMarker } from "./memory-revocation.ts";
import { buildPrompt, promptPart, recordTurnObject, sendFence, turnToolText } from "./prompt-parts.ts";
import { commitRevoke } from "./revoke-commit.ts";
import { linkMemoryDisclosureOutput } from "./disclosures.ts";
import { downgradeMemorySchema, upgradeDevelopmentV10Carry, validateMemorySchema } from "./schema.ts";
import { buildLegacyHistory, markUpgraded } from "./testing/legacy-history-fixture.ts";
import { LineageAllowance as LegacyAllowance } from "./testing/legacy-lineage/lineage-allowance.ts";
import { forgetKeptLineageForTest, replayExclusions, setReplayNodeBudgetForTest } from "./testing/legacy-lineage/replay-lineage.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { channelToProjectRows } from "../project-settings.ts";
import { createProjectCard } from "../project-cards.ts";
import { workingContextBlock, type WorkingContextInput } from "../working-context.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const CONTENT: LineageReader = { audience: null };
const OWNER_READER: LineageReader = { audience: { owner: true, scopeIds: [] } };
const msg = (id: string, extra: Partial<Message> = {}): Message => ({ id, role: "bot", kind: "text", text: id, at: Date.now(), ...extra });
const owner = (id: string, extra: Partial<Message> = {}): Message => msg(id, { role: "user", ...extra });
const verdict = (thread: string, id: string, author: "owner" | "generated" = "generated") => denyLookup(database(), { threadId: thread, lines: [{ messageId: id, author }] }, CONTENT).get(id)!;
const inTurn = (thread: string, turnId: string, write: () => void) => {
  const turn = openTurnLineage(database(), { threadId: thread, turnId });
  try { write(); } finally { closeTurnLineage(turn); }
};
const drain = () => expect(drainRevokeMarker(database()).pending).toBe(false);

beforeEach(() => {
  closeMessageDb(); closeDatabase(); resetLineageBackfillForTest(); forgetKeptLineageForTest();
  removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
});

describe("Astra audit P1", () => {
  it("1. two destination threads whose open turns share a head and a source line both lose their replies when the source is forgotten (the carry key includes the child thread)", () => {
    appendMessage("s", owner("so1")); appendMessage("s", msg("s1", { parentId: "so1" }));
    appendMessage("a", owner("ao1")); appendMessage("b", owner("bo1"));
    const ta = openTurnLineage(database(), { threadId: "a", turnId: "ta" }), tb = openTurnLineage(database(), { threadId: "b", turnId: "tb" });
    expect(ta.turnLsn).toBe(tb.turnLsn);
    const source: LineageRef = { kind: "line", threadId: "s", messageId: "s1" };
    addTurnParents(ta, [source]); addTurnParents(tb, [source]);
    appendMessage("a", msg("a1", { parentId: "ao1" })); appendMessage("b", msg("b1", { parentId: "bo1" }));
    closeTurnLineage(ta); closeTurnLineage(tb);
    commitRevoke(database(), { kind: "line", threadId: "s", messageIds: ["s1"], cause: "forget" });
    drain();
    expect(verdict("a", "a1").state).toBe("withheld");
    expect(verdict("b", "b1").state).toBe("withheld");
  });

  it("2. a receipt citing an active record whose evidence source has advanced is withheld after the upgrade, as the frozen judge withholds it", () => {
    const db = database();
    const history = buildLegacyHistory(db, { seed: 3, threads: 2, lines: 8 });
    const thread = history.threads[0]!;
    const line = history.lines.get(thread)!.find(entry => entry.receipt)!;
    const scope = history.scopeOf.get(thread)!;
    db.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,owner_pinned,valid_from,valid_to,supersedes_id,created_at) VALUES('rec-x',1,?,'fact','text','observed','active',0,0,NULL,NULL,0)").run(scope);
    db.prepare("INSERT INTO memory_source_versions(source_id,revision,content_hash,payload,created_at) VALUES(?,1,'hash','{}',0)").run(`doc:${thread}`);
    db.prepare("INSERT INTO memory_evidence(record_id,record_version,source_id,source_revision,start_byte,end_byte) VALUES('rec-x',1,?,1,0,3)").run(`doc:${thread}`);
    db.prepare("UPDATE memory_disclosures SET record_versions=?, source_versions='[]' WHERE bundle_id=?").run('[{"id":"rec-x","version":1}]', line.receipt);
    db.prepare("UPDATE memory_sources SET revision=2 WHERE id=?").run(`doc:${thread}`); // the source the record rests on moved on
    setReplayNodeBudgetForTest(Number.MAX_SAFE_INTEGER);
    try {
      const old = replayExclusions(LegacyAllowance.tool(Number.MAX_SAFE_INTEGER), thread, history.lines.get(thread)!.map(entry => ({ id: entry.id, role: entry.role })), null, { failClosed: true });
      expect(old.has(line.id), "the frozen judge withholds the receipt's reply").toBe(true);
    } finally { setReplayNodeBudgetForTest(null); }
    markUpgraded(db);
    for (let slices = 0; lineageBackfillSlice(db, { budgetMs: 500 }).more; slices++) if (slices > 100_000) throw new Error("backfill without end");
    expect(lineageCertProgress(db).ready).toBe(true);
    drain();
    expect(verdict(thread, line.id).state).toBe("withheld");
  });

  it("3. a note a bot wrote from a secret-bearing turn, read by another thread's turn, withholds that thread's reply when the secret is forgotten", () => {
    const db = database();
    const note: MemoryRef = { kind: "note", id: "n1" };
    appendMessage("A", owner("ao1"));
    inTurn("A", "turn-a", () => { appendMessage("A", msg("a1", { parentId: "ao1" })); recordTurnObject(db, "A", note); });
    appendMessage("B", owner("bo1"));
    inTurn("B", "turn-b", () => { turnToolText("B", "the note's words", [{ kind: "memory", ref: note }]); appendMessage("B", msg("b1", { parentId: "bo1" })); });
    expect(verdict("B", "b1").state).toBe("shown");
    commitRevoke(db, { kind: "line", threadId: "A", messageIds: ["a1"], cause: "forget" });
    drain();
    expect(memoryLookup(db, [note], CONTENT).get("note:n1:0")).toEqual({ state: "withheld", reason: "deny-memory" });
    expect(verdict("B", "b1").state).toBe("withheld");
  });

  describe("4. a card the owner's forget reached never reaches the working context or the send", () => {
    const input = (): WorkingContextInput => ({
      botId: "reed", currentThreadId: "reed-direct", now: Date.UTC(2026, 8, 29, 12, 0, 0),
      bots: [{ id: "reed", threadId: "reed-direct", tasks: [{ threadId: "reed-direct", title: "Reed" }] }, { id: "cole", threadId: "cole-direct" }],
      groups: [{ id: "launch", name: "Tallyroo Launch", threadId: "launch-chat", memberIds: ["reed", "cole"], channelProject: { goal: "Launch" }, tasks: [] }],
      routines: [],
    });
    it("the denied card's title is left out of the block, and a prompt part naming a denied card is refused at an unchanged generation", () => {
      const db = database();
      channelToProjectRows(db, { groupId: "launch", bulletin: "", leadBotId: "cole", now: Date.UTC(2026, 8, 29, 12, 0, 0) });
      const made = createProjectCard(db, { groupId: "launch", title: "Research three segments", assigneeBotId: "reed", actor: { kind: "owner" }, memberIds: ["reed", "cole"], now: Date.UTC(2026, 8, 29, 12, 0, 0) });
      if (!made.ok) throw new Error(JSON.stringify(made));
      const shownBefore = workingContextBlock(LineageAllowance.tool(1_000_000_000), true, input(), db);
      expect(shownBefore.text).toContain("Research three segments");
      // the card was reached through its writer's carried context: a deny_memory mark, its explicit sources valid
      db.prepare("INSERT INTO memory_deny_memory(kind,id,version,revoke_id) VALUES('card',?,0,1)").run(String(made.card.id));
      expect(memoryLookup(db, [{ kind: "card", id: String(made.card.id) }], CONTENT).get(`card:${made.card.id}:0`)).toEqual({ state: "withheld", reason: "deny-memory" });
      const block = workingContextBlock(LineageAllowance.tool(1_000_000_000), true, input(), db);
      expect(block.text).not.toContain("Research three segments");
      // the send: the same generation as the build, a part that names the denied card
      const turn = openTurnLineage(db, { threadId: "reed-direct", turnId: "t" });
      try {
        const built = buildPrompt(turn, [promptPart("What I've been working on: Research three segments", [{ kind: "memory", ref: { kind: "card", id: String(made.card.id) } }])]);
        expect(sendFence(db, built, OWNER_READER).state).not.toBe("shown");
      } finally { closeTurnLineage(turn); }
    });
  });

  it("5. the send fence refuses a prompt whose replay shows a line the owner forgot after it was built (a prefix part names the lines it showed)", () => {
    const db = database();
    appendMessage("t", owner("o1"));
    inTurn("t", "turn-1", () => appendMessage("t", msg("r1", { parentId: "o1" })));
    appendMessage("t", owner("o2", { parentId: "r1" }));
    const turn = openTurnLineage(db, { threadId: "t", turnId: "turn-2" });
    try {
      const prefix = (shown: string[]): LineageRef => ({ kind: "prefix", threadId: "t", headLsn: turn.turnLsn, shown } as LineageRef);
      const replay = buildPrompt(turn, [promptPart("o1\nr1\no2", [prefix(["o1", "r1", "o2"])])]);
      const clean = buildPrompt(turn, [promptPart("o1\no2", [prefix(["o1", "o2"])])]);
      expect(sendFence(db, replay, OWNER_READER).state).toBe("shown");
      commitRevoke(db, { kind: "line", threadId: "t", messageIds: ["r1"], cause: "forget" });
      drain();
      expect(verdict("t", "r1").state).toBe("withheld");
      expect(sendFence(db, replay, OWNER_READER).state).not.toBe("shown");
      expect(sendFence(db, clean, OWNER_READER).state).toBe("shown"); // the owner's own lines never wait
    } finally { closeTurnLineage(turn); }
  });

  it("6. a clean reply written after a forget, copied to another thread, stays shown there (the carry inheritance respects the range's until)", () => {
    const db = database();
    appendMessage("t", owner("o1"));
    inTurn("t", "turn-1", () => appendMessage("t", msg("r1", { parentId: "o1" })));
    commitRevoke(db, { kind: "line", threadId: "t", messageIds: ["r1"], cause: "forget" });
    drain();
    appendMessage("t", owner("o2", { parentId: "r1" }));
    inTurn("t", "turn-2", () => appendMessage("t", msg("r2", { parentId: "o2" })));
    expect(verdict("t", "r1").state).toBe("withheld");
    expect(verdict("t", "r2").state).toBe("shown");
    appendMessage("u", owner("u1"));
    appendMessage("u", msg("c1", { parentId: "u1", copyOf: { threadId: "t", messageIds: ["r2"] } }));
    drain();
    expect(verdict("u", "c1").state).toBe("shown");
  });

  it("7. a delayed marker never reaches a clean answer captured after the commit whose turn began at the range's excluded bound", () => {
    const db = database();
    appendMessage("t", owner("o1"));
    inTurn("t", "turn-1", () => appendMessage("t", msg("r1", { parentId: "o1" })));
    commitRevoke(db, { kind: "line", threadId: "t", messageIds: ["r1"], cause: "forget" }, { inline: false });
    appendMessage("t", owner("o2", { parentId: "r1" }));
    inTurn("t", "turn-2", () => appendMessage("t", msg("r2", { parentId: "o2" })));
    // (the write captures a reply into memory itself: memory_sources and memory_line_capture)
    expect(db.prepare("SELECT 1 AS x FROM memory_line_capture c JOIN memory_thread_no n ON n.no=c.thread_no WHERE n.thread_id='t' AND c.source_id='message:t:r2'").get()).toBeTruthy();
    const range = db.prepare("SELECT until_turn_lsn AS u FROM memory_deny_range WHERE thread_id='t' ORDER BY from_lsn LIMIT 1").get()!;
    const turnLsn = db.prepare("SELECT l.turn_lsn AS t FROM memory_line_lineage l JOIN memory_thread_no n ON n.no=l.thread_no WHERE n.thread_id='t' AND l.message_id='r2'").get()!;
    // (the commit takes its own lsn, the range's excluded upper bound: a turn opened after it is at or above that bound, here one past it
    // as o2 took the next slot; a turn opened right on the bound with no new line is memory-late-submission-api.test.ts "no new line")
    expect(Number(turnLsn.t), "the answer's turn began at or after the range's excluded upper bound").toBeGreaterThanOrEqual(Number(range.u));
    drain();
    expect(verdict("t", "r1").state).toBe("withheld");
    expect(verdict("t", "r2").state).toBe("shown");
  });

  it("8. (found by the extended generator) a source the owner forgets still withholds, from the content reader, the outputs of a receipt that cites it and was revoked earlier", () => {
    const db = database();
    appendMessage("S", owner("so1"));
    inTurn("S", "turn-s", () => appendMessage("S", msg("sx", { parentId: "so1" })));
    appendMessage("t", owner("o1"));
    inTurn("t", "turn-t", () => appendMessage("t", msg("r1", { parentId: "o1" })));
    db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES('rc','t','d','s','[]',?,'[]',0,0,0,'delivered',0)")
      .run(JSON.stringify([{ id: "message:S:sx", revision: 1 }]));
    linkMemoryDisclosureOutput("rc", "r1");
    // a state flip (settings, restore, bookkeeping): the receipt leaves the citation index; the content reader is still shown its lines
    db.prepare("UPDATE memory_disclosures SET state='revoked' WHERE bundle_id='rc'").run();
    drain();
    expect(verdict("t", "r1").state).toBe("shown");
    commitRevoke(db, { kind: "line", threadId: "S", messageIds: ["sx"], cause: "forget" });
    drain();
    expect(verdict("S", "sx").state).toBe("withheld");
    expect(verdict("t", "r1").state).toBe("withheld");
  });

  it("9. a v10 file the earlier lane wrote (the carry key without the child thread, NULL for a record child) is rebuilt with every row and validates", () => {
    const db = database();
    // a 1.0.2-era file: v10 stays explicit (the repair runs only on a v10 file)
    expect(downgradeMemorySchema(db, 10)).toMatchObject({ status: "downgraded", from: 13, to: 10 });
    const rows = [[1, 5, 5, 1, "7", 2], [1, 5, 5, 3, "note:n1:0", null], [2, 9, 3, 0, "9", 4]] as const;
    db.exec("DROP TABLE memory_lineage_carry");
    db.exec("CREATE TABLE memory_lineage_carry (\n parent_thread_no INTEGER NOT NULL, to_lsn INTEGER NOT NULL, from_lsn INTEGER NOT NULL, child_kind INTEGER NOT NULL CHECK(child_kind BETWEEN 0 AND 3),\n child_ref TEXT NOT NULL, child_thread_no INTEGER,\n PRIMARY KEY(parent_thread_no,to_lsn,from_lsn,child_kind,child_ref)) WITHOUT ROWID");
    for (const row of rows) db.prepare("INSERT INTO memory_lineage_carry(parent_thread_no,to_lsn,from_lsn,child_kind,child_ref,child_thread_no) VALUES(?,?,?,?,?,?)").run(...row);
    expect(upgradeDevelopmentV10Carry(db)).toBe(true);
    expect(() => validateMemorySchema(db)).not.toThrow();
    expect(db.prepare("SELECT parent_thread_no AS p,to_lsn AS t,from_lsn AS f,child_kind AS k,child_ref AS r,child_thread_no AS c FROM memory_lineage_carry ORDER BY 1,2,3,4,5").all().map(row => ({ ...row })))
      .toEqual([{ p: 1, t: 5, f: 5, k: 1, r: "7", c: 2 }, { p: 1, t: 5, f: 5, k: 3, r: "note:n1:0", c: 0 }, { p: 2, t: 9, f: 3, k: 0, r: "9", c: 4 }]);
    expect(upgradeDevelopmentV10Carry(db)).toBe(false); // nothing left to do
  });
});
