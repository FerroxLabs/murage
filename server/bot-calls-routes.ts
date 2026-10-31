// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bot calls (design BOT-CALLS-109 rev 4.2, section 6; docs/contracts/calls-109.yaml): the owner routes and the call
// channel websocket (5.7). Every route is owner-authenticated by the central gate (route-policy.ts, class companion: the
// desktop, or the phone's companion proof); a bot's capability is never enough. This module answers {status, body};
// server/index.ts writes it.
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { DatabaseSync } from "node:sqlite";
import { WebSocketServer, type WebSocket } from "ws";
import { CALL_DEVICE, CALL_PROTOCOL } from "../shared/bot-calls-contract.ts";
import { getIntent, getSession, liveSessions, markTurnCall, ringingIntent, type CallIntent, type SessionEnd } from "./bot-calls-machine.ts";
import {
  CallRuleInputError, botCallsEnabled, callRulesHold, callsOffUntil, setCallsOffUntil, listCallRules, putCallRules, rearmCallRules, rebuildWatchThreads, setBotCallsEnabled,
  type CallRuleInput,
} from "./bot-calls-schema.ts";
import type { BotCallsRuntime } from "./bot-calls-runtime.ts";
import { createTicketStore, type TicketStore } from "./single-use-ticket.ts";

export interface CallsRouteReply { status: number; body: unknown; headers?: Record<string, string> }
export interface CallsRouteDeps {
  db: () => DatabaseSync;
  runtime: BotCallsRuntime;
  /** The caller may see this conversation (the desktop sees all; a phone what its sidebar shows). */
  visible(threadId: string): boolean;
  bot(botId: string): { id: string; name: string; threadId?: string } | null;
  /** The opener's sentence (design 8), server text spoken before the host runs. */
  opener(intent: CallIntent): string;
  /** Quiet hours as the Calls page shows them, and whether this bot has a voice. */
  quietHours(): unknown;
  voiceReady(botId: string): boolean;
  /** "Rings for calls" on one phone binding; false when there is no such binding. */
  setRingsForCalls(bindingId: string, on: boolean): boolean;
  readBody(): Promise<unknown>;
  /** The turn running now on this conversation (the provider turn id turn.completed carries) and its bot; null when none. */
  runningTurn?(threadId: string): { turnId: string; botId: string } | null;
  tickets: TicketStore;
  now?: () => number;
}

/** The stored "Calls off for today" while it holds; a lapsed value reads null. */
const offUntilNow = (db: DatabaseSync, at: number): number | null => { const until = callsOffUntil(db); return until !== null && until > at ? until : null; };
const ok = (body: unknown): CallsRouteReply => ({ status: 200, body });
const err = (status: number, error: string): CallsRouteReply => ({ status, body: { error } });
const objectOf = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const ticketPrincipal = (callId: string, device: string) => `call:${callId}:${device}`;

export function createCallTickets(): TicketStore { return createTicketStore({ ttlMs: CALL_PROTOCOL.ticketMs, maxOutstanding: 64 }); }

function rulesBody(d: CallsRouteDeps, botId: string): unknown {
  const db = d.db();
  const hold = callRulesHold(db);
  return { enabled: botCallsEnabled(db, botId), rules: listCallRules(db, botId), held: hold.held, restoreGen: hold.restoreGen, quietHours: d.quietHours(), voice: d.voiceReady(botId) };
}

/** "Don't call me about this again" (design 3): a turn mark is deleted, a sender is taken off its rule, a Tier B rule
 * is demoted to message only, any other rule is switched off. The rule's other intents are cancelled. */
function neverAgain(d: CallsRouteDeps, intent: CallIntent): CallsRouteReply {
  const db = d.db();
  const rule = db.prepare("SELECT id, kind, tier, params FROM bot_call_rules WHERE id=? AND bot_id=?").get(intent.ruleId, intent.botId) as { id: string; kind: string; tier: string; params: string } | undefined;
  let outcome: "off" | "demoted" | "deleted" | "sender_removed" = "off";
  const at = (d.now ?? Date.now)();
  if (rule) {
    if (rule.kind === "turn_end") { db.prepare("DELETE FROM bot_call_rules WHERE id=?").run(rule.id); outcome = "deleted"; }
    else if (rule.kind === "sender" && typeof intent.factFields.senderId === "string") {
      const params = objectOf(JSON.parse(rule.params));
      const senders = (Array.isArray(params.senderIds) ? params.senderIds : []).filter((s) => s !== intent.factFields.senderId);
      if (senders.length) db.prepare("UPDATE bot_call_rules SET params=?, updated_at=? WHERE id=?").run(JSON.stringify({ ...params, senderIds: senders }), at, rule.id);
      else db.prepare("UPDATE bot_call_rules SET enabled=0, updated_at=? WHERE id=?").run(at, rule.id);
      rebuildWatchThreads(db);
      outcome = "sender_removed";
    } else if (rule.tier === "B") { db.prepare("UPDATE bot_call_rules SET demoted=1, updated_at=? WHERE id=?").run(at, rule.id); outcome = "demoted"; }
    else { db.prepare("UPDATE bot_call_rules SET enabled=0, updated_at=? WHERE id=?").run(at, rule.id); rebuildWatchThreads(db); }
  }
  d.runtime.cancel({ rule: intent.ruleId }, "never_again");
  return ok({ rule: outcome });
}

const intentView = (i: CallIntent) => ({
  intentId: i.id, botId: i.botId, threadId: i.threadId, state: i.state, outcome: i.outcome, factKind: i.factKind,
  createdAt: i.createdAt, rangAt: i.rangAt, endedAt: i.endedAt, receipt: i.receipt,
});

/** A usable IANA zone name, or null (then the host's zone is used). */
function zoneOrNull(tz: unknown): string | null {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return null;
  try { return new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone; } catch { return null; }
}
/** The wall clock in `zone` read as if it were UTC, minus the instant: the zone's offset at `at`, in ms. */
function zoneOffset(at: number, zone: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(at)).map((p) => [p.type, p.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second)) - Math.floor(at / 1000) * 1000;
}
/** "Calls off for today" (calls-109.yaml v2, off-today): the next local midnight after `now` in the device's IANA zone, or in the
 * host's zone when that is missing or not a zone. */
export function nextLocalMidnight(now: number, tz?: unknown): number {
  const zone = zoneOrNull(tz) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const local = new Date(now + zoneOffset(now, zone));
  const target = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1);
  // two passes settle the offset at the target itself (DST may differ from now's)
  let at = target - zoneOffset(target, zone);
  at = target - zoneOffset(at, zone);
  if (at <= now) at = now + 1;
  return at;
}

/** null: not a calls route. */
export async function handleCallsRoute(method: string, path: string, url: URL, d: CallsRouteDeps): Promise<CallsRouteReply | null> {
  // the cheap test every request pays: the second segment, never a route of its own
  const segment = path.split("/", 3)[2];
  if (segment !== "calls" && segment !== "bots" && segment !== "phone") return null;
  const now = d.now ?? Date.now;
  let m: RegExpExecArray | null;
  if (method === "GET" && path === "/api/calls/active") {
    const db = d.db();
    const ringing = ringingIntent(db);
    const shown = ringing && d.visible(ringing.threadId) && ringing.deadlineAt !== null && ringing.deadlineAt > now() ? ringing : null;
    return ok({
      ringing: shown ? { intentId: shown.id, botId: shown.botId, botName: d.bot(shown.botId)?.name ?? null, threadId: shown.threadId, rangAt: shown.rangAt, deadlineAt: shown.deadlineAt } : null,
      live: liveSessions(db, now()).filter((s) => !s.threadId || d.visible(s.threadId))
        .map((s) => ({ callId: s.callId, sessionId: s.id, intentId: s.intentId, botId: s.botId, threadId: s.threadId, device: s.device, openedAt: s.openedAt })),
      offUntil: offUntilNow(db, now()),
    });
  }
  if (method === "POST" && path === "/api/calls/off-today") {
    // owner-wide, not per bot; it returns no names or text, so it is not unlockedOnly. It lapses on its own: no timer.
    const body = objectOf(await d.readBody());
    if (typeof body.on !== "boolean") return err(400, "on must be true or false");
    const db = d.db();
    setCallsOffUntil(db, body.on ? nextLocalMidnight(now(), body.tz) : null);
    // a ring already on its way stops now (5.6 "calls off for today"), except an Emergency rule's; a waiting intent is
    // re-decided at its escalation, where step 7 keeps it a message
    if (body.on) {
      const ringing = db.prepare(`SELECT c.id FROM bot_calls c LEFT JOIN bot_call_rules r ON r.id = c.rule_id
        WHERE c.state = 'ringing' AND NOT (COALESCE(r.tier, '') = 'A' AND COALESCE(r.emergency, 0) = 1)`).all() as Array<{ id: string }>;
      for (const { id } of ringing) d.runtime.cancel({ intent: id }, "calls_off");
    }
    return ok({ offUntil: offUntilNow(db, now()) });
  }
  if (method === "POST" && path === "/api/calls/turn-end") {
    // "Call me when this finishes" (design 4.1): the turn_end rule and its armed owed row, in one transaction (markTurnCall);
    // born held during a restore (F61). The settle hook fires on turn.completed; a crash settles it at boot.
    const body = objectOf(await d.readBody());
    if (typeof body.threadId !== "string" || !body.threadId) return err(400, "threadId is required");
    const how = body.how === undefined ? "ring" : body.how;
    if (how !== "ring" && how !== "text_first") return err(400, "how must be ring or text_first");
    const waitMin = how === "text_first" ? (body.waitMin === undefined ? 10 : body.waitMin) : undefined;
    if (waitMin !== undefined && ![10, 15, 30, 60].includes(waitMin as number)) return err(400, "waitMin must be 10, 15, 30 or 60");
    if (!d.visible(body.threadId)) return err(404, "not_found");
    const turn = d.runningTurn?.(body.threadId) ?? null;
    if (!turn || !d.bot(turn.botId)) return err(409, "not_running");
    const db = d.db();
    if (!botCallsEnabled(db, turn.botId)) return err(409, "calls_off");
    // Calls off for today (MurageMain 10-27): nothing is queued; the app offers "Turn calls back on", then asks again
    if (offUntilNow(db, now()) !== null) return { status: 409, body: { error: "calls_off_today", code: "calls_off_today" } };
    // a second tap on the same turn is the first one's answer (idempotent)
    const marked = db.prepare("SELECT id FROM bot_call_rules WHERE bot_id=? AND kind='turn_end' AND json_extract(params,'$.turnId')=? LIMIT 1").get(turn.botId, turn.turnId) as { id: string } | undefined;
    if (marked) return ok({ ruleId: marked.id, turnId: turn.turnId });
    try { return ok({ ruleId: markTurnCall(db, { botId: turn.botId, threadId: body.threadId, turnId: turn.turnId, how, waitMin: waitMin as number | undefined }, now()).ruleId, turnId: turn.turnId }); }
    catch (error) { if (error instanceof CallRuleInputError) return err(400, error.message); throw error; }
  }
  if (method === "GET" && path === "/api/calls/history") {
    const before = Number(url.searchParams.get("before") ?? Number.MAX_SAFE_INTEGER);
    const limit = Math.min(100, Math.max(1, Math.trunc(Number(url.searchParams.get("limit") ?? 50)) || 50));
    // Hidden rows are skipped, never counted: the page fills with visible calls, and `next` is the createdAt of the last
    // one returned, so the cursor never carries the time of a call in a conversation the caller cannot see.
    const page = d.db().prepare("SELECT id, created_at FROM bot_calls WHERE created_at < ? OR (created_at = ? AND id < ?) ORDER BY created_at DESC, id DESC LIMIT 200");
    const seen: CallIntent[] = [];
    let more = false;
    let at = Number.isFinite(before) ? before : Number.MAX_SAFE_INTEGER, lastId = "";
    scan: for (;;) {
      const rows = page.all(at, at, lastId) as Array<{ id: string; created_at: number }>;
      for (const r of rows) {
        const intent = getIntent(d.db(), r.id);
        if (!intent || !d.visible(intent.threadId)) continue;
        if (seen.length === limit) { more = true; break scan; }
        seen.push(intent);
      }
      if (rows.length < 200) break;
      at = Number(rows[rows.length - 1].created_at); lastId = rows[rows.length - 1].id;
    }
    return ok({ items: seen.map(intentView), next: more ? seen[limit - 1].createdAt : null });
  }
  if (method === "POST" && path === "/api/calls/rearm") {
    const body = objectOf(await d.readBody());
    const r = rearmCallRules(d.db(), body.restoreGen, now());
    return r.ok ? ok({ rearmed: r.rearmed }) : err(409, "stale");
  }
  if (method === "POST" && path === "/api/calls/sessions") {
    const body = objectOf(await d.readBody());
    const bot = typeof body.botId === "string" ? d.bot(body.botId) : null;
    if (!bot || typeof body.threadId !== "string" || !d.visible(body.threadId)) return err(404, "no such conversation");
    if (typeof body.device !== "string" || !CALL_DEVICE.test(body.device)) return err(400, "device");
    // the call id on the headers too, so a client that aborts a slow body still ends the session it opened
    const opened = d.runtime.openSession({ botId: bot.id, threadId: body.threadId, device: body.device });
    return { ...ok(opened), headers: { [CALL_PROTOCOL.callIdHeader]: opened.callId } };
  }
  if (method === "POST" && (m = /^\/api\/calls\/sessions\/([\w-]{1,64})\/(ticket|end)$/.exec(path))) {
    const [, callId, action] = m;
    const session = getSession(d.db(), callId);
    if (!session || (session.threadId && !d.visible(session.threadId))) return err(404, "no such call");
    if (action === "end") return ok({ ended: d.runtime.endSession(callId, "closed") });
    const body = objectOf(await d.readBody());
    if (body.device !== session.device) return err(404, "no such call");
    if (session.endedAt !== null || d.runtime.touch(callId) !== "live") return err(410, "gone");
    return ok({ ticket: d.tickets.mint(ticketPrincipal(callId, session.device)), expiresAt: now() + CALL_PROTOCOL.ticketMs });
  }
  if (method === "POST" && (m = /^\/api\/calls\/([0-9a-f-]{36})\/(answer|decline|text-instead|never-again|seen)$/.exec(path))) {
    const [, id, action] = m;
    const intent = getIntent(d.db(), id);
    if (!intent || !d.visible(intent.threadId)) return err(404, "no such call");
    const body = objectOf(await d.readBody());
    if (action === "answer") {
      if (typeof body.device !== "string" || !CALL_DEVICE.test(body.device)) return err(400, "device");
      const r = d.runtime.answer(id, body.device);
      return r.status === 200 ? ok({ sessionId: r.sessionId, callId: r.callId, threadId: r.threadId }) : err(r.status, r.error);
    }
    if (action === "decline") return d.runtime.decline(id, "declined") ? ok({ outcome: "declined" }) : err(409, "not_ringing");
    if (action === "text-instead") return d.runtime.decline(id, "text_instead") ? ok({ outcome: "text_instead" }) : err(409, "not_ringing");
    if (action === "seen") return ok({ seen: d.runtime.seen(id) });
    return neverAgain(d, intent);
  }
  if (method === "GET" && (m = /^\/api\/calls\/([0-9a-f-]{36})\/opener$/.exec(path))) {
    const intent = getIntent(d.db(), m[1]);
    if (!intent || !d.visible(intent.threadId)) return err(404, "no such call");
    return ok({ text: d.opener(intent), botId: intent.botId, threadId: intent.threadId });
  }
  if (method === "GET" && (m = /^\/api\/calls\/([0-9a-f-]{36})$/.exec(path))) {
    const intent = getIntent(d.db(), m[1]);
    if (!intent || !d.visible(intent.threadId)) return err(404, "no such call");
    return ok(intentView(intent));
  }
  if ((m = /^\/api\/bots\/([\w-]+)\/calls\/rules$/.exec(path)) && (method === "GET" || method === "PUT")) {
    const bot = d.bot(m[1]);
    if (!bot) return err(404, "no such bot");
    if (method === "GET") return ok(rulesBody(d, bot.id));
    const body = objectOf(await d.readBody());
    if (body.rules !== undefined && !Array.isArray(body.rules)) return err(400, "rules must be a list");
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") return err(400, "enabled must be true or false");
    try {
      if (Array.isArray(body.rules)) putCallRules(d.db(), bot.id, body.rules as CallRuleInput[], now());
    } catch (error) {
      if (error instanceof CallRuleInputError) return err(400, error.message);
      throw error;
    }
    if (body.enabled === false && botCallsEnabled(d.db(), bot.id)) { setBotCallsEnabled(d.db(), bot.id, false); d.runtime.cancel({ bot: bot.id }, "bot_off"); }
    else if (body.enabled === true) setBotCallsEnabled(d.db(), bot.id, true);
    return ok(rulesBody(d, bot.id));
  }
  if (method === "PATCH" && (m = /^\/api\/phone\/bindings\/([\w-]{1,64})$/.exec(path))) {
    const body = objectOf(await d.readBody());
    if (typeof body.ringsForCalls !== "boolean") return err(400, "ringsForCalls must be true or false");
    return d.setRingsForCalls(m[1], body.ringsForCalls) ? ok({ ringsForCalls: body.ringsForCalls }) : err(404, "no such phone");
  }
  return null;
}

// ── the call channel (5.7) ──────────────────────────────────────────────────

/** `call.live`, echoing the heartbeat's sequence number when the client frame carried a valid one. */
export function liveFrame(data: unknown): string {
  let seq: unknown;
  try { seq = (JSON.parse(String(data)) as { seq?: unknown }).seq; } catch { /* not JSON: still traffic */ }
  return JSON.stringify(typeof seq === "number" && Number.isSafeInteger(seq) && seq > 0 ? { type: "call.live", seq } : { type: "call.live" });
}
export const CALL_CHANNEL_PATH = /^\/api\/calls\/sessions\/([\w-]{1,64})\/live$/;

export interface CallChannelDeps {
  db: () => DatabaseSync;
  runtime: () => BotCallsRuntime;
  tickets: TicketStore;
  /** The same Host and Origin rules as the HTTP gate (voice/stream-route.ts upgradeAdmitted). */
  admitUpgrade(req: IncomingMessage): boolean;
  pingEveryMs?: number;
}

/** One websocket per open CallView, bound by a single-use ticket to the session's device. A pong or any frame is traffic;
 * a session that ends sends `call.ended` and closes. The open socket itself never counts: only what it returns. A client
 * heartbeat `{ type: "call.alive", seq }` is answered `{ type: "call.live", seq }` while the session is live. The server
 * is the only authority on liveness: the client ends on call.ended, a 404/410 ticket, or CALL_PROTOCOL.clientGivesUpMs
 * after the last echo ARRIVED, which is always after this server has already ended the session for silence. */
export function createCallChannel(deps: CallChannelDeps) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const sockets = new Map<string, Set<WebSocket>>();
  const frame = (callId: string, reason: SessionEnd) => JSON.stringify({ type: "call.ended", callId, reason });
  function closeAll(callId: string, reason: SessionEnd): void {
    for (const ws of sockets.get(callId) ?? []) { try { ws.send(frame(callId, reason)); ws.close(1000, "call ended"); } catch { /* already gone */ } }
    sockets.delete(callId);
  }
  function attach(ws: WebSocket, callId: string): void {
    let set = sockets.get(callId);
    if (!set) sockets.set(callId, set = new Set());
    set.add(ws);
    const traffic = (): boolean => {
      const state = deps.runtime().touch(callId);
      if (state !== "live") { const s = getSession(deps.db(), callId); try { ws.send(frame(callId, s?.endedBy ?? "lost")); ws.close(1000, "call ended"); } catch { /* gone */ } }
      return state === "live";
    };
    const ping = setInterval(() => { try { ws.ping(); } catch { /* closing */ } }, deps.pingEveryMs ?? CALL_PROTOCOL.pingEveryMs);
    ping.unref?.();
    ws.on("pong", traffic);
    ws.on("message", (data) => { if (traffic()) { try { ws.send(liveFrame(data)); } catch { /* closing */ } } });
    ws.on("close", () => { clearInterval(ping); set!.delete(ws); if (set!.size === 0 && sockets.get(callId) === set) sockets.delete(callId); });
    ws.on("error", () => { /* close follows */ });
    traffic();
  }
  return {
    /** False for any other path, so the caller goes on to the next upgrade handler. */
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const m = CALL_CHANNEL_PATH.exec(url.pathname);
      if (!m) return false;
      const session = getSession(deps.db(), m[1]);
      const ticket = url.searchParams.get("ticket") ?? "";
      if (!deps.admitUpgrade(req) || !session || session.endedAt !== null || !deps.tickets.redeem(ticket, ticketPrincipal(session.callId, session.device))) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        socket.destroy();
        return true;
      }
      wss.handleUpgrade(req, socket, head, (ws) => attach(ws, session.callId));
      return true;
    },
    sessionEnded: closeAll,
    open: (callId: string) => sockets.get(callId)?.size ?? 0,
  };
}
