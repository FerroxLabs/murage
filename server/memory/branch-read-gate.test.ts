// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// rc3f: while a branch change of a conversation is pending (a switch away from a branch longer than the write's share), every memory
// read withholds that conversation's sources, so a record resting on an abandoned-branch message is not readable from a sibling
// conversation before the slices have retired it. Once the slices finish, the selected branch's records read again.
import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { appendMessage, setActiveLeaf } from "../message-db.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { memoryAccess, reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { claimMemoryJob, publishMemoryWork } from "./jobs.ts";
import { captureWork } from "./chunks.ts";
import { setMemoryCaptureRoster } from "./capture-scope.ts";
import { memoryAgentRoute } from "./routes.ts";
import { plausiblyReadable } from "./readable.ts";
import { BRANCH_CHANGE_PENDING } from "./deny.ts";
import { drainBranchChanges, pendingBranchChanges } from "./branch-change.ts";

afterEach(() => setMemoryCaptureRoster(null));
beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });

const TEXT = "Verified source note about the lighthouse";
function fixture() {
  // the reader is the bot's memory capability; the supporting source sits in the conversation that switches branch
  const roster = { bots: [{ id: "bot", threadId: "thread" }, { id: "other", threadId: "private" }], groups: [] };
  setMemoryCaptureRoster(() => roster); reconcileMemoryRoster(roster); setMemoryMode("capture");
  appendMessage("thread", { id: "m", at: 1, role: "user", origin: "desktop", kind: "text", text: TEXT, parentId: null });
  const work = claimMemoryJob("fixture")!; publishMemoryWork(work, "fixture", captureWork(work));
  setMemoryMode("active");
  const record = database().prepare("SELECT id FROM memory_records").get()!;
  const registry = new InternalCapabilities(); registry.begin("bot", "thread", "generation");
  const token = registry.mint({ botId: "bot", threadId: "thread", generation: "generation", depth: 99, kind: "memory", skillAuthoring: false });
  const context = memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
  const bridge = { search: async () => ({ hits: [], vectorRows: 0 }) };
  return { context, bridge, recordId: String(record.id), sourceId: work.sourceId };
}
const get = (f: ReturnType<typeof fixture>) => memoryAgentRoute("/api/internal/memory/get", { handles: [{ id: f.recordId, version: 1 }] }, f.context, f.bridge);
const search = (f: ReturnType<typeof fixture>) => memoryAgentRoute("/api/internal/memory/search", { query: "lighthouse" }, f.context, f.bridge) as Promise<{ hits: unknown[] }>;

it("withholds an abandoned-branch record from a sibling's get, search and candidate check while a 2,000-row switch is mid-slice, and reads the selected branch after", async () => {
  const f = fixture();
  // the record's evidence is the OLDEST message of a 2,000-row branch (a switch flips newest first, so it is the last to change)
  let previous = "m";
  for (let i = 1; i <= 2000; i++) { appendMessage("thread", { id: `x${i}`, at: 1 + i, role: "user", kind: "text", text: `words ${i}`, parentId: previous }); previous = `x${i}`; }
  await drainBranchChanges(database());
  database().prepare("UPDATE memory_sources SET message_id='x1' WHERE id=?").run(f.sourceId);
  expect(JSON.stringify(await get(f))).toContain(TEXT);

  // the owner switches back to the root's other child: x1..x2000 leave, far more than the write's share
  appendMessage("thread", { id: "edit", at: 5000, role: "user", kind: "text", text: "an edit", parentId: "m" });
  expect(pendingBranchChanges(database())).toBe(1);
  expect(database().prepare("SELECT state FROM memory_sources WHERE id=?").get(f.sourceId)!.state).toBe("active"); // still wrongly active mid-change
  await expect(get(f)).rejects.toThrow(/MEMORY_/);
  expect(plausiblyReadable([{ id: f.recordId, version: 1 }], [String(database().prepare("SELECT scope_id FROM memory_records WHERE id=?").get(f.recordId)!.scope_id)]).size).toBe(0);
  expect(JSON.stringify(await search(f).catch(() => ({ hits: [] })))).not.toContain(TEXT);

  await drainBranchChanges(database());
  expect(pendingBranchChanges(database())).toBe(0);
  await expect(get(f)).rejects.toThrow(/MEMORY_/); // abandoned for good: retired

  // switch back to the long branch: the source joins again in slices; withheld meanwhile, readable after
  setActiveLeaf("thread", "x2000");
  expect(pendingBranchChanges(database())).toBe(1);
  await expect(get(f)).rejects.toThrow(/MEMORY_/);
  await drainBranchChanges(database());
  expect(JSON.stringify(await get(f))).toContain(TEXT);
}, 120_000);

it("the read gate is a keyed seek whose plan is the same at 10 and at 100,000 sources", () => {
  const plans: string[] = [];
  for (const n of [10, 100_000]) {
    closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true });
    const db = database();
    db.exec("PRAGMA foreign_keys=OFF"); db.exec("BEGIN");
    db.prepare(`WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i<?1)
      INSERT INTO memory_sources(id,scope_id,thread_id,message_id,revision,content_hash,kind,speaker,outcome,state) SELECT 's'||i,'sc','T'||(i%3),'m'||i,1,'h','text','owner','recorded','active' FROM c`).run(n);
    db.prepare("INSERT INTO branch_change(thread_id,to_id) VALUES('T0','x')").run();
    db.exec("COMMIT"); db.exec("ANALYZE");
    const sql = `SELECT s.id, ${BRANCH_CHANGE_PENDING("s")} AS p FROM memory_sources s WHERE s.id=?`;
    plans.push(db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("s3").map((row) => String(row.detail)).join("|"));
    expect(Number(db.prepare(sql).get("s3")!.p)).toBe(1);  // s3: thread T0
    expect(Number(db.prepare(sql).get("s4")!.p)).toBe(0);
    expect(plans.at(-1)).not.toMatch(/SCAN s\b|SCAN memory_sources/);
    expect(plans.at(-1)).toMatch(/SEARCH bc USING/);
  }
  expect(plans[1]).toBe(plans[0]);
});
