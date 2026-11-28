// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// E15-V3 (designs/E15-V3-RELOAD-NO-RESULT-1023.md): an engine reload ends every turn running on the engines it replaces, and no
// turn.completed follows, so the pass-1 terminal mark (store.markTurnToolsUnrecorded) never runs for them. This record remembers the
// provider turns running on the attached fleet (liveTurns), takes the ones a reload ends into capture groups, and marks each turn's open
// tool rows "No result" when THAT TURN'S OWN engine child has closed, whoever owns the thread by then. Events the old fleet had queued
// in the bus when it was detached (bus.detachedSeq) join their group instead of the live set, so their rows are marked too.
// It is display only: it sends, charges and starts nothing. One terminal path marks a captured turn: markTurn.
// r3: a detach's record (its Epoch) is released on settle, never by a count of later detaches: it lives until every capture of that
// detach has settled, no event the bus stamped with it is still queued, and every turn waiting on it has had its own child close.
import { turnCloses, type EndedTurn } from "./reload-retain.ts";

export interface ReloadEndedDeps {
  /** databaseGeneration(): moves when the database handle opens or closes (wipe, restore, shutdown). */
  generation(): number;
  /** Store.markTurnToolsUnrecorded: the unchanged pass-1 predicate and patch. */
  mark(threadId: string, turnId: string): number;
  /** True for a locked-database error: the mark is retried after the writer gate, never dropped. */
  isBusy(error: unknown): boolean;
  /** Resolves when writers may run again (awaitWriterGateForeground). */
  waitGate(): Promise<void>;
  /** Which captured turns still have their own child open (reload-retain.ts turnCloses). */
  closes?: typeof turnCloses;
  /** bus.detachedQueued(seq): events the bus stamped with this detach that are still queued. */
  queued(seq: number): number;
  log?(line: string): void;
}

/** What an event means to this record, read by the host listener from the real event (never the fold's local copy). */
export interface EndedTurnEvent {
  type: string;
  threadId: string;
  turnId?: string;
  /** bus.instanceOf(event) ?? providerInstanceId: oversize events carry no field. */
  instanceId?: string;
  itemType?: string;
  toolKind?: string;
  /** bus.detachedSeq(event): set when the event was still queued when its fleet was detached. */
  detachedSeq?: number;
}

interface Group {
  readonly threadId: string;
  readonly instanceId: string;
  readonly seq: number;
  readonly generation: number;
  readonly turns: Set<string>;
  readonly settled: Set<string>;
  pending: number;
  state: "HELD" | "MARKED";
  released: boolean;
  late: string[];
}

type Unconfirmed = Parameters<typeof turnCloses>[1];

/** One detach (DESIGN-DELTA r3): the captures of it still open, whether its adapters have been asked (every capture settled), and the
 * unconfirmed set of each settled capture, which a turn that joins late is asked against. Released only by release(), never by count. */
interface Epoch { captures: number; settled: boolean; readonly unconfirmed: Unconfirmed[]; readonly generation: number }

export interface Capture { readonly seq: number; readonly turns: EndedTurn[]; readonly groups: Group[]; readonly epoch: Epoch }

const RETRY_MIN_MS = 25;
const RETRY_MAX_MS = 1000;

export class ReloadEndedTurns {
  private readonly live = new Map<string, Map<string, string>>();
  private readonly groups = new Map<string, Group[]>();
  private readonly epochs = new Map<number, Epoch>();
  private seen: number;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  private readonly deps: ReloadEndedDeps;

  // no parameter property: the server runs this file through Node's type stripping, which only erases types
  constructor(deps: ReloadEndedDeps) { this.deps = deps; this.seen = deps.generation(); }

  /** A database handle that opened or closed since the last call ended every turn this record held. */
  private sync(): void {
    const generation = this.deps.generation();
    if (generation === this.seen) return;
    this.seen = generation;
    this.live.clear();
    this.groups.clear();
    this.epochs.clear();
  }

  /** Detach records still held: each one waits on a queued event, an unsettled capture or a child close. */
  records(): number { this.sync(); return this.epochs.size; }

  /** The bus delivered the last event it had stamped with this detach (bus.onDetachDrained). */
  drained(seq: number): void { this.release(seq); }

  /** Sizes for tests and the bound check: one live turn per (thread, instance), groups released at the next current-fleet event. */
  sizes(): { liveTurns: number; groups: number } {
    this.sync();
    let live = 0, groups = 0;
    for (const turns of this.live.values()) live += turns.size;
    for (const list of this.groups.values()) groups += list.length;
    return { liveTurns: live, groups };
  }

  isLive(threadId: string, turnId: string): boolean { return this.live.get(threadId)?.has(turnId) === true; }

  /** The listener: every event of the thread, in the bus's per-thread order, after the fold's own work. */
  observe(event: EndedTurnEvent): void {
    this.sync();
    const { threadId, turnId, instanceId } = event;
    const seq = event.detachedSeq;
    if (seq === undefined) {
      if (instanceId === undefined) return;
      // per-thread FIFO: every queued old-fleet event of this thread has folded before a current-fleet one
      this.dropGroups(threadId, group => group.state === "MARKED");
      if (event.type === "turn.completed" || event.type === "session.exited") this.endLive(threadId, instanceId, turnId);
      else if (turnId && (event.type === "turn.started" || (event.type === "item.started" && event.itemType === "tool" && event.toolKind !== "notice"))) this.addLive(threadId, turnId, instanceId);
      return;
    }
    if (!turnId || instanceId === undefined) return;
    if (!(event.type === "turn.started" || ((event.type === "item.started" || event.type === "item.completed") && event.itemType === "tool"))) return;
    // a turn none of the capture's groups holds (its start was still queued at the detach) gets a group of its own, released when its
    // detach's settle has asked the adapters; with no record of that detach it is closed now
    let group = this.groupFor(threadId, instanceId, seq);
    if (!group) group = this.add({ threadId, instanceId, seq, generation: this.deps.generation(), turns: new Set(), settled: new Set(), pending: 0, state: "MARKED", released: this.epochs.get(seq)?.settled ?? true, late: [] });
    this.join(group, turnId);
  }

  /** The turn ended without a turn.completed the listener saw as current-fleet (a refused lease settle). */
  ended(threadId: string, turnId: string): void {
    this.sync();
    const turns = this.live.get(threadId);
    if (turns?.delete(turnId) && !turns.size) this.live.delete(threadId);
  }

  forgetThreads(threadIds: Iterable<string>): void {
    const seqs = new Set<number>();
    for (const threadId of threadIds) {
      for (const group of this.groups.get(threadId) ?? []) seqs.add(group.seq);
      this.live.delete(threadId); this.groups.delete(threadId);
    }
    // a held group of a deleted thread no longer keeps its detach's record
    for (const seq of seqs) this.release(seq);
  }

  /** Right after the bus detach: every live turn on the detached instances (all of them with no scope) leaves the live set into a group. */
  capture(seq: number, scope?: ReadonlySet<string>): Capture {
    this.sync();
    // bus.detach only counts a detach that took an attached instance: a repeated seq (a scoped reload that detached nothing) joins the
    // epoch it has, so its late turns wait for every capture of the detach and are asked against every capture's unconfirmed set
    let epoch = this.epochs.get(seq);
    if (!epoch) this.epochs.set(seq, epoch = { captures: 0, settled: false, unconfirmed: [], generation: this.deps.generation() });
    epoch.captures += 1;
    // a capture joining a detach that already settled reopens it: a late turn arriving now waits for this capture's unconfirmed set too
    if (epoch.settled) {
      epoch.settled = false;
      for (const list of this.groups.values()) for (const group of list) if (group.seq === seq) group.released = false;
    }
    const capture: Capture = { seq, turns: [], groups: [], epoch };
    for (const [threadId, turns] of [...this.live]) {
      const byInstance = new Map<string, string[]>();
      for (const [turnId, instanceId] of turns) if (!scope || scope.has(instanceId)) (byInstance.get(instanceId) ?? byInstance.set(instanceId, []).get(instanceId)!).push(turnId);
      for (const [instanceId, ids] of byInstance) {
        // an older MARKED group of this pair would never be released if the thread never runs again
        this.dropGroups(threadId, group => group.instanceId === instanceId && group.state === "MARKED");
        const group = this.add({ threadId, instanceId, seq, generation: this.deps.generation(), turns: new Set(ids), settled: new Set(), pending: ids.length, state: "HELD", released: false, late: [] });
        capture.groups.push(group);
        for (const turnId of ids) { turns.delete(turnId); capture.turns.push({ threadId, turnId, instanceId }); }
      }
      if (!turns.size) this.live.delete(threadId);
    }
    return capture;
  }

  /** After the engines are disposed: every captured turn is marked when its own child has closed (now, or when its close settles, fulfilled
   * or rejected: the mark is display only). Never throws: a failure to ask the adapters means every turn is closed now. */
  private dropGroups(threadId: string, drop: (group: Group) => boolean): void {
    const list = this.groups.get(threadId);
    if (!list) return;
    const keep = list.filter(group => !drop(group));
    if (keep.length) this.groups.set(threadId, keep); else this.groups.delete(threadId);
  }

  async settle(capture: Capture, unconfirmed: Parameters<typeof turnCloses>[1]): Promise<void> {
    let results: Awaited<ReturnType<typeof turnCloses>>;
    try { results = await (this.deps.closes ?? turnCloses)(capture.turns, unconfirmed as never); }
    catch { this.deps.log?.("[e15-reload-mark] count=1"); results = capture.turns.map(turn => ({ turn })); }
    const group = (turn: EndedTurn) => capture.groups.find(g => g.threadId === turn.threadId && g.instanceId === turn.instanceId && g.turns.has(turn.turnId))!;
    for (const { turn, close } of results) {
      const owner = group(turn);
      if (close) {
        const settle = () => this.settleTurn(owner, turn.turnId);
        close.then(settle, settle);
      } else this.settleTurn(owner, turn.turnId);
    }
    const epoch = this.epochs.get(capture.seq) === capture.epoch ? capture.epoch : undefined;
    if (epoch) {
      epoch.unconfirmed.push(unconfirmed);
      epoch.captures -= 1;
      if (epoch.captures <= 0) epoch.settled = true;
    }
    // every group of this detach, the ones a late event made too, once its last capture has settled
    if (!epoch || epoch.settled) for (const list of [...this.groups.values()]) for (const owner of [...list]) {
      if (owner.seq !== capture.seq || owner.released) continue;
      owner.released = true;
      for (const turnId of owner.late.splice(0)) this.watchLate(owner, turnId);
    }
    this.release(capture.seq);
  }

  /** The one place a detach's record is released (DESIGN-DELTA r3): every capture settled, no event stamped with it still queued, and
   * no group of it still waiting on a child close. Released, no event of this detach can reach observe again. */
  private release(seq: number): void {
    this.sync();
    const epoch = this.epochs.get(seq);
    if (!epoch || !epoch.settled || epoch.captures > 0 || this.deps.queued(seq) > 0) return;
    for (const list of this.groups.values()) for (const group of list) if (group.seq === seq && group.pending > 0) return;
    this.epochs.delete(seq);
  }

  private groupFor(threadId: string, instanceId: string, seq: number): Group | undefined {
    return this.groups.get(threadId)?.find(group => group.instanceId === instanceId && group.seq === seq);
  }

  private add(group: Group): Group {
    const list = this.groups.get(group.threadId);
    if (list) list.push(group); else this.groups.set(group.threadId, [group]);
    return group;
  }

  private isOpen(group: Group): boolean { return this.groups.get(group.threadId)?.includes(group) === true; }

  private addLive(threadId: string, turnId: string, instanceId: string): void {
    let turns = this.live.get(threadId);
    if (!turns) this.live.set(threadId, turns = new Map());
    // one engine runs one turn per thread at a time: a newer turn evicts an older one of the same pair
    for (const [other, owner] of [...turns]) if (owner === instanceId && other !== turnId) turns.delete(other);
    turns.set(turnId, instanceId);
  }

  private endLive(threadId: string, instanceId: string, turnId?: string): void {
    const turns = this.live.get(threadId);
    if (!turns) return;
    for (const [other, owner] of [...turns]) if (turnId ? other === turnId : owner === instanceId) turns.delete(other);
    if (!turns.size) this.live.delete(threadId);
  }

  /** A turn of an old fleet's event joins its group. A MARKED group marks again at every late row (the mark is idempotent and the row is new);
   * a HELD one is joined once, because the fold can be retried for the same event. A live turn (a current-fleet turn that reused the id) is never marked. */
  private join(group: Group, turnId: string): void {
    if (this.isLive(group.threadId, turnId)) return;
    // a turn this group already settled has a closed child: its late row is marked at write
    if (group.settled.has(turnId)) { this.markTurn(group, turnId, () => undefined); return; }
    if (group.turns.has(turnId)) return;
    group.turns.add(turnId);
    group.pending += 1;
    group.state = "HELD";
    if (!group.released) group.late.push(turnId); else this.watchLate(group, turnId);
  }

  /** A turn that joined after the capture waits on its OWN child, never on the close of the turn it joined beside. */
  private watchLate(group: Group, turnId: string): void {
    const settle = () => this.settleTurn(group, turnId);
    // every settled capture of this detach may hold the adapter of the turn's child: it settles when every close they return has
    const sets: Unconfirmed[] = this.epochs.get(group.seq)?.unconfirmed ?? [undefined];
    let asks: ReturnType<typeof turnCloses>[];
    try { asks = sets.map(unconfirmed => (this.deps.closes ?? turnCloses)([{ threadId: group.threadId, turnId, instanceId: group.instanceId }], unconfirmed as never)); }
    catch { settle(); return; }
    void Promise.all(asks.map(ask => ask.then(([result]) => result?.close?.catch(() => undefined), () => undefined))).then(settle, settle);
  }

  private settleTurn(group: Group, turnId: string): void {
    this.markTurn(group, turnId, () => {
      group.settled.add(turnId);
      group.pending -= 1;
      if (group.pending <= 0) group.state = "MARKED";
      this.release(group.seq);
    });
  }

  /** The one place a reload-ended turn's rows are marked. */
  private markTurn(group: Group, turnId: string, done: () => void, attempt = 0): void {
    this.sync();
    // a wipe, restore or shutdown since the capture: the callback never borrows the successor's database
    // a retry outlives its group's release (the thread's next current-fleet event): only the fence stops it, never a dropped mark
    if ((attempt === 0 && !this.isOpen(group)) || group.generation !== this.deps.generation()) return;
    if (!this.isLive(group.threadId, turnId)) {
      try { this.deps.mark(group.threadId, turnId); }
      catch (error) {
        if (this.deps.isBusy(error)) { this.retry(() => this.markTurn(group, turnId, done, attempt + 1), attempt); return; }
        this.deps.log?.("[e15-reload-mark] count=1");
      }
    }
    done();
  }

  /** A locked database keeps the turn pending until the writer gate lets it through; never a dropped mark. */
  private retry(run: () => void, attempt: number): void {
    void this.deps.waitGate().catch(() => undefined).then(() => {
      const timer = setTimeout(() => { this.timers.delete(timer); run(); }, Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.min(attempt, 6)));
      timer.unref?.();
      this.timers.add(timer);
    });
  }
}
