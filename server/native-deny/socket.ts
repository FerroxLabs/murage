// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import net, { type Socket } from "node:net";
import { chmodSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { canonicalJson, sha256 } from "./compile.ts";
import { decideNoLimitsNative, operationSha256, NATIVE_DENY_DEADLINE_MS, retireNativeDenySession, verifyNativeDenyIntegrity, type NativeDenyReply, type NativeDenyRequest, type NativeDenySession } from "./backstop.ts";
import { GATE_MESSAGE_BYTES, hookSocketPath } from "./upstream.ts";

const denied = (callId: string, reason: string): NativeDenyReply => ({ allow: false, callId, reason });
function decode(bytes: Buffer): unknown { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
export interface NativeDenySocketOptions { path: string; envFile: string }
export const nativeDenySocketPath = (privateDir: string): string => process.platform === "win32" ? hookSocketPath() : join(privateDir, basename(hookSocketPath()));
/** Creates transport and a new 0600 token file, never an engine process. Callers
 * must withhold the turn prompt until their actual engine seam completes a full
 * requestNativeDeny round trip. A listen callback alone is not liveness proof. */
export async function startNativeDenySocket(session: NativeDenySession, options: NativeDenySocketOptions): Promise<{ path: string; envFile: string; close: () => Promise<void> }> {
  if (session.retired || !verifyNativeDenyIntegrity(session)) throw Error("native-deny retired");
  const { path, envFile } = options;
  // Reserve transport paths in the compiled policy before emission and launch.
  for (const file of [envFile, ...(process.platform === "win32" ? [] : [path])]) {
    if (!session.spec.selfPaths.some(root => file === root || file.startsWith(root.endsWith("/") ? root : root + "/"))) throw Error("native-deny transport path absent from deny spec");
  }
  for (const dir of [dirname(envFile), ...(process.platform === "win32" ? [] : [dirname(path)])]) {
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw Error("native-deny socket directory must be private");
  }
  const clients = new Set<Socket>();
  let envWritten = false, listening = false, closed: Promise<void> | undefined;
  const server = net.createServer(socket => {
    clients.add(socket);
    let chunks: Buffer[] = [], length = 0, finished = false, processing = false;
    const timer = setTimeout(() => reply(denied("", "deadline")), NATIVE_DENY_DEADLINE_MS);
    function reply(value: NativeDenyReply) {
      if (finished || socket.destroyed) return;
      finished = true; clearTimeout(timer); chunks = [];
      socket.end(`${canonicalJson(value)}\n`);
    }
    socket.on("error", () => socket.destroy());
    socket.once("close", () => { clearTimeout(timer); clients.delete(socket); });
    socket.on("data", data => {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (finished) return;
      if (processing) return reply(denied("", "framing"));
      length += chunk.length;
      if (length > GATE_MESSAGE_BYTES) return reply(denied("", "oversize"));
      chunks.push(chunk);
      // Parse exactly one complete JSON line; never evaluate a partial frame.
      if (!chunk.includes(10)) return;
      const bytes = Buffer.concat(chunks); chunks = [];
      if (bytes.indexOf(10) !== bytes.length - 1) return reply(denied("", "framing"));
      let value: unknown;
      try { value = decode(bytes.subarray(0, -1)); } catch { return reply(denied("", "bad-json")); }
      processing = true;
      void decideNoLimitsNative(session, value).then(reply, () => reply(denied("", "backstop-failure")));
    });
    socket.on("end", () => { if (!finished && !processing) reply(denied("", "truncated")); });
  });
  // Includes turn-end integrity check, including turns with no final tool call.
  async function cleanup() {
    verifyNativeDenyIntegrity(session); retireNativeDenySession(session);
    for (const socket of clients) socket.destroy();
    if (listening) await new Promise<void>(resolve => server.close(() => resolve()));
    if (envWritten) rmSync(envFile, { force: true });
  }
  const close = (): Promise<void> => closed ??= cleanup();
  try {
    writeFileSync(envFile, `${canonicalJson({ v: 2, socket: path, token: session.token, generation: session.generation })}\n`, { mode: 0o600, flag: "wx" });
    envWritten = true;
    const stat = lstatSync(envFile);
    session.pins.push({ path: envFile, hash: sha256(readFileSync(envFile)), dev: stat.dev, ino: stat.ino });
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => { server.off("listening", ready); reject(error); };
      const ready = () => { server.off("error", fail); listening = true; resolve(); };
      server.once("error", fail); server.once("listening", ready); server.listen(path);
    });
    server.on("error", () => { void close(); });
    if (process.platform !== "win32") chmodSync(path, 0o600);
    return { path, envFile, close };
  } catch (error) { await close(); throw error; }
}
/** Client-side default is always deny, including socket down, server death,
 * mismatched IDs, partial replies, malformed JSON and the native deadline. */
export function requestNativeDeny(path: string, request: NativeDenyRequest, deadlineMs = NATIVE_DENY_DEADLINE_MS): Promise<NativeDenyReply> {
  const id = request.callId;
  return new Promise(resolve => {
    let socket: Socket | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    let done = false, chunks: Buffer[] = [], length = 0;
    const finish = (value: NativeDenyReply) => { if (done) return; done = true; if (timer) clearTimeout(timer); socket?.destroy(); resolve(value); };
    try {
      const text = `${canonicalJson(request)}\n`;
      if (Buffer.byteLength(text) > GATE_MESSAGE_BYTES) return finish(denied(id, "oversize"));
      timer = setTimeout(() => finish(denied(id, "deadline")), Math.max(1, Math.min(Number.isFinite(deadlineMs) ? deadlineMs : NATIVE_DENY_DEADLINE_MS, NATIVE_DENY_DEADLINE_MS)));
      socket = net.createConnection(path, () => socket!.write(text));
      socket.on("data", data => {
        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
        length += chunk.length;
        if (length > 8192) return finish(denied(id, "bad-reply"));
        chunks.push(chunk);
        if (!chunk.includes(10)) return;
        const bytes = Buffer.concat(chunks); chunks = [];
        if (bytes.indexOf(10) !== bytes.length - 1) return finish(denied(id, "bad-reply"));
        try {
          const reply = decode(bytes.subarray(0, -1)) as Record<string, unknown>;
          if (!reply || reply.callId !== id || typeof reply.allow !== "boolean") return finish(denied(id, "bad-reply"));
          if (reply.allow === true && reply.operationSha256 === operationSha256(request)) finish({ allow: true, callId: id, operationSha256: reply.operationSha256 as string });
          else if (reply.allow === true) finish(denied(id, "operation-mismatch"));
          else finish(denied(id, typeof reply.reason === "string" ? reply.reason : "denied"));
        } catch { finish(denied(id, "bad-reply")); }
      });
      socket.on("error", () => finish(denied(id, "socket-error")));
      socket.on("close", () => finish(denied(id, "disconnected")));
      socket.on("end", () => finish(denied(id, "disconnected")));
    } catch { finish(denied(id, "socket-error")); }
  });
}
