import { randomUUID } from "node:crypto";
import { createLabelStream, scanLabelDelta, type LabelStream } from "../shared/md-secret-label.mjs";
import { scanTurnText } from "./redact.ts";
import { A2_STREAM, A2_WHOLE, CONTEXT_LIMIT, LOST, ScanMeter, ScanLimit, checkTurnUnit, decide, openAfter, lfDecision, joinItems, certifyRelease, PROBES, type Scanner, type ChainContext, type CertifiedRelease, type ReleaseDecision } from "./redact-stream-release.ts";
export { checkTurnUnit } from "./redact-stream-release.ts";

// PROVISIONAL INTERFACE: F1/F2 are not in base contracts.ts (owned by 1B).
// These structural aliases keep the frozen F2 method/record shapes here until
// the collector owns their public declarations. Only its private allocator may
// call admit, exactly once for a fresh capability, after epoch validation.
// Provider strings must NEVER be cast into admissions or host stream keys.
export type TurnAdmission = Readonly<{ readonly __turnAdmission: unique symbol }>;
export type HostStreamKey = string;
export type ManifestPath = string;
export type HostEnvelope = Readonly<{ eventId: string; instanceId: string; threadId: string; generation: number; intakeOrdinal: number; createdAt: number }>;
export type TextCarrier = Readonly<{ path: ManifestPath; stream: HostStreamKey; mode: "delta" | "whole" | "snapshot"; text: string }>;
export type ManifestBatch = Readonly<{ envelope: HostEnvelope; variant: string; carriers: readonly TextCarrier[]; controls: Readonly<Record<string, unknown>>; terminal?: "complete" | "cancel" | "exit" }>;
export type SafeTextOperation = CertifiedRelease;
/** withheld: some text of this turn was withheld UNSCANNED (design 5.4 BLIND): the turn is not masked, yet its raw text is not proven clean. */
export type PolicyDecision = Readonly<{ masked: boolean; exhausted: boolean; operations: readonly SafeTextOperation[]; withheld?: boolean }>;
export interface TurnTextPolicy {
  admit(cap: TurnAdmission): void;
  consume(cap: TurnAdmission | undefined, batch: ManifestBatch): PolicyDecision;
  reset(cap: TurnAdmission | undefined, stream: HostStreamKey): PolicyDecision;
  finish(cap: TurnAdmission | undefined, how: "complete" | "cancel" | "exit"): PolicyDecision;
  retire(cap: TurnAdmission): void;
}
// cause22-E (b): no live-turn, pending, stream, scalar, node or fixed work limit decides what is shown (designs/REDACT-AUDIENCE-1021.md
// T1-T3, T5-T8). The field table (retainedStreams/globalStreams) stays until the next build step (T4).
export const TURN_TEXT_LIMITS = Object.freeze({ retainedStreams: 2048, globalStreams: 4096 });
const MARKER = "«redacted»";
// back: unreleased text of this item the engine took back (retract), one piece per take-back, since the item's last release.
type Stream = { path: string; key: string; region: string; revision: number; scanner: LabelStream; pending: string; lfEnd: number; wordEnd: number; emitted: string | undefined; started: boolean; completed: boolean; snapshot?: string; queued: number; target?: Target; d: number; decisions: number; deferred: boolean; resume?: { end: number; partial: string }; back?: string[]; pieces?: string[] };
// alts: other open ways to read what precedes the chain's next item: tails that hold text an item took back (complete). `context` is
// always what the audience was shown.
type Target = { items: Stream[]; last?: string; context: ChainContext; blind?: boolean; alts?: string[] };
/** How many take-backs one item, and open alternative tails one chain, may carry. Past it the turn fails closed. */
const BACK_PIECES = 8, ALT_TAILS = 4;
// shed: keys of released fields a full table let go (see letGo). A let-go key is never treated as a fresh field.
// blind: stream keys of a BLIND chain that already carry their one marker. withheld: the turn holds unscanned withheld text.
type Turn = { streams: Map<string, Stream>; targets: Map<string, Target>; pending: number; history: number; shed: Set<string>; blind: Set<string>; withheld: boolean };
/** How many let-go keys one turn remembers. Past it nothing more is let go: a new field is then withheld alone. */
const SHED_KEYS = 16_384;
export type TurnTextPolicyOptions = { separateItemRegions?: boolean; contextFor?: (cap: TurnAdmission, target: string) => ChainContext; traceDecision?: (event: Readonly<{ stream: string; size: number; runningMax: number }>) => void; scan?: Scanner; streamAllowance?: number; wholeAllowance?: number; contexts?: Readonly<Record<string, ChainContext>> };
const decision = (masked: boolean, exhausted: boolean, operations: SafeTextOperation[] = [], withheld = false): PolicyDecision => Object.freeze({ masked, exhausted, operations: Object.freeze(operations.map(o => Object.freeze(o))), ...(withheld ? { withheld } : {}) });
const chainOf = (stream: string) => /(?:^|:)(assistant|reasoning)$/.exec(stream)?.[1] ?? "other";
const unscannable = (error: unknown) => error instanceof ScanLimit && error.outcome === "FC-SCAN";
const data = (o: object, key: string): unknown => Object.getOwnPropertyDescriptor(o, key)?.value;
class Latch extends Error {}

/** Admission-scoped state. No raw text or tombstones survive retire. Siblings
 * are staged atomically: a latch discards every operation of that consume. */
export function createTurnTextPolicy(options: TurnTextPolicyOptions = {}) {
  const incarnation = randomUUID(), clean = new Map<TurnAdmission, Turn>();
  const scanner = options.scan ?? scanTurnText;
  let streamCount = 0, units = 0;
  let a2Work = 0, a2WholeWork = 0, a2Decisions = 0, a2Deferred = 0, a2ScanExhausted = 0;
  const get = (cap: TurnAdmission | undefined) => cap ? clean.get(cap) : undefined;
  const entries = (t: Turn) => new Set([...t.streams.values(), ...[...t.targets.values()].flatMap(target => target.items)]);
  const retire = (cap: TurnAdmission | undefined) => { const t = get(cap); if (t && cap) { streamCount -= entries(t).size; clean.delete(cap); } };
  const region = (key: string, b: ManifestBatch) => `r.${incarnation}.${b.envelope.instanceId}.${b.envelope.threadId}.${b.envelope.generation}.${key}`;
  const op = (s: Stream, value: string, kind: "append" | "replace" = "append", speech: "append" | "none" = "append"): SafeTextOperation => certifyRelease({ path: s.path, stream: s.key, regionId: s.region, revision: ++s.revision, op: kind, text: value, speech });
  const omit = (): SafeTextOperation => certifyRelease({ path: "omission", stream: "omission", regionId: "omission", revision: 0, op: "omit", text: MARKER, speech: "none" });
  const mask = (cap: TurnAdmission | undefined, carriers: readonly TextCarrier[], b?: ManifestBatch, exhausted = false): PolicyDecision => {
    const t = get(cap), operations: SafeTextOperation[] = [], seen = new Set<string>();
    if (exhausted) { retire(cap); return decision(true, true, [omit()]); }
    if (t) for (const target of t.targets.values()) for (const s of target.items) if (s.pending || s.snapshot) { operations.push(op(s, MARKER, "append", "none")); seen.add(s.key); }
    if (b) for (const c of carriers) if (!seen.has(c.stream)) {
      seen.add(c.stream);
      operations.push(certifyRelease({ path: c.path, stream: c.stream, regionId: region(c.stream, b), revision: 0, op: "omit", text: MARKER, speech: "none" }));
    }
    retire(cap); return decision(true, false, operations);
  };
  const checked = (value: string, budget: { left: number }) => {
    let r;
    try { r = checkTurnUnit(value, budget.left, scanner); } catch { throw new ScanLimit("FC-SCAN"); }
    units += r.workUnits;
    if (r.exhausted) throw new ScanLimit("FC-SCAN");
    if (r.detected) throw new Latch();
  };
  // A long clean turn stays shown (owner rule, 1.0.20). The field table (retainedStreams per turn, globalStreams for
  // the process) used to end the turn's display when it filled: an engine whose tool results are records (an ACP
  // rawOutput object: two fields per leaf) filled it in a few dozen steps and every later row and the reply read
  // «redacted». Now the table lets go of this turn's OLDEST released entry (a whole field, or a text item that
  // completed) to seat the newest. Its key is remembered: if the engine writes that key again, the new value can
  // no longer be joined to the old one for the scan, so that one field is withheld alone (the makeRoom rule).
  // Nothing unreleased is ever let go: an open text item keeps its place.
  const letGo = (t: Turn, keep: ReadonlySet<Stream>): boolean => {
    if (t.shed.size >= SHED_KEYS) return false;
    for (const [key, old] of t.streams) {
      if (keep.has(old) || (old.target && !old.completed) || old.pending || old.snapshot !== undefined) continue;
      t.streams.delete(key); t.shed.add(key); streamCount--; t.history -= old.emitted?.length ?? 0;
      return true;
    }
    return false;
  };
  // This turn's table is full: its own oldest goes. Only the process table is full (other long turns hold it): the
  // turn holding the most lets go, so a turn that has just started is still seated.
  const NONE: ReadonlySet<Stream> = new Set();
  const seat = (t: Turn, keep: ReadonlySet<Stream>): boolean => {
    if (t.streams.size >= TURN_TEXT_LIMITS.retainedStreams) return letGo(t, keep);
    let most = t;
    for (const other of clean.values()) if (other.streams.size > most.streams.size) most = other;
    return (most !== t && letGo(most, NONE)) || letGo(t, keep);
  };
  const remember = (t: Turn, s: Stream, value: string, replace = false) => {
    if (replace) { t.history -= s.emitted?.length ?? 0; s.emitted = ""; }
    // cause22-E (b) T10: a field's released history is kept for the life of the turn (no size drop), so a rewrite or a
    // completion is always joined to what was shown. Only a let-go field (letGo, T4) has none.
    if (s.emitted !== undefined) { s.emitted += value; t.history += value.length; }
  };
  const release = (t: Turn, s: Stream, text: string, out: SafeTextOperation[], replace = false) => {
    if (text || replace) {
      // Region-based consumers already carry item boundaries. Their local text
      // excludes the separator used only to concatenate a flat display stream;
      // context(s)/complete still scan the identical cross-item chain.
      const shown = s.target && !s.started && !options.separateItemRegions ? joinItems("", text, s.target.last) : text;
      out.push(op(s, shown, replace ? "replace" : "append", replace ? "none" : "append"));
      if (s.target && shown) s.target.last = shown.at(-1);
      s.started = true;
    }
    remember(t, s, text, replace);
  };
  const drop = (t: Turn, s: Stream, n: number) => {
    s.pending = s.pending.slice(n); t.pending -= n;
    s.lfEnd = Math.max(0, s.lfEnd - n); s.wordEnd = Math.max(0, s.wordEnd - n);
  };
  // SAFETY FLOOR (MAIN-RULING 2026-11-22T17:47:36Z + 17:58:19Z Q2, design 5.4): a unit of this chain could not be scanned, so
  // nothing later in the chain can be proven clean (a label masks to the end of the text). The chain goes BLIND: its open
  // items are withheld under one marker each, later items of the chain get one marker each (consume), and every other
  // chain, field and control event of the turn keeps flowing. Nothing unscanned is released; the turn is not masked.
  const marker = (path: string, key: string, regionId: string, revision: number) => certifyRelease({ path, stream: key, regionId, revision, op: "append", text: MARKER, speech: "none" });
  const blind = (t: Turn, target: Target, out: SafeTextOperation[]) => {
    target.blind = true; target.context = LOST; target.alts = undefined; t.withheld = true;
    for (const s of target.items) {
      if (!t.blind.has(s.key)) { t.blind.add(s.key); out.push(marker(s.path, s.key, s.region, ++s.revision)); }
      t.pending -= s.pending.length + s.queued; s.pending = ""; s.queued = 0; s.snapshot = undefined; s.completed = true; s.deferred = false; s.resume = undefined;
      s.scanner = createLabelStream({ turn: true }); // nothing of the withheld text is left to retract: a later content.reset is not a finding
      if (t.streams.get(s.key) !== s) streamCount--;
    }
    target.items.length = 0;
  };
  const context = (s: Stream) => {
    const ctx = s.target?.context ?? "";
    if (ctx === LOST) throw new Latch();
    return ctx;
  };
  const eligible = (s: Stream) => !s.target || s.target.items[0] === s;
  // 1.0.22 withheld (field gate): an engine takes back text it streamed and sends other text in its place: a retry or a compaction
  // that voids the attempt (content.reset: ACP resetForRetry/discardForRetry, pi), or a resent stream whose completed message is
  // not what streamed before it (Claude: a stream cut by an expired login or an API retry, then the resend). The taken-back text
  // that was still unreleased (an unfinished last line) was never shown. That used to latch the turn as if its words held a
  // secret, and every later message of the turn was withheld. It is not a finding by itself. The text is scanned here (a hit in
  // it still latches) and is never released. What the audience was shown is untouched (the chain context), so the text before
  // and after the take-back is still scanned side by side; the taken-back text is kept with its item (back) and every later
  // unit of the item is ALSO scanned as if that text were still there: as the line before it, and joined raw (views, rawJoin).
  // So a label or value split across a take-back latches exactly as it would have with no take-back.
  const retract = (t: Turn, s: Stream, meter: ScanMeter) => {
    const gone = s.pending, back = s.back ?? [], pieces = s.pieces ?? [];
    if (!s.target || pieces.length >= BACK_PIECES || gone.length + pieces.reduce((n, g) => n + g.length, 0) > CONTEXT_LIMIT) throw new Latch();
    // ASTRA 4ee6745319: two take-backs can split a label (`pa`, reset, `ss`, reset, `word=`): every run of consecutive pieces ending in
    // this one (`ss`, `pass`) is a reading of its own, so `back` holds every contiguous run of the item's pieces.
    const runs = pieces.map((_, i) => pieces.slice(i).join("") + gone).concat(gone);
    for (const run of runs) if (!meter.clean(run)) throw new Latch();
    // the head of its chain is also read with what precedes it (an item behind the head is, when its turn comes: views)
    if (eligible(s)) for (const c of views(s)) for (const run of runs) if (c && !meter.clean(joinItems(c, run))) throw new Latch();
    drop(t, s, gone.length); t.pending -= s.queued; s.queued = 0; s.resume = undefined; s.deferred = false;
    s.scanner = createLabelStream({ turn: true });
    s.back = [...back, ...runs]; s.pieces = [...pieces, gone];
  };
  /** Every way the text before this item's next unit can be read: what was shown (first), the chain's open alternative tails, and
   * each of them followed by a piece this item took back. */
  const views = (s: Stream): string[] => {
    const shown = [context(s), ...(s.target?.alts ?? [])];
    return [...shown, ...(s.back ?? []).flatMap(g => shown.map(c => c ? joinItems(c, g) : g))];
  };
  /** A unit read as the same line as a taken-back piece (no separator), alone and after each shown reading (context, alts), with
   * the release probes. ASTRA 28cd6b9151: a value can start in the shown context (`my password:`), go on in the piece and end in U. */
  const rawJoin = (s: Stream, U: string, partial: string, meter: ScanMeter): ReleaseDecision => {
    let result: ReleaseDecision = "RELEASE";
    const shown = ["", context(s), ...(s.target?.alts ?? [])];
    for (const g of s.back ?? []) for (const c of shown) {
      const raw = (c ? joinItems(c, g) : g) + U + partial;
      if (!meter.clean(raw)) return partial === "" || meter.clean(partial) ? "LATCH" : "HOLD";
      for (const probe of PROBES) if (!meter.clean(raw + probe)) result = "HOLD";
    }
    return result;
  };
  /** Scan allowance the extra readings of this item need (design 5.3: the allowance follows the text offered). */
  const extra = (s: Stream) => { const c = s.target?.context; return (typeof c === "string" ? c.length : 0) + (s.target?.alts ?? []).reduce((n, a) => n + a.length, 0) + (s.back ?? []).reduce((n, g) => n + g.length, 0); };
  /** The same for every item of the turn that carries a take-back, per reading (views, rawJoin). */
  const grantReadings = (t: Turn, meter: ScanMeter, incoming: number) => {
    for (const target of t.targets.values()) for (const s of target.items) if (s.back || target.alts) {
      const readings = (1 + (target.alts?.length ?? 0)) * (1 + 3 * (s.back?.length ?? 0)) + (s.back?.length ?? 0);
      meter.grant(readings * (s.pending.length + (s.snapshot?.length ?? 0) + incoming + extra(s)));
    }
  };
  const settled = (s: Stream) => { s.back = undefined; s.pieces = undefined; if (s.target) s.target.alts = undefined; };
  const decideAt = (t: Turn, s: Stream, end: number, partial: string, meter: ScanMeter, out: SafeTextOperation[]) => {
    const ctx = context(s), U = s.pending.slice(0, end);
    let result;
    try {
      result = decide(U, partial, meter, ctx);
      // after a take-back (retract): every other reading must release it too; any LATCH latches, any HOLD holds
      if (result !== "LATCH" && (s.back || s.target?.alts)) {
        for (const other of [...views(s).slice(1).map(c => decide(U, partial, meter, c)), rawJoin(s, U, partial, meter)]) {
          if (other === "LATCH") { result = other; break; }
          if (other === "HOLD") result = other;
        }
      }
    }
    catch (error) {
      if (error instanceof ScanLimit && error.outcome === "DEFER") s.resume ??= { end, partial };
      throw error;
    }
    s.resume = undefined;
    s.d = Math.max(s.d, ctx.length + U.length); s.decisions++; a2Decisions++;
    options.traceDecision?.(Object.freeze({ stream: s.key, size: ctx.length + U.length, runningMax: s.d }));
    if (result === "LATCH") throw new Latch();
    if (result === "RELEASE") { release(t, s, U, out); drop(t, s, end); if (s.target) s.target.context = ""; settled(s); }
  };
  const complete = (t: Turn, s: Stream, meter: ScanMeter, out: SafeTextOperation[]) => {
    const snapshot = s.snapshot;
    let rest = s.pending, replace = false;
    if (snapshot !== undefined) {
      // A long item's released history was let go (remember: past CONTEXT_LIMIT). Its unfinished last line is still pending: when the
      // snapshot ends with it, only that line is left to check, with the same context as any completion. A clean long brief used to
      // latch here as if its words held a secret, and the owner's every later message in the turn was withheld (1.0.21 withheld).
      if (s.emitted === undefined) {
        if (!s.pending) { rest = snapshot; replace = true; }
        else if (!snapshot.endsWith(s.pending)) throw new Latch();
      }
      else if (snapshot.startsWith(s.emitted + s.pending)) rest = snapshot.slice(s.emitted.length);
      // The completed message is not what streamed (a resent stream): the streamed unfinished line is taken back (retract) and
      // the message replaces what was shown. It is scanned whole below, with the taken-back text as its context.
      else { if (s.pending) retract(t, s, meter); rest = snapshot; replace = true; }
    }
    const ctx = context(s), tail = ctx ? joinItems(ctx, rest) : rest;
    // Compute everything before committing: a partial scan can defer this
    // unit without having released or cleared a byte.
    if (!meter.clean(tail)) throw new Latch();
    const last = rest.at(-1) ?? s.target?.last;
    const open = openAfter(tail, last, meter);
    // after a take-back (retract): the completed text is also read every other way; a reading left open stays with the chain
    const alts: string[] = [];
    if (s.back || s.target?.alts) {
      if (rawJoin(s, rest, "", meter) === "LATCH") throw new Latch();
      for (const c of views(s).slice(1)) {
        const other = c ? joinItems(c, rest) : rest;
        if (!meter.clean(other)) throw new Latch();
        if (other !== tail && !alts.includes(other) && openAfter(other, last, meter)) alts.push(other);
      }
      // ASTRA 0b17e1b5a1: the raw join (a taken-back piece and this text as one line, after each shown reading) is a reading too. A
      // label it leaves open (`pass` taken back, `word=` completed) stays with the chain, so the value in its next item is caught.
      for (const g of s.back ?? []) for (const c of [context(s), ...(s.target?.alts ?? [])]) {
        const raw = (c ? joinItems(c, g) : g) + rest;
        if (!meter.clean(raw)) throw new Latch();
        if (raw !== tail && !alts.includes(raw) && openAfter(raw, last, meter)) alts.push(raw);
      }
      if (alts.length > ALT_TAILS || alts.some(a => a.length > CONTEXT_LIMIT)) throw new Latch();
    }
    release(t, s, rest, out, replace);
    drop(t, s, s.pending.length); t.pending -= s.queued; s.queued = 0; s.snapshot = undefined; s.completed = true; s.deferred = false; s.resume = undefined;
    if (s.target) {
      s.target.context = open ? tail : "";
      s.target.items.shift();
    }
    settled(s);
    if (s.target && alts.length) s.target.alts = alts;
    s.scanner = createLabelStream({ turn: true });
    if (t.streams.get(s.key) !== s) {
      // A later carrier can have opened the next item while this completion
      // was deferred. Its predecessor is no longer retained by either queue.
      streamCount--; t.history -= s.emitted?.length ?? 0; s.emitted = undefined;
    }
  };
  const held = (t: Turn, s: Stream, meter: ScanMeter, out: SafeTextOperation[]) => {
    if (!eligible(s)) return;
    if (s.snapshot !== undefined) { complete(t, s, meter, out); return; }
    let cursor = 0, endAlreadyChecked = false;
    if (s.resume) {
      const unit = s.resume, before = s.pending.length;
      endAlreadyChecked = unit.end === s.lfEnd && unit.partial === s.pending.slice(s.lfEnd, s.wordEnd);
      decideAt(t, s, unit.end, unit.partial, meter, out);
      cursor = Math.max(0, unit.end - (before - s.pending.length));
    }
    for (let nl = s.pending.indexOf("\n", cursor); nl >= 0;) {
      const next = s.pending.indexOf("\n", nl + 1), size = context(s).length + nl + 1;
      if (lfDecision(size, s.d, (next < 0 ? s.pending.length : next + 1) > CONTEXT_LIMIT, next < 0)) {
        const before = s.pending.length;
        decideAt(t, s, nl + 1, "", meter, out);
        nl -= before - s.pending.length;
      }
      nl = s.pending.indexOf("\n", nl + 1);
    }
    const end = s.lfEnd, wordEnd = Math.max(0, s.wordEnd - end);
    if (!endAlreadyChecked && end && wordEnd && end + wordEnd <= 256) decideAt(t, s, end, s.pending.slice(end, s.wordEnd), meter, out);
    s.deferred = false;
  };
  const api = {
    admit(cap: TurnAdmission) { if (!clean.has(cap)) clean.set(cap, { streams: new Map(), targets: new Map(), pending: 0, history: 0, shed: new Set(), blind: new Set(), withheld: false }); },
    retire,
    consume(cap: TurnAdmission | undefined, batch: ManifestBatch): PolicyDecision {
      const t = get(cap), carriers: TextCarrier[] = [], budget = { left: Number.POSITIVE_INFINITY };
      const meter = new ScanMeter(options.streamAllowance ?? A2_STREAM, scanner), whole = new ScanMeter(options.wholeAllowance ?? A2_WHOLE, scanner);
      a2Work = a2WholeWork = a2Decisions = a2Deferred = a2ScanExhausted = 0;
      const operations: SafeTextOperation[] = [];
      let deferred = false;
      const run = (s: Stream, fn: () => void, unit?: { end: number; partial: string }) => {
        if (deferred || !eligible(s)) { s.deferred = true; s.resume ??= unit; return; }
        try { fn(); } catch (error) {
          if (unscannable(error) && s.target) { blind(t!, s.target, operations); return; }
          if (!(error instanceof ScanLimit) || error.outcome !== "DEFER") throw error;
          deferred = true; s.deferred = true; a2Deferred++;
        }
      };
      try {
        const list = data(batch, "carriers");
        if (!Array.isArray(list)) throw new Error("carrier");
        for (let i = 0; i < list.length; i++) {
          const c = data(list, String(i)); if (!c || typeof c !== "object") throw new Error("carrier");
          const path = data(c, "path"), stream = data(c, "stream"), mode = data(c, "mode"), text = data(c, "text");
          if (typeof path !== "string" || typeof stream !== "string" || typeof text !== "string" || !["delta", "whole", "snapshot"].includes(mode as string) || path.length > 1024 || stream.length > 1024) throw new Error("carrier");
          units += text.length + 16;
          carriers.push({ path, stream, mode: mode as TextCarrier["mode"], text });
        }
        if (!t) return mask(cap, carriers, batch);
        // An explicit allowance (tests) is fixed; the default allowance is a rate (design 5.3), so size never reaches it.
        // 5.3 counts the new carriers, what is resumed (pending text, a waiting completion) and their contexts. Text already
        // released (`emitted`) is never scanned on this meter, so it buys no work here: with it in the grant one held line re-decided
        // at every LF past CONTEXT_LIMIT cost work and decisions in proportion to the turn's whole history, not to the new text.
        if (options.streamAllowance === undefined) meter.grant(t.pending + carriers.reduce((n, c) => n + c.text.length, 0) + [...t.targets.values()].reduce((n, target) => n + (target.context === LOST ? 0 : target.context.length) + target.items.reduce((m, s) => m + (s.snapshot?.length ?? 0), 0), 0));
        if (options.streamAllowance === undefined) grantReadings(t, meter, carriers.reduce((n, c) => n + c.text.length, 0));
        if (options.wholeAllowance === undefined) whole.grant(carriers.reduce((n, c) => n + (c.mode === "whole" ? c.text.length + (t.streams.get(c.stream)?.emitted?.length ?? 0) : 0), 0));
        for (const target of t.targets.values()) for (const s of target.items) { s.d = 0; s.decisions = 0; }
        // Only previously deferred/serialized work resumes here; ordinary
        // pending items get their next decision from their own carrier.
        for (const target of t.targets.values()) {
          while (target.items[0]?.deferred && !deferred) {
            const s = target.items[0];
            run(s, () => held(t, s, meter, operations));
            if (!s.completed) break;
          }
        }
        // Precompute per-item lookahead in one reverse pass. A completion is
        // a barrier; repeated scans/joins of the remaining carrier list would
        // make a batch of tiny deltas quadratic outside the scanner meter.
        const ahead = new Map<string, { length: number; firstLF: number }>();
        const future: { length: number; firstLF: number }[] = [];
        for (let i = carriers.length - 1; i >= 0; i--) {
          const c = carriers[i], tail = ahead.get(c.stream) ?? { length: 0, firstLF: -1 };
          future[i] = tail;
          if (c.mode !== "delta") { ahead.delete(c.stream); continue; }
          const lf = c.text.indexOf("\n");
          ahead.set(c.stream, { length: c.text.length + tail.length, firstLF: lf >= 0 ? lf : tail.firstLF < 0 ? -1 : c.text.length + tail.firstLF });
        }
        const touched = new Set<Stream>();
        for (let ci = 0; ci < carriers.length; ci++) {
          const c = carriers[ci]; let s = t.streams.get(c.stream);
          const previous = s;
          // A let-go key written again, or a table with nothing left to let go: this one carrier is withheld alone.
          // Its own words are still checked first, so a hit in them latches the turn as before.
          const alone = () => { try { checked(c.text, budget); } catch (error) { if (!unscannable(error)) throw error; t.withheld = true; } operations.push(certifyRelease({ path: c.path, stream: c.stream, regionId: region(c.stream, batch), revision: 0, op: "omit", text: MARKER, speech: "none" })); };
          if (!s && t.shed.has(c.stream)) { alone(); continue; }
          // A later item (or later text) of a BLIND chain: one marker for its region, nothing else (design 5.4).
          if (c.mode !== "whole" && t.targets.get(chainOf(c.stream))?.blind) {
            if (!t.blind.has(c.stream)) { t.blind.add(c.stream); operations.push(marker(c.path, c.stream, s?.region ?? region(c.stream, batch), (s?.revision ?? 0) + 1)); }
            continue;
          }
          if (!s || ((s.completed || s.snapshot !== undefined) && c.mode !== "whole")) {
            const addsEntry = !previous || !previous.completed;
            if (addsEntry && (t.streams.size >= TURN_TEXT_LIMITS.retainedStreams || streamCount >= TURN_TEXT_LIMITS.globalStreams) && !seat(t, touched)) { alone(); continue; }
            if (addsEntry && (t.streams.size >= TURN_TEXT_LIMITS.retainedStreams || streamCount >= TURN_TEXT_LIMITS.globalStreams)) throw new Error("stream budget");
            let target: Target | undefined;
            if (c.mode !== "whole") {
              const name = chainOf(c.stream);
              target = t.targets.get(name);
              if (!target) { target = { items: [], context: options.contextFor?.(cap!, name) ?? options.contexts?.[name] ?? "" }; t.targets.set(name, target); }
            }
            s = { path: c.path, key: c.stream, region: previous?.region ?? region(c.stream, batch), revision: previous?.revision ?? 0, scanner: createLabelStream({ turn: true }), pending: "", lfEnd: 0, wordEnd: 0, emitted: "", started: false, completed: false, queued: 0, target, d: 0, decisions: 0, deferred: false };
            if (addsEntry) streamCount++;
            else t.history -= previous.emitted?.length ?? 0;
            t.streams.set(c.stream, s); target?.items.push(s);
          }
          s.path = c.path; touched.add(s);
          if (c.mode === "whole") {
            // UNREDACTABLE whole field (design 5.5): this field alone is withheld; it has no later text, so nothing else is.
            try { checked(c.text, budget); if (s.emitted !== undefined && !whole.clean(s.emitted + c.text)) throw new Latch(); }
            catch (error) {
              if (!(error instanceof ScanLimit)) throw error;
              t.withheld = true; t.history -= s.emitted?.length ?? 0; s.emitted = undefined;
            }
            // This field's earlier value can no longer be joined to the new one for the scan (its history
            // made room, or was too long to keep). The join is not provably clean, so THIS field is
            // withheld alone; the rest of the turn stays shown. A hit in the new value latched above.
            if (s.emitted === undefined) { operations.push(certifyRelease({ path: s.path, stream: s.key, regionId: s.region, revision: ++s.revision, op: "omit", text: MARKER, speech: "none" })); continue; }
            release(t, s, c.text, operations);
            // A whole field is shown as its newest value; its earlier values are kept only as the context the next rewrite is
            // joined to for the scan (a secret split across rewrites). Keeping all of it would make N rewrites cost N*N scan
            // work, so past CONTEXT_LIMIT only the last CONTEXT_LIMIT characters are kept, and only when what was shown is
            // closed at its end (no continuation can complete a label or secret that began earlier: the same probes a release
            // uses). An open history cannot be shortened safely: it is let go, and the next rewrite of this field is
            // withheld alone (the rule before this build for any history that did not fit). DECISIONS D-b2.
            if (s.emitted !== undefined && s.emitted.length > CONTEXT_LIMIT) {
              let open = true;
              try { open = openAfter(s.emitted, s.emitted.at(-1), whole); } catch (error) { if (!(error instanceof ScanLimit)) throw error; }
              t.history -= s.emitted.length - (open ? 0 : CONTEXT_LIMIT);
              s.emitted = open ? undefined : s.emitted.slice(-CONTEXT_LIMIT);
            }
            continue;
          }
          if (c.mode === "snapshot") {
            // A completion that repeats what this open item already streamed adds no unscanned byte before `complete` (every
            // released chunk was scanned with its context and probes; the rest is scanned there), so it is not scanned twice.
            const repeats = s === previous && s.emitted !== undefined && c.text.startsWith(s.emitted + s.pending);
            try { if (!repeats) checked(c.text, budget); } catch (error) { if (!unscannable(error)) throw error; blind(t, s.target!, operations); continue; }
            const prior = previous?.completed ? previous.emitted : previous?.snapshot;
            s.snapshot = prior !== undefined && c.text.startsWith(prior) ? c.text.slice(prior.length) : c.text;
            run(s, () => complete(t, s!, meter, operations));
            if (!s.completed) {
              s.deferred = true;
              t.pending -= s.queued;
              s.queued = Math.max(0, s.snapshot!.length - (s.emitted?.length ?? 0) - s.pending.length);
              t.pending += s.queued;
            }
            continue;
          }
          // Look ahead to this item's last LF in the consume. The running max
          // persists across carriers and releases, and resets only per consume.
          for (let at = 0; at < c.text.length;) {
            const nl = c.text.indexOf("\n", at), end = nl < 0 ? c.text.length : nl + 1, part = c.text.slice(at, end);
            units += part.length;
            if (s.completed) break; // its chain went BLIND inside this carrier
            if (scanLabelDelta(s.scanner, part) >= 0) throw new Latch();
            const before = s.pending.length;
            s.pending += part; t.pending += part.length;
            if (nl < 0) {
              const wordEnd = Math.max(part.lastIndexOf(" "), part.lastIndexOf("\t")) + 1;
              if (wordEnd) s.wordEnd = before + wordEnd;
            }
            if (nl >= 0) {
              s.lfEnd = s.pending.length; s.wordEnd = 0;
              const tail = future[ci], nextHere = c.text.indexOf("\n", end);
              const remaining = c.text.length - end + tail.length;
              const next = nextHere >= 0 ? nextHere - end : tail.firstLF < 0 ? -1 : c.text.length - end + tail.firstLF;
              const ctx = eligible(s) ? context(s) : "";
              if (lfDecision(ctx.length + s.pending.length, s.d, s.pending.length + (next < 0 ? remaining : next + 1) > CONTEXT_LIMIT, next < 0)) run(s, () => decideAt(t, s!, s!.pending.length, "", meter, operations), { end: s.pending.length, partial: "" });
            }
            at = end;
          }
          if (!eligible(s)) s.deferred = true;
        }
        for (const s of touched) if (!s.completed && s.snapshot === undefined && s.target) {
          const end = s.lfEnd, wordEnd = Math.max(0, s.wordEnd - end);
          if (end && wordEnd && end + wordEnd <= 256) run(s, () => decideAt(t, s, end, s.pending.slice(end, s.wordEnd), meter, operations), { end, partial: s.pending.slice(end, s.wordEnd) });
        }
        if (batch.terminal) {
          const tail = api.finish(cap, batch.terminal);
          if (tail.masked || batch.terminal === "cancel") return tail;
          return decision(false, false, [...operations, ...tail.operations], t.withheld);
        }
        return decision(false, false, operations, t.withheld);
      } catch (error) { return mask(cap, carriers, batch, !(error instanceof Latch || error instanceof ScanLimit && error.outcome === "FC-SCAN")); }
      finally { a2Work = meter.work; a2WholeWork = whole.work; a2ScanExhausted = meter.scanExhausted + whole.scanExhausted; }
    },
    reset(cap: TurnAdmission | undefined, key: string): PolicyDecision {
      const t = get(cap); if (!t) return decision(true, false);
      const s = t.streams.get(key);
      // An open item's unfinished text is taken back (retract): scanned, never shown, kept as the context of what follows.
      if (s?.pending && s.snapshot === undefined && !s.completed) {
        const meter = new ScanMeter(options.streamAllowance ?? A2_STREAM, scanner);
        if (options.streamAllowance === undefined) meter.grant((2 + BACK_PIECES + ALT_TAILS) * (2 + (s.pieces?.length ?? 0)) * (1 + (s.back?.length ?? 0)) * (s.pending.length + extra(s)));
        try { retract(t, s, meter); } catch { return mask(cap, [], undefined); }
      }
      else if (s?.pending || s?.scanner.len || s?.snapshot !== undefined) return mask(cap, [], undefined);
      // A reset retracts delivered bytes; retain the scanner and cross-item context.
      if (s) remember(t, s, "", true);
      return decision(false, false);
    },
    finish(cap: TurnAdmission | undefined, how: "complete" | "cancel" | "exit"): PolicyDecision {
      const t = get(cap); if (!t) return decision(true, false);
      if (how === "cancel") { retire(cap); return decision(false, false); }
      const meter = new ScanMeter(options.streamAllowance ?? A2_STREAM, scanner);
      if (options.streamAllowance === undefined) meter.grant(t.pending + [...t.targets.values()].reduce((n, target) => n + (target.context === LOST ? 0 : target.context.length) + target.items.reduce((m, s) => m + (s.snapshot?.length ?? 0) + (s.emitted?.length ?? 0), 0), 0));
      if (options.streamAllowance === undefined) grantReadings(t, meter, 0);
      a2Decisions = a2Deferred = a2WholeWork = 0;
      try {
        const operations: SafeTextOperation[] = [];
        for (const target of t.targets.values()) while (target.items.length) {
          // The allowance covers everything pending (design 5.3), so a unit that cannot be scanned here is UNREDACTABLE.
          try { complete(t, target.items[0], meter, operations); } catch (error) { if (!(error instanceof ScanLimit)) throw error; blind(t, target, operations); }
        }
        retire(cap); return decision(false, false, operations, t.withheld);
      } catch (error) { return mask(cap, [], undefined, !(error instanceof Latch || error instanceof ScanLimit && error.outcome === "FC-SCAN")); }
      finally { a2Work = meter.work; a2ScanExhausted = meter.scanExhausted; }
    },
    stats() {
      let pending = 0; for (const t of clean.values()) pending += t.pending;
      return Object.freeze({ clean: clean.size, streams: streamCount, pending, units, a2Work, a2WholeWork, a2Decisions, a2Deferred, a2ScanExhausted });
    },
  };
  return api;
}
