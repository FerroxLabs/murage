// server/voice/stream-route.ts
// Streaming voice IN (spec C.2). Two doors:
//   POST /api/voice/stream/ticket  ordinary HTTP: the desktop proves itself with
//                                  its surface headers, a phone through the
//                                  companion's launch proof; the ticket is bound
//                                  to that principal.
//   GET  /api/voice/stream?ticket= websocket upgrade; the ticket redeems only for
//                                  the same principal.
// The harness relays contract A both ways and holds the Flux key; the page
// never sees it. Off by default (streamFlagOn): the Flux side is not live yet
// (Flux FLUX-940, subprotocol flux.stt.v1). The harness never reconnects to Flux: the page owns fallback.
import { randomBytes } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";

import { LEASE_MS, LIMITS, SLOW_CONSUMER_BYTES, SUBPROTOCOL, fatal, parseClientMessage, type ClientMessage, type StreamError } from "../../shared/flux-stream-contract.ts";
import { FluxStreamRefused, failureForClose, openFluxStream, type FluxStream } from "./flux-stream.ts";

/** A WebSocket close reason must fit 123 bytes of UTF-8; ws throws a RangeError past it. Cuts on a character boundary. */
export function trimCloseReason(reason: string, maxBytes = 123): string {
  let out = "";
  let bytes = 0;
  for (const ch of reason) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > maxBytes) break;
    out += ch;
    bytes += n;
  }
  return out;
}

/** Live streaming transcription is off unless MURAGE_VOICE_STREAM=on. Flux has
 *  not built wss /v1/audio/transcriptions/stream yet (Flux FLUX-940, flux.stt.v1),
 *  so dictation and calls use the batch POST /v1/audio/transcriptions path. */
export function streamFlagOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MURAGE_VOICE_STREAM === "on";
}

export const STREAM_TICKET_PATH = "/api/voice/stream/ticket";
export const STREAM_WS_PATH = "/api/voice/stream";
export const STREAM_PRINCIPAL_HEADER = "x-murage-stream-principal";
const TICKET_TTL_MS = 30_000;
const HOUR_MS = 60 * 60_000;
const FLUX_BACKLOG_BYTES = 32 * 1024; // about 1 s of 16 kHz PCM
const MAX_PAGE_MESSAGE = 64 * 1024;
const RESTART_DEADLINE_MS = 2_000;
const PAGE_CLOSE_GRACE_MS = 1_000;
const PRINCIPAL = /^companion:[\w-]+:[\w-]+$/;
const PAGE_CONFIG_FIELDS = new Set(["eagerness", "keyterms", "min_silence_ms", "max_silence_ms"]);
const PAGE_QUERY = new Set(["eagerness", "keyterms", "min_silence_ms", "max_silence_ms", "partials", "words"]);

/** Who is streaming: "desktop", or the principal the companion stamped
 *  (companion:<device>:<session>), trusted only behind its launch proof. */
export function streamPrincipal(headers: IncomingHttpHeaders, door: "desktop" | "companion" | "unproven"): string | null {
  if (door === "desktop") return "desktop";
  if (door !== "companion") return null;
  const value = String(headers[STREAM_PRINCIPAL_HEADER] ?? "");
  return PRINCIPAL.test(value) ? value : null;
}

/** The principal an upgrade claims. A request the companion marked must also
 *  carry its launch proof, or it has no principal (the page then gets 4401);
 *  an unmarked one is the desktop page, proven by its single-use ticket. */
export function upgradePrincipalFor(
  headers: IncomingHttpHeaders,
  checks: { marked(headers: IncomingHttpHeaders): boolean; authorized(headers: IncomingHttpHeaders): boolean },
): string | null {
  if (!checks.marked(headers)) return "desktop";
  return streamPrincipal(headers, checks.authorized(headers) ? "companion" : "unproven");
}

/** The same Host and Origin rules as the HTTP gate. A request with no Origin
 *  (the companion, a native client) passes the Origin rule, as it does there. */
export function upgradeAdmitted(headers: IncomingHttpHeaders, checks: { host(host: string | undefined): boolean; origin(origin: string): boolean }): boolean {
  if (!checks.host(headers.host)) return false;
  const origin = headers.origin;
  return !origin || checks.origin(origin);
}

export function createTicketStore(opts: { ttlMs?: number; now?: () => number } = {}) {
  const ttl = opts.ttlMs ?? TICKET_TTL_MS;
  const now = opts.now ?? Date.now;
  const tickets = new Map<string, { principal: string; expires: number }>();
  return {
    mint(principal: string): string {
      for (const [t, v] of tickets) if (v.expires < now()) tickets.delete(t);
      const ticket = randomBytes(32).toString("base64url");
      tickets.set(ticket, { principal, expires: now() + ttl });
      return ticket;
    },
    /** Single use: spent whether or not it matches. */
    redeem(ticket: string, principal: string): boolean {
      const found = tickets.get(ticket);
      tickets.delete(ticket);
      return Boolean(found && found.expires >= now() && found.principal === principal);
    },
  };
}

export interface StreamSlot {
  ok: true;
  /** Settles the lease that ended and reserves the next; false when the hour is spent. */
  lease(): boolean;
  /** This stream got session.expiring: its principal may open one replacement. */
  expiring(): void;
  /** Settles and releases; returns the seconds this stream used. */
  done(): number;
}
type Refusal = { ok: false; reason: "busy" | "budget"; retryAfterMs: number };

export function createStreamBudget(opts: { maxSecondsPerHour?: number; perPrincipal?: number; perHarness?: number; now?: () => number } = {}) {
  const maxSeconds = opts.maxSecondsPerHour ?? HOUR_MS / 1000;
  const perPrincipal = opts.perPrincipal ?? 1;
  const perHarness = opts.perHarness ?? 2;
  const now = opts.now ?? Date.now;
  const leaseS = LEASE_MS / 1000;
  const open = new Map<string, { count: number; expiring: number }>();
  let spent: Array<[number, number]> = [];
  let reserved = 0;
  const used = (at: number) => {
    spent = spent.filter(([when]) => when > at - HOUR_MS);
    return spent.reduce((n, [, s]) => n + s, 0) + reserved; // open leases count (FS-09)
  };
  const check = (principal: string, replacing: boolean): { ok: true } | Refusal => {
    const at = now();
    const mine = open.get(principal) ?? { count: 0, expiring: 0 };
    const total = [...open.values()].reduce((a, b) => a + b.count, 0);
    const extra = replacing && mine.expiring > 0 ? 1 : 0;
    if (mine.count >= perPrincipal + extra || total >= perHarness + extra) return { ok: false, reason: "busy", retryAfterMs: 5_000 };
    if (used(at) + leaseS > maxSeconds) {
      // when open reservations alone block, a lease frees within a minute; only
      // settled seconds make the caller wait for the window to roll
      const settledBlocks = used(at) - reserved + leaseS > maxSeconds;
      const rolls = Math.max(1_000, (spent[0]?.[0] ?? at) + HOUR_MS - at);
      return { ok: false, reason: "budget", retryAfterMs: settledBlocks ? rolls : Math.min(rolls, LEASE_MS) };
    }
    return { ok: true };
  };
  return {
    /** Read-only: what begin() would answer now. */
    probe: (principal: string, replacing = false) => check(principal, replacing),
    begin(principal: string, replacing = false): StreamSlot | Refusal {
      const verdict = check(principal, replacing);
      if (!verdict.ok) return verdict;
      const mine = open.get(principal) ?? { count: 0, expiring: 0 };
      mine.count += 1;
      open.set(principal, mine);
      reserved += leaseS;
      let held = true;
      const startedAt = now();
      let total = 0;
      let isExpiring = false;
      let closed = false;
      // cumulative: each settlement is the ceiling of the whole stream's seconds
      // minus what earlier leases settled, so rounding never accumulates (Astra I19)
      const settle = (t: number) => {
        if (!held) return;
        const through = Math.ceil((t - startedAt) / 1000);
        spent.push([t, through - total]);
        reserved -= leaseS;
        held = false;
        total = through;
      };
      return {
        ok: true,
        lease() {
          if (closed) return false;
          const t = now();
          settle(t);
          if (used(t) + leaseS > maxSeconds) return false;
          reserved += leaseS;
          held = true;
          return true;
        },
        expiring() {
          if (isExpiring || closed) return;
          isExpiring = true;
          mine.expiring += 1;
        },
        done() {
          if (closed) return 0;
          closed = true;
          settle(now());
          mine.count = Math.max(0, mine.count - 1);
          if (isExpiring) mine.expiring = Math.max(0, mine.expiring - 1);
          return total;
        },
      };
    },
  };
}

export interface StreamRouteDeps {
  enabled(): boolean;
  /** Credentials are changing or the harness is stopping: no new streams. */
  busy(): boolean;
  fluxKey(): string | null;
  ticketPrincipal(req: IncomingMessage): string | null;
  upgradePrincipal(req: IncomingMessage): string | null;
  tickets: ReturnType<typeof createTicketStore>;
  budget: ReturnType<typeof createStreamBudget>;
  /** Extra admission for the upgrade (loopback Host, allowed Origin), beside the ticket. */
  admitUpgrade?(req: IncomingMessage): boolean;
  /** Test seam: how long a restart waits for Flux before forcing the close. */
  restartDeadlineMs?: number;
  open?: typeof openFluxStream;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

/** What the page is told when the Flux handshake itself fails. The decision
 *  keys on closeCode (4000 plus the HTTP status), never on error.close_code,
 *  which is 4502 for every non-503 handshake failure. */
function pageErrorFor(e: FluxStreamRefused | null): StreamError {
  if (!e) return fatal("capability_unavailable", "Couldn't reach Flux");
  switch (failureForClose(e.closeCode)) {
    case "auth":
      return fatal("unauthorized", "Flux did not accept the workspace key");
    case "premium":
      return fatal("premium_locked", "streaming voice needs a paid Flux plan");
    case "rate_limit":
      return fatal("rate_limit_error", "Flux is rate limiting; try again shortly");
    case "format":
      return fatal("invalid_param", "Flux refused the audio format");
    default:
      return e.closeCode === 4503 && e.error ? e.error : fatal("capability_unavailable", "Couldn't reach Flux");
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
}

export async function handleStreamTicketRoute(method: string, url: URL, req: IncomingMessage, res: ServerResponse, deps: StreamRouteDeps): Promise<boolean> {
  if (url.pathname !== STREAM_TICKET_PATH) return false;
  if (method !== "POST") {
    res.setHeader("allow", "POST");
    json(res, 405, { error: "POST to this route" });
    return true;
  }
  const principal = deps.ticketPrincipal(req);
  if (!principal) return json(res, 403, { error: "calls need a paired device" }), true;
  if (!deps.enabled()) return json(res, 409, { error: "Streaming voice is not switched on.", reason: "unavailable" }), true;
  if (!deps.fluxKey()) return json(res, 409, { error: "Add a Flux key in Settings on the computer to turn on voice.", reason: "key" }), true;
  if (deps.busy()) return json(res, 409, { error: "Credentials are being changed. Try again shortly.", reason: "busy" }), true;
  const replacing = url.searchParams.get("replace") === "1";
  const probe = deps.budget.probe(principal, replacing);
  if (!probe.ok) {
    res.setHeader("retry-after", String(Math.ceil(probe.retryAfterMs / 1000)));
    json(res, 429, { error: probe.reason === "busy" ? "A call is already streaming." : "Streaming voice has used its hourly allowance.", reason: probe.reason });
    return true;
  }
  json(res, 200, { ticket: deps.tickets.mint(principal), expiresInMs: TICKET_TTL_MS, path: STREAM_WS_PATH });
  return true;
}

// ws calls handleProtocols only when the page offered subprotocols. Echo an
// unknown offer so the page can read unsupported_protocol (contract A.1).
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAGE_MESSAGE, handleProtocols: (p) => (p.has(SUBPROTOCOL) ? SUBPROTOCOL : ([...p][0] ?? false)) });
const live = new Set<() => Promise<void>>();

/** How many streams are open or still connecting. */
export function openStreamCount(): number {
  return live.size;
}

/** Close every open stream with session.closed going_away and 1001 so pages
 *  reconnect (and the harness reads the key again). Each stream gets a
 *  deadline: a Flux that ignores session.close is closed by force. Resolves
 *  with how many were open once every relay has finished. */
export async function closeAllStreams(): Promise<number> {
  const closers = [...live];
  await Promise.all(closers.map((close) => close()));
  return closers.length;
}

/** Returns false for any other path, so the caller destroys the socket. */
export function handleStreamUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, deps: StreamRouteDeps): boolean {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== STREAM_WS_PATH) return false;
  if (deps.admitUpgrade && !deps.admitUpgrade(req)) return false;
  const principal = deps.upgradePrincipal(req);
  wss.handleUpgrade(req, socket, head, (ws) => relay(ws, url, principal, deps));
  return true;
}

/** Synchronous up to the first await: every page listener is attached, and the
 *  relay is registered for closeAllStreams(), before Flux is contacted
 *  (FS-32, Astra I16). */
function relay(page: WebSocket, url: URL, principal: string | null, deps: StreamRouteDeps): void {
  const log = deps.log ?? ((line: string) => console.warn(line));
  // one ordered queue of audio and controls until Flux is open (Astra I10)
  const early: Array<{ audio: Buffer } | { control: ClientMessage }> = [];
  let earlyBytes = 0;
  let flux: FluxStream | null = null;
  let pageGone = false;
  let goingAway = false;
  let frames = 0;
  let lastSeq = 0;
  let lastReceived = 0;
  let relayedClosed = false;
  let draining = false;
  let restart: Promise<void> | null = null;
  let forced: () => void = () => undefined;
  const forcedClose = new Promise<void>((resolve) => (forced = resolve));
  const abort = new AbortController();
  const pageClosed = new Promise<void>((resolve) => {
    if (page.readyState === page.CLOSED) resolve();
    else page.once("close", () => resolve());
  });
  const pauseRead = () => (page as unknown as { _socket?: { pause(): void } })._socket?.pause();
  const resumeRead = () => (page as unknown as { _socket?: { resume(): void } })._socket?.resume();
  const refuse = (error: StreamError, code = error.close_code ?? 4500) => {
    resumeRead(); // a read paused while Flux connected would never see the page's close frame
    if (page.readyState !== page.OPEN) return;
    lastSeq += 1;
    page.send(JSON.stringify({ type: "error", seq: lastSeq, received_audio_ms: lastReceived, error }));
    page.close(code, error.code);
  };
  /** The page is told going_away (once) and closed 1001; a page that does not
   *  answer the close frame is cut after a short grace. */
  const endForRestart = () => {
    resumeRead();
    if (page.readyState !== page.OPEN) return;
    if (!relayedClosed) {
      relayedClosed = true;
      lastSeq += 1;
      const seconds = Math.round(lastReceived / 1000);
      page.send(JSON.stringify({
        type: "session.closed", seq: lastSeq, received_audio_ms: lastReceived, reason: "going_away",
        usage: { session_seconds: seconds, audio_seconds: seconds, billed_seconds: 0, confirmed_seconds: 0, pending_seconds: 0, unit: "session_second" },
      }));
    }
    page.close(1001, "going_away");
    const cut = setTimeout(() => page.terminate(), PAGE_CLOSE_GRACE_MS);
    cut.unref?.();
    void pageClosed.then(() => clearTimeout(cut));
  };
  const closeForRestart = (): Promise<void> => {
    if (restart) return restart;
    goingAway = true;
    if (flux) {
      const stream = flux;
      stream.sendJson({ type: "session.close" }); // Flux flushes the open turn, then closes
      // an unresponsive Flux must not keep the old key alive: force the close at the deadline
      const timer = setTimeout(() => {
        stream.close();
        forced(); // the relay stops waiting for a Flux that will not answer
        endForRestart();
      }, deps.restartDeadlineMs ?? RESTART_DEADLINE_MS);
      timer.unref?.();
      void pageClosed.then(() => clearTimeout(timer));
    } else {
      abort.abort(); // still connecting: stop, and the page is told in the catch below
      if (page.readyState === page.OPEN && !flux) endForRestart();
    }
    restart = pageClosed;
    return restart;
  };
  live.add(closeForRestart);

  page.on("message", (data, binary) => {
    if (binary) {
      const buf = data as Buffer;
      if (!flux) {
        early.push({ audio: buf });
        earlyBytes += buf.length;
        // over 3 s queued: stop reading, so the page's own uplink drops what it
        // cannot send and knows it (its clock stays exact)
        if (earlyBytes > LIMITS.prestartBufferMs * 32) pauseRead();
        return;
      }
      frames += 1;
      flux.send(buf);
      if (flux.bufferedAmount() > FLUX_BACKLOG_BYTES && !draining) {
        draining = true;
        pauseRead();
        const wait = setInterval(() => {
          if (!flux || flux.bufferedAmount() <= FLUX_BACKLOG_BYTES / 2 || pageGone) {
            clearInterval(wait);
            draining = false;
            resumeRead();
          }
        }, 20);
      }
      return;
    }
    const msg = parseClientMessage(String(data));
    if ("invalid" in msg) return;
    let out: ClientMessage = msg;
    if (msg.type === "session.update") {
      const config = Object.fromEntries(Object.entries(msg.config).filter(([k]) => PAGE_CONFIG_FIELDS.has(k)));
      if (!Object.keys(config).length) return;
      out = { type: "session.update", config };
    }
    if (flux) flux.sendJson(out);
    else {
      early.push({ control: out }); // at its place between the frames around it
      earlyBytes += String(data).length;
      if (earlyBytes > LIMITS.prestartBufferMs * 32) pauseRead();
    }
  });
  // an oversize page message (maxPayload) is an error event, then a 1009 close;
  // unhandled, it would throw out of the harness
  page.on("error", () => undefined);
  page.on("close", () => {
    pageGone = true;
    abort.abort();
    flux?.close();
  });

  void (async () => {
    const ticket = url.searchParams.get("ticket") ?? "";
    if (!principal || !deps.tickets.redeem(ticket, principal)) {
      live.delete(closeForRestart);
      return refuse(fatal("unauthorized", "that stream ticket is not valid"));
    }
    // admission again at redemption: a ticket minted before a credential change,
    // or before streaming was switched off, must not open now (Astra I16)
    const key = deps.fluxKey();
    if (!deps.enabled() || deps.busy() || !key) {
      live.delete(closeForRestart);
      return refuse(fatal("service_unavailable", "voice settings are changing on the computer; try again", { retry_after_ms: 2000 }));
    }
    const replacing = url.searchParams.get("replace") === "1";
    const slot = deps.budget.begin(principal, replacing);
    if (!slot.ok) {
      live.delete(closeForRestart);
      return refuse(fatal(slot.reason === "busy" ? "concurrency_limit" : "seconds_limit", "streaming allowance reached", { retry_after_ms: slot.retryAfterMs }));
    }
    const door = principal === "desktop" ? "desktop" : "companion";

    const query = new URLSearchParams();
    for (const [name, value] of url.searchParams) {
      if (PAGE_QUERY.has(name) || (name.startsWith("sim_") && deps.env?.MURAGE_FLUX_STREAM_API?.startsWith("ws://127.0.0.1"))) query.append(name, value);
    }
    // staging only: a Flux test fault for the device acceptance (spec F step 10 on real Flux)
    const fault = deps.env?.MURAGE_FLUX_TEST_FAULT;
    const base = deps.env?.MURAGE_FLUX_STREAM_API;
    query.set("sample_rate", "16000");
    query.set("idle_timeout_s", "30");

    let stream: FluxStream;
    try {
      // inside the try: an unparsable base refuses this stream and frees its slot
      if (fault && base && new URL(base).host !== "api.fluxrouter.ai") query.set("flux_test_fault", fault); // never production
      stream = await (deps.open ?? openFluxStream)({ key, query, env: deps.env, signal: abort.signal });
    } catch (error) {
      live.delete(closeForRestart);
      const seconds = slot.done();
      const e = error instanceof FluxStreamRefused ? error : null;
      log(`[voice-stream] refused door=${door} code=${e?.closeCode ?? 4502} billed=${seconds}s`);
      if (goingAway) return endForRestart();
      return refuse(pageErrorFor(e));
    }
    if (pageGone || goingAway) {
      live.delete(closeForRestart);
      stream.close();
      slot.done();
      if (goingAway) endForRestart();
      return;
    }
    flux = stream;
    for (const item of early) {
      if ("audio" in item) {
        stream.send(item.audio);
        frames += 1;
      } else stream.sendJson(item.control);
    }
    early.length = 0;
    earlyBytes = 0;
    resumeRead();
    log(`[voice-stream] open door=${door}`);

    const lease = setInterval(() => {
      if (!slot.lease()) {
        refuse(fatal("seconds_limit", "streaming voice has used its hourly allowance"));
        stream.close();
      }
    }, LEASE_MS);

    stream.onMessage((raw, msg) => {
      lastSeq = msg.seq;
      lastReceived = msg.received_audio_ms;
      if (msg.type === "session.expiring") slot.expiring();
      if (page.readyState !== page.OPEN) return;
      if (page.bufferedAmount > SLOW_CONSUMER_BYTES) {
        refuse(fatal("slow_consumer", "the page is not reading its messages"));
        stream.close();
        return;
      }
      // a restart the harness asked for: the page is told the reason it acts on (Astra I16)
      if (msg.type === "session.closed") relayedClosed = true;
      page.send(goingAway && msg.type === "session.closed" ? JSON.stringify({ ...msg, reason: "going_away" }) : raw);
    });

    const closed = await Promise.race([stream.closed, forcedClose.then(() => ({ code: 1001, reason: "going_away", error: null }))]);
    live.delete(closeForRestart);
    clearInterval(lease);
    const seconds = slot.done();
    log(`[voice-stream] close code=${closed.code} frames=${frames} billed=${seconds}s`);
    if (page.readyState !== page.OPEN) return;
    if (goingAway) return endForRestart();
    // 1005 and 1006 cannot be sent in a close frame; a Flux socket that
    // vanished without one is, to the page, an unavailable provider.
    if (closed.code === 1000 || closed.code === 1001 || closed.code === 1012 || closed.code >= 4000) return page.close(closed.code, trimCloseReason(closed.reason));
    refuse(fatal("capability_unavailable", "the connection to Flux dropped"));
  })();
}
