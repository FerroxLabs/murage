// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// B3 WP2: the desktop's Cloud-home client. Runs in Electron MAIN only. It is a
// port of lanes/cloud-v2/tools/b1/e2e-browser.py `Home`:
//   connect (door v2: a ticket the site minted for our key, or a code minted for our public keys) -> challenge/refresh
//   -> Bearer + Origin -> x-murage-step-up -> one 401 refresh-retry.
//
// Trust: every connect verifies the CP-signed murage-home-key-v1 from
// /.well-known/murage/environment against a CP JWK built into the app, and
// compares it with what was pinned at pairing. Any mismatch refuses; the person
// must pair again. A HIGHER generation is accepted only when the CP signature on
// it verifies (home restored/replaced by the control plane).
//
// No queue: an unreachable home fails the call at once. Callers (and the
// renderer's bot-patch-queue, which WP4 keeps off for Cloud) must not retry
// writes behind the person's back. `queuesWrites` is false on purpose.
//
// The access token lives in this closure only. It is never returned over IPC;
// WP1's proxy gets it through getAccessToken() inside main.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

import { describeStepUp } from "./cloud-step-up-label.mjs";
import { parseDoorLink, ticketClaims, MAX_LINK_LENGTH } from "./cloud-door-link.mjs";
import { HOME_ID, generateDeviceKeys } from "./cloud-home-store.mjs";
import { CLOUD_HOME_CP } from "./cloud-control-plane.mjs";

export const COPY = Object.freeze({
  unreachable: "Your Cloud home isn't reachable",
  versionMismatch: "the versions need to match",
  pinMismatch: "This isn't the Cloud home you paired with. Pair it again.",
  needsRepair: "Your Cloud home no longer knows this computer. Pair it again.",
  stepUpCancelled: "You cancelled the confirmation, so nothing was changed.",
  notPaired: "This computer isn't paired with that Cloud home.",
  pairingRefused: "Your Cloud home would not connect this computer. Try again.",
  // Door v2 (Connect from the browser)
  connectRefused: "Your Cloud home would not connect this computer. Press Connect again.",
  tooManyTries: "Too many tries. Wait ten minutes, then press Connect again.",
  tooManyDevices: "This home has too many devices connected. Remove one on My Cloud, then press Connect again.",
  homeBusy: "Your Cloud home is busy right now. Wait a moment, then press Connect again.",
  lostAnswer: "Your home may have connected this computer, but the answer didn't arrive. Press Connect again; it uses the same key, so no new 72-hour check.",
  tookTooLong: "That took longer than ten minutes. Press Connect to start again.",
  removeOnMyCloud: "If this computer appears on My Cloud, remove it there.",
  otherConnect: "This link was made for another Connect. Press Connect again.",
  notLive: "Murage Cloud isn't available for this app yet. Update Murage and try again.",
  linkExpired: "This link has expired. Press Connect again.",
  badLink: "That is not a Murage connect link.",
  holdRequired: "Start adding this computer on My Cloud. It can connect after the 72-hour check.",
  disconnected: "This computer was disconnected from your Cloud home. Connect it again.",
  disconnectFailed: "Could not disconnect this computer. Try again.",
  suspended: "Your Cloud home is paused right now. This computer stays connected and comes back when the home is running again.",
  signInRefused: "Your Cloud home did not let this computer in just now. Murage will try again.",
  connectCancelled: "You cancelled connecting this computer, so nothing was changed.",
  cancelKept: "This computer is still connected to your Cloud home. To remove it, use Disconnect in Cloud Settings.",
  noSite: "Could not open the Murage site. Try again.",
  notOpen: "Murage Cloud is not open yet. Connect will be here as soon as it is.",
});

/** The one CP table (cloud-control-plane.mjs): base URL, the site Connect opens, and the pinned key (prod: null until it ships). */
export { CLOUD_HOME_CP } from "./cloud-control-plane.mjs";

/**
 * Which CLOUD_HOME_CP entry this app talks to, and so which site Connect opens. MURAGE_CLOUD_CP ("prod" or "staging")
 * picks one on purpose; without it a packaged (production) build is "prod" (murage.ai) and a development run is
 * "staging". A packaged build therefore never opens the staging preview unless someone asked for staging.
 */
export function resolveCloudCpEnvironment({ isPackaged, environment = process.env } = {}) {
  const chosen = environment?.MURAGE_CLOUD_CP;
  if (chosen === "prod" || chosen === "staging") return chosen;
  return isPackaged ? "prod" : "staging";
}

export class CloudHomeError extends Error {
  constructor(code, message, status) { super(message); this.name = "CloudHomeError"; this.code = code; if (status !== undefined) this.status = status; }
}

const b64u = (buffer) => Buffer.from(buffer).toString("base64url");
const major = (version) => { const m = /^(\d+)\./.exec(String(version ?? "")); return m ? Number(m[1]) : null; };
const KEY_FIELDS = ["type", "homeId", "generation", "homeKey", "publicOrigin", "issuedAt", "expiresAt"];

/** Port of server/cloud-home/b1b-identity.ts verifiedHomeIdentity, minus the pinned-generation argument (the caller compares). */
export function verifyHomeKey(envelope, jwk, now = Date.now()) {
  const refuse = () => new CloudHomeError("pin-mismatch", COPY.pinMismatch);
  if (!jwk || jwk.d !== undefined || jwk.kty !== "EC" || jwk.crv !== "P-256") throw refuse();
  if (!envelope || envelope.algorithm !== "ES256" || typeof envelope.payload !== "string" || envelope.payload.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(envelope.payload)
    || typeof envelope.signature !== "string" || !/^[A-Za-z0-9_-]+$/.test(envelope.signature) || Buffer.from(envelope.signature, "base64url").length !== 64) throw refuse();
  let ok = false;
  try { ok = verify("sha256", Buffer.from(envelope.payload), { key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(envelope.signature, "base64url")); } catch { ok = false; }
  if (!ok) throw refuse();
  let claims;
  try { claims = JSON.parse(Buffer.from(envelope.payload, "base64url").toString("utf8")); } catch { throw refuse(); }
  if (!claims || typeof claims !== "object" || Array.isArray(claims) || Object.keys(claims).some((k) => !KEY_FIELDS.includes(k)) || claims.type !== "murage-home-key-v1"
    || !HOME_ID.test(String(claims.homeId)) || !Number.isSafeInteger(claims.generation) || claims.generation <= 0
    || !Number.isSafeInteger(claims.issuedAt) || claims.issuedAt > now || !Number.isSafeInteger(claims.expiresAt) || claims.expiresAt <= now || claims.expiresAt > claims.issuedAt + 3_600_000
    || typeof claims.publicOrigin !== "string" || typeof claims.homeKey !== "string" || !claims.homeKey || claims.homeKey.length > 4096) throw refuse();
  return claims;
}

/** The server's stepPurpose (server/cloud-request-auth.ts): path INCLUDES the query string; body is the parsed JSON, {} when none. */
export function stepPurpose(method, pathWithQuery, body) {
  return `step:${method}:${pathWithQuery}:${createHash("sha256").update(JSON.stringify(body ?? {})).digest("hex")}`;
}

const DEVICE_REQUEST_PREFIX = "murage-device-request-1.";
const DEVICE_CODE_PREFIX = "murage-device-code-1.";
const encodeBlob = (prefix, value) => prefix + Buffer.from(JSON.stringify(value)).toString("base64url");
function decodeBlob(prefix, text, max) {
  const value = String(text ?? "").trim();
  if (!value.startsWith(prefix) || value.length > max || !/^[A-Za-z0-9_-]+$/.test(value.slice(prefix.length))) throw new CloudHomeError("pairing-refused", COPY.pairingRefused);
  try { const parsed = JSON.parse(Buffer.from(value.slice(prefix.length), "base64url").toString("utf8")); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed; } catch { /* fall through */ }
  throw new CloudHomeError("pairing-refused", COPY.pairingRefused);
}

/** NEW device: what it shows (or copies) so an already-paired device can mint a code for ITS keys. Public keys only. */
export function buildDeviceRequest(keys) {
  return encodeBlob(DEVICE_REQUEST_PREFIX, { scope: "owner-desktop", publicKey: keys.sessionPublicKey, assertionKey: keys.assertionPublicKey });
}
/** PAIRED device: validate a pasted request. Only owner-desktop is accepted (the strictest scope). */
export function parseDeviceRequest(text) {
  const request = decodeBlob(DEVICE_REQUEST_PREFIX, text, 4096);
  if (Object.keys(request).some((key) => !["scope", "publicKey", "assertionKey"].includes(key)) || request.scope !== "owner-desktop"
    || typeof request.publicKey !== "string" || typeof request.assertionKey !== "string" || !request.publicKey || !request.assertionKey || request.publicKey === request.assertionKey
    || !request.publicKey.includes("PUBLIC KEY") || !request.assertionKey.includes("PUBLIC KEY") || request.publicKey.includes("PRIVATE") || request.assertionKey.includes("PRIVATE")) throw new CloudHomeError("pairing-refused", COPY.pairingRefused);
  return { scope: request.scope, publicKey: request.publicKey, assertionKey: request.assertionKey };
}
/** PAIRED device: what it shows after minting. */
export function buildDeviceCodePackage({ homeId, homeOrigin, account, code }) {
  return encodeBlob(DEVICE_CODE_PREFIX, { homeId, homeOrigin, account, code });
}
/** NEW device: validate what was typed or pasted. */
export function parseDeviceCodePackage(text) {
  const parsed = decodeBlob(DEVICE_CODE_PREFIX, text, 2048);
  if (Object.keys(parsed).some((key) => !["homeId", "homeOrigin", "account", "code"].includes(key)) || !HOME_ID.test(String(parsed.homeId))
    || typeof parsed.homeOrigin !== "string" || !/^https:\/\/[a-z0-9.-]+$/.test(parsed.homeOrigin) || typeof parsed.account !== "string" || !parsed.account || parsed.account.length > 256
    || typeof parsed.code !== "string" || !/^[A-Za-z0-9_-]{6,256}$/.test(parsed.code)) throw new CloudHomeError("pairing-refused", COPY.pairingRefused);
  return { homeId: parsed.homeId, homeOrigin: parsed.homeOrigin, account: parsed.account, code: parsed.code };
}

/**
 * The native confirmation for a step-up. It names the action in plain words (cloud-step-up-label.mjs: a label for the
 * route, a short summary of the body such as which bot and which settings), never "approve this request".
 * Touch ID on a Mac that can prompt, otherwise a confirm dialog. Resolves true only on an explicit yes.
 * `body` is main's own parsed copy of the bytes it will sign and send; nothing here can change them.
 * `resolveBotName(homeId, botId)` is optional and best effort (two seconds): a bot's display name for the summary.
 */
export function createNativeStepUpConfirm({ systemPreferences, dialog, platform = process.platform, getWindow = () => undefined, resolveBotName }) {
  return async ({ homeId, method, path, body }) => {
    let botName;
    const botId = /^\/api\/bots\/([\w-]+)(?:\/|\?|$)/.exec(String(path))?.[1];
    if (botId && typeof resolveBotName === "function") {
      try { botName = await Promise.race([resolveBotName(homeId, botId), new Promise((resolve) => setTimeout(() => resolve(undefined), 2000).unref?.())]); } catch { botName = undefined; }
    }
    const described = describeStepUp({ method, path, body, botName: typeof botName === "string" ? botName : undefined });
    if (platform === "darwin" && systemPreferences?.canPromptTouchID?.()) {
      try { await systemPreferences.promptTouchID(described.reason); return true; } catch { return false; }
    }
    const options = { type: "question", buttons: ["Confirm", "Cancel"], defaultId: 1, cancelId: 1, title: "Confirm on your Cloud", message: described.label, detail: [...described.lines, "", described.request].join("\n") };
    const window = getWindow();
    const result = await (window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options));
    return result.response === 0;
  };
}

export function createCloudHomeClient({
  store, fetch: fetchImpl = globalThis.fetch, appVersion, confirmStepUp, cp = CLOUD_HOME_CP, cpEnvironment: defaultCpEnvironment = "prod",
  openExternal, generateKeys = generateDeviceKeys,
  now = Date.now, schedule = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; }, refreshAfterMs = 10 * 60_000, healthTtlMs = 60_000, requestTimeoutMs = 30_000,
  sleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); }), healthRetryDelaysMs = [1_000, 3_000, 9_000],
}) {
  if (!store || typeof fetchImpl !== "function" || !appVersion || typeof confirmStepUp !== "function") throw new TypeError("store, fetch, appVersion and confirmStepUp are required");
  /** homeId -> { record, token, tokenAt, healthAt, refreshing } . MAIN MEMORY ONLY. */
  const sessions = new Map();

  const unreachable = () => new CloudHomeError("unreachable", COPY.unreachable);
  const SESSION_INVALID = new Set(["Open this on a device you've paired with your Cloud.", "Sign in required"]);
  const UNREACHABLE_STATUS = new Set([502, 504, 521, 522, 523, 524, 530]);

  async function send(url, init = {}) {
    let response;
    try {
      response = await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(requestTimeoutMs), ...init });
    } catch { throw unreachable(); }
    if (UNREACHABLE_STATUS.has(response.status)) throw unreachable();
    return response;
  }
  const jsonOf = async (response) => { try { return await response.json(); } catch { return null; } };

  async function homeJson(origin, method, path, body, headers = {}) {
    const raw = body === undefined ? undefined : JSON.stringify(body);
    const response = await send(origin + path, {
      method, body: raw,
      headers: { accept: "application/json", ...(raw === undefined ? {} : { "content-type": "application/json" }), ...(method === "GET" || method === "HEAD" ? {} : { origin }), ...headers },
    });
    return { status: response.status, body: await jsonOf(response), retryAfter: response.headers?.get?.("retry-after") ?? null };
  }

  /** A control plane with a pinned verification key. Without one nothing can be verified, so Cloud is not open on this build yet. */
  const cloudOpen = (environment) => Boolean(cp?.[environment]?.jwk);
  const cpEntry = (environment) => {
    if (!cloudOpen(environment)) throw new CloudHomeError("not-open", COPY.notOpen);
    return cp[environment];
  };

  /** Fetch + verify the signed identity and return {environmentId, claims}. */
  async function readIdentity(origin, environment) {
    const { jwk } = cpEntry(environment); // not open on this build: refused before anything is sent
    const { status, body } = await homeJson(origin, "GET", "/.well-known/murage/environment");
    if (status !== 200 || !body || typeof body.environmentId !== "string" || !body.environmentId) throw new CloudHomeError("pin-mismatch", COPY.pinMismatch);
    const claims = verifyHomeKey(body.homeKey, jwk, now());
    return { environmentId: body.environmentId, claims };
  }

  /** Compare the live signed identity with the pin. Updates the pin only for a CP-signed higher generation. */
  async function checkPin(state) {
    const { record } = state;
    const live = await readIdentity(record.publicOrigin, record.cpEnvironment);
    const refuse = () => new CloudHomeError("pin-mismatch", COPY.pinMismatch);
    if (live.claims.homeId !== record.homeId || live.claims.publicOrigin !== record.publicOrigin || live.environmentId !== record.environmentId) throw refuse();
    if (live.claims.generation < record.generation) throw refuse();
    if (live.claims.generation === record.generation) { if (live.claims.homeKey !== record.homeKey) throw refuse(); return; }
    // Higher generation, valid CP signature (verified above): re-pin.
    const repinned = { ...record, generation: live.claims.generation, homeKey: live.claims.homeKey, pinnedAt: now() };
    state.record = repinned;
    // Under the store lock, and only while this session is still the home's: a Disconnect or a revoke that removed the
    // record while the identity was read is never undone by writing it back.
    await serialized(async () => { if (sessions.get(record.homeId) === state) await store.save(repinned); });
  }

  async function checkHealth(origin, token) {
    const { status, body } = await homeJson(origin, "GET", "/api/health", undefined, token ? { authorization: `Bearer ${token}` } : {});
    if (status !== 200) throw unreachable();
    if (body && typeof body.serverVersion === "string") {
      if (major(body.serverVersion) !== major(appVersion)) throw new CloudHomeError("version-mismatch", COPY.versionMismatch);
    } else if (token) {
      // A paired device always gets the full body; its absence is not proof of a match.
      throw new CloudHomeError("version-mismatch", COPY.versionMismatch);
    }
  }

  async function open(homeId) {
    if (!HOME_ID.test(String(homeId))) throw new CloudHomeError("not-paired", COPY.notPaired);
    let state = sessions.get(homeId);
    if (!state) {
      const record = await store.load(homeId);
      if (!record) throw new CloudHomeError("not-paired", COPY.notPaired);
      state = { record, token: null, tokenAt: 0, healthAt: 0, verifiedAt: 0 };
      sessions.set(homeId, state);
    }
    return state;
  }

  const signWith = (pem, message) => b64u(sign(null, Buffer.from(message), createPrivateKey(pem)));

  /** A refused challenge or refresh. `reason` is the home's own word: "revoked" (removed) or "suspended" (paused); else none. */
  const refusedSignIn = ({ status, body }) => {
    const error = new CloudHomeError("needs-repair", COPY.needsRepair, status);
    if (body?.reason === "revoked" || body?.reason === "suspended") error.reason = body.reason;
    return error;
  };

  async function refresh(state) {
    const { record } = state;
    const challenge = await homeJson(record.publicOrigin, "POST", "/api/cloud/challenge", { deviceId: record.deviceId, purpose: "refresh" });
    if (challenge.status !== 200 || typeof challenge.body?.challenge !== "string") throw refusedSignIn(challenge);
    if (challenge.body.environmentId !== record.environmentId) throw new CloudHomeError("pin-mismatch", COPY.pinMismatch);
    const at = now();
    const message = `murage:${record.environmentId}:${record.deviceId}:refresh:${challenge.body.challenge}:${at}`;
    const result = await homeJson(record.publicOrigin, "POST", "/api/cloud/refresh", { deviceId: record.deviceId, challenge: challenge.body.challenge, at, signature: signWith(record.sessionPrivateKey, message) });
    if (result.status !== 200 || typeof result.body?.accessToken !== "string") throw refusedSignIn(result);
    state.token = result.body.accessToken; state.tokenAt = now();
    arm(state);
  }

  /** Active homes keep a fresh token in memory ahead of expiry, so the proxy's SYNC getAccessToken() is always current. */
  function arm(state) {
    if (!state.active) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = schedule(() => {
      state.timer = undefined;
      ensureFresh(state, true).catch((error) => { if (error?.code === "needs-repair" || error?.code === "pin-mismatch") { state.token = null; } else arm(state); });
    }, refreshAfterMs);
  }

  /** One in-flight refresh per home; concurrent callers share it. */
  function ensureFresh(state, force = false) {
    if (!force && state.token && now() - state.tokenAt < refreshAfterMs) return Promise.resolve();
    state.refreshing ??= refresh(state).finally(() => { state.refreshing = undefined; });
    return state.refreshing;
  }

  /** Verify the pin (on first use per session and again every refresh window), health/version, and a fresh token. */
  async function connect(homeId) {
    const state = await open(homeId);
    if (now() - state.verifiedAt > refreshAfterMs) { await checkPin(state); state.verifiedAt = now(); }
    await ensureFresh(state);
    if (now() - state.healthAt > healthTtlMs) { await checkHealth(state.record.publicOrigin, state.token); state.healthAt = now(); }
    return state;
  }

  /**
   * Native confirm, then sign stepPurpose(method, path, body) for exactly these bytes. `bytes` is main's copy: the confirm
   * sees a clone of the parsed body, and the signature is over the same parse, so what was confirmed is what is signed.
   */
  async function stepUpHeader(state, method, path, bytes, headers) {
    const { record } = state;
    const parsed = stepBody(bytes, headers);
    if (!await confirmStepUp({ homeId: record.homeId, method, path, body: structuredClone(parsed) })) throw new CloudHomeError("step-up-cancelled", COPY.stepUpCancelled);
    const purpose = stepPurpose(method, path, parsed);
    const challenge = await homeJson(record.publicOrigin, "POST", "/api/cloud/challenge", { deviceId: record.deviceId, purpose }, { authorization: `Bearer ${state.token}` });
    if (challenge.status !== 200 || typeof challenge.body?.challenge !== "string") throw refusedSignIn(challenge);
    if (challenge.body.environmentId !== record.environmentId) throw new CloudHomeError("pin-mismatch", COPY.pinMismatch);
    const at = now();
    const message = `murage:${record.environmentId}:${record.deviceId}:${purpose}:${challenge.body.challenge}:${at}`;
    return b64u(JSON.stringify({ challenge: challenge.body.challenge, at, signature: signWith(record.assertionPrivateKey, message) }));
  }

  function stepBody(bytes, headers) {
    if (bytes === undefined || bytes.length === 0) return {};
    if (!/json/i.test(String(new Headers(headers).get("content-type") ?? ""))) return {};
    try { return JSON.parse(bytes.toString("utf8")); } catch { return {}; }
  }

  /** Always a private copy: a caller mutating its buffer after the call cannot change what is confirmed, signed or sent. */
  const toBytes = (body) => body === undefined || body === null ? undefined : Buffer.from(typeof body === "string" ? body : body instanceof Uint8Array ? body : JSON.stringify(body));

  /**
   * Step-up aware fetch to a paired home. `path` is a path+query on the home ("/api/bots?x=1").
   * Returns the raw Response (streamable). The body is held here as bytes, so a 401 refresh-retry and a
   * 403 step-up retry send exactly what the caller sent. Never queues: unreachable throws at once.
   */
  async function fetchHome(homeId, path, { method = "GET", headers = {}, body, signal } = {}) {
    if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) throw new TypeError("path must be a path on the home");
    const state = await connect(homeId);
    const origin = state.record.publicOrigin, verb = method.toUpperCase();
    const bytes = toBytes(body);
    const attempt = (extra = {}) => send(origin + path, {
      method: verb, body: bytes, signal: signal ?? AbortSignal.timeout(requestTimeoutMs),
      headers: { ...headers, ...(verb === "GET" || verb === "HEAD" ? {} : { origin }), ...extra, authorization: `Bearer ${state.token}` },
    });
    let response = await attempt();
    // An invalid access token is a 401, or (on /api routes the home answers anonymous callers with) a 403 "paired device required".
    // Either way: one refresh, one retry with the same bytes. A second refusal is returned as it is.
    const sessionInvalid = async (r) => r.status === 401 || (r.status === 403 && SESSION_INVALID.has((await jsonOf(r.clone()))?.error));
    if (await sessionInvalid(response)) { await ensureFresh(state, true); response = await attempt(); }
    if (response.status === 403) {
      const peek = await jsonOf(response.clone());
      if (peek?.error === "step-up required") {
        const header = await stepUpHeader(state, verb, path, bytes, headers);
        response = await attempt({ "x-murage-step-up": header });
      }
    }
    return response;
  }

  /**
   * The main-driven step-up for a write the renderer already sent and the home refused with 403 "step-up required"
   * (the proxy's path). `body` is the byte buffer main already holds. Native confirm -> sign stepPurpose over those
   * bytes -> ONE retry carrying the assertion. No further retry, no queue. A "no" throws step-up-cancelled and nothing
   * is sent. Never loops: whatever the home answers to the signed retry is what the caller gets.
   */
  async function stepUpRetry(homeId, path, { method = "POST", headers = {}, body, signal } = {}) {
    if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) throw new TypeError("path must be a path on the home");
    const state = await connect(homeId);
    const origin = state.record.publicOrigin, verb = method.toUpperCase();
    if (verb === "GET" || verb === "HEAD") throw new TypeError("step-up applies to writes");
    const bytes = toBytes(body);
    const header = await stepUpHeader(state, verb, path, bytes, headers);
    return send(origin + path, {
      method: verb, body: bytes, signal: signal ?? AbortSignal.timeout(requestTimeoutMs),
      headers: { ...headers, origin, "x-murage-step-up": header, authorization: `Bearer ${state.token}` },
    });
  }

  // ---- pairing -------------------------------------------------------------------------------------------------
  async function cpJson(environment, token, method, path, body) {
    const base = cpEntry(environment).baseUrl;
    const response = await send(base + path, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { accept: "application/json", authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    });
    return { status: response.status, body: await jsonOf(response) };
  }

  /** The signed-in owner's homes from the control plane. */
  async function listHomes({ cpToken, cpEnvironment = "staging" }) {
    const { status, body } = await cpJson(cpEnvironment, cpToken, "GET", "/v1/homes");
    if (status !== 200 || !Array.isArray(body?.homes)) throw new CloudHomeError("cp-refused", "Could not list your Cloud homes", status);
    return body.homes;
  }
  async function redeem({ homeId, cpEnvironment, homeOrigin, account, code, keys, identity }) {
    const message = `murage-pair:${identity.environmentId}:${code}:${account}`;
    const paired = await homeJson(homeOrigin, "POST", "/api/cloud/pair", {
      code, account, signature: signWith(keys.sessionPrivateKey, message), assertionSignature: signWith(keys.assertionPrivateKey, message),
    });
    if (paired.status !== 200 || typeof paired.body?.accessToken !== "string" || typeof paired.body?.deviceId !== "string") throw new CloudHomeError("pairing-refused", COPY.pairingRefused, paired.status);
    const record = {
      homeId, cpEnvironment, publicOrigin: homeOrigin, environmentId: identity.environmentId, homeKey: identity.claims.homeKey, generation: identity.claims.generation,
      deviceId: paired.body.deviceId, account, sessionPrivateKey: keys.sessionPrivateKey, assertionPrivateKey: keys.assertionPrivateKey, pinnedAt: now(),
    };
    await serialized(() => store.save(record)); // refused (Linux basic_text etc.) => nothing paired locally; the unused device is harmless but orphaned
    const state = { record, token: paired.body.accessToken, tokenAt: now(), healthAt: 0, verifiedAt: now() };
    sessions.set(homeId, state);
    try { await checkHealth(homeOrigin, state.token); state.healthAt = now(); }
    catch (error) { sessions.delete(homeId); await serialized(() => store.remove(homeId)); throw error; }
    return { homeId, deviceId: record.deviceId, publicOrigin: homeOrigin, generation: record.generation };
  }

  async function preparePairing({ homeId, cpEnvironment, homeOrigin }) {
    if (!HOME_ID.test(homeId)) throw new CloudHomeError("not-paired", COPY.notPaired);
    const identity = await readIdentity(homeOrigin, cpEnvironment);
    if (identity.claims.homeId !== homeId || identity.claims.publicOrigin !== homeOrigin) throw new CloudHomeError("pin-mismatch", COPY.pinMismatch);
    await checkHealth(homeOrigin, null); // anonymous body has no version; compared again with the paired body inside redeem()
    return identity;
  }

  /**
   * Pair with a code that was minted for OUR public keys (shown by this app as a pairing request) by an existing
   * device's owner flow. The home origin must be one the person chose; its identity is still verified against the CP key.
   */
  async function pairWithDeviceCode(input) {
    const { homeId, homeOrigin, code, account, cpEnvironment = "staging", keys } = input.package !== undefined ? { ...input, ...parseDeviceCodePackage(input.package) } : input;
    await store.assertWritable();
    const identity = await preparePairing({ homeId, cpEnvironment, homeOrigin });
    return redeem({ homeId, cpEnvironment, homeOrigin, account, code, keys, identity });
  }

  /**
   * ADD DEVICE, step 1 (runs on the ALREADY-PAIRED desktop). Mint a short-lived code bound to the NEW device's public keys.
   *   1. The control plane (owner session, rate limited) answers with the exact body for the home's /api/cloud/pairing and
   *      its bootstrap HMAC over those bytes. The CP never talks to the home on this path.
   *   2. We check that body is what we asked for (this home's operation, our account, the new device's keys, nothing else).
   *   3. We POST it to the home with step-up on the FIRST request (native confirm / Touch ID): the home spends the
   *      bootstrap nonce before it checks step-up, so a plain first try would burn the signature.
   * Returns the package to show on this device and type or paste on the new one: pairWithDeviceCode({ package, keys }).
   */
  async function mintDeviceCode({ homeId, cpToken, cpEnvironment = "staging", request }) {
    const device = parseDeviceRequest(request);
    const state = await open(homeId);
    const { record } = state;
    const signed = await cpJson(record.cpEnvironment ?? cpEnvironment, cpToken, "POST", `/v1/homes/${homeId}/pairing/device`, { device });
    if (signed.status !== 200 || typeof signed.body?.body !== "string" || typeof signed.body?.signature !== "string" || signed.body.homeOrigin !== record.publicOrigin) throw new CloudHomeError("cp-refused", COPY.pairingRefused, signed.status);
    let wire;
    try { wire = JSON.parse(signed.body.body); } catch { throw new CloudHomeError("cp-refused", COPY.pairingRefused); }
    if (!wire || wire.operation !== "/api/cloud/pairing" || wire.account !== record.account || wire.scope !== device.scope
      || wire.publicKey !== device.publicKey || wire.assertionKey !== device.assertionKey || wire.recovery !== undefined) throw new CloudHomeError("cp-refused", COPY.pairingRefused);
    const response = await stepUpRetry(homeId, "/api/cloud/pairing", {
      method: "POST", headers: { "content-type": "application/json", "x-murage-signature": signed.body.signature }, body: signed.body.body,
    });
    const answer = response.status === 200 ? await jsonOf(response) : null;
    if (typeof answer?.code !== "string") throw new CloudHomeError("pairing-refused", COPY.pairingRefused, response.status);
    return { code: answer.code, expiresIn: answer.expiresIn, package: buildDeviceCodePackage({ homeId, homeOrigin: record.publicOrigin, account: record.account, code: answer.code }) };
  }

  /** The homes this computer is paired with: [{ homeId, origin }]. Reads the sealed records; returns no key material. */
  async function pairedHomes() {
    const out = [];
    for (const homeId of await store.list()) {
      try { const record = await store.load(homeId); if (record) out.push({ homeId, origin: record.publicOrigin }); } catch { /* unreadable: pair it again */ }
    }
    return out;
  }


  // ---- Door v2: Connect from the browser -----------------------------------------------------------------------
  // One pending Connect at a time. Its keys are sealed on disk BEFORE the browser opens, so a restart reuses them
  // until enrollment succeeds or the person cancels. The 10-minute countdown is the window's own; nothing here expires.
  // States of the sealed pending Connect:
  //   made       the key only. Expires CONNECT_WINDOW_MS after startedAt (the key is discarded on the next status or link).
  //   attempted  { at, homeId, origin }, sealed BEFORE the POST to /api/cloud/enter. Never expires by time: the home may have
  //              enrolled the key, so only a confirmed enrolment or Cancel ends it. The next Connect reuses the key, and the
  //              home answers a retried redeem with the same key as a known device (same id, no second 72-hour hold).
  //   enrolled   { deviceId, ... } right after a 200, then the record is saved and the pending file cleared.
  let pending; // undefined = not loaded yet, null = none
  let accepting = false;
  // The last outcome the Connect panel shows: { code, message, at, retryAfterMs? }. Kept until the next Connect or
  // RESULT_TTL_MS, whether or not a Connect is still pending.
  let lastResult = null;
  let revokedNotice = false; // a revoked computer was just forgotten
  let connectGeneration = 0; // bumped by every Connect and Cancel: a link exchange that started under an older one stops
  async function loadPending() {
    if (pending === undefined) {
      pending = typeof store.loadPending === "function" ? await store.loadPending().catch(() => null) : null;
      if (!lastResult && pending?.lastResult) lastResult = pending.lastResult; // a restart still shows what happened
    }
    return pending;
  }
  const CONNECT_WINDOW_MS = 10 * 60_000, RESULT_TTL_MS = 10 * 60_000;
  const result = (code, message, extra = {}) => ({ code, message, at: now(), ...extra });
  /** A made pending older than ten minutes: its key is discarded and the panel says why. attempted and enrolled never expire. */
  async function expireMade() {
    const current = await loadPending();
    if (!current || current.enrolled || current.attempted || now() - current.startedAt < CONNECT_WINDOW_MS) return;
    await serialized(async () => {
      if (pending !== current) return; // a Connect, Cancel or link got there first
      await store.clearPending?.();
      pending = null; connectGeneration++;
      lastResult = result("took-too-long", COPY.tookTooLong);
    });
  }
  const currentResult = () => {
    if (!lastResult) return null;
    const ttl = Math.max(RESULT_TTL_MS, lastResult.retryAfterMs ?? 0);
    if (now() - lastResult.at > ttl) { lastResult = null; return null; }
    return lastResult;
  };
  /**
   * The one store lock. Every change to the store runs here, one at a time, and a change that depends on what is stored
   * reads it again inside the same turn: the pending file (a Connect's save, a Cancel's clear, an enrollment's save, the
   * restart recovery), the revocation queue (queueing a cancelled device, removing the ones the home confirmed) and the
   * home records (a re-pin, a removal). So no write is ever based on an old read, and whichever came second sees what the
   * first left behind. Network calls never run inside it. Never call serialized() from inside serialized work.
   */
  let persistence = Promise.resolve();
  const serialized = (work) => { const run = persistence.then(() => work()); persistence = run.then(() => {}, () => {}); return run; };
  // ---- Devices the home enrolled for a cancelled Connect: removed at the home, confirmed or kept until it is ---------------
  const REVOKE_RETRY_MS = 60_000;
  let revokeRetryAt = 0, revoking = null;
  /** True only when the home confirmed it forgot this device. A refusal, a 5xx or no answer is not a confirmation. */
  async function forgetAtHome(origin, token) {
    try { return (await homeJson(origin, "POST", "/api/cloud/devices/forget", {}, { authorization: `Bearer ${token}` })).status === 200; }
    catch { return false; }
  }
  /** The record shape for a pending Connect the home enrolled: what a sign-in with its session key needs. */
  const recordOf = (withDevice) => {
    const { enrolled } = withDevice;
    return {
      homeId: enrolled.homeId, cpEnvironment: withDevice.cpEnvironment, publicOrigin: enrolled.publicOrigin, environmentId: enrolled.environmentId, homeKey: enrolled.homeKey,
      generation: enrolled.generation, deviceId: enrolled.deviceId, account: enrolled.account,
      sessionPrivateKey: withDevice.sessionPrivateKey, assertionPrivateKey: withDevice.assertionPrivateKey, pinnedAt: now(),
    };
  };
  const loadRevocations = async () => typeof store.loadRevocations === "function" ? store.loadRevocations().catch(() => []) : [];
  const sameDevice = (a, b) => a.deviceId === b.deviceId && a.publicOrigin === b.publicOrigin;
  /**
   * Keep the credentials of a device the home still has, so a later start or door open can remove it. Read and written in
   * one turn of the store lock, on the queue as it is stored now. Throws (and changes nothing) when the queue cannot be
   * read or is full: the caller keeps the credentials some other way.
   */
  async function queueRevocation(record) {
    if (typeof store.saveRevocations !== "function") return;
    await serialized(async () => {
      const queued = (await store.loadRevocations({ strict: true })).filter((entry) => !sameDevice(entry, record));
      await store.saveRevocations([...queued, { ...record, cancelledAt: now() }]);
    });
    revokeRetryAt = 0; // the next door open tries at once
  }
  /**
   * Remove every queued device at its home: sign in with the kept session key, then /devices/forget. An entry leaves the
   * queue only when the home confirms (200) or says on sign-in that the device is already revoked. Once a minute at most,
   * one run at a time, never throws: it runs on every start and door open.
   */
  async function retryRevocations({ force = false } = {}) {
    if (revoking) return revoking;
    if (!force && now() < revokeRetryAt) return;
    revoking = (async () => {
      const queued = await loadRevocations();
      if (queued.length === 0) return;
      revokeRetryAt = now() + REVOKE_RETRY_MS;
      const confirmed = [];
      for (const entry of queued) {
        let done = false;
        try {
          const state = { record: entry, token: null, tokenAt: 0 };
          await refresh(state); // throws needs-repair with reason "revoked" when the home no longer has the device
          done = await forgetAtHome(entry.publicOrigin, state.token);
        } catch (error) { done = error?.code === "needs-repair" && error?.reason === "revoked"; }
        if (done) confirmed.push(entry);
      }
      if (confirmed.length === 0) return;
      // The queue may have changed while the homes were asked (a Cancel queued another device). Remove exactly the devices
      // the homes confirmed from the queue as it is stored NOW; everything else stays with its credentials.
      await serialized(async () => {
        const current = await store.loadRevocations({ strict: true });
        const left = current.filter((entry) => !confirmed.some((done) => sameDevice(done, entry) && done.sessionPrivateKey === entry.sessionPrivateKey));
        if (left.length !== current.length) await store.saveRevocations(left);
      });
    })().catch(() => {}).finally(() => { revoking = null; });
    return revoking;
  }
  /** The home enrolled a device for a Connect that is now cancelled: forget it there, confirmed or queued, and keep nothing of it here. */
  async function undoEnrollment({ origin, token, withDevice, record }) {
    if (!await forgetAtHome(origin, token)) {
      const kept = record ?? recordOf(withDevice);
      try { await queueRevocation(kept); }
      catch {
        // The queue could not take it (full, or unreadable). Never lose a device the home still has: keep it as this
        // computer's connection, which Disconnect in Cloud Settings removes.
        await serialized(() => store.save(kept));
        if (pending?.enrolled?.deviceId === withDevice.enrolled.deviceId) pending = null;
        await serialized(() => store.clearPending?.()).catch(() => {});
        throw new CloudHomeError("cancel-kept", COPY.cancelKept);
      }
    }
    if (record) { sessions.delete(record.homeId); await serialized(() => store.remove(record.homeId)).catch(() => {}); }
    if (pending?.enrolled?.deviceId === withDevice.enrolled.deviceId) pending = null;
    await serialized(() => store.clearPending?.()).catch(() => {});
  }
  const bindOf = (publicKeyPem) => createHash("sha256").update(createPublicKey(publicKeyPem).export({ type: "spki", format: "der" })).digest("hex");
  const siteConnectUrl = (environment, bind) => {
    const origin = cp?.[environment]?.siteOrigin;
    let site;
    try { site = new URL(String(origin)); } catch { throw new CloudHomeError("pairing-refused", COPY.noSite); }
    if (site.protocol !== "https:" || site.origin !== origin || site.username || site.password) throw new CloudHomeError("pairing-refused", COPY.noSite);
    return `${site.origin}/home/cloud/connect-app?k=${bind}`;
  };

  /** Make (or reuse) the pending key pair, seal it, then open the system browser on the site's connect page. */
  async function startConnect({ cpEnvironment = defaultCpEnvironment } = {}) {
    if (typeof openExternal !== "function") throw new CloudHomeError("pairing-refused", COPY.noSite);
    if (!cloudOpen(cpEnvironment)) throw new CloudHomeError("not-open", COPY.notOpen); // no key sealed, no browser: nothing could be verified
    await settleUnfinished();
    await expireMade();
    const existing = await loadPending();
    // An unenrolled key is reused: made, or attempted (the home may know it already, so a new key could leave a device behind).
    const keys = (existing && !existing.enrolled ? existing : null) ?? (() => {
      const made = generateKeys();
      return { sessionPublicKey: made.sessionPublicKey, sessionPrivateKey: made.sessionPrivateKey, assertionPublicKey: made.assertionPublicKey, assertionPrivateKey: made.assertionPrivateKey, cpEnvironment };
    })();
    const url = siteConnectUrl(keys.cpEnvironment, bindOf(keys.sessionPublicKey));
    await store.assertWritable();
    const { lastResult: _previous, ...kept } = keys;
    const next = { ...kept, startedAt: now() };
    await serialized(async () => {
      await store.savePending(next); // sealed and on disk first
      pending = next; lastResult = null; revokedNotice = false; connectGeneration++;
    });
    await openExternal(url);
    return { pending: true, startedAt: next.startedAt };
  }

  /**
   * Forget the pending key pair. The generation moves at once, so an exchange in flight sees the Cancel at its next check
   * and undoes whatever the home enrolled; the file itself is cleared in turn with the other pending writes, never racing one.
   */
  async function cancelConnect() {
    connectGeneration++; // at once: an exchange in flight sees the Cancel at its next check
    const was = pending !== undefined ? pending : await loadPending();
    pending = null;
    // After an answer that never arrived the home may hold this key, under a device id this computer never learned, so it
    // cannot be removed from here: say where it can be.
    lastResult = was?.attempted && !was.enrolled ? result("remove-on-my-cloud", COPY.removeOnMyCloud) : null;
    await serialized(() => store.clearPending?.());
    return { pending: false };
  }

  async function connectStatus({ cpEnvironment = defaultCpEnvironment } = {}) {
    await settleUnfinished();
    await expireMade();
    const current = await loadPending();
    const shown = currentResult();
    return {
      pending: Boolean(current), startedAt: current?.startedAt ?? null, attempted: Boolean(current?.attempted && !current.enrolled),
      paired: (await pairedHomes()).length > 0,
      lastResult: shown ? { code: shown.code, message: shown.message, at: shown.at, ...(shown.retryAfterMs ? { retryAfterMs: shown.retryAfterMs } : {}) } : null,
      disconnected: revokedNotice, open: cloudOpen(cpEnvironment),
    };
  }

  /** Each wire reason of a refused /api/cloud/enter (server/cloud-request-auth.ts coarseDoorReason) has its own words. */
  const DOOR_REASONS = Object.freeze({
    expired: ["expired", COPY.linkExpired],
    hold_required: ["hold-required", COPY.holdRequired],
    too_many_devices: ["too-many-devices", COPY.tooManyDevices],
    refused: ["refused", COPY.connectRefused],
  });
  const retryAfterMs = (value) => { const seconds = Number(value); return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) * 1000 : 600_000; };
  const doorRefusal = (status, body, retryAfter) => {
    if (status === 403 && Object.hasOwn(DOOR_REASONS, String(body?.reason))) { const [code, message] = DOOR_REASONS[body.reason]; return new CloudHomeError(code, message, status); }
    if (status === 429) return Object.assign(new CloudHomeError("too-many-tries", COPY.tooManyTries, status), { retryAfterMs: retryAfterMs(retryAfter) });
    if (status === 503) return new CloudHomeError("home-busy", COPY.homeBusy, status);
    return new CloudHomeError("refused", COPY.connectRefused, status);
  };
  /** No answer, or one that says nothing about what the home did (a 5xx other than busy): the home may have enrolled the key. */
  const answerLost = (status) => status >= 500 && status !== 503;

  /**
   * The app's side of murage://door. Only while a Connect is pending. The CP-signed home identity must name the link's home
   * and origin BEFORE anything is posted. Never logs or returns the link, the ticket or a key.
   * Returns { ignored: true } when no Connect is pending (or one link is already being handled); throws CloudHomeError on a refusal.
   */
  async function acceptDoorLink(rawLink) {
    try { return await acceptDoorLinkInner(rawLink); }
    catch (error) {
      if (error instanceof CloudHomeError && error.code !== "cancelled") lastResult = result(error.code, error.message, error.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : {});
      throw error;
    }
  }
  async function acceptDoorLinkInner(rawLink) {
    await settleUnfinished();
    await expireMade();
    const current = await loadPending();
    // No pending key, or one already enrolled or being redeemed: this link has nothing to finish. Never a dialog from a link.
    if (!current || current.enrolled || accepting) return { ignored: true };
    const link = parseDoorLink(rawLink);
    if (!link) throw new CloudHomeError("bad-link", COPY.badLink);
    const claims = ticketClaims(link.ticket);
    if (!claims || typeof claims.account !== "string" || !claims.account || claims.account.length > 256
      || (claims.homeId !== undefined && claims.homeId !== link.homeId) || (claims.publicOrigin !== undefined && claims.publicOrigin !== link.origin)) throw new CloudHomeError("bad-link", COPY.badLink);
    // The ticket must be bound to THIS pending key, checked before anything is sent: a link made for another Connect (an
    // older key, another computer) is refused here, not by the home.
    if (typeof claims.bind !== "string" || claims.bind !== bindOf(current.sessionPublicKey)) throw new CloudHomeError("other-connect", COPY.otherConnect);
    accepting = true;
    const generation = connectGeneration;
    const cancelled = () => generation !== connectGeneration; // Connect and Cancel both move it, synchronously
    try {
      await store.assertWritable();
      const identity = await preparePairing({ homeId: link.homeId, cpEnvironment: current.cpEnvironment, homeOrigin: link.origin });
      if (cancelled()) throw new CloudHomeError("cancelled", COPY.connectCancelled); // Cancel pressed while the identity was checked: nothing is sent
      // attempted is sealed BEFORE the POST: if the answer is lost, this key may be enrolled at the home, so it must never expire.
      const firstAttempt = !current.attempted;
      const attempting = { ...current, attempted: current.attempted ?? { at: now(), homeId: link.homeId, origin: link.origin } };
      await serialized(async () => {
        if (cancelled()) return;
        await store.savePending(attempting);
        pending = attempting;
      });
      if (cancelled()) throw new CloudHomeError("cancelled", COPY.connectCancelled);
      /** The home answered and enrolled nothing: a first attempt goes back to made (it can expire again); an earlier lost
       *  attempt stays attempted, because the home may still hold the key from it. */
      const refusedNoEnrol = async (error) => {
        if (cancelled()) throw new CloudHomeError("cancelled", COPY.connectCancelled);
        if (firstAttempt) await serialized(async () => {
          if (cancelled() || pending !== attempting) return;
          const { attempted: _a, ...made } = attempting;
          const next = { ...made, lastResult: result(error.code, error.message) };
          await store.savePending(next).catch(() => {});
          pending = next;
        });
        throw error;
      };
      const lost = async () => {
        // Cancelled meanwhile: Cancel already told the person where to look (remove it on My Cloud); that stays.
        if (cancelled()) throw new CloudHomeError("cancelled", COPY.connectCancelled);
        const error = new CloudHomeError("lost", COPY.lostAnswer);
        await serialized(async () => {
          if (cancelled() || pending !== attempting) return;
          const next = { ...attempting, lastResult: result(error.code, error.message) };
          await store.savePending(next).catch(() => {});
          pending = next;
        });
        throw error;
      };
      const proof = signWith(current.sessionPrivateKey, `murage-door-v2:${link.ticket}`);
      let entered;
      try {
        entered = await homeJson(link.origin, "POST", "/api/cloud/enter", {
          ticket: link.ticket, device: { deviceId: null, publicKey: current.sessionPublicKey, assertionKey: current.assertionPublicKey, proof },
        });
      } catch (error) { if (error?.code === "unreachable") return await lost(); throw error; }
      if (answerLost(entered.status)) return await lost();
      if (entered.status !== 200 || typeof entered.body?.accessToken !== "string" || typeof entered.body?.deviceId !== "string") return await refusedNoEnrol(doorRefusal(entered.status, entered.body, entered.retryAfter));
      const enrolled = {
        homeId: link.homeId, publicOrigin: link.origin, environmentId: identity.environmentId, homeKey: identity.claims.homeKey, generation: identity.claims.generation,
        deviceId: entered.body.deviceId, account: claims.account,
      };
      const withDevice = { ...attempting, enrolled };
      // From here the home has spent the ticket and enrolled this key. A Cancel seen at any check below wins: the device is
      // removed at the home again (confirmed, or kept in the revocation queue until it is) and nothing of it stays here.
      let record = null;
      try {
        await serialized(async () => {
          if (cancelled()) return;
          // Keep the device id with the pending keys at once, so a failed save or a restart still finishes this enrollment
          // instead of needing another link.
          await store.savePending(withDevice);
          if (cancelled()) return;
          pending = withDevice;
          record = await saveEnrolled(withDevice);
        });
      } catch (error) { if (!cancelled()) throw error; }
      if (cancelled()) {
        await undoEnrollment({ origin: link.origin, token: entered.body.accessToken, withDevice, record });
        // The answer did arrive, so this device is being removed from here after all: no need to send the person to My Cloud.
        if (lastResult?.code === "remove-on-my-cloud") lastResult = null;
        throw new CloudHomeError("cancelled", COPY.connectCancelled);
      }
      const state = { record, token: entered.body.accessToken, tokenAt: now(), healthAt: 0, verifiedAt: now() };
      sessions.set(link.homeId, state);
      // The record stays whatever the health check says: this computer is enrolled. A home that does not answer yet is
      // asked again with backoff; the Cloud window's banner covers the rest.
      await healthWithRetry(state);
      return { homeId: link.homeId, deviceId: record.deviceId, publicOrigin: link.origin, generation: record.generation };
    } finally { accepting = false; }
  }

  /** Turn a pending Connect the home already enrolled into the saved record, then drop the pending keys. */
  async function saveEnrolled(withDevice) {
    const record = recordOf(withDevice);
    await store.save(record);
    pending = null; lastResult = null; await store.clearPending?.();
    return record;
  }
  /**
   * A restart (or a failed save) after the home enrolled this key: finish from the sealed pending keys. A pending key whose
   * device waits in the revocation queue was cancelled: it is cleared, never finished.
   */
  async function finishEnrolledPending() {
    const current = await loadPending();
    if (!current?.enrolled || accepting) return;
    try {
      await serialized(async () => {
        if (pending !== current) return; // a Connect or Cancel got there first
        // Read the queue inside the lock: a Cancel that queued this device a moment ago is seen. Unreadable = not finished.
        const queued = typeof store.loadRevocations === "function" ? await store.loadRevocations({ strict: true }) : [];
        const cancelledDevice = queued.some((entry) => sameDevice(entry, current.enrolled));
        if (cancelledDevice) { pending = null; await store.clearPending?.(); } else await saveEnrolled(current);
      });
    } catch { /* kept sealed; tried again next time */ }
  }
  /** Every start and door open: finish an enrolled Connect, then remove the devices still queued for revocation. Never throws. */
  async function settleUnfinished() {
    await finishEnrolledPending();
    await retryRevocations();
  }
  async function healthWithRetry(state) {
    for (let attempt = 0; ; attempt++) {
      try { await checkHealth(state.record.publicOrigin, state.token); state.healthAt = now(); return; }
      catch (error) {
        if (error?.code !== "unreachable" || attempt >= healthRetryDelaysMs.length) throw error;
        await sleep(healthRetryDelaysMs[attempt]);
      }
    }
  }

  /** "Paste link": the same as the deep link arriving, except an https:// link or a murage://package link is refused at once. */
  async function pasteDoorLink(text) {
    const value = typeof text === "string" ? text.trim() : "";
    if (!value || value.length > MAX_LINK_LENGTH || /^https?:/i.test(value) || !parseDoorLink(value)) throw new CloudHomeError("bad-link", COPY.badLink);
    return acceptDoorLink(value);
  }

  /**
   * Silent reattach after sleep or when the network comes back: refresh the token through the existing path. Only a home that
   * says "revoked" (this computer was removed on My Cloud) makes it forget the record and show the Connect panel. A paused
   * account or any other refusal keeps the record, so the computer comes back by itself when the home lets it in again.
   */
  async function resume(homeId) {
    try {
      const state = await open(homeId);
      await ensureFresh(state, true);
      return { ok: true };
    } catch (error) {
      if (error?.code === "needs-repair" && error?.reason === "revoked") {
        const gone = sessions.get(homeId); if (gone?.timer) clearTimeout(gone.timer);
        sessions.delete(homeId); await serialized(() => store.remove(homeId)); revokedNotice = true;
        return { ok: false, disconnected: true, code: "disconnected", message: COPY.disconnected };
      }
      if (error?.code === "needs-repair" && error?.reason === "suspended") return { ok: false, code: "suspended", message: COPY.suspended };
      if (error?.code === "needs-repair") return { ok: false, code: "sign-in-refused", message: COPY.signInRefused };
      return { ok: false, code: error?.code ?? "unreachable", message: error instanceof CloudHomeError ? error.message : COPY.unreachable };
    }
  }

  /** "Disconnect this computer": revoke this device at the home (DELETE /api/cloud/devices/:id, native step-up as ever), then forget the record. */
  async function disconnect(homeId) {
    let state;
    try { state = await open(homeId); } catch (error) { if (error?.code === "not-paired") return { disconnected: true }; throw error; }
    const deviceId = state.record.deviceId;
    let revoked = false;
    try {
      const response = await fetchHome(homeId, `/api/cloud/devices/${encodeURIComponent(deviceId)}`, { method: "DELETE" });
      revoked = response.ok || response.status === 404;
    } catch (error) {
      if (error?.code === "needs-repair" && error?.reason === "revoked") revoked = true; // already revoked from My Cloud
      else throw error;
    }
    if (!revoked) throw new CloudHomeError("disconnect-failed", COPY.disconnectFailed);
    if (state.timer) clearTimeout(state.timer);
    sessions.delete(homeId); await serialized(() => store.remove(homeId));
    return { disconnected: true };
  }

  /** Reachability for the Cloud window's banner: verifies pin + version and refreshes the token. Never throws. */
  async function status(homeId) {
    try { await connect(homeId); return { ok: true }; }
    catch (error) { return { ok: false, code: error?.code ?? "unreachable", message: error instanceof CloudHomeError ? error.message : COPY.unreachable }; }
  }

  return {
    queuesWrites: false,
    listHomes, pairWithDeviceCode, mintDeviceCode, status, pairedHomes,
    startConnect, cancelConnect, connectStatus, acceptDoorLink, pasteDoorLink, resume, disconnect, settleUnfinished,
    fetch: fetchHome, stepUpRetry,
    /** For WP1's proxy, in main only. Verifies pin + version, refreshes when due, returns the Bearer token. */
    async getAccessToken(homeId) { return (await connect(homeId)).token; },
    /** Sync, from the pin. Null when the home is not loaded; call getAccessToken/connect first or use loadedOrigin. */
    homeOrigin(homeId) { return sessions.get(homeId)?.record.publicOrigin ?? null; },
    /** Async version that loads the pin from the store without touching the network. */
    async pinnedOrigin(homeId) { return (await open(homeId)).record.publicOrigin; },
    /** Forget a home on this computer (does not revoke the device on the home). */
    async unpair(homeId) { sessions.delete(homeId); await serialized(() => store.remove(homeId)); },
    /**
     * B3 WP5, main only: what a WebSocket upgrade to `path` ("/api/engine-login/codex?action=login") on a paired home
     * needs. Verifies the pin and version, refreshes the token, and runs the native step-up confirmation for GET `path`
     * (no body). The caller opens the socket; the token and step-up header go on that one upgrade request only.
     */
    async authorizeUpgrade(homeId, path) {
      if (typeof path !== "string" || !path.startsWith("/api/") || path.startsWith("//")) throw new TypeError("path must be an /api path on the home");
      const state = await connect(homeId);
      const origin = state.record.publicOrigin;
      const stepUp = await stepUpHeader(state, "GET", path, {});
      return { url: origin.replace(/^http/, "ws") + path, origin, headers: { authorization: `Bearer ${state.token}`, "x-murage-step-up": stepUp } };
    },
    /** Drop the in-memory token (sign-out, lock). The pin and keys stay. */
    /** Load the pin, verify it, fetch a token and keep it fresh in memory. Call once per home when the Cloud window opens. */
    async activate(homeId) { const state = await connect(homeId); state.active = true; arm(state); await retryRevocations(); },
    deactivate(homeId) { const state = sessions.get(homeId); if (state) { state.active = false; if (state.timer) clearTimeout(state.timer); state.token = null; state.tokenAt = 0; } },
    /** WP1's CloudHomeProvider: (homeId) => { homeId, origin, getAccessToken() (sync, memory only) } | null. Null until activate(). */
    provider(homeId) {
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(String(homeId))) return null;
      const state = sessions.get(homeId);
      return state?.active ? { homeId, origin: state.record.publicOrigin, getAccessToken: () => state.token } : null;
    },
    /** For the proxy's 401/403 hook: refresh once; true means the caller may retry once with provider().getAccessToken(). Step-up stays in fetch(). */
    async onAuthFailure(homeId) {
      const state = sessions.get(homeId); if (!state) return false;
      try { await ensureFresh(state, true); return true; } catch { return false; }
    },
    forgetTokens() { for (const state of sessions.values()) { state.token = null; state.tokenAt = 0; } },
  };
}
