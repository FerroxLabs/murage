// src/lib/stream-uplink.ts
// The page's end of streaming voice (spec C.5): a ticket over the ordinary
// fetch path, then a same-origin websocket to the harness, which holds the
// Flux key. This file never sees a key. One instance per connect.
import { SUBPROTOCOL, parseServerMessage, type ServerMessage, type StreamError } from "../../shared/flux-stream-contract";
import { desktopSurfaceHeaders, ensureDesktopSurfaceSecret } from "./live-events";

/** About one second of 16 kHz PCM. Past this the socket is backed up and a
 *  call is better served by dropping stale audio than by sending it late. */
const MAX_BUFFERED = 32 * 1024;
/** The whole connect (ticket, then the websocket handshake) has this long
 *  (spec C.3's handshake deadline); past it the connect is abandoned. */
const CONNECT_DEADLINE_MS = 10_000;
/** After session.close the harness gives Flux 2 s, then closes the page itself;
 *  past this the page forces the close so nothing waits forever. */
const CLOSE_GRACE_MS = 2_500;
const RESERVED_QUERY = new Set(["ticket", "replace"]);

export class UplinkRefused extends Error {
  readonly status: number;
  readonly reason: string | null;
  /** The server's retry-after, in ms (a 429 carries it as a header); null when absent. */
  readonly retryAfterMs: number | null;
  constructor(status: number, reason: string | null, message: string, retryAfterMs: number | null = null) {
    super(message);
    this.status = status;
    this.reason = reason;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface UplinkOptions {
  fetchImpl?: typeof fetch;
  WebSocketImpl?: typeof WebSocket;
  origin?: { protocol: string; host: string };
  maxBufferedBytes?: number;
  /** The desktop's surface proof, as every desktop request sends it (inert on a phone). */
  ticketHeaders?: () => Promise<Record<string, string>>;
  connectDeadlineMs?: number;
}

type CloseInfo = { code: number; error: StreamError | null };

async function desktopHeaders(): Promise<Record<string, string>> {
  await ensureDesktopSurfaceSecret();
  return { "x-murage-surface": "desktop", ...desktopSurfaceHeaders() };
}

/** `work`, unless `signal` aborts first (then `stopped()` is thrown). The work
 *  itself is left running: it may be shared. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal, stopped: () => Error): Promise<T> {
  if (signal.aborted) return Promise.reject(stopped());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(stopped());
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => (signal.removeEventListener("abort", onAbort), resolve(value)),
      (error) => (signal.removeEventListener("abort", onAbort), reject(error)),
    );
  });
}

export class StreamUplink {
  private ws: WebSocket | null = null;
  private readonly opts: UplinkOptions;
  private readonly messages = new Set<(m: ServerMessage) => void>();
  private readonly closes = new Set<(c: CloseInfo) => void>();
  private held: ServerMessage[] = [];
  private lastError: StreamError | null = null;
  private droppedFrames = 0;
  /** Cancels a connect in flight: close() before `open`, or the deadline (Astra 2 I8). */
  private readonly abort = new AbortController();
  private closed = false;
  private started = false;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: UplinkOptions = {}) {
    this.opts = opts;
  }

  get dropped() {
    return this.droppedFrames;
  }

  get live() {
    return this.ws !== null && this.ws.readyState === 1;
  }

  async connect(query: Record<string, string | string[]> = {}, opts: { replace?: boolean } = {}): Promise<void> {
    const signal = this.abort.signal;
    const stopped = () => new UplinkRefused(0, signal.reason === "timeout" ? "timeout" : "closed", `stream connect ${signal.reason === "timeout" ? "timed out" : "cancelled"}`);
    if (this.closed) throw stopped();
    // one instance, one connect: a second would overwrite the socket and let an
    // old socket's close reach the new stream's handlers (FS-39)
    if (this.started) throw new UplinkRefused(0, "reused", "a stream uplink connects once");
    this.started = true;
    const deadline = setTimeout(() => this.abort.abort("timeout"), this.opts.connectDeadlineMs ?? CONNECT_DEADLINE_MS);
    try {
      const call = this.opts.fetchImpl ?? fetch;
      // the header wait is raced, not cancelled: the desktop secret request is
      // shared with the rest of the page (Astra 3 I5)
      const headers = await untilAborted((this.opts.ticketHeaders ?? desktopHeaders)(), signal, stopped);
      const res = await call(`/api/voice/stream/ticket${opts.replace ? "?replace=1" : ""}`, { method: "POST", headers, signal });
      const body = (await res.json().catch(() => null)) as { ticket?: string; path?: string; reason?: string; error?: string } | null;
      if (signal.aborted) throw stopped();
      if (!res.ok || !body?.ticket) {
        const seconds = Number(res.headers.get("retry-after"));
        const retryAfterMs = res.headers.get("retry-after") !== null && Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
        throw new UplinkRefused(res.status, body?.reason ?? null, body?.error ?? `ticket ${res.status}`, retryAfterMs);
      }
      const path = body.path ?? "/api/voice/stream";
      if (!/^\/(?![/\\])/.test(path)) throw new UplinkRefused(res.status, "bad_path", "ticket named an invalid stream path");
      const origin = this.opts.origin ?? window.location;
      const q = new URLSearchParams({ ticket: body.ticket });
      if (opts.replace) q.set("replace", "1");
      for (const [k, v] of Object.entries(query)) if (!RESERVED_QUERY.has(k)) for (const item of [v].flat()) q.append(k, item);
      const scheme = origin.protocol === "https:" ? "wss:" : "ws:";
      const Impl = this.opts.WebSocketImpl ?? WebSocket;
      const ws = new Impl(`${scheme}//${origin.host}${path}?${q}`, [SUBPROTOCOL]);
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      this.lastError = null;
      // listeners first: nothing that arrives with or right after `open` is lost
      ws.addEventListener("message", (e) => {
        if (typeof (e as MessageEvent).data !== "string") return;
        const msg = parseServerMessage((e as MessageEvent).data);
        if (!msg) return;
        if (msg.type === "error" && msg.error.fatal) this.lastError = msg.error;
        if (!this.messages.size) this.held.push(msg);
        else for (const fn of [...this.messages]) fn(msg);
      });
      let opened = false;
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          ws.close();
          reject(stopped());
        };
        signal.addEventListener("abort", onAbort, { once: true });
        ws.addEventListener("open", () => {
          signal.removeEventListener("abort", onAbort);
          opened = true;
          resolve();
        });
        ws.addEventListener("close", (e) => {
          if (this.ws === ws) this.ws = null;
          if (!opened) return reject(signal.aborted ? stopped() : new UplinkRefused(0, String((e as CloseEvent).code), "stream closed before it opened"));
          const info = { code: (e as CloseEvent).code, error: this.lastError };
          for (const fn of [...this.closes]) fn(info);
        });
        ws.addEventListener("error", () => {
          if (!opened) reject(new UplinkRefused(0, null, "stream could not open"));
        });
      });
    } catch (error) {
      // a fetch aborted by close() or the deadline rejects with its own error
      throw signal.aborted && !(error instanceof UplinkRefused) ? stopped() : error;
    } finally {
      clearTimeout(deadline);
    }
  }

  send(pcm: Int16Array): boolean {
    const ws = this.ws;
    if (this.closed || !ws || ws.readyState !== 1) return false;
    if (ws.bufferedAmount > (this.opts.maxBufferedBytes ?? MAX_BUFFERED)) {
      this.droppedFrames += 1;
      return false;
    }
    ws.send(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength));
    return true;
  }

  commit() {
    this.json({ type: "turn.commit" });
  }

  keepalive() {
    this.json({ type: "keepalive" });
  }

  update(config: Record<string, unknown>) {
    this.json({ type: "session.update", config });
  }

  /** Ends the stream: a graceful `session.close` once open; before that, the
   *  connect in flight (ticket or handshake) is cancelled. */
  close() {
    this.closed = true;
    if (this.ws?.readyState === 1) {
      const ws = this.ws;
      this.json({ type: "session.close" });
      this.closeTimer ??= setTimeout(() => {
        if (ws.readyState === 1) ws.close();
      }, CLOSE_GRACE_MS);
      ws.addEventListener("close", () => {
        if (this.closeTimer) clearTimeout(this.closeTimer);
      });
      return;
    }
    this.abort.abort("closed");
    this.ws?.close();
  }

  onMessage(fn: (m: ServerMessage) => void) {
    this.messages.add(fn);
    const held = this.held;
    this.held = [];
    for (const m of held) fn(m);
    return () => this.messages.delete(fn);
  }

  onClose(fn: (c: CloseInfo) => void) {
    this.closes.add(fn);
    return () => this.closes.delete(fn);
  }

  private json(message: unknown) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(message));
  }
}
