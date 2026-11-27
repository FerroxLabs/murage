import type { DatabaseSync } from "node:sqlite";
import { projectFrame } from "./mailbox/projection.ts";
import type { FrameSubject } from "./sse-visibility.ts";

export const SSE_MAX_FRAME_BYTES = 2 * 1024 * 1024;
export const SSE_MAX_PENDING_BYTES = 4 * 1024 * 1024;
export const SSE_MAX_PENDING_FRAMES = 128;
export const SSE_MAX_CLIENTS = 16;
export const SSE_REPLAY_MAX_BYTES = 8 * 1024 * 1024;
export const SSE_REPLAY_MAX_ENTRIES = 500;
// Reserve chunk framing as well as payload bytes before writing to Node.
const WRITE_OVERHEAD_BYTES = 32;

export interface SseWritable {
  readonly writableLength: number;
  readonly destroyed: boolean;
  write(frame: string): boolean;
  destroy(): unknown;
  on(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
}

export type SseCloseReason = "closed" | "error" | "backpressure" | "oversized";

/** A bounded queue shared by hello, replay, heartbeat and live traffic.
 * write(false) has accepted that frame: never write it again on drain. */
export class SseWriter {
  private queue: Array<{ frame: string; bytes: number }> = [];
  private queueBytes = 0;
  private blocked = false;
  private stopped = false;
  private readonly limits: { maxBytes: number; maxFrames: number; maxFrameBytes: number };
  private readonly mailboxDatabase?: () => DatabaseSync;
  private queuedSealGeneration?: number;
  private readonly response: SseWritable;
  private readonly onClose: (reason: SseCloseReason) => void;
  private readonly onProgress: () => void;
  peakPendingBytes = 0;
  peakQueuedFrames = 0;
  /** UTF-8 bytes of every frame this writer accepted (net-meter.ts reads the difference around a send). */
  acceptedBytes = 0;

  constructor(
    response: SseWritable,
    onClose: (reason: SseCloseReason) => void,
    options: Partial<SseWriter["limits"]> & { mailboxDatabase?: () => DatabaseSync } = {},
    onProgress: () => void = () => {},
  ) {
    this.response = response;
    this.onClose = onClose;
    this.onProgress = onProgress;
    const { mailboxDatabase, ...limits } = options;
    this.mailboxDatabase = mailboxDatabase;
    this.limits = { maxBytes: SSE_MAX_PENDING_BYTES, maxFrames: SSE_MAX_PENDING_FRAMES, maxFrameBytes: SSE_MAX_FRAME_BYTES, ...limits };
    response.on("drain", this.drain);
    response.on("close", this.peerClosed);
    response.on("error", this.errored);
  }

  get closed(): boolean { return this.stopped; }
  get pendingBytes(): number { return this.stopped ? 0 : this.queueBytes + this.response.writableLength; }
  get queuedFrames(): number { return this.queue.length; }

  send(frame: string): boolean {
    if (this.stopped) return false;
    if (this.response.destroyed) { this.close("closed"); return false; }
    const bytes = Buffer.byteLength(frame) + WRITE_OVERHEAD_BYTES;
    if (bytes - WRITE_OVERHEAD_BYTES > this.limits.maxFrameBytes) { this.close("oversized"); return false; }
    if (this.pendingBytes + bytes > this.limits.maxBytes || (this.blocked && this.queue.length >= this.limits.maxFrames)) {
      this.close("backpressure");
      return false;
    }
    this.acceptedBytes += bytes - WRITE_OVERHEAD_BYTES;
    if (this.blocked) {
      if (!this.queue.length && this.mailboxDatabase) this.queuedSealGeneration = this.sealGeneration();
      this.queue.push({ frame, bytes });
      this.queueBytes += bytes;
      this.observe();
      return true;
    }
    return this.write(frame);
  }

  close(reason: SseCloseReason = "closed"): void {
    if (this.stopped) return;
    this.stopped = true;
    this.queue = [];
    this.queueBytes = 0;
    this.response.off("drain", this.drain);
    this.response.off("close", this.peerClosed);
    this.response.off("error", this.errored);
    this.onClose(reason);
    if (!this.response.destroyed) this.response.destroy();
  }

  private readonly peerClosed = () => this.close("closed");
  private readonly errored = () => this.close("error");
  private readonly drain = () => {
    if (this.stopped) return;
    // Reconnect runs current-seal replay for frames encoded before the barrier.
    if (this.queue.length && this.mailboxDatabase
      && (this.queuedSealGeneration === undefined || this.queuedSealGeneration !== this.sealGeneration())) {
      this.close("backpressure");
      return;
    }
    this.blocked = false;
    while (this.queue.length && !this.blocked && !this.stopped) {
      const next = this.queue.shift()!;
      this.queueBytes -= next.bytes;
      this.write(next.frame);
    }
    this.observe();
  };

  private sealGeneration(): number | undefined {
    try {
      const generation = this.mailboxDatabase?.().prepare("SELECT COALESCE(MAX(generation),0) AS generation FROM mailbox_sealed_threads").get()?.generation;
      return typeof generation === "number" && Number.isSafeInteger(generation) ? generation : undefined;
    } catch { return undefined; }
  }

  private write(frame: string): boolean {
    try {
      this.blocked = !this.response.write(frame);
      this.observe();
      // A response implementation must not be able to bypass the byte bound.
      if (this.pendingBytes > this.limits.maxBytes) { this.close("backpressure"); return false; }
      return true;
    } catch {
      this.close("error");
      return false;
    }
  }

  private observe(): void {
    this.peakPendingBytes = Math.max(this.peakPendingBytes, this.pendingBytes);
    this.peakQueuedFrames = Math.max(this.peakQueuedFrames, this.queue.length);
    this.onProgress();
  }
}

export interface SseReplayEntry {
  seq: number;
  kind: string;
  subject: FrameSubject;
  threadId?: string;
  frame: string | null;
  bytes: number;
  /** A required frame was too large to replay; matching clients need a snapshot. */
  gap: boolean;
  /** A page frame kept in the cards-beside shape only (index.ts broadcastPage). */
  besideOnly?: boolean;
}

function encodeSseFrame(streamId: string, seq: number, payload: Record<string, unknown>, sealed: boolean): string {
  const visible = sealed ? projectFrame(payload) : payload;
  return `id: ${streamId}:${seq}\ndata: ${JSON.stringify({ ...visible, seq })}\n\n`;
}

export function encodeSseFrames(
  streamId: string, seq: number, sealed: boolean,
  primary: Record<string, unknown>, taskDelta?: Record<string, unknown>, cardsBeside?: Record<string, unknown>,
) {
  return {
    primary: encodeSseFrame(streamId, seq, primary, sealed),
    taskDelta: taskDelta && encodeSseFrame(streamId, seq, taskDelta, sealed),
    cardsBeside: cardsBeside && encodeSseFrame(streamId, seq, cardsBeside, sealed),
  };
}

function projectReplayFrame(frame: string, seq: number): string | null {
  const [id, data] = frame.split("\n", 2);
  const stream = /^id: ([^:\s]+):[0-9]+$/.exec(id)?.[1];
  if (!stream || !data?.startsWith("data: ")) return null;
  try {
    const payload = JSON.parse(data.slice(6));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    return encodeSseFrame(stream, seq, payload, true);
  } catch { return null; }
}

export class SseReplay {
  private entries: SseReplayEntry[] = [];
  private readonly limits: { maxBytes: number; maxEntries: number; maxFrameBytes: number };
  private readonly sealedSubject: ((subject: FrameSubject) => boolean) | undefined;
  bytes = 0;

  constructor(limits = {
    maxBytes: SSE_REPLAY_MAX_BYTES,
    maxEntries: SSE_REPLAY_MAX_ENTRIES,
    maxFrameBytes: SSE_MAX_FRAME_BYTES,
  }, sealedSubject?: (subject: FrameSubject) => boolean) {
    this.limits = limits;
    this.sealedSubject = sealedSubject;
  }

  get count(): number { return this.entries.length; }

  /** Whether any frame after `since` was kept only in the cards-beside shape. */
  hasBesideOnlySince(since: number | null): boolean {
    return since !== null && this.entries.some((entry) => entry.seq > since && entry.besideOnly === true);
  }

  append(meta: Pick<SseReplayEntry, "seq" | "kind" | "subject" | "threadId"> & { besideOnly?: boolean }, frame: string): SseReplayEntry {
    const size = Buffer.byteLength(frame);
    const screen = meta.kind === "screen";
    const gap = !screen && (size > this.limits.maxFrameBytes || size > this.limits.maxBytes);
    const entry = { ...meta, frame: screen || gap ? null : frame, bytes: screen || gap ? 0 : size, gap };
    this.entries.push(entry);
    this.bytes += entry.bytes;
    while (this.entries.length > this.limits.maxEntries || this.bytes > this.limits.maxBytes) {
      this.bytes -= this.entries.shift()!.bytes;
    }
    return entry;
  }

  prepare(
    since: number | null,
    lastSeq: number,
    accepts: (entry: SseReplayEntry) => boolean,
    budget = { maxBytes: SSE_MAX_PENDING_BYTES - 1024, maxFrames: SSE_MAX_PENDING_FRAMES - 1 },
  ): { resumed: boolean; frames: string[] } {
    const unavailable = { resumed: false, frames: [] };
    if (since === null || since > lastSeq || (this.entries.length ? this.entries[0].seq > since + 1 : since !== lastSeq)) return unavailable;
    const frames: string[] = [];
    let bytes = 0;
    for (const entry of this.entries) {
      if (entry.seq <= since || !accepts(entry)) continue;
      if (entry.gap) return unavailable;
      if (!entry.frame) continue;
      const sealed = this.sealedSubject?.(entry.subject) ||
        (entry.threadId && this.sealedSubject?.({ scope: "thread", threadId: entry.threadId }));
      const frame = sealed ? projectReplayFrame(entry.frame, entry.seq) : entry.frame;
      if (frame === null) return unavailable;
      bytes += (frame === entry.frame ? entry.bytes : Buffer.byteLength(frame)) + WRITE_OVERHEAD_BYTES;
      if (bytes > budget.maxBytes || frames.length >= budget.maxFrames) return unavailable;
      frames.push(frame);
    }
    return { resumed: true, frames };
  }
}

/** Ephemeral preview degradation never disconnects the stream or erases the
 * last good image. The next ordinary screen clears this bounded notice. */
export function oversizedScreenNotice(streamId: string, seq: number, botId: unknown): string {
  return `id: ${streamId}:${seq}\ndata: ${JSON.stringify({
    kind: "screen.unavailable", seq, botId: typeof botId === "string" ? botId.slice(0, 128) : undefined,
    message: "This live preview exceeds the 2 MiB stream limit. The last preview is unchanged; open the live desktop or request a screenshot to see the current screen.",
  })}\n\n`;
}
