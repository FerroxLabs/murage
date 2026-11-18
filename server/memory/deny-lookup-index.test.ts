// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { denyLookup, denyReadMeter, resetDenyReadMeter } from "./deny-read.ts";
import { CONTENT, testThreadNo, WritetimeFixture } from "./testing/writetime-fixture.ts";

it("a page's lineage lookup seeks both the thread and each message rather than walking the thread prefix", () => {
  const fixture = new WritetimeFixture();
  try {
    fixture.reply("thread", "reply", 2);
    resetDenyReadMeter();
    expect(denyLookup(fixture.db, { threadId: "thread", lines: [{ messageId: "reply", author: "generated" }] }, CONTENT).get("reply")).toEqual({ state: "shown" });
    const sql = denyReadMeter().sql.find(sql => sql.startsWith("SELECT message_id,lsn,turn_lsn,mem_lsn,footprint FROM memory_line_lineage"));
    expect(sql).toBeDefined();
    const plan = fixture.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(testThreadNo(fixture.db, "thread"), JSON.stringify(["reply"]));
    expect(plan.some(row => /SEARCH memory_line_lineage .*\(thread_no=\? AND message_id=\?\)/.test(String(row.detail)))).toBe(true);
  } finally { fixture.close(); }
});
