// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Decode fix adapted from OpenMausBot #2387 (Apache-2.0).
import type { IncomingMessage } from "node:http";

/** A body a front gate already read and verified (the Cloud home's request auth, cloud-request-auth.ts `cloudBodies`):
 *  the route reads it from here, under the same size bound, since the stream is spent. */
export const preReadBodies = new WeakMap<IncomingMessage, { body: unknown; bytes: number }>();

export function readBody(req: IncomingMessage, maxBytes = 1_000_000): Promise<any> {
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
    req.on("data", (c) => {
      if (done) return;
      bytes += typeof c === "string" ? Buffer.byteLength(c) : c.length;
      if (bytes > maxBytes) {
        // Keep draining the socket, but stop retaining attacker-controlled
        // bytes. Destroying the request here prevents the caller from
        // receiving the useful 413 response.
        return fail(413, "body too large");
      }
      chunks.push(typeof c === "string" ? Buffer.from(c) : c);
    });
    req.on("end", () => {
      if (done) return;
      const data = Buffer.concat(chunks).toString("utf8");
      let body: any;
      try {
        body = data ? JSON.parse(data) : {};
      } catch {
        return fail(400, "invalid JSON body");
      }
      done = true;
      resolve(body);
    });
    req.on("error", (e) => fail(400, e instanceof Error ? e.message : String(e)));
  });
}
