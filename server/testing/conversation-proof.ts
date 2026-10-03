// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { openSse, type SseRecorder } from "./sse.ts";

/** Test-side stand-in for the paired phone's door.
 *
 * The harness answers its conversation routes (bots, threads, rooms, search,
 * the live stream) only to the desktop's per-launch secret or to the companion
 * credential, so a bare loopback request is an unknown route. Most suites in
 * this repo read those routes as the scoped, non-desktop caller; this adds the
 * credential the real door adds, and nothing else. It never adds a desktop
 * proof, never overrides a proof the request already carries, and leaves every
 * other route alone. A test that means "no proof at all" calls
 * `globalThis.fetch` directly. */
export const CONVERSATION_PATH = /^\/api\/(?:(?:bots|threads|groups)(?:\/|$|\?)|(?:search|events)(?:$|\?))/;

/** A request that already says who it is (any `x-murage-*` header, or a bearer)
 * is left exactly as the test wrote it: those tests are about that identity. */
const namesItself = (headers: Record<string, string>, query: URLSearchParams): boolean =>
  Object.keys(headers).some((name) => name.toLowerCase().startsWith("x-murage-") || name.toLowerCase() === "authorization")
  || query.has("surfaceSecret") || query.has("surface");

export function conversationProofHeaders(target: string, token: string, headers: Record<string, string> = {}): Record<string, string> {
  let parsed: URL;
  try { parsed = new URL(target, "http://localhost"); } catch { return {}; }
  if (!CONVERSATION_PATH.test(parsed.pathname + parsed.search) || namesItself(headers, parsed.searchParams)) return {};
  return { "x-murage-companion-token": token };
}

function plainHeaders(headers: RequestInit["headers"]): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return headers as Record<string, string>;
}

/** `fetch`, with the companion credential added to conversation routes on `base`. */
export function conversationFetch(base: string, token: string): typeof fetch {
  return (input, init) => {
    const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!target.startsWith(base)) return globalThis.fetch(input, init);
    const headers = plainHeaders(init?.headers);
    return globalThis.fetch(input, { ...init, headers: { ...headers, ...conversationProofHeaders(target.slice(base.length), token, headers) } });
  };
}

/** `openSse` with the same credential. */
export function conversationSse(base: string, token: string): (url: string, headers?: Record<string, string>) => Promise<SseRecorder> {
  return (url, headers = {}) => openSse(url, { ...conversationProofHeaders(url.startsWith(base) ? url.slice(base.length) : url, token, headers), ...headers });
}

/** A verification fixture, resolved when the call is made (the fixture starts in `beforeAll`). */
export interface ProofFixture { info: { url: string }; companionToken: string }

/** `fetch` for a suite whose server is a `launchVerificationServer` fixture. */
export function fixtureFetch(fixture: () => ProofFixture | undefined): typeof fetch {
  return (input, init) => {
    const current = fixture();
    return current ? conversationFetch(current.info.url, current.companionToken)(input, init) : globalThis.fetch(input, init);
  };
}

/** `openSse` for the same. */
export function fixtureSse(fixture: () => ProofFixture | undefined): (url: string, headers?: Record<string, string>) => Promise<SseRecorder> {
  return (url, headers) => {
    const current = fixture();
    return current ? conversationSse(current.info.url, current.companionToken)(url, headers) : openSse(url, headers);
  };
}

/** `fetch` for a suite that starts its own harness on a random loopback port
 * and gives it `MURAGE_COMPANION_TOKEN=token`: any 127.0.0.1 conversation URL
 * gets the credential. */
export function loopbackFetch(token: string): typeof fetch {
  return (input, init) => {
    const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const origin = /^http:\/\/127\.0\.0\.1:\d+/.exec(target)?.[0];
    return origin ? conversationFetch(origin, token)(input, init) : globalThis.fetch(input, init);
  };
}

/** `openSse` for the same. */
export function loopbackSse(token: string): (url: string, headers?: Record<string, string>) => Promise<SseRecorder> {
  return (url, headers = {}) => {
    const origin = /^http:\/\/127\.0\.0\.1:\d+/.exec(url)?.[0];
    return origin ? conversationSse(origin, token)(url, headers) : openSse(url, headers);
  };
}
