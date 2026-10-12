// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { ConversationDeletions, fuigoSessionKey, removeEngineHistoryFiles, runConversationDeletion } from "./conversation-deletion.ts";
import { PlanError } from "./engine-plan-core.ts";
import { fsOps, realEngineFs } from "./engine-fs.ts";
import { cursorChatsKey, cursorProjectSlug, droidCwdKey, geminiNormalizedPath, geminiSlug, kimiWorkDirKey, qwenProjectHash, qwenProjectKey } from "./engine-history-deletion.ts";

const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-engines-")));
// Every messages.db a test opens is closed before the folder goes: Windows
// refuses to remove a folder with an open file in it.
const openDatabases: DatabaseSync[] = [];
afterAll(() => { for (const db of openDatabases) db.close(); rmSync(scratch, { recursive: true, force: true }); });
let n = 0;
const fresh = (name: string) => { const dir = join(scratch, `${name}-${++n}`); mkdirSync(dir, { recursive: true }); return dir; };
const touch = (file: string, text = "x") => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); };
const BOT = "f25024c1-a18e-4251-acf1-0c1713d9b6d9";
const THREAD = "2e9018ee-1f45-46be-8ed1-7a02fc022807";
const WIN = `C:\\cust\\wd\\data\\workspaces\\${BOT}\\threads\\${THREAD}`;
const SECRET = "engine-private-3391";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

describe("engine folder keys, as each engine computes them", () => {
  it("Gemini CLI: resolved path, lowercased on Windows; slug of the leaf", () => {
    expect(geminiNormalizedPath(WIN)).toBe(WIN.toLowerCase());
    // A POSIX folder only exists on a POSIX host; on Windows Gemini lowercases every path.
    if (process.platform !== "win32") expect(geminiNormalizedPath("/a/b/../My Project")).toBe("/a/My Project");
    else expect(geminiNormalizedPath("C:\\a\\b\\..\\My Project")).toBe("c:\\a\\my project");
    expect(geminiSlug("/a/My Project!!")).toBe("my-project");
    expect(geminiSlug("/a/!!!")).toBe("project");
  });
  it("Qwen Code: sanitizeCwd and sha256 project hash, lowercased on Windows", () => {
    expect(qwenProjectKey(WIN)).toBe(`c--cust-wd-data-workspaces-${BOT}-threads-${THREAD}`);
    expect(qwenProjectKey("/Users/a/.q")).toBe("-Users-a--q");
    expect(qwenProjectHash(WIN)).toBe(sha(WIN.toLowerCase()));
  });
  it("Kimi Code: wd_<slug>_<sha256 prefix> of the forward-slash folder", () => {
    expect(kimiWorkDirKey(WIN)).toBe(`wd_${THREAD}_${sha(WIN.replace(/\\/g, "/")).slice(0, 12)}`);
    expect(kimiWorkDirKey("/x/My Repo/")).toBe(`wd_my-repo_${sha("/x/My Repo").slice(0, 12)}`);
  });
  it("Droid: dash-joined realpath", () => {
    expect(droidCwdKey("/Users/a/.m/workspaces/b/")).toBe("-Users-a-.m-workspaces-b");
  });
  it("Cursor: collapsed-dash slug and md5 chats key", () => {
    expect(cursorProjectSlug("/Users/a/.m/workspaces/b")).toBe("Users-a-m-workspaces-b");
    // Cursor hashes the host's resolved path.
    expect(cursorChatsKey("/a/b")).toBe(createHash("md5").update(path.resolve("/a/b")).digest("hex"));
  });
});

function setup() {
  const data = fresh("data");
  const home = fresh("home");
  const db = new DatabaseSync(join(data, "messages.db"));
  openDatabases.push(db);
  const desk = join(data, "workspaces", BOT, "threads", THREAD);
  touch(join(desk, "a.md"));
  return { data, home, db, desk, deletions: new ConversationDeletions({ dataDir: data, database: () => db }) };
}

describe("removing one conversation's engine history", () => {
  it("Gemini CLI: the folder's tmp and history, confirmed by .project_root", async () => {
    const { home, desk, deletions } = setup();
    const gemini = join(home, ".gemini");
    touch(join(gemini, "projects.json"), JSON.stringify({ projects: { [desk]: `${THREAD}`, "/other": "other" } }));
    // Gemini normalizes a marker before comparing it: one in the folder's own
    // case (not lowercased on Windows) still names this folder.
    touch(join(gemini, "tmp", THREAD, ".project_root"), desk);
    touch(join(gemini, "tmp", THREAD, "chats", "session-x.jsonl"), SECRET);
    touch(join(gemini, "history", THREAD, ".project_root"), desk);
    touch(join(gemini, "tmp", `${THREAD}-1`, ".project_root"), "/other-folder");
    touch(join(gemini, "tmp", sha(desk), "logs.json"), SECRET);
    touch(join(gemini, "tmp", "other", ".project_root"), "/other");
    await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: [{ engine: "gemini", home: gemini }] }, () => true);
    for (const gone of [join(gemini, "tmp", THREAD), join(gemini, "history", THREAD), join(gemini, "tmp", sha(desk))]) expect(existsSync(gone), gone).toBe(false);
    expect(existsSync(join(gemini, "tmp", `${THREAD}-1`))).toBe(true);
    expect(existsSync(join(gemini, "tmp", "other"))).toBe(true);
  });

  it("Qwen Code: project chats, tmp/history by hash, and per-session todos, debug and plans", async () => {
    const { home, desk, deletions } = setup();
    const qwen = join(home, ".qwen");
    const sid = "b2c6d1a0-1111-4222-8333-444455556666";
    touch(join(qwen, "projects", qwenProjectKey(desk), "chats", `${sid}.jsonl`), JSON.stringify({ cwd: desk, message: SECRET }));
    touch(join(qwen, "projects", "other", "chats", "o.jsonl"), "kept");
    touch(join(qwen, "tmp", qwenProjectHash(desk), "shell_history"), SECRET);
    touch(join(qwen, "history", qwenProjectHash(desk), "HEAD"), "x");
    touch(join(qwen, "todos", `${sid}.json`), SECRET);
    touch(join(qwen, "debug", `${sid}.txt`), SECRET);
    touch(join(qwen, "plans", `${sid}.md`), SECRET);
    touch(join(qwen, "plans", "other.md"), "kept");
    touch(join(qwen, "oauth_creds.json"), "sign-in");
    await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: [{ engine: "qwen", home: qwen, secondary: qwen }] }, () => true);
    for (const gone of [join(qwen, "projects", qwenProjectKey(desk)), join(qwen, "tmp", qwenProjectHash(desk)), join(qwen, "history", qwenProjectHash(desk)), join(qwen, "todos", `${sid}.json`), join(qwen, "debug", `${sid}.txt`), join(qwen, "plans", `${sid}.md`)]) expect(existsSync(gone), gone).toBe(false);
    for (const kept of [join(qwen, "projects", "other"), join(qwen, "plans", "other.md"), join(qwen, "oauth_creds.json")]) expect(existsSync(kept), kept).toBe(true);
  });

  it("OpenCode: the folder's sessions and their children in the shared store, nothing else", async () => {
    const { home, desk, deletions } = setup();
    const data = join(home, ".local", "share", "opencode");
    mkdirSync(data, { recursive: true });
    const store = new DatabaseSync(join(data, "opencode.db"));
    store.exec(`CREATE TABLE session(id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT);
      CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT REFERENCES session(id) ON DELETE CASCADE, data TEXT);
      CREATE TABLE event(id INTEGER PRIMARY KEY, aggregate_id TEXT, data TEXT);
      CREATE TABLE account(id TEXT, token TEXT);`);
    store.prepare("INSERT INTO session VALUES(?,?,?,?)").run("ses_a", null, desk, SECRET);
    store.prepare("INSERT INTO session VALUES(?,?,?,?)").run("ses_child", "ses_a", "/sub/dir", SECRET);
    store.prepare("INSERT INTO session VALUES(?,?,?,?)").run("ses_other", null, "/other", "kept");
    store.prepare("INSERT INTO message VALUES(?,?,?)").run("m1", "ses_a", SECRET);
    store.prepare("INSERT INTO message VALUES(?,?,?)").run("m2", "ses_other", "kept");
    store.prepare("INSERT INTO event(aggregate_id,data) VALUES(?,?)").run("ses_child", SECRET);
    store.prepare("INSERT INTO account VALUES(?,?)").run("acct", "sign-in");
    store.close();
    touch(join(data, "storage", "session_diff", "ses_a.json"), SECRET);
    touch(join(data, "storage", "session_diff", "ses_other.json"), "kept");
    await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: [{ engine: "opencode", home: data }] }, () => true);
    const after = new DatabaseSync(join(data, "opencode.db"));
    expect(after.prepare("SELECT id FROM session").all().map((row) => row.id)).toEqual(["ses_other"]);
    expect(after.prepare("SELECT id FROM message").all().map((row) => row.id)).toEqual(["m2"]);
    expect(after.prepare("SELECT count(*) AS n FROM event").get()?.n).toBe(0);
    expect(after.prepare("SELECT token FROM account").get()?.token).toBe("sign-in");
    after.close();
    expect(readFileSync(join(data, "opencode.db")).includes(SECRET)).toBe(false);
    expect(existsSync(join(data, "storage", "session_diff", "ses_a.json"))).toBe(false);
    expect(existsSync(join(data, "storage", "session_diff", "ses_other.json"))).toBe(true);
  });

  it("Kimi Code: the folder's sessions bucket, its index lines and input history", async () => {
    const { home, desk, deletions } = setup();
    const kimi = join(home, ".kimi-code");
    touch(join(kimi, "sessions", kimiWorkDirKey(desk), "s1", "agents", "main", "wire.jsonl"), SECRET);
    touch(join(kimi, "sessions", "wd_other_000000000000", "s2", "state.json"), "kept");
    touch(join(kimi, "session_index.jsonl"), `${JSON.stringify({ sessionId: "s1", workDir: desk, title: SECRET })}\n${JSON.stringify({ sessionId: "s2", workDir: "/other", title: "other title" })}\n`);
    touch(join(kimi, "user-history", `${createHash("md5").update(desk).digest("hex")}.jsonl`), SECRET);
    touch(join(kimi, "credentials", "kimi-code.json"), "sign-in");
    await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: [{ engine: "kimi", home: kimi }] }, () => true);
    expect(existsSync(join(kimi, "sessions", kimiWorkDirKey(desk)))).toBe(false);
    expect(existsSync(join(kimi, "sessions", "wd_other_000000000000"))).toBe(true);
    // the row keeps its ids (an identifier is not the conversation's words); its title is gone
    expect(readFileSync(join(kimi, "session_index.jsonl"), "utf8")).not.toContain(SECRET);
    expect(readFileSync(join(kimi, "session_index.jsonl"), "utf8")).toContain('"sessionId":"s1"');
    expect(readFileSync(join(kimi, "session_index.jsonl"), "utf8")).toContain("other title");
    expect(existsSync(join(kimi, "credentials", "kimi-code.json"))).toBe(true);
  });

  it("Cursor: project transcripts, chats by md5, and the ACP sessions this conversation started (from its event log)", async () => {
    const { data, home, desk, deletions } = setup();
    const cursor = join(home, ".cursor");
    touch(join(cursor, "projects", cursorProjectSlug(desk), "agent-transcripts", "s", "s.jsonl"), SECRET);
    touch(join(cursor, "chats", cursorChatsKey(desk), "a", "store.db"), SECRET);
    touch(join(cursor, "acp-sessions", "old-session", "store.db"), SECRET);
    touch(join(cursor, "acp-sessions", "current-session", "store.db"), SECRET);
    touch(join(cursor, "acp-sessions", "someone-else", "store.db"), "kept");
    touch(join(cursor, "cli-config.json"), "settings");
    // a rewind started a new session and forgot the old cursor; the event log still has it
    touch(join(data, "events", `${THREAD}.ndjson`), `${JSON.stringify({ type: "session.started", providerInstanceId: "cur", sessionId: "old-session", threadId: THREAD })}\n`);
    await runConversationDeletion(deletions, {
      threadIds: [THREAD], engineHomes: [{ engine: "cursor", home: cursor, secondary: cursor }],
      sessionIds: { cursorAgent: ["current-session"] }, instanceKind: (id) => (id === "cur" ? "cursorAgent" : undefined),
    }, () => true);
    for (const gone of [join(cursor, "projects", cursorProjectSlug(desk)), join(cursor, "chats", cursorChatsKey(desk)), join(cursor, "acp-sessions", "old-session"), join(cursor, "acp-sessions", "current-session")]) expect(existsSync(gone), gone).toBe(false);
    expect(existsSync(join(cursor, "acp-sessions", "someone-else"))).toBe(true);
    expect(existsSync(join(cursor, "cli-config.json"))).toBe(true);
  });

  // Droid's Windows per-folder bucket name is unverified: this rule keeps the
  // drive colon and backslashes, which cannot be a Windows folder name (0.1.61
  // CI lane), so on Windows only the bucket is left out. Its flat copies by
  // session id and its index rows are removed the same everywhere.
  const droidBucketKnown = process.platform !== "win32";
  it("Droid: the folder's sessions, flat copies by session id, and its index rows", async () => {
    const { home, desk, deletions } = setup();
    const factory = join(home, ".factory");
    const sid = "7d7c0000-1111-4222-8333-444455556666";
    const bucket = join(factory, "sessions", droidBucketKnown ? droidCwdKey(realpathSync.native(desk)) : "-bucket-under-test");
    touch(join(bucket, `${sid}.jsonl`), SECRET);
    touch(join(bucket, `${sid}.settings.json`), "{}");
    touch(join(factory, "sessions", `${sid}.jsonl`), SECRET);
    touch(join(factory, "sessions", "-other", "o.jsonl"), "kept");
    mkdirSync(join(factory, "cache", "session-index"), { recursive: true });
    const index = new DatabaseSync(join(factory, "cache", "session-index", "index.db"));
    index.exec("CREATE TABLE sessions(session_id TEXT, summary TEXT); CREATE TABLE files(transcript_path TEXT, fingerprint TEXT);");
    index.prepare("INSERT INTO sessions VALUES(?,?)").run(sid, SECRET);
    index.prepare("INSERT INTO sessions VALUES(?,?)").run("other", "kept");
    index.prepare("INSERT INTO files VALUES(?,?)").run(`/x/${sid}.jsonl`, SECRET);
    index.close();
    touch(join(factory, "auth.v2.file"), "sign-in");
    // Where the bucket is known it names the session; on Windows the id comes
    // from the resume cursor Murage holds for the conversation.
    const sessionIds: Record<string, string[]> = droidBucketKnown ? {} : { droidAgent: [sid] };
    await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: [{ engine: "droid", home: factory }], sessionIds }, () => true);
    if (droidBucketKnown) expect(existsSync(bucket)).toBe(false);
    expect(existsSync(join(factory, "sessions", `${sid}.jsonl`))).toBe(false);
    expect(existsSync(join(factory, "sessions", "-other"))).toBe(true);
    expect(existsSync(join(factory, "auth.v2.file"))).toBe(true);
    const after = new DatabaseSync(join(factory, "cache", "session-index", "index.db"));
    expect(after.prepare("SELECT session_id FROM sessions").all().map((row) => row.session_id)).toEqual(["other"]);
    expect(after.prepare("SELECT count(*) AS n FROM files").get()?.n).toBe(0);
    after.close();
  });

  it("Hermes: the conversation's sessions and their child sessions in state.db, and its session files", async () => {
    const { home, deletions } = setup();
    const hermes = join(home, ".hermes");
    mkdirSync(hermes, { recursive: true });
    const sid = "a1b2c3d4-1111-4222-8333-444455556666";
    const store = new DatabaseSync(join(hermes, "state.db"));
    store.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, parent_session_id TEXT, meta TEXT);
      CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, content TEXT);`);
    store.prepare("INSERT INTO sessions VALUES(?,?,?)").run(sid, null, "{}");
    store.prepare("INSERT INTO sessions VALUES(?,?,?)").run("child-0000000001", sid, "{}");
    store.prepare("INSERT INTO sessions VALUES(?,?,?)").run("other-0000000001", null, "{}");
    store.prepare("INSERT INTO messages(session_id,content) VALUES(?,?)").run(sid, SECRET);
    store.prepare("INSERT INTO messages(session_id,content) VALUES(?,?)").run("child-0000000001", SECRET);
    store.prepare("INSERT INTO messages(session_id,content) VALUES(?,?)").run("other-0000000001", "kept");
    store.close();
    touch(join(hermes, "sessions", `${sid}.jsonl`), SECRET);
    touch(join(hermes, "sessions", `request_dump_${sid}_1.json`), SECRET);
    touch(join(hermes, "sessions", "other-0000000001.json"), "kept");
    await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: [{ engine: "hermes", home: hermes }], sessionIds: { hermesAgent: [sid] } }, () => true);
    const after = new DatabaseSync(join(hermes, "state.db"));
    expect(after.prepare("SELECT id FROM sessions").all().map((row) => row.id)).toEqual(["other-0000000001"]);
    expect(after.prepare("SELECT content FROM messages").all().map((row) => row.content)).toEqual(["kept"]);
    after.close();
    expect(readFileSync(join(hermes, "state.db")).includes(SECRET)).toBe(false);
    expect(existsSync(join(hermes, "sessions", `${sid}.jsonl`))).toBe(false);
    expect(existsSync(join(hermes, "sessions", `request_dump_${sid}_1.json`))).toBe(false);
    expect(existsSync(join(hermes, "sessions", "other-0000000001.json"))).toBe(true);
  });

  it("r10 finding 1 (Hermes): a database that cannot be read during discovery removes nothing and keeps the pending record; the next run removes parent and child", async () => {
    const { data, home, db, deletions } = setup();
    const hermes = join(home, ".hermes");
    const sid = "a1b2c3d4-1111-4222-8333-444455556666", child = "child-0000000001";
    const file = join(hermes, "state.db");
    touch(file, "this is not a database"); // discovery cannot read it
    touch(join(hermes, "sessions", `${sid}.jsonl`), SECRET);
    touch(join(hermes, "sessions", `${child}.jsonl`), SECRET);
    const { report } = await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: [{ engine: "hermes", home: hermes }], sessionIds: { hermesAgent: [sid] } }, () => true);
    expect(report.failed).toContain(file);
    expect(existsSync(join(hermes, "sessions", `${sid}.jsonl`))).toBe(true);
    expect(existsSync(join(hermes, "sessions", `${child}.jsonl`))).toBe(true);
    const [saved] = deletions.pending();
    expect(saved).toBeDefined();
    expect(saved!.engineDiscovery).toBeUndefined(); // incomplete discovery is never saved
    rmSync(file);
    const store = new DatabaseSync(file);
    store.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, parent_session_id TEXT, meta TEXT);
      CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, content TEXT);`);
    store.prepare("INSERT INTO sessions VALUES(?,?,?)").run(sid, null, "{}");
    store.prepare("INSERT INTO sessions VALUES(?,?,?)").run(child, sid, "{}");
    store.prepare("INSERT INTO messages(session_id,content) VALUES(?,?)").run(child, SECRET);
    store.close();
    expect(await new ConversationDeletions({ dataDir: data, database: () => db, retryDelaysMs: [] }).reconcile(() => false, () => undefined)).toBe(1);
    const after = new DatabaseSync(file);
    expect(after.prepare("SELECT count(*) AS n FROM sessions").get()?.n).toBe(0);
    after.close();
    expect(existsSync(join(hermes, "sessions", `${sid}.jsonl`))).toBe(false);
    expect(existsSync(join(hermes, "sessions", `${child}.jsonl`))).toBe(false);
    expect(new ConversationDeletions({ dataDir: data, database: () => db }).pending()).toEqual([]);
  });

  it("r11: only a missing database counts as absent; any other probe error is a failed read so nothing is removed", () => {
    const fs = realEngineFs();
    const dir = mkdtempSync(join(tmpdir(), "probe-"));
    expect(fs.withDb(join(dir, "state.db"), () => "opened")).toBeNull(); // ENOENT: absent, not a failure
    // A real error the system gives: a name too long for the file system (ENAMETOOLONG). Windows has no such answer for a name: it
    // reports a component over 255 characters as an invalid name, which Node (libuv) reports as ENOENT, the same as a missing file.
    if (process.platform !== "win32") expect(() => fs.withDb(join(dir, "x".repeat(300), "state.db"), () => "opened")).toThrow(PlanError);
    // EIO and EACCES/EPERM, on every system, from the probe of the file and from the open of the database
    touch(join(dir, "real.db"), "");
    const real = { lstat: fsOps.lstat, openDb: fsOps.openDb };
    const fail = (code: string) => () => { throw Object.assign(new Error(`${code}: injected`), { code }); };
    try {
      for (const code of ["EIO", "EACCES", "EPERM", "EBUSY"]) {
        fsOps.lstat = fail(code) as typeof fsOps.lstat;
        expect(() => fs.withDb(join(dir, "real.db"), () => "opened")).toThrow(PlanError);
        fsOps.lstat = real.lstat;
        fsOps.openDb = fail(code) as typeof fsOps.openDb;
        expect(() => fs.withDb(join(dir, "real.db"), () => "opened")).toThrow(PlanError);
        fsOps.openDb = real.openDb;
      }
    } finally { Object.assign(fsOps, real); }
    expect(fs.withDb(join(dir, "real.db"), () => "opened")).toBe("opened");
    rmSync(dir, { recursive: true, force: true });
  });

  it("r10 finding 1 (OpenCode): a database that cannot be read during discovery removes nothing and keeps the pending record; the next run removes parent and child", async () => {
    const { data, home, db, desk, deletions } = setup();
    const dir = join(home, ".local", "share", "opencode");
    const file = join(dir, "opencode.db");
    touch(file, "this is not a database");
    touch(join(dir, "storage", "session_diff", "ses_a.json"), SECRET);
    touch(join(dir, "storage", "session_diff", "ses_child.json"), SECRET);
    const { report } = await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: [{ engine: "opencode", home: dir }] }, () => true);
    expect(report.failed).toContain(file);
    expect(existsSync(join(dir, "storage", "session_diff", "ses_a.json"))).toBe(true);
    expect(existsSync(join(dir, "storage", "session_diff", "ses_child.json"))).toBe(true);
    const [saved] = deletions.pending();
    expect(saved).toBeDefined();
    expect(saved!.engineDiscovery).toBeUndefined();
    rmSync(file);
    const store = new DatabaseSync(file);
    store.exec("CREATE TABLE session(id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT); CREATE TABLE message(id TEXT, session_id TEXT, data TEXT);");
    store.prepare("INSERT INTO session VALUES(?,?,?)").run("ses_a", null, desk);
    store.prepare("INSERT INTO session VALUES(?,?,?)").run("ses_child", "ses_a", "/sub/dir");
    store.prepare("INSERT INTO message VALUES(?,?,?)").run("m1", "ses_child", SECRET);
    store.close();
    expect(await new ConversationDeletions({ dataDir: data, database: () => db, retryDelaysMs: [] }).reconcile(() => false, () => undefined)).toBe(1);
    const after = new DatabaseSync(file);
    expect(after.prepare("SELECT count(*) AS n FROM session").get()?.n).toBe(0);
    expect(after.prepare("SELECT count(*) AS n FROM message").get()?.n).toBe(0);
    after.close();
    expect(existsSync(join(dir, "storage", "session_diff", "ses_a.json"))).toBe(false);
    expect(existsSync(join(dir, "storage", "session_diff", "ses_child.json"))).toBe(false);
  });

  it("Antigravity: the conversation's brain folder and summary row", async () => {
    const { home, deletions } = setup();
    const agy = join(home, ".gemini", "antigravity-cli");
    const cid = "c0ffee00-1111-4222-8333-444455556666";
    touch(join(agy, "brain", cid, ".system_generated", "logs", "transcript.jsonl"), SECRET);
    touch(join(agy, "brain", "other-conversation", "x"), "kept");
    const summaries = new DatabaseSync(join(agy, "conversation_summaries.db"));
    summaries.exec("CREATE TABLE summaries(app_data_dir TEXT, conversation_id TEXT, summary TEXT)");
    summaries.prepare("INSERT INTO summaries VALUES(?,?,?)").run(agy, cid, SECRET);
    summaries.prepare("INSERT INTO summaries VALUES(?,?,?)").run(agy, "other-conversation", "kept");
    summaries.close();
    await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: [{ engine: "antigravity", home: agy }], sessionIds: { antigravityAgent: [cid] } }, () => true);
    expect(existsSync(join(agy, "brain", cid))).toBe(false);
    expect(existsSync(join(agy, "brain", "other-conversation"))).toBe(true);
    const after = new DatabaseSync(join(agy, "conversation_summaries.db"));
    expect(after.prepare("SELECT conversation_id FROM summaries").all().map((row) => row.conversation_id)).toEqual(["other-conversation"]);
    after.close();
  });
});

// A listing or read failure that is not "not there" (EIO here; EACCES, EMFILE behave the same) must leave discovery
// incomplete: nothing is removed for that home and the failure is reported, so the pending record stays for the retry.
describe("file-based engine homes: only absence is silent", () => {
  const real = { lstat: fsOps.lstat, readdir: fsOps.readdir, readFile: fsOps.readFile };
  afterEach(() => { Object.assign(fsOps, real); });
  const failOn = (target: string) => {
    const eio = () => Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
    fsOps.lstat = ((p: string, ...rest: unknown[]) => { if (p === target) throw eio(); return (real.lstat as (...a: unknown[]) => unknown)(p, ...rest); }) as typeof fsOps.lstat;
  };
  const heal = () => { Object.assign(fsOps, real); };
  const folder = () => { const { desk } = setup(); return desk; };

  type Case = { name: string; engine: "codex" | "fuigo" | "qwen" | "gemini" | "kimi" | "droid"; build: (home: string, desk: string) => { fault: string; gone: string[] } };
  const codexRow = (desk: string) => `${JSON.stringify({ type: "session_meta", payload: { id: "abc", cwd: desk } })}\n`;
  const cases: Case[] = [
    { name: "Codex: a day directory that cannot be listed", engine: "codex", build: (home, desk) => {
      const file = join(home, "sessions", "2026", "10", "11", "rollout-a.jsonl"); touch(file, codexRow(desk));
      return { fault: join(home, "sessions", "2026", "10", "11"), gone: [file] };
    } },
    { name: "Codex: a rollout whose head cannot be read", engine: "codex", build: (home, desk) => {
      const file = join(home, "sessions", "2026", "10", "11", "rollout-a.jsonl"); touch(file, codexRow(desk));
      const other = join(home, "archived_sessions", "rollout-b.jsonl"); touch(other, codexRow(desk));
      return { fault: other, gone: [file, other] };
    } },
    { name: "Fuigo: the folder's sessions directory", engine: "fuigo", build: (home, desk) => {
      const dir = join(home, "sessions", fuigoSessionKey(desk)); touch(join(dir, "s1", "t.json"));
      return { fault: dir, gone: [dir] };
    } },
    { name: "Qwen: the project's chats directory", engine: "qwen", build: (home, desk) => {
      const project = join(home, "projects", qwenProjectKey(desk)); touch(join(project, "chats", "s1.jsonl"), JSON.stringify({ cwd: desk }));
      return { fault: join(project, "chats"), gone: [project] };
    } },
    { name: "Gemini: the tmp directory", engine: "gemini", build: (home, desk) => {
      const tmp = join(home, "tmp", geminiSlug(desk)); touch(join(tmp, ".project_root"), desk); touch(join(tmp, "chats", "c.jsonl"), SECRET);
      return { fault: join(home, "tmp"), gone: [tmp] };
    } },
    { name: "Kimi Code: the workdir bucket", engine: "kimi", build: (home, desk) => {
      const bucket = join(home, "sessions", kimiWorkDirKey(desk)); touch(join(bucket, "s1", "log"), SECRET);
      return { fault: bucket, gone: [bucket] };
    } },
    { name: "Droid: the folder's session bucket", engine: "droid", build: (home, desk) => {
      const bucket = join(home, "sessions", droidCwdKey(realpathSync.native(desk))); touch(join(bucket, "s1.jsonl"), SECRET);
      return { fault: bucket, gone: [bucket] };
    } },
  ];

  for (const item of cases) {
    it(`${item.name}: nothing is removed and the home is reported failed; a clean retry removes everything`, () => {
      const desk = folder();
      const home = fresh("eh");
      const { fault, gone } = item.build(home, desk);
      const homes = [{ engine: item.engine, home, ...(item.engine === "qwen" ? { secondary: home } : {}) }];
      for (const exists of gone) expect(existsSync(exists), exists).toBe(true);
      failOn(fault);
      const discover = removeEngineHistoryFiles(homes, [desk], [], {}, {}, false);
      expect(discover.failed, "discovery").toContain(fault);
      const apply = removeEngineHistoryFiles(homes, [desk], [], {}, {}, true);
      expect(apply.failed, "removal").toContain(fault);
      expect(apply.removed).toEqual([]);
      for (const exists of gone) expect(existsSync(exists), `${exists} must stay while discovery is incomplete`).toBe(true);
      heal();
      const retry = removeEngineHistoryFiles(homes, [desk], [], {}, {}, true);
      expect(retry.failed).toEqual([]);
      for (const exists of gone) expect(existsSync(exists), `${exists} removed on the clean retry`).toBe(false);
    });
  }

  it("absence stays silent for every family: a home with nothing in it reports no failure", () => {
    const desk = folder();
    for (const engine of ["codex", "fuigo", "qwen", "gemini", "kimi", "droid", "cursor", "hermes", "antigravity", "opencode"] as const) {
      const home = fresh(`empty-${engine}`);
      const result = removeEngineHistoryFiles([{ engine, home }], [desk], [], {}, {}, true);
      expect(result.failed, engine).toEqual([]);
    }
    const missing = join(fresh("gone"), "nope");
    for (const engine of ["codex", "fuigo", "qwen", "gemini", "kimi", "droid"] as const) {
      expect(removeEngineHistoryFiles([{ engine, home: missing }], [desk], [], {}, {}, true).failed, engine).toEqual([]);
    }
  });
});
