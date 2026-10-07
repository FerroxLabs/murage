// The harness's side of Flux streaming transcription (spec C.3). Opens
// wss://…/v1/audio/transcriptions/stream with the workspace's Flux key as a
// Bearer header. The key goes in that header and nowhere else.
import WebSocket from "ws";

import {
  HANDSHAKE_TIMEOUT_MS,
  SUBPROTOCOL,
  fatal,
  parseServerMessage,
  streamUrl,
  type ClientMessage,
  type ServerMessage,
  type StreamError,
} from "../../shared/flux-stream-contract.ts";
import type { TranscriptionFailure } from "./flux-voice.ts";

/** Read per call, never at module load (see flux-voice.ts apiBase). */
export function fluxStreamBase(env: NodeJS.ProcessEnv = process.env): string {
  return env.MURAGE_FLUX_STREAM_API || "wss://api.fluxrouter.ai/v1";
}

export class FluxStreamRefused extends Error {
  readonly closeCode: number;
  readonly error: StreamError | null;
  constructor(closeCode: number, error: StreamError | null, message: string) {
    super(message);
    this.closeCode = closeCode;
    this.error = error;
  }
}

export interface FluxStream {
  send(pcm: Buffer): void;
  sendJson(message: ClientMessage): void;
  bufferedAmount(): number;
  onMessage(fn: (raw: string, message: ServerMessage) => void): () => void;
  readonly closed: Promise<{ code: number; reason: string; error: StreamError | null }>;
  close(code?: number): void;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

function isSecureOrLoopback(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "wss:") return true;
    return parsed.protocol === "ws:" && LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function failureForClose(code: number): TranscriptionFailure {
  if (code === 4401) return "auth";
  if (code === 4402) return "premium";
  if (code === 4403 || code === 4404) return "unavailable";
  if (code === 4429) return "rate_limit";
  if (code === 4400 || code === 4413) return "format";
  return "upstream";
}

export async function openFluxStream(opts: { key: string; query: URLSearchParams; env?: NodeJS.ProcessEnv; handshakeMs?: number; signal?: AbortSignal }): Promise<FluxStream> {
  if (opts.signal?.aborted) throw new FluxStreamRefused(4502, fatal("capability_unavailable", "the call ended"), "aborted");
  const url = streamUrl(fluxStreamBase(opts.env), opts.query);
  // the Bearer key must never travel in cleartext to a remote host
  if (!isSecureOrLoopback(url)) {
    throw new FluxStreamRefused(4502, fatal("capability_unavailable", "Flux streaming base must be wss://"), "the Flux streaming base must be wss:// (cleartext ws:// is allowed only to a loopback host)");
  }
  const ws = new WebSocket(url, [SUBPROTOCOL], {
    headers: { authorization: `Bearer ${opts.key}` },
    handshakeTimeout: opts.handshakeMs ?? HANDSHAKE_TIMEOUT_MS,
    maxPayload: 1024 * 1024,
  });
  ws.on("error", () => undefined); // surfaced through open/close below
  const listeners = new Set<(raw: string, message: ServerMessage) => void>();
  // messages that arrive before anyone subscribes are held, not lost (Astra I16)
  const held: Array<[string, ServerMessage]> = [];
  let lastError: StreamError | null = null;
  ws.on("message", (data, binary) => {
    if (binary) return;
    const raw = String(data);
    const message = parseServerMessage(raw);
    if (!message) return; // never forwarded unparsed
    if (message.type === "error" && message.error.fatal) lastError = message.error;
    if (!listeners.size) held.push([raw, message]);
    else for (const fn of [...listeners]) fn(raw, message);
  });
  const closed = new Promise<{ code: number; reason: string; error: StreamError | null }>((resolve) => {
    ws.on("close", (code, reason) => resolve({ code, reason: String(reason).slice(0, 120), error: lastError }));
  });
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      ws.terminate();
      reject(new FluxStreamRefused(4502, fatal("capability_unavailable", "the call ended"), "aborted"));
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    ws.once("open", () => {
      opts.signal?.removeEventListener("abort", onAbort);
      resolve();
    });
    ws.once("unexpected-response", (_req, res) => {
      opts.signal?.removeEventListener("abort", onAbort);
      const code = res.statusCode === 503 ? 4503 : 4000 + (res.statusCode ?? 500);
      reject(new FluxStreamRefused(code, fatal(code === 4503 ? "service_unavailable" : "capability_unavailable", `Flux answered ${res.statusCode}`), `http ${res.statusCode}`));
      ws.terminate();
    });
    ws.once("close", () => {
      opts.signal?.removeEventListener("abort", onAbort);
      reject(new FluxStreamRefused(4502, fatal("capability_unavailable", "Couldn't reach Flux"), "closed during handshake"));
    });
  });
  return {
    send(pcm) {
      if (ws.readyState === WebSocket.OPEN) ws.send(pcm, { binary: true });
    },
    sendJson(message) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    },
    bufferedAmount: () => ws.bufferedAmount,
    onMessage(fn) {
      listeners.add(fn);
      for (const [raw, message] of held.splice(0)) fn(raw, message);
      return () => listeners.delete(fn);
    },
    closed,
    close(code = 1000) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(code);
    },
  };
}
