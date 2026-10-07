// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The versioned project brief (SPEC-P 3.5). Every change is a new version
// (copy-on-write); the current brief is the highest version; versions are
// never deleted except by group deletion and the 200-version cap.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  currentProjectBrief,
  insertProjectActivity,
  insertProjectBriefVersion,
  projectBriefVersion,
  projectSettingsFor,
  type ProjectBrief,
  type ProjectBriefEntry,
} from "./project-records.ts";

export type BriefFailure =
  | { ok: false; error: "not_allowed"; reason: string }
  | { ok: false; error: "invalid"; reason: string }
  | { ok: false; error: "not_found"; reason: string }
  | { ok: false; error: "changed"; reason: string; brief: ProjectBrief };

export type BriefOutcome = { ok: true; brief: ProjectBrief } | BriefFailure;

const invalid = (reason: string): BriefFailure => ({ ok: false, error: "invalid", reason });

function briefContext(db: DatabaseSync, groupId: string): { current: ProjectBrief } | BriefFailure {
  const settings = projectSettingsFor(db, groupId);
  if (!settings) return { ok: false, error: "not_found", reason: "Not a project." };
  if (settings.endedAt !== null) return { ok: false, error: "not_allowed", reason: "This is a channel now." };
  if (settings.closedAt !== null) return { ok: false, error: "not_allowed", reason: "This project is closed." };
  const current = currentProjectBrief(db, groupId);
  if (!current) return { ok: false, error: "not_found", reason: "Not a project." };
  return { current };
}

/** Inherited lineage kept on a brief entry (projectRequestSourceMessages caps at 50). */
export const BRIEF_LINEAGE_SOURCES_MAX = 50;

function checkEntry(entry: unknown): ProjectBriefEntry | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const value = entry as Record<string, unknown>;
  if (typeof value.text !== "string" || value.text.trim().length < 1 || value.text.length > 500) return null;
  if (value.path !== undefined && (typeof value.path !== "string" || value.path.length > 512)) return null;
  if (typeof value.by !== "string" || typeof value.at !== "number") return null;
  if (value.sourceMessageIds !== undefined && (!Array.isArray(value.sourceMessageIds) || value.sourceMessageIds.length > 20)) return null;
  if (value.lineageSourceMessageIds !== undefined && (!Array.isArray(value.lineageSourceMessageIds) || value.lineageSourceMessageIds.length > BRIEF_LINEAGE_SOURCES_MAX || value.lineageSourceMessageIds.some(id => typeof id !== "string"))) return null;
  return value as unknown as ProjectBriefEntry;
}

/** O: the brief PATCH (11.1). A new version carries the changed fields and
 * keeps the rest; `restoreVersion` copies that version's content as a new
 * version with change `restore_version`. */
export function patchProjectBrief(
  db: DatabaseSync,
  input: {
    groupId: string;
    expectedVersion: number;
    summary?: string;
    doneMeans?: string;
    rules?: string;
    whereWorkIs?: unknown[];
    restoreVersion?: number;
    now: number;
  },
): BriefOutcome {
  const context = briefContext(db, input.groupId);
  if (!("current" in context)) return context;
  const { current } = context;
  if (input.expectedVersion !== current.version) {
    return { ok: false, error: "changed", reason: "The brief changed since you read it.", brief: current };
  }
  if (input.restoreVersion !== undefined) {
    const source = projectBriefVersion(db, input.groupId, input.restoreVersion);
    if (!source) return invalid("No such brief version.");
    const brief = insertProjectBriefVersion(db, {
      groupId: input.groupId, summary: source.summary, doneMeans: source.doneMeans, rules: source.rules,
      whereWorkIs: source.whereWorkIs, decisions: source.decisions,
      updatedBy: "owner", change: "restore_version", now: input.now,
    });
    insertProjectActivity(db, { groupId: input.groupId, kind: "brief_version", actor: "owner", at: input.now, detail: { version: brief.version, change: "restore_version", from: input.restoreVersion } });
    return { ok: true, brief };
  }
  const summary = input.summary ?? current.summary;
  const doneMeans = input.doneMeans ?? current.doneMeans;
  const rules = input.rules ?? current.rules;
  if (summary.length > 200) return invalid("The summary is at most 200 characters.");
  if (doneMeans.length > 4000) return invalid("Done means is at most 4000 characters.");
  if (rules.length > 12000) return invalid("The rules are at most 12000 characters.");
  let whereWorkIs = current.whereWorkIs;
  if (input.whereWorkIs !== undefined) {
    if (input.whereWorkIs.length > 20) return invalid("At most 20 notes.");
    const checked = input.whereWorkIs.map(checkEntry);
    if (checked.some(entry => entry === null)) return invalid("A note is text of at most 500 characters with an optional path.");
    whereWorkIs = checked as ProjectBriefEntry[];
  }
  const brief = insertProjectBriefVersion(db, {
    groupId: input.groupId, summary, doneMeans, rules, whereWorkIs, decisions: current.decisions,
    updatedBy: "owner", change: "owner_edit", now: input.now,
  });
  insertProjectActivity(db, { groupId: input.groupId, kind: "brief_version", actor: "owner", at: input.now, detail: { version: brief.version, change: "owner_edit" } });
  return { ok: true, brief };
}

/** L: the lead's append-only update (11.3 brief-update): a decision or a
 * "where the work is" note, each with its source messages. Never touches
 * rules, done_means, the goal, owner criteria, budget, members, work roots
 * or work profile. */
export function leadProjectBriefUpdate(
  db: DatabaseSync,
  input: {
    groupId: string;
    leadBotId: string;
    decision?: string;
    note?: { text: string; path?: string };
    sourceMessageIds: string[];
    /** Inherited request lineage that does not fit the 20 citations. */
    lineageSourceMessageIds?: string[];
    now: number;
  },
): BriefOutcome {
  const context = briefContext(db, input.groupId);
  if (!("current" in context)) return context;
  const { current } = context;
  if (!Array.isArray(input.sourceMessageIds) || input.sourceMessageIds.length < 1 || input.sourceMessageIds.length > 20) {
    return invalid("A bot-written brief entry carries its source messages.");
  }
  const lineage = [...new Set(input.lineageSourceMessageIds ?? [])].filter(id => !input.sourceMessageIds.includes(id));
  if (lineage.length > BRIEF_LINEAGE_SOURCES_MAX) return invalid("A bot-written brief entry carries its source messages.");
  const lineageField = lineage.length ? { lineageSourceMessageIds: lineage } : {};
  const hasDecision = typeof input.decision === "string" && input.decision.trim().length > 0;
  const hasNote = input.note !== undefined && typeof input.note.text === "string" && input.note.text.trim().length > 0;
  if (hasDecision === hasNote) return invalid("Give exactly one of a decision or a note.");
  if (hasDecision && input.decision!.length > 500) return invalid("A decision is at most 500 characters.");
  if (hasNote) {
    if (input.note!.text.length > 500) return invalid("A note is at most 500 characters.");
    if (input.note!.path !== undefined && input.note!.path.length > 512) return invalid("A note path is at most 512 characters.");
  }
  const decisions = current.decisions;
  if (hasDecision) {
    decisions.push({ id: randomUUID(), text: input.decision!.trim(), by: input.leadBotId, at: input.now, sourceMessageIds: input.sourceMessageIds, ...lineageField });
    while (decisions.length > 50) decisions.shift(); // last 50 (3.5)
  }
  const whereWorkIs = current.whereWorkIs;
  if (hasNote) {
    whereWorkIs.push({
      text: input.note!.text.trim(), ...(input.note!.path !== undefined ? { path: input.note!.path } : {}),
      by: input.leadBotId, at: input.now, sourceMessageIds: input.sourceMessageIds, ...lineageField,
    });
    while (whereWorkIs.length > 20) whereWorkIs.shift();
  }
  const brief = insertProjectBriefVersion(db, {
    groupId: input.groupId, summary: current.summary, doneMeans: current.doneMeans, rules: current.rules,
    whereWorkIs, decisions,
    updatedBy: input.leadBotId, change: hasDecision ? "lead_decision" : "lead_note", now: input.now,
  });
  insertProjectActivity(db, { groupId: input.groupId, kind: "brief_version", actor: input.leadBotId, at: input.now, detail: { version: brief.version, change: brief.change } });
  return { ok: true, brief };
}
