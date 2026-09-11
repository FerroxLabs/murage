// Byte-bounded newline framing for engine stdout (audit A4).
//
// Every stdio engine (ACP, Claude stream-json, Codex app-server, Pi RPC)
// speaks one JSON frame per line into the shared server process. Collecting
// "everything until the next newline" without a bound lets one child that
// emits a huge frame, or never terminates one, grow the harness heap without
// limit before any JSON.parse or native-log cap can apply. This splitter
// bounds the bytes held for a single frame, decodes UTF-8 only for complete
// lines, and scans each chunk once, so framing stays linear in its input.
//
// An oversized frame is never truncated and parsed. It is reported once, and
// the splitter closes: nothing after a dropped frame is delivered, because a
// later terminal frame (a `result`, `turn/completed` or prompt response) could
// otherwise settle a turn whose content was lost as if it had succeeded. The
// driver fails that turn and stops that child; other turns are untouched.

/**
 * Largest single engine frame the harness accepts, in bytes, excluding the
 * newline. Chosen to carry an inline assistant image: saved images are capped
 * at 10 MiB (`IMAGE_MAX_BYTES` in server/attachments.ts), about 14 MiB as
 * base64, and a JSON envelope around it. It matches the MCP bridge and Pi MCP
 * extension frame limit (`MAX_BRIDGE_FRAME_BYTES`, 32 MiB).
 */
export const ENGINE_FRAME_MAX_BYTES = 32 * 1024 * 1024;

export interface FrameOverflow {
  /** Bytes of the offending frame seen so far (at least `limit + 1`). */
  bytes: number;
  limit: number;
  /** True when its newline was already in the input; false when the frame
   * was still open, which is reported at once rather than waiting for a
   * newline that may never come. */
  terminated: boolean;
}

export interface BoundedLineSplitter {
  /** Feed raw stdout bytes (or already-decoded text). No-op once closed. */
  push(chunk: Buffer | string): void;
  /** Stop framing and release buffered bytes. Later pushes are ignored. */
  close(): void;
  readonly closed: boolean;
  /** Bytes of the unterminated frame currently held. */
  readonly bufferedBytes: number;
}

const NEWLINE = 0x0a;

export function createBoundedLineSplitter(options: {
  onLine: (line: string) => void;
  onOverflow: (overflow: FrameOverflow) => void;
  maxBytes?: number;
}): BoundedLineSplitter {
  const maxBytes = options.maxBytes ?? ENGINE_FRAME_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("maxBytes must be a positive integer");
  let parts: Buffer[] = [];
  let pendingBytes = 0;
  let closed = false;

  const close = () => {
    closed = true;
    parts = [];
    pendingBytes = 0;
  };

  return {
    push(chunk) {
      if (closed) return;
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      // Frame first, deliver second: the framing state is final before any
      // handler runs, so a throwing handler cannot desynchronize it.
      const lines: string[] = [];
      let overflow: FrameOverflow | null = null;
      let start = 0;
      while (start <= bytes.length) {
        const newline = bytes.indexOf(NEWLINE, start);
        const end = newline === -1 ? bytes.length : newline;
        const frameBytes = pendingBytes + (end - start);
        if (frameBytes > maxBytes) {
          overflow = { bytes: frameBytes, limit: maxBytes, terminated: newline !== -1 };
          break;
        }
        if (newline === -1) {
          if (end > start) {
            parts.push(bytes.subarray(start));
            pendingBytes = frameBytes;
          }
          break;
        }
        const piece = bytes.subarray(start, newline);
        lines.push(
          parts.length ? Buffer.concat([...parts, piece], frameBytes).toString("utf8") : piece.toString("utf8"),
        );
        parts = [];
        pendingBytes = 0;
        start = newline + 1;
      }
      if (overflow) close();
      for (const line of lines) options.onLine(line);
      if (overflow) options.onOverflow(overflow);
    },
    close,
    get closed() {
      return closed;
    },
    get bufferedBytes() {
      return pendingBytes;
    },
  };
}

/** User-facing reason for a turn stopped by an oversized frame. */
export function frameOverflowMessage(engine: string, overflow: FrameOverflow): string {
  const limitMiB = Math.round(overflow.limit / (1024 * 1024));
  return `${engine} sent a protocol message larger than ${limitMiB} MiB, so Murage stopped this turn instead of reading it. Other conversations were not affected.`;
}

/** Turn stop reason for an oversized engine frame. */
export const FRAME_TOO_LARGE = "frame_too_large";
