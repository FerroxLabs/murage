// Copyright 2026 Ferrox Labs
// Seam shape follows server/channels/slack/transport.ts; the contract is WHATSAPP-DESIGN.md 6 and 7.1.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `WhatsAppTransport` is the seam between the service and a backend. `BridgeTransport` is the linked-device
// backend: it speaks to the bridge child through `BridgeHost` and does nothing else (no policy, no echo or
// dedupe, which live in the bridge and in core/access). The Cloud API backend (W9) implements the same
// interface with a different `capabilities` record; it is not a transport-only swap (design 7.1).
import { ChannelSendError } from "../durable-delivery.ts";
import { BridgeHost, BridgeRequestError, type BridgeHostOptions, type HostLifecycle } from "./bridge-host.ts";
import type { BlockedReason, CloseDecision, LinkState } from "./core/close-decision.ts";
import type { ChildMessage, InboundEnvelope, MessageKeyRef, QuoteRef, SendErrorWire } from "./core/protocol.ts";
import type { LidMapping } from "./core/lid.ts";

export interface TransportCapabilities {
  linking: "qr-or-code" | "token";
  groups: boolean;
  presence: boolean;
  readReceipts: boolean;
  lidResolution: boolean;
  ownSendEcho: boolean;
}

/** QR text and pairing codes are shown, never stored or logged (design 2.2, 2.3). */
export type LinkEvent =
  | { kind: "qr"; text: string; version: number; issuedAt: number }
  | { kind: "pairing-code"; code: string; phone: string };

export interface HealthEvent {
  state: LinkState;
  self?: { pn: string; lid?: string };
  decision?: CloseDecision;
  blockedReason?: BlockedReason;
  attempt?: number;
  retryInMs?: number;
  /** Last time the socket was seen connected; the service persists it for the catch-up rule (design 5.5). */
  lastSeenAtMs?: number;
  webVersion?: [number, number, number];
}

/** Bridge notes that are not a connection state: a write that failed, a truncated catch-up, a fatal child error. */
export type StatusNote =
  | { kind: "admitted"; at: number }
  | { kind: "ingress-write-failed"; remoteJid: string; id: string }
  | { kind: "catch-up-truncated" }
  | { kind: "fatal"; message: string };

export interface TransportHandlers {
  /** One received message. `ack` tells the transport the service wrote it down; until then it is re-sent. */
  onEnvelope(envelope: InboundEnvelope, ack: () => Promise<void>): void;
  onHealth(event: HealthEvent): void;
  onNote?(note: StatusNote): void;
}

export interface SendInput {
  chatId: string;
  text: string;
  /** Ids reserved on disk for this text before the call (one per chunk). */
  ids: string[];
  quote?: QuoteRef;
  signal: AbortSignal;
}

export interface WhatsAppTransport {
  capabilities: TransportCapabilities;
  /** Starts the backend. Resolves once started; connection state arrives through `onHealth`. */
  start(handlers: TransportHandlers): Promise<void>;
  /** Link events (QR, pairing code) go to the one listener; nothing else ever sees them. */
  onLink(listener: (event: LinkEvent) => void): void;
  link(input: { method: "qr" | "code"; phone?: string }): Promise<void>;
  stop(): Promise<void>;
  /** Best-effort logout from WhatsApp (the service wipes local data after). */
  unlink(): Promise<void>;
  revoke?(chatId: string): void;
  self(): { pn: string; lid?: string } | null;
  resolve: LidMapping;
  /** Puts ids on disk before any send (design 5.5 echo rule). */
  reserve(input: { chatId: string; text: string }): Promise<{ ids: string[] }>;
  /** Sends under reserved ids. A rejection after the first chunk is a `ChannelSendError` with `partial` set. */
  sendText(input: SendInput): Promise<{ ids: string[] }>;
  /** Puts the id of a voice note on disk before it is sent (the same echo rule as text). */
  reserveAudio?(chatId: string): Promise<{ ids: string[] }>;
  /**
   * Sends one audio clip. The bridge sends an Ogg clip as a voice bubble (`ptt`) and every other container as a plain audio
   * message; Murage's voices make mp3 or wav and no Opus encoder is bundled, so today they arrive as audio messages.
   */
  sendAudio?(input: { chatId: string; name: string; mime: string; bytes: Uint8Array; ids: string[]; signal: AbortSignal }): Promise<{ ids: string[] }>;
  groups?(): Promise<Array<{ jid: string; name: string }>>;
  markRead?(keys: MessageKeyRef[]): void;
  presence?(chatId: string, state: "composing" | "paused"): void;
}

/** Maps a bridge request failure to the receipt ledger's error codes (design 6). */
export function toChannelSendError(error: unknown): ChannelSendError {
  if (error instanceof ChannelSendError) return error;
  if (error instanceof BridgeRequestError) {
    const wire: SendErrorWire = error.error;
    const partial = error.sentIds.length > 0;
    return new ChannelSendError(wire.code, partial || wire.uncertain === true, wire.retryAfterSeconds, partial);
  }
  return new ChannelSendError("unavailable", false);
}

export const BRIDGE_CAPABILITIES: TransportCapabilities = {
  linking: "qr-or-code", groups: true, presence: true, readReceipts: true, lidResolution: true, ownSendEcho: true,
};

export type BridgeTransportOptions = Omit<BridgeHostOptions, "onMessage" | "onLifecycle"> & {
  /** Tests build a host around their own fork; production leaves this unset. */
  hostFactory?: (options: BridgeHostOptions) => BridgeHost;
};

export class BridgeTransport implements WhatsAppTransport {
  readonly capabilities = BRIDGE_CAPABILITIES;
  private host?: BridgeHost;
  private handlers?: TransportHandlers;
  private linkListener?: (event: LinkEvent) => void;
  private selfIdentity: { pn: string; lid?: string } | null = null;
  private options: BridgeTransportOptions;
  constructor(options: BridgeTransportOptions) { this.options = options; }

  onLink(listener: (event: LinkEvent) => void): void { this.linkListener = listener; }

  async start(handlers: TransportHandlers): Promise<void> {
    if (this.host) throw new Error("WhatsApp transport already started");
    this.handlers = handlers;
    const { hostFactory, ...rest } = this.options;
    const hostOptions: BridgeHostOptions = { ...rest, onMessage: m => this.onChild(m), onLifecycle: e => this.onLifecycle(e) };
    this.host = hostFactory ? hostFactory(hostOptions) : new BridgeHost(hostOptions);
    await this.host.start();
  }

  private onLifecycle(event: HostLifecycle): void {
    if (event.kind === "exited" && event.respawnInMs !== null) this.handlers?.onHealth({ state: "retry", retryInMs: event.respawnInMs });
    else if (event.kind === "key-unavailable") this.handlers?.onHealth({ state: "blocked", blockedReason: "credential-store", retryInMs: event.respawnInMs });
    else if (event.kind === "handshake-timeout" || event.kind === "unresponsive") this.handlers?.onNote?.({ kind: "fatal", message: event.kind });
  }

  private onChild(message: ChildMessage): void {
    switch (message.kind) {
      case "qr": this.linkListener?.({ kind: "qr", text: message.text, version: message.version, issuedAt: message.issuedAt }); return;
      case "pairing-code": this.linkListener?.({ kind: "pairing-code", code: message.code, phone: message.phone }); return;
      case "connection":
        if (message.self) this.selfIdentity = message.self;
        this.handlers?.onHealth({
          state: message.state, ...(message.self ? { self: message.self } : {}), ...(message.decision ? { decision: message.decision } : {}),
          ...(message.blockedReason ? { blockedReason: message.blockedReason } : {}), ...(message.attempt !== undefined ? { attempt: message.attempt } : {}),
          ...(message.retryInMs !== undefined ? { retryInMs: message.retryInMs } : {}), ...(message.lastSeenAtMs !== undefined ? { lastSeenAtMs: message.lastSeenAtMs } : {}),
          ...(message.webVersion ? { webVersion: message.webVersion } : {}),
        });
        return;
      case "inbound": {
        const seq = message.seq;
        this.handlers?.onEnvelope(message.envelope, async () => { this.host?.ack(seq); });
        return;
      }
      case "status":
        if (message.admittedAtMs !== undefined) this.handlers?.onNote?.({ kind: "admitted", at: message.admittedAtMs });
        if (message.ingressWriteFailed) this.handlers?.onNote?.({ kind: "ingress-write-failed", ...message.ingressWriteFailed });
        if (message.catchUpTruncated) this.handlers?.onNote?.({ kind: "catch-up-truncated" });
        return;
      case "fatal": this.handlers?.onNote?.({ kind: "fatal", message: message.message }); return;
      default: return;
    }
  }

  private requireHost(): BridgeHost {
    if (!this.host) throw new ChannelSendError("offline", false);
    return this.host;
  }

  async link(input: { method: "qr" | "code"; phone?: string }): Promise<void> {
    if (!await this.requireHost().link(input.method, input.phone)) throw new ChannelSendError("offline", false);
  }

  async stop(): Promise<void> {
    const host = this.host;
    await host?.stop();
    if (this.host === host) this.host = undefined;
    this.selfIdentity = null;
  }

  async unlink(): Promise<void> {
    // The child logs out and exits on its own; a missing channel only means there is nothing to log out of.
    await this.host?.logout();
  }

  revoke(chatId: string): void { this.host?.revoke(chatId); }

  self(): { pn: string; lid?: string } | null { return this.selfIdentity; }

  readonly resolve: LidMapping = {
    pnForLid: async lid => (await this.query(() => this.requireHost().resolve("pn-for-lid", lid)))?.jid ?? undefined,
    lidForPn: async pn => (await this.query(() => this.requireHost().resolve("lid-for-pn", pn)))?.jid ?? undefined,
  };

  /** A failed lookup is "no mapping", never a thrown error inside an access decision. */
  private async query<T>(run: () => Promise<T>): Promise<T | undefined> {
    try { return await run(); } catch { return undefined; }
  }

  async reserve(input: { chatId: string; text: string }): Promise<{ ids: string[] }> {
    try { return { ids: await this.requireHost().reserve(input.chatId, { type: "text", text: input.text }) }; }
    catch (error) { throw toChannelSendError(error); }
  }

  async sendText(input: SendInput): Promise<{ ids: string[] }> {
    const host = this.requireHost();
    const revoke = () => host.revoke(input.chatId);
    input.signal.addEventListener("abort", revoke, { once: true });
    try {
      if (input.signal.aborted) throw new ChannelSendError("offline", false);
      return { ids: await host.send(input.chatId, input.ids, { type: "text", text: input.text, ...(input.quote ? { quote: input.quote } : {}) }) };
    } catch (error) { throw toChannelSendError(error); }
    finally { input.signal.removeEventListener("abort", revoke); }
  }

  async reserveAudio(chatId: string): Promise<{ ids: string[] }> {
    try { return { ids: await this.requireHost().reserve(chatId, { type: "audio" }) }; }
    catch (error) { throw toChannelSendError(error); }
  }

  async sendAudio(input: { chatId: string; name: string; mime: string; bytes: Uint8Array; ids: string[]; signal: AbortSignal }): Promise<{ ids: string[] }> {
    const host = this.requireHost();
    const revoke = () => host.revoke(input.chatId);
    input.signal.addEventListener("abort", revoke, { once: true });
    try {
      if (input.signal.aborted) throw new ChannelSendError("offline", false);
      return { ids: await host.send(input.chatId, input.ids, { type: "audio", name: input.name, mime: input.mime, bytesBase64: Buffer.from(input.bytes).toString("base64") }) };
    } catch (error) { throw toChannelSendError(error); }
    finally { input.signal.removeEventListener("abort", revoke); }
  }

  async groups(): Promise<Array<{ jid: string; name: string }>> {
    try { return (await this.requireHost().groups()).map(g => ({ jid: g.jid, name: g.subject })); }
    catch (error) { throw toChannelSendError(error); }
  }

  markRead(keys: MessageKeyRef[]): void { this.host?.read(keys); }
  presence(chatId: string, state: "composing" | "paused"): void { this.host?.presence(chatId, state); }
}
