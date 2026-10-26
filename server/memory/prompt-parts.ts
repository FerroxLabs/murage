// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Write-time privacy: the only way to make engine input and tool results (DESIGN-WRITETIME 2, Enforcement (a)). The casts to PromptPart,
// BuiltPrompt and ToolText live here and nowhere else (lineage-sinks.test.ts fails on any such cast in another file). S2 owns this file.
//
// What is tracked, and what is not:
//  - every part of engine input (promptPart / buildPrompt) and every Murage tool result (toolText / turnToolText) names what it rests on;
//    assembling a BuiltPrompt, or returning a tool result inside a turn, adds those refs to the running turn (addTurnParents), so the
//    reply, the session and every note or record the turn writes carry them (lineage-write.ts, S1);
//  - files read or written through Murage's own tools (skills, artifacts, reference packs, published sites) are tracked like messages:
//    a file a bot writes in a turn gets the turn's lineage (recordTurnObject), and a file Murage hands back carries its ref (fileRef);
//  - engine-native file access (an engine's own read/write/edit tools on the workspace, a shell, an MCP server Murage does not run) is
//    outside Murage's sight: Murage never sees those bytes, so it cannot carry them. What Murage can see is the turn itself: a file a
//    bot writes with its own tools rests on the turn that wrote it, and the turn's reply already carries every part it was shown.
import type { DatabaseSync } from "node:sqlite";
import { addTurnParents, currentTurnLineage, runningTurnFor, turnOwnGenerations, writeRecordLineage } from "./lineage-write.ts";
import { denyGeneration, fenceUnchanged, fenceVerdict, generationUnchanged } from "./deny-read.ts";
import type { BuiltPrompt, LineageReader, LineageRef, LineageVerdict, MemoryRef, MemoryRefKind, NoneReason, PromptPart, ToolText, TurnLineage } from "./lineage-types.ts";

/** One part of engine input and what it rests on (line keys, prefixes, memory refs, receipts, or none(reason)). */
export function promptPart(text: string, lineageOf: readonly LineageRef[]): PromptPart {
  return Object.freeze({ text, lineageOf: Object.freeze([...lineageOf]) }) as PromptPart;
}

/** A tool handler's result and what it rests on. */
export function toolText(text: string, lineageOf: readonly LineageRef[]): ToolText {
  return Object.freeze({ text, lineageOf: Object.freeze([...lineageOf]) }) as ToolText;
}

/** The engine input of a send or steer: the parts joined in order; every part's refs join the running turn (none outside a turn). */
export function buildPrompt(turn: TurnLineage | undefined, parts: readonly PromptPart[], separator = "\n\n"): BuiltPrompt {
  if (turn) addTurnParents(turn, parts.flatMap(part => part.lineageOf));
  return Object.freeze({ text: parts.map(part => part.text).join(separator), parts: Object.freeze([...parts]), denyGeneration: turn?.denyGeneration ?? -1, ...(turn ? { ownGenerations: (db: DatabaseSync, above: number, upTo: number) => turnOwnGenerations(db, turn, above, upTo) } : {}) }) as BuiltPrompt;
}

// ── refs ─────────────────────────────────────────────────────────────────────

/** Point carries for stored lines of one thread (a quote, a replayed or owed line, a line a tool returned). */
/** The lines of its own thread a prompt shows in words, which its prefix part names so the send fence asks their marks again: the replayed
 * entries rendered in words AND every other line of the thread the prompt quotes (the explicit reply target, an excerpt inside a quoting
 * entry), replay or not (a resumed session is not replayed, yet its prompt still quotes the reply target). A withheld line is not named. */
export function ownShownLineIds(threadId: string, inWords: Iterable<string>, shown: readonly { readonly threadId: string; readonly id: string }[], withheld: ReadonlySet<string>): string[] {
  const out = new Set(inWords);
  for (const line of shown) if (line.threadId === threadId && line.id && !withheld.has(line.id)) out.add(line.id);
  return [...out];
}
export function lineRefs(threadId: string, messageIds: Iterable<string>): LineageRef[] {
  const refs: LineageRef[] = [];
  for (const messageId of new Set(messageIds)) refs.push({ kind: "line", threadId, messageId });
  return refs;
}
/** The lines of the prompt's own thread its replay shows in words, named one by one (the last rebuild, which reads no prefix): judged by content
 * at the send fence, as a prefix's shown lines are (deny-read.ts refsLookup). Only for the prompt's own thread. */
export function ownReplayRefs(threadId: string, messageIds: Iterable<string>): LineageRef[] {
  const refs: LineageRef[] = [];
  for (const messageId of new Set(messageIds)) refs.push({ kind: "line", threadId, messageId, replay: true });
  return refs;
}
/** A line a prompt shows, as the turn builds collect them (steer-lineage.ts ShownLine). */
export type PromptShownLine = { readonly threadId: string; readonly id: string; readonly copyOf?: { readonly threadId: string; readonly messageIds: readonly string[] }; readonly quoted?: boolean };
/** Write-time lineage (DESIGN-WRITETIME 2.2): the lines of OTHER threads a turn's context showed in words, any role, as point carries for its
 * replies and session (same-thread context is positional). A line the renderer replaced by its withheld line carried no words, so it is no
 * parent (inheriting its mark would withhold a reply that never saw it); a quote rendered in full counts whatever a replay withheld.
 * `ownByContent`: the prompt's own thread is read by content at the send fence (an owner-only room's prefix `content: true`). The originals
 * of a copy one of its OWN rows carries are then judged by content as that row is (copyOfShown); every other ref keeps the fence's reader.
 * `emitted`: the own rows the renderer actually wrote into the prompt in words (index.ts renderRoomContext). Only those rows' originals carry
 * the flag (Astra design review A2): a row the renderer trimmed (its window, its budget) showed no words, so its originals stay judged for
 * the fence's reader, as today. Without it no original carries the flag (fail closed). */
export function crossThreadLineageRefs(threadId: string, shown: ReadonlyArray<PromptShownLine>, withheldIds: ReadonlySet<string>, ownByContent = false, emitted?: ReadonlySet<string>): LineageRef[] {
  const refs: LineageRef[] = [];
  for (const line of shown) {
    if (line.threadId === threadId && withheldIds.has(line.id) && !line.quoted) continue;
    if (line.threadId !== threadId) refs.push({ kind: "line", threadId: line.threadId, messageId: line.id });
    if (line.copyOf && line.copyOf.threadId !== threadId) {
      const byContent = ownByContent && line.threadId === threadId && !line.quoted && emitted !== undefined && emitted.has(line.id);
      for (const id of line.copyOf.messageIds) refs.push(byContent ? { kind: "line", threadId: line.copyOf.threadId, messageId: id, copyOfShown: true } : { kind: "line", threadId: line.copyOf.threadId, messageId: id });
    }
  }
  return refs;
}
/** Text that stands on nothing stored (Murage's own words, fixed copy). */
export const noneRef = (reason: NoneReason): LineageRef => ({ kind: "none", reason });

/** Murage objects that are not memory records but hold words a bot wrote in a turn: a teammate's note on a card, a card, a project
 * summary, a member's suggestion, a learned skill, a file written or read through a Murage tool. Each is a MemoryRef of its own kind
 * (lineage-types.ts MEMORY_REF_KINDS: note, card, summary, skill, file): deny_memory, the frontier and memoryLookup key on (kind, id,
 * version), so a revoke reaches it through the carry its writer's turn left, and its readers ask memoryLookup. A suggestion is a note. */
export type MurageObjectKind = "project-note" | "project-card" | "project-summary" | "project-suggestion" | "skill" | "file";
const OBJECT_KIND: Record<MurageObjectKind, MemoryRefKind> = {
  "project-note": "note", "project-suggestion": "note", "project-card": "card", "project-summary": "summary", skill: "skill", file: "file",
};
export function murageObjectRef(kind: MurageObjectKind, id: string, scopeId?: string): MemoryRef {
  return { kind: OBJECT_KIND[kind], id: kind === "project-suggestion" ? `suggestion:${id}` : id, ...(scopeId ? { scopeId } : {}) };
}
/** A file read or written through a Murage tool, by owner (a bot id) and workspace-relative path: every version of the path is one object,
 * so a revoke of what a bot wrote reaches whatever it later wrote over it. */
export function fileRef(ownerId: string, path: string): MemoryRef {
  return murageObjectRef("file", `${ownerId}:${path}`);
}
export const memoryRefs = (refs: readonly MemoryRef[]): LineageRef[] => refs.map(ref => ({ kind: "memory", ref }));

// ── tool results inside a turn ───────────────────────────────────────────────

/** A Murage tool's result for the turn running on `consumingThreadId`: its refs join that turn (DESIGN-WRITETIME 2.2, tool results).
 * A tool called outside any turn (the owner's UI) records nothing. */
export function turnToolText(consumingThreadId: string | undefined, text: string, lineageOf: readonly LineageRef[]): ToolText {
  const tool = toolText(text, lineageOf);
  const turn = consumingThreadId ? currentTurnLineage(consumingThreadId) : undefined;
  if (turn && tool.lineageOf.length) addTurnParents(turn, tool.lineageOf);
  return tool;
}

/** A Murage object a bot wrote in the turn running on `writerThreadId` (a note, a card, a summary, a suggestion, a skill, a file): a
 * prefix carry from the turn (lineage-write.ts writeRecordLineage). Returns the turn it was recorded under, or undefined outside a turn
 * (then nothing is recorded, and readers keep their existing gate for the object). */
export function recordTurnObject(db: DatabaseSync, writerThreadId: string | undefined, ref: MemoryRef, writerBotId?: string): TurnLineage | undefined {
  // a room thread can hold one open turn per member: the writer's own when it is known (lineage-write.ts runningTurnFor merges them otherwise)
  const turn = !writerThreadId ? undefined : writerBotId ? runningTurnFor(writerThreadId, writerBotId) : currentTurnLineage(writerThreadId);
  if (turn) writeRecordLineage(db, ref, turn);
  return turn;
}

/** The refs of what a turn rests on, for an object kept in process (a member's suggestion): the turn's prefix plus every carried parent.
 * Empty outside a turn. */
export function turnRefs(turn: TurnLineage | undefined): LineageRef[] {
  return turn ? [{ kind: "prefix", threadId: turn.threadId, headLsn: turn.turnLsn }, ...turn.parents] : [];
}

// ── the send fence ───────────────────────────────────────────────────────────

/** The fence a driver submission or steer runs right before its write (DESIGN-WRITETIME 3, "Prompt vs send race"): shown when nothing
 * was revoked since the prompt was built; otherwise the parts are looked up again (fenceVerdict). An unknown generation (-1, a prompt
 * built outside a turn or a meta row that cannot be read) is never taken as "unchanged". */
export function sendFence(db: DatabaseSync, built: BuiltPrompt, reader: LineageReader): LineageVerdict {
  try {
    const now = denyGeneration(db);
    if (generationUnchanged(db, built, now)) return fenceUnchanged(db, built, reader);
    return fenceVerdict(db, built, reader);
  } catch { return { state: "checking", reason: "lookup-error" }; }
}
