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

export function sendDelegated(res: ServerResponse, method: string, result: DelegatedResult): void {
  for (const [name, value] of Object.entries(result.headers ?? {})) res.setHeader(name, value);
  const head = method === "HEAD";
  if (result.stream) {
    const stream = result.stream;
    res.writeHead(result.status);
    if (head) { stream.destroy(); res.end(); return; }
    stream.on("error", () => res.destroy());
    res.on("close", () => stream.destroy());
    stream.pipe(res);
    return;
  }
  if (result.bytes) {
    res.writeHead(result.status);
    res.end(head ? undefined : result.bytes);
    return;
  }
  if (!res.hasHeader("content-type")) res.setHeader("content-type", "application/json");
  res.writeHead(result.status);
  res.end(head || result.body === undefined ? undefined : JSON.stringify(result.body));
}
