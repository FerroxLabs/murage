// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The authenticated device a bot call session and its channel ticket are bound to (BOT-CALLS-109 5.7). It is read only from
// what the server itself proved: never from a client header, body field or query value.
import type { IncomingHttpHeaders } from "node:http";
import { companionAuthorized } from "./companion-authority.ts";
import { CALL_PRINCIPAL } from "./bot-calls-schema.ts";
import { cloudIdentity } from "./cloud-request-identity.ts";
import { companionMarked, requestSurface } from "./sse-visibility.ts";

/** Bind calls to the proven desktop, Cloud device, or companion device/session.
 * A companion principal is trusted only with its private launch proof. */
export function callCaller(headers: IncomingHttpHeaders, o: { cloudHome: boolean; upgrade: boolean; query?: URLSearchParams | null }, proven = companionAuthorized): string | null {
  const caller = provenCaller(headers, o, proven);
  // Closed principal shapes, never the pre-migration sentinel.
  return caller !== null && CALL_PRINCIPAL.test(caller) ? caller : null;
}
function provenCaller(headers: IncomingHttpHeaders, o: { cloudHome: boolean; upgrade: boolean; query?: URLSearchParams | null }, proven: typeof companionAuthorized): string | null {
  if (o.cloudHome) {
    const id = cloudIdentity(headers)?.id;
    return typeof id === "string" && id ? `cloud:${id}` : null;
  }
  if (companionMarked(headers)) {
    const principal = headers["x-murage-stream-principal"];
    return proven(headers) && typeof principal === "string" && /^companion:[\w-]+:[\w-]+$/.test(principal) ? principal : null;
  }
  if (o.upgrade) return "desktop";
  return requestSurface(headers, o.query ?? null) === "desktop" ? "desktop" : null;
}
