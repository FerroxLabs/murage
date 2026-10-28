// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bot calls (design BOT-CALLS-109 rev 4.2, 4.4; BOT-CALLS-109-FREEBUSY rev 1): the live free/busy read behind
// DecideWorld.calendar. One live inventory read and one free/busy query per ACTIVE googlecalendar account, through the same
// in-process relay the bot's MCP bridge reaches, in a scope no bot can reach. Only free | busy | unsure | none leaves this
// module; nothing of the reply is kept or logged. Every answer that is not clean and live is `unsure`.
import { randomUUID } from "node:crypto";
import type { InventoryRead, InventoryReadOptions } from "./connected-inventory.ts";
import { CALENDAR_BUDGET_MS, CALENDAR_SLUG, calendarAnswer, freeBusyRequest, type CalendarAnswer } from "./bot-calls-policy.ts";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** The broker's batch-execute tool id, the only tool name this module sends (internal id, never shown). */
export const MULTI_EXECUTE_TOOL = "COMPOSIO_MULTI_EXECUTE_TOOL";

/** The most googlecalendar accounts one decision asks. */
export const CALENDAR_MAX_ACCOUNTS = 3;
/** The relay scope prefix: a bot's bridge relays under its own id, so it never shares an operation store with these reads. */
export const CALENDAR_SCOPE_PREFIX = "botcall:";

export interface CalendarRelayReply { status: number; bytes: Uint8Array }
export interface CalendarCheckDeps {
  mode(): "managed" | "unavailable";
  inventory(options: InventoryReadOptions): Promise<InventoryRead>;
  relay(payload: JsonValue, options: { botId: string; waitMs: number }): Promise<CalendarRelayReply>;
  now?: () => number;
  warn?: (step: string, error: unknown) => void;
}

type Json = unknown;
const obj = (value: Json): Record<string, Json> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, Json> : null;

/** The JSON-RPC frames of a relay reply that answer `id` (a JSON body or SSE `data:` lines). */
function framesFor(bytes: Uint8Array, id: string): Array<Record<string, Json>> {
  const text = new TextDecoder().decode(bytes).trim();
  const all: Json[] = [];
  const parse = (value: string) => { try { all.push(JSON.parse(value)); } catch { /* not a frame */ } };
  if (text.startsWith("{") || text.startsWith("[")) parse(text);
  else for (const line of text.split(/\r?\n/)) if (line.startsWith("data:")) parse(line.slice(5).trim());
  return all.flatMap((frame) => Array.isArray(frame) ? frame : [frame]).map(obj)
    .filter((frame): frame is Record<string, Json> => frame !== null && frame.id === id);
}

const failed = (row: Record<string, Json> | null): boolean =>
  !row || row.successful === false || row.success === false || row.isError === true
  || (typeof row.error === "string" && row.error.trim() !== "") || obj(row.error) !== null;

/** The Google freeBusy object of one multi-execute reply, or null for any other shape (a pending-action text included). */
export function freeBusyBody(reply: CalendarRelayReply, id: string): Record<string, Json> | null {
  if (reply.status !== 200) return null;
  const frames = framesFor(reply.bytes, id);
  if (frames.length !== 1 || frames[0].error !== undefined) return null;
  const result = obj(frames[0].result);
  if (!result || result.isError === true) return null;
  let top = obj(result.structuredContent);
  if (!top) {
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content.length === 1 ? obj(content[0]) : null;
    if (!text || text.type !== "text" || typeof text.text !== "string") return null;
    try { top = obj(JSON.parse(text.text)); } catch { return null; }
  }
  if (!top || failed(top)) return null;
  const rows = Array.isArray(obj(top.data)?.results) ? obj(top.data)!.results as Json[] : Array.isArray(top.results) ? top.results as Json[] : null;
  if (!rows || rows.length !== 1) return null;
  const row = obj(rows[0]);
  if (!row || (row.tool_slug ?? row.toolSlug) !== CALENDAR_SLUG || failed(row)) return null;
  const response = obj(row.response);
  if (failed(response)) return null;
  const data = obj(response!.data);
  if (!data) return null;
  const inner = obj(data.response_data);
  return data.calendars === undefined && inner && inner.calendars !== undefined ? inner : data;
}

/** The one relay payload this module sends: one row, the free/busy slug, the request body of 4.4 and nothing else. */
export function freeBusyPayload(id: string, account: string, now: number): JsonValue {
  return {
    jsonrpc: "2.0", id, method: "tools/call",
    params: { name: MULTI_EXECUTE_TOOL, arguments: { tools: [{ tool_slug: CALENDAR_SLUG, account, arguments: freeBusyRequest(now) }] } },
  };
}

export function createCalendarCheck(deps: CalendarCheckDeps): (botId: string, signal: AbortSignal) => Promise<CalendarAnswer> {
  const now = deps.now ?? Date.now;
  return async (botId, signal) => {
    const started = now();
    const left = () => CALENDAR_BUDGET_MS - (now() - started);
    const gone = () => signal.aborted || left() <= 0;
    try {
      if (deps.mode() !== "managed") return "unsure";
      if (gone()) return "unsure";
      const read = await deps.inventory({ force: true, waitMs: Math.max(0, Math.min(3_000, left())) });
      if (gone()) return "unsure";
      const live = read.services !== null && read.revalidating === false && typeof read.at === "number" && read.at >= started;
      if (!live) return "unsure";
      const entry = read.services!.googlecalendar;
      if (!entry || (!entry.connected && !entry.pending && entry.accounts.length === 0)) {
        return calendarAnswer({ mode: "managed", inventory: { ok: true, live: true, hasGooglecalendar: false }, window: { start: started, end: started } });
      }
      if (entry.pending || entry.needsReconnect || !entry.connected) return "unsure";
      const accounts = entry.accounts.filter((a) => a.status.toUpperCase() === "ACTIVE").map((a) => a.id);
      if (accounts.length === 0 || accounts.length > CALENDAR_MAX_ACCOUNTS) return "unsure";
      const at = now();
      const window = { start: at, end: at + 5 * 60_000 };
      const answers = await Promise.all(accounts.map(async (account): Promise<CalendarAnswer> => {
        const id = `botcall-fb-${randomUUID()}`;
        try {
          const reply = await deps.relay(freeBusyPayload(id, account, at), { botId: CALENDAR_SCOPE_PREFIX + botId, waitMs: Math.max(0, left()) });
          if (gone()) return "unsure";
          const body = freeBusyBody(reply, id);
          return calendarAnswer({ mode: "managed", inventory: { ok: true, live: true, hasGooglecalendar: true }, status: body ? 200 : 0, body, window });
        } catch (error) {
          deps.warn?.("free-busy", error);
          return "unsure";
        }
      }));
      if (gone()) return "unsure";
      if (answers.includes("busy")) return "busy";
      return answers.every((a) => a === "free") ? "free" : "unsure";
    } catch (error) {
      deps.warn?.("inventory", error);
      return "unsure";
    }
  };
}
