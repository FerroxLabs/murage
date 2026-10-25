// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.4 memory gaps A and B: a historical read refuses a version that was only ever a candidate, and the "where it came from"
// excerpts are shown only for a waiting memory whose sources are still there.
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { appendMessage } from "../message-db.ts";
import { ensureScope, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { claimMemoryJob, publishMemoryWork } from "./jobs.ts";
import { captureWork } from "./chunks.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { memoryOwnerRoute } from "./settings.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { vi.restoreAllMocks(); });

const TEXT_ONE = "The deploy window is Tuesday and reports go out Monday";
const TEXT_TWO = "A second message about the launch review date";

function world() {
  const roster = {
    bots: [{ id: "bot", name: "Sable", threadId: "thread" }, { id: "other", name: "Ember", threadId: "other-thread" }],
    groups: [{ id: "room", name: "Ops room", threadId: "room-thread", memberIds: ["bot", "other"] }],
  } as unknown as MemoryRoster;
  reconcileMemoryRoster(roster); setMemoryMode("capture");
  const sources: string[] = [];
  // Two sources in two threads: a second message in one thread would retire the first from the visible branch.
  [["thread", TEXT_ONE], ["other-thread", TEXT_TWO]].forEach(([thread, text], index) => {
    appendMessage(thread, { id: `m${index}`, at: index + 1, role: "user", kind: "text", text });
    const work = claimMemoryJob("fixture")!; publishMemoryWork(work, "fixture", captureWork(work)); sources.push(work.sourceId);
  });
  setMemoryMode("active");
  const db = database(), owner = ownerMemoryTicket();
  let tick = Date.now();
  const scopes = { bot: ensureScope("bot", "bot"), other: ensureScope("bot", "other"), room: ensureScope("room", "room"), conversation: ensureScope("conversation", "other-thread") };
  function candidate(text: string, options: { scope?: keyof typeof scopes; kind?: string; supersedes?: string; source?: number; assertion?: string } = {}) {
    const id = randomUUID();
    db.prepare("INSERT INTO memory_records VALUES(?,1,?,?,?,?,'candidate',0,?,NULL,?,?)")
      .run(id, scopes[options.scope ?? "bot"], options.kind ?? "fact", text, options.assertion ?? "assistant-inference", ++tick, options.supersedes ?? null, tick);
    db.prepare("INSERT INTO memory_evidence VALUES(?,1,?,1,0,5)").run(id, sources[options.source ?? 0]);
    return id;
  }
  const act = (body: Record<string, unknown>) => memoryOwnerRoute("/api/memory/action", body, owner, roster) as Promise<any>;
  const row = (id: string, version = 1) => db.prepare("SELECT state,text,owner_pinned FROM memory_records WHERE id=? AND version=?").get(id, version) as { state: string; text: string; owner_pinned: number } | undefined;
  return { roster, db, owner, scopes, sources, candidate, act, row };
}
import { InternalCapabilities } from "../internal-capabilities.ts";
import { memoryAccess } from "./policy.ts";
import { readableMemoryRecord } from "./readable.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
const uid = () => randomUUID();

function accessOf(w: ReturnType<typeof world>) {
  const registry = new InternalCapabilities(), generation = registry.begin("bot", "thread");
  const token = registry.mint({ botId: "bot", threadId: "thread", generation, depth: 0, kind: "memory", skillAuthoring: false });
  return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => w.roster);
}

describe("historical reads (104 gap A)", () => {
  it("refuses a version that was only ever a candidate, and still reads a kept one", async () => {
    const w = world(), access = accessOf(w);
    const id = w.candidate("Reports go out on Mondays");
    await w.act({ action: "review-edit", actionId: uid(), id, version: 1, text: "Reports go out on Mondays, short." });
    expect(w.row(id, 1)!.state).toBe("superseded");
    const allowance = () => LineageAllowance.tool(1_000_000_000);
    expect(readableMemoryRecord(id, 1, access, { allowance: allowance(), mode: "historical" })).toBe("MEMORY_RECORD_UNAVAILABLE");
    // a kept (once active, now superseded) version is real history and stays readable
    const kept = w.candidate("The standup moves to nine", { assertion: "owner-statement" });
    await w.act({ action: "review-keep", actionId: uid(), id: kept, version: 1 });
    w.db.prepare("UPDATE memory_records SET state='superseded' WHERE id=? AND version=1").run(kept);
    expect(typeof readableMemoryRecord(kept, 1, access, { allowance: allowance(), mode: "historical" })).not.toBe("string");
  });
});

describe("waiting sources (104 gap B)", () => {
  it("shows an excerpt for a waiting memory, none once the source is forgotten, and none for a memory that is not waiting", async () => {
    const w = world();
    const id = w.candidate("Reports go out on Mondays");
    expect((await w.act({ action: "waiting-sources", id, version: 1 })).sources).toHaveLength(1);
    w.db.prepare("INSERT INTO memory_tombstones VALUES('tomb-b','source',?,NULL,NULL,1,'forgotten',1)").run(w.sources[0]);
    expect((await w.act({ action: "waiting-sources", id, version: 1 })).sources).toEqual([]);
    const active = w.candidate("The launch review is on a Friday", { source: 1 });
    w.db.prepare("UPDATE memory_records SET state='active' WHERE id=?").run(active);
    expect((await w.act({ action: "waiting-sources", id: active, version: 1 })).sources).toEqual([]);
  });
});
