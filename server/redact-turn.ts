import { randomUUID } from "node:crypto";
import { createLabelStream, scanLabelDelta, SECRET_SCAN_BUDGET, type LabelStream } from "../shared/md-secret-label.mjs";
import { scanTurnText } from "./redact.ts";
import { A2_STREAM, A2_WHOLE, CONTEXT_LIMIT, LOST, ScanMeter, ScanLimit, checkTurnUnit, decide, openAfter, lfDecision, joinItems, certifyRelease, type Scanner, type ChainContext, type CertifiedRelease } from "./redact-stream-release.ts";
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
export type PolicyDecision = Readonly<{ masked: boolean; exhausted: boolean; operations: readonly SafeTextOperation[] }>;
export interface TurnTextPolicy {
  admit(cap: TurnAdmission): void;
  consume(cap: TurnAdmission | undefined, batch: ManifestBatch): PolicyDecision;
  reset(cap: TurnAdmission | undefined, stream: HostStreamKey): PolicyDecision;
  finish(cap: TurnAdmission | undefined, how: "complete" | "cancel" | "exit"): PolicyDecision;
  retire(cap: TurnAdmission): void;
}
export const TURN_TEXT_LIMITS = Object.freeze({ clean: 256, pending: 65_536, streams: 64, globalStreams: 4096, scalarUnits: 262_144, nodes: 20_000, depth: 40, keyUnits: 1024, work: SECRET_SCAN_BUDGET });
const MARKER = "«redacted»";
type Stream = { path: string; key: string; region: string; revision: number; scanner: LabelStream; pending: string; lfEnd: number; wordEnd: number; emitted: string | undefined; started: boolean; completed: boolean; snapshot?: string; queued: number; target?: Target; d: number; decisions: number; deferred: boolean; resume?: { end: number; partial: string } };
type Target = { items: Stream[]; last?: string; context: ChainContext };
type Turn = { streams: Map<string, Stream>; targets: Map<string, Target>; pending: number; history: number };
export type TurnTextPolicyOptions = { separateItemRegions?: boolean; contextFor?: (cap: TurnAdmission, target: string) => ChainContext; traceDecision?: (event: Readonly<{ stream: string; size: number; runningMax: number }>) => void; scan?: Scanner; streamAllowance?: number; wholeAllowance?: number; contexts?: Readonly<Record<string, ChainContext>> };
const decision = (masked: boolean, exhausted: boolean, operations: SafeTextOperation[] = []): PolicyDecision => Object.freeze({ masked, exhausted, operations: Object.freeze(operations.map(o => Object.freeze(o))) });
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
    const r = checkTurnUnit(value, budget.left, scanner);
    units += r.workUnits; budget.left -= r.workUnits;
    if (r.exhausted || budget.left < 0) throw new Error("intake budget");
    if (r.detected) throw new Latch();
  };
  const remember = (t: Turn, s: Stream, value: string, replace = false) => {
    if (replace) { t.history -= s.emitted?.length ?? 0; s.emitted = ""; }
    if (s.emitted !== undefined && t.history + value.length <= CONTEXT_LIMIT) { s.emitted += value; t.history += value.length; }
    else { t.history -= s.emitted?.length ?? 0; s.emitted = undefined; }
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
  const context = (s: Stream) => {
    const ctx = s.target?.context ?? "";
    if (ctx === LOST) throw new Latch();
    return ctx;
  };
  const eligible = (s: Stream) => !s.target || s.target.items[0] === s;
  const decideAt = (t: Turn, s: Stream, end: number, partial: string, meter: ScanMeter, out: SafeTextOperation[]) => {
    const ctx = context(s), U = s.pending.slice(0, end);
    let result;
    try { result = decide(U, partial, meter, ctx); }
    catch (error) {
      if (error instanceof ScanLimit && error.outcome === "DEFER") s.resume ??= { end, partial };
      throw error;
    }
    s.resume = undefined;
    s.d = Math.max(s.d, ctx.length + U.length); s.decisions++; a2Decisions++;
    options.traceDecision?.(Object.freeze({ stream: s.key, size: ctx.length + U.length, runningMax: s.d }));
    if (result === "LATCH") throw new Latch();
    if (result === "RELEASE") { release(t, s, U, out); drop(t, s, end); if (s.target) s.target.context = ""; }
  };
  const complete = (t: Turn, s: Stream, meter: ScanMeter, out: SafeTextOperation[]) => {
    const snapshot = s.snapshot;
    let rest = s.pending, replace = false;
    if (snapshot !== undefined) {
      if (s.emitted === undefined) { if (s.pending) throw new Latch(); rest = snapshot; replace = true; }
      else if (snapshot.startsWith(s.emitted + s.pending)) rest = snapshot.slice(s.emitted.length);
      else { if (s.pending) throw new Latch(); rest = snapshot; replace = true; }
    }
    const ctx = context(s), tail = ctx ? joinItems(ctx, rest) : rest;
    // Compute everything before committing: a partial scan can defer this
    // unit without having released or cleared a byte.
    if (!meter.clean(tail)) throw new Latch();
    const last = rest.at(-1) ?? s.target?.last;
    const open = openAfter(tail, last, meter);
    release(t, s, rest, out, replace);
    drop(t, s, s.pending.length); t.pending -= s.queued; s.queued = 0; s.snapshot = undefined; s.completed = true; s.deferred = false; s.resume = undefined;
    if (s.target) {
      s.target.context = open ? tail.length > CONTEXT_LIMIT ? LOST : tail : "";
      s.target.items.shift();
    }
    s.scanner = createLabelStream();
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
    admit(cap: TurnAdmission) { if (!clean.has(cap) && clean.size < TURN_TEXT_LIMITS.clean) clean.set(cap, { streams: new Map(), targets: new Map(), pending: 0, history: 0 }); },
    retire,
    consume(cap: TurnAdmission | undefined, batch: ManifestBatch): PolicyDecision {
      const t = get(cap), carriers: TextCarrier[] = [], budget = { left: TURN_TEXT_LIMITS.work };
      const meter = new ScanMeter(options.streamAllowance ?? A2_STREAM, scanner), whole = new ScanMeter(options.wholeAllowance ?? A2_WHOLE, scanner);
      a2Work = a2WholeWork = a2Decisions = a2Deferred = a2ScanExhausted = 0;
      const operations: SafeTextOperation[] = [];
      let deferred = false;
      const run = (s: Stream, fn: () => void, unit?: { end: number; partial: string }) => {
        if (deferred || !eligible(s)) { s.deferred = true; s.resume ??= unit; return; }
        try { fn(); } catch (error) {
          if (!(error instanceof ScanLimit) || error.outcome !== "DEFER") throw error;
          deferred = true; s.deferred = true; a2Deferred++;
        }
      };
      try {
        const list = data(batch, "carriers");
        if (!Array.isArray(list) || list.length > TURN_TEXT_LIMITS.nodes) throw new Error("manifest budget");
        let scalar = 0;
        for (let i = 0; i < list.length; i++) {
          const c = data(list, String(i)); if (!c || typeof c !== "object") throw new Error("carrier");
          const path = data(c, "path"), stream = data(c, "stream"), mode = data(c, "mode"), text = data(c, "text");
          if (typeof path !== "string" || typeof stream !== "string" || typeof text !== "string" || !["delta", "whole", "snapshot"].includes(mode as string) || path.length > 1024 || stream.length > 1024) throw new Error("carrier");
          scalar += text.length + path.length + stream.length;
          if (scalar > TURN_TEXT_LIMITS.scalarUnits || budget.left < text.length + 16) throw new Error("intake budget");
          budget.left -= text.length + 16; units += text.length + 16;
          carriers.push({ path, stream, mode: mode as TextCarrier["mode"], text });
        }
        if (!t) return mask(cap, carriers, batch);
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
          if (!s || ((s.completed || s.snapshot !== undefined) && c.mode !== "whole")) {
            const addsEntry = !previous || !previous.completed;
            if (addsEntry && (entries(t).size >= TURN_TEXT_LIMITS.streams || streamCount >= TURN_TEXT_LIMITS.globalStreams)) throw new Error("stream budget");
            let target: Target | undefined;
            if (c.mode !== "whole") {
              const name = /(?:^|:)(assistant|reasoning)$/.exec(c.stream)?.[1] ?? "other";
              target = t.targets.get(name);
              if (!target) { target = { items: [], context: options.contextFor?.(cap!, name) ?? options.contexts?.[name] ?? "" }; t.targets.set(name, target); }
            }
            s = { path: c.path, key: c.stream, region: previous?.region ?? region(c.stream, batch), revision: previous?.revision ?? 0, scanner: createLabelStream(), pending: "", lfEnd: 0, wordEnd: 0, emitted: "", started: false, completed: false, queued: 0, target, d: 0, decisions: 0, deferred: false };
            if (addsEntry) streamCount++;
            else t.history -= previous.emitted?.length ?? 0;
            t.streams.set(c.stream, s); target?.items.push(s);
          }
          s.path = c.path; touched.add(s);
          if (c.mode === "whole") {
            checked(c.text, budget);
            if (s.emitted === undefined) throw new Error("whole history lost");
            if (!whole.clean(s.emitted + c.text)) throw new Latch();
            release(t, s, c.text, operations); continue;
          }
          if (c.mode === "snapshot") {
            checked(c.text, budget);
            const prior = previous?.completed ? previous.emitted : previous?.snapshot;
            s.snapshot = prior !== undefined && c.text.startsWith(prior) ? c.text.slice(prior.length) : c.text;
            run(s, () => complete(t, s!, meter, operations));
            if (!s.completed) {
              s.deferred = true;
              t.pending -= s.queued;
              s.queued = Math.max(0, s.snapshot!.length - (s.emitted?.length ?? 0) - s.pending.length);
              t.pending += s.queued;
              if (t.pending > TURN_TEXT_LIMITS.pending) throw new Error("deferred pending budget");
            }
            continue;
          }
          // Look ahead to this item's last LF in the consume. The running max
          // persists across carriers and releases, and resets only per consume.
          for (let at = 0; at < c.text.length;) {
            const nl = c.text.indexOf("\n", at), end = nl < 0 ? c.text.length : nl + 1, part = c.text.slice(at, end);
            if (t.pending + part.length > TURN_TEXT_LIMITS.pending || budget.left < part.length) throw new Error("pending budget");
            budget.left -= part.length; units += part.length;
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
          return decision(false, false, [...operations, ...tail.operations]);
        }
        return decision(false, false, operations);
      } catch (error) { return mask(cap, carriers, batch, !(error instanceof Latch || error instanceof ScanLimit && error.outcome === "FC-SCAN")); }
      finally { a2Work = meter.work; a2WholeWork = whole.work; a2ScanExhausted = meter.scanExhausted + whole.scanExhausted; }
    },
    reset(cap: TurnAdmission | undefined, key: string): PolicyDecision {
      const t = get(cap); if (!t) return decision(true, false);
      const s = t.streams.get(key);
      if (s?.pending || s?.scanner.len) return mask(cap, [], undefined);
      return decision(false, false);
    },
    finish(cap: TurnAdmission | undefined, how: "complete" | "cancel" | "exit"): PolicyDecision {
      const t = get(cap); if (!t) return decision(true, false);
      if (how === "cancel") { retire(cap); return decision(false, false); }
      const meter = new ScanMeter(options.streamAllowance ?? A2_STREAM, scanner);
      a2Decisions = a2Deferred = a2WholeWork = 0;
      try {
        const operations: SafeTextOperation[] = [];
        for (const target of t.targets.values()) while (target.items.length) complete(t, target.items[0], meter, operations);
        retire(cap); return decision(false, false, operations);
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
