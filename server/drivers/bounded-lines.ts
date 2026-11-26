// Newline framing for engine stdout (audit A4).
//
// Every stdio engine (ACP, Claude stream-json, Codex app-server, Pi RPC)
// speaks one JSON frame per line into the shared server process. This
// splitter decodes UTF-8 only for complete lines and scans each chunk once,
// so framing stays linear in its input.
//
// MAIN-RULING cause22-no-transport-caps (1.0.21): engine frames have no size
// limit, as upstream OpenMaus (b8adcbd597). A frame is delivered whole however
// large it is; only a caller that passes its own `maxBytes` (a non-engine
// reader with its own limit) is told of an overflow, and the splitter then
// closes.
//
// 1.0.21 group B (cause22-eng-design3-fable/DESIGN.md A1-A3): a line is decoded
// as it arrives (one StringDecoder, slices of <= 1 MiB, `end()` at each newline)
// and counted in UTF-16 units, as `String.length` counts. A line of <= LIMIT
// units (the runtime's own string limit) is delivered whole and unchanged; a
// longer one is FITTED (fitJson: only its long strings are cut, its JSON shape
// and every key kept) and goes to `onFit`, never thrown, never closed for size.
// No `onFit`: that one line is dropped.

import { StringDecoder } from "node:string_decoder";
import { constants as bufferConstants } from "node:buffer";
import { fitJson, type JsonFitter } from "../owner-turn-caps.ts";

/** The longest string the runtime can hold, in UTF-16 units (536,870,888 on node 22): read from node, never assumed. */
export const LINE_UNIT_LIMIT = bufferConstants.MAX_STRING_LENGTH;
const SLICE_BYTES = 1024 * 1024;

export interface LineFit {
  /** UTF-16 units the whole line decoded to (more than `limit`). */
  units: number;
  limit: number;
}

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
  /** A caller's own frame limit in bytes; absent: no limit (every engine stdout). Needs `onOverflow`. */
  maxBytes?: number;
  onOverflow?: (overflow: FrameOverflow) => void;
  /** A line past the runtime's string limit, fitted (A3). Absent: such a line is dropped. */
  onFit?: (line: string, fit: LineFit) => void;
  /** Units a reader adds to each line (the Muse SDK's newline); the limit shrinks by it. Tests never set the limit itself. */
  room?: number;
}): BoundedLineSplitter {
  const limit = LINE_UNIT_LIMIT - (options.room ?? 0);
  const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
  if (options.maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1)) throw new RangeError("maxBytes must be a positive integer");
  if (options.maxBytes !== undefined && !options.onOverflow) throw new RangeError("maxBytes needs onOverflow");
  let pendingBytes = 0;
  let closed = false;
  // The open line: decoded pieces (never its bytes) and their units, or its fitter once it passed the limit.
  let decoder = new StringDecoder("utf8");
  let pieces: string[] = [];
  let units = 0;
  let fitter: JsonFitter | null = null;

  const close = () => {
    closed = true;
    pieces = [];
    units = 0;
    fitter = null;
    pendingBytes = 0;
    decoder = new StringDecoder("utf8");
  };
  const take = (text: string) => {
    if (!text) return;
    if (fitter) { fitter.write(text); units += text.length; return; }
    if (units + text.length > limit) {
      fitter = fitJson(limit);
      for (const piece of pieces) fitter.write(piece);
      pieces = [];
      fitter.write(text);
      units += text.length;
      return;
    }
    pieces.push(text);
    units += text.length;
  };
  const feed = (bytes: Buffer, from: number, to: number) => {
    for (let at = from; at < to; at += SLICE_BYTES) take(decoder.write(bytes.subarray(at, Math.min(to, at + SLICE_BYTES))));
  };

  return {
    push(chunk) {
      if (closed) return;
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      // Frame first, deliver second: the framing state is final before any
      // handler runs, so a throwing handler cannot desynchronize it.
      const lines: Array<{ line: string; fit?: LineFit }> = [];
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
        feed(bytes, start, end);
        if (newline === -1) {
          pendingBytes = frameBytes;
          break;
        }
        take(decoder.end());
        if (fitter) lines.push({ line: fitter.end(), fit: { units, limit } });
        else lines.push({ line: pieces.length === 1 ? pieces[0]! : pieces.join("") });
        pieces = [];
        units = 0;
        fitter = null;
        pendingBytes = 0;
        start = newline + 1;
      }
      if (overflow) close();
      for (const { line, fit } of lines) {
        if (!fit) options.onLine(line);
        else if (options.onFit) options.onFit(line, fit);
      }
      if (overflow) options.onOverflow!(overflow);
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

/** 1.0.21 group B (OPUS on cause22-eng-design3-fable, H1): a turn's reply text, appended chunk by chunk, stays below the string
 * limit with room to spare for whatever later joins it. Past that its head is kept, the marker added once, and `onCut` runs once
 * (the reader's existing mark): never a throw from the stdout listener, never a stop. */
export const TURN_TEXT_MAX = LINE_UNIT_LIMIT - 64 * 1024 * 1024;
export const TURN_TEXT_CUT_MARK = "\n…[cut: this reply passed the text limit (over 448 MiB)]";
export function appendTurnText(prev: string, delta: string, onCut?: () => void): string {
  if (prev.length + delta.length <= TURN_TEXT_MAX) return prev + delta;
  if (prev.endsWith(TURN_TEXT_CUT_MARK)) return prev;
  let head = delta.slice(0, Math.max(0, TURN_TEXT_MAX - prev.length));
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  onCut?.();
  return prev + head + TURN_TEXT_CUT_MARK;
}
