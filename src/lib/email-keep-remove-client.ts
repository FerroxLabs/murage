// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The ONE module the Settings email Keep/Remove screen talks to, wired to the owner routes (restore-park r3.4b, MurageCloud
// OWNER-VIEW-WIRE-CONTRACT rounds 1 to 5; shared with the phone client, 9152c720b):
//   GET  /api/email/status                          the home view {rows: SurfaceRow[]}
//   POST <action.path>                              every action; the body is {token?, target?} and nothing else
// The contracted paths: /api/email/bots/:botId/(keep|remove|try-again), /api/email/parked/:botId/(keep|remove),
// /api/email/other-setups/:inboxId/remove, /api/email/restore/confirm-inventory. A success is 200 with the fresh home view; a refusal is
// the HTTP status with {error: <line>, code, rowId?}. The server owns every line. A token is minted only by a view and lives only as long
// as that view: nothing here caches or reuses one.
// Every field name the server's view uses is read in parseView and nowhere else. A path comes from the server, so it is validated
// (validEmailPath) before it is used; an action whose path fails is disabled and sends nothing.
import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import { ownerRouteLine, type EmailKeepRemoveProofAction } from "../../shared/email-copy.ts";

export type EmailSection = "bot" | "parked" | "kept" | "key_only" | "other_setup" | "removing" | "restore_check" | "home";
export type EmailActionKind = "keep" | "remove" | "try_again_now" | "confirm_inventory";
export interface RowAction {
  kind: EmailActionKind;
  tokenId: string | null;
  enabled: boolean;
  /** The server's path when it passed validation; null when absent or rejected. */
  path: string | null;
  /** "absent": no path was sent (the section's fallback applies). "rejected": a path was sent and failed validation (disabled, no request). */
  pathState: "ok" | "absent" | "rejected";
}
export interface EmailRow {
  /** The server's rowId: stable across reads, unique within a view. */
  id: string;
  section: EmailSection;
  botId: string | null;
  inboxId: string | null;
  keyIds: string[];
  /** The phone's step-up card needs the bot's thread; absent means the plain call. */
  threadId: string | null;
  /** Opaque, nullable, never parsed: sent back as `target` when present. */
  target: string | null;
  /** Shown as text only. */
  address: string | null;
  botName: string | null;
  /** The server's message for this row, verbatim. */
  line: string | null;
  actions: RowAction[];
}
export interface EmailKeepRemoveView { rows: EmailRow[] }
export type DecisionAnswer =
  /** `view` is the fresh home view when the answer carried a valid one, else null (the screen then reads the status again).
   *  `body` is that answer exactly as the server sent it (the full home view), for the screen to keep its other fields. */
  | { ok: true; view: EmailKeepRemoveView | null; body: unknown }
  | { ok: false; status: number | null; code: string; error: string | null; rowId: string | null };

export interface EmailKeepRemoveClient {
  view(): Promise<EmailKeepRemoveView>;
  act(row: EmailRow, kind: EmailActionKind): Promise<DecisionAnswer>;
}

export type Call = (path: string, init?: RequestInit) => Promise<unknown>;

/** The body is not a home view this app reads. Reported, never shown as an empty list. */
export class UnsupportedViewError extends Error {
  constructor(reason: string) { super(`unsupported email view: ${reason}`); this.name = "UnsupportedViewError"; }
}

const SECTIONS: readonly EmailSection[] = ["bot", "parked", "kept", "key_only", "other_setup", "removing", "restore_check", "home"];
const ACTION_KINDS: readonly EmailActionKind[] = ["keep", "remove", "try_again_now", "confirm_inventory"];
const rec = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/** An id segment, exactly the server router's own pattern. */
const ID = "[\\w-]{1,160}";
/** The contracted route templates, per action kind. */
const TEMPLATES: Record<EmailActionKind, RegExp> = {
  keep: new RegExp(`^/api/email/(?:bots|parked)/${ID}/keep$`),
  remove: new RegExp(`^/api/email/(?:bots|parked|other-setups)/${ID}/remove$`),
  try_again_now: new RegExp(`^/api/email/bots/${ID}/try-again$`),
  confirm_inventory: /^\/api\/email\/restore\/confirm-inventory$/,
};

/** Is this server-sent path safe to POST to, for this kind of action? Relative, under /api/email/, no scheme, host, `//`, `..`, `\`,
 *  `?`, `#`, `%` (so no encoded dot or slash), no whitespace or control character, and one of the contracted templates. */
export function validEmailPath(path: unknown, kind: EmailActionKind): path is string {
  if (typeof path !== "string" || !path.startsWith("/api/email/")) return false;
  if (path.includes("//") || path.includes("..") || /[\\?#%\s]/.test(path) || Array.from(path).some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)) return false;
  return TEMPLATES[kind].test(path);
}

function parseActions(value: unknown): RowAction[] {
  if (!Array.isArray(value)) return [];
  const actions: RowAction[] = [];
  for (const item of value) {
    const action = rec(item);
    const kind = ACTION_KINDS.find((known) => known === action.kind);
    if (!kind || actions.some((have) => have.kind === kind)) continue;
    const given = "path" in action && action.path !== undefined && action.path !== null;
    const ok = given && validEmailPath(action.path, kind);
    actions.push({ kind, tokenId: str(action.tokenId), enabled: action.enabled === true, path: ok ? action.path as string : null, pathState: !given ? "absent" : ok ? "ok" : "rejected" });
  }
  return actions;
}

/** A complete home view carries a rows array. */
export function isHomeView(body: unknown): boolean { return Array.isArray(rec(body).rows); }

/** The only place the server's view field names are read (r3.4 SurfaceRow). Throws UnsupportedViewError for anything that is not a
 *  complete home view, for a row with no rowId or a rowId used twice, or for an unknown section; it never returns an empty view for a
 *  shape it does not know. The top-level otherSetups array is a legacy fallback, read only when `rows` is absent. */
export function parseView(body: unknown): EmailKeepRemoveView {
  const view = rec(body);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new UnsupportedViewError("not an object");
  let items: unknown[];
  if (Array.isArray(view.rows)) items = view.rows;
  else if (Array.isArray(view.otherSetups)) {
    items = view.otherSetups.map((other) => ({ section: "other_setup", rowId: `other_setup:${String(rec(other).inboxId)}`, ...rec(other) }));
  } else throw new UnsupportedViewError("no rows");
  const seen = new Set<string>();
  const rows = items.map((item): EmailRow => {
    const row = rec(item);
    const section = SECTIONS.find((known) => known === row.section);
    if (!section) throw new UnsupportedViewError(`unknown section ${String(row.section)}`);
    const id = str(row.rowId);
    if (!id) throw new UnsupportedViewError("a row has no rowId");
    if (seen.has(id)) throw new UnsupportedViewError("a rowId is used twice");
    seen.add(id);
    return {
      id, section, botId: str(row.botId), inboxId: str(row.inboxId),
      keyIds: Array.isArray(row.keyIds) ? row.keyIds.filter((key): key is string => typeof key === "string") : [],
      threadId: str(row.threadId), target: str(row.target), address: str(row.address), botName: str(row.botName), line: str(row.line),
      actions: parseActions(row.actions),
    };
  });
  return { rows };
}

export const actionOf = (row: EmailRow, kind: EmailActionKind): RowAction | null => row.actions.find((action) => action.kind === kind) ?? null;
/** The server's home line(s): the "home" rows. */
export const homeLines = (view: EmailKeepRemoveView): string[] => view.rows.filter((row) => row.section === "home" && row.line !== null).map((row) => row.line!);
/** The restore result's kept addresses: the "kept" rows. */
export const keptAddresses = (view: EmailKeepRemoveView): string[] => view.rows.filter((row) => row.section === "kept" && row.address !== null).map((row) => row.address!);

/** The route a row's section implies, used ONLY when the server sent no path. Decided by section, never by which ids are present;
 *  an other_setup row goes by its inbox. A section or ids that fit no route give null. */
export function fallbackPath(row: EmailRow, kind: EmailActionKind): string | null {
  if (kind === "confirm_inventory") return row.section === "restore_check" ? "/api/email/restore/confirm-inventory" : null;
  let path: string | null = null;
  if (row.section === "other_setup") path = kind === "remove" && row.inboxId ? `/api/email/other-setups/${row.inboxId}/remove` : null;
  else if (row.section === "parked") path = row.botId && (kind === "keep" || kind === "remove") ? `/api/email/parked/${row.botId}/${kind}` : null;
  else if (row.section === "bot" || row.section === "kept" || row.section === "key_only" || (row.section === "removing" && kind === "try_again_now")) {
    path = row.botId ? `/api/email/bots/${row.botId}/${kind === "try_again_now" ? "try-again" : kind}` : null;
  }
  return path !== null && validEmailPath(path, kind) ? path : null;
}

/** The path an action will POST to: the server's validated path, else the section fallback only when none was sent. A rejected path
 *  has no fallback. */
export function pathFor(row: EmailRow, action: RowAction): string | null {
  if (action.pathState === "ok") return action.path;
  if (action.pathState === "rejected") return null;
  return fallbackPath(row, action.kind);
}

/** The body of every action: {token} (omitted when tokenId is null) plus {target} when the row has one. Nothing else. */
export function bodyFor(row: EmailRow, action: RowAction): Record<string, unknown> {
  return { ...(action.tokenId !== null ? { token: action.tokenId } : {}), ...(row.target !== null ? { target: row.target } : {}) };
}

/** The request an action makes: exact URL and JSON body, or null when it cannot be sent. A Remove still never goes without its token. */
export function requestFor(row: EmailRow, kind: EmailActionKind): { path: string; body: Record<string, unknown> } | null {
  const action = actionOf(row, kind);
  if (!action || !action.enabled) return null;
  if (kind === "remove" && action.tokenId === null) return null;
  const path = pathFor(row, action);
  return path === null ? null : { path, body: bodyFor(row, action) };
}
export const canAct = (row: EmailRow, kind: EmailActionKind): boolean => requestFor(row, kind) !== null;
/** True when the server sent a path for some action that failed validation: that action is disabled and the row says so. */
export const hasRejectedPath = (row: EmailRow): boolean => row.actions.some((action) => action.pathState === "rejected");

/** Which proof wrapper a validated owner path takes: bot keep/remove keep the original card (`bot`); every other route its own action. */
type ProofRoute = { id: string; bot: "keep" | "remove"; action?: never } | { id: string; bot?: never; action: EmailKeepRemoveProofAction };
function proofOf(path: string): ProofRoute | null {
  const match = path.match(/^\/api\/email\/(?:(bots|parked|other-setups)\/([\w-]+)\/(keep|remove|try-again)|restore\/(confirm-inventory))$/);
  if (!match) return null;
  if (match[4]) return { id: "restore", action: "confirm_inventory" };
  const [, family, id, verb] = match;
  if (family === "bots") return verb === "try-again" ? { id: id!, action: "try_again" } : { id: id!, bot: verb as "keep" | "remove" };
  if (family === "parked") return verb === "keep" || verb === "remove" ? { id: id!, action: verb === "keep" ? "parked_keep" : "parked_remove" } : null;
  return verb === "remove" ? { id: id!, action: "other_setup_remove" } : null;
}

/** The owner line for a refusal: the server's own `error` exactly as given (an empty string included); only a refusal that carried no
 *  string gets the shared line for its code (shared/email-copy.ts ownerRouteLine). */
export function refusalText(refusal: { code: string; error: string | null }): string {
  const english = ownerRouteLine(refusal.code);
  // the server's line is shown as given; the three park lines show in the app's language when the line is exactly the shared English
  if (refusal.error === null || refusal.error === english) {
    if (refusal.code === "inbox_gone") return t("emailPark.inboxGone");
    if (refusal.code === "keep_pending") return t("emailPark.keepPending");
    if (refusal.code === "other_setup_unavailable") return t("emailPark.otherSetupUnavailable");
  }
  return refusal.error !== null ? refusal.error : english;
}

function refusalOf(error: unknown): DecisionAnswer {
  const failure = rec(error), body = rec(failure.body);
  return {
    ok: false, status: typeof failure.status === "number" ? failure.status : null,
    code: typeof body.code === "string" && body.code !== "" ? body.code : "unknown",
    // The server's own line, exactly as given: never trimmed, never rewritten, never shown as markup. An empty string is a string.
    error: typeof body.error === "string" ? body.error : null,
    rowId: str(body.rowId),
  };
}

export function createHttpEmailKeepRemoveClient(call: Call = api): EmailKeepRemoveClient {
  return {
    async view() { return parseView(await call("/api/email/status")); },
    async act(row, kind) {
      const request = requestFor(row, kind);
      // An action that fits no valid route is an error state, not a guess: nothing is sent.
      if (!request) return { ok: false, status: null, code: "unsupported_route", error: null, rowId: null };
      try {
        let body: unknown;
        const proof = row.threadId ? proofOf(request.path) : null;
        if (row.threadId && proof) {
          // A phone's step-up on EVERY owner action POST (round 4): the existing fresh proof card over this exact act (it signs and
          // resumes the one request). A row with no thread cannot be signed for, so it is the plain call and the challenge is the refusal.
          const { emailOwnerAct, emailOwnerPost } = await import("./bot-email");
          body = proof.bot ? await emailOwnerAct(proof.id, row.threadId, proof.bot, request.body, call) : await emailOwnerPost(request.path, row.threadId, proof.action, proof.id, request.body, call);
        } else body = await call(request.path, { method: "POST", body: JSON.stringify(request.body) });
        if (!isHomeView(body)) return { ok: true, view: null, body };
        try { return { ok: true, view: parseView(body), body }; } catch { return { ok: true, view: null, body }; }
      } catch (error) { return refusalOf(error); }
    },
  };
}

export const defaultEmailKeepRemoveClient: EmailKeepRemoveClient = createHttpEmailKeepRemoveClient();
