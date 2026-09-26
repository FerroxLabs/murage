// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";

import {
  ConversationDeletions,
  claudeProjectKey,
  engineSlug,
  fuigoMemoryKey,
  fuigoSessionKey,
  insideGitRepository,
  scrubJsonlInPlace,
  isStrictlyInside,
  removeConfined,
  runConversationDeletion,
  rustUrlEncode,
} from "./conversation-deletion.ts";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "murage-delete-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
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
  db.exec("CREATE TABLE IF NOT EXISTS messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id))");
  return db;
}

function seed(data: string, fuigoHome: string, claudeHome: string, codexHome: string, db: DatabaseSync) {
  const desk = join(data, "workspaces", BOT, "threads", THREAD);
  touch(join(desk, "notes", "pipeline.md"), "mail");
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
  db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?)").run(THREAD, "m1", 1, "bot", "text", "hi", JSON.stringify({ attachments: [{ kind: "image", path: join(data, "attachments", image) }, { kind: "image", path: join(data, "attachments", shared) }] }));
  db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?)").run(OTHER, "m2", 1, "bot", "text", "hi", JSON.stringify({ attachments: [{ kind: "image", path: join(data, "attachments", shared) }] }));
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
      engineKinds: ["fuigoAgent", "geminiAgent", "grok"],
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
    expect(report.leftovers.map((item) => item.what)).toContain("Gemini CLI's own copy of this conversation");
    expect(report.leftovers.some((item) => item.what.includes("Grok"))).toBe(false);
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
    expect(scrubJsonlInPlace(log, (row) => row.sid === "gone")).toBe(1);
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
    const memory = join(fuigoHome, "memory", fuigoMemoryKey(realpathSync(desk)));
    const otherMemory = join(fuigoHome, "memory", "project-0123abcd");
    touch(join(memory, "notes.md"), MARKER_TEXT);
    touch(join(otherMemory, "notes.md"), "kept");
    const deletions = new ConversationDeletions({ dataDir: data, database: () => db });
    await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: [{ engine: "fuigo", home: fuigoHome }] }, () => true);
    expect(existsSync(ours)).toBe(false);
    expect(existsSync(theirs)).toBe(true);
    expect(existsSync(memory)).toBe(false);
    expect(existsSync(otherMemory)).toBe(true);
    const log = readFileSync(join(fuigoHome, "logs", "unified.jsonl"), "utf8");
    expect(log).not.toContain(MARKER_TEXT);
    expect(log).toContain("kept");
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

  it("ignores ids that are not plain ids", () => {
    const data = fresh("data");
    const db = messagesDb(data);
    touch(join(data, "bots.json"), "{}");
    const deletions = new ConversationDeletions({ dataDir: data, database: () => db });
    const entry = deletions.begin({ threadIds: ["../bots", ".."] });
    expect(entry.threadIds).toEqual([]);
    deletions.finish({ ...entry, threadIds: ["../bots"], desks: [{ botId: "..", threadId: "../x" }], attachments: ["../bots.json"], artifactBlobs: ["../bots.json"] });
    expect(existsSync(join(data, "bots.json"))).toBe(true);
  });
});
