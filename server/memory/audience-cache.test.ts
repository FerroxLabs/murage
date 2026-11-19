// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { Store } from "../store.ts";
import { teamIdFor } from "../team-identities.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { audienceCacheCounters, audienceStamp } from "./audience-cache.ts";
import { backgroundMemoryScopes, ensureScope, reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => closeDatabase());

function world(project = false) {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const bot = store.createBot({ name: "Worker", section: "Home" }, { seedMessages: false });
  const member = store.createBot({ name: "Member", section: "Shared" }, { seedMessages: false });
  const team = teamIdFor("Shared");
  store.patchBot(bot.id, { partitionedAt: 1, sharedWith: { mode: "list", teams: [{ id: team, name: "Shared" }] } });
  const work = store.createSharedWorkTask(bot.id, team)!;
  const room = store.createGroup("Project", [bot.id, member.id], false, "Shared");
  if (project) database().prepare("INSERT INTO project_settings(group_id,updated_at) VALUES(?,1)").run(room.id);
  reconcileMemoryRoster(store); setMemoryMode("active");
  const thread = project ? room.threadId : work.threadId;
  const retired = ensureScope(project ? "bot" : "team", project ? `${bot.id}#project:${room.id}` : "Shared");
  const read = () => backgroundMemoryScopes(bot.id, thread, store);
  // A roster without a revision always computes the legacy answer afresh.
  const fresh = () => backgroundMemoryScopes(bot.id, thread, { bots: store.bots, groups: store.groups });
  const warm = () => {
    read(); const first = read(), before = audienceCacheCounters();
    expect(first).toContain(retired);
    expect(read()).toBe(first);
    expect(audienceCacheCounters().hits).toBe(before.hits + 1);
    return store.memoryRosterRevision;
  };
  return { store, team, room, retired, read, fresh, warm };
}

for (const connection of ["same", "other"] as const) {
  it.each(["retire", "memory key"] as const)(`drops a team's old scope after %s on the ${connection} connection`, change => {
    const f = world(), revision = f.warm();
    const writer = connection === "same" ? database() : new DatabaseSync(join(DATA_DIR, "messages.db"));
    try {
      writer.prepare(change === "retire" ? "UPDATE team_identities SET retired_at=1 WHERE team_id=?"
        : "UPDATE team_identities SET memory_key='Renamed' WHERE team_id=?").run(f.team);
    } finally { if (connection === "other") writer.close(); }
    const next = f.read();
    expect(next).not.toContain(f.retired);
    expect([...next].sort()).toEqual([...f.fresh()].sort());
    expect(f.store.memoryRosterRevision).toBe(revision);
  });

  it.each(["delete", "move"] as const)(`drops a project partition after settings %s on the ${connection} connection`, change => {
    const f = world(true), revision = f.warm();
    const writer = connection === "same" ? database() : new DatabaseSync(join(DATA_DIR, "messages.db"));
    try {
      writer.prepare(change === "delete" ? "DELETE FROM project_settings WHERE group_id=?"
        : "UPDATE project_settings SET group_id='other-project' WHERE group_id=?").run(f.room.id);
    } finally { if (connection === "other") writer.close(); }
    const next = f.read();
    expect(next).not.toContain(f.retired);
    expect([...next].sort()).toEqual([...f.fresh()].sort());
    expect(f.store.memoryRosterRevision).toBe(revision);
  });
}

it.each(["team_identities", "project_settings"] as const)("invalidates on every same-connection row event in %s", table => {
  const db = database(), roster = { memoryRosterRevision: 1, bots: [], groups: [] };
  let stamp = audienceStamp(db, roster);
  expect(stamp).toBeTypeOf("string");
  const statements = table === "team_identities" ? [
    "INSERT INTO team_identities(team_id,label,created_at,updated_at) VALUES('fixture-team','Fixture',1,1)",
    "UPDATE team_identities SET label='Changed' WHERE team_id='fixture-team'",
    "INSERT OR REPLACE INTO team_identities(team_id,label,created_at,updated_at) VALUES('fixture-team','Fixture',1,1)",
    "DELETE FROM team_identities WHERE team_id='fixture-team'",
  ] : [
    "INSERT INTO project_settings(group_id,updated_at) VALUES('fixture-project',1)",
    "UPDATE project_settings SET group_id='changed-project' WHERE group_id='fixture-project'",
    "INSERT OR REPLACE INTO project_settings(group_id,updated_at) VALUES('changed-project',1)",
    "DELETE FROM project_settings WHERE group_id='changed-project'",
  ];
  for (const sql of statements) {
    db.exec(sql);
    const next = audienceStamp(db, roster);
    expect(next).toBeTypeOf("string"); expect(next).not.toBe(stamp); stamp = next;
  }
});

it("never reuses a transactional partition answer after rollback", () => {
  const f = world(); f.warm(); const db = database();
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE team_identities SET retired_at=1 WHERE team_id=?").run(f.team);
    expect(f.read()).not.toContain(f.retired);
  } finally { db.exec("ROLLBACK"); }
  expect(f.read()).toContain(f.retired);
  db.prepare("UPDATE team_identities SET memory_key='Renamed' WHERE team_id=?").run(f.team);
  expect(f.read()).not.toContain(f.retired);
});
