// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DelegationPack } from "./delegation-pack/types.ts";

/** @delegation-pack owner-route Lets only the authenticated owner inspect prepared chat lines. */
export const DELEGATION_PACK_ROUTE = "/api/delegation-packs/:packId";

/** @delegation-pack prompt-part Declares the fenced recent-chat prompt kind for L5b-3 integration. */
export const DELEGATION_PACK_PROMPT_KIND = "delegation-context";

export interface DelegationPackRequest { method: string; path: string }
export interface DelegationPackRouteHost {
  /** Server-owned request closure: desktop proof or ownerActs, never a body field or loopback alone.
   * L5b-3 mounts the route behind the outer HTTP authentication and supplies this proof. */
  isOwnerRequest(): boolean;
  getPack(id: string): DelegationPack | undefined;
  /** Current forgottenMessageSources for these source pairs; throw when the state is unknown. */
  forgottenIds(threadId: string, ids: readonly string[]): ReadonlySet<string>;
  /** Read one source pair through the owner's reader, never a bot reader or a stored text snapshot. */
  readOwnerRow(threadId: string, id: string): {
    id: string; threadId: string; author: string; text: string; withheldFromBots?: string;
  } | undefined;
}

export type PreparedPackRow =
  | { id: string; state: "text"; author: string; text: string }
  | { id: string; state: "forgotten" | "unavailable" };
export interface DelegationPackAnswer {
  status: 200 | 404 | 503;
  headers: { "Cache-Control": "no-store" };
  body?: { rows: PreparedPackRow[] };
}

/** Standalone handler for L5b-3 to mount. All reads are synchronous, with no authority or forget cache.
 * prepared means the pack guard passed; a later submission check may still have refused the write. */
export function answerDelegationPackRoute(request: DelegationPackRequest, host: DelegationPackRouteHost): DelegationPackAnswer {
  const headers = { "Cache-Control": "no-store" } as const;
  if (!host.isOwnerRequest()) return { status: 404, headers };
  const match = /^\/api\/delegation-packs\/([A-Za-z0-9_-]+)$/.exec(request.path);
  if (request.method !== "GET" || !match) return { status: 404, headers };
  try {
    const pack = host.getPack(match[1]);
    if (!pack || pack.id !== match[1]) return { status: 404, headers };
    // Do not fall back to refs: enqueue candidates say nothing about preparation.
    const ids = [...new Set(pack.prepared)];
    const forgotten = ids.length ? host.forgottenIds(pack.source_thread_id, ids) : new Set<string>();
    const rows: PreparedPackRow[] = ids.map(id => {
      if (forgotten.has(id)) return { id, state: "forgotten" };
      const row = host.readOwnerRow(pack.source_thread_id, id);
      if (!row || row.id !== id || row.threadId !== pack.source_thread_id) return { id, state: "unavailable" };
      if (row.withheldFromBots === "forgotten") return { id, state: "forgotten" };
      return { id, state: "text", author: row.author, text: row.text };
    });
    return { status: 200, headers, body: { rows } };
  } catch {
    // Unknown forget or reader state cannot turn into source words or an empty preparation receipt.
    return { status: 503, headers };
  }
}
