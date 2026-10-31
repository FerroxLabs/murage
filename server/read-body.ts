// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Decode fix adapted from OpenMausBot #2387 (Apache-2.0).
import type { IncomingMessage } from "node:http";

/** A body a front gate already read and verified (the Cloud home's request auth, cloud-request-auth.ts `cloudBodies`):
 *  the route reads it from here, under the same size bound, since the stream is spent. */
export const preReadBodies = new WeakMap<IncomingMessage, { body: unknown; bytes: number }>();

/** `signal` (optional): when it aborts, the read stops at once: listeners off, collected bytes dropped, the rest of the body
 *  discarded as it arrives, and the promise rejects with status 408. The caller answers and closes the connection. */
export function readBody(req: IncomingMessage, maxBytes = 1_000_000, signal?: AbortSignal): Promise<any> {
  const cached = preReadBodies.get(req);
  if (cached) return cached.bytes > maxBytes
    ? Promise.reject(Object.assign(new Error("body too large"), { status: 413 }))
    : Promise.resolve(cached.body);
  return new Promise((resolve, reject) => {
    // Collect bytes and decode once: decoding per chunk turns a multi-byte
    // character split across two chunks into U+FFFD.
    const chunks: Buffer[] = [];
    let bytes = 0;
    let done = false;
    const fail = (status: number, msg: string) => {
      if (done) return;
      done = true;
      const err = Object.assign(new Error(msg), { status });
      reject(err);
    };
    const onData = (c: Buffer | string) => {
      if (done) return;
      bytes += typeof c === "string" ? Buffer.byteLength(c) : c.length;
      if (bytes > maxBytes) {
        // Keep draining the socket, but stop retaining attacker-controlled
        // bytes. Destroying the request here prevents the caller from
        // receiving the useful 413 response.
        return fail(413, "body too large");
      }
      chunks.push(typeof c === "string" ? Buffer.from(c) : c);
    };
    const onEnd = () => {
      if (done) return;
      const data = Buffer.concat(chunks).toString("utf8");
      let body: any;
      try {
        body = data ? JSON.parse(data) : {};
      } catch {
        return fail(400, "invalid JSON body");
      }
      done = true;
      signal?.removeEventListener("abort", onAbort);
      resolve(body);
    };
    const onError = (e: unknown) => fail(400, e instanceof Error ? e.message : String(e));
    const onAbort = () => {
      if (done) return;
      chunks.length = 0;
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      req.on("error", () => {}); // a late socket error must not become an unhandled 'error' event
      req.resume(); // discard the rest; the route's answer closes the connection
      fail(408, "body read timed out");
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}
