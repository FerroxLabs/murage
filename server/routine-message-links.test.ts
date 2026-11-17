// SPDX-License-Identifier: AGPL-3.0-or-later
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { initializeRoutineMessageLinks, routineMessageAnchor } from "./routine-message-links.ts";
const dbs: DatabaseSync[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const db of dbs.splice(0)) db.close(); });
function fixture() {
  const db = new DatabaseSync(":memory:"); dbs.push(db);
  db.exec("CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(thread_id,id))");
  initializeRoutineMessageLinks(db); return db;
}
function put(db: DatabaseSync, id: string, at: number) { db.prepare("INSERT OR REPLACE INTO messages VALUES(?,?,?)").run("thread", id, at); }
it("P20 stored-order anchors preserve ties and non-monotonic timestamps through append edit delete replace and rollback", () => {
  const db = fixture(); put(db, "a", 100); put(db, "b", 300); put(db, "c", 200); put(db, "d", 300);
  const oracle = (at: number) => (db.prepare("SELECT id FROM messages WHERE thread_id='thread' AND at>=? ORDER BY rowid LIMIT 1").get(at) ?? db.prepare("SELECT id FROM messages WHERE thread_id='thread' ORDER BY rowid DESC LIMIT 1").get()) as { id: string } | undefined;
  const check = () => { for (const at of [0, 100, 101, 200, 201, 300, 301]) expect(routineMessageAnchor(db, "thread", at)).toBe(oracle(at)?.id); };
  check(); db.exec("UPDATE messages SET at=50 WHERE id='b'"); check(); db.exec("DELETE FROM messages WHERE id='c'"); check(); put(db, "a", 400); check();
  db.exec("BEGIN"); put(db, "x", 500); db.exec("DELETE FROM messages WHERE id='d'"); check(); db.exec("ROLLBACK"); check();
  db.exec("DELETE FROM messages WHERE thread_id='thread'"); expect(routineMessageAnchor(db, "thread", 0)).toBeUndefined();
});
it("P20 anchors migrate legacy messages once and query fixed work at 100 and 2,000 rows", () => {
  const calls = [];
  for (const size of [100, 2_000]) {
    const db = new DatabaseSync(":memory:"); dbs.push(db); db.exec("CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(thread_id,id))");
    for (let i = 0; i < size; i++) put(db, `m-${i}`, i % 2 ? 200 : 100);
    initializeRoutineMessageLinks(db); const sql = vi.spyOn(db, "prepare");
    expect(routineMessageAnchor(db, "thread", 200)).toBe("m-1"); calls.push(sql.mock.calls.length);
    expect(sql.mock.calls.every(([query]) => !query.includes("FROM messages"))).toBe(true); sql.mockRestore();
    put(db, "fresh", 300); expect(routineMessageAnchor(db, "thread", 300)).toBe("fresh");
  }
  expect(calls).toEqual([17, 17]); console.info("P20-anchor-work", JSON.stringify({ sizes: [100, 2_000], calls }));
});
it("P20 the loaded Store path uses the same bounded anchor query", () => {
  const source = readFileSync(new URL("./store.ts", import.meta.url), "utf8"), start = source.indexOf("  firstMessageSince(threadId: string, at: number)");
  const body = source.slice(start, source.indexOf("\n  messagesFor(", start));
  const read = vi.fn(() => ({ id: "live", at: 10 }));
  const method = new Function("mdb", `return function(threadId, at) { ${body.slice(body.indexOf("{\n") + 2, body.lastIndexOf("}"))} }`.replaceAll("row ? this.loadedMessages([row])[0] : undefined", "row ? this.loadedMessages([row])[0] : undefined"))({ firstMessageSince: read });
  const context = { threads: { get: () => ({ messages: new Proxy([], { get: () => { throw new Error("loaded transcript walked"); } }) }) }, loadedMessages: (rows: unknown[]) => rows };
  expect(() => method.call(context, "thread", 5)).not.toThrow();
  expect(method.call(context, "thread", 5)?.id).toBe("live"); expect(read).toHaveBeenCalledWith("thread", 5);
});

it("P20 routine-link schema is accepted by snapshots and removable on downgrade", async () => {
  const { APP_SCHEMA_102_ADDITIONS } = await import("./installation-app-schema-downgrade.ts");
  const { ADDED_TABLE_LIFECYCLE } = await import("./added-table-lifecycle.ts");
  const db = fixture();
  for (const row of db.prepare("SELECT type,name FROM sqlite_schema WHERE name LIKE 'routine_link_%'").all() as Array<{ type: string; name: string }>) {
    const group = row.type === "table" ? "tables" : row.type === "trigger" ? "triggers" : "indexes";
    expect(APP_SCHEMA_102_ADDITIONS[group], `snapshot/downgrade registration for ${row.name}`).toContain(row.name);
    if (row.type === "table") expect(ADDED_TABLE_LIFECYCLE[row.name]).toMatchObject({ kind: "marker" });
  }
  for (const [kind, names] of [["TRIGGER", APP_SCHEMA_102_ADDITIONS.triggers], ["INDEX", APP_SCHEMA_102_ADDITIONS.indexes], ["TABLE", APP_SCHEMA_102_ADDITIONS.tables]] as const)
    for (const name of names.filter(name => name.startsWith("routine_link_"))) db.exec(`DROP ${kind} ${name}`);
  expect(db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'routine_link_%'").all()).toEqual([]);
  initializeRoutineMessageLinks(db); put(db, "after-upgrade", 42); expect(routineMessageAnchor(db, "thread", 42)).toBe("after-upgrade");
});
