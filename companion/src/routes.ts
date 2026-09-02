// What a paired device is allowed to ask for.
//
// The default is deny, and that direction is the whole point: the sidecar
// sits in front of an API it does not own and cannot see the future of. A
// route that appears in the harness later is closed to phones until someone
// decides otherwise, because the alternative is that every upstream release
// silently widens what a lost phone can reach.
//
// This file used to claim that and not do it — it listed refusals and let
// everything else under `/api/` through. In the time between writing it and
// noticing, upstream added webhook triggers, connected-app authorisation and
// routines, all of which a paired phone could drive: minting an
// internet-reachable trigger, rotating a signing secret out from under
// whatever was sending to it, disconnecting a Google account. None of that
// was a decision anyone made. It was the default.
//
// So the list below is the surface, derived from what the app actually
// calls. Adding a feature to the phone means adding its route here, on
// purpose, in a diff someone can read. That cost is the feature.

/** A refusal to send back, or null to let the request through. */
export interface Denial {
  status: number;
  error: string;
  /** Where a browser should go to get a credential. Present only on the
   * browser surface's 401, and never a redirect — the SPA's own `fetch`
   * calls must not follow a 302 into an HTML page and parse it as JSON. */
  signIn?: string;
}

/** Which door a request arrived at.
 *
 * The two are not the same surface and they never converge. `device` is a
 * native client holding a bearer token and sending no Origin. `browser` is a
 * page this sidecar served, holding a host-only cookie and sending Origin on
 * every write. A route reachable from one is not thereby reachable from the
 * other, and the two separate lists below are the whole statement of that.
 *
 * There is deliberately no default. A caller that forgets to say which door
 * it is fails to compile, which is the failure to have — the alternative is
 * a new listener inheriting the phone's surface by omission. */
export type Surface = "device" | "browser";

/** One request, reduced to what the allowlist decides on. */
export interface RouteRequest {
  path: string;
  method: string;
  /** Whether the credential on the request resolved to a paired device. */
  authenticated: boolean;
  /** Which door it came in at. No default: every caller states it. */
  surface: Surface;
}

/** The one companion route that crosses into full interactive desktop
 * control. Both the allowlist and capability gate consume this classifier so
 * their security decisions cannot drift apart. */
export const CLOUD_DESKTOP_JOIN_ROUTE = {
  method: "POST",
  path: /^\/api\/bots\/[\w-]+\/computer\/join$/,
} as const;

export function isCloudDesktopJoin(method: string, path: string): boolean {
  return method === CLOUD_DESKTOP_JOIN_ROUTE.method && CLOUD_DESKTOP_JOIN_ROUTE.path.test(path);
}

/** The two routine routes that can carry a `runOn` field.
 *
 * Creating or amending a routine is an ordinary thing to do from a phone, but
 * `runOn: "cloud"` inside the body reaches the same provisioning call that
 * POST /api/bots/:id/computer/provision is denied for. A path-and-method
 * allowlist cannot see a body, so the proxy reads these two and applies the
 * cloud capability check itself. Running an *existing* routine is deliberately
 * not here: that routine was configured at the keyboard. */
export function isRoutineWrite(method: string, path: string): boolean {
  if (method !== "POST" && method !== "PATCH") return false;
  return /^\/api\/routines(?:\/[\w-]+)?$/.test(path);
}

/** Every request the iOS app makes, and nothing else.
 *
 * Ids are `[\w-]+`, matching the harness's own route patterns. The paths
 * arrive undecoded and are anchored at both ends, so an encoded traversal
 * fails to match and is denied rather than forwarded — the failure mode of
 * a strict pattern is a closed door, which is the one to have. */
const DEVICE_ALLOWED: ReadonlyArray<{ method: string; path: RegExp }> = [
  // configured-or-not booleans. The write side is refused below: reading
  // which providers are set up is not reading their keys.
  { method: "GET", path: /^\/api\/config$/ },
  { method: "GET", path: /^\/api\/events$/ },
  { method: "GET", path: /^\/api\/instances$/ },
  // Sidecar-owned, authenticated endpoint metadata. The proxy terminates it
  // locally; it never becomes a newly exposed harness route.
  { method: "GET", path: /^\/api\/companion\/endpoints$/ },

  // the fleet, and making a bot
  { method: "GET", path: /^\/api\/bots$/ },
  { method: "POST", path: /^\/api\/bots$/ },
  // One narrow, atomic organizer write. This can only file visible bots;
  // unlike the desktop's broad PATCH it cannot alter execution policy.
  { method: "POST", path: /^\/api\/sidebar-sections$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/messages$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/interrupt$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/read$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/always-allow$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/messages\/[\w-]+\/edit$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/active-branch$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/tasks$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/tasks\/[\w-]+$/ },
  { method: "PATCH", path: /^\/api\/bots\/[\w-]+\/tasks\/[\w-]+$/ },
  { method: "DELETE", path: /^\/api\/bots\/[\w-]+\/tasks\/[\w-]+$/ },
  // Paired-safe profile subset. The harness route itself rejects fields
  // outside identity, avatar, notifications, and voice preferences.
  { method: "PATCH", path: /^\/api\/bots\/[\w-]+\/profile$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/avatar\/generate$/ },
  // Full cloud desktop access. The route is narrow and the proxy applies a
  // second, per-device capability check before it reaches the harness.
  CLOUD_DESKTOP_JOIN_ROUTE,

  // rooms — making one, and talking in one
  { method: "POST", path: /^\/api\/groups$/ },
  { method: "POST", path: /^\/api\/groups\/[\w-]+\/messages$/ },
  { method: "POST", path: /^\/api\/groups\/[\w-]+\/read$/ },
  { method: "POST", path: /^\/api\/groups\/[\w-]+\/tasks$/ },
  { method: "POST", path: /^\/api\/groups\/[\w-]+\/tasks\/[\w-]+$/ },
  { method: "PATCH", path: /^\/api\/groups\/[\w-]+\/tasks\/[\w-]+$/ },
  { method: "DELETE", path: /^\/api\/groups\/[\w-]+\/tasks\/[\w-]+$/ },

  // a transcript, its images, and answering an approval
  { method: "GET", path: /^\/api\/threads\/[\w-]+\/messages$/ },
  { method: "GET", path: /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/image$/ },
  { method: "POST", path: /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/reactions$/ },
  { method: "GET", path: /^\/api\/threads\/[\w-]+\/export$/ },
  { method: "POST", path: /^\/api\/threads\/[\w-]+\/respond$/ },
  // GET /api/search is deliberately absent. It is a full-transcript grep with
  // no visibility scoping — one character of `q` returns hits from every
  // thread on the machine, including hidden bots and bot-to-bot rooms. A
  // paired device gets transcripts one thread id at a time or not at all.

  // App-owned profile images. Upload is image-only and capped at 10 MB by
  // the harness; GET is a single bare generated filename, never a path.
  { method: "POST", path: /^\/api\/attachments$/ },
  { method: "GET", path: /^\/api\/attachments\/[\w-]+\.(?:png|jpe?g|gif|webp)$/i },
  // Share-sheet documents are raw, capped at 25 MiB, and stored under a
  // generated filename by the harness. The display name stays in the query;
  // only this exact upload route crosses the companion boundary.
  { method: "POST", path: /^\/api\/files$/ },

  // Renderer-neutral voice operations. Neither route reads or writes the
  // workspace ElevenLabs key; the phone receives labels or audio only.
  { method: "GET", path: /^\/api\/tts\/voices$/ },
  { method: "POST", path: /^\/api\/tts\/speak$/ },

  // Routines create ordinary tasks using an existing agent configuration.
  // Webhook management remains explicitly denied below.
  { method: "GET", path: /^\/api\/routines$/ },
  { method: "POST", path: /^\/api\/routines$/ },
  { method: "PATCH", path: /^\/api\/routines\/[\w-]+$/ },
  { method: "DELETE", path: /^\/api\/routines\/[\w-]+$/ },
  { method: "POST", path: /^\/api\/routines\/[\w-]+\/run$/ },

  // Multi-account Composio management exposes opaque ids and aliases only.
  // Revocation stays on the Mac: the account DELETE route is deliberately
  // absent — a paired phone can see and add accounts, never remove one.
  { method: "GET", path: /^\/api\/connectors\/catalog$/ },
  { method: "GET", path: /^\/api\/connectors\/connected$/ },
  { method: "GET", path: /^\/api\/connectors$/ },
  // Authorising an account is also absent, for the same reason the DELETE is:
  // binding a Google or Slack account to this machine is a decision that
  // belongs at the keyboard, not on a credential that lives in a pocket.
];

/** The UI shell itself, served only at the browser door.
 *
 * Anchored and exact, and enumerated rather than wildcarded, for one reason
 * that is not style: the harness's static branch answers a *miss* with
 * `index.html`, `content-type: text/html`, **status 200**
 * (`server/index.ts:9124-9128`). A wildcard here would hand that 200 to a
 * service worker precaching a stale hashed asset, which then caches HTML
 * under a `.js` URL and breaks the app in a way that survives reload. An
 * unmatched static path is a 404 at this door instead.
 *
 * `/assets/` carries vite's content hashes. Measured against the real build:
 * all 311 files in `dist/assets` match `[\w-]+\.(js|css)`, so the pattern is
 * the hash alphabet plus the extensions the build actually emits — not `.*`.
 *
 * `browser.ts` imports this list as well as consuming it through
 * `denyReason`, because it has to know which allowed paths go to the static
 * branch and which are API. */
export const BROWSER_STATIC: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: "GET", path: /^\/$/ },
  { method: "GET", path: /^\/index\.html$/ },
  { method: "GET", path: /^\/assets\/[\w-]+\.(?:js|css|woff2|svg|png|json)$/ },
  { method: "GET", path: /^\/app-icon\.svg$/ },
  { method: "GET", path: /^\/murage-logo(?:-dark)?\.png$/ },
  { method: "GET", path: /^\/favicon\.ico$/ },
  // Not in `dist/` today — the vite build emits neither, measured. Listed so
  // the door does not have to change the day the PWA files land, and harmless
  // until then because a miss is a 404 here rather than the SPA fallback.
  { method: "GET", path: /^\/manifest\.webmanifest$/ },
  { method: "GET", path: /^\/sw\.js$/ },
  { method: "GET", path: /^\/icons\/murage-(?:180|192|512)\.png$/ },
  // SPA deep links. Enumerated, not `/.*`: these are the only client routes
  // the app has, and a wildcard would quietly re-open the SPA fallback for
  // every path the list above refuses.
  { method: "GET", path: /^\/(?:chat|rooms|routines|settings|search)(?:\/[\w-]+)?$/ },
];

/** The four routes that must never be reachable from a browser, whatever
 * else changes.
 *
 * This is the second lock. The harness itself now answers 404 to the first
 * two on any non-desktop surface (`server/index.ts:8505`, `:8534`, commit
 * 07bf5c7c) and the local-VM lifecycle has its own gate. That one is the real
 * boundary; this one exists so that a future edit to `BROWSER_ALLOWED` — the
 * kind that adds a family and takes one line — cannot re-open them by
 * accident. Checked *before* the allowlist, so allowing something here is not
 * a thing an allowlist entry can do.
 *
 * Each line is its own line on purpose. Two of these compose into arbitrary
 * code execution in two requests: `POST /api/cli-test` spawns a
 * caller-supplied path, and `PATCH /api/instances/:id` installs one as the
 * engine every later turn runs.
 *
 * 404 rather than 403, matching the harness: a 403 confirms the route is
 * here and worth attacking. */
export const BROWSER_DENIED: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: "POST", path: /^\/api\/cli-test$/ },
  { method: "PATCH", path: /^\/api\/instances\/[\w.-]+$/ },
  { method: "POST", path: /^\/api\/local-computer(?:\/.*)?$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/local-computer(?:\/.*)?$/ },
];

/** Every harness route the browser UI is allowed to reach.
 *
 * Written out in full rather than composed from `DEVICE_ALLOWED`, and that
 * duplication is the point: the readable diff this file exists for is per
 * surface. Sharing a list would mean a line added for the phone silently
 * appears in the browser, which is exactly the property being bought here.
 *
 * Three things in `DEVICE_ALLOWED` are deliberately absent:
 *
 *  - `POST /api/pair` and `GET /api/health` — the device door's two
 *    unauthenticated routes. The browser door has its own first contact
 *    (`GET /enter`) and terminates it before this function is reached.
 *  - `GET /api/companion/endpoints` — connection candidates for a native
 *    client choosing an address to dial. A browser already arrived.
 *
 * And `GET /api/search` stays absent on both surfaces. The harness now scopes
 * it to visible threads for any non-desktop surface
 * (`server/index.ts:6350-6351`), which fixes the leak, but nothing yet bounds
 * the query — `?q=e` against a LIKE scan is still a bulk read of every
 * visible transcript dressed as a search. Adding it wants the query bound
 * from plan-security §5 first. */
const BROWSER_ALLOWED: ReadonlyArray<{ method: string; path: RegExp }> = [
  ...BROWSER_STATIC,

  // configured-or-not booleans, and the live stream the whole app hangs off.
  { method: "GET", path: /^\/api\/config$/ },
  { method: "GET", path: /^\/api\/events$/ },
  // GET only. The PATCH on this family is half of the two-request RCE and is
  // named again in BROWSER_DENIED above.
  { method: "GET", path: /^\/api\/instances$/ },

  // the fleet, and making a bot
  { method: "GET", path: /^\/api\/bots$/ },
  { method: "POST", path: /^\/api\/bots$/ },
  { method: "POST", path: /^\/api\/sidebar-sections$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/messages$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/interrupt$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/read$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/always-allow$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/messages\/[\w-]+\/edit$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/active-branch$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/tasks$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/tasks\/[\w-]+$/ },
  { method: "PATCH", path: /^\/api\/bots\/[\w-]+\/tasks\/[\w-]+$/ },
  { method: "DELETE", path: /^\/api\/bots\/[\w-]+\/tasks\/[\w-]+$/ },
  // The narrow profile patch, not the desktop's broad PATCH /api/bots/:id.
  { method: "PATCH", path: /^\/api\/bots\/[\w-]+\/profile$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/avatar\/generate$/ },
  // Same route, same per-device capability check. `browser.ts` applies the
  // identical gate the device proxy does before this can be reached.
  CLOUD_DESKTOP_JOIN_ROUTE,

  // rooms — making one, and talking in one
  { method: "POST", path: /^\/api\/groups$/ },
  { method: "POST", path: /^\/api\/groups\/[\w-]+\/messages$/ },
  { method: "POST", path: /^\/api\/groups\/[\w-]+\/read$/ },
  { method: "POST", path: /^\/api\/groups\/[\w-]+\/tasks$/ },
  { method: "POST", path: /^\/api\/groups\/[\w-]+\/tasks\/[\w-]+$/ },
  { method: "PATCH", path: /^\/api\/groups\/[\w-]+\/tasks\/[\w-]+$/ },
  { method: "DELETE", path: /^\/api\/groups\/[\w-]+\/tasks\/[\w-]+$/ },

  // a transcript, its images, and answering an approval
  { method: "GET", path: /^\/api\/threads\/[\w-]+\/messages$/ },
  { method: "GET", path: /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/image$/ },
  { method: "POST", path: /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/reactions$/ },
  { method: "GET", path: /^\/api\/threads\/[\w-]+\/export$/ },
  { method: "POST", path: /^\/api\/threads\/[\w-]+\/respond$/ },

  // attachments and share-sheet documents
  { method: "POST", path: /^\/api\/attachments$/ },
  { method: "GET", path: /^\/api\/attachments\/[\w-]+\.(?:png|jpe?g|gif|webp)$/i },
  { method: "POST", path: /^\/api\/files$/ },

  // voice out, never the workspace key
  { method: "GET", path: /^\/api\/tts\/voices$/ },
  { method: "POST", path: /^\/api\/tts\/speak$/ },

  // routines
  { method: "GET", path: /^\/api\/routines$/ },
  { method: "POST", path: /^\/api\/routines$/ },
  { method: "PATCH", path: /^\/api\/routines\/[\w-]+$/ },
  { method: "DELETE", path: /^\/api\/routines\/[\w-]+$/ },
  { method: "POST", path: /^\/api\/routines\/[\w-]+\/run$/ },

  // opaque connected-app ids and aliases. Authorising and revoking an
  // account stay at the keyboard, on this surface as on the other.
  { method: "GET", path: /^\/api\/connectors\/catalog$/ },
  { method: "GET", path: /^\/api\/connectors\/connected$/ },
  { method: "GET", path: /^\/api\/connectors$/ },

  // ── the new-bot intake, and the library it reads from ─────────────────
  //
  // Six GETs and nothing else. Every one of them ranks, counts or describes;
  // none of them installs anything, and that split is not incidental — it is
  // the same line the harness already draws. `POST /api/bots/:id/skills`,
  // `POST /api/bots/:id/skills/library` and `POST /api/bots/:id/assistant-
  // profile` install a skill, and an enabled skill is instructions the engine
  // will follow, so the harness answers 404 to all three off the desktop
  // (`server/index.ts:7823`, `:7912`). They are absent here as well, by
  // omission rather than by name, so the two locks hold independently: if the
  // harness gate were ever relaxed this list would still refuse them, and the
  // test below pins that.
  //
  // Without these six the phone does not get a degraded intake, it gets a
  // wrong one: `GET /api/bots/:id/skills` is what `bot-skill-count.ts` reads,
  // and a 404 there leaves the count at −1, which is the condition the seeded
  // quiz renders on. So the phone showed the quiz to a bot that already had
  // skills. Browse is the same story one panel over — `library/browse` is the
  // facets, `team-library/catalog` the teams, and without them the panel is
  // an empty box rather than a library.
  //
  // Deliberately still absent: `GET /api/bots/:id/skills/:name` reads a
  // SKILL.md off disk to fill the expanded row. It is a read, and a narrow
  // one, but nothing in the intake needs it and this list grows on purpose.
  { method: "GET", path: /^\/api\/bots\/[\w-]+\/skills$/ },
  { method: "GET", path: /^\/api\/library\/suggest$/ },
  { method: "GET", path: /^\/api\/library\/search$/ },
  { method: "GET", path: /^\/api\/library\/browse$/ },
  // `team-library`, not `teams` — a different family with a different
  // EXPLAINED entry. The slug pattern is the harness's own
  // (`server/index.ts:6665`), anchored, so an encoded traversal fails to
  // match and is denied rather than forwarded.
  { method: "GET", path: /^\/api\/team-library\/catalog$/ },
  { method: "GET", path: /^\/api\/team-library\/teams\/[a-z0-9][a-z0-9-]*$/ },
];

/** Route families worth naming in the refusal.
 *
 * Everything not allowed is denied either way; this only decides whether the
 * person gets a sentence or a 404. These are the ones someone might
 * reasonably expect to work from the phone, where "no route" would read as a
 * bug in the companion rather than a decision about where host configuration
 * happens. Order matters only in that the first match wins. */
const EXPLAINED: ReadonlyArray<{ path: RegExp; error: string }> = [
  {
    path: /^\/api\/(companion|devices)(\/|$)/,
    // Losing the phone must not mean losing the ability to lock it out.
    error: "Phone settings are managed on your computer",
  },
  { path: /^\/api\/config$/, error: "API keys can only be changed on your computer" },
  { path: /^\/api\/local-computer(\/|$)/, error: "the Local VM is set up on your computer" },
  {
    // Creating one exposes an endpoint to the internet, and rotating a
    // secret breaks whatever was sending to it. Neither belongs on a device
    // that lives in a pocket.
    path: /^\/api\/webhooks(\/|$)/,
    error: "webhooks are set up on your computer",
  },
  { path: /^\/api\/connectors(\/|$)/, error: "connected apps are set up on your computer" },
  {
    path: /^\/api\/routines(\/|$)/,
    error: "this routine operation is only available on your computer",
  },
  { path: /^\/api\/teams(\/|$)/, error: "teams are imported and exported on your computer" },
];

/** Why this request may not go through, or null when it may.
 *
 * Default deny: the answer for anything not on the list is "no route", which
 * is what keeps a stolen token from mapping the API. An allowlist rather than
 * a blocklist is the property this whole module exists for, and the one that
 * quietly stopped being true once before. */
export function denyReason({ path, method, authenticated, surface }: RouteRequest): Denial | null {
  // The execution routes, refused before anything can allow them. First, so
  // that no present or future entry in BROWSER_ALLOWED can reach them.
  if (surface === "browser" && BROWSER_DENIED.some((r) => r.method === method && r.path.test(path))) {
    return { status: 404, error: `no route: ${method} ${path}` };
  }

  if (surface === "device") {
    // Pairing is the one thing a device does before it has a credential.
    if (method === "POST" && path === "/api/pair") return null;
    // Liveness is the other: it exists to be the first thing anyone curls when
    // pairing will not work, and behind the token check it answered 401 to
    // exactly the person it was for — which reads as "broken" rather than
    // "unpaired". It discloses nothing a port scan would not.
    if (method === "GET" && path === "/api/health") return null;
  }

  if (!authenticated) {
    return surface === "browser"
      // A browser gets a place to go, not a sentence about a desktop panel.
      // 401 rather than a redirect: the app's own fetches must not follow a
      // 302 into an HTML page and try to parse it as JSON.
      ? { status: 401, error: "sign in", signIn: "/enter" }
      : { status: 401, error: "pair this device from Phone settings in Murage on your computer" };
  }

  const allowed = surface === "browser" ? BROWSER_ALLOWED : DEVICE_ALLOWED;
  if (allowed.some((route) => route.method === method && route.path.test(path))) return null;

  const explained = EXPLAINED.find((family) => family.path.test(path));
  if (explained) return { status: 403, error: explained.error };

  // Everything else, including routes the harness really does have. Saying
  // "no route" rather than "not allowed" keeps the sidecar from enumerating
  // the API to anyone holding a stolen token — and it is what the peer-agent
  // endpoints under /api/internal/ always got, since off this machine they
  // genuinely do not exist.
  return { status: 404, error: `no route: ${method} ${path}` };
}
