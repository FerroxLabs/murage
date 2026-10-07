// A running server writes a line for every tool call that worked, and each
// one used to empty the Inbox memo, so the polls that follow rescanned every
// bot message of every thread (196 ms per scan on the real store, 76 a
// minute). Only a line the Inbox projection can read may move its version.
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { insertMessage } from "./message-db.ts";
import { messagesVersion } from "./inbox-version.ts";
import { listInboxCached, owedThreadsCached, type InboxAccess } from "./inbox.ts";
import type { Message } from "./store.ts";

const access: InboxAccess = { owner: true, threads: [{ threadId: "t", label: "Bot" }] };
const msg = (id: string, extra: Record<string, unknown>): Message => ({ id, at: 1, role: "bot", kind: "text", text: "x", ...extra }) as Message;
beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });

/** Counts the RUNS (get, all, run) of statements whose SQL contains `needle`,
 * from the moment of the call on: a statement held and reused still counts. */
function runCounter(db: ReturnType<typeof database>, needle: string): () => number {
  const real = db.prepare.bind(db); let runs = 0;
  (db as any).prepare = (sql: string) => {
    const statement = real(sql);
    if (!sql.includes(needle)) return statement;
    return new Proxy(statement, { get(target, key) {
      const value = (target as any)[key];
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => { if (key === "get" || key === "all" || key === "run" || key === "iterate") runs++; return value.apply(target, args); };
    } });
  };
  return () => runs;
}

it("100 polls between 100 successful tool-call lines run the projection at most once per kind of poll", () => {
  const db = database(), runs = runCounter(db, "WITH raw AS");
  for (let i = 0; i < 400; i++) insertMessage("t", msg(`seed${i}`, { kind: "activity", tool: { name: "Bash", ok: true } }));
  listInboxCached(db, { view: "decisions" }, access); owedThreadsCached(db, access);
  const before = runs();
  for (let i = 0; i < 100; i++) {
    insertMessage("t", msg(`a${i}`, { kind: "activity", tool: { name: "Bash", ok: i % 2 === 0 } }));
    listInboxCached(db, { view: "decisions" }, access); owedThreadsCached(db, access);
  }
  expect(runs() - before).toBeLessThanOrEqual(2);
});

it("a line the Inbox can read still moves the version at once", () => {
  const db = database();
  expect(listInboxCached(db, { view: "decisions" }, access).decisions).toBe(0);
  const before = messagesVersion();
  insertMessage("t", msg("auth", { kind: "activity", tool: { name: "Gmail", ok: false, authRequired: true } }));
  expect(messagesVersion()).toBe(before + 1);
  insertMessage("t", msg("prov", { kind: "activity", tool: { name: "P", ok: false, providerError: { code: "x" } } }));
  insertMessage("t", msg("dig", { kind: "activity", actorKind: "murage", murage: { kind: "status", digestDay: "2026-10-05" } }));
  expect(messagesVersion()).toBe(before + 3);
  insertMessage("t", msg("c", { kind: "options", card: { requestId: "r", options: ["Allow"], tool: "Bash" } }));
  expect(listInboxCached(db, { view: "decisions" }, access).decisions).toBeGreaterThan(0);
  expect([...owedThreadsCached(db, access)]).toEqual(["t"]);
});
