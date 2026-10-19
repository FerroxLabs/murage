// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one definition of a Murage-voice row (LINEAGE-DESIGN-S6 rule 1): a row Murage writes in its own voice, never a turn's engine. It is
// stamped with the murage-line.ts marker, carries actorKind "murage" or a `murage` offer, or is a lifecycle card (routine.run, goal.run).
// isEngineOutput (message-db.ts) and every reader (the reader door, bot-read.ts) call this; a legacy row classifies by its stored JSON, so
// nothing is backfilled. A bot never reads such a row's words: the door shows it only as its fixed-copy projection, or not at all.

/** Murage's own kinds of row: a routine's lifecycle card and a team goal's receipt. */
export const MURAGE_KINDS: ReadonlySet<string> = new Set(["routine.run", "goal.run"]);

/** Whether a stored or in-memory row (its parsed JSON) is Murage-voice. Pure; any shape is accepted and judged by its fields. */
export function isMurageVoice(json: unknown): boolean {
  if (!json || typeof json !== "object") return false;
  const row = json as { murageLine?: unknown; actorKind?: unknown; murage?: unknown; kind?: unknown };
  if (row.murageLine === true) return true;
  if (row.actorKind === "murage") return true;
  if (row.murage !== undefined && row.murage !== null && row.murage !== false) return true;
  return typeof row.kind === "string" && MURAGE_KINDS.has(row.kind);
}

/** isMurageVoice as one SQL predicate over a `messages` row (alias `m`), for a reader that filters in the query (a bot's search). It hides
 * at least every row isMurageVoice hides: each of the four tests is read both as JavaScript types it (murage present and neither null nor
 * false, so 0 and "" count) and loosely (murageLine 1, the row's kind column as well as its stored kind), so it hides every row the
 * earlier forms hid. The search door still runs isMurageVoice on each row it keeps. Never NULL, so NOT of it is a verdict. The rule 23 and
 * 24 anchor checks do not use it: both judge with murageAnchor (murage-anchor.ts). */
export function murageVoiceSql(alias: string): string {
  const kinds = [...MURAGE_KINDS].map(kind => `'${kind}'`).join(",");
  return `(COALESCE(json_extract(${alias}.json,'$.murageLine'),0) = 1 OR COALESCE(json_extract(${alias}.json,'$.actorKind'),'') = 'murage'`
    + ` OR COALESCE(json_extract(${alias}.json,'$.murage'),0) <> 0 OR COALESCE(json_type(${alias}.json,'$.murage'),'null') NOT IN ('null','false')`
    + ` OR ${alias}.kind IN (${kinds}) OR COALESCE(json_extract(${alias}.json,'$.kind'),'') IN (${kinds}))`;
}
