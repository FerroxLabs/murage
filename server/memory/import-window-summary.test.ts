// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// chats-s2 (Grok privacy High): a line stored after a forget writes its text into thread_summary; the forget's import-window step then
// finds its content under an import tombstone and ends it as forgotten-original. The All chats preview must leave it in that same step.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, transaction } from "../database.ts";
import { appendMessage, closeMessageDb, searchMessagesWithMeta } from "../message-db.ts";
import { readThreadSummary } from "../thread-summary.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { forgetMemory } from "./forget.ts";
import { INLINE_REVOCATION, runRevocationJobsNow, stopMemoryRevocation } from "./memory-revocation.ts";
import { ensureScope, reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import type { Message } from "../store.ts";

const inline = { ...INLINE_REVOCATION };
beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {}); vi.spyOn(console, "log").mockImplementation(() => {});
  closeMessageDb(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
});
afterEach(() => {
  stopMemoryRevocation(); Object.assign(INLINE_REVOCATION, inline); vi.restoreAllMocks();
  closeMessageDb(); closeDatabase();
});

const msg = (id: string, text: string, parentId: string | null = null): Message => ({ id, at: Number(id.replace(/\D/g, "")) || 1, role: "user", kind: "text", text, parentId });
function live(): string {
  reconcileMemoryRoster({ bots: [{ id: "bot", threadId: "private", section: "team-a" }], groups: [] });
  setMemoryMode("active");
  return ensureScope("bot", "bot");
}
/** A memory source with `revisions` versions (hash h-<id>-<r>); upserted, so a row capture already wrote for the line keeps its rowid. */
function source(id: string, scope: string, thread: string | null, message: string | null, revisions = 1, hash = (r: number) => `h-${id}-${r}`) {
  const db = database();
  db.prepare("INSERT INTO memory_sources VALUES(?,?,?,?,NULL,?,?,'text','bot','recorded',NULL,'active') ON CONFLICT(id) DO UPDATE SET scope_id=excluded.scope_id,thread_id=excluded.thread_id,message_id=excluded.message_id,revision=excluded.revision,content_hash=excluded.content_hash,state='active'")
    .run(id, scope, thread, message, revisions, hash(revisions));
  const version = db.prepare("INSERT OR REPLACE INTO memory_source_versions VALUES(?,?,?,?,1)");
  for (let r = 1; r <= revisions; r++) version.run(id, r, hash(r), JSON.stringify({ text: `rev ${r}` }));
}

it("a line ended as forgotten-original by the import-window step leaves the All chats preview and search", () => {
  const scope = live();
  const db = database();
  appendMessage("T", msg("m1", "kept visible line"));
  source("legacy:x", scope, null, null, 100);
  // no bookkeeping inside the commit, no runner: the import window stays open until drained below
  INLINE_REVOCATION.rows = 1; INLINE_REVOCATION.ms = 0; stopMemoryRevocation();
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: "legacy:x" });
  // an old revision's bytes come in again as a new line of T while that hash still waits for its import tombstone
  appendMessage("T", msg("m2", "reimported secret CORAL", "m1"));
  source("message:T:m2", scope, "T", "m2", 1, () => "h-legacy:x-5");
  expect(readThreadSummary(db, "T")?.snippet).toBe("reimported secret CORAL");

  transaction(tx => runRevocationJobsNow(tx));
  // the import-window step ended it as forgotten-original
  expect(db.prepare("SELECT state FROM memory_sources WHERE id='message:T:m2'").get()?.state).toBe("deleted");
  expect(db.prepare("SELECT reason FROM memory_tombstones WHERE target_type='source' AND target_id='message:T:m2' AND revision IS NULL").get()?.reason).toBe("forgotten-original");
  // (a) the preview row no longer holds its text: it shows the remaining visible line
  const summary = readThreadSummary(db, "T");
  expect(summary?.snippet ?? "").not.toContain("CORAL");
  expect(summary?.snippet).toBe("kept visible line");
  // (b) the All chats search the preview sits beside does not return it
  expect(searchMessagesWithMeta("CORAL", 40, ["T"], { owner: true, excludeForgotten: true }).hits).toEqual([]);
});
