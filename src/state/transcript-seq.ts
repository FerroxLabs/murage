// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ROOM-ORDER-DESIGN r6-r8 (one ordering key): the server gives every row of a numbered thread its storage position, `seq`, contiguous
// from 1, and every envelope that carries such rows the thread's newest number, `newestSeq`. A transcript holds rows sorted by `seq`;
// its gaps are the integers it does not hold (never stored); it pages, merges and orders by `seq` alone. A thread that carries no
// numbers (an older server, a thread the backfill has not reached) is `legacy`: rows in arrival order, `hasMore` from its pages,
// never `complete`. This module is pure and reads no timestamp, no clock and no display hint (C5).
import type { Message } from "./store";

/** The explicit loaded state of a transcript: `unloaded` holds nothing yet, `partial` lacks a number (or is legacy), `complete` holds
 * exactly `1..tail`, every row vouched for. */
export type TranscriptState = "unloaded" | "partial" | "complete";

/** The transcript keys of a room (or a bot, which is always legacy). */
export interface SeqTranscript {
  messages: Message[];
  /** r6 R6/R8: promoted this run by its first numbered input; until then (and in a new run) the transcript is legacy. */
  numbered?: true;
  /** r7 R4: the highest `newestSeq` a vouching input carried; undefined until one did (and after a hydrate). */
  tail?: number;
  /** Legacy only: older rows remain on the server. A numbered transcript derives it (`front`). */
  hasMore?: boolean;
  /** Legacy only: a branch page's next ancestor (bots). */
  olderFrom?: string;
  /** Astra build r5 H2, legacy only: held rows each just above a run the client may lack (a newer page that shares no row with what was
   * held and says older rows remain). Paged `before` that row, newest first, until a page reaches the rows held below it or the start. */
  legacyGaps?: string[];
  /** No rows held and nothing loaded yet. */
  messagesUnloaded?: true;
}

/** How an input reached the client: a page asked for (`newest`, `older`), a room statement's page (`statement`), a live row (`live`:
 * a `message` frame or a POST answer) or a row's newer copy (`patch`). */
export type InputKind = "newest" | "older" | "statement" | "live" | "patch";

export interface TranscriptInput {
  kind: InputKind;
  rows: Message[];
  /** The envelope's `newestSeq`: present on every delivery from a numbered thread, absent from a legacy one. */
  newestSeq?: number;
  /** r6 Q3 / r4 T4: the input was sent at or after the floor (a frame, a page asked after the roster); see `vouches`. */
  vouched: boolean;
  /** Legacy pages. */
  hasMore?: boolean;
  olderFrom?: string | null;
  /** An older page: the held row it was asked before (a legacy gap's page is laid into that gap). */
  before?: string;
}

/** r6 R6: `numbered` when the envelope carries `newestSeq` and every row a `seq`; `legacy` when it carries neither; `empty` when it carries
 * no rows and no number (an empty page says nothing); anything else is a wire defect. */
export function inputShape(rows: readonly Message[], newestSeq: number | undefined): "numbered" | "legacy" | "empty" | "mixed" {
  const numberedRows = rows.filter((row) => typeof row.seq === "number").length;
  if (typeof newestSeq === "number") return numberedRows === rows.length ? "numbered" : "mixed";
  if (rows.length === 0) return "empty";
  return numberedRows === 0 ? "legacy" : "mixed";
}

/** r4 T4's origin test, applied to rows: a frame vouches, an HTTP input only when it was sent at or after the floor. */
export function vouches(origin: { source: string; sentAt?: number }, floor: number | undefined): boolean {
  if (origin.source !== "http") return true;
  if (floor === undefined) return true;
  return typeof origin.sentAt === "number" && origin.sentAt >= floor;
}

/**
 * r6 Q3: hold numbered rows. A number not held joins at its place (marked unvouched when the input does not vouch); a held number keeps
 * the held copy unless it is unvouched (the input's vouched copy replaces it and clears the flag) or the input is a patch (a newer copy
 * of the row). Order-independent: a number is held once, whatever order the inputs arrive in.
 * Astra build r5 H1: an unvouched row never blocks a vouched one. A number held by an unvouched row yields to a vouched input's row for that
 * number, whatever its id (the unvouched row may be a pre-restore server's answer); an id held unvouched at another number moves to the
 * vouched number. A vouched holder is never displaced by a different id or moved by an unvouched copy.
 */
export function holdRows(held: readonly Message[], rows: readonly Message[], options: { vouched: boolean; replace?: boolean }): Message[] {
  const bySeq = new Map<number, Message>();
  const seqOf = new Map<string, number>();
  for (const row of held) {
    if (typeof row.seq !== "number") continue;
    bySeq.set(row.seq, row);
    seqOf.set(row.id, row.seq);
  }
  let changed = held.length !== bySeq.size;
  for (const row of rows) {
    const seq = row.seq;
    if (typeof seq !== "number") continue;
    const current = bySeq.get(seq);
    const copy = (unvouched: boolean): Message => {
      const { unvouched: _flag, ...rest } = row;
      return unvouched ? { ...rest, unvouched: true } : (rest as Message);
    };
    if (!current || current.id !== row.id) {
      if (current && !(current.unvouched && options.vouched)) continue; // a vouched holder, or an unvouched input: the held row stays
      const elsewhere = seqOf.get(row.id);
      if (elsewhere !== undefined) {
        // one id, one number: a row is never held twice; an unvouched copy elsewhere yields to this vouched one
        if (!(options.vouched && bySeq.get(elsewhere)!.unvouched)) continue;
        bySeq.delete(elsewhere);
      }
      if (current) seqOf.delete(current.id);
      bySeq.set(seq, copy(!options.vouched));
      seqOf.set(row.id, seq);
      changed = true;
      continue;
    }
    if (options.replace) {
      bySeq.set(seq, copy(Boolean(current.unvouched) && !options.vouched));
      changed = true;
    } else if (current.unvouched && options.vouched) {
      bySeq.set(seq, copy(false));
      changed = true;
    }
  }
  if (!changed) return held as Message[];
  return [...bySeq.keys()].sort((a, b) => a - b).map((seq) => bySeq.get(seq)!);
}

/** A run of missing numbers, both ends included. */
export interface SeqGap { from: number; to: number }

/** r6 Q3 / r7 R4: what a numbered transcript lacks. `front`: 1 is not held. `interior`: the runs missing between the oldest and the newest
 * held row, newest first. `tail`: the run above the newest held row up to `tail`, or `"open"` while the tail is unknown. */
export function gapsOf(t: Pick<SeqTranscript, "messages" | "tail">): { front: boolean; interior: SeqGap[]; tail: SeqGap | "open" | undefined } {
  const rows = t.messages;
  const interior: SeqGap[] = [];
  for (let index = rows.length - 1; index > 0; index--) {
    const above = rows[index]!.seq!;
    const below = rows[index - 1]!.seq!;
    if (above - below > 1) interior.push({ from: below + 1, to: above - 1 });
  }
  const first = rows[0]?.seq;
  const last = rows[rows.length - 1]?.seq ?? 0;
  const tail = t.tail === undefined ? "open" : t.tail > last ? { from: last + 1, to: t.tail } : undefined;
  return { front: first === undefined ? (t.tail ?? 1) > 0 : first > 1, interior, tail };
}

/** The page scrollback asks for next: the newest page (no `before`), or the page before a held row. */
export type PageAsk = { newest: true } | { before: string; olderFrom?: string };

/**
 * r6 Q4 with r7 R4 and r8 R9. Numbered:
 * 1. the tail is unknown, the held max is below it, or the newest held row is unvouched: the newest page (its rows end at the server's
 *    newest number and are vouched, so the suffix closes or becomes an interior gap whose upper end is held);
 * 2. the newest interior gap: before the held row just above it;
 * 2b. the newest unvouched row: before the held (vouched) row just above it, so the page re-fetches the run and repairs a missed edit;
 * 3. the front: before the oldest held row;
 * else nothing (`complete`). Legacy: the newest page while unloaded, else the page before the oldest held row while `hasMore`.
 */
export function nextPage(t: SeqTranscript): PageAsk | undefined {
  if (!t.numbered) {
    if (t.messagesUnloaded) return { newest: true };
    const gap = newestLegacyGap(t);
    if (gap) return { before: gap };
    const before = t.messages[0]?.id;
    if (!t.hasMore || !before) return undefined;
    const olderFrom = t.olderFrom && !t.messages.some((row) => row.id === t.olderFrom) ? t.olderFrom : undefined;
    return olderFrom ? { before, olderFrom } : { before };
  }
  const rows = t.messages;
  const top = rows[rows.length - 1];
  if (t.tail === undefined) return { newest: true };
  if (!top) return t.tail > 0 ? { newest: true } : undefined;
  if (top.seq! < t.tail || top.unvouched) return { newest: true };
  for (let index = rows.length - 1; index > 0; index--) {
    if (rows[index]!.seq! - rows[index - 1]!.seq! > 1) return { before: rows[index]!.id };
  }
  for (let index = rows.length - 2; index >= 0; index--) {
    if (rows[index]!.unvouched) return { before: rows[index + 1]!.id };
  }
  if (rows[0]!.seq! > 1) return { before: rows[0]!.id };
  return undefined;
}

/** The newest held legacy gap anchor (the one a reader paging up meets first). */
function newestLegacyGap(t: Pick<SeqTranscript, "messages" | "legacyGaps">): string | undefined {
  if (!t.legacyGaps?.length) return undefined;
  const open = new Set(t.legacyGaps);
  for (let index = t.messages.length - 1; index >= 0; index--) if (open.has(t.messages[index]!.id)) return t.messages[index]!.id;
  return undefined;
}

/** True while there is a page to ask for: "Load earlier" shows, scrollback pages. */
export const hasOlder = (t: SeqTranscript): boolean => nextPage(t) !== undefined;

/** True when the next page is the newest one (the first-page path asks it). */
export const wantsNewest = (t: SeqTranscript): boolean => {
  const ask = nextPage(t);
  return ask !== undefined && "newest" in ask;
};

/** r7 R4: `complete` iff the held numbers are exactly `1..tail` and none is unvouched; a legacy transcript is never complete. */
export function transcriptState(t: SeqTranscript): TranscriptState {
  if (!t.numbered) return t.messagesUnloaded ? "unloaded" : "partial";
  if (t.tail === undefined) return t.messages[0] === undefined ? "unloaded" : "partial";
  const rows = t.messages;
  if (rows.length !== t.tail) return "partial";
  if (rows.length && (rows[0]!.seq !== 1 || rows[rows.length - 1]!.seq !== t.tail)) return "partial";
  return rows.some((row) => row.unvouched) ? "partial" : "complete";
}

/** r6 Q3 closing check: a page's rows are contiguous numbers (the server pages by `seq`), and a page that says nothing older exists
 * starts at 1. Anything else is a defect. */
function pageIsSound(input: TranscriptInput): boolean {
  if (input.kind === "live" || input.kind === "patch") return true;
  const rows = input.rows;
  for (let index = 1; index < rows.length; index++) if (rows[index]!.seq! !== rows[index - 1]!.seq! + 1) return false;
  if (input.kind === "older" && input.hasMore === false && rows.length > 0 && rows[0]!.seq !== 1) return false;
  if (rows.length && typeof input.newestSeq === "number" && rows[rows.length - 1]!.seq! > input.newestSeq) return false;
  return true;
}

/** A defect (r6 Q6): the input is dropped and the newest page is asked once (the tail is forgotten, so step 1 asks it). */
const askNewest = (t: SeqTranscript): SeqTranscript => (t.numbered && t.tail !== undefined ? { ...t, tail: undefined } : t);

/** Legacy union of a page with the held rows: page order for the rows it carries; a held row it lacks keeps its place relative to the
 * held row in front of it that the page carries (or the front); with nothing shared, an older page goes in front, any other behind. */
function legacyUnion(held: readonly Message[], page: readonly Message[], older: boolean): Message[] {
  const pageIds = new Set(page.map((row) => row.id));
  const unique = page.filter((row, index) => page.findIndex((entry) => entry.id === row.id) === index);
  const heldById = new Map(held.map((row) => [row.id, row]));
  const pageRows = unique.map((row) => heldById.get(row.id) ?? row);
  if (!held.some((row) => pageIds.has(row.id))) return older ? [...pageRows, ...held] : [...held, ...pageRows];
  const front: Message[] = [];
  const after = new Map<string, Message[]>();
  let predecessor: string | undefined;
  for (const row of held) {
    if (pageIds.has(row.id)) { predecessor = row.id; continue; }
    if (predecessor === undefined) front.push(row);
    else after.set(predecessor, [...(after.get(predecessor) ?? []), row]);
  }
  const out = [...front];
  for (const row of pageRows) out.push(row, ...(after.get(row.id) ?? []));
  return out;
}

/** r6 Q6 / r7 R3: the legacy branch. Rows in arrival order: an older page prepends, a live row appends, a patch replaces by id, a newest or
 * statement page unions; `hasMore` from the page; no numbers, no gaps. A bot's transcript is always this (bots stay legacy). */
export function legacyTranscriptInput(t: SeqTranscript, input: TranscriptInput): SeqTranscript {
  const held = t.messages;
  switch (input.kind) {
    case "live":
      if (t.messagesUnloaded) return t;
      return { ...t, messages: [...held, ...input.rows.filter((row) => !held.some((entry) => entry.id === row.id))] };
    case "patch": {
      if (t.messagesUnloaded) return t;
      const byId = new Map(input.rows.map((row) => [row.id, row]));
      return held.some((row) => byId.has(row.id)) ? { ...t, messages: held.map((row) => byId.get(row.id) ?? row) } : t;
    }
    case "older": {
      if (input.before !== undefined && t.legacyGaps?.includes(input.before)) return legacyGapPage(t, input, input.before);
      const ids = new Set(held.map((row) => row.id));
      const fresh = input.rows.filter((row) => !ids.has(row.id));
      const hasMore = Boolean(input.hasMore);
      // a branch page names the next ancestor; a storage page leaves the cursor as it was
      const cursor = input.olderFrom === undefined ? t.olderFrom : input.olderFrom ?? undefined;
      return { ...t, messages: fresh.length ? [...fresh, ...held] : held, hasMore, olderFrom: hasMore ? cursor : undefined };
    }
    default: {
      // an unloaded transcript is loaded only by an input that vouches (r4 T4); otherwise the first page loads it
      if (t.messagesUnloaded && !input.vouched) return t;
      const base = t.messagesUnloaded ? [] : held;
      const messages = legacyUnion(base, input.rows, false);
      const baseIds = new Set(base.map((row) => row.id));
      const pageIds = new Set(input.rows.map((row) => row.id));
      const disjoint = base.length > 0 && input.rows.length > 0 && !input.rows.some((row) => baseIds.has(row.id));
      const reachesBack = base.length > 0 && !pageIds.has(base[0]!.id) && messages[0] === base[0];
      const hasMore = reachesBack ? Boolean(t.hasMore) : Boolean(input.hasMore);
      const olderFrom = reachesBack ? t.olderFrom : input.hasMore && input.olderFrom ? input.olderFrom : undefined;
      // Astra build r5 H2: a newer page that shares no held row and says older rows remain may leave a run between them: record it
      let gaps = t.messagesUnloaded ? [] : (t.legacyGaps ?? []).filter((id) => !closedByPage(base, id, pageIds, Boolean(input.hasMore)));
      if (gaps.length) gaps = gaps.map((id) => (pageIds.has(id) ? input.rows[0]!.id : id)).filter((id, index, all) => all.indexOf(id) === index);
      if (disjoint && input.hasMore) gaps = [...gaps, input.rows[0]!.id];
      return { ...t, messages, hasMore, olderFrom, legacyGaps: gaps.length ? gaps : undefined, messagesUnloaded: undefined };
    }
  }
}

/** A newer legacy page that carries a gap's anchor closes that gap when it also carries a row held below the anchor, or says nothing older
 * exists; otherwise the gap's upper end moves to the page's oldest row (the page is contiguous storage). */
function closedByPage(held: readonly Message[], anchor: string, pageIds: ReadonlySet<string>, hasMore: boolean): boolean {
  if (!pageIds.has(anchor)) return false;
  if (!hasMore) return true;
  const at = held.findIndex((row) => row.id === anchor);
  for (let index = 0; index < at; index++) if (pageIds.has(held[index]!.id)) return true;
  return false;
}

/** Astra build r5 H2: an older page asked before a legacy gap's anchor is laid into that gap, between the rows held below it and the anchor.
 * It closes the gap when it reaches a row held below (the union keeps page order there), when nothing older exists, or when it brings no row
 * not held (no further progress is possible); else the gap's anchor moves to the page's oldest row. The front (`hasMore`) is untouched. */
function legacyGapPage(t: SeqTranscript, input: TranscriptInput, anchor: string): SeqTranscript {
  const held = t.messages;
  const at = held.findIndex((row) => row.id === anchor);
  const others = (t.legacyGaps ?? []).filter((id) => id !== anchor);
  if (at < 0) return { ...t, legacyGaps: others.length ? others : undefined };
  const lower = held.slice(0, at);
  const upper = held.slice(at);
  const upperIds = new Set(upper.map((row) => row.id));
  const page = input.rows.filter((row) => !upperIds.has(row.id));
  const lowerIds = new Set(lower.map((row) => row.id));
  const fresh = page.filter((row) => !lowerIds.has(row.id));
  const reaches = page.some((row) => lowerIds.has(row.id));
  const closed = reaches || !input.hasMore || fresh.length === 0;
  const laid = reaches ? legacyUnion(lower, page, false) : [...lower, ...fresh];
  const gaps = closed ? others : [...others, fresh[0]!.id];
  return { ...t, messages: [...laid, ...upper], legacyGaps: gaps.length ? gaps : undefined };
}

/**
 * The one entry for every input (r6 Q3-Q6, r8 R8). Returns the transcript after it (the same object when nothing changed).
 * - A defect (one of `seq`/`newestSeq` without the other, a page whose numbers are not contiguous) is dropped; a numbered transcript then
 *   asks the newest page once.
 * - A numbered transcript holds a numbered input and raises `tail` to its `newestSeq` when it vouches; a legacy input (a replayed pre-flip
 *   frame, an in-flight legacy page) is dropped and the newest page asked once.
 * - A legacy transcript's first numbered input promotes it: every held legacy row is dropped, the input's rows held, `tail` from it when it
 *   vouches; `nextPage` refills the rest. Until then legacy inputs take the legacy branch.
 * - An unloaded transcript is loaded only by a page that vouches; a live row or a patch reaching it moves only the sidebar (the caller).
 */
export function applyTranscriptInput(t: SeqTranscript, input: TranscriptInput): SeqTranscript {
  const shape = inputShape(input.rows, input.newestSeq);
  if (shape === "mixed") return askNewest(t);
  if (shape === "empty") return t.numbered ? t : legacyTranscriptInput(t, input);
  if (shape === "legacy") return t.numbered ? askNewest(t) : legacyTranscriptInput(t, input);
  if (!pageIsSound(input)) return askNewest(t);
  const live = input.kind === "live" || input.kind === "patch";
  if (t.messagesUnloaded && (live || !input.vouched)) return t;
  const raise = (tail: number | undefined): number | undefined =>
    input.vouched && typeof input.newestSeq === "number" ? Math.max(tail ?? input.newestSeq, input.newestSeq) : tail;
  if (!t.numbered) {
    // Astra build r5 H1: an input that does not vouch (an answer sent before this run's roster, perhaps to the server before a restore)
    // never promotes: it would hold numbers with no tail to bound them; the first vouched numbered input promotes
    if (!input.vouched) return t;
    // r8 R8 promotion: the legacy rows have no number and no place; the input's rows are the transcript's first numbered rows
    const messages = holdRows([], input.rows, { vouched: true });
    return { ...t, numbered: true, messages, tail: raise(undefined), hasMore: undefined, olderFrom: undefined, legacyGaps: undefined, messagesUnloaded: undefined };
  }
  // Astra build r5 H1: once the tail is the server's number, an input that does not vouch admits no row above it: such a row may be another
  // generation's (a pre-restore answer) and nothing the server sends would ever displace it; the current row there reaches this client by
  // its frame or the newest page. Rows at or below the tail join unvouched and yield to the server's copy (holdRows).
  const rows = input.vouched || t.tail === undefined ? input.rows : input.rows.filter((row) => row.seq! <= t.tail!);
  const messages = holdRows(t.messages, rows, { vouched: input.vouched, replace: input.kind === "patch" });
  const tail = raise(t.tail);
  if (messages === t.messages && tail === t.tail && !t.messagesUnloaded) return t;
  return { ...t, messages, tail, messagesUnloaded: undefined };
}

/**
 * r7 R4: a hydrate. In the same run a numbered transcript keeps its rows, each marked unvouched (the stream that vouched for them broke),
 * and forgets its tail; the walk refreshes them. A legacy transcript (no numbers to re-vouch by) and every transcript of a new run (a
 * restore may have renumbered) drop their rows and arrive unloaded.
 */
export function hydrateTranscript(t: SeqTranscript, sameRun: boolean): SeqTranscript {
  if (sameRun && t.numbered && t.messages[0] !== undefined) {
    return { ...t, messages: t.messages.map((row) => (row.unvouched ? row : { ...row, unvouched: true })), tail: undefined, messagesUnloaded: undefined };
  }
  return { ...t, messages: [], numbered: sameRun ? t.numbered : undefined, tail: undefined, hasMore: undefined, olderFrom: undefined, legacyGaps: undefined, messagesUnloaded: true };
}
