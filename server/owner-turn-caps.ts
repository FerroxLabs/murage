// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.21 cause22 caps (Sean, MAIN-RULING local-memory-budget: an owner turn is never stopped, refused or sealed by a size or memory
// cap). Owners: this module owns the one ceiling and the fixed lines; release-budget.ts owns who is the owner's turn (ownerKept);
// consuming-turn-ingress.ts ownerTurnBinding asks it in the server; proxy-turn-release.ts learns it in a spawned proxy from the
// release door's answer header below. It imports nothing: every spawned proxy loads it before it answers `initialize`.
//
// On an owner turn every size cap between the engine, the tool servers, the model service and Murage is a mark, not a stop:
//   size <= the old cap                 unchanged
//   old cap < size <= OWNER_ITEM_MAX    the item passes whole
//   one item > OWNER_ITEM_MAX           that one item is cut: its call gets one of the fixed lines below, the turn continues
// Every other turn keeps the old caps.

/** The one ceiling left on an owner turn: 64 MiB (67,108,864 bytes) for a single item (one frame, one event, one body, one line). */
export const OWNER_ITEM_MAX = 64 * 1024 * 1024;
/** A JSON-RPC frame carried inside a JSON string (a release envelope, the release door's body) can double when escaped. */
export const OWNER_ENVELOPE_MAX = OWNER_ITEM_MAX * 2 + 4096;
/** The release door (200 answers only) tells a spawned proxy that its turn is the owner's own: the value "1", nothing else. */
export const OWNER_TURN_HEADER = "x-murage-owner-turn";
/** The error code of a read the ceiling cut. Never a refusal: the one call fails, nothing is sealed. */
export const OVERSIZE_ITEM_CODE = "UPSTREAM_OVERSIZE_CUT";
export const OVERSIZE_RESULT_LINE = "This tool result was too large to pass on (over 64 MiB).";
export const OVERSIZE_CALL_LINE = "This tool call was too large to send (over 64 MiB).";
export const TOO_MANY_CALLS_LINE = "Too many tool calls are waiting at once. Try this one again in a moment.";
/** The permission proxy's deny notes for one ask whose answer (or whose own text) went over the ceiling. Never the broker-unavailable
 * note of permission-pipe.ts: the driver ends the turn on that one. */
export const OVERSIZE_PERMISSION_ANSWER_LINE = "Murage: the answer to this request was too large to pass on (over 64 MiB), so skip this action";
export const OVERSIZE_PERMISSION_ASK_LINE = "Murage: this request was too large to ask about (over 64 MiB), so skip this action";
/** MAIN-RULING cause22-OPEN-2: one mount sent more frames on the owner's turn than the frame count (chat-mcp-client.ts
 * CHAT_MCP_MAX_FRAMES, 10,000). Each frame past it fails as one item: a reply becomes this error for its own call, a server request is
 * answered with it, a notification is dropped. The turn, the child and the transport live. */
export const TOO_MANY_FRAMES_LINE = "This tool server sent too many messages on this turn (over 10000), so this result was dropped.";
/** 1.0.21 group B: the owner is told once per turn that one engine line passed the string limit and its long parts were cut. */
/** 1.0.21 group B (design3-fable B R1): the deny a request to us gets when its line passed the string limit and was fitted. */
export const OVERSIZE_FITTED_ASK_LINE = "Murage: this request was too large to ask about (over 512 MiB of text), so skip this action";
export const LINE_FITTED_NOTICE = "One engine message was too large to hold (over 512 MiB of text). Its long parts were cut.";
export const OVERSIZE_ENGINE_FRAME_LINE = "One engine message was too large to read (over 64 MiB) and was skipped.";

/** The cap of one item on this turn: the old cap, or the ceiling on the owner's own turn. */
export function itemCap(owner: boolean, cap: number): number { return owner ? Math.max(cap, OWNER_ITEM_MAX) : cap; }

/** The fixed, content-free answer for the one call whose item was cut. */
export function oversizeItemError(id: string | number, line: string = OVERSIZE_RESULT_LINE) {
  return { jsonrpc: "2.0", id, error: { code: -32000, message: line } } as const;
}
export function oversizeCut(line: string = OVERSIZE_RESULT_LINE): Error & { code: string } {
  return Object.assign(new Error(line), { code: OVERSIZE_ITEM_CODE });
}
export function isOversizeCut(error: unknown): boolean { return (error as { code?: unknown } | null | undefined)?.code === OVERSIZE_ITEM_CODE; }
/** 1.0.21 cause22-one-rule, response side: the answer owed to the one call whose upstream answer the owner ceiling cut (`error` is an
 * oversizeCut on the owner's own turn). Undefined for any other failure, which keeps its old handling. */
export function isOwnerCut(error: unknown, owner: boolean): boolean { return owner && isOversizeCut(error); }
export function cutCallAnswer(error: unknown, owner: boolean, id: string | number) { return isOwnerCut(error, owner) ? oversizeItemError(id) : undefined; }

/** How much of a cut line's start and end is kept to name the call it belongs to; everything between is discarded as it arrives. */
export const SNIFF_BYTES = 64 * 1024;
/** The id of a JSON-RPC line that was never kept whole, read from its first bytes (`head`) or, when the frame carries its id after its
 * params or result (the MCP TypeScript SDK writes `{ method, params, jsonrpc, id }` and `{ result, jsonrpc, id }`), from its last bytes
 * (`tail`: the id is then followed only by plain members, such as `"jsonrpc":"2.0"`, before the closing brace). A string id must be short and plain. Undefined when it cannot
 * be read: the caller then answers the only call in flight, or nothing. */
export function sniffRpcId(head: string, tail = ""): string | number | undefined {
  const match = /^\s*\{[^{}\[\]]*?"id"\s*:\s*(?:(-?\d{1,15})(?=\s*[,}])|"([^"\\]{1,128})")/.exec(head)
    ?? /[,{]\s*"id"\s*:\s*(?:(-?\d{1,15})|"([^"\\]{1,128})")(?:\s*,\s*"[^"\\]{1,64}"\s*:\s*(?:"[^"\\]{0,256}"|-?\d[\d.eE+-]{0,30}|true|false|null))*\s*\}\s*$/.exec(tail);
  if (!match) return undefined;
  return match[1] !== undefined ? Number(match[1]) : match[2];
}
/** True when a line read by its first and last bytes is a request (it names a method at its top level), not a reply. */
export function sniffRpcCall(head: string, tail = ""): boolean {
  return /^\s*\{[^{}\[\]]*?"method"\s*:/.test(head) || /[,{]\s*"method"\s*:\s*"[^"\\]{1,256}"\s*(?:,\s*"(?:jsonrpc|id)"\s*:\s*(?:"[^"\\]{0,128}"|-?\d{1,15})\s*){0,2}\}\s*$/.test(tail);
}
/** The first `SNIFF_BYTES` of a line held as parts (plus the part now arriving), without copying the rest. */
export function headOf(parts: readonly Uint8Array[], next: Uint8Array): string {
  const kept: Uint8Array[] = []; let size = 0;
  for (const part of [...parts, next]) { if (size >= SNIFF_BYTES) break; const piece = part.subarray(0, SNIFF_BYTES - size); kept.push(piece); size += piece.length; }
  return Buffer.concat(kept, size).toString("utf8");
}
/** The last `SNIFF_BYTES` seen of a line being discarded: what was kept so far plus the bytes now arriving. */
export function tailOf(kept: Uint8Array, next: Uint8Array): Buffer {
  if (next.length >= SNIFF_BYTES) return Buffer.from(next.subarray(next.length - SNIFF_BYTES));
  const joined = Buffer.concat([kept, next]);
  return joined.length > SNIFF_BYTES ? joined.subarray(joined.length - SNIFF_BYTES) : joined;
}

/** 1.0.21 cause22-one-rule: one JSON-RPC line a line cap cut, read from its first and last bytes (createLineSplitter onCut). */
export interface LineCut { bytes: number; limit: number; id: string | number | undefined; call: boolean }
export function lineCut(head: string, tail: string, bytes: number, limit: number): LineCut {
  return { bytes, limit, id: sniffRpcId(head, tail), call: sniffRpcCall(head, tail) };
}
const capText = (bytes: number) => bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MiB` : `${Math.round(bytes / 1024)} KiB`;
/** The one answer a cut line is owed, naming the cap: a request (`call`) gets "this tool call was too large to send"; a reply gets "this
 * tool result was too large to pass on", addressed to the request it answers. Undefined when the line names no id it can be read by (a
 * notification, or an unreadable id): nothing is waiting on it, so the caller only logs it. */
export function lineCutAnswer(cut: LineCut): string | undefined {
  if (cut.id === undefined) return undefined;
  const line = cut.call ? `This tool call was too large to send (over ${capText(cut.limit)}).` : `This tool result was too large to pass on (over ${capText(cut.limit)}).`;
  return JSON.stringify(oversizeItemError(cut.id, line));
}

/** 1.0.21 group B (cause22-eng-design3-fable/DESIGN.md A4): the text a line past the runtime's string limit is FITTED to. One pass,
 * constant state (in-string, escape, a type stack of 64, kept units): F1 a string keeps its first 1 MiB of units, then a visible
 * marker, never splitting an escape or a surrogate pair; F2 a bare token keeps 4,096 units, whitespace outside strings is dropped;
 * F3 a container deeper than 64 becomes the marker string; F4 once kept >= limit/2, at the next comma every container below the top
 * level is closed and the rest of that top-level value skipped (later top-level containers are copied as {} / []); F5 once kept >=
 * limit - 4 MiB at a top-level comma, the top level is closed and the rest skipped. Valid JSON in, valid JSON out, every top-level key
 * kept; any other bytes pass through the same rules (the reader's parse error path takes them). The output never passes `limit`. */
export interface JsonFitter { write(text: string): void; end(): string; readonly kept: number }
export const FIT_STRING_KEEP = 1024 * 1024;
export const FIT_TOKEN_KEEP = 4096;
export const FIT_DEPTH_MAX = 64;
export const FIT_DEEP_MARKER = "\"…[cut: nested too deep]\"";
export function fitJson(limit: number, opts: { stringKeep?: number; tokenKeep?: number; margin?: number } = {}): JsonFitter {
  const stringKeep = opts.stringKeep ?? FIT_STRING_KEEP;
  const tokenKeep = opts.tokenKeep ?? FIT_TOKEN_KEEP;
  const margin = opts.margin ?? 4 * 1024 * 1024;
  // Output is held in pieces of about 64 Ki units (a line of one-unit members never holds one array slot per unit). A hard bound
  // backs F4/F5: whatever the input (non-JSON separators outside any container included), nothing is kept past limit - margin / 2;
  // the rest of the line is skipped, so the output never passes `limit`.
  const out: string[] = [];
  let parts: string[] = []; // the newest output, flattened into `out` every 4,096 parts (never a rope of one node per unit)
  let kept = 0;
  const hard = limit - Math.floor(margin / 2);
  const flushParts = () => { if (parts.length) { out.push(parts.join("")); parts = []; } };
  const emit = (s: string) => {
    if (!s) return;
    if (kept + s.length > hard) { skip = -1; return; }
    parts.push(s); kept += s.length;
    if (parts.length >= 4096) flushParts();
  };
  const stack: number[] = []; // 0x7b '{' or 0x5b '['
  let inStr = false; let esc = 0; let strBuf = ""; let strKept = 0; let strCut = 0;
  let tok = 0; let tokCut = 0; let tokBuf = "";
  // Skipping: the input is read for nesting and strings only, nothing is emitted, until `skip` input closers are consumed (-1: all).
  let skip = 0; let skipStr = false; let skipEsc = false;
  const flushTok = () => { if (tok) { emit(tokBuf + (tokCut ? `…[cut ${tokCut} units]` : "")); tokBuf = ""; tok = 0; tokCut = 0; } };
  const flushStr = () => { if (strBuf) { emit(strBuf); strBuf = ""; } };
  const write = (text: string) => {
    let i = 0;
    const n = text.length;
    while (i < n) {
      if (skip !== 0) {
        for (; i < n; i++) {
          const c = text.charCodeAt(i);
          if (skipStr) { if (skipEsc) skipEsc = false; else if (c === 0x5c) skipEsc = true; else if (c === 0x22) skipStr = false; continue; }
          if (c === 0x22) skipStr = true;
          else if (c === 0x7b || c === 0x5b) { if (skip > 0) skip++; }
          else if ((c === 0x7d || c === 0x5d) && skip > 0) { skip--; if (skip === 0) { i++; break; } }
        }
        continue;
      }
      if (inStr) {
        // Copy a run of plain units at once, keeping the first `stringKeep` of them.
        let j = i;
        if (strCut === 0) for (; j < n; j++) {
          const c = text.charCodeAt(j);
          if (esc !== 0) { if (esc === -1) esc = c === 0x75 ? 4 : 0; else esc--; strKept++; continue; }
          if (c === 0x5c) { if (strKept >= stringKeep) break; esc = -1; strKept++; continue; }
          if (c === 0x22) break;
          if (strKept >= stringKeep) break;
          strKept++;
        }
        strBuf += text.slice(i, j);
        if (j >= n) { flushStr(); i = j; continue; }
        const c = text.charCodeAt(j);
        if (c === 0x22 && esc === 0) {
          flushStr();
          if (strCut) {
            // Never leave half a surrogate pair at the cut.
            flushParts();
            const last = out.length ? out[out.length - 1]! : "";
            const code = last.charCodeAt(last.length - 1);
            if (code >= 0xd800 && code <= 0xdbff) { out[out.length - 1] = last.slice(0, -1); kept--; strCut++; }
            emit(` …[cut ${strCut} units]`);
          }
          emit("\""); inStr = false; strKept = 0; strCut = 0; esc = 0; i = j + 1; continue;
        }
        // Past the keep: count until the closing quote (escapes are skipped whole).
        flushStr();
        let k = j;
        for (; k < n; k++) {
          const d = text.charCodeAt(k);
          if (esc !== 0) { if (esc === -1) esc = d === 0x75 ? 4 : 0; else esc--; strCut++; continue; }
          if (d === 0x5c) { esc = -1; strCut++; continue; }
          if (d === 0x22) break;
          strCut++;
        }
        i = k;
        continue;
      }
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) { flushTok(); i++; continue; }
      if (c === 0x22) {
        flushTok();
        emit("\""); inStr = true; strKept = 0; strCut = 0; esc = 0; i++; continue;
      }
      if (c === 0x7b || c === 0x5b) {
        flushTok();
        if (stack.length >= FIT_DEPTH_MAX) { emit(FIT_DEEP_MARKER); skip = 1; i++; continue; }
        if (stack.length === 1 && kept >= limit / 2) { emit(c === 0x7b ? "{}" : "[]"); skip = 1; i++; continue; }
        stack.push(c); emit(text[i]!); i++; continue;
      }
      if (c === 0x7d || c === 0x5d) { flushTok(); stack.pop(); emit(text[i]!); i++; continue; }
      if (c === 0x2c) {
        flushTok();
        if (stack.length === 1 && kept >= limit - margin) {
          emit(stack[0] === 0x7b ? "}" : "]"); stack.pop(); skip = -1; i++; continue;
        }
        if (stack.length >= 2 && kept >= limit / 2) {
          const open = stack.length - 1;
          while (stack.length > 1) emit(stack.pop() === 0x7b ? "}" : "]");
          skip = open; i++; continue;
        }
        emit(","); i++; continue;
      }
      if (c === 0x3a) { flushTok(); emit(":"); i++; continue; }
      // A bare token (number, true/false/null, or any other byte).
      if (tok < tokenKeep) { tokBuf += text[i]; } else tokCut++;
      tok++; i++;
    }
  };
  return {
    write,
    end() {
      flushTok(); flushStr();
      if (inStr && strCut) emit(` …[cut ${strCut} units]`);
      flushParts();
      const result = out.join("");
      out.length = 0;
      return result;
    },
    get kept() { return kept; },
  };
}
