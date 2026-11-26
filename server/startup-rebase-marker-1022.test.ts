// q1022-startup item 3: once a previous data root is recorded, a start after the rebase finished does not read every message
// (or every artifact) again; a new previous root, and rows written since, are still rebased. Driven through the two boot steps
// index.ts runs (attachments.rebasePaths -> rebaseMessageAttachmentPaths, artifacts.rebaseSourceRoots -> rebaseArtifactSourceRoots).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { DATA_DIR, ensureDirs } from "./config.ts";
import { bootDataRoots } from "./data-roots.ts";
import { database } from "./database.ts";
import { insertMessage, readMessage, rebaseMessageAttachmentPaths } from "./message-db.ts";
import { rebaseArtifactSourceRoots } from "./artifact-paths.ts";
import { cwdConstructors } from "./turn-paths.ts";

const first = join(DATA_DIR, "root-one"), second = join(DATA_DIR, "root-two");
const image = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}.png`;
const attachment = (path: string) => ({ kind: "image" as const, path, mime: "image/png" });
function movedFrom(root: string) {
  ensureDirs();
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(join(DATA_DIR, ".murage-root.json"), JSON.stringify({ schema: 1, root, previous: [] }));
  bootDataRoots();
}
/** Rows the rebase pass reads back from SQLite: every .all() over messages/artifacts while the pass runs. */
function measured(db: DatabaseSync, run: () => number) {
  const prepare = db.prepare.bind(db);
  let rows = 0;
  (db as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (!/FROM (messages|artifacts)\b/.test(sql) || /MAX\(rowid\)/.test(sql)) return statement;
    const all = statement.all.bind(statement);
    (statement as { all: typeof statement.all }).all = ((...args: Parameters<typeof statement.all>) => { const out = all(...args); rows += out.length; return out; }) as typeof statement.all;
    return statement;
  }) as typeof db.prepare;
  try { const changed = run(); return { rows, changed }; }
  finally { (db as { prepare: typeof db.prepare }).prepare = prepare; }
}

it("a second start with the same previous roots reads no message row again; rows written since and a new previous root are still rebased", () => {
  movedFrom(first);
  const N = 40;
  // rows an older version wrote before the move (message writes now store current-root paths: MAIN-RULING STARTUP-1022 H2-sameKey)
  const old = database().prepare("INSERT INTO messages (thread_id, id, at, role, kind, text, json, seq) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)");
  for (let n = 0; n < N; n++) old.run("rb-thread", `m${n}`, n + 1, "user", "text", null, JSON.stringify({ id: `m${n}`, role: "user", kind: "text", at: n + 1, attachments: [attachment(join(first, "attachments", image(n)))] }));
  // a row naming a root that is not (yet) a recorded previous root: left as it is by this pass
  insertMessage("rb-thread", { id: "later-root", role: "user", kind: "text", at: 100, attachments: [attachment(join(second, "attachments", image(999)))] });
  const boot1 = measured(database(), () => rebaseMessageAttachmentPaths());
  expect(boot1.changed).toBe(N);
  expect(boot1.rows).toBeGreaterThanOrEqual(N + 1);
  expect(readMessage("rb-thread", "m0")?.attachments?.[0].path).toBe(join(DATA_DIR, "attachments", image(0)));

  // the next start: same record, same roots. Nothing to change and nothing is read.
  bootDataRoots();
  const boot2 = measured(database(), () => rebaseMessageAttachmentPaths());
  expect(boot2.changed).toBe(0);
  expect(boot2.rows).toBe(0);

  // a row written after the pass (an old-shape row) is still read and rebased on the following start
  database().prepare("INSERT INTO messages (thread_id, id, at, role, kind, text, json, seq) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)")
    .run("rb-thread", "after", 200, "user", "text", null, JSON.stringify({ id: "after", role: "user", kind: "text", at: 200, attachments: [attachment(join(first, "attachments", image(500)))] }));
  const boot3 = measured(database(), () => rebaseMessageAttachmentPaths());
  expect(boot3.changed).toBe(1);
  expect(boot3.rows).toBe(1);

  // the top row is deleted and a new old-root row takes its rowid (no INTEGER PRIMARY KEY): the next start still rebases it
  database().prepare("DELETE FROM messages WHERE thread_id=? AND id=?").run("rb-thread", "after");
  database().prepare("INSERT INTO messages (thread_id, id, at, role, kind, text, json, seq) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)")
    .run("rb-thread", "reused", 300, "user", "text", null, JSON.stringify({ id: "reused", role: "user", kind: "text", at: 300, attachments: [attachment(join(first, "attachments", image(600)))] }));
  const boot3b = measured(database(), () => rebaseMessageAttachmentPaths());
  expect(boot3b.changed, "a row that reused the high-water rowid is rebased").toBe(1);

  // another move: root-two becomes a recorded previous root, so every row is read again and the older row naming it moves
  movedFrom(second);
  const boot4 = measured(database(), () => rebaseMessageAttachmentPaths());
  expect(boot4.changed).toBe(1);
  expect(boot4.rows).toBeGreaterThanOrEqual(N + 2);
  expect(readMessage("rb-thread", "later-root")?.attachments?.[0].path).toBe(join(DATA_DIR, "attachments", image(999)));
});

it("artifacts: a second start with the same previous roots reads no artifact row again; a new previous root reads them all", () => {
  movedFrom(first);
  const db = database();
  const add = db.prepare("INSERT INTO artifacts(id,name,kind,mime,bytes,sha256,extension,created_at,bot_id,thread_id,run_id,source_root,relative_path,source_fingerprint) VALUES(?,?,'text','text/plain',1,?,'txt',1,'bot-rb',?,'',?,'a.txt','old')");
  const N = 30;
  for (let n = 0; n < N; n++) add.run(`rb-a${n}`, `a${n}`, `s${n}`, `t${n}`, join(first, "workspaces", "bot-rb", "threads", `t${n}`));
  add.run("rb-late", "late", "late", "t-late", join(second, "workspaces", "bot-rb", "threads", "t-late"));
  const constructors = (row: { botId: string; threadId: string }) => cwdConstructors({ id: row.botId }, row.threadId);
  const boot1 = measured(db, () => rebaseArtifactSourceRoots(db, constructors));
  expect(boot1.changed).toBe(N);
  bootDataRoots();
  const boot2 = measured(db, () => rebaseArtifactSourceRoots(db, constructors));
  expect(boot2.changed).toBe(0);
  expect(boot2.rows).toBe(0);
  movedFrom(second);
  const boot3 = measured(db, () => rebaseArtifactSourceRoots(db, constructors));
  expect(boot3.changed).toBe(1);
  expect(boot3.rows).toBeGreaterThanOrEqual(N + 1);
  expect(db.prepare("SELECT source_root FROM artifacts WHERE id='rb-late'").get()?.source_root).toBe(join(DATA_DIR, "workspaces", "bot-rb", "threads", "t-late"));
});

it("artifacts: a row whose rebase the unique key IGNOREd is tried again on the next start once its twin is gone (self-review M1)", () => {
  movedFrom(first);
  const db = database();
  const add = db.prepare("INSERT INTO artifacts(id,name,kind,mime,bytes,sha256,extension,created_at,bot_id,thread_id,run_id,source_root,relative_path,source_fingerprint) VALUES(?,?,'text','text/plain',1,?,'txt',1,'bot-m1',?,'',?,'a.txt','old')");
  add.run("m1-old", "old", "same", "t1", join(first, "workspaces", "bot-m1", "threads", "t1"));
  add.run("m1-twin", "twin", "same", "t1", join(DATA_DIR, "workspaces", "bot-m1", "threads", "t1"));
  for (let n = 0; n < 5; n++) add.run(`m1-other${n}`, `o${n}`, `o${n}`, `u${n}`, join(DATA_DIR, "workspaces", "bot-m1", "threads", `u${n}`));
  const constructors = (row: { botId: string; threadId: string }) => cwdConstructors({ id: row.botId }, row.threadId);
  expect(rebaseArtifactSourceRoots(db, constructors), "the twin holds the current-root key: the update is ignored").toBe(0);
  db.prepare("DELETE FROM artifacts WHERE id='m1-twin'").run();
  bootDataRoots();
  rebaseArtifactSourceRoots(db, constructors);
  expect(db.prepare("SELECT source_root FROM artifacts WHERE id='m1-old'").get()?.source_root, "the ignored row is rebased on the next start").toBe(join(DATA_DIR, "workspaces", "bot-m1", "threads", "t1"));
});
