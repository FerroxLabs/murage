// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// secret-scan: fixture (fake addresses and fake tokens)
//
// Test support for the Keep/Remove client and screen: (1) the contract fixtures of MurageCloud's OWNER-VIEW-WIRE-CONTRACT (rounds 1 to 3,
// designs/r34-contract/owner-view-fixtures.json), copied verbatim until the server build emits real ones; (2) a fake of the owner routes
// that speaks the same shape: GET /api/email/status answers {rows}, every action POSTs to its action.path with {token?, target?}, a success
// is 200 with the fresh home view, a refusal throws as the app's `api` does (status and body {error, code, rowId?}). Tokens are minted
// only when a view is produced and every new view kills the old ones.
import type { Call } from "./email-keep-remove-client";
import { RECONFIRM_KEPT_LINE } from "./email-keep-remove";

/** MurageCloud's contract fixtures. The refusal is the corrected round 4 shape: refuse() sends {error: <owner line>, code, rowId?} and
 *  there is NO `message` field. */
export const CONTRACT_HOME_VIEW = {
  enabled: true, accountState: "active",
  rows: [
    { rowId: "bot:b1", section: "bot", botId: "b1", inboxId: "in_1", keyIds: ["k1"], target: "bot:b1", address: "ava@mail.example", botName: "Ava",
      line: "Ava has email at ava@mail.example.", actions: [{ kind: "remove", tokenId: "tok_b_1", enabled: true, path: "/api/email/bots/b1/remove" }] },
    { rowId: "parked:b2", section: "parked", botId: "b2", inboxId: "in_2", keyIds: ["k2"], target: "park:p2", address: "max@mail.example", botName: "Max",
      line: "This address came back with a restore. Keep it or remove it.", actions: [
        { kind: "keep", tokenId: "tok_p_2k", enabled: true, path: "/api/email/parked/b2/keep" },
        { kind: "remove", tokenId: "tok_p_2r", enabled: true, path: "/api/email/parked/b2/remove" }] },
    { rowId: "other_setup:in_9", section: "other_setup", botId: null, inboxId: "in_9", keyIds: [], target: "inbox:in_9", address: "old@mail.example", botName: null,
      line: "old@mail.example is set up on another install.", actions: [{ kind: "remove", tokenId: "tok_f_9", enabled: true, path: "/api/email/other-setups/in_9/remove" }] },
    { rowId: "restore_check:home", section: "restore_check", botId: null, inboxId: null, keyIds: [], target: null, address: null, botName: null,
      line: "Check your email setup after the restore.", actions: [{ kind: "confirm_inventory", tokenId: "tok_r_1", enabled: true, path: "/api/email/restore/confirm-inventory" }] },
  ],
};
export const CONTRACT_ACTION_SUCCESS = { enabled: true, accountState: "active", rows: [] };
export const CONTRACT_REFUSAL = { error: "A Keep is still finishing. Try again in a moment.", code: "keep_pending", rowId: "parked:b2" };

export type FakeKind = "keep" | "remove" | "try_again_now" | "confirm_inventory";
export interface FakeAction { kind: FakeKind; token?: boolean; enabled?: boolean; /** undefined: the section's contracted path; null: no path sent; a string: that path. */ path?: string | null }
export interface FakeRow {
  rowId?: string;
  section: "bot" | "parked" | "kept" | "key_only" | "other_setup" | "removing" | "restore_check" | "home";
  botId?: string; inboxId?: string; keyId?: string; /** undefined: the server default (a bot-owned row in any section: its own thread; parked, other-setup and restore rows: "email-owner"); null: the row carries none. */ threadId?: string | null;
  address?: string | null; botName?: string | null; line?: string; target?: string | null;
  /** A Remove ends skipped_in_use: the row stays and the server writes the reconfirm line. */
  inUse?: boolean;
  actions?: FakeAction[];
}
export interface Refusal { code: string; error?: string; status?: number; once?: boolean; thenRows?: FakeRow[]; rowId?: string }
export interface FakeSeed {
  rows?: FakeRow[];
  refuse?: Refusal;
  /** Every decision is refused restore_finishing with this server line (the server's restore window). */
  windowLine?: string;
  /** The next untokened bot-row Keep is refused confirm_expired (the binding changed), once. */
  bindingChanged?: boolean;
  /** The success answer of an action: the fresh home view, or only the bot's own view (no rows). */
  answer?: "home" | "bot";
}
export interface FakeCall { path: string; method: string; body: unknown; raw: string | undefined }

export const SERVER_LINE = `Server says <i>wait</i> a bit &amp; retry "now".  `;

const OWNER_THREAD_SECTIONS: ReadonlySet<FakeRow["section"]> = new Set(["parked", "other_setup", "restore_check"]);
const defaultActions = (row: FakeRow): FakeAction[] => {
  switch (row.section) {
    case "bot": return [{ kind: "keep", token: false }, { kind: "remove", token: true }];
    case "parked": case "key_only": return [{ kind: "keep", token: true }, { kind: "remove", token: true }];
    case "other_setup": return [{ kind: "remove", token: true }];
    case "restore_check": return [{ kind: "confirm_inventory", token: true }];
    case "removing": return [{ kind: "try_again_now", token: true }];
    default: return [];
  }
};
const familyOf = (section: FakeRow["section"]): string => (section === "parked" ? "parked" : section === "other_setup" ? "other-setups" : "bots");
const suffixOf = (kind: FakeKind): string => (kind === "try_again_now" ? "try-again" : kind);

export function createFakeServer(seed: FakeSeed = {}) {
  let rows = (seed.rows ?? []).map((row) => ({ ...row }));
  let refuse = seed.refuse ?? null;
  let bindingChanged = seed.bindingChanged === true;
  const calls: FakeCall[] = [];
  const live = new Map<string, { path: string; rowId: string }>();
  const issued: string[] = [];
  let minted = 0;
  let views = 0;
  const idOf = (row: FakeRow, index: number) => row.rowId ?? `${row.section}:${row.section === "key_only" ? row.keyId ?? index : row.botId ?? row.inboxId ?? row.keyId ?? index}`;
  const targetOf = (row: FakeRow) => (row.section === "other_setup" ? row.inboxId : row.botId ?? row.inboxId ?? row.keyId) ?? "";
  const homeView = () => {
    views += 1;
    live.clear();
    return {
      enabled: true, accountState: "active", limits: {}, removing: [],
      rows: rows.map((row, index) => {
        const rowId = idOf(row, index);
        const actions = (row.actions ?? defaultActions(row)).map((action) => {
          const path = action.path === undefined
            ? (action.kind === "confirm_inventory" ? "/api/email/restore/confirm-inventory" : `/api/email/${familyOf(row.section)}/${targetOf(row)}/${suffixOf(action.kind)}`)
            : action.path;
          let tokenId: string | null = null;
          if (action.token) { minted += 1; tokenId = `v1.${1_900_000_000_000 + minted}.hm${minted}-Zq_9`; live.set(tokenId, { path: path ?? "", rowId }); issued.push(tokenId); }
          return { kind: action.kind, tokenId, enabled: action.enabled !== false, ...(path === null ? {} : { path }) };
        });
        return {
          rowId, section: row.section, botId: row.botId ?? null, inboxId: row.inboxId ?? null, keyIds: row.keyId ? [row.keyId] : [],
          // The server fills every row: a bot-owned row (any section, removing included) carries that bot's own thread; parked, other-setup and restore rows have no bot, so "email-owner"; null leaves the row without one.
          threadId: row.threadId === null ? undefined : row.threadId ?? (row.botId && !OWNER_THREAD_SECTIONS.has(row.section) ? `thread-${row.botId}` : "email-owner"),
          target: row.target ?? null, address: row.address ?? null, botName: row.botName ?? null, line: row.line ?? "", actions,
        };
      }),
    };
  };
  const refuseWith = (status: number, code: string, error: string | undefined, rowId?: string): never => {
    const body: Record<string, unknown> = { code };
    if (error !== undefined) body.error = error;
    if (rowId !== undefined) body.rowId = rowId;
    throw Object.assign(new Error(error ?? code), { status, body });
  };
  const call: Call = async (path, init) => {
    const method = init?.method ?? "GET";
    const raw = typeof init?.body === "string" ? init.body : undefined;
    const body = raw === undefined ? undefined : JSON.parse(raw) as Record<string, unknown>;
    calls.push({ path, method, body, raw });
    if (path === "/api/email/status" && method === "GET") return homeView();
    const match = path.match(/^\/api\/email\/(?:(bots|parked|other-setups)\/([\w-]+)\/(keep|remove|try-again)|(restore)\/(confirm-inventory))$/);
    if (!match || method !== "POST") return refuseWith(404, "no_route", "No such route.");
    const family = match[1] ?? match[4]!, id = match[2] ?? "", suffix = match[3] ?? match[5]!;
    if (seed.windowLine !== undefined) return refuseWith(409, "restore_finishing", seed.windowLine);
    if (refuse) {
      const current = refuse;
      if (current.once) { refuse = null; if (current.thenRows) rows = current.thenRows.map((row) => ({ ...row })); }
      return refuseWith(current.status ?? 409, current.code, current.error, current.rowId);
    }
    const token = body?.token;
    if (suffix === "keep" && body && !("token" in body) && family === "bots" && bindingChanged) { bindingChanged = false; return refuseWith(409, "confirm_expired", undefined); }
    let index = -1;
    if (typeof token === "string") {
      const found = live.get(token);
      if (!found || found.path !== path) return refuseWith(409, "confirm_expired", "Look again, then choose.");
      index = rows.findIndex((row, at) => idOf(row, at) === found.rowId);
    } else {
      if (suffix === "remove") return refuseWith(409, "confirm_expired", "Look again, then choose.");
      index = rows.findIndex((row) => familyOf(row.section) === family && targetOf(row) === id);
    }
    if (family !== "restore" && index < 0) return refuseWith(404, "no_bot", "No such bot.");
    if (family === "restore") rows = rows.filter((row) => row.section !== "restore_check");
    else if (suffix === "keep") {
      const row = rows[index]!;
      rows[index] = row.section === "parked" ? { ...row, section: "kept", actions: [], line: "" } : { ...row, line: "" };
    } else if (suffix === "remove") {
      if (rows[index]!.inUse) rows[index] = { ...rows[index]!, line: RECONFIRM_KEPT_LINE };
      else rows = rows.filter((_, at) => at !== index);
    } else rows = rows.filter((_, at) => at !== index);
    if (seed.answer === "bot") return { botId: id, botName: "x", state: "active", address: null, chip: null, panelLine: null, failure: null, policy: "ask", policyPending: false, trusted: [], blocked: [], activity: [], waiting: 0, pauseReason: null };
    return homeView();
  };
  return { call, calls, issued, viewCount: () => views, posts: () => calls.filter((c) => c.method === "POST") };
}
