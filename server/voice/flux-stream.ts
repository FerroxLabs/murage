import { classifyFluxRefusal } from "../../shared/flux-refusal.ts";
import { markBudgetReached, isBudgetReached } from "./voice-routes.ts";
// The harness's side of Flux streaming transcription (spec C.3). Opens
// wss://…/v1/audio/transcriptions/stream with the workspace's Flux key as a
// Bearer header. The key goes in that header and nowhere else.
import WebSocket from "ws";
import { Readable } from "node:stream";
import { withFluxCallHeaders } from "../flux-memory-headers.ts";
import { read402Body } from "./refusal-body.ts";

import {
  CALL_ADMISSION_UNKNOWN,
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
import { authorizeFluxDispatch } from "../flux-start-gate.ts";

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

export function failureForClose(code: number, reason: unknown = null): TranscriptionFailure {
  if (code === 4401) return "auth";
  const refusal = classifyFluxRefusal(code, reason);
  if (refusal !== "other") return refusal;
  if (code === 4403 || code === 4404) return "unavailable";
  if (code === 4429) return "rate_limit";
  if (code === 4400 || code === 4413) return "format";
  return "upstream";
}

export async function openFluxStream(opts: { key: string; query: URLSearchParams; env?: NodeJS.ProcessEnv; handshakeMs?: number; signal?: AbortSignal }): Promise<FluxStream> {
  if (opts.signal?.aborted) throw new FluxStreamRefused(4502, fatal("capability_unavailable", "the call ended"), "aborted");
  const baseUrl = fluxStreamBase(opts.env);
  const endpoint = { via: "flux" as const, label: "Flux", baseUrl, key: opts.key, model: "flux-voice-stream" };
  const budget = (status: number, body: unknown) => {
    if (classifyFluxRefusal(status, body) === "budget") markBudgetReached(endpoint);
  };
  const url = streamUrl(baseUrl, opts.query);
  // the Bearer key must never travel in cleartext to a remote host
  if (!isSecureOrLoopback(url)) {
    throw new FluxStreamRefused(4502, fatal("capability_unavailable", "Flux streaming base must be wss://"), "the Flux streaming base must be wss:// (cleartext ws:// is allowed only to a loopback host)");
  }
  if (isBudgetReached(endpoint)) throw new FluxStreamRefused(4402, fatal("key_budget_reached", "This Flux key has reached its budget"), "budget");
  await authorizeFluxDispatch(endpoint.key); // spend gate
  // Cancellation can arrive while the budget gate is checking this call.
  // Observe it before opening a socket or installing the handshake listener.
  if (opts.signal?.aborted) throw new FluxStreamRefused(4502, fatal("capability_unavailable", "the call ended"), "aborted");
  const ws = new WebSocket(url, [SUBPROTOCOL], {
    headers: withFluxCallHeaders("voice-stream", { authorization: `Bearer ${endpoint.key}` }),
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
    if (message.type === "error" && (message.error.fatal || classifyFluxRefusal(0, message.error) === "budget")) { lastError = message.error; budget(0, message.error); }
    if (!listeners.size) held.push([raw, message]);
    else for (const fn of [...listeners]) fn(raw, message);
    if (message.type === "error" && classifyFluxRefusal(0, message.error) === "budget") ws.close(1000);
  });
  const closed = new Promise<{ code: number; reason: string; error: StreamError | null }>((resolve) => {
    ws.on("close", (code, reason) => {
      const text = String(reason);
      budget(code, lastError ?? text);
      resolve({ code, reason: text, error: lastError });
    });
  });
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      ws.terminate();
      reject(new FluxStreamRefused(4502, fatal("capability_unavailable", "the call ended"), "aborted"));
    };
    const onClose = () => {
      opts.signal?.removeEventListener("abort", onAbort);
      reject(new FluxStreamRefused(4502, fatal("capability_unavailable", "Couldn't reach Flux"), "closed during handshake"));
    };
    ws.once("close", onClose);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    ws.once("open", () => {
      opts.signal?.removeEventListener("abort", onAbort);
      resolve();
    });
    ws.once("unexpected-response", (_req, res) => {
      opts.signal?.removeEventListener("abort", onAbort);
      const status = res.statusCode ?? 500;
      let finished = false;
      const finish = (body: unknown) => {
        if (finished) return;
        finished = true;
        const refusal = classifyFluxRefusal(0, body);
        if (refusal === "budget") markBudgetReached(endpoint);
        const error = fatal(
          refusal === "budget" ? "key_budget_reached" : refusal === "premium" ? "premium_locked" :
            status === 402 ? CALL_ADMISSION_UNKNOWN : status === 503 ? "service_unavailable" : "capability_unavailable",
          `Flux answered ${status}`,
        );
        const code = error.code === CALL_ADMISSION_UNKNOWN ? error.close_code! : 4000 + status;
        reject(new FluxStreamRefused(code, error, `http ${status}`));
        ws.terminate();
      };
      if (status === 402) {
        // An observed refusal survives the transport closing mid-body.
        ws.off("close", onClose);
        res.setTimeout(opts.handshakeMs ?? HANDSHAKE_TIMEOUT_MS, () => res.destroy());
        const body = Readable.toWeb(res, { strategy: { highWaterMark: 0 } }) as ReadableStream<Uint8Array>;
        void read402Body(new Response(body)).then(finish, () => finish(null));
        return;
      }
      let body = "";
      res.on("data", chunk => { body += String(chunk); if (body.length > 65536) { finish(body.slice(0, 65536)); res.destroy(); } });
      res.once("end", () => finish(body));
      res.once("error", () => finish(body));
      res.setTimeout(opts.handshakeMs ?? HANDSHAKE_TIMEOUT_MS, () => { finish(body); res.destroy(); });
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
