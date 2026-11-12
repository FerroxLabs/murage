// SPDX-License-Identifier: AGPL-3.0-or-later
// The calling client's capability flags for the request being handled, so deep helpers (the engine list,
// the bot model check) can withhold what the client cannot use without every function taking the request.
import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingHttpHeaders } from "node:http";
import { CLIENT_CAPABILITIES_HEADER, parseClientCapabilities } from "./runnable-engines.ts";

const store = new AsyncLocalStorage<ReadonlySet<string>>();
/** Run `work` with the flags this request's headers carry. */
export function withClientCapabilities<T>(headers: IncomingHttpHeaders, work: () => T): T {
  return store.run(parseClientCapabilities(headers[CLIENT_CAPABILITIES_HEADER]), work);
}
/** The flags of the request being handled; empty (fail closed) outside one. */
export function currentClientCapabilities(): ReadonlySet<string> {
  return store.getStore() ?? new Set();
}
