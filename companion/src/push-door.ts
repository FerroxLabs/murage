// The door's half of push (spec §3.3, §3.5). Two session routes it owns,
// like /session: enrol (hand the relay's grant to the harness, then mint
// the tokens) and tokens (mint again). Three bearer routes it checks and
// forwards: the detail read, the pending list and the respond action.
// The harness trusts the ids below only with the launch proof.
import { request as httpRequest, type IncomingMessage } from "node:http";
import { bearerToken, PUSH_BINDING, PUSH_TOKEN } from "./devices.ts";

const DETAIL_PATH = /^\/api\/mobile\/push\/(?:[a-f0-9]{64}|pending)$/;
const GRANT = /^murage_pg_[A-Za-z0-9_-]{43}$/;
const PROOF = /^[a-f0-9]{64}$/;
const MAX_BODY = 4096;

export function pushBearerScope(method: string, path: string): "detail" | "respond" | null {
  if (method === "GET" && DETAIL_PATH.test(path)) return "detail";
  if (method === "POST" && path === "/api/mobile/push/respond") return "respond";
  return null;
}
/** The scope a request may skip the origin gate for: a push bearer route
 * AND a token of exactly that scope's shape. Shape only — the gate never
 * touches the registry; `handlePushBearer` checks the token itself. */
export function pushBearerExempt(method: string, path: string, authorization: string | undefined): "detail" | "respond" | null {
  const scope = pushBearerScope(method, path);
  const token = scope ? bearerToken(authorization) : undefined;
  return scope && token && PUSH_TOKEN[scope].test(token) ? scope : null;
}
export function isPushSessionRoute(method: string, path: string): boolean {
  return method === "POST" && (path === "/api/mobile/push/enrol" || path === "/api/mobile/push/tokens")
    || (method === "GET" || method === "POST") && path === "/api/mobile/push/preferences";
}

export type HarnessCall = (req: { method: string; path: string; headers: Record<string, string>; body: Buffer | null }) => Promise<{ status: number; body: unknown }>;
export interface PushDoorDevices {
  issuePushTokens(deviceId: string, bindingId: string): { detail: string; respond: string; expiresAt: number } | null;
  pushBinding(deviceId: string): string | null;
  authenticatePush(token: string | undefined, scope: "detail" | "respond"): { deviceId: string; bindingId: string } | null;
}
export interface PushDoorOptions {
  devices: PushDoorDevices;
  harness: HarnessCall;
  companionToken: string | undefined;
  /** Queue a device for the harness to drop its relay binding (the push
   * revocation queue's `add`). Used when an enrolment lands for a device
   * that was removed while the harness was making the binding. */
  revoked?: (deviceId: string) => void;
}

const UNAVAILABLE = { status: 503, body: { error: "Notifications need Murage and its companion to be started together by the desktop app or murage start." } };
const proven = (o: PushDoorOptions, deviceId: string): Record<string, string> | null =>
  typeof o.companionToken === "string" && PROOF.test(o.companionToken)
    ? { accept: "application/json", "x-murage-companion": "1", "x-murage-companion-token": o.companionToken, "x-murage-push-device": deviceId }
    : null;

export async function handlePushBearer(
  req: { method: string; path: string; authorization: string | undefined; body: Buffer | null },
  o: PushDoorOptions,
): Promise<{ status: number; body: unknown }> {
  const scope = pushBearerScope(req.method, req.path);
  const auth = scope ? o.devices.authenticatePush(bearerToken(req.authorization), scope) : null;
  if (!scope || !auth) return { status: 401, body: { error: "sign in" } };
  const headers = proven(o, auth.deviceId);
  if (!headers) return UNAVAILABLE;
  headers["x-murage-push-binding"] = auth.bindingId;
  headers["x-murage-push-scope"] = scope;
  if (req.body) headers["content-type"] = "application/json";
  return o.harness({ method: req.method, path: req.path, headers, body: req.body });
}

function mint(o: PushDoorOptions, deviceId: string, bindingId: string): { status: number; body: unknown } {
  const issued = o.devices.issuePushTokens(deviceId, bindingId);
  return issued ? { status: 200, body: { bindingId, ...issued } } : { status: 401, body: { error: "sign in" } };
}

export async function handlePushSession(
  req: { method: string; path: string; deviceId: string; body: Buffer },
  o: PushDoorOptions,
): Promise<{ status: number; body: unknown }> {
  const headers = proven(o, req.deviceId);
  if (!headers) return UNAVAILABLE;
  if (req.path === "/api/mobile/push/preferences") {
    return o.harness({ method: req.method, path: req.path,
      headers: { ...headers, "content-type": "application/json" }, body: req.method === "POST" ? req.body : null });
  }
  let parsed: unknown;
  try { parsed = JSON.parse(req.body.toString("utf8") || "{}"); } catch { return { status: 400, body: { error: "bad request" } }; }
  if (req.path === "/api/mobile/push/enrol") {
    const grant = (parsed as { grant?: unknown })?.grant;
    if (!parsed || typeof parsed !== "object" || Object.keys(parsed).join() !== "grant" || typeof grant !== "string" || !GRANT.test(grant)) {
      return { status: 400, body: { code: "bad_grant", error: "That notification setup has expired. Try again." } };
    }
    const body = Buffer.from(JSON.stringify({ grant }));
    const answer = await o.harness({ method: "POST", path: "/api/mobile/push/enrol", headers: { ...headers, "content-type": "application/json" }, body });
    const bindingId = (answer.body as { bindingId?: unknown })?.bindingId;
    if (answer.status !== 200) return answer;
    // Fail closed on anything but a binding id: it goes into a header on
    // every bearer forward from here on.
    if (typeof bindingId !== "string" || !PUSH_BINDING.test(bindingId)) {
      return { status: 502, body: { error: "Murage answered in a way this door does not understand. Try again." } };
    }
    // The device may have gone while the harness was enrolling it — signed
    // out, revoked, re-paired — and the revocation for it may already have
    // reached the harness before this binding existed. `issuePushTokens`
    // re-reads the registry and mints nothing for a device that is gone;
    // queue it again so the binding just made is dropped too.
    const minted = mint(o, req.deviceId, bindingId);
    if (minted.status !== 200) o.revoked?.(req.deviceId);
    return minted;
  }
  // tokens: only for the binding the harness still holds for this device
  const known = o.devices.pushBinding(req.deviceId);
  const answer = await o.harness({ method: "GET", path: "/api/mobile/push/binding", headers, body: null });
  const held = (answer.body as { bindingId?: unknown })?.bindingId;
  // Only the harness saying "not enrolled" is a 404 for the phone: anything
  // else (not answering, a lost proof, push off) is an outage, and must never
  // make the phone replace its binding (it enrols afresh on not_enrolled).
  const code = (answer.body as { code?: unknown } | null)?.code;
  const notEnrolled = answer.status === 404 && code === "not_enrolled";
  // Push off on this host is still no reason to replace, but the page is told,
  // so it stops asking the phone for a binding (final review I1).
  if (answer.status === 503 && code === "push_off") return { status: 503, body: { code: "push_off", error: "Notifications are turned off on this computer." } };
  if (answer.status !== 200 && !notEnrolled) return { status: 503, body: { error: "Murage is not answering on this computer. Try again." } };
  if (!known || answer.status !== 200 || held !== known) {
    return { status: 404, body: { code: "not_enrolled", error: "This phone is not set up for notifications yet." } };
  }
  return mint(o, req.deviceId, known);
}

/** The request body, up to `max` bytes. Past that it rejects and stops
 * keeping what arrives, but leaves the socket alone: destroying it here
 * would also destroy the 413 the caller is about to send, so Node discards
 * the rest once that answer is written. */
export function readLimited(req: IncomingMessage, max = MAX_BODY): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > max) { req.resume(); reject(new Error("too large")); return; }
    let chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (chunk: Buffer) => {
      if (over) return;
      size += chunk.byteLength;
      if (size > max) { over = true; chunks = []; reject(new Error("too large")); return; }
      chunks.push(chunk);
    });
    req.on("end", () => { if (!over) resolve(Buffer.concat(chunks)); });
    req.on("error", reject);
  });
}

const HARNESS_DEADLINE_MS = 15_000;
const MAX_ANSWER = 1024 * 1024;
const NOT_ANSWERING = { status: 502, body: { error: "Murage is not answering on this computer." } };

/** One loopback call to the harness. Always settles, exactly once: on the
 * whole answer, or as a 502 when the connection fails, the answer is cut
 * off mid-body (the harness died or restarted), it runs past `MAX_ANSWER`,
 * or the whole exchange — headers and body — outlives `deadlineMs`. A call
 * that never settled would hang the phone's request and wedge the
 * revocation queue behind it. */
export function createHarnessCall(port: number, o: { deadlineMs?: number } = {}): HarnessCall {
  return ({ method, path, headers, body }) => new Promise((resolve) => {
    let settled = false;
    const settle = (answer: { status: number; body: unknown }) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(answer);
    };
    const out = httpRequest({ hostname: "127.0.0.1", port, path, method, headers: body ? { ...headers, "content-length": String(body.byteLength) } : headers }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.byteLength;
        if (size > MAX_ANSWER) { settle(NOT_ANSWERING); out.destroy(); return; }
        chunks.push(c);
      });
      res.on("end", () => {
        let parsed: unknown = {};
        try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { parsed = { error: "unavailable" }; }
        settle({ status: res.statusCode ?? 502, body: parsed });
      });
      res.on("error", () => settle(NOT_ANSWERING));
      res.on("aborted", () => settle(NOT_ANSWERING));
      res.on("close", () => { if (!res.complete) settle(NOT_ANSWERING); });
    });
    const deadline = setTimeout(() => { settle(NOT_ANSWERING); out.destroy(); }, o.deadlineMs ?? HARNESS_DEADLINE_MS);
    deadline.unref?.();
    out.on("error", () => settle(NOT_ANSWERING));
    out.end(body ?? undefined);
  });
}
