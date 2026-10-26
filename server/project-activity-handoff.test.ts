// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.4 rig: a project's Activity listed usage, limit and settings lines and never the hand-offs its lead made ("Activity has no hand-off line").
// Activity now reads one line per teammate hand-off from the hand-off's own request: who handed work to whom, and where it stands. Nothing new is
// stored (the activity table's kinds are frozen), so hand-offs made before this build show too.
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { initializeProjectTables } from "./project-tables.ts";
import { channelToProjectRows } from "./project-settings.ts";
import { handleProjectRoute } from "./project-routes.ts";
import { insertProjectActivity } from "./project-records.ts";

mkdirSync(DATA_DIR, { recursive: true });

function fixture() {
  const db = new DatabaseSync(":memory:");
  initializeProjectTables(db);
  channelToProjectRows(db, { groupId: "g", bulletin: "Rules", leadBotId: "ember", now: 1 });
  const group = { id: "g", memberIds: ["ember", "canvas", "byline"], threadId: "room", dm: false };
  const read = (query = "") => handleProjectRoute(db, { method: "GET", path: "/api/groups/g/activity", query: new URLSearchParams(query), body: {}, group, now: 1000 });
  const request = (id: string, input: { at: number; to: string; state: string; handoff?: 0 | 1; from?: string; fromKind?: string; group?: string }) => db.prepare(`INSERT INTO room_requests
    (id, root_id, group_id, target_thread_id, verb, from_kind, from_bot_id, to_bot_id, origin, root_thread_id, audience_fingerprint, not_owner_audience, unattended, admission_key, state, created_at, handoff)
    VALUES (?, ?, ?, 'desk', 'ask', ?, ?, ?, 'desktop', 'room', 'owner', 0, 0, ?, ?, ?, ?)`)
    .run(id, id, input.group ?? "g", input.fromKind ?? "bot", input.from ?? "ember", input.to, `ask:delegation:${id}`, input.state, input.at, input.handoff ?? 1);
  return { db, read, request };
}
const items = (result: ReturnType<ReturnType<typeof fixture>["read"]>) => (result!.body as { items: Array<{ id: string; kind: string; at: number; actor: string; requestId: string | null; detail: Record<string, unknown> }> }).items;

describe("project Activity shows the hand-offs", () => {
  it("each teammate hand-off is one line (who, to whom, where it stands), in time order with the stored lines", () => {
    const { db, read, request } = fixture();
    try {
      insertProjectActivity(db, { groupId: "g", kind: "budget_raised", actor: "owner", at: 30, detail: { budgetId: "b" } });
      request("h-byline", { at: 20, to: "byline", state: "done" });
      request("h-canvas", { at: 40, to: "canvas", state: "failed" });
      request("not-a-handoff", { at: 50, to: "canvas", state: "done", handoff: 0 });
      request("owner-send", { at: 60, to: "ember", state: "done", fromKind: "owner", from: "" });
      request("elsewhere", { at: 70, to: "canvas", state: "done", group: "other" });
      const list = items(read());
      // (the project's own "settings" line from its creation sorts last)
      expect(list.map((row) => [row.kind, row.at])).toEqual([["handoff", 40], ["budget_raised", 30], ["handoff", 20], ["settings", 1]]);
      expect(list[0]).toMatchObject({ id: "handoff:h-canvas", actor: "ember", requestId: "h-canvas", detail: { toBotId: "canvas", state: "failed" } });
      expect(list[2]).toMatchObject({ id: "handoff:h-byline", actor: "ember", detail: { toBotId: "byline", state: "done" } });
    } finally { db.close(); }
  });

  it("pages like the stored lines (before, limit) and stays out of a card's own history", () => {
    const { db, read, request } = fixture();
    try {
      for (let at = 1; at <= 5; at++) request(`h${at}`, { at: at * 10, to: "canvas", state: "done" });
      insertProjectActivity(db, { groupId: "g", kind: "card_moved", actor: "owner", workItemId: "c-1", at: 25 });
      expect(items(read("limit=2")).map((row) => row.at)).toEqual([50, 40]);
      expect(items(read("before=40&limit=3")).map((row) => row.at)).toEqual([30, 25, 20]);
      expect(items(read("card=c-1")).map((row) => row.kind)).toEqual(["card_moved"]);
    } finally { db.close(); }
  });
});
