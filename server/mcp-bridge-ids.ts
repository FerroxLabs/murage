// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The id namespace of the MCP bridge (C11 design note 3.1, section 6).
//
// The child's answer carries only an id, so a bridge that passes the engine's ids on cannot tell an old duplicate
// from the answer to a new request that reused the id, and any memory of answered ids is either unbounded or forgets.
// So the bridge chooses the ids the child sees: every request it passes on carries "mb.<nonce>.<seq>", and an
// answer is delivered only through the handle of the live entry that issued that exact id.
//
// Pure: no process wiring, no I/O, so a unit test can drive it. Memory is one entry per live request and nothing else.
import type { McpRequest } from "./mcp-listed.ts";

/** At most this many requests wait at once (plus one tracked busy answer). */
export const MAX_BRIDGE_IN_FLIGHT = 4096;

/** open: issued, no answer yet. claimed: an answer was handed to the handle, its frame is not written yet.
 * revoked: a claimed answer that must not be written any more. An entry is deleted at "done" (settle). */
export type BridgeEntryState = "open" | "claimed" | "revoked";
export interface BridgeEntry {
  readonly seq: number;
  readonly bridgeId: string;
  /** The engine's id as the engine wrote it (raw JSON text), put back verbatim on the answer. */
  readonly engineIdRaw: string;
  readonly engineKey: string;
  readonly req: McpRequest;
  state: BridgeEntryState;
}

export type TakeResult =
  | { kind: "live"; entry: BridgeEntry }
  | { kind: "retired" }
  | { kind: "foreign"; collides: boolean };

export type IssueResult =
  | { admitted: true; bridgeId: string; entry: BridgeEntry }
  /** Refused at the cap: the entry is tracked (state "claimed") so the busy answer can be revoked like any other. */
  | { admitted: false; entry: BridgeEntry };

export interface BridgeIds {
  issue(engineKey: string, engineIdRaw: string, req: McpRequest): IssueResult;
  take(childId: unknown): TakeResult;
  settle(entry: BridgeEntry): void;
  cancelByEngine(engineKey: string): string | undefined;
  retire(bridgeId: string): void;
  liveCount(): number;
  /** The id key shared with the catalog observer: `${typeof id}:${id}`. */
  engineKeyOf(id: unknown): string | undefined;
}

export function bridgeBusyFrame(id: unknown, cap = MAX_BRIDGE_IN_FLIGHT): { jsonrpc: "2.0"; id: unknown; error: { code: number; message: string } } {
  return { jsonrpc: "2.0", id, error: { code: -32000, message: `This server already has ${cap.toLocaleString("en-US")} requests waiting. Try again in a moment.` } };
}

const engineKeyOf = (id: unknown): string | undefined => typeof id === "string" || typeof id === "number" ? `${typeof id}:${id}` : undefined;

export function createBridgeIds(options: {
  cap?: number;
  nonce?: string;
  /** An entry left without delivering an answer: cancelled (open), or revoked (claimed). Called once per entry. */
  onRetire?: (entry: BridgeEntry, how: "cancelled" | "revoked") => void;
  random?: () => string;
} = {}): BridgeIds {
  const cap = options.cap ?? MAX_BRIDGE_IN_FLIGHT;
  const nonce = options.nonce ?? (options.random ?? (() => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join("")))();
  const prefix = `mb.${nonce}.`;
  const live = new Map<number, BridgeEntry>();
  const byEngine = new Map<string, number>();
  let next = 1;

  const drop = (entry: BridgeEntry) => {
    if (live.get(entry.seq) === entry) live.delete(entry.seq);
    if (byEngine.get(entry.engineKey) === entry.seq) byEngine.delete(entry.engineKey);
  };
  /** Take an entry out of service without an answer. An open entry has its handle cancelled and leaves at once. A claimed
   * entry is revoked: it stays (its frame may be waiting on a publication) until settle. */
  const retireEntry = (entry: BridgeEntry): void => {
    if (entry.state === "open") {
      entry.req.cancel();
      drop(entry);
      options.onRetire?.(entry, "cancelled");
    } else if (entry.state === "claimed") {
      entry.state = "revoked";
      options.onRetire?.(entry, "revoked");
    }
  };
  const seqOf = (bridgeId: string): number | undefined => {
    const rest = bridgeId.slice(prefix.length);
    return /^[1-9]\d*$/.test(rest) && Number.isSafeInteger(Number(rest)) ? Number(rest) : undefined;
  };

  return {
    engineKeyOf,
    issue(engineKey, engineIdRaw, req) {
      const stale = byEngine.get(engineKey);
      if (stale !== undefined) {
        const old = live.get(stale);
        byEngine.delete(engineKey);
        if (old) retireEntry(old);
      }
      const seq = next++;
      const bridgeId = `${prefix}${seq}`;
      const refused = live.size >= cap;
      const entry: BridgeEntry = { seq, bridgeId, engineIdRaw, engineKey, req, state: refused ? "claimed" : "open" };
      live.set(seq, entry);
      byEngine.set(engineKey, seq);
      return refused ? { admitted: false, entry } : { admitted: true, bridgeId, entry };
    },
    take(childId) {
      if (typeof childId === "string" && childId.startsWith(prefix)) {
        const seq = seqOf(childId);
        const entry = seq === undefined ? undefined : live.get(seq);
        if (!entry || entry.state !== "open") return { kind: "retired" };
        entry.state = "claimed";
        return { kind: "live", entry };
      }
      const key = engineKeyOf(childId);
      return { kind: "foreign", collides: key !== undefined && byEngine.has(key) };
    },
    settle: drop,
    cancelByEngine(engineKey) {
      const seq = byEngine.get(engineKey);
      const entry = seq === undefined ? undefined : live.get(seq);
      if (!entry) return undefined;
      const wasOpen = entry.state === "open";
      retireEntry(entry);
      return wasOpen ? entry.bridgeId : undefined;
    },
    retire(bridgeId) {
      const seq = bridgeId.startsWith(prefix) ? seqOf(bridgeId) : undefined;
      const entry = seq === undefined ? undefined : live.get(seq);
      if (entry) retireEntry(entry);
    },
    liveCount: () => live.size,
  };
}

interface Member { key: string; start: number; end: number }

const WS = /[ \t\r\n]/;
const skipWs = (text: string, from: number): number => { let i = from; while (i < text.length && WS.test(text[i]!)) i++; return i; };
/** The index just past the string literal that starts at `from` (a quote), or -1. */
function stringEnd(text: string, from: number): number {
  for (let i = from + 1; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") { i++; continue; }
    if (c === '"') return i + 1;
  }
  return -1;
}
/** The index just past the JSON value that starts at `from`, or -1. Containers are matched, never parsed. */
function valueEnd(text: string, from: number): number {
  const c = text[from];
  if (c === '"') return stringEnd(text, from);
  if (c === "{" || c === "[") {
    let depth = 0;
    for (let i = from; i < text.length; i++) {
      const d = text[i];
      if (d === '"') { const end = stringEnd(text, i); if (end < 0) return -1; i = end - 1; continue; }
      if (d === "{" || d === "[") depth++;
      else if (d === "}" || d === "]") { depth--; if (depth === 0) return i + 1; }
    }
    return -1;
  }
  let i = from;
  while (i < text.length && !",}] \t\r\n".includes(text[i]!)) i++;
  return i === from ? -1 : i;
}
/** The top-level members of a JSON object text, with the span of each value; undefined when the text is not an object. */
function topLevelMembers(text: string): Member[] | undefined {
  let i = skipWs(text, 0);
  if (text[i] !== "{") return undefined;
  i = skipWs(text, i + 1);
  const members: Member[] = [];
  if (text[i] === "}") return members;
  for (;;) {
    if (text[i] !== '"') return undefined;
    const keyEnd = stringEnd(text, i);
    if (keyEnd < 0) return undefined;
    let key: unknown;
    try { key = JSON.parse(text.slice(i, keyEnd)); } catch { return undefined; }
    i = skipWs(text, keyEnd);
    if (text[i] !== ":") return undefined;
    i = skipWs(text, i + 1);
    const end = valueEnd(text, i);
    if (end < 0) return undefined;
    members.push({ key: key as string, start: i, end });
    i = skipWs(text, end);
    if (text[i] === ",") { i = skipWs(text, i + 1); continue; }
    return text[i] === "}" ? members : undefined;
  }
}

/** The raw JSON text of the top-level "id" member (the last one, as JSON.parse keeps), or undefined. */
export function topLevelIdText(line: string): string | undefined {
  const ids = topLevelMembers(line)?.filter((m) => m.key === "id");
  const last = ids?.at(-1);
  return last ? line.slice(last.start, last.end) : undefined;
}

/** Replace EVERY top-level "id" member's value with `idJson`, in place in the text (never parse then stringify), so
 * nothing but the id changes. Only a top-level member counts: params.id and result.id are untouched. Returns
 * undefined when the line is not a JSON object or has no top-level id. */
export function spliceTopLevelId(line: string, idJson: string): string | undefined {
  const ids = topLevelMembers(line)?.filter((m) => m.key === "id");
  if (!ids?.length) return undefined;
  let out = "", last = 0;
  for (const m of ids) { out += line.slice(last, m.start) + idJson; last = m.end; }
  return out + line.slice(last);
}
