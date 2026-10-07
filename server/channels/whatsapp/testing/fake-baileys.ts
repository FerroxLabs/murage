// Copyright 2026 Ferrox Labs
// The EventEmitter fake-socket pattern follows OpenClaw extensions/whatsapp/src/auto-reply.test-harness.ts
// (MIT, OpenClaw Foundation). No network, no WhatsApp: a scripted stand-in for the slice of Baileys the bridge uses.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { BaileysLib, SocketLike } from "../bridge.ts";

export const FAKE_PN = "15550001111:7@s.whatsapp.net";
export const FAKE_LID = "99887766:7@lid";

export class FakeSocket implements SocketLike {
  readonly ev = new EventEmitter();
  readonly ws = new EventEmitter();
  user: { id: string; lid?: string } | null = null;
  readonly config: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  readonly sent: Array<{ jid: string; content: Record<string, unknown>; options: Record<string, unknown> | undefined }> = [];
  readonly presence: Array<{ state: string; jid?: string }> = [];
  readonly reads: unknown[] = [];
  readonly pairingRequests: string[] = [];
  ended = 0;
  loggedOut = 0;
  /** Replace to script a failure or a delay. Receives the 1-based call number. */
  onSend: (call: number, jid: string, content: Record<string, unknown>, options: Record<string, unknown> | undefined) => Promise<unknown> = async () => undefined;
  onPresence: (state: string) => Promise<unknown> = async () => undefined;
  onPairing: (phone: string) => Promise<string> = async () => "ABCD1234";
  groups: Record<string, { id: string; subject?: string; participants?: unknown[] }> = {};
  lidMap: Record<string, string> = {};
  readonly signalRepository = {
    lidMapping: {
      getPNForLID: async (lid: string) => this.lidMap[lid] ?? null,
      getLIDForPN: async (pn: string) => Object.entries(this.lidMap).find(([, v]) => v === pn)?.[0] ?? null,
    },
  };
  private calls = 0;

  constructor(config: Record<string, unknown>) {
    this.config = config;
  }

  async sendMessage(jid: string, content: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown> {
    const call = ++this.calls;
    this.sent.push({ jid, content, options });
    await this.onSend(call, jid, content, options);
    return { key: { id: options?.messageId ?? `AUTO${call}`, remoteJid: jid, fromMe: true } };
  }
  async sendPresenceUpdate(state: string, jid?: string): Promise<unknown> { this.presence.push({ state, ...(jid ? { jid } : {}) }); return this.onPresence(state); }
  async readMessages(keys: unknown[]): Promise<unknown> { this.reads.push(keys); return undefined; }
  async requestPairingCode(phone: string): Promise<string> { this.pairingRequests.push(phone); return this.onPairing(phone); }
  async groupFetchAllParticipating(): Promise<Record<string, { id: string; subject?: string; participants?: unknown[] }>> { return this.groups; }
  async logout(): Promise<void> { this.loggedOut++; }
  end(): void { this.ended++; }

  // -- helpers the tests use to play WhatsApp --------------------------------------------------

  qr(text = "2@fake-qr-text"): void { this.ev.emit("connection.update", { qr: text }); }
  /** The link succeeded or the session restored: credentials say registered, then the socket opens. */
  open(user: { id: string; lid?: string } = { id: FAKE_PN, lid: FAKE_LID }): void {
    this.user = user;
    const creds = this.config.auth?.creds as Record<string, unknown> | undefined;
    if (creds) { creds.registered = true; creds.me = { id: user.id, lid: user.lid }; }
    this.ev.emit("creds.update", {});
    this.ev.emit("connection.update", { connection: "open" });
  }
  close(statusCode?: number): void {
    this.ev.emit("connection.update", { connection: "close", lastDisconnect: { error: statusCode === undefined ? new Error("closed") : Object.assign(new Error("closed"), { output: { statusCode } }) } });
  }
  upsert(messages: unknown[], type: "notify" | "append" = "notify"): void { this.ev.emit("messages.upsert", { messages, type }); }
  frame(): void { this.ws.emit("frame", {}); }
}

/** A received text message in the shape Baileys delivers. */
export function textMessage(init: { id: string; chat: string; text: string; fromMe?: boolean; participant?: string; participantAlt?: string; chatAlt?: string; pushName?: string; ts?: number; mentioned?: string[]; stanzaId?: string; quotedText?: string; quotedParticipant?: string }): Record<string, unknown> {
  const context: Record<string, unknown> = {
    ...(init.mentioned ? { mentionedJid: init.mentioned } : {}),
    ...(init.stanzaId ? { stanzaId: init.stanzaId, ...(init.quotedParticipant ? { participant: init.quotedParticipant } : {}), ...(init.quotedText ? { quotedMessage: { conversation: init.quotedText } } : {}) } : {}),
  };
  return {
    key: { remoteJid: init.chat, id: init.id, fromMe: init.fromMe === true, ...(init.participant ? { participant: init.participant } : {}), ...(init.participantAlt ? { participantAlt: init.participantAlt } : {}), ...(init.chatAlt ? { remoteJidAlt: init.chatAlt } : {}) },
    message: Object.keys(context).length ? { extendedTextMessage: { text: init.text, contextInfo: context } } : { conversation: init.text },
    messageTimestamp: init.ts ?? Math.floor(Date.now() / 1000),
    ...(init.pushName ? { pushName: init.pushName } : {}),
  };
}

export function voiceNote(init: { id: string; chat: string; fromMe?: boolean; bytes?: number; ts?: number }): Record<string, unknown> {
  return {
    key: { remoteJid: init.chat, id: init.id, fromMe: init.fromMe === true },
    message: { audioMessage: { mimetype: "audio/ogg; codecs=opus", seconds: 3, ptt: true, ...(init.bytes !== undefined ? { fileLength: init.bytes } : {}), mediaKey: Buffer.from("k") } },
    messageTimestamp: init.ts ?? Math.floor(Date.now() / 1000),
  };
}

export interface FakeLib {
  lib: BaileysLib;
  sockets: FakeSocket[];
  last(): FakeSocket;
  idCounter: () => number;
  /** Set to make `fetchLatestBaileysVersion` reject or hang. */
  versionBehavior: { mode: "ok" | "reject" | "hang"; version: [number, number, number] };
  /** Bytes (or a failure) `downloadMediaMessage` produces. */
  media: { chunks: Buffer[]; failure?: Error; destroyed: number };
  downloads: unknown[];
}

export function makeFakeLib(): FakeLib {
  const sockets: FakeSocket[] = [];
  let counter = 0;
  const state: FakeLib = {
    sockets,
    last: () => sockets[sockets.length - 1],
    idCounter: () => counter,
    versionBehavior: { mode: "ok", version: [2, 3000, 1] },
    media: { chunks: [Buffer.from("OggS-fake-voice-note")], destroyed: 0 },
    downloads: [],
    lib: undefined as unknown as BaileysLib,
  };
  state.lib = {
    makeWASocket(config) {
      const socket = new FakeSocket(config);
      sockets.push(socket);
      return socket;
    },
    initAuthCreds: () => ({ noiseKey: Buffer.from([1, 2, 3]), registered: false, me: undefined }),
    generateMessageIDV2: () => `3EB0FAKE${String(++counter).padStart(4, "0")}`,
    fetchLatestBaileysVersion: async () => {
      if (state.versionBehavior.mode === "reject") throw new Error("version endpoint down");
      if (state.versionBehavior.mode === "hang") return new Promise(() => undefined);
      return { version: state.versionBehavior.version };
    },
    downloadMediaMessage: async (message) => {
      state.downloads.push(message);
      if (state.media.failure) throw state.media.failure;
      const stream = Readable.from(state.media.chunks);
      const destroy = stream.destroy.bind(stream);
      stream.destroy = ((error?: Error) => { state.media.destroyed++; return destroy(error); }) as typeof stream.destroy;
      return stream;
    },
    proto: { Message: { AppStateSyncKeyData: { fromObject: (value: unknown) => ({ revived: value }) } } },
  };
  return state;
}
