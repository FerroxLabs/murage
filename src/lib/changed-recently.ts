// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings v10 J1: the rows of "Changed recently" from the journal (core J0, shared/settings-v10/journal.ts). Pure view
// model: who changed it, what it was and is (never a secret), and whether Set back is offered. Set back is the one
// shipped write path of a single-field instant save, sent through the server compare-and-set; this file only decides
// whether the button exists. Never No limits, never a removal, never a form, and never once the value moved on.
import type { JournalActor, JournalRow } from "../../shared/settings-v10/journal";

/** What the writer table says about a row beyond the contract's fields (core J0 supplies them with each row). */
export interface ChangedRecentlyRow extends JournalRow {
  /** Only "field" (a single-field instant save) can be set back. */
  shape?: "field" | "form" | "removal" | "noLimits";
  /** A model change Murage made itself, and why. */
  reason?: string;
  /** The first change cleared this bot's saved app choices. */
  clearedAppChoices?: boolean;
  /** The kind of value, for the Set back wording. */
  valueKind?: "model" | "other";
  secret?: boolean;
}

export interface ChangedRecentlyView {
  changeId: string;
  settingId: string;
  at: number;
  who: string;
  /** Plain words, never a secret value; null when the value is not recorded. */
  was: string | null;
  now: string | null;
  note: string | null;
  setBack: { available: boolean; says: string | null };
}

const SECRET_KEY = /(secret|token|password|passphrase|api[-_ ]?key|credential|recovery[-_ ]?key|bearer)/i;
const SHOWN_MAX = 80;

/** Who, in words. A bot is named by `botName`; a program Murage cannot name reads "Another program". */
export function whoChanged(actor: JournalActor, botName: (id: string) => string | null): string {
  switch (actor.kind) {
    case "owner": return "You";
    case "bot": return botName(actor.botId) ?? "A bot";
    case "murage": return "Murage";
    case "otherProgram": return actor.name?.trim() ? actor.name.trim().slice(0, 40) : "Another program";
  }
}

/** A recorded value in words. Secrets, objects and anything long read as not shown. */
export function shownValue(settingId: string, value: unknown, secret = false): string | null {
  if (secret) return null;
  if (value === undefined || value === null) return null;
  if (SECRET_KEY.test(settingId)) return null;
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "string") return value.length > 0 && value.length <= SHOWN_MAX && !SECRET_KEY.test(value) ? value : null;
  return null;
}

/** Set back exists only for a single-field instant save whose value is still the one it wrote. */
export function setBackFor(row: ChangedRecentlyRow, currentValue: unknown): ChangedRecentlyView["setBack"] {
  const none = { available: false, says: null };
  if (row.secret || SECRET_KEY.test(row.settingId)) return none;
  if (row.shape !== "field") return none;
  if (row.before === "noLimits" || row.after === "noLimits") return none;
  if (row.after === undefined) return none;
  if (row.before === undefined) return none;
  if (row.actor.kind === "murage" && row.reason === undefined) return none;
  if (currentValue !== row.after) return none;
  const says = row.valueKind === "model"
    ? "This changes the model again. App choices cleared by the first change do not come back."
    : null;
  return { available: true, says };
}

export function changedRecentlyView(
  rows: readonly ChangedRecentlyRow[],
  ctx: { botName: (id: string) => string | null; current: (settingId: string, bot?: string) => unknown },
  limit = 20,
): ChangedRecentlyView[] {
  return [...rows]
    .sort((a, b) => b.at - a.at)
    .slice(0, limit)
    .map((row) => ({
      changeId: row.changeId,
      settingId: row.settingId,
      at: row.at,
      who: whoChanged(row.actor, ctx.botName),
      was: shownValue(row.settingId, row.before, row.secret),
      now: shownValue(row.settingId, row.after, row.secret),
      note: row.actor.kind === "murage"
        ? [row.reason, row.clearedAppChoices ? "App choices cleared" : null].filter(Boolean).join(". ") || null
        : row.clearedAppChoices ? "App choices cleared" : null,
      setBack: setBackFor(row, ctx.current(row.settingId, row.bot)),
    }));
}
