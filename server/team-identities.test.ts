// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { initializeTeamIdentityTables, teamIdFor, teamLabel, teamMemoryKey, parseTeamOpRecords } from "./team-identities.ts";
import { initializeMessageTables } from "./message-tables.ts";
import { inspectInstallationDatabase } from "./installation-database-snapshot.ts";
it("registers frozen DDL and rejects altered DDL", () => {
  const db = new DatabaseSync(":memory:"); initializeMessageTables(db); initializeTeamIdentityTables(db);
  expect(() => inspectInstallationDatabase(db)).not.toThrow();
  db.exec("ALTER TABLE team_identities ADD COLUMN surprise TEXT");
  expect(() => inspectInstallationDatabase(db)).toThrow(); db.close();
});
it("preserves returning labels until deletion retires their identity", () => {
  const db = new DatabaseSync(":memory:"); initializeTeamIdentityTables(db);
  const id = teamIdFor("Sales", db); expect(teamIdFor("Sales", db)).toBe(id);
  expect(teamMemoryKey(id, db)).toBe("Sales");
  db.prepare("UPDATE team_identities SET retired_at=1 WHERE team_id=?").run(id);
  expect(teamLabel(id, db)).toBe("Sales (deleted)"); expect(teamMemoryKey(id, db)).toBeNull();
  expect(teamIdFor("Sales", db)).not.toBe(id); db.close();
});
it("blocks even existing identity lookup while any journal is open", () => {
  const db = new DatabaseSync(":memory:"); initializeTeamIdentityTables(db); teamIdFor("Sales", db);
  db.exec("UPDATE team_identities SET op='rename'"); expect(() => teamIdFor("Sales", db)).toThrow(); db.close();
});
it.each(['{}', '{"bots":[],"groups":[],"extra":1}', '{"bots":["../bad"],"groups":[]}', '{"bots":["a","a"],"groups":[]}'])("strict journal shape %s", raw => expect(() => parseTeamOpRecords(raw)).toThrow());
it("parses exact journal records", () => expect(parseTeamOpRecords('{"bots":["a"],"groups":["g"]}')).toEqual({ bots: ["a"], groups: ["g"] }));
