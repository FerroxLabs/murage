// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.22 owner report: "Backups are paused: the last backup did not finish", and Clear plus a new backup failed every time. One
// conversation row the backup's reader refused (INVALID_MESSAGE_JSON, INVALID_MESSAGE_IDENTITY, INVALID_RESTORE_MESSAGE,
// INVALID_MESSAGE_PARENT, CYCLIC_MESSAGE_BRANCH, INVALID_ACTIVE_BRANCH) refused the whole backup, on every attempt, in a database
// the app opens and runs. Each case here goes through the real open path (database()), the real backup (writeInstallationArchive,
// the capture every backup kind shares) and the real restore check (prepareInstallationRestore, unchanged):
//   - the backup is written, the row is left out and named in the backup's own list, every other row is kept;
//   - the live database is not touched, and the archive passes the restore check as it always ran;
//   - an upgrade chain: conversation tables exactly as 1.0.18 made them, opened by this build, one such row, backs up;
//   - a refusal that is not about a row (an unknown table) still refuses.
// The restore side is not touched: installation-archive.test.ts keeps its witnesses that an archive holding such a row is refused.
// The same report on 1.0.21 read "Murage's conversation database is from a different version of Murage. Open this version of Murage
// normally once": a memory row that fails memory's own proof (the app opens such a file and runs with memory set aside) was reported
// as an unsupported schema, and opening never cleared it. The second block: the app opens it and holds memory, the backup is written
// with exactly that row left out and named and every other memory row kept, the restored file opens by the real path with memory in
// use, and a memory schema this build does not write or a broken reference outside memory still refuses.
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database, finishBackgroundUpgradeWorkNow, memoryHoldCode } from "./database.ts";
import { writeInstallationArchive } from "./installation-archive.ts";
import { MEMORY_LEFT_OUT_ITEM, inspectInstallationDatabase } from "./installation-database-snapshot.ts";
import { MESSAGE_SEARCH_DDL } from "./message-tables.ts";
import { ftsSettled } from "./settle-copy.ts";
import { prepareInstallationRestore } from "./installation-restore-preparation.ts";
import { runIntegrityPassToEnd } from "./memory/integrity-pass.ts";
import { beginIntegrityPass, readIntegrityPass } from "./memory/integrity-state.ts";
import { validateMemorySchema } from "./memory/schema.ts";
import { stopSearchIndex } from "./message-search-index.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { stopWalMaintenance } from "./wal-maintenance.ts";

type Planted = { thread: string; id: string; at: number; role: string; kind: string; text: string | null; json: string | Uint8Array };
const good = (thread: string, id: string, at: number, extra: Record<string, unknown> = {}): Planted =>
  ({ thread, id, at, role: "user", kind: "text", text: `words ${id}`, json: JSON.stringify({ id, at, role: "user", kind: "text", text: `words ${id}`, ...extra }) });
/** The conversation tables exactly as 1.0.18 created them (6e4dda8af, read back from a database that build opened). */
const TABLES_1_0_18 = `CREATE TABLE messages (
      thread_id TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, role TEXT NOT NULL,
      kind TEXT NOT NULL, text TEXT, json TEXT NOT NULL, seq INTEGER, PRIMARY KEY(thread_id,id));
CREATE TABLE thread_state(thread_id TEXT PRIMARY KEY, active_leaf_id TEXT);`;

/** Rows as they are found in the field, written straight into the closed file. The app's triggers guard its own live writes and
 *  would refuse several of these, so they step aside for the planting and return with their exact text. */
function plant(rows: Planted[], leaves: Record<string, string>): void {
  const db = new DatabaseSync(join(DATA_DIR, "messages.db"));
  try {
    const triggers = db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name IN ('messages','thread_state')").all() as Array<{ name: string; sql: string }>;
    for (const trigger of triggers) db.exec(`DROP TRIGGER "${trigger.name}"`);
    const insert = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES (?,?,?,?,?,?,?)");
    for (const row of rows) insert.run(row.thread, row.id, row.at, row.role, row.kind, row.text, row.json);
    // what the app keeps beside a message: a routine link member for each row that will be set aside (routine-message-links.ts)
    if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name='routine_link_members'").get()) for (const row of rows) if (row.id.startsWith("bad")) db.prepare("INSERT INTO routine_link_members(thread_id,id,rowkey) VALUES (?,?,?)").run(row.thread, row.id, String(row.at).padStart(16, "0"));
    for (const [thread, leaf] of Object.entries(leaves)) db.prepare("INSERT OR REPLACE INTO thread_state(thread_id,active_leaf_id) VALUES (?,?)").run(thread, leaf);
    for (const trigger of triggers) db.exec(trigger.sql);
  } finally { db.close(); }
}
const ids = (file: string) => { const db = new DatabaseSync(file, { readOnly: true }); try { return (db.prepare("SELECT thread_id||'/'||id AS k FROM messages ORDER BY thread_id,rowid").all() as Array<{ k: string }>).map(row => row.k); } finally { db.close(); } };
const leaf = (file: string, thread: string) => { const db = new DatabaseSync(file, { readOnly: true }); try { return (db.prepare("SELECT active_leaf_id AS id FROM thread_state WHERE thread_id=?").get(thread) as { id: string | null } | undefined)?.id; } finally { db.close(); } };
const parentIn = (file: string, thread: string, id: string) => { const db = new DatabaseSync(file, { readOnly: true }); try { return (db.prepare("SELECT json_extract(json,'$.parentId') AS p FROM messages WHERE thread_id=? AND id=?").get(thread, id) as { p: string | null } | undefined)?.p; } finally { db.close(); } };
/** The triggers on the conversation tables, without the Inbox projection's (inbox_*, setup_marks_*): a restore discards that projection and the app rebuilds it. */
const triggerText = (file: string) => { const db = new DatabaseSync(file, { readOnly: true }); try { return db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name IN ('messages','thread_state') AND name NOT LIKE 'inbox_%' AND name NOT LIKE 'setup_marks_%' ORDER BY name").all(); } finally { db.close(); } };

const parents: string[] = [];
async function settle(): Promise<void> { closeDatabase(); await stopWalMaintenance(); expect(await stopSearchIndex()).toBe(true); }
function asInstallation(): void {
  writeFileSync(join(DATA_DIR, "config.json"), JSON.stringify({ profile: { name: "Fixture" }, instances: {}, appearance: { skin: "light" } }) + "\n");
  writeFileSync(join(DATA_DIR, "bots.json"), JSON.stringify([{ id: "bot", threadId: "kept", name: "Fixture" }]) + "\n");
  writeFileSync(join(DATA_DIR, "groups.json"), "[]\n");
}
/** The real backup, then the real restore check of what it wrote. */
async function backUpAndCheck() {
  const parent = mkdtempSync(join(tmpdir(), "murage-row-backup-test-")); parents.push(parent);
  const archive = join(parent, "backup.murage-backup.zip");
  // a refusal is reported by its code, so the test fails on the line that expects none
  let refused: string | null = null;
  const code = (error: unknown) => String((error as { code?: unknown })?.code ?? error);
  const written = await writeInstallationArchive(DATA_DIR, archive).catch(error => { refused = `backup ${code(error)}`; return null; });
  const restored = written && await prepareInstallationRestore(archive, parent).catch(error => { refused = `restore check ${code(error)}`; return null; });
  return { refused: refused as string | null, written: written!, restored: restored!, file: restored ? join(restored.stateDirectory, "messages.db") : "" };
}

const KEPT = [good("kept", "k1", 1), good("kept", "k2", 2), good("hurt", "h1", 3), good("hurt", "h3", 9)];
const CASES: Array<{ name: string; code: string; rows: Planted[]; leaves: Record<string, string>; left: string[]; hurtLeaf: string; kept?: string[]; parentOf?: Record<string, string | null> }> = [
  { name: "text that is not JSON", code: "INVALID_MESSAGE_JSON", rows: [{ ...good("hurt", "bad", 5), json: '{"id":"bad","at":5,' }], leaves: { hurt: "h3" }, left: ["messages.db/conversation hurt/message bad"], hurtLeaf: "h3", parentOf: { h3: null } },
  { name: "a column that disagrees with its JSON", code: "INVALID_MESSAGE_IDENTITY", rows: [{ ...good("hurt", "bad", 5), text: "other words" }], leaves: { hurt: "h3" }, left: ["messages.db/conversation hurt/message bad"], hurtLeaf: "h3" },
  { name: "a payload no recovery schema reads", code: "INVALID_RESTORE_MESSAGE", rows: [{ ...good("hurt", "bad", 5), role: "narrator", json: JSON.stringify({ id: "bad", at: 5, role: "narrator", kind: "text", text: "words bad" }) }], leaves: { hurt: "h3" }, left: ["messages.db/conversation hurt/message bad"], hurtLeaf: "h3" },
  { name: "a parent that is not a message name", code: "INVALID_MESSAGE_PARENT", rows: [good("hurt", "bad", 5, { parentId: 7 })], leaves: { hurt: "h3" }, left: ["messages.db/conversation hurt/message bad"], hurtLeaf: "h3", parentOf: { h3: "bad" } },
  { name: "two rows that name each other as parent", code: "CYCLIC_MESSAGE_BRANCH", rows: [good("hurt", "bad", 5, { parentId: "bad2" }), good("hurt", "bad2", 6, { parentId: "bad" })], leaves: { hurt: "h3" }, left: ["messages.db/conversation hurt/message bad", "messages.db/conversation hurt/message bad2"], hurtLeaf: "h3" },
  // removing the loop would re-chain the row that followed it (it has no parent of its own) into a second loop that is not in the
  // file: those two rows are readable and on no loop of the file, so they stay, and the follower keeps the parent it had (ASTRA 8159ea7a05)
  { name: "a loop whose removal would chain its readable neighbours into another", code: "CYCLIC_MESSAGE_BRANCH", rows: [good("hurt", "ra", 5, { parentId: "rb" }), good("hurt", "bad2", 6, { parentId: "bad3" }), good("hurt", "bad3", 7, { parentId: "bad2" }), good("hurt", "rb", 8)], leaves: { hurt: "h3" }, left: ["messages.db/conversation hurt/message bad2", "messages.db/conversation hurt/message bad3"], hurtLeaf: "h3", kept: ["hurt/h1", "hurt/ra", "hurt/rb", "hurt/h3", "kept/k1", "kept/k2"], parentOf: { ra: "rb", rb: "bad3" } },
  // ASTRA 8159ea7a05: readable A names B, B has no parent of its own and follows the unreadable C. Reading past C as if it were not
  // there chains B to A, a loop the file does not hold: A and B stay, and B keeps C as its parent (a root once C leaves)
  { name: "a readable pair that skipping the unreadable row between them would loop", code: "INVALID_MESSAGE_JSON", rows: [good("hurt", "pa", 5, { parentId: "pb" }), { ...good("hurt", "bad", 6), json: "not json" }, good("hurt", "pb", 7)], leaves: { hurt: "h3" }, left: ["messages.db/conversation hurt/message bad"], hurtLeaf: "h3", kept: ["hurt/h1", "hurt/pa", "hurt/pb", "hurt/h3", "kept/k1", "kept/k2"], parentOf: { pa: "pb", pb: "bad" } },
  // the same with C refused for its payload, not its text: B still follows C, never A
  { name: "a readable pair around a row no recovery schema reads", code: "INVALID_RESTORE_MESSAGE", rows: [good("hurt", "pa", 5, { parentId: "pb" }), { ...good("hurt", "bad", 6), role: "narrator", json: JSON.stringify({ id: "bad", at: 6, role: "narrator", kind: "text", text: "words bad" }) }, good("hurt", "pb", 7)], leaves: { hurt: "h3" }, left: ["messages.db/conversation hurt/message bad"], hurtLeaf: "h3", kept: ["hurt/h1", "hurt/pa", "hurt/pb", "hurt/h3", "kept/k1", "kept/k2"], parentOf: { pa: "pb", pb: "bad" } },
  { name: "the conversation's current message is the unreadable one", code: "INVALID_MESSAGE_JSON", rows: [{ ...good("hurt", "bad", 5), json: "not json" }], leaves: { hurt: "bad" }, left: ["messages.db/conversation hurt/message bad"], hurtLeaf: "h3" },
  // MAIN-RULING 22:15Z (ASTRA/OPUS f0c0ab63c7): the oversized row O names its parent P (h1) and C follows O with no parent of its own.
  // O is refused for its size before its parent is read; C keeps O's parent, never the row that happens to sit before O (qq)
  { name: "a row past the size a restore reads that names its parent, followed by a row with none", code: "INVALID_RESTORE_MESSAGE", rows: [good("hurt", "qq", 4), { ...good("hurt", "bad", 5), text: "x".repeat(64 * 1024 ** 2), json: JSON.stringify({ id: "bad", at: 5, role: "user", kind: "text", text: "x".repeat(64 * 1024 ** 2), parentId: "h1" }) }, good("hurt", "cc", 6)], leaves: { hurt: "h3" }, left: ["messages.db/conversation hurt/message bad"], hurtLeaf: "h3", kept: ["hurt/h1", "hurt/qq", "hurt/cc", "hurt/h3", "kept/k1", "kept/k2"], parentOf: { cc: "h1", h3: null } },
  // ASTRA 994665a512 + OPUS 6a32c1b1cd Medium: the same with the parent named twice, differently. The app's two readers disagree
  // (JSON.parse takes the last, h1; the branch index's json_extract the first, qq), so O's parent is not known: C is attached to
  // neither. It keeps the parent it had, O's name, and begins its branch there. (Was: h1, the last. Either was one reader's guess.)
  { name: "a row past the size a restore reads that names two parents, followed by a row with none", code: "INVALID_RESTORE_MESSAGE", rows: [good("hurt", "qq", 4), { ...good("hurt", "bad", 5), text: "x".repeat(64 * 1024 ** 2), json: `{"id":"bad","at":5,"role":"user","kind":"text","text":"${"x".repeat(64 * 1024 ** 2)}","parentId":"qq","parentId":"h1"}` }, good("hurt", "cc", 6)], leaves: { hurt: "h3" }, left: ["messages.db/conversation hurt/message bad"], hurtLeaf: "h3", kept: ["hurt/h1", "hurt/qq", "hurt/cc", "hurt/h3", "kept/k1", "kept/k2"], parentOf: { cc: "bad", h3: null } },
  // ASTRA/FABLE/OPUS 6a32c1b1cd: O's JSON is valid and stored as a BLOB. The app's branch index reads its parent (h1) through
  // SQLite; the backup reads the same bytes as UTF-8 before it decides anything, so C keeps h1, never the row before O (qq)
  { name: "a row whose JSON is stored as a BLOB that names its parent, followed by a row with none", code: "INVALID_RESTORE_MESSAGE", rows: [good("hurt", "qq", 4), { ...good("hurt", "bad", 5), json: Buffer.from(good("hurt", "bad", 5, { parentId: "h1" }).json as string) }, good("hurt", "cc", 6)], leaves: { hurt: "h3" }, left: ["messages.db/conversation hurt/message bad"], hurtLeaf: "h3", kept: ["hurt/h1", "hurt/qq", "hurt/cc", "hurt/h3", "kept/k1", "kept/k2"], parentOf: { cc: "h1", h3: null } },
  // one row past the size a restore reads (64 MiB of JSON): its column and its JSON agree, only its size is refused
  { name: "a row larger than a restore reads", code: "INVALID_RESTORE_MESSAGE", rows: [{ ...good("hurt", "bad", 5), text: "x".repeat(64 * 1024 ** 2), json: JSON.stringify({ id: "bad", at: 5, role: "user", kind: "text", text: "x".repeat(64 * 1024 ** 2) }) }], leaves: { hurt: "h3" }, left: ["messages.db/conversation hurt/message bad"], hurtLeaf: "h3" },
  { name: "a current message that names no row", code: "INVALID_ACTIVE_BRANCH", rows: [], leaves: { hurt: "gone" }, left: ["messages.db/conversation hurt/message gone"], hurtLeaf: "h3" },
];

describe("a backup of a database the app opens is never refused over one conversation row", () => {
  beforeEach(async () => { await settle(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
  afterEach(async () => { await settle(); for (const parent of parents.splice(0)) removeTempDirSync(parent); });

  it.each(CASES)("$name ($code): the backup is written, the row is left out and named, the rest is kept", { timeout: 120_000 }, async ({ code, rows, leaves, left, hurtLeaf, kept = ["hurt/h1", "hurt/h3", "kept/k1", "kept/k2"], parentOf = {} }) => {
    database(); await settle(); asInstallation();
    // h3 is planted after the damaged rows, so a row in the middle of a conversation is the one that leaves
    plant([KEPT[0], KEPT[1], KEPT[2], ...rows, KEPT[3]], { kept: "k2", ...leaves });
    // the planted state is the reported one: the reader refuses this database with exactly this code
    const live = new DatabaseSync(join(DATA_DIR, "messages.db"), { readOnly: true });
    try { expect(() => inspectInstallationDatabase(live)).toThrow(new RegExp(`\\(${code}\\)`)); } finally { live.close(); }
    const before = ids(join(DATA_DIR, "messages.db")), triggers = triggerText(join(DATA_DIR, "messages.db"));

    const { refused, written, restored, file } = await backUpAndCheck();

    expect(refused).toBeNull();
    expect([...restored.manifest.skipped ?? []].sort((a, b) => a.path.localeCompare(b.path))).toEqual(left.map(path => ({ path, reason: "unreadable" })));
    expect(restored.manifest.skippedCount).toBe(left.length);
    expect(written).toMatchObject({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    // every readable row, in order, and nothing else
    expect(ids(file)).toEqual(kept);
    expect(restored.manifest.database).toMatchObject({ status: "copied", messages: kept.length, threads: 2 });
    // a readable row a removal would have re-chained keeps the parent it had in the file
    for (const [id, parent] of Object.entries(parentOf)) expect(parentIn(file, "hurt", id)).toBe(parent);
    expect(leaf(file, "hurt")).toBe(hurtLeaf);
    expect(leaf(file, "kept")).toBe("k2");
    // the app's own triggers are in the copy with their exact text
    expect(triggerText(file)).toEqual(triggers);
    expect(triggers.length).toBeGreaterThan(0);
    // what the app keeps about a message left with it, by the app's own delete triggers: no routine link names a removed row
    const copy = new DatabaseSync(file, { readOnly: true });
    try { expect(copy.prepare("SELECT count(*) AS n FROM routine_link_members WHERE thread_id='hurt' AND id LIKE 'bad%'").get()?.n).toBe(0); } finally { copy.close(); }
    const source = new DatabaseSync(join(DATA_DIR, "messages.db"), { readOnly: true });
    try { expect(source.prepare("SELECT count(*) AS n FROM routine_link_members WHERE thread_id='hurt' AND id LIKE 'bad%'").get()?.n).toBe(rows.filter(row => row.id.startsWith("bad")).length); } finally { source.close(); }
    // the live database was read, never changed: the row is still there
    expect(ids(join(DATA_DIR, "messages.db"))).toEqual(before);
    expect(before.length).toBe(4 + rows.length);
  });

  // ASTRA 2be2eb0ef9: the row that keeps its parent is exactly the size a restore reads, so the parent written into it takes it past
  // that size. It is never left out for that: the backup refuses, naming the row's own reason, and the live file keeps every row
  it("a readable row the kept parent would take past the size a restore reads is never left out: the backup refuses", { timeout: 120_000 }, async () => {
    database(); await settle(); asInstallation();
    const bare = JSON.stringify({ id: "rb", at: 8, role: "user", kind: "text", text: "" });
    const text = "x".repeat(64 * 1024 ** 2 - Buffer.byteLength(bare));
    const rb: Planted = { thread: "hurt", id: "rb", at: 8, role: "user", kind: "text", text, json: JSON.stringify({ id: "rb", at: 8, role: "user", kind: "text", text }) };
    expect(Buffer.byteLength(rb.json)).toBe(64 * 1024 ** 2);
    plant([KEPT[0], KEPT[1], KEPT[2], good("hurt", "ra", 5, { parentId: "rb" }), good("hurt", "bad2", 6, { parentId: "bad3" }), good("hurt", "bad3", 7, { parentId: "bad2" }), rb, KEPT[3]], { kept: "k2", hurt: "h3" });

    const { refused } = await backUpAndCheck();

    expect(refused).toBe("backup INVALID_RESTORE_MESSAGE");
    expect(ids(join(DATA_DIR, "messages.db"))).toEqual(["hurt/h1", "hurt/ra", "hurt/bad2", "hurt/bad3", "hurt/rb", "hurt/h3", "kept/k1", "kept/k2"]);
  });

  // ASTRA/FABLE/OPUS 6a32c1b1cd, MAIN round 4: the class, not the case. Conversations are generated row by row from every shape a
  // removed row comes in (JSON as text or as a BLOB, past the size a restore reads, not JSON, bytes that are not UTF-8, a column
  // that disagrees, a payload nothing reads, a parent that is not a name, two different parents, a conversation name nothing
  // accepts) with every parent it can carry (none of its own, an earlier row, a later row, itself, a name no row has, a root),
  // between readable rows with and without a parent of their own. The real backup and the real restore check run on each
  // database, and every readable row is then compared with the SOURCE, from the generator's own record of what was planted:
  //   - it is in the copy (no readable row leaves);
  //   - a row that names its parent names exactly that parent, and a row that follows a readable row still follows it;
  //   - a row that followed a removed row is under the first remaining row its removed parents lead to in the source, when every
  //     removed row on the way has a parent that is known; where one is not known, or that parent would close a loop, it keeps the
  //     parent it had (the removed row's name: it begins its branch there) and is attached to no other row.
  type Own = { t: "follows" } | { t: "names"; parent: string | null } | { t: "unknown" };
  type Spec = { id: string; readable: boolean; shape: string; own: Own; planted: Planted };
  const rng = (seed: number) => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const BIG = 64 * 1024 ** 2;
  /** One removed row: its stored value, and what is known of its own parent (the test's record, never read back from the row). */
  function removedRow(thread: string, id: string, at: number, shape: string, parent: string | null | undefined, other: string): { planted: Planted; own: Own } {
    const extra = parent === undefined ? {} : { parentId: parent };
    const named: Own = parent === undefined ? { t: "follows" } : { t: "names", parent };
    const base = good(thread, id, at, extra), json = base.json as string;
    switch (shape) {
      case "blob": return { planted: { ...base, json: Buffer.from(json) }, own: named };
      case "column": return { planted: { ...base, text: "other words" }, own: named };
      case "payload": return { planted: { ...base, role: "narrator", json: JSON.stringify({ id, at, role: "narrator", kind: "text", text: `words ${id}`, ...extra }) }, own: named };
      case "oversized": return { planted: { ...base, text: "x".repeat(BIG), json: JSON.stringify({ id, at, role: "user", kind: "text", text: "x".repeat(BIG), ...extra }) }, own: named };
      case "oversized-blob": return { planted: { ...base, text: "x".repeat(BIG), json: Buffer.from(JSON.stringify({ id, at, role: "user", kind: "text", text: "x".repeat(BIG), ...extra })) }, own: named };
      case "same-twice": return { planted: { ...base, text: "other words", json: `${json.slice(0, -1)},"parentId":${JSON.stringify(parent ?? null)}}` }, own: { t: "names", parent: parent ?? null } };
      // text no reader takes as JSON has no parent of its own, as the app's branch index reads it, whatever the text looks like
      case "not-json": return { planted: { ...base, json: "not json" }, own: { t: "follows" } };
      case "cut-short": return { planted: { ...base, json: json.slice(0, -1) + "," }, own: { t: "follows" } };
      case "not-json-blob": return { planted: { ...base, json: Buffer.from(json.slice(0, -1) + ",") }, own: { t: "follows" } };
      // not known: bytes that are not UTF-8, two readers that would each take a different parent, a parent that is not a name
      case "not-utf8": return { planted: { ...base, json: Buffer.concat([Buffer.from(json.slice(0, -2)), Buffer.from([0xff, 0xfe]), Buffer.from('"}')]) }, own: { t: "unknown" } };
      case "two-parents": return { planted: { ...base, text: "other words", json: `{"parentId":${JSON.stringify(other === parent ? "elsewhere" : other)},${json.slice(1, -1)}${parent === undefined ? `,"parentId":null` : ""}}` }, own: { t: "unknown" } };
      case "not-a-name": return { planted: { ...base, json: JSON.stringify({ id, at, role: "user", kind: "text", text: `words ${id}`, parentId: 7 }) }, own: { t: "unknown" } };
      default: throw new Error(shape);
    }
  }
  const SHAPES = ["blob", "blob", "column", "payload", "same-twice", "not-json", "cut-short", "not-json-blob", "not-utf8", "two-parents", "not-a-name"];
  function generate(seed: number, threads: number, large: string[]): { rows: Planted[]; specs: Map<string, Spec[]>; strays: Planted[] } {
    const next = rng(seed), pick = <T,>(list: T[]): T => list[Math.floor(next() * list.length)]!;
    const rows: Planted[] = [], specs = new Map<string, Spec[]>();
    let at = 100;
    const build = (thread: string, plan: Array<(ids: string[], index: number) => Spec>) => { const ids = plan.map((_, index) => `${thread}r${index}`); const list = plan.map((make, index) => make(ids, index)); specs.set(thread, list); rows.push(...list.map(spec => spec.planted)); };
    const readable = (thread: string, parent: (ids: string[], index: number) => string | null | undefined) => (ids: string[], index: number): Spec => {
      const own = parent(ids, index);
      return { id: ids[index]!, readable: true, shape: "readable", own: own === undefined ? { t: "follows" } : { t: "names", parent: own }, planted: good(thread, ids[index]!, at++, own === undefined ? {} : { parentId: own }) };
    };
    const removed = (thread: string, shape: string, parent: (ids: string[], index: number) => string | null | undefined) => (ids: string[], index: number): Spec =>
      ({ id: ids[index]!, readable: false, shape, ...removedRow(thread, ids[index]!, at++, shape, parent(ids, index), ids[Math.max(0, index - 1)]!) });
    // the reported shape first, in every database: P, Q, O (a BLOB that names P), C
    build(`g${seed}first`, [readable(`g${seed}first`, () => undefined), readable(`g${seed}first`, () => undefined), removed(`g${seed}first`, "blob", ids => ids[0]!), readable(`g${seed}first`, () => undefined)]);
    // the rows past the size a restore reads are few (each is 64 MiB): one conversation each, P, Q, O, C
    large.forEach((shape, n) => { const thread = `g${seed}large${n}`; build(thread, [readable(thread, () => undefined), readable(thread, () => undefined), removed(thread, shape, ids => ids[0]!), readable(thread, () => undefined)]); });
    for (let n = 0; n < threads; n++) {
      const thread = `g${seed}t${n}`, length = 3 + Math.floor(next() * 6), plan: Array<(ids: string[], index: number) => Spec> = [];
      for (let index = 0; index < length; index++) {
        if (next() < 0.5) {
          const form = next();
          // a readable row names only an earlier row (or no row, or none): the source holds no loop of readable rows
          plan.push(readable(thread, (ids, i) => form < 0.6 ? undefined : form < 0.8 && i > 0 ? ids[Math.floor(next() * i)]! : form < 0.9 ? "nobody" : null));
        } else {
          const shape = pick(SHAPES), form = next();
          plan.push(removed(thread, shape, (ids, i) => form < 0.3 ? undefined : form < 0.6 && i > 0 ? ids[Math.floor(next() * i)]! : form < 0.75 ? ids[Math.min(ids.length - 1, i + 1 + Math.floor(next() * 2))]! : form < 0.8 ? ids[i]! : form < 0.9 ? "nobody" : null));
        }
      }
      build(thread, plan);
    }
    // conversation names nothing accepts: their rows leave and no other conversation's row moves for them
    const strays = [good(`g${seed} stray`, "s1", at++), good(`g${seed} stray`, "s2", at++, { parentId: "s1" }), good(`g${seed}/stray`, "s1", at++)];
    return { rows: [...rows, ...strays], specs, strays };
  }
  /** Where a row that followed a removed row belongs, from the source alone: the first remaining row its removed parents lead to,
   *  a root (null), or "keep": the parent it had, when a removed row's own parent is not known or the removed rows lead in a circle. */
  function lead(list: Spec[], index: number): { to: string | null } | "keep" {
    const seen = new Set<number>();
    for (let at = index - 1; !seen.has(at);) {
      seen.add(at);
      const own = list[at]!.own;
      if (own.t === "unknown") return "keep";
      let up: number;
      if (own.t === "names") {
        if (own.parent === null) return { to: null };
        up = list.findIndex(spec => spec.id === own.parent);
        if (up < 0) return { to: own.parent };
      } else { if (at === 0) return { to: null }; up = at - 1; }
      if (list[up]!.readable) return { to: list[up]!.id };
      at = up;
    }
    return "keep";
  }
  const PROPERTY = [{ seed: 11, threads: 45, large: ["oversized", "oversized-blob"] }, { seed: 29, threads: 60, large: [] as string[] }, { seed: 47, threads: 60, large: [] as string[] }];
  /** The parent every readable row has in the source (a row that followed a removed row placed where its removed parents lead),
   *  and for each such follower where it was led. */
  function source(list: Spec[]) {
    const inSource = new Map<string, string | null>(), led = new Map<string, { to: string | null } | "keep">();
    list.forEach((spec, index) => {
      if (!spec.readable) return;
      if (spec.own.t === "names") { inSource.set(spec.id, spec.own.parent); return; }
      if (index === 0 || list[index - 1]!.readable) { inSource.set(spec.id, list[index - 1]?.id ?? null); return; }
      const where = lead(list, index); led.set(spec.id, where);
      inSource.set(spec.id, where === "keep" ? list[index - 1]!.id : where.to);
    });
    const circles = (id: string) => { const seen = new Set<string>(); for (let at: string | null | undefined = inSource.get(id); at !== null && at !== undefined && !seen.has(at); at = inSource.get(at)) { if (at === id) return true; seen.add(at); } return false; };
    return { led, circles };
  }
  it.each(PROPERTY)("generated conversations (seed $seed): no readable row leaves, and none changes parent against the source", { timeout: 600_000 }, async ({ seed, threads, large }) => {
    database(); await settle(); asInstallation();
    const { rows, specs, strays } = generate(seed, threads, large);
    plant([...KEPT, ...rows], { kept: "k2", hurt: "h3" });
    const before = ids(join(DATA_DIR, "messages.db"));

    const { refused, restored, file } = await backUpAndCheck();

    expect(refused).toBeNull();
    const copy = new DatabaseSync(file, { readOnly: true });
    const wrong: string[] = [], gone: string[] = [];
    let followers = 0;
    try {
      const read = copy.prepare("SELECT id, json_type(json,'$.parentId') AS type, json_extract(json,'$.parentId') AS parent FROM messages WHERE thread_id=? ORDER BY rowid");
      for (const [thread, list] of specs) {
        const kept = read.all(thread) as Array<{ id: string; type: string | null; parent: unknown }>;
        const want = list.filter(spec => spec.readable).map(spec => spec.id);
        if (JSON.stringify(kept.map(row => row.id)) !== JSON.stringify(want)) { gone.push(`${thread}: ${kept.map(row => row.id)} != ${want}`); continue; }
        // the parent each kept row has in the copy: its own, or the row before it
        const inCopy = new Map<string, string | null>();
        kept.forEach((row, index) => inCopy.set(row.id, row.type === null ? kept[index - 1]?.id ?? null : row.type === "null" ? null : String(row.parent)));
        const { led, circles } = source(list);
        list.forEach((spec, index) => {
          if (!spec.readable) return;
          const row = kept.find(item => item.id === spec.id)!, has = inCopy.get(spec.id), where = led.get(spec.id);
          const say = (rule: string) => wrong.push(`${thread}/${spec.id} ${rule}: in the copy ${JSON.stringify(row)} under ${has}; source ${list.map(item => `${item.id}:${item.shape}:${JSON.stringify(item.own)}`).join(" ")}`);
          if (spec.own.t === "names") { if (row.type === null || has !== spec.own.parent) say("names its own parent and must keep it"); return; }
          if (!where) { if (row.type !== null) say("follows a readable row and must be left as it is"); return; }
          followers++;
          const pin = list[index - 1]!.id;
          if (where === "keep") { if (row.type !== "text" || has !== pin) say(`must keep the parent it had (${pin})`); return; }
          if (circles(spec.id)) { if (has !== where.to && !(row.type === "text" && has === pin)) say(`must be under ${where.to} or keep the parent it had (${pin})`); return; }
          if (has !== where.to) say(`must be under ${where.to}`);
        });
      }
      for (const stray of strays) if (copy.prepare("SELECT 1 FROM messages WHERE thread_id=? AND id=?").get(stray.thread, stray.id)) gone.push(`${stray.thread}/${stray.id} is in the copy`);
    } finally { copy.close(); }
    // no readable row left the copy, and every removed row is named
    expect(gone).toEqual([]);
    expect(restored.manifest.skippedCount).toBe([...specs.values()].flat().filter(spec => !spec.readable).length + strays.length);
    // no readable row changed parent against the source
    expect(wrong).toEqual([]);
    expect(followers).toBeGreaterThan(20);
    expect(ids(join(DATA_DIR, "messages.db"))).toEqual(before);
  });
  // a generator that never made a shape proves nothing of it: the same seeds hold a row following every kind of removed row, walks
  // through several removed rows, roots, circles and parents that are not known (the two 64 MiB conversations are fixed, not drawn)
  it("the generated conversations hold every shape the property is about", () => {
    const seen = new Map<string, number>(), count = (what: string) => seen.set(what, (seen.get(what) ?? 0) + 1);
    for (const { seed, threads } of PROPERTY) for (const list of generate(seed, threads, []).specs.values()) {
      const { led, circles } = source(list);
      list.forEach((spec, index) => {
        const where = led.get(spec.id);
        if (!where) return;
        count(`follows ${list[index - 1]!.shape}`);
        if (where === "keep") { count("kept: not known or removed rows in a circle"); return; }
        if (index >= 2 && !list[index - 2]!.readable && list[index - 1]!.own.t === "follows") count("through several removed rows");
        if (where.to === null) count("led to a root");
        if (circles(spec.id)) count("would close a circle");
      });
    }
    const missing = [...new Set(SHAPES)].map(shape => `follows ${shape}`).concat(["kept: not known or removed rows in a circle", "through several removed rows", "led to a root", "would close a circle"]).filter(what => !seen.get(what));
    expect(missing).toEqual([]);
  });

  it("an upgrade chain: conversation tables as 1.0.18 made them, opened by this build, with one unreadable row, back up", { timeout: 120_000 }, async () => {
    const old = new DatabaseSync(join(DATA_DIR, "messages.db"));
    old.exec(TABLES_1_0_18);
    const insert = old.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json,seq) VALUES (?,?,?,?,?,?,?,?)");
    [good("kept", "k1", 1), good("kept", "k2", 2), good("hurt", "h1", 3)].forEach((row, index) => insert.run(row.thread, row.id, row.at, row.role, row.kind, row.text, row.json, index + 1));
    insert.run("hurt", "bad", 5, "user", "text", "words bad", '{"id":"bad"', 4);
    insert.run("hurt", "h3", 9, "user", "text", "words h3", good("hurt", "h3", 9).json, 5);
    old.exec("INSERT INTO thread_state VALUES ('kept','k2'),('hurt','h3')");
    old.close();
    // this build's own migrator takes the 1.0.18 tables forward
    const upgraded = database();
    expect((upgraded.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map(column => column.name)).toContain("turn_id");
    await settle(); asInstallation();

    const { refused, restored, file } = await backUpAndCheck();

    expect(refused).toBeNull();
    expect(restored.manifest.skipped).toEqual([{ path: "messages.db/conversation hurt/message bad", reason: "unreadable" }]);
    expect(ids(file)).toEqual(["hurt/h1", "hurt/h3", "kept/k1", "kept/k2"]);
    expect(ids(join(DATA_DIR, "messages.db"))).toContain("hurt/bad");
  });

  // The Inbox projection's triggers are the one kind the inspection accepts without comparing their text (derived data, discarded at
  // restore). A delete in the staged copy must not run one: a projection trigger whose body reaches past the projection (here: an
  // older or foreign text that deletes a healthy message) would take a row the backup's list never names.
  it("leaving a row out never runs an Inbox projection trigger: no row the list does not name leaves the copy", { timeout: 120_000 }, async () => {
    database(); await settle(); asInstallation();
    plant([KEPT[0], KEPT[1], KEPT[2], { ...good("hurt", "bad", 5), json: "not json" }, KEPT[3]], { kept: "k2", hurt: "h3" });
    const db = new DatabaseSync(join(DATA_DIR, "messages.db"));
    try {
      db.exec("DROP TRIGGER IF EXISTS inbox_project_delete; CREATE TRIGGER inbox_project_delete AFTER DELETE ON messages BEGIN DELETE FROM messages WHERE thread_id='kept' AND id='k1'; END");
      // the inspection accepts this trigger by its name and refuses only the row
      expect(() => inspectInstallationDatabase(db)).toThrow(/\(INVALID_MESSAGE_JSON\)/);
    } finally { db.close(); }

    const { refused, restored, file } = await backUpAndCheck();

    expect(refused).toBeNull();
    expect(restored.manifest.skipped).toEqual([{ path: "messages.db/conversation hurt/message bad", reason: "unreadable" }]);
    expect(ids(file)).toEqual(["hurt/h1", "hurt/h3", "kept/k1", "kept/k2"]);
    expect(restored.manifest.database).toMatchObject({ status: "copied", messages: 4, threads: 2 });
  });

  // The settle empties search_intents before it sweeps the index, on every backup: a projection-named trigger on that table (accepted
  // by its name, whatever table it is on) fired there too. The projection leaves every staged copy before its first delete, with a row
  // set aside or with every row readable.
  const INTENT_CASES = [
    { name: "with a row set aside", rows: [{ ...good("hurt", "bad", 5), json: "not json" }], skipped: [{ path: "messages.db/conversation hurt/message bad", reason: "unreadable" }] },
    { name: "with every row readable", rows: [], skipped: [] },
  ];
  it.each(INTENT_CASES)("emptying the search intents never runs an Inbox projection trigger, $name: no row the list does not name leaves the copy", { timeout: 120_000 }, async ({ rows, skipped }) => {
    database(); await settle(); asInstallation();
    plant([KEPT[0], KEPT[1], KEPT[2], ...rows, KEPT[3]], { kept: "k2", hurt: "h3" });
    const db = new DatabaseSync(join(DATA_DIR, "messages.db"));
    try {
      db.exec("DROP TRIGGER IF EXISTS inbox_raw_added; CREATE TRIGGER inbox_raw_added AFTER DELETE ON search_intents BEGIN DELETE FROM messages WHERE thread_id='kept' AND id='k1'; END");
      db.prepare("INSERT INTO search_intents(nonce,rowid) VALUES (1,1)").run();
    } finally { db.close(); }

    const { refused, restored, file } = await backUpAndCheck();

    expect(refused).toBeNull();
    expect(restored.manifest.skipped ?? []).toEqual(skipped);
    expect(ids(file)).toEqual(["hurt/h1", "hurt/h3", "kept/k1", "kept/k2"]);
    expect(ids(join(DATA_DIR, "messages.db"))).toContain("kept/k1");
  });

  // A search index in the file (the legacy messages_fts, keyed by messages.rowid) holds a posting for the unreadable row too: the row
  // leaves the copy before the index's orphans are swept, so its posting goes with them and the index proof after VACUUM holds.
  it("an unreadable row the search index holds a posting for: the backup is written and the copy's index is settled", { timeout: 120_000 }, async () => {
    database(); await settle(); asInstallation();
    plant([KEPT[0], KEPT[1], KEPT[2], { ...good("hurt", "bad", 5), json: "not json" }, KEPT[3]], { kept: "k2", hurt: "h3" });
    const db = new DatabaseSync(join(DATA_DIR, "messages.db"));
    try {
      db.exec(MESSAGE_SEARCH_DDL);
      db.exec("INSERT INTO messages_fts(rowid,t) SELECT rowid, coalesce(text,'') FROM messages WHERE rowid NOT IN (SELECT rowid FROM messages_fts)");
      expect(db.prepare("SELECT count(*) AS n FROM messages_fts").get()?.n).toBe(5);
    } finally { db.close(); }

    const { refused, restored, file } = await backUpAndCheck();

    expect(refused).toBeNull();
    expect(restored.manifest.skipped).toEqual([{ path: "messages.db/conversation hurt/message bad", reason: "unreadable" }]);
    expect(ids(file)).toEqual(["hurt/h1", "hurt/h3", "kept/k1", "kept/k2"]);
    const copy = new DatabaseSync(file, { readOnly: true });
    try { expect(ftsSettled(copy)).toBe("settled"); } finally { copy.close(); }
  });

  it("a database with every row readable lists nothing as left out", { timeout: 120_000 }, async () => {
    database(); await settle(); asInstallation();
    plant(KEPT, { kept: "k2", hurt: "h3" });
    const { refused, restored, file } = await backUpAndCheck();
    expect(refused).toBeNull();
    expect(restored.manifest.skipped).toBeUndefined();
    expect(restored.manifest.skippedCount).toBeUndefined();
    expect(ids(file)).toEqual(["hurt/h1", "hurt/h3", "kept/k1", "kept/k2"]);
  });

  it("a refusal that is not about a row still refuses: an unreadable row beside a table Murage does not know", { timeout: 120_000 }, async () => {
    database(); await settle(); asInstallation();
    plant([...KEPT, { ...good("hurt", "bad", 5), json: "not json" }], { kept: "k2", hurt: "h3" });
    const db = new DatabaseSync(join(DATA_DIR, "messages.db"));
    db.exec("CREATE TABLE stranger(id TEXT)"); db.close();
    const parent = mkdtempSync(join(tmpdir(), "murage-row-backup-test-")); parents.push(parent);
    await expect(writeInstallationArchive(DATA_DIR, join(parent, "backup.murage-backup.zip"))).rejects.toMatchObject({ code: "DATABASE_SCHEMA_UNSUPPORTED" });
  });
});

/** Memory rows as they are found in the field, written straight into the closed file (no reference enforcement, as an older writer left them). */
function plantMemory(sql: string): void {
  const db = new DatabaseSync(join(DATA_DIR, "messages.db"), { enableForeignKeyConstraints: false });
  try { db.exec(sql); } finally { db.close(); }
}
const memoryObjects = (file: string) => { const db = new DatabaseSync(file, { readOnly: true }); try { return (db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'memory\\_%' ESCAPE '\\' OR tbl_name LIKE 'memory\\_%' ESCAPE '\\'").all() as Array<{ name: string }>).length; } finally { db.close(); } };
const LESSON = "INSERT INTO memory_lessons(id,version,bot_id,scope,kind,text,origin,state,created_at,learning_event_id) VALUES('l1',1,'bot','owner','note','a lesson','typed','active',1,";
/** A lesson no proof reads (it is retired): it must come through the backup and the restore untouched. */
const KEPT_LESSON = "INSERT INTO memory_lessons(id,version,bot_id,scope,kind,text,origin,state,created_at) VALUES('l2',1,'bot','owner','note','a kept lesson','typed','retired',2)";
const lessons = (db: DatabaseSync) => (db.prepare("SELECT id FROM memory_lessons ORDER BY id").all() as Array<{ id: string }>).map(row => row.id);
const MEMORY_CASES: Array<{ name: string; sql: string; left: RegExp; live?: string[]; row?: string }> = [
  // lesson-lineage.ts reads a lesson with no event as a plain lesson; the proof (memory/schema.ts, integrity-pass.ts) holds memory over it
  { name: "an active lesson with no ledger event", sql: `${LESSON}NULL)`, left: /^messages\.db\/memory\/lesson l1$/ },
  // the event it names is gone: the reference sweep or the lesson proof finds the same row, whichever reads it first
  { name: "an active lesson whose ledger event is gone", sql: `${LESSON}'gone')`, left: /^messages\.db\/memory\/(lesson l1|memory_lessons row \d+)$/ },
  // memory/schema.ts INVALID_MEMORY_LEARNING_EVENT: a ledger event whose scope is gone (scope_id carries no declared reference, so only this proof finds it)
  { name: "a ledger event whose scope is gone", sql: "INSERT INTO memory_learning_events(id,scope_id,kind,created_at) VALUES('e1','scope-gone','activated',1)", left: /^messages\.db\/memory\/learning event e1$/, live: ["l2"], row: "SELECT count(*) AS n FROM memory_learning_events WHERE id='e1'" },
  // INVALID_MEMORY_REFERENCE alone: a scope binding (no lesson or ledger proof reads it) whose declared reference names no scope
  { name: "a scope binding whose scope is gone", sql: "INSERT INTO memory_scope_bindings(id,scope_id,subject_type,subject_id,revision,state,intent) VALUES('b1','scope-gone','bot','bot',0,'granted','{}')", left: /^messages\.db\/memory\/memory_scope_bindings row \d+$/, live: ["l2"], row: "SELECT count(*) AS n FROM memory_scope_bindings WHERE id='b1'" },
];

describe("a backup of a database the app opens is never refused over one memory row that fails memory's own proof", () => {
  beforeEach(async () => { await settle(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
  afterEach(async () => { await settle(); for (const parent of parents.splice(0)) removeTempDirSync(parent); });

  it.each(MEMORY_CASES)("$name: the app opens it, the backup is written with that row left out and named, and the restored file opens with every conversation and its other memory", { timeout: 120_000 }, async ({ sql, left, live: liveLessons = ["l1", "l2"], row }) => {
    database(); await settle(); asInstallation();
    plant(KEPT, { kept: "k2", hurt: "h3" });
    plantMemory(`${sql}; ${KEPT_LESSON}`);
    // the reported state: the reader refuses this database as an unsupported schema ...
    const live = new DatabaseSync(join(DATA_DIR, "messages.db"), { readOnly: true });
    try { expect(() => inspectInstallationDatabase(live)).toThrow(/\(DATABASE_SCHEMA_UNSUPPORTED\)/); } finally { live.close(); }
    // ... while this build opens it normally, as often as the person likes, and its own integrity pass sets memory aside and carries on
    expect(() => database()).not.toThrow(); await settle();
    // an upgrade that skips the full sweep begins this pass (memory/schema.ts beginIntegrityPass); it runs in the background of a normal open
    const opened = database();
    beginIntegrityPass(opened);
    const held = runIntegrityPassToEnd(opened);
    expect(String(held?.result)).toMatch(/^held:INVALID_MEMORY_/);
    await settle();
    expect(() => database()).not.toThrow(); await settle();
    const liveMemory = memoryObjects(join(DATA_DIR, "messages.db"));
    expect(liveMemory).toBeGreaterThan(0);

    const { refused, restored, file } = await backUpAndCheck();

    expect(refused).toBeNull();
    expect(restored.manifest.skipped).toEqual([{ path: expect.stringMatching(left), reason: "unreadable" }]);
    expect(restored.manifest.skippedCount).toBe(1);
    expect(ids(file)).toEqual(["hurt/h1", "hurt/h3", "kept/k1", "kept/k2"]);
    // exactly the row the proof refused left the copy; every other memory row and object is still in it
    const copied = new DatabaseSync(file, { readOnly: true });
    try { expect(lessons(copied)).toEqual(["l2"]); if (row) expect(copied.prepare(row).get()?.n).toBe(0); } finally { copied.close(); }
    expect(memoryObjects(file)).toBe(liveMemory);
    // the live database keeps the row
    const kept = new DatabaseSync(join(DATA_DIR, "messages.db"), { readOnly: true });
    try { expect(lessons(kept)).toEqual(liveLessons); if (row) expect(kept.prepare(row).get()?.n).toBe(1); } finally { kept.close(); }
    // the restored file, opened by the real path: every conversation, and its memory, which this build proves in full
    removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
    copyFileSync(file, join(DATA_DIR, "messages.db"));
    const reopened = database();
    expect(validateMemorySchema(reopened).size).toBeGreaterThan(0);
    expect((reopened.prepare("SELECT thread_id||'/'||id AS k FROM messages ORDER BY thread_id,rowid").all() as Array<{ k: string }>).map(row => row.k)).toEqual(["hurt/h1", "hurt/h3", "kept/k1", "kept/k2"]);
    expect(lessons(reopened)).toEqual(["l2"]);
    // memory is in use: the hold over the row that was left out did not travel, before or after the upgrade work runs
    expect(memoryHoldCode()).toBeNull();
    expect(String(readIntegrityPass(reopened)?.result ?? "")).not.toMatch(/^held/);
    finishBackgroundUpgradeWorkNow();
    expect(memoryHoldCode()).toBeNull();
    expect(String(readIntegrityPass(reopened)?.result ?? "")).not.toMatch(/^held/);
  });

  it("a memory row that fails its proof beside an unreadable conversation row: both are left out and named", { timeout: 120_000 }, async () => {
    database(); await settle(); asInstallation();
    plant([...KEPT.slice(0, 3), { ...good("hurt", "bad", 5), json: "not json" }, KEPT[3]], { kept: "k2", hurt: "h3" });
    plantMemory(`${LESSON}NULL)`);
    const { refused, restored, file } = await backUpAndCheck();
    expect(refused).toBeNull();
    expect(restored.manifest.skipped).toEqual([{ path: "messages.db/memory/lesson l1", reason: "unreadable" }, { path: "messages.db/conversation hurt/message bad", reason: "unreadable" }]);
    expect(ids(file)).toEqual(["hurt/h1", "hurt/h3", "kept/k1", "kept/k2"]);
  });

  it("a broken reference in a table that is not memory's still refuses, and no memory row is left out for it", { timeout: 120_000 }, async () => {
    const db = database();
    const child = (db.prepare("SELECT m.name AS name FROM sqlite_schema m WHERE m.type='table' AND m.name NOT LIKE 'memory\\_%' ESCAPE '\\' AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND EXISTS (SELECT 1 FROM pragma_foreign_key_list(m.name)) ORDER BY m.name").all() as Array<{ name: string }>).map(row => row.name);
    await settle(); asInstallation();
    plant(KEPT, { kept: "k2", hurt: "h3" });
    // a table of the app's own with a reference, and one row in it that names nothing
    expect(child).toContain("push_events");
    const raw = new DatabaseSync(join(DATA_DIR, "messages.db"), { enableForeignKeyConstraints: false });
    try {
      raw.exec("INSERT INTO push_events(event_ref,binding_id,kind,category,bot_id,thread_id,collapse_key,thread_group,revision,time_sensitive,created_at,expires_at,hold_until,state,next_attempt_at) VALUES('e','no-binding','k','c','bot','kept','ck','tg',1,0,1,2,1,'held',1)");
      expect((raw.prepare("PRAGMA foreign_key_check").all() as Array<{ table: string }>).map(row => row.table)).toEqual(["push_events"]);
    } finally { raw.close(); }
    const parent = mkdtempSync(join(tmpdir(), "murage-row-backup-test-")); parents.push(parent);
    await expect(writeInstallationArchive(DATA_DIR, join(parent, "backup.murage-backup.zip"))).rejects.toMatchObject({ code: "DATABASE_SCHEMA_UNSUPPORTED" });
  });

  // CHANGED EXPECTATION (1.0.22 q1022-startmem, MAIN-RULING 2026-11-25T15:37Z "backups must still succeed without memory"): this used to
  // refuse the backup. Memory this build does not write is now left out of the backup whole (named in its list), and nothing of it,
  // the unknown object included, reaches the restore; the chats come through.
  it("a memory schema this build does not write leaves memory out of the backup, with or without a failed proof", { timeout: 120_000 }, async () => {
    database(); await settle(); asInstallation();
    plant(KEPT, { kept: "k2", hurt: "h3" });
    plantMemory(`${LESSON}NULL); CREATE INDEX memory_stranger ON memory_lessons(text)`);
    const { refused, restored, file } = await backUpAndCheck();
    expect(refused).toBeNull();
    expect(restored.manifest.skipped?.map(item => item.path)).toContain(`messages.db/memory/${MEMORY_LEFT_OUT_ITEM}`);
    expect(memoryObjects(file)).toBe(0);
    expect(ids(file)).toEqual(["hurt/h1", "hurt/h3", "kept/k1", "kept/k2"]);
  });
});
