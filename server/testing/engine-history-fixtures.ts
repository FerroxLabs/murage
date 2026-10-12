// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One fixture per engine for the engine-history deletion tests: a temp tree holding a conversation's history in that engine's
// own layout (JSONL, zstd rollouts, SQLite stores with their text still in the -wal, side files, caches) and a bystander the
// deletion must leave alone. Everything lives under a temp dir the caller made; nothing here touches a real engine home.
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import zlib from "node:zlib";

import type { DeletionEngine, DeletionEngineHome } from "../conversation-deletion.ts";
import { fuigoMemoryKey, fuigoSessionKey } from "../engine-keys.ts";
import { cursorChatsKey, cursorProjectSlug, droidCwdKey, kimiWorkDirKey, md5, qwenProjectHash, qwenProjectKey, sha256 } from "../engine-history-deletion.ts";

export const ENGINES: DeletionEngine[] = ["fuigo", "grok", "claude", "codex", "gemini", "qwen", "opencode", "kimi", "cursor", "droid", "hermes", "antigravity"];
export const BOT = "f25024c1-a18e-4251-acf1-0c1713d9b6d9";
export const THREAD = "2e9018ee-1f45-46be-8ed1-7a02fc022807";

export interface Fixture {
  engine: DeletionEngine;
  root: string;
  homes: DeletionEngineHome[];
  folders: string[];
  memoryFolders: string[];
  sessions: Partial<Record<DeletionEngine, string[]>>;
  /** strings that must be in no byte of the tree after the deletion (raw, decompressed zstd, .db and -wal) */
  canaries: string[];
  /** identifiers of the conversation (thread ids): they may stay in `idsMayRemainIn` (a history row keeps its id, its words go) and nowhere else */
  ids: string[];
  idsMayRemainIn: string[];
  /** what must still be there; returns the problems */
  checkBystanders(): string[];
  /** a reference to every file the deletion should have emptied, for assertions */
  gone: string[];
}

const dump = (value: unknown) => `${JSON.stringify(value)}\n`;
const write = (file: string, text: string | Buffer = "x") => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); };

/** A WAL-mode SQLite file whose rows are still in its -wal (copied while the writer is open, as an engine that never
 * checkpointed would leave it). */
export function walDatabase(file: string, setup: (db: DatabaseSync) => void): void {
  const staging = mkdtempSync(join(tmpdir(), "wal-fixture-"));
  const source = join(staging, "s.db");
  const db = new DatabaseSync(source);
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
    setup(db);
    mkdirSync(path.dirname(file), { recursive: true });
    copyFileSync(source, file);
    if (existsSync(`${source}-wal`)) copyFileSync(`${source}-wal`, `${file}-wal`);
  } finally {
    db.close();
  }
}

function fuigoIndex(file: string, rows: Array<{ id: string; cwd: string; content: string }>): void {
  walDatabase(file, (db) => {
    db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE session_docs (session_id TEXT PRIMARY KEY, cwd TEXT NOT NULL, updated_at INTEGER NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL);
      CREATE VIRTUAL TABLE session_docs_fts USING fts5(title, content, content='session_docs', content_rowid='rowid');
      CREATE TRIGGER session_docs_ai AFTER INSERT ON session_docs BEGIN INSERT INTO session_docs_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content); END;
      CREATE TRIGGER session_docs_ad AFTER DELETE ON session_docs BEGIN INSERT INTO session_docs_fts(session_docs_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content); END;`);
    for (const row of rows) db.prepare("INSERT INTO session_docs(session_id, cwd, updated_at, title, content, content_hash) VALUES (?,?,?,?,?,?)").run(row.id, row.cwd, 1, "t", row.content, "h");
  });
}

/** A SQLite file as its rows, read from a COPY (opening the original would checkpoint its -wal): the logical content that must
 * not change when something only reads. A file that is not a database is hashed as it is. */
function logicalDatabase(file: string): string {
  const staging = mkdtempSync(join(tmpdir(), "digest-"));
  const copy = join(staging, "c.db");
  copyFileSync(file, copy);
  if (existsSync(`${file}-wal`)) copyFileSync(`${file}-wal`, `${copy}-wal`);
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(copy);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
    return createHash("sha256").update(JSON.stringify(tables.map((name) => [name, db!.prepare(`SELECT * FROM "${name}"`).all()]))).digest("hex");
  } catch {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  } finally {
    db?.close();
  }
}

/** Every file under `root` (relative path) with its content digest, symlinks by target: the whole tree as one string.
 * SQLite files count by their rows, so SQLite folding its own log into the file on close is not a change. */
export function treeDigest(root: string): string {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name.endsWith("-shm") || name.endsWith("-wal")) continue;
      const full = join(dir, name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) out.push(`${path.relative(root, full)} -> link`);
      else if (stat.isDirectory()) { out.push(`${path.relative(root, full)}/`); walk(full); }
      else if (/\.(?:db|sqlite)$/.test(name)) out.push(`${path.relative(root, full)} ${logicalDatabase(full)}`);
      else out.push(`${path.relative(root, full)} ${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
    }
  };
  walk(root);
  return out.join("\n");
}

/** Opens every SQLite file under `root`, as an engine that is running would hold its stores: the -wal stays in place while the
 * deletion works. Close them with the returned function. */
export function holdDatabasesOpen(root: string): () => void {
  const held: DatabaseSync[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const stat = lstatSync(full);
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile() && /\.(?:db|sqlite)$/.test(name)) held.push(new DatabaseSync(full));
    }
  };
  walk(root);
  return () => { for (const db of held) db.close(); };
}

/** Where any canary is still readable: raw bytes of every file (SQLite pages and -wal included) and zstd files decompressed. */
export function canaryHits(root: string, canaries: string[]): string[] {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) { walk(full); continue; }
      const bytes = readFileSync(full);
      for (const canary of canaries) if (bytes.includes(canary)) hits.push(`${full}: ${canary}`);
      if (name.endsWith(".zst")) {
        const decode = (zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer }).zstdDecompressSync;
        const text = decode ? decode(bytes) : Buffer.alloc(0);
        for (const canary of canaries) if (text.includes(canary)) hits.push(`${full} (decompressed): ${canary}`);
      }
    }
  };
  walk(root);
  return hits;
}

/** Where an identifier of the conversation is still readable outside the files that keep their rows' ids. */
export function idHits(fx: Fixture): string[] {
  if (!fx.ids.length) return [];
  return canaryHits(fx.root, fx.ids).filter((hit) => !fx.idsMayRemainIn.some((name) => hit.split(": ")[0]!.endsWith(`/${name}`)));
}

export function hasZstd(): boolean {
  return typeof (zlib as unknown as { zstdCompressSync?: unknown }).zstdCompressSync === "function";
}

export function buildFixture(engine: DeletionEngine, base: string): Fixture {
  const root = mkdtempSync(join(base, `fx-${engine}-`));
  const folder = join(root, "data", "workspaces", BOT, "threads", THREAD);
  mkdirSync(folder, { recursive: true });
  write(join(folder, "a.md"));
  const C = `canary-${engine}-5521`;
  const B = `bystander-${engine}-9917`;
  const kept: Array<[string, string]> = []; // file, expected content
  const keptRows: Array<{ db: string; sql: string; rows: unknown[] }> = [];
  const keepFile = (file: string, text: string) => { write(file, text); kept.push([file, text]); };
  const gone: string[] = [];
  const fx: Fixture = {
    engine, root, homes: [], folders: [folder], memoryFolders: [], sessions: {}, canaries: [C], ids: [], idsMayRemainIn: [], gone,
    checkBystanders() {
      const problems: string[] = [];
      for (const [file, text] of kept) {
        if (!existsSync(file)) problems.push(`${file} was removed`);
        else if (readFileSync(file, "utf8") !== text) problems.push(`${file} changed`);
      }
      for (const { db, sql, rows } of keptRows) {
        const handle = new DatabaseSync(db);
        try {
          const got = JSON.stringify(handle.prepare(sql).all());
          if (got !== JSON.stringify(rows)) problems.push(`${db}: ${sql} gave ${got}`);
        } finally { handle.close(); }
      }
      return problems;
    },
  };
  const home = join(root, "home");

  switch (engine) {
    case "fuigo":
    case "grok": {
      const h = join(home, engine === "fuigo" ? ".fuigo" : ".grok");
      write(join(h, "sessions", fuigoSessionKey(folder), "s-1", "chat_history.jsonl"), dump({ text: C }));
      gone.push(join(h, "sessions", fuigoSessionKey(folder)));
      keepFile(join(h, "sessions", "other-key", "s-other", "chat_history.jsonl"), dump({ text: B }));
      write(join(h, "logs", "unified.jsonl"), dump({ sid: "s-1", text: C }) + dump({ sid: "s-other", text: B }));
      fx.checkBystanders = ((inner) => () => {
        const problems = inner();
        // the dropped row keeps its keys and its values are spaces of the same length (never cut), so only the other session's row has any content
        const rows = readFileSync(join(h, "logs", "unified.jsonl"), "utf8").split("\n").filter((line) => line.trim() !== "");
        const live = rows.filter((line) => line.includes(B));
        if (live.length !== 1 || live[0] !== JSON.stringify({ sid: "s-other", text: B }) || rows.some((line) => line.includes(C))) problems.push("logs/unified.jsonl holds more than the other session's line");
        for (const line of rows) { try { JSON.parse(line); } catch { problems.push("logs/unified.jsonl holds a row that is not JSON"); } }
        return problems;
      })(fx.checkBystanders.bind(fx));
      fuigoIndex(join(h, "sessions", "session_search.sqlite"), [{ id: "s-1", cwd: folder, content: C }, { id: "s-other", cwd: "/w/other", content: B }]);
      keptRows.push({ db: join(h, "sessions", "session_search.sqlite"), sql: "SELECT session_id FROM session_docs ORDER BY 1", rows: [{ session_id: "s-other" }] });
      write(join(h, "memory", fuigoMemoryKey(folder), "note.md"), C);
      keepFile(join(h, "memory", "other-1234abcd", "note.md"), B);
      fx.memoryFolders = [folder];
      fx.homes = [{ engine, home: h }];
      break;
    }
    case "claude": {
      const h = join(home, ".claude");
      const key = folder.replace(/[^a-zA-Z0-9]/g, "-");
      const hash = "ab12cd34ef56ab12", shared = "1122334455667788", others = "ffeeddccbbaa9988";
      write(join(h, "projects", key, "sess-claude-1.jsonl"), dump({ type: "user", cwd: folder, sessionId: "sess-claude-1", slug: "cool-slug", message: C }) + dump({ type: "assistant", message: "more" }));
      gone.push(join(h, "projects", key));
      keepFile(join(h, "projects", "-other", "s9.jsonl"), dump({ type: "user", cwd: "/other", sessionId: "sess-other", message: B }));
      write(join(h, "history.jsonl"), dump({ sessionId: "sess-claude-1", project: folder, display: C, pastedContents: { 1: { contentHash: hash }, 2: { contentHash: shared } } })
        + dump({ sessionId: "sess-other", project: "/other", display: B, pastedContents: { 1: { contentHash: shared }, 2: { contentHash: others } } }));
      write(join(h, "paste-cache", `${hash}.txt`), C);
      keepFile(join(h, "paste-cache", `${shared}.txt`), "shared paste");
      keepFile(join(h, "paste-cache", `${others}.txt`), B);
      write(join(h, "debug", "sess-claude-1.txt"), C);
      write(join(h, "file-history", "sess-claude-1", "f"), C);
      write(join(h, "plans", "cool-slug.md"), C);
      keepFile(join(h, "plans", "other-slug.md"), B);
      symlinkSync(join(h, "debug", "sess-claude-1.txt"), join(h, "debug", "latest"));
      fx.canaries = [C, hash];
      fx.homes = [{ engine, home: h }];
      // the history keeps only the other session's line; that line is checked by content
      fx.checkBystanders = ((inner) => () => {
        const problems = inner();
        const history = readFileSync(join(h, "history.jsonl"), "utf8");
        if (!history.includes(B) || history.includes(C)) problems.push("history.jsonl lost the other session's line or kept this one");
        return problems;
      })(fx.checkBystanders.bind(fx));
      break;
    }
    case "codex": {
      const h = join(home, ".codex");
      const sqlHome = join(home, ".codex-sql");
      const tid = "019a0000-aaaa-7bbb-8ccc-000000000001", zid = "019a0000-aaaa-7bbb-8ccc-000000000002", oid = "019a0000-aaaa-7bbb-8ccc-0000000000ff";
      const meta = (id: string, cwd: string, text: string) => dump({ type: "session_meta", payload: { id, cwd } }) + dump({ type: "event", text });
      write(join(h, "sessions", "2026", "10", "11", `rollout-2026-10-11T10-00-00-${tid}.jsonl`), meta(tid, folder, C));
      gone.push(join(h, "sessions", "2026", "10", "11", `rollout-2026-10-11T10-00-00-${tid}.jsonl`));
      const compressed = (hasZstd() ? (zlib as unknown as { zstdCompressSync: (b: Buffer) => Buffer }).zstdCompressSync(Buffer.from(meta(zid, folder, C))) : Buffer.from(meta(zid, folder, C)));
      write(join(h, "archived_sessions", hasZstd() ? `rollout-2026-10-10T09-00-00-${zid}.jsonl.zst` : `rollout-2026-10-10T09-00-00-${zid}.jsonl`), compressed);
      keepFile(join(h, "sessions", "2026", "10", "11", `rollout-2026-10-11T11-00-00-${oid}.jsonl`), meta(oid, "/other/folder", B));
      write(join(h, "history.jsonl"), dump({ session_id: tid, text: C }) + dump({ session_id: zid, text: C }) + dump({ session_id: oid, text: B }));
      write(join(h, "session_index.jsonl"), dump({ id: tid, thread_name: C }) + dump({ id: oid, thread_name: B }));
      write(join(h, "shell_snapshots", `${tid}.1.sh`), C);
      keepFile(join(h, "shell_snapshots", `${oid}.1.sh`), B);
      walDatabase(join(sqlHome, "state_1.sqlite"), (db) => {
        db.exec("CREATE TABLE threads(id TEXT, title TEXT); CREATE TABLE logs(thread_id TEXT, body TEXT);");
        for (const id of [tid, zid]) { db.prepare("INSERT INTO threads VALUES(?,?)").run(id, C); db.prepare("INSERT INTO logs VALUES(?,?)").run(id, C); }
        db.prepare("INSERT INTO threads VALUES(?,?)").run(oid, B);
        db.prepare("INSERT INTO logs VALUES(?,?)").run(oid, B);
      });
      keptRows.push({ db: join(sqlHome, "state_1.sqlite"), sql: "SELECT id FROM threads ORDER BY 1", rows: [{ id: oid }] });
      fx.canaries = [C];
      fx.ids = [tid, zid];
      fx.idsMayRemainIn = ["history.jsonl", "session_index.jsonl"];
      fx.homes = [{ engine, home: h, sqliteHome: sqlHome }];
      fx.checkBystanders = ((inner) => () => {
        const problems = inner();
        const history = readFileSync(join(h, "history.jsonl"), "utf8");
        if (!history.includes(B)) problems.push("history.jsonl lost the other thread's line");
        return problems;
      })(fx.checkBystanders.bind(fx));
      break;
    }
    case "gemini": {
      const h = join(home, ".gemini");
      write(join(h, "projects.json"), JSON.stringify({ projects: { [folder]: THREAD, "/other": "other" } }));
      write(join(h, "tmp", THREAD, ".project_root"), folder);
      write(join(h, "tmp", THREAD, "chats", "session-x.jsonl"), C);
      write(join(h, "history", THREAD, ".project_root"), folder);
      write(join(h, "history", THREAD, "HEAD"), C);
      write(join(h, "tmp", sha256(folder), "logs.json"), C);
      gone.push(join(h, "tmp", THREAD), join(h, "history", THREAD), join(h, "tmp", sha256(folder)));
      keepFile(join(h, "tmp", "other", ".project_root"), "/other");
      keepFile(join(h, "tmp", "other", "chats", "c.jsonl"), B);
      keepFile(join(h, "tmp", `${THREAD}-1`, ".project_root"), "/other-folder");
      fx.homes = [{ engine, home: h }];
      break;
    }
    case "qwen": {
      const h = join(home, ".qwen");
      const sid = "b2c6d1a0-1111-4222-8333-444455556666";
      write(join(h, "projects", qwenProjectKey(folder), "chats", `${sid}.jsonl`), dump({ cwd: folder, message: C }));
      write(join(h, "tmp", qwenProjectHash(folder), "shell_history"), C);
      write(join(h, "history", qwenProjectHash(folder), "HEAD"), C);
      write(join(h, "todos", `${sid}.json`), C);
      write(join(h, "debug", `${sid}.txt`), C);
      write(join(h, "plans", `${sid}.md`), C);
      gone.push(join(h, "projects", qwenProjectKey(folder)), join(h, "todos", `${sid}.json`));
      keepFile(join(h, "projects", "other", "chats", "o.jsonl"), dump({ cwd: "/other", message: B }));
      keepFile(join(h, "plans", "other.md"), B);
      keepFile(join(h, "oauth_creds.json"), "sign-in");
      fx.homes = [{ engine, home: h, secondary: h }];
      break;
    }
    case "opencode": {
      const d = join(home, ".local", "share", "opencode");
      walDatabase(join(d, "opencode.db"), (db) => {
        db.exec(`CREATE TABLE session(id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT);
          CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT REFERENCES session(id) ON DELETE CASCADE, data TEXT);
          CREATE TABLE event(id INTEGER PRIMARY KEY, aggregate_id TEXT, data TEXT);
          CREATE TABLE account(id TEXT, token TEXT);`);
        db.prepare("INSERT INTO session VALUES(?,?,?,?)").run("ses_a", null, folder, C);
        db.prepare("INSERT INTO session VALUES(?,?,?,?)").run("ses_child", "ses_a", "/sub/dir", C);
        db.prepare("INSERT INTO session VALUES(?,?,?,?)").run("ses_other", null, "/other", B);
        db.prepare("INSERT INTO message VALUES(?,?,?)").run("m1", "ses_a", C);
        db.prepare("INSERT INTO message VALUES(?,?,?)").run("m2", "ses_other", B);
        db.prepare("INSERT INTO event(aggregate_id,data) VALUES(?,?)").run("ses_child", C);
        db.prepare("INSERT INTO account VALUES(?,?)").run("acct", "sign-in");
      });
      write(join(d, "storage", "session_diff", "ses_a.json"), C);
      write(join(d, "storage", "session_diff", "ses_child.json"), C);
      keepFile(join(d, "storage", "session_diff", "ses_other.json"), B);
      keptRows.push({ db: join(d, "opencode.db"), sql: "SELECT id FROM session ORDER BY 1", rows: [{ id: "ses_other" }] }, { db: join(d, "opencode.db"), sql: "SELECT id FROM message ORDER BY 1", rows: [{ id: "m2" }] });
      fx.homes = [{ engine, home: d }];
      break;
    }
    case "kimi": {
      const h = join(home, ".kimi-code");
      write(join(h, "sessions", kimiWorkDirKey(folder), "s1", "agents", "main", "wire.jsonl"), C);
      gone.push(join(h, "sessions", kimiWorkDirKey(folder)));
      keepFile(join(h, "sessions", "wd_other_000000000000", "s2", "state.json"), B);
      write(join(h, "session_index.jsonl"), dump({ sessionId: "s1", workDir: folder, title: C }) + dump({ sessionId: "s2", workDir: "/other", title: B }));
      write(join(h, "user-history", `${md5(folder)}.jsonl`), C);
      keepFile(join(h, "credentials", "kimi-code.json"), "sign-in");
      fx.homes = [{ engine, home: h }];
      fx.checkBystanders = ((inner) => () => {
        const problems = inner();
        const index = readFileSync(join(h, "session_index.jsonl"), "utf8");
        if (!index.includes(B)) problems.push("session_index.jsonl lost the other session's line");
        return problems;
      })(fx.checkBystanders.bind(fx));
      break;
    }
    case "cursor": {
      const h = join(home, ".cursor");
      write(join(h, "projects", cursorProjectSlug(folder), "agent-transcripts", "s", "s.jsonl"), C);
      write(join(h, "chats", cursorChatsKey(folder), "a", "store.db"), C);
      write(join(h, "acp-sessions", "current-session", "store.db"), C);
      gone.push(join(h, "projects", cursorProjectSlug(folder)), join(h, "chats", cursorChatsKey(folder)), join(h, "acp-sessions", "current-session"));
      keepFile(join(h, "acp-sessions", "someone-else", "store.db"), B);
      keepFile(join(h, "cli-config.json"), "settings");
      fx.sessions = { cursor: ["current-session"] };
      fx.homes = [{ engine, home: h, secondary: h }];
      break;
    }
    case "droid": {
      const h = join(home, ".factory");
      const sid = "7d7c0000-1111-4222-8333-444455556666";
      const bucket = join(h, "sessions", droidCwdKey(folder));
      write(join(bucket, `${sid}.jsonl`), C);
      write(join(bucket, `${sid}.settings.json`), "{}");
      write(join(h, "sessions", `${sid}.jsonl`), C);
      gone.push(bucket, join(h, "sessions", `${sid}.jsonl`));
      keepFile(join(h, "sessions", "-other", "o.jsonl"), B);
      walDatabase(join(h, "cache", "session-index", "index.db"), (db) => {
        db.exec("CREATE TABLE sessions(session_id TEXT, summary TEXT); CREATE TABLE files(transcript_path TEXT, fingerprint TEXT);");
        db.prepare("INSERT INTO sessions VALUES(?,?)").run(sid, C);
        db.prepare("INSERT INTO sessions VALUES(?,?)").run("other", B);
        db.prepare("INSERT INTO files VALUES(?,?)").run(`/x/${sid}.jsonl`, C);
      });
      keptRows.push({ db: join(h, "cache", "session-index", "index.db"), sql: "SELECT session_id FROM sessions", rows: [{ session_id: "other" }] });
      keepFile(join(h, "auth.v2.file"), "sign-in");
      fx.homes = [{ engine, home: h }];
      break;
    }
    case "hermes": {
      const h = join(home, ".hermes");
      const sid = "a1b2c3d4-1111-4222-8333-444455556666", child = "child-0000000001", other = "other-0000000001";
      walDatabase(join(h, "state.db"), (db) => {
        db.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY, parent_session_id TEXT, meta TEXT); CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, content TEXT);");
        db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(sid, null, "{}");
        db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(child, sid, "{}");
        db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(other, null, "{}");
        db.prepare("INSERT INTO messages(session_id,content) VALUES(?,?)").run(sid, C);
        db.prepare("INSERT INTO messages(session_id,content) VALUES(?,?)").run(child, C);
        db.prepare("INSERT INTO messages(session_id,content) VALUES(?,?)").run(other, B);
      });
      write(join(h, "sessions", `${sid}.jsonl`), C);
      write(join(h, "sessions", `request_dump_${sid}_1.json`), C);
      write(join(h, "sessions", `${child}.jsonl`), C);
      gone.push(join(h, "sessions", `${sid}.jsonl`), join(h, "sessions", `${child}.jsonl`));
      keepFile(join(h, "sessions", `${other}.json`), B);
      keptRows.push({ db: join(h, "state.db"), sql: "SELECT id FROM sessions", rows: [{ id: other }] }, { db: join(h, "state.db"), sql: "SELECT content FROM messages", rows: [{ content: B }] });
      fx.sessions = { hermes: [sid] };
      fx.homes = [{ engine, home: h }];
      break;
    }
    case "antigravity": {
      const h = join(home, ".gemini", "antigravity-cli");
      const cid = "c0ffee00-1111-4222-8333-444455556666";
      write(join(h, "brain", cid, ".system_generated", "logs", "transcript.jsonl"), C);
      write(join(h, "conversations", `${cid}.pb`), C);
      write(join(h, "annotations", `${cid}.pbtxt`), C);
      gone.push(join(h, "brain", cid), join(h, "conversations", `${cid}.pb`));
      keepFile(join(h, "brain", "other-conversation", "x"), B);
      walDatabase(join(h, "conversation_summaries.db"), (db) => {
        db.exec("CREATE TABLE summaries(app_data_dir TEXT, conversation_id TEXT, summary TEXT)");
        db.prepare("INSERT INTO summaries VALUES(?,?,?)").run(h, cid, C);
        db.prepare("INSERT INTO summaries VALUES(?,?,?)").run(h, "other-conversation", B);
      });
      keptRows.push({ db: join(h, "conversation_summaries.db"), sql: "SELECT conversation_id FROM summaries", rows: [{ conversation_id: "other-conversation" }] });
      fx.sessions = { antigravity: [cid] };
      fx.homes = [{ engine, home: h }];
      break;
    }
  }
  return fx;
}
