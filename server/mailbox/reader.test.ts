// M3 local reader (email design r9 section 8): the MailReadPort EmailTools calls for a mailbox bot, over the mailbox tables.
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { LocalMailboxReader, MAILBOX_LIST_CAP, localMailboxBinding, mailboxAccount, pruneInbound, saveMailboxAccount, storeInbound } from "./reader.ts";

const mail = (n: number, thread = "t1") => ({ id: `m${n}`, threadId: thread, receivedAt: 1_700_000_000_000 + n * 1000, from: "sender@example.test", to: ["owner@example.test"], subject: `Subject ${n}`, text: `Body ${n}` });
function fixture() {
  const db = new DatabaseSync(":memory:");
  saveMailboxAccount(db, "bot-1", "inbox-1", true);
  return { db, reader: new LocalMailboxReader(() => db) };
}

it("an install with no mailbox has no tables and no binding", () => {
  const db = new DatabaseSync(":memory:");
  expect(mailboxAccount(db, "bot-1")).toBeUndefined();
  expect(localMailboxBinding(() => db, "bot-1", () => "complete")).toBeUndefined();
  expect(db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name LIKE 'mailbox_%'").get()!.n).toBe(0);
  expect(() => storeInbound(db, "inbox-1", mail(1))).toThrow(/not connected/);
});

it("the read tick off gives no binding; on gives the account's inbox", () => {
  const { db } = fixture();
  expect(localMailboxBinding(() => db, "bot-1", () => "complete")?.inboxId).toBe("inbox-1");
  saveMailboxAccount(db, "bot-1", "inbox-1", false);
  expect(localMailboxBinding(() => db, "bot-1", () => "complete")).toBeUndefined();
});

it("stores a message once and reads it back by id and thread, newest last in a thread", async () => {
  const { db, reader } = fixture();
  expect(storeInbound(db, "inbox-1", mail(1))).toBe(true);
  expect(storeInbound(db, "inbox-1", { ...mail(1), text: "replaced" })).toBe(false);
  storeInbound(db, "inbox-1", mail(2));
  const one = await reader.getMessage(null as never, "inbox-1", "m1") as any;
  expect(one.kind).toBe("ok");
  expect(one.body.text).toBe("Body 1");
  expect(one.body.sender_authenticated).toBeUndefined();
  const thread = await reader.getThread(null as never, "inbox-1", "t1") as any;
  expect(thread.body.messages.map((m: any) => m.id)).toEqual(["m1", "m2"]);
  expect((await reader.getMessage(null as never, "other-inbox", "m1") as any).kind).toBe("refused");
  expect((await reader.getThread(null as never, "inbox-1", "nope") as any).code).toBe("thread_not_found");
});

it("lists at most the cap, newest first, with a preview and no body", async () => {
  const { db, reader } = fixture();
  for (let n = 0; n < 40; n++) storeInbound(db, "inbox-1", mail(n, n % 2 ? "odd" : "even"));
  const listed = await reader.listMessages(null as never, "inbox-1", { limit: 99 }) as any;
  expect(listed.body.data).toHaveLength(MAILBOX_LIST_CAP);
  expect(listed.body.data[0].id).toBe("m39");
  expect(listed.body.data[0].text).toBeUndefined();
  expect(listed.body.data[0].preview).toBe("Body 39");
  const odd = await reader.listMessages(null as never, "inbox-1", { thread_id: "odd", limit: 5 }) as any;
  expect(odd.body.data.map((m: any) => m.id)).toEqual(["m39", "m37", "m35", "m33", "m31"]);
  expect((await reader.listMessages(null as never, "inbox-1", { direction: "outbound" }) as any).body.data).toEqual([]);
});

it("refuses a malformed message whole and prunes past the keep count in one bounded batch", () => {
  const { db } = fixture();
  expect(() => storeInbound(db, "inbox-1", { ...mail(1), to: "not-a-list" as never })).toThrow(/refused/);
  expect(() => storeInbound(db, "inbox-1", { ...mail(1), text: "x".repeat(1_000_001) })).toThrow(/refused/);
  for (let n = 0; n < 10; n++) storeInbound(db, "inbox-1", mail(n));
  expect(pruneInbound(db, "inbox-1", 4)).toBe(6);
  expect(db.prepare("SELECT message_id FROM mailbox_messages ORDER BY received_at").all().map(row => row.message_id)).toEqual(["m6", "m7", "m8", "m9"]);
});
