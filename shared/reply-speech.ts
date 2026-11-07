/** D24 audio framing: one byte kind, four bytes unsigned big-endian length, then payload. */
export const REPLY_AUDIO_MIME = "application/x-murage-speech";
export const MAX_REPLY_AUDIO = 8 * 1024 * 1024;
export const MAX_REPLY_FRAME = 64 * 1024;
export const AUDIO_MIMES = new Set(["audio/mpeg", "audio/ogg", "audio/wav", "audio/mp4", "audio/webm"]);
export type ReplyStart = { attemptId: string; revision: number; mime: string };
export type ReplyFrame = { type: "start"; value: ReplyStart } | { type: "audio"; bytes: Uint8Array } | { type: "complete" } | { type: "failed"; code: "speech_failed" };
const encoder = new TextEncoder();
export function replyFrame(frame: ReplyFrame): Uint8Array<ArrayBuffer> {
  const kind = frame.type === "start" ? 1 : frame.type === "audio" ? 2 : frame.type === "complete" ? 3 : 4;
  const payload = frame.type === "audio" ? frame.bytes : frame.type === "start" ? encoder.encode(JSON.stringify(frame.value)) : frame.type === "failed" ? encoder.encode(frame.code) : new Uint8Array();
  if (payload.length > MAX_REPLY_FRAME) throw new Error("speech_frame_size");
  const result = new Uint8Array(5 + payload.length); result[0] = kind;
  new DataView(result.buffer).setUint32(1, payload.length); result.set(payload, 5); return result;
}
/** Incremental bounded parser. No repeated concatenation when bytes arrive one at a time. */
export class ReplyFrameReader {
  private readonly header = new Uint8Array(5);
  private headerUsed = 0;
  private payload: Uint8Array | undefined;
  private payloadUsed = 0;
  private phase: "new" | "audio" | "complete" | "failed" = "new";
  private audioBytes = 0;
  private frames = 0;
  private readonly emit: (frame: ReplyFrame) => void;
  constructor(emit: (frame: ReplyFrame) => void) { this.emit = emit; }
  push(chunk: Uint8Array): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.phase === "complete" || this.phase === "failed") throw new Error("speech_after_terminal");
      if (!this.payload) {
        const count = Math.min(5 - this.headerUsed, chunk.length - offset);
        this.header.set(chunk.subarray(offset, offset + count), this.headerUsed); this.headerUsed += count; offset += count;
        if (this.headerUsed < 5) return;
        const size = new DataView(this.header.buffer).getUint32(1);
        if (size > MAX_REPLY_FRAME || ++this.frames > 4096 || this.header[0] < 1 || this.header[0] > 4) throw new Error("speech_frame_size");
        if (this.header[0] !== 2 && size > 1024) throw new Error("speech_metadata_size");
        this.payload = new Uint8Array(size); this.payloadUsed = 0;
      }
      const count = Math.min(this.payload.length - this.payloadUsed, chunk.length - offset);
      this.payload.set(chunk.subarray(offset, offset + count), this.payloadUsed); this.payloadUsed += count; offset += count;
      if (this.payloadUsed !== this.payload.length) return;
      const payload = this.payload, kind = this.header[0]; this.payload = undefined; this.headerUsed = 0;
      if (kind === 1) {
        if (this.phase !== "new") throw new Error("speech_duplicate_start");
        const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("speech_invalid_start");
        const row = value as Record<string, unknown>;
        if (Object.keys(row).sort().join(",") !== "attemptId,mime,revision" || typeof row.attemptId !== "string" || !/^[\w-]{1,128}$/.test(row.attemptId) || !Number.isSafeInteger(row.revision) || Number(row.revision) < 0 || typeof row.mime !== "string" || !AUDIO_MIMES.has(row.mime)) throw new Error("speech_invalid_start");
        this.phase = "audio"; this.emit({ type: "start", value: row as ReplyStart });
      } else if (kind === 2) {
        if (this.phase !== "audio" || !payload.length || (this.audioBytes += payload.length) > MAX_REPLY_AUDIO) throw new Error("speech_invalid_audio");
        this.emit({ type: "audio", bytes: payload });
      } else if (kind === 3) {
        if (this.phase !== "audio" || payload.length || !this.audioBytes) throw new Error("speech_invalid_complete");
        this.phase = "complete"; this.emit({ type: "complete" });
      } else {
        if (this.phase !== "audio" || new TextDecoder().decode(payload) !== "speech_failed") throw new Error("speech_invalid_failure");
        this.phase = "failed"; this.emit({ type: "failed", code: "speech_failed" });
      }
    }
  }
  finish(): void {
    if (this.phase !== "complete" || this.headerUsed || this.payload) throw new Error("speech_incomplete");
  }
}
