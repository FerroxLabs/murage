// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GET /api/memory/status costs the same at any history size: one capped count per state (not per scope), a body that does not grow with the number of
// conversations. Pinned by plan, rows visited and bytes, never by time.
import { mkdirSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { MEMORY_COUNT_CAP } from "./forget.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { MEMORY_SCOPE_LABELS_MAX, MEMORY_STATE_COUNT_SQL, MEMORY_STATUS_SCOPE_LIMIT, memoryOwnerRoute, memoryOwnerStatus } from "./settings.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const roster = { bots: [{ id: "a", threadId: "thread-a" }], groups: [] };
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); reconcileMemoryRoster(roster); });

function fill(scopes: number, perScope: number, state = "active") {
  const db = database();
  db.exec("BEGIN");
  db.prepare(`WITH RECURSIVE c(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM c WHERE v<?) INSERT INTO memory_scopes SELECT 'fx-'||v,'conversation','fx-thread-'||v,'[]',0 FROM c`).run(scopes);
  db.prepare(`WITH RECURSIVE s(a) AS (VALUES(1) UNION ALL SELECT a+1 FROM s WHERE a<?), r(b) AS (VALUES(1) UNION ALL SELECT b+1 FROM r WHERE b<?)
    INSERT INTO memory_records SELECT 'rec-'||a||'-'||b,1,'fx-'||a,'fact','text','owner',?,0,1,NULL,NULL,a*100000+b FROM s, r`).run(scopes, perScope, state);
  db.exec("COMMIT");
}
const status = () => memoryOwnerStatus(ownerMemoryTicket(), roster) as unknown as Record<string, unknown> & { records: Record<string, number>; recordsMore: Record<string, boolean>; scopes: unknown[]; scopesOmitted: number };

describe("the capped count per state", () => {
  for (const [scopes, perScope] of [[50, 2000], [500, 2000]] as const) {
    it(`${scopes} scopes x ${perScope} active records: plan is a scope scan plus an index seek, rows visited stay at the cap, and the figure reads 1,000+`, () => {
      fill(scopes, perScope);
      const db = database();
      const plan = (db.prepare(`EXPLAIN QUERY PLAN ${MEMORY_STATE_COUNT_SQL}`).all("active", MEMORY_COUNT_CAP + 1) as Array<{ detail: string }>).map(d => d.detail).join("\n");
      expect(plan).toMatch(/SCAN s/);
      expect(plan).toMatch(/SEARCH r USING (COVERING )?INDEX memory_records_scope \(scope_id=\? AND state=\?\)/);
      let visited = 0;
      db.function("visit", () => { visited++; return 1; });
      const counting = MEMORY_STATE_COUNT_SQL.replace("AND r.state=?", "AND r.state=? AND visit()");
      const n = Number((db.prepare(counting).get("active", MEMORY_COUNT_CAP + 1) as { n: number }).n);
      expect(n).toBe(MEMORY_COUNT_CAP + 1);
      expect(visited).toBeLessThanOrEqual(MEMORY_COUNT_CAP + 1);
      const out = status();
      expect(out.records.active).toBe(MEMORY_COUNT_CAP);
      expect(out.recordsMore.active).toBe(true);
    });
  }

  it("exactly 1,000 rows is not 'more'; 1,001 is", () => {
    fill(3, 1);
    const db = database();
    db.prepare("INSERT INTO memory_scopes VALUES('one','bot','one','[]',0)").run();
    const add = (from: number, to: number) => db.prepare(`WITH RECURSIVE c(v) AS (VALUES(?) UNION ALL SELECT v+1 FROM c WHERE v<?) INSERT INTO memory_records SELECT 'b-'||v,1,'one','fact','t','owner','archived',0,1,NULL,NULL,v FROM c`).run(from, to);
    add(1, MEMORY_COUNT_CAP);
    expect(status().records.archived).toBe(MEMORY_COUNT_CAP);
    expect(status().recordsMore.archived).toBeUndefined();
    add(MEMORY_COUNT_CAP + 1, MEMORY_COUNT_CAP + 1);
    expect(status().recordsMore.archived).toBe(true);
  });
});

describe("the body", () => {
  it("996 conversation scopes: no top-level key passes 16 KB, the audiences people choose stay, and the omission is counted", () => {
    fill(996, 3);
    const out = status();
    const sizes = Object.fromEntries(Object.entries(out).map(([key, value]) => [key, JSON.stringify(value ?? null).length]));
    console.info("memory status key bytes", JSON.stringify(sizes), "total", JSON.stringify(out).length);
    for (const [key, bytes] of Object.entries(sizes)) expect({ key, over: bytes > 16 * 1024 }).toEqual({ key, over: false });
    expect(JSON.stringify(out).length).toBeLessThan(32 * 1024);
    expect(out.scopesOmitted).toBeGreaterThanOrEqual(996);
    expect((out.scopes as Array<{ kind: string }>).every(scope => scope.kind !== "conversation")).toBe(true);
    expect((out.scopes as Array<{ ownerKey: string }>).some(scope => scope.ownerKey === "a")).toBe(true);
  });

  it("the body is the same size with 10x the conversations", () => {
    fill(MEMORY_STATUS_SCOPE_LIMIT + 50, 1);
    const small = JSON.stringify(status()).length;
    closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); reconcileMemoryRoster(roster);
    fill((MEMORY_STATUS_SCOPE_LIMIT + 50) * 10, 1);
    const big = JSON.stringify(status()).length;
    expect(Math.abs(big - small)).toBeLessThan(64);
  });

  it("a small history lists every audience and omits nothing", () => {
    fill(10, 1);
    const out = status();
    expect(out.scopesOmitted).toBe(0);
    expect(out.scopes.length).toBeGreaterThanOrEqual(10);
  });
});

describe("the names of the conversations the status leaves out", () => {
  type Audience = { id: string; kind: string; ownerKey: string; label: string };
  const labels = (scopeIds: string[]) => memoryOwnerRoute("/api/memory/action", { action: "scope-labels", scopeIds }, ownerMemoryTicket(), roster) as Promise<{ scopes: Audience[] }>;

  it("996 conversations: the status stays small, and every omitted conversation is named by one keyed call of at most 50 ids", async () => {
    fill(996, 1);
    const out = status();
    expect(JSON.stringify(out).length).toBeLessThan(32 * 1024);
    const listed = new Set((out.scopes as Audience[]).map(scope => scope.id));
    const omitted = Array.from({ length: 996 }, (_, index) => `fx-${index + 1}`).filter(id => !listed.has(id));
    expect(omitted).toHaveLength(996);
    // every one of them is nameable, 50 at a time, and a call stays far below the cap on bytes
    let named = 0, biggest = 0;
    for (let at = 0; at < omitted.length; at += MEMORY_SCOPE_LABELS_MAX) {
      const answer = await labels(omitted.slice(at, at + MEMORY_SCOPE_LABELS_MAX));
      biggest = Math.max(biggest, JSON.stringify(answer).length);
      for (const scope of answer.scopes) { expect(scope.label).toBe(scope.ownerKey); expect(scope.label).not.toBe("A conversation"); named++; }
    }
    expect(named).toBe(996);
    console.info("scope-labels bytes for 50 ids", biggest);
    expect(biggest).toBeLessThan(8 * 1024);
    // names for all 996 as one compact id->name map would be this large; the keyed call is why it is not in the status
    console.info("names-only map bytes for 996 scopes", JSON.stringify(Object.fromEntries(omitted.map(id => [id, `fx-thread-${id.slice(3)}`]))).length);
  });

  it("is bounded: more than 50 ids is refused, unknown ids are left out, duplicates answer once", async () => {
    fill(3, 1);
    await expect(labels(Array.from({ length: MEMORY_SCOPE_LABELS_MAX + 1 }, (_, index) => `fx-${index}`))).rejects.toThrow("INVALID_MEMORY_ARGUMENTS");
    const answer = await labels(["fx-1", "fx-1", "missing"]);
    expect(answer.scopes.map(scope => scope.id)).toEqual(["fx-1"]);
  });

  it("reads by primary key", () => {
    const plan = (database().prepare("EXPLAIN QUERY PLAN SELECT id,kind,owner_key FROM memory_scopes WHERE id=?").all("x") as Array<{ detail: string }>).map(d => d.detail).join("\n");
    expect(plan).toMatch(/SEARCH memory_scopes USING (COVERING )?INDEX|PRIMARY KEY/);
  });
});
