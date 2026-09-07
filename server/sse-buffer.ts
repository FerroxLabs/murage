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
  private readonly response: SseWritable;
  private readonly onClose: (reason: SseCloseReason) => void;
  private readonly onProgress: () => void;
  peakPendingBytes = 0;
  peakQueuedFrames = 0;

  constructor(
    response: SseWritable,
    onClose: (reason: SseCloseReason) => void,
    options: Partial<SseWriter["limits"]> = {},
    onProgress: () => void = () => {},
  ) {
    this.response = response;
    this.onClose = onClose;
    this.onProgress = onProgress;
    this.limits = { maxBytes: SSE_MAX_PENDING_BYTES, maxFrames: SSE_MAX_PENDING_FRAMES, maxFrameBytes: SSE_MAX_FRAME_BYTES, ...options };
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
    if (this.blocked) {
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
    this.blocked = false;
    while (this.queue.length && !this.blocked && !this.stopped) {
      const next = this.queue.shift()!;
      this.queueBytes -= next.bytes;
      this.write(next.frame);
    }
    this.observe();
  };

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
  frame: string | null;
  bytes: number;
  /** A required frame was too large to replay; matching clients need a snapshot. */
  gap: boolean;
}

export class SseReplay {
  private entries: SseReplayEntry[] = [];
  private readonly limits: { maxBytes: number; maxEntries: number; maxFrameBytes: number };
  bytes = 0;

  constructor(limits = {
    maxBytes: SSE_REPLAY_MAX_BYTES,
    maxEntries: SSE_REPLAY_MAX_ENTRIES,
    maxFrameBytes: SSE_MAX_FRAME_BYTES,
  }) { this.limits = limits; }

  get count(): number { return this.entries.length; }

  append(meta: Pick<SseReplayEntry, "seq" | "kind" | "subject">, frame: string): SseReplayEntry {
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
      bytes += entry.bytes + WRITE_OVERHEAD_BYTES;
      if (bytes > budget.maxBytes || frames.length >= budget.maxFrames) return unavailable;
      frames.push(entry.frame);
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
