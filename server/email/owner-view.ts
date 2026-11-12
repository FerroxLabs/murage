// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Restore park, Batch B: the owner Keep/Remove view (OWNER-VIEW-WIRE-CONTRACT rounds 1 to 5, r3.1 sections 6 and 7). Tokens are minted ONLY here,
// by a view, for an enabled action on a row it shows, and bound to exactly what that row shows (target, inbox, keys, address, generation or park
// revision, action). The key is 32 random bytes held per process, so a restart expires every token (it fails toward parked).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { BindingRow } from "./email-store.ts";
import { EMAIL_OWNER_COPY, EMAIL_OWNER_PROOF_THREAD, type EmailOwnerRow, type EmailOwnerRowAction } from "../../shared/email-copy.ts";

/** One token key per email runtime (per process): a restart expires every outstanding token. Shared by the owner routes and the bot-delete confirmation. */
const TOKENS = new WeakMap<object, OwnerTokens>();
export const tokensFor = (runtime: object): OwnerTokens => { let t = TOKENS.get(runtime); if (!t) { t = new OwnerTokens(); TOKENS.set(runtime, t); } return t; };

export const OWNER_TOKEN_TTL_MS = 10 * 60_000;
export type TokenAct = "keep" | "remove" | "delete" | "confirm_inventory";
/** What a token is bound to. Anything left null is bound as null: a token for one row never fits another. */
export interface TokenScope {
  kind: "b" | "p" | "f" | "r" | "d"; act: TokenAct; botId: string | null; inboxId: string | null; parkId: string | null; parkRev: number | null;
  address: string | null; target: string | null; keyIds: string[]; generation: string | null;
}
const b64 = (buffer: Buffer) => buffer.toString("base64url");

export class OwnerTokens {
  private readonly secret = randomBytes(32);
  private readonly now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }
  private sign(scope: TokenScope, expiresAt: number): string {
    const s = { ...scope, address: scope.address === null ? null : scope.address.toLowerCase(), keyIds: [...scope.keyIds].sort() };
    return b64(createHmac("sha256", this.secret).update(JSON.stringify([s.kind, s.act, s.botId, s.inboxId, s.parkId, s.parkRev, s.address, s.target, s.keyIds, s.generation, expiresAt])).digest());
  }
  mint(scope: TokenScope, at: number = this.now()): string { const expiresAt = at + OWNER_TOKEN_TTL_MS; return `v1.${expiresAt}.${this.sign(scope, expiresAt)}`; }
  /** ok only for an unexpired token whose scope equals the FRESH scope the caller just read. */
  check(token: unknown, scope: TokenScope, at: number = this.now()): "ok" | "expired" {
    if (typeof token !== "string" || token.length > 300) return "expired";
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== "v1" || !/^\d{1,16}$/.test(parts[1]!)) return "expired";
    const expiresAt = Number(parts[1]);
    if (at > expiresAt) return "expired";
    const want = Buffer.from(this.sign(scope, expiresAt)), got = Buffer.from(parts[2]!);
    return want.length === got.length && timingSafeEqual(want, got) ? "ok" : "expired";
  }
}

// ---- the port to Batch A's park table, gate and resumer (defined here so this batch builds and tests alone; wired on merge) ----
export interface ParkRecord {
  botId: string; parkId: string; parkRev: number; address: string | null; inboxId: string | null; keyIds: string[];
  state: "parked" | "keep_pending" | "remove_authorized" | "key_release"; remoteDeleted: boolean;
}
export type PortResult = { ok: true } | { ok: false; status: number; code: string };
export interface ParkPort {
  list(): ParkRecord[];
  /** Durable Keep (4.1). */
  keep(botId: string, expect: { parkId: string; parkRev: number }): Promise<PortResult>;
  /** 4.3: authorize on the park, then continue the removal. `by` is the authorized_by column. */
  remove(botId: string, by: "bot_section" | "orphan", expect: { parkId: string; parkRev: number }): Promise<PortResult>;
}

// ---- route templates: the ONLY way a path is built (contract round 3) ----
const ID = /^[\w-]{1,160}$/;
export const PATH_TEMPLATES = {
  botKeep: (id: string) => `/api/email/bots/${id}/keep`, botRemove: (id: string) => `/api/email/bots/${id}/remove`, botTryAgain: (id: string) => `/api/email/bots/${id}/try-again`,
  parkedKeep: (id: string) => `/api/email/parked/${id}/keep`, parkedRemove: (id: string) => `/api/email/parked/${id}/remove`,
  otherRemove: (id: string) => `/api/email/other-setups/${id}/remove`, confirmInventory: () => "/api/email/restore/confirm-inventory",
} as const;
export const PATH_PATTERNS: RegExp[] = [
  /^\/api\/email\/bots\/[\w-]{1,160}\/(keep|remove|try-again)$/, /^\/api\/email\/parked\/[\w-]{1,160}\/(keep|remove)$/,
  /^\/api\/email\/other-setups\/[\w-]{1,160}\/remove$/, /^\/api\/email\/restore\/confirm-inventory$/,
];
export const safeId = (id: string): boolean => ID.test(id);

export interface ViewInput {
  tokens: OwnerTokens; at: number;
  bindings: BindingRow[];
  bot: (botId: string) => { id: string; name: string; threadId: string } | undefined;
  parks: ParkRecord[];
  otherSetups: Array<{ inboxId: string; address: string | null }>;
  restoreCheck: boolean;
}
const LIVE_ROW = new Set(["active", "paused", "grace", "billing_hold", "closing", "restored_unverified", "failed", "account_off", "provisioning"]);

/** The scope a bot-row Remove token is bound to; the route recomputes it from the fresh binding. */
export const botScope = (row: BindingRow, act: TokenAct): TokenScope => ({
  kind: "b", act, botId: row.botId, inboxId: row.inboxId, parkId: null, parkRev: null, address: row.address, target: botTarget(row),
  keyIds: row.emailKeyRef ? [row.emailKeyRef] : [], generation: `${row.opId ?? ""}:${row.inboxId ?? ""}:${row.emailKeyRef ?? ""}`,
});
export const botTarget = (row: Pick<BindingRow, "botId">): string => `bot:${row.botId}`;
export const parkScope = (park: ParkRecord, act: TokenAct): TokenScope => ({
  kind: "p", act, botId: park.botId, inboxId: park.inboxId, parkId: park.parkId, parkRev: park.parkRev, address: park.address, target: `park:${park.parkId}`, keyIds: park.keyIds, generation: null,
});
export const otherScope = (inboxId: string, address: string | null): TokenScope => ({
  kind: "f", act: "remove", botId: null, inboxId, parkId: null, parkRev: null, address, target: `inbox:${inboxId}`, keyIds: [], generation: null,
});
export const restoreScope = (): TokenScope => ({ kind: "r", act: "confirm_inventory", botId: null, inboxId: null, parkId: null, parkRev: null, address: null, target: null, keyIds: [], generation: null });
/** r3.1 section 6: the bot-delete confirmation, bound to bot, park generation and the address the owner saw. */
export const deleteScope = (park: ParkRecord): TokenScope => ({ ...parkScope(park, "delete"), kind: "d", target: null });

export function buildRows(input: ViewInput): EmailOwnerRow[] {
  const { tokens } = input, rows: EmailOwnerRow[] = [];
  const act = (kind: EmailOwnerRowAction["kind"], path: string, tokenId: string | null, enabled = true): EmailOwnerRowAction => ({ kind, tokenId, enabled, path });
  const parked = new Map(input.parks.map(p => [p.botId, p]));
  for (const row of input.bindings) {
    if (!safeId(row.botId)) continue;
    const bot = input.bot(row.botId);
    const park = parked.get(row.botId);
    if (row.state === "removing" || row.state === "remove_requested") {
      rows.push({ rowId: `removing:${row.botId}`, section: "removing", botId: row.botId, inboxId: row.inboxId, keyIds: row.emailKeyRef ? [row.emailKeyRef] : [], target: botTarget(row), line: EMAIL_OWNER_COPY.removingLine(row.address ?? "this address", row.state === "remove_requested" ? row.closingUntil : null),
        address: row.address, botName: bot?.name ?? null, threadId: bot?.threadId ?? EMAIL_OWNER_PROOF_THREAD, actions: [act("try_again_now", PATH_TEMPLATES.botTryAgain(row.botId), null)] });
      continue;
    }
    if (row.state === "removal_parked") {
      if (!park || park.state !== "parked") continue; // no park row: nothing the owner can decide yet
      rows.push({ rowId: `bot:${row.botId}`, section: "bot", botId: row.botId, inboxId: row.inboxId, keyIds: park.keyIds, target: `park:${park.parkId}`, line: EMAIL_OWNER_COPY.parkedLine(park.address ?? row.address ?? EMAIL_OWNER_COPY.parkedUnknownAddress),
        address: park.address ?? row.address, botName: bot?.name ?? null, threadId: bot?.threadId ?? EMAIL_OWNER_PROOF_THREAD,
        actions: [act("keep", PATH_TEMPLATES.botKeep(row.botId), null), act("remove", PATH_TEMPLATES.botRemove(row.botId), tokens.mint(parkScope(park, "remove"), input.at))] });
      continue;
    }
    if (!LIVE_ROW.has(row.state) || (!row.inboxId && !row.address)) continue;
    const address = row.address ?? EMAIL_OWNER_COPY.parkedUnknownAddress;
    rows.push({ rowId: `bot:${row.botId}`, section: "bot", botId: row.botId, inboxId: row.inboxId, keyIds: row.emailKeyRef ? [row.emailKeyRef] : [], target: botTarget(row),
      line: row.state === "closing" ? EMAIL_OWNER_COPY.closingLine(row.closingUntil) : `${bot?.name ?? "This bot"} has email at ${address}.`, address: row.address, botName: bot?.name ?? null, threadId: bot?.threadId ?? EMAIL_OWNER_PROOF_THREAD,
      actions: [...(row.state === "closing" ? [act("keep", PATH_TEMPLATES.botKeep(row.botId), null)] : []), act("remove", PATH_TEMPLATES.botRemove(row.botId), tokens.mint(botScope(row, "remove"), input.at))] });
  }
  for (const park of input.parks) {
    if (!safeId(park.botId) || input.bot(park.botId)) continue; // an orphan: its bot is gone (a live bot's own section owns its park)
    const known = park.address ?? null;
    const base = { rowId: `parked:${park.botId}`, section: "parked" as const, botId: park.botId, inboxId: park.inboxId, keyIds: park.keyIds, target: `park:${park.parkId}`, address: known, botName: null, threadId: EMAIL_OWNER_PROOF_THREAD };
    const line = park.state === "keep_pending" ? EMAIL_OWNER_COPY.keepingLine(known ?? EMAIL_OWNER_COPY.parkedUnknownAddress)
      : park.remoteDeleted ? EMAIL_OWNER_COPY.goneLine(known ?? EMAIL_OWNER_COPY.parkedUnknownAddress) : EMAIL_OWNER_COPY.parkedOrphanLine(known ?? EMAIL_OWNER_COPY.parkedUnknownAddress);
    if (park.state === "parked") {
      rows.push({ ...base, line, actions: [...(park.remoteDeleted ? [] : [act("keep", PATH_TEMPLATES.parkedKeep(park.botId), tokens.mint(parkScope(park, "keep"), input.at))]), act("remove", PATH_TEMPLATES.parkedRemove(park.botId), tokens.mint(parkScope(park, "remove"), input.at))] });
    } else rows.push({ ...base, line, actions: [] });
  }
  for (const other of input.otherSetups) {
    if (!safeId(other.inboxId)) continue;
    rows.push({ rowId: `other_setup:${other.inboxId}`, section: "other_setup", botId: null, inboxId: other.inboxId, keyIds: [], target: `inbox:${other.inboxId}`, address: other.address, botName: null, threadId: EMAIL_OWNER_PROOF_THREAD,
      line: `${other.address ?? EMAIL_OWNER_COPY.parkedUnknownAddress} is set up on another install.`, actions: [act("remove", PATH_TEMPLATES.otherRemove(other.inboxId), tokens.mint(otherScope(other.inboxId, other.address), input.at))] });
  }
  if (input.restoreCheck)
    rows.push({ rowId: "restore_check:home", section: "restore_check", botId: null, inboxId: null, keyIds: [], target: null, line: EMAIL_OWNER_COPY.restoreCheckLine, address: null, botName: null, threadId: EMAIL_OWNER_PROOF_THREAD,
      actions: [act("confirm_inventory", PATH_TEMPLATES.confirmInventory(), tokens.mint(restoreScope(), input.at))] });
  return rows;
}
