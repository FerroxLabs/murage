// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The authenticated device a bot call session and its channel ticket are bound to (BOT-CALLS-109 5.7). It is read only from
// what the server itself proved: never from a client header, body field or query value.
import type { IncomingHttpHeaders } from "node:http";
import { CALL_PRINCIPAL } from "./bot-calls-schema.ts";
import { cloudIdentity } from "./cloud-request-identity.ts";
import { companionMarked, requestSurface } from "./sse-visibility.ts";

/** On a Cloud home: the device identity cloudRequestAuth resolved for this request (`cloud:<device id>`). Off Cloud: the
 * desktop only. The companion forwards no call route (companion/src/routes.ts), so a phone has no device to bind there, and a
 * stamped principal header is never read. An HTTP request is the desktop when it proves the desktop surface; an upgrade from
 * the desktop page carries no headers, so an upgrade the companion did not mark is the desktop, proven by its ticket and the
 * loopback Host and Origin rules. Null when no device is proven. */
export function callCaller(headers: IncomingHttpHeaders, o: { cloudHome: boolean; upgrade: boolean; query?: URLSearchParams | null }): string | null {
  const caller = provenCaller(headers, o);
  // only "desktop" or "cloud:<id>": never the legacy sentinel, never anything else
  return caller !== null && CALL_PRINCIPAL.test(caller) ? caller : null;
}
function provenCaller(headers: IncomingHttpHeaders, o: { cloudHome: boolean; upgrade: boolean; query?: URLSearchParams | null }): string | null {
  if (o.cloudHome) {
    const id = cloudIdentity(headers)?.id;
    return typeof id === "string" && id ? `cloud:${id}` : null;
  }
  if (o.upgrade) return companionMarked(headers) ? null : "desktop";
  return requestSurface(headers, o.query ?? null) === "desktop" ? "desktop" : null;
}
