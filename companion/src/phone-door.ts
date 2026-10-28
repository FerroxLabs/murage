// The door's phone-jobs bootstrap (plan S3, design §4.2): a phone that holds a
// paired approval key asks for a nonce, signs it, and trades the signature for
// a phone-jobs bearer. Nothing here reads or sets a cookie, and nothing here
// touches the harness except the offered() question the caller supplies.
import { createPublicKey, verify } from "node:crypto";
import { bearerToken } from "./devices.ts";
import type { HarnessCall, HarnessStreamCall } from "./push-door.ts";
import { approvalKeyId, PHONE_TOKEN, phoneJobsMessage } from "./phone-jobs-shape.ts";
import { PHONE_ASK_TOKEN, phoneAskMessage } from "./phone-ask-shape.ts";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const CHALLENGE = "/api/phones/self/challenge";
const TOKEN = "/api/phones/self/token";
const SELF_PREFIX = "/api/phones/self";

/** Exactly the two bootstrap routes. Method and path are compared as given:
 * no case folding, no trailing slash, no query (the caller passes the path). */
export function phoneBootstrapExempt(method: string, path: string): boolean {
  return (method === "GET" && path === CHALLENGE) || (method === "POST" && path === TOKEN);
}

/** True for anything that is, or could be decoded or normalised into, a path
 * under /api/phones/self. Deliberately wide: whatever this matches and
 * phoneBootstrapExempt does not is refused at the door. */
export function isPhoneSelfPath(path: string): boolean {
  const raw = [path];
  try { raw.push(decodeURIComponent(path)); } catch { return true; }
  const variants: string[] = [];
  for (const v of raw) {
    const collapsed = v.toLowerCase().replace(/[\\/]+/g, "/");
    variants.push(collapsed);
    // Resolve "." and ".." segments the way a URL parser downstream would.
    try { variants.push(new URL(collapsed, "http://door").pathname.toLowerCase()); } catch { return true; }
  }
  return variants.some((v) => v.startsWith(SELF_PREFIX));
}

const TOTAL_LIMIT = 256;
const PER_KEY_LIMIT = 32;
const PER_SOURCE_LIMIT = 32;
export const CHALLENGE_TTL_MS = 60_000;

interface Held { keyId: string; source: string; expiresAt: number }

export class PhoneChallenges {
  private readonly held = new Map<string, Held>();
  private readonly deps: { now(): number; random(): string };
  constructor(deps: { now(): number; random(): string }) { this.deps = deps; }

  private prune(now: number): void {
    for (const [nonce, h] of this.held) if (h.expiresAt <= now) this.held.delete(nonce);
  }

  issue(keyId: string, source: string): { nonce: string; expiresAt: number } | "limited" {
    const now = this.deps.now();
    this.prune(now);
    let perKey = 0;
    let perSource = 0;
    for (const h of this.held.values()) {
      if (h.keyId === keyId) perKey++;
      if (h.source === source) perSource++;
    }
    if (this.held.size >= TOTAL_LIMIT || perKey >= PER_KEY_LIMIT || perSource >= PER_SOURCE_LIMIT) return "limited";
    const nonce = this.deps.random();
    if (this.held.has(nonce)) return "limited";
    const expiresAt = now + CHALLENGE_TTL_MS;
    this.held.set(nonce, { keyId, source, expiresAt });
    return { nonce, expiresAt };
  }

  /** Removes the nonce first, whatever follows. An expired one is gone too and answers null. */
  take(nonce: string): { keyId: string; expiresAt: number } | null {
    const h = this.held.get(nonce);
    if (!h) return null;
    this.held.delete(nonce);
    return h.expiresAt > this.deps.now() ? { keyId: h.keyId, expiresAt: h.expiresAt } : null;
  }
}

export interface PhoneDoorDevices {
  deviceByApprovalKeyId(keyId: string): { ok: true; deviceId: string; point: string } | { ok: false; reason: string };
  issuePhoneJobsToken(deviceId: string): string | null;
  /** S5b: the device record still holds this token (a fresh mint is only answered while it does). */
  authenticatePhoneJobs?(token: string | undefined): { deviceId: string } | null;
  /** S5b: drops the device's token when the harness barrier could not be cleared. With `onlyToken`, only while the device still holds that token. */
  clearPhoneJobsToken?(deviceId: string, onlyToken?: string): boolean;
  /** S26: the same four questions for the share-and-ask bearer. Null from issue means no token (unknown device, or switched off). */
  issuePhoneAskToken?(deviceId: string): { token: string; generation: number } | null;
  authenticatePhoneAsk?(token: string | undefined): { deviceId: string; generation: number } | null;
  /** Drops only the ask token (no generation spent), and only while the device still holds `onlyToken` when given. */
  clearPhoneAskToken?(deviceId: string, onlyToken?: string): boolean;
}

export const MINTED_DEADLINE_MS = 8_000;

/** S5b (Astra AS2): after a fresh mint, ask the harness to clear the device's revocation barrier.
 * "ok" only for a 200 answer carrying `ok: true`; "not-offered" for a 404; anything else, a throw or
 * the deadline is "failed". Same call pattern as phoneHarnessRevoke (launch proof, companion headers). */
export async function phoneHarnessMinted(harness: HarnessCall, launchProof: string | undefined, deviceId: string, deadlineMs = MINTED_DEADLINE_MS, scope: "jobs" | "ask" = "jobs"): Promise<"ok" | "not-offered" | "failed"> {
  if (typeof launchProof !== "string" || !/^[a-f0-9]{64}$/.test(launchProof)) return "failed";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = await Promise.race([
      harness({
        method: "POST",
        path: "/api/phones/minted",
        headers: { accept: "application/json", "content-type": "application/json", "x-murage-companion": "1", "x-murage-companion-token": launchProof },
        // The jobs body is unchanged; an ask mint says so, so the harness does not treat it as a jobs enrolment.
        body: Buffer.from(JSON.stringify(scope === "ask" ? { deviceId, scope } : { deviceId })),
      }),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), deadlineMs); }),
    ]);
    if (!answer) return "failed";
    if (answer.status === 404) return "not-offered";
    return answer.status === 200 && (answer.body as { ok?: unknown } | null)?.ok === true ? "ok" : "failed";
  } catch { return "failed"; } finally { if (timer) clearTimeout(timer); }
}

const KEY_ID = /^[A-Za-z0-9_-]{43}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{16,200}$/;

/** ECDSA P-256 over SHA-256, ASN.1 DER, base64url. High-S accepted, raw r||s refused (it is not DER). */
export function verifyPhoneJobsSignature(point: string, message: string, signature: string): boolean {
  try {
    if (approvalKeyId(point) === null || typeof signature !== "string" || !SIGNATURE.test(signature)) return false;
    const raw = Buffer.from(point, "base64url");
    const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33).toString("base64url") }, format: "jwk" });
    return verify("sha256", Buffer.from(message, "utf8"), { key, dsaEncoding: "der" }, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

/** One body for every refusal that is about who the caller is, so a probe cannot tell a wrong key from a wrong signature. */
const REFUSED = { error: "phone sign-in refused" };
const refused = () => ({ status: 403, body: { ...REFUSED } });

export async function handlePhoneBootstrap(
  req: { method: string; path: string; query: URLSearchParams; body: Buffer | null; source: string; origin: string },
  o: { devices: PhoneDoorDevices; challenges: PhoneChallenges; offered(): Promise<boolean>; offeredAsk?(): Promise<boolean>; harness?: HarnessCall; doorToken?: string; mintedDeadlineMs?: number },
): Promise<{ status: number; body: unknown }> {
  if (!phoneBootstrapExempt(req.method, req.path)) return { status: 404, body: { error: "no such route" } };
  // The two bootstrap routes serve either family. A family that is not offered answers 404; with neither offered so does the challenge.
  let offered = false;
  try { offered = await o.offered(); } catch { offered = false; }
  let askOffered = false;
  try { askOffered = o.offeredAsk ? await o.offeredAsk() : false; } catch { askOffered = false; }
  if (!offered && !askOffered) return { status: 404, body: { error: "no such route" } };

  if (req.method === "GET") {
    // Only `key`, and only exactly one of it. `device` and every other field are ignored.
    const keys = req.query.getAll("key");
    if (keys.length !== 1 || !KEY_ID.test(keys[0])) return refused();
    const found = o.devices.deviceByApprovalKeyId(keys[0]);
    if (!found.ok) return refused();
    const issued = o.challenges.issue(keys[0], req.source);
    if (issued === "limited") return { status: 429, body: { error: "too many sign-in attempts" } };
    return { status: 200, body: issued };
  }

  let parsed: unknown;
  try { parsed = req.body ? JSON.parse(req.body.toString("utf8")) : null; } catch { parsed = null; }
  const b = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  // The nonce goes first, even when the rest of the body is wrong.
  const held = b && typeof b.nonce === "string" ? o.challenges.take(b.nonce) : null;
  // `scope` is optional (default "jobs"); only "jobs" and "ask" exist, and no other key is allowed.
  const keys = b ? Object.keys(b).sort().join(",") : "";
  const scoped = keys === "expiresAt,keyId,nonce,scope,signature";
  const exact = b !== null && (scoped || keys === "expiresAt,keyId,nonce,signature");
  const scope = scoped ? (b as Record<string, unknown>).scope : "jobs";
  if (!b || !exact || (scope !== "jobs" && scope !== "ask") || typeof b.keyId !== "string" || typeof b.nonce !== "string" || typeof b.signature !== "string" || !Number.isSafeInteger(b.expiresAt)) {
    return { status: 400, body: { error: "bad request" } };
  }
  if (scope === "ask" ? !askOffered : !offered) return { status: 404, body: { error: "no such route" } };
  if (!held || held.keyId !== b.keyId || held.expiresAt !== b.expiresAt) return refused();
  const found = o.devices.deviceByApprovalKeyId(b.keyId);
  if (!found.ok || !req.origin) return refused();
  // The tag binds the purpose: a jobs signature never verifies as an ask mint and the reverse.
  const fields = { origin: req.origin, keyId: b.keyId, nonce: b.nonce, expiresAt: b.expiresAt as number };
  const message = scope === "ask" ? phoneAskMessage(fields) : phoneJobsMessage(fields);
  if (!verifyPhoneJobsSignature(found.point, message, b.signature)) return refused();
  const ask = scope === "ask";
  let token: string | null;
  try {
    if (ask) {
      if (!o.devices.issuePhoneAskToken) return refused();
      token = o.devices.issuePhoneAskToken(found.deviceId)?.token ?? null;
    } else token = o.devices.issuePhoneJobsToken(found.deviceId);
  } catch { return { status: 500, body: { error: "Could not sign this phone in on the computer. Try again." } }; }
  if (!token) return refused();
  // S5b: the new token is only answered once the harness has cleared the device's barrier. Every
  // other end clears THIS request's token, and only while the device still holds it: a retried bootstrap's newer token survives.
  const unavailable = () => {
    try { (ask ? o.devices.clearPhoneAskToken : o.devices.clearPhoneJobsToken)?.(found.deviceId, token); } catch { /* the barrier still refuses it */ }
  };
  const clearFn = ask ? o.devices.clearPhoneAskToken : o.devices.clearPhoneJobsToken;
  const authFn = ask ? o.devices.authenticatePhoneAsk : o.devices.authenticatePhoneJobs;
  if (!o.harness || !clearFn || !authFn) {
    unavailable();
    return { status: 503, body: { error: "unavailable" } };
  }
  const minted = await phoneHarnessMinted(o.harness, o.doorToken, found.deviceId, o.mintedDeadlineMs, ask ? "ask" : "jobs");
  if (minted !== "ok") {
    unavailable();
    return minted === "not-offered" ? { status: 403, body: { ...REFUSED } } : { status: 503, body: { error: "unavailable" } };
  }
  let still: { deviceId: string } | null = null;
  try { still = authFn.call(o.devices, token); } catch { still = null; }
  if (!still || still.deviceId !== found.deviceId) {
    unavailable();
    return { status: 503, body: { error: "unavailable" } };
  }
  return { status: 200, body: { token } };
}

// ── bearer job routes (plan S4, Grok G2) ─────────────────────────────────
//
// An EXACT allowlist of method + path. There is no shape match: a path that is
// not spelled here (case, trailing slash, encoding, an unknown operation id)
// is not a phone job route and is refused at the door.
const UUID_V4 = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const JOB_ROUTES: { method: string; path: RegExp; maxBody: number; long?: boolean }[] = [
  { method: "PUT", path: /^\/api\/phones\/self$/, maxBody: 8 * 1024 },
  { method: "DELETE", path: /^\/api\/phones\/self$/, maxBody: 0 },
  { method: "GET", path: /^\/api\/phones\/self\/jobs$/, maxBody: 0, long: true },
  { method: "GET", path: new RegExp(`^/api/phones/self/jobs/${UUID_V4}$`), maxBody: 0 },
  { method: "POST", path: new RegExp(`^/api/phones/self/jobs/${UUID_V4}/lease$`), maxBody: 8 * 1024 },
  { method: "POST", path: new RegExp(`^/api/phones/self/jobs/${UUID_V4}/decline$`), maxBody: 8 * 1024 },
  { method: "POST", path: new RegExp(`^/api/phones/self/jobs/${UUID_V4}/result$`), maxBody: 300 * 1024 },
  { method: "POST", path: /^\/api\/phones\/self\/foreground$/, maxBody: 8 * 1024 },
];

/** The listed bearer job route this request is, or null. Bootstrap routes are not in it. */
export function phoneJobRoute(method: string, path: string): { maxBody: number; long: boolean } | null {
  const hit = JOB_ROUTES.find((r) => r.method === method && r.path.test(path));
  return hit ? { maxBody: hit.maxBody, long: hit.long === true } : null;
}
export function phoneSelfRoute(method: string, path: string): boolean {
  return phoneJobRoute(method, path) !== null;
}

/** Gate exemption: a listed job route AND a bearer of the murage_pj_ shape. Shape only (no registry
 * read); the door verifies the bearer against the registry before it reads a byte of body. */
export function phoneBearerExempt(method: string, path: string, authorization: string | undefined): boolean {
  const token = bearerToken(authorization);
  return phoneSelfRoute(method, path) && token !== undefined && PHONE_TOKEN.test(token);
}

/** The only identity the harness gets: the device the bearer proved, never anything the request says. */
export function phoneForwardHeaders(deviceId: string, doorToken: string): Record<string, string> {
  return { "x-murage-door-token": doorToken, "x-murage-phone-device": deviceId, "x-murage-phone-scope": "jobs", accept: "application/json" };
}

export interface PhoneBearerDevices {
  authenticatePhoneJobs(token: string | undefined): { deviceId: string } | null;
  /** Drops the device's token. Optional so a store without it cannot switch off (the route then answers 500). */
  clearPhoneJobsToken?(deviceId: string): boolean;
}

/** Revoke order (plan S5): the harness job map goes first, the door token second. This is the harness
 * half: POST /api/phones/revoke with the launch proof. True only for a 200 whose body carries
 * `revoked` as a number (0 is fine: a retry finds nothing left). Anything else is "not done". */
export async function phoneHarnessRevoke(harness: HarnessCall, launchProof: string | undefined, deviceId: string, reason: "removed" | "switch-off"): Promise<boolean> {
  if (typeof launchProof !== "string" || !/^[a-f0-9]{64}$/.test(launchProof)) return false;
  let answer: { status: number; body: unknown };
  try {
    answer = await harness({
      method: "POST",
      path: "/api/phones/revoke",
      headers: { accept: "application/json", "content-type": "application/json", "x-murage-companion": "1", "x-murage-companion-token": launchProof },
      body: Buffer.from(JSON.stringify({ deviceId, reason })),
    });
  } catch { return false; }
  const revoked = (answer.body as { revoked?: unknown } | null)?.revoked;
  return answer.status === 200 && typeof revoked === "number" && Number.isFinite(revoked);
}
const EVENT_REF = /^[a-f0-9]{64}$/;

export async function handlePhoneBearer(
  req: { method: string; path: string; query?: URLSearchParams; authorization: string | undefined; body: Buffer | null },
  o: { devices: PhoneBearerDevices; harness: HarnessCall; jobsHarness: HarnessCall; doorToken: string | undefined },
): Promise<{ status: number; body: unknown }> {
  const route = phoneJobRoute(req.method, req.path);
  let auth: { deviceId: string } | null = null;
  // A share-and-ask bearer carries no job authority: refused by shape, before any registry read.
  const presented = bearerToken(req.authorization);
  const askShaped = presented !== undefined && PHONE_ASK_TOKEN.test(presented);
  try { auth = route && !askShaped ? o.devices.authenticatePhoneJobs(presented) : null; } catch { auth = null; }
  if (!route || !auth) return { status: 403, body: { error: "forbidden" } };
  if (typeof o.doorToken !== "string" || !/^[a-f0-9]{64}$/.test(o.doorToken)) {
    return { status: 503, body: { error: "Phone tools need Murage and its companion to be started together by the desktop app or murage start." } };
  }
  // Master switch off on the phone: harness first, then the door token, then 200. A harness failure
  // answers 502 and leaves the token, so the phone retries. A failure after the harness write leaves a
  // token the harness refuses on every job route (S14), and the retry deletes it.
  if (req.method === "DELETE") {
    if (!(await phoneHarnessRevoke(o.harness, o.doorToken, auth.deviceId, "switch-off"))) {
      return { status: 502, body: { error: "Could not reach Murage. Try again." } };
    }
    try {
      if (!o.devices.clearPhoneJobsToken) throw new Error("no store");
      o.devices.clearPhoneJobsToken(auth.deviceId);
    } catch { return { status: 500, body: { error: "Could not switch phone tools off. Try again." } }; }
    return { status: 200, body: { ok: true } };
  }
  // Only the job poll takes a query, and only a well-formed eventRef; nothing else is forwarded.
  let path = req.path;
  if (req.method === "GET" && route.long) {
    const refs = req.query?.getAll("eventRef") ?? [];
    if (refs.length > 1 || (refs.length === 1 && !EVENT_REF.test(refs[0]))) return { status: 400, body: { error: "bad request" } };
    if (refs.length === 1) path = `${path}?eventRef=${refs[0]}`;
  }
  const headers = phoneForwardHeaders(auth.deviceId, o.doorToken);
  const body = route.maxBody > 0 && req.body && req.body.byteLength > 0 ? req.body : null;
  if (body) headers["content-type"] = "application/json";
  return (route.long ? o.jobsHarness : o.harness)({ method: req.method, path, headers, body });
}

// ── share and ask routes (plan S27) ──────────────────────────────────────
//
// The second native-only bearer, murage_pa_. Three exact routes and nothing else. The bearer is
// resolved before a byte of body is read and again after the whole body is in, so a phone removed
// or re-minted while it uploads forwards nothing.
const ASK_ROUTES: { method: string; path: string; route: "targets" | "share" | "ask"; maxBody: number }[] = [
  { method: "GET", path: "/api/phones/self/targets", route: "targets", maxBody: 0 },
  { method: "POST", path: "/api/phones/self/share", route: "share", maxBody: 64 * 1024 * 1024 },
  { method: "POST", path: "/api/phones/self/ask", route: "ask", maxBody: 8 * 1024 },
];

export function phoneAskRoute(method: string, path: string): "targets" | "share" | "ask" | null {
  return ASK_ROUTES.find((r) => r.method === method && r.path === path)?.route ?? null;
}

/** Gate exemption: a listed ask route AND a bearer of the murage_pa_ shape. Shape only; the handler
 * verifies the bearer against the registry before reading any body. */
export function phoneAskExempt(method: string, path: string, authorization: string | undefined): boolean {
  const token = bearerToken(authorization);
  return phoneAskRoute(method, path) !== null && token !== undefined && PHONE_ASK_TOKEN.test(token);
}

/** The only identity the harness gets for an ask route: what the second authentication proved. */
export function phoneAskHeaders(deviceId: string, generation: number, doorToken: string): Record<string, string> {
  return { "x-murage-door-token": doorToken, "x-murage-phone-device": deviceId, "x-murage-phone-scope": "ask", "x-murage-phone-ask-gen": String(generation), accept: "application/json" };
}

/** The ask forwards running right now, per device, so a revoke can abort them (S28 calls abortAll). */
export class AskForwards {
  private readonly live = new Map<string, Set<AbortController>>();

  add(deviceId: string): { signal: AbortSignal; done(): void } {
    const ctl = new AbortController();
    let set = this.live.get(deviceId);
    if (!set) { set = new Set(); this.live.set(deviceId, set); }
    set.add(ctl);
    return {
      signal: ctl.signal,
      done: () => {
        const mine = this.live.get(deviceId);
        if (!mine) return;
        mine.delete(ctl);
        if (mine.size === 0) this.live.delete(deviceId);
      },
    };
  }

  /** Aborts every live forward of the device; the count is how many were running. */
  abortAll(deviceId: string): number {
    const set = this.live.get(deviceId);
    if (!set) return 0;
    this.live.delete(deviceId);
    for (const ctl of set) ctl.abort();
    return set.size;
  }
}

/** A device that is removed (revoked, signed out from the phone, or replaced by a re-pair) loses its in-flight ask forwards too. */
export function abortAskForwardsOnRemoval(
  devices: { onDeviceRemoved(listener: (deviceId: string) => void): () => void },
  forwards: AskForwards,
): () => void {
  return devices.onDeviceRemoved((deviceId) => { forwards.abortAll(deviceId); });
}

const ACK_WAIT_MS = 5_000;

/** S28: switch share and ask off for a device, harness first. One synchronous step (the registry write, the queue entry
 * with its first send, the abort of every live forward), then one await for the harness to acknowledge. `acknowledged: false`
 * means the harness had not answered within `ackWaitMs`; the entry stays queued and retries. Throws, having changed nothing,
 * when the registry write fails. */
export async function revokeShareAsk(
  deviceId: string,
  o: {
    devices: { revokePhoneAsk(deviceId: string): { through: number } | null };
    revocations: { add(e: { deviceId: string; through: number }): void; acked(deviceId: string): Promise<void> };
    forwards: AskForwards;
    ackWaitMs?: number;
  },
): Promise<{ acknowledged: boolean }> {
  const revoked = o.devices.revokePhoneAsk(deviceId);
  if (!revoked) return { acknowledged: true };
  o.revocations.add({ deviceId, through: revoked.through });
  o.forwards.abortAll(deviceId);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), o.ackWaitMs ?? ACK_WAIT_MS); });
  try {
    return { acknowledged: (await Promise.race([o.revocations.acked(deviceId).then(() => true as const), late])) === true };
  } finally { clearTimeout(timer); }
}

export interface PhoneAskDoor {
  devices: { authenticatePhoneAsk(token: string | undefined): { deviceId: string; generation: number } | null };
  harness: HarnessCall;
  stream: HarnessStreamCall;
  doorToken: string | undefined;
  spoolDir: string;
  forwards: AskForwards;
  /** A silent upload is given up on after this long. Tests only. */
  idleMs?: number;
}

const FORBIDDEN = { status: 403, body: { error: "forbidden" } };
const TOO_LARGE = { status: 413, body: { error: "too large" } };
const REVOKED = { status: 401, body: { error: "unauthorized" } };

type BodySource = AsyncIterable<Uint8Array> & { destroy?: (err?: Error) => unknown };

/** Reads the whole body into memory, to at most `max` bytes. Null means over the cap. */
async function readBounded(body: BodySource, max: number, stop: () => boolean, touch: () => void): Promise<Buffer | null> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const c of body) {
    touch();
    if (stop()) return null;
    size += c.byteLength;
    if (size > max) return null;
    parts.push(Buffer.from(c.buffer, c.byteOffset, c.byteLength));
  }
  return Buffer.concat(parts);
}

/** Streams the body to `file` (mode 0600), counting as it goes. Null means over the cap. */
async function spoolBody(body: BodySource, file: string, max: number, stop: () => boolean, touch: () => void): Promise<number | null> {
  const out = createWriteStream(file, { flags: "wx", mode: 0o600 });
  const failed = new Promise<never>((_, reject) => out.once("error", reject));
  failed.catch(() => {});
  let size = 0;
  try {
    for await (const c of body) {
      touch();
      if (stop()) { out.destroy(); return null; }
      size += c.byteLength;
      if (size > max) { out.destroy(); return null; }
      if (!out.write(c)) await Promise.race([new Promise<void>((r) => out.once("drain", () => r())), failed]);
    }
    await Promise.race([new Promise<void>((r) => out.end(() => r())), failed]);
    return size;
  } catch (e) {
    out.destroy();
    throw e;
  }
}

export async function handlePhoneAsk(
  req: { method: string; path: string; authorization: string | undefined; body: BodySource; declaredLength?: number; contentType?: string },
  o: PhoneAskDoor,
): Promise<{ status: number; body: unknown }> {
  const kind = phoneAskRoute(req.method, req.path);
  const spec = kind ? ASK_ROUTES.find((r) => r.route === kind) : undefined;
  const token = bearerToken(req.authorization);
  let first: { deviceId: string; generation: number } | null = null;
  try { first = kind && token !== undefined && PHONE_ASK_TOKEN.test(token) ? o.devices.authenticatePhoneAsk(token) : null; } catch { first = null; }
  if (!kind || !spec || !first) return FORBIDDEN;
  if (typeof o.doorToken !== "string" || !/^[a-f0-9]{64}$/.test(o.doorToken)) {
    return { status: 503, body: { error: "Share and ask need Murage and its companion to be started together by the desktop app or murage start." } };
  }
  if (typeof req.declaredLength === "number" && req.declaredLength > spec.maxBody) return TOO_LARGE;

  const fwd = o.forwards.add(first.deviceId);
  const signal = fwd.signal;
  const stop = () => signal.aborted;
  const onAbort = () => { try { req.body.destroy?.(); } catch { /* the socket is already gone */ } };
  signal.addEventListener("abort", onAbort, { once: true });
  let file: string | null = null;
  let timedOut = false;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => { timedOut = true; onAbort(); }, o.idleMs ?? 30_000);
    idle.unref?.();
  };
  touch();
  try {
    let body: Buffer | null = null;
    let bytes = 0;
    if (kind === "ask") {
      body = await readBounded(req.body, spec.maxBody, stop, touch);
      if (stop()) return REVOKED;
      if (body === null) return TOO_LARGE;
      bytes = body.byteLength;
    } else if (kind === "share") {
      await mkdir(o.spoolDir, { recursive: true, mode: 0o700 });
      file = join(o.spoolDir, randomBytes(18).toString("base64url"));
      const spooled = await spoolBody(req.body, file, spec.maxBody, stop, touch);
      if (stop()) return REVOKED;
      if (spooled === null) return TOO_LARGE;
      bytes = spooled;
    }
    clearTimeout(idle);
    // Second authentication, against the live registry, after the body is in. A token that no longer
    // resolves, or resolves to another device or generation, forwards nothing.
    let second: { deviceId: string; generation: number } | null = null;
    try { second = o.devices.authenticatePhoneAsk(token); } catch { second = null; }
    if (!second || second.deviceId !== first.deviceId || second.generation !== first.generation) return REVOKED;
    if (stop()) return REVOKED;
    const headers = phoneAskHeaders(second.deviceId, second.generation, o.doorToken);
    if (kind === "share") {
      return await o.stream({ method: req.method, path: req.path, headers: req.contentType && /^[\x20-\x7e]{1,256}$/.test(req.contentType) ? { ...headers, "content-type": req.contentType } : headers, file: file as string, bytes, signal });
    }
    if (body && bytes > 0) headers["content-type"] = "application/json";
    const aborted = new Promise<{ status: number; body: unknown }>((resolve) => signal.addEventListener("abort", () => resolve(REVOKED), { once: true }));
    // The signal also drops the loopback request itself, so a revoked device's call stops at the harness too.
    return await Promise.race([o.harness({ method: req.method, path: req.path, headers, body: bytes > 0 ? body : null, signal }), aborted]);
  } catch {
    if (timedOut) return { status: 408, body: { error: "upload stalled" } };
    return stop() ? REVOKED : { status: 502, body: { error: "Could not reach Murage. Try again." } };
  } finally {
    clearTimeout(idle);
    signal.removeEventListener("abort", onAbort);
    fwd.done();
    if (file) await rm(file, { force: true }).catch(() => {});
  }
}
