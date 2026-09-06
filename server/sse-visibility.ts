// Who may see which SSE frame.
//
// `broadcast()` writes to every open stream. Until this module existed the
// only thing it consulted was `screens`, so a client holding `/api/events`
// received every message on every thread: hidden bots, the auto-created
// bot⇄bot channels, and delegation task threads included. That is a wider
// read than any route the companion allowlist grants, and it is reachable
// today with nothing but a paired device token.
//
// The rule here is deliberately narrow, because the failure mode of an
// over-broad rule is a phone that silently stops updating:
//
//   a frame that names a conversation reaches only a client entitled to
//   that conversation; a frame that names none is workspace-level and
//   reaches everyone.
//
// "Entitled" is the same set the sidebar shows a person: every bot they have
// not hidden and every room they made. It is a surface filter, not an
// authorization model — see the note on `visibleToCompanion`.
import { randomBytes, timingSafeEqual } from "node:crypto";

/** Which door a request came through, and therefore how much of the
 * workspace it may be shown. `remote` is not one client — it is every
 * client that is not the local desktop app. */
export type Surface = "desktop" | "remote";

/** The desktop's opt-out marker, in the header form and the query form. */
export const DESKTOP_SURFACE = "desktop";
export const SURFACE_HEADER = "x-murage-surface";
export const SURFACE_QUERY = "surface";
export const COMPANION_HEADER = "x-murage-companion";

/** Where the per-launch desktop secret travels. Two forms for the same
 * reason the marker has two: `EventSource` cannot set a request header, so
 * `/api/events` has only the query string. */
export const SURFACE_SECRET_HEADER = "x-murage-surface-secret";
export const SURFACE_SECRET_QUERY = "surfaceSecret";

/** Is this process the harness that Electron embeds?
 *
 * `process.parentPort` is supplied by exactly one runtime — an Electron
 * `utilityProcess` child — and `electron/main.mjs` forks the harness that
 * way (`startServerOn`, guarded by `app.isPackaged`). There is no other path
 * by which a packaged build starts this server, so this is a structural fact
 * about how the process was launched rather than a claim its environment
 * makes about itself. `MURAGE_DESKTOP_PARENT` is the same claim in env form
 * and is kept only as a second, weaker witness.
 *
 * Everything dev-only below hangs off this, because what dev mode needs is
 * an env var — and an env var must never be able to switch itself on inside
 * a shipped app. */
const embeddedInDesktopApp =
  (process as NodeJS.Process & { parentPort?: unknown }).parentPort !== undefined ||
  process.env.MURAGE_DESKTOP_PARENT === "1";

/** Pins the secret to a known value so a dev renderer served by Vite — which
 * is a different origin, a different process, and has no Electron bridge —
 * can hold it too. Read once, at import. */
const DEV_SECRET_ENV = "MURAGE_DEV_DESKTOP_SECRET";
/** For a harness that runs outside Electron and is NOT a developer's box —
 * the cloud install, where the only humans on loopback are agents. */
const DEV_SECRET_OFF_ENV = "MURAGE_NO_DEV_DESKTOP_SECRET";
/** Only explicit development/fixture launchers may offer the handshake. */
const DEV_SECRET_ALLOW_ENV = "MURAGE_ALLOW_DEV_DESKTOP_SECRET";

const devSecretAllowed =
  !embeddedInDesktopApp && process.env[DEV_SECRET_OFF_ENV] !== "1" &&
  (process.env[DEV_SECRET_ALLOW_ENV] === "1" || Boolean(process.env[DEV_SECRET_ENV]?.trim()));

/** One secret, minted once per launch, never written to disk and never
 * logged. `randomBytes(32)` because this is the whole proof now: a caller
 * that holds it is the local desktop app, and a caller that does not is
 * `remote` no matter what it says about itself. */
const desktopSecret = (() => {
  const pinned = devSecretAllowed ? (process.env[DEV_SECRET_ENV] ?? "").trim() : "";
  return pinned || randomBytes(32).toString("hex");
})();
const desktopSecretBytes = Buffer.from(desktopSecret, "utf8");

/** The secret itself. Two callers, both in `index.ts`: the message that hands
 * it to Electron's main process over the private utility-process port, and
 * the dev-only route below. It must not reach a log, a config file, an agent
 * environment, or an MCP server. */
export function desktopSurfaceSecret(): string {
  return desktopSecret;
}

/** Whether this harness may hand the secret to a loopback caller that asks.
 *
 * False inside the packaged app, always — see `embeddedInDesktopApp`. True
 * for explicitly opted-in `pnpm dev:server` and fixture launchers, where the
 * renderer has no bridge to ask through. A plain Node or production launch
 * is closed by default. A cloud install additionally forces
 * `MURAGE_NO_DEV_DESKTOP_SECRET=1`, overriding any inherited dev opt-in. */
export function devDesktopSecretOffered(): boolean {
  return devSecretAllowed;
}

/** Constant-time, and `false` for anything that is not exactly the secret.
 *
 * The length compare leaks the length, which is a fixed 64 hex characters in
 * every real launch — the same trade `authorizedComms` makes for the peer
 * comms token, and for the same reason. */
function secretProven(candidate: string | undefined): boolean {
  if (!candidate) return false;
  const got = Buffer.from(candidate, "utf8");
  return got.length === desktopSecretBytes.length && timingSafeEqual(got, desktopSecretBytes);
}

const headerValue = (
  headers: Partial<Record<string, string | string[] | undefined>>,
  name: string,
): string | undefined => {
  const raw = headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
};

/** The companion marker, read as PRESENCE rather than as a value.
 *
 * Node folds most duplicated request headers into one comma-joined string,
 * so two `x-murage-companion: 1` headers arrive as the string `"1, 1"`. A
 * check spelled `=== "1"` reads that as "not a companion", falls through to
 * the desktop markers, and a request carrying `?surface=desktop` is then
 * served as the local app. The door that exists today builds its forwarded
 * headers in a fresh object and stamps this one itself, so nothing can smuggle
 * a duplicate through it — but the value was never the point. Any spelling of
 * the marker means a door put it there, and the answer is the narrow one. */
export const companionMarked = (
  headers: Partial<Record<string, string | string[] | undefined>>,
): boolean => headers[COMPANION_HEADER] !== undefined;

/** Which surface is asking — **defaulting to the narrow answer**.
 *
 * The security plan wrote this the other way round:
 *
 *   const companion = req.headers["x-murage-companion"] === "1";
 *   scope = companion ? store.visibleThreadIds() : undefined;
 *
 * which means *absent header ⇒ unscoped*. That is the wrong direction for a
 * default. The one door that exists today happens to set the header, but the
 * next one is a new listener in a new file, and the failure mode of
 * forgetting a line there is the whole transcript rather than a broken
 * feature — silent, and only visible to whoever is reading the stream.
 *
 * So breadth is proved, never assumed. Four rules, and the order matters:
 *
 *  1. A caller that says it is a companion IS one. `proxy.ts` writes
 *     `x-murage-companion: 1` into a *fresh* header object, so a device
 *     cannot clear it — and checking it first means a device cannot talk its
 *     way out with a forged `?surface=desktop` either. Read as presence, not
 *     as a value: see `companionMarked`.
 *  2. The local desktop announces itself. `EventSource` cannot set a request
 *     header and the renderer's live stream is a native `EventSource`
 *     (`src/lib/live-events.ts`), so the query form is not a convenience —
 *     it is the only form that route can use. The header form is for
 *     `fetch` callers such as `/api/search`.
 *  3. …and PROVES it, with the per-launch secret. The marker says what the
 *     caller wants; the secret says who it is. Both, or `remote`.
 *  4. Everything else is `remote`.
 *
 * Rule 3 is the one this file used to be missing, and the commits that added
 * rules 1–2 oversold what they bought. The marker is not a secret: any local
 * process could type it, and
 *
 *     curl -H 'x-murage-surface: desktop' 127.0.0.1:8799/api/cli-test
 *
 * therefore reached a route that spawns a caller-supplied binary. "Local
 * process" is not a small set on this machine — every agent the app runs has
 * a shell. What the markers alone bought was real but narrower than claimed:
 * a *remote* door gets the narrow stream without having to know this file
 * exists. Naming a principal takes a secret only the renderer holds, minted
 * fresh each launch, above.
 *
 * The polarity is unchanged, and deliberately so: a wrong secret, a missing
 * secret and a malformed one are all simply `remote`. There is no 403 here
 * and no distinguishable failure — a caller learns nothing about whether it
 * guessed close, and the routes that care answer 404 rather than confirm
 * they exist. */
export function requestSurface(
  headers: Partial<Record<string, string | string[] | undefined>>,
  query?: URLSearchParams | null,
): Surface {
  if (companionMarked(headers)) return "remote";
  const marked =
    headerValue(headers, SURFACE_HEADER) === DESKTOP_SURFACE ||
    query?.get(SURFACE_QUERY) === DESKTOP_SURFACE;
  if (!marked) return "remote";
  const proven =
    secretProven(headerValue(headers, SURFACE_SECRET_HEADER)) ||
    secretProven(query?.get(SURFACE_SECRET_QUERY) ?? undefined);
  return proven ? DESKTOP_SURFACE : "remote";
}

/** What one frame is about. `workspace` frames belong to no conversation. */
export type FrameSubject =
  | { scope: "workspace" }
  | { scope: "thread"; threadId: string }
  | { scope: "bot"; botId: string }
  | { scope: "group"; groupId: string };

const WORKSPACE: FrameSubject = { scope: "workspace" };

/** The slice of `Store` this decision needs. Structural rather than the
 * concrete class so the unit tests can state the world in four lines, and
 * so the same predicate can be reused by `/api/bots`, `/api/search` and
 * `/api/threads/:id/messages` without dragging the server in. */
export interface VisibilityStore {
  bot(id: string): { hidden?: boolean } | null;
  botByThread(threadId: string): { hidden?: boolean } | null;
  group(id: string): { dm?: boolean } | undefined;
  groupByThread(threadId: string): { dm?: boolean } | undefined;
}

const id = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const nested = (payload: Record<string, unknown>, key: string): Record<string, unknown> | null => {
  const value = payload[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
};

/** Every frame kind `broadcast()` emits that this module decides explicitly.
 *
 * The `default` branch below is a safety net, not a policy: it looks for
 * `threadId`/`botId`/`groupId` at the top level, so a kind added later that
 * nests transcript content under some other key resolves to `workspace` and
 * goes to every open stream. That is the leak direction, and it is silent.
 *
 * `sse-visibility.test.ts` reads the `broadcast({ kind: … })` call sites out
 * of `index.ts` and fails if any of them is missing from this list, so a new
 * kind breaks the build and has to be classified on purpose. */
export const KNOWN_FRAME_KINDS = [
  "message",
  "message.patch",
  "thread",
  "runtime",
  "notify",
  "bot",
  "group",
  "screen",
  "computer",
  "computer-control",
  "bot.deleted",
  "group.deleted",
  "config",
] as const;

/** Read the conversation a frame is about out of its payload.
 *
 * Kinds are listed explicitly rather than inferred, so renaming a payload
 * field shows up here as a frame that stops resolving instead of a frame
 * that quietly becomes workspace-level. */
export function frameSubject(payload: Record<string, unknown>): FrameSubject {
  const kind = String(payload.kind ?? "");
  switch (kind) {
    case "message":
    case "message.patch":
    case "thread": {
      const threadId = id(payload.threadId);
      return threadId ? { scope: "thread", threadId } : WORKSPACE;
    }
    case "runtime": {
      // Streaming deltas — the assistant's text before it is persisted.
      const threadId = id(nested(payload, "event")?.threadId);
      return threadId ? { scope: "thread", threadId } : WORKSPACE;
    }
    case "notify": {
      const threadId = id(nested(payload, "notification")?.threadId);
      return threadId ? { scope: "thread", threadId } : WORKSPACE;
    }
    case "bot": {
      // Most bot frames are the slim wire shape, but the routine and import
      // paths send `publicBot`, which carries the whole transcript inline.
      const botId = id(nested(payload, "bot")?.id);
      return botId ? { scope: "bot", botId } : WORKSPACE;
    }
    case "group": {
      const groupId = id(nested(payload, "group")?.id);
      return groupId ? { scope: "group", groupId } : WORKSPACE;
    }
    case "screen":
    case "computer":
    case "computer-control": {
      const botId = id(payload.botId);
      return botId ? { scope: "bot", botId } : WORKSPACE;
    }
    // A deletion names a record that is already gone, so nothing can resolve
    // it and a fail-closed lookup would drop every one of them — leaving a
    // deleted bot in the phone's sidebar until the next full refresh. The
    // frame carries an opaque id and no content, so it goes to everyone.
    case "bot.deleted":
    case "group.deleted":
      return WORKSPACE;
    // Settings for the machine, belonging to no conversation. Listed rather
    // than left to the default branch so that "workspace" is a decision
    // somebody made about this kind, not a thing that happened to it.
    case "config":
      return WORKSPACE;
    default: {
      // A frame this module has not been taught. Harness frames name their
      // subject with these exact keys, so resolving by convention keeps a
      // future thread-bearing frame scoped rather than silently exempt.
      const threadId = id(payload.threadId);
      if (threadId) return { scope: "thread", threadId };
      const botId = id(payload.botId);
      if (botId) return { scope: "bot", botId };
      const groupId = id(payload.groupId);
      if (groupId) return { scope: "group", groupId };
      return WORKSPACE;
    }
  }
}

/** Whether a companion client — a paired device, reaching the harness
 * through the sidecar — may be shown this frame.
 *
 * Excluded: bots the person hid, and the `dm` channels the harness creates
 * for bot⇄bot exchanges. Task threads follow their owner, because
 * `botByThread`/`groupByThread` already resolve them.
 *
 * Unresolvable subjects fail closed. A thread belonging to no bot and no
 * room is one the companion surface has no route to open, so dropping its
 * frames costs nothing and is the safe direction for anything added later.
 *
 * This is a surface filter and not an authorization model: it decides what
 * is pushed, not what may be pulled. `GET /api/bots`, `GET /api/search` and
 * `GET /api/threads/:id/messages` still answer for every thread on the
 * machine, and closing those is the rest of the same job. */
/** Whether the record a subject names exists at all.
 *
 * `visibleToCompanion` returns false for two very different reasons, and
 * only one of them is the policy working. "Hidden bot" and "dm room" are
 * deliberate. "Nothing resolved this" is the fail-closed branch, and it is
 * the direction that eats frames a client was entitled to — a message
 * broadcast that outran the store's thread→bot mapping looks exactly like a
 * conversation the person may not see, and the symptom is a phone quietly
 * missing the first lines of a new chat.
 *
 * Splitting the two lets the second be counted instead of guessed at. */
export function subjectResolves(store: VisibilityStore, subject: FrameSubject): boolean {
  switch (subject.scope) {
    case "workspace":
      return true;
    case "thread":
      return Boolean(store.botByThread(subject.threadId) ?? store.groupByThread(subject.threadId));
    case "bot":
      return store.bot(subject.botId) !== null;
    case "group":
      return store.group(subject.groupId) !== undefined;
  }
}

export function visibleToCompanion(store: VisibilityStore, subject: FrameSubject): boolean {
  switch (subject.scope) {
    case "workspace":
      return true;
    case "thread": {
      const bot = store.botByThread(subject.threadId);
      if (bot) return bot.hidden !== true;
      const group = store.groupByThread(subject.threadId);
      if (group) return group.dm !== true;
      return false;
    }
    case "bot": {
      const bot = store.bot(subject.botId);
      return bot ? bot.hidden !== true : false;
    }
    case "group": {
      const group = store.group(subject.groupId);
      return group ? group.dm !== true : false;
    }
  }
}
