// Memory schema v6 (1.0, round 3 item 3): output lineage tables, added
// additively. The upgrade runs on a COPY of a used data dir: a realistic v5
// messages.db made by this build's own paths (a disclosure under a receipt,
// its reply X', an OFF reply Y after it, owner lines, a reply before any
// disclosure, a thread that never used memory), stepped down to v5 by the
// exact inverse. Every existing row is kept byte for byte, except the
// memory-shape-check binding marker that every open of a new schema version
// rewrites; the backfill points Y at the root set {X'}; once X is revoked, Y
// is withheld. The inverse runs too.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { memoryAccess, reconcileMemoryRoster, type MemoryAccess, type MemoryRoster } from "./policy.ts";
import { captureSource } from "./capture.ts";
import { ownerMemoryTicket, saveMemoryCandidate } from "./authority.ts";
import { forgetMemory } from "./forget.ts";
import { buildMemoryBundle } from "./bundle.ts";
import { MemoryDispatchReceipt } from "./dispatch.ts";
import { replayExclusions } from "./replay-lineage.ts";
import { setMemoryMode } from "./repository.ts";
import { downgradeMemorySchema, MEMORY_SCHEMA_VERSION, migrateMemorySchema, validateMemorySchema } from "./schema.ts";

const roster: MemoryRoster = { bots: [{ id: "dax", threadId: "dax-direct" }, { id: "moss", threadId: "moss-direct" }], groups: [] };
const thread = "dax-direct";
const NEW_TABLES = ["memory_output_roots", "memory_session_roots", "memory_root_sets", "memory_root_set_members", "memory_lineage_meta"];
let copyDir: string;
beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); copyDir = mkdtempSync(join(tmpdir(), "murage-v6-copy-")); });
afterEach(() => { closeDatabase(); rmSync(copyDir, { recursive: true, force: true }); });
function access(): MemoryAccess {
  const registry = new InternalCapabilities(); registry.begin("dax", thread, "g");
  return memoryAccess(registry, registry.resolve(`Bearer ${registry.mint({ botId: "dax", threadId: thread, generation: "g", depth: 0, kind: "memory", skillAuthoring: false })}`)!, () => roster);
}
const empty = { async search() { return { hits: [], vectorRows: 0, coverageComplete: false }; } };
const message = (threadId: string, id: string, at: number, role: "user" | "bot", text: string) =>
  database().prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,'text',?,?)")
    .run(threadId, id, at, role, text, JSON.stringify({ id, at, role, kind: "text", text }));

/** A used v5 data dir: the app's own writes, then the exact v6 -> v5 inverse. */
async function usedV5DataDir(): Promise<string> {
  setMemoryMode("active"); reconcileMemoryRoster(roster);
  message(thread, "early", 5, "bot", "Hello, how can I help?");
  message(thread, "ask-1", 10, "user", "The vault code is 7731.");
  captureSource(database(), { id: "src-x", threadId: thread, messageId: "ask-1", kind: "text", speaker: "owner", outcome: "recorded", text: "The vault code is 7731." });
  const id = saveMemoryCandidate("The vault code is 7731.", [{ sourceId: "src-x", revision: 1, startByte: 0, endByte: 23 }], "k-x", access());
  database().prepare("UPDATE memory_records SET state='active', owner_pinned=1 WHERE id=?").run(id);
  const a = access();
  const receipt = new MemoryDispatchReceipt(await buildMemoryBundle("vault", a, empty), a, "claude");
  receipt.sessionStarted("s-active"); receipt.accepted(); receipt.output("x-prime");
  message(thread, "x-prime", 11, "bot", "Your vault code is 7731.");
  // memory switched off: an OFF reply repeats it, with no lineage in v5
  setMemoryMode("off");
  message(thread, "ask-2", 20, "user", "Say it again?");
  message(thread, "y", 21, "bot", "Again: the code is 7731.");
  message("moss-direct", "moss-1", 30, "bot", "Unrelated chat.");
  expect(downgradeMemorySchema(database(), 5)).toMatchObject({ status: "downgraded", from: MEMORY_SCHEMA_VERSION, to: 5 });
  database().exec("PRAGMA wal_checkpoint(TRUNCATE)");
  closeDatabase();
  const copy = join(copyDir, "messages.db");
  copyFileSync(join(DATA_DIR, "messages.db"), copy);
  return copy;
}
/** Every table's rows as text, in key order: what "unchanged" means here. */
function rows(db: DatabaseSync): Map<string, string> {
  const out = new Map<string, string>();
  for (const { name } of db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>) {
    const all = db.prepare(`SELECT * FROM "${name}"`).all().map(row => JSON.stringify(row, (_k, v) => typeof v === "bigint" ? String(v) : v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v)).sort();
    out.set(name, JSON.stringify(all));
  }
  return out;
}
/** The shape-check marker is rewritten by every open of a new schema version (validateMemorySchema). */
const withoutMarker = (db: DatabaseSync) => JSON.stringify(db.prepare("SELECT * FROM memory_scope_bindings WHERE id!='memory-shape-check'").all().map(row => JSON.stringify(row)).sort());

it("upgrades a copy of a used v5 data dir additively, backfills Y's root, and the inverse runs", async () => {
  const copy = await usedV5DataDir();
  const db = new DatabaseSync(copy);
  try {
    db.exec("PRAGMA foreign_keys=ON");
    expect(db.prepare("SELECT schema_version FROM memory_meta").get()?.schema_version).toBe(5);
    for (const table of NEW_TABLES) expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(table), table).toBeUndefined();
    const before = rows(db), metaBefore = db.prepare("SELECT * FROM memory_meta").get(), bindingsBefore = withoutMarker(db);
    migrateMemorySchema(db);
    expect(db.prepare("SELECT schema_version FROM memory_meta").get()?.schema_version).toBe(7);
    validateMemorySchema(db, { references: true });
    const after = rows(db);
    // every existing table keeps every row, byte for byte (the shape-check marker aside)
    for (const [table, content] of before) {
      if (table === "memory_meta" || table === "memory_scope_bindings") continue;
      expect(after.get(table), table).toBe(content);
    }
    expect(withoutMarker(db)).toBe(bindingsBefore);
    expect(db.prepare("SELECT * FROM memory_meta").get()).toEqual({ ...metaBefore, schema_version: 7 });
    // the backfill wrote only the roots table: Y, after the thread's first receipt output, rests on X'
    const roots = db.prepare("SELECT o.thread_id,o.message_id,m.root_thread_id,m.root_message_id FROM memory_output_roots o JOIN memory_root_set_members m ON m.set_id=o.set_id ORDER BY o.message_id").all();
    expect(roots).toEqual([{ thread_id: thread, message_id: "y", root_thread_id: thread, root_message_id: "x-prime" }]);
    expect(db.prepare("SELECT count(*) AS n FROM memory_output_roots WHERE set_id NOT IN (SELECT set_id FROM memory_root_sets)").get()?.n).toBe(0);
    expect(db.prepare("SELECT count(*) AS n FROM memory_session_roots").get()?.n).toBe(0);
    expect(db.prepare("SELECT count(*) AS n FROM memory_lineage_meta").get()?.n).toBe(1);
    // a second open changes nothing
    migrateMemorySchema(db);
    for (const table of NEW_TABLES) expect(rows(db).get(table), table).toBe(after.get(table));
    // the inverse: back to the v5 file, every row as it was
    expect(downgradeMemorySchema(db, 5)).toEqual({ status: "downgraded", from: 7, to: 5 });
    validateMemorySchema(db, { references: true });
    for (const table of NEW_TABLES) expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(table), table).toBeUndefined();
    const back = rows(db);
    for (const [table, content] of before) if (table !== "memory_scope_bindings") expect(back.get(table), table).toBe(content);
  } finally { db.close(); }
});

it("after the upgrade, revoking X withholds the pre-v6 OFF reply Y with X'", async () => {
  const copy = await usedV5DataDir();
  // the app opens the upgraded copy as its data dir
  rmSync(join(DATA_DIR, "messages.db"), { force: true });
  for (const suffix of ["-wal", "-shm"]) if (existsSync(join(DATA_DIR, `messages.db${suffix}`))) rmSync(join(DATA_DIR, `messages.db${suffix}`));
  copyFileSync(copy, join(DATA_DIR, "messages.db"));
  expect(database().prepare("SELECT schema_version FROM memory_meta").get()?.schema_version).toBe(7);
  const lines = ["early", "x-prime", "y"].map(id => ({ id, role: "bot" }));
  expect([...replayExclusions(thread, lines, null, { failClosed: true })]).toEqual([]);
  reconcileMemoryRoster(roster);
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: "src-x", revision: 1 });
  expect(new Set(replayExclusions(thread, lines, null, { failClosed: true }))).toEqual(new Set(["x-prime", "y"]));
  // the thread that never used memory is untouched
  expect([...replayExclusions("moss-direct", [{ id: "moss-1", role: "bot" }], null, { failClosed: true })]).toEqual([]);
});

it("the backfill writes deduplicated root sets past 256 outputs, with no marker for valid memory", async () => {
  const copy = await usedV5DataDir();
  const db = new DatabaseSync(copy);
  try {
    // 300 more receipt outputs in the thread, each followed by an OFF reply
    const insert = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,'text',?,?)");
    const bundle = db.prepare("SELECT bundle_id FROM memory_disclosure_outputs WHERE thread_id=? LIMIT 1").get(thread)?.bundle_id;
    const outputs = ["x-prime"];
    for (let i = 0; i < 300; i++) {
      insert.run(thread, `o-${i}`, 100 + 2 * i, "bot", "made with memory", JSON.stringify({ id: `o-${i}`, at: 100 + 2 * i, role: "bot", kind: "text", text: "made with memory" }));
      insert.run(thread, `f-${i}`, 101 + 2 * i, "bot", "made without", JSON.stringify({ id: `f-${i}`, at: 101 + 2 * i, role: "bot", kind: "text", text: "made without" }));
      outputs.push(`o-${i}`);
    }
    db.prepare("UPDATE memory_disclosures SET output_message_ids=? WHERE bundle_id=?").run(JSON.stringify(outputs), String(bundle));
    migrateMemorySchema(db);
    expect(db.prepare("SELECT count(*) AS n FROM memory_output_roots WHERE set_id=''").get()?.n).toBe(0);
    const size = (id: string) => db.prepare("SELECT r.size FROM memory_output_roots o JOIN memory_root_sets r ON r.set_id=o.set_id WHERE o.thread_id=? AND o.message_id=?").get(thread, id)?.size;
    expect(size("f-299")).toBe(301);
    // o-i (a receipt output, a bot text reply) and f-(i-1) rest on the same outputs: one set
    const setOf = (id: string) => db.prepare("SELECT set_id FROM memory_output_roots WHERE thread_id=? AND message_id=?").get(thread, id)?.set_id;
    expect(setOf("o-10")).toBe(setOf("f-9"));
    // the session table is part of the v6 shape that archive, restore and merge validate
    db.exec("DROP TABLE memory_session_roots");
    expect(() => validateMemorySchema(db)).toThrow();
  } finally { db.close(); }
});
