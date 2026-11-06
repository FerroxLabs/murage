// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// U22 G20: the ONE rule for a limit backup engine. Every path that offers, saves, restores or
// starts a backup (the PUT, the card, the automatic failover, the routine backup, restart recovery,
// a later turn on an applied failover, the dispatch boundary, the backup picker) asks this gate at
// the moment of use, after its last await. Design: designs/U22-HIDDEN-BACKUP-CHOKEPOINT.md rev 2.
// Pure: the deps read live state on every call, so a check after an await sees a hide.

import type { ModelSelection } from "./contracts.ts";
import type { RouteVerdict } from "./turn-selection.ts";

export type BackupRefusal = "hidden" | "removed" | "route" | "billing" | "limit";
export type BackupVerdict = { ok: true } | { ok: false; reason: BackupRefusal };

export interface BackupGateDeps {
  hidden(instanceId: string): boolean;
  registered(instanceId: string): boolean;
  routes(selection: ModelSelection): RouteVerdict;
  billingAllowed(from: ModelSelection, to: ModelSelection): boolean;
  atLimit(selection: ModelSelection, now: number): boolean;
}

/** The rule, in order; the first failing step names the reason. `now` omitted: the engine need not answer now (a save, or "may this chat stay on it"). */
export function backupGate(deps: BackupGateDeps): (from: ModelSelection, to: ModelSelection, now?: number) => BackupVerdict {
  return (from, to, now) => {
    if (deps.hidden(to.instanceId)) return { ok: false, reason: "hidden" };
    if (!deps.registered(to.instanceId)) return { ok: false, reason: "removed" };
    if (!deps.routes(to).ok) return { ok: false, reason: "route" };
    if (!deps.billingAllowed(from, to)) return { ok: false, reason: "billing" };
    if (now !== undefined && deps.atLimit(to, now)) return { ok: false, reason: "limit" };
    return { ok: true };
  };
}

/** One plain line per refusal, for the chat, the card answer, the PUT and the submit refusal. */
export function backupRefusalLine(reason: BackupRefusal, engine: string, from: string): string {
  switch (reason) {
    case "hidden": return `${engine} is hidden in Settings, so it did not take over. Unhide it or pick another backup.`;
    case "removed": return `${engine} is no longer set up, so it did not take over. Pick another backup.`;
    case "route": return `${engine} cannot run right now, so it did not take over. Check it in Settings.`;
    case "billing": return `${engine} shares a limit with ${from}, so it did not take over. Pick an engine with its own limit.`;
    case "limit": return `${engine} is at its own limit, so it did not take over.`;
  }
}

/** A dispatch-boundary refusal of a limit backup. Its message is the owner's line, carried through a late settlement too (Codex and ACP
 * can refuse at a write after they handed the turn id back; the settlement then shows this line, not a generic one). */
export class BackupRefusedError extends Error {
  readonly reason: BackupRefusal;
  constructor(reason: BackupRefusal, line: string) { super(line); this.name = "BackupRefusedError"; this.reason = reason; }
}

/** The owner's line when a backup refusal is what refused the submission. */
export function backupRefusalMessage(refusal: unknown): string | undefined {
  return refusal instanceof BackupRefusedError ? refusal.message : undefined;
}

/** #11/#12: the dispatch boundary gates the backup the turn was RESOLVED onto, against the engine it stands in for (`backupFrom`, carried
 * by value from the resolver). Nothing is re-read from the chat, so a /use-fuigo or a DELETE during setup cannot take the check away.
 * No `backupFrom`: the turn is on the bot's own engine or the chat's own pick, not a backup. */
export function assertBackupAtDispatch(
  gate: (from: ModelSelection, to: ModelSelection, now?: number) => BackupVerdict,
  backupFrom: ModelSelection | undefined,
  selection: ModelSelection,
  now: number,
  line: (reason: BackupRefusal, from: ModelSelection, to: ModelSelection) => string,
): void {
  if (!backupFrom) return;
  const verdict = gate(backupFrom, selection, now);
  if (!verdict.ok) throw new BackupRefusedError(verdict.reason, line(verdict.reason, backupFrom, selection));
}

/** #4/#13: a list built across an await is cut again once the await resolves, so an engine hidden or removed meanwhile is never offered. */
export async function keptAfter<T>(pending: Promise<readonly T[]>, keep: (item: T) => boolean): Promise<T[]> {
  const listed = await pending;
  return listed.filter(keep);
}
