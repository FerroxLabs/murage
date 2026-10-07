// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { database } from "./database.ts";

export function initializeTeamIdentityTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS team_identities (
    team_id TEXT PRIMARY KEY NOT NULL,
    label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 60),
    created_at INTEGER NOT NULL,
    retired_at INTEGER,
    op TEXT CHECK(op IS NULL OR op IN ('rename','delete')),
    op_label TEXT CHECK(op_label IS NULL OR length(op_label) BETWEEN 1 AND 200),
    op_choice TEXT CHECK(op_choice IS NULL OR op_choice IN ('keep','archive')),
    op_phase INTEGER CHECK(op_phase IS NULL OR op_phase BETWEEN 1 AND 6),
    op_records TEXT CHECK(op_records IS NULL OR json_valid(op_records)),
    op_since INTEGER,
    memory_key TEXT CHECK(memory_key IS NULL OR length(memory_key) BETWEEN 1 AND 200),
    updated_at INTEGER NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS team_identities_live_label ON team_identities(label) WHERE retired_at IS NULL;`);
}

export function parseTeamOpRecords(raw: string): { bots: string[]; groups: string[] } {
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== "bots,groups"
    || ![value.bots, value.groups].every(ids => Array.isArray(ids) && ids.every(id => typeof id === "string" && /^[\w-]+$/.test(id)) && new Set(ids).size === ids.length)) throw new Error("Invalid team journal records");
  return value;
}

export function teamIdFor(label: string, db = database()): string {
  label = label.trim();
  if (!label || label.length > 60) throw new Error("Invalid team label");
  if (db.prepare("SELECT 1 FROM team_identities WHERE op IS NOT NULL LIMIT 1").get()) throw new Error("A team change is still finishing. Try again in a moment.");
  const now = Date.now();
  db.prepare("INSERT INTO team_identities(team_id,label,created_at,memory_key,updated_at) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING").run(randomUUID(), label, now, label, now);
  return String(db.prepare("SELECT team_id FROM team_identities WHERE label=? AND retired_at IS NULL").get(label)!.team_id);
}
/** A work thread's title as the sidebar and the task switcher show it
 * (SPEC-X 13.2): "Iris · work for Sales". A rename of the bot or the team
 * retitles a thread that still carries the old one. */
export const workThreadTitle = (name: string, team: string): string => `${name} · work for ${team}`;
export function teamLabel(teamId: string, db = database()): string | null {
  const row = db.prepare("SELECT label,retired_at FROM team_identities WHERE team_id=?").get(teamId);
  return row ? String(row.label) + (row.retired_at === null ? "" : " (deleted)") : null;
}
/** A live team's label; null for an unknown or retired team. */
export function liveTeamLabel(teamId: string, db = database()): string | null {
  const row = db.prepare("SELECT label FROM team_identities WHERE team_id=? AND retired_at IS NULL").get(teamId);
  return row ? String(row.label) : null;
}
export function teamMemoryKey(teamId: string, db = database()): string | null {
  const row = db.prepare("SELECT memory_key FROM team_identities WHERE team_id=? AND retired_at IS NULL").get(teamId);
  return typeof row?.memory_key === "string" ? row.memory_key : null;
}

export const TEAM_JOURNAL = Symbol("team-journal");
export function teamChangeOpen(db = database()): boolean { return !!db.prepare("SELECT 1 FROM team_identities WHERE op IS NOT NULL LIMIT 1").get(); }
export const TEAM_RENAME_STALLED = "A team rename could not finish. Rename it again.";
const stalledRenames = new Set<string>();
/** A rename journal recovery refused to continue (V5 both-present): the owner retries it. */
export function markTeamRenameStalled(teamId: string, stalled: boolean): void { if (stalled) stalledRenames.add(teamId); else stalledRenames.delete(teamId); }
export function teamRenameStalled(label: string, db = database()): boolean {
  const row = db.prepare("SELECT team_id FROM team_identities WHERE op='rename' AND label=? AND retired_at IS NULL").get(label.trim());
  return !!row && stalledRenames.has(String(row.team_id));
}
export function assertSectionUnlocked(): void {
  if (!teamChangeOpen()) { stalledRenames.clear(); return; }
  throw Object.assign(new Error(stalledRenames.size ? TEAM_RENAME_STALLED : "A team change is still finishing. Try again in a moment."), { status: 409 });
}
export function assertHomeMove(bot: {name:string;section?:string;partitionedAt?:number}, section: string | undefined):void {
  if(bot.partitionedAt!==undefined&&(bot.section?.trim()??"")!==(section?.trim()??""))throw Object.assign(new Error(`${bot.name} keeps separate work for several teams, so ${bot.name}'s home team cannot change. Make a copy for the new team instead.`),{status:409});
}
