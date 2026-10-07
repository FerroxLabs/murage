// The 0.1.62 route policy classes `/api/bots/:id/computer*` and
// `/api/bots/:id/browser` as desktop-only. A client that reaches one of
// those endpoints before it knows that — a phone, or a session caught mid
// capability check — gets the door's own words back verbatim: a
// `no route: METHOD path` 404 (server/index.ts, the route-table fallthrough,
// ~18079), or `browser owner authentication required`, a 401
// (server/index.ts, ~11386). Neither is something to put in front of a
// person; this maps them to plain words everywhere the Computer/Browser
// panel surfaces a fetch failure. Any other message passes through
// unchanged.
export interface RouteErrorLike {
  /** `api()` (state/store.tsx) attaches the response status to every thrown
   *  error; a network-level failure (no HTTP response at all) has none. */
  status?: number;
  /** `server/index.ts` sends `code: "desktop_only"` for the door's
   *  device-auth refusal and `server/browser-owner-api.ts` sends
   *  `code: "browser_inactive"` for the unrelated "authority went inactive
   *  mid-poll" 401 (fix round 2) — the most reliable signal, since it does
   *  not depend on status or wording at all. */
  code?: string;
  message: string;
}

/** Decides from `code`/`status` — not by parsing `message` — wherever that
 *  is enough to be unambiguous on its own:
 *  - An explicit `code` always wins outright.
 *  - `404` is NOT unambiguous by status alone: `/api/bots/:id/computer`
 *    also 404s for "no such bot" (a real bot lookup miss, its own
 *    legitimate message that must keep showing), a condition the generic
 *    route-table fallthrough's `no route: ...` text has nothing to do
 *    with. So the 404 case still narrows on that literal prefix — the one
 *    part of the server's wording that is itself the signal (ANY unmatched
 *    path/method gets exactly that text, never anything else) rather than
 *    incidental phrasing to be parsed.
 *  - `401` on `/api/bots/:id/browser` is ALSO not unambiguous by status
 *    alone (fix round 2, rereview): the door's device-auth refusal
 *    (server/index.ts:11386, lowercase "browser owner authentication
 *    required") and `browserOwnerRequest`'s own "authority went inactive"
 *    check (server/browser-owner-api.ts:10, capital-B "Browser owner
 *    authentication required") both throw status 401 for completely
 *    different, unrelated reasons — a profile switch or a disabled
 *    built-in browser mid-poll on an already-authenticated desktop is not
 *    "your Mac needs to sign in." Both server sites now send a `code`
 *    (see above) so this case should not be reached in practice; the exact
 *    text is kept as a narrow, case-sensitive equality check (not a guess)
 *    purely as a second line of defense for an older response that has not
 *    been updated to send one.
 *  Only when the caller has no status at all does the same text check run
 *  unscoped, as a fallback for a caller this shape has not been wired
 *  through yet (a network-level failure, not an HTTP response). */
/** The route table's fallthrough says `no route: METHOD path`; the 0.1.61
 *  deny-by-default gate (server/route-policy.ts) says `no such route`. Both
 *  mean the path is not served here, and neither can be a bot lookup miss. */
const NO_ROUTE = /^no (?:such )?route\b/i;

export function describeDesktopOnlyRouteError({ status, code, message }: RouteErrorLike): string {
  if (code === "no-route") return "This isn't available from here.";
  if (code === "desktop_only") return "This needs your Mac to sign in first.";
  if (code === "browser_inactive") return "Browser unavailable right now.";

  if (status === 404 && NO_ROUTE.test(message)) {
    return "This isn't available from here.";
  }

  if (status === 401) {
    if (message === "browser owner authentication required") return "This needs your Mac to sign in first.";
    if (message === "Browser owner authentication required") return "Browser unavailable right now.";
    return message;
  }

  if (status === undefined) {
    if (NO_ROUTE.test(message)) return "This isn't available from here.";
    if (message === "browser owner authentication required") return "This needs your Mac to sign in first.";
    if (message === "Browser owner authentication required") return "Browser unavailable right now.";
  }

  return message;
}

/** Pulls the shape `describeDesktopOnlyRouteError` wants out of whatever a
 *  catch block actually has. `api()` (state/store.tsx) throws
 *  `Object.assign(new Error(...), { status: res.status, body })` for every
 *  non-ok response — `body` is the parsed JSON, so `body.code` is where the
 *  server's error code shows up. A cause that is not an `Error` at all (or
 *  carries neither) still gets a usable `message`. */
export function routeErrorFrom(cause: unknown): RouteErrorLike {
  if (cause instanceof Error) {
    const withMeta = cause as Error & { status?: number; body?: { code?: unknown } };
    const code = typeof withMeta.body?.code === "string" ? withMeta.body.code : undefined;
    return { status: withMeta.status, code, message: cause.message };
  }
  return { message: String(cause) };
}
