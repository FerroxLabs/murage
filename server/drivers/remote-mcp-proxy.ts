import "../../shared/win-hide-child-process.mjs";
import {exitWithChildIoReceipt} from "../io-child-receipts.ts";
import { createMcpCatalogWriter, guardHandle, type McpRequest } from "../mcp-listed.ts";
import { NotModelRequest } from "../../shared/engine-transport.ts";
import { proxyTransportLost, reserveProxyUpstream, terminalReasonWord } from "../proxy-turn-release.ts";
import { logSwallowedConsumingError } from "../consuming-error-log.ts";
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// Stdio MCP server an engine mounts for ONE link server (spec MCP-LINK 3.8). It
// holds no credential and knows no address: every message goes to the harness's
// /api/internal/mcp-remote/<name> with this turn's token, and the harness does
// the sign-in, the headers and the network. The server name is in argv, not in
// the environment, because Codex shares one environment across all its servers.
//
// stdout is the MCP transport. Never log there.
import readline from "node:readline";
import { publishMcpWipeTools } from "../mcp-wipe-publisher.ts";

import { turnSecret } from "../turn-credential.ts";
import {
  announcedElicitation,
  classifyFrame,
  failureFrame,
  failureText,
  isElicitationRequest,
  isRelayDecision,
  rewriteInitializeCapabilities,
  serverRequestReply,
  splitUpstreamFrames,
  SseFrameReader,
  type JsonRpcMessage,
} from "./remote-mcp-proxy-core.ts";

const INITIALIZE_RELAY_TIMEOUT_MS = 30_000;
const RELAY_TIMEOUT_MS = 10 * 60_000;
const NOT_MODEL = "MCP tool/control traffic to the harness or tool server; this adapter does not submit model inference";

/** A call's relay deadline. It is paused while an elicitation the call is
 * waiting on is open (a person is deciding: the card's own timeout bounds
 * that), and starts over in full once the last one closes. */
export interface CallDeadline { signal: AbortSignal; pause(): void; resume(): void }
function callDeadline(ms: number): CallDeadline {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const arm = () => { timer = setTimeout(() => controller.abort(new Error("timeout")), ms); };
  arm();
  return {
    signal: controller.signal,
    pause: () => { if (timer) clearTimeout(timer); timer = null; },
    resume: () => { if (!timer && !controller.signal.aborted) arm(); },
  };
}

/** Only the fields an elicitation is: never the server's `_meta`, which an
 * engine could read as its own (Codex's `codex_approval_kind`). */
function elicitationParams(params: unknown): JsonRpcMessage {
  const source = params !== null && typeof params === "object" && !Array.isArray(params) ? (params as JsonRpcMessage) : {};
  const out: JsonRpcMessage = {};
  for (const key of ["mode", "message", "requestedSchema", "url", "elicitationId"]) if (key in source) out[key] = source[key];
  return out;
}

async function readBounded(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** Only a rejection caused by the supplied caller cancellation may leave the mount alive (the rule of
 * proxyFetch in proxy-turn-release.ts, kept word for word). */
function callerCancelled(signal: AbortSignal, error: unknown): boolean {
  return signal.aborted === true && signal.reason?.name !== "TimeoutError"
    && (error === signal.reason || error instanceof Error && error.name === "AbortError");
}
/** The connection-level cause of a failed fetch: a code word, never a message. */
function fetchErrorWord(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown; errors?: Array<{ code?: unknown }>; name?: unknown } } | null)?.cause;
  const word = [cause?.code, cause?.errors?.[0]?.code, (error as { code?: unknown } | null)?.code, cause?.name, (error as { name?: unknown } | null)?.name]
    .find(value => typeof value === "string" && value);
  return terminalReasonWord(word ?? "error");
}
/** What the relay POST reaches outside this file. The process passes the network, the turn's reserve and
 * the real seal (`main`); the interleaving test passes a network it schedules and a seal object it reads.
 * The code between them, `gatedFetch`, is the same. */
export interface RelayPorts {
  fetch(url: string, init: RequestInit & { signal: AbortSignal }): Promise<Response>;
  /** Reserves one chunk against the turn. A refusal rejects, and has sealed the mount itself already
   * (reserveProxyUpstream): no gate is asked, the turn's authority is gone for every session. */
  reserve(bytes: number): Promise<void>;
  /** Seals the mount for the turn. */
  lost(reason: string): void;
}
/** proxyFetch with ONE addition (1.0.21 cause6 r3, DESIGN-R3 3.3): `sealGate` is asked immediately before
 * each of the two TRANSPORT seals (the fetch was rejected; a chunk could not be reserved; a body that broke
 * mid-read no longer seals, q1022-connparity). When it
 * says no, the fault is about a session that is no longer the live one: the seal is skipped and the same
 * error still reaches the reader, whose own continuation decides. Every chunk is still reserved against
 * the turn first, and a refused reserve seals whatever the gate says: reserveProxyUpstream seals it itself
 * (the turn's authority is gone for every session). The size caps are the ones proxyUpstreamResponse has. */
async function gatedFetch(url: string, init: RequestInit & { signal: AbortSignal }, sealGate: () => boolean, ports: RelayPorts): Promise<Response> {
  const signal = init.signal;
  let response: Response;
  try {
    response = await ports.fetch(url, init);
  } catch (error) {
    if (!callerCancelled(signal, error) && sealGate()) { logSwallowedConsumingError("proxy.fetch", error); ports.lost(`fetch:${fetchErrorWord(error)}`); }
    throw error;
  }
  if (!response.body) return response;
  const reader = response.body.getReader();
  const wrapped = new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      let next: Awaited<ReturnType<typeof reader.read>>;
      try {
        next = await reader.read();
      } catch (error) {
        // q1022-connparity (MAIN-RULING CONNPARITY-1022): a body that broke mid-read no longer seals here; the reader
        // reconnects once and fails its call by name.
        void reader.cancel().catch(() => {}); controller.error(error); return;
      }
      if (next.done) { controller.close(); reader.releaseLock(); return; }
      try {
        await ports.reserve(next.value.byteLength);
      } catch (error) {
        // a chunk the turn refused still seals (T24)
        if (!callerCancelled(signal, error) && sealGate()) ports.lost("upstream-body");
        void reader.cancel().catch(() => {}); controller.error(error); return;
      }
      controller.enqueue(next.value);
    },
    cancel(reason) { return reader.cancel(reason); },
  }, { highWaterMark: 0 }), { status: response.status, statusText: response.statusText, headers: response.headers });
  for (const key of ["url", "redirected", "type"] as const) Object.defineProperty(wrapped, key, { value: response[key] });
  return wrapped;
}

/** The relay side of the machine's deps: every POST is one `gatedFetch` with the turn's token, and the
 * machine's own seal is the same seal the transport uses. `main` and the interleaving test both call this. */
export function relayDeps(url: string, token: () => string, relay: RelayPorts): Pick<ProxySessionDeps, "post" | "transportLost"> {
  return {
    post: (message, signal, sessionId, protocolVersion, sealGate) => NotModelRequest(NOT_MODEL, gatedFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token()}`,
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
      },
      body: JSON.stringify(message),
      signal,
    }, sealGate, relay)),
    transportLost: relay.lost,
  };
}

// ---- The owner's MCP session: ONE state machine, ONE fence (1.0.21 cause6 r3, DESIGN-R3) ------------
// closed -> opening -> open (handshake none -> sending -> done) -> closed. `gen` goes up every time an
// open BEGINS (the engine's initialize, or an automatic reopen). `epoch` goes up on every begin AND on
// every close: a session a probe or a handshake closed is no longer usable although its `gen` stays.
//
// THE invariant (I1): code that runs after an await may change session state or seal the mount only
// through `fenced(f, site, fx)`, where `f` is the fence taken when its POST was issued. The check is the
// synchronous statement before the side effect. A stale continuation of the proxy's own POST does
// nothing (T20). A stale engine request that would have sealed gets its own error (T21), or, when it is a
// tool call whose outcome is unknown, still seals (T22, design 399). Engine events (a line the engine
// wrote) are new facts: they read `cur` and act in the same tick (`engineTick`, `begin`).
// The session id is set in one place per origin: the answer to the initialize of the current generation.
/** A relay answer that was not ok: its status and parsed body (null when unreadable). */
interface RelayFailed { status: number; body: unknown }
interface Session {
  gen: number;
  id: string;
  origin: "engine" | "auto";
  state: "closed" | "opening" | "open";
  /** `done` = sent once on this session, whatever the answer: never sent on it again. */
  handshake: "none" | "sending" | "done";
  /** Why this generation closed, for the call that waited on it. */
  failure: RelayFailed | null;
}
/** What a continuation was started on: the session that was current, and the epoch then. `epoch` alone
 * decides freshness (it goes up whenever `cur` is replaced and whenever `cur` is closed, so an equal epoch
 * is the same record, still open as it was); `session` is kept for what the continuation reads from it. */
interface Fence { session: Session; epoch: number }
/** One engine request: who is owed an answer, and whether it got one. */
interface Call { method: string; id: unknown; req: McpRequest; answered: boolean; done: Promise<void> }
function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}
async function failedAnswer(response: Response): Promise<RelayFailed> {
  return { status: response.status, body: parseJson(await readBounded(response).catch(() => "")) };
}
const relayCode = (failed: RelayFailed) => String((failed.body as { code?: unknown } | null)?.code ?? "");
/** Only the relay's own "the session you named is not held, nothing was sent". Any other failure may
 * have run the call already; resending could run it twice. */
function sessionLost(body: unknown): boolean {
  return typeof body === "object" && body !== null && (body as { code?: unknown }).code === "session-gone";
}
/** A completed access decision is an application response (null). A failed or unreadable relay is
 * transport loss (§12.1), even with a live ledger: the seal reason is returned and the caller seals
 * through its fence.
 * 1.0.21 cause6: the relay's own failure answer (its fixed code and sentence, nothing of the upstream's)
 * is a completed decision at any status. One call the server refused, errored on or timed out (a 502
 * from the relay) fails that call alone. A tool call is the exception (design 399): its outcome is
 * unknown, the call may have run, so it never becomes a tool result and the seal stays. */
function lossReason(failed: RelayFailed, method: string): string | null {
  const decided = failed.body !== null && typeof failed.body === "object" && !Array.isArray(failed.body);
  if (decided && !(failed.status >= 500 && (method === "tools/call" || !isRelayDecision(failed.body)))) return null;
  return `relay-status=${failed.status}`;
}
/** What a call gets when a POST the proxy made for it (probe, automatic initialize, automatic handshake)
 * was not answered by the proxy's own deadline: the relay's own words for it. */
const NO_ANSWER: RelayFailed = { status: 502, body: { code: "no-answer", error: "The server did not answer in time. Try again in a moment." } };
/** What a call gets when the server answered the proxy's own initialize, HTTP ok, with an error instead of
 * a result: a failed open, in the relay's words for a server that had a problem answering. Nothing of the
 * server's own text is in it. */
const OPEN_REFUSED: RelayFailed = { status: 502, body: { code: "server-error", error: "The server had a problem answering. Try again in a moment." } };
/** q1022-connparity: what a tool call gets when the server's side of it dropped (the relay's own 5xx for it, or its
 * answer stream ended with no answer). It may have run, so it is never told to try again. */
/** q1022-connparity (MAIN-RULING CONNPARITY-1022): the relay's answer broke mid-stream. The proxy has reconnected
 * once through the relay; the call itself fails by name (a tool call may have run, so it is never resent). */
export const STREAM_BROKE_CALL = "stream-broke: the connection to this server broke during this call. Murage reconnected, but cannot tell whether the call ran. Check before you run it again.";
export const STREAM_BROKE = "stream-broke: the connection to this server broke before it answered. Murage reconnected; try again.";
export const CALL_DROPPED = "The connection to this server dropped during this call, so Murage cannot tell whether it ran. Check before you run it again.";
/** What an engine request gets when its POST failed after its session was replaced or closed (T21). */
const SESSION_REPLACED = "The server's session was replaced during this call. Try again.";
/** An initialize is answered by its BODY, not by its HTTP status: only a result object opens a session.
 * A JSON-RPC error (or a result that is no object) on HTTP 200 is a failed open, exactly as a failed status. */
function opensSession(answer: JsonRpcMessage): boolean {
  return !("error" in answer) && answer.result !== null && typeof answer.result === "object" && !Array.isArray(answer.result);
}
/** The frame that answers request `id` in an ok response: a JSON body, or an SSE body read until that
 * frame arrives. null = the body ended without one. Throws when the body cannot be read. A request the
 * server makes on the stream first (a ping it waits on before it answers) goes to `serverAsks`. */
async function answerIn(response: Response, id: unknown, serverAsks: (frame: JsonRpcMessage) => void): Promise<JsonRpcMessage | null> {
  const type = response.headers.get("content-type") ?? "";
  const isAnswer = (frame: JsonRpcMessage) => classifyFrame(frame, id) === "answer";
  if (!/^text\/event-stream/i.test(type) || !response.body) return splitUpstreamFrames(await readBounded(response), type).find(isAnswer) ?? null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const frames = new SseFrameReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      const read = done ? [...frames.push(decoder.decode()), ...frames.end()] : frames.push(decoder.decode(value, { stream: true }));
      for (const frame of read) {
        if (isAnswer(frame)) return frame;
        if (classifyFrame(frame, id) === "server-request") serverAsks(frame);
      }
      if (done) return null;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** Everything the session machine reaches outside itself. The process passes the real relay POST and the
 * real seal; the interleaving test passes a transport it schedules. The machine code is the same. */
export interface ProxySessionDeps {
  /** One POST to the relay. `sealGate` is asked before a TRANSPORT fault on this POST seals the mount. */
  post(message: JsonRpcMessage, signal: AbortSignal, session: string, protocolVersion: string, sealGate: () => boolean): Promise<Response>;
  /** Seals the mount for the turn. */
  transportLost(reason: string): void;
  /** A frame to the engine that answers no request of its own (a notification, a forwarded question). */
  send(frame: JsonRpcMessage): Promise<unknown>;
  /** The answer the engine gets for a tools/list once its effect hints are recorded. */
  hints(method: string, frame: JsonRpcMessage, replace: boolean): Promise<JsonRpcMessage>;
  deadline(ms: number): CallDeadline;
  /** The deadline of a reply to a request the server made. */
  replySignal(ms: number): AbortSignal;
  log(line: string): void;
  /** Test builds: a write to session state outside the fence throws. */
  strict?: boolean;
}

export function createProxySession(deps: ProxySessionDeps): { handle(message: JsonRpcMessage, req: McpRequest): Promise<void> } {
  /** Above zero only inside a `fenced` fx, an engine event's same-tick code, or `begin`. */
  let writing = 0;
  const guarded = <T extends object>(value: T): T => !deps.strict ? value : new Proxy(value, {
    set(target, key, next) {
      if (!writing) throw new Error(`session state ${String(key)} written outside the fence`);
      return Reflect.set(target, key, next);
    },
  });
  /** The machine's own counters and kept frames. `initializeFrame`: the engine's own initialize once it
   * was answered ok, kept so a closed session can be reopened without it. `unanswered`: automatic
   * sessions in a row whose handshake was sent and not known delivered. */
  const m = guarded({ epoch: 0, protocolVersion: "", initializeFrame: null as JsonRpcMessage | null, unanswered: 0 });
  let cur: Session = guarded<Session>({ gen: 0, id: "", origin: "engine", state: "closed", handshake: "none", failure: null });
  const isClosed = (session: Session) => session.state === "closed";
  let wakers: Array<() => void> = [];
  const changed = () => new Promise<void>((resolve) => { wakers.push(resolve); });
  function wake(): void {
    const all = wakers;
    wakers = [];
    for (const resolve of all) resolve();
  }
  const fenceNow = (): Fence => ({ session: cur, epoch: m.epoch });
  const fresh = (f: Fence) => f.epoch === m.epoch;
  /** For the transport under a POST: may a fault on it seal? A tool call's may always (its outcome is unknown). */
  const gate = (f: Fence, method = "") => () => fresh(f) || method === "tools/call";
  /** An engine event's own same-tick writes (it has just read `cur`; nothing was awaited). */
  function engineTick(act: () => void): void {
    writing++;
    try { act(); } finally { writing--; }
  }
  function seal(reason: string): void {
    if (!writing) throw new Error("seal outside the fence");
    deps.transportLost(reason);
  }
  function begin(origin: Session["origin"]): Session {
    writing++;
    try {
      cur = guarded<Session>({ gen: cur.gen + 1, id: "", origin, state: "opening", handshake: "none", failure: null });
      m.epoch++;
    } finally { writing--; }
    wake();
    return cur;
  }
  /** Closes the current session: the only one a fresh continuation can be about. Every fence taken on it
   * is stale from here. */
  function close(failure: RelayFailed | null): void {
    if (!writing) throw new Error("close outside the fence");
    cur.state = "closed";
    cur.failure = failure;
    m.epoch++;
    wake();
  }
  /** THE one check. Fresh: `fx` runs now, synchronously, and is the only code that may seal, close or
   * write session state after an await. Stale: `fx` does not run. `sealing` is passed when `fx` would
   * have sealed for an engine request: a tool call still seals (T22), any other request gets its own
   * error once (T21), a notification is owed nothing (T23). One continuation = one `fenced` call. */
  function fenced(f: Fence, site: string, fx: () => void, sealing?: Call): boolean {
    if (fresh(f)) {
      writing++;
      try { fx(); } finally { writing--; }
      return true;
    }
    if (sealing && sealing.method === "tools/call") {
      writing++;
      try { seal(`stale-tool:${site}`); } finally { writing--; }
    } else if (sealing && sealing.id !== undefined && !sealing.answered) {
      sealing.answered = true;
      sealing.done = sealing.req.respond(failureFrame(sealing.method, sealing.id, SESSION_REPLACED));
    }
    deps.log(`[remote-mcp-proxy] stale ${site} gen=${f.session.gen}\n`);
    return false;
  }
  const post = (message: JsonRpcMessage, signal: AbortSignal, session: string, sealGate: () => boolean) => deps.post(message, signal, session, m.protocolVersion, sealGate);
  const drop = (response: Response) => response.body?.cancel().catch(() => undefined);

  /** The engine announced elicitation in its initialize: a server's
   * elicitation/create is forwarded to it (MCP-ELICITATION-109). */
  let engineElicits = false;
  /** Elicitations forwarded to the engine, by the proxy's own id: the server's id
   * the engine's answer goes back under, and what to do when it closes. */
  const forwarded = new Map<string, { upstreamId: string | number; session: string; f: Fence; closed: () => void }>();
  let forwardSeq = 0;

  /** A request the server made while answering a call: an elicitation goes to
   * the engine (the owner's card), anything else is answered here. Returns the
   * proxy id of a forwarded elicitation. */
  function serverRequest(frame: JsonRpcMessage, onClosed: (id: string) => void, callSession: string, f: Fence): string | null {
    if (engineElicits && isElicitationRequest(frame)) {
      const id = `murage-elicit-${++forwardSeq}`;
      // the session the question came on (the call's own, frozen at its answer's
      // headers): the answer goes back on it, whatever another call reopened since
      forwarded.set(id, { upstreamId: frame.id as string | number, session: callSession, f, closed: () => onClosed(id) });
      void NotModelRequest(NOT_MODEL, deps.send({ jsonrpc: "2.0", id, method: "elicitation/create", params: elicitationParams(frame.params) })).catch(() => { process.exitCode = 1; });
      return id;
    }
    void post(serverRequestReply(frame), deps.replySignal(30_000), callSession, gate(f)).then(drop, () => undefined);
    return null;
  }

  /** The engine's answer to a forwarded elicitation goes back to the server
   * under the server's own id. True when `message` was one. */
  function engineAnswer(message: JsonRpcMessage): boolean {
    const id = message.id;
    if (typeof id !== "string" || !forwarded.has(id)) return false;
    const { upstreamId, session, f, closed } = forwarded.get(id)!;
    forwarded.delete(id);
    closed();
    const reply: JsonRpcMessage = "error" in message
      ? { jsonrpc: "2.0", id: upstreamId, error: message.error }
      : { jsonrpc: "2.0", id: upstreamId, result: message.result ?? { action: "cancel" } };
    void post(reply, deps.replySignal(30_000), session, gate(f)).then(drop, () => undefined);
    return true;
  }

  /** The engine is told a forwarded elicitation is withdrawn (its card closes):
   * the server cancelled it, or the call it belonged to ended. */
  function withdraw(ids: Iterable<string>, reason: string): void {
    for (const id of ids) {
      const entry = forwarded.get(id);
      if (!entry) continue;
      forwarded.delete(id);
      entry.closed();
      void NotModelRequest(NOT_MODEL, deps.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason } })).catch(() => { process.exitCode = 1; });
    }
  }

  /** A server's `notifications/cancelled` for an elicitation it sent on THIS
   * call (`opened`: a server may number its ids per response, so another call's
   * question can share the id): the engine knows that request by the proxy's id,
   * so the cancel is renamed. Every match on the call is withdrawn; none is
   * guessed. True when it named one (and must not also pass through as is). */
  function serverCancelled(frame: JsonRpcMessage, opened: ReadonlySet<string>): boolean {
    if (frame.method !== "notifications/cancelled") return false;
    const params = frame.params !== null && typeof frame.params === "object" ? (frame.params as JsonRpcMessage) : {};
    const matches = [...opened].filter((id) => forwarded.get(id)?.upstreamId === params.requestId);
    if (matches.length === 0) return false;
    withdraw(matches, typeof params.reason === "string" ? params.reason.slice(0, 200) : "The server cancelled its question.");
    return true;
  }

  /** One POST the proxy makes for itself, on its own deadline. That deadline passing is "no answer in
   * time" for the call that waited (null), never a seal: nothing of the engine's was lost. Any other
   * failed POST has sealed the mount in the transport, when its fence was still fresh (`sealGate`). */
  async function ownPost(message: JsonRpcMessage, session: string, sealGate: () => boolean): Promise<Response | null> {
    const deadline = deps.deadline(INITIALIZE_RELAY_TIMEOUT_MS);
    try {
      return await post(message, deadline.signal, session, sealGate);
    } catch {
      return null;
    } finally {
      deadline.pause();
    }
  }

  /** A call waits while an open or the proxy's own handshake is in flight. While the engine's own
   * handshake is in flight its other calls pass (the engine owns the order on a session it opened), but a
   * RESENT call waits for it: no retried call runs on a session before its handshake was sent and answered. */
  function unsettled(resent: boolean): boolean {
    if (cur.state === "opening") return true;
    if (cur.handshake === "sending") return cur.origin === "auto" || resent;
    return resent && cur.state === "open" && cur.handshake === "none";
  }

  /** Is the session really gone? The relay cannot tell a lost session from a server that answers 404 for
   * a method it lacks, so one `ping` on the same session decides, shared by every call that asks on the
   * same fence while it runs. Only the relay's session-gone to the ping means gone. This is the verdict
   * only: the caller closes the session, through its own fence. Anything else (an answer, another
   * failure, no answer in time) leaves the session as it is. */
  let probe: { f: Fence; verdict: Promise<boolean> } | null = null;
  let probeSeq = 0;
  function confirmGone(f: Fence, afterBreak = false): Promise<boolean> {
    if (probe && probe.f.epoch === f.epoch) return probe.verdict;
    const verdict = (async () => {
      // the reconnect after a break never seals, nor does its ping (ASTRA 49dd8dd7dd)
      const response = await ownPost({ jsonrpc: "2.0", id: `murage-probe-${++probeSeq}`, method: "ping" }, f.session.id, afterBreak ? () => false : gate(f));
      if (!response) return false;
      if (response.ok) {
        await drop(response);
        return false;
      }
      return sessionLost((await failedAnswer(response)).body);
    })();
    const mine = { f, verdict };
    probe = mine;
    void verdict.finally(() => { if (probe === mine) probe = null; });
    return verdict;
  }

  /** POSTs notifications/initialized on `session`. `failure` null = accepted. `seal` = the reason the
   * mount is sealed for, which `shake` applies through its fence. */
  async function postHandshake(session: Session, frame: JsonRpcMessage, sealGate: () => boolean): Promise<{ failure: RelayFailed | null; seal: string | null }> {
    let response: Response | null;
    if (session.origin === "engine") {
      // the engine's own notification, on a call's deadline as before
      const deadline = deps.deadline(RELAY_TIMEOUT_MS);
      try {
        response = await post(frame, deadline.signal, session.id, sealGate);
      } catch {
        return { failure: NO_ANSWER, seal: "relay-post" };
      } finally {
        deadline.pause();
      }
    } else response = await ownPost(frame, session.id, sealGate);
    if (response === null) return { failure: NO_ANSWER, seal: null };
    if (response.ok) {
      await drop(response);
      return { failure: null, seal: null };
    }
    const failure = await failedAnswer(response);
    return { failure, seal: lossReason(failure, "notifications/initialized") };
  }
  /** Sends notifications/initialized on `session` (the caller has just marked it `sending`, in the same
   * tick) and acts on the answer. A session gets it once.
   * - accepted: the session is used.
   * - session-gone, and the probe agrees: the session is closed.
   * - the server answered it with an error status (or 404 on a live session): it has it; the session is
   *   used (a server that errors on the notification still lists and runs).
   * - not known delivered (no answer in time, not reachable, a sign-in code): on a session the ENGINE
   *   opened it stays the engine's business and the session is used, as before. A session the PROXY opened
   *   is closed unused, so the next call opens another; when that one's handshake is not answered either,
   *   it is used: the server does not answer the notification, and each session still got it exactly once.
   * An answer that comes after the session was replaced or closed changes nothing and seals nothing (T20). */
  async function shake(session: Session, frame: JsonRpcMessage, afterBreak = false): Promise<void> {
    const f = fenceNow();
    const { failure, seal: found } = await postHandshake(session, frame, afterBreak ? () => false : gate(f));
    const reason = afterBreak ? null : found;
    let gone = false;
    if (failure !== null && session.id !== "" && sessionLost(failure.body) && fresh(f)) gone = await confirmGone(f, afterBreak);
    fenced(f, "handshake", () => {
      if (reason) seal(reason);
      session.handshake = "done";
      if (gone) close(failure);
      else if (failure === null) m.unanswered = 0;
      else if (session.origin === "auto" && !["server-error", "wrong-address", "session-gone"].includes(relayCode(failure)) && m.unanswered++ === 0) close(failure);
      wake();
    });
  }

  /** The session is closed and the engine's initialize is kept: open a new one with it and send the
   * handshake. One at a time; every call that waits on it shares the result. An open that an engine
   * initialize superseded is no longer the one to wait on. Called only from code that has just read `cur`. */
  let reopening: { session: Session; running: boolean; done: Promise<void> } | null = null;
  function reopen(afterBreak = false): Promise<void> {
    if (reopening && reopening.running && reopening.session === cur) return reopening.done;
    const frame = m.initializeFrame;
    if (!frame || !isClosed(cur)) return Promise.resolve();
    const mine = { session: begin("auto"), running: true, done: Promise.resolve() };
    mine.done = openAutomatic(mine.session, frame, afterBreak).finally(() => { mine.running = false; wake(); });
    reopening = mine;
    return mine.done;
  }
  /** `afterBreak` (q1022-connparity, MAIN-RULING CONNPARITY-1022 "never seals"; OPUS 4ed978c679 H2): the one
   * reconnect after a stream broke mid-call. However it ends (rejected POST, any failed status, no answer
   * frame, a failed handshake) it only closes, and the call gets its named error. A chunk the turn refused
   * still seals in reserveProxyUpstream itself. */
  async function openAutomatic(session: Session, frame: JsonRpcMessage, afterBreak = false): Promise<void> {
    const f = fenceNow();
    const sealGate = afterBreak ? () => false : gate(f);
    const id = `reopen-${Date.now()}`;
    // The proxy's own deadline covers the POST and the reading of an ok answer. Passing it is "no answer in
    // time" for the call that waited, never a seal; any other failed POST or read seals the mount, but
    // only while this open is still the current generation (T14, T20).
    const deadline = deps.deadline(INITIALIZE_RELAY_TIMEOUT_MS);
    let opened: Response;
    let answer: JsonRpcMessage | null;
    try {
      try {
        opened = await post({ ...frame, id }, deadline.signal, "", sealGate);
      } catch {
        fenced(f, "reopen-post", () => close(NO_ANSWER));
        return;
      }
      if (!opened.ok) {
        deadline.pause();
        const failure = await failedAnswer(opened);
        fenced(f, "reopen-status", () => {
          const reason = afterBreak ? null : lossReason(failure, "initialize");
          if (reason) seal(reason);
          close(failure);
        });
        return;
      }
      try {
        // Nobody on this side answers the server's own requests: it is told so (a ping is answered), as on a call.
        const asked = opened.headers.get("mcp-session-id") ?? "";
        answer = await answerIn(opened, id, (ask) => void post(serverRequestReply(ask), deps.replySignal(30_000), asked, sealGate).then(drop, () => undefined));
      } catch {
        // q1022-connparity (MAIN-RULING CONNPARITY-1022): a reopen whose answer broke mid-read closes; it never seals.
        fenced(f, "reopen-read", () => close(NO_ANSWER));
        return;
      }
    } finally {
      deadline.pause();
    }
    // HTTP ok is not an open session. The server's answer decides, as it does for a failed status (T14):
    // an error result closes this generation with that failure, the call that waited gets it as its own
    // error and the next call opens again. An ok answer with no answer frame is the existing seal for a
    // request nobody answered. Neither ever leaves a session marked open with nothing behind it. When the
    // engine initialized meanwhile, this session is never used and none of this happens.
    const read = answer;
    let opens = false;
    fenced(f, "reopen-answer", () => {
      if (read === null) {
        if (!afterBreak) seal("no-answer");
        return close(OPEN_REFUSED);
      }
      if (!opensSession(read)) return close(OPEN_REFUSED);
      session.id = opened.headers.get("mcp-session-id") ?? "";
      session.state = "open";
      session.handshake = "sending";
      opens = true;
    });
    if (opens) await shake(session, { jsonrpc: "2.0", method: "notifications/initialized" }, afterBreak);
  }

  /** One answer frame to the engine request `call`. */
  async function answerCall(call: Call, frame: JsonRpcMessage): Promise<void> {
    call.answered = true;
    await NotModelRequest(NOT_MODEL, call.req.respond(frame, id => failureFrame(call.method, id, "Murage could not record this server's tools. Try again in a moment.")));
  }
  /** The answer for one call the relay failed: its own error, or the seal (through the call's fence `f`;
   * `also` is session state the same continuation changes). A notification is owed nothing. */
  async function fail(failed: RelayFailed, call: Call, f: Fence, also?: () => void): Promise<void> {
    // q1023-connparity-fix (MAIN-RULING CONNPARITY-1022; ASTRA 14d1f27d48 High 3): the relay says a legacy SSE server's
    // stream broke under this call. That is the same break as a streamable answer that breaks mid-body, and it gets
    // the same treatment: one reconnect now, the call's named stream-broke error, never a seal.
    if (failed.status >= 500 && isRelayDecision(failed.body) && relayCode(failed) === "stream-broke") return broke(call, f, "relay-stream-broke", also);
    // q1022-connparity (MAIN-RULING SEAN 2026-11-25, metricool 208 drops): the relay's own 5xx for a tool call (the
    // server erred, could not be reached or did not answer) used to seal the whole server for the rest of the turn
    // (design 399). Now that call alone gets CALL_DROPPED and its session is closed, so the next call reconnects.
    // A 5xx that is not the relay's own answer still seals.
    const dropped = call.method === "tools/call" && failed.status >= 500 && isRelayDecision(failed.body);
    const reason = dropped ? null : lossReason(failed, call.method);
    fenced(f, "call-status", () => {
      if (reason) seal(reason);
      if (dropped && !isClosed(cur)) close(failed);
      also?.();
    }, reason ? call : undefined);
    if (reason) return call.done;
    if (call.id !== undefined && !call.answered) {
      call.answered = true;
      await NotModelRequest("Local MCP error synthesized for an unreachable tool server.", call.req.respond(failureFrame(call.method, call.id, dropped ? CALL_DROPPED : failureText(failed.body, "The server could not be reached."))));
    }
  }

  /** q1022-connparity (MAIN-RULING CONNPARITY-1022): the relay's answer for `call` broke mid-body (its upstream stream
   * broke). Never a seal. On a fresh fence the session is closed and ONE reconnect goes through the relay now (the
   * engine's own initialize is not reopened for); then the call gets its named error. On a stale fence (the session
   * was already replaced) a request other than a tool call still gets SESSION_REPLACED (T21); a tool call gets the
   * named error, never the seal it used to get (T22 superseded). `also` is session state the same continuation changes. */
  async function broke(call: Call, f: Fence, site: string, also?: () => void): Promise<void> {
    const current = fenced(f, site, () => {
      also?.();
      if (!isClosed(cur)) close(NO_ANSWER);
    }, call.method === "tools/call" ? undefined : call);
    if (current && call.method !== "initialize") await reopen(true);
    if (call.id !== undefined && !call.answered) {
      call.answered = true;
      call.done = call.req.respond(failureFrame(call.method, call.id, call.method === "tools/call" ? STREAM_BROKE_CALL : STREAM_BROKE));
    }
    await call.done;
  }

  async function handle(message: JsonRpcMessage, req: McpRequest, resent = false): Promise<void> {
    const id = message.id;
    const method = typeof message.method === "string" ? message.method : "";
    // A reply from the engine: an answer to a forwarded elicitation, or to
    // something we never forwarded (nothing to do).
    if (!method) {
      engineAnswer(message);
      return;
    }
    const call: Call = { method, id, req, answered: false, done: Promise.resolve() };
    // q1022-connparity: Claude Code opens every MCP server with a `server/discover` probe before `initialize`
    // (BROWSERROOT-1020). Forwarded, it reached the link server with no session, the server refused it, and the
    // relay logged `server/discover code=wrong-address` on every turn. No link server is asked it: it is answered
    // here as unknown, as the browser and computer proxies answer it, and the engine goes on to initialize.
    if (method === "server/discover") {
      if (id !== undefined) await answerCall(call, { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found: server/discover" } });
      return;
    }
    const outgoing = rewriteInitializeCapabilities(message);
    let session: Session;
    if (method === "initialize") {
      // The engine opens a session: a new generation at once. An automatic reopen still in flight is
      // superseded, and its late answer is stale.
      session = begin("engine");
      engineTick(() => { m.initializeFrame = null; });
      const params = message.params !== null && typeof message.params === "object" && !Array.isArray(message.params) ? (message.params as JsonRpcMessage) : {};
      engineElicits = announcedElicitation(params.capabilities) !== null;
    } else {
      // The state is judged and the session taken in one step, with no await between: another call may
      // begin an open in any gap. The call waits on the STATE, never on one reopen: an engine initialize
      // that supersedes the reopen releases it onto the engine's session. A call whose own reopen failed
      // gets that failure (never a loop); a closed session it did not wait on is reopened.
      let waitedOn: Session | null = null;
      for (let reopens = 0; ; ) {
        if (unsettled(resent)) { await changed(); continue; }
        if (!isClosed(cur) || !m.initializeFrame) break;
        // a reopen that just failed is still settling: wait for it to end, never spin on its promise
        if (reopening && reopening.running && reopening.session === cur) { await changed(); continue; }
        if (waitedOn === cur || reopens++ > 3) return fail(cur.failure ?? NO_ANSWER, call, fenceNow());
        void reopen();
        waitedOn = reopening ? reopening.session : null;
      }
      session = cur;
      if (method === "notifications/initialized" && session.state === "open") {
        if (session.handshake !== "none") return; // this session already has its handshake
        engineTick(() => { session.handshake = "sending"; });
        await shake(session, outgoing);
        // The engine's own handshake found the session gone: the replacement is opened now, not at the next call.
        if (session === cur && isClosed(session)) await reopen();
        return;
      }
    }
    // The call's fence: taken in the tick its POST is issued. Everything this call does to the session
    // or the mount after an await goes through it.
    const f = fenceNow();
    const timeoutMs = method === "initialize" ? INITIALIZE_RELAY_TIMEOUT_MS : RELAY_TIMEOUT_MS;
    // The engine's initialize is settled by its ANSWER, not by the HTTP status (T2/T3): a result opens the
    // session with the id from the header and keeps the frame for reopens; an error result, or no answer
    // at all, closes it and keeps nothing (the engine is told it failed; the proxy opens nothing on its own).
    // `settleFx` is the state change itself and runs only inside a `fenced` fx; the first one decides.
    let openedId = "";
    let settled = false;
    const settleFx = method !== "initialize" ? null : (answer: JsonRpcMessage | null, version = false) => {
      if (settled) return;
      settled = true;
      if (session.state !== "opening") return;
      if (answer === null || !opensSession(answer)) return close(null);
      session.id = openedId;
      session.state = "open";
      m.initializeFrame = outgoing;
      const offered = (answer.result as { protocolVersion?: unknown }).protocolVersion;
      if (version && typeof offered === "string" && /^\d{4}-\d{2}-\d{2}$/.test(offered)) m.protocolVersion = offered;
      wake();
    };
    const settle = settleFx && ((answer: JsonRpcMessage | null, version = false) => {
      if (!settled && !fenced(f, "settle", () => settleFx(answer, version))) settled = true;
    });
    let response: Response;
    const deadline = deps.deadline(timeoutMs);
    try {
      response = await post(outgoing, deadline.signal, session.id, gate(f, method));
    } catch {
      fenced(f, "call-post", () => {
        seal("relay-post");
        settleFx?.(null);
      }, call);
      return call.done;
    }
    openedId = response.headers.get("mcp-session-id") ?? "";
    // An SSE answer is read as it arrives: a server's elicitation must reach the
    // engine while the call it belongs to is still open.
    if (response.ok && /^text\/event-stream/i.test(response.headers.get("content-type") ?? "") && response.body) {
      try {
        return await streamAnswer(response, call, f, deadline, settle ? openedId : session.id, !(message.params as any)?.cursor, settle);
      } finally {
        settle?.(null); // the stream ended with no answer to the initialize
      }
    }
    let text: string;
    try {
      text = await readBounded(response);
    } catch {
      // The call's own deadline passing is no break (the server did not answer): it still seals, as before.
      if (deadline.signal.aborted) {
        fenced(f, "call-read", () => {
          seal("relay-read");
          settleFx?.(null);
        }, call);
        return call.done;
      }
      return broke(call, f, "call-read", settleFx ? () => settleFx(null) : undefined);
    }
    if (!response.ok) {
      const failed: RelayFailed = { status: response.status, body: parseJson(text) };
      if (!resent && method !== "initialize" && session.id !== "" && sessionLost(failed.body)) {
        // Nothing was sent upstream. On a stale fence the session was already replaced or closed: send
        // once more on the current one (T16). On a fresh one, reopen only if the session is really gone:
        // the probe gives the verdict and this call closes the session through its own fence (T12).
        if (!fresh(f)) return handle(message, req, true);
        if (await confirmGone(f)) {
          fenced(f, "call-session-gone", () => close(null));
          return handle(message, req, true);
        }
        if (!fresh(f)) return handle(message, req, true);
      }
      return fail(failed, call, f, settleFx ? () => settleFx(null) : undefined);
    }
    const frames = splitUpstreamFrames(text, response.headers.get("content-type") ?? "");
    try {
      for (const frame of frames) {
        const kind = classifyFrame(frame, id);
        if (kind === "notification") await NotModelRequest(NOT_MODEL, deps.send(frame));
        else if (kind === "server-request") {
          // Nobody on this side answers sampling or elicitation: say so to the server.
          void post(serverRequestReply(frame), deps.replySignal(30_000), session.id, gate(f)).then(drop, () => undefined);
        } else if (kind === "answer" && !call.answered) {
          settle?.(frame, true);
          await answerCall(call, await deps.hints(method, frame, !(message.params as any)?.cursor));
        }
      }
      // Every id is answered. An unreadable or empty answer to a request is an error
      // result, never silence (a hung tool call looks like the model thinking).
      if (id !== undefined && !call.answered) {
        fenced(f, "call-no-answer", () => {
          seal("no-answer");
          settleFx?.(null);
        }, call);
        await call.done;
      }
    } finally {
      settle?.(null); // an ok answer with no answer frame opened nothing; no exit leaves the session opening
    }
  }

  /** One SSE answer, frame by frame. Every id is still answered exactly once. */
  async function streamAnswer(response: Response, call: Call, f: Fence, deadline: CallDeadline, callSession: string, replaceMetadata: boolean, settle: ((answer: JsonRpcMessage) => void) | null = null): Promise<void> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const frames = new SseFrameReader();
    const opened = new Set<string>();
    let faulted = false;
    // this call's deadline waits while one of its questions is with the owner
    const closed = (forwardedId: string) => {
      opened.delete(forwardedId);
      if (opened.size === 0) deadline.resume();
    };
    const take = async (frame: JsonRpcMessage) => {
      const kind = classifyFrame(frame, call.id);
      if (kind === "notification") {
        if (!serverCancelled(frame, opened)) await NotModelRequest(NOT_MODEL, deps.send(frame));
      } else if (kind === "server-request") {
        const forwardedId = serverRequest(frame, closed, callSession, f);
        if (forwardedId) {
          opened.add(forwardedId);
          deadline.pause();
        }
      } else if (kind === "answer" && !call.answered) {
        settle?.(frame);
        await answerCall(call, await deps.hints(call.method, frame, replaceMetadata));
      }
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const frame of frames.push(decoder.decode(value, { stream: true }))) await take(frame);
      }
      for (const frame of frames.push(decoder.decode())) await take(frame);
      for (const frame of frames.end()) await take(frame);
    } catch {
      faulted = true;
    } finally {
      withdraw([...opened], "The server's call ended before the answer.");
    }
    // q1022-connparity (MAIN-RULING CONNPARITY-1022): the stream broke mid-call. Before its answer: reconnect once, then
    // the call fails by name. After its answer: nothing is owed and nothing is sealed (a stale break is still logged).
    // The call's own deadline passing is no break (the server did not answer): it still seals, as before.
    if (faulted && deadline.signal.aborted) { fenced(f, "stream-read", () => seal("stream-read"), call); return call.done; }
    if (faulted && call.answered) { fenced(f, "stream-read", () => {}); return call.done; }
    if (faulted) return broke(call, f, "stream-read");
    if (call.id !== undefined && !call.answered && !faulted) {
      // q1022-connparity: the server's stream for this call ended with no answer (it dropped). That call alone
      // fails and its session is closed, so the next call reconnects; the server stays mounted for the turn.
      fenced(f, "stream-no-answer", () => { if (!isClosed(cur)) close(NO_ANSWER); });
      if (!call.answered) {
        call.answered = true;
        call.done = call.req.respond(failureFrame(call.method, call.id, call.method === "tools/call" ? CALL_DROPPED : failureText(NO_ANSWER.body, "The server did not answer in time.")));
      }
    }
    await call.done;
  }

  return { handle };
}

/** The process: stdin lines in, the relay behind `gatedFetch`, the real seal. */
function main(): void {
  const HARNESS = process.env.MURAGE_HARNESS_URL ?? "http://127.0.0.1:8799";
  const token = () => turnSecret("MURAGE_MCP_TOKEN");
  const serverIndex = process.argv.indexOf("--server");
  const NAME = serverIndex >= 0 ? process.argv[serverIndex + 1] ?? "" : "";
  const catalog = NotModelRequest("MCP catalog observer emits local tool discovery metadata to child stdout.", createMcpCatalogWriter(process.env, process.stdout, "remoteMcp"));
  const send = (message: JsonRpcMessage) => NotModelRequest(NOT_MODEL, catalog.send(message));

  /** The answer the engine gets for a tools/list: the server's own, once its effect hints are recorded
   * (the engine's later permission request reads them), else the fixed "could not record" error for that
   * one call. No tool is listed without its hints. 1.0.21 cause6: a failed record used to seal the whole
   * server for the turn. */
  async function hintsRecorded(method: string, frame: JsonRpcMessage, replace: boolean): Promise<JsonRpcMessage> {
    const tools = method === "tools/list" && frame.result && typeof frame.result === "object" ? (frame.result as { tools?: unknown }).tools : undefined;
    if (!Array.isArray(tools)) return frame;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await publishMcpWipeTools(NAME, tools, replace); return frame; } catch { /* once more, then the fixed error */ }
    }
    process.stderr.write("[remote-mcp-proxy] effect hints could not be recorded; this tools/list is answered with an error\n");
    return failureFrame(method, frame.id, "Murage could not record this server's tools. Try again in a moment.");
  }

  const session = createProxySession({
    ...relayDeps(`${HARNESS}/api/internal/mcp-remote/${encodeURIComponent(NAME)}`, token, {
      fetch: (url, init) => fetch(url, init),
      reserve: (bytes) => reserveProxyUpstream("remoteMcp", bytes),
      lost: (reason) => proxyTransportLost("remoteMcp", reason),
    }),
    send,
    hints: hintsRecorded,
    deadline: callDeadline,
    replySignal: (ms) => AbortSignal.timeout(ms),
    log: (line) => { process.stderr.write(line); },
  });

  const input = readline.createInterface({ input: process.stdin, terminal: false });
  input.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: JsonRpcMessage;
    try {
      const value: unknown = JSON.parse(trimmed);
      if (value === null || typeof value !== "object" || Array.isArray(value)) return;
      message = value as JsonRpcMessage;
    } catch {
      return;
    }
    const req = guardHandle(catalog.observeRequest(message), () => { process.exitCode = 1; process.stdin.destroy(); });
    void req.published.then(() => session.handle(message, req)).catch(async () => {
      // `handle` threw: a proxy bug, the state is unknown, so no fence can be read. Fail closed (E-throw).
      proxyTransportLost("remoteMcp", "handle");
    });
  });
  input.on("close", () => void exitWithChildIoReceipt(0));
}

// The interleaving test imports the machine alone, by setting this mark first. Everything else runs the process.
if (!(globalThis as Record<symbol, unknown>)[Symbol.for("murage.remote-mcp-proxy.session-only")]) main();
