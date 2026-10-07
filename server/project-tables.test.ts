// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lane R schema tests: the eleven project tables, their registration in the
// archive inspector, and the shared row validator (SPEC-P 15.2).
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import { initializeProjectTables, prepareProjectTablesForRestore, assertProjectTablesPaused, PROJECT_TABLE_NAMES, validateProjectRows, deleteProjectRows, pruneProjectActivity, markProjectDerivedStale } from "./project-tables.ts";
import { initializeMessageTables } from "./message-tables.ts";
import { initializeInbox } from "./inbox.ts";
import { initializeArtifacts } from "./artifacts.ts";
import { initializeThreadSnooze } from "./thread-snooze.ts";
import { initializeImageOperations } from "./image-operations-schema.ts";
import { inspectInstallationDatabase, InstallationSnapshotError } from "./installation-database-snapshot.ts";

function freshDb() {
  const db = new DatabaseSync(":memory:");
  initializeMessageTables(db);
  initializeInbox(db);
  initializeArtifacts(db);
  initializeImageOperations(db);
  initializeThreadSnooze(db);
  initializeProjectTables(db);
  return db;
}

const NOW = Date.now();

function insertSettings(db: DatabaseSync, groupId: string, over: Record<string, unknown> = {}) {
  db.prepare(`INSERT INTO project_settings
    (group_id, mode, lead_bot_id, parts, parallel_cards, work_roots, work_profile, migrated_from, owner_viewed_at, run_state, run_state_reason, closed_at, ended_at, revision, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    groupId, "conversation", null, "{}", 3, "[]", "ask", null, null, "running", null, null, null, 0, NOW,
  );
  for (const [key, value] of Object.entries(over)) {
    db.prepare(`UPDATE project_settings SET ${key}=? WHERE group_id=?`).run(value as never, groupId);
  }
}

function insertGoal(db: DatabaseSync, id: string, groupId: string, state: string) {
  db.prepare(`INSERT INTO project_goals (id, group_id, title, description, criteria, state, state_reason, plan_first, review, replans, no_progress, lead_wakes, revision, created_at, started_at, finished_at, summary_message_id, deadline_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, groupId, "Goal", "", "[]", state, null, 0, 1, 0, 0, 0, 0, NOW, null, null, null, null);
}

let cardNumber = 0;
function insertCard(db: DatabaseSync, id: string, groupId: string, state: string, over: Record<string, unknown> = {}) {
  db.prepare(`INSERT INTO project_work_items
    (id, group_id, goal_id, number, title, description, assignee_bot_id, owner_took_over, state, column_id, position, revision, generation, attempt, failures, waiting_on, reason, needs, touches, depends_on, writes, work_root_index, request_id, review_request_id, desk_thread_id, result_message_id, source_message_ids, stale, create_key, due_at, created_by, created_at, updated_at, done_at, archived_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, groupId, null, ++cardNumber, "Card", "", null, 0, state, null, 1, 0, 0, 1, 0, null, null, "[]", "[]", "[]", 1, null, null, null, null, null, "[]", 0, null, null, "owner", NOW, NOW, null, null,
  );
  for (const [key, value] of Object.entries(over)) {
    db.prepare(`UPDATE project_work_items SET ${key}=? WHERE id=?`).run(value as never, id);
  }
}

function insertRequest(db: DatabaseSync, id: string, groupId: string, state: string, over: Record<string, unknown> = {}) {
  db.prepare(`INSERT INTO room_requests
    (id, root_id, parent_id, card_generation, attempt, group_id, target_thread_id, project_goal_id, work_item_id, verb, from_kind, from_bot_id, to_bot_id, payload_text, reply_to_id, send_id, mode, origin, root_thread_id, audience_fingerprint, not_owner_audience, unattended, execution_audience, source_message_id, return_thread_id, return_bot_id, admission_key, priority, state, refusal, created_at, dispatched_at, deadline_at, finished_at, owner_wait_ms, waiting_since, result_message_id, outcome_note)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, id, null, null, 1, groupId, null, null, null, "assign", "owner", null, null, null, null, null, null, "desktop", "thread-1", "owner", 0, 0, null, null, null, null, `key:${id}`, "work", state, null, NOW, null, null, null, 0, null, null, null,
  );
  for (const [key, value] of Object.entries(over)) {
    db.prepare(`UPDATE room_requests SET ${key}=? WHERE id=?`).run(value as never, id);
  }
}

describe("initializeProjectTables", () => {
  it("creates all eleven tables with their indexes, idempotently", () => {
    const db = freshDb();
    initializeProjectTables(db); // second run must be a no-op
    const tables = new Set((db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all() as Array<{ name: string }>).map(row => row.name));
    for (const name of PROJECT_TABLE_NAMES) expect(tables.has(name), name).toBe(true);
    expect(PROJECT_TABLE_NAMES).toEqual([
      "project_settings", "room_requests", "project_work_items", "project_board_columns", "project_briefs",
      "project_goals", "project_budgets", "usage_ledger", "project_summaries", "project_activity", "project_member_state",
    ]);
    const indexes = (db.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND name LIKE 'room_requests_%' OR name LIKE 'project_%' OR name LIKE 'usage_%'").all() as Array<{ name: string }>).map(row => row.name);
    for (const name of [
      "room_requests_group_state", "room_requests_root", "room_requests_parent", "room_requests_work_item", "room_requests_to_bot",
      "project_work_items_group_state", "project_work_items_number", "project_goals_group_state", "project_goals_one_active",
      "project_budgets_group", "project_budgets_one_period", "project_budgets_one_goal",
      "usage_ledger_group_at", "usage_ledger_goal", "usage_ledger_root", "project_activity_group_at",
    ]) expect(indexes, name).toContain(name);
    db.close();
  });

  it("enforces the one-active-goal rule in SQL", () => {
    const db = freshDb();
    insertGoal(db, "g1", "grp", "working");
    expect(() => insertGoal(db, "g2", "grp", "paused")).toThrow();
    insertGoal(db, "g3", "grp", "draft"); // draft does not count as active
    insertGoal(db, "g4", "grp", "done");
    db.close();
  });

  it("passes the archive inspector on a fresh database (referenceSchema includes every new object)", () => {
    const db = freshDb();
    expect(() => inspectInstallationDatabase(db)).not.toThrow();
    db.close();
  });

  it("accepts an older archive without the project tables (required: false)", () => {
    const db = new DatabaseSync(":memory:");
    initializeMessageTables(db);
    initializeInbox(db);
    initializeArtifacts(db);
    initializeImageOperations(db);
    initializeThreadSnooze(db);
    expect(() => inspectInstallationDatabase(db)).not.toThrow();
    db.close();
  });

  it("accepts a database with any one project table dropped", () => {
    for (const name of PROJECT_TABLE_NAMES) {
      const db = freshDb();
      db.exec(`DROP TABLE ${name}`);
      expect(() => inspectInstallationDatabase(db), name).not.toThrow();
      db.close();
    }
  });

  it("refuses a project table whose DDL changed", () => {
    const db = freshDb();
    db.exec("DROP TABLE project_goals");
    db.exec("CREATE TABLE project_goals (id TEXT PRIMARY KEY NOT NULL, group_id TEXT NOT NULL)");
    expect(() => inspectInstallationDatabase(db)).toThrow(InstallationSnapshotError);
    try { inspectInstallationDatabase(db); } catch (error) { expect((error as InstallationSnapshotError).code).toBe("DATABASE_SCHEMA_UNSUPPORTED"); }
    db.close();
  });

  it("refuses an unknown table, which is what the previous release says to a new archive", () => {
    // The previous release's inspector knows no project tables: from its
    // reference schema every one of them is simply an unknown object. The
    // refusal path is the same one this fixture exercises with a stand-in.
    const db = freshDb();
    db.exec("CREATE TABLE project_future_lane (id TEXT PRIMARY KEY NOT NULL)");
    try { inspectInstallationDatabase(db); expect.unreachable(); }
    catch (error) { expect((error as InstallationSnapshotError).code).toBe("DATABASE_SCHEMA_UNSUPPORTED"); }
    db.close();
  });
});

describe("validateProjectRows (SPEC-P 15.2)", () => {
  const ctx = { groups: [{ id: "grp", channelProject: { goal: "g" } }], botIds: new Set(["b1", "lead"]), now: NOW };

  it("accepts a fully paused project", () => {
    const db = freshDb();
    insertSettings(db, "grp", { run_state: "paused", run_state_reason: "Restored from a backup: paused. Resume?" });
    insertGoal(db, "g1", "grp", "paused");
    expect(validateProjectRows(db, ctx)).toEqual([]);
    db.close();
  });

  it("refuses an open request, naming the table", () => {
    const db = freshDb();
    insertSettings(db, "grp", { run_state: "paused" });
    insertRequest(db, "r1", "grp", "queued");
    try { validateProjectRows(db, ctx); expect.unreachable(); }
    catch (error) {
      expect((error as InstallationSnapshotError).code).toBe("RESTORE_WORK_NOT_PAUSED");
      expect(String((error as Error).cause)).toContain("room_requests");
    }
    db.close();
  });

  it("refuses a planning or working goal", () => {
    for (const state of ["planning", "working"]) {
      const db = freshDb();
      insertSettings(db, "grp", { run_state: "paused" });
      insertGoal(db, "g1", "grp", state);
      try { validateProjectRows(db, ctx); expect.unreachable(); }
      catch (error) {
        expect((error as InstallationSnapshotError).code).toBe("RESTORE_WORK_NOT_PAUSED");
        expect(String((error as Error).cause)).toContain("project_goals");
      }
      db.close();
    }
  });

  it("refuses a card that is doing, in review, or in a live wait", () => {
    for (const [state, waitingOn] of [["doing", null], ["review", null], ["waiting", JSON.stringify({ kind: "owner_approval" })]] as Array<[string, string | null]>) {
      const db = freshDb();
      insertSettings(db, "grp", { run_state: "paused" });
      insertCard(db, "c1", "grp", state, waitingOn ? { waiting_on: waitingOn } : {});
      try { validateProjectRows(db, ctx); expect.unreachable(state); }
      catch (error) { expect((error as InstallationSnapshotError).code).toBe("RESTORE_WORK_NOT_PAUSED"); }
      db.close();
    }
  });

  it("refuses settings that are not paused, not ask, or still hold work roots", () => {
    for (const over of [{ run_state: "running" }, { work_profile: "auto-in-roots", run_state: "paused" }, { work_roots: JSON.stringify([{ path: "/tmp/x", dev: "1", ino: "2", label: "x", addedAt: 1 }]), run_state: "paused" }]) {
      const db = freshDb();
      insertSettings(db, "grp", over);
      try { validateProjectRows(db, ctx); expect.unreachable(JSON.stringify(over)); }
      catch (error) { expect((error as InstallationSnapshotError).code).toBe("RESTORE_WORK_NOT_PAUSED"); }
      db.close();
    }
  });

  it("repairs invalid descriptive JSON with a note instead of refusing", () => {
    const db = freshDb();
    insertSettings(db, "grp", { run_state: "paused" });
    // The CHECK(json_valid) constraint keeps malformed JSON out, so the
    // violations a restore can meet are structural: valid JSON, wrong shape.
    insertCard(db, "c1", "grp", "todo", { touches: '{"not":"an array"}' });
    const notes = validateProjectRows(db, ctx);
    expect(notes.length).toBe(1);
    expect(notes[0]).toContain("project_work_items");
    expect((db.prepare("SELECT touches FROM project_work_items WHERE id='c1'").get() as { touches: string }).touches).toBe("[]");
    db.close();
  });

  it("refuses invalid authority JSON", () => {
    const db = freshDb();
    insertSettings(db, "grp", { run_state: "paused", parts: '{"board":"yes"}' });
    try { validateProjectRows(db, ctx); expect.unreachable(); }
    catch (error) { expect((error as InstallationSnapshotError).code).toBe("RESTORE_WORK_NOT_PAUSED"); }
    db.close();
  });

  it("cuts a depends_on cycle by dropping the edge to the later card", () => {
    const db = freshDb();
    insertSettings(db, "grp", { run_state: "paused" });
    insertCard(db, "c1", "grp", "todo", { depends_on: '["c2"]', created_at: 1 });
    insertCard(db, "c2", "grp", "todo", { depends_on: '["c1"]', created_at: 2 });
    const notes = validateProjectRows(db, ctx);
    expect(notes.length).toBe(1);
    const c1 = db.prepare("SELECT depends_on FROM project_work_items WHERE id='c1'").get() as { depends_on: string };
    const c2 = db.prepare("SELECT depends_on FROM project_work_items WHERE id='c2'").get() as { depends_on: string };
    // c2 is the later card, so the c1 -> c2 edge (pointing at it) is cut.
    expect(JSON.parse(c1.depends_on)).toEqual([]);
    expect(JSON.parse(c2.depends_on)).toEqual(["c1"]);
    db.close();
  });

  it("clears a card reference to a missing request", () => {
    const db = freshDb();
    insertSettings(db, "grp", { run_state: "paused" });
    insertCard(db, "c1", "grp", "todo", { request_id: "gone" });
    const notes = validateProjectRows(db, ctx);
    expect(notes.some(note => note.includes("request"))).toBe(true);
    expect((db.prepare("SELECT request_id FROM project_work_items WHERE id='c1'").get() as { request_id: string | null }).request_id).toBeNull();
    db.close();
  });

  it("clears a column_id that names no column of the card's state", () => {
    const db = freshDb();
    insertSettings(db, "grp", { run_state: "paused" });
    db.prepare("INSERT INTO project_board_columns (group_id, id, title, state, position) VALUES ('grp','col1','Client review','waiting',1)").run();
    insertCard(db, "c1", "grp", "todo", { column_id: "col1" }); // state mismatch
    insertCard(db, "c2", "grp", "waiting", { column_id: "missing" }); // missing column
    validateProjectRows(db, ctx);
    expect((db.prepare("SELECT column_id FROM project_work_items WHERE id='c1'").get() as { column_id: string | null }).column_id).toBeNull();
    expect((db.prepare("SELECT column_id FROM project_work_items WHERE id='c2'").get() as { column_id: string | null }).column_id).toBeNull();
    db.close();
  });

  it("clears a lead or assignee that is not a bot of the restored install", () => {
    const db = freshDb();
    insertSettings(db, "grp", { run_state: "paused", lead_bot_id: "ghost" });
    insertCard(db, "c1", "grp", "todo", { assignee_bot_id: "ghost" });
    validateProjectRows(db, ctx);
    expect((db.prepare("SELECT lead_bot_id FROM project_settings WHERE group_id='grp'").get() as { lead_bot_id: string | null }).lead_bot_id).toBeNull();
    expect((db.prepare("SELECT assignee_bot_id FROM project_work_items WHERE id='c1'").get() as { assignee_bot_id: string | null }).assignee_bot_id).toBeNull();
    db.close();
  });

  it("refuses an open settings row whose group is gone from the restored groups.json", () => {
    const db = freshDb();
    insertSettings(db, "grp", { run_state: "paused" });
    try { validateProjectRows(db, { ...ctx, groups: [] }); expect.unreachable(); }
    catch (error) { expect((error as InstallationSnapshotError).code).toBe("RESTORE_WORK_NOT_PAUSED"); }
    db.close();
  });

  it("skips absent tables (an archive from before the projects release)", () => {
    const db = new DatabaseSync(":memory:");
    initializeMessageTables(db);
    expect(validateProjectRows(db, ctx)).toEqual([]);
    db.close();
  });
});

describe("deleteProjectRows", () => {
  it("deletes the group's rows from every table except usage_ledger", () => {
    const db = freshDb();
    insertSettings(db, "grp");
    insertGoal(db, "g1", "grp", "done");
    insertCard(db, "c1", "grp", "done");
    insertRequest(db, "r1", "grp", "done");
    db.prepare("INSERT INTO usage_ledger (settle_key, bot_id, thread_id, engine, tokens_reported, charge_kind, work_ms, ok, rolled_up, at, group_id) VALUES ('turn:x','b1','t1','claude',1,'none',5,1,0,?,'grp')").run(NOW);
    db.prepare("INSERT INTO project_activity (id, group_id, at, kind, actor, detail) VALUES ('a1','grp',?,'card_created','owner','{}')").run(NOW);
    db.prepare("INSERT INTO project_member_state (group_id, bot_id, updated_at) VALUES ('grp','b1',?)").run(NOW);
    insertRequest(db, "r2", "grp", "queued");
    deleteProjectRows(db, "grp", NOW);
    const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    for (const table of PROJECT_TABLE_NAMES) {
      if (table === "usage_ledger") expect(count(table), table).toBe(1);
      else expect(count(table), table).toBe(0);
    }
    db.close();
  });
});

describe("pruneProjectActivity", () => {
  it("deletes activity older than 90 days and keeps newer rows", () => {
    const db = freshDb();
    const old = NOW - 91 * 24 * 60 * 60 * 1000;
    db.prepare("INSERT INTO project_activity (id, group_id, at, kind, actor, detail) VALUES ('old','grp',?,'card_created','owner','{}')").run(old);
    db.prepare("INSERT INTO project_activity (id, group_id, at, kind, actor, detail) VALUES ('new','grp',?,'card_created','owner','{}')").run(NOW);
    pruneProjectActivity(db, NOW);
    const rows = db.prepare("SELECT id FROM project_activity").all() as Array<{ id: string }>;
    expect(rows.map(row => row.id)).toEqual(["new"]);
    db.close();
  });
});

describe("markProjectDerivedStale (SPEC-P 15.3)", () => {
  it("marks every derived row citing a forgotten message", () => {
    const db = freshDb();
    insertSettings(db, "grp");
    insertCard(db, "c1", "grp", "todo", { source_message_ids: '["m1","m2"]' });
    insertCard(db, "c2", "grp", "todo", { source_message_ids: '["m9"]' });
    db.prepare("INSERT INTO project_summaries (group_id, version, text, source_message_ids, made_by, at, stale) VALUES ('grp',1,'sum','[\"m2\"]','b1',?,0)").run(NOW);
    db.prepare("INSERT INTO project_member_state (group_id, bot_id, last_card_summary, last_card_summary_sources, stale, updated_at) VALUES ('grp','b1','sum','[\"m1\"]',0,?)").run(NOW);
    db.prepare(`INSERT INTO project_briefs (group_id, version, summary, done_means, rules, where_work_is, decisions, updated_by, change, updated_at)
      VALUES ('grp',1,'','','',?,?,'lead','lead_note',?)`).run(
      JSON.stringify([{ text: "note", by: "b1", at: 1, sourceMessageIds: ["m1"] }, { text: "keep", by: "b1", at: 2 }]),
      JSON.stringify([{ id: "d1", text: "decide", by: "b1", at: 1, sourceMessageIds: ["nope"] }]),
      NOW,
    );
    const marked = markProjectDerivedStale(db, ["m1", "m2"]);
    expect(marked).toBeGreaterThanOrEqual(3);
    expect((db.prepare("SELECT stale FROM project_work_items WHERE id='c1'").get() as { stale: number }).stale).toBe(1);
    expect((db.prepare("SELECT stale FROM project_work_items WHERE id='c2'").get() as { stale: number }).stale).toBe(0);
    expect((db.prepare("SELECT stale FROM project_summaries WHERE group_id='grp'").get() as { stale: number }).stale).toBe(1);
    expect((db.prepare("SELECT stale FROM project_member_state WHERE group_id='grp'").get() as { stale: number }).stale).toBe(1);
    const brief = db.prepare("SELECT where_work_is, decisions FROM project_briefs WHERE group_id='grp'").get() as { where_work_is: string; decisions: string };
    const notes = JSON.parse(brief.where_work_is) as Array<{ text: string; stale?: boolean }>;
    expect(notes[0]!.stale).toBe(true);
    expect(notes[1]!.stale).toBeUndefined();
    expect((JSON.parse(brief.decisions) as Array<{ stale?: boolean }>)[0]!.stale).toBeUndefined();
    db.close();
  });
});

describe("project restore matrix", () => {
  const ctx = { groups: [{ id: "grp", channelProject: {} }], botIds: new Set(["b1"]), now: NOW };
  it("pauses live rows, clears a doing card's custom column, and keeps history", () => {
    const db = freshDb();
    insertSettings(db, "grp");
    insertGoal(db, "g", "grp", "working");
    db.prepare("INSERT INTO project_board_columns VALUES ('grp','custom','In work','doing',1)").run();
    insertRequest(db, "r", "grp", "running");
    insertCard(db, "c", "grp", "doing", { column_id: "custom", request_id: "r" });
    db.prepare("INSERT INTO project_budgets (id,group_id,period,tz,period_start,max_work_minutes,warn_at,state,revision,created_at) VALUES ('b','grp','week','UTC',0,120,0.8,'paused',0,0)").run();
    db.prepare("INSERT INTO usage_ledger (settle_key,group_id,bot_id,thread_id,engine,tokens_reported,charge_kind,work_ms,ok,at) VALUES ('u','grp','b1','t','fake',0,'none',5,1,0)").run();
    const budgetsBefore=db.prepare("SELECT * FROM project_budgets").all();
    const usageBefore=db.prepare("SELECT * FROM usage_ledger").all();
    const notes = prepareProjectTablesForRestore(db, ctx);
    expect(db.prepare("SELECT * FROM project_budgets").all()).toEqual(budgetsBefore);
    expect(db.prepare("SELECT * FROM usage_ledger").all()).toEqual(usageBefore);
    expect(notes.length).toBeGreaterThan(0);
    expect(() => assertProjectTablesPaused(db, ctx)).not.toThrow();
    expect(db.prepare("SELECT state,column_id,waiting_on FROM project_work_items").get()).toMatchObject({ state: "waiting", column_id: null, waiting_on: '{"kind":"restore"}' });
    expect(db.prepare("SELECT state,outcome_note FROM room_requests").get()).toMatchObject({ state: "expired", outcome_note: "restored" });
    expect(db.prepare("SELECT state FROM project_budgets").get()!.state).toBe("paused");
    expect(db.prepare("SELECT work_ms FROM usage_ledger").get()!.work_ms).toBe(5);
    db.close();
  });
  it.each(PROJECT_TABLE_NAMES)("skips absent archive table %s without recreating it", table => {
    const db = freshDb(); insertSettings(db, "grp");
    db.exec(`DROP TABLE ${table}`);
    expect(() => prepareProjectTablesForRestore(db, ctx)).not.toThrow();
    expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(table)).toBeUndefined();
    db.close();
  });
});

it("refuses malformed execution audience shape before resetting restore authority", () => {
  const db = freshDb(); insertSettings(db, "grp");
  insertRequest(db, "r", "grp", "done", { execution_audience: '{"v":1,"kind":"project"}' });
  expect(() => prepareProjectTablesForRestore(db, { groups: [{ id: "grp", channelProject: {} }], botIds: new Set(), now: NOW })).toThrow(InstallationSnapshotError);
  db.close();
});
it("repairs invalid criterion entry shape with a note", () => {
  const db = freshDb(); insertSettings(db, "grp", { run_state: "paused" });
  insertGoal(db, "g", "grp", "draft");
  db.prepare("UPDATE project_goals SET criteria='[42]'").run();
  const notes = validateProjectRows(db, { groups: [{ id: "grp", channelProject: {} }], botIds: new Set(), now: NOW });
  expect(notes).toHaveLength(1);
  expect(db.prepare("SELECT criteria FROM project_goals").get()!.criteria).toBe("[]");
  db.close();
});

it("the previous inspector schema refuses an archive with project tables", async () => {
  const db = freshDb();
  // Model the previous APP_TABLES and initializer together using the real inspector.
  vi.resetModules();
  vi.doMock("./project-tables.ts", () => ({ initializeProjectTables: () => {} }));
  const iterate = Map.prototype[Symbol.iterator];
  const projectNames = new Set<string>(PROJECT_TABLE_NAMES);
  const registry = vi.spyOn(Map.prototype, Symbol.iterator).mockImplementation((function* (this: Map<unknown, unknown>) {
    for (const entry of iterate.call(this)) {
      const [key, value] = entry;
      if (projectNames.has(String(key)) && value && typeof value === "object" && Object.hasOwn(value, "required") && Object.hasOwn(value, "optional")) continue;
      yield entry;
    }
  }) as never);
  try {
    const previous = await import("./installation-database-snapshot.ts");
    expect(() => previous.inspectInstallationDatabase(db)).toThrowError(expect.objectContaining({ code: "DATABASE_SCHEMA_UNSUPPORTED" }));
  } finally { registry.mockRestore(); vi.doUnmock("./project-tables.ts"); vi.resetModules(); db.close(); }
});
