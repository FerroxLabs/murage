import { types } from "node:util";
import { checkAllHookCanon } from "../hook-safety.ts";
// Fan-in event bus — port of upstream's ProviderService fan-in +
// EventNdjsonLogger tee, minus Effect. Every adapter's event stream merges
// into one bus; each event is stamped with its providerInstanceId, teed to
// a per-thread canonical NDJSON log (the debugging trick both upstream and
// agentcal lean on), and delivered to subscribers (the SSE endpoint and
// the server-side message folder).
import { looksLikeAuthFailure, noteInstanceAuthFailure, noteInstanceTurnOk } from "../key-rejections.ts";
import { appendFileSync } from "../counted-fs.ts";
import { join } from "node:path";

import { EVENTS_DIR } from "../config.ts";
import { redactSecrets } from "../redact.ts";
import { LOGGED_TOOL_KINDS, loggedRuntimeEvent } from "../runtime-event-out.ts";
import { isPhoneRequest } from "../phones/withhold.ts";
import { PHONE_TOOL_NAMES } from "../../shared/phone-jobs-contract.ts";
import { createHash, randomUUID } from "node:crypto";
import { RuntimeAudienceCollector, attachedEventCharge, chargeExecutionEvent } from "./audience-collector.ts";
import type { MaskedValueView } from "./masked-values.ts";
import type { AudienceEmission, SourceContext, TurnTextPolicy, AttachmentCapability } from "../contracts.ts";
import { boundedEventCharge } from "./event-charge.ts";
import { IntakeValve } from "./intake.ts";
import { observeTurnEvent } from "../health/turn-observer.ts";
import { boundedRecord, markLogCovered, persistsEvent, flushSessionLines, recordSessionLine, rotateIfFull, sweepAfterWrite, threadLogClosed } from "./event-log.ts";
import { type ProviderInstance, type RuntimeEvent, type RuntimeEventListener } from "../contracts.ts";

/** Provider image bytes, out of the on-disk log.
 *
 * `redactSecrets` scrubs CREDENTIAL-shaped content; nothing in it knows about
 * base64 payloads. So the ACP driver carefully kept generated-image bytes out
 * of native/<thread>.ndjson while the very same payload went verbatim into
 * events/<thread>.ndjson — the sibling file, and the one the comment below
 * calls "a file people paste into bug reports". Half the job.
 *
 * The shape is kept so the log still shows that an image happened and how big
 * it was; only the payload goes. Found by the sweep's own verifier after two
 * external audits called this lane clean. */
function withoutImageBytes(event: RuntimeEvent): RuntimeEvent {
  const candidate = event as unknown as { itemType?: unknown; data?: unknown };
  if (candidate.itemType !== "assistant_image" || typeof candidate.data !== "string") return event;
  return {
    ...event,
    data: `[image data: ${candidate.data.length} base64 chars]`,
  } as RuntimeEvent;
}

export type DeliveryGate = {
  held(): boolean; wait(): Promise<void>; isBusy(error: unknown): boolean;
  /** The queue passed its bound while the gate was held: release the hold (the index build defers to a later idle). */
  overflow?(): void;
};
type QueuedDelivery = { event: RuntimeEvent; owed: RuntimeEventListener[]; bytes: number; reserved: boolean };
export type DeliveryLimits = { maxEvents: number; maxBytes: number; batch: number; retryMinMs: number; retryMaxMs: number };
/** Text longer than LONG_TEXT characters is taken in as line-safe chunks of about LINE_CHUNK characters (see EventBus.attach). */
const LONG_TEXT = 262_144, LINE_CHUNK = 32_768;
const DEFAULT_LIMITS: DeliveryLimits = { maxEvents: 2_000, maxBytes: 32 * 1024 * 1024, batch: 50, retryMinMs: 50, retryMaxMs: 2_000 };

export const PHONE_TEXT_WITHHELD = "[phone turn text withheld]";
export const PHONE_RESULT_WITHHELD = "[phone result withheld]";
export interface PhoneWithholdPolicy {
  thread(threadId: string): boolean;
  phoneTool(event: RuntimeEvent): { summary: string } | null;
}

const REQUEST_WITHHELD_FIELDS = ["toolInput", "toolCall", "questions", "choices", "reason", "filePaths", "folderTrust"] as const;

function withheldRequest(e: Record<string, unknown>): RuntimeEvent {
  const out: Record<string, unknown> = { ...e, summary: PHONE_RESULT_WITHHELD };
  delete out.raw;
  for (const key of REQUEST_WITHHELD_FIELDS) delete out[key];
  return out as unknown as RuntimeEvent;
}

/** The model picks Codex question ids, so the log keeps a stable non-reversible stand-in; rows still line up. Live delivery keeps the real id. */
function standInQuestionId(id: unknown): string | undefined {
  if (typeof id !== "string") return undefined;
  return `q-${createHash("sha256").update(id).digest("hex").slice(0, 16)}`;
}

/** A marked thread's question keeps its shape (ids, counts, flags) and none of its words. */
function withheldQuestions(e: Record<string, unknown>): RuntimeEvent {
  const { raw: _raw, ...rest } = e;
  const questions = Array.isArray(e.questions)
    ? e.questions.map((q) => ({ id: standInQuestionId((q as { id?: string }).id), question: PHONE_RESULT_WITHHELD, options: [], multiSelect: Boolean((q as { multiSelect?: boolean }).multiSelect), allowOther: Boolean((q as { allowOther?: boolean }).allowOther) }))
    : [];
  return { ...rest, questions } as unknown as RuntimeEvent;
}

/** NOLIMITS 1.0.18 (design NOLIMITS-S1S2-H6-ALLOWLIST.md L5): the envelope a withheld tool row keeps. */
const WITHHELD_TOOL_ENVELOPE = ["type", "itemType", "origin", "eventId", "provider", "providerInstanceId", "threadId", "turnId", "createdAt", "itemId"] as const;
const PHONE_SUMMARIES: ReadonlySet<string> = new Set([...PHONE_TOOL_NAMES, "phone tool"]);

/** L5: the ONE builder of every withheld tool row (phone tool on any thread, any tool row on a marked thread; start and
 * completion; normal and catch path). Rebuilt from the envelope, never spread: no toolIdentity, title, detail, raw or any
 * other key. `summary` is a canonical phone tool name, "phone tool", or the withheld marker. */
function withheldToolRow(e: Record<string, unknown>, summary: string): RuntimeEvent {
  const row: Record<string, unknown> = {};
  for (const key of WITHHELD_TOOL_ENVELOPE) if (typeof e[key] === "string") row[key] = e[key];
  if (typeof e.toolKind === "string" && LOGGED_TOOL_KINDS.has(e.toolKind)) row.toolKind = e.toolKind;
  const canonical = summary === PHONE_RESULT_WITHHELD || PHONE_SUMMARIES.has(summary) ? summary : "phone tool";
  if (e.type === "item.completed") {
    if (typeof e.ok === "boolean") row.ok = e.ok;
    row.summary = canonical;
    row.result = PHONE_RESULT_WITHHELD;
  } else {
    row.summary = canonical;
    row.input = PHONE_RESULT_WITHHELD;
  }
  return row as unknown as RuntimeEvent;
}

const isToolRow = (e: Record<string, unknown>) => (e.type === "item.started" || e.type === "item.completed") && e.itemType === "tool";

/** `loggable` is what the log may keep (already projected); `original` is the live event, which the policy reads: the
 * logged projection drops `summary` and may replace `title`, so recognition never runs on it (L5). */
function withheldByType(policy: PhoneWithholdPolicy, loggable: RuntimeEvent, original: RuntimeEvent): RuntimeEvent {
  const event = loggable;
  try {
    const e = event as unknown as Record<string, unknown>;
    const marked = policy.thread(original.threadId);
    if (e.type === "request.opened") {
      if (marked || isPhoneRequest(original as unknown as Record<string, unknown>)) return withheldRequest(e);
      return event;
    }
    if (e.type === "item.completed" || e.type === "item.started") {
      if (e.itemType === "tool") {
        const phone = policy.phoneTool(original);
        if (!phone && !marked) return event;
        return withheldToolRow(e, phone ? phone.summary : PHONE_RESULT_WITHHELD);
      }
      if (e.type === "item.started" && e.itemType === "reasoning" && marked) {
        const { raw: _raw, ...rest } = e;
        return { ...rest, title: PHONE_RESULT_WITHHELD, summary: PHONE_RESULT_WITHHELD, input: PHONE_RESULT_WITHHELD } as unknown as RuntimeEvent;
      }
      if (e.type === "item.completed" && e.itemType === "assistant_text" && marked) {
        const { raw: _raw, ...rest } = e;
        return { ...rest, text: PHONE_TEXT_WITHHELD } as unknown as RuntimeEvent;
      }
    }
    if (e.type === "question.async" && marked) return withheldQuestions(e);
    return event;
  } catch {
    // fail closed: a policy that throws writes the shape and none of the words
    const e = event as unknown as Record<string, unknown>;
    if (e.type === "request.opened") return withheldRequest(e);
    if (e.type === "question.async") return withheldQuestions(e);
    if (e.type === "item.started" && e.itemType === "reasoning") return { ...e, raw: undefined, title: PHONE_RESULT_WITHHELD, summary: PHONE_RESULT_WITHHELD, input: PHONE_RESULT_WITHHELD } as unknown as RuntimeEvent;
    if (e.type === "item.completed" && e.itemType === "assistant_text") return { ...e, raw: undefined, text: PHONE_TEXT_WITHHELD } as unknown as RuntimeEvent;
    if (isToolRow(e)) return withheldToolRow(e, PHONE_RESULT_WITHHELD);
    return event;
  }
}

/** Marked threads are deny-by-default: every string at any depth becomes the withheld marker except these structural fields
 * (ids, event type, kind, status, timestamps, tool name, item type). Numbers, booleans and null always stay. An event type
 * nobody listed here gets every string withheld. */
const STRUCTURAL_STRING_KEYS: ReadonlySet<string> = new Set([
  "eventId", "provider", "providerInstanceId", "threadId", "turnId", "itemId", "requestId", "interjectionId", "sessionId", "id",
  "createdAt", "type", "kind", "itemType", "requestType", "streamKind", "status", "origin", "behavior", "source", "stopReason",
  "approvalScope", "toolKind", "tool", "toolEngine", "mcpReadiness", "deniedBy",
]);
/** `name` and `namespace` are structural only inside a tool identity (a tool's name, never display text). */
const TOOL_IDENTITY_KEYS: ReadonlySet<string> = new Set(["name", "namespace", "kind"]);
const WITHHOLD_MAX_DEPTH = 12;

function isMarker(value: string): boolean {
  return value === PHONE_TEXT_WITHHELD || value === PHONE_RESULT_WITHHELD;
}

function withholdAllStrings(value: unknown, key: string, parent: string, keep: ReadonlySet<string>, depth: number): unknown {
  if (typeof value === "string") {
    if (isMarker(value)) return value;
    if (STRUCTURAL_STRING_KEYS.has(key) || keep.has(key) || (parent === "toolIdentity" && TOOL_IDENTITY_KEYS.has(key))) return value;
    return PHONE_RESULT_WITHHELD;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= WITHHOLD_MAX_DEPTH) return PHONE_RESULT_WITHHELD;
  if (Array.isArray(value)) return value.map((item) => withholdAllStrings(item, key, parent, keep, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, item] of Object.entries(value as Record<string, unknown>)) out[k] = withholdAllStrings(item, k, key, keep, depth + 1);
  return out;
}

/** A marked thread's raw engine frame never reaches the log: its keys are the engine's, so the structural allowlist means nothing there. */
function withoutRaw(event: RuntimeEvent): RuntimeEvent {
  const { raw: _raw, ...rest } = event as RuntimeEvent & { raw?: unknown };
  return rest as RuntimeEvent;
}

const NO_KEYS: ReadonlySet<string> = new Set();
const PHONE_ROW_KEYS: ReadonlySet<string> = new Set(["summary"]);

function withheldForLog(policy: PhoneWithholdPolicy | null, loggable: RuntimeEvent, original: RuntimeEvent): RuntimeEvent {
  if (!policy) return loggable;
  const typed = withheldByType(policy, loggable, original);
  try {
    if (!policy.thread(original.threadId)) return typed;
    // a withheld tool row's summary is Murage's own canonical line (withheldToolRow), never model text. Read from the row
    // itself, not a second policy.phoneTool call: the matcher hands a completion's remembered start out once.
    const keep = isToolRow(typed as unknown as Record<string, unknown>) ? PHONE_ROW_KEYS : NO_KEYS;
    return withholdAllStrings(withoutRaw(typed), "", "", keep, 0) as RuntimeEvent;
  } catch {
    return withholdAllStrings(withoutRaw(typed), "", "", NO_KEYS, 0) as RuntimeEvent;
  }
}


/** Log routing and classification read a bounded descriptor copy. Execution keeps the original graph. */
const safeLogCopies = new WeakMap<object, RuntimeEvent>();
function descriptorLogEvent(event: RuntimeEvent): RuntimeEvent {
  const cached = safeLogCopies.get(event); if (cached) return cached;
  let nodes = 0, units = 0;
  const clone = (value: unknown, depth: number): unknown => {
    if (++nodes > 2048 || depth > 8) return undefined;
    if (typeof value === 'string') { units += value.length; return units <= 262144 ? value : undefined; }
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (!value || typeof value !== 'object' || types.isProxy(value)) return undefined;
    const out: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {};
    for (const key in value) {
      if (++nodes > 2048 || (units += key.length) > 262144) break;
      const d = Object.getOwnPropertyDescriptor(value, key); if (!d || !('value' in d)) continue;
      const copy = clone(d.value, depth + 1); if (copy !== undefined && key !== '__proto__' && key !== 'constructor') Object.defineProperty(out, key, { value: copy, enumerable: true, configurable: true, writable: true });
    }
    return out;
  };
  let copy: RuntimeEvent;
  try { copy = clone(event, 0) as RuntimeEvent; } catch { copy = undefined as unknown as RuntimeEvent; }
  const thread = copy?.threadId;
  if (!copy || typeof copy !== 'object') copy = {} as RuntimeEvent;
  // No provider-controlled path may escape events/.
  copy.threadId = typeof thread === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(thread) ? thread : 'unowned';
  safeLogCopies.set(event, copy); return copy;
}

/** Reconstruct only named path/wrapper slots from the already scanned preview. No raw argument graph enters the logger. */
function loggedAudienceInput(event: RuntimeEvent): Record<string, unknown> | undefined {
  const rows = (event as unknown as { preview?: readonly {key:string;value:string}[] }).preview;
  if (!rows) return undefined;
  const wrappers = new Set(['tool_input','toolInput','args','arguments','input','params','parameters']);
  const leaves = new Set(['path','file_path','filePath','filepath','dir','directory','cwd','folder','notebook_path','target_file','old_path','new_path','move_path','destination','directory_path','root','workdir','working_directory','tool_name','toolName']);
  const out: Record<string, unknown> = {};
  for (const row of rows.slice(0, 64)) {
    const parts = row.key.split('.'); if (parts.length > 5 || !leaves.has(parts.at(-1)!)) continue;
    let target = out, accepted = true;
    for (const part of parts.slice(0,-1)) {
      if (!wrappers.has(part)) { accepted = false; break; }
      const old = target[part]; if (old !== undefined && (!old || typeof old !== 'object')) { accepted = false; break; }
      target = (target[part] ??= {}) as Record<string, unknown>;
    }
    if (accepted) target[parts.at(-1)!] = row.value;
  }
  return Object.keys(out).length ? out : undefined;
}

export class EventBus {
  private pendingLogWarnings = new Map<string, RuntimeEvent>();
  readonly collector: RuntimeAudienceCollector;
  private attachments = new Map<string, AttachmentCapability>();
  private hostDriverKinds = new Map<string, string>();
  private hostSources = new Map<string, SourceContext>();
  /** LLS S2 (nativecrash): terminal arbitration is bus-owned. A source is `stopped` once cancelTurn ran for it and `terminated` once its one
   * terminal (a provider turn.completed, or the host's memory_refused) went through intake; later events for it never reach intake. */
  private stoppedSources = new WeakSet<SourceContext>();
  private terminatedSources = new WeakSet<SourceContext>();
  /** A duplicate terminal rejected by S2 (never an LLE drop). */
  dupTerminalRejected = 0;
  private executionSources = new WeakMap<object, SourceContext>();
  sourceForExecution(event: RuntimeEvent): SourceContext | undefined { return this.executionSources.get(event); }
  private audienceListeners = new Map<(event: AudienceEmission) => void, { durable?: boolean }>();
  private audienceByExecution = new WeakMap<object, readonly AudienceEmission[]>();
  private maskedByExecution = new WeakMap<object, boolean>();
  private secretMaskedByExecution = new WeakMap<object, boolean>();
  private withheldByExecution = new WeakMap<object, boolean>();
  /** 1.0.22 cause B: the admission's masked-value list as of each execution event's intake (masked-values.ts). */
  private maskedValuesByExecution = new WeakMap<object, MaskedValueView>();
  /** The source a refusal ended (refuseTurn drops it from hostSources), per thread, until the thread's next admission: a re-dispatch
   * of the refused message reads what that attempt had masked (ASTRA N3). */
  private refusedSources = new Map<string, SourceContext>();
  /** The last adapter event still being taken in chunk by chunk (see attach); undefined when intake is synchronous. */
  /** One queue per thread (ASTRA 0489638c7a): events of a thread wait behind that thread's chunked reply, in order, whichever
   * engine sent them; no other thread waits. `intakeDraining` counts the queued events of an attachment so that a detach or a
   * replacement in that window ends the attachment only after they were delivered (`detachAfterDrain`). */
  private intakeTails = new Map<string, Promise<void>>();
  private intakeDraining = new Map<AttachmentCapability, number>();
  private detachAfterDrain = new Set<AttachmentCapability>();
  /** Resolves when no adapter event is waiting behind a chunked intake. */
  async intakeIdle(): Promise<void> { while (this.intakeTails.size) await Promise.all([...this.intakeTails.values()]); }
  /** The line-safe content.delta chunks of one long unstreamed reply (then the reply itself follows: final) or of one long
   * delta (the chunks replace it). Undefined for every other event, including a long text that is a single line. */
  private lineChunks(event: RuntimeEvent, source?: SourceContext): (RuntimeEvent[] & { final?: boolean }) | undefined {
    if (!event || typeof event !== "object" || types.isProxy(event)) return undefined;
    const read = (key: string): unknown => Object.getOwnPropertyDescriptor(event, key)?.value;
    const type = read("type"), reply = type === "item.completed" && read("itemType") === "assistant_text";
    const text = reply ? read("text") : type === "content.delta" ? read("delta") : undefined;
    if (typeof text !== "string" || text.length <= LONG_TEXT) return undefined;
    if (reply && !this.collector.unstreamedReply(event, source)) return undefined;
    const cuts: number[] = [];
    for (let at = 0; at < text.length;) {
      const nl = text.indexOf("\n", Math.min(text.length, at + LINE_CHUNK) - 1);
      at = nl < 0 ? text.length : nl + 1; cuts.push(at);
    }
    if (cuts.length < 2) return undefined;
    const base = { provider: read("provider"), threadId: read("threadId"), createdAt: read("createdAt"), ...(typeof read("turnId") === "string" ? { turnId: read("turnId") } : {}), ...(typeof read("itemId") === "string" ? { itemId: read("itemId") } : {}) };
    const streamKind = reply ? "assistant_text" : read("streamKind");
    const chunks: RuntimeEvent[] & { final?: boolean } = cuts.map((end, i) => ({ ...base, eventId: `${String(read("eventId"))}.${i}`, type: "content.delta", streamKind, delta: text.slice(i ? cuts[i - 1] : 0, end) }) as RuntimeEvent);
    chunks.final = reply;
    return chunks;
  }
  private listeners = new Set<RuntimeEventListener>();
  private subscriptions = new Map<string, { adapter: ProviderInstance["adapter"]; unsubscribe: () => void }>();
  private readonly appendLog: typeof appendFileSync;
  /** Every listener is durable by default (the fold, terminal cleanup and the waiters all write or follow writes): its
   * deliveries wait out the writer gate and are retried on a locked database, never dropped. `{ durable: false }` opts out. */
  private immediate = new Set<RuntimeEventListener>();
  private gate: DeliveryGate | null = null;
  /** Events waiting for the writer gate (or for a lock to clear), per thread and in order, each with the durable listeners
   * still owed it (the failed one and every listener after it, in subscription order). A thread whose head keeps meeting a
   * locked database backs off on its own; other threads are never held behind it. */
  private pendingByThread = new Map<string, QueuedDelivery[]>();
  private retryState = new Map<string, { at: number; attempts: number }>();
  /** Every event still owed. All of it is in RAM and none of it is ever written to a side file: revoked content must not
   * outlive its deletion, so the bound is kept by slowing the producers (see intake.ts), never by spilling. */
  private reserveCount = 0;
  private reserveBytes = 0;
  private regularByThread = new Map<string, number>();
  private pendingCount = 0;
  private pendingBytes = 0;
  /** Bytes owed per thread, so a few huge events from one thread close that thread's intake before they reach the global byte cap. */
  private bytesByThread = new Map<string, number>();
  /** True from the moment the global cap is reached until the queue is back under the low-water mark. */
  private saturated = false;
  private overflowed = false;
  /** Producers ask this before handing over another event; engine stdout streams are paused through it. */
  readonly valve = new IntakeValve(threadId => this.intakeClosed(threadId));
  private limits: DeliveryLimits = DEFAULT_LIMITS;
  private draining = false;
  /** Threads whose events are delivered but never written to events/. */
  private omitThread: (threadId: string) => boolean = () => false;
  /** 1.0.9 phone tools: what the canonical log may not keep of a phone thread (see withholdText). */
  private withhold: PhoneWithholdPolicy | null = null;

  constructor(appendLog: typeof appendFileSync = appendFileSync, policy?: TurnTextPolicy) {
    this.collector = new RuntimeAudienceCollector(policy);
    this.appendLog = appendLog;
  }

  private boundResolution?: (threadId: string, turnId: string) => boolean;
  /** A raw engine resolution needs an immutable dispatch binding before any consumer can use it. */
  bindRequestResolutions(bound: (threadId: string, turnId: string) => boolean): void { this.boundResolution = bound; }

  attach(instances: ProviderInstance[]) {
    for (const instance of instances) {
      if (this.subscriptions.get(instance.instanceId)?.adapter === instance.adapter) continue;
      this.detach(new Set([instance.instanceId]));
      const attachment = this.collector.attach(instance.instanceId);
      this.hostDriverKinds.set(instance.instanceId, instance.driverKind);
      this.attachments.set(instance.instanceId, attachment);
      // An event belongs to this attachment when the adapter emits it. One that then waits behind a chunked reply was already
      // accepted: a detach or replacement while it waits must not drop it (the reply and its turn end would be lost).
      const current = (source?: SourceContext) => this.attachments.get(instance.instanceId) === attachment && (!source || source.attachment === attachment);
      const deliver = (event: RuntimeEvent, source?: SourceContext, accepted = false) => {
        if (!accepted && !current(source)) return;
        // hard invariant borrowed from correlateRuntimeEventWithInstance:
        // an adapter may only emit events for its own driver kind
        if (descriptorLogEvent(event).provider !== instance.driverKind) {
          console.error(`bus: dropped cross-driver event from ${instance.instanceId}`);
          return;
        }
        if (instance.tracksKeyRejection !== true) observeSignIn(instance.instanceId, descriptorLogEvent(event), instance.driverKind === "claude" || instance.driverKind === "codex");
        const charge = chargeExecutionEvent(event);
        // The ordinary schema-only wrapper keeps legacy execution correlation;
        // hostile/oversize graphs are handed off untouched and accounted once.
        const stamped = charge.oversize ? event : Object.create(Object.getPrototypeOf(event), {
          ...Object.getOwnPropertyDescriptors(event), providerInstanceId: { value: instance.instanceId, enumerable: true },
        }) as RuntimeEvent;
        chargeExecutionEvent(stamped, event);
        this.publish(stamped, source);
      };
      // cause22-E (b) (MAIN-RULING 2026-11-22T17:58:19Z, event loop): the secret scan is synchronous. A reply or delta longer
      // than LONG_TEXT is handed to the turn policy as content.delta chunks that each end at a line end, and the event loop
      // runs between two chunks (setImmediate). Order is kept: while such an event is in flight every later event of its thread
      // waits behind it (other threads do not wait). Nothing is cut and no line is split (a split line could hide a secret), so one line with no line end
      // is still one scan. Shorter events take the same synchronous path as before.
      const unsubscribe = instance.adapter.onEvent((event, source) => {
        if (!current(source)) return;
        const thread = event && typeof event === "object" && !types.isProxy(event) ? Object.getOwnPropertyDescriptor(event, "threadId")?.value : undefined;
        const key = typeof thread === "string" ? `t:${thread}` : `i:${instance.instanceId}`;
        const waiting = this.intakeTails.get(key);
        const first = waiting ? undefined : this.lineChunks(event, source);
        if (!first && !waiting) { deliver(event, source); return; }
        this.intakeDraining.set(attachment, (this.intakeDraining.get(attachment) ?? 0) + 1);
        const run = async () => {
          // An event that waited is judged when its turn comes: only then is it known whether its reply was streamed.
          const chunks = first ?? this.lineChunks(event, source);
          // A chunk that fails to deliver ends the chunking only: the reply itself is still delivered below and is then
          // scanned whole by the policy, so nothing is dropped silently.
          try { if (chunks) for (const chunk of chunks) { deliver(chunk, source, true); await new Promise<void>(resolve => setImmediate(resolve)); } }
          catch (e) { console.error("bus: chunked intake failed", e instanceof Error ? e.name : "error"); }
          if (!chunks || chunks.final) deliver(event, source, true);
        };
        const tail: Promise<void> = (waiting ?? Promise.resolve()).then(run).catch(e => console.error("bus: chunked intake failed", e instanceof Error ? e.name : "error"))
          .then(() => {
            if (this.intakeTails.get(key) === tail) this.intakeTails.delete(key);
            const left = (this.intakeDraining.get(attachment) ?? 1) - 1;
            if (left > 0) { this.intakeDraining.set(attachment, left); return; }
            this.intakeDraining.delete(attachment);
            if (this.detachAfterDrain.delete(attachment)) this.collector.detach(attachment);
          });
        this.intakeTails.set(key, tail);
      });
      this.subscriptions.set(instance.instanceId, { adapter: instance.adapter, unsubscribe });
    }
  }

  /** The Chief's hidden New project proposal turns leave no event log. */
  omitLog(predicate: (threadId: string) => boolean) { this.omitThread = predicate; }

  /** A thread that used the phone tools keeps its words out of events/ (the Inspector reads that file), and a phone tool's input and
   * result are never written for any thread. Live delivery is untouched: the owner's chat keeps the words. Runs before boundedRecord, so
   * an over-limit record is withheld too. Never gated on the feature flag (a mark outlives the flag). */
  withholdText(policy: PhoneWithholdPolicy) { this.withhold = policy; }

  /** The send fence allocates this before invoking any adapter. The context is
   * host-only and travels as the callback's second argument. */
  admitNewTurn(instanceId: string, threadId: string, options?: Readonly<{ redispatch?: boolean }>): SourceContext {
    const attachment = this.attachments.get(instanceId);
    if (!attachment) throw new Error("instance_not_attached");
    const previous = this.hostSources.get(threadId);
    if (previous) this.terminatedSources.add(previous);
    // 1.0.22 cause B (design section 4): the same owner message dispatched again (`redispatch`: a memory context revoked mid-turn,
    // index.ts admitLedgerLease) while its secret-latched admission is still open. The engine session may still hold what the first
    // attempt printed, so its masked values carry into the new admission. Read BEFORE the cancel drops them. Any other new turn
    // starts with an empty list, also when the turn before it never completed (a latch does not outlive its turn).
    const earlier = previous ?? this.refusedSources.get(threadId);
    this.refusedSources.delete(threadId);
    const carried = options?.redispatch && earlier?.admission ? this.collector.carriedValues(earlier.admission) : undefined;
    if (previous?.admission) this.collector.cancel(previous.admission);
    const source = this.collector.source(this.collector.admitNewTurn({ instanceId, threadId, attachment }, carried));
    this.hostSources.set(threadId, source);
    return source;
  }

  cancelTurn(threadId: string): void {
    const source = this.hostSources.get(threadId);
    if (source) this.stoppedSources.add(source);
    if (source?.admission) this.collector.cancel(source.admission);
    if (source && this.hostSources.get(threadId) === source) this.hostSources.delete(threadId);
    // 1.0.22 cause B: a Stop ends the message; what its refused attempt masked is not carried into anything after it
    this.refusedSources.delete(threadId);
  }

  /** Host-owned terminal control for a sealed ledger. It carries no provider
   * content and never re-enters execution finalizers or settles a replacement. */
  refuseTurn(threadId: string, source: SourceContext): readonly AudienceEmission[] {
    // A source Stop already cancelled still owes its one memory_refused (S1' race); a replaced or terminated source owes nothing.
    if (this.terminatedSources.has(source) || this.hostSources.get(threadId) !== source && !this.stoppedSources.has(source)) return [];
    if (this.hostSources.get(threadId) === source) { this.hostSources.delete(threadId); this.refusedSources.set(threadId, source); }
    this.terminatedSources.add(source);
    const event: RuntimeEvent = { type: "turn.completed", eventId: randomUUID(), provider: "murage",
      threadId, createdAt: new Date().toISOString(), ok: false, stopReason: "memory_refused" };
    return this.collector.intake(event, source).audience
      .filter(emission => emission.event.type === "turn.completed")
      .map(emission => Object.freeze({ ...emission, event: Object.freeze({ ...emission.event,
        ok: false, stopReason: "memory_refused" }) }));
  }

  audienceMaskedFor(event: RuntimeEvent): boolean { return this.maskedByExecution.get(event) ?? true; }
  /** The mask came from the turn's own secret scan (RuntimeAudienceCollector.maskedBySecret), not a fence. */
  audienceSecretMaskedFor(event: RuntimeEvent): boolean { return this.secretMaskedByExecution.get(event) === true; }
  /** The turn withheld some text unscanned (RuntimeAudienceCollector.withheld): its raw text is not proven clean, so a
   * reader of the RAW event (not the projection) treats this like a mask (cause22-E (b), FABLE design review H1). */
  audienceWithheldFor(event: RuntimeEvent): boolean { return this.withheldByExecution.get(event) === true; }
  /** What the event's turn had masked when this event was taken in. Undefined = unavailable: the reader keeps the 1.0.21 outcome. */
  audienceMaskedValuesFor(event: RuntimeEvent): MaskedValueView | undefined { return this.maskedValuesByExecution.get(event); }
  audienceFor(event: RuntimeEvent): readonly AudienceEmission[] { return this.audienceByExecution.get(event) ?? []; }

  publish(event: RuntimeEvent, source?: SourceContext) {
    if (source) {
      const terminal = event.type === "turn.completed";
      if (this.terminatedSources.has(source)) { if (terminal) this.dupTerminalRejected++; return; }
      if (this.stoppedSources.has(source) && !terminal) return;
      if (terminal) this.terminatedSources.add(source);
    }
    // Intake always precedes every no-log/live/closed-log and delivery branch.
    const result = this.collector.intake(event, source);
    const route = descriptorLogEvent(event);
    if (route.type === "request.resolved" && this.boundResolution && (!route.turnId || !this.boundResolution(route.threadId, route.turnId))) return;
    if (source) this.executionSources.set(event, source);
    this.audienceByExecution.set(event, result.audience);
    this.maskedByExecution.set(event, this.collector.masked(source));
    if (this.collector.maskedBySecret(source)) this.secretMaskedByExecution.set(event, true);
    if (this.collector.withheld(source)) this.withheldByExecution.set(event, true);
    const maskedValues = this.collector.maskedValues(source);
    if (maskedValues) this.maskedValuesByExecution.set(event, maskedValues);
    if (route.type === "item.completed" && route.itemType === "tool") checkAllHookCanon("V-ANY");
    observeTurnEvent(route);
    const write = !this.omitThread(route.threadId) && persistsEvent(route) && !threadLogClosed(route.threadId);
    if (write) {
      try {
        const safe = result.audience.filter(emission => persistsEvent(emission.event as unknown as RuntimeEvent)).map(emission => {
          const safeEvent = emission.event as unknown as RuntimeEvent;
          const candidate = { ...safeEvent, provider: this.hostDriverKinds.get(emission.envelope.instanceId), ...(safeEvent.type === 'item.started' ? { input: loggedAudienceInput(safeEvent) } : {}) } as RuntimeEvent;
          return candidate.type === ("audience.omitted" as string) ? candidate :
            withheldForLog(this.withhold, redactSecrets(withoutImageBytes(loggedRuntimeEvent(candidate))) as RuntimeEvent, route);
        });
        const pendingWarning = this.pendingLogWarnings.get(route.threadId);
        const lines = (pendingWarning ? [pendingWarning, ...safe] : safe).map(value => boundedRecord(value as RuntimeEvent));
        const encoded = lines.join("\n") + "\n";
        const bytes = Buffer.byteLength(encoded);
        const ownsFiles = this.appendLog === appendFileSync;
        if (ownsFiles) {
          flushSessionLines(EVENTS_DIR, route.threadId);
          // Native deletion owns this private compact record. Audience logs
          // keep only the collector projection, including its opaque ids.
          if (route.type === "session.started") recordSessionLine(EVENTS_DIR, route.threadId, JSON.stringify(loggedRuntimeEvent(route)));
        }
        const freshFile = ownsFiles && rotateIfFull(EVENTS_DIR, route.threadId, bytes);
        this.appendLog(join(EVENTS_DIR, `${route.threadId}.ndjson`), encoded, { mode: 0o600 });
        if (freshFile) markLogCovered(EVENTS_DIR, route.threadId);
        if (ownsFiles) sweepAfterWrite(EVENTS_DIR, route.threadId, bytes);
        this.pendingLogWarnings.delete(route.threadId);
      } catch {
        // Never expose an exception that may contain provider values.
        if (!this.pendingLogWarnings.has(route.threadId)) {
          const warning: RuntimeEvent = { type: "runtime.error", eventId: randomUUID(), provider: "murage", threadId: route.threadId,
            createdAt: new Date().toISOString(), message: "Canonical event history is incomplete: Murage could not write one or more events to disk. Live updates will continue." };
          this.pendingLogWarnings.set(route.threadId, warning);
          console.error("bus: canonical event log write failed");
          this.deliver(warning);
        }
      }
    }
    this.deliver(event);
    for (const emission of result.audience) {
      const owed: RuntimeEventListener[] = [];
      for (const [listener, options] of this.audienceListeners) {
        if (options.durable !== false) { owed.push(() => listener(emission)); continue; }
        try { listener(emission); } catch { console.error("bus: audience listener threw"); }
      }
      if (!owed.length) continue;
      // Queue only the immutable safe payload. Retrying an owed listener never
      // re-enters the collector or captures the execution graph.
      const safe = emission.event as unknown as RuntimeEvent;
      if (this.pendingByThread.has(safe.threadId) || this.gate?.held()) this.enqueue(safe, owed);
      else { const left = this.runOwed(safe, owed); if (left.length) this.enqueue(safe, left); }
    }
  }

  subscribeExecution(listener: RuntimeEventListener, options: { durable?: boolean } = {}): () => void {
    return this.subscribe(listener, options);
  }
  subscribeAudience(listener: (event: AudienceEmission) => void, options: { durable?: boolean } = {}): () => void {
    this.audienceListeners.set(listener, options);
    return () => { this.audienceListeners.delete(listener); };
  }

  private deliver(event: RuntimeEvent) {
    const owed: RuntimeEventListener[] = [];
    for (const listener of [...this.listeners]) {
      if (!this.immediate.has(listener)) { owed.push(listener); continue; }
      try {
        listener(event);
      } catch (e) {
        console.error("bus: execution listener threw");
      }
    }
    if (!owed.length) return;
    // Durable listeners write to messages.db. While the lock is held, or earlier events of the same thread are still waiting,
    // this one queues behind them (per-thread order is kept); otherwise it runs now.
    if (this.pendingByThread.has(descriptorLogEvent(event).threadId) || this.gate?.held()) { this.enqueue(event, owed); return; }
    const left = this.runOwed(event, owed);
    if (left.length) this.enqueue(event, left);
  }

  /** Runs the listeners in order. At the first one that hits a locked database it stops and returns that listener AND every
   * listener after it, so none overtakes the failed one. A listener that fails any other way is logged and skipped. */
  private runOwed(event: RuntimeEvent, owed: RuntimeEventListener[]): RuntimeEventListener[] {
    for (let i = 0; i < owed.length; i++) {
      try {
        owed[i]!(event);
      } catch (e) {
        if (this.gate?.isBusy(e)) return owed.slice(i);
        console.error("bus: execution listener threw");
      }
    }
    return [];
  }

  private enqueue(event: RuntimeEvent, owed: RuntimeEventListener[]) {
    const bytes = (attachedEventCharge(event) ?? boundedEventCharge(event)).bytes;
    const control = descriptorLogEvent(event).type === "turn.completed" || descriptorLogEvent(event).type === "session.exited" || descriptorLogEvent(event).type === "request.resolved" || descriptorLogEvent(event).type === "runtime.error";
    const reserved = control && this.reserveCount < 256 && this.reserveBytes + bytes <= 1024 * 1024;
    if (control && !reserved) console.error("bus: control delivery reserve reached its cap");
    const entry = { event, owed, bytes, reserved };
    const queue = this.pendingByThread.get(descriptorLogEvent(event).threadId);
    if (queue) queue.push(entry); else this.pendingByThread.set(descriptorLogEvent(event).threadId, [entry]);
    if (reserved) { this.reserveCount++; this.reserveBytes += bytes; }
    else {
      this.pendingCount++; this.pendingBytes += bytes;
      this.regularByThread.set(descriptorLogEvent(event).threadId, (this.regularByThread.get(descriptorLogEvent(event).threadId) ?? 0) + 1);
      this.bytesByThread.set(descriptorLogEvent(event).threadId, (this.bytesByThread.get(descriptorLogEvent(event).threadId) ?? 0) + bytes);
    }
    this.checkCapacity();
    this.kick();
  }

  /** The cap is global (all threads, events and bytes). Reaching it releases the hold on writers (a held gate would
   * otherwise keep every thread queueing; the index build defers to a later idle) and closes intake. Intake reopens only
   * below the low-water mark, so producers do not flap.
   *
   * No deadlock between threads: a thread may hold at most half the event cap (`threadShare`), so one thread whose
   * listener keeps meeting a lock cannot fill the queue and starve the others. A blocked thread's queue drains by its own
   * retry timer, independent of intake, and a thread with nothing queued delivers synchronously without using capacity. */
  private checkCapacity() {
    const { maxEvents, maxBytes } = this.limits;
    if (!this.saturated && (this.pendingCount >= maxEvents || this.pendingBytes >= maxBytes)) {
      this.saturated = true;
      if (!this.overflowed) {
        this.overflowed = true;
        console.error(`bus: delivery queue reached its cap (${this.pendingCount} events); intake is paused until it drains and the writer hold is released`);
        try { this.gate?.overflow?.(); } catch (e) { console.error("bus: overflow release failed", e); }
      }
    } else if (this.saturated && this.pendingCount <= Math.floor(maxEvents / 2) && this.pendingBytes <= Math.floor(maxBytes / 2)) {
      this.saturated = false;
    }
    if (!this.overflowed && [...this.bytesByThread.values()].some(bytes => bytes >= Math.max(1, Math.floor(maxBytes / 2)))) {
      this.overflowed = true;
      try { this.gate?.overflow?.(); } catch { console.error("bus: overflow release failed"); }
    }
    if (!this.pendingCount) this.overflowed = false;
    this.valve.evaluate();
  }
  private threadShare(): number { return Math.max(1, Math.floor(this.limits.maxEvents / 2)); }
  /** True while a producer for this thread (null: a stream shared by several) must wait. */
  private intakeClosed(threadId: string | null): boolean {
    if (this.saturated) return true;
    if (threadId === null) return false;
    return (this.regularByThread.get(threadId) ?? 0) >= this.threadShare() || (this.bytesByThread.get(threadId) ?? 0) >= Math.max(1, Math.floor(this.limits.maxBytes / 2));
  }

  private kick() {
    if (this.draining) return;
    this.draining = true;
    void this.drain().catch(e => console.error("bus: drain failed", e)).finally(() => { this.draining = false; if (this.pendingDurable()) this.kick(); });
  }

  private async drain() {
    let held = 0;
    while (this.pendingDurable()) {
      if (this.gate?.held()) {
        await this.gate.wait();
        // a wait that returns at once while the hold is still in force (a bounded or exclusion-blind wait) must not spin the loop: a real timer, growing to a cap
        if (this.gate.held()) { held = Math.min(held * 2 || 5, 100); await new Promise<void>(resolve => setTimeout(resolve, held)); } else held = 0;
        continue;
      }
      held = 0;
      const now = Date.now();
      let budget = this.limits.batch, soonest = Infinity;
      for (const [threadId, queue] of [...this.pendingByThread]) {
        const state = this.retryState.get(threadId);
        if (state && state.at > now) { soonest = Math.min(soonest, state.at); continue; }
        while (queue.length && budget > 0) {
          const head = queue[0]!;
          head.owed = this.runOwed(head.event, head.owed);
          if (head.owed.length) {
            const attempts = (state?.attempts ?? 0) + 1;
            if (attempts === 100) console.error(`bus: thread ${threadId} has met a locked database ${attempts} times; still retrying`);
            const wait = Math.min(this.limits.retryMaxMs, this.limits.retryMinMs * 2 ** Math.min(attempts, 10));
            this.retryState.set(threadId, { at: Date.now() + wait, attempts });
            soonest = Math.min(soonest, Date.now() + wait);
            break;
          }
          queue.shift(); budget--;
          if (head.reserved) { this.reserveCount--; this.reserveBytes -= head.bytes; }
          else {
            this.pendingCount--; this.pendingBytes -= head.bytes;
            this.regularByThread.set(threadId, Math.max(0, (this.regularByThread.get(threadId) ?? 0) - 1));
            this.bytesByThread.set(threadId, Math.max(0, (this.bytesByThread.get(threadId) ?? 0) - head.bytes));
          }
          this.retryState.delete(threadId);
        }
        if (!queue.length) { this.pendingByThread.delete(threadId); this.retryState.delete(threadId); this.bytesByThread.delete(threadId); this.regularByThread.delete(threadId); }
        this.checkCapacity();
        if (budget <= 0) break;
      }
      if (!this.pendingDurable()) break;
      // hand the loop back between batches; sleep until the soonest retry when every thread is backing off
      await new Promise<void>(resolve => budget <= 0 ? setImmediate(resolve) : setTimeout(resolve, Math.max(5, Math.min(this.limits.retryMaxMs, soonest - Date.now()))));
    }
  }

  /** Test seam: tighter bounds and timings. */
  setDeliveryLimits(limits: Partial<DeliveryLimits>) { this.limits = { ...DEFAULT_LIMITS, ...limits }; }

  /** The writer gate the durable listeners wait on (server/database.ts). */
  gateDeliveries(gate: DeliveryGate | null) { this.gate = gate; }

  /** True while a durable delivery is still queued. */
  pendingDurable(): number { return this.pendingCount + this.reserveCount; }

  subscribe(listener: RuntimeEventListener, options: { durable?: boolean } = {}): () => void {
    this.listeners.add(listener);
    if (options.durable === false) this.immediate.add(listener);
    return () => { this.listeners.delete(listener); this.immediate.delete(listener); };
  }

  detachAll() {
    this.detach(new Set(this.attachments.keys()));
  }

  /** Stop delivering only these instances' events; every other engine stays
   * attached (a scoped provider reload, server/index.ts reloadProviders). */
  detach(instanceIds: ReadonlySet<string>) {
    for (const instanceId of instanceIds) {
      const attachment = this.attachments.get(instanceId);
      // Events this attachment already handed over may still wait behind a chunked reply: its admissions end after them.
      if (attachment && this.intakeDraining.get(attachment)) this.detachAfterDrain.add(attachment);
      else if (attachment) this.collector.detach(attachment);
      this.attachments.delete(instanceId);
      this.subscriptions.get(instanceId)?.unsubscribe();
      this.subscriptions.delete(instanceId);
    }
  }
}

/** An authentication-class failure on an engine marks it signed out; a turn that finishes well clears the mark.
 *  Read from the event's own words (and the structured provider error when there is one), never from tool names. */
function observeSignIn(instanceId: string, event: RuntimeEvent, subscriptionLogin = false): void {
  if (event.type === "turn.completed") {
    if (event.ok === true) noteInstanceTurnOk(instanceId);
    return;
  }
  if (event.type !== "runtime.error" || event.setup === true) return;
  if (event.fluxDecision) {
    if (event.fluxDecision.reason === "keyRevoked") noteInstanceAuthFailure(instanceId, Date.now(), { signIn: false });
    return;
  }
  if (event.authRequired === true || event.providerError?.kind === "authentication" || looksLikeAuthFailure(event.message, { engineLevel: subscriptionLogin })) noteInstanceAuthFailure(instanceId, Date.now(), { signIn: subscriptionLogin });
}
