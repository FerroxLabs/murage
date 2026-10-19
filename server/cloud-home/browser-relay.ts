// SPDX-License-Identifier: AGPL-3.0-or-later
// On a Cloud home each bot's browser listens on loopback INSIDE its own network
// namespace, which the server (host namespace) cannot dial. The launcher's
// fixed `relay cdp|stream` request runs a byte pipe inside that namespace; this
// module presents the pipe's stdio as a socket-like Duplex that `ws` can use
// through its `createConnection` option. The relay is a plain byte pipe: the
// WebSocket handshake and frames still run between `ws` and the browser.
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { Duplex } from "node:stream";
import { cloudHomeCopy } from "./copy.ts";
import { spawnCloudBrowser } from "./browser-process.ts";

export type RelayKind = "cdp" | "stream";
type Spawn = (args: string[], env: NodeJS.ProcessEnv) => ChildProcessWithoutNullStreams | null;

/** A socket-like Duplex over a child's stdout (readable) and stdin (writable).
 * Destroying it kills the child; the child exiting destroys it. */
export class ChildDuplex extends Duplex {
  private readonly child: ChildProcessWithoutNullStreams;
  private stderr = "";
  constructor(child: ChildProcessWithoutNullStreams) {
    super({ allowHalfOpen: false });
    this.child = child;
    child.stdin.on("error", () => {});
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});
    // The launcher's refusal text is fixed words only; keep a bounded tail so a caller can say why the relay ended.
    child.stderr.on("data", (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString()).slice(-2048); });
    child.stdout.on("data", chunk => { if (!this.push(chunk)) child.stdout.pause(); });
    child.stdout.once("end", () => this.push(null));
    child.once("error", error => this.destroy(error));
    child.once("close", () => this.destroy());
  }
  /** The last non-empty line the relay wrote to stderr, or "". */
  stderrTail(): string { return this.stderr.split("\n").map(line => line.trim()).filter(Boolean).pop() ?? ""; }
  _read(): void { this.child.stdout.resume(); }
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this.child.stdin.destroyed) return callback(new Error(cloudHomeCopy.browserRelayClosed));
    this.child.stdin.write(chunk, error => callback(error ?? null));
  }
  _final(callback: (error?: Error | null) => void): void { this.child.stdin.end(); callback(); }
  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    // Closing stdin makes the relay exit on its own; the signal covers a relay
    // still waiting on its endpoint. Both are best effort.
    this.child.stdin.destroy(); this.child.stdout.destroy();
    try { this.child.kill("SIGTERM"); } catch {}
    callback(error);
  }
  // net.Socket surface that http and ws call on whatever createConnection returns.
  setTimeout(): this { return this; }
  setNoDelay(): this { return this; }
  setKeepAlive(): this { return this; }
  ref(): this { return this; }
  unref(): this { return this; }
}

/** The `createConnection` factory for `ws` on a cloud home; undefined elsewhere
 * (desktop dials TCP exactly as before). */
export function cloudRelayConnection(kind: RelayKind, env: NodeJS.ProcessEnv, spawnRelay: Spawn = spawnCloudBrowser): (() => Duplex) | undefined {
  if (process.env.MURAGE_CLOUD_ROLE !== "home") return undefined;
  return () => {
    try {
      const child = spawnRelay(["relay", kind], env);
      if (child) return new ChildDuplex(child);
    } catch {}
    // Surfaces through ws as its ordinary connection error.
    const failed = new Duplex({ read() {}, write(_c, _e, cb) { cb(); } });
    process.nextTick(() => failed.destroy(new Error(cloudHomeCopy.browserRelayUnavailable)));
    return failed;
  };
}
