// Output lineage of a steer (memory schema v6). A steer folds a line, and the
// reply it quotes, into a running turn. The quote's roots are what that text
// discloses to the engine, so they are taken when the text is rendered and
// recorded on the running turn and its engine session at the write boundary:
// inside the driver's submission fence, which runs with no await before the
// engine write. They are never recomputed after the engine's acknowledgement:
// by then the quoted reply can be withheld (its source revoked), and a check
// made then would record nothing for text the engine already has.
import { doorReader } from "./bot-read.ts";
import type { Message } from "./store.ts";
import type { SteerDelivery } from "./contracts.ts";
import { LineageAllowance, mergeOutputRoots, outputRootsBad, outputRootsFor, outputRootsShallow, recordSessionRoots, type OutputRoots } from "./memory/replay-lineage.ts";
import { steerBusyDesk } from "./project-card-executor.ts";
import { collectRendered, type EgressOrigin, type SourceRange } from "./released-text.ts";
import { storedPosition, threadRangeNow, turnSourceCopiesBackfilled, type HeldRange } from "./turn-source-holds.ts";
import { database } from "./database.ts";
import { addTurnParents } from "./memory/lineage-write.ts";
import { refsLookup } from "./memory/deny-read.ts";
import { verdictShows, type LineageReader, type LineageRef, type LineageVerdict, type TurnLineage } from "./memory/lineage-types.ts";
import { buildPrompt, noneRef, promptPart } from "./memory/prompt-parts.ts";

/** A running turn's output lineage: the roots of what it was shown, laid on
 * each reply it produces and on its engine session. `botId` is the bot whose
 * turn it is; `sources` every stored line the turn could carry (what it was
 * shown, what its retained session already holds, and each reply it has
 * written so far), or "over" past TURN_SOURCES_MAX. Roots are only the lines
 * made under memory; the sources are every line, so what the turn writes
 * apart from its replies (a card note) rests on all of them. */
export interface RunningTurnLineage { roots: OutputRoots; instanceId: string; session?: string; botId?: string; sources?: ShownLine[] | "over";
  /** The dispatch claim (internal generation) this running turn belongs to, and the very TurnLineage object `openTurnLineage` returned for
   * that dispatch (thread tools bind to both: a replacing dispatch of the same bot never lends its turn to them). */
  generation: string; turn: TurnLineage;
  /** A resumed turn's raw cursor and the incarnation it was started under (S6 rule 27): `session` is the memory key formed from both. */
  cursor?: string; incarnation?: number;
  /** Whole stretches of conversations the turn carries (server/turn-source-holds.ts): its own conversation up to the newest line when it began,
   * however long, and any a note it was shown rests on. A line it takes in that one of these already covers is not named again. */
  ranges?: HeldRange[] }
/** A line a turn's context showed. `quoted`: shown in full by a renderer that judged it on its own (the working context's
 * quotes), so a replay that withheld the same id does not take its roots away. */
export type ShownLine = { threadId: string; id: string; role?: string; copyOf?: Message["copyOf"]; quoted?: boolean };

/** At most this many stored lines a turn's sources name one by one (lines outside its ranges: what it read or was quoted from other
 * conversations); past it the turn's sources are not established and nothing it writes apart from its replies is shown to a bot. */
export const TURN_SOURCES_MAX = 1600;
/** At most this many ranges a turn carries (its own conversation, and those of the notes it was shown); past it: not established. */
export const TURN_RANGES_MAX = 64;

/** A turn's sources from the lines it carries: owner and person lines are never sources (as never roots), and a line already withheld when the
 * turn began was carried as its withheld line, not its words. Each line once. */
export function turnSources(lines: Iterable<ShownLine>, withheldNow: (line: ShownLine) => boolean): ShownLine[] | "over" {
  const out = new Map<string, ShownLine>();
  for (const line of lines) {
    if (line.role === "user") continue;
    const key = `${line.threadId}\u0000${line.id}`;
    if (out.has(key) || withheldNow(line)) continue;
    out.set(key, line);
    if (out.size > TURN_SOURCES_MAX) return "over";
  }
  return [...out.values()];
}

/** Lines a running turn takes in or writes after it began (a steered quote, each reply it stores, what a prompt quoted or a Murage tool
 * returned): they join its sources. A line of a conversation the turn carries a range of is placed by its stored position: inside the range it
 * is already carried; past it (a line written since), the range is carried on to it. Any other line is named. */
export function addSourcesToRunningTurn(lineage: RunningTurnLineage | undefined, lines: ReadonlyArray<ShownLine>): void {
  if (!lineage || lineage.sources === undefined || lineage.sources === "over") return;
  const known = new Set(lineage.sources.map(line => `${line.threadId}\u0000${line.id}`));
  for (const line of lines) {
    if (line.role === "user" || known.has(`${line.threadId}\u0000${line.id}`)) continue;
    const range = lineage.ranges?.length ? widestRange(lineage.ranges, line.threadId) : undefined;
    if (range) {
      let position: number | undefined;
      try { position = storedPosition(line.threadId, line.id); } catch { position = undefined; }
      if (position !== undefined) {
        if (position > range.position) { range.upTo = line.id; range.position = position; }
        continue;
      }
    }
    known.add(`${line.threadId}\u0000${line.id}`);
    lineage.sources.push(line);
    if (lineage.sources.length > TURN_SOURCES_MAX) { lineage.sources = "over"; return; }
  }
}

/** How many of `lines` addSourcesToRunningTurn would name one by one, the same walk (known keys, range placement) with nothing changed.
 * 0 when the turn's sources are not established (the caller refuses that case itself). */
export function sourcesRoom(lineage: RunningTurnLineage | undefined, lines: ReadonlyArray<ShownLine>): number {
  if (!lineage || lineage.sources === undefined || lineage.sources === "over") return 0;
  const known = new Set(lineage.sources.map(line => `${line.threadId}\u0000${line.id}`));
  let named = 0;
  for (const line of lines) {
    const key = `${line.threadId}\u0000${line.id}`;
    if (line.role === "user" || known.has(key)) continue;
    const range = lineage.ranges?.length ? widestRange(lineage.ranges, line.threadId) : undefined;
    if (range) {
      let position: number | undefined;
      try { position = storedPosition(line.threadId, line.id); } catch { position = undefined; }
      if (position !== undefined) continue;
    }
    known.add(key);
    named++;
  }
  return named;
}

/** The range of `threadId` that reaches furthest, if the turn carries one. */
function widestRange(ranges: readonly HeldRange[], threadId: string): HeldRange | undefined {
  let widest: HeldRange | undefined;
  for (const range of ranges) if (range.threadId === threadId && (!widest || range.position > widest.position)) widest = range;
  return widest;
}

/** Ranges a running turn takes in after it began (a note it was shown rests on them): they join its ranges, each once. */
export function addRangesToRunningTurn(lineage: RunningTurnLineage | undefined, ranges: ReadonlyArray<SourceRange>): void {
  if (!lineage || lineage.sources === undefined || lineage.sources === "over" || !ranges.length) return;
  const held = lineage.ranges ??= [];
  for (const range of ranges) {
    if (held.some(kept => kept.threadId === range.threadId && kept.upTo === range.upTo && kept.since <= range.since)) continue;
    let position: number | undefined;
    try { position = storedPosition(range.threadId, range.upTo); } catch { position = undefined; }
    // a range whose last line is gone no longer holds: the turn's sources are not established
    if (position === undefined) { lineage.sources = "over"; return; }
    held.push({ threadId: range.threadId, upTo: range.upTo, since: range.since, position });
    if (held.length > TURN_RANGES_MAX) { lineage.sources = "over"; return; }
  }
}

/** What a prompt or a tool answer showed a turn (`collectRendered`): the originals of every released text in it, and what those rest on. */
export function addShownToRunningTurn(lineage: RunningTurnLineage | undefined, shown: { origins: ReadonlyArray<EgressOrigin>; ranges: ReadonlyArray<SourceRange> }): void {
  addSourcesToRunningTurn(lineage, shown.origins.flatMap(origin => origin.messageIds.map(id => ({ threadId: origin.threadId, id, role: "bot" }))));
  addRangesToRunningTurn(lineage, shown.ranges);
}

/** The sources of `botId`'s running turn, grouped by conversation, for what that turn writes apart from its replies. Undefined (not
 * established) when the lineage is not that bot's turn, has no sources, or is over the limit. */
export function runningTurnSources(lineage: RunningTurnLineage | undefined, botId: string): Array<{ threadId: string; messageIds: string[] }> | undefined {
  if (!lineage || lineage.botId !== botId || lineage.sources === undefined || lineage.sources === "over" || lineage.roots.over) return undefined;
  const byThread = new Map<string, string[]>();
  for (const line of lineage.sources) {
    const ids = byThread.get(line.threadId);
    if (ids) ids.push(line.id); else byThread.set(line.threadId, [line.id]);
  }
  return [...byThread].map(([threadId, messageIds]) => ({ threadId, messageIds }));
}

/** The ranges of `botId`'s running turn, as a note keeps them (with `runningTurnSources`; undefined exactly when that is). */
export function runningTurnRanges(lineage: RunningTurnLineage | undefined, botId: string): SourceRange[] | undefined {
  if (!runningTurnSources(lineage, botId)) return undefined;
  return (lineage!.ranges ?? []).map(range => ({ threadId: range.threadId, upTo: range.upTo, since: range.since }));
}

/** What prompts built for a turn that has not begun yet showed it, by conversation and bot: taken by that turn when its lineage is set. */
const promptShown = new Map<string, { origins: EgressOrigin[]; ranges: SourceRange[] }>();
const promptKey = (threadId: string, botId: string) => `${threadId}\u0000${botId}`;

/** Builds the prompt a turn of `botId` in `threadId` will be sent (a wake, a redo, a card run's ask) and keeps what it quoted (every released
 * result and note it renders, with what those rest on) for that turn's sources (`beginTurnLineage`). */
export function promptForTurn(threadId: string, botId: string, build: () => string): string {
  const built = collectRendered(build);
  if (built.origins.length || built.ranges.length) {
    const held = promptShown.get(promptKey(threadId, botId)) ?? { origins: [], ranges: [] };
    held.origins.push(...built.origins); held.ranges.push(...built.ranges);
    // bounded: a prompt never shown keeps no more than one turn's worth, and the next turn that begins takes it (fail closed: more sources)
    if (held.origins.length > TURN_SOURCES_MAX * 2) held.origins.splice(0, held.origins.length - TURN_SOURCES_MAX * 2);
    promptShown.set(promptKey(threadId, botId), held);
  }
  return built.value;
}

/** Whether the copy index is filled, so a conversation can be carried as a range (turn-source-holds.ts). Once true, it stays true. */
let rangesReady = false;
function rangesUsable(): boolean {
  if (rangesReady) return true;
  try { rangesReady = turnSourceCopiesBackfilled(database()); } catch { rangesReady = false; }
  return rangesReady;
}

/** A turn's lineage as it begins in `threadId` for `botId`. Its sources are its own conversation, as a range up to the newest line now (every
 * line it can carry, however long the conversation: a resumed session holds far more than its window), the lines it is shown from other
 * conversations (`shown`), what a kept engine session already took in (`kept`), and what the prompts built for it quoted (`promptForTurn`).
 * `withheldNow` leaves out a line withheld when the turn began (it was carried as its withheld line, not its words). Without the range (a
 * conversation with no lines, or the copy index not filled yet), every line of `ownLines` is named instead. */
export function beginTurnLineage(input: {
  threadId: string; botId: string; roots: OutputRoots; instanceId: string; session?: string; generation: string; turn: TurnLineage; cursor?: string; incarnation?: number;
  shown: Iterable<ShownLine>; ownLines?: Iterable<ShownLine>; kept?: { sources?: ShownLine[] | "over"; ranges?: HeldRange[] };
  /** `ownLines` are not every line the turn can carry (a resumed session over a conversation longer than its window): without the range, the
   * turn's sources are then not established. */
  ownLinesIncomplete?: boolean;
  withheldNow: (line: ShownLine) => boolean;
}): RunningTurnLineage {
  const { threadId, botId } = input;
  const base = { roots: input.roots, instanceId: input.instanceId, botId, generation: input.generation, turn: input.turn, ...(input.session ? { session: input.session } : {}),
    ...(input.cursor ? { cursor: input.cursor } : {}), ...(input.incarnation !== undefined ? { incarnation: input.incarnation } : {}) };
  const pending = promptShown.get(promptKey(threadId, botId));
  promptShown.delete(promptKey(threadId, botId));
  if (input.kept?.sources === "over") return { ...base, sources: "over" };
  let own: HeldRange | undefined;
  try { own = rangesUsable() ? threadRangeNow(threadId) : undefined; } catch { own = undefined; }
  if (!own && input.ownLinesIncomplete) return { ...base, sources: "over" };
  const lines = [...(input.kept?.sources ?? []), ...input.shown, ...(own ? [] : [...(input.ownLines ?? [])])]
    // the turn's own conversation, up to now, is the range
    .filter(line => !own || line.threadId !== threadId);
  const sources = turnSources(lines, line => line.threadId === threadId && input.withheldNow(line));
  const lineage: RunningTurnLineage = { ...base, sources, ...(own ? { ranges: [own] } : {}) };
  // a kept session's ranges of other conversations still hold what it took in
  if (input.kept?.ranges?.length) addRangesToRunningTurn(lineage, input.kept.ranges.filter(range => range.threadId !== threadId));
  if (pending) addShownToRunningTurn(lineage, pending);
  return lineage;
}


/** The lines of one thread a turn's renderer showed as their withheld line (or left out). */
export interface RenderedWithheld { threadId: string; ids: ReadonlySet<string> }
/** The flat root set of the lines a turn's context showed. Owner and person lines never count, and a line the turn's own
 * renderer showed as its withheld line (`renderedWithheld`: the ids its replay or room filter replaced) carried none of its
 * words, so it brings no roots. Every other line was shown, whatever a check made now would say: the decision is the one the
 * prompt was built with, never a second judgement (1.0.2 lineage-cold r3: a recheck that ran out of allowance answered
 * "withheld" for a line already in the prompt, and the reply built on it was recorded with no roots at all).
 *
 * The roots are read within the allowance. A read it cannot pay for does not drop anything: the set is the shown lines
 * themselves (outputRootsShallow), and a reply resting on them is withheld exactly when one of them is.
 *
 * Owner and person lines of the turn's own thread (`threadId`, by default the renderer's) never count; given the turn's thread, a
 * line carried from another thread is a root whoever wrote it (1.0.2 revoke-bounded r3). */
export function shownLinesRoots(allowance: LineageAllowance, lines: ReadonlyArray<ShownLine>, renderedWithheld?: RenderedWithheld, threadId: string | undefined = renderedWithheld?.threadId): OutputRoots {
  const shown = lines.filter(line => (line.role !== "user" || (threadId !== undefined && line.threadId !== threadId)) && !(renderedWithheld && line.threadId === renderedWithheld.threadId && renderedWithheld.ids.has(line.id) && !line.quoted));
  try {
    const roots = outputRootsFor(allowance, shown, threadId);
    return roots.unproven ? outputRootsShallow(shown, threadId) : roots;
  } catch (error) {
    console.warn(`[memory] output lineage could not be read (${error instanceof Error ? error.message.slice(0, 80) : "error"}); this turn's replies are withheld from bots`);
    return { roots: new Set(), over: true };
  }
}

/** Roots shown to a running turn after it started: they join the turn's
 * replies (every later output) and its engine session. */
export function addRootsToRunningTurn(threadId: string, lineage: RunningTurnLineage | undefined, added: OutputRoots): void {
  if (!lineage) return;
  if (!added.over && !added.roots.size) return;
  lineage.roots = mergeOutputRoots(lineage.roots, added);
  if (lineage.session) {
    try { recordSessionRoots(threadId, lineage.instanceId, lineage.session, added); }
    catch (error) { console.warn(`[memory] session lineage not recorded (${error instanceof Error ? error.message.slice(0, 80) : "error"})`); }
  }
}

type SteerAdapter = Parameters<typeof steerBusyDesk>[0];

/** The write-time refs of a steer's quote (DESIGN-WRITETIME 2.2): the quoted line, and the originals of a quoted copy. A same-thread line is
 * positional (writeLineage carries nothing for it) but is listed, so the fence asks about it. */
export function quoteLineageRefs(quote: ShownLine | undefined): LineageRef[] {
  if (!quote) return [];
  const refs: LineageRef[] = [{ kind: "line", threadId: quote.threadId, messageId: quote.id }];
  if (quote.copyOf) for (const id of quote.copyOf.messageIds) refs.push({ kind: "line", threadId: quote.copyOf.threadId, messageId: id });
  return refs;
}

/** Whether the write-time verdict refuses a steer's quote: everything but a proven allow. Withheld refuses, and so does every "checking"
 * (no lineage, thread not ready, pending, a wide footprint, a lookup error): the steer then runs as its own turn, which renders the quote
 * again under its own lookups. */
export function steerQuoteRefused(verdict: LineageVerdict | undefined): boolean {
  return !verdict || !verdictShows(verdict);
}

/** Steers `text` into the running turn. `holds` is the session fence; `quote`
 * is the reply the text quotes, and `lineage` the running turn it joins (the
 * turn's entry when the steer started). The quote's roots are taken now, with
 * the text, and recorded right after the fence passes, before the write:
 * whatever the acknowledgement later says ("uncertain" included), the engine
 * may have the text. The fence also refuses when those roots no longer hold
 * (a source revoked or unprovable since the text was rendered, as while a
 * Claude steer waits for `init`): the text was rendered under the old
 * eligibility, so it is not written, and the line runs as its own turn, which
 * renders the quote again. A fence refusal writes nothing and records nothing. */
export function steerWithQuoteLineage(adapter: SteerAdapter, threadId: string, text: string, allowed: boolean, opts: {
  holds: () => boolean;
  steerId?: string;
  quote?: ShownLine;
  lineage: RunningTurnLineage | undefined;
  /** The running turn's write-time lineage (lineage-write.ts): the quote joins its parents inside the fence, never moving its turnLsn. */
  turn?: TurnLineage;
  /** Who the running turn answers (the fence asks the write-time read side for this reader). Content checks only when absent. */
  reader?: LineageReader;
  /** The engine's answer when it arrives after the response deadline. */
  onLate?: (delivery: SteerDelivery) => void;
  /** Run inside the write's fence, after every check passed and with no await before the write: the caller takes the receiving attempt here. */
  onFence?: () => void;
}): Promise<"steer" | "queue" | "uncertain"> {
  // the steer's own allowance: its quote is checked when it is rendered and again at the write boundary
  const allowance = LineageAllowance.steer();
  const quoted = opts.quote ? shownLinesRoots(allowance, [opts.quote]) : undefined;
  const refs = quoteLineageRefs(opts.quote);
  const reader = opts.reader ?? doorReader();
  // the steer's engine input: the owner's words and the quote (built outside the turn, so its refs join the turn only once the fence passed;
  // a prompt built outside a turn is always looked up again at the fence)
  const prompt = buildPrompt(undefined, [promptPart(text, [noneRef("owner-turn"), ...refs])]);
  return steerBusyDesk(adapter, threadId, prompt, allowed, () => {
    if (!opts.holds()) throw new Error("MEMORY_CONTEXT_REVOKED");
    if (quoted && outputRootsBad(allowance, quoted)) throw new Error("MEMORY_CONTEXT_REVOKED");
    if (refs.length) {
      // write-time: a quote with no running turn to carry it could never be revoked from what the turn writes next: refused
      if (!opts.turn) throw new Error("MEMORY_CONTEXT_REVOKED");
      // the quote is looked up at the write boundary; anything but a proven allow refuses (DESIGN-WRITETIME 3)
      let verdict: LineageVerdict | undefined;
      try { verdict = refsLookup(database(), refs, reader); }
      catch { verdict = undefined; }
      if (steerQuoteRefused(verdict)) throw new Error("MEMORY_CONTEXT_REVOKED");
    }
    if (quoted) addRootsToRunningTurn(threadId, opts.lineage, quoted);
    if (opts.quote) addSourcesToRunningTurn(opts.lineage, [opts.quote]);
    // a steer adds parents to the running turn (every later reply and its session carry them); it never moves the turn's turnLsn
    if (opts.turn && refs.length) addTurnParents(opts.turn, refs);
    opts.onFence?.();
  }, opts.steerId, undefined, opts.onLate, { reader }).finally(() => allowance.close());
}
