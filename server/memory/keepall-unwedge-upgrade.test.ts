// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.2 Keep all P0 (F5): the one-time repair at start of a memory file 1.0.2 left wedged (keepall-unwedge.ts). The server-level run (a
// wedged data dir restarted, its first turn answered, a second start doing nothing) is in server/memory-keepall-refused-api.test.ts.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KEEPALL_UNWEDGE, keepAllUnwedged, MEMORY_REPAIRS_FILE, runKeepAllUnwedge } from "./keepall-unwedge.ts";
import { WritetimeFixture } from "./testing/writetime-fixture.ts";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const setup = () => {
  const fx = new WritetimeFixture();
  const dir = mkdtempSync(join(tmpdir(), "keepall-unwedge-"));
  cleanups.push(() => { fx.close(); removeTempDirSync(dir); });
  return { fx, dir };
};
const rows = (fx: WritetimeFixture, thread: string) => (fx.db.prepare("SELECT native_session AS s, revoke_id AS r FROM memory_deny_session WHERE thread_id=? ORDER BY 1,2").all(thread) as Array<{ s: string; r: number }>).map(row => `${row.s}@${row.r}`);

describe("the Keep all repair at start", () => {
  it("removes audience-only session marks on the owner's direct chats only, clears cursors, sets its flag, and does nothing a second time", () => {
    const { fx, dir } = setup();
    // the wedged shape: receipts flipped by a roster change (audience-only revokes 4 and 5) marked the owner's newest sessions; a forget (revoke 9)
    // marked one too; a channel person's thread holds an audience-only mark as well
    for (const revoke of [4, 5]) fx.db.prepare("INSERT INTO memory_revoke_audience(revoke_id) VALUES(?)").run(revoke);
    fx.owner("owner-chat", "o1", 1).sessionLineage("owner-chat", "fuigo", "s-1", 1, 4).sessionLineage("owner-chat", "fuigo", "s-2", 4, 8);
    fx.denySession("owner-chat", "fuigo", "s-1", 4).denySession("owner-chat", "fuigo", "s-2", 5).denySession("owner-chat", "fuigo", "s-1", 9);
    fx.owner("person-chat", "p1", 10).sessionLineage("person-chat", "fuigo", "p-1", 10, 12).denySession("person-chat", "fuigo", "p-1", 4);
    // a revoke a 1.0.2 inherit reopened and never finished
    fx.db.prepare("INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(4,'inherit',?,1,2,'mark','','active')").run(JSON.stringify({ kind: "inherit", cause: "inherit" }));
    let drained = 0, cleared = 0;
    const lines: string[] = [];
    const deps = { ownerDirectThread: (thread: string) => thread === "owner-chat", drain: () => { drained++; }, clearCursors: () => { cleared++; return 1; }, log: (line: string) => lines.push(line) };
    expect(keepAllUnwedged(fx.db, dir)).toBe(false);
    const first = runKeepAllUnwedge(fx.db, dir, deps);
    expect(first).toMatchObject({ skipped: false, denySessions: 2, ownerThreads: 1, openJobs: 1, cursors: 1, done: true });
    // the owner's chat keeps only the forget's mark; the channel person's thread keeps its audience-only mark (an audience reader honours it)
    expect(rows(fx, "owner-chat")).toEqual(["s-1@9"]);
    expect(rows(fx, "person-chat")).toEqual(["p-1@4"]);
    expect(drained).toBe(1);
    expect(cleared).toBe(1);
    expect(lines).toEqual(["[memory] keep-all repair: owner-chat session marks removed=2 threads=1 open-jobs=1 cursors-cleared=1"]);
    // the flag names this memory file
    const installationId = String(fx.db.prepare("SELECT installation_id FROM memory_meta WHERE id=1").get()!.installation_id);
    expect(JSON.parse(readFileSync(join(dir, MEMORY_REPAIRS_FILE), "utf8"))[KEEPALL_UNWEDGE].installationId).toBe(installationId);
    expect(keepAllUnwedged(fx.db, dir)).toBe(true);
    // a second start does nothing, even with a new audience-only mark on the owner's chat (inert there: deny-read.ts sessionLookup)
    fx.denySession("owner-chat", "fuigo", "s-2", 4);
    const second = runKeepAllUnwedge(fx.db, dir, deps);
    expect(second.skipped).toBe(true);
    expect(rows(fx, "owner-chat")).toEqual(["s-2@4", "s-1@9"].sort());
    expect(cleared).toBe(1);
    expect(lines).toHaveLength(1);
  });
  it("a replaced memory file (another installation id) is repaired again; a missing flag file is a first run", () => {
    const { fx, dir } = setup();
    expect(existsSync(join(dir, MEMORY_REPAIRS_FILE))).toBe(false);
    const deps = { ownerDirectThread: () => true, clearCursors: () => 0, log: () => {} };
    expect(runKeepAllUnwedge(fx.db, dir, deps).skipped).toBe(false);
    expect(runKeepAllUnwedge(fx.db, dir, deps).skipped).toBe(true);
    fx.db.prepare("UPDATE memory_meta SET installation_id=? WHERE id=1").run("00000000-0000-4000-8000-000000000000");
    expect(keepAllUnwedged(fx.db, dir)).toBe(false);
    expect(runKeepAllUnwedge(fx.db, dir, deps).skipped).toBe(false);
  });
});
