// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// BRTOKEN19: the per-launch control token for the vendored agent-browser engine (see designs/AB-ENGINE-PATCH-1019.md).
//
// Murage generates 32 random bytes for each launch of a browser session and gives them to the engine ONLY through its
// environment (AGENT_BROWSER_CONTROL_TOKEN), never argv. The patched engine then
//  - requires `Authorization: Bearer <token>` on its stream port (WebSocket and HTTP), and
//  - on Windows, proves the token to its daemon TCP port with a mutual challenge-response, after which every line in both directions
//    is an `ab1` MAC-framed message. The token itself never crosses the wire, so a process squatting the port learns nothing.
// This file is the Murage side of both. The Rust side is native/control_token.rs in the engine patch; the known-answer vectors in
// browser-control-token.test.ts are the same ones its tests check.
//
// Threat boundary: other OS accounts and any loopback client without the token. Out of scope: same-account processes with debug
// rights (they can read the token from the process environment) and the raw Chromium CDP port.
//
// Framing rule (rev B): every line we read from a daemon is bounded BEFORE it is buffered and checked byte by byte against the frame
// grammar as it arrives, and the whole exchange has one absolute deadline. Nothing is parsed (UTF-8 or JSON) before the MAC has passed.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { connect as connectSocket } from "node:net";

export const CONTROL_TOKEN_ENV = "AGENT_BROWSER_CONTROL_TOKEN";

/** A fresh token: 32 random bytes, hex. One per launch of a browser session. */
export const newControlToken = (): string => randomBytes(32).toString("hex");

/** The token an environment carries, or undefined when it holds none (or a malformed one). */
export function controlTokenFrom(env: Record<string, string | undefined>): Buffer | undefined {
  const value = env[CONTROL_TOKEN_ENV];
  return typeof value === "string" && /^[0-9a-f]{64}$/iu.test(value) ? Buffer.from(value, "hex") : undefined;
}

/** Headers for the engine's stream port, or none when the environment holds no token. */
export function streamAuthHeaders(env: Record<string, string | undefined>): Record<string, string> | undefined {
  const value = env[CONTROL_TOKEN_ENV];
  return controlTokenFrom(env) ? { Authorization: `Bearer ${value}` } : undefined;
}

/** The engine's refusal of a stale daemon (one a previous launch left running with an older token). */
export function isControlTokenMismatch(text: string): boolean {
  return /control_token_mismatch/u.test(text);
}

const mac = (key: Buffer, ...parts: Array<Buffer | string>): Buffer => {
  const h = createHmac("sha256", key);
  for (const part of parts) h.update(part);
  return h.digest();
};
const same = (expected: Buffer, presentedHex: unknown): boolean => {
  const presented = typeof presentedHex === "string" && /^[0-9a-f]{64}$/iu.test(presentedHex) ? Buffer.from(presentedHex, "hex") : Buffer.alloc(32);
  const ok = timingSafeEqual(expected, presented);
  return ok && typeof presentedHex === "string" && /^[0-9a-f]{64}$/iu.test(presentedHex);
};
const counter = (n: number): Buffer => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
/** Exactly 32 LOWERCASE hex characters (the engine requires the same). */
const isNonce = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{32}$/u.test(v);

/** `ab1 ` + 16 hex + space + 64 hex + space. */
export const FRAME_PREFIX_LEN = 86;
/** Handshake lines (hello, proof, auth), newline included. */
export const HANDSHAKE_LINE_MAX = 4096;
/** The largest reply payload we will buffer from a daemon (the close reply is a few dozen bytes). */
export const REPLY_PAYLOAD_MAX = 65536;
/** Counters stay below 2^53 so they are exact in a JS number; a session is closed long before this. */
const COUNTER_LIMIT = Number.MAX_SAFE_INTEGER;

const lowerHex = (b: number): boolean => (b >= 0x30 && b <= 0x39) || (b >= 0x61 && b <= 0x66);
/** Is `b` allowed at byte `pos` of the 86-byte frame prefix? Same grammar the engine's accumulator enforces as bytes arrive. */
export function framePrefixByteOk(pos: number, b: number): boolean {
  if (pos === 0) return b === 0x61; // a
  if (pos === 1) return b === 0x62; // b
  if (pos === 2) return b === 0x31; // 1
  if (pos === 3 || pos === 20 || pos === 85) return b === 0x20;
  if ((pos >= 4 && pos <= 19) || (pos >= 21 && pos <= 84)) return lowerHex(b);
  return true;
}

/** One authenticated connection. Post-handshake wire line, both directions:
 * `ab1 <n: 16 lowercase hex> <mac: 64 lowercase hex> <payload, no newline>\n`, `mac = HMAC-SHA256(K, "ab1" || dir || n as 8 big-endian bytes || payload)`,
 * counters strictly increasing per direction. */
export class ControlSession {
  private sent = 0;
  private received = 0;
  constructor(private readonly key: Buffer) {}
  /** The whole wire line (newline included) for one message to the daemon. */
  seal(message: string): Buffer {
    const payload = Buffer.from(message, "utf8");
    if (payload.includes(0x0a)) throw new Error("A control frame payload must not contain a newline");
    if (this.sent >= COUNTER_LIMIT) throw new Error("The control session's counter is spent");
    const n = this.sent++;
    const prefix = `ab1 ${n.toString(16).padStart(16, "0")} ${mac(this.key, "ab1", "c", counter(n), payload).toString("hex")} `;
    return Buffer.concat([Buffer.from(prefix, "ascii"), payload, Buffer.from("\n")]);
  }
  /** The message inside one line from the daemon (newline included), or undefined when it is not the next authentic one. Order: grammar,
   * MAC over the raw payload bytes (constant time), counter, and only then UTF-8. State advances only on success. */
  open(line: Buffer): string | undefined {
    if (line.length <= FRAME_PREFIX_LEN || line[line.length - 1] !== 0x0a) return undefined;
    for (let i = 0; i < FRAME_PREFIX_LEN; i++) if (!framePrefixByteOk(i, line[i]!)) return undefined;
    const payload = line.subarray(FRAME_PREFIX_LEN, line.length - 1);
    if (payload.includes(0x0a)) return undefined;
    const nField = line.toString("ascii", 4, 20);
    const presented = Buffer.from(line.toString("ascii", 21, 85), "hex");
    if (!timingSafeEqual(mac(this.key, "ab1", "s", Buffer.from(nField, "hex"), payload), presented)) return undefined;
    if (BigInt(`0x${nField}`) !== BigInt(this.received) || this.received >= COUNTER_LIMIT) return undefined;
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(payload); } catch { return undefined; }
    this.received++;
    return text;
  }
}

/** The client half of the handshake. `finish` checks the daemon's proof BEFORE anything else is sent. */
export class ControlClient {
  private cn: string;
  constructor(private readonly token: Buffer, nonce: string = randomBytes(16).toString("hex")) { this.cn = nonce; }
  hello(): string { return JSON.stringify({ hello: this.cn }); }
  /** undefined: the daemon did not prove the token (a squatter, a stale daemon, or an engine without the patch), or its answer is
   * unreadable. There is no downgrade: nothing but a valid proof lets the exchange go on. */
  finish(line: string): { auth: string; session: ControlSession } | undefined {
    let value: any;
    try { value = JSON.parse(line); } catch { return undefined; }
    if (!value || typeof value !== "object") return undefined;
    if (!isNonce(value.nonce) || !same(mac(this.token, "srv", this.cn), value.proof)) return undefined;
    const sn = value.nonce;
    return {
      auth: JSON.stringify({ auth: mac(this.token, "cli", sn, this.cn).toString("hex") }),
      session: new ControlSession(mac(this.token, "key", this.cn, sn)),
    };
  }
}

/** Direct close without launch discovery. Ownership transactions bind the request and reply to
 * one launch and allow the daemon's bounded stop to finish within the 15-second response limit.
 * Every reply remains bounded and authenticated before parsing. */
export function closeDaemonSession(target: { host: string; port: number } | { path: string }, token: Buffer | undefined, ownership?: { launchId: string | null; requireSaved: boolean }): Promise<void> {
  return new Promise<void>((done, fail) => {
    const plain = JSON.stringify({ id: "murage-close", action: "close", ...(ownership ? { closeOnly: true, ...ownership } : {}) });
    const client = token ? new ControlClient(token) : undefined;
    let session: ControlSession | undefined;
    let stage: "proof" | "reply" = client ? "proof" : "reply";
    const transport = connectSocket(target as never, () => transport.write((client ? client.hello() : plain) + "\n"));
    let pending: Buffer[] = [];
    let pendingLength = 0;
    let settled = false;
    const timer = setTimeout(() => { transport.destroy(); fail(new Error("Browser session close timed out")); }, ownership ? 15_000 : 5000);
    const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); transport.destroy(); if (error) fail(error); else done(); };
    const lineCap = () => (stage === "proof" ? HANDSHAKE_LINE_MAX : FRAME_PREFIX_LEN + REPLY_PAYLOAD_MAX + 1);
    const handle = (line: Buffer) => {
      if (stage === "proof") {
        const reply = client!.finish(line.toString("utf8"));
        if (reply === undefined) return finish(new Error("Browser daemon did not prove the control token"));
        stage = "reply";
        session = reply.session;
        transport.write(Buffer.concat([Buffer.from(`${reply.auth}\n`), session.seal(plain)]));
        return;
      }
      let text: string;
      if (session) {
        const opened = session.open(line);
        if (opened === undefined) return finish(new Error("Browser close response was invalid"));
        text = opened;
      } else {
        text = line.toString("utf8");
      }
      try { const result = JSON.parse(text); if (result.success === true && result.data?.closed === true && (!ownership || result.data?.launchId === ownership.launchId)) finish(); else finish(new Error("Browser session close was refused")); }
      catch { finish(new Error("Browser close response was invalid")); }
    };
    transport.on("data", (chunk: Buffer) => {
      let offset = 0;
      while (offset < chunk.length && !settled) {
        const newline = chunk.indexOf(0x0a, offset);
        const end = newline >= 0 ? newline + 1 : chunk.length;
        const piece = chunk.subarray(offset, end);
        offset = end;
        // A framed reply that breaks the prefix grammar is refused at that byte, before more is read.
        if (stage === "reply" && session) {
          for (let i = 0; i < piece.length && pendingLength + i < FRAME_PREFIX_LEN; i++) {
            if (!framePrefixByteOk(pendingLength + i, piece[i]!)) return finish(new Error("Browser close response was invalid"));
          }
        }
        // The cap is checked BEFORE the bytes are kept.
        if (pendingLength + piece.length > lineCap()) return finish(new Error("Browser close response exceeded its bound"));
        pending.push(piece);
        pendingLength += piece.length;
        if (newline >= 0) {
          const line = Buffer.concat(pending, pendingLength);
          pending = [];
          pendingLength = 0;
          handle(line);
        }
      }
    });
    transport.once("error", () => finish(new Error("Browser session close connection failed")));
    // A daemon that hangs up (a refused client) is an answer; do not wait out the timer for it.
    transport.once("close", () => finish(new Error("Browser session close connection failed")));
  });
}
