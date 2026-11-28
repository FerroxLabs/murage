// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// An engine's history home may be a link (a dotfiles folder, another disk), as it was on v1.0.20. Deleting a conversation must still
// remove that engine's own files of it through the link, and must not leave the delete pending for ever. The app-owned roots keep
// their refusal of a linked root (conversation-deletion.test.ts CONFINE-ROOT-SYMLINK). Entered through runConversationDeletion.
// Rows: the whole home is a link (removeGuarded), the Claude paste-cache folder is a link (removeUnlessReferenced), the Qwen
// projects folder is a link (rmdirIfEmpty).
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, expect, it } from "vitest";
import { ConversationDeletions, runConversationDeletion } from "./conversation-deletion.ts";
import { qwenProjectKey } from "./engine-history-deletion.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-delete-linked-home-")));
afterAll(() => removeTempDirSync(scratch));
const BOT = "f25024c1-a18e-4251-acf1-0c1713d9b6d9";
const THREAD = "2e9018ee-1f45-46be-8ed1-7a02fc022807";
const touch = (file: string, text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };

const ROWS = [
  {
    name: "codex rollout through a home that is a link",
    engine: "codex" as const,
    // returns [home handed to the run, the file that must be gone]
    seed: (base: string, desk: string): [string, string[]] => {
      const realHome = join(base, "dotfiles-home");
      const file = join(realHome, "sessions", "2026", "09", "25", "rollout-2026-09-25T10-00-00-abc.jsonl");
      touch(file, `${JSON.stringify({ type: "session_meta", payload: { id: "abc", cwd: desk } })}\n`);
      const linked = join(base, "home-link");
      symlinkSync(realHome, linked);
      return [linked, [file]];
    },
  },
  {
    name: "claude pasted text through a paste-cache folder that is a link",
    engine: "claude" as const,
    seed: (base: string, desk: string): [string, string[]] => {
      const home = join(base, "claude-home");
      const sid = "5f0c7f4e-1111-4222-8333-444455556666";
      const hash = "aaaaaaaaaaaaaaaa";
      touch(join(home, "projects", desk.replace(/[^a-zA-Z0-9]/g, "-"), `${sid}.jsonl`), `${JSON.stringify({ sessionId: sid, cwd: desk })}\n`);
      touch(join(home, "history.jsonl"), `${JSON.stringify({ display: "mail", pastedContents: { 1: { contentHash: hash } }, timestamp: 1, project: desk, sessionId: sid })}\n`);
      const realPaste = join(base, "other-disk-paste");
      const file = join(realPaste, `${hash}.txt`);
      touch(file, "mail");
      symlinkSync(realPaste, join(home, "paste-cache"));
      return [home, [file]];
    },
  },
  {
    name: "qwen project folder through a projects folder that is a link",
    engine: "qwen" as const,
    seed: (base: string, desk: string): [string, string[]] => {
      const home = join(base, "qwen-home");
      const realProjects = join(base, "other-disk-projects");
      const project = join(realProjects, qwenProjectKey(desk));
      touch(join(project, "chats", "s1.jsonl"), JSON.stringify({ cwd: desk, message: "mail" }));
      mkdirSync(home, { recursive: true });
      symlinkSync(realProjects, join(home, "projects"));
      return [home, [project]];
    },
  },
];

it.each(ROWS)("removes a $name, and reports no failure", async (row) => {
  const base = join(scratch, row.engine);
  const data = join(base, "data");
  mkdirSync(join(data, "events"), { recursive: true });
  const db = new DatabaseSync(join(data, "messages.db"));
  db.exec("CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id))");
  const desk = join(data, "workspaces", BOT, "threads", THREAD);
  touch(join(desk, "notes.md"), "mail");
  const [home, gone] = row.seed(base, desk);
  const deletions = new ConversationDeletions({ dataDir: data, database: () => db, retryDelaysMs: [] });
  const { report } = await runConversationDeletion(deletions, { threadIds: [THREAD], engineKinds: [], engineHomes: [{ engine: row.engine, home }] }, () => true, async () => {});
  for (const file of gone) expect(existsSync(file), file).toBe(false);
  expect(report.failed).toEqual([]);
  db.close();
});
