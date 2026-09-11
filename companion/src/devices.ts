// Companion devices — the phones allowed to reach this harness over the
// network. Everything here exists because of one fact: the harness has no
// authentication at all, and it is right not to have any on 127.0.0.1. The
// loopback socket IS the credential — the same reason the app can PUT an API
// key without proving anything. The moment a second socket leaves loopback
// that assumption is gone, so a device token becomes the credential instead.
//
// Tokens follow the same write-only rule as the keys in config.json: the
// token is generated once, handed to the phone at pairing, and never stored
// — devices.json keeps only its SHA-256. A stolen devices.json is not a
// stolen fleet.
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR, ensureDataDir, writeFileAtomic } from "./state.ts";

/** One browser signed in against a paired device.
 *
 * A browser session is a second credential *form* for an existing device, not
 * a second identity. That is the whole reason it is stored inside the device
 * record rather than beside it: there is no second store to keep consistent,
 * so `revoke()` already kills every browser signed in on that device, and
 * `connectedDeviceTracker` already terminates their live streams. */
export interface BrowserSession {
  /** sha256 of the cookie value — same write-only rule as `tokenHash`. */
  hash: string;
  /** "Safari on iPhone", clamped the same way a device name is. */
  label: string;
  createdAt: number;
  lastSeenAt: number;
  /** The absolute cap. Set at sign-in and moved forward by `renewSession`,
   * never past `createdAt + SESSION_MAX_LIFETIME_MS`. Use alone does not
   * move it — only an explicit renewal does. */
  expiresAt: number;
}

/** One paired phone, as it is written to disk. */
export interface DeviceRecord {
  id: string;
  name: string;
  /** sha256 of the bearer token — never the token itself */
  tokenHash: string;
  createdAt: number;
  lastSeenAt: number;
  /** Full interactive access to a bot's cloud desktop. Deliberately off on
   * every new and migrated device until the computer owner enables it. */
  cloudDesktopAccess: boolean;
  /** Browsers signed in against this device. Hashes only. Absent on a device
   * that has never opened one, which is what every record predating the
   * browser door looks like. */
  sessions?: BrowserSession[];
}

/** What the UI is allowed to see: a device without its secrets.
 *
 * `sessions` goes too. Session hashes are not credentials — you cannot sign
 * in with a digest — but they are the only thing standing between a leaked
 * devices.json and an offline guess at a cookie value, and the control page
 * has no use for them. Same rule as `tokenHash`, for the same reason. */
export type PublicDevice = Omit<DeviceRecord, "tokenHash" | "sessions">;

/** A pairing window: two short-lived credentials, deliberately single-use.
 *
 * `token` is the primary path carried inside the QR code. It has enough
 * entropy to stand on its own and is never typed or persisted. `code` is the
 * human fallback: six digits is only 1e6 possibilities, so it lives for
 * `PAIRING_TTL_MS` and no longer, dies after `MAX_PAIRING_ATTEMPTS` wrong
 * guesses, and only exists while the user is looking at the pairing screen.
 * Redeeming either burns both.
 *
 * Named rather than numbered on purpose: this comment restated the duration
 * in English for a while after the constant changed, and went on being wrong
 * because nothing recompiles a comment. A restated constant is a second copy
 * of it, and `devices.test.ts` now reads this file back to keep it the only
 * one. */
export interface PairingWindow {
  code: string;
  token: string;
  expiresAt: number;
  attemptsLeft: number;
}

/** Why a redemption failed, as a stable code rather than a sentence.
 *
 * The sentence is for the person and will be reworded; this is for the two
 * doors, which have to *behave* differently per case and must not do that by
 * matching on prose. Specifically: a wrong code is a guess and counts against
 * the door's rate limiter, while `full` is a *correct* code arriving at a full
 * fleet — locking somebody out for that would punish them for the one failure
 * they can fix at the keyboard in ten seconds.
 *
 * It is an added field on the existing `{ error }` shape, deliberately: the
 * device door (`proxy.ts`) reads `.error` and is outside this change's lane. */
export type RedeemFailure =
  /** There is no window and none of the remembered spent ones matches. */
  | "no-pairing"
  /** This exact credential existed and ran out of time, or was superseded. */
  | "expired"
  /** This exact credential already signed a device in. */
  | "used"
  /** This exact credential was destroyed by wrong guesses. */
  | "burned"
  /** A live window exists and this is not it. */
  | "wrong"
  /** The guess budget on the live window just ran out. */
  | "locked-out"
  /** Right credential, no room left in the fleet. */
  | "full"
  /** Right credential, and the registration could not be written down. */
  | "save-failed";

/** A window that is gone, remembered only so that presenting it again gets an
 * honest answer instead of "no pairing is in progress".
 *
 * This is the difference between a person retyping a code and being told the
 * truth — it expired, it was already used, it was guessed to death — and
 * being told something that reads as "the app forgot about pairing", which
 * sends them looking for a fault that is not there.
 *
 * Hashes, not the credentials, for the same reason `tokenHash` is a hash: this
 * lives in a long-running desktop process and there is no reason for a spent
 * credential to sit in it in the clear. And it is *forgotten* on a timer, so
 * the honest answer is not available forever — see `SPENT_MEMORY_MS`. */
interface SpentWindow {
  codeHash: string;
  tokenHash: string;
  reason: Extract<RedeemFailure, "expired" | "used" | "burned">;
  forgetAt: number;
}

/** A successful redemption kept only long enough for the *same* phone request
 * to recover from a lost HTTP response on another advertised address.
 *
 * The device token remains memory-only here (the durable file still contains
 * only its digest), and a replay needs both the original high-entropy pairing
 * credential and the client-generated request id. Older clients that omit a
 * request id retain the original exactly-once behaviour. */
interface PairingReplay {
  requestId: string;
  credentialHash: string;
  expiresAt: number;
  result: { device: PublicDevice; token: string };
}

const DEVICES_FILE = join(DATA_DIR, "devices.json");
export /** How long a pairing window stays open.
 *
 * It was 2 * 60_000 once, and that was measured against a flow that does not
 * exist: the person is already holding the phone with the camera open. The real flow is
 * open Phone settings on the computer, walk to the phone, unlock it, find the
 * camera, frame the code — or, when the code is relayed to another person,
 * read a message and paste a link into a browser. Every one of those took
 * longer than the window, and the failure reads as a rejection ("that pairing
 * credential is not right") rather than as an expiry, which sends people
 * hunting for a wrong password that was never wrong.
 *
 * Ten minutes changes nothing about what guards the six-digit code: that is
 * the five-attempt lockout below, which burns the window on the fifth wrong
 * guess. A longer window does not buy an attacker more attempts. It buys a
 * person time to walk across the room. */
const PAIRING_TTL_MS = 10 * 60_000;
export const MAX_PAIRING_ATTEMPTS = 5;
/** How long a dead pairing window is remembered well enough to be explained.
 *
 * The same ten minutes the window itself lived, which is the useful span: a
 * person who was too slow, or whose code was already spent by another device,
 * is still holding the same digits and still standing in front of the screen.
 * After that the honest answer is genuinely "no pairing is in progress",
 * because by then nothing about the old window is true any more.
 *
 * Bounded in time on purpose. Presenting a spent credential is free — there is
 * no window left to charge attempts against — so an unbounded memory would be
 * a permanently queryable oracle for "was 123456 ever a code here". Ten
 * minutes and three entries is a small enough surface to state plainly, the
 * answer it gives away is about a credential that is already dead, and the
 * door's own limiter (`browser.ts`) is what stops anybody asking it quickly. */
const SPENT_MEMORY_MS = PAIRING_TTL_MS;
/** Refreshing the QR twice in a row should still explain the first code. Three
 * is enough for that and small enough that the list never needs a real
 * eviction policy. */
const MAX_SPENT_WINDOWS = 3;
/** Bounds the file, and a fleet of 20 phones is already an odd story. */
export const MAX_DEVICES = 20;
/** lastSeen is a UI nicety, not an audit log — don't write on every request. */
const LAST_SEEN_WRITE_MS = 60_000;
/** A browser that clears cookies weekly must not grow devices.json without
 * bound. Oldest-first eviction, so signing in on a fourth browser signs the
 * least recently used one out rather than failing. */
export const MAX_SESSIONS_PER_DEVICE = 3;
/** Rolling idle window. Longer than a fortnight away from a machine is a
 * reasonable point to make somebody scan the QR again.
 *
 * UNCHANGED BY RENEWAL, and that is a decision rather than an oversight.
 * `renewSession` moves the absolute cap because a cap punishes a session for
 * ageing; this bound punishes a session for being *unused*, and renewal has
 * no evidence to offer against it — a renewal only ever happens because a
 * page is open, which is the definition of not idle.
 *
 * Sixty days, and the number is the whole point of the feature.
 *
 * Renewal cannot help this bound and never could: a renewal happens only
 * because a page is open, and a page being open is the definition of not
 * idle. A laptop closed in a bag sends nothing and has no way to say it still
 * wants the session. So the only lever is this constant.
 *
 * At fourteen days the case this was built for still failed. A machine
 * reached from a hotel twice a quarter is a ~45-day gap, so it was signed out
 * every single time — and re-pairing needs the QR from the desktop sitting at
 * home, which is exactly what is absent on the road. Sixty covers that with
 * margin for a skipped trip while staying inside a business quarter, so a
 * device genuinely abandoned still expires.
 *
 * The cost is that a stolen cookie on an untouched device stays valid for
 * sixty days rather than fourteen, and it is close to nothing here. Using one
 * requires already being on the tailnet — there is no public ingress and
 * never will be — and if a stranger is on the tailnet, a fourteen-day cookie
 * is not the control that saves anyone. Meanwhile rotation made theft
 * strictly worse for the thief than the old scheme ever did: every time the
 * real browser returns, the hash rotates and the stolen copy dies. And revoke
 * is instant, killing every session on a device, renewed or not.
 *
 * `RENEW_INTERVAL_MS` is deliberately NOT derived from this — see the note
 * there for why daily renewal is about rotation freshness, not about this
 * window. */
export const SESSION_IDLE_MS = 60 * 24 * 60 * 60 * 1000;
/** How far ahead the absolute cap is set, at sign-in and at every renewal.
 *
 * It is no longer "never extended" — see `SESSION_MAX_LIFETIME_MS` and
 * `renewSession` for what replaced that, and why. */
export const SESSION_ABSOLUTE_MS = 90 * 24 * 60 * 60 * 1000;
/** The wall. The one bound in this file no client can push.
 *
 * The cap used to be simply "90 days from sign-in, never extended", and for a
 * phone opened weekly that is fine: ten seconds of QR once a quarter. For the
 * laptop this feature exists for it is not fine at all. Somebody who reaches
 * their home machine twice a quarter is ALWAYS past the cap when they need
 * it, and re-pairing needs physical access to the desktop — which is exactly
 * what they do not have when they are away from it. A credential that only
 * works when you are standing next to the thing it lets you reach is not a
 * remote credential.
 *
 * So renewal moves `expiresAt`. The question the cap has to keep answering is
 * "how long can a credential chain live", and the answer must not be "as long
 * as anyone keeps asking", because then it is not a cap. Three positions were
 * available:
 *
 *  - Renewal extends nothing. The traveller is stranded. That is the bug.
 *  - Renewal re-anchors freely. A stolen cookie that renews on a timer lives
 *    forever, and the cap is decoration.
 *  - Renewal extends up to a ceiling anchored on the session's `createdAt`,
 *    which renewal never rewrites. That is this.
 *
 * A year. Once a year, at your own desk, you scan a code — and between those
 * scans the credential is rotated on every renewal, so the value sitting in a
 * cookie jar or in devices.json is at most one renewal interval old. That
 * rotation is a stronger property than the old cap ever bought: the 90-day
 * wall did nothing to a thief inside the window, whereas rotation retires the
 * stolen copy the moment the real browser comes back.
 *
 * The ceiling is per SESSION, not per device. Signing in again on the same
 * browser starts a fresh year, because that sign-in required the pairing
 * credential and therefore the desktop. */
export const SESSION_MAX_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;

/** Hex digest. Tokens live on disk as one of these and never in the clear. */
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Constant-time compare of two hex digests of the same length. A plain ===
 * on a token hash leaks its prefix through timing; cheap to avoid. */
function sameDigest(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/** Same treatment for a pairing credential, which is compared far more often
 * than it is correct. */
function sameCredential(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Whether a browser session is past either of its two bounds.
 *
 * Both, and they are different bounds: `expiresAt` is the absolute cap, which
 * only an explicit `renewSession` moves and only up to a fixed ceiling, and
 * the idle window rolls forward with use. A session that fails either is
 * gone — including inside `renewSession`, which refuses to renew what is
 * already expired rather than becoming a back door around both. */
function sessionExpired(session: BrowserSession, now: number): boolean {
  return session.expiresAt <= now || now - session.lastSeenAt > SESSION_IDLE_MS;
}

/** Device names come from the phone, so they are untrusted display text:
 * clamp the length and drop control characters before they reach a UI. */
export function cleanDeviceName(raw: unknown): string {
  const name = String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, 60);
  return name || "Companion";
}

/** A timestamp we are willing to render, or a stand-in. `0` and the negatives
 * are as wrong as a missing field and read worse: they date a device to 1970
 * in the UI, where "now" is at least true of when we learned of it. */
const timestamp = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;

/** Complete a stored record, whatever shape the file had. `lastSeenAt` falls
 * back to `createdAt` rather than to the clock: a device we have never heard
 * from since pairing was last seen when it paired. */
function normalizeDevice(record: Partial<DeviceRecord> & { id: string; tokenHash: string }): DeviceRecord {
  const createdAt = timestamp(record.createdAt, Date.now());
  const device: DeviceRecord = {
    id: record.id,
    tokenHash: record.tokenHash,
    name: cleanDeviceName(record.name),
    createdAt,
    lastSeenAt: timestamp(record.lastSeenAt, createdAt),
    cloudDesktopAccess: record.cloudDesktopAccess === true,
  };
  // A session without a hash cannot authenticate and cannot be signed out;
  // it is a row that would sit in the file forever doing nothing. Drop it
  // rather than complete it, which is the opposite call from the device
  // fields above and for the opposite reason: those decorate a working
  // credential, this one *is* the credential.
  const sessions = Array.isArray(record.sessions) ? record.sessions : [];
  const kept = sessions
    .filter((s): s is BrowserSession => typeof (s as BrowserSession)?.hash === "string")
    .map((s) => ({
      hash: s.hash,
      label: cleanDeviceName(s.label),
      createdAt: timestamp(s.createdAt, createdAt),
      lastSeenAt: timestamp(s.lastSeenAt, timestamp(s.createdAt, createdAt)),
      expiresAt: timestamp(s.expiresAt, 0),
    }))
    .slice(0, MAX_SESSIONS_PER_DEVICE);
  if (kept.length) device.sessions = kept;
  return device;
}

/** The paired fleet: who may reach the harness through the sidecar, and the
 * one short-lived window in which a new phone may join it. Backed by a file,
 * loaded once at construction and written on every change. */
export class DeviceRegistry {
  private devices: DeviceRecord[] = [];
  private window: PairingWindow | null = null;
  private spent: SpentWindow[] = [];
  private replay: PairingReplay | null = null;
  private replayExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSeenWrites = new Map<string, number>();
  /** A process-local name for each session RECORD.
   *
   * Live streams have to be ended when their session ends, and the cookie
   * cannot name the session for that: renewal rotates the hash in place while
   * the session carries on. The record object itself is the identity —
   * `renewSession` mutates it where it sits, and every way a session ends
   * removes that object — so the id is keyed on the object and never written
   * to disk. A restart drops every stream anyway. */
  private sessionIds = new WeakMap<BrowserSession, string>();
  private sessionEndListeners = new Set<(ended: { deviceId: string; sessionId: string }) => void>();

  /** Load the paired fleet, normalising as it goes.
   *
   * Only `id` and `tokenHash` decide whether a record is a device at all —
   * without them it can neither be revoked nor authenticate. The rest is
   * display, and a record missing it is not worth discarding a working phone
   * over: what a half-written or hand-edited file used to produce was a UI
   * saying "undefined", last seen "NaN min ago". Defaults are cheaper than
   * either dropping the device or teaching every reader to doubt the type. */
  constructor() {
    try {
      const parsed = JSON.parse(readFileSync(DEVICES_FILE, "utf8"));
      if (Array.isArray(parsed?.devices)) {
        this.devices = parsed.devices
          .filter(
            (d: unknown): d is Partial<DeviceRecord> & { id: string; tokenHash: string } =>
              typeof (d as DeviceRecord)?.id === "string" &&
              typeof (d as DeviceRecord)?.tokenHash === "string",
          )
          .map(normalizeDevice);
      }
    } catch {
      /* first run, or a file we can't read — start with no paired devices */
    }
  }

  /** Write the fleet to disk. Atomic, because a torn file reads as empty and
   * would sign every phone out with no way to tell why. */
  private persist() {
    ensureDataDir();
    writeFileAtomic(DEVICES_FILE, JSON.stringify({ devices: this.devices }, null, 2));
  }

  /** Every paired device, without the hash — this is what the page renders. */
  list(): PublicDevice[] {
    return this.devices.map(({ tokenHash, sessions, ...rest }) => rest);
  }

  /** How many phones are paired, against MAX_DEVICES. */
  count(): number {
    return this.devices.length;
  }

  /** The live pairing window, or null. Expiry is evaluated on read so a
   * stale window can never be redeemed by a caller that skipped a tick. */
  pairing(): PairingWindow | null {
    if (this.window && this.window.expiresAt <= Date.now()) this.spend("expired");
    return this.window;
  }

  /** Retire the live window, remembering what it was and why it went.
   *
   * Every path that clears `this.window` goes through here, which is what
   * makes "why is this code not working" answerable at all. It deliberately
   * does NOT touch the replay record: `closePairing` is the explicit cancel
   * and clears that separately, and a successful redemption must keep it. */
  private spend(reason: SpentWindow["reason"]): void {
    const window = this.window;
    this.window = null;
    if (!window) return;
    const now = Date.now();
    this.spent = this.spent
      .filter((entry) => entry.forgetAt > now)
      .concat({
        codeHash: sha256(window.code),
        tokenHash: sha256(window.token),
        reason,
        forgetAt: now + SPENT_MEMORY_MS,
      })
      .slice(-MAX_SPENT_WINDOWS);
  }

  /** The remembered fate of a credential that is no longer live, or null. */
  private recallSpent(presented: string): SpentWindow | null {
    const now = Date.now();
    this.spent = this.spent.filter((entry) => entry.forgetAt > now);
    const hash = sha256(presented);
    // Newest first: refreshing the QR twice leaves two "expired" rows and the
    // most recent one is the one the person is most likely holding.
    for (let i = this.spent.length - 1; i >= 0; i--) {
      const entry = this.spent[i];
      if (sameDigest(entry.codeHash, hash) || sameDigest(entry.tokenHash, hash)) return entry;
    }
    return null;
  }

  /** Open a fresh window, replacing any that was already open. The code is
   * from `randomInt`, not `Math.random` — it is a credential, live for
   * `PAIRING_TTL_MS`, and the entropy has to hold for all of it. */
  openPairing(): PairingWindow {
    this.clearReplay();
    // The replaced window is gone, and somebody may be holding it: a person
    // who pressed Refresh on the desktop while a second person was typing.
    // "That code has expired" is true of it and is the useful thing to say.
    this.spend("expired");
    this.window = {
      code: String(randomInt(0, 1_000_000)).padStart(6, "0"),
      token: `murage_pair_${randomBytes(32).toString("base64url")}`,
      expiresAt: Date.now() + PAIRING_TTL_MS,
      attemptsLeft: MAX_PAIRING_ATTEMPTS,
    };
    return this.window;
  }

  closePairing(expectedToken?: string): boolean {
    if (expectedToken !== undefined && this.pairing()?.token !== expectedToken) return false;
    // Cancelled on the computer reads to whoever is holding the digits
    // exactly as an expiry does: the code was live, it is not any more, and
    // the fix is to open the pairing screen again.
    this.spend("expired");
    this.clearReplay();
    return true;
  }

  /** Erase the only in-memory copy of a successfully issued device token.
   * The timer matters even if nobody ever calls `redeem` again: an expired
   * recovery window must not leave a raw bearer sitting in a long-lived
   * desktop process. */
  private clearReplay() {
    this.replay = null;
    if (this.replayExpiryTimer) clearTimeout(this.replayExpiryTimer);
    this.replayExpiryTimer = null;
  }

  /** Redeem either pairing credential for a device token.
   *
   * Old clients receive the token exactly once. A client that supplies a
   * request id may repeat that same logical redemption until the pairing
   * window's original expiry, which is just enough to survive losing the
   * response while changing routes. There is no general token-read endpoint. */
  redeem(
    credential: string,
    name: unknown,
    pairRequestId?: unknown,
  ): { device: PublicDevice; token: string } | { error: string; reason: RedeemFailure } {
    const presented = String(credential ?? "");
    const requestId =
      typeof pairRequestId === "string" && /^[A-Za-z0-9._-]{16,128}$/.test(pairRequestId)
        ? pairRequestId
        : null;

    // A route can die after the registry committed the device but before the
    // phone received the response. Retrying the same logical request through
    // another advertised address must return the same device, not burn a
    // second slot or turn a successful pairing into a misleading 401.
    if (this.replay && this.replay.expiresAt <= Date.now()) this.clearReplay();
    if (
      requestId &&
      this.replay &&
      sameCredential(this.replay.requestId, requestId) &&
      sameDigest(this.replay.credentialHash, sha256(presented))
    ) {
      return this.replay.result;
    }

    const window = this.pairing();
    if (!window) {
      // Not "no pairing is in progress" for everything, because that sentence
      // is only true of a credential we have never seen. A person retyping a
      // code that expired, or that another device already spent, is holding
      // something we know the fate of, and saying so is the difference
      // between "refresh the code" and "the app is broken".
      const spent = this.recallSpent(presented);
      if (spent?.reason === "used") {
        return {
          error: "that code has already signed a device in — open Phone settings on your computer for a new one",
          reason: "used",
        };
      }
      if (spent?.reason === "burned") {
        return {
          error: "that code was cancelled after too many wrong guesses — start pairing again on your computer",
          reason: "burned",
        };
      }
      if (spent?.reason === "expired") {
        return {
          error: "that code has expired — open Phone settings on your computer and show a new one",
          reason: "expired",
        };
      }
      return {
        error: "no pairing is in progress — open Phone settings on your computer",
        reason: "no-pairing",
      };
    }
    if (!sameCredential(window.code, presented) && !sameCredential(window.token, presented)) {
      window.attemptsLeft -= 1;
      // A burned window is the whole point: without this, six digits is a
      // few seconds of guessing. It stays burned rather than merely paused,
      // and that is the deliberate answer to "is a guessed-at code still
      // safe to accept": five wrong guesses is not a typo pattern, and the
      // cost of being wrong here is a person pressing Refresh, while the cost
      // of being wrong the other way is a stranger inside the fleet.
      if (window.attemptsLeft <= 0) {
        this.spend("burned");
        this.clearReplay();
        return { error: "too many incorrect codes — start pairing again", reason: "locked-out" };
      }
      return { error: "that pairing credential is not right", reason: "wrong" };
    }
    // After the code, not before. Checked first, a full fleet answers every
    // wrong guess with "too many paired devices" — which tells a guesser
    // something about this machine, and costs them none of their five
    // attempts. The window survives, so removing a phone and retyping the
    // same code still works.
    if (this.devices.length >= MAX_DEVICES) {
      return { error: "too many paired devices — remove one first", reason: "full" };
    }
    // Consume the window without clearing a possible replay. `closePairing`
    // is the explicit cancel operation and intentionally clears both.
    this.spend("used");

    const token = `murage_${randomBytes(32).toString("base64url")}`;
    const device: DeviceRecord = {
      id: randomUUID(),
      name: cleanDeviceName(name),
      tokenHash: sha256(token),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      cloudDesktopAccess: false,
    };
    this.devices.push(device);
    // Unlike the lastSeenAt write below, this one must not be swallowed. A
    // device that lives in memory but not on disk is paired until the next
    // restart and then silently is not — the phone keeps a token that stops
    // working for no reason it can show. Roll the registration back and say
    // so, so the user retries now rather than discovering it days later.
    try {
      this.persist();
    } catch (e) {
      this.devices.pop();
      return { error: `could not save the pairing: ${(e as Error).message}`, reason: "save-failed" };
    }
    const { tokenHash, sessions, ...pub } = device;
    const result = { device: pub, token };
    if (requestId) {
      this.replay = {
        requestId,
        credentialHash: sha256(presented),
        expiresAt: window.expiresAt,
        result,
      };
      this.replayExpiryTimer = setTimeout(
        () => this.clearReplay(),
        Math.max(0, window.expiresAt - Date.now()),
      );
      // The recovery window lasts as long as the pairing window does
      // (`PAIRING_TTL_MS`), and none of that is a reason for a deliberately
      // stopped companion process to stay alive.
      this.replayExpiryTimer.unref?.();
    }
    return result;
  }

  /** Resolve a bearer token to its device, or null. */
  authenticate(token: string | undefined): DeviceRecord | null {
    if (!token) return null;
    const hash = sha256(token);
    const device = this.devices.find((d) => sameDigest(d.tokenHash, hash));
    if (!device) return null;
    const now = Date.now();
    if (now - (this.lastSeenWrites.get(device.id) ?? 0) > LAST_SEEN_WRITE_MS) {
      device.lastSeenAt = now;
      this.lastSeenWrites.set(device.id, now);
      // lastSeenAt decorates a row in a settings panel. A full disk or a
      // read-only home is a reason for it to be stale, never a reason for an
      // already-valid token to stop authenticating — which is what letting
      // this throw would mean, on every request, for the one user least able
      // to diagnose it.
      try {
        this.persist();
      } catch {
        /* the token is still good; the timestamp can wait */
      }
    }
    return device;
  }

  /** The stable, process-local id of one session record. */
  private sessionId(session: BrowserSession): string {
    let id = this.sessionIds.get(session);
    if (!id) {
      id = randomUUID();
      this.sessionIds.set(session, id);
    }
    return id;
  }

  /** Be told when a browser session stops being an authorisation: signed out,
   * evicted by a newer sign-in, found expired, or taken with its device.
   *
   * Called only once the end is real — for sign-out, eviction and revoke that
   * means after the change is on disk. A listener that throws does not stop
   * the others. Returns the unsubscribe. */
  onSessionEnded(listener: (ended: { deviceId: string; sessionId: string }) => void): () => void {
    this.sessionEndListeners.add(listener);
    return () => {
      this.sessionEndListeners.delete(listener);
    };
  }

  private sessionsEnded(deviceId: string, ended: readonly BrowserSession[]): void {
    for (const session of ended) {
      // A session nobody ever asked the id of cannot have a stream filed
      // under it, so there is nothing to tell anyone.
      const sessionId = this.sessionIds.get(session);
      if (!sessionId) continue;
      for (const listener of this.sessionEndListeners) {
        try {
          listener({ deviceId, sessionId });
        } catch {
          /* one listener failing must not keep another session's stream open */
        }
      }
    }
  }

  /** When a live session must next be looked at again, or null when it is no
   * longer an authorisation at all.
   *
   * This is what a long-lived stream asks instead of re-presenting its cookie.
   * It follows the record, so a legitimate renewal moves the answer forward
   * and a deleted or expired record answers null — nothing here revives a row
   * or touches `lastSeenAt`, because a connection that merely stays open is
   * not evidence that anybody is using the session. */
  sessionDeadline(sessionId: string, now = Date.now()): number | null {
    for (const device of this.devices) {
      for (const session of device.sessions ?? []) {
        if (this.sessionIds.get(session) !== sessionId) continue;
        if (sessionExpired(session, now)) return null;
        // `sessionExpired` needs strictly more than the idle window, hence +1.
        return Math.min(session.expiresAt, session.lastSeenAt + SESSION_IDLE_MS + 1);
      }
    }
    return null;
  }

  /** Open a browser session against an already-paired device.
   *
   * Returns the raw cookie value, which is the only time it exists in the
   * clear: the file gets its sha256 and nothing else, exactly as with a
   * device token. The caller sets it as an `HttpOnly` cookie and never
   * echoes it into a response body — a body the page can read is a body an
   * XSS can read.
   *
   * Null when there is no such device. A session cannot outlive the device
   * it hangs off, and that is enforced by where it is stored. */
  openSession(deviceId: string, label: unknown, now = Date.now()): { value: string; session: BrowserSession } | null {
    const device = this.devices.find((candidate) => candidate.id === deviceId);
    if (!device) return null;
    const value = `murage_browser_${randomBytes(32).toString("base64url")}`;
    const session: BrowserSession = {
      hash: sha256(value),
      label: cleanDeviceName(label),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + SESSION_ABSOLUTE_MS,
    };
    const live = (device.sessions ?? []).filter((s) => !sessionExpired(s, now));
    // Oldest use first, so the cap evicts the browser nobody has opened in
    // longest rather than refusing the one in front of the person.
    live.sort((a, b) => a.lastSeenAt - b.lastSeenAt);
    const previous = device.sessions;
    device.sessions = [...live.slice(-(MAX_SESSIONS_PER_DEVICE - 1)), session];
    try {
      this.persist();
    } catch {
      // Unlike lastSeenAt, this must not be swallowed: a session that lives
      // in memory but not on disk signs the browser out at the next restart
      // for no reason it can show.
      device.sessions = previous;
      return null;
    }
    // Evicted or found expired on the way in: whatever the new list no longer
    // holds has stopped being a sign-in, and its streams go with it.
    const kept = new Set(device.sessions);
    this.sessionsEnded(device.id, (previous ?? []).filter((s) => !kept.has(s)));
    return { value, session };
  }

  /** Resolve a browser cookie to the device that owns it.
   *
   * One lookup, and no separate session store to keep consistent with the
   * device list — which is the whole reason sessions hang off `DeviceRecord`.
   * A revoked device resolves to nothing here by construction.
   *
   * Expiry is evaluated on read, both bounds: the absolute cap, and the
   * rolling idle window. `lastSeenAt` is written at most once an hour, and a
   * failed write must never fail the request. */
  resolveSession(
    value: string | undefined,
    now = Date.now(),
  ): { device: DeviceRecord; session: BrowserSession; sessionId: string } | null {
    if (!value) return null;
    const hash = sha256(value);
    for (const device of this.devices) {
      const session = device.sessions?.find((s) => sameDigest(s.hash, hash));
      if (!session) continue;
      if (sessionExpired(session, now)) {
        // Take it out on the way past. An expired row that stays is a row
        // that has to be re-judged on every later request.
        device.sessions = device.sessions?.filter((s) => s !== session);
        try {
          this.persist();
        } catch {
          /* it is already refused; the file can catch up */
        }
        // Expiry is a fact about the clock, not about the file, so its
        // streams end whether or not the write above landed.
        this.sessionsEnded(device.id, [session]);
        return null;
      }
      if (now - session.lastSeenAt > LAST_SEEN_WRITE_MS) {
        session.lastSeenAt = now;
        try {
          this.persist();
        } catch {
          /* the session is still good; the timestamp can wait */
        }
      }
      return { device, session, sessionId: this.sessionId(session) };
    }
    return null;
  }

  /** Rotate a live session's credential in place, and push its cap forward.
   *
   * Three properties, and each of them is why this is a method on the
   * registry rather than "close the old session and open a new one":
   *
   *  1. **Revocation survives renewal.** The row is mutated where it already
   *     sits, inside `device.sessions`, so the identity of the record does
   *     not change and `revoke()` still takes every session on the device
   *     with it. Minting a fresh session would have been three fewer lines
   *     and would have made revocation defeatable by anyone able to renew —
   *     which, since renewal is the one thing a browser does automatically,
   *     means defeatable by the browser being revoked.
   *  2. **The old value dies.** One hash per row, overwritten. A renewal that
   *     left the previous cookie working would turn every rotation into an
   *     extra live credential.
   *  3. **`createdAt` is never rewritten.** It is the anchor the ceiling in
   *     `SESSION_MAX_LIFETIME_MS` is measured from, and the only reason that
   *     ceiling is a wall rather than a suggestion.
   *
   * Fails CLOSED, and silently: an unknown, expired or unpersistable session
   * returns `null` having changed nothing at all. The caller's contract is
   * that a failed renewal leaves the browser exactly as signed in as it was —
   * never signed out early, never shown an error. */
  renewSession(
    value: string | undefined,
    now = Date.now(),
  ): { value: string; session: BrowserSession } | null {
    if (!value) return null;
    const hash = sha256(value);
    for (const device of this.devices) {
      const session = device.sessions?.find((s) => sameDigest(s.hash, hash));
      if (!session) continue;
      // Not reaped here, deliberately. `resolveSession` owns taking a dead
      // row out; renewal's only job on failure is to change nothing.
      if (sessionExpired(session, now)) return null;

      const next = `murage_browser_${randomBytes(32).toString("base64url")}`;
      const previous = { hash: session.hash, lastSeenAt: session.lastSeenAt, expiresAt: session.expiresAt };
      session.hash = sha256(next);
      session.lastSeenAt = now;
      // Monotonic without needing a guard: `expiresAt` was itself set to at
      // most (some earlier now) + SESSION_ABSOLUTE_MS, so it can never be
      // above `now + SESSION_ABSOLUTE_MS`, and the ceiling term is fixed.
      session.expiresAt = Math.min(now + SESSION_ABSOLUTE_MS, session.createdAt + SESSION_MAX_LIFETIME_MS);
      try {
        this.persist();
      } catch {
        // The rotation only counts if it is on disk. A hash that lives in
        // memory and not in the file signs this browser out at the next
        // restart — the exact silent logout renewal exists to prevent — so
        // put the row back and let the caller keep the cookie it has.
        session.hash = previous.hash;
        session.lastSeenAt = previous.lastSeenAt;
        session.expiresAt = previous.expiresAt;
        return null;
      }
      return { value: next, session };
    }
    return null;
  }

  /** Sign one browser out. Other browsers on the same device survive, which
   * is the difference between this and `revoke`. */
  closeSession(value: string | undefined): boolean {
    if (!value) return false;
    const hash = sha256(value);
    for (const device of this.devices) {
      const before = device.sessions?.length ?? 0;
      if (!before) continue;
      const kept = device.sessions!.filter((s) => !sameDigest(s.hash, hash));
      if (kept.length === before) continue;
      const ended = device.sessions!.filter((s) => !kept.includes(s));
      device.sessions = kept.length ? kept : undefined;
      this.persist();
      this.sessionsEnded(device.id, ended);
      return true;
    }
    return false;
  }

  /** Take a phone's access away. False when there was no such device — a
   * revoke that quietly matched nothing would read as success on the page. */
  revoke(id: string): boolean {
    const removed = this.devices.find((d) => d.id === id);
    if (!removed) return false;
    this.devices = this.devices.filter((d) => d !== removed);
    this.lastSeenWrites.delete(id);
    this.persist();
    this.sessionsEnded(id, removed.sessions ?? []);
    return true;
  }

  /** Grant or remove the one capability that crosses from companion actions
   * into full desktop control. This is per device so a watch-only phone does
   * not inherit a different phone's permission. */
  setCloudDesktopAccess(id: string, allowed: boolean): boolean {
    const device = this.devices.find((candidate) => candidate.id === id);
    if (!device) return false;
    const previous = device.cloudDesktopAccess;
    device.cloudDesktopAccess = allowed;
    try {
      this.persist();
    } catch (error) {
      device.cloudDesktopAccess = previous;
      throw error;
    }
    return true;
  }
}

/**
 * Pull the bearer token out of an Authorization header.
 *
 * The scheme is matched case-insensitively because RFC 7235 §2.1 says it is:
 * a client sending `bearer <token>` is within its rights. This used to
 * require the exact casing while the proxy had a second, laxer parser of its
 * own — so which of the two a request happened to meet decided whether it
 * authenticated, and a phone got a 401 it could not explain. One function,
 * used everywhere a token is read. A header with nothing after the scheme is
 * `undefined` rather than the empty string, so no caller has to decide
 * whether "" counts as a credential.
 */
export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() || undefined : undefined;
}
