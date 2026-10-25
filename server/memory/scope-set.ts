// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// How a reader's scope list reaches the helper when it does not fit one message (1.0.4: an owner with more than 256 scopes had
// every semantic recall refused by the helper's schema and fell back to words only).
//
// The helper answers a search from the WHOLE scope list in one pass, exactly as before: ranks, resume cursors and counts are
// scope-set dependent, so the list is never split across searches and merged. Instead the list travels in bounded `scopes`
// messages ahead of the query, tagged with the query's request id, and the query names only how many ids to expect. The helper
// joins them under that request id and refuses the search unless the count matches. Only ids the main thread chose to send
// (the reader's own, already authorized) ever enter a request: the helper resolves nothing about audiences itself.
import type { Serializable } from "node:child_process";
import type { MemorySearchInput } from "./worker-protocol.ts";

/** Most ids in one `scopes` message, and most bytes of ids in one (whichever comes first). */
export const SCOPE_PART_IDS = 256;
export const SCOPE_PART_BYTES = 32 * 1024;
/** Longest scope id the helper accepts, and the most ids in one search. */
export const SCOPE_ID_MAX = 512;
export const SCOPE_SET_MAX = 200_000;
/** Searches whose scope parts the helper holds at once (matches its query queue). */
export const SCOPE_PENDING_MAX = 64;

/** Splits a scope list into messages of at most SCOPE_PART_IDS ids and SCOPE_PART_BYTES bytes, order kept. */
export function splitScopeIds(ids: readonly string[], maxIds = SCOPE_PART_IDS): string[][] {
  const parts: string[][] = [];
  let current: string[] = [], bytes = 0;
  for (const id of ids) {
    const size = Buffer.byteLength(id) + 4;
    if (current.length && (current.length >= maxIds || bytes + size > SCOPE_PART_BYTES)) { parts.push(current); current = []; bytes = 0; }
    current.push(id); bytes += size;
  }
  if (current.length) parts.push(current);
  return parts;
}

/** True when the list can ride inside the query message itself, as it always did. */
export function fitsInline(ids: readonly string[], maxIds = SCOPE_PART_IDS): boolean {
  if (ids.length > maxIds) return false;
  let bytes = 0;
  for (const id of ids) bytes += Buffer.byteLength(id) + 4;
  return bytes <= SCOPE_PART_BYTES;
}

/** Sends one search: inline when the scopes fit one message, else bounded `scopes` messages and then the query by count. */
export function sendSearch(send: (message: Serializable) => void, requestId: string, input: MemorySearchInput, maxIds = SCOPE_PART_IDS): void {
  if (fitsInline(input.scopeIds, maxIds)) { send({ type: "query", requestId, input }); return; }
  if (input.scopeIds.length > SCOPE_SET_MAX) throw new Error("MEMORY_SCOPE_SET_TOO_LARGE");
  for (const [part, ids] of splitScopeIds(input.scopeIds, maxIds).entries()) send({ type: "scopes", requestId, part, ids });
  send({ type: "query", requestId, input: { ...input, scopeIds: [], scopeCount: input.scopeIds.length } });
}

/** The helper's side: scope parts held per request until the query arrives. */
export class ScopeAssembler {
  private held = new Map<string, { parts: string[][]; total: number }>();
  add(requestId: string, part: number, ids: readonly string[]): void {
    let entry = this.held.get(requestId);
    if (!entry) {
      if (this.held.size >= SCOPE_PENDING_MAX) throw new Error("scope queue full");
      entry = { parts: [], total: 0 }; this.held.set(requestId, entry);
    }
    if (part !== entry.parts.length) { this.held.delete(requestId); throw new Error("scope part out of order"); }
    entry.total += ids.length;
    if (entry.total > SCOPE_SET_MAX) { this.held.delete(requestId); throw new Error("scope set too large"); }
    entry.parts.push([...ids]);
  }
  /** The query's full scope list, and the parts forgotten. A query that names no count has its scopes inline. */
  resolve(requestId: string, input: MemorySearchInput): MemorySearchInput {
    const count = input.scopeCount, entry = this.held.get(requestId);
    this.held.delete(requestId);
    if (count === undefined) { if (entry) throw new Error("scope parts without a count"); return input; }
    if (input.scopeIds.length) throw new Error("scopes both inline and by count");
    const ids = entry ? entry.parts.flat() : [];
    if (ids.length !== count) throw new Error("scope count mismatch");
    const { scopeCount: _count, ...rest } = input;
    return { ...rest, scopeIds: ids };
  }
  drop(requestId: string): void { this.held.delete(requestId); }
  get size(): number { return this.held.size; }
}
