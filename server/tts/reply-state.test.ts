import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeReplySchema } from "./reply-schema.ts";
import { ReplyState, speechTransaction, SpeechRefusal, type SpeechConnection, type SpeechEvent, type SpeechReservation } from "./reply-state.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const databases: DatabaseSync[] = [], directories: string[] = [];
afterEach(() => { for (const db of databases.splice(0)) { try { db.close(); } catch {} } for (const dir of directories.splice(0)) removeTempDirSync(dir); });
function fixture(db = new DatabaseSync(":memory:")) {
  databases.push(db); initializeReplySchema(db);
  let now = 1_000_000;
  const events: SpeechEvent[] = [];
  const tx = speechTransaction(db);
  const state = new ReplyState({ db: () => db, transaction: tx, now: () => now, emit: event => events.push(event) }); state.boot();
  const send = vi.fn(() => true), terminate = vi.fn();
  const connection: SpeechConnection = { id: "connection", principal: "owner", send, terminate };
  const session = state.session(connection, "thread");
  const account = state.account("fixture-account", "credential-1");
  const input = (commandSequence = 1, messageId = "message"): SpeechReservation => ({ sessionId: session.sessionId, principal: "owner", connectionId: "connection", threadId: "thread", messageId, commandSequence, action: "speak" });
  const validate = (messageId = "message", accountOverride = account) => () => ({ target: { threadId: "thread", messageId, botId: "bot", eligible: true }, account: accountOverride });
  const settle = (generation = "generation", messageId = "message", provider = "provider") => {
    state.begin("thread", "bot", generation, "prompt"); state.bind(generation, provider);
    return state.settle("thread", provider, messageId, true)! as Extract<SpeechEvent, { kind: "speech.ready" }>;
  };
  return { db, state, events, connection, session, account, input, validate, settle, send, terminate, tx, time: (value: number) => { now = value; } };
}
const code = (run: () => unknown, status: number, outcome?: string) => {
  try { run(); throw new Error("expected refusal"); } catch (error) { expect(error).toBeInstanceOf(SpeechRefusal); expect((error as SpeechRefusal).status).toBe(status); if (outcome) expect((error as SpeechRefusal).code).toBe(outcome); }
};

describe("D24 durable turn identity and settlement", () => {
  it("S-settle emits only once after terminal commit and rejects unknown, failed and ambiguous provider identity", () => {
    const f = fixture();
    f.state.begin("thread", "bot", "g", "prompt"); f.state.bind("g", "p");
    expect(f.state.settle("thread", "unknown", "m", true)).toBeUndefined();
    f.tx(() => { f.state.settle("thread", "p", "m", true); expect(f.events).toEqual([]); });
    expect(f.events).toHaveLength(1);
    expect(f.state.settle("thread", "p", "m", true)).toBeUndefined();
    f.state.begin("thread", "bot", "failed", "prompt"); f.state.bind("failed", "fail"); f.state.settle("thread", "fail", "mf", false);
    expect(f.state.settle("thread", "fail", "mf", true)).toBeUndefined();
    f.state.begin("thread", "bot", "a", "prompt"); f.state.bind("a", "same");
    f.state.begin("thread", "bot", "b", "prompt"); f.state.bind("b", "same");
    expect(f.state.generation("thread", "same")).toBeUndefined(); expect(f.events).toHaveLength(1);
  });
  it("S-late and S-new keep invalidation irreversible across late appends, duplicate binds and room member completions", () => {
    const f = fixture(); f.state.begin("thread", "bot", "old", "p"); f.state.bind("old", "old-provider");
    const revision = f.state.prompt("thread");
    expect(f.state.settle("thread", "old-provider", "late", true)).toBeUndefined();
    expect(() => f.state.begin("thread", "bot", "old", "p")).toThrow();
    for (const [g, bot] of [["a", "A"], ["b", "B"]]) { f.state.begin("thread", bot, g, "new-prompt"); f.state.bind(g, g); }
    expect(f.state.settle("thread", "a", "ma", true)).toMatchObject({ revision });
    expect(f.state.settle("thread", "b", "mb", true)).toMatchObject({ revision });
    f.state.invalidateGeneration("thread", "old");
    expect(f.db.prepare("SELECT state FROM speech_generations WHERE generation_id='b'").get()?.state).toBe("completed");
  });
  it("rolls back both a terminal mark and speech settlement, publishing neither on outer failure", () => {
    const f = fixture(); f.state.begin("thread", "bot", "g", "p"); f.state.bind("g", "provider");
    f.db.exec("CREATE TABLE terminal(id TEXT PRIMARY KEY)");
    expect(() => f.tx(db => { db.exec("INSERT INTO terminal VALUES('m')"); f.state.settle("thread", "provider", "m", true); throw new Error("fixture rollback"); })).toThrow();
    expect(f.events).toEqual([]); expect(f.db.prepare("SELECT count(*) n FROM terminal").get()?.n).toBe(0);
    expect(f.db.prepare("SELECT count(*) n FROM speech_settlements").get()?.n).toBe(0);
    expect(f.state.settle("thread", "provider", "m", true)).toBeDefined();
  });
  it("S-target revalidates source membership and bot identity inside reservation", () => {
    const f = fixture(); const event = f.settle();
    const auto = { ...f.input(), action: undefined, settlementId: event.settlementId };
    code(() => f.state.reserve(auto, () => ({ ...f.validate()(), target: { threadId: "other", messageId: "message", botId: "bot", eligible: true } })), 404);
    code(() => f.state.reserve(auto, () => ({ ...f.validate()(), target: { threadId: "thread", messageId: "message", botId: "other", eligible: true } })), 204);
    code(() => f.state.reserve(f.input(), () => ({ ...f.validate()(), target: { threadId: "thread", messageId: "message", botId: "bot", eligible: false } })), 404);
    expect(f.db.prepare("SELECT count(*) n FROM speech_attempts").get()?.n).toBe(0);
  });
});

describe("D24 permanent claims, sessions and spend", () => {
  it("S-race permanently claims automatic speech across connections and lets an explicit manual command replay", () => {
    const f = fixture(); const event = f.settle();
    const a = f.state.reserve({ ...f.input(), action: undefined, settlementId: event.settlementId }, f.validate()); f.state.finish(a, "complete");
    const second = f.state.session({ ...f.connection, id: "connection-2" }, "thread");
    code(() => f.state.reserve({ ...f.input(), sessionId: second.sessionId, connectionId: "connection-2", action: undefined, settlementId: event.settlementId }, f.validate()), 204);
    const manual = f.state.reserve(f.input(2), f.validate()); expect(manual.attemptId).not.toBe(a.attemptId);
    expect(f.db.prepare("SELECT count(*) n FROM speech_attempts WHERE mode='automatic'").get()?.n).toBe(1);
  });
  it("manual history is eligible without a new settlement, while stale automatic claims fail", () => {
    const f = fixture(); const event = f.settle(); f.time(1_060_000);
    code(() => f.state.reserve({ ...f.input(), action: undefined, settlementId: event.settlementId }, f.validate()), 204);
    expect(f.state.reserve(f.input(), f.validate())).toBeDefined();
  });
  it("command order and duplicate completion cannot start audio or erase the replacement slot", () => {
    const f = fixture(); const a = f.state.reserve(f.input(1), f.validate()); const abort = vi.fn(); f.state.install(a, abort);
    const b = f.state.reserve(f.input(3, "next"), f.validate("next")); f.state.install(b, () => {});
    expect(abort).toHaveBeenCalledOnce(); expect(f.state.current(a)).toBe(false); expect(f.state.current(b)).toBe(true);
    f.state.finish(a, "complete"); expect(f.state.current(b)).toBe(true);
    code(() => f.state.reserve(f.input(2), f.validate()), 409);
    code(() => f.state.reserve(f.input(3, "next"), f.validate("next")), 409, "duplicate_command");
    f.state.cancel({ ...f.input(4) }); expect(f.state.current(b)).toBe(false);
    code(() => f.state.reserve(f.input(3, "next"), f.validate("next")), 204);
  });
  it("disconnect and session replacement revoke playback ownership including completed downloads", () => {
    const f = fixture(); const a = f.state.reserve(f.input(), f.validate()); const abort = vi.fn(); f.state.install(a, abort);
    const replacement = f.state.session(f.connection, "thread"); expect(replacement.sessionId).not.toBe(f.session.sessionId); expect(abort).toHaveBeenCalledOnce();
    code(() => f.state.reserve(f.input(2), f.validate()), 409);
    f.state.closeConnection("connection");
    code(() => f.state.authorize({ ...f.input(), sessionId: replacement.sessionId }), 409);
  });
  it("P-quota counts failed/cancelled attempts, persists rolling clocks and does not reset with the mode", () => {
    const f = fixture();
    for (let seq = 1; seq <= 3; seq++) { const attempt = f.state.reserve(f.input(seq), f.validate()); f.state.finish(attempt, seq % 2 ? "failed" : "cancelled"); }
    code(() => f.state.reserve(f.input(4), f.validate()), 429);
    f.time(1); code(() => f.state.reserve(f.input(4), f.validate()), 429);
    for (let seq = 4; seq <= 6; seq++) { const attempt = f.state.reserve(f.input(seq, "m" + seq), f.validate("m" + seq)); f.state.finish(attempt, "complete"); }
    code(() => f.state.reserve(f.input(7, "m7"), f.validate("m7")), 429);
    f.time(1_060_001); expect(f.state.reserve(f.input(7, "m7"), f.validate("m7"))).toBeDefined();
  });
  it("S-budget scopes holds to opaque account identity and keeps the same binding stable across restart", () => {
    const f = fixture(); const other = f.state.account("own-eleven", "credential-2");
    const a = f.state.reserve(f.input(), f.validate()); f.state.finish(a, "budget");
    const same = f.state.account("fixture-account", "credential-1"); expect(same.accountScopeId).toBe(f.account.accountScopeId); expect(same.accountScopeId).not.toContain("fixture");
    expect(same.holdUntil).toBe(1_600_000);
    code(() => f.state.reserve(f.input(2), f.validate()), 402);
    const b = f.state.reserve(f.input(2), f.validate("message", other)); f.state.finish(b, "complete");
    const restarted = new ReplyState({ db: () => f.db, transaction: f.tx, now: () => 1_000_001 }); restarted.boot();
    expect(restarted.account("fixture-account", "credential-1")).toMatchObject({ accountScopeId: f.account.accountScopeId, holdUntil: 1_600_000 });
    expect(restarted.account("own-eleven", "credential-2").holdUntil).toBe(0);
  });
  it("S-crash-before/after reopens durable claims, interrupts uncertainty and never restores a listening session", () => {
    const dir = mkdtempSync(join(tmpdir(), "d24-ledger-")); directories.push(dir);
    const file = join(dir, "speech.sqlite"); const f = fixture(new DatabaseSync(file)); const event = f.settle();
    const attempt = f.state.reserve({ ...f.input(), action: undefined, settlementId: event.settlementId }, f.validate());
    f.db.close();
    const db = new DatabaseSync(file); databases.push(db);
    const state = new ReplyState({ db: () => db, transaction: speechTransaction(db), now: () => 1_000_050 }); state.boot();
    expect(db.prepare("SELECT state FROM speech_attempts WHERE attempt_id=?").get(attempt.attemptId)?.state).toBe("interrupted");
    expect(db.prepare("SELECT count(*) n FROM speech_attempts WHERE message_id='message' AND mode='automatic'").get()?.n).toBe(1);
    expect(state.account("fixture-account", "credential-1").holdUntil).toBe(1_600_050);
    code(() => state.authorize(f.input()), 409); expect(state.bootId).not.toBe(f.state.bootId);
  });
});

describe("D24 failed durable Stop revocation", () => {
  it.each([true, false])("S-db-remote revokes fully downloaded and queued authority, signal delivery=%s", delivered => {
    const f = fixture(); const a = f.state.reserve(f.input(), f.validate()); f.state.finish(a, "complete");
    f.send.mockReturnValue(delivered);
    f.db.exec("CREATE TRIGGER stop_failure BEFORE UPDATE ON speech_threads BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
    code(() => f.state.invalidate("thread"), 503, "durable_stop_failed");
    expect(f.send).toHaveBeenCalledWith({ kind: "speech.sessionClosed", sessionId: f.session.sessionId, bootId: f.state.bootId, reason: "durable_stop_failed" });
    expect(f.terminate).toHaveBeenCalledTimes(delivered ? 0 : 1);
    code(() => f.state.reserve(f.input(2, "queued"), f.validate("queued")), 409);
    code(() => f.state.session({ ...f.connection, id: "reconnect" }, "thread"), 409);
    expect(() => f.state.recover("thread")).toThrow();
    code(() => f.state.session(f.connection, "thread"), 409);
    f.db.exec("DROP TRIGGER stop_failure"); f.state.recover("thread");
    code(() => f.state.authorize(f.input()), 409);
    expect(f.state.session({ ...f.connection, id: "fresh" }, "thread").sessionId).not.toBe(f.session.sessionId);
  });
  it("a failed 402 write keeps its account held in memory and establishes a fresh hold on restart", () => {
    const f = fixture(); const attempt = f.state.reserve(f.input(), f.validate());
    f.db.exec("CREATE TRIGGER hold_failure BEFORE UPDATE ON speech_accounts BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
    expect(() => f.state.finish(attempt, "budget")).toThrow();
    expect(f.state.account("fixture-account", "credential-1").holdUntil).toBe(1_600_000);
    f.db.exec("DROP TRIGGER hold_failure");
    const state = new ReplyState({ db: () => f.db, transaction: f.tx, now: () => 1_000_010 }); state.boot();
    expect(state.account("fixture-account", "credential-1").holdUntil).toBe(1_600_010);
  });
  it("missing and failed boot state never admit speech", () => {
    const db = new DatabaseSync(":memory:"); databases.push(db);
    const state = new ReplyState({ db: () => db, transaction: speechTransaction(db) });
    expect(() => state.boot()).toThrow();
    code(() => state.session({ id: "c", principal: "p", send: () => true, terminate() {} }, "thread"), 409);
  });
});

it("P-quota keeps an automatic claim after over a thousand later attempts and multiple spend windows", () => {
  const f = fixture(), ready = f.settle();
  const original = f.state.reserve({ ...f.input(), action: undefined, settlementId: ready.settlementId }, f.validate()); f.state.finish(original, "complete");
  for (let index = 0; index < 1001; index++) {
    f.time(2_000_000 + index * 61_000);
    const message = `later-${index}`;
    const attempt = f.state.reserve(f.input(index + 2, message), f.validate(message)); f.state.finish(attempt, "failed");
  }
  expect(f.db.prepare("SELECT count(*) n FROM speech_attempts").get()?.n).toBe(1002);
  expect(f.db.prepare("SELECT attempt_id FROM speech_attempts WHERE message_id='message' AND mode='automatic'").get()?.attempt_id).toBe(original.attemptId);
  code(() => f.state.reserve({ ...f.input(1003), action: undefined, settlementId: ready.settlementId }, f.validate()), 204);
});

it("S-dispose retires completed downloads, rotates authority on fleet disposal, and cannot reuse same-process restored records", () => {
  const f = fixture(), ready = f.settle();
  const attempt = f.state.reserve(f.input(), f.validate()); f.state.finish(attempt, "complete");
  const oldBoot = f.state.bootId;
  f.state.closeAll();
  expect(f.send).toHaveBeenCalledWith({ kind: "speech.sessionClosed", sessionId: f.session.sessionId, bootId: oldBoot, reason: "closed" });
  expect(f.state.bootId).not.toBe(oldBoot); code(() => f.state.authorize(f.input()), 409);
  // Simulate metadata restored from an earlier snapshot taken in this same process.
  f.db.prepare("UPDATE speech_generations SET state='completed' WHERE generation_id=?").run(ready.generationId);
  const fresh = f.state.session({ ...f.connection, id: "new-connection" }, "thread");
  code(() => f.state.reserve({ ...f.input(2), sessionId: fresh.sessionId, connectionId: "new-connection", action: undefined, settlementId: ready.settlementId }, f.validate()), 204);
});
it("S-remote bot disposal invalidates its completed generations without clearing another conversation", () => {
  const f = fixture(); f.settle();
  f.state.begin("other-thread", "other-bot", "other-generation", "other-prompt"); f.state.bind("other-generation", "other-provider");
  f.state.invalidateBot("bot");
  expect(f.state.generation("thread", "provider")?.state).toBe("invalid");
  expect(f.state.generation("other-thread", "other-provider")?.state).toBe("running");
});
it("provider plan versions are durable and separate from their account's shared hold", () => {
  const f = fixture(); const a = f.state.plan(f.account, "plan-a"), b = f.state.plan(f.account, "plan-b");
  expect(a.accountScopeId).toBe(b.accountScopeId); expect(a.planVersion).not.toBe(b.planVersion);
  expect(f.state.plan(f.account, "plan-a").planVersion).toBe(a.planVersion);
  const attempt = f.state.reserve(f.input(), f.validate("message", a)); f.state.finish(attempt, "budget");
  const held = f.state.plan(f.state.account("fixture-account", "credential-1"), "plan-b");
  expect(held.holdUntil).toBeGreaterThan(held.serverNow);
  code(() => f.state.reserve(f.input(2), f.validate("message", held)), 402);
});
