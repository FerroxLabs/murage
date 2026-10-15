// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Write-time privacy (Murage 1.0.2, STORAGE-AUDIT 2): a full turn through the real server writes no root-set row. Its replies get their
// write-time lineage rows instead. Boots the real harness server (node server/index.ts) with the fake engine.
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { api, desktopApi, home } from "./testing/index-harness.ts";

const ROOT_SET_TABLES = ["memory_root_sets", "memory_root_set_members", "memory_root_set_parents", "memory_output_roots", "memory_session_roots"];

describe("a full turn writes zero root-set rows", () => {
  it("a direct turn on the fake engine: replies stored with lineage rows, and every memory_root_set_* and root table still empty", async () => {
    const bot = (await desktopApi("POST", "/api/bots")).body.bot;
    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).status).toBe(200);
    expect((await desktopApi("POST", `/api/bots/${bot.id}/messages`, { text: "write-time root set probe" })).status).toBe(202);
    await expect.poll(async () => ((await api("GET", `/api/threads/${bot.threadId}/messages`)).body.messages as Array<{ role: string }>).some(message => message.role === "bot"), { timeout: 30_000 }).toBe(true);
    const db = new DatabaseSync(join(home, ".murage", "messages.db"), { readOnly: true });
    try {
      for (const table of ROOT_SET_TABLES) expect(Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n), table).toBe(0);
      const lines = Number(db.prepare("SELECT count(*) AS n FROM memory_line_lineage l JOIN memory_thread_no t ON t.no=l.thread_no WHERE t.thread_id=?").get(bot.threadId)!.n);
      expect(lines).toBeGreaterThanOrEqual(2);
    } finally { db.close(); }
  }, 60_000);
});
