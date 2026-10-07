import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../atomic.ts";

const id = z.string().min(1).max(400).regex(/^[^\x00-\x1f\x7f]+$/);
/** The message a reply quotes (WhatsApp keeps the triggering key; other adapters leave it unset). */
const quoteSchema = z.object({ id, remoteJid: id.optional(), participant: id.optional(), fromMe: z.boolean().optional(), text: z.string().max(600).optional() }).strict();
/** A stored attachment reference; the file lives in the adapter's media directory. */
const mediaSchema = z.object({ path: z.string().min(1).max(600), mime: z.string().max(120), bytes: z.number().int().nonnegative() }).strict();
export type DeliveryQuote = z.infer<typeof quoteSchema>;
export type DeliveryMedia = z.infer<typeof mediaSchema>;
const buildSchema = (maxResponse: number, bounded = true) => {
  const recordSchema = z.object({ deliveryId: id, dedupeId: id.optional(), prompt: z.string().max(6000), occurredAt: z.number().finite(),
    runId: id.optional(), state: z.enum(["accepted", "queued", "sending", "sent", "uncertain", "rejected", "cancelled", "needs-review"]),
    response: z.string().max(maxResponse).optional(), attempts: z.number().int().min(0).max(3).default(0),
    retryAt: z.number().finite().optional(), messageId: id.optional(), error: z.string().max(60).optional(),
    quote: quoteSchema.optional(), media: z.array(mediaSchema).max(8).optional(),
  }).strict();
  return z.object({ version: z.literal(1), bindingKey: id, recipient: id,
    records: z.array(recordSchema).max(bounded ? 200 : Infinity), tombstones: z.array(z.object({ deliveryId: id, dedupeId: id.optional(), occurredAt: z.number().finite() }).strict()).max(bounded ? 10000 : Infinity),
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
  for (let i = 1; i < pages.length; i++) writeFileAtomic(`${file}.${root.overflow![i - 1]}`, serialized[i], { mode: 0o600 });
  writeFileAtomic(file, serialized[0], { mode: 0o600 });
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
  result(id: string): { status: string; output?: string; error?: string } | null;
  /** Voice notes the run made, each handed out once (server/voice/voice-notes.ts). */
  voiceNotes?(id: string): Array<{ name: string; mime: string; bytes: Uint8Array; text: string; from: string }>;
}
interface Options {
  file: string; bindingKey: string; recipient: string; isCurrent: () => boolean;
  runs: ChannelRuns;
  send: (input: { recipient: string; text: string; signal: AbortSignal; reserved?: string[]; quote?: DeliveryQuote }) => Promise<{ recipient: string; messageId: string }>;
  /** Longest stored reply. Default 4000; WhatsApp passes 20000 so its chunker receives the whole reply. */
  maxResponse?: number;
  clearResponseOnSettle?: boolean;
  /** Called before `send`; returns the ids the send must use (WhatsApp reserves them on disk first). A failure is a send failure. */
  reserve?: (input: { recipient: string; text: string }) => Promise<string[]>;
  /** Sends one voice note after the run's text reply went. Best effort: a
   *  note that cannot be sent is still in the Murage chat and in Files. */
  sendAudio?: (input: { recipient: string; name: string; mime: string; bytes: Uint8Array; title: string; signal: AbortSignal }) => Promise<void>;
  now?: () => number;
}
const windowMs = 7 * 86400000;
const pending = (s: string) => ["accepted", "queued", "sending"].includes(s);

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
        if (row.occurredAt >= now - windowMs && !records.has(row.deliveryId)) tombstones.set(row.deliveryId, { ...row, dedupeId: dedupeId(row.deliveryId) });
      }
    }
    if (!records.size && !tombstones.size && original === undefined) return;
    for (const [id, row] of records) {
      if (["sent", "cancelled"].includes(row.state) && row.occurredAt < now - windowMs) records.delete(id);
    }
    const counts = new Map<string, number>();
    for (const row of [...records.values(), ...tombstones.values()]) counts.set(row.dedupeId!, (counts.get(row.dedupeId!) ?? 0) + 1);
    for (const row of records.values()) {
      if (pending(row.state) && counts.get(row.dedupeId!)! > 1) { row.state = "needs-review"; row.error = "alias-duplicate"; }
    }
    const canonical = new Map<string, State["tombstones"][number]>();
    for (const row of tombstones.values()) {
      if (row.occurredAt < now - windowMs) continue;
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
  private options: Options;
  constructor(options: Options) {
    this.options = options;
    this.maxResponse = options.maxResponse ?? 4000;
    this.schema = buildSchema(this.maxResponse, false);
    this.state = this.schema.parse({ version: 1, bindingKey: options.bindingKey, recipient: options.recipient, records: [], tombstones: [] });
    try {
      this.checkFile();
      this.state = readLedger(options.file, buildSchema(this.maxResponse));
      if (this.state.bindingKey !== options.bindingKey || this.state.recipient !== options.recipient) throw new Error();
      const ids = [...this.state.records, ...this.state.tombstones].map(r => r.deliveryId);
      if (new Set(ids).size !== ids.length) throw new Error();
      if (this.state.records.some(r => r.state === "sending")) this.mutate(s => { for (const r of s.records) if (r.state === "sending") r.state = "uncertain"; });
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Channel receipt data is invalid; original data preserved."); }
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  private checkFile() {
    checkFile(this.options.file);
  }
  private mutate(change: (state: State) => void) {
    const next = structuredClone(this.state); change(next);
    this.schema.parse(next);
    mkdirSync(dirname(this.options.file), { recursive: true, mode: 0o700 });
    writeLedger(this.options.file, next, buildSchema(this.maxResponse)); this.state = next;
  }

  private active() { return !this.stopped && !this.controller.signal.aborted && this.options.isCurrent(); }
  accept(input: { deliveryId: string; prompt: string; occurredAt: number; response?: string; quote?: DeliveryQuote; media?: DeliveryMedia[] }): "accepted" | "duplicate" {
    if (!this.active()) throw new Error("Channel binding is not current");
    if (this.has(input.deliveryId)) return "duplicate";
    if (!Number.isFinite(input.occurredAt) || input.occurredAt < this.now() - windowMs || input.occurredAt > this.now() + 300000) throw new Error("Channel event is outside the admission window");
    this.mutate(s => {
      s.tombstones = s.tombstones.filter(r => r.occurredAt >= this.now() - windowMs);
      const settled = s.records.filter(r => ["sent", "cancelled"].includes(r.state));
      for (const r of settled) if (r.occurredAt >= this.now() - windowMs) s.tombstones.push({ deliveryId: r.deliveryId, ...(r.dedupeId ? { dedupeId: r.dedupeId } : {}), occurredAt: r.occurredAt });
      s.records = s.records.filter(r => !["sent", "cancelled"].includes(r.state));
      if (s.records.length >= 200 || s.tombstones.length >= 10000) throw new Error("Channel pending receipt limit");
      s.records.push({ ...input, attempts: 0, state: "accepted" });
    });
    return "accepted";
  }
  status() {
    return { pending: this.state.records.filter(r => pending(r.state)).length,
      uncertain: this.state.records.filter(r => r.state === "uncertain").length,
      rejected: this.state.records.filter(r => r.state === "rejected").length,
      needsReview: this.state.records.filter(r => r.state === "needs-review").length };
  }
  /** True when this delivery id is already a record or a tombstone (so a resend need not redo expensive work). */
  has(deliveryId: string): boolean { return [...this.state.records, ...this.state.tombstones].some(r => r.deliveryId === deliveryId || r.dedupeId === deliveryId); }
  /** Media files that records still need: unfinished work, or a reply whose delivery is uncertain or awaiting review. The adapter's sweep keeps these. */
  referencedMedia(): string[] { return this.state.records.filter(r => ["accepted", "queued", "sending", "uncertain", "needs-review"].includes(r.state)).flatMap(r => (r.media ?? []).map(m => m.path)); }
  /** Run ids of unfinished records, so an adapter can cancel exactly the tasks of a chat it just revoked. */
  pendingRunIds(): string[] { return this.state.records.filter(r => pending(r.state) && r.runId !== undefined).map(r => r.runId!); }
  stop() { this.stopped = true; this.controller.abort(); }
  revoke() {
    this.stop();
    this.mutate(s => { for (const r of s.records) if (pending(r.state)) r.state = r.state === "sending" ? "uncertain" : "cancelled"; });
  }
  drain(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = this.work().finally(() => { this.draining = undefined; });
    return this.draining;
  }
  private async work() {
    for (const original of [...this.state.records]) {
      if (!this.active()) return;
      const lookup = () => this.state.records.find(r => r.deliveryId === original.deliveryId)!;
      const change = (fn: (r: State["records"][number]) => void) => this.mutate(s => fn(s.records.find(r => r.deliveryId === original.deliveryId)!));
      let r = lookup();
      if (r.state === "accepted" && r.response === undefined) {
        if (this.state.records.filter(x => x.state === "queued" && x.response === undefined).length >= 3) continue;
        // enqueue must return a retained receipt on retry across the cross-file crash window.
        let run:{id:string};
        try{run=this.options.runs.enqueue({ deliveryId: r.deliveryId, prompt: r.prompt, ...(r.media?.length ? { media: r.media.map(m => ({ ...m })) } : {}) });}
        catch(error){
          if(!(error instanceof Error)||!/^HUMAN_(?:LINK_REQUIRED|BINDING_REVOKED)/.test(error.message))throw error;
          change(x=>{x.response="Link this channel account to yourself or another person in Murage Memory settings, then send your message again.";});
          r=lookup();
          continue;
        }
        if (!this.active()) return;
        change(x => { x.runId = run.id; x.state = "queued"; }); r = lookup();
      }
      if (r.state === "queued" && r.response === undefined) {
        const result = this.options.runs.result(r.runId!);
        if (!this.active()) return;
        if (!result) { change(x => { x.state = "needs-review"; x.error = "run-receipt-missing"; }); continue; }
        if (!["completed", "failed", "cancelled", "blocked", "stopped"].includes(result.status)) continue;
        change(x => { x.response = (result.output || "Task ended. Review its result in Murage.").slice(0, this.maxResponse); }); r = lookup();
      }
      if (r.response === undefined || !["accepted", "queued"].includes(r.state) || (r.retryAt ?? 0) > this.now()) continue;
      if (!this.active()) return;
      change(x => { x.state = "sending"; x.attempts++; });
      try {
        const reserved = this.options.reserve ? await this.options.reserve({ recipient: this.options.recipient, text: r.response }) : undefined;
        if (!this.active()) return;
        const sent = await this.options.send({ recipient: this.options.recipient, text: r.response, signal: this.controller.signal,
          ...(reserved ? { reserved } : {}), ...(r.quote ? { quote: r.quote } : {}) });
        if (!this.active()) return;
        if (sent.recipient !== this.options.recipient || !id.safeParse(sent.messageId).success) throw new ChannelSendError("invalid-request", true);
        change(x => { x.state = "sent"; x.messageId = sent.messageId; delete x.retryAt; delete x.error; if (this.options.clearResponseOnSettle) delete x.response; });
        if (r.runId && this.options.sendAudio && this.options.runs.voiceNotes) {
          for (const note of this.options.runs.voiceNotes(r.runId)) {
            try {
              await this.options.sendAudio({ recipient: this.options.recipient, name: note.name, mime: note.mime, bytes: note.bytes, title: `Voice note from ${note.from}`, signal: this.controller.signal });
            } catch (error) {
              console.warn(`[channels] a voice note could not be sent: ${error instanceof ChannelSendError ? error.code : "failed"}`);
            }
          }
        }
      } catch (error) {
        if (!this.active()) return;
        change(x => {
          x.error = error instanceof ChannelSendError ? (error.partial ? "partial" : error.code) : "send-uncertain";
          if (error instanceof ChannelSendError && !error.uncertain && !error.partial) {
            if (x.attempts < 3 && ["rate-limit", "offline", "timeout", "unavailable"].includes(error.code)) {
              x.state = "queued"; x.retryAt = this.now() + Math.max(1, error.retryAfterSeconds ?? 2 ** x.attempts) * 1000;
            } else x.state = "rejected";
          } else x.state = "uncertain";
          if (this.options.clearResponseOnSettle && x.state !== "queued") delete x.response;
        });
      }
    }
  }
}
