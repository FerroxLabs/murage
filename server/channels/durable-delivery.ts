import { createHash, randomUUID } from "node:crypto";
import { channelReply } from "./reply-text.ts";
import { buildSchema, id, type DeliveryMedia as Media, type DeliveryQuote as Quote, type State } from "./delivery-ledger-v1.ts";
import { LEDGER_INVALID, LedgerStore, ledgerExists } from "./delivery-ledger-store.ts";

export type DeliveryQuote = Quote;
export type DeliveryMedia = Media;
export class ChannelSendError extends Error {
  public code: "auth" | "forbidden" | "rate-limit" | "invalid-request" | "offline" | "timeout" | "unavailable";
  public uncertain: boolean;
  public retryAfterSeconds?: number;
  /** Some chunks of a multi-part reply went out; the record is kept for review and never retried. */
  public partial: boolean;
  constructor(code: ChannelSendError["code"], uncertain: boolean, retryAfterSeconds?: number, partial = false) {
    super(code); this.code = code; this.uncertain = uncertain; this.retryAfterSeconds = retryAfterSeconds; this.partial = partial;
  }
}
export interface ChannelRuns {
  /** `media` is the record's stored attachments (WhatsApp images); adapters that keep none never see the field. */
  enqueue(input: { deliveryId: string; prompt: string; media?: DeliveryMedia[] }): { id: string };
  /** `notice`: one plain line for the sender while the run waits (an engine limit); sent once per record, never as the answer. */
  result(id: string): { status: string; output?: string; error?: string; notice?: string } | null;
  /** Voice notes the run made, each handed out once (server/voice/voice-notes.ts). */
  voiceNotes?(id: string): Array<{ name: string; mime: string; bytes: Uint8Array; text: string; from: string }>;
}
export interface DeliveryAttempt { deliveryId: string; purpose: "reply" | "notice"; attempt: number }
interface Options {
  /** Adapter-owned creation boundary; applies equally to root and overflow pages. */
  writeFile?: (file:string,data:string)=>void;
  file: string; bindingKey: string; recipient: string; isCurrent: () => boolean;
  runs: ChannelRuns;
  send: (input: DeliveryAttempt & { recipient: string; text: string; signal: AbortSignal; reserved?: string[]; quote?: DeliveryQuote }) => Promise<{ recipient: string; messageId: string }>;
  /** Longest stored reply. Default 4000; WhatsApp passes 20000 so its chunker receives the whole reply. */
  maxResponse?: number;
  clearResponseOnSettle?: boolean;
  /** Persist the notice attempt before calling either hook. Unset preserves WhatsApp's best-effort retries. */
  noticeAtMostOnce?: boolean;
  /** Called before `send`; returns the ids the send must use (WhatsApp reserves them on disk first). A failure is a send failure. */
  reserve?: (input: DeliveryAttempt & { recipient: string; text: string }) => Promise<string[]>;
  /** Sends one voice note after the run's text reply went. Best effort: a
   *  note that cannot be sent is still in the Murage chat and in Files. */
  sendAudio?: (input: { recipient: string; name: string; mime: string; bytes: Uint8Array; title: string; signal: AbortSignal }) => Promise<void>;
  now?: () => number;
}
const windowMs = 7 * 86400000;
const pending = (s: string) => ["accepted", "queued", "sending"].includes(s);
const settled = (s: string) => s === "sent" || s === "cancelled";
/** The same post-reclamation view is used for capacity, admission and resend. */
function keepTombstone(row: LineageRow, now: number, referenced: Set<string>) {
  return row.occurredAt >= now - windowMs || (row.expiresAt !== undefined && row.expiresAt > now) || referenced.has(row.deliveryId);
}
function reclaimed(state: State, now: number) {
  const referenced = new Set(state.records.filter(r => !settled(r.state)).flatMap(r => r.sourceDeliveryId ? [r.sourceDeliveryId] : []));
  return {
    records: state.records.filter(r => !settled(r.state)),
    tombstones: [...state.tombstones.filter(r => keepTombstone(r, now, referenced)),
      ...state.records.filter(r => settled(r.state) && keepTombstone(r, now, referenced)).map(r => ({
        deliveryId: r.deliveryId, ...(r.dedupeId ? { dedupeId: r.dedupeId } : {}), ...(r.sourceDeliveryId ? { sourceDeliveryId: r.sourceDeliveryId } : {}),
        ...(r.expiresAt === undefined ? {} : { expiresAt: r.expiresAt }), ...(r.expiryKnown ? { expiryKnown: true as const } : {}), occurredAt: r.occurredAt,
      }))],
  };
}
function review(record: State["records"][number]) {
  record.state = "cancelled"; record.error = "reviewed"; record.prompt = ""; delete record.response;
}
const matches = (r: { deliveryId: string; dedupeId?: string }, deliveryId: string) => r.deliveryId === deliveryId || r.dedupeId === deliveryId;
const contains = (state: State, deliveryId: string) => state.records.some(r => matches(r, deliveryId)) || state.tombstones.some(r => matches(r, deliveryId));

const resendId = (source: string) => createHash("sha256").update(source).update("\0resend").digest("hex");
type LineageRow = State["tombstones"][number];
/** Include every retained ancestor, even when the root has already been reclaimed. */
function lineage(row: LineageRow, rows: Map<string, LineageRow>) {
  const ids = new Set<string>();
  let source = row.deliveryId, expiresAt: number | undefined;
  let current: LineageRow | undefined = row;
  while (current) {
    if (ids.has(current.deliveryId)) throw new Error("Invalid resend lineage");
    ids.add(current.deliveryId);
    if (current.expiresAt !== undefined) expiresAt = Math.min(expiresAt ?? current.expiresAt, current.expiresAt);
    source = current.sourceDeliveryId ?? current.deliveryId;
    if (!current.sourceDeliveryId) break;
    current = rows.get(current.sourceDeliveryId);
  }
  ids.add(source);
  return { source, expiresAt, ids };
}
/** Restore legacy deterministic links before compressing ancestry or pruning it.
 * Copy the minimum deadline along with the source, including through tombstones.
 */
function restoreResendSources(state: State, knownSources: string[] = []): boolean {
  const rows = [...state.records, ...state.tombstones];
  const parents = new Map([...knownSources.map(deliveryId => ({ deliveryId })), ...rows].map(row => [resendId(row.deliveryId), row]));
  let changed = false;
  for (const row of rows) {
    const parent = parents.get(row.deliveryId);
    if (!row.sourceDeliveryId && parent) { row.sourceDeliveryId = parent.deliveryId; changed = true; }
  }
  const byId = new Map(rows.map(row => [row.deliveryId, row]));
  // Snapshot ancestry before compressing it: order must not lose an intermediate deadline.
  const families = new Map<string, LineageRow[]>();
  for (const row of rows) {
    const source = lineage(row, byId).source;
    const family = families.get(source) ?? []; family.push(row); families.set(source, family);
  }
  for (const [source, family] of families) {
    const deadlines = family.flatMap(row => row.expiresAt === undefined ? [] : [row.expiresAt]);
    const minimum = deadlines.length ? Math.min(...deadlines) : undefined;
    const known = family.some(row => row.expiryKnown);
    for (const row of family) {
      if (row.sourceDeliveryId && row.sourceDeliveryId !== source) { row.sourceDeliveryId = source; changed = true; }
      if (minimum !== undefined && row.expiresAt !== minimum) { row.expiresAt = minimum; changed = true; }
      if (known && !row.expiryKnown) { row.expiryKnown = true; changed = true; }
    }
  }
  return changed;
}

/** New adapters' local receipt ledger; Telegram's existing ledger is deliberately unchanged. */
export class DurableDelivery {
  /** Merge before opening any ledger. Keep original ids for run receipt recovery. */
  static consolidate(target: Pick<Options, "file" | "bindingKey" | "recipient" | "writeFile">, sources: Array<Pick<Options, "file" | "bindingKey" | "recipient">>, dedupeId: (id: string) => string, now = Date.now()): void {
    const writeFile = target.writeFile;
    const records = new Map<string, State["records"][number]>(), tombstones = new Map<string, State["tombstones"][number]>();
    let original: string | undefined;
    // The canonical file wins on retry after a crash between ledger and chat-list writes.
    for (const source of [...sources.filter(s => s.file !== target.file), target]) {
      const store = new LedgerStore(source.file, target.file === source.file ? writeFile : undefined);
      let state: State, found: ReturnType<LedgerStore["load"]>;
      try { found = store.load(20_000, { migrate: false }); } finally { store.release(); }
      if (!found) continue;
      state = found.state;
      if (source.file === target.file) original = JSON.stringify(state);
      if (state.bindingKey !== source.bindingKey || state.recipient !== source.recipient) throw new Error("Channel receipt binding mismatch");
      const ids = [...state.records, ...state.tombstones].map(r => r.deliveryId);
      if (new Set(ids).size !== ids.length) throw new Error("Duplicate channel receipt");
      for (const row of state.records) { records.set(row.deliveryId, { ...row, dedupeId: dedupeId(row.deliveryId) }); tombstones.delete(row.deliveryId); }
      for (const row of state.tombstones) {
        // A pending receipt always survives, even if another file has a tombstone.
        if ((row.occurredAt >= now - windowMs || (row.expiresAt !== undefined && row.expiresAt > now)) && !records.has(row.deliveryId)) tombstones.set(row.deliveryId, { ...row, dedupeId: dedupeId(row.deliveryId) });
      }
    }
    if (!records.size && !tombstones.size && original === undefined) return;
    for (const [id, row] of records) {
      if (["sent", "cancelled"].includes(row.state) && row.occurredAt < now - windowMs && (row.expiresAt === undefined || row.expiresAt <= now)) records.delete(id);
    }
    const counts = new Map<string, number>();
    for (const row of [...records.values(), ...tombstones.values()]) counts.set(row.dedupeId!, (counts.get(row.dedupeId!) ?? 0) + 1);
    for (const row of records.values()) {
      if (pending(row.state) && counts.get(row.dedupeId!)! > 1) { row.state = "needs-review"; row.error = "alias-duplicate"; }
    }
    const canonical = new Map<string, State["tombstones"][number]>();
    for (const row of tombstones.values()) {
      if (row.occurredAt < now - windowMs && (row.expiresAt === undefined || row.expiresAt <= now)) continue;
      const previous = canonical.get(row.dedupeId!);
      if (!previous || row.occurredAt > previous.occurredAt) canonical.set(row.dedupeId!, row);
    }
    const state: State = { version: 1, bindingKey: target.bindingKey, recipient: target.recipient,
      records: [...records.values()], tombstones: [...canonical.values()] };
    if (JSON.stringify(state) !== original) {
      buildSchema(20_000, false).parse(state);
      const store = new LedgerStore(target.file, writeFile);
      try {
        const row = store.row(), v1 = row ? undefined : store.load(20_000, { migrate: false });
        // An unmigrated v1 target keeps its files for the verified retirement; the row records their hash.
        store.commit(state, v1 && v1.row.legacy === "kept" ? { legacy: "kept", sha: v1.row.legacy_sha256, by: store.nonce } : undefined);
      } finally { store.release(); }
    }
  }
  /** True when a store row or a v1 root exists for this ledger. Never creates the store; a read error answers true (the constructor then fails closed). */
  static exists(file: string): boolean { return ledgerExists(file); }

  private state: State;
  private schema: ReturnType<typeof buildSchema>;
  private maxResponse: number;
  private stopped = false;
  private controller = new AbortController();
  private draining?: Promise<void>;
  private stopping?: Promise<void>;
  private retiring?: Promise<{ removed: number; failed: number; more: boolean }>;
  private sweeping?: Promise<{ removed: number; failed: number }>;
  /** Only the current audio batch needs cancellation history after receipt reclamation. */
  private audioDelivery?: { deliveryId: string; cancelled: boolean };
  private options: Options;
  private sweepFailureCount = 0;
  private store?: LedgerStore;
  private readonly ownNonce = randomUUID();
  private diverged = false;
  get pageSweepFailures() { return this.sweepFailureCount; }
  /** 1 while an older build's v1 file sits beside the store (the store stays authoritative; nothing is deleted). */
  get legacyDiverged() { return this.diverged ? 1 : 0; }
  /** The records as committed (the in-memory state always equals the committed rows). */
  snapshotRecords(): State["records"] { return structuredClone(this.state.records); }
  constructor(options: Options) {
    this.options = options;
    this.maxResponse = options.maxResponse ?? 4000;
    this.schema = buildSchema(this.maxResponse, false);
    this.state = this.schema.parse({ version: 1, bindingKey: options.bindingKey, recipient: options.recipient, records: [], tombstones: [] });
    try {
      this.store = new LedgerStore(options.file, options.writeFile, this.ownNonce);
      const found = this.store.load(this.maxResponse, { migrate: true });
      if (found) {
        this.state = found.state; this.diverged = found.row.legacy === "diverged";
        if (this.state.bindingKey !== options.bindingKey || this.state.recipient !== options.recipient) throw new Error();
        const ids = [...this.state.records, ...this.state.tombstones].map(r => r.deliveryId);
        if (new Set(ids).size !== ids.length) throw new Error();
        const migration = structuredClone(this.state);
        const restoredSources = restoreResendSources(migration);
        if (restoredSources || this.state.records.some(r => r.state === "sending")) this.mutate(s => {
          restoreResendSources(s);
          for (const r of s.records) if (r.state === "sending") r.state = "uncertain";
          return { commit: true, result: undefined };
        });
      }
    } catch { this.store?.release(); this.store = undefined; throw new Error(LEDGER_INVALID); }
    // Legacy v1 files are retired in bounded idle steps, never inside the constructor.
    const step = async () => { if (this.stopped) return; const r = await this.retireStep(); if (r.more && !r.failed && r.removed > 0) setImmediate(step).unref(); };
    setImmediate(step).unref();
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  /** The ledger's own lease while it runs; after stop(), a transient one the caller releases (a revoke after a stop commits through it). */
  private lease(): { store: LedgerStore; transient: boolean } {
    if (this.store && !this.store.isReleased) return { store: this.store, transient: false };
    return { store: new LedgerStore(this.options.file, this.options.writeFile, this.ownNonce), transient: true };
  }
  private mutate<T>(change: (state: State) => { commit: boolean; result: T }): T {
    const next = structuredClone(this.state), decision = change(next);
    if (!decision.commit) return decision.result;
    this.schema.parse(next);
    const { store, transient } = this.lease();
    try { store.commit(next); } finally { if (transient) this.stopping = Promise.allSettled([this.stopping, store.release()]).then(() => {}); }
    this.state = next;
    const audio = this.audioDelivery;
    if (audio && next.records.some(r => r.deliveryId === audio.deliveryId && r.state === "cancelled")) audio.cancelled = true;
    return decision.result;
  }

  private active() { return !this.stopped && !this.controller.signal.aborted && this.options.isCurrent(); }
  accept(input: { deliveryId: string; prompt: string; occurredAt: number; expiresAt?: number; expiryKnown?: true; response?: string; quote?: DeliveryQuote; media?: DeliveryMedia[] }): "accepted" | "duplicate" {
    if (!this.active()) throw new Error("Channel binding is not current");
    if (this.has(input.deliveryId)) return "duplicate";
    if (!Number.isFinite(input.occurredAt) || input.occurredAt < this.now() - windowMs || input.occurredAt > this.now() + 300000) throw new Error("Channel event is outside the admission window");
    this.mutate(s => {
      Object.assign(s, reclaimed(s, this.now()));
      if (s.records.length >= 200 || s.tombstones.length >= 10000) throw new Error("Channel pending receipt limit");
      s.records.push({ ...input, attempts: 0, state: "accepted" });
      return { commit: true, result: undefined };
    });
    return "accepted";
  }
  /** Occupied slots after reclaiming completed records, not the number of free slots. */
  admissionCapacity(): { records: number; tombstones: number } {
    const next = reclaimed(this.state, this.now());
    return { records: next.records.length, tombstones: next.tombstones.length };
  }
  settle(deliveryId: string): void {
    this.mutate(s => {
      const record = s.records.find(r => r.deliveryId === deliveryId);
      if (!record || record.state === "cancelled") return { commit: false, result: undefined };
      review(record);
      return { commit: true, result: undefined };
    });
    this.cancelAudio(deliveryId);
  }
  /** Commit the deadline before ingress marks it mirrored. Replays can only tighten it. */
  setExpiry(deliveryId: string, expiresAt: number): boolean {
    if (!Number.isFinite(expiresAt)) throw new Error("Invalid delivery expiry");
    return this.mutate(s => {
      let changed = restoreResendSources(s, [deliveryId]);
      const rows = [...s.records, ...s.tombstones], byId = new Map(rows.map(row => [row.deliveryId, row]));
      const source = byId.get(deliveryId);
      const root = source ? lineage(source, byId).source : deliveryId;
      const family = rows.filter(row => lineage(row, byId).source === root);
      const deadline = Math.min(expiresAt, ...family.flatMap(row => row.expiresAt === undefined ? [] : [row.expiresAt]));
      for (const row of family) {
        if (row.expiresAt !== deadline || !row.expiryKnown) { row.expiresAt = deadline; row.expiryKnown = true; changed = true; }
      }
      const found = family.length > 0;
      return { commit: changed, result: found };
    });
  }
  /** Signal migration: an intact journal proves the original timer, including no timer.
   * A retained deadline also protects older copies. With neither, do not guess that
   * a legacy receipt was permanent. Persist proof before journal reclamation.
   */
  recoverExpiry(sources: Array<{ deliveryId: string; expiresAt?: number }>): void {
    this.mutate(s => {
      let changed = restoreResendSources(s, sources.map(row => row.deliveryId));
      const rows = [...s.records, ...s.tombstones], byId = new Map(rows.map(row => [row.deliveryId, row]));
      const evidence = new Map(sources.map(row => [row.deliveryId, row]));
      for (const row of rows) {
        const ancestry = lineage(row, byId);
        const proof = evidence.get(ancestry.source) ?? evidence.get(row.deliveryId);
        if (proof || row.expiresAt !== undefined) {
          if (!row.expiryKnown) { row.expiryKnown = true; changed = true; }
          if (proof?.expiresAt !== undefined && (row.expiresAt === undefined || row.expiresAt > proof.expiresAt)) {
            row.expiresAt = proof.expiresAt; changed = true;
          }
        }
      }
      changed = restoreResendSources(s) || changed;
      return { commit: changed, result: undefined };
    });
  }
  unknownExpirySourceIds(): string[] {
    return [...new Set(this.state.records.filter(r => !r.expiryKnown).map(r => r.sourceDeliveryId ?? r.deliveryId))];
  }
  /** The replacement and the original's settlement share the root-page commit. */
  resend(oldId: string): "resent" | "already" | "full" {
    return this.mutate<"resent" | "already" | "full">(s => {
      const old = s.records.find(r => r.deliveryId === oldId);
      if (!old || old.state === "cancelled") return { commit: false, result: "already" };
      // NUL separates the domain from the id (receipt ids cannot contain NUL).
      const deliveryId = resendId(oldId);
      if (contains(s, deliveryId)) {
        review(old); return { commit: true, result: "already" };
      }
      const inherited = lineage(old, new Map([...s.records, ...s.tombstones].map(row => [row.deliveryId, row])));
      const now = this.now(), next = reclaimed(s, now);
      if (next.records.length >= 200 || next.tombstones.length >= 10000) return { commit: false, result: "full" };
      Object.assign(s, next);
      // Keep the reviewed source in this commit even if it was already sent.
      // The next admission can reclaim it like any other cancelled record.
      if (!s.records.includes(old)) {
        s.records.push(old);
        s.tombstones = s.tombstones.filter(r => r.deliveryId !== oldId);
      }
      s.records.push({ deliveryId, sourceDeliveryId: inherited.source,
        ...(inherited.expiresAt === undefined ? {} : { expiresAt: inherited.expiresAt }), ...(old.expiryKnown ? { expiryKnown: true as const } : {}), prompt: old.prompt, ...(old.response !== undefined ? { response: old.response } : {}),
        occurredAt: now, attempts: 0, state: "accepted" });
      review(old);
      return { commit: true, result: "resent" };
    });
  }
  /** A resend retains its source even after earlier receipts become tombstones. */
  redact(deliveryId: string): { runId?: string; descendantRunIds?: string[] } | null {
    const family = (s: State) => {
      const record = s.records.find(r => r.deliveryId === deliveryId);
      const source = record?.sourceDeliveryId ?? deliveryId;
      return { record, related: s.records.filter(r => r.deliveryId === source || r.sourceDeliveryId === source) };
    };
    const unredacted = (row: State["records"][number]) => row.error !== "redacted" || row.state !== "cancelled" || row.prompt !== ""
      || row.response !== undefined || row.quote !== undefined || row.media !== undefined;
    const answer = ({ record, related }: ReturnType<typeof family>) => {
      const descendantRunIds = [...new Set(related.filter(r => r !== record && r.runId !== undefined).map(r => r.runId!))];
      return { ...(record?.runId === undefined ? {} : { runId: record.runId }), ...(descendantRunIds.length ? { descendantRunIds } : {}) };
    };
    // An already redacted family is answered from the committed state: no copy of the state, no commit, no sweep.
    const held = family(this.state);
    if (!held.related.length) { this.cancelAudio(deliveryId); return null; }
    if (!held.related.some(unredacted)) { this.cancelAudio(deliveryId); return answer(held); }
    const result = this.mutate<{ runId?: string; descendantRunIds?: string[] } | null>(s => {
      const found = family(s);
      for (const row of found.related) {
        row.prompt = ""; delete row.response; delete row.quote; delete row.media;
        row.state = "cancelled"; row.error = "redacted";
      }
      return { commit: true, result: answer(found) };
    });
    this.cancelAudio(deliveryId);
    void this.sweepPages();
    return result;
  }
  private cancelAudio(deliveryId: string) {
    if (this.audioDelivery?.deliveryId === deliveryId) this.audioDelivery.cancelled = true;
  }
  /** Deadlines follow copies even after the ingress journal's retention window. */
  expiredSourceIds(): string[] {
    return [...new Set(this.state.records.filter(r => r.expiresAt !== undefined && r.expiresAt <= this.now())
      .map(r => r.sourceDeliveryId ?? r.deliveryId))];
  }
  /** Missing records are terminal, including rows reclaimed during a suspended send. */
  isRedacted(deliveryId: string): boolean {
    const record = this.state.records.find(r => r.deliveryId === deliveryId);
    return !record || record.error === "redacted";
  }
  /** One bounded step of the verified legacy-file retirement. A failed step backs off in the store; it is not retried per turn. */
  private retireStep(): Promise<{ removed: number; failed: number; more: boolean }> {
    return this.retiring ??= this.runRetireStep().finally(() => { this.retiring = undefined; });
  }
  private async runRetireStep(): Promise<{ removed: number; failed: number; more: boolean }> {
    if (this.stopped) return { removed: 0, failed: 0, more: false };
    let result = { removed: 0, failed: 0, more: false };
    const { store, transient } = this.lease();
    try { result = await store.retire(this.maxResponse, this.state, this.ownNonce, this.now()); if (!store.isReleased) this.diverged = store.row()?.legacy === "diverged"; }
    catch { result = { removed: 0, failed: 1, more: false }; }
    finally { if (transient) await store.release(); }
    this.sweepFailureCount += result.failed;
    return result;
  }
  /** Runs one retirement step and folds the WAL so redacted bytes leave it promptly. */
  sweepPages(): Promise<{ removed: number; failed: number }> {
    const sweep = this.runSweepPages(this.sweeping ?? this.retireStep());
    this.sweeping = sweep;
    return sweep.finally(() => { if (this.sweeping === sweep) this.sweeping = undefined; });
  }
  private async runSweepPages(retirement: Promise<{ removed: number; failed: number }>): Promise<{ removed: number; failed: number }> {
    const { store, transient } = this.lease();
    try { await store.checkpoint(); } catch { /* best effort */ } finally { if (transient) await store.release(); }
    const { removed, failed } = await retirement;
    return { removed, failed };
  }
  status() {
    return { pending: this.state.records.filter(r => pending(r.state)).length,
      uncertain: this.state.records.filter(r => r.state === "uncertain").length,
      rejected: this.state.records.filter(r => r.state === "rejected").length,
      needsReview: this.state.records.filter(r => r.state === "needs-review").length };
  }
  /** True when this delivery id is already a record or a tombstone (so a resend need not redo expensive work). */
  has(deliveryId: string): boolean { return contains(this.state, deliveryId); }
  /** Media files that records still need: unfinished work, or a reply whose delivery is uncertain or awaiting review. The adapter's sweep keeps these. */
  referencedMedia(): string[] { return this.state.records.filter(r => ["accepted", "queued", "sending", "uncertain", "needs-review"].includes(r.state)).flatMap(r => (r.media ?? []).map(m => m.path)); }
  /** Run ids of unfinished records, so an adapter can cancel exactly the tasks of a chat it just revoked. */
  pendingRunIds(): string[] { return this.state.records.filter(r => pending(r.state) && r.runId !== undefined).map(r => r.runId!); }
  get maintenancePending() { return Boolean(this.sweeping || this.retiring || this.store?.maintenancePending); }
  stop(): Promise<void> {
    this.stopped = true; this.controller.abort();
    const closing = this.store?.release(); this.store = undefined;
    return this.stopping = Promise.allSettled([this.stopping, closing, this.sweeping, this.retiring]).then(() => {});
  }
  revoke() {
    this.stop();
    this.mutate(s => {
      for (const r of s.records) if (pending(r.state)) r.state = r.state === "sending" ? "uncertain" : "cancelled";
      return { commit: true, result: undefined };
    });
  }
  drain(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = this.work().finally(() => { this.draining = undefined; });
    return this.draining;
  }
  private async work() {
    delivery: for (const original of [...this.state.records]) {
      if (!this.active()) return;
      const lookup = () => this.state.records.find(r => r.deliveryId === original.deliveryId);
      const live = (r: State["records"][number] | undefined): r is State["records"][number] => !!r && r.error !== "redacted" && r.state !== "cancelled";
      const change = (fn: (r: State["records"][number]) => void) => this.mutate(s => {
        const record = s.records.find(r => r.deliveryId === original.deliveryId);
        if (!live(record)) return { commit: false, result: undefined };
        fn(record); return { commit: true, result: undefined };
      });
      let r = lookup();
      if (!live(r)) continue;
      if (r.state === "accepted" && r.response === undefined) {
        if (this.state.records.filter(x => x.state === "queued" && x.response === undefined).length >= 3) continue;
        // enqueue must return a retained receipt on retry across the cross-file crash window.
        let run:{id:string};
        try{run=this.options.runs.enqueue({ deliveryId: r.deliveryId, prompt: r.prompt, ...(r.media?.length ? { media: r.media.map(m => ({ ...m })) } : {}) });}
        catch(error){
          if(!(error instanceof Error)||!/^HUMAN_(?:LINK_REQUIRED|BINDING_REVOKED)/.test(error.message))throw error;
          change(x=>{x.response=channelReply("channelReply.linkAccount");});
          continue;
        }
        if (!this.active()) return;
        change(x => { x.runId = run.id; x.state = "queued"; }); r = lookup();
        if (!live(r)) continue;
      }
      if (r.state === "queued" && r.response === undefined) {
        const result = this.options.runs.result(r.runId!);
        if (!this.active()) return;
        r = lookup(); if (!live(r)) continue;
        if (!result) { change(x => { x.state = "needs-review"; x.error = "run-receipt-missing"; }); continue; }
        if (!["completed", "failed", "cancelled", "blocked", "stopped"].includes(result.status)) {
          if (result.notice && !r.noticeSent && (r.retryAt ?? 0) <= this.now()) {
            const input = { deliveryId: r.deliveryId, purpose: "notice" as const, attempt: 1, recipient: this.options.recipient, text: result.notice };
            if (this.options.noticeAtMostOnce) change(x => { x.noticeSent = true; });
            try {
              const reserved = this.options.reserve ? await this.options.reserve(input) : undefined;
              if (!this.active()) return;
              r = lookup(); if (!live(r)) continue;
              const sent = await this.options.send({ ...input, signal: this.controller.signal, ...(reserved ? { reserved } : {}), ...(r.quote ? { quote: r.quote } : {}) });
              if (!this.active()) return;
              r = lookup(); if (!live(r)) continue;
              if (!this.options.noticeAtMostOnce && sent.recipient === this.options.recipient && id.safeParse(sent.messageId).success) change(x => { x.noticeSent = true; });
            } catch {
              if (!this.active()) return;
              r = lookup(); if (!live(r)) continue;
              // Best effort: only adapters without noticeAtMostOnce retry this line.
            }
          }
          continue;
        }
        change(x => { x.response = (result.output || channelReply("channelReply.taskEnded")).slice(0, this.maxResponse); }); r = lookup();
        if (!live(r)) continue;
      }
      if (r.response === undefined || !["accepted", "queued"].includes(r.state) || (r.retryAt ?? 0) > this.now()) continue;
      if (!this.active()) return;
      change(x => { x.state = "sending"; x.attempts++; });
      r = lookup(); if (!live(r) || r.response === undefined) continue;
      const input = { deliveryId: r.deliveryId, purpose: "reply" as const, attempt: r.attempts, recipient: this.options.recipient, text: r.response };
      try {
        const reserved = this.options.reserve ? await this.options.reserve(input) : undefined;
        if (!this.active()) return;
        r = lookup(); if (!live(r)) continue;
        const sent = await this.options.send({ ...input, signal: this.controller.signal,
          ...(reserved ? { reserved } : {}), ...(r.quote ? { quote: r.quote } : {}) });
        if (!this.active()) return;
        r = lookup(); if (!live(r)) continue;
        if (sent.recipient !== this.options.recipient || !id.safeParse(sent.messageId).success) throw new ChannelSendError("invalid-request", true);
        change(x => { x.state = "sent"; x.messageId = sent.messageId; delete x.retryAt; delete x.error; if (this.options.clearResponseOnSettle) delete x.response; });
        if (r.runId && this.options.sendAudio && this.options.runs.voiceNotes) {
          const audio = this.audioDelivery = { deliveryId: r.deliveryId, cancelled: false };
          try {
            for (const note of this.options.runs.voiceNotes(r.runId)) {
              if (!this.active()) return;
              if (audio.cancelled) continue delivery;
              try {
                await this.options.sendAudio({ recipient: this.options.recipient, name: note.name, mime: note.mime, bytes: note.bytes, title: channelReply("channelReply.voiceNoteFrom", { name: note.from }), signal: this.controller.signal });
              } catch (error) {
                if (!this.active()) return;
                if (audio.cancelled) continue delivery;
                console.warn(`[channels] a voice note could not be sent: ${error instanceof ChannelSendError ? error.code : "failed"}`);
              }
              if (!this.active()) return;
              if (audio.cancelled) continue delivery;
            }
          } finally { this.audioDelivery = undefined; }
        }
      } catch (error) {
        if (!this.active()) return;
        r = lookup(); if (!live(r)) continue;
        change(x => {
          x.error = error instanceof ChannelSendError ? (error.partial ? "partial" : error.code) : "send-uncertain";
          if (error instanceof ChannelSendError && !error.uncertain && !error.partial) {
            if (x.attempts < 3 && ["rate-limit", "offline", "timeout", "unavailable"].includes(error.code)) {
              x.state = "queued"; x.retryAt = this.now() + Math.max(1, error.retryAfterSeconds ?? 2 ** x.attempts) * 1000;
            } else x.state = "rejected";
          } else x.state = "uncertain";
          if (x.state === "uncertain" && error instanceof ChannelSendError && error.code === "rate-limit") {
            const delay = error.retryAfterSeconds;
            x.resendAfter = this.now() + (delay !== undefined && Number.isFinite(delay) && delay >= 0 ? delay : 60) * 1000;
          }
          if (this.options.clearResponseOnSettle && x.state !== "queued") delete x.response;
        });
      }
    }
  }
}
