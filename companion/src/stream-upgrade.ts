// Websocket forwarding for exactly one path: the call's streaming voice.
// The door that calls this has already decided who is asking (browser door:
// origin gate and cookie session; device door: bearer). This file forwards
// as the companion: loopback Host, the launch proof, the principal the door
// resolved, and nothing the client sent except the websocket handshake
// headers. The harness's single-use ticket, bound to the same principal, is
// the second factor. The forwarder owns the attempt from its first byte: a
// client that leaves, a revocation or a harness that never answers all end it
// and free its slot, before and after the upgrade (Astra I17).
import { request as httpRequest, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

export const STREAM_UPGRADE_PATH = "/api/voice/stream";
const HOP_HEADERS = ["sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions"];
const HANDSHAKE_MS = 10_000;
const RECHECK_MS = 30_000;
const REJECT_GRACE_MS = 1_000;
const SECRET_QUERY = ["ticket", "keyterms", "client_token"];

const STATUS: Record<number, string> = { 401: "Unauthorized", 403: "Forbidden", 426: "Upgrade Required", 429: "Too Many Requests", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout" };

export function rejectUpgrade(socket: Duplex, status: number, error: string): void {
  if (socket.destroyed) return;
  // Node drops its own error listener once a socket is handed to an upgrade
  // handler: a reset after the refusal would otherwise be uncaught.
  if (socket.listenerCount("error") === 0) socket.on("error", () => socket.destroy());
  const body = JSON.stringify({ error });
  // an http server's sockets are half-open, so end() alone waits for the peer
  setTimeout(() => socket.destroy(), REJECT_GRACE_MS).unref();
  socket.end(`HTTP/1.1 ${status} ${STATUS[status] ?? "Error"}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
}

/** The path and query with the ticket and keyterms masked, for anything that logs a URL (Astra I20). */
export function redactStreamQuery(url: string | undefined): string {
  const u = new URL(url ?? "/", "http://door");
  for (const name of SECRET_QUERY) if (u.searchParams.has(name)) u.searchParams.set(name, "redacted");
  return `${u.pathname}${u.search}`;
}

/** The same request with a redacted url, for code (originGate's diagnostics) that may log it. */
export function redactedRequest(req: IncomingMessage): IncomingMessage {
  return Object.assign(Object.create(req) as IncomingMessage, { url: redactStreamQuery(req.url) });
}

export function forwardStreamUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  opts: {
    harnessPort: number;
    companionToken: string;
    principal: string;
    slots: Map<string, number>;
    maxOpen: number;
    /** Registers with the door's connection tracker; returns the release. */
    onOpen?: (disconnect: () => void) => () => void;
    /** The session or device is still authorised. */
    live?: () => boolean;
    /** When the session must next be checked (ms epoch), or null; the recheck is armed to it. */
    deadline?: () => number | null;
    /** Tests only. */
    handshakeMs?: number;
  },
): void {
  const url = new URL(req.url ?? "/", "http://device");
  if (req.method !== "GET" || url.pathname !== STREAM_UPGRADE_PATH) return void socket.destroy();
  if ((opts.slots.get(opts.principal) ?? 0) >= opts.maxOpen) return rejectUpgrade(socket, 429, "a call is already streaming");
  const headers: Record<string, string> = {
    connection: "Upgrade",
    upgrade: "websocket",
    host: `127.0.0.1:${opts.harnessPort}`,
    "x-murage-companion": "1",
    "x-murage-companion-token": opts.companionToken,
    "x-murage-stream-principal": opts.principal,
  };
  for (const name of HOP_HEADERS) {
    const value = req.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  opts.slots.set(opts.principal, (opts.slots.get(opts.principal) ?? 0) + 1);
  let released = false;
  let upgraded = false;
  let refused = false;
  let untrack: (() => void) | null = null;
  let recheck: ReturnType<typeof setTimeout> | null = null;
  const upstream = httpRequest({ host: "127.0.0.1", port: opts.harnessPort, path: `${url.pathname}${url.search}`, method: "GET", headers });
  const release = () => {
    if (released) return;
    released = true;
    if (recheck) clearTimeout(recheck);
    untrack?.();
    untrack = null;
    opts.slots.set(opts.principal, Math.max(0, (opts.slots.get(opts.principal) ?? 1) - 1));
  };
  const abandon = () => {
    if (upgraded) return;
    upstream.destroy();
    socket.destroy();
    release();
  };
  // owned from the start: a client gone, or a revocation, during the handshake.
  // An http server's sockets are half-open, so a client that leaves shows up
  // as `end` first; `close` would wait for this side to end too.
  socket.once("end", abandon);
  socket.once("close", abandon);
  socket.once("error", abandon);
  untrack = opts.onOpen?.(() => {
    upstream.destroy();
    socket.destroy();
    release();
  }) ?? null;
  upstream.setTimeout(opts.handshakeMs ?? HANDSHAKE_MS, () => {
    if (upgraded) return;
    // the refusal is delivered and the socket closed by rejectUpgrade's grace timer
    refused = true;
    upstream.destroy();
    rejectUpgrade(socket, 504, "the harness did not answer");
    release();
  });
  upstream.on("upgrade", (res, harnessSocket, harnessHead) => {
    // checked again right before the client is let through
    if (socket.destroyed || (opts.live && !opts.live())) {
      harnessSocket.destroy();
      rejectUpgrade(socket, 401, "sign in");
      release();
      return;
    }
    upgraded = true;
    const lines = [`HTTP/1.1 ${res.statusCode} ${res.statusMessage}`];
    for (let i = 0; i < res.rawHeaders.length; i += 2) lines.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}`);
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (harnessHead.length) socket.write(harnessHead);
    if (head.length) harnessSocket.write(head);
    harnessSocket.pipe(socket).pipe(harnessSocket);
    const end = () => {
      release();
      harnessSocket.destroy();
      socket.destroy();
    };
    // a revoked device or ended session takes this socket with it
    untrack?.();
    untrack = opts.onOpen?.(end) ?? null;
    if (opts.live) {
      // armed to the session's own deadline, like the event stream, so a
      // stream cannot outlive its session by the polling interval
      const arm = () => {
        const due = opts.deadline?.();
        const wait = due == null ? RECHECK_MS : Math.max(250, Math.min(RECHECK_MS, due - Date.now() + 5));
        recheck = setTimeout(() => (opts.live!() ? arm() : end()), wait);
        recheck.unref();
      };
      arm();
    }
    for (const s of [harnessSocket, socket]) {
      s.on("close", end);
      s.on("error", end);
    }
  });
  upstream.on("response", (res) => {
    refused = true;
    res.resume();
    upstream.destroy();
    rejectUpgrade(socket, res.statusCode ?? 502, "the harness refused the stream");
    release();
  });
  upstream.on("error", () => {
    if (refused) return; // already answered; destroying the request raises this
    refused = true;
    rejectUpgrade(socket, 502, "the harness is not reachable");
    release();
  });
  upstream.end();
}
