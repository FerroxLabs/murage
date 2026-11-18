import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { SEND_ATTEMPT_SCHEMA_SQL, SendAttemptStore } from "../send-attempt-state.ts";
import { captureSendReplayProof, assertSendReplayProof } from "./replay-lineage.ts";
import { updateReceiptReplayProof } from "./receipt-replay-proof.ts";
import { setReplayShadowForTest } from "./replay-walk.ts";
import { takeReplayShadowDivergencesForTest } from "./replay-shadow.ts";
import { WritetimeFixture } from "./testing/writetime-fixture.ts";

const fixtures: WritetimeFixture[] = [];
afterEach(() => { setReplayShadowForTest(process.env.MURAGE_REPLAY_SHADOW === "1"); vi.restoreAllMocks(); fixtures.splice(0).forEach(f => f.close()); });
function fixture() {
  const f = new WritetimeFixture().owner("T", "history", 1).owner("T", "current", 2); fixtures.push(f);
  f.db.exec(SEND_ATTEMPT_SCHEMA_SQL);
  const store = new SendAttemptStore(f.db);
  const row = store.create({ ownerId: "owner", botId: "bot", threadId: "T", sendId: "send", fingerprint: "fixture" });
  store.link(row.attemptId, "current");
  let key = store.bind([row.attemptId], { generation: "generation", providerInstanceId: "engine" })[0]!;
  const state = { proof: captureSendReplayProof("T", ["history", "current"], new Map(), f.db) };
  const mutate = <T,>(work: () => T, ids = ["current"]) => store.transaction(() => updateReceiptReplayProof(f.db, state, ids, work));
  const release = () => store.releaseWrite(key, store.byId(row.attemptId)!.revision, 1);
  const acknowledge = () => { key = store.allocateProvider(key, store.byId(row.attemptId)!.revision, "provider-turn"); store.acknowledge(key, store.byId(row.attemptId)!.revision); };
  const excludeHistory = () => f.db.exec("INSERT INTO send_replay_exclusions VALUES('T','history',NULL,'uncertain',1); UPDATE send_replay_epochs SET revision=revision+1 WHERE thread_id='T'");
  return { f, store, row, state, mutate, release, acknowledge, excludeHistory };
}

it("advances only across this attempt's released and acknowledged receipt evidence", () => {
  const f = fixture(), original = f.state.proof;
  f.mutate(f.release);
  expect(f.store.byId(f.row.attemptId)!.delivery).toBe("uncertain");
  expect(f.state.proof.epochs[0]![1]).toBe(original.epochs[0]![1] + 1);
  expect(() => assertSendReplayProof(f.state.proof, f.f.db)).not.toThrow();
  f.mutate(f.acknowledge);
  expect(f.store.byId(f.row.attemptId)!.delivery).toBe("submitted");
  expect(f.state.proof.excludedIds.has("current")).toBe(false);
  expect(f.state.proof.excludedIds.has("history")).toBe(false);
  expect(() => assertSendReplayProof(f.state.proof, f.f.db)).not.toThrow();
});

it("checks a previously committed replay change before mutating any receipt", () => {
  const f = fixture(), write = vi.fn(f.release), before = f.store.byId(f.row.attemptId);
  f.excludeHistory();
  expect(() => f.mutate(write)).toThrow("SEND_REPLAY_CHANGED");
  expect(write).not.toHaveBeenCalled(); expect(f.store.byId(f.row.attemptId)).toEqual(before);
});

it.each(["selected", "unselected"])("does not absorb an unrelated %s exclusion into the receipt proof", source => {
  const f = fixture(), before = f.state.proof;
  expect(() => f.mutate(() => {
    f.release();
    if (source === "selected") f.excludeHistory();
    else f.f.db.exec("INSERT INTO send_replay_exclusions VALUES('T','unselected',NULL,'uncertain',1); UPDATE send_replay_epochs SET revision=revision+1 WHERE thread_id='T'");
  })).toThrow("SEND_REPLAY_CHANGED");
  expect(f.state.proof).toBe(before);
  expect(f.store.byId(f.row.attemptId)!.delivery).toBe("not_submitted");
  expect(f.f.db.prepare("SELECT * FROM send_replay_exclusions WHERE message_id!='current'").all()).toEqual([]);
});

it("requires the exact owned message identity before advancing an epoch", () => {
  const f = fixture(), before = f.state.proof;
  expect(() => f.mutate(f.release, ["another-message"])).toThrow("SEND_REPLAY_CHANGED");
  expect(f.state.proof).toBe(before);
  expect(f.store.byId(f.row.attemptId)!.delivery).toBe("not_submitted");
});

it("does not absorb changed copy ancestry alongside its own receipt write", () => {
  // Deliberately bypass the epoch writer: the required shadow invariant must
  // be observed even though the existing SEND_REPLAY_CHANGED assertion catches it.
  setReplayShadowForTest(true);
  const f = fixture(), before = f.state.proof;
  expect(() => f.mutate(() => {
    f.release();
    f.f.db.prepare("UPDATE messages SET json=? WHERE thread_id='T' AND id='history'").run(JSON.stringify({ copyOf: { threadId: "T", messageIds: ["current"] } }));
  })).toThrow("SEND_REPLAY_CHANGED");
  expect(takeReplayShadowDivergencesForTest()).toBe(1);
  expect(f.state.proof).toBe(before);
  expect(f.store.byId(f.row.attemptId)!.delivery).toBe("not_submitted");
});

it("restores the exact proof alias if an enclosing transaction rolls back", () => {
  const f = fixture(), before = f.state.proof;
  expect(() => f.store.transaction(() => { f.mutate(f.release); expect(f.state.proof).not.toBe(before); throw new Error("fixture rollback"); })).toThrow("fixture rollback");
  expect(f.state.proof).toBe(before);
  expect(f.store.byId(f.row.attemptId)!.delivery).toBe("not_submitted");
  expect(() => assertSendReplayProof(f.state.proof, f.f.db)).not.toThrow();
});

it("holds the installation writer lock across both proof checks and the receipt mutation", () => {
  const f = fixture(); f.f.db.exec("PRAGMA journal_mode=WAL");
  const other = new DatabaseSync(f.f.db.prepare("PRAGMA database_list").all()[0]!.file as string); other.exec("PRAGMA busy_timeout=0");
  try {
    f.mutate(() => { expect(() => other.exec("BEGIN IMMEDIATE; COMMIT")).toThrow(/locked|busy/i); f.release(); });
    expect(() => other.exec("BEGIN IMMEDIATE; COMMIT")).not.toThrow();
  } finally { other.close(); }
});

it("requires a synchronous writer scope and refuses async callbacks before invoking them", () => {
  const f = fixture(), write = vi.fn(f.release);
  expect(() => updateReceiptReplayProof(f.f.db, f.state, ["current"], write)).toThrow("SEND_REPLAY_WRITE_SCOPE");
  expect(write).not.toHaveBeenCalled();
  expect(() => f.mutate(async () => write())).toThrow("ASYNC_SEND_REPLAY_WRITE");
  expect(write).not.toHaveBeenCalled();
});
