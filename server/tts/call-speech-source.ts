/** Volatile, server-issued authority for a complete call reply. No source is persisted. */
import { randomUUID } from "node:crypto";
import { capSpeech, compileSpeechChunks, compileSpeechSource, MAX_SOURCE_BYTES, protectSpeechSource, REST_ON_SCREEN } from "./speech-source.ts";
import { plainSpeechUtterances } from "./speech-text.ts";
import { optionBCut } from "./speech-source-option-b.ts";

export type CallAuthority = Readonly<{ bootId: string; callSessionId: string; principalId: string; threadId: string }>;
export type CallReplyIdentity = Readonly<CallAuthority & { replyId: string; botId: string; generationId: string }>;
type Phase = "receiving" | "sealed" | "draining" | "closed";
type Reply = {
  identity: CallReplyIdentity;
  phase: Phase;
  sequence: number;
  raw: string;
  bytes: number;
  utterances: string[];
  cursor: number;
  forceCut?: boolean;
  protectedText?: string;
  presentationText?: string;
};
export class CallSpeechSource {
  readonly bootId = randomUUID();
  private readonly sessions = new Set<CallAuthority>();
  private readonly replies = new Map<string, Reply>();
  private totalBytes = 0;
  private readonly limits: { perCallBytes: number; installationBytes: number; perCallContexts: number };
  constructor(limits = { perCallBytes: 1024 * 1024, installationBytes: 4 * 1024 * 1024, perCallContexts: 16 }) { this.limits = limits; }

  /** Called only after call admission and visible room membership have succeeded. */
  open(principalId: string, threadId: string): CallAuthority {
    const authority = Object.freeze({ bootId: this.bootId, callSessionId: randomUUID(), principalId, threadId });
    this.sessions.add(authority);
    return authority;
  }

  /** An authenticated producer allocates the reply before receiving engine output. */
  begin(authority: CallAuthority, botId: string, generationId: string): CallReplyIdentity {
    this.requireSession(authority);
    const contexts = [...this.replies.values()].filter((r) => r.identity.callSessionId === authority.callSessionId && r.phase !== "closed");
    if (contexts.length >= this.limits.perCallContexts) throw new Error("call speech context limit");
    const identity = Object.freeze({ ...authority, replyId: randomUUID(), botId, generationId });
    this.replies.set(identity.replyId, { identity, phase: "receiving", sequence: 0, raw: "", bytes: 0, utterances: [], cursor: 0 });
    return identity;
  }

  append(authority: CallAuthority, identity: CallReplyIdentity, sequence: number, delta: string): void {
    const reply = this.requireReply(authority, identity);
    if (reply.phase !== "receiving" || sequence !== reply.sequence) throw new Error("stale call speech source");
    // UTF-16 chunks may split a surrogate pair. Correct the independently counted replacement bytes.
    const joinedPair = /[\uD800-\uDBFF]$/.test(reply.raw) && /^[\uDC00-\uDFFF]/.test(delta);
    const bytes = reply.bytes + Buffer.byteLength(delta) - (joinedPair ? 2 : 0);
    this.reserveBytes(authority, reply, bytes);
    reply.raw += delta;
    reply.sequence++;
  }

  /** A trusted producer replaces its full raw pre-image before sealing, preserving an established cut. */
  replace(authority: CallAuthority, identity: CallReplyIdentity, replacement: string): void {
    const reply = this.requireReply(authority, identity);
    if (reply.phase !== "receiving") throw new Error("stale call speech source");
    if (replacement === reply.raw) return;
    try {
      reply.forceCut ||= (protectSpeechSource(reply.raw).cut !== null) || optionBCut(reply.raw);
    } catch {
      reply.forceCut = true;
    }
    this.reserveBytes(authority, reply, Buffer.byteLength(replacement));
    reply.raw = replacement;
  }

  /** Successful producer completion alone seals a context. Client requests cannot supply this authority. */
  seal(authority: CallAuthority, identity: CallReplyIdentity, replacement?: string, project?: (protectedText: string) => string[]): void {
    const reply = this.requireReply(authority, identity);
    if (reply.phase !== "receiving") throw new Error("stale call speech source");
    if (replacement !== undefined) this.replace(authority, identity, replacement);
    reply.protectedText = reply.forceCut ? REST_ON_SCREEN : compileSpeechSource(reply.raw, { maxUnits: MAX_SOURCE_BYTES * 2 });
    reply.presentationText = reply.forceCut ? REST_ON_SCREEN : compileSpeechSource(reply.raw, { presentation: true, maxUnits: MAX_SOURCE_BYTES * 2 });
    // D24 B.2: sealing stores exact checked projections; custom splitter changes
    // run inside compilation, and drain only releases the resulting slices.
    reply.utterances = reply.forceCut || reply.protectedText === REST_ON_SCREEN || reply.presentationText === REST_ON_SCREEN
      ? [REST_ON_SCREEN] : compileSpeechChunks(reply.raw, project ?? plainSpeechUtterances, { maxUnits: MAX_SOURCE_BYTES * 2 });
    if (reply.utterances.length === 1 && reply.utterances[0] === REST_ON_SCREEN) {
      // A final projection failure must remain a whole cut, including fallback.
      reply.protectedText = reply.presentationText = REST_ON_SCREEN;
    }
    reply.phase = "sealed";
  }

  /** Optional presentation consumers receive only the label-inclusive projection. */
  presentation(authority: CallAuthority, identity: CallReplyIdentity): string {
    const reply = this.requireReply(authority, identity);
    if (reply.phase !== "sealed") throw new Error("call speech source not sealed");
    return reply.presentationText!;
  }

  /** The coordinator may shorten only this sealed protected projection for failed briefs. */
  fallback(authority: CallAuthority, identity: CallReplyIdentity): void {
    const reply = this.requireReply(authority, identity);
    if (reply.phase !== "sealed") throw new Error("call speech source not sealed");
    const full = reply.protectedText!;
    if (full === REST_ON_SCREEN) { reply.utterances = [REST_ON_SCREEN]; return; }
    const cut = full.endsWith(REST_ON_SCREEN);
    const prefix = cut ? full.slice(0, -REST_ON_SCREEN.length).trimEnd() : full;
    reply.utterances = compileSpeechChunks(prefix, plainSpeechUtterances, { pronounce: false, maxUnits: MAX_SOURCE_BYTES * 2,
      releaseTransform: text => capSpeech(text, 450, cut || text.length > 450) });
  }

  /** The first drain claims the stream. Late subscribers cannot replay a draining reply. */
  drain(authority: CallAuthority, identity: CallReplyIdentity): IterableIterator<string> {
    const reply = this.requireReply(authority, identity);
    if (reply.phase !== "sealed") throw new Error("call speech source not sealed");
    reply.phase = "draining";
    const owner = this;
    return (function* () {
      try {
        for (;;) {
          owner.requireReply(authority, identity);
          if (reply.cursor >= reply.utterances.length) return;
          if (reply.phase !== "draining") return;
          yield reply.utterances[reply.cursor++];
        }
      } finally {
        owner.closeReply(reply);
      }
    })();
  }

  cancel(authority: CallAuthority, identity: CallReplyIdentity): void {
    this.closeReply(this.requireReply(authority, identity));
  }

  close(authority: CallAuthority): void {
    if (!this.sessions.delete(authority)) return;
    for (const [id, reply] of this.replies) {
      if (reply.identity.callSessionId !== authority.callSessionId) continue;
      this.closeReply(reply);
      this.replies.delete(id);
    }
  }

  dispose(): void { for (const authority of this.sessions) this.close(authority); }

  private requireSession(authority: CallAuthority): void {
    if (!this.sessions.has(authority) || authority.bootId !== this.bootId) throw new Error("closed call speech session");
  }
  private requireReply(authority: CallAuthority, identity: CallReplyIdentity): Reply {
    this.requireSession(authority);
    const reply = this.replies.get(identity.replyId);
    if (!reply || reply.identity !== identity || identity.callSessionId !== authority.callSessionId || reply.phase === "closed") {
      throw new Error("closed call speech source");
    }
    return reply;
  }
  private reserveBytes(authority: CallAuthority, reply: Reply, bytes: number): void {
    const change = bytes - reply.bytes;
    let callBytes = change;
    for (const item of this.replies.values()) if (item.identity.callSessionId === authority.callSessionId) callBytes += item.bytes;
    if (bytes > MAX_SOURCE_BYTES || callBytes > this.limits.perCallBytes || this.totalBytes + change > this.limits.installationBytes) {
      this.closeReply(reply);
      throw new Error("call speech source limit");
    }
    this.totalBytes += change;
    reply.bytes = bytes;
  }
  private closeReply(reply: Reply): void {
    this.totalBytes -= reply.bytes;
    reply.bytes = 0;
    reply.raw = "";
    reply.utterances = [];
    reply.protectedText = undefined;
    reply.presentationText = undefined;
    reply.phase = "closed";
    this.replies.delete(reply.identity.replyId);
  }
}
