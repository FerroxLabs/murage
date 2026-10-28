// S29: the via columns on owner_sends rows (share and ask-intent), their carry-over on a replaced row, and Message.via on the store.
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { neutralizeRestoredSends, recoveredSteerLine, SendStore, type AcceptResult, type SendRow } from "./send-store.ts";
import { Store } from "./store.ts";
import type { ModelSelection } from "./contracts.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const FILES: NonNullable<SendRow["attachments"]> = [
  { kind: "image", path: "/a/x.jpg", mime: "image/jpeg" },
  { kind: "file", path: "/a/y.pdf", mime: "application/pdf" },
];
const shareInput = (over: Record<string, unknown> = {}) => ({
  kind: "bot" as const, ownerId: "b1", threadId: "t1", fingerprint: "f", text: "x", status: "queued" as const, origin: "unproven",
  via: "share" as const, queueOnly: true as const, viaDevice: "d1", attachments: FILES, ...over,
});
const newRow = (r: AcceptResult): SendRow => { expect(r.kind).toBe("new"); return (r as { row: SendRow }).row; };
const mem = () => new SendStore(() => db);
let db: DatabaseSync;
beforeEach(() => { db = new DatabaseSync(":memory:"); });

describe("owner_sends via columns", () => {
  it("an older table gains the columns and old rows read as plain", () => {
    const old = new DatabaseSync(":memory:");
    old.exec("CREATE TABLE owner_sends (seq INTEGER PRIMARY KEY, kind TEXT NOT NULL, owner_id TEXT NOT NULL, thread_id TEXT NOT NULL, send_id TEXT, queue_id TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, text TEXT, prompt TEXT, reply_to_id TEXT, origin TEXT, mode TEXT, responder_id TEXT, existing_message_id TEXT, message_id TEXT, status TEXT NOT NULL, dispatched INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
    old.exec("INSERT INTO owner_sends (kind, owner_id, thread_id, queue_id, fingerprint, text, status, created_at, updated_at) VALUES ('bot','b1','t1','q1','f','hi','queued',1,1)");
    const s = new SendStore(() => old);
    const [row] = s.queuedRows("t1", "bot");
    expect(row).toMatchObject({ via: null, queueOnly: false, viaDevice: null, attachments: null });
  });

  it("persists a share row and refuses a via row that is not queue-only and unproven", () => {
    const s = mem();
    const a = s.accept(shareInput());
    expect(a.kind).toBe("new");
    expect(s.bySeq((a as { row: SendRow }).row.seq)).toMatchObject({ via: "share", queueOnly: true, viaDevice: "d1", attachments: FILES });
    expect(() => s.accept(shareInput({ fingerprint: "g", text: "y", origin: "desktop" }))).toThrow();
    expect(() => s.accept(shareInput({ fingerprint: "h", text: "z", queueOnly: undefined }))).toThrow();
  });

  it("a malformed attachments column reads as null", () => {
    const s = mem();
    const row = newRow(s.accept(shareInput()));
    db.prepare("UPDATE owner_sends SET attachments=? WHERE seq=?").run("{not json", row.seq);
    expect(s.bySeq(row.seq)).toMatchObject({ via: "share", attachments: null });
    db.prepare("UPDATE owner_sends SET attachments=? WHERE seq=?").run(JSON.stringify([{ kind: "image", path: 3 }]), row.seq);
    expect(s.bySeq(row.seq)?.attachments).toBeNull();
  });

  it("replacing a refused via row keeps via, queue-only, device, files and unproven origin, even when the input omits them", () => {
    const s = mem();
    const first = newRow(s.accept(shareInput({ sendId: "S" })));
    s.refuse(first.seq);
    const again = s.accept({ kind: "bot", ownerId: "b1", threadId: "t1", sendId: "S", fingerprint: "f", text: "x", origin: "desktop", resend: true, actionId: "a1" });
    const row = newRow(again);
    expect(row).toMatchObject({ via: "share", queueOnly: true, viaDevice: "d1", attachments: FILES, origin: "unproven" });
    expect(row.queueId).not.toBe(first.queueId);
    expect((db.prepare("SELECT COUNT(*) AS n FROM owner_sends WHERE send_id='S'").get() as { n: number }).n).toBe(1);
  });

  it("a replay of the same actionId, a restore-held row and a stopped row are returned as existing, never replaced", () => {
    const s = mem();
    const first = newRow(s.accept(shareInput({ sendId: "S" })));
    s.refuse(first.seq);
    const press = { kind: "bot" as const, ownerId: "b1", threadId: "t1", sendId: "S", fingerprint: "f", text: "x", origin: "desktop", resend: true, actionId: "a1" };
    const second = newRow(s.accept(press));
    s.refuse(second.seq);
    const replay = s.accept(press);
    expect(replay.kind).toBe("existing");
    expect((replay as { row: SendRow }).row.seq).toBe(second.seq);

    const held = newRow(s.accept(shareInput({ sendId: "H", fingerprint: "fh", text: "h" })));
    neutralizeRestoredSends(db);
    const heldAgain = s.accept({ kind: "bot", ownerId: "b1", threadId: "t1", sendId: "H", fingerprint: "fh", text: "h", origin: "desktop" });
    expect(heldAgain.kind).toBe("existing");
    expect(s.bySeq(held.seq)).toBeDefined();

    const stopped = newRow(s.accept(shareInput({ threadId: "t2", sendId: "T", fingerprint: "ft", text: "t" })));
    s.markStopped("t2");
    s.refuse(stopped.seq);
    const stoppedAgain = s.accept({ kind: "bot", ownerId: "b1", threadId: "t2", sendId: "T", fingerprint: "ft", text: "t", origin: "desktop", resend: true, actionId: "a9" });
    expect(stoppedAgain.kind).toBe("existing");
    expect(s.bySeq(stopped.seq)).toBeDefined();
  });

  it("an input via that differs from the refused row's via throws and leaves the row", () => {
    const s = mem();
    const first = newRow(s.accept(shareInput({ sendId: "S" })));
    s.refuse(first.seq);
    expect(() => s.accept(shareInput({ sendId: "S", via: "ask-intent", resend: true, actionId: "a1" }))).toThrow();
    expect(s.bySeq(first.seq)).toMatchObject({ status: "refused", via: "share" });
  });

  it("a plain refused row is replaced as before and stays plain", () => {
    const s = mem();
    const first = s.accept({ kind: "bot", ownerId: "b1", threadId: "t1", sendId: "P", fingerprint: "p", text: "p", origin: "desktop" });
    s.refuse(newRow(first).seq);
    const row = newRow(s.accept({ kind: "bot", ownerId: "b1", threadId: "t1", sendId: "P", fingerprint: "p", text: "p", origin: "desktop", resend: true, actionId: "a1" }));
    expect(row).toMatchObject({ via: null, queueOnly: false, attachments: null, origin: "desktop" });
  });
});

describe("Message.via", () => {
  const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
  beforeEach(() => { removeTempDirSync(DATA_DIR); });

  it("round-trips through appendMessage and the transcript read, and patchMessage cannot change it", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const line = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "shared words", origin: "unproven", via: "share" });
    expect(store.messagesFor(bot.threadId).find((m) => m.id === line.id)?.via).toBe("share");
    store.patchMessage(bot.threadId, line.id, { via: "ask-intent", text: "edited" });
    const after = store.messagesFor(bot.threadId).find((m) => m.id === line.id);
    expect(after).toMatchObject({ via: "share", text: "edited" });
    const plain = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "plain" });
    store.patchMessage(bot.threadId, plain.id, { via: "share" });
    expect(store.messagesFor(bot.threadId).find((m) => m.id === plain.id)?.via).toBeUndefined();
  });
});

describe("crash recovery of a via row (Opus S2 M1)", () => {
  it("writes the recovered line with via and unproven standing, and the edit route's guard reads it", () => {
    const s = mem();
    const row = newRow(s.accept(shareInput({ attachments: null })));
    s.markDispatchedMany([row.seq]);
    const restarted = new SendStore(() => db);
    const { unresolved } = restarted.recover();
    expect(unresolved.map((r) => r.seq)).toEqual([row.seq]);
    removeTempDirSync(DATA_DIR);
    const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
    const bot = store.createBot();
    restarted.completeUnresolved(unresolved, {
      landed: () => undefined,
      appendReceipt: (r, lineId) => { store.appendMessage(bot.threadId, { ...recoveredSteerLine(r, "steer-1"), ...(r.origin ? { origin: r.origin as never } : {}) }, lineId); },
    });
    const line = store.messagesFor(bot.threadId).find((m) => m.text === "x");
    // the edit route answers 409 on `if (source.via)`; a line without it would be an ordinary user line the owner could edit into a turn
    expect(line).toMatchObject({ via: "share", origin: "unproven", steered: true, steerUnconfirmed: true });
    expect(Boolean(line?.via)).toBe(true);
  });
});
