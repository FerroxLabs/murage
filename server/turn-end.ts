// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { SEND_NOTICE_ENGLISH, type NativeTurnNoticeCode } from "../shared/send-notice.ts";

import { LEDGER_REFUSAL_LINE } from "./ledger-refusal-line.ts";
export { LEDGER_REFUSAL_LINE };
export const MCP_CLOUD_UNAVAILABLE_TEXT = "Add-on tools (MCP servers) are not available on Murage Cloud yet. They work in the desktop app.";
export const MCP_NOT_READY_TEXT = "I stopped this turn because an add-on tool (MCP server) did not finish starting. Your message was not sent.";

/** What the owner sees in place of engine text that breaks the copy rules. */
export const ENGINE_FALLBACK_TEXT = "The engine stopped this turn with an error. The details are in the logs.";
const BANNED_COPY: readonly RegExp[] = [/[\u2013\u2014]/, /\b(un)?saf(e|er|est|ely|ety)\b/i, /\bfree\b/i, /\bforge\b/i, /\bwill\s+fail\b/i];
/** The owner-copy rules: plain words, no dashes, none of the banned words. */
export const ownerCopyOk = (text: string): boolean => !BANNED_COPY.some(rule => rule.test(text));
/** Engine text is the least trusted line: it reaches the owner only when it passes the copy rules. */
export function ownerEngineText(text: string | undefined): string {
  if (!text) return ENGINE_FALLBACK_TEXT;
  if (ownerCopyOk(text)) return text;
  console.warn("[turn] engine-text-withheld");
  return ENGINE_FALLBACK_TEXT;
}

/** Fixed names only: they are the only strings the cell ever logs. */
export type TurnCause = "mcp-cloud-unavailable" | "mcp-not-ready" | "owner-stop";
export type TurnEnd =
  | { readonly kind: "silent" }
  | { readonly kind: "mcp-cloud" | "mcp-not-ready" | "ledger" | "engine"; readonly line: string }
  | { readonly kind: "notice"; readonly notice: NativeTurnNoticeCode; readonly line: string };
export interface TurnEndInput { readonly verdict?: unknown; readonly hostLine?: string; readonly engineText?: string }

/** The one place an owner refusal sentence is chosen. Pure; first match wins. */
export function selectTurnEnd(causes: readonly TurnCause[], notice: NativeTurnNoticeCode | undefined, input: TurnEndInput): TurnEnd {
  if (causes[0] === "owner-stop") return Object.freeze({ kind: "silent" });
  if (causes.includes("mcp-cloud-unavailable")) return Object.freeze({ kind: "mcp-cloud", line: MCP_CLOUD_UNAVAILABLE_TEXT });
  if (causes.includes("mcp-not-ready")) return Object.freeze({ kind: "mcp-not-ready", line: MCP_NOT_READY_TEXT });
  if (input.verdict !== undefined) {
    return notice ? Object.freeze({ kind: "notice", notice, line: SEND_NOTICE_ENGLISH[notice] }) : Object.freeze({ kind: "ledger", line: LEDGER_REFUSAL_LINE });
  }
  // Murage's own copy passes verbatim; engine text goes through the guard.
  if (input.hostLine) return Object.freeze({ kind: "engine", line: input.hostLine });
  return Object.freeze({ kind: "engine", line: ownerEngineText(input.engineText) });
}

/** One cell per admitted turn. Causes arrive in order; the first freeze is the result for good. */
export function createTurnEnd() {
  const causes: TurnCause[] = [];
  const seen = new Set<TurnCause>();
  let notice: NativeTurnNoticeCode | undefined;
  let frozen: TurnEnd | undefined;
  return Object.freeze({
    get frozen() { return frozen; },
    noteCause(cause: TurnCause): boolean {
      // The same cause can be noted at its origin and again where the turn refuses: one entry, one log line.
      if (seen.has(cause)) return !frozen;
      seen.add(cause);
      if (frozen) { console.warn(`[turn] late-cause=${cause} after=${frozen.kind}`); return false; }
      causes.push(cause);
      return true;
    },
    noteNotice(next: NativeTurnNoticeCode | undefined): void { if (!frozen) notice ??= next; },
    freeze(input: TurnEndInput): TurnEnd { return frozen ??= selectTurnEnd(causes, notice, input); },
  });
}
export type TurnEndCell = ReturnType<typeof createTurnEnd>;

/** The line a presenter stores for a refused turn. Silent (the owner's Stop) and engine (the engine's own line is already on the owner's screen) store none. */
export function storedRefusalLine(end: TurnEnd): string | undefined { return end.kind === "silent" || end.kind === "engine" ? undefined : end.line; }

/** What a driver puts on its own stream after a ledger refusal: the lease's frozen line, or undefined when the owner's Stop made it silent.
 * With no lease (a driver run directly) the ledger sentence stands. */
export function emitterRefusalLine(binding: { readonly turnEnd?: () => TurnEnd | undefined } | null | undefined): string | undefined {
  const end = binding?.turnEnd?.();
  if (!end) return LEDGER_REFUSAL_LINE;
  return storedRefusalLine(end);
}
