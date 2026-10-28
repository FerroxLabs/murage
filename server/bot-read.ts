// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The reader door (LINEAGE-DESIGN-S6 section D). Every row a bot reads passes through botRows: it classifies (murage-voice.ts, rule 1),
// shows a Murage-voice row only as its fixed-copy projection (rules 10-12), validates every copy and hand-off chain (rule 9), applies the
// transcript row check with the lineage judge (partition-sources.ts, 15a) and reads the lineage verdicts with ownFlag false (15b, 17), never
// the owner's note. It returns branded BotRow values; only a BotRow may be rendered into a prompt, a tool answer, a continuation or a cached
// summary.
//
// The viewer axis is presentation, not lineage: only { kind: "human" } (the owner's HTTP and UI routes) sees rows as stored. A bot
// answering an owner-audience turn is { kind: "bot" } and reads with full withholding. The door decides on every build; nothing it
// decides is cached across turns (rule 19).
import { emailDerivedText } from "./email/external-marks.ts";
import type { DatabaseSync } from "node:sqlite";
import type { Message } from "./store.ts";
import { isMurageVoice } from "./murage-voice.ts";
import { BOT_VISIBLE_STATUS, MurageStatus, statusFromStored } from "./murage-status.ts";
import { copyChainCheck, transcriptRowCheck } from "./partition-sources.ts";
import { executionStore } from "./execution-audience.ts";
import { lineAuthor } from "./message-db.ts";
import { withheldRoomLine } from "./room-context.ts";
import { denyLookup, lineageLive } from "./memory/deny-read.ts";
import { verdictShows, type LineageAudience, type LineageReader, type LineageVerdict } from "./memory/lineage-types.ts";
import type { LineVerdictState } from "./result-egress.ts";

/** Who reads. Only the owner's HTTP and UI routes pass the human viewer (a structural test holds the allowlist). */
export type Viewer = { readonly kind: "human" } | { readonly kind: "bot"; readonly botId: string };

declare const BOT_ROW: unique symbol;
/** A row as a reader may render it: minted only here. */
export type BotRow = {
  readonly id: string;
  readonly role: Message["role"];
  readonly speaker: { readonly id: string; readonly name: string } | undefined;
  readonly text: string;
  readonly at: number;
  readonly [BOT_ROW]: true;
};

const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const plainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const MURAGE_ROW_KINDS: ReadonlySet<string> = new Set(["failure", "status", "queue", "budget", "restore", "milestone", "result", "progress", "cap"]);

/** The one fixed-copy projection of a Murage-voice row (rule 10): the fresh words of the status the row stores (`murage.status`, rule 11),
 * rendered from the table, or nothing. Only a key in BOT_VISIBLE_STATUS (rule 14) whose kept parameters match its schema renders; the row's
 * text, tool name, card, attachments and every other stored field are never read for words. Any failed check (a legacy row without a stored
 * status, an owner-only key, malformed or extra parameters, a tampered kind) yields nothing. */
export function fixedCopy(json: unknown): string | undefined {
  const line = fixedStatus(json);
  if (!line) return undefined;
  const words = MurageStatus.words(line);
  return words.trim() ? words : undefined;
}

/** The status behind fixedCopy, for a writer that copies a Murage row on as its status (a correction's room copy, rule 16): the same checks,
 * the line rebuilt from the table, never the row's stored words. */
export function fixedStatus(json: unknown): MurageStatus | undefined {
  if (!plainObject(json) || !own(json, "murage")) return undefined;
  const murage = json.murage;
  if (!plainObject(murage) || !own(murage, "kind") || !own(murage, "status")) return undefined;
  if (typeof murage.kind !== "string" || !MURAGE_ROW_KINDS.has(murage.kind)) return undefined;
  const stored = murage.status;
  if (!plainObject(stored) || typeof stored.key !== "string" || !own(stored, "key")) return undefined;
  if (Object.keys(stored).some(name => name !== "key" && name !== "data")) return undefined;
  const key = stored.key;
  if (!(BOT_VISIBLE_STATUS as ReadonlySet<string>).has(key)) return undefined;
  const data = own(stored, "data") ? stored.data : undefined;
  if (data !== undefined && !plainObject(data)) return undefined;
  return statusFromStored(key, data);
}

/** The door's lineage reader: the caller's audience, with the owner's note never the judge (15b). */
export function doorReader(audience: LineageAudience | null = null): LineageReader {
  return { audience, ownFlag: false };
}

/** The speaker of a row: read from the bot record by from.botId, the stored name only for a bot no longer on the roster. */
function speakerOf(row: Message): BotRow["speaker"] {
  const from = row.from;
  if (!from?.botId) return undefined;
  const bot = executionStore()?.bot(from.botId);
  return { id: from.botId, name: bot?.name ?? from.name };
}

function mint(row: Message, text: string): BotRow {
  return Object.freeze({ id: row.id, role: row.role, speaker: speakerOf(row), text, at: row.at }) as BotRow;
}

/** What the door last decided for each row object it returned, per viewer: the words it admitted the row with (rule 18b). Each door pass over
 * a row replaces its viewer's entry, so a row the latest pass left out has none (rule 19: no verdict is kept past the next one). */
const DOOR_DECIDED = new WeakMap<Message, Map<string, string>>();
const viewerKey = (viewer: Viewer): string => viewer.kind === "human" ? "\u0000human" : viewer.botId;
function decided(viewer: Viewer, judged: readonly Message[], shown: ReadonlyArray<{ row: Message; text: string }>): void {
  const key = viewerKey(viewer);
  for (const row of judged) DOOR_DECIDED.get(row)?.delete(key);
  for (const { row, text } of shown) {
    let entry = DOOR_DECIDED.get(row);
    if (!entry) DOOR_DECIDED.set(row, entry = new Map());
    entry.set(key, text);
  }
}

/** The BotRow of a row the door returned to this viewer (botMessages, botWindow) on its latest pass over it; undefined for any other row.
 * A prompt line, an external update and a room line are built only from one (TranscriptEntry.source and the renderers that take a BotRow). */
export function botRowOf(row: Message, viewer: Viewer): BotRow | undefined {
  const text = DOOR_DECIDED.get(row)?.get(viewerKey(viewer));
  return text === undefined ? undefined : mint(row, text);
}

export interface BotRowsOptions {
  /** The audience of the reading turn (content checks only when absent). */
  readonly audience?: LineageAudience | null;
  /** Ids the caller already shows as their withheld line (Murage's fixed copy, naming no stored words): they pass unjudged. */
  readonly standIns?: ReadonlySet<string>;
  /** Result delivery to the owner's own chat (server/result-egress.ts): an explicit owner audience is not held by the policy/epoch watermark
   * alone, as the gate's write-time lookup reads it (deny-read.ts denyLookup). Every mark still applies. */
  readonly ownerOwnChat?: boolean;
  /** Filled by `admit` with why each judged row was or was not shown (REPLY-WITHHELD-CONTRACT R1): "shown", "withheld" (a mark, a failed
   * chain or row check, a classified row) or "checking" (a lineage verdict that could not be reached, a row that could not be judged). */
  readonly states?: Map<string, LineVerdictState>;
}

/** The bot viewer for a reading bot. */
export const botViewer = (botId: string): Viewer => ({ kind: "bot", botId });

type Admitted = { row: Message; projection?: string };

/** The most sources one row's copy and hand-off chains may name (rule 9). */
export const CHAIN_REFS = 64;
type ChainRef = { threadId: string; messageId: string };
const refKey = (ref: ChainRef): string => `${ref.threadId}\u0000${ref.messageId}`;

/** The sources a stored row names: its copy's originals and its hand-off's row. Undefined when either link is malformed. */
function chainRefs(stored: Record<string, unknown>): ChainRef[] | undefined {
  const refs: ChainRef[] = [];
  if (own(stored, "copyOf") && stored.copyOf !== undefined) {
    const copy = stored.copyOf;
    if (!plainObject(copy) || typeof copy.threadId !== "string" || !Array.isArray(copy.messageIds) || !copy.messageIds.length
      || !copy.messageIds.every((id: unknown) => typeof id === "string")) return undefined;
    for (const id of copy.messageIds as string[]) refs.push({ threadId: copy.threadId, messageId: id });
  }
  if (own(stored, "handoffOf") && stored.handoffOf !== undefined) {
    const handoff = stored.handoffOf;
    if (!plainObject(handoff) || typeof handoff.threadId !== "string" || typeof handoff.messageId !== "string") return undefined;
    refs.push({ threadId: handoff.threadId, messageId: handoff.messageId });
  }
  return refs;
}

/** Rule 9: a copy or a hand-off is validated recursively at read. Every source its `copyOf` and `handoffOf` chains name must be stored, parse,
 * be unclassified (rule 3: a copy of a Murage-voice row inherits its classification), be a bot or owner row, pass the copy chain's `lineage`
 * judge (15a) and read shown under the door's reader (15b); the chains must be acyclic and name at most CHAIN_REFS sources. One judge per
 * operation: a source judged once is not read again in it (rule 19: nothing is kept across turns). */
/** A chain judge: true when a copy or hand-off row's chain holds. After a false answer, `checking()` says whether the chain failed only on
 * unknowns (a source read "checking", a judgement that threw) and on no mark (a source gone, malformed, withheld, a cycle, a chain over
 * CHAIN_REFS, which no later check changes):
 * such a row is left out as checking, never as withheld (REPLY-WITHHELD-CONTRACT C1, R1). */
export type ChainJudge = ((row: Message) => boolean) & { checking(): boolean };
export function chainJudge(db: DatabaseSync, threadId: string, audience: LineageAudience | null, ownerOwnChat = false, present = copyChainCheck(db), live = lineageLive(db)): ChainJudge {
  // a source's verdict and how many sources its chains named (a later row that reaches it spends them too, so the bound holds for every row);
  // a failed source keeps whether it failed on a mark (hard) or only on an unknown (soft)
  const verdicts = new Map<string, { ok: boolean; size: number; hard: boolean; soft: boolean }>();
  const read = db.prepare("SELECT role,json FROM messages WHERE thread_id=? AND id=?");
  let last = { ok: true, hard: false, soft: false };
  const judge = (row: Message): boolean => {
    let budget = CHAIN_REFS;
    let hard = false, soft = false;
    // depth first; `path` holds the sources being judged, so a source that names one of them is a cycle
    const path = new Set<string>([refKey({ threadId, messageId: row.id })]);
    const sourceOk = (ref: ChainRef): boolean => {
      const key = refKey(ref);
      if (path.has(key)) { hard = true; return false; }
      const known = verdicts.get(key);
      if (known) {
        budget -= known.size;
        if (!known.ok) { hard ||= known.hard; soft ||= known.soft; }
        if (known.ok && budget < 0) hard = true;
        return known.ok && budget >= 0;
      }
      const before = budget;
      if (--budget < 0) { hard = true; return false; }
      path.add(key);
      const [outerHard, outerSoft] = [hard, soft];
      hard = false; soft = false;
      let ok = false;
      try { ok = judgeSource(ref); } catch { ok = false; soft = true; }
      path.delete(key);
      const own = { hard, soft };
      hard = outerHard || own.hard; soft = outerSoft || own.soft;
      // a chain cut by this row's bound is not that source's verdict: it is judged again where it is reached with room left
      if (budget >= 0) verdicts.set(key, { ok, size: before - budget, ...own });
      return ok;
    };
    const judgeSource = (ref: ChainRef): boolean => {
      const stored = read.get(ref.threadId, ref.messageId) as { role: unknown; json: unknown } | undefined;
      if (!stored) { hard = true; return false; }
      const json: unknown = JSON.parse(String(stored.json));
      if (!plainObject(json) || isMurageVoice(json)) { hard = true; return false; }
      if ((stored.role !== "bot" && stored.role !== "user") || json.role !== stored.role) { hard = true; return false; }
      const further = chainRefs(json);
      if (!further) { hard = true; return false; }
      if (plainObject(json.copyOf) && !present(json.copyOf as { threadId: string; messageIds: string[] })) { hard = true; return false; }
      if (live) {
        const verdict = denyLookup(db, { threadId: ref.threadId, lines: [{ messageId: ref.messageId, author: lineAuthor(json as unknown as Message) }] }, doorReader(audience), { ownerOwnChat }).get(ref.messageId);
        if (!verdict || verdict.state === "checking") { soft = true; return false; }
        if (!verdictShows(verdict)) { hard = true; return false; }
      }
      return everySource(further);
    };
    // every source is judged, not only up to the first that fails: a mark on any of them outranks a check still open on another, whatever
    // their order (REPLY-WITHHELD-CONTRACT C1). Stops once a mark is found: nothing later changes a withheld answer.
    const everySource = (refs: readonly ChainRef[]): boolean => {
      let all = true;
      for (const ref of refs) if (!sourceOk(ref)) { all = false; if (hard) break; }
      return all;
    };
    let ok = false;
    try {
      const refs = chainRefs(row as unknown as Record<string, unknown>);
      if (!refs) hard = true;
      ok = refs ? everySource(refs) : false;
    } catch { ok = false; soft = true; }
    last = { ok, hard, soft };
    return ok;
  };
  return Object.assign(judge, { checking: () => !last.ok && last.soft && !last.hard });
}

/** One operation's row check and chain judge, sharing one copy chain check (its memo stamp is read once per operation) and one read of
 * whether line lineage is live. */
type DoorJudges = { check: (row: Message) => boolean; chain: ChainJudge; live: boolean };
type DoorShared = { present: ReturnType<typeof copyChainCheck>; live: boolean };
const doorShared = (db: DatabaseSync): DoorShared => ({ present: copyChainCheck(db), live: lineageLive(db) });
function doorJudges(db: DatabaseSync, botId: string, threadId: string, options: BotRowsOptions, shared = doorShared(db)): DoorJudges {
  const { present, live } = shared;
  return { check: transcriptRowCheck(db, botId, threadId, present), chain: chainJudge(db, threadId, options.audience ?? null, options.ownerOwnChat === true, present, live), live };
}

/** The door's judgment of one page: classify, project, validate copy and hand-off chains (rule 9), row check, then the lineage verdicts under
 * the door's reader. While no line lineage
 * is written on this file (lineageLive false), the lineage step reads nothing and the readers' own read-time judge stays (rule 29 keeps
 * those bypasses). */
function admit(db: DatabaseSync, botId: string, threadId: string, rows: readonly Message[], options: BotRowsOptions, judges = doorJudges(db, botId, threadId, options)): Admitted[] {
  const { check, chain, live } = judges;
  const candidates: Admitted[] = [];
  // copies whose chain failed only on a check still open: judged under the door's reader with the page, so a mark of their own outranks it
  const unsettled: Message[] = [];
  const states = options.states;
  for (const row of rows) {
    try {
      if (options.standIns?.has(row.id)) { candidates.push({ row }); states?.set(row.id, "shown"); continue; }
      if (isMurageVoice(row)) {
        const projection = fixedCopy(row);
        if (projection !== undefined) candidates.push({ row, projection });
        states?.set(row.id, "withheld"); // a classified row is never read as stored
        continue;
      }
      if ((row.copyOf !== undefined || row.handoffOf !== undefined) && !chain(row)) {
        // rule 9: a copy or hand-off whose chain fails reads as its withheld line in the owner's turn, and is dropped for any other; a chain
        // that failed only on unknowns (a source still checking) reads as the checking line and counts as checking (REPLY-WITHHELD-CONTRACT C1)
        const checking = chain.checking();
        if (options.audience?.owner === true) candidates.push({ row, projection: withheldRoomLine(row, false, checking) });
        states?.set(row.id, checking ? "checking" : "withheld");
        // a chain still checking is not this row's whole answer: its own verdict is read with the page below, and a mark on it reads withheld
        if (checking) unsettled.push(row);
        continue;
      }
      if (!check(row)) { states?.set(row.id, "withheld"); continue; }
      candidates.push({ row });
      states?.set(row.id, "shown");
    } catch { states?.set(row.id, "checking"); /* a row that cannot be judged is not shown */ }
  }
  const page = candidates.filter(c => c.projection === undefined && !options.standIns?.has(c.row.id)).map(c => ({ messageId: c.row.id, author: lineAuthor(c.row) }));
  for (const row of unsettled) page.push({ messageId: row.id, author: lineAuthor(row) });
  if (!page.length || !live) return candidates;
  const verdicts = denyLookup(db, { threadId, lines: page }, doorReader(options.audience ?? null), { ownerOwnChat: options.ownerOwnChat === true });
  for (const row of unsettled) {
    if (verdicts.get(row.id)?.state !== "withheld") continue;
    states?.set(row.id, "withheld");
    const at = candidates.findIndex(c => c.row === row);
    if (at >= 0) candidates[at] = { row, projection: withheldRoomLine(row, false, false) };
  }
  return candidates.filter(({ row, projection }) => {
    if (projection !== undefined || options.standIns?.has(row.id)) return true;
    const verdict: LineageVerdict | undefined = verdicts.get(row.id);
    states?.set(row.id, !verdict ? "checking" : verdict.state);
    return Boolean(verdict && verdictShows(verdict));
  });
}

/** The rows of `threadId` a viewer may read, in order: for a bot, unclassified rows that pass the row check and read shown under the door's
 * reader, and classified rows only as their projection; for the human viewer, every row as stored. A row that fails any check is not shown,
 * never an error. */
export function botRows(db: DatabaseSync, viewer: Viewer, threadId: string, rows: readonly Message[], options: BotRowsOptions = {}): BotRow[] {
  if (viewer.kind === "human") return rows.map(row => mint(row, row.text ?? ""));
  return admit(db, viewer.botId, threadId, rows, options).map(({ row, projection }) => mint(row, projection ?? row.text ?? ""));
}

/** For a reader that holds stored rows by id (the result gate's walk, server/result-egress.ts): whether every one of them reads to the viewer as
 * stored, by the door's own verdicts. A row missing, unreadable, classified (a bot reads only its projection) or failing any check is not. */
export function storedRowsShown(db: DatabaseSync, viewer: Viewer, threadId: string, ids: readonly string[], options: BotRowsOptions = {}): boolean {
  return storedRowsVerdict(db, viewer, threadId, ids, options) === "shown";
}

/** The same question with its three answers (REPLY-WITHHELD-CONTRACT R1): "shown" when every row reads as stored; "withheld" when a row is
 * missing, unreadable, classified or fails a mark, a chain or the row check; "checking" when a row's verdict could not be reached (a pending
 * window, lineage not ready, a row held "checking", a judgement that threw). withheld wins over checking. */
export function storedRowsVerdict(db: DatabaseSync, viewer: Viewer, threadId: string, ids: readonly string[], options: BotRowsOptions = {}): LineVerdictState {
  if (viewer.kind === "human" || !ids.length) return "shown";
  try {
    const read = db.prepare("SELECT json FROM messages WHERE thread_id=? AND id=?");
    const rows: Array<{ threadId: string; row: Message }> = [];
    for (const id of ids) {
      const stored = read.get(threadId, id) as { json: unknown } | undefined;
      if (!stored) return "withheld";
      const json: unknown = JSON.parse(String(stored.json));
      if (!plainObject(json)) return "withheld";
      rows.push({ threadId, row: { ...json, id } as unknown as Message });
    }
    const states = new Map<string, LineVerdictState>();
    const shown = rowsShown(db, viewer, rows, { ...options, states });
    let worst: LineVerdictState = "shown";
    rows.forEach(({ row }, index) => {
      const state = shown[index] ? "shown" : states.get(row.id) ?? "withheld";
      if (state === "withheld") worst = "withheld";
      else if (state === "checking" && worst === "shown") worst = "checking";
    });
    return worst;
  } catch { return "checking"; }
}

/** For a reader that already holds parsed stored rows, of one thread or many (the working context's quoted replies): whether each reads to
 * the viewer as stored, by the door's own verdicts, in input order. One operation: the copy memo's stamp and the lineage gate are read once,
 * each thread's rows are judged in one lookup, and no row is read again by key. A row that is classified (a bot reads only its projection),
 * fails any check or cannot be judged is not. */
export function rowsShown(db: DatabaseSync, viewer: Viewer, held: ReadonlyArray<{ threadId: string; row: Message }>, options: BotRowsOptions = {}): boolean[] {
  if (viewer.kind === "human") return held.map(() => true);
  if (!held.length) return [];
  try {
    const shared = doorShared(db);
    const byThread = new Map<string, Message[]>();
    for (const { threadId, row } of held) byThread.set(threadId, [...(byThread.get(threadId) ?? []), row]);
    const shown = new Set<string>();
    for (const [threadId, rows] of byThread) {
      for (const { row, projection } of admit(db, viewer.botId, threadId, rows, options, doorJudges(db, viewer.botId, threadId, options, shared)))
        if (projection === undefined) shown.add(`${threadId}\u0000${row.id}`);
    }
    return held.map(({ threadId, row }) => shown.has(`${threadId}\u0000${row.id}`));
  } catch { return held.map(() => false); }
}

/** The door as the result gate asks it (ResultEgressDeps.doorShown): the bot the result is released to reads every line of its walk, under the
 * audience it is released for (an owner audience as the owner's own chat, as the gate's write-time lookup). */
/** `ownerConversation`: as result-egress.ts writetimeLinesShown, lines of the owner's own direct conversation released to the owner's own
 * audience are read as that conversation reads them (content reader); every other thread keeps the explicit owner audience. */
/** `scopeIds` (SL-E r3 W9): a proven person reader's S(P): the same door, for the audience `{ owner: false, scopeIds }`. Absent: today's rule. */
export function doorEgress(db: () => DatabaseSync, ownerConversation?: (threadId: string) => boolean): (readerBotId: string, threadId: string, messageIds: readonly string[], notOwnerAudience: boolean, scopeIds?: readonly string[]) => LineVerdictState {
  return (readerBotId, threadId, messageIds, notOwnerAudience, scopeIds) => storedRowsVerdict(db(), botViewer(readerBotId), threadId, messageIds,
    notOwnerAudience && scopeIds !== undefined ? { audience: { owner: false, scopeIds: [...scopeIds] }, ownerOwnChat: false }
    : !notOwnerAudience && ownerConversation?.(threadId) === true ? { audience: null }
      : { audience: { owner: !notOwnerAudience, scopeIds: [] }, ownerOwnChat: !notOwnerAudience });
}

/** A projection as a row a renderer can carry: its fixed words and who it is, no other stored field. */
function projectionRow(row: Message, text: string): Message {
  return { id: row.id, role: row.role, kind: "text", text, at: row.at, ...(row.from ? { from: row.from } : {}) } as Message;
}

/** The same verdicts as botRows, for the renderers that format a row's shape (quotes, attachments, the engine that wrote it): every row
 * returned is one botRows admits, an unclassified row as stored and a classified one only as its projection. */
export function botMessages(db: DatabaseSync, viewer: Viewer, threadId: string, rows: readonly Message[], options: BotRowsOptions = {}): Message[] {
  if (viewer.kind === "human") { decided(viewer, rows, rows.map(row => ({ row, text: row.text ?? "" }))); return [...rows]; }
  return shownRows(viewer, rows, admit(db, viewer.botId, threadId, rows, options));
}

/** The admitted rows as a renderer reads them (an unclassified row as stored, a classified one as its projection), each recorded as the door's
 * latest decision for this viewer (botRowOf). */
function shownRows(viewer: Viewer, judged: readonly Message[], admitted: readonly Admitted[]): Message[] {
  // 5.4: a bot reads a marked row (written after reading outside mail) fenced, kind email-derived
  const shown = admitted.map(({ row, projection }) => {
    if (projection !== undefined) return { row: projectionRow(row, projection), text: projection };
    if (viewer.kind !== "bot" || row.externalContent !== "email" || !row.text) return { row, text: row.text ?? "" };
    const text = emailDerivedText(row, row.text);
    return { row: { ...row, text } as Message, text };
  });
  decided(viewer, judged, shown);
  return shown.map(({ row }) => row);
}

/** The newest rows a bot may read, judged through the door from the newest back in pages and only until `full` says the prompt has what it
 * can carry (the partition-sources.ts window, behind the door): a turn's work grows with its window, never with the history. */
export function botWindow(db: DatabaseSync, viewer: Viewer, threadId: string, rows: readonly Message[], full: (kept: Message) => boolean, examinedCap: number, options: BotRowsOptions = {}): { window: Message[]; olderRows: number; readonly older: Message[] } {
  const kept: Message[] = [];
  let index = rows.length - 1, examined = 0, done = false;
  const judges = viewer.kind === "bot" ? doorJudges(db, viewer.botId, threadId, options) : undefined;
  while (!done && index >= 0 && examined < examinedCap) {
    const take = Math.min(WINDOW_PAGE, index + 1, examinedCap - examined);
    const page = rows.slice(index - take + 1, index + 1).reverse();
    const admitted = shownRows(viewer, page, viewer.kind === "human" ? page.map(row => ({ row })) : admit(db, viewer.botId, threadId, page, options, judges));
    const byId = new Map(admitted.map(row => [row.id, row]));
    for (const row of page) {
      index -= 1; examined += 1;
      const shown = byId.get(row.id);
      if (!shown) continue;
      kept.push(shown);
      if (full(shown)) { done = true; break; }
    }
  }
  const end = index + 1;
  return { window: kept.reverse(), olderRows: end, get older() { return rows.slice(0, end); } };
}
/** How many rows the window judges at once (one lineage lookup each). */
const WINDOW_PAGE = 40;

// ---- The legacy anchor check (rules 23, 24): its own leaf module, so the door (memory/deny-read.ts) reaches it without a cycle ----
export { anyMurageAnchor, murageAnchor } from "./murage-anchor.ts";
