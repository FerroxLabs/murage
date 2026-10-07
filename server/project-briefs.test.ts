// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lane R brief tests (SPEC-P 3.5, 11.1 brief routes): copy-on-write
// versioning, the 409 changed rule, restore-this-version, lead append-only
// updates and the 200-version cap.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { initializeProjectTables } from "./project-tables.ts";
import { leadProjectBriefUpdate, patchProjectBrief } from "./project-briefs.ts";
import { currentProjectBrief, projectBriefVersion } from "./project-records.ts";

const NOW = 1_700_300_000_000;

function freshDb() {
  const db = new DatabaseSync(":memory:");
  initializeProjectTables(db);
  db.prepare(`INSERT INTO project_settings
    (group_id, mode, lead_bot_id, parts, parallel_cards, work_roots, work_profile, run_state, revision, updated_at)
    VALUES ('grp','conversation','lead','{}',3,'[]','ask','running',0,?)`).run(NOW);
  db.prepare(`INSERT INTO project_briefs (group_id, version, summary, done_means, rules, where_work_is, decisions, updated_by, change, updated_at)
    VALUES ('grp',1,'The summary','Done means shipped','The rules','[]','[]','owner','owner_edit',?)`).run(NOW);
  return db;
}

describe("patchProjectBrief", () => {
  it("writes a new version with the changed fields and keeps the rest", () => {
    const db = freshDb();
    const result = patchProjectBrief(db, { groupId: "grp", expectedVersion: 1, rules: "New rules", now: NOW + 1 });
    expect(result.ok).toBe(true);
    const brief = currentProjectBrief(db, "grp")!;
    expect(brief).toMatchObject({ version: 2, rules: "New rules", summary: "The summary", doneMeans: "Done means shipped", updatedBy: "owner", change: "owner_edit" });
    expect(projectBriefVersion(db, "grp", 1)).toMatchObject({ rules: "The rules" }); // version 1 is untouched
    db.close();
  });

  it("a stale expectedVersion is 409 changed with the current brief", () => {
    const db = freshDb();
    const stale = patchProjectBrief(db, { groupId: "grp", expectedVersion: 7, rules: "x", now: NOW });
    expect(stale).toMatchObject({ ok: false, error: "changed" });
    if (!stale.ok && stale.error === "changed") expect(stale.brief.version).toBe(1);
    db.close();
  });

  it("restores a past version as a new version", () => {
    const db = freshDb();
    patchProjectBrief(db, { groupId: "grp", expectedVersion: 1, rules: "Second", summary: "v2", now: NOW + 1 });
    const restored = patchProjectBrief(db, { groupId: "grp", expectedVersion: 2, restoreVersion: 1, now: NOW + 2 });
    expect(restored.ok).toBe(true);
    const brief = currentProjectBrief(db, "grp")!;
    expect(brief).toMatchObject({ version: 3, rules: "The rules", summary: "The summary", change: "restore_version" });
    db.close();
  });

  it("refuses unknown versions, bad bounds and writes on an ended project", () => {
    const db = freshDb();
    expect(patchProjectBrief(db, { groupId: "grp", expectedVersion: 1, restoreVersion: 9, now: NOW })).toMatchObject({ ok: false, error: "invalid" });
    expect(patchProjectBrief(db, { groupId: "grp", expectedVersion: 1, rules: "r".repeat(12001), now: NOW })).toMatchObject({ ok: false, error: "invalid" });
    expect(patchProjectBrief(db, { groupId: "grp", expectedVersion: 1, summary: "s".repeat(201), now: NOW })).toMatchObject({ ok: false, error: "invalid" });
    expect(patchProjectBrief(db, { groupId: "grp", expectedVersion: 1, doneMeans: "d".repeat(4001), now: NOW })).toMatchObject({ ok: false, error: "invalid" });
    db.prepare("UPDATE project_settings SET ended_at=? WHERE group_id='grp'").run(NOW);
    expect(patchProjectBrief(db, { groupId: "grp", expectedVersion: 1, rules: "x", now: NOW })).toMatchObject({ ok: false, error: "not_allowed" });
    db.close();
  });

  it("keeps at most 200 versions, never deleting version 1", () => {
    const db = freshDb();
    for (let v = 1; v <= 205; v++) {
      const current = currentProjectBrief(db, "grp")!;
      const result = patchProjectBrief(db, { groupId: "grp", expectedVersion: current.version, summary: `v${v + 1}`, now: NOW + v });
      expect(result.ok).toBe(true);
    }
    expect(currentProjectBrief(db, "grp")!.version).toBe(206);
    expect(projectBriefVersion(db, "grp", 1)).not.toBeNull();
    const count = (db.prepare("SELECT COUNT(*) AS n FROM project_briefs WHERE group_id='grp'").get() as { n: number }).n;
    expect(count).toBe(200);
    db.close();
  });
});

describe("leadProjectBriefUpdate (11.3 brief-update)", () => {
  it("appends a decision with sources and never touches owner rules", () => {
    const db = freshDb();
    const result = leadProjectBriefUpdate(db, { groupId: "grp", leadBotId: "lead", decision: "Chose the simpler schema", sourceMessageIds: ["m1"], now: NOW + 1 });
    expect(result.ok).toBe(true);
    const brief = currentProjectBrief(db, "grp")!;
    expect(brief.version).toBe(2);
    expect(brief.rules).toBe("The rules"); // owner rules unchanged
    expect(brief.decisions[0]).toMatchObject({ text: "Chose the simpler schema", by: "lead", sourceMessageIds: ["m1"] });
    expect(brief.change).toBe("lead_decision");
    db.close();
  });

  it("appends a where-the-work-is note; a bot note without sources is refused", () => {
    const db = freshDb();
    const noSources = leadProjectBriefUpdate(db, { groupId: "grp", leadBotId: "lead", note: { text: "Work is in the repo" }, sourceMessageIds: [], now: NOW + 1 });
    expect(noSources).toMatchObject({ ok: false, error: "invalid" });
    const noted = leadProjectBriefUpdate(db, { groupId: "grp", leadBotId: "lead", note: { text: "Work is in the repo", path: "/repo" }, sourceMessageIds: ["m2"], now: NOW + 1 });
    expect(noted.ok).toBe(true);
    const brief = currentProjectBrief(db, "grp")!;
    expect(brief.whereWorkIs[0]).toMatchObject({ text: "Work is in the repo", path: "/repo", by: "lead" });
    expect(brief.change).toBe("lead_note");
    db.close();
  });

  it("refuses a call that is neither a decision nor a note, and bounds the text", () => {
    const db = freshDb();
    expect(leadProjectBriefUpdate(db, { groupId: "grp", leadBotId: "lead", sourceMessageIds: ["m1"], now: NOW })).toMatchObject({ ok: false, error: "invalid" });
    expect(leadProjectBriefUpdate(db, { groupId: "grp", leadBotId: "lead", decision: "d".repeat(501), sourceMessageIds: ["m1"], now: NOW })).toMatchObject({ ok: false, error: "invalid" });
    db.close();
  });
});
