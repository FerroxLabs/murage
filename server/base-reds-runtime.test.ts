// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { afterEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { gateWriteRequest, holdWritersForIndexBuild } from "./db-busy.ts";
import { MemoryIndex } from "./memory/index.ts";
import { closeMemoryIndexReader } from "./memory/index-reader.ts";
import { ownerMemoryList, ownerSearchTrace } from "./memory/owner-list.ts";
import { ensureScope, reconcileMemoryRoster } from "./memory/policy.ts";

afterEach(() => { holdWritersForIndexBuild(false); ownerSearchTrace.on = false; closeMemoryIndexReader(); closeDatabase(); });

it("read-only team exports settle during a writer hold while other writes remain gated", async () => {
  holdWritersForIndexBuild(true);
  let exported = false, writing = false;
  const call = gateWriteRequest as (method: string, path: string) => Promise<void>;
  const read = call("POST", "/api/teams/export").then(() => { exported = true; });
  const write = call("POST", "/api/teams/export-more").then(() => { writing = true; });
  await new Promise(resolve => setImmediate(resolve));
  try { expect({ exported, writing }).toEqual({ exported: true, writing: false }); }
  finally { holdWritersForIndexBuild(false); await Promise.all([read, write]); }
});

it("a busy request reports the operation that met the lock", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const start = source.indexOf("    if (isDatabaseBusy(e))");
  const end = source.indexOf("    // One boundary for the hand-off allowance", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const stripped = stripTypeScriptTypes(`function run() { ${source.slice(start, end)} }`);
  const body = stripped.slice(stripped.indexOf("{") + 1, stripped.lastIndexOf("}"));
  const answer = new Function("e", "isDatabaseBusy", "busyJson", "res", "method", "path", "writersHeldForIndexBuild", "console", body);
  const result = answer({ op: "fixture-commit", waitedMs: 50, message: "database is locked" }, () => true, (_res: unknown, op: string) => ({ op }), {}, "POST", "/api/bots", () => true, { error() {} });
  expect(result).toEqual({ op: "fixture-commit" });
});

it("an empty search-index key range returns no matches without querying the word list", async () => {
  mkdirSync(DATA_DIR, { recursive: true });
  const roster = { bots: [{ id: "empty-range", threadId: "empty-thread" }], groups: [] };
  reconcileMemoryRoster(roster);
  const scope = ensureScope("bot", "empty-range");
  database().prepare("INSERT INTO memory_records VALUES('empty-record',1,?,'fact','weekly note','owner-statement','active',0,1,NULL,NULL,1)").run(scope);
  database().exec("INSERT INTO memory_projection_receipts VALUES('empty-record',1,1,'indexed','unavailable',NULL)");
  const index = new MemoryIndex(join(DATA_DIR, "memory-index.db"));
  index.prepareModel("fixture-model"); index.close();
  ownerSearchTrace.statements = []; ownerSearchTrace.on = true;
  const result = await ownerMemoryList({ botId: "empty-range", query: "weekly" }, roster);
  expect(result.rows).toEqual([]);
  expect(ownerSearchTrace.statements.some(row => row.db === "index")).toBe(true);
  expect(ownerSearchTrace.statements.filter(row => /\bMATCH\b/.test(row.sql))).toEqual([]);
});
