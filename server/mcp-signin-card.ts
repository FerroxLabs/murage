// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// The words of the mid-turn sign-in card (spec MCP-LINK 3.12, 7.4). A link
// server's sign-in can end while a bot is working; the relay then asks the owner
// to sign in again in the conversation, and the turn stops. Kept out of
// index.ts so the copy and the key that makes the card once per turn are named,
// tested functions.
import { createHash } from "node:crypto";

/** What a phone or the browser door shows where the desktop shows a button. */
export const MCP_SIGNIN_PHONE_NOTE = "Finish sign-in on the computer running Murage.";

export interface McpSignInCardText {
  title: string;
  body: string;
  phone: string;
}

export function mcpSignInCardText(input: { name: string; host: string; botName: string }): McpSignInCardText {
  return {
    title: `Sign in to ${input.host}`,
    body: `${input.name} needs you to sign in again before ${input.botName} can use it.`,
    phone: MCP_SIGNIN_PHONE_NOTE,
  };
}

/** The tool result the engine reads: it ends the turn, because the resume is
 * the app's to do once the owner has signed in. */
export function mcpSignInToolText(name: string, host: string): string {
  return `${name} needs the owner to sign in to ${host} again. Murage showed them a sign-in card. End this turn now; the app will continue after sign-in.`;
}

/** One card per server per turn: the key is stable for a turn's generation and
 * differs between turns, and fits the same shape connector cards use. */
export function mcpSignInResumeKey(name: string, generation: string): string {
  const digest = createHash("sha256").update(`${name}\n${generation}`).digest("hex").slice(0, 24);
  return `mcp-${digest}`;
}

/** The relay codes that put a card in the conversation. */
export const MCP_SIGNIN_CARD_CODES: ReadonlySet<string> = new Set(["sign-in-ended", "needs-more-access"]);

export function mcpPromptAfterSignIn(name: string, host: string): string {
  return `Murage connection update: the owner signed in to ${host} again for ${name}. Continue the task that paused for this sign-in. Do not ask them to sign in again.`;
}

// ── what survives a restart ──────────────────────────────────────────────
// Nothing about a waiting card lives only in memory. Which cards still wait is
// read from the saved conversations, and a card is settled only by a sign-in
// that happened after it was posted: main hands the harness the token it holds
// at every start-up, and after a restart that is the very token the card was
// posted for.

const SCOPE_TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]+$/;

/** The most scopes, and the most characters, a merged scope list may hold. A
 * server that varies its 403 scopes must not grow the authorize URL without end. */
export const MAX_SCOPE_COUNT = 20;
export const MAX_SCOPE_CHARS = 1024;

/** Space-separated scopes merged in order, each once; malformed ones dropped;
 * at most MAX_SCOPE_COUNT scopes and MAX_SCOPE_CHARS characters (the first ones win). */
export function unionScopeText(...lists: Array<string | readonly string[] | undefined>): string {
  const out: string[] = [];
  let length = 0;
  for (const list of lists) {
    const items = typeof list === "string" ? list.split(/\s+/) : Array.isArray(list) ? list : [];
    for (const item of items) {
      if (!item || item.length > 200 || !SCOPE_TOKEN.test(item) || out.includes(item)) continue;
      if (out.length >= MAX_SCOPE_COUNT || length + item.length + (out.length ? 1 : 0) > MAX_SCOPE_CHARS) continue;
      length += item.length + (out.length ? 1 : 0);
      out.push(item);
    }
  }
  return out.join(" ");
}

export interface WaitingMcpSignInCard {
  threadId: string;
  messageId: string;
  /** When the card was posted (the message's own time). */
  at: number;
  botId?: string;
  reason: "sign-in-ended" | "needs-more-access";
  /** What a needs-more-access card asked for. */
  scope?: string;
  /** The origin of the server the card was posted for. */
  origin?: string;
}

/** The minimal database surface (node:sqlite's DatabaseSync fits). */
export interface CardDatabase {
  prepare(sql: string): { all(...params: Array<string | number | null>): unknown[] };
}

/** Every card for server `name` still waiting on a sign-in: not signed in, not
 * dismissed, not resumed. Read from the saved messages, so a restart loses none.
 * With `origin`, only cards posted for that origin: a different server added
 * later under the same name never inherits another server's cards. */
export function waitingMcpSignInCards(db: CardDatabase, name: string, origin?: string): WaitingMcpSignInCard[] {
  const rows = db.prepare(`SELECT thread_id, id, at, json FROM messages
    WHERE kind='mcpSignIn' AND role='bot' AND json_extract(json,'$.mcpSignIn.name')=?
      AND json_extract(json,'$.mcpSignIn.status')='required'
      AND COALESCE(json_extract(json,'$.mcpSignIn.dismissed'),0)=0
      AND COALESCE(json_extract(json,'$.mcpSignIn.resumed'),0)=0
    ORDER BY at, rowid`).all(name) as Array<{ thread_id: string; id: string; at: number; json: string }>;
  const out: WaitingMcpSignInCard[] = [];
  for (const row of rows) {
    let message: { from?: { botId?: unknown }; mcpSignIn?: { botId?: unknown; reason?: unknown; scope?: unknown; origin?: unknown } };
    try { message = JSON.parse(row.json); } catch { continue; }
    const card = message.mcpSignIn ?? {};
    const reason = card.reason === "needs-more-access" ? "needs-more-access" : "sign-in-ended";
    const botId = typeof card.botId === "string" ? card.botId : typeof message.from?.botId === "string" ? message.from.botId : undefined;
    const scope = typeof card.scope === "string" ? unionScopeText(card.scope) : "";
    const cardOrigin = typeof card.origin === "string" ? card.origin : undefined;
    if (origin !== undefined && cardOrigin !== origin) continue;
    out.push({ threadId: row.thread_id, messageId: row.id, at: Number(row.at), ...(botId ? { botId } : {}), reason, ...(scope ? { scope } : {}), ...(cardOrigin ? { origin: cardOrigin } : {}) });
  }
  return out;
}

/** The scopes a new sign-in must add for the cards that asked for more access. */
export function mcpStepUpScope(cards: readonly WaitingMcpSignInCard[]): string | undefined {
  const scope = unionScopeText(...cards.filter((card) => card.reason === "needs-more-access").map((card) => card.scope));
  return scope || undefined;
}

/**
 * True when the sign-in held now is a new one for this card: a token is held,
 * it was issued after the card was posted, it is not the token the card was
 * posted for (when this process still remembers that), and for a card that
 * asked for more access it carries that access. A token with no issue time is
 * not provably new, so it settles nothing.
 */
export function mcpSignInFresh(
  card: { at: number; reason: "sign-in-ended" | "needs-more-access"; scope?: string },
  held: { bearer?: string; issuedAt?: number; signedInAt?: number; scope?: string },
  rejectedBearer?: string,
): boolean {
  if (!held.bearer) return false;
  if (rejectedBearer !== undefined && held.bearer === rejectedBearer) return false;
  // Only an owner sign-in settles a card. A refresh renews issuedAt but never signedInAt.
  if (typeof held.signedInAt !== "number" || !(held.signedInAt > card.at)) return false;
  if (card.reason === "needs-more-access" && card.scope) {
    if (!held.scope) return false;
    const granted = new Set(held.scope.split(/\s+/));
    return card.scope.split(/\s+/).filter(Boolean).every((scope) => granted.has(scope));
  }
  return true;
}
