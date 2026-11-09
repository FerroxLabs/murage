/** Volatile call speech authority, owned by authenticated call-channel connections. */
import { protectedHostUtterances } from "../voice/voice-host.ts";
import { randomUUID } from "node:crypto";
import { mintCallPresentation, readCallPresentation, presentationPrefix, type PresentationFields, type ProtectedPresentation } from "./call-presentation.ts";
import { CallSpeechSource, type CallAuthority, type CallReplyIdentity } from "./call-speech-source.ts";
import { MAX_SOURCE_BYTES } from "./speech-source.ts";

export type CallSpeechReady = Readonly<{
  type: "call.speech.ready";
  callId: string;
  threadId: string;
  botId: string;
  messageId: string;
  replyId: string;
  bootId: string;
}>;
export type CallSpeechEvent = CallSpeechReady | Readonly<{ type: "call.speech.invalidated"; callId: string; threadId: string }>;
export type CallSpeechSession = Readonly<{ callId: string; principal: string; threadId: string; targetId: string; desktop?: boolean }>;
type Turn = {
  identity: CallReplyIdentity;
  sequence: number;
  providerTurnId?: string;
  host?: boolean;
  parentGeneration?: string;
  selected?: boolean;
  resolved?: boolean;
  items: string[];
  itemBytes: number;
  events: Set<string>;
  sealed: boolean;
  messageId?: string;
  controller: AbortController;
};
export type CallHeardReport = { ended: number; cut: boolean; cutIn: boolean };
type Scope = {
  session: CallSpeechSession;
  connection: object & { terminate?: () => void };
  authority: CallAuthority;
  emit: (event: CallSpeechEvent) => boolean;
  turns: Map<string, Turn>;
  closed: Set<string>;
  replies: Map<string, Turn>;
  history: Map<string, PresentationFields["history"]>;
  hostEntries: Map<string, { botId: string; owner: PresentationFields["history"][number]; entry?: PresentationFields["history"][number]; delivered: string[]; reported?: boolean }>;
};

/** No string from HTTP can mint an authority or seal a source. */
export class CallSpeechCoordinator {
  private readonly source = new CallSpeechSource();
  private readonly scopes = new Map<string, Scope>();
  private readonly retired = new Map<string, Set<string>>();
  private readonly maySpeak: (session: CallSpeechSession, botId: string) => boolean;
  constructor(maySpeak: (session: CallSpeechSession, botId: string) => boolean) { this.maySpeak = maySpeak; }
  get bootId(): string { return this.source.bootId; }

  attach(session: CallSpeechSession, connection: object, emit: Scope["emit"]): void {
    const previous = this.scopes.get(session.callId);
    if (previous) this.emit(previous, { type: "call.speech.invalidated", callId: session.callId, threadId: previous.session.threadId });
    this.close(session.callId);
    if (!this.retired.has(session.callId) && this.retired.size >= 16) throw new Error("call speech session limit");
    const closed = this.retired.get(session.callId) ?? new Set<string>();
    this.retired.set(session.callId, closed);
    const authority = this.source.open(session.principal, session.threadId);
    this.scopes.set(session.callId, { session: Object.freeze({ ...session }), connection, authority, emit, turns: new Map(), closed, replies: new Map(), history: new Map(), hostEntries: new Map() });
  }

  detach(callId: string, connection: object): void {
    if (this.scopes.get(callId)?.connection === connection) this.close(callId);
  }

  close(callId: string): void {
    const scope = this.scopes.get(callId);
    if (!scope) return;
    this.scopes.delete(callId);
    for (const [key, turn] of scope.turns) { scope.closed.add(key); turn.controller.abort(); }
    this.source.close(scope.authority);
    scope.turns.clear();
    scope.replies.clear();
    scope.history.clear();
    scope.hostEntries.clear();
    scope.connection.terminate?.();

  }

  /** Only the durable session end releases its bounded tombstones. */
  end(callId: string): void { this.close(callId); this.retired.delete(callId); }

  bind(threadId: string, botId: string, generationId: string, providerTurnId: string): void {
    this.each(threadId, botId, generationId, (_scope, turn) => {
      if (turn.providerTurnId && turn.providerTurnId !== providerTurnId) throw new Error("call speech provider changed");
      turn.providerTurnId = providerTurnId;
    });
  }

  /** Resolve only an accepted provider identity, never the thread's current generation. */
  provider(threadId: string, providerTurnId: string | undefined): { botId: string; generationId: string } | undefined {
    if (!providerTurnId) return undefined;
    for (const scope of this.scopes.values()) {
      if (scope.session.threadId !== threadId) continue;
      for (const turn of scope.turns.values()) if (turn.providerTurnId === providerTurnId) {
        return { botId: turn.identity.botId, generationId: turn.identity.generationId };
      }
    }
    return undefined;
  }

  /** A trusted dispatch producer, before source transformations. Missing turn identity stays silent. */
  begin(threadId: string, botId: string, generationId: string): void {
    for (const scope of this.scopes.values()) {
      if (scope.session.threadId !== threadId || !this.maySpeak(scope.session, botId)) continue;
      const key = this.key(botId, generationId);
      if (scope.turns.has(key) || scope.closed.has(key)) continue;
      // Bound identifier bookkeeping as well as raw buffers. Closing a call never revives its replies.
      if (scope.closed.size + scope.turns.size >= 4096) { this.close(scope.session.callId); continue; }
      try {
        const identity = this.source.begin(scope.authority, botId, generationId);
        const turn: Turn = { identity, sequence: 0, items: [], itemBytes: 0, events: new Set(), sealed: false, controller: new AbortController() };
        scope.turns.set(key, turn);
        scope.replies.set(identity.replyId, turn);
      } catch { scope.closed.add(key); }
    }
  }

  append(threadId: string, botId: string, generationId: string, eventId: string, text: string): void {
    this.each(threadId, botId, generationId, (scope, turn) => {
      if (!this.takeEvent(turn, eventId)) return;
      this.source.append(scope.authority, turn.identity, turn.sequence++, text);
    });
  }

  /** The authoritative complete raw item, before display or goal cleanup. */
  item(threadId: string, botId: string, generationId: string, eventId: string, text: string): void {
    this.each(threadId, botId, generationId, (scope, turn) => {
      if (!this.takeEvent(turn, eventId)) return;
      turn.itemBytes += Buffer.byteLength(text) + (turn.items.length ? 1 : 0);
      if (turn.itemBytes > MAX_SOURCE_BYTES) throw new Error("call speech source limit");
      turn.items.push(text);
      this.source.replace(scope.authority, turn.identity, turn.items.join("\n"));
    });
  }

  /** Only the successful producer terminal fold supplies the final stored message identity. */
  settle(threadId: string, botId: string, generationId: string, messageId: string | undefined, completed: boolean): void {
    this.each(threadId, botId, generationId, (scope, turn) => {
      if (!completed || !messageId || !turn.items.length) { this.closeTurn(scope, turn); return; }
      this.source.seal(scope.authority, turn.identity, turn.items.join("\n"));
      turn.items = [];
      turn.events.clear();
      turn.itemBytes = 0;
      turn.sealed = true;
      turn.messageId = messageId;
      if (!this.emit(scope, { type: "call.speech.ready", callId: scope.session.callId, threadId, botId, messageId, replyId: turn.identity.replyId, bootId: this.bootId })) this.close(scope.session.callId);
    });
  }

  invalidate(threadId: string, generationId?: string, receivingOnly = false): void {
    for (const scope of this.scopes.values()) {
      if (scope.session.threadId !== threadId) continue;
      if (!receivingOnly && !this.emit(scope, { type: "call.speech.invalidated", callId: scope.session.callId, threadId })) { this.close(scope.session.callId); continue; }
      for (const turn of [...scope.turns.values()]) if ((!generationId || turn.identity.generationId === generationId || turn.parentGeneration === generationId) && (!receivingOnly || !turn.sealed)) this.closeTurn(scope, turn);
    }
  }

  invalidateAll(botId?: string): void {
    const threads = new Set([...this.scopes.values()].filter(scope => !botId || [...scope.turns.values()].some(turn => turn.identity.botId === botId)).map(scope => scope.session.threadId));
    for (const threadId of threads) this.invalidate(threadId);
  }

  /** Resolve complete source for a model input without recovering a clipped transcript derivative. */
  presentation(callId: string, principal: string, threadId: string, messageId: string): string | undefined {
    const scope = this.requireScope(callId, principal, threadId);
    const turn = [...scope.turns.values()].find((candidate) => candidate.messageId === messageId && candidate.sealed);
    if (!turn || !this.maySpeak(scope.session, turn.identity.botId)) return undefined;
    try { return this.source.presentation(scope.authority, turn.identity); } catch { return undefined; }
  }

  reportHeard(callId: string, principal: string, threadId: string, replyId: string, report: CallHeardReport): void {
    const scope = this.requireScope(callId, principal, threadId);
    const record = scope.hostEntries.get(replyId);
    if (!record || record.reported) return;
    record.reported = true;
    const ended = Math.max(0, Math.min(report.ended, record.delivered.length));
    const heard = record.delivered.slice(0, ended);
    if (report.cut && record.delivered[ended]) heard.push(`${record.delivered[ended].replace(/[.!?]+$/, "")}…`);
    const text = presentationPrefix(heard.join(" "), 500) + (report.cutIn ? " [the owner cut in here]" : "");
    if (!text) return;
    const history = scope.history.get(record.botId) ?? [];
    const entry: PresentationFields["history"][number] = record.entry ? { ...record.entry, text } : { role: "host", text };
    if (record.entry) {
      scope.history.set(record.botId, history.map(old => old === record.entry ? entry : old));
    } else {
      const index = history.indexOf(record.owner);
      if (index < 0) return;
      scope.history.set(record.botId, [...history.slice(0, index + 1), entry, ...history.slice(index + 1)].slice(-12));
    }
    record.entry = entry;
    this.pruneHostEntries(scope);
  }

  private pruneHostEntries(scope: Scope): void {
    for (const [id, record] of scope.hostEntries) {
      const history = scope.history.get(record.botId);
      if (!history?.includes(record.owner) || (record.entry && !history.includes(record.entry))) scope.hostEntries.delete(id);
    }
  }

  /** Server-owned host generation and atomic brief/fallback selection. */
  openPresentation(callId: string, principal: string, threadId: string, botId: string, engineReplyId?: string): {
    signal: AbortSignal;
    answer?: string;
    sourceMessageId?: string;
    history: PresentationFields["history"];
    resolve(messageId: string): string | undefined;
    snapshot(fields: PresentationFields): ProtectedPresentation;
    source(raw: string): void;
    handDown(request: string): string;
    finish(success: boolean, spoken: boolean): CallSpeechReady | undefined;
    cancel(): void;
  } {
    const scope = this.requireScope(callId, principal, threadId);
    if (!this.maySpeak(scope.session, botId)) throw new Error("call presentation unavailable");
    const engine = engineReplyId ? scope.replies.get(engineReplyId) : undefined;
    if (engineReplyId && (!engine?.sealed || engine.selected || engine.resolved || engine.host || engine.identity.botId !== botId)) throw new Error("call presentation unavailable");
    const answer = engine ? this.source.presentation(scope.authority, engine.identity) : undefined;
    for (const old of [...scope.turns.values()]) if (old.host && old.identity.botId === botId) this.closeTurn(scope, old);
    if (scope.closed.size + scope.turns.size >= 4096) throw new Error("call presentation limit");
    const generationId = randomUUID();
    const identity = this.source.begin(scope.authority, botId, generationId);
    const turn: Turn = { identity, sequence: 0, items: [], itemBytes: 0, events: new Set(), sealed: false, controller: new AbortController(), host: true, parentGeneration: engine?.identity.generationId };
    scope.turns.set(this.key(botId, generationId), turn); scope.replies.set(identity.replyId, turn);
    if (engine) engine.selected = true;
    const live = () => !selected && this.scopes.get(callId) === scope && !turn.controller.signal.aborted && this.maySpeak(scope.session, botId) && (!engine || scope.replies.get(engine.identity.replyId) === engine);
    const ready = (chosen: Turn): CallSpeechReady => ({ type: "call.speech.ready", callId, threadId, botId, messageId: chosen.messageId!, replyId: chosen.identity.replyId, bootId: this.bootId });
    let selected = false;
    let protectedSaid = "";
    let handDown: { id: string; request: string } | undefined;
    const remember = (text: string, replyId?: string) => {
      const prior = scope.history.get(botId) ?? [];
      const owner: PresentationFields["history"][number] = { role: "owner", text: presentationPrefix(protectedSaid, 2000) };
      const entry: PresentationFields["history"][number] | undefined = !replyId || handDown
        ? { role: "host", text: replyId ? "" : presentationPrefix(text, 500), ...(handDown ? { handDown } : {}) }
        : undefined;
      scope.history.set(botId, [...prior, owner, ...(entry ? [entry] : [])].slice(-12));
      if (replyId) scope.hostEntries.set(replyId, { botId, owner, entry, delivered: [] });
      this.pruneHostEntries(scope);
    };
    return {
      history: scope.history.get(botId) ?? [],
      resolve: messageId => live() ? this.presentation(callId, principal, threadId, messageId) : undefined,
      signal: turn.controller.signal, answer, sourceMessageId: engine?.messageId,
      snapshot: fields => {
        if (!live() || selected) throw new Error("call presentation unavailable");
        const snapshot = mintCallPresentation({ bootId: this.bootId, callId, threadId, botId, generationId, sourceMessageId: engine?.messageId }, fields, turn.controller.signal, live);
        protectedSaid = readCallPresentation(snapshot).said;
        return snapshot;
      },
      handDown: request => {
        if (!live()) throw new Error("call presentation unavailable");
        handDown ??= { id: randomUUID(), request };
        return handDown.id;
      },
      source: raw => {
        if (!live() || selected) throw new Error("call presentation unavailable");
        try {
          turn.itemBytes += Buffer.byteLength(raw) + (turn.items.length ? 1 : 0);
          if (turn.itemBytes > MAX_SOURCE_BYTES) throw new Error("call speech source limit");
          turn.items.push(raw);
          this.source.replace(scope.authority, identity, turn.items.join("\n"));
        } catch { this.closeTurn(scope, turn); if (engine) this.closeTurn(scope, engine); throw new Error("call presentation unavailable"); }
      },
      finish: (success, spoken) => {
        if (selected) return undefined;
        if (!live()) { this.closeTurn(scope, turn); if (engine) this.closeTurn(scope, engine); return undefined; }
        selected = true;
        if (success && spoken && turn.items.some(text => text.trim())) {
          this.source.seal(scope.authority, identity, undefined, protectedHostUtterances);
          remember(this.source.presentation(scope.authority, identity), identity.replyId);
          turn.sealed = true; turn.messageId = randomUUID(); turn.items = []; turn.itemBytes = 0;
          // The selected host keeps its own source. No fallback survives to race its drain.
          if (engine) this.closeTurn(scope, engine, false);
          return ready(turn);
        }
        // No output has drained. Only this server decision can unlock the protected engine fallback.
        if (engine) { remember(this.source.presentation(scope.authority, engine.identity), engine.identity.replyId); this.source.fallback(scope.authority, engine.identity); engine.selected = false; engine.resolved = true; this.closeTurn(scope, turn, false); return ready(engine); }
        if (success && handDown) remember("");
        this.closeTurn(scope, turn);
        return undefined;
      },
      cancel: () => { this.closeTurn(scope, turn); if (engine) this.closeTurn(scope, engine); },
    };
  }

  /** Single-consumer audio admission. Every continuation checks the same live scope and turn. */
  claim(callId: string, principal: string, threadId: string, replyId: string): { botId: string; signal: AbortSignal; utterances: IterableIterator<string>; delivered(utterance: string): void; current(): boolean; close(): void } {
    const scope = this.requireScope(callId, principal, threadId);
    const turn = scope.replies.get(replyId);
    if (!turn?.sealed || turn.selected || !this.maySpeak(scope.session, turn.identity.botId)) throw new Error("call speech unavailable");
    const drain = this.source.drain(scope.authority, turn.identity);
    const owner = this;
    return {
      delivered: utterance => { scope.hostEntries.get(replyId)?.delivered.push(utterance); },
      botId: turn.identity.botId,
      signal: turn.controller.signal,
      current: () => owner.scopes.get(callId) === scope && !turn.controller.signal.aborted && owner.maySpeak(scope.session, turn.identity.botId),
      utterances: (function* () {
        let completed = false;
        try {
          for (const utterance of drain) {
            if (owner.scopes.get(callId) !== scope || turn.controller.signal.aborted || !owner.maySpeak(scope.session, turn.identity.botId)) return;
            yield utterance;
          }
          completed = true;
        } finally { owner.closeTurn(scope, turn, !completed); }
      })(),
      close: () => this.closeTurn(scope, turn),
    };
  }

  private emit(scope: Scope, event: CallSpeechEvent): boolean {
    try { return scope.emit(event); } catch { return false; }
  }

  private key(botId: string, generationId: string): string { return JSON.stringify([botId, generationId]); }
  private requireScope(callId: string, principal: string, threadId: string): Scope {
    const scope = this.scopes.get(callId);
    if (!scope || scope.session.principal !== principal || scope.session.threadId !== threadId) throw new Error("call speech unavailable");
    return scope;
  }
  private takeEvent(turn: Turn, eventId: string): boolean {
    if (turn.sealed || turn.events.has(eventId)) return false;
    if (turn.events.size >= 16_384) throw new Error("call speech event limit");
    turn.events.add(eventId);
    return true;
  }
  private each(threadId: string, botId: string, generationId: string, run: (scope: Scope, turn: Turn) => void): void {
    for (const scope of this.scopes.values()) {
      if (scope.session.threadId !== threadId) continue;
      const turn = scope.turns.get(this.key(botId, generationId));
      if (!turn || turn.sealed) continue;
      try { run(scope, turn); } catch { this.closeTurn(scope, turn); }
    }
  }
  private closeTurn(scope: Scope, turn: Turn, abort = true): void {
    const key = this.key(turn.identity.botId, turn.identity.generationId);
    if (scope.turns.get(key) !== turn) return;
    scope.closed.add(key);
    scope.turns.delete(key);
    scope.replies.delete(turn.identity.replyId);
    if (abort) turn.controller.abort();
    turn.items = [];
    turn.events.clear();
    try { this.source.cancel(scope.authority, turn.identity); } catch { /* drain already closed the source */ }
  }
}
