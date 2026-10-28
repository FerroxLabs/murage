// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One call screen, one server session (design BOT-CALLS-109 rev 4.2, 5.4 and 5.7; calls-109.yaml session). A bot's call
// screen holds the session the answer route returned (an answered bot call) or opens one (an ordinary call; the server
// ends a ring still ringing as "You started another call"). The server is the only authority on whether a call is live;
// this is its local copy, three states long: opening -> live -> ended.
//
// - Opening (an ordinary call): POST /api/calls/sessions, retried within CALL_PROTOCOL.silenceEndsMs. A deadline armed
//   when the open begins aborts a POST still in flight and ends the call with a short note, so a call never runs without
//   a server session; a session id that arrives after the end is ended at once. The ring banner stays back while a call
//   screen is opening its session (callSessionOpening), so no ring lands on a session-less screen.
// - Live: every pingEveryMs the channel carries a numbered heartbeat, sent whether or not the last one was answered; the
//   server echoes the number in call.live. `heardAt` is when the newest echo (or ticket) ARRIVED, never before the server
//   counted that traffic, so CALL_PROTOCOL.clientGivesUpMs (the server's silence plus a margin, from one constant) ends
//   the call here only after the server has ended it. A slow round trip delays echoes; it never hangs up a held call.
// - Ended, by one path (end): the call screen hung up or moved to another target, a server end (call.ended on the channel
//   or as an SSE hint, or a 404/410 ticket), or clientGivesUpMs with no echo. It ends the call screen here (endCall: the
//   screen, its microphone and its audio), closes the channel and tells the server (the end route is idempotent).
import { CALL_PROTOCOL } from "../../shared/bot-calls-contract";
import { CALL_EVENT } from "./bot-call-event";
import { BOT_CALL_WORDS, thisCallDevice } from "./bot-calls";
import { currentCall, endCall, onCallChange } from "./call";
import { desktopCallerHeaders, desktopSurfaceHeaders } from "./live-events";

/** The longest wait between two tries to reopen a dropped channel or open a session. */
const RETRY_MAX_MS = 4_000;
/** The opener is said before the owner's turn; one that does not come in this long is skipped. */
const OPENER_WAIT_MS = 5_000;

interface Session {
  botId: string;
  device: string;
  callId: string | null;
  opener: Promise<string | null> | null;
  socket: WebSocket | null;
  /** When the newest server echo, ticket or session answer arrived here. */
  heardAt: number;
  /** The newest heartbeat number sent; an echo counts only for a number this session sent. */
  seq: number;
  beat: ReturnType<typeof setInterval> | null;
  retries: number;
  timer: ReturnType<typeof setTimeout> | null;
  ended: boolean;
}
let session: Session | null = null;

// Told whenever this window's session starts, gets its server id or ends. The ring banner reads callSessionOpening()
// during render; a call screen opening its session renders nothing else, so the banner subscribes here.
const subscribers = new Set<() => void>();
function changed(): void { for (const fn of [...subscribers]) { try { fn(); } catch { /* one listener never stops another */ } } }
/** Subscribe to session changes (start, server id, end); returns the unsubscribe. */
export function onCallSessionChange(fn: () => void): () => void {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}

const headers = (callId?: string | null): Record<string, string> => ({
  "content-type": "application/json", "x-murage-surface": "desktop",
  ...(callId ? { [CALL_PROTOCOL.callIdHeader]: callId } : {}),
});
const post = (path: string, body: unknown, callId: string | null, signal?: AbortSignal) =>
  fetch(path, { method: "POST", cache: "no-store", redirect: "error", headers: { ...headers(callId), ...desktopSurfaceHeaders() }, body: JSON.stringify(body), signal });
const mine = (s: Session) => session === s && !s.ended;
const backoff = (s: Session) => Math.min(RETRY_MAX_MS, 250 * 2 ** ++s.retries);

/** The call id header while this window's call has a session; empty otherwise (or for another bot). */
export function botCallHeaders(botId?: string): Record<string, string> {
  const s = session;
  if (!s || s.ended || !s.callId || (botId !== undefined && botId !== s.botId)) return {};
  return { [CALL_PROTOCOL.callIdHeader]: s.callId };
}

/** A call screen is up and its ordinary session is still opening (no server session yet): the ring banner waits. */
export function callSessionOpening(): boolean {
  const s = session;
  return !!s && !s.ended && !s.callId;
}

/** The opener of the bot's answered call, once; null when none waits. The call screen says it before the owner's turn. */
export function takeBotCallOpener(botId: string): Promise<string | null> | null {
  const s = session;
  if (!s || s.ended || s.botId !== botId || !s.opener) return null;
  const opener = s.opener;
  s.opener = null;
  return opener;
}

function stopBeat(s: Session): void {
  if (s.beat) clearInterval(s.beat);
  s.beat = null;
}

/** The single exit. A server end, silence, a failed open or a hang-up all end the same way. */
function end(s: Session, note?: string): void {
  if (s.ended) return;
  s.ended = true;
  if (s.timer) clearTimeout(s.timer);
  s.timer = null;
  stopBeat(s);
  const socket = s.socket;
  s.socket = null;
  try { socket?.close(1000, "call ended"); } catch { /* gone */ }
  if (session === s) session = null;
  changed();
  if (s.callId) void post(`/api/calls/sessions/${s.callId}/end`, {}, s.callId).catch(() => undefined);
  if (endCall(s.botId) && note && typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new CustomEvent(CALL_EVENT, { detail: { type: "call.note", text: note } }));
  }
}

/** The local give-up clock: end clientGivesUpMs after the newest echo arrived. */
function watch(s: Session): void {
  if (!mine(s)) return;
  if (s.timer) clearTimeout(s.timer);
  const wait = s.heardAt + CALL_PROTOCOL.clientGivesUpMs - Date.now();
  if (wait <= 0) return end(s);
  s.timer = setTimeout(() => watch(s), wait);
}

function heard(s: Session): void {
  s.heardAt = Date.now();
  watch(s);
}

function heartbeat(s: Session, ws: WebSocket): void {
  if (!mine(s) || s.socket !== ws || ws.readyState !== 1) return;
  s.seq += 1;
  try { ws.send(JSON.stringify({ type: "call.alive", seq: s.seq })); } catch { /* the close follows */ }
}

/** Opens (or reopens) the call channel: a single-use ticket, then the websocket. Tried until end(). */
function connect(s: Session): void {
  if (!mine(s) || !s.callId || s.socket) return;
  const callId = s.callId;
  const retry = () => {
    if (!mine(s) || s.socket) return;
    setTimeout(() => connect(s), backoff(s));
  };
  void (async () => {
    let ticket: string;
    try {
      const res = await post(`/api/calls/sessions/${callId}/ticket`, { device: s.device }, callId);
      if (res.status === 404 || res.status === 410) return end(s);
      if (!res.ok) return retry();
      ticket = ((await res.json()) as { ticket: string }).ticket;
    } catch { return retry(); }
    if (!mine(s)) return;
    heard(s);
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${scheme}//${location.host}/api/calls/sessions/${callId}/live?ticket=${encodeURIComponent(ticket)}`);
    s.socket = ws;
    ws.onopen = () => {
      if (s.socket !== ws || !mine(s)) return;
      s.retries = 0;
      stopBeat(s);
      heartbeat(s, ws);
      s.beat = setInterval(() => heartbeat(s, ws), CALL_PROTOCOL.pingEveryMs);
    };
    ws.onmessage = (event) => {
      let frame: { type?: unknown; seq?: unknown };
      try { frame = JSON.parse(String(event.data)) as { type?: unknown; seq?: unknown }; } catch { return; }
      if (s.socket !== ws) return;
      if (frame.type === "call.ended") end(s);
      else if (frame.type === "call.live" && typeof frame.seq === "number" && frame.seq >= 1 && frame.seq <= s.seq) heard(s);
    };
    ws.onclose = () => {
      if (s.socket !== ws) return;
      s.socket = null;
      stopBeat(s);
      retry();
    };
  })();
}

function start(o: { botId: string; device: string; callId: string | null; opener: Promise<string | null> | null }): Session {
  if (session) end(session);
  const s: Session = { ...o, socket: null, heardAt: Date.now(), seq: 0, beat: null, retries: 0, timer: null, ended: false };
  session = s;
  return s;
}

/** After a successful answer: the session the answer route opened rides with the call screen this starts. */
export function attachAnsweredCall(o: { intentId: string; callId: string; botId: string; device: string }): void {
  const opener = fetch(`/api/calls/${o.intentId}/opener`, { cache: "no-store", redirect: "error", headers: { ...desktopCallerHeaders(), [CALL_PROTOCOL.callIdHeader]: o.callId }, signal: AbortSignal.timeout(OPENER_WAIT_MS) })
    .then(async (res) => (res.ok ? ((await res.json()) as { text?: unknown }).text : null))
    .then((text) => (typeof text === "string" && text.trim() ? text : null))
    .catch(() => null);
  const s = start({ botId: o.botId, device: o.device, callId: o.callId, opener });
  watch(s);
  connect(s);
}

/** The longest the owner's turn waits on an opener that never reports its end (a stalled clip). */
export const OPENER_CAP_MS = 30_000;

/** Says the opener with `playing` held up until playback has ENDED (say resolves on the clip's ended event, or a cut or
 *  a failure), or OPENER_CAP_MS at most. The call screen starts no recognition while `playing` is up, so an
 *  echo-cancelled microphone cannot open the owner's turn over the opener. */
export async function sayOpener(say: () => Promise<unknown>, playing: { current: boolean }, capMs = OPENER_CAP_MS): Promise<void> {
  playing.current = true;
  let cap: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([say().catch(() => undefined), new Promise<void>((resolve) => { cap = setTimeout(resolve, capMs); })]);
  } finally {
    clearTimeout(cap);
    playing.current = false;
  }
}

/** A failed open worth another try inside the window: no answer, the server busy or failing. Anything else is final. */
const retryable = (status: number | null) => status === null || status === 408 || status === 429 || status >= 500;

/** The call screen for this bot is up: hold its session, opening an ordinary one when no answered call brought it. */
export function holdCallSession(botId: string, threadId: string | null | undefined): void {
  if (session && session.botId === botId && !session.ended) return;
  if (!threadId || currentCall() !== botId) return;
  const device = thisCallDevice();
  const s = start({ botId, device, callId: null, opener: null });
  changed();
  const until = Date.now() + CALL_PROTOCOL.silenceEndsMs;
  let inFlight: AbortController | null = null;
  // the open's deadline, armed now: a POST that never settles cannot hold a session-less screen up. watch() replaces
  // this timer once a session id arrives; end() clears it.
  s.timer = setTimeout(() => { inFlight?.abort(); end(s, BOT_CALL_WORDS.couldNotConnect); }, CALL_PROTOCOL.silenceEndsMs);
  const attempt = async (): Promise<void> => {
    if (!mine(s)) return;
    let callId: unknown = null;
    let status: number | null = null;
    const abort = new AbortController();
    inFlight = abort;
    try {
      const res = await post("/api/calls/sessions", { botId, threadId, device }, null, abort.signal);
      status = res.status;
      // the session id rides on the headers too: read it before the body, so a deadline that aborts a body still on
      // its way still knows the session the server opened and ends it below, rather than leaving it to the 60 s sweep
      if (res.ok) callId = res.headers?.get(CALL_PROTOCOL.callIdHeader) || null;
      if (res.ok && typeof callId !== "string") callId = ((await res.json()) as { callId?: unknown }).callId;
    } catch { /* no answer (or aborted at the deadline): retried below */ }
    if (inFlight === abort) inFlight = null;
    // hung up (or the deadline passed) while it opened: a late session id ends now, not 60 s later
    if (!mine(s)) { if (typeof callId === "string") void post(`/api/calls/sessions/${callId}/end`, {}, callId).catch(() => undefined); return; }
    if (typeof callId === "string") {
      s.callId = callId;
      s.retries = 0;
      changed();
      heard(s);
      connect(s);
      return;
    }
    // a call never runs without a session: try again inside the window, then end the call with a plain note
    const wait = backoff(s);
    if (!retryable(status) || Date.now() + wait > until) return end(s, BOT_CALL_WORDS.couldNotConnect);
    setTimeout(() => void attempt(), wait);
  };
  void attempt();
}

// The call screen hung up or moved to another target: its session ends with it.
onCallChange(() => { if (session && currentCall() !== session.botId) end(session); });
// The live stream's call.ended hint for this call: the same end as the channel's frame.
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener(CALL_EVENT, (event) => {
    const detail = (event as CustomEvent<{ type?: unknown; callId?: unknown }>).detail;
    if (session?.callId && detail?.type === "call.ended" && detail.callId === session.callId) end(session);
  });
}
