// K0 route delegation seam. server/index.ts owns only the prefix match and
// the surface/capability decision; each feature module answers the request
// itself, so feature lanes never co-edit dispatch code.
import type { IncomingHttpHeaders, ServerResponse } from "node:http";
import type { Readable } from "node:stream";

export interface DelegatedRequest {
  method: string;
  path: string;
  url: URL;
  headers: IncomingHttpHeaders;
  /** requestSurface(...) === "desktop" (per-launch renderer proof). */
  desktop: boolean;
  /** Bounded JSON body reader from server/index.ts; call at most once. */
  readBody: () => Promise<unknown>;
}

export interface DelegatedResult {
  status: number;
  headers?: Record<string, string>;
  /** JSON body. */
  body?: unknown;
  /** Small binary body. */
  bytes?: Uint8Array;
  /** Large binary body (media ranges); destroyed if the client goes away. */
  stream?: Readable;
}

/** Same answer as the existing desktop-only precedent: do not confirm the route exists. */
export function hiddenRoute(): DelegatedResult {
  return { status: 404, body: { error: "no such route" } };
}

export function notImplemented(error: string): DelegatedResult {
  return { status: 501, body: { error, code: "not-implemented" } };
}

/** True once nothing written to this response can reach the client any more:
 * the socket closed (Node marks the response destroyed when it does), the
 * response was destroyed or already ended, or its socket is going away and
 * the 'close' event is still pending. */
export function responseGone(res: ServerResponse): boolean {
  return res.destroyed || res.writableEnded || res.socket?.destroyed === true;
}

export function sendDelegated(res: ServerResponse, method: string, result: DelegatedResult): void {
  const head = method === "HEAD";
  if (result.stream) {
    const stream = result.stream;
    // A feature module may have opened its source while the client was
    // already gone (media players abort range requests on every seek). A
    // pipe into a dead response never drains and never emits 'close' again,
    // so the source would stay open, and counted, for the life of the
    // process. Release it here instead of writing into the void.
    if (responseGone(res)) { stream.destroy(); res.destroy(); return; }
    // Every way the sink can go away releases the source, wired before the
    // first byte moves so no event can be missed.
    res.once("close", () => stream.destroy());
    res.on("error", () => stream.destroy());
    stream.on("error", () => res.destroy());
    for (const [name, value] of Object.entries(result.headers ?? {})) res.setHeader(name, value);
    res.writeHead(result.status);
    if (head) { stream.destroy(); res.end(); return; }
    stream.pipe(res);
    return;
  }
  for (const [name, value] of Object.entries(result.headers ?? {})) res.setHeader(name, value);
  if (result.bytes) {
    res.writeHead(result.status);
    res.end(head ? undefined : result.bytes);
    return;
  }
  if (!res.hasHeader("content-type")) res.setHeader("content-type", "application/json");
  res.writeHead(result.status);
  res.end(head || result.body === undefined ? undefined : JSON.stringify(result.body));
}
