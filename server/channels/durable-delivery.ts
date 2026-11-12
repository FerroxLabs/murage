import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { syncParentDirectory, writeFileAtomic } from "../atomic.ts";
import { channelReply } from "./reply-text.ts";

const id = z.string().min(1).max(400).regex(/^[^\x00-\x1f\x7f]+$/);
/** The message a reply quotes (WhatsApp keeps the triggering key; other adapters leave it unset). */
const quoteSchema = z.object({ id, remoteJid: id.optional(), participant: id.optional(), fromMe: z.boolean().optional(), text: z.string().max(600).optional() }).strict();
/** A stored attachment reference; the file lives in the adapter's media directory. */
const mediaSchema = z.object({ path: z.string().min(1).max(600), mime: z.string().max(120), bytes: z.number().int().nonnegative() }).strict();
export type DeliveryQuote = z.infer<typeof quoteSchema>;
export type DeliveryMedia = z.infer<typeof mediaSchema>;
const buildSchema = (maxResponse: number, bounded = true) => {
  const recordSchema = z.object({ deliveryId: id, dedupeId: id.optional(), sourceDeliveryId: id.optional(), expiresAt: z.number().finite().optional(), expiryKnown: z.literal(true).optional(), prompt: z.string().max(6000), occurredAt: z.number().finite(),
    runId: id.optional(), state: z.enum(["accepted", "queued", "sending", "sent", "uncertain", "rejected", "cancelled", "needs-review"]),
    response: z.string().max(maxResponse).optional(), attempts: z.number().int().min(0).max(3).default(0),
    retryAt: z.number().finite().optional(), resendAfter: z.number().finite().optional(), messageId: id.optional(), error: z.string().max(60).optional(),
    quote: quoteSchema.optional(), media: z.array(mediaSchema).max(8).optional(), noticeSent: z.boolean().optional(),
  }).strict();
  return z.object({ version: z.literal(1), bindingKey: id, recipient: id,
    records: z.array(recordSchema).max(bounded ? 200 : Infinity), tombstones: z.array(z.object({ deliveryId: id, dedupeId: id.optional(), sourceDeliveryId: id.optional(), expiresAt: z.number().finite().optional(), expiryKnown: z.literal(true).optional(), occurredAt: z.number().finite() }).strict()).max(bounded ? 10000 : Infinity),
    overflow: z.array(z.uuid()).optional(),
  }).strict();
};
type State = z.infer<ReturnType<typeof buildSchema>>;
const fileMax = 4 * 1024 * 1024;
function checkFile(file: string) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > fileMax) throw new Error("Invalid channel receipt file");
}
function readPage(file: string, schema: ReturnType<typeof buildSchema>): State {
  checkFile(file);
  return schema.parse(JSON.parse(readFileSync(file, "utf8")));
}
function readLedger(file: string, schema: ReturnType<typeof buildSchema>): State {
  const state = readPage(file, schema);
  for (const part of state.overflow ?? []) {
    // Referenced pages must exist; ENOENT must not make a partial ledger look new.
    let page: State;
    try { page = readPage(`${file}.${part}`, schema); } catch { throw new Error("Invalid channel receipt overflow"); }
    if (page.overflow || page.bindingKey !== state.bindingKey || page.recipient !== state.recipient) throw new Error("Channel receipt binding mismatch");
    state.records.push(...page.records); state.tombstones.push(...page.tombstones);
  }
  delete state.overflow;
  return state;
}
/** Publish immutable overflow pages before atomically replacing their root. Admission limits stay unchanged. */
function writeLedger(file: string, state: State, schema: ReturnType<typeof buildSchema>): void {
  let previous: string[] = [];
  try { previous = readPage(file, schema).overflow ?? []; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  const empty = (): State => ({ version: 1, bindingKey: state.bindingKey, recipient: state.recipient, records: [], tombstones: [] });
  const pages = [empty()];
  let size = 0;
  for (const field of ["records", "tombstones"] as const) for (const row of state[field]) {
    const bytes = Buffer.byteLength(JSON.stringify(row)) + 1;
    let page = pages.at(-1)!;
    // Leave room in the root for the page references as well as its own rows.
    if (page[field].length >= (field === "records" ? 200 : 10000) || size + bytes > fileMax / 2) {
      page = empty(); pages.push(page); size = 0;
    }
    if (field === "records") page.records.push(row as State["records"][number]);
    else page.tombstones.push(row);
    size += bytes;
  }
  const root = pages[0];
  if (pages.length > 1) root.overflow = pages.slice(1).map(() => randomUUID());
  const serialized = pages.map(page => JSON.stringify(schema.parse(page)));
  if (serialized.some(bytes => Buffer.byteLength(bytes) > fileMax)) throw new Error("Channel receipt size limit");
  // Persist page names before publishing references, then persist the root rename
  // before reclaiming pages the previous root may still need after a power loss.
  // atomic.ts cannot provide this barrier on Windows or unsupported filesystems;
  // their power-loss durability remains an explicit platform verification gap.
  for (let i = 1; i < pages.length; i++) writeFileAtomic(`${file}.${root.overflow![i - 1]}`, serialized[i], { mode: 0o600, syncDir: true });
  writeFileAtomic(file, serialized[0], { mode: 0o600, syncDir: true });
  // A failed cleanup only leaves an unreferenced page; it must not undo a committed receipt.
  for (const part of previous) { try { rmSync(`${file}.${part}`); } catch { /* reclaimed with the adapter's directory */ } }
}
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
const contains = (state: State, deliveryId: string) => [...state.records, ...state.tombstones].some(r => r.deliveryId === deliveryId || r.dedupeId === deliveryId);

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
  static consolidate(target: Pick<Options, "file" | "bindingKey" | "recipient">, sources: Array<Pick<Options, "file" | "bindingKey" | "recipient">>, dedupeId: (id: string) => string, now = Date.now()): void {
    const schema = buildSchema(20_000);
    const records = new Map<string, State["records"][number]>(), tombstones = new Map<string, State["tombstones"][number]>();
    let original: string | undefined;
    // The canonical file wins on retry after a crash between ledger and chat-list writes.
    for (const source of [...sources.filter(s => s.file !== target.file), target]) {
      let state: State;
      try { state = readLedger(source.file, schema); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; throw e; }
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
    if (JSON.stringify(state) !== original) writeLedger(target.file, state, schema);
  }

  private state: State;
  private schema: ReturnType<typeof buildSchema>;
  private maxResponse: number;
  private stopped = false;
  private controller = new AbortController();
  private draining?: Promise<void>;
  /** Only the current audio batch needs cancellation history after receipt reclamation. */
  private audioDelivery?: { deliveryId: string; cancelled: boolean };
  private options: Options;
  private sweepFailureCount = 0;
  get pageSweepFailures() { return this.sweepFailureCount; }
  constructor(options: Options) {
    this.options = options;
    this.maxResponse = options.maxResponse ?? 4000;
    this.schema = buildSchema(this.maxResponse, false);
    this.state = this.schema.parse({ version: 1, bindingKey: options.bindingKey, recipient: options.recipient, records: [], tombstones: [] });
    let loaded = false;
    try {
      this.checkFile();
      this.state = readLedger(options.file, buildSchema(this.maxResponse));
      loaded = true;
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
    } catch (e) { if (loaded || (e as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Channel receipt data is invalid; original data preserved."); }
    this.sweepPages();
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  private checkFile() {
    checkFile(this.options.file);
  }
  private mutate<T>(change: (state: State) => { commit: boolean; result: T }): T {
    const next = structuredClone(this.state), decision = change(next);
    if (!decision.commit) return decision.result;
    this.schema.parse(next);
    mkdirSync(dirname(this.options.file), { recursive: true, mode: 0o700 });
    writeLedger(this.options.file, next, buildSchema(this.maxResponse)); this.state = next;
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
    const result = this.mutate<{ runId?: string; descendantRunIds?: string[] } | null>(s => {
      const record = s.records.find(r => r.deliveryId === deliveryId);
      const source = record?.sourceDeliveryId ?? deliveryId;
      const related = s.records.filter(r => r.deliveryId === source || r.sourceDeliveryId === source);
      if (!related.length) return { commit: false, result: null };
      let changed = false;
      for (const row of related) {
        if (row.error !== "redacted" || row.state !== "cancelled" || row.prompt !== ""
            || row.response !== undefined || row.quote !== undefined || row.media !== undefined) changed = true;
        row.prompt = ""; delete row.response; delete row.quote; delete row.media;
        row.state = "cancelled"; row.error = "redacted";
      }
      const descendantRunIds = [...new Set(related.filter(r => r !== record && r.runId !== undefined).map(r => r.runId!))];
      return { commit: changed, result: { ...(record?.runId === undefined ? {} : { runId: record.runId }),
        ...(descendantRunIds.length ? { descendantRunIds } : {}) } };
    });
    this.cancelAudio(deliveryId);
    this.sweepPages();
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
  /** Only the on-disk root decides which immutable pages remain live. Failures retry on the next sweep. */
  sweepPages(): { removed: number; failed: number } {
    let removed = 0, failed = 0;
    try {
      let referenced: string[] = [];
      try { referenced = readPage(this.options.file, buildSchema(this.maxResponse)).overflow ?? []; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      // A previous root rename may have succeeded while its directory sync failed.
      // Until this barrier succeeds, the previous root can still need its pages.
      syncParentDirectory(this.options.file);
      const prefix = basename(this.options.file) + ".", live = new Set(referenced.map(part => prefix + part));
      for (const name of readdirSync(dirname(this.options.file))) {
        if (!name.startsWith(prefix) || live.has(name)) continue;
        try { rmSync(join(dirname(this.options.file), name)); removed++; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") failed++; }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") failed++; }
    this.sweepFailureCount += failed;
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
  stop() { this.stopped = true; this.controller.abort(); }
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
