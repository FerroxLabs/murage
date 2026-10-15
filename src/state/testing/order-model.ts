// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The randomized event-order harness of BOTADDED-DESIGN-V3 r6 §11 (src/state/store.order.test.ts), with the four corrections of
// OPUS-AUDIT-V3-R5 "Check r6" and Astra r5: a second quiescence mode with no forced reload, invariants H and I, a server model
// that emits a mutation's frame before its answer and has failed/stalled hydrates, two desktop subjects, a PATCH restore inside a
// DELETE's await window, and invariant C restated so it allows only the documented R10 tombstone.
//
// `ServerTruth` mirrors the server half (fix/rc13-bot-server: server/bot-deletion-ledger.ts, index.ts bot/bot.deleted broadcast,
// GET /api/bots `removed[]`, DELETE /api/bots/:id). The subject is the REAL reducer from store.tsx driven through a thin
// provider shim (api tagging, the delete effect with its retry classes, the stream handler with pendingFrames/liveGen, hydrate
// with sentTick, the sweep, the verify drain). The client action shapes follow design §2.2. Two names the design leaves open
// are set here, in one place, so the gate can be aligned with the client half in one edit: VERIFY_404 (what the verify drain
// dispatches on a 404) and the phone flag (the reducer's step 5 asks `isPhoneClient()`, which the test mocks per subject).
//
// Against a reducer that has no `tombstones` (HEAD before merge 2) the shim maps the new actions to HEAD's (`LEGACY`), so the
// harness runs and reports which invariants HEAD breaks.

import { initialState, reducer, type Action, type AppState, type Bot } from "../store";

export const ANSWER_TTL_MS = 10 * 60_000;
export const SWEEP_MS = 60_000;
export const DELETE_RETRY_MAX = 20;
/** Small on purpose: a disconnect of a few operations overflows it and forces `resumed:false`. */
export const REPLAY_FRAMES = 12;
export const MAX_BOTS = 6;
/** What the verify drain dispatches when GET /api/bots/:id answers 404 (design §9.3: "cleared on that answer or on a 404"). */
export const VERIFY_404 = "verifySettled";

export const LEGACY = !("tombstones" in (initialState as object));

type Loose = Record<string, any>;
const loose = (state: AppState): Loose => state as unknown as Loose;

// ── PRNG ───────────────────────────────────────────────────────────────
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Server ─────────────────────────────────────────────────────────────
export type Surface = "desktop" | "phone";
export type SubName = "D1" | "D2" | "P";
export interface SBot { id: string; name: string; hidden: boolean; threadId: string; tasks: string[]; busy: boolean }
export interface Frame { n: number; kind: "bot" | "bot.deleted"; botId: string; bot?: Loose; audience?: "remote"; tasksSeq: number; tasksEpoch: string }
interface Removal { tasksSeq: number; tasksEpoch: string; kind: "deleted" | "hidden"; at: number; companionVisible: boolean }
export type Answer = { kind: "network" } | { kind: "nonjson" } | { kind: "json"; status: number; body: Loose };
export type Fail = "none" | "netBefore" | "netAfter" | "json5xx" | "nonJsonBefore" | "nonJsonAfter";
export type ReqKind = "create" | "duplicate" | "rename" | "hide" | "restore" | "delete" | "switch" | "deleteTask" | "detail" | "roster";

export interface Req {
  id: string; sub: SubName; kind: ReqKind; sentAt: number;
  botId?: string; thread?: string; intent?: number; attempt?: string; ifArchived?: boolean; verify?: boolean;
  sentTick?: number; liveGen?: number; switchSeq?: number;
  phase: "toServer" | "queued" | "awaiting" | "answered" | "done";
  answer?: Answer;
  /** A DELETE waiting on the per-bot lock keeps the failure it was drawn with; one in its await window, the answer it loses. */
  queuedFail?: Fail;
  lost?: Answer | null;
}

export class ServerTruth {
  epochNo = 0;
  bots = new Map<string, SBot>();
  seq = new Map<string, number>();
  ledger = new Map<string, Removal>();
  /** owner_deleted records: survive a restart. */
  durable = new Set<string>();
  deletedThreads = new Set<string>();
  lastN = 0;
  replay: Frame[] = [];
  constructor(private readonly now: () => number, private readonly fanout: (frame: Frame) => void) {}
  get epoch(): string { return `e${this.epochNo}`; }

  wire(bot: SBot): Loose {
    return {
      id: bot.id, threadId: bot.threadId, name: bot.name, title: "", description: "", notifications: false, color: "orange",
      unread: false, modelSelection: { instanceId: "fake", model: "fake" }, hidden: bot.hidden, busy: bot.busy,
      tasks: bot.tasks.map((threadId) => ({ threadId, title: threadId, createdAt: 0 })), tasksTotal: bot.tasks.length,
      tasksSeq: this.seq.get(bot.id) ?? 0, tasksEpoch: this.epoch,
    };
  }
  private emit(frame: Omit<Frame, "n">): void {
    const full = { ...frame, n: ++this.lastN } as Frame;
    this.replay.push(full);
    if (this.replay.length > REPLAY_FRAMES) this.replay.shift();
    this.fanout(full);
  }
  private prune(): void {
    for (const [id, entry] of this.ledger) if (entry.at < this.now() - ANSWER_TTL_MS) this.ledger.delete(id);
  }
  /** Any change to a held bot: a numbered `bot` frame; a hidden bot also tells scoped streams to forget it (index.ts 4618-4628). */
  bump(id: string): void {
    const bot = this.bots.get(id);
    if (!bot) return;
    this.seq.set(id, (this.seq.get(id) ?? 0) + 1);
    const seq = this.seq.get(id)!;
    this.emit({ kind: "bot", botId: id, bot: this.wire(bot), tasksSeq: seq, tasksEpoch: this.epoch });
    if (bot.hidden) {
      this.prune();
      if (!this.ledger.has(id)) this.ledger.set(id, { tasksSeq: seq, tasksEpoch: this.epoch, kind: "hidden", at: this.now(), companionVisible: false });
      this.emit({ kind: "bot.deleted", botId: id, audience: "remote", tasksSeq: seq, tasksEpoch: this.epoch });
    } else if (this.ledger.get(id)?.kind === "hidden") this.ledger.delete(id);
  }
  create(id: string, name: string): void {
    this.bots.set(id, { id, name, hidden: false, threadId: `${id}-t0`, tasks: [`${id}-t0`], busy: false });
    this.bump(id);
  }
  commitDeletion(id: string, companionVisible: boolean): void {
    this.bots.delete(id);
    this.durable.add(id);
    const seq = this.seq.get(id) ?? 0;
    this.prune();
    this.ledger.set(id, { tasksSeq: seq, tasksEpoch: this.epoch, kind: "deleted", at: this.now(), companionVisible });
    this.emit({ kind: "bot.deleted", botId: id, tasksSeq: seq, tasksEpoch: this.epoch });
  }
  deletion(id: string): Removal | undefined {
    this.prune();
    const entry = this.ledger.get(id);
    return entry?.kind === "deleted" ? entry : undefined;
  }
  removedFor(surface: Surface): Loose[] {
    this.prune();
    const out: Loose[] = [];
    for (const [id, e] of this.ledger) {
      if (surface === "desktop" ? e.kind === "deleted" : e.kind === "hidden" || e.companionVisible) out.push({ id, tasksSeq: e.tasksSeq, tasksEpoch: e.tasksEpoch, kind: e.kind });
    }
    return out;
  }
  visible(surface: Surface): SBot[] {
    return [...this.bots.values()].filter((bot) => surface === "desktop" || !bot.hidden);
  }
  restart(): void {
    this.epochNo += 1;
    this.seq.clear();
    this.ledger.clear();
    this.lastN = 0;
    this.replay = [];
  }
  /** The thread ops of design §4 (switch, task delete). */
  switchTo(id: string, thread: string): boolean {
    const bot = this.bots.get(id);
    if (!bot || !bot.tasks.includes(thread)) return false;
    bot.threadId = thread;
    this.bump(id);
    return true;
  }
  deleteTask(id: string, thread: string): boolean {
    const bot = this.bots.get(id);
    if (!bot || !bot.tasks.includes(thread) || bot.tasks.length < 2) return false;
    bot.tasks = bot.tasks.filter((t) => t !== thread);
    this.deletedThreads.add(thread);
    if (bot.threadId === thread) bot.threadId = bot.tasks[0]!;
    this.bump(id);
    return true;
  }
  newTask(id: string, thread: string): void {
    const bot = this.bots.get(id);
    if (!bot) return;
    bot.tasks = [...bot.tasks, thread];
    this.bump(id);
  }
}

const wants = (surface: Surface, frame: Frame): boolean =>
  surface === "desktop" ? frame.kind === "bot" || !frame.audience : frame.kind === "bot.deleted" || frame.bot?.hidden !== true;

// ── Operations ─────────────────────────────────────────────────────────
export type Op =
  | { t: "send"; id: string; sub: SubName; kind: Exclude<ReqKind, "detail" | "roster"> | "detail"; botId?: string; thread?: string; archivedList?: boolean }
  | { t: "process"; req: string; fail: Fail }
  | { t: "commit"; req: string }
  | { t: "deliver"; req: string }
  | { t: "frame"; sub: SubName }
  | { t: "disconnect"; sub: SubName }
  | { t: "reconnect"; sub: SubName }
  | { t: "reconcile"; sub: SubName }
  | { t: "server"; id?: string; kind: "create" | "rename" | "hide" | "restore" | "delete" | "busy" | "switch" | "deleteTask" | "newTask"; botId?: string; thread?: string }
  | { t: "flood"; botId: string }
  | { t: "restart" }
  | { t: "tick"; ms: number };

export function describeOp(op: Op): string {
  switch (op.t) {
    case "send": return `${op.sub} sends ${op.kind}${op.botId ? ` ${op.botId}` : ""}${op.thread ? ` ${op.thread}` : ""}${op.archivedList ? " (archived list)" : ""}`;
    case "process": return `server handles ${op.req}${op.fail === "none" ? "" : ` [${op.fail}]`}`;
    case "commit": return `server commits DELETE ${op.req}`;
    case "deliver": return `answer ${op.req} delivered`;
    case "frame": return `next frame -> ${op.sub}`;
    case "disconnect": return `${op.sub} stream drops`;
    case "reconnect": return `${op.sub} reconnects`;
    case "reconcile": return `${op.sub} reconcile() hydrate`;
    case "server": return `server-side ${op.kind}${op.botId ? ` ${op.botId}` : ""}${op.thread ? ` ${op.thread}` : ""}`;
    case "flood": return `server floods ${REPLAY_FRAMES + 2} frames of ${op.botId}`;
    case "restart": return "server restarts (new epoch)";
    case "tick": return `clock +${op.ms >= 60_000 ? `${Math.round(op.ms / 1000)}s` : `${op.ms}ms`}`;
  }
}

// ── Failures ───────────────────────────────────────────────────────────
export type Letter = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "I" | "X";
export interface OrderFailure { letter: Letter; step: number; detail: string }
export type Mode = "reload" | "resume";

// ── Subject (real reducer + provider shim) ─────────────────────────────
interface Tracker { attempt: string; botId: string; archived: boolean; tries: number; nextAt: number; inflight: string | null; done: boolean }
export interface Subject {
  name: SubName; surface: Surface; state: AppState;
  conn: { up: boolean; cursor: number; epochNo: number; queue: Frame[] };
  /** The provider's `liveGen` (bumped by a `resumed:false` hello) and `hydrated` (false while any hydrate runs or after one failed:
   * frames are buffered in `pendingFrames` meanwhile and drained, current generation only, after a hydrate succeeds). */
  liveGen: number; hydrated: boolean; pendingFrames: Array<{ frame: Frame; gen: number }>;
  hydrate: { inFlight: string | null; again: boolean; retryAt: number };
  reconcileSeen: number;
  /** The reducer asked for the roster again; the provider's effect runs it after the current step (useEffect timing). */
  reconcileAsked: boolean;
  intents: Record<string, number>;
  /** The provider's switchSeq: only the latest switch's answer of a bot is dispatched. */
  switchSeq: Record<string, number>;
  trackers: Tracker[];
  verifying: Set<string>;
  maxSeen: Map<string, { epochNo: number; seq: number }>;
  reallyDeleted: Set<string>;
  sawDeleteFrame: Set<string>;
  settledDeleted: Set<string>;
  rosterRemoved: Set<string>;
  lastSweep: number;
}

export interface WorldOptions { phoneFlag: { phone: boolean }; clock: { now(): number; advance(ms: number): void } }

export class World {
  readonly server: ServerTruth;
  readonly subs: Subject[];
  readonly reqs = new Map<string, Req>();
  step = 0;
  checking = true;
  failure: OrderFailure | null = null;
  /** Requests the provider makes on its own (hydrates, verifies, retries) are named by what they are, not by step, so a shrunk
   * order still refers to the same ones. */
  private readonly counters = new Map<string, number>();
  private readonly t0: number;

  constructor(private readonly opts: WorldOptions) {
    this.t0 = opts.clock.now();
    this.server = new ServerTruth(() => this.now(), (frame) => this.fanout(frame));
    const sub = (name: SubName, surface: Surface): Subject => ({
      name, surface, state: initialState,
      conn: { up: false, cursor: 0, epochNo: 0, queue: [] },
      liveGen: 0, hydrated: false, pendingFrames: [], hydrate: { inFlight: null, again: false, retryAt: 0 }, reconcileSeen: 0, reconcileAsked: false,
      intents: {}, switchSeq: {}, trackers: [], verifying: new Set(), maxSeen: new Map(), reallyDeleted: new Set(), sawDeleteFrame: new Set(),
      settledDeleted: new Set(), rosterRemoved: new Set(), lastSweep: this.t0,
    });
    this.subs = [sub("D1", "desktop"), sub("D2", "desktop"), sub("P", "phone")];
    this.step = -1; // boot requests: r-1.n
    this.server.create("b0", "Ada");
    this.server.create("b1", "Bo");
    this.server.create("b2", "Cy");
    this.server.newTask("b0", "b0-t1");
    this.server.newTask("b1", "b1-t1");
    this.server.bots.get("b2")!.hidden = true;
    this.server.bump("b2");
    // Every subject boots: hello `resumed:false`, its hydrate answered at once.
    for (const s of this.subs) {
      this.reconnect(s);
      const id = s.hydrate.inFlight!;
      this.process(id, "none");
      this.deliver(id);
    }
    this.step = 0;
  }

  now(): number { return this.opts.clock.now(); }
  sub(name: SubName): Subject { return this.subs.find((s) => s.name === name)!; }
  held(s: Subject, id: string): Bot | undefined { return s.state.bots.find((b) => b.id === id); }

  // ── dispatch ──
  dispatch(s: Subject, action: Loose): void {
    const mapped = LEGACY ? toHead(action) : action;
    if (!mapped) return;
    this.opts.phoneFlag.phone = s.surface === "phone";
    const next = reducer(s.state, mapped as unknown as Action);
    if (!next) throw new Error(`reducer returned nothing for ${String(mapped.type)}`);
    s.state = next;
    // The provider's effect: an input that asked for the roster again (reconcileRequested) runs one hydrate.
    const asked = loose(next).reconcileRequested ?? 0;
    if (asked > s.reconcileSeen) { s.reconcileSeen = asked; s.reconcileAsked = true; }
  }

  private fanout(frame: Frame): void {
    for (const s of this.subs) if (s.conn.up && s.conn.epochNo === this.server.epochNo && wants(s.surface, frame)) s.conn.queue.push(frame);
  }

  // ── requests ──
  private newReq(s: Subject, kind: ReqKind, fields: Partial<Req>, id?: string): Req {
    const req: Req = { id: id ?? this.nameFor(`${kind}.${s.name}.${fields.botId ?? ""}`), sub: s.name, kind, sentAt: this.now(), phase: "toServer", ...fields };
    this.reqs.set(req.id, req);
    return req;
  }

  private nameFor(prefix: string): string {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}#${n}`;
  }

  /** A client action: the local dispatch it makes first (deleteBot, pageRequested), then its request. */
  send(op: Extract<Op, { t: "send" }>, id?: string): string | null {
    const s = this.sub(op.sub);
    const held = op.botId ? this.held(s, op.botId) : undefined;
    if (op.botId && !held) return null;
    switch (op.kind) {
      case "create": return this.newReq(s, "create", {}, id).id;
      case "duplicate": return this.newReq(s, "duplicate", { botId: op.botId }, id).id;
      case "rename": case "detail": return this.newReq(s, op.kind, { botId: op.botId, verify: op.kind === "detail" }, id).id;
      case "hide": case "restore": return this.newReq(s, op.kind, { botId: op.botId }, id).id;
      case "switch": case "deleteTask": {
        if (!op.thread) return null;
        const botId = op.botId!;
        const intent = Math.max(s.intents[botId] ?? 0, loose(s.state).pageIntent?.[botId] ?? 0) + 1;
        s.intents[botId] = intent;
        this.dispatch(s, { type: "pageRequested", botId, intent });
        const switchSeq = op.kind === "switch" ? (s.switchSeq[botId] = (s.switchSeq[botId] ?? 0) + 1) : undefined;
        return this.newReq(s, op.kind, { botId, thread: op.thread, intent, switchSeq }, id).id;
      }
      case "delete": {
        const botId = op.botId!;
        if (s.trackers.some((t) => t.botId === botId && !t.done)) return null;
        // The archived list lists only archived bots, and only on a desktop (a shrunk order may no longer agree).
        if (op.archivedList && (s.surface !== "desktop" || held?.hidden !== true)) return null;
        const attempt = `a.${s.name}.${id ?? this.step}`;
        const archived = op.archivedList === true;
        this.dispatch(s, { type: "deleteBot", source: "local", botId, attempt, ...(archived ? { archived: true } : {}) });
        const tracker: Tracker = { attempt, botId, archived, tries: 0, nextAt: 0, inflight: null, done: false };
        s.trackers.push(tracker);
        tracker.inflight = this.newReq(s, "delete", { botId, attempt, ifArchived: archived }, id).id;
        return tracker.inflight;
      }
    }
  }

  /** The server handles a request: frames first (store.onChange broadcasts before the handler answers), then the answer. */
  process(reqId: string, fail: Fail): void {
    const req = this.reqs.get(reqId);
    if (!req || (req.phase !== "toServer" && req.phase !== "queued")) return;
    const sv = this.server;
    const answer = (a: Answer) => { req.answer = a; req.phase = "answered"; };
    const json = (status: number, body: Loose) => answer({ kind: "json", status, body });
    if (fail === "netBefore") return answer({ kind: "network" });
    if (fail === "nonJsonBefore") return answer({ kind: "nonjson" });
    if (fail === "json5xx") return json(500, { error: "cleanup journal unreadable" });
    const lost = fail === "netAfter" ? { kind: "network" as const } : fail === "nonJsonAfter" ? { kind: "nonjson" as const } : null;
    const reply = (status: number, body: Loose) => (lost && status < 300 ? answer(lost) : json(status, body));
    const bot = req.botId ? sv.bots.get(req.botId) : undefined;
    const surface = this.sub(req.sub).surface;
    switch (req.kind) {
      case "create": case "duplicate": {
        if (req.kind === "duplicate" && !bot) return reply(404, { error: "no such bot" });
        if (sv.bots.size >= MAX_BOTS) return reply(409, { error: "too many" });
        const id = `n${req.id.replace(/[^0-9a-z]/gi, "")}`;
        sv.create(id, bot ? `${bot.name} copy` : "New");
        return reply(200, { bot: { ...sv.wire(sv.bots.get(id)!), messages: [] } });
      }
      case "rename": {
        if (!bot) return reply(404, { error: "no such bot" });
        bot.name = `${bot.name}'`;
        sv.bump(bot.id);
        return reply(200, { bot: sv.wire(bot) });
      }
      case "hide": case "restore": {
        if (!bot) return reply(404, { error: "no such bot" });
        bot.hidden = req.kind === "hide";
        sv.bump(bot.id);
        return reply(200, { bot: sv.wire(bot) });
      }
      case "switch": {
        if (!bot || !sv.switchTo(bot.id, req.thread!)) return reply(404, { error: "no such task" });
        return reply(200, { bot: { ...sv.wire(bot), messages: [pageMarker(req.id)], hasMore: false } });
      }
      case "deleteTask": {
        if (!bot || !sv.deleteTask(bot.id, req.thread!)) return reply(409, { error: "cannot delete task" });
        return reply(200, { bot: { ...sv.wire(bot), messages: [pageMarker(req.id)], hasMore: false } });
      }
      case "detail": {
        if (!bot || (surface === "phone" && bot.hidden)) return json(404, { error: "no such bot" });
        return reply(200, { bot: sv.wire(bot) });
      }
      case "roster": {
        const bots = sv.visible(surface).map((b) => sv.wire(b));
        return reply(200, { bots, groups: [], computerControl: {}, tasksEpoch: sv.epoch, removed: sv.removedFor(surface) });
      }
      case "delete": {
        // (1) one DELETE per bot at a time; a waiter re-runs the route from the top after it.
        const busy = [...this.reqs.values()].some((r) => r !== req && r.kind === "delete" && r.botId === req.botId && r.phase === "awaiting");
        if (busy) { req.phase = "queued"; req.queuedFail = fail; return; }
        if (!bot) {
          const known = sv.deletion(req.botId!);
          if (known) return reply(200, { ok: true, alreadyDeleted: true, tasksSeq: known.tasksSeq, tasksEpoch: known.tasksEpoch });
          if (sv.durable.has(req.botId!)) return reply(200, { ok: true, alreadyDeleted: true, tasksSeq: sv.seq.get(req.botId!) ?? 0, tasksEpoch: sv.epoch });
          return json(404, { error: "no such bot" });
        }
        if (bot.busy) return json(409, { error: "bot is running" });
        if (req.ifArchived && !bot.hidden) return json(409, { error: "not archived" });
        req.phase = "awaiting";
        req.lost = lost;
        return;
      }
    }
  }

  /** The DELETE leaves its await window: the commit-time re-check (`commitRefusal`), then the deletion. */
  commit(reqId: string): void {
    const req = this.reqs.get(reqId);
    if (!req || req.phase !== "awaiting") return;
    const sv = this.server;
    const bot = sv.bots.get(req.botId!);
    const lost = req.lost ?? null;
    const done = (a: Answer) => { req.answer = a; req.phase = "answered"; };
    if (!bot) done({ kind: "json", status: 200, body: { ok: true, alreadyDeleted: true, ...this.seqOf(req.botId!) } });
    else if (req.ifArchived && !bot.hidden) done({ kind: "json", status: 409, body: { error: "restored meanwhile" } });
    else if (bot.busy) done({ kind: "json", status: 409, body: { error: "bot is running" } });
    else {
      const seq = sv.seq.get(bot.id) ?? 0;
      sv.commitDeletion(bot.id, !bot.hidden);
      done(lost ?? { kind: "json", status: 200, body: { ok: true, tasksSeq: seq, tasksEpoch: sv.epoch } });
    }
    for (const waiter of [...this.reqs.values()]) {
      if (waiter.kind === "delete" && waiter.botId === req.botId && waiter.phase === "queued") {
        waiter.phase = "toServer";
        this.process(waiter.id, waiter.queuedFail ?? "none");
        break;
      }
    }
  }
  private seqOf(id: string): Loose { return { tasksSeq: this.server.seq.get(id) ?? 0, tasksEpoch: this.server.epoch }; }

  /** The client receives an answer. */
  deliver(reqId: string): void {
    const req = this.reqs.get(reqId);
    if (!req || req.phase !== "answered" || !req.answer) return;
    req.phase = "done";
    const s = this.sub(req.sub);
    const a = req.answer;
    const sentAt = req.sentAt;
    const expired = this.now() - sentAt > ANSWER_TTL_MS;
    const ok = a.kind === "json" && a.status < 300 ? a.body : null;
    switch (req.kind) {
      case "roster": {
        if (s.hydrate.inFlight !== req.id) return; // superseded (dropped as too old at quiescence)
        s.hydrate.inFlight = null;
        // loadAll: a roster asked for under an older generation is not dispatched; the hydrate runs again.
        if (req.liveGen !== s.liveGen) { this.startRoster(s); return; }
        // A failed or refused roster: hydrate() resolves false, `hydrated` stays false and frames keep buffering until a later one.
        if (!ok) { s.hydrate.again = false; s.hydrate.retryAt = this.now() + 2_000; return; }
        this.dispatch(s, { type: "clientScope", scoped: s.surface === "phone" });
        this.dispatch(s, { type: "hydrate", source: "http", sentAt, expired, tasksEpoch: ok.tasksEpoch, removed: ok.removed, bots: ok.bots, groups: [], computerControl: {}, sentTick: req.sentTick, liveGen: req.liveGen });
        if (!expired) {
          for (const r of ok.removed as Loose[]) {
            s.rosterRemoved.add(r.id);
            if (r.kind === "deleted" && !this.held(s, r.id)) s.reallyDeleted.add(r.id);
          }
          if (this.checking) this.checkI(s, ok.bots as Loose[]);
        }
        // do { loadAll() } while (rehydrateRequested): another roster before the drain.
        if (s.hydrate.again) { this.startRoster(s); return; }
        s.hydrated = true;
        const drained = s.pendingFrames.splice(0);
        for (const entry of drained) if (entry.gen === s.liveGen) this.applyFrame(s, entry.frame);
        this.dispatch(s, { type: "streamDrained" });
        return;
      }
      case "delete": {
        const tracker = s.trackers.find((t) => t.inflight === req.id);
        if (!tracker) return;
        tracker.inflight = null;
        if (tracker.done) return;
        if (a.kind === "json" && a.body.error) return this.settle(s, tracker, { outcome: "refused", error: a.body.error });
        if (a.kind === "json") return this.settle(s, tracker, { outcome: "deleted", tasksSeq: a.body.tasksSeq, tasksEpoch: a.body.tasksEpoch });
        tracker.tries += 1;
        if (tracker.tries >= DELETE_RETRY_MAX) return this.settle(s, tracker, { outcome: "gaveUp", error: "the server has not answered" });
        tracker.nextAt = this.now() + Math.min(1000 * 2 ** (tracker.tries - 1), 30_000);
        return;
      }
      case "detail": {
        if (req.verify) s.verifying.delete(req.botId!);
        if (ok) this.record(s, { type: "botPatched", source: "http", sentAt, expired, bot: ok.bot, verified: true });
        if (req.verify) this.dispatch(s, { type: VERIFY_404, botId: req.botId, gone: a.kind === "json" && a.status === 404 });
        return;
      }
      case "create": case "duplicate":
        if (ok) this.record(s, { type: "botAdded", source: "http", sentAt, expired, bot: ok.bot });
        return;
      case "rename": case "hide": case "restore":
        if (ok) this.record(s, { type: "botPatched", source: "http", sentAt, expired, bot: ok.bot });
        return;
      case "switch": case "deleteTask": {
        if (!ok) return;
        const before = this.held(s, req.botId!);
        const latest = Math.max(s.intents[req.botId!] ?? 0, loose(s.state).pageIntent?.[req.botId!] ?? 0);
        // switchTask: a later switch owns the screen. deleteTask: its own answer is offered only while the record still shows the
        // deleted task or waits for the snapshot the server's deletion frame asked for (store.tsx deleteTask effect).
        if (req.kind === "switch" && s.switchSeq[req.botId!] !== req.switchSeq) return;
        if (req.kind === "deleteTask" && !(before && (before.threadId === req.thread || before.awaitingThreadSnapshot))) return;
        const action = req.kind === "switch"
          ? { type: "taskSwitched", source: "http", sentAt, expired, bot: ok.bot, intent: req.intent }
          : { type: "botPatched", source: "http", sentAt, expired, bot: ok.bot, intent: req.intent };
        this.record(s, action);
        const after = this.held(s, req.botId!);
        if (this.checking && after && after.messages.some((m) => m.id === `page:${req.id}`) && !before?.messages.some((m) => m.id === `page:${req.id}`)) {
          // The highest intent may be the server's own (a deletion of the viewed task moved the record and waits for its
          // snapshot): a page of exactly that thread is the page it asked for.
          const serverIntentPage = Boolean(before?.awaitingThreadSnapshot) && before?.threadId === ok.bot.threadId;
          if (req.intent !== latest && !serverIntentPage) this.fail("F", `${s.name} applied ${req.id}'s page of ${req.botId} under intent ${req.intent}, latest is ${latest}`);
          if (before?.deletedThreadId && before.deletedThreadId === ok.bot.threadId) this.fail("F", `${s.name} applied a page of deleted thread ${ok.bot.threadId}`);
        }
        return;
      }
    }
  }

  private settle(s: Subject, tracker: Tracker, fields: Loose): void {
    tracker.done = true;
    if (fields.outcome === "deleted") { s.reallyDeleted.add(tracker.botId); s.settledDeleted.add(tracker.botId); s.rosterRemoved.delete(tracker.botId); }
    this.dispatch(s, { type: "deletionSettled", source: "http", botId: tracker.botId, attempt: tracker.attempt, ...fields });
  }

  /** A record-shaped http input: E (an expired answer changes nothing), then the provider's reconcile() for an unfamiliar run. */
  private record(s: Subject, action: Loose): void {
    const before = this.checking && action.expired ? fingerprint(s.state) : null;
    this.dispatch(s, action);
    if (before !== null && fingerprint(s.state) !== before) this.fail("E", `${s.name} applied an expired ${action.type} for ${action.bot.id}`);
  }

  /** hydrate(): one in flight; a second call while it runs asks for one more roster after it (rehydrateRequested). */
  reconcile(s: Subject): void {
    s.hydrated = false;
    if (s.hydrate.inFlight) { s.hydrate.again = true; return; }
    this.startRoster(s);
  }
  private startRoster(s: Subject): void {
    s.hydrate.again = false;
    s.hydrate.retryAt = 0;
    s.hydrate.inFlight = this.newReq(s, "roster", { sentTick: loose(s.state).admitTick ?? 0, liveGen: s.liveGen }).id;
  }

  // ── stream ──
  deliverFrame(s: Subject): void {
    const frame = s.conn.queue.shift();
    if (!frame) return;
    s.conn.cursor = frame.n;
    if (!s.hydrated) { s.pendingFrames.push({ frame, gen: s.liveGen }); return; }
    this.applyFrame(s, frame);
  }
  private applyFrame(s: Subject, frame: Frame): void {
    if (frame.kind === "bot") { this.dispatch(s, { type: "botPatched", source: "stream", bot: frame.bot }); return; }
    this.dispatch(s, { type: "botDeleted", source: "stream", botId: frame.botId, hidden: frame.audience === "remote", tasksSeq: frame.tasksSeq, tasksEpoch: frame.tasksEpoch });
    if (!frame.audience) {
      // Applied only when the reducer acted on it: a deletion of an unfamiliar run is verified, not applied (§2.4, §9.4).
      if (!this.held(s, frame.botId)) s.reallyDeleted.add(frame.botId);
      s.sawDeleteFrame.add(frame.botId);
      for (const t of s.trackers) if (t.botId === frame.botId) t.done = true; // deleteControl.stop: the provider stops the retry outright
    }
  }
  disconnect(s: Subject): void {
    s.conn.up = false;
    s.conn.queue = [];
  }
  /** A hello: resumed when the server still holds every frame past the cursor (same run), else `resumed:false` and a hydrate. */
  reconnect(s: Subject): void {
    const sv = this.server;
    s.conn.up = true;
    const first = sv.replay[0]?.n ?? sv.lastN + 1;
    const resumed = s.liveGen > 0 && s.conn.epochNo === sv.epochNo && s.conn.cursor + 1 >= first;
    if (resumed) {
      s.conn.queue = sv.replay.filter((f) => f.n > s.conn.cursor && wants(s.surface, f));
    } else {
      s.conn.epochNo = sv.epochNo;
      s.conn.cursor = sv.lastN;
      s.conn.queue = [];
      s.liveGen += 1;
      s.pendingFrames.splice(0);
      this.reconcile(s); // a hydrate in flight was asked for under the old generation: ignored on arrival, run again
    }
    for (const t of s.trackers) if (!t.done && !t.inflight) t.nextAt = 0; // a reconnect retries at once
  }
  restart(): void {
    this.server.restart();
    for (const r of this.reqs.values()) if (r.phase === "awaiting" || r.phase === "queued") { r.answer = { kind: "network" }; r.phase = "answered"; }
    for (const s of this.subs) this.disconnect(s);
  }
  tick(ms: number): void {
    // A live stream delivers in seconds: frames do not sit in an open connection while minutes pass.
    if (ms >= 30_000) for (const s of this.subs) while (s.conn.up && s.conn.queue.length) this.deliverFrame(s);
    this.opts.clock.advance(ms);
    for (const s of this.subs) {
      if (this.now() - s.lastSweep >= SWEEP_MS) { s.lastSweep = this.now(); this.dispatch(s, { type: "tombstonesSweep", now: this.now() }); }
    }
  }

  /** The provider's effects after every step: the delete effect's retries, the verify drain, a requested hydrate. */
  effects(quiescing = false): boolean {
    let moved = false;
    for (const s of this.subs) {
      for (const t of s.trackers) {
        if (t.done || t.inflight) continue;
        if (!LEGACY && loose(s.state).pendingDeletes?.[t.botId]?.attempt !== t.attempt) { t.done = true; continue; }
        if (!quiescing && this.now() < t.nextAt) continue;
        t.inflight = this.newReq(s, "delete", { botId: t.botId, attempt: t.attempt, ifArchived: t.archived }).id;
        moved = true;
      }
      if (!LEGACY) {
        for (const id of Object.keys(loose(s.state).verifyBots ?? {})) {
          if (s.verifying.has(id)) continue;
          s.verifying.add(id);
          this.newReq(s, "detail", { botId: id, verify: true });
          moved = true;
        }
      }
      if (s.reconcileAsked) { s.reconcileAsked = false; this.reconcile(s); moved = true; }
      if (!s.hydrated && !s.hydrate.inFlight && (quiescing || this.now() >= s.hydrate.retryAt)) { this.startRoster(s); moved = true; }
    }
    return moved;
  }

  // ── applying an operation ──
  apply(op: Op): void {
    const sv = this.server;
    switch (op.t) {
      case "send": this.send(op, op.id); break;
      case "process": this.process(op.req, op.fail); break;
      case "commit": this.commit(op.req); break;
      case "deliver": this.deliver(op.req); break;
      case "frame": this.deliverFrame(this.sub(op.sub)); break;
      case "disconnect": this.disconnect(this.sub(op.sub)); break;
      case "reconnect": if (!this.sub(op.sub).conn.up) this.reconnect(this.sub(op.sub)); break;
      case "reconcile": this.reconcile(this.sub(op.sub)); break;
      case "flood": for (let i = 0; i < REPLAY_FRAMES + 2 && sv.bots.has(op.botId); i++) { sv.bots.get(op.botId)!.busy = !sv.bots.get(op.botId)!.busy; sv.bump(op.botId); } break;
      case "restart": this.restart(); break;
      case "tick": this.tick(op.ms); break;
      case "server": {
        const bot = op.botId ? sv.bots.get(op.botId) : undefined;
        if (op.kind === "create") { if (sv.bots.size < MAX_BOTS && op.id && !sv.bots.has(op.id) && !sv.durable.has(op.id)) sv.create(op.id, "Remote"); break; }
        if (!bot) break;
        if (op.kind === "rename") { bot.name = `${bot.name}*`; sv.bump(bot.id); }
        if (op.kind === "hide" && !bot.hidden) { bot.hidden = true; sv.bump(bot.id); }
        if (op.kind === "restore" && bot.hidden) { bot.hidden = false; sv.bump(bot.id); }
        if (op.kind === "busy") { bot.busy = !bot.busy; sv.bump(bot.id); }
        if (op.kind === "delete" && !bot.busy) sv.commitDeletion(bot.id, false);
        if (op.kind === "switch" && op.thread) sv.switchTo(bot.id, op.thread);
        if (op.kind === "deleteTask" && op.thread) sv.deleteTask(bot.id, op.thread);
        if (op.kind === "newTask") sv.newTask(bot.id, `${bot.id}-x${this.step}`);
        break;
      }
    }
    this.effects();
    if (this.checking && !this.failure) this.checkStep();
    this.step += 1;
  }

  // ── invariants ──
  fail(letter: Letter, detail: string): void {
    if (!this.failure) this.failure = { letter, step: this.step, detail };
  }

  /** D-I after every step (E and F are checked at their dispatch). */
  checkStep(): void {
    for (const s of this.subs) {
      const pending = loose(s.state).pendingDeletes ?? {};
      for (const bot of s.state.bots) {
        if (s.surface === "phone" && bot.hidden === true) this.fail("D", `phone holds archived ${bot.id}`);
        if (pending[bot.id]) this.fail("E", `${s.name} holds pending-delete ${bot.id}`);
        if (s.reallyDeleted.has(bot.id)) this.fail("H", `${s.name} holds ${bot.id} again after applying its deletion`);
        const seq = numberOf(bot);
        const epochNo = epochNoOf(bot);
        if (seq === undefined || epochNo === undefined) continue;
        const max = s.maxSeen.get(bot.id);
        if (max && (epochNo < max.epochNo || (epochNo === max.epochNo && seq < max.seq))) {
          this.fail("G", `${s.name} holds ${bot.id} at e${epochNo}/${seq} after e${max.epochNo}/${max.seq}`);
        }
        if (!max || epochNo > max.epochNo || (epochNo === max.epochNo && seq > max.seq)) s.maxSeen.set(bot.id, { epochNo, seq });
      }
    }
  }

  /** I: on a desktop, a hidden record the server lists stays held (H-r6-1). */
  private checkI(s: Subject, rows: Loose[]): void {
    if (s.surface !== "desktop") return;
    for (const row of rows) {
      if (row.hidden !== true || !this.server.bots.has(row.id)) continue;
      if (s.trackers.some((t) => t.botId === row.id && !t.done)) continue;
      if (!this.held(s, row.id)) this.fail("I", `${s.name} dropped archived ${row.id} that its roster lists`);
    }
  }

  /** A-C after quiescence. */
  checkQuiescent(): void {
    for (const s of this.subs) {
      const truth = new Map(this.server.visible(s.surface).map((b) => [b.id, b]));
      const heldIds = s.state.bots.map((b) => b.id).sort();
      const want = [...truth.keys()].sort();
      if (heldIds.join() !== want.join()) this.fail("A", `${s.name} holds [${heldIds}] but the server shows it [${want}]`);
      for (const bot of s.state.bots) {
        const t = truth.get(bot.id);
        if (!t) continue;
        const seq = this.server.seq.get(bot.id) ?? 0;
        const recordSeq = numberOf(bot);
        if (bot.name !== t.name || Boolean(bot.hidden) !== t.hidden) this.fail("B", `${s.name} holds ${bot.id} as ${bot.name}/${Boolean(bot.hidden)}, server ${t.name}/${t.hidden}`);
        else if (recordSeq !== seq || bot.tasksEpoch !== this.server.epoch) this.fail("B", `${s.name} holds ${bot.id} at ${bot.tasksEpoch}/${recordSeq}, server ${this.server.epoch}/${seq}`);
      }
      const st = loose(s.state);
      for (const [id, t] of Object.entries((st.tombstones ?? {}) as Record<string, Loose>)) {
        // R10 (Astra r5 / Opus L5, retained by decision in r6 §10): the subject's own DELETE settled "deleted", the deletion frame
        // never reached it, and no roster it applied listed the removal. That entry, and nothing else, may outlive quiescence.
        const r10 = t.kind === "deleted" && t.streamAcked === false && t.epoch === st.streamEpoch &&
          s.settledDeleted.has(id) && !s.sawDeleteFrame.has(id) && !s.rosterRemoved.has(id);
        if (!r10) this.fail("C", `${s.name} keeps tombstone ${id} ${JSON.stringify(t)} after quiescence`);
      }
      if (Object.keys(st.pendingDeletes ?? {}).length) this.fail("C", `${s.name} keeps pendingDeletes ${Object.keys(st.pendingDeletes)}`);
      if (Object.keys(st.verifyBots ?? {}).length) this.fail("C", `${s.name} keeps verifyBots ${Object.keys(st.verifyBots)}`);
      for (const e of (st.pastEpochs ?? []) as unknown[]) {
        const seenAt = typeof e === "object" && e ? (e as Loose).seenAt : undefined;
        if (typeof seenAt === "number" && this.now() - seenAt > ANSWER_TTL_MS) this.fail("C", `${s.name} keeps past epoch ${JSON.stringify(e)} older than the TTL`);
      }
    }
  }

  /** Deliver everything still within its life, drop the rest, settle; `reload` then forces one `resumed:false` hydrate per subject
   * (the r6 §11 quiescence), `resume` does not (Opus "Check r6" 1: a forced reload rebuilds the list and hides divergence). Then the
   * clock passes the TTL and the sweep runs. */
  quiesce(mode: Mode): void {
    const settle = () => {
      for (let round = 0; round < 100; round++) {
        let moved = false;
        for (const r of [...this.reqs.values()]) if (r.phase === "awaiting") { this.commit(r.id); moved = true; }
        for (const r of [...this.reqs.values()]) if (r.phase === "toServer" || r.phase === "queued") { r.phase = "toServer"; this.process(r.id, "none"); moved = true; }
        for (const s of this.subs) if (!s.conn.up) { this.reconnect(s); moved = true; }
        for (const s of this.subs) while (s.conn.queue.length) { this.deliverFrame(s); moved = true; }
        for (const r of [...this.reqs.values()]) {
          if (r.phase !== "answered") continue;
          if (this.now() - r.sentAt <= ANSWER_TTL_MS) this.deliver(r.id);
          else {
            r.phase = "done";
            const s = this.sub(r.sub);
            if (r.kind === "roster" && s.hydrate.inFlight === r.id) s.hydrate.inFlight = null;
            if (r.kind === "detail") s.verifying.delete(r.botId!);
            for (const t of s.trackers) if (t.inflight === r.id) t.inflight = null;
          }
          moved = true;
        }
        moved = this.effects(true) || moved;
        if (!moved) return;
      }
      this.fail("X", "quiescence did not settle in 100 rounds");
    };
    settle();
    if (mode === "reload") {
      for (const s of this.subs) { this.disconnect(s); s.conn.cursor = -1; this.reconnect(s); }
      settle();
    }
    this.tick(ANSWER_TTL_MS + SWEEP_MS + 1);
    settle();
    this.tick(SWEEP_MS + 1);
    settle();
  }
}

/** One subject in a trace line: held ids with their run/number, pending, verify, tombstones. */
function summary(s: Subject): string {
  const st = loose(s.state);
  const held = s.state.bots.map((b) => `${b.id}${b.hidden ? "(h)" : ""}@${b.tasksEpoch}/${numberOf(b)}`).join(",");
  const keys = (o: unknown) => Object.keys((o ?? {}) as object).join(",");
  const tombs = Object.entries((st.tombstones ?? {}) as Record<string, Loose>).map(([id, t]) => `${id}:${t.kind[0]}${t.epoch}/${t.seq}${t.streamAcked ? "a" : ""}`).join(",");
  return `${s.name}[${held}] pend{${keys(st.pendingDeletes)}} ver{${keys(st.verifyBots)}} tomb{${tombs}}${s.hydrated ? "" : " (hydrating)"}`;
}

const pageMarker = (reqId: string): Loose => ({ id: `page:${reqId}`, role: "bot", kind: "text", text: `page ${reqId}`, at: 0 });

function numberOf(bot: Bot): number | undefined {
  const n = LEGACY ? bot.tasksSeq : (bot as unknown as Loose).recordSeq;
  return typeof n === "number" ? n : undefined;
}
function epochNoOf(bot: Bot): number | undefined {
  const e = bot.tasksEpoch;
  return typeof e === "string" && /^e\d+$/.test(e) ? Number(e.slice(1)) : undefined;
}
function fingerprint(state: AppState): string {
  return state.bots.map((b) => `${b.id}|${b.name}|${Boolean(b.hidden)}|${numberOf(b)}|${b.tasksEpoch}|${b.threadId}`).join(";");
}

/** HEAD's reducer (before merge 2) knows none of the new control actions. */
function toHead(action: Loose): Loose | null {
  switch (action.type) {
    case "pageRequested": case "deletionSettled": case "tombstonesSweep": case "streamDrained": case "clientScope": case VERIFY_404: return null;
    case "botDeleted": return action.hidden ? { type: "deleteBot", botId: action.botId, archived: true } : { type: "deleteBot", botId: action.botId };
    case "deleteBot": return { type: "deleteBot", botId: action.botId };
    default: return action;
  }
}

// ── Generation ─────────────────────────────────────────────────────────
const SUBS: SubName[] = ["D1", "D2", "P"];

export function generate(w: World, rnd: () => number, count: number): Op[] {
  const pick = <T>(xs: readonly T[]): T | undefined => (xs.length ? xs[Math.floor(rnd() * xs.length)] : undefined);
  const ops: Op[] = [];
  const failClass = (kind: ReqKind): Fail => {
    const x = rnd();
    if (x < 0.75) return "none";
    if (kind !== "delete") return x < 0.88 ? "netBefore" : "netAfter";
    return pick<Fail>(["netBefore", "netAfter", "json5xx", "nonJsonBefore", "nonJsonAfter"])!;
  };
  for (let i = 0; i < count; i++) {
    const sv = w.server;
    const reqs = [...w.reqs.values()];
    const toServer = reqs.filter((r) => r.phase === "toServer");
    const awaiting = reqs.filter((r) => r.phase === "awaiting");
    const answered = reqs.filter((r) => r.phase === "answered");
    const candidates: Array<[number, () => Op | undefined]> = [
      [24, () => {
        const sub = pick(SUBS)!;
        const s = w.sub(sub);
        const held = s.state.bots;
        const bot = pick(held);
        const kind = pick(["create", "duplicate", "rename", "hide", "restore", "delete", "delete", "switch", "switch", "deleteTask", "detail"] as const)!;
        if (kind === "create") return { t: "send", id: `r${i}`, sub, kind };
        if (!bot) return undefined;
        if (kind === "restore" && (s.surface === "phone" || !bot.hidden)) return undefined;
        if (kind === "switch" || kind === "deleteTask") {
          const thread = pick((bot.tasks ?? []).map((t) => t.threadId));
          return thread ? { t: "send", id: `r${i}`, sub, kind, botId: bot.id, thread } : undefined;
        }
        if (kind === "delete") return { t: "send", id: `r${i}`, sub, kind, botId: bot.id, archivedList: Boolean(bot.hidden) && s.surface === "desktop" };
        return { t: "send", id: `r${i}`, sub, kind, botId: bot.id };
      }],
      [toServer.length ? 20 : 0, () => { const r = pick(toServer)!; return { t: "process", req: r.id, fail: failClass(r.kind) }; }],
      [awaiting.length ? 6 : 0, () => ({ t: "commit", req: pick(awaiting)!.id })],
      [answered.length ? 20 : 0, () => ({ t: "deliver", req: pick(answered)!.id })],
      [20, () => {
        const ready = w.subs.filter((s) => s.conn.queue.length);
        const s = pick(ready);
        return s ? { t: "frame", sub: s.name } : undefined;
      }],
      [2, () => { const s = pick(w.subs.filter((x) => x.conn.up)); return s ? { t: "disconnect", sub: s.name } : undefined; }],
      [5, () => { const s = pick(w.subs.filter((x) => !x.conn.up)); return s ? { t: "reconnect", sub: s.name } : undefined; }],
      [1, () => ({ t: "reconcile", sub: pick(SUBS)! })],
      [6, () => {
        const kind = pick(["create", "rename", "hide", "restore", "delete", "busy", "busy", "switch", "deleteTask", "newTask"] as const)!;
        const bot = pick([...sv.bots.values()]);
        if (kind === "create") return { t: "server", id: `s${i}`, kind };
        if (!bot) return undefined;
        const thread = pick(bot.tasks);
        return { t: "server", kind, botId: bot.id, ...(kind === "switch" || kind === "deleteTask" ? { thread } : {}) };
      }],
      [1.5, () => { const bot = pick([...sv.bots.keys()]); return bot ? { t: "flood", botId: bot } : undefined; }],
      [0.6, () => ({ t: "restart" })],
      [6, () => {
        const x = rnd();
        return { t: "tick", ms: x < 0.7 ? 1 + Math.floor(rnd() * 5000) : x < 0.9 ? SWEEP_MS + 1 : ANSWER_TTL_MS + 1 };
      }],
    ];
    const total = candidates.reduce((sum, [weight]) => sum + weight, 0);
    let op: Op | undefined;
    for (let tries = 0; tries < 8 && !op; tries++) {
      let x = rnd() * total;
      for (const [weight, make] of candidates) {
        if ((x -= weight) <= 0) { op = make(); break; }
      }
    }
    op ??= { t: "tick", ms: 1 };
    ops.push(op);
    w.apply(op);
  }
  return ops;
}

// ── Runs and shrinking ─────────────────────────────────────────────────
export interface RunResult { failure: OrderFailure | null; ops: Op[] }

export function replay(make: () => World, ops: readonly Op[], mode: Mode, checkSteps = true, trace?: (line: string) => void): OrderFailure | null {
  const w = make();
  w.checking = checkSteps;
  for (const op of ops) {
    w.apply(op);
    trace?.(`${describeOp(op).padEnd(44)} ${w.subs.map(summary).join(" | ")}`);
    if (w.failure) return w.failure;
  }
  w.checking = true;
  w.quiesce(mode);
  if (!w.failure) w.checkQuiescent();
  return w.failure;
}

/** Drops operations from the end, then chunks from the middle, while the same invariant still fails. */
export function shrink(make: () => World, ops: Op[], mode: Mode, letter: Letter, budgetMs: number, realNow: () => number): Op[] {
  const deadline = realNow() + budgetMs;
  const same = (candidate: Op[]) => replay(make, candidate, mode)?.letter === letter;
  let cur = ops;
  // From the end: the shortest failing prefix (a failure is not monotone in the prefix, so a linear halving, not a bisection).
  for (let cut = Math.floor(cur.length / 2); cut >= 1 && realNow() < deadline; ) {
    const candidate = cur.slice(0, cur.length - cut);
    if (candidate.length && same(candidate)) cur = candidate; else cut = Math.floor(cut / 2);
  }
  for (let chunk = Math.max(1, Math.floor(cur.length / 2)); chunk >= 1 && realNow() < deadline; ) {
    let changed = false;
    for (let i = 0; i < cur.length && realNow() < deadline; ) {
      const candidate = [...cur.slice(0, i), ...cur.slice(i + chunk)];
      if (candidate.length && same(candidate)) { cur = candidate; changed = true; } else i += chunk;
    }
    if (!changed) chunk = Math.floor(chunk / 2);
  }
  return cur;
}
