// SPDX-License-Identifier: AGPL-3.0-or-later
// S5-DATADIR-PATHS r4.1 DR7: the owner confirms a linked data root that now points somewhere else (Settings > Data folder), and reads
// the roots' states for that row. Fail-closed gate (Astra r4 M4): the owner's own computer only (isOwnersComputer: the local desktop app
// with its renderer secret proven, false on a Cloud home). Every other caller gets 404 with no body, like the other owner routes.
import type { IncomingHttpHeaders } from "node:http";
import { isOwnersComputer } from "./cloud-owner-surface.ts";
import { DATA_ROOT_NAMES, type DataRoots, type RootName, type RootState } from "./data-roots.ts";

export const DATA_DIR_ROOTS_ROUTE = "/api/data-dir/roots";
export const DATA_DIR_CONFIRM_ROUTE = "/api/data-dir/confirm-root";

export interface DataRootRow { name: RootName; state: RootState; candidate?: string }
export interface DataDirAnswer { status: 200 | 400 | 404 | 409 | 415; body?: unknown }

/** The DR7 gate. Narrower than requestFromComputer / isDesktopApp on purpose. */
export const dataDirRequestAllowed = (headers: IncomingHttpHeaders, query?: URLSearchParams | null): boolean => isOwnersComputer(headers, query);

/** GET rows: every root with its state; candidate (the current canonical target) only in state "changed" (Astra r4 L1). */
export function dataRootRows(roots: DataRoots): DataRootRow[] {
  return DATA_ROOT_NAMES.map((name) => {
    const state = roots.status(name);
    const candidate = state === "changed" ? roots.candidate(name) : undefined;
    return candidate ? { name, state, candidate } : { name, state };
  });
}

export interface DataDirRequest { method: string; path: string; allowed: boolean; contentType?: string; body?: unknown }

/** One answer per DR7 request. A denied caller is answered before anything is read or recorded. */
export function answerDataDirRoute(request: DataDirRequest, roots: () => DataRoots): DataDirAnswer {
  if (!request.allowed) return { status: 404 };
  if (request.path === DATA_DIR_ROOTS_ROUTE && request.method === "GET") return { status: 200, body: dataRootRows(roots()) };
  if (request.path === DATA_DIR_CONFIRM_ROUTE && request.method === "POST") {
    if (!String(request.contentType ?? "").toLowerCase().startsWith("application/json")) return { status: 415, body: { error: "JSON required" } };
    const body = request.body;
    const keys = body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body) : [];
    const name = keys.length === 1 && keys[0] === "name" ? (body as { name?: unknown }).name : undefined;
    if (!(DATA_ROOT_NAMES as readonly unknown[]).includes(name)) return { status: 400, body: { error: "name must be workspaces or providers" } };
    // allowed only in state "changed"; re-runs the whole of DR2 (data-roots.ts confirm). 409 otherwise, nothing recorded.
    const result = roots().confirm(name as RootName);
    return { status: result.status, body: result.restart ? { state: result.state, restart: true } : { state: result.state } };
  }
  return { status: 404 };
}
