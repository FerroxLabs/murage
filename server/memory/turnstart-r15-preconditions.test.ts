// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.18 TURNSTART r15.1 GATE preconditions (MurageMain), builder L3:
// (1) Y1/Y2: the writes a plain send makes before its dispatch compare (the append of U, its capture, its branch head) only NOTE dirty
//     keys; none moves a RAW epoch (temp lineage_epoch, lineage_structure, lineage_forgets where TCFO installs it, authority_epoch n/hard,
//     data_version), and none writes a root-set or tombstone row. Statically over every installed trigger on those tables, and at runtime
//     over a real append with capture. Mutant append-bumps (an epoch UPDATE in the messages INSERT body) reds the static case.
// (2) shared connection: the post-reply writers open no DatabaseSync of their own and nothing in production calls foreignLineageWrite,
//     so no commit of theirs moves data_version, which the lineage stamp reads as a foreign write and drops the verdict cache on.
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { appendMessage } from "../message-db.ts";
import type { Message } from "../store.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { authorityEpochInstalled } from "./authority-epoch.ts";
import { memoryAccess, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { catchUpRecentMemory } from "./recent.ts";
import { lineageTriggersInstalled } from "./replay-lineage.ts";
import { setMemoryMode } from "./repository.ts";

const THREAD = "dax-direct";
const roster: MemoryRoster = { bots: [{ id: "dax", threadId: THREAD, section: "Operations" }], groups: [] };
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("active"); reconcileMemoryRoster(roster); });

/** The tables (and events) a plain send writes before IX dispatch: U's messages row, its capture source and version, the data revision of
 * memory_meta, the turn index and the branch-change row (r15.1 Y1, as narrowed by the TURNSTART lead after TCFO r2). */
const PATH: ReadonlyArray<{ table: string; events: readonly string[] }> = [
  { table: "messages", events: ["INSERT"] },
  { table: "memory_sources", events: ["INSERT"] },
  { table: "memory_source_versions", events: ["INSERT"] },
  { table: "memory_meta", events: ["UPDATE"] },
  { table: "turn_first", events: ["INSERT", "UPDATE", "DELETE"] },
  { table: "branch_change", events: ["INSERT", "UPDATE", "DELETE"] },
];
/** A body statement that writes a RAW epoch: any lineage_* counter but the dirty list (lineage_epoch, lineage_structure, lineage_forgets),
 * or any authority_* table (the authority stamp's epoch, soft log and pending marks). A NOTE (INSERT INTO lineage_dirty) is not one; nor is
 * a counter no stamp reads (app_write_revision: asserted unread below). */
const RAW_WRITE = /^(?:UPDATE|INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|DELETE\s+FROM)\s+(?:temp\.|main\.)?(?:lineage_(?!dirty\b)\w+|authority_\w+)\b/i;
/** Raw statements that can never run on a plain send's first write of U, each with why (TCFO r2, a0298d0b5). */
const NEVER_FOR_FRESH_U: ReadonlyArray<{ why: string; statement: RegExp }> = [
  // FORGOTTEN_LINE (RL r2 :1804): only when a source tombstone already names this very line; U's id is new, so none can (the runtime case
  // below forgets a line first and shows the counter moves: that send is INELIGIBLE, today's path)
  { why: "forgotten line", statement: /^UPDATE\s+(?:temp\.)?lineage_forgets\s+SET\s+n\s*=\s*n\s*\+\s*1\s+WHERE\s+EXISTS\s*\(SELECT 1 FROM main\.memory_tombstones ft WHERE ft\.target_type='source' AND ft\.target_id='message:'\|\|NEW\.thread_id\|\|':'\|\|NEW\.id\)$/i },
];
/** The modules whose stamps decide a warm turn. */
const STAMP_MODULES = ["replay-lineage.ts", "authority-epoch.ts", "disclosures.ts", "verdict-store.ts", "lineage-warm.ts", "root-set-handles.ts"];
/** Trigger conditions that can never hold on a plain send's write, each with why. A trigger on the path whose body moves anything is allowed
 * only under one of these (and the runtime case below shows the plain send does not meet it). */
const NEVER_ON_PLAIN_SEND: ReadonlyArray<{ why: string; when: RegExp }> = [
  // INSERT OR REPLACE of a row already stored under the same id: a rewrite, never U's first write
  { why: "replace of a stored row", when: /^EXISTS\s*\(\s*SELECT 1 FROM main\.messages o WHERE o\.thread_id\s*=\s*NEW\.thread_id AND o\.id\s*=\s*NEW\.id\b/i },
  // memory_meta: only a policy, deletion or mode move; the capture's data_revision bump is none of them
  { why: "policy/deletion/mode move", when: /^OLD\.policy_revision IS NOT NEW\.policy_revision OR OLD\.deletion_epoch IS NOT NEW\.deletion_epoch OR OLD\.mode IS NOT NEW\.mode$/i },
];

interface Trigger { name: string; table: string; event: string; when: string; body: string[] }
function installedTriggers(): Trigger[] {
  expect(lineageTriggersInstalled(), "lineage triggers").toBe(true);
  expect(authorityEpochInstalled(), "authority triggers").toBe(true);
  const rows = database().prepare("SELECT name, sql FROM sqlite_temp_master WHERE type='trigger'").all() as Array<{ name: string; sql: string }>;
  return rows.map(({ name, sql }) => {
    const head = sql.match(/\b(BEFORE|AFTER)\s+(INSERT|UPDATE|DELETE)\b(?:\s+OF\s+[\w\s,]+?)?\s+ON\s+(?:main\.)?(\w+)([\s\S]*?)\bBEGIN\b([\s\S]*)\bEND\s*;?\s*$/i);
    expect(head, `unparsed trigger ${name}`).not.toBeNull();
    const when = (head![4]!.match(/^\s*(?:FOR EACH ROW\s+)?WHEN\s+([\s\S]*?)\s*$/i)?.[1] ?? "").replace(/\s+/g, " ").trim();
    const body = head![5]!.split(";").map(part => part.replace(/\s+/g, " ").trim()).filter(Boolean);
    return { name, table: head![3]!, event: head![2]!.toUpperCase(), when, body };
  });
}

/** Every raw counter the stamps read, ENUMERATED at test time (so a counter TCFO adds or deletes is followed, not hardcoded): every temp
 * lineage_* table but the dirty list, every temp authority_* table, and data_version. */
function rawEpochs(): Record<string, unknown> {
  const db = database();
  const tables = (db.prepare("SELECT name FROM sqlite_temp_master WHERE type='table' AND ((name LIKE 'lineage\\_%' ESCAPE '\\' AND name != 'lineage_dirty') OR name LIKE 'authority\\_%' ESCAPE '\\') ORDER BY name").all() as Array<{ name: string }>).map(row => row.name);
  expect(tables, "the lineage epoch is among the raw counters").toContain("lineage_epoch");
  const out: Record<string, unknown> = { dataVersion: db.prepare("SELECT data_version AS v FROM pragma_data_version").get()?.v };
  for (const name of tables) out[name] = db.prepare(`SELECT * FROM temp.${name} ORDER BY rowid`).all();
  return out;
}
const count = (table: string) => { try { return Number(database().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0); } catch { return -1; } };
const line = (id: string, role: "user" | "bot", parentId: string | undefined, at: number): Message =>
  ({ id, role, kind: "text", text: `line ${id} about the weekly plan`, at, ...(parentId ? { parentId } : {}) }) as Message;

describe("r15.1 Y1/Y2: a plain send's writes before the compare move no raw epoch", () => {
  it("every installed trigger on the plain-send path only notes dirty keys, or holds only under a condition a plain send never meets", () => {
    const path = installedTriggers().filter(t => PATH.some(p => p.table === t.table && p.events.includes(t.event)));
    expect(path.map(t => t.table), "the messages INSERT note exists").toContain("messages");
    const bad: string[] = [];
    for (const t of path) {
      if (!t.body.some(statement => RAW_WRITE.test(statement) && !NEVER_FOR_FRESH_U.some(rule => rule.statement.test(statement)))) continue;
      const excuse = NEVER_ON_PLAIN_SEND.find(rule => rule.when.test(t.when));
      if (!excuse) bad.push(`${t.name} (${t.event} ${t.table}) WHEN [${t.when}] BEGIN ${t.body.join("; ")}`);
    }
    expect(bad, "triggers on the plain-send path that move more than a NOTE").toEqual([]);
    // the one counter the path does move (app_write_revision, app-write-revision.ts) is read by no stamp a warm turn rests on
    for (const name of STAMP_MODULES) {
      let text = ""; try { text = readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8"); } catch { continue; }
      expect(text, `${name} reads app_write_revision`).not.toMatch(/app_write_revision|appWriteRevision/);
    }
  });

  it("a real plain append with capture moves no raw epoch, notes only U's own keys, and writes no root-set or tombstone row", () => {
    installedTriggers();
    appendMessage(THREAD, line("q1", "user", undefined, 1));
    appendMessage(THREAD, line("r1", "bot", "q1", 2));
    database().exec("DELETE FROM temp.lineage_dirty");
    const before = rawEpochs(), rows = { members: count("memory_root_set_members"), parents: count("memory_root_set_parents"), sets: count("memory_root_sets"), tombstones: count("memory_tombstones") };
    appendMessage(THREAD, line("U", "user", "r1", 3));
    expect(rawEpochs(), "raw epochs").toEqual(before);
    expect({ members: count("memory_root_set_members"), parents: count("memory_root_set_parents"), sets: count("memory_root_sets"), tombstones: count("memory_tombstones") }).toEqual(rows);
    expect(database().prepare("SELECT 1 AS ok FROM memory_sources WHERE id=?").get(`message:${THREAD}:U`), "U was captured").toBeTruthy();
    const SEP = String.fromCharCode(31);
    const dirty = (database().prepare("SELECT DISTINCT k FROM temp.lineage_dirty").all() as Array<{ k: string }>).map(row => row.k).sort();
    // U's own keys at most (b13e notes none for a fresh line; TCFO adds the messages INSERT m note and the version s note)
    const own = new Set([`m${SEP}${THREAD}${SEP}U`, `s${SEP}message:${THREAD}:U`]);
    expect(dirty.filter(key => !own.has(key)), "notes other than U's own").toEqual([]);
    expect(database().prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id=? AND at>=3").get(THREAD)?.n, "exactly one row after the anchor").toBe(1);
  });
});

describe("r15.1: the cases that DO move a raw counter are visible to W3' (so they read INELIGIBLE, today's path)", () => {
  it("re-inserting a forgotten line moves lineage_forgets where TCFO installs it (any raw move: the send is not covered)", () => {
    installedTriggers();
    const forgetsAt = () => { try { return Number(database().prepare("SELECT n FROM temp.lineage_forgets").get()?.n); } catch { return null; } };
    if (forgetsAt() === null) return; // b13e: no forgets counter (TCFO r2 adds it); the gate runs this after the rebase onto TCFO
    appendMessage(THREAD, line("q1", "user", undefined, 1));
    database().prepare("INSERT INTO memory_tombstones(id,target_type,target_id,revision,content_hash,epoch,reason,created_at) VALUES(?,?,?,NULL,NULL,1,?,1)")
      .run("tomb-x", "source", `message:${THREAD}:X`, "forgotten");
    const before = rawEpochs();
    appendMessage(THREAD, line("X", "user", "q1", 2));
    expect(rawEpochs().lineage_forgets, "forgets moved").not.toEqual(before.lineage_forgets);
  });
  it("a root-set member or parent written into an already stored set moves lineage_structure (never on the plain-send path, asserted above)", () => {
    const struct = installedTriggers().filter(t => t.name.startsWith("lineage_") && (t.table === "memory_root_set_members" || t.table === "memory_root_set_parents") && t.event === "INSERT");
    for (const t of struct) expect(t.body.join("; "), `${t.name} notes its set`).toMatch(/lineage_dirty/);
  });
});

describe("r15.1 shared connection: post-reply writers commit on the shared connection", () => {
  const server = fileURLToPath(new URL("../", import.meta.url));
  const read = (rel: string) => readFileSync(join(server, rel), "utf8");
  /** The reply's append, the cursor write (store.ts setResumeCursor / patchTask), capture, publish, the lineage and revoke writes, the
   * branch index and head, the turn's catch-up. */
  const WRITERS = ["index.ts", "store.ts", "message-db.ts", "branch-store.ts", "memory/capture.ts", "memory/jobs.ts", "memory/recent.ts",
    "memory/lineage-write.ts", "memory/revoke-commit.ts", "memory/branch-change.ts", "memory/park.ts", "memory/thread-no.ts"];
  it("no post-reply writer opens its own DatabaseSync or calls foreignLineageWrite", () => {
    for (const rel of WRITERS) {
      const text = read(rel);
      expect(text, `${rel}: own connection`).not.toMatch(/\bnew DatabaseSync\(/);
      expect(text, `${rel}: foreign lineage write`).not.toMatch(/\bforeignLineageWrite\(/);
    }
  });
  it("foreignLineageWrite has no production caller", () => {
    const callers: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (name === "node_modules" || name === "testing" || name.startsWith(".")) continue;
        if (statSync(path).isDirectory()) { walk(path); continue; }
        if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
        const text = readFileSync(path, "utf8");
        if (/\bforeignLineageWrite\(/.test(text) && !/export function foreignLineageWrite\b/.test(text)) callers.push(path.slice(server.length));
      }
    };
    walk(server);
    expect(callers).toEqual([]);
  });
  it("a reply, its capture and the next turn's catch-up publish leave data_version where it was (no foreign commit for the stamp to see)", () => {
    installedTriggers();
    const version = () => Number(database().prepare("SELECT data_version AS v FROM pragma_data_version").get()?.v);
    const v0 = version();
    appendMessage(THREAD, line("q1", "user", undefined, 1));
    appendMessage(THREAD, line("r1", "bot", "q1", 2));
    const registry = new InternalCapabilities(); registry.begin("dax", THREAD, "g");
    const token = registry.mint({ botId: "dax", threadId: THREAD, generation: "g", depth: 0, kind: "memory", skillAuthoring: false });
    catchUpRecentMemory(memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster));
    appendMessage(THREAD, line("U", "user", "r1", 3));
    expect(version()).toBe(v0);
  });
});
