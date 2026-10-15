// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.2 pre-release, owner sends: the owner's words are kept until a transcript commit or an owner dismiss.
//   S4 the 1.0.1 queued-messages.json import never loses a line and never doubles one
//   S5 a restored backup never runs what was waiting when it was taken
//   S6 a rolled-back outer transaction leaves no phantom message in the cache, the events or the parent chain
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { closeDatabase, database, transaction } from "./database.ts";
import { initializeOwnerSends, neutralizeRestoredSends, SendStore } from "./send-store.ts";
import { importLegacyQueueFile, recoverMirroredQueue, type SteerQueueEntries } from "./steer-queue.ts";
import { Store } from "./store.ts";
import { sendFingerprint } from "./send-idempotency.ts";
import { scopedTx } from "./tx-scope.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "pm-sends-")); dirs.push(d); return d; };

/** A store whose lines survive a "restart" (the same instance is reused) and that honours stable ids. */
function lineStore(failAt?: number) {
  const lines: Array<{ id: string; sendId?: string; text: string }> = [];
  let calls = 0;
  return {
    lines,
    messagesFor: () => lines.slice(),
    appendMessage(_thread: string, message: { text: string; sendId?: string }, stableId?: string) {
      if (stableId && lines.some((l) => l.id === stableId)) return lines.find((l) => l.id === stableId);
      calls += 1;
      if (failAt !== undefined && calls === failAt) throw new Error("disk full");
      const line = { id: stableId ?? `m${lines.length}`, text: message.text, ...(message.sendId ? { sendId: message.sendId } : {}) };
      lines.push(line);
      return line;
    },
  };
}
/** A transaction that undoes the lines written inside it when it throws. */
const rollbackOn = (store: ReturnType<typeof lineStore>) => <T,>(work: () => T): T => {
  const before = store.lines.length;
  try { return work(); } catch (error) { store.lines.length = before; throw error; }
};

describe("S4 legacy queued-messages.json import", () => {
  const entries = (): SteerQueueEntries => [["t1", { botId: "b1", items: [
    { messageId: "q1", text: "first", prompt: "first" },
    { messageId: "q2", text: "second", prompt: "second" },
    { messageId: "q3", text: "third", prompt: "third" },
  ] }]];

  it("a failed import keeps the file and loses nothing; the next start finishes it", () => {
    const file = join(tmp(), "queued-messages.json");
    writeFileSync(file, JSON.stringify(entries()));
    const store = lineStore(2); // the second append fails
    const logs: string[] = [];
    const first = importLegacyQueueFile(file, store, { atomically: rollbackOn(store), log: (m) => logs.push(m) });
    expect(first.removed).toBe(false);
    expect(existsSync(file)).toBe(true);
    expect(store.lines).toHaveLength(0); // all of the thread's lines or none
    expect(logs.join(" ")).toMatch(/kept/);
    const second = importLegacyQueueFile(file, store, { atomically: rollbackOn(store), log: (m) => logs.push(m) });
    expect(second.removed).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(store.lines.map((l) => l.text)).toEqual(["first", "second", "third"]);
  });

  it("an unreadable file is kept and reported, never deleted", () => {
    const file = join(tmp(), "queued-messages.json");
    writeFileSync(file, "{ not json");
    const logs: string[] = [];
    expect(importLegacyQueueFile(file, lineStore(), { log: (m) => logs.push(m) }).removed).toBe(false);
    expect(readFileSync(file, "utf8")).toBe("{ not json");
    expect(logs.length).toBe(1);
  });

  it("a crash after the import and before the unlink adds each line exactly once, even with no sendId", () => {
    const store = lineStore();
    const waiting: SteerQueueEntries = [["t1", { botId: "b1", items: [
      { messageId: "", text: "same words", prompt: "same words" },
      { messageId: "", text: "same words", prompt: "same words" }, // two identical lines are two lines
      { messageId: "q9", text: "other", prompt: "other" },
    ] }]];
    expect(recoverMirroredQueue(waiting, store, { atomically: (w) => w() }).complete).toBe(true);
    expect(store.lines).toHaveLength(3);
    // the file was never removed: the next start reads it again
    const again = recoverMirroredQueue(waiting, store, { atomically: (w) => w() });
    expect(again).toMatchObject({ added: 0, complete: true });
    expect(store.lines.map((l) => l.text)).toEqual(["same words", "same words", "other"]);
  });

  it("an empty registry (bots.json missing) destroys nothing: every line is kept and the file stays", () => {
    const file = join(tmp(), "queued-messages.json");
    writeFileSync(file, JSON.stringify(entries()));
    const store = lineStore();
    const logs: string[] = [];
    const out = importLegacyQueueFile(file, store, { threadIsLive: () => false, atomically: (w) => w(), log: (m) => logs.push(m) });
    expect(out.removed).toBe(false);
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(entries());
    // the registry comes back: the same file now imports in full, once
    const again = importLegacyQueueFile(file, store, { threadIsLive: () => true, atomically: (w) => w(), log: (m) => logs.push(m) });
    expect(again.removed).toBe(true);
    expect(store.lines.map((l) => l.text)).toEqual(["first", "second", "third"]);
  });

  it("only a durable owner-deletion record lets an unrecognised conversation's lines go; the rest still import", () => {
    const store = lineStore();
    const waiting: SteerQueueEntries = [["gone", { botId: "b", items: [{ messageId: "a", text: "x", prompt: "x" }] }], ...entries()];
    const unproven = recoverMirroredQueue(waiting, store, { threadIsLive: (t) => t !== "gone", atomically: (w) => w() });
    expect(unproven.complete).toBe(false);
    const proven = recoverMirroredQueue(waiting, store, { threadIsLive: (t) => t !== "gone", ownerDeleted: (t) => t === "gone", atomically: (w) => w() });
    expect(proven.complete).toBe(true);
    expect(store.lines.map((l) => l.text)).toEqual(["first", "second", "third"]);
  });
});

describe("S5 restored backup never runs what was waiting", () => {
  it("queued and sending rows become Send again chips; nothing drains or recovers into a run", () => {
    const db = new DatabaseSync(":memory:");
    initializeOwnerSends(db);
    const source = new SendStore(() => db);
    const make = (text: string, status: "queued" | "sending", sendId: string) => source.accept({ kind: "bot", ownerId: "b1", threadId: "t1", text, sendId, fingerprint: sendFingerprint(text), status });
    make("queued words", "queued", "s1");
    make("deciding words", "sending", "s2");
    const restored = new SendStore(() => db);
    expect(neutralizeRestoredSends(db)).toBe(2);
    const { requeued } = restored.recover();
    expect(requeued).toHaveLength(0);
    expect(restored.queuedThreads("bot")).toEqual([]);
    expect(restored.drainable("t1", "bot")).toHaveLength(0);
    const rows = db.prepare("SELECT status, text, notice FROM owner_sends ORDER BY seq").all() as Array<{ status: string; text: string; notice: string }>;
    expect(rows.map((r) => r.status)).toEqual(["refused", "refused"]);
    expect(rows.map((r) => r.text)).toEqual(["queued words", "deciding words"]);
    // the owner's explicit choice still works: dismiss
    const chip = restored.bySendId("t1", "s1")!;
    expect(restored.cancel("b1", chip.queueId)).not.toBeNull();
  });

  it("a backup from before the notice column still restores", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE owner_sends (seq INTEGER PRIMARY KEY, kind TEXT NOT NULL, owner_id TEXT NOT NULL, thread_id TEXT NOT NULL, send_id TEXT, queue_id TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, text TEXT, prompt TEXT, reply_to_id TEXT, origin TEXT, mode TEXT, responder_id TEXT, existing_message_id TEXT, message_id TEXT, status TEXT NOT NULL, dispatched INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    db.prepare("INSERT INTO owner_sends (kind,owner_id,thread_id,queue_id,fingerprint,text,status,created_at,updated_at) VALUES ('bot','b','t','q','f','keep me','queued',1,1)").run();
    expect(neutralizeRestoredSends(db)).toBe(1);
    expect(db.prepare("SELECT status, text, notice FROM owner_sends").get()).toMatchObject({ status: "refused", text: "keep me", notice: "refused" });
  });
});

describe("S5b restore-held sends are not run by a retry of the same send id", () => {
  const setup = () => {
    const db = new DatabaseSync(":memory:");
    initializeOwnerSends(db);
    const store = new SendStore(() => db);
    store.accept({ kind: "bot", ownerId: "b1", threadId: "t1", text: "do the thing", sendId: "s1", fingerprint: sendFingerprint("do the thing"), status: "queued" });
    neutralizeRestoredSends(db);
    return { db, store };
  };
  const input = { kind: "bot" as const, ownerId: "b1", threadId: "t1", text: "do the thing", sendId: "s1", fingerprint: sendFingerprint("do the thing") };

  it("a lost-ack POST retry with the restored sendId is not admitted; the chip and its words stay", () => {
    const { store } = setup();
    const retry = store.accept(input);
    expect(retry.kind).toBe("existing");
    expect(retry.row.restoreHeld).toBe(true);
    expect(retry.row.status).toBe("refused");
    expect(store.bySendId("t1", "s1")).toMatchObject({ status: "refused", text: "do the thing" });
    expect(store.drainable("t1", "bot")).toHaveLength(0);
  });

  it("the owner's explicit Send again (resend) is admitted as a fresh attempt", () => {
    const { store } = setup();
    const again = store.accept({ ...input, resend: true, restoreGen: store.bySendId("t1", "s1")!.restoreGen! });
    expect(again.kind).toBe("new");
    expect(again.row.restoreHeld).toBe(false);
    expect(again.row.status).toBe("sending");
  });

  it("an ordinary refused chip (not from a restore) is still replaced by a plain retry", () => {
    const db = new DatabaseSync(":memory:");
    initializeOwnerSends(db);
    const store = new SendStore(() => db);
    const first = store.accept({ ...input, status: "refused", notice: "refused" });
    expect(first.row.restoreHeld).toBe(false);
    expect(store.accept(input).kind).toBe("new");
  });
});

describe("S6 a rolled-back outer transaction publishes nothing", () => {
  beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); });

  const chain = (store: Store, threadId: string) => store.messagesFor(threadId).map((m) => m.id);

  it("sendStore.settleWithLine rollback: no phantom message in the cache, the events or the parent chain", () => {
    const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
    const bot = store.createBot({}, { seedMessages: false });
    const sends = new SendStore(() => database());
    const events: string[] = [];
    store.onChange((c) => { if (c.type === "message" || c.type === "message.patch") events.push(`${c.type}:${c.message.id}`); });
    const base = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "base" });
    events.length = 0;
    const row = sends.accept({ kind: "bot", ownerId: bot.id, threadId: bot.threadId, text: "w", fingerprint: sendFingerprint("w"), status: "queued" });
    expect(() => sends.settleWithLine(row.kind === "new" ? row.row.seq : -1, "started", "line-1", () => {
      store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "phantom" }, "line-1");
      store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "notice" });
      throw new Error("the second write failed");
    })).toThrow(/second write/);
    expect(chain(store, bot.threadId)).toEqual([base.id]);
    expect(events).toEqual([]);
    const next = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "after" });
    expect(next.parentId).toBe(base.id);
    expect(chain(store, bot.threadId)).toEqual([base.id, next.id]);
    // a reload from SQLite agrees with the cache
    expect(new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" })).messagesFor(bot.threadId).map((m) => m.id)).toEqual([base.id, next.id]);
  });

  it("a commit announces the messages only after it commits, in order", () => {
    const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
    const bot = store.createBot({}, { seedMessages: false });
    const seen: Array<{ id: string; inTx: boolean }> = [];
    store.onChange((c) => { if (c.type === "message") seen.push({ id: c.message.id, inTx: database().isTransaction }); });
    let a = "", b = "";
    transaction(() => {
      a = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "a" }).id;
      b = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "b" }).id;
      expect(seen).toEqual([]);
    });
    expect(seen).toEqual([{ id: a, inTx: false }, { id: b, inTx: false }]);
  });

  it("the generic transaction() wrapper rolls the cache back too (projectRoutine pattern)", () => {
    const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
    const bot = store.createBot({}, { seedMessages: false });
    const events: string[] = [];
    store.onChange((c) => { if (c.type === "message") events.push(c.message.id); });
    expect(() => transaction(() => {
      store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "x" });
      throw new Error("boom");
    })).toThrow(/boom/);
    expect(store.messagesFor(bot.threadId)).toHaveLength(0);
    expect(events).toEqual([]);
  });
});

describe("S6b send chips are announced only after the commit", () => {
  const make = () => {
    const db = new DatabaseSync(":memory:");
    const sends = new SendStore(() => db);
    const seen: Array<{ threadId: string; inTx: boolean }> = [];
    sends.setObserver((threadId) => seen.push({ threadId, inTx: db.isTransaction }));
    return { db, sends, seen };
  };
  const queued = (sends: SendStore) => {
    const r = sends.accept({ kind: "bot", ownerId: "b1", threadId: "t1", text: "w", sendId: "s1", fingerprint: sendFingerprint("w"), status: "queued" });
    return r.row.seq;
  };

  it("a rolled-back settleWithLine inside an outer transaction publishes no chip change", () => {
    const { db, sends, seen } = make();
    const seq = queued(sends);
    seen.length = 0;
    expect(() => scopedTx(() => {
      db.exec("SAVEPOINT outer_owner");
      try {
        sends.settleWithLine(seq, "started", "line-1", () => ({ id: "line-1" }));
        throw new Error("outer failed");
      } catch (error) { db.exec("ROLLBACK TO outer_owner; RELEASE outer_owner"); throw error; }
    })).toThrow(/outer failed/);
    expect(seen).toEqual([]);
    expect(sends.bySeq(seq)?.status).toBe("queued");
  });

  it("a raw SAVEPOINT owner announces after RELEASE, never inside, and nothing after a rollback", () => {
    const { db, sends, seen } = make();
    const seq = queued(sends);
    seen.length = 0;
    scopedTx(() => {
      db.exec("SAVEPOINT raw_owner");
      sends.settleWithLine(seq, "started", "line-1", () => ({ id: "line-1" }));
      expect(seen).toEqual([]);
      db.exec("RELEASE raw_owner");
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => !s.inTx)).toBe(true);
    const second = sends.accept({ kind: "bot", ownerId: "b1", threadId: "t1", text: "w2", sendId: "s2", fingerprint: sendFingerprint("w2"), status: "queued" }).row.seq;
    seen.length = 0;
    expect(() => scopedTx(() => {
      db.exec("SAVEPOINT raw_owner2");
      sends.settleWithLine(second, "started", "line-2", () => ({ id: "line-2" }));
      db.exec("ROLLBACK TO raw_owner2; RELEASE raw_owner2");
      throw new Error("refused afterwards");
    })).toThrow();
    expect(seen).toEqual([]);
  });

  it("a result-level rollback (scopedTx rolledBack) publishes nothing", () => {
    const { sends, seen } = make();
    const seq = queued(sends);
    seen.length = 0;
    scopedTx(() => { sends.settleWithLine(seq, "started", "line-1", () => ({ id: "line-1" })); return { status: 409 }; }, (r) => r.status >= 400);
    expect(seen).toEqual([]);
  });
});
