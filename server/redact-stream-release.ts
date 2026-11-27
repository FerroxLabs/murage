import { SECRET_SCAN_BUDGET, type SecretScanResult } from "../shared/md-secret-label.mjs";
import { scanTurnText } from "./redact.ts";

let boundaryTrace: ((text: string) => void) | undefined;
/** Synchronous test instrumentation: restore even when the assertion throws. */
export function traceItemBoundaries<T>(trace: (text: string) => void, run: () => T): T {
  if (process.env.NODE_ENV !== "test") throw new Error("test instrumentation only");
  const before = boundaryTrace; boundaryTrace = trace;
  try { return run(); } finally { boundaryTrace = before; }
}

/** One item boundary, shared by live releases, completion probes and rows. */
export function itemSep(leftLast: string | undefined): string {
  return leftLast === undefined || leftLast === "\n" ? "" : "\n";
}
export function joinItems(leftTail: string, right: string, leftLast = leftTail.at(-1)): string {
  const joined = leftTail + itemSep(leftLast) + right;
  boundaryTrace?.(joined);
  return joined;
}

export const P_BASIC = "basic," + "Q".repeat(48);
export const P_SEP = "=" + "Q".repeat(48);
export const P_VALUE = "Q".repeat(48);
export const PROBES = Object.freeze([P_BASIC, P_SEP, P_VALUE]);
export const A2_STREAM = 24 * SECRET_SCAN_BUDGET;
export const A2_WHOLE = 8 * SECRET_SCAN_BUDGET;
export const A2_ROW = A2_STREAM;
export const H_ROW = 256;
export const CONTEXT_LIMIT = 65_536;
/** cause22-E (b) (MAIN-RULING 2026-11-22T17:47:36Z, designs/REDACT-AUDIENCE-1021.md 5.3): scan work is granted per character of
 * the text scanned, never as a fixed amount, so no text is withheld because it is long. */
export const SCAN_RATE = 64;

export type Scanner = (text: string, options: { mode: "turn"; budget: number; perChar?: number }) => SecretScanResult;
export type UnitResult = Readonly<{ text: string; detected: boolean; exhausted: boolean; workUnits: number; spans?: readonly { from: number; to: number }[] }>;

/** The policy and its oracle use this very same composite checker. */
export function checkTurnUnit(text: string, budget = SECRET_SCAN_BUDGET, scan: Scanner = scanTurnText): UnitResult {
  return scan(text, { mode: "turn", budget: Math.min(SECRET_SCAN_BUDGET, budget), perChar: SCAN_RATE });
}

export class ScanLimit extends Error {
  readonly outcome: "DEFER" | "FC-SCAN";
  constructor(outcome: "DEFER" | "FC-SCAN") { super(outcome); this.outcome = outcome; }
}

/** Charge actual scanner work, including work discarded by a deferred unit. */
export class ScanMeter {
  work = 0;
  scanExhausted = 0;
  /** 1.0.22 cause B (masked values): every unit this meter found a hit in, with the scan's spans, for the life of the meter (one
   * consume, reset or finish). The policy turns them into its latch payload (redact-turn.ts latchOf); raw text never outlives the call. */
  readonly hits: { text: string; spans: readonly { from: number; to: number; wrapped?: boolean }[] }[] = [];
  /** More hit units than the meter keeps: the payload cannot name every value (the latch is then unproven). */
  hitsOverflow = false;
  allowance: number;
  readonly scan: Scanner;
  constructor(allowance = A2_STREAM, scan: Scanner = scanTurnText) { this.allowance = allowance; this.scan = scan; }
  get remaining(): number { return this.allowance - this.work; }
  /** The allowance grows with the text offered to this consume or finish (a rate, design 5.3): size can never reach it. */
  grant(chars: number): void { this.allowance += 4 * SCAN_RATE * chars; }
  check(text: string): UnitResult {
    const remaining = this.remaining;
    if (remaining <= 0) throw new ScanLimit("DEFER");
    let result: UnitResult;
    // A scanner that throws has not cleared this unit: it is UNREDACTABLE (design 5.5), the same outcome as exhausted work.
    try { result = checkTurnUnit(text, Math.min(SECRET_SCAN_BUDGET, remaining), this.scan); }
    catch { this.scanExhausted++; throw new ScanLimit("FC-SCAN"); }
    if (!Number.isInteger(result.workUnits) || result.workUnits < 0 || result.workUnits > Math.min(SECRET_SCAN_BUDGET, remaining) + SCAN_RATE * text.length) {
      throw new Error("Invalid scanner work accounting");
    }
    this.work += result.workUnits;
    if (result.exhausted) {
      if (remaining < SECRET_SCAN_BUDGET) throw new ScanLimit("DEFER");
      this.scanExhausted++;
      throw new ScanLimit("FC-SCAN");
    }
    if (result.detected) {
      if (this.hits.length >= ScanMeter.HITS_MAX) this.hitsOverflow = true;
      else this.hits.push({ text, spans: result.spans ?? [] });
    }
    return result;
  }
  static readonly HITS_MAX = 64;
  clean(text: string): boolean { const r = this.check(text); return !r.detected && r.text === text; }
}

export type ReleaseDecision = "HOLD" | "LATCH" | "RELEASE";
/** U ends at LF. Only U is releasable; the partial word remains pending. */
export function decide(U: string, t: string, meter: ScanMeter, context = ""): ReleaseDecision {
  const withContext = (right: string) => context ? joinItems(context, right) : right;
  if (!meter.clean(withContext(U + t))) return t === "" || meter.clean(t) ? "LATCH" : "HOLD";
  // In-item probes are U + t + p, without an inserted separator.
  for (const probe of PROBES) if (!meter.clean(withContext(U + t + probe))) return "HOLD";
  return "RELEASE";
}

export function openAfter(tail: string, last: string | undefined, meter: ScanMeter): boolean {
  if (!meter.clean(joinItems(tail, "", last))) return true;
  for (const probe of PROBES) if (!meter.clean(joinItems(tail, probe, last))) return true;
  return false;
}

/** d is a running maximum within one consume, including after a release. */
export function lfDecision(S: number, d: number, capGuard: boolean, last: boolean): boolean {
  return d === 0 || S >= 2 * d || capGuard || last;
}

/** Original-offset form of the same detector, including compatibility spans. */
export function turnUnitSpans(text: string, meter = new ScanMeter(A2_ROW)) {
  return meter.check(text).spans ?? [];
}
export const LOST = Symbol("lost turn context");
export type ChainContext = string | typeof LOST;
export type RowChainState = Readonly<{ mask: boolean; open: boolean; tailStart: number; lost: boolean }>;

/** Both row completion and streaming use this schedule and these decisions. */
export function rowChainStep(L: ChainContext, R: string, meter = new ScanMeter(A2_ROW)): RowChainState {
  const failed = { mask: true, open: true, tailStart: 0, lost: true };
  if (L === LOST || L.length > CONTEXT_LIMIT) return failed;
  try {
    const J = L ? joinItems(L, R) : R;
    const offset = J.length - R.length;
    const alone = turnUnitSpans(R, meter);
    const together = L ? turnUnitSpans(J, meter) : alone;
    let mask = false;
    for (const s of together) {
      let at = Math.max(offset, s.from), end = s.to;
      for (const r of alone) {
        if (r.to + offset <= at) continue;
        if (r.from + offset > at) break;
        at = Math.max(at, r.to + offset);
      }
      if (at < end) mask = true;
    }
    let released = 0, d = 0;
    for (let nl = J.indexOf("\n"); nl >= 0; nl = J.indexOf("\n", nl + 1)) {
      const next = J.indexOf("\n", nl + 1), S = nl + 1 - released;
      if (!lfDecision(S, d, (next < 0 ? J.length : next + 1) - released > CONTEXT_LIMIT, next < 0)) continue;
      d = Math.max(d, S);
      const result = L && released === 0 && nl + 1 >= offset
        ? decide(J.slice(offset, nl + 1), "", meter, L)
        : decide(J.slice(released, nl + 1), "", meter);
      if (result === "RELEASE") released = nl + 1;
      // A detected row is still sanitized normally when its own bytes alone
      // account for all matches. Only cross-row additions set mask.
    }
    const open = openAfter(J.slice(released), J.at(-1), meter);
    const lost = open && J.length - released > CONTEXT_LIMIT;
    return { mask, open, tailStart: released, lost };
  } catch (error) {
    if (error instanceof ScanLimit) return failed;
    throw error;
  }
}

export type ChainRow = Readonly<{ id: string; parentId?: string; role: string; kind: string; turnId?: string; speaker?: string; text: string; context?: ChainContext }>;
/** Reader helper: every fetched row, including skipped tools, costs one hop.
 * S4 supplies the epoch-valid cached/persisted context and forward fallback. */
export function readChainContext(start: string | undefined, read: (id: string) => ChainRow | undefined,
  forward?: () => ChainContext | undefined): ChainContext {
  let id = start, reads = 0, length = 0, chain: ChainRow | undefined;
  const parts: string[] = [];
  while (id) {
    if (reads++ === H_ROW) return forward?.() ?? LOST;
    const row = read(id); if (!row) break;
    if (row.role !== "bot") break;
    if (chain && (row.turnId !== chain.turnId || (!row.turnId && row.speaker !== chain.speaker))) break;
    chain ??= row;
    if (row.context !== undefined) {
      if (row.context === LOST) return LOST;
      length += row.context.length + (parts.length ? itemSep(row.context.at(-1)).length : 0);
      if (length > CONTEXT_LIMIT) return LOST;
      parts.unshift(row.context); break;
    }
    if (row.kind === "text") {
      length += row.text.length + (parts.length ? itemSep(row.text.at(-1)).length : 0);
      if (length > CONTEXT_LIMIT) return LOST;
      parts.unshift(row.text);
    }
    id = row.parentId;
  }
  const context = parts.reduce((a, b) => joinItems(a, b), "");
  return context.length > CONTEXT_LIMIT ? LOST : context;
}

declare const certified: unique symbol;
export type CertifiedRelease = Readonly<{ path: string; stream: string; regionId: string; revision: number; op: "append" | "replace" | "omit"; text: string; speech: "append" | "none"; [certified]: true }>;
/** Mint used only by the policy after its checked release transition. */
export function certifyRelease(op: Omit<CertifiedRelease, typeof certified>): CertifiedRelease {
  return Object.freeze(op) as CertifiedRelease;
}
