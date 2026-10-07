// SPDX-License-Identifier: AGPL-3.0-or-later
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { initializeProjectTables } from "./project-tables.ts";
import { channelToProjectRows } from "./project-settings.ts";
import { recordProjectRoutine, linkLegacyProjectRoutineRuns, projectMainThread } from "./project-routines.ts";
import { createProjectGoal, startProjectGoal } from "./project-goals.ts";

describe("project routine row delivery", () => {
  it.each(["ongoing", "goal"])("posts %s work once, with a queued routine request", mode => {
    const db = new DatabaseSync(":memory:"); initializeProjectTables(db);
    channelToProjectRows(db, { groupId: "g", leadBotId: "lead", bulletin: "", now: 1 });
    db.prepare("UPDATE project_settings SET mode='ongoing'").run();
    if (mode === "goal") {
      const goal = createProjectGoal(db, { groupId: "g", title: "Finish", now: 1 });
      if (!goal.ok) throw new Error("fixture");
      startProjectGoal(db, { goalId: goal.goal.id, tz: "UTC", now: 2 });
    }
    const input = { groupId: "g", threadId: "room", memberIds: ["lead"], runId: "run", botId: "lead", name: "Daily check", prompt: "Check it", now: 3 };
    expect(recordProjectRoutine(db, input)).toMatchObject({ created: true });
    expect(recordProjectRoutine(db, input)).toMatchObject({ created: false });
    expect(db.prepare("SELECT verb, from_kind, origin, admission_key, state FROM room_requests").get()).toMatchObject({ verb: "routine", from_kind: "routine", origin: "server", admission_key: "routine:run", state: "queued" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM project_work_items").get()!.n).toBe(mode === "ongoing" ? 1 : 0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM project_activity WHERE kind='routine_run'").get()!.n).toBe(1);
    db.close();
  });
});

it("links existing routine threads in Activity once", () => {
  const db = new DatabaseSync(":memory:"); initializeProjectTables(db);
  channelToProjectRows(db, { groupId: "g", bulletin: "", leadBotId: null, now: 1 });
  const runs = [{ id: "old", groupId: "g", threadId: "old-task", target: "room-goal", createdAt: 1 }];
  linkLegacyProjectRoutineRuns(db, runs);
  linkLegacyProjectRoutineRuns(db, runs);
  const rows = db.prepare("SELECT detail FROM project_activity WHERE kind='routine_run'").all();
  expect(rows).toHaveLength(1);
  expect(JSON.parse(String(rows[0]!.detail))).toMatchObject({ threadId: "old-task", runId: "old" });
  db.close();
});

it("uses the group main chat even when older routine tasks exist", () => {
  expect(projectMainThread({ threadId: "main", tasks: [{ threadId: "new", createdAt: 2 }, { threadId: "old", createdAt: 1 }] })).toBe("main");
});
