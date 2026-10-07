// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// The harness side of the legacy HTTP+SSE transport (spec MCP-LINK 3.8). An
// engine's stdio proxy speaks plain request and response through the relay
// route; a legacy server answers on a long-lived GET stream instead. So the
// harness holds that stream per session it mints, posts messages to the
// endpoint the stream announced, and matches the answers off the stream by id.
//
// A session belongs to one server name and one turn generation: another turn's
// token cannot use it, it closes when the generation is revoked, and it closes
// after a quiet spell.
import { randomBytes } from "node:crypto";
import type { Readable } from "node:stream";

import { GuardedHttpError, guardedRequest, type GuardedRequestOptions, type GuardedStreamResponse } from "../shared/guarded-http.mjs";
import { LIMITS, sameOrigin, type LocalConfirmation } from "../shared/remote-mcp-url.mjs";
import { SseReaderError, classifyUnauthorized, createSseReader, isSameOriginEndpoint, reasonForGuardedError } from "./remote-mcp-client.ts";
import type { McpProbeFailureReason } from "./mcp-probe.ts";

export const SSE_SESSION_IDLE_MS = 10 * 60_000;
export const MAX_SSE_SESSIONS = 20;
/** One turn cannot hold every session: its own cap (MCP-LINK L2). */
export const MAX_SSE_SESSIONS_PER_GENERATION = 4;

type Frame = Record<string, unknown>;
export type SseSessionFailure = { ok: false; reason: McpProbeFailureReason; status?: number; stepUpScopes?: string[] };

interface Pending {
  resolve: (frame: Frame | null) => void;
  reject: (reason: McpProbeFailureReason) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Session {
  id: string;
  name: string;
  generation: string;
  endpoint: string;
  serverUrl: string;
  confirmed: LocalConfirmation | null;
  stream: GuardedStreamResponse;
  pending: Map<number | string, Pending>;
  closed: boolean;
}

/** 401 and 403 are sign-in problems; a 403 insufficient_scope is a step-up
 * (the same classification streamable HTTP uses), carrying the scopes asked for. */
function refusal(status: number, wwwAuthenticate: string | string[] | undefined, bearer: string | undefined): SseSessionFailure | null {
  if (status !== 401 && status !== 403) return null;
  const classified = classifyUnauthorized({ status, wwwAuthenticate, sent: bearer ? "bearer" : "nothing" });
  if (classified.reason === "needs-more-access") {
    return { ok: false, reason: "needs-more-access", status, ...(classified.scopes.length > 0 ? { stepUpScopes: classified.scopes } : {}) };
  }
  return { ok: false, reason: "sign-in-ended", status };
}

export interface SseOpenInput {
  name: string;
  generation: string;
  url: string;
  headers: Record<string, string>;
  bearer?: string;
  confirmed: LocalConfirmation | null;
  signal?: AbortSignal;
  resolver?: GuardedRequestOptions["resolver"];
}

export interface SseCallInput {
  /** The entry's link and local confirmation as they are NOW. A session opened
   * for another origin or another confirmation is not used (MCP-LINK N1): its
   * headers were resolved for the current link. */
  dialUrl: string;
  confirmed: LocalConfirmation | null;
  headers: Record<string, string>;
  bearer?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  resolver?: GuardedRequestOptions["resolver"];
}

const isRecord = (value: unknown): value is Frame => value !== null && typeof value === "object" && !Array.isArray(value);

/** A session may be used only by the name and generation it was opened for. */
export function sessionOwnedBy(session: { name: string; generation: string }, name: string, generation: string): boolean {
  return session.name === name && session.generation === generation;
}

export class RemoteSseSessions {
  private readonly sessions = new Map<string, Session>();
  /** Opens still waiting on the server, per generation. They hold a slot from
   * the moment they start, so opens that race each other cannot pass the caps. */
  private readonly opening = new Map<string, number>();
  private openingTotal = 0;
  private readonly idleMs: number;
  private readonly max: number;

  private readonly maxPerGeneration: number;
  private readonly isLive: ((generation: string) => boolean) | undefined;
  private sweeper: ReturnType<typeof setInterval> | undefined;

  /** `isLive` says whether a turn generation still exists. A session whose
   * generation is gone is closed on the next sweep (every 10 s), on the next
   * open and on the next call: a stopped turn must not leave a stream open to
   * the owner's server. */
  constructor(options: { idleMs?: number; max?: number; maxPerGeneration?: number; isLive?: (generation: string) => boolean; sweepMs?: number } = {}) {
    this.idleMs = options.idleMs ?? SSE_SESSION_IDLE_MS;
    this.max = options.max ?? MAX_SSE_SESSIONS;
    this.maxPerGeneration = options.maxPerGeneration ?? MAX_SSE_SESSIONS_PER_GENERATION;
    this.isLive = options.isLive;
    if (this.isLive) {
      this.sweeper = setInterval(() => this.sweep(), options.sweepMs ?? 10_000);
      this.sweeper.unref?.();
    }
  }

  /** Close every session whose turn is gone. */
  sweep(): void {
    if (!this.isLive) return;
    for (const session of [...this.sessions.values()]) if (!this.isLive(session.generation)) this.finish(session, "cancelled");
  }

  get size(): number {
    return this.sessions.size;
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  async open(input: SseOpenInput): Promise<{ ok: true; sessionId: string } | SseSessionFailure> {
    this.sweep();
    if (this.isLive && !this.isLive(input.generation)) return { ok: false, reason: "cancelled" };
    if (this.sessions.size + this.openingTotal >= this.max) return { ok: false, reason: "server-error" };
    const held = [...this.sessions.values()].filter((session) => session.generation === input.generation).length + (this.opening.get(input.generation) ?? 0);
    if (held >= this.maxPerGeneration) return { ok: false, reason: "server-error" };
    // Reserve the slot before the first await (MCP-LINK L-a).
    this.opening.set(input.generation, (this.opening.get(input.generation) ?? 0) + 1);
    this.openingTotal += 1;
    try {
      return await this.connect(input);
    } finally {
      this.openingTotal -= 1;
      const left = (this.opening.get(input.generation) ?? 1) - 1;
      if (left > 0) this.opening.set(input.generation, left);
      else this.opening.delete(input.generation);
    }
  }

  private async connect(input: SseOpenInput): Promise<{ ok: true; sessionId: string } | SseSessionFailure> {
    let opened;
    try {
      opened = await guardedRequest({
        url: input.url, method: "GET", kind: "sse", responseMode: "stream", mode: "request", confirmed: input.confirmed,
        signal: input.signal, resolver: input.resolver, totalMs: LIMITS.initializeRelayMs,
        headers: { accept: "text/event-stream", ...input.headers, ...(input.bearer ? { authorization: `Bearer ${input.bearer}` } : {}) },
      });
    } catch (error) {
      return { ok: false, reason: reasonForGuardedError(error instanceof GuardedHttpError ? error.code : "unreachable") };
    }
    if (opened.status !== 200 || !("stream" in opened)) {
      opened.discard();
      return refusal(opened.status, opened.headers["www-authenticate"], input.bearer) ?? { ok: false, reason: "wrong-address", status: opened.status };
    }
    const stream = opened as unknown as GuardedStreamResponse;
    const events = createSseReader(stream.stream as Readable, { idleMs: this.idleMs, maxEventBytes: LIMITS.sseEventBytes });
    let first;
    try {
      first = await Promise.race([
        events.next(),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new SseReaderError("idle-timeout")), LIMITS.initializeRelayMs);
          timer.unref?.();
        }),
      ]);
    } catch {
      stream.close();
      return { ok: false, reason: "no-answer" };
    }
    if (first.done || first.value.event !== "endpoint" || !isSameOriginEndpoint(input.url, first.value.data.trim())) {
      stream.close();
      return { ok: false, reason: "wrong-address" };
    }
    const id = randomBytes(12).toString("hex");
    const session: Session = {
      id, name: input.name, generation: input.generation, endpoint: new URL(first.value.data.trim(), input.url).href,
      serverUrl: input.url, confirmed: input.confirmed, stream, pending: new Map(), closed: false,
    };
    this.sessions.set(id, session);
    void this.pump(session, events);
    return { ok: true, sessionId: id };
  }

  /** Read answers off the stream until it ends, matching them to waiting calls. */
  private async pump(session: Session, events: AsyncGenerator<{ event: string; data: string }>): Promise<void> {
    let reason: McpProbeFailureReason = "unreachable";
    try {
      for (;;) {
        const next = await events.next();
        if (next.done) break;
        if (next.value.event !== "message") continue;
        let frame: unknown;
        try {
          frame = JSON.parse(next.value.data);
        } catch {
          continue;
        }
        if (!isRecord(frame)) continue;
        const key = frame.id;
        if ((typeof key === "number" || typeof key === "string") && session.pending.has(key)) {
          const waiting = session.pending.get(key)!;
          clearTimeout(waiting.timer);
          session.pending.delete(key);
          waiting.resolve(frame);
        }
      }
    } catch (error) {
      reason = error instanceof SseReaderError && error.code === "idle-timeout" ? "no-answer" : "unreachable";
    } finally {
      this.finish(session, reason);
    }
  }

  private finish(session: Session, reason: McpProbeFailureReason): void {
    if (session.closed) return;
    session.closed = true;
    this.sessions.delete(session.id);
    session.stream.close();
    for (const waiting of session.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(reason);
    }
    session.pending.clear();
  }

  /** POST one message to the session's endpoint. A request (it has an id) waits
   * for its answer on the stream; a notification does not. */
  async call(sessionId: string, name: string, generation: string, message: Frame, input: SseCallInput): Promise<{ ok: true; frame: Frame | null } | SseSessionFailure> {
    this.sweep();
    const session = this.sessions.get(sessionId);
    if (!session || session.closed || !sessionOwnedBy(session, name, generation)) return { ok: false, reason: "session-gone", status: 404 };
    // The link was edited, or its local confirmation changed, since this
    // session was opened: the stream belongs to a server the entry no longer
    // names. Close it and send nothing.
    if (!sameOrigin(session.serverUrl, input.dialUrl) || session.confirmed !== input.confirmed) {
      this.finish(session, "cancelled");
      return { ok: false, reason: "wrong-address", status: 404 };
    }
    const rawId = message.id;
    const key = typeof rawId === "number" || typeof rawId === "string" ? rawId : undefined;
    const forget = () => {
      if (key === undefined) return;
      const pending = session.pending.get(key);
      if (pending) { clearTimeout(pending.timer); session.pending.delete(key); }
    };
    let waiting: Promise<Frame | null> | undefined;
    if (key !== undefined) {
      waiting = new Promise<Frame | null>((resolve, reject) => {
        const timer = setTimeout(() => { session.pending.delete(key); reject("no-answer" as McpProbeFailureReason); }, input.timeoutMs);
        timer.unref?.();
        session.pending.set(key, { resolve, reject: (why) => reject(why), timer });
      });
      waiting.catch(() => undefined);
    }
    let response;
    try {
      response = await guardedRequest({
        url: session.endpoint, method: "POST", kind: "mcp", mode: "request", confirmed: session.confirmed,
        signal: input.signal, resolver: input.resolver, totalMs: input.timeoutMs, body: JSON.stringify(message),
        headers: { "content-type": "application/json", ...input.headers, ...(input.bearer ? { authorization: `Bearer ${input.bearer}` } : {}) },
      });
    } catch (error) {
      forget();
      return { ok: false, reason: reasonForGuardedError(error instanceof GuardedHttpError ? error.code : "unreachable") };
    }
    if (response.status >= 300) {
      forget();
      return refusal(response.status, response.headers["www-authenticate"], input.bearer) ?? { ok: false, reason: response.status >= 500 ? "server-error" : "wrong-address", status: response.status };
    }
    if (!waiting) return { ok: true, frame: null };
    try {
      return { ok: true, frame: await waiting };
    } catch (why) {
      return { ok: false, reason: typeof why === "string" ? (why as McpProbeFailureReason) : "unreachable" };
    }
  }

  closeSession(id: string): void {
    const session = this.sessions.get(id);
    if (session) this.finish(session, "cancelled");
  }

  /** The server was edited, switched off or removed, or its secrets were
   * dropped: every session opened for it closes, in every turn. */
  closeName(name: string): void {
    for (const session of [...this.sessions.values()]) if (session.name === name) this.finish(session, "cancelled");
  }

  /** The turn ended or was stopped: every session it opened closes. */
  closeGeneration(generation: string): void {
    for (const session of [...this.sessions.values()]) if (session.generation === generation) this.finish(session, "cancelled");
  }

  closeAll(): void {
    for (const session of [...this.sessions.values()]) this.finish(session, "cancelled");
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
  }
}
