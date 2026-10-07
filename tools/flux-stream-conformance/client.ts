// tools/flux-stream-conformance/client.ts
// A contract-A client that records every message with its receipt time and
// every audio frame with its send time (spec E.3).
import WebSocket from "ws";

import { SUBPROTOCOL, parseServerMessage, streamUrl, type ServerMessage } from "../../shared/flux-stream-contract.ts";

export interface Received {
  at: number;
  msg: ServerMessage;
}

export interface OpenOptions {
  key?: string | null;
  query?: Record<string, string | string[]>;
  protocols?: string[];
}

const FRAME_BYTES = 2048;
const FRAME_MS = 64;
const HANDSHAKE_MS = 10_000;

/** Every client not yet closed, so the runner can end whatever a failed
 *  check left open before the next check runs (Astra 2 I15). */
export const openClients = new Set<ConformanceClient>();

/** When this process last opened a connection to each base: the start-cap
 *  check waits for the run's own earlier starts to leave the server's 60 s window. */
export const lastOpenAt = new Map<string, number>();

export async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} did not arrive within ${ms} ms`)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

export class ConformanceClient {
  readonly ws: WebSocket;
  readonly messages: Received[] = [];
  readonly invalid: number[] = [];
  readonly closed: Promise<{ code: number; reason: string; at: number }>;
  readonly opened: Promise<void>;
  readonly openedAt = Date.now();
  /** Wall time each audio frame was sent; frame i holds audio [i*64, i*64+64) ms. */
  readonly sentAt: number[] = [];
  pings = 0;

  private constructor(url: string, options: OpenOptions) {
    this.ws = new WebSocket(url, options.protocols ?? [SUBPROTOCOL], { headers: options.key ? { authorization: `Bearer ${options.key}` } : {} });
    this.ws.on("message", (data, binary) => {
      if (binary) return;
      const msg = parseServerMessage(String(data));
      if (msg) this.messages.push({ at: Date.now(), msg });
      else this.invalid.push(Date.now());
    });
    this.ws.on("ping", () => (this.pings += 1));
    openClients.add(this);
    this.closed = new Promise((resolve) => this.ws.on("close", (code, reason) => {
      openClients.delete(this);
      resolve({ code, reason: String(reason), at: Date.now() });
    }));
    // bounded: a server that never completes the handshake fails the check (Astra 2 I15)
    this.opened = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`no handshake within ${HANDSHAKE_MS} ms`));
        this.ws.terminate();
      }, HANDSHAKE_MS);
      this.ws.once("open", () => (clearTimeout(timer), resolve()));
      this.ws.once("error", (e) => (clearTimeout(timer), reject(e)));
      this.ws.once("unexpected-response", (_req, res) => (clearTimeout(timer), reject(new Error(`http ${res.statusCode}`))));
    });
  }

  static async open(base: string, options: OpenOptions = {}): Promise<ConformanceClient> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(options.query ?? {})) for (const item of [v].flat()) q.append(k, item);
    lastOpenAt.set(base, Date.now());
    const client = new ConformanceClient(streamUrl(base, q), options);
    client.opened.catch(() => undefined);
    return client;
  }

  of<T extends ServerMessage["type"]>(type: T): Array<Received & { msg: Extract<ServerMessage, { type: T }> }> {
    return this.messages.filter((r) => r.msg.type === type) as Array<Received & { msg: Extract<ServerMessage, { type: T }> }>;
  }

  async waitFor(pred: (r: Received) => boolean, ms = 10_000): Promise<Received> {
    const end = Date.now() + ms;
    for (;;) {
      const hit = this.messages.find(pred);
      if (hit) return hit;
      if (Date.now() > end) throw new Error(`timed out after ${ms} ms`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /** Receipt time of session.started. */
  async started(ms = 15_000): Promise<number> {
    return (await this.waitFor((r) => r.msg.type === "session.started", ms)).at;
  }

  /** Real-time pacing in 64 ms frames, then trailing silence. Warm by
   *  default: waits for session.started (spec E.3). Returns this send's
   *  origin: the index of its first frame, for sentTimeOf (Astra 2 I11). */
  async sendPaced(pcm: Buffer, opts: { early?: boolean; trailingSilenceMs?: number } = {}): Promise<number> {
    await this.opened;
    if (!opts.early) await this.started();
    const origin = this.sentAt.length;
    const silence = Buffer.alloc(FRAME_BYTES);
    const total = pcm.length + Math.round((opts.trailingSilenceMs ?? 3000) * 32);
    const start = Date.now();
    for (let off = 0, n = 0; off < total; off += FRAME_BYTES, n += 1) {
      if (this.ws.readyState !== WebSocket.OPEN) return origin;
      const chunk = off < pcm.length ? pcm.subarray(off, off + FRAME_BYTES) : silence;
      this.sentAt.push(Date.now());
      this.ws.send(chunk.length === FRAME_BYTES ? chunk : Buffer.concat([chunk, Buffer.alloc(FRAME_BYTES - chunk.length)]));
      const due = start + (n + 1) * FRAME_MS;
      await new Promise((r) => setTimeout(r, Math.max(0, due - Date.now())));
    }
    return origin;
  }

  /** When the frame holding position `audioMs` of the send that began at
   *  frame `origin` (sendPaced's return) left this client. */
  sentTimeOf(audioMs: number, origin = 0): number {
    const k = Math.max(0, Math.floor(audioMs / FRAME_MS));
    const i = Math.min(this.sentAt.length - 1, origin + k);
    return this.sentAt[i] + (audioMs - k * FRAME_MS);
  }

  sendJson(o: unknown) {
    this.ws.send(JSON.stringify(o));
  }

  sendRaw(b: Buffer) {
    this.ws.send(b);
  }

  /** Stop reading: the server's writes back up (B02). */
  pauseReading() {
    (this.ws as unknown as { _socket: { pause(): void } })._socket.pause();
  }

  async rtt(ms = 5000): Promise<number> {
    await this.opened;
    const t = Date.now();
    await within(new Promise<void>((resolve) => {
      this.ws.once("pong", () => resolve());
      this.ws.ping();
    }), ms, "the pong");
    return Date.now() - t;
  }

  /** The close, or a failure after `ms` (the socket is terminated): a stuck
   *  server can never hang an acceptance run (Astra I18). */
  async closedWithin(ms = 15_000): Promise<{ code: number; reason: string; at: number }> {
    try {
      return await within(this.closed, ms, "the close");
    } catch (error) {
      this.ws.terminate();
      throw error;
    }
  }

  close() {
    if (this.ws.readyState === WebSocket.OPEN) this.sendJson({ type: "session.close" });
  }

  /** Ends the socket now, whatever state it is in. */
  dispose() {
    this.ws.terminate();
    openClients.delete(this);
  }
}
