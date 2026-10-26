// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// QW design section 6 GATE, "downgrade rehearsal with widget rows" (1.0.4 item 207). A person who goes back from 1.0.4 to
// 1.0.3 keeps the conversations that hold widgets. 1.0.3 checks every message row before it backs up (the snapshot's
// inspect) and before it restores (restore preparation and activation), with a kind list that has no widget kind: a row
// it refuses fails the WHOLE backup or restore. So a widget is a bot `kind: "text"` row whose `text` is readable words (the
// title and the choices) with the tree in a `widget` field beside it, which 1.0.3's schema lets pass. This file builds a
// 1.0.4 database with open, updated, answered, fence-made and reopened widgets, backs it up the 1.0.4 way, and runs 1.0.3's
// own checks (pinned copies of its source at 81ee09f2b, server/testing/release-1.0.3/) on the result for both directions.
// Fails before the fix: the rows were `kind: "widget"`, which 1.0.3's z.enum refuses.
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";

import { prepareWidgetPress, reopenWidget, showWidget, updateWidget } from "./chat-widgets.ts";
import { DATA_DIR } from "./config.ts";
import { closeDatabase } from "./database.ts";
import { inspectInstallationDatabase, snapshotInstallationDatabase } from "./installation-database-snapshot.ts";
import { closeMessageDb } from "./message-db.ts";
import { Store } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { validInstallationMessagePayload as valid103 } from "./testing/release-1.0.3/installation-message-validation.ts";
import { InstallationTranscriptGraph as Graph103 } from "./testing/release-1.0.3/installation-transcript-graph.ts";
import { stopWalMaintenance } from "./wal-maintenance.ts";

const BOOKING = {
  type: "Card", title: "Book a call", confirm: { label: "Book it", action: { type: "book" } }, cancel: { label: "Not now", action: { type: "cancel" } },
  children: [
    { type: "DatePicker", name: "date", label: "Date" },
    { type: "Select", name: "length", label: "Length", options: [{ label: "30 minutes", value: "30" }, { label: "1 hour", value: "60" }] },
  ],
};
const roots: string[] = [];
const fail = (code: string): never => { throw new Error(`1.0.3 refused: ${code}`); };

/** 1.0.3's activation review of each restored row (installation-activation.ts inertMessage at 81ee09f2b), copied as written. */
const object = (value: unknown): value is Record<string, any> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
function inertMessage103(value: unknown) {
  if (!object(value)) fail("INVALID_REVIEW_MESSAGE");
  const row = value as Record<string, any>;
  if (row.queued === true || (object(row.goalRun) && row.goalRun.status === "working")) fail("RESTORE_WORK_NOT_PAUSED");
  if (object(row.card) && (row.card.requestId || row.card.routineRequest || row.card.skillRequest) && !row.card.answered) fail("RESTORE_WORK_NOT_PAUSED");
  for (const key of ["secret", "connector", "mcpSignIn"]) if (object(row[key]) && (row[key].dismissed !== true || row[key].resumed !== false)) fail("RESTORE_WORK_NOT_PAUSED");
}

beforeEach(() => { closeMessageDb(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { closeMessageDb(); closeDatabase(); for (const root of roots.splice(0)) removeTempDirSync(root); });

/** A 1.0.4 installation whose conversation holds every widget state, backed up the 1.0.4 way. */
async function backupWithWidgets(): Promise<{ snapshot: string; threadId: string; widgetIds: string[] }> {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const bot = store.createBot({ name: "Widget downgrade" }, { seedMessages: false });
  store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "book me a call" });
  const open = showWidget(store, bot.threadId, BOOKING, "turn-1");
  const updated = showWidget(store, bot.threadId, BOOKING, "turn-1");
  const answered = showWidget(store, bot.threadId, BOOKING, "turn-1");
  const said = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "```murage-widget\n{}\n```", turnId: "turn-2" });
  const fenced = showWidget(store, bot.threadId, BOOKING, "turn-2", { messageId: said.id, index: 0 });
  if (!open.ok || !updated.ok || !answered.ok || !fenced.ok) throw new Error("a widget did not show");
  expect(updateWidget(store, bot.threadId, updated.widgetId, { ...BOOKING, caption: "Changed" })).toMatchObject({ ok: true });
  const press = prepareWidgetPress(answered.message.widget!, { ref: "confirm", values: { date: "2026-10-21", length: "60" } });
  if (!press.ok) throw new Error(press.error);
  store.patchMessage(bot.threadId, answered.message.id, { widget: { ...answered.message.widget!, settled: press.settled } });
  const reopened = reopenWidget(store, bot.threadId, answered.widgetId);
  if (!reopened.ok) throw new Error(reopened.error);
  closeMessageDb(); closeDatabase(); await stopWalMaintenance();
  const root = mkdtempSync(join(tmpdir(), "murage-widget-downgrade-")); roots.push(root);
  const snapshot = join(root, "snapshot.db");
  // the 1.0.4 backup itself accepts the file it makes
  expect(await snapshotInstallationDatabase(DATA_DIR, snapshot)).toMatchObject({ status: "copied" });
  return { snapshot, threadId: bot.threadId, widgetIds: [open.widgetId, updated.widgetId, answered.widgetId, fenced.widgetId, reopened.widgetId] };
}

const rowsOf = (db: DatabaseSync) => db.prepare("SELECT thread_id AS threadId, kind, text, json FROM messages ORDER BY thread_id, rowid").all() as Array<{ threadId: string; kind: string; text: string | null; json: string }>;

it("a 1.0.4 backup with widget rows passes 1.0.3's backup check, and every widget row reads as its words", async () => {
  const { snapshot, widgetIds } = await backupWithWidgets();
  const db = new DatabaseSync(snapshot, { readOnly: true });
  try {
    expect(inspectInstallationDatabase(db).messages).toBeGreaterThan(widgetIds.length);
    const rows = rowsOf(db);
    const widgets = rows.filter((row) => (JSON.parse(row.json) as { widget?: unknown }).widget !== undefined);
    expect(widgets.map((row) => (JSON.parse(row.json) as { widget: { id: string } }).widget.id).sort()).toEqual([...widgetIds].sort());
    for (const row of widgets) {
      // the column 1.0.3 indexes, renders and searches by: an ordinary text row with the title and the choices in it
      expect(row.kind).toBe("text");
      expect(row.text).toContain("Book a call");
      expect(row.text).toContain("30 minutes / 1 hour");
      expect(valid103(JSON.parse(row.json))).toBe(true);
    }
    // 1.0.3's snapshot inspect (installation-database-snapshot.ts at 81ee09f2b): the identity check, then every row of
    // every thread through its transcript graph and payload schema
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE json_type(json) != 'object' OR json_extract(json,'$.id') IS NOT id").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE json_extract(json,'$.at') IS NOT at OR json_extract(json,'$.role') IS NOT role OR json_extract(json,'$.kind') IS NOT kind OR json_extract(json,'$.text') IS NOT text").get()).toEqual({ count: 0 });
    let thread: string | undefined;
    let graph = new Graph103(fail);
    for (const row of rows) {
      if (thread !== row.threadId) { graph.validate(); graph = new Graph103(fail); thread = row.threadId; }
      graph.add(JSON.parse(row.json));
    }
    graph.validate();
  } finally { db.close(); }
}, 60000);

it("the same backup restores on 1.0.3: preparation's transcript check and activation's review accept every widget row", async () => {
  const { snapshot, threadId } = await backupWithWidgets();
  const db = new DatabaseSync(snapshot, { readOnly: true });
  try {
    const leaf = (db.prepare("SELECT active_leaf_id AS leaf FROM thread_state WHERE thread_id=?").get(threadId) as { leaf: string | null }).leaf;
    // a restored transcript, as preparation reads messages-<thread>.json and activation reviews it
    const transcript = rowsOf(db).filter((row) => row.threadId === threadId).map((row) => JSON.parse(row.json) as Record<string, unknown>);
    expect(transcript.filter((row) => row.widget !== undefined)).toHaveLength(5);
    const graph = new Graph103(fail);
    for (const row of transcript) { graph.add(row); inertMessage103(row); }
    graph.validate(leaf);
    // an answered widget keeps its answer through the restore (unknown fields pass 1.0.3's schema unchanged)
    const settled = transcript.find((row) => (row.widget as { settled?: unknown } | undefined)?.settled);
    expect(settled?.widget).toMatchObject({ settled: { ref: "confirm", label: "Book it", values: { date: "2026-10-21", length: "60" } } });
  } finally { db.close(); }
}, 60000);
