// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Cloud home door, browser side (server/cloud-request-auth.ts "/api/cloud/enter"). This browser keeps its own pair of device keys in
// IndexedDB (non-extractable private halves). A one-time ticket is minted for the hash of the session key and spent with a proof signed by it.

import { cloudCopy } from "./cloud-copy";
import { desktopCallerHeaders } from "./live-events";

export const doorCopy = {
  opening: "Opening your Murage home",
  expired: "This link has expired. Go back to murage.ai and press Open Murage again.",
  tooManyTries: "Too many tries. Wait a few minutes, then press Open Murage again.",
  tooManyBrowsers: "This home already has ten browsers connected. Remove one on your Murage Cloud page under Devices, then press Open Murage again.",
  computerConnected: "This home already has a computer connected. Use Murage on that computer, or open Murage in your browser.",
  badLink: "Murage could not open from this link. Press Open Murage again from murage.ai.",
  openFromSite: "Open Murage from murage.ai to connect this browser.",
  storage: "This browser cannot keep a sign-in. Allow site data for this address, or open Murage in another browser.",
  goButton: "Go to murage.ai",
  tabOpen: cloudCopy.doorTabOpen,
  tryAgain: cloudCopy.doorTryAgain,
} as const;

/** The path of the site's first-open page; the site mints a ticket on a button press there. */
export const SITE_OPEN_PATH = "/home/cloud/open";

/** The ticket in `#t=<payload>.<signature>`; anything else is not a ticket. */
export function ticketFromHash(hash: string): string | null {
  const value = /^#t=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(hash)?.[1];
  return value && value.length <= 8300 ? value : null;
}
export { homeMeta } from "./cloud-home-meta";

export const b64url = (bytes: ArrayBuffer | Uint8Array): string => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let text = ""; for (const byte of view) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
export const fromB64url = (value: string): Uint8Array => {
  const text = atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
  return Uint8Array.from(text, ch => ch.charCodeAt(0));
};
export function spkiToPem(spki: ArrayBuffer | Uint8Array): string {
  const body = btoa(String.fromCharCode(...(spki instanceof Uint8Array ? spki : new Uint8Array(spki)))).replace(/(.{64})/g, "$1\n").replace(/\n$/, "");
  return `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----\n`;
}
/** Messages the home verifies (server/cloud-sessions.ts). */
export const refreshMessage = (environmentId: string, deviceId: string, challenge: string, at: number) => `murage:${environmentId}:${deviceId}:refresh:${challenge}:${at}`;

// ── Problem reports ───────────────────────────────────────────────────────────────────────────────────────────────────────
/** The page's steps that can fail (server/cloud-home/door-log.ts DOOR_PAGE_STAGES; the home maps anything else to "unknown"). */
export type DoorStage = "no_ticket" | "device_load" | "device_save" | "device_forget" | "refresh" | "bounce" | "v1_record" | "unexpected";
const ERROR_NAMES = new Set(["NotAllowedError", "AbortError", "InvalidStateError", "SecurityError", "NotSupportedError", "ConstraintError", "UnknownError",
  "DataError", "QuotaExceededError", "TimeoutError", "TypeError", "NetworkError", "OperationError", "VersionError", "ReadOnlyError", "SyntaxError"]);
/** Only an error's name ever leaves the page, and only a known one: never its message, a key, the ticket or an id. */
export function doorErrorName(error: unknown): string {
  if (error === undefined) return "none";
  const name = error && typeof error === "object" && "name" in error ? (error as { name: unknown }).name : undefined;
  return typeof name === "string" && ERROR_NAMES.has(name) ? name : "unknown";
}
/** Answered by the Cloud home's request gate (server/cloud-request-auth.ts), not by the route dispatcher, so it has no route-policy entry. */
const DOOR_REPORT_PATH = "/api/cloud/enter/report";
/** Answered by the Cloud home's request gate (server/cloud-request-auth.ts) before route policy, like the report route. */
const DEVICES_PATH = "/api/cloud/devices";
/** Tells the home which step went wrong so it lands in the home's log as one fixed line. Never throws, never waits. */
export function reportDoorProblem(stage: DoorStage, error?: unknown): void {
  sendReport({ stage, error: doorErrorName(error) });
}
/** Why the key store did not open (server/cloud-home/door-log.ts DOOR_OPEN_CAUSES). */
export type DoorOpenCause = "timeout" | "blocked" | "error";
/** A coarse browser family from the user agent (DOOR_BROWSERS): never the version, platform or the agent string itself. */
export function doorBrowser(userAgent: unknown): "chrome" | "safari" | "firefox" | "edge" | "other" {
  if (typeof userAgent !== "string") return "other";
  if (/\bEdg(?:e|A|iOS)?\//.test(userAgent)) return "edge";
  if (/\b(?:Firefox|FxiOS)\//.test(userAgent)) return "firefox";
  if (/\b(?:Chrome|Chromium|CriOS)\//.test(userAgent)) return "chrome";
  if (/\bSafari\//.test(userAgent)) return "safari";
  return "other";
}
/** Reports an IndexedDB open that did not finish, with its cause and the browser family. Never throws, never waits. */
export function reportDeviceOpen(cause: DoorOpenCause): void {
  let browser: ReturnType<typeof doorBrowser> = "other";
  try { browser = doorBrowser(navigator.userAgent); } catch { /* no navigator: "other" */ }
  sendReport({ stage: "device_open", cause, browser });
}
function sendReport(body: Record<string, string>): void {
  try {
    void fetch(DOOR_REPORT_PATH, { method: "POST", credentials: "same-origin", redirect: "error", keepalive: true, headers: { ...desktopCallerHeaders(), "content-type": "application/json" },
      body: JSON.stringify(body) }).catch(() => { /* the report is best effort; the page already shows what happened */ });
  } catch { /* fetch unavailable: nothing more to tell */ }
}

// ── IndexedDB device store ───────────────────────────────────────────────────────────────────────────────────────────────
export interface StoredDevice { deviceId: string | null; privateKey: CryptoKey; publicKey: CryptoKey; assertionPrivateKey: CryptoKey; assertionPublicKey: CryptoKey }
/** This browser cannot keep its keys (private window, blocked site data, a key store that never answers); nothing was sent to the network. */
export class StorageRefused extends Error { constructor() { super("storage refused"); this.name = "StorageRefused"; } }
/** Another tab of this home holds the key store open (IndexedDB "blocked"); closing it and trying again fixes it. */
export class StorageBlocked extends StorageRefused { constructor() { super(); this.name = "StorageBlocked"; } }
const DB = "murage-door", STORE = "device", KEY = "this-home";
/** Every IndexedDB step (an open, a transaction) settles within this many milliseconds. Tests shorten it. */
export const doorStorageTiming = { stepMs: 5000 };
class OpenFailed extends Error {
  constructor(readonly reason: DoorOpenCause, readonly source?: unknown) { super("key store did not open"); this.name = "OpenFailed"; }
}
function openOnce(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fail = (reason: DoorOpenCause, source?: unknown) => { if (settled) return; settled = true; clearTimeout(timer); reject(new OpenFailed(reason, source)); };
    let request: IDBOpenDBRequest;
    try { request = indexedDB.open(DB, 1); } catch (error) { fail("error", error); return; }
    timer = setTimeout(() => fail("timeout"), doorStorageTiming.stepMs);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => {
      const db = request.result;
      // An open that lands after the timeout or a block is closed at once, so it never holds the store against the next try or another tab.
      if (settled) { db.close(); return; }
      settled = true; clearTimeout(timer);
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => fail("error", request.error);
    request.onblocked = () => fail("blocked");
  });
}
/** Opens the key store, bounded: a timeout or a block is reported and tried once more; a second failure throws StorageRefused (StorageBlocked when blocked). */
async function open(): Promise<IDBDatabase> {
  try { return await openOnce(); } catch (first) {
    const reason = first instanceof OpenFailed ? first.reason : "error";
    reportDeviceOpen(reason);
    if (reason === "error") throw first instanceof OpenFailed && first.source !== undefined ? first.source : first;
    try { return await openOnce(); } catch (second) {
      const again = second instanceof OpenFailed ? second.reason : "error";
      reportDeviceOpen(again);
      throw again === "blocked" ? new StorageBlocked() : new StorageRefused();
    }
  }
}
/** Runs one transaction on `db`, settled within doorStorageTiming.stepMs (a TimeoutError otherwise), then closes `db`. */
function step<T>(db: IDBDatabase, work: (done: (value: T) => void, fail: (error: unknown) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const end = <V>(fn: (value: V) => void) => (value: V) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
    const timer = setTimeout(end(reject), doorStorageTiming.stepMs, new DOMException("key store step timed out", "TimeoutError"));
    try { work(end(resolve), end(reject)); } catch (error) { end(reject)(error); }
  }).finally(() => { try { db.close(); } catch { /* already closed */ } });
}
/** The raw stored record (a v1 record has no assertion pair), or null. Throws StorageRefused when the store does not open or does not answer. */
export async function loadDevice(): Promise<Partial<StoredDevice> | null> {
  try {
    const db = await open();
    return await step<Partial<StoredDevice> | null>(db, done => {
      const tx = db.transaction(STORE), get = tx.objectStore(STORE).get(KEY);
      get.onsuccess = () => done((get.result as Partial<StoredDevice> | undefined) ?? null);
      get.onerror = () => { reportDoorProblem("device_load", get.error ?? undefined); done(null); };
      tx.onabort = () => { reportDoorProblem("device_load", tx.error ?? undefined); done(null); };
    });
  } catch (error) {
    if (error instanceof StorageRefused) throw error;
    reportDoorProblem("device_load", error);
    // A store that does not answer is not an empty one: making new keys over the stored ones would drop this browser's sign-in.
    if (doorErrorName(error) === "TimeoutError") throw new StorageRefused();
    return null;
  }
}
export async function saveDevice(device: StoredDevice): Promise<void> {
  const db = await open();
  await step<void>(db, (done, fail) => { const tx = db.transaction(STORE, "readwrite"); tx.objectStore(STORE).put(device, KEY); tx.oncomplete = () => done(); tx.onerror = () => fail(tx.error); tx.onabort = () => fail(tx.error); });
}
/** Drops the local record. A store that does not open throws StorageRefused; any other failure is reported and ignored. */
export async function forgetDevice(): Promise<void> {
  try {
    const db = await open();
    await step<void>(db, done => {
      const tx = db.transaction(STORE, "readwrite"); tx.objectStore(STORE).delete(KEY); tx.oncomplete = () => done();
      tx.onerror = () => { reportDoorProblem("device_forget", tx.error ?? undefined); done(); };
      tx.onabort = () => { reportDoorProblem("device_forget", tx.error ?? undefined); done(); };
    });
  } catch (error) { if (error instanceof StorageRefused) throw error; reportDoorProblem("device_forget", error); }
}

const isComplete = (d: Partial<StoredDevice> | null): d is StoredDevice => !!d && !!d.privateKey && !!d.publicKey && !!d.assertionPrivateKey && !!d.assertionPublicKey;
async function generatePair(): Promise<{ privateKey: CryptoKey; publicKey: CryptoKey }> {
  // extractable=false makes the private half non-extractable; WebCrypto still lets the public half be exported.
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return { privateKey: pair.privateKey, publicKey: pair.publicKey };
}
/** Loads this browser's keys, or makes both pairs and stores them before returning. A v1 record is replaced. Throws StorageRefused. */
export async function ensureDevice(): Promise<StoredDevice> {
  const existing = await loadDevice();
  if (isComplete(existing)) return existing;
  if (existing) { await forgetDevice(); reportDoorProblem("v1_record"); }
  const session = await generatePair(), assertion = await generatePair();
  const device: StoredDevice = { deviceId: null, privateKey: session.privateKey, publicKey: session.publicKey, assertionPrivateKey: assertion.privateKey, assertionPublicKey: assertion.publicKey };
  try { await saveDevice(device); } catch (error) {
    if (error instanceof StorageRefused) throw error;
    reportDoorProblem("device_save", error); throw new StorageRefused();
  }
  return device;
}
/** Lowercase hex sha256 of the SPKI DER of the session public key: what a ticket is minted for. */
export async function bindOf(device: Pick<StoredDevice, "publicKey">): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await crypto.subtle.exportKey("spki", device.publicKey)));
  return [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
/** `<site>/home/cloud/open?home=<id>&auto=1&k=<bind>`, or null unless the site origin is a bare https origin, the id is plain and bind is 64 hex. */
export function bounceUrl(siteOrigin: string | null | undefined, homeId: string | null | undefined, bind: string | null | undefined): string | null {
  if (!siteOrigin || !homeId || !bind || !/^[A-Za-z0-9_-]{1,128}$/.test(homeId) || !/^[0-9a-f]{64}$/.test(bind)) return null;
  try {
    const site = new URL(siteOrigin);
    if (site.protocol !== "https:" || site.origin !== siteOrigin || site.username || site.password) return null;
    // auto=1 (design 2.1): the site mints the link for this key without a second press.
    return `${site.origin}${SITE_OPEN_PATH}?home=${encodeURIComponent(homeId)}&auto=1&k=${bind}`;
  } catch { return null; }
}

/** A door request that does not answer within this many milliseconds is aborted (an AbortError), so the page never waits on it forever. */
export const DOOR_REQUEST_MS = 15_000;
async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new DOMException("door request timed out", "AbortError")), DOOR_REQUEST_MS);
  try {
    const res = await fetch(path, { method: "POST", credentials: "same-origin", redirect: "error", headers: { ...desktopCallerHeaders(), "content-type": "application/json" }, body: JSON.stringify(body), signal: abort.signal });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } finally { clearTimeout(timer); }
}
const sign = async (key: CryptoKey, message: string) => b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(message)));
const pemOf = async (key: CryptoKey) => spkiToPem(await crypto.subtle.exportKey("spki", key));

/** Signs in with this browser's own session key (the existing challenge and refresh routes). False when there is no stored deviceId or the home refuses.
 *  A 403 from the challenge or the refresh clears only the stored deviceId: the keys stay so the bounce can re-enroll them. Any other failure keeps everything. */
export async function refreshSession(): Promise<boolean> {
  const device = await loadDevice();
  if (!isComplete(device) || !device.deviceId) return false;
  const deviceId = device.deviceId;
  const clearId = async () => { try { await saveDevice({ ...device, deviceId: null }); } catch (error) { reportDoorProblem("device_save", error); } };
  const challenge = await post("/api/cloud/challenge", { deviceId });
  if (challenge.status === 403) { await clearId(); return false; }
  if (challenge.status !== 200) return false;
  const at = Date.now() - 2000;
  const signature = await sign(device.privateKey, refreshMessage(challenge.body.environmentId, deviceId, challenge.body.challenge, at));
  const refreshed = await post("/api/cloud/refresh", { deviceId, challenge: challenge.body.challenge, at, signature });
  if (refreshed.status === 200) return true;
  if (refreshed.status === 403) await clearId();
  return false;
}

export type EnterResult = "signed-in" | "expired" | "too-many" | "hold" | "failed";
/** The remembered-owner state the last successful enter answered: whether this browser is now an owner browser and, for a
 *  remembered-owner factor, when it expires. The device list UI reads it; a stolen cookie never sets it (no enter). */
let lastOwner: { owner: boolean; ownerUntil?: number } = { owner: false };
export const enteredOwnerState = (): { owner: boolean; ownerUntil?: number } => lastOwner;
/** Spends the ticket with this browser's keys: a proof signed by the session key, and (§4.2) an assertionProof signed by the
 *  assertion key, both over this ticket. Stores the deviceId the home answers and records the owner state it reports. */
export async function enterWithTicket(ticket: string): Promise<EnterResult> {
  const device = await ensureDevice();
  const proof = await sign(device.privateKey, `murage-door-v2:${ticket}`);
  const assertionProof = await sign(device.assertionPrivateKey, `murage-door-v2-assertion:${ticket}`);
  const entered = await post("/api/cloud/enter", { ticket, device: { deviceId: device.deviceId, publicKey: await pemOf(device.publicKey), assertionKey: await pemOf(device.assertionPublicKey), proof, assertionProof } });
  if (entered.status === 429) return "expired";
  if (entered.status === 403) {
    const reason = entered.body?.reason;
    return reason === "too_many_devices" ? "too-many" : reason === "hold_required" ? "hold" : reason === "expired" ? "expired" : "failed";
  }
  if (entered.status !== 200 || entered.body?.state !== "signed-in" || typeof entered.body.deviceId !== "string") return "failed";
  lastOwner = { owner: entered.body?.owner === true, ...(typeof entered.body?.ownerUntil === "number" ? { ownerUntil: entered.body.ownerUntil } : {}) };
  try { await saveDevice({ ...device, deviceId: entered.body.deviceId }); } catch (error) { reportDoorProblem("device_save", error); throw error; }
  return "signed-in";
}

export interface HomeDevice { id: string; scope: string; addedAt: number | string | null; lastSeenAt: number | string | null; keyHash: string;
  /** The LIVE owner factor this device carries (server/cloud-sessions.ts listDevices): "remembered-owner" is an owner until
   *  `factorExpiresAt`; another non-empty value is an owner with no expiry; null or false is chat only. Older homes omit it. */
  factor?: "remembered-owner" | (string & {}) | false | null; factorExpiresAt?: number | null }
export async function listDevices(): Promise<{ devices: HomeDevice[]; self: string | null } | null> {
  try {
    const res = await fetch(DEVICES_PATH, { credentials: "same-origin", redirect: "error", headers: desktopCallerHeaders() });
    if (!res.ok) return null;
    const body = await res.json();
    return Array.isArray(body.devices) ? { devices: body.devices, self: typeof body.self === "string" ? body.self : null } : null;
  } catch { return null; }
}
/** Revokes this browser at the home (clears the cookie), then drops the whole local record. */
export async function forgetThisBrowser(): Promise<boolean> {
  try {
    const res = await post("/api/cloud/devices/forget", {});
    if (res.status !== 200) return false;
    await forgetDevice();
    return true;
  } catch (error) { reportDoorProblem("device_forget", error); return false; }
}
/** "Make this browser chat-only": drops just the owner factor on `deviceId` by posting the home's own owner-factor revoke
 *  (server/cloud-request-auth.ts POST /api/cloud/devices/:id/owner/revoke -> revokeOwnerFactor, which runs the revoke and the
 *  watermark in one transaction). The device stays connected for chat. True only when the home answers 200. */
export async function makeChatOnly(deviceId: string): Promise<boolean> {
  try {
    const res = await post(`${DEVICES_PATH}/${encodeURIComponent(deviceId)}/owner/revoke`, {});
    return res.status === 200;
  } catch { return false; }
}
