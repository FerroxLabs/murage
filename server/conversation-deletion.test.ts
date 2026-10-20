// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn } from "node:child_process";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { atomicWriteCount } from "./atomic.ts";
import { engineHistoryTestHooks, runEngineHistoryOffThread } from "./engine-history-offthread.ts";
import { executeEnginePlans, type ExecResult } from "./engine-exec.ts";
import { realEngineFs } from "./engine-fs.ts";
import { keepOut } from "./testing/keep-out.ts";
import { isCleared, JSONL_FORMAT, rowSkeleton, type Step } from "./engine-plan-core.ts";

import {
  ConversationDeletions,
  claudeProjectKey,
  engineSlug,
  fuigoMemoryKey,
  fuigoSessionKey,
  insideGitRepository,
  isStrictlyInside,
  removeConfined,
  runConversationDeletion,
  rustUrlEncode,
} from "./conversation-deletion.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { windowsPerfBudget } from "./testing/windows-hosted.ts";

const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-delete-")));
// Every messages.db a test opens is closed before the folder goes: Windows
// refuses to remove a folder with an open file in it.
const openDatabases: DatabaseSync[] = [];
afterAll(() => { for (const db of openDatabases) db.close(); removeTempDirSync(scratch); });
let counter = 0;
const fresh = (name: string) => {
  const dir = join(scratch, `${name}-${++counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const touch = (file: string, text = "x") => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

const MARKER_TEXT = "private-words-8841";

/** The steps a plan lists for Fuigo's session search index, run by the executor (the way a deletion runs them): the rows of these
 * sessions and folders deleted, the index merged, the log checkpointed and the free pages vacuumed. */
function scrubSearch(index: string, sessionIds: string[], folders: string[]): { changed: boolean; ran: ExecResult | null } {
  const ids = [...new Set(sessionIds)], cwds = [...new Set(folders)];
  if (!ids.length && !cwds.length) return { changed: false, ran: null };
  const probe = new DatabaseSync(index);
  let tables: Set<string>, before = 0;
  const where = [ids.length ? `session_id IN (${ids.map(() => "?").join(",")})` : "", cwds.length ? `cwd IN (${cwds.map(() => "?").join(",")})` : ""].filter(Boolean).join(" OR ");
  try {
    tables = new Set((probe.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as Array<{ name: string }>).map((row) => row.name));
    if (tables.has("session_docs")) before = Number((probe.prepare(`SELECT count(*) AS n FROM session_docs WHERE ${where}`).get(...ids, ...cwds) as { n?: number }).n ?? 0);
  } finally { probe.close(); }
  if (!tables.has("session_docs")) return { changed: false, ran: null };
  const pragmas = "PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;";
  const steps: Step[] = [
    { k: "sqlDelete", cls: "content", group: index, db: index, pragmas, stmts: [{ table: "session_docs", where, params: [...ids, ...cwds] }] },
    ...(tables.has("session_docs_fts") ? [{ k: "ftsOptimize", cls: "hygiene", group: index, db: index } as Step] : []),
    { k: "checkpoint", cls: "content", group: index, db: index },
    { k: "vacuumIfFree", cls: "hygiene", group: index, db: index },
  ];
  const ran = executeEnginePlans({ x: { engine: "fuigo", home: path.dirname(index), steps } });
  return { changed: before > 0, ran };
}

/** Rows of a Fuigo log that a predicate picks, cleared in place by the executor under the log's own lock. */
function scrubLog(file: string, drop: (row: Record<string, unknown>) => boolean): number {
  const format = JSONL_FORMAT["fuigo-unified"]!;
  const rows: Array<{ off: number; len: number; sha: string }> = [];
  realEngineFs().eachRow(file, [], (row, line, off) => { if (row && drop(row) && !isCleared(line, format)) rows.push({ off, len: line.length, sha: rowSkeleton(line, format)! }); });
  if (!rows.length) return 0;
  const step = { k: "rewrite", cls: "content", path: file, mode: "blank", pred: { any: [] }, needles: [], format: "fuigo-unified", how: "lock", fp: { size: 0, mtimeMs: 0, ino: lstatSync(file).ino }, lines: rows } as Step;
  executeEnginePlans({ x: { engine: "fuigo", home: path.dirname(file), steps: [step] } });
  return rows.length;
}

/** Fuigo's session search index, with its exact schema (fuigo-session-search
 * fts.rs, schema generation current in 1.0.x) and journal mode (WAL). */
function fuigoSearchIndex(file: string, rows: Array<{ id: string; cwd: string; title: string; content: string }>): DatabaseSync {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS session_docs (session_id TEXT PRIMARY KEY, cwd TEXT NOT NULL, updated_at INTEGER NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL);
    CREATE VIRTUAL TABLE IF NOT EXISTS session_docs_fts USING fts5(title, content, content='session_docs', content_rowid='rowid');
    CREATE TRIGGER IF NOT EXISTS session_docs_ai AFTER INSERT ON session_docs BEGIN
      INSERT INTO session_docs_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content); END;
    CREATE TRIGGER IF NOT EXISTS session_docs_ad AFTER DELETE ON session_docs BEGIN
      INSERT INTO session_docs_fts(session_docs_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content); END;
    CREATE TRIGGER IF NOT EXISTS session_docs_au AFTER UPDATE ON session_docs BEGIN
      INSERT INTO session_docs_fts(session_docs_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content);
      INSERT INTO session_docs_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content); END;`);
  const insert = db.prepare("INSERT INTO session_docs(session_id, cwd, updated_at, title, content, content_hash) VALUES (?,?,?,?,?,?)");
  // one row per statement, as Fuigo writes them, so each lands in its own FTS segment
  for (const row of rows) insert.run(row.id, row.cwd, 1, row.title, row.content, "h");
  return db;
}
const fileHas = (file: string, text: string) => [file, `${file}-wal`].some((name) => existsSync(name) && readFileSync(name).includes(text));
const BOT = "f25024c1-a18e-4251-acf1-0c1713d9b6d9";
const THREAD = "2e9018ee-1f45-46be-8ed1-7a02fc022807";
const OTHER = "9b0e3c1a-0000-4000-8000-000000000001";

describe("engine folder keys", () => {
  it("encodes a Windows folder the way Fuigo named it on the customer machine", () => {
    const cwd = `C:\\cust\\wd\\data\\workspaces\\${BOT}\\threads\\${THREAD}`;
    expect(fuigoSessionKey(cwd)).toBe(`C%3A%5Ccust%5Cwd%5Cdata%5Cworkspaces%5C${BOT}%5Cthreads%5C${THREAD}`);
  });

  it("encodes a POSIX folder with the urlencoding crate's unreserved set", () => {
    expect(rustUrlEncode("/Users/Shared/my notes/data (1)/a~b_c.d-e!*'")).toBe(
      "%2FUsers%2FShared%2Fmy%20notes%2Fdata%20%281%29%2Fa~b_c.d-e%21%2A%27",
    );
    expect(rustUrlEncode("/Users/zoë")).toBe("%2FUsers%2Fzo%C3%AB");
  });

  it("switches to the slug form past 255 encoded bytes", () => {
    const long = `/Users/${"x".repeat(200)}/workspaces/${BOT}/threads/${THREAD}`;
    // blake3 digest from the blake3 crate's C reference for this exact string
    expect(fuigoSessionKey(long)).toBe(`${THREAD}-bf24c475b6ab630d`);
    expect(engineSlug("My Project__Name!!", 40)).toBe("my-project-name");
    expect(engineSlug("---", 40)).toBe("");
  });

  it("keys Claude Code projects by replacing every non letter or digit", () => {
    expect(claudeProjectKey(`C:\\cust\\wd\\data\\workspaces\\${BOT}\\threads\\${THREAD}`)).toEqual({
      exact: `C--cust-wd-data-workspaces-${BOT}-threads-${THREAD}`,
    });
    expect(claudeProjectKey("/Users/a/.murage/x")).toEqual({ exact: "-Users-a--murage-x" });
    const long = `/${"a".repeat(250)}`;
    expect(claudeProjectKey(long)).toEqual({ prefix: `-${"a".repeat(199)}-` });
  });
});

describe("path confinement", () => {
  it("accepts only paths strictly below the root, on both path styles", () => {
    expect(isStrictlyInside("/data/events", "/data/events/a.ndjson")).toBe(true);
    expect(isStrictlyInside("/data/events", "/data/events")).toBe(false);
    expect(isStrictlyInside("/data/events", "/data/events/../bots.json")).toBe(false);
    expect(isStrictlyInside("/data/events", "/data/eventsX/a")).toBe(false);
    expect(isStrictlyInside("/data/events", "/data/events/..a")).toBe(true);
    expect(isStrictlyInside("/data/events", "relative/a")).toBe(false);
    expect(isStrictlyInside("C:\\data\\events", "C:\\data\\events\\a.ndjson")).toBe(true);
    expect(isStrictlyInside("C:\\data\\events", "c:\\DATA\\events\\a.ndjson")).toBe(true);
    expect(isStrictlyInside("C:\\data\\events", "D:\\data\\events\\a")).toBe(false);
    expect(isStrictlyInside("C:\\data\\events", "C:\\data\\events\\..\\config.json")).toBe(false);
  });

  it("removes a folder inside its root and refuses one outside", () => {
    const root = fresh("root");
    touch(join(root, "a", "b.txt"));
    const outside = fresh("outside");
    touch(join(outside, "keep.txt"));
    expect(removeConfined(root, join(root, "a"))).toBe("removed");
    expect(existsSync(join(root, "a"))).toBe(false);
    expect(removeConfined(root, join(root, "..", path.basename(outside)))).toBe("refused");
    expect(removeConfined(root, root)).toBe("refused");
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
    expect(removeConfined(root, join(root, "missing"))).toBe("absent");
  });

  it("never follows a symlink, at the target or on the way to it", () => {
    const root = fresh("root");
    const outside = fresh("outside");
    touch(join(outside, "keep", "file.txt"));
    symlinkSync(join(outside, "keep"), join(root, "link"));
    symlinkSync(outside, join(root, "via"));
    expect(removeConfined(root, join(root, "via", "keep"))).toBe("refused");
    expect(removeConfined(root, join(root, "link"))).toBe("removed");
    expect(existsSync(join(root, "link"))).toBe(false);
    expect(existsSync(join(outside, "keep", "file.txt"))).toBe(true);
  });
});

function messagesDb(dir: string) {
  const db = new DatabaseSync(join(dir, "messages.db"));
  openDatabases.push(db);
  db.exec("CREATE TABLE IF NOT EXISTS messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id))");
  return db;
}

function seed(data: string, fuigoHome: string, claudeHome: string, codexHome: string, db: DatabaseSync) {
  const desk = join(data, "workspaces", BOT, "threads", THREAD);
  touch(join(desk, "notes", "pipeline.md"), "mail");
  touch(join(data, "workspaces", THREAD, "agy-notes.md"), "mail");
  touch(join(data, "workspaces", BOT, "MEMORY.md"), "bot memory");
  touch(join(data, "workspaces", BOT, "threads", OTHER, "keep.md"));
  touch(join(data, "events", `${THREAD}.ndjson`));
  touch(join(data, "native", `${THREAD}.ndjson`));
  touch(join(data, "native", `${THREAD}.previous.ndjson`));
  touch(join(data, "events", `${OTHER}.ndjson`));
  touch(join(data, "skill-state", BOT, "task-bundles", THREAD, "a.json"));
  touch(join(data, "skill-state", BOT, "skills.json"));
  const image = "0b7c1f2e-1111-4222-8333-444455556666.png";
  const shared = "0b7c1f2e-1111-4222-8333-777788889999.png";
  touch(join(data, "attachments", image));
  touch(join(data, "attachments", shared));
  db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)").run(THREAD, "m1", 1, "bot", "text", "hi", JSON.stringify({ attachments: [{ kind: "image", path: join(data, "attachments", image) }, { kind: "image", path: join(data, "attachments", shared) }] }));
  db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)").run(OTHER, "m2", 1, "bot", "text", "hi", JSON.stringify({ attachments: [{ kind: "image", path: join(data, "attachments", shared) }] }));
  const fuigoSession = join(fuigoHome, "sessions", rustUrlEncode(desk), "01a0d905", "chat_history.jsonl");
  touch(fuigoSession);
  touch(join(fuigoHome, "sessions", rustUrlEncode(join(data, "workspaces", BOT)), "s", "chat_history.jsonl"));
  const claudeDir = join(claudeHome, "projects", desk.replace(/[^a-zA-Z0-9]/g, "-"));
  touch(join(claudeDir, "s1.jsonl"), `${JSON.stringify({ type: "user", cwd: desk })}\n`);
  touch(join(codexHome, "sessions", "2026", "09", "25", "rollout-2026-09-25T10-00-00-abc.jsonl"), `${JSON.stringify({ type: "session_meta", payload: { id: "abc", cwd: desk } })}\n`);
  touch(join(codexHome, "sessions", "2026", "09", "25", "rollout-2026-09-25T11-00-00-def.jsonl"), `${JSON.stringify({ type: "session_meta", payload: { id: "def", cwd: join(data, "workspaces", BOT) } })}\n`);
  return { desk, image, shared, fuigoSession, claudeDir };
}

describe("ConversationDeletions", () => {
  it("removes every file of the conversation and keeps what other conversations use", async () => {
    const data = fresh("data");
    const fuigoHome = fresh("fuigo");
    const claudeHome = fresh("claude");
    const codexHome = fresh("codex");
    const db = messagesDb(data);
    const seeded = seed(data, fuigoHome, claudeHome, codexHome, db);
    const deletions = new ConversationDeletions({ dataDir: data, database: () => db });
    const order: string[] = [];
    const { report } = await runConversationDeletion(deletions, {
      threadIds: [THREAD],
      engineKinds: ["fuigoAgent", "customAcp", "grok", "piAgent", "openclawAgent"],
      engineHomes: [{ engine: "fuigo", home: fuigoHome }, { engine: "claude", home: claudeHome }, { engine: "codex", home: codexHome }],
    }, () => {
      db.prepare("DELETE FROM messages WHERE thread_id=?").run(THREAD);
      order.push("commit");
      return true;
    }, async () => {
      // settled after the commit, before any file goes
      order.push(existsSync(seeded.desk) ? "settle-before-files" : "settle-late");
    });
    expect(order).toEqual(["commit", "settle-before-files"]);

    expect(existsSync(seeded.desk)).toBe(false);
    expect(existsSync(join(data, "workspaces", THREAD))).toBe(false);
    expect(existsSync(join(data, "events", `${THREAD}.ndjson`))).toBe(false);
    expect(existsSync(join(data, "native", `${THREAD}.ndjson`))).toBe(false);
    expect(existsSync(join(data, "native", `${THREAD}.previous.ndjson`))).toBe(false);
    expect(existsSync(join(data, "skill-state", BOT, "task-bundles", THREAD))).toBe(false);
    expect(existsSync(join(data, "attachments", seeded.image))).toBe(false);
    expect(existsSync(path.dirname(path.dirname(seeded.fuigoSession)))).toBe(false);
    expect(existsSync(seeded.claudeDir)).toBe(false);
    expect(existsSync(join(codexHome, "sessions", "2026", "09", "25", "rollout-2026-09-25T10-00-00-abc.jsonl"))).toBe(false);
    // what belongs to the bot or another conversation stays
    expect(existsSync(join(data, "workspaces", BOT, "MEMORY.md"))).toBe(true);
    expect(existsSync(join(data, "workspaces", BOT, "threads", OTHER, "keep.md"))).toBe(true);
    expect(existsSync(join(data, "events", `${OTHER}.ndjson`))).toBe(true);
    expect(existsSync(join(data, "skill-state", BOT, "skills.json"))).toBe(true);
    expect(existsSync(join(data, "attachments", seeded.shared))).toBe(true);
    expect(existsSync(join(fuigoHome, "sessions", rustUrlEncode(join(data, "workspaces", BOT))))).toBe(true);
    expect(existsSync(join(codexHome, "sessions", "2026", "09", "25", "rollout-2026-09-25T11-00-00-def.jsonl"))).toBe(true);

    expect(report.failed).toEqual([]);
    expect(report.leftovers.map((item) => item.what)).toContain("your custom engine's own copy of this conversation");
    expect(report.leftovers.some((item) => item.what.includes("Grok"))).toBe(false);
    // OpenClaw is handled like the custom engine: its own sessions are named
    // honestly as left alone, never silently skipped and never guessed at.
    expect(report.leftovers).toContainEqual({ what: "OpenClaw's own copy of this conversation", where: "OpenClaw's history on this computer" });
    expect(deletions.pending()).toEqual([]);
    for (const item of report.leftovers) expect(`${item.what} ${item.where}`).not.toMatch(/\u2014|\bsafe(ly)?\b|\//i);
  });

  it("removes only this conversation's lines and side files from Claude Code's and Codex's shared history", async () => {
    const data = fresh("data");
    const claudeHome = fresh("claude");
    const codexHome = fresh("codex");
    const db = messagesDb(data);
    const desk = join(data, "workspaces", BOT, "threads", THREAD);
    touch(join(desk, "a.md"), "x");
    const sid = "5f0c7f4e-1111-4222-8333-444455556666", otherSid = "5f0c7f4e-9999-4222-8333-444455556666";
    const project = join(claudeHome, "projects", desk.replace(/[^a-zA-Z0-9]/g, "-"));
    touch(join(project, `${sid}.jsonl`), `${JSON.stringify({ sessionId: sid, cwd: desk, slug: "quiet-river" })}\n`);
    touch(join(project, sid, "tool-results", "r.txt"), MARKER_TEXT);
    touch(join(claudeHome, "history.jsonl"), [
      JSON.stringify({ display: MARKER_TEXT, pastedContents: { 1: { contentHash: "aaaaaaaaaaaaaaaa" } }, timestamp: 1, project: desk, sessionId: sid }),
      JSON.stringify({ display: "older line, no session id", timestamp: 2, project: desk }),
      JSON.stringify({ display: "another project", pastedContents: { 1: { contentHash: "bbbbbbbbbbbbbbbb" } }, timestamp: 3, project: "/elsewhere", sessionId: otherSid }),
      "",
    ].join("\n"));
    touch(join(claudeHome, "paste-cache", "aaaaaaaaaaaaaaaa.txt"), MARKER_TEXT);
    touch(join(claudeHome, "paste-cache", "bbbbbbbbbbbbbbbb.txt"), "kept");
    for (const [dir, name] of [["file-history", `${sid}/abc@v1`], ["debug", `${sid}.txt`], ["tasks", `${sid}/1.json`], ["session-env", `${sid}/hook.sh`], ["image-cache", `${sid}/1.png`], ["uploads", `${sid}/f.pdf`], ["plans", "quiet-river.md"], ["plans", "quiet-river-agent-1.md"]]) touch(join(claudeHome, dir!, name!), MARKER_TEXT);
    touch(join(claudeHome, "file-history", otherSid, "x@v1"), "kept");
    touch(join(claudeHome, "plans", "loud-sea.md"), "kept");
    const tid = "019a0000-aaaa-7bbb-8ccc-000000000001";
    touch(join(codexHome, "sessions", "2026", "09", "25", `rollout-2026-09-25T10-00-00-${tid}.jsonl`), `${JSON.stringify({ type: "session_meta", payload: { id: tid, cwd: desk } })}\n`);
    touch(join(codexHome, "history.jsonl"), `${JSON.stringify({ session_id: tid, ts: 1, text: MARKER_TEXT })}\n${JSON.stringify({ session_id: "other", ts: 2, text: "kept" })}\n`);
    touch(join(codexHome, "session_index.jsonl"), `${JSON.stringify({ id: tid, thread_name: MARKER_TEXT })}\n${JSON.stringify({ id: "other", thread_name: "kept" })}\n`);
    touch(join(codexHome, "shell_snapshots", `${tid}.abc.sh`), "env");
    touch(join(codexHome, "shell_snapshots", "other.abc.sh"), "env");
    const state = new DatabaseSync(join(codexHome, "state_5.sqlite"));
    state.exec("CREATE TABLE threads(id TEXT PRIMARY KEY, cwd TEXT, first_user_message TEXT); CREATE TABLE thread_spawn_edges(parent_thread_id TEXT, child_thread_id TEXT);");
    state.prepare("INSERT INTO threads VALUES(?,?,?)").run(tid, desk, MARKER_TEXT);
    state.prepare("INSERT INTO threads VALUES(?,?,?)").run("other", "/elsewhere", "kept");
    state.close();
    const logs = new DatabaseSync(join(codexHome, "logs_2.sqlite"));
    logs.exec("CREATE TABLE logs(thread_id TEXT, feedback_log_body TEXT)");
    logs.prepare("INSERT INTO logs VALUES(?,?)").run(tid, MARKER_TEXT);
    logs.close();

    const deletions = new ConversationDeletions({ dataDir: data, database: () => db });
    const { report } = await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: [{ engine: "claude", home: claudeHome }, { engine: "codex", home: codexHome }] }, () => true);
    expect(report.failed).toEqual([]);
    expect(existsSync(project)).toBe(false);
    const history = readFileSync(join(claudeHome, "history.jsonl"), "utf8");
    expect(history).not.toContain(MARKER_TEXT);
    expect(history).not.toContain("older line");
    expect(history).toContain("another project");
    expect(existsSync(join(claudeHome, "history.jsonl.lock"))).toBe(false);
    expect(existsSync(join(claudeHome, "paste-cache", "aaaaaaaaaaaaaaaa.txt"))).toBe(false);
    expect(existsSync(join(claudeHome, "paste-cache", "bbbbbbbbbbbbbbbb.txt"))).toBe(true);
    for (const [dir, name] of [["file-history", sid], ["debug", `${sid}.txt`], ["tasks", sid], ["session-env", sid], ["image-cache", sid], ["uploads", sid], ["plans", "quiet-river.md"], ["plans", "quiet-river-agent-1.md"]]) expect(existsSync(join(claudeHome, dir!, name!)), `${dir}/${name}`).toBe(false);
    expect(existsSync(join(claudeHome, "file-history", otherSid))).toBe(true);
    expect(existsSync(join(claudeHome, "plans", "loud-sea.md"))).toBe(true);
    for (const file of ["history.jsonl", "session_index.jsonl"]) {
      const text = readFileSync(join(codexHome, file), "utf8");
      expect(text).not.toContain(MARKER_TEXT);
      expect(text).toContain("kept");
    }
    expect(existsSync(join(codexHome, "shell_snapshots", `${tid}.abc.sh`))).toBe(false);
    expect(existsSync(join(codexHome, "shell_snapshots", "other.abc.sh"))).toBe(true);
    const after = new DatabaseSync(join(codexHome, "state_5.sqlite"));
    expect(after.prepare("SELECT id FROM threads").all().map((row) => row.id)).toEqual(["other"]);
    after.close();
    for (const file of ["state_5.sqlite", "logs_2.sqlite"]) expect(readFileSync(join(codexHome, file)).includes(MARKER_TEXT), file).toBe(false);
  });

  it("leaves a Claude Code folder whose sessions name another folder", async () => {
    const data = fresh("data");
    const claudeHome = fresh("claude");
    const db = messagesDb(data);
    const desk = join(data, "workspaces", BOT, "threads", THREAD);
    touch(join(desk, "a.md"));
    const dir = join(claudeHome, "projects", desk.replace(/[^a-zA-Z0-9]/g, "-"));
    touch(join(dir, "s1.jsonl"), `${JSON.stringify({ cwd: desk.replace(/threads/, "threads-") })}\n`);
    const deletions = new ConversationDeletions({ dataDir: data, database: () => db });
    const { report } = await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: [{ engine: "claude", home: claudeHome }] }, () => true);
    expect(existsSync(dir)).toBe(true);
    expect(report.leftovers.some((item) => item.what === "Claude Code's history of this conversation")).toBe(true);
  });

  it("names Fuigo's memory folder the way Fuigo does, outside a git repository", () => {
    // blake3 of the customer's folder, from the blake3 crate's C reference
    expect(fuigoMemoryKey(`C:\\cust\\wd\\data\\workspaces\\${BOT}\\threads\\${THREAD}`)).toBe(`${THREAD}-175c01e3`);
    expect(fuigoMemoryKey("/Users/a/My Project")).toMatch(/^my-project-[0-9a-f]{8}$/);
    const repo = fresh("repo");
    mkdirSync(join(repo, ".git"));
    mkdirSync(join(repo, "sub", "deeper"), { recursive: true });
    expect(insideGitRepository(join(repo, "sub", "deeper"))).toBe(true);
    expect(insideGitRepository(fresh("plain"))).toBe(false);
  });

  it("removes only the deleted sessions' lines from Fuigo's shared log, keeping its inode", () => {
    const dir = fresh("log");
    const log = join(dir, "unified.jsonl");
    writeFileSync(log, [JSON.stringify({ sid: "gone", msg: MARKER_TEXT }), JSON.stringify({ sid: "kept", msg: "other" }), "{torn", JSON.stringify({ msg: "no session" }), ""].join("\n"));
    const inode = lstatSync(log).ino;
    expect(scrubLog(log, (row) => row.sid === "gone")).toBe(1);
    expect(lstatSync(log).ino).toBe(inode);
    const text = readFileSync(log, "utf8");
    expect(text).not.toContain(MARKER_TEXT);
    expect(text).toContain("\"kept\"");
    expect(text).toContain("{torn");
    expect(text).toContain("no session");
  });

  it("finds a long Fuigo folder by its hashed name, and its log lines and memory notes", async () => {
    const data = join(fresh("data"), "d".repeat(120));
    mkdirSync(data, { recursive: true });
    const fuigoHome = fresh("fuigo");
    const db = messagesDb(data);
    const desk = join(data, "workspaces", BOT, "threads", THREAD);
    touch(join(desk, "a.md"));
    const key = fuigoSessionKey(desk);
    expect(key).toMatch(new RegExp(`^${THREAD}-[0-9a-f]{16}$`));
    const ours = join(fuigoHome, "sessions", key);
    const theirs = join(fuigoHome, "sessions", `${THREAD}-fedcba9876543210`);
    touch(join(ours, ".cwd"), desk);
    touch(join(ours, "01a0d905", "chat_history.jsonl"), MARKER_TEXT);
    touch(join(theirs, ".cwd"), `${desk}-other`);
    touch(join(fuigoHome, "logs", "unified.jsonl"), `${JSON.stringify({ sid: "01a0d905", msg: MARKER_TEXT })}\n${JSON.stringify({ sid: "other", msg: "kept" })}\n`);
    const memory = join(fuigoHome, "memory", fuigoMemoryKey(realpathSync.native(desk)));
    const otherMemory = join(fuigoHome, "memory", "project-0123abcd");
    touch(join(memory, "notes.md"), MARKER_TEXT);
    touch(join(otherMemory, "notes.md"), "kept");
    // 0.1.60 Linux D5: the search index kept the conversation's words
    const index = join(fuigoHome, "sessions", "session_search.sqlite");
    fuigoSearchIndex(index, [
      { id: "01a0d905", cwd: desk, title: "Copy bot setup", content: `${MARKER_TEXT} xylophonequartz` },
      { id: "01a0ffff", cwd: realpathSync.native(desk), title: "Earlier session of this conversation", content: MARKER_TEXT },
      { id: "01a0aaaa", cwd: `${desk}-other`, title: "Another conversation", content: "kept words" },
    ]).close();
    const deletions = new ConversationDeletions({ dataDir: data, database: () => db });
    await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: [{ engine: "fuigo", home: fuigoHome }] }, () => true);
    const after = new DatabaseSync(index);
    expect(after.prepare("SELECT session_id FROM session_docs").all().map((row) => row.session_id)).toEqual(["01a0aaaa"]);
    expect(after.prepare("SELECT rowid FROM session_docs_fts WHERE session_docs_fts MATCH 'xylophonequartz'").all()).toEqual([]);
    expect(after.prepare("SELECT count(*) AS n FROM session_docs_fts WHERE session_docs_fts MATCH 'kept'").get()).toEqual({ n: 1 });
    after.close();
    expect(fileHas(index, MARKER_TEXT)).toBe(false);
    expect(fileHas(index, "xylophonequartz")).toBe(false);
    expect(existsSync(ours)).toBe(false);
    expect(existsSync(theirs)).toBe(true);
    expect(existsSync(memory)).toBe(false);
    expect(existsSync(otherMemory)).toBe(true);
    const log = readFileSync(join(fuigoHome, "logs", "unified.jsonl"), "utf8");
    expect(log).not.toContain(MARKER_TEXT);
    expect(log).toContain("kept");
  });

  it("scrubs Fuigo's search index while Fuigo has it open, and waits out a writer holding it", async () => {
    const dir = fresh("fuigo-index");
    const index = join(dir, "session_search.sqlite");
    // Fuigo holds the database open (WAL, idle between writes)
    const open = fuigoSearchIndex(index, [
      { id: "gone-1", cwd: "/w/threads/t", title: "zzqqgone", content: `${MARKER_TEXT} xylophonequartz` },
      { id: "kept-1", cwd: "/w/threads/u", title: "zzqqkept", content: "kept words" },
    ]);
    // and another Fuigo process is in the middle of a write for 800 ms
    const writer = spawn(process.execPath, ["-e", `
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(${JSON.stringify(index)});
      db.exec("BEGIN IMMEDIATE"); console.log("locked");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
      db.exec("COMMIT"); db.close();`], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((resolve) => writer.stdout!.once("data", () => resolve()));
    const started = Date.now();
    expect(scrubSearch(index, ["gone-1"], []).changed).toBe(true);
    expect(Date.now() - started).toBeGreaterThan(300);
    await new Promise((resolve) => writer.once("exit", resolve));
    expect(open.prepare("SELECT session_id FROM session_docs").all().map((row) => row.session_id)).toEqual(["kept-1"]);
    open.close();
    expect(fileHas(index, MARKER_TEXT)).toBe(false);
    expect(fileHas(index, "xylophonequartz")).toBe(false);
    // nothing of ours: nothing changed
    expect(scrubSearch(index, ["absent"], ["/nowhere"]).changed).toBe(false);
    expect(scrubSearch(index, [], []).changed).toBe(false);
  });

  // 0.1.60 low (Windows RE-TEST 3/4 L6): Fuigo rewrites a session's search
  // row as the conversation grows, without secure_delete, so earlier copies
  // of its text sit in the file's free pages. Deleting the conversation
  // removed the live row and left those copies readable in a raw scan.
  it("leaves no earlier copy of the conversation's text in Fuigo's free pages", () => {
    const dir = fresh("fuigo-freed");
    const index = join(dir, "session_search.sqlite");
    const db = fuigoSearchIndex(index, [
      { id: "gone-1", cwd: "/w/threads/t", title: "zzqqgone", content: "first draft quetzalmarmot" },
      { id: "kept-1", cwd: "/w/threads/u", title: "zzqqkept", content: "kept words" },
    ]);
    // Fuigo's own later writes: the row grows, the old pages are freed as-is.
    for (let i = 0; i < 4; i++) db.prepare("UPDATE session_docs SET content = ? WHERE session_id = 'gone-1'").run(`first draft quetzalmarmot and more ${"x".repeat(3000 * (i + 1))}`);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    expect(scrubSearch(index, ["gone-1"], []).changed).toBe(true);
    expect(fileHas(index, "quetzalmarmot")).toBe(false);
    expect(fileHas(index, "kept words")).toBe(true);
  });

  // Audit: a conversation deleted on 0.1.60 left copies in free pages, and a
  // later scrub found no rows to delete, so it never vacuumed them away.
  it("clears free-page copies a scrub finds even when no row is left to delete", () => {
    const dir = fresh("fuigo-old-residue");
    const index = join(dir, "session_search.sqlite");
    const db = fuigoSearchIndex(index, [
      { id: "old-1", cwd: "/w/threads/o", title: "zzqqold", content: `earlier words okapiheron ${"y".repeat(8000)}` },
      { id: "kept-1", cwd: "/w/threads/u", title: "zzqqkept", content: "kept words" },
    ]);
    db.exec("DELETE FROM session_docs WHERE session_id = 'old-1'");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    expect(fileHas(index, "okapiheron")).toBe(true);
    expect(scrubSearch(index, ["old-1"], []).changed).toBe(false);
    expect(fileHas(index, "okapiheron")).toBe(false);
    expect(fileHas(index, "kept words")).toBe(true);
  });

  it("reports a folder shared with other conversations instead of removing it", async () => {
    const data = fresh("data");
    const picked = fresh("picked");
    touch(join(picked, "work.md"));
    const db = messagesDb(data);
    const deletions = new ConversationDeletions({ dataDir: data, database: () => db });
    const { report } = await runConversationDeletion(deletions, { threadIds: [THREAD], sharedFolders: [picked] }, () => true);
    expect(existsSync(join(picked, "work.md"))).toBe(true);
    expect(report.leftovers).toContainEqual({ what: "Files this conversation made there, and the engine's history for that folder", where: `the folder "${path.basename(picked)}" you chose` });
  });

  it("drops the record and removes nothing when the delete is refused", async () => {
    const data = fresh("data");
    const db = messagesDb(data);
    touch(join(data, "events", `${THREAD}.ndjson`));
    const deletions = new ConversationDeletions({ dataDir: data, database: () => db });
    const { result } = await runConversationDeletion(deletions, { threadIds: [THREAD] }, () => null);
    expect(result).toBeNull();
    expect(existsSync(join(data, "events", `${THREAD}.ndjson`))).toBe(true);
    expect(deletions.pending()).toEqual([]);
    await expect(runConversationDeletion(deletions, { threadIds: [THREAD] }, () => { throw new Error("roster write failed"); })).rejects.toThrow("roster write failed");
    expect(existsSync(join(data, "events", `${THREAD}.ndjson`))).toBe(true);
    expect(deletions.pending()).toEqual([]);
  });

  it("finishes an interrupted delete at boot and drops one that never committed", async () => {
    const data = fresh("data");
    const db = messagesDb(data);
    const desk = join(data, "workspaces", BOT, "threads", THREAD);
    touch(join(desk, "notes.md"));
    touch(join(data, "events", `${THREAD}.ndjson`));
    touch(join(data, "events", `${OTHER}.ndjson`));
    const deletions = new ConversationDeletions({ dataDir: data, database: () => db });
    // a crash after the record and before any file was removed
    deletions.begin({ threadIds: [THREAD] });
    deletions.begin({ threadIds: [OTHER] });
    expect(deletions.pending()).toHaveLength(2);
    const rowsDeleted: string[] = [];
    const restarted = new ConversationDeletions({ dataDir: data, database: () => db });
    expect(await restarted.reconcile((threadId) => threadId === OTHER, (threadId) => rowsDeleted.push(threadId))).toBe(1);
    expect(rowsDeleted).toEqual([THREAD]);
    expect(existsSync(desk)).toBe(false);
    expect(existsSync(join(data, "events", `${THREAD}.ndjson`))).toBe(false);
    expect(existsSync(join(data, "events", `${OTHER}.ndjson`))).toBe(true);
    expect(restarted.pending()).toEqual([]);
  });

  // W-D8 (0.1.60 Windows): a workspace keeps read-only skill files in
  // .murage-procedures. The Node inside Electron could not remove them on
  // Windows (EPERM), so Delete left the folder and the boot retry failed the
  // same way. A read-only folder does the same to rmSync on macOS and Linux.
  it("removes a workspace holding read-only skill files, at delete and on the boot retry (W-D8)", async () => {
    const readOnlyDesk = (data: string, threadId: string) => {
      const desk = join(data, "workspaces", BOT, "threads", threadId), skill = join(desk, ".murage-procedures", "skills", "research");
      touch(join(skill, "SKILL.md"), "procedure");
      chmodSync(join(skill, "SKILL.md"), 0o444); chmodSync(skill, 0o555); chmodSync(join(desk, ".murage-procedures"), 0o555);
      return desk;
    };
    const data = fresh("data");
    const db = messagesDb(data);
    const desk = readOnlyDesk(data, THREAD);
    const deletions = new ConversationDeletions({ dataDir: data, database: () => db });
    const report = await deletions.finish(deletions.begin({ threadIds: [THREAD] }));
    expect(report.failed).toEqual([]);
    expect(existsSync(desk)).toBe(false);
    expect(deletions.pending()).toEqual([]);
    // Interrupted before the files went: the next start finishes it.
    const other = readOnlyDesk(data, OTHER);
    deletions.begin({ threadIds: [OTHER] });
    const restarted = new ConversationDeletions({ dataDir: data, database: () => db });
    expect(await restarted.reconcile(() => false, () => {})).toBe(1);
    expect(existsSync(other)).toBe(false);
    expect(restarted.pending()).toEqual([]);
  });

  it("gives write permission back without following a link out of the folder (W-D8)", () => {
    const root = fresh("ro"), outside = fresh("ro-outside");
    touch(join(outside, "keep.txt")); chmodSync(join(outside, "keep.txt"), 0o444);
    touch(join(root, "target", "inner", "f.txt")); chmodSync(join(root, "target", "inner", "f.txt"), 0o444); chmodSync(join(root, "target", "inner"), 0o555);
    symlinkSync(outside, join(root, "target", "link"));
    expect(removeConfined(root, join(root, "target"))).toBe("removed");
    expect(lstatSync(join(outside, "keep.txt")).mode & 0o777).toBe(0o444);
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
  });

  it("ignores ids that are not plain ids", async () => {
    const data = fresh("data");
    const db = messagesDb(data);
    touch(join(data, "bots.json"), "{}");
    const deletions = new ConversationDeletions({ dataDir: data, database: () => db });
    const entry = deletions.begin({ threadIds: ["../bots", ".."] });
    expect(entry.threadIds).toEqual([]);
    await deletions.finish({ ...entry, threadIds: ["../bots"], desks: [{ botId: "..", threadId: "../x" }], attachments: ["../bots.json"], artifactBlobs: ["../bots.json"] });
    expect(existsSync(join(data, "bots.json"))).toBe(true);
  });
});

// 1.0.2: the engines' own files are rewritten in a worker thread, one deletion at a time, and a job that cannot finish keeps
// the pending record so the next start runs it again.
describe("engine history off the main thread", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  afterEach(() => { process.off("unhandledRejection", onUnhandled); for (const key of Object.keys(engineHistoryTestHooks)) delete (engineHistoryTestHooks as Record<string, unknown>)[key]; });

  it("a worker that dies mid-job fails every home, keeps the pending record and raises no rejection", async () => {
    process.on("unhandledRejection", onUnhandled);
    const data = fresh("data"), claudeHome = fresh("claude"), dir = fresh("silent");
    const db = messagesDb(data);
    const desk = join(data, "workspaces", BOT, "threads", THREAD);
    touch(join(desk, "a.md"));
    touch(join(claudeHome, "projects", desk.replace(/[^a-zA-Z0-9]/g, "-"), "s1.jsonl"), `${JSON.stringify({ type: "user", cwd: desk })}\n`);
    const silent = join(dir, "silent-worker.mjs");
    writeFileSync(silent, 'import { parentPort } from "node:worker_threads"; parentPort.once("message", () => { setInterval(() => {}, 1000); });\n');
    engineHistoryTestHooks.workerPath = silent;
    engineHistoryTestHooks.onWorker = (worker) => { setTimeout(() => { void worker.terminate(); }, 100); };
    const deletions = new ConversationDeletions({ dataDir: data, database: () => db });
    const { report } = await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: [{ engine: "claude", home: claudeHome }] }, () => true);
    expect(report.failed).toEqual([claudeHome]);
    expect(deletions.pending()).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(unhandled).toEqual([]);
    // the boot retry, on a healthy worker, finishes it
    for (const key of Object.keys(engineHistoryTestHooks)) delete (engineHistoryTestHooks as Record<string, unknown>)[key];
    expect(await new ConversationDeletions({ dataDir: data, database: () => db }).reconcile(() => false, () => {})).toBe(1);
    expect(existsSync(join(claudeHome, "projects", desk.replace(/[^a-zA-Z0-9]/g, "-")))).toBe(false);
  });

  it("a worker that cannot be started does NOT run the removal on the calling thread: the job fails with a reason and the files are untouched", async () => {
    const claudeHome = fresh("claude"), desk = join(fresh("data"), "workspaces", BOT, "threads", THREAD);
    const project = join(claudeHome, "projects", desk.replace(/[^a-zA-Z0-9]/g, "-"));
    touch(join(project, "s1.jsonl"), `${JSON.stringify({ type: "user", cwd: desk })}\n`);
    const result = await runEngineHistoryOffThread({ homes: [{ engine: "claude", home: claudeHome }], folders: [desk], memoryFolders: [], sessions: {} }, { workerPath: join(fresh("nowhere"), "missing-worker.mjs"), createWorker: () => { throw new Error("no thread"); } });
    expect(result.failed).toEqual([claudeHome]);
    expect(result.homeReasons).toEqual({ [`claude\0${claudeHome}`]: "worker-unavailable" });
    expect(existsSync(project)).toBe(true);
  });

  it("rewrites a 100 MB Fuigo search index in a worker thread while the main loop stays free", windowsPerfBudget(), async () => {
    const data = fresh("data"), fuigoHome = fresh("fuigo"), db = messagesDb(data);
    const desk = join(data, "workspaces", BOT, "threads", THREAD);
    touch(join(desk, "a.md"));
    const index = join(fuigoHome, "sessions", "session_search.sqlite");
    const rows = Array.from({ length: 40 }, (_, i) => ({ id: i === 0 ? "gone-1" : `kept-${i}`, cwd: i === 0 ? desk : `/w/threads/${i}`, title: `t${i}`, content: i === 0 ? "first draft quetzalmarmot" : "x" }));
    const seeded = fuigoSearchIndex(index, rows);
    seeded.exec("BEGIN");
    const bulk = seeded.prepare("UPDATE session_docs SET content = ? WHERE session_id = ?");
    for (let i = 1; i < 40; i++) bulk.run(Array.from({ length: 2600 }, (_, j) => `w${(i * 7919 + j * 104729) % 99991}`).join(" ").repeat(150).slice(0, 2_600_000), `kept-${i}`);
    seeded.exec("COMMIT");
    seeded.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    seeded.close();
    expect(statSync(index).size).toBeGreaterThan(100 * 1024 * 1024);
    let threadId = -1;
    // the pending record is written (and fsynced) on this thread only between jobs, never while a worker rewrites the engine's files: an
    // fsync then waits behind that worker's writes on the same drive and stalls the loop
    const journal = join(data, "pending-deletions.json");
    const writesWhileRunning: string[] = [];
    engineHistoryTestHooks.onWorker = (worker) => {
      threadId = worker.threadId;
      const atStart = atomicWriteCount(journal);
      worker.on("message", (message: { type?: string; key?: string; index?: number }) => { if (atomicWriteCount(journal) !== atStart) writesWhileRunning.push(`${message.type} ${message.index ?? ""}`); });
    };
    const histogram = monitorEventLoopDelay({ resolution: 5 });
    histogram.enable();
    const deletions = new ConversationDeletions({ dataDir: data, database: () => db });
    touch(join(fuigoHome, "sessions", rustUrlEncode(desk), "s1", "chat_history.jsonl"));
    const { report } = await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: [{ engine: "fuigo", home: fuigoHome }] }, () => true);
    histogram.disable();
    expect(report.failed).toEqual([]);
    expect(threadId).toBeGreaterThan(0); // it ran in a worker thread, not the main one (thread id 0)
    expect(writesWhileRunning).toEqual([]);
    expect(histogram.max / 1e6).toBeLessThan(50);
    expect(fileHas(index, "quetzalmarmot")).toBe(false);
  }, 180_000);

  it("two deletions at once run one after the other, and both rewrites of the shared history survive", async () => {
    const data = fresh("data"), codexHome = fresh("codex"), db = messagesDb(data);
    const second = "thread-two";
    const tidA = "019a0000-aaaa-7bbb-8ccc-00000000000a", tidB = "019a0000-aaaa-7bbb-8ccc-00000000000b";
    const deskA = join(data, "workspaces", BOT, "threads", THREAD), deskB = join(data, "workspaces", BOT, "threads", second);
    touch(join(deskA, "a.md")); touch(join(deskB, "b.md"));
    for (const [tid, desk] of [[tidA, deskA], [tidB, deskB]]) touch(join(codexHome, "sessions", "2026", "09", "25", `rollout-2026-09-25T10-00-00-${tid}.jsonl`), `${JSON.stringify({ type: "session_meta", payload: { id: tid, cwd: desk } })}\n`);
    const lines = (n: number) => Array.from({ length: n }, (_, i) => [JSON.stringify({ session_id: tidA, ts: i, text: `a${i}` }), JSON.stringify({ session_id: tidB, ts: i, text: `b${i}` }), JSON.stringify({ session_id: "other", ts: i, text: `k${i}` })].join("\n")).join("\n") + "\n";
    touch(join(codexHome, "history.jsonl"), lines(2000));
    const deletions = new ConversationDeletions({ dataDir: data, database: () => db });
    const run = (id: string) => runConversationDeletion(deletions, { threadIds: [id], engineHomes: [{ engine: "codex", home: codexHome }] }, () => true);
    const [one, two] = await Promise.all([run(THREAD), run(second)]);
    expect(one.report.failed).toEqual([]); expect(two.report.failed).toEqual([]);
    const history = readFileSync(join(codexHome, "history.jsonl"), "utf8");
    expect(history).not.toMatch(/"text":"[ab]\d/); // the words of both conversations are gone (their ids stay: an id is not their words)
    expect(history).toContain(tidA); expect(history).toContain(tidB);
    const rows = history.split("\n").filter(Boolean);
    expect(rows).toHaveLength(6000); // the rows of the two conversations are blanked in place, not cut
    for (const row of rows) expect(() => JSON.parse(row)).not.toThrow();
    expect(rows.filter((row) => row.includes('"other"'))).toHaveLength(2000); // the bystander's rows are all there
  }, 60_000);
});

// r9: what an interrupted or incomplete engine cleanup must not lose, and what must not count as done.
describe("engine cleanup survives an interruption and is never reported done while text remains (r9)", () => {
  afterEach(() => {
    for (const key of Object.keys(engineHistoryTestHooks)) delete (engineHistoryTestHooks as Record<string, unknown>)[key];
  });
  const noRows = () => undefined;

  it("finding 1 (Codex): a history rewrite that fails after the rollouts are gone is finished by the replay from the saved thread ids", async () => {
    const data = fresh("data"), codexHome = fresh("codex"), sqliteHome = fresh("codex-sql"), db = messagesDb(data);
    const tid = "019a0000-aaaa-7bbb-8ccc-0000000000c1";
    const desk = join(data, "workspaces", BOT, "threads", THREAD);
    touch(join(desk, "a.md"));
    const rollout = join(codexHome, "sessions", "2026", "09", "25", `rollout-2026-09-25T10-00-00-${tid}.jsonl`);
    touch(rollout, `${JSON.stringify({ type: "session_meta", payload: { id: tid, cwd: desk } })}\n`);
    touch(join(codexHome, "history.jsonl"), `${JSON.stringify({ session_id: tid, text: "private-codex-words" })}\n${JSON.stringify({ session_id: "other", text: "keep" })}\n`);
    const state = new DatabaseSync(join(sqliteHome, "state_1.sqlite"));
    state.exec("PRAGMA journal_mode=WAL; CREATE TABLE threads(id TEXT, title TEXT); CREATE TABLE logs(thread_id TEXT, body TEXT);");
    state.prepare("INSERT INTO threads VALUES(?,?)").run(tid, "private-codex-title");
    state.prepare("INSERT INTO logs VALUES(?,?)").run(tid, "private-codex-log");
    state.close();
    const deletions = new ConversationDeletions({ dataDir: data, database: () => db, retryDelaysMs: [] });
    chmodSync(join(codexHome, "history.jsonl"), 0o444); // history.jsonl cannot be opened for writing, after the rollouts are removed
    try {
      const { report } = await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: [{ engine: "codex", home: codexHome, sqliteHome }] }, () => true);
      expect(report.failed).toContain(join(codexHome, "history.jsonl"));
    } finally { chmodSync(join(codexHome, "history.jsonl"), 0o644); }
    expect(existsSync(rollout)).toBe(false); // the thread id can no longer be found by looking
    const [saved] = deletions.pending();
    expect(saved).toBeDefined();
    expect(Object.values(saved!.engineDiscovery ?? {}).some((home) => home.threadIds?.includes(tid))).toBe(true);
    expect(await new ConversationDeletions({ dataDir: data, database: () => db, retryDelaysMs: [] }).reconcile(() => false, noRows)).toBe(1);
    expect(readFileSync(join(codexHome, "history.jsonl"), "utf8")).not.toContain("private-codex-words");
    expect(readFileSync(join(codexHome, "history.jsonl"), "utf8")).toContain("keep");
    const after = new DatabaseSync(join(sqliteHome, "state_1.sqlite"));
    expect(after.prepare("SELECT count(*) AS n FROM threads").get()?.n).toBe(0);
    expect(after.prepare("SELECT count(*) AS n FROM logs").get()?.n).toBe(0);
    after.close();
    expect(fileHas(join(sqliteHome, "state_1.sqlite"), "private-codex-title")).toBe(false);
    expect(new ConversationDeletions({ dataDir: data, database: () => db }).pending()).toEqual([]);
  });

  it("finding 1 (Fuigo): session folders removed before the shared log is scrubbed; the replay still scrubs it by the saved session ids", async () => {
    const data = fresh("data"), fuigoHome = fresh("fuigo"), db = messagesDb(data);
    const desk = join(data, "workspaces", BOT, "threads", THREAD);
    touch(join(desk, "a.md"));
    touch(join(fuigoHome, "sessions", fuigoSessionKey(desk), "s-private-1", "chat_history.jsonl"));
    const log = join(fuigoHome, "logs", "unified.jsonl");
    touch(log, `${JSON.stringify({ sid: "s-private-1", text: "private-fuigo-words" })}\n${JSON.stringify({ sid: "s-other", text: "keep" })}\n`);
    const index = join(fuigoHome, "sessions", "session_search.sqlite");
    const seeded = fuigoSearchIndex(index, [{ id: "s-private-1", cwd: desk, title: "t", content: "private-fuigo-index" }, { id: "s-other", cwd: "/w/x", title: "k", content: "keep" }]);
    seeded.exec("PRAGMA wal_checkpoint(TRUNCATE)"); seeded.close();
    const deletions = new ConversationDeletions({ dataDir: data, database: () => db, retryDelaysMs: [] });
    chmodSync(log, 0o444); // the in-place scrub of the shared log cannot open it for writing
    try {
      const { report } = await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: [{ engine: "fuigo", home: fuigoHome }] }, () => true);
      expect(report.failed).toEqual([log]);
    } finally { chmodSync(log, 0o644); }
    expect(existsSync(join(fuigoHome, "sessions", fuigoSessionKey(desk)))).toBe(false);
    expect(await new ConversationDeletions({ dataDir: data, database: () => db, retryDelaysMs: [] }).reconcile(() => false, noRows)).toBe(1);
    expect(readFileSync(log, "utf8")).not.toContain("private-fuigo-words");
    expect(readFileSync(log, "utf8")).toContain("keep");
    expect(fileHas(index, "private-fuigo-index")).toBe(false);
  });

  it("finding 1 (Hermes): child sessions whose rows are already gone still have their transcripts removed on the replay", async () => {
    const data = fresh("data"), hermesHome = fresh("hermes"), db = messagesDb(data);
    const desk = join(data, "workspaces", BOT, "threads", THREAD);
    touch(join(desk, "a.md"));
    const parent = "parent-session-0001", child = "child-session-00002";
    const state = new DatabaseSync(join(hermesHome, "state.db"));
    state.exec("PRAGMA journal_mode=WAL; CREATE TABLE sessions(id TEXT PRIMARY KEY, parent_session_id TEXT); CREATE TABLE messages(session_id TEXT, content TEXT);");
    state.prepare("INSERT INTO sessions VALUES(?,?)").run(parent, null);
    state.prepare("INSERT INTO sessions VALUES(?,?)").run(child, parent);
    state.prepare("INSERT INTO messages VALUES(?,?)").run(child, "private-hermes-child-words");
    state.close();
    touch(join(hermesHome, "sessions", `${parent}.json`)); touch(join(hermesHome, "sessions", `${child}.jsonl`), "private-hermes-child-words");
    const deletions = new ConversationDeletions({ dataDir: data, database: () => db, retryDelaysMs: [] });
    const letIn = keepOut(join(hermesHome, "sessions"), 0o555); // transcripts cannot be removed after the rows are deleted (Windows: held open)
    try {
      const { report } = await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: [{ engine: "hermes", home: hermesHome }], sessionIds: { hermesAgent: [parent] } }, () => true);
      expect(report.failed.length).toBeGreaterThan(0);
    } finally { letIn(); }
    const rows = new DatabaseSync(join(hermesHome, "state.db"));
    expect(rows.prepare("SELECT count(*) AS n FROM sessions").get()?.n).toBe(0); // the child can no longer be found in the database
    rows.close();
    expect(await new ConversationDeletions({ dataDir: data, database: () => db, retryDelaysMs: [] }).reconcile(() => false, noRows)).toBe(1);
    expect(existsSync(join(hermesHome, "sessions", `${parent}.json`))).toBe(false);
    expect(existsSync(join(hermesHome, "sessions", `${child}.jsonl`))).toBe(false);
  });

  it("finding 2 (Fuigo): an engine reader that pins the log keeps the deletion unfinished; the record stays and a bounded retry finishes it", async () => {
    const data = fresh("data"), fuigoHome = fresh("fuigo"), db = messagesDb(data);
    const desk = join(data, "workspaces", BOT, "threads", THREAD);
    touch(join(desk, "a.md"));
    const index = join(fuigoHome, "sessions", "session_search.sqlite");
    const seeded = fuigoSearchIndex(index, [{ id: "gone-1", cwd: desk, title: "t", content: MARKER_TEXT }, { id: "kept-1", cwd: "/w/x", title: "k", content: "keep" }]);
    seeded.exec("PRAGMA wal_checkpoint(TRUNCATE)"); seeded.close();
    const reader = new DatabaseSync(index); // the engine's own connection, mid-read
    reader.exec("BEGIN"); reader.prepare("SELECT count(*) FROM session_docs").get();
    const deletions = new ConversationDeletions({ dataDir: data, database: () => db, retryDelaysMs: [150, 150, 150, 150, 150, 150] });
    try {
      const { report } = await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: [{ engine: "fuigo", home: fuigoHome }] }, () => true);
      expect(report.failed).toEqual([index]); // not a successful deletion
      expect(deletions.pending()).toHaveLength(1);
      expect(fileHas(index, MARKER_TEXT)).toBe(true); // it really is still readable in the log
    } finally { reader.exec("COMMIT"); reader.close(); }
    await vi.waitFor(() => expect(deletions.pending()).toEqual([]), { timeout: 10_000 });
    expect(fileHas(index, MARKER_TEXT)).toBe(false);
    deletions.dispose();
  });

  it("finding 2 (ACP engine database): a log that cannot be checkpointed is reported failed, saved as owed, and replayed to completion", async () => {
    const data = fresh("data"), home = fresh("opencode"), db = messagesDb(data);
    const desk = join(data, "workspaces", BOT, "threads", THREAD);
    touch(join(desk, "a.md"));
    const file = join(home, "opencode.db");
    const engineDb = new DatabaseSync(file);
    engineDb.exec("PRAGMA journal_mode=WAL; CREATE TABLE session(id TEXT PRIMARY KEY, directory TEXT, parent_id TEXT); CREATE TABLE message(session_id TEXT, data TEXT);");
    engineDb.prepare("INSERT INTO session VALUES(?,?,?)").run("ses_private_1", desk, null);
    engineDb.prepare("INSERT INTO message VALUES(?,?)").run("ses_private_1", MARKER_TEXT);
    engineDb.exec("PRAGMA wal_checkpoint(TRUNCATE)"); engineDb.close();
    const reader = new DatabaseSync(file);
    reader.exec("BEGIN"); reader.prepare("SELECT count(*) FROM session").get();
    const deletions = new ConversationDeletions({ dataDir: data, database: () => db, retryDelaysMs: [] });
    try {
      const { report } = await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: [{ engine: "opencode", home }] }, () => true);
      expect(report.failed).toEqual([file]);
      expect(fileHas(file, MARKER_TEXT)).toBe(true);
    } finally { reader.exec("COMMIT"); reader.close(); }
    const [saved] = deletions.pending();
    expect(Object.values(saved!.engineDiscovery ?? {}).some((entry) => entry.dirtyDbs?.includes(file))).toBe(true);
    // the rows are already gone, so only the saved list says this database is still owed a checkpoint
    expect(await new ConversationDeletions({ dataDir: data, database: () => db, retryDelaysMs: [] }).reconcile(() => false, noRows)).toBe(1);
    expect(fileHas(file, MARKER_TEXT)).toBe(false);
    expect(new ConversationDeletions({ dataDir: data, database: () => db }).pending()).toEqual([]);
  });

  it("finding 2: the search index step fails instead of reporting success when its log cannot be checkpointed", () => {
    const dir = fresh("fuigo-blocked");
    const index = join(dir, "session_search.sqlite");
    const seeded = fuigoSearchIndex(index, [{ id: "gone-1", cwd: "/w/a", title: "t", content: MARKER_TEXT }]);
    seeded.exec("PRAGMA wal_checkpoint(TRUNCATE)"); seeded.close();
    const reader = new DatabaseSync(index);
    reader.exec("BEGIN"); reader.prepare("SELECT count(*) FROM session_docs").get();
    try { const blocked = scrubSearch(index, ["gone-1"], []).ran!; expect(blocked.failed).toEqual([index]); expect(blocked.reasons[index]).toMatch(/checkpoint/); }
    finally { reader.exec("COMMIT"); reader.close(); }
    expect(scrubSearch(index, ["gone-1"], []).changed).toBe(false); // nothing left to delete, and now the log is clean
    expect(fileHas(index, MARKER_TEXT)).toBe(false);
  });
});
