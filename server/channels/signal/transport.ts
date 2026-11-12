// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../../atomic.ts";
import { ChannelSendError, type ChannelRuns, type DurableDelivery } from "../durable-delivery.ts";
import { wrapUntrusted } from "../core/wrap.ts";
import { aciSchema, parseRequest, parseResponse, rateLimitErrorSchema } from "./rpc.ts";
import type { SignalProcessHost } from "./process-host.ts";
import type { DeliveryAttempt, OutboxEntry, RpcError, RpcRequest, RuntimePin, SendNoteToSelfInput, Transport } from "./types.ts";

export const SIGNAL_MAX_RESPONSE = 20_000;
const RESPONSE_LIMIT = 12_000, CHUNK_LIMIT = 2000, WINDOW_MS = 7 * 86400000;
const suffix = "\nThe rest is in Murage.";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const key = (input: DeliveryAttempt) => JSON.stringify([input.deliveryId, input.purpose, input.attempt]);
const identity = z.object({ deliveryId: z.string().min(1).max(400).regex(/^[^\x00-\x1f\x7f]+$/),
  purpose: z.enum(["reply", "notice"]), attempt: z.number().int().min(1).max(3),
}).refine(value => value.purpose !== "notice" || value.attempt === 1);
const timestamp = z.number().int().safe().positive();
const chunkSchema = z.union([
  z.strictObject({ state: z.enum(["reserved", "written"]), timestamp: timestamp.optional() }),
  z.strictObject({ state: z.literal("confirmed"), timestamp }),
]);
const entrySchema = z.strictObject({ ...identity.shape, occurredAt: timestamp, digest: z.string().regex(/^[a-f0-9]{64}$/),
  chunks: z.array(chunkSchema).min(1).max(6),
}).refine(value => value.purpose !== "notice" || value.attempt === 1);
const stateSchema = z.strictObject({ version: z.literal(1), connectionId: z.string().min(1), recipient: z.string(),
  lastTimestamp: z.number().int().safe().nonnegative(), entries: z.array(entrySchema),
  sent: z.array(z.strictObject({ timestamp, occurredAt: timestamp })),
});
type Entry = OutboxEntry & { digest: string };
type State = Omit<z.infer<typeof stateSchema>, "entries"> & { entries: Entry[] };

/** The adapter calls this on complete run output, before DurableDelivery stores it. */
export function formatSignalResult(output: string): string {
  if (output.length <= RESPONSE_LIMIT && splitText(output).length <= 6) return output;
  // Five boundaries can each give up one UTF-16 unit to keep a surrogate pair whole.
  const prefix = output.slice(0, RESPONSE_LIMIT - 5 - suffix.length);
  const line = prefix.lastIndexOf("\n"), space = prefix.lastIndexOf(" ");
  let end = line > 0 ? line : space > 0 ? space : prefix.length;
  if (/[\uD800-\uDBFF]/.test(prefix[end - 1] ?? "")) end--;
  return prefix.slice(0, end).trimEnd() + suffix;
}
export function formatSignalRuns(runs: ChannelRuns): ChannelRuns {
  return { enqueue: input => runs.enqueue(input), result: id => {
    const result = runs.result(id);
    return result ? { ...result, ...(result.output === undefined ? {} : { output: formatSignalResult(result.output) }),
      ...(result.notice === undefined ? {} : { notice: formatSignalResult(result.notice) }) } : null;
  } };
}
/** Size admission only; B4 must apply every other note guard before replying. */
export function prepareSignalPrompt(body: string): string | null {
  const prompt = wrapUntrusted("SIGNAL", { body });
  return prompt.length <= 6000 ? prompt : null;
}
function chunks(text: string): string[] {
  if (typeof text !== "string" || !text.length || text.length > RESPONSE_LIMIT) throw new ChannelSendError("invalid-request", false);
  const result = splitText(text);
  if (result.length > 6) throw new ChannelSendError("invalid-request", false);
  return result;
}
function splitText(text: string): string[] {
  const result: string[] = [];
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(offset + CHUNK_LIMIT, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
    result.push(text.slice(offset, end)); offset = end;
  }
  return result;
}

export interface SignalTransportOptions {
  /** DATA_DIR/channels/signal/<connectionId>/outbox.json, after StorageGuard. */
  file: string;
  connectionId: string;
  ownAci: string;
  generation: number;
  /** B0-compatible wrappers may already bind requests to a captured child token. */
  host: Pick<SignalProcessHost, "request" | "generation"> & Partial<Pick<SignalProcessHost, "spawnToken">>;
  isCurrent: () => boolean;
  /** Enabled only by S1-TS; otherwise release also requires S1-ECHO. */
  timestampSupported: boolean;
  pin: Pick<RuntimePin, "signalCliVersion" | "rateLimitNotSentProof">;
  /** The version verified for this child generation, never a cached previous child. */
  liveVersion: () => string | null;
  now?: () => number;
  log?: (line: string) => void;
  count?: (name: "signal.send.uncertain", labels: { reason: "rate-limit" }) => void;
}

/** One instance per connection. The sent set shares the outbox's atomic commit,
 * so reservations cannot survive without their echo guard. No message text is stored here. */
export class SignalTransport implements Transport {
  readonly recipient: string;
  private state: State;
  private active = new Set<string>();
  private poisoned = false;
  private options: SignalTransportOptions;
  constructor(options: SignalTransportOptions) {
    this.options = options;
    if (!aciSchema.safeParse(options.ownAci).success) throw new Error("Invalid Signal identity");
    this.recipient = `note-to-self:${hash(options.ownAci)}`;
    this.state = { version: 1, connectionId: options.connectionId, recipient: this.recipient, lastTimestamp: 0, entries: [], sent: [] };
    try {
      const fd = openSync(options.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 32 * 1024 * 1024) throw new Error();
        const parsed = stateSchema.safeParse(JSON.parse(readFileSync(fd, "utf8")));
        if (!parsed.success) throw new Error();
        const state = parsed.data as State;
        if (state.connectionId !== options.connectionId || state.recipient !== this.recipient
          || new Set(state.entries.map(key)).size !== state.entries.length) throw new Error();
        this.state = state;
      } finally { closeSync(fd); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Invalid Signal outbox; original data preserved");
    }
    this.prune();
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  private update(change: (state: State) => void) {
    if (this.poisoned) throw new Error("Signal outbox needs reopening");
    const next = structuredClone(this.state); change(next);
    if (!stateSchema.safeParse(next).success) throw new Error("Invalid Signal outbox update");
    const bytes = JSON.stringify(next);
    if (Buffer.byteLength(bytes) > 32 * 1024 * 1024) throw new Error("Signal outbox is full");
    try {
      mkdirSync(dirname(this.options.file), { recursive: true, mode: 0o700 });
      writeFileAtomic(this.options.file, bytes, { mode: 0o600, syncDir: true });
      this.state = next;
    } catch (error) { this.poisoned = true; throw error; }
  }
  private entry(input: DeliveryAttempt) { return this.state.entries.find(entry => key(entry) === key(input)); }
  private validate(input: DeliveryAttempt & { text: string }): string[] {
    if (!identity.safeParse(input).success) throw new ChannelSendError("invalid-request", false);
    return chunks(input.text);
  }
  private current() { return this.options.isCurrent() && this.options.host.generation === this.options.generation; }
  prune(): void {
    const cutoff = this.now() - WINDOW_MS;
    if (!this.state.entries.some(entry => entry.occurredAt < cutoff && !this.active.has(key(entry)))
      && !this.state.sent.some(row => row.occurredAt < cutoff)) return;
    this.update(state => {
      state.entries = state.entries.filter(entry => entry.occurredAt >= cutoff || this.active.has(key(entry)));
      state.sent = state.sent.filter(row => row.occurredAt >= cutoff);
    });
  }
  hasSentTimestamp(value: number): boolean {
    return this.state.sent.some(row => row.timestamp === value && row.occurredAt >= this.now() - WINDOW_MS);
  }
  /** Pass this to B5's RpcPolicy along with timestampSupported. */
  isReservedTimestamp(value: number): boolean {
    return !this.poisoned && this.hasSentTimestamp(value) && this.state.entries.some(entry =>
      entry.chunks.some(chunk => chunk.timestamp === value && chunk.state !== "confirmed"));
  }
  async reserve(input: DeliveryAttempt & { text: string }): Promise<string[]> {
    const parts = this.validate(input);
    this.prune();
    const existing = this.entry(input);
    if (existing) {
      if (existing.digest !== hash(input.text) || existing.chunks.length !== parts.length) throw new ChannelSendError("invalid-request", false);
      if (this.poisoned) throw new ChannelSendError("unavailable", true);
      return this.options.timestampSupported ? existing.chunks.map(chunk => String(chunk.timestamp)) : [];
    }
    this.update(state => {
      const occurredAt = this.now();
      const entry: Entry = { deliveryId: input.deliveryId, purpose: input.purpose, attempt: input.attempt,
        occurredAt, digest: hash(input.text), chunks: [] } as Entry;
      for (const _part of parts) {
        if (this.options.timestampSupported) {
          const value = Math.max(occurredAt, state.lastTimestamp + 1); state.lastTimestamp = value;
          entry.chunks.push({ state: "reserved", timestamp: value }); state.sent.push({ timestamp: value, occurredAt });
        } else entry.chunks.push({ state: "reserved" });
      }
      state.entries.push(entry);
    });
    return this.options.timestampSupported ? this.entry(input)!.chunks.map(chunk => String(chunk.timestamp)) : [];
  }
  private rateLimit(error: RpcError, partial: boolean): ChannelSendError {
    const parsed = rateLimitErrorSchema.safeParse(error);
    const results = parsed.success ? parsed.data.data.response.results : [];
    const rawDelay = results.length === 1 ? results[0].retryAfterSeconds ?? 60 : 60;
    const safeDelay = Number.isSafeInteger(this.now() + rawDelay * 1000);
    const delay = safeDelay ? rawDelay : 60;
    const proof = this.options.pin.rateLimitNotSentProof;
    const proven = !partial && parsed.success && safeDelay && !!proof?.citation.trim() && !!proof.reviewedBy.trim()
      && proof.signalCliVersion === this.options.pin.signalCliVersion && proof.signalCliVersion === this.options.liveVersion()
      && results.length === 1 && results[0].recipientAddress.uuid === this.options.ownAci;
    if (!proven) {
      // Diagnostics must never affect delivery settlement or include provider text.
      try { (this.options.log ?? console.warn)(`[signal] reply may have been sent: rate-limit retryAfter=${delay}`); } catch { /* diagnostic only */ }
      try { this.options.count?.("signal.send.uncertain", { reason: "rate-limit" }); } catch { /* diagnostic only */ }
    }
    return new ChannelSendError("rate-limit", !proven, delay, partial);
  }
  async sendNoteToSelf(input: SendNoteToSelfInput): Promise<{ timestamps: number[] }> {
    // Capture before any await; all chunks belong to this originating child.
    const spawnToken = this.options.host.spawnToken;
    const parts = this.validate(input), attemptKey = key(input);
    if (this.active.has(attemptKey)) throw new ChannelSendError("unavailable", true);
    this.active.add(attemptKey);
    let written = 0;
    try {
      const reserved = await this.reserve(input);
      const entry = this.entry(input)!;
      if (entry.chunks.some(chunk => chunk.state !== "reserved")) throw new ChannelSendError("unavailable", true,
        undefined, entry.chunks.some(chunk => chunk.state === "confirmed") && entry.chunks.length > 1);
      if (input.reserved && JSON.stringify(input.reserved) !== JSON.stringify(reserved)) throw new ChannelSendError("invalid-request", false);
      const timestamps: number[] = [];
      for (let i = 0; i < parts.length; i++) {
        let mapped: ChannelSendError | undefined;
        try {
          if (!this.current()) throw Object.assign(new Error(), { code: "offline" });
          const request: RpcRequest<"send"> = { jsonrpc: "2.0", id: randomUUID(), method: "send", params: {
            noteToSelf: true, message: parts[i], ...(this.options.timestampSupported ? { timestamp: Number(reserved[i]) } : {}),
          } };
          parseRequest(request, { timestampSupported: this.options.timestampSupported, isReservedTimestamp: value => this.isReservedTimestamp(value) });
          const raw = await this.options.host.request(request, { generation: this.options.generation, spawnToken, beforeWrite: () => {
            if (!this.current() || input.signal?.aborted || input.isRedacted()) return false;
            // This is synchronous inside the host's write fence, after its readiness check.
            this.update(state => { state.entries.find(row => key(row) === attemptKey)!.chunks[i].state = "written"; });
            written++;
            return this.current() && !input.signal?.aborted && !input.isRedacted();
          } });
          if (!written || !this.current()) throw new Error();
          const response = parseResponse("send", raw);
          if (response.id !== request.id) throw new Error();
          if (response.error) {
            mapped = response.error.code === -5 ? this.rateLimit(response.error, i > 0)
              : new ChannelSendError("unavailable", true, undefined, i > 0);
            throw mapped;
          }
          const { timestamp: value, results } = response.result;
          if (results.length !== 1 || results[0].type !== "SUCCESS" || results[0].recipientAddress.uuid !== this.options.ownAci
            || (this.options.timestampSupported && value !== Number(reserved[i]))) throw new Error();
          // Without S1-TS, commit the returned echo guard before confirming this chunk.
          if (!this.options.timestampSupported) this.update(state => {
            state.sent.push({ timestamp: value, occurredAt: this.now() }); state.lastTimestamp = Math.max(state.lastTimestamp, value);
          });
          this.update(state => { state.entries.find(row => key(row) === attemptKey)!.chunks[i] = { state: "confirmed", timestamp: value }; });
          timestamps.push(value);
        } catch (error) {
          if (mapped === error) throw mapped;
          const code = (error as { code?: string } | null)?.code;
          throw new ChannelSendError(code === "invalid-request" ? "invalid-request" : code === "offline" ? "offline"
            : code === "timeout" ? "timeout" : "unavailable", written > 0 || this.poisoned, undefined, i > 0);
        }
      }
      return { timestamps };
    } finally { this.active.delete(attemptKey); }
  }
  /** B1's broader hook identity is validated at runtime before crossing B0's contract. */
  ledgerHooks(isRedacted: (deliveryId: string) => boolean): Pick<ConstructorParameters<typeof DurableDelivery>[0], "reserve" | "send"> {
    return {
      reserve: input => this.reserve(input as DeliveryAttempt & { text: string }),
      send: async input => {
        if (input.recipient !== this.recipient) throw new ChannelSendError("invalid-request", false);
        const result = await this.sendNoteToSelf({ ...input, isRedacted: () => isRedacted(input.deliveryId) } as SendNoteToSelfInput);
        return { recipient: this.recipient, messageId: String(result.timestamps.at(-1)!) };
      },
    };
  }
}
