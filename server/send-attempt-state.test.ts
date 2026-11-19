import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { initializeSendAttempts, useSendAttemptDatabase, readAttempt, recordInvocation, releaseWrite, settleAttempt, type BindingKey } from "./send-attempt-state.ts";
let db: DatabaseSync;
const key: BindingKey = { ownerId: "owner", botId: "bot", threadId: "thread", sendId: "send", attemptId: "attempt", bindingEpoch: 1, generation: "gen", providerInstanceId: "instance" };
beforeEach(() => {
  db = new DatabaseSync(":memory:"); initializeSendAttempts(db); useSendAttemptDatabase(() => db);
  db.exec(`INSERT INTO send_attempts VALUES ('attempt','owner','bot','thread','send','hash',0,0,'starting','not_submitted','exclude',1,1,NULL,NULL,'line','queue',NULL,NULL,NULL,0,1,1);
    INSERT INTO send_attempt_bindings VALUES ('attempt',1,'gen','instance',NULL,NULL,0,0,0,1,'thread');
    INSERT INTO send_replay_exclusions VALUES ('thread','line','attempt','not_submitted',1);`);
});
afterEach(() => db.close());
it("F7-ACTION: frozen I0 schema rejects resend actions without replacement identities", () => {
  expect(() => db.exec(`INSERT INTO send_actions
    (owner_id,action_id,bot_id,thread_id,kind,target_attempt_id,target_revision,target_binding_epoch,fingerprint,status,created_at)
    VALUES ('owner','press','bot','thread','resend','attempt',1,1,'hash','pending',1)`)).toThrow();
});
it("F7-RECEIPT: authorized reads return immutable scoped identities", () => {
  expect(readAttempt(key, "send")).toMatchObject({ attemptId: "attempt", messageId: "line", delivery: "not_submitted" });
  expect(readAttempt({ ...key, botId: "foreign" }, "send")).toEqual({ kind: "missing" });
});
it("F7-INVOKE: unfenced invocation durably records uncertainty", () => {
  try { recordInvocation(key, 1, false); } catch { /* failed persistence is allowed to throw, never to release */ }
  expect(db.prepare("SELECT delivery FROM send_attempts").get()).toEqual({ delivery: "uncertain" });
  expect(db.prepare("SELECT invocation_released FROM send_attempt_bindings").get()).toEqual({ invocation_released: 1 });
});
it("F7-ID-NOT-ACK: fenced invocation and provider allocation do not prove submission", () => {
  const revision = recordInvocation(key, 1, true);
  db.prepare("UPDATE send_attempt_bindings SET provider_turn_id='allocated'").run();
  expect(readAttempt(key, "send")).toMatchObject({ revision, delivery: "not_submitted" });
});
it("F7-MULTIWRITE: evidence cannot erase an earlier possible write", () => {
  const revision = releaseWrite(key, 1, 1);
  const result = settleAttempt(key, revision, "failed", { binding: key, delivery: "not_submitted" });
  expect(result.receipt.delivery).toBe("uncertain");
});
it("F7-SETUP: terminal setup failure commits receipt before cleanup", () => {
  try { settleAttempt(key, 1, "failed", { binding: key, delivery: "not_submitted" }); } catch { /* assert durable result below */ }
  expect(db.prepare("SELECT phase,terminal_outcome FROM send_attempts").get()).toEqual({ phase: "terminal", terminal_outcome: "failed" });
  expect(db.prepare("SELECT count(*) AS n FROM turn_cleanup_owed WHERE status='pending'").get()).toMatchObject({ n: 6 });
});
it("F7-CAS: duplicate terminal callbacks return the original revision", () => {
  const result = settleAttempt(key, 1, "failed", { binding: key, delivery: "not_submitted" });
  const repeat = settleAttempt(key, 1, "completed", { binding: key, delivery: "not_submitted" });
  expect(repeat.kind).toBe("already"); expect(repeat.receipt).toEqual(result.receipt);
});
it("F7-CAS: wrong scope/generation/epoch/revision cannot settle another run", () => {
  for (const wrong of [{ generation: "other" }, { bindingEpoch: 2 }, { botId: "other" }]) {
    expect(settleAttempt({ ...key, ...wrong }, 1, "failed", { binding: { ...key, ...wrong }, delivery: "not_submitted" }).kind).toBe("stale");
  }
  expect(settleAttempt(key, 0, "failed", { binding: key, delivery: "not_submitted" }).kind).toBe("stale");
  expect(readAttempt(key, "send")).toMatchObject({ phase: "starting", revision: 1 });
});
it("F7-DB-TERMINAL: an aborted terminal transaction leaves replay and ownership intact", () => {
  db.exec(`CREATE TRIGGER fail_terminal BEFORE UPDATE OF terminal_outcome ON send_attempts BEGIN SELECT RAISE(ABORT,'disk full'); END`);
  expect(() => settleAttempt(key, 1, "failed", { binding: key, delivery: "not_submitted" })).toThrow("disk full");
  expect(readAttempt(key, "send")).toMatchObject({ phase: "starting", revision: 1 });
  expect(db.prepare("SELECT active FROM send_attempt_bindings").get()).toEqual({ active: 1 });
});

it("F7-ML6-QUERY-PLAN: replay candidates use the exclusion primary key", () => {
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM send_replay_exclusions WHERE thread_id=? AND message_id=?").all("thread", "line");
  expect(JSON.stringify(plan)).toContain("SEARCH send_replay_exclusions USING PRIMARY KEY");
  expect(JSON.stringify(plan)).not.toContain("SCAN");
});

import { SendAttemptStore } from "./send-attempt-state.ts";
import { vi } from "vitest";
it("F7-ML6-FAILED-ROWS-INVARIANT: lookup count ignores 0, 10000 and 100000 failed rows", () => {
  const store = new SendAttemptStore(db);
  const insert = db.prepare(`INSERT INTO send_attempts SELECT ?,owner_id,bot_id,thread_id,?,fingerprint,isolated,queue_only,'terminal',delivery,replay_policy,revision,0,NULL,NULL,NULL,NULL,'failed',NULL,1,0,1,1 FROM send_attempts WHERE attempt_id='attempt'`);
  let previous = 0;
  const counts: number[] = [];
  for (const count of [0, 10_000, 100_000]) {
    db.exec("BEGIN IMMEDIATE");
    for (let i = previous; i < count; i++) insert.run(`failed-${i}`, `failed-send-${i}`);
    db.exec("COMMIT"); previous = count;
    const prepare = db.prepare.bind(db); let lookups = 0;
    const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      const statement = prepare(sql);
      if (sql.startsWith("SELECT 1 FROM send_replay_exclusions")) {
        const get = statement.get.bind(statement);
        vi.spyOn(statement, "get").mockImplementation((...args) => { lookups++; return get(...args); });
      }
      return statement;
    });
    expect([...store.replayEligibility("thread", ["line", "ordinary", "another"]).excludedIds]).toEqual(["line"]);
    spy.mockRestore(); counts.push(lookups);
  }
  expect(counts).toEqual([3, 3, 3]);
});

import { afterCommit } from "./tx-scope.ts";
it("F7-RECEIPT: line, exclusion and publication roll back with the enclosing transaction", () => {
  const store = new SendAttemptStore(db); const seen: string[] = [];
  db.exec("CREATE TABLE messages(id TEXT PRIMARY KEY,json TEXT)");
  const receipt = store.create({ ownerId: "owner", botId: "bot", threadId: "thread", sendId: "new", fingerprint: "hash" });
  expect(() => store.transaction(() => {
    store.link(receipt.attemptId, "new-line", () => {
      db.prepare("INSERT INTO messages VALUES ('new-line','words')").run();
      afterCommit(() => { seen.push("published"); });
    });
    throw new Error("commit failed");
  })).toThrow("commit failed");
  expect(seen).toEqual([]); expect(db.prepare("SELECT count(*) AS n FROM messages").get()).toEqual({ n: 0 });
  expect(store.byId(receipt.attemptId)?.messageId).toBeNull();
  expect(store.replayEligibility("thread", ["new-line"]).excludedIds.size).toBe(0);
});
