// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Plan sign-in for ChatGPT and Grok, main process side.
//
// Flow drivers ported from Wayland's chatgptOAuth.ts and xaiOAuth.ts: bind a
// one-shot loopback listener on 127.0.0.1, open the system browser, check the
// CSRF state, swap the code at the pinned token endpoint. Grok also accepts a
// pasted code, because the xAI consent page sometimes shows one instead of
// redirecting (Wayland's XGrokButton paste box).
//
// Custody is Murage's own and is the part that differs from Wayland:
//  - Tokens live only in the OS-encrypted credential document, under
//    `modelSignIns`, written through the one serialized credential queue.
//  - Nothing here reads or writes ~/.codex/auth.json or ~/.grok/auth.json.
//    Wayland overwrote the Codex login file; that is not ported.
//  - One refresher per provider, in this process only. The refresh token is
//    persisted before the new access token is published to the server,
//    because xAI refresh tokens are single use (Wayland #391).
//  - Only the access token and display fields ever leave this process, over
//    the private utility-process port. Never logged.
import { CHATGPT_IDENTITY_HEADERS, SIGNIN_CONNECTION_IDS, SIGNIN_PROVIDERS, signInProviderEnabled } from "./model-signin-presets.mjs";
import {
  CHATGPT_REDIRECT_PATH, CHATGPT_REDIRECT_PORT, CHATGPT_REDIRECT_PORT_FALLBACK, CHATGPT_SCOPES, CHATGPT_TOKEN_URL,
  XAI_AUTHORIZE_URL_FALLBACK, XAI_DISCOVERY_URL, XAI_REDIRECT_PATH, XAI_SCOPES, XAI_TOKEN_URL_FALLBACK,
  CHATGPT_DEVICE_REDIRECT_URI, CHATGPT_DEVICE_TOKEN_URL, CHATGPT_DEVICE_USERCODE_URL, CHATGPT_DEVICE_VERIFY_URL, XAI_DEVICE_CODE_URL_FALLBACK,
  buildChatGptAuthorizeUrl, buildXaiAuthorizeUrl, chatgptRedirectUri, classifyTokenFailure, createPkce,
  isHeadlessEnvironment, isPinnedOpenAiAuthHttps, isPinnedXaiTokenUrl, parseRetryAfterMs, parseTokenResponse, parseXaiDeviceEndpoint, parseXaiDiscovery,
  pinnedXaiVerificationUrl, resolveClientId,
} from "./model-signin-oauth.mjs";
import { runLoopback } from "./oauth/loopback.mjs";

export const MODEL_SIGNIN_DOCUMENT_KEY = "modelSignIns";
const FLOW_TIMEOUT_MS = 3 * 60 * 1000;
const NET_TIMEOUT_MS = 20 * 1000;
const RETRY_MS = 60 * 1000;
const MIN_TIMER_MS = 30 * 1000;
const MAX_TIMER_MS = 2 ** 31 - 1;
const REACTIVE_COOLDOWN_MS = 30 * 1000;
const MAX_BACKOFF_MS = 15 * 60 * 1000;
const DEVICE_TIMEOUT_MS = 15 * 60 * 1000;
const DEVICE_MIN_INTERVAL_MS = 3 * 1000;
const DEVICE_MAX_POLL_FAILURES = 5;

const isProvider = value => SIGNIN_PROVIDERS.includes(value);
const text = (value, max = 8192) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\r\n\0]/.test(value);

/** The saved sign-ins, tolerating a missing or unreadable entry (it is then
 * treated as signed out; the credential document itself is never rewritten
 * from a partial read here). */
export function readSignInRecords(credentials) {
  const raw = credentials?.[MODEL_SIGNIN_DOCUMENT_KEY];
  if (typeof raw !== "string" || !raw) return {};
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return {}; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const records = {};
  for (const provider of SIGNIN_PROVIDERS) {
    const row = parsed[provider];
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    if (!text(row.revision, 100) || !["connected", "needs-sign-in"].includes(row.state)) continue;
    records[provider] = row;
  }
  return records;
}

/** What the server may hold: no refresh token, no id token. */
export function publicSignInEntries(records, env = process.env) {
  return SIGNIN_PROVIDERS.filter(provider => records[provider] && signInProviderEnabled(provider, env)).map(provider => {
    const row = records[provider];
    return {
      provider, connectionId: SIGNIN_CONNECTION_IDS[provider], revision: row.revision, state: row.state,
      ...(row.state === "connected" && text(row.accessToken) ? { accessToken: row.accessToken } : {}),
      ...(text(row.accountId, 200) ? { accountId: row.accountId } : {}),
      ...(typeof row.expiresAt === "number" ? { expiresAt: row.expiresAt } : {}),
      ...(text(row.email, 320) ? { email: row.email } : {}),
      ...(text(row.plan, 40) ? { plan: row.plan } : {}),
    };
  });
}

/**
 * @param {object} deps
 * @param {() => Record<string, unknown>} deps.readDocument latest credential document
 * @param {(derive: (c: Record<string, unknown>) => Record<string, unknown>) => Promise<unknown>} deps.updateDocument serialized encrypted write
 * @param {(entries: ReturnType<typeof publicSignInEntries>) => void} deps.publish hand tokens to the running server
 * @param {(url: string) => Promise<void>} deps.openExternal
 * @param {() => import("node:http").Server} deps.createServer
 * @param {typeof fetch} [deps.fetch]
 * @param {(message: string) => void} [deps.log] never receives a secret
 */
export function createModelSignIn(deps) {
  const fetcher = deps.fetch ?? fetch;
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimeout ?? setTimeout;
  const clearTimer = deps.clearTimeout ?? clearTimeout;
  const randomId = deps.randomId;
  const log = deps.log ?? (() => {});
  const flows = new Map();      // provider -> { finish(outcome), manual?(code) }
  const timers = new Map();     // provider -> timer
  const refreshing = new Map(); // provider -> refresh or persistence retry Promise<boolean>
  const lastReactive = new Map();
  const failures = new Map();     // provider -> consecutive refresh failures that kept the sign-in
  const backoffUntil = new Map(); // provider -> time before which no reactive refresh is sent
  // A refreshed bundle whose save failed. Held in memory (and used for the
  // next refresh) until a save succeeds, because the old refresh token may
  // already be spent: xAI refresh tokens are single use.
  const unsaved = new Map();
  const saveTimers = new Map();   // provider -> pending persistence retry
  const unsavedFrom = new WeakMap(); // unsaved pair -> the committed refresh token it replaced
  // Per-provider sign-in generation. A start, a cancel and a sign-out each
  // bump it before any async work, and the credential write checks it inside
  // the serialized update, so a superseded flow can never overwrite a newer one.
  const generations = new Map();
  const nextGeneration = provider => { const gen = (generations.get(provider) ?? 0) + 1; generations.set(provider, gen); return gen; };
  const isCurrent = (provider, gen) => generations.get(provider) === gen;
  let disposed = false;

  /** Committed credentials only: this is what is published and shown. */
  const records = () => readSignInRecords(deps.readDocument());
  /** What the refresher itself works from: committed, or a rotated pair whose
   * save is still being retried (the old refresh token may already be spent). */
  const refreshRecord = provider => {
    const saved = records()[provider];
    const pending = unsaved.get(provider);
    if (pending && saved?.revision === pending.revision) return pending;
    unsaved.delete(provider);
    return saved;
  };
  const publish = () => {
    try { deps.publish(publicSignInEntries(records(), env)); }
    catch (error) { log(`plan sign-in publish failed: ${error?.message ?? "unknown"}`); }
  };

  async function fetchWithTimeout(url, init) {
    const signal = AbortSignal.timeout(NET_TIMEOUT_MS);
    return fetcher(url, { ...init, signal, redirect: "error" });
  }

  /** POST a token form to a pinned endpoint. Never throws. */
  async function postToken(provider, tokenUrl, form) {
    const pinned = provider === "chatgpt" ? isPinnedOpenAiAuthHttps(tokenUrl) : isPinnedXaiTokenUrl(tokenUrl);
    if (!pinned) return { failure: "retry", error: "unknown" };
    let response;
    try {
      response = await fetchWithTimeout(tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", ...(provider === "chatgpt" ? CHATGPT_IDENTITY_HEADERS : {}) }, body: form.toString() });
    } catch { return { failure: "retry", error: "offline" }; }
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    if (!response.ok) {
      const failure = classifyTokenFailure(response.status, body);
      const retryAfterMs = parseRetryAfterMs(response.headers?.get?.("retry-after") ?? undefined, now());
      return { failure, error: failure === "retry" ? "unknown" : "unauthorized", ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
    }
    const tokens = parseTokenResponse(provider, body, now());
    return tokens ? { tokens } : { failure: "retry", error: "unknown" };
  }

  async function xaiEndpoints() {
    const fallback = { authorizeUrl: XAI_AUTHORIZE_URL_FALLBACK, tokenUrl: XAI_TOKEN_URL_FALLBACK, deviceUrl: XAI_DEVICE_CODE_URL_FALLBACK };
    try {
      const response = await fetchWithTimeout(XAI_DISCOVERY_URL, { method: "GET", headers: { accept: "application/json" } });
      if (!response.ok) return fallback;
      const doc = await response.json();
      const parsed = parseXaiDiscovery(doc);
      return parsed ? { ...parsed, deviceUrl: parseXaiDeviceEndpoint(doc) } : fallback;
    } catch { return fallback; }
  }

  /** Loopback authorize (the shared listener, electron/oauth/loopback.mjs).
   * Resolves {code, redirectUri} or {error}. The listener is always closed
   * before this resolves. */
  async function authorize(provider, gen, pkce, buildUrl, manual) {
    const chatgpt = provider === "chatgpt";
    let redirectUri = "", flow = null;
    const outcome = await runLoopback({
      createServer: deps.createServer,
      path: chatgpt ? CHATGPT_REDIRECT_PATH : XAI_REDIRECT_PATH,
      ports: chatgpt ? [CHATGPT_REDIRECT_PORT, CHATGPT_REDIRECT_PORT_FALLBACK] : [0],
      state: pkce.state,
      timeoutMs: FLOW_TIMEOUT_MS,
      setTimeout: setTimer,
      clearTimeout: clearTimer,
      register: ({ finish }) => {
        if (!isCurrent(provider, gen)) { finish({ error: "cancelled" }); return; }
        flow = { finish, ...(manual ? { manual: code => finish({ code }) } : {}) };
        flows.set(provider, flow);
      },
      onSettled: () => { if (flows.get(provider) === flow) flows.delete(provider); },
      onListening: async (port) => {
        redirectUri = chatgpt ? chatgptRedirectUri(port) : `http://127.0.0.1:${port}${XAI_REDIRECT_PATH}`;
        await deps.openExternal(buildUrl(redirectUri));
      },
    });
    return outcome.error ? { error: outcome.error, redirectUri } : { code: outcome.code, redirectUri };
  }

  const SUPERSEDED = Symbol("superseded");
  /** Commit one provider's record through the serialized credential queue.
   * `fence`, when given, is checked a second time AFTER the encrypted write
   * and before the commit is accepted (the queue's second phase): if it is
   * false then, the queue restores the previous document, so a cancel, a
   * sign-out or a newer sign-in that landed during the encryption wins and
   * nothing superseded is ever left connected or published. */
  async function persist(provider, derive, fence) {
    let kept = null;
    try {
      await deps.updateDocument(credentials => {
        kept = null;
        const all = readSignInRecords(credentials);
        const next = derive(all[provider] ?? null);
        if (next === undefined) return credentials; // nothing to change
        if (next === null) delete all[provider]; else all[provider] = next;
        kept = next;
        return { ...credentials, [MODEL_SIGNIN_DOCUMENT_KEY]: JSON.stringify(all) };
      }, fence ? () => { if (kept && !fence()) throw SUPERSEDED; } : undefined);
    } catch (error) {
      if (error === SUPERSEDED) return null;
      throw error;
    }
    return kept;
  }

  function schedule(provider) {
    const previous = timers.get(provider);
    if (previous) clearTimer(previous);
    timers.delete(provider);
    if (disposed) return;
    const row = records()[provider];
    if (!row || row.state !== "connected" || !row.refreshToken) return;
    const remainingBackoff = (backoffUntil.get(provider) ?? 0) - now();
    if (typeof row.expiresAt !== "number" && remainingBackoff <= 0) return;
    // Never earlier than the back-off deadline: a reschedule keeps it.
    const delay = Math.min(MAX_TIMER_MS, Math.max(MIN_TIMER_MS, typeof row.expiresAt === "number" ? row.expiresAt - 5 * 60 * 1000 - now() : 0, remainingBackoff));
    const timer = setTimer(() => { timers.delete(provider); void refresh(provider); }, delay);
    timer?.unref?.();
    timers.set(provider, timer);
  }

  function saveUnsavedLater(provider) {
    if (disposed || saveTimers.has(provider)) return;
    const timer = setTimer(() => {
      // Join the entire refresh, including its failed-write bookkeeping, then
      // read the pending pair. New refreshes also join this persistence retry.
      const work = Promise.resolve(refreshing.get(provider)).then(async () => {
        saveTimers.delete(provider);
        if (disposed) return false;
        const row = unsaved.get(provider);
        if (!row) return false;
        const from = unsavedFrom.get(row);
        try {
          // Checked inside the queue against the pair and predecessor that
          // are current after the provider operation has settled.
          const kept = await persist(provider, current => current?.revision === row.revision && unsaved.get(provider) === row && current.refreshToken === from ? row : undefined);
          if (unsaved.get(provider) === row) unsaved.delete(provider);
          // Publish only committed credentials and retain the vendor deadline.
          if (kept) { publish(); schedule(provider); }
          return Boolean(kept);
        } catch { saveUnsavedLater(provider); return false; }
      }).finally(() => { if (refreshing.get(provider) === work) refreshing.delete(provider); });
      refreshing.set(provider, work);
      return work;
    }, RETRY_MS);
    timer?.unref?.();
    saveTimers.set(provider, timer);
  }

  /** Try again later, backing off while the vendor keeps refusing: a minute,
   * then doubling to fifteen, or the vendor's Retry-After when it is longer (the fifteen-minute cap
   * applies to our own doubling only, never to what the vendor asked for).
   * The saved sign-in is never touched. */
  function retryLater(provider, retryAfterMs) {
    const previous = timers.get(provider);
    if (previous) clearTimer(previous);
    if (disposed) return;
    const count = failures.get(provider) ?? 0;
    failures.set(provider, count + 1);
    // The deadline keeps the vendor's whole wait; only the timer is chunked to
    // what a timer can hold (refresh() re-arms itself while the deadline stands).
    const delay = Math.max(Math.min(MAX_BACKOFF_MS, RETRY_MS * 2 ** count), retryAfterMs ?? 0);
    backoffUntil.set(provider, now() + delay);
    const timer = setTimer(() => { timers.delete(provider); void refresh(provider); }, Math.min(MAX_TIMER_MS, delay));
    timer?.unref?.();
    timers.set(provider, timer);
  }

  async function start(provider) {
    if (!isProvider(provider)) return { ok: false, error: "unknown" };
    if (!signInProviderEnabled(provider, env)) return { ok: false, error: "disabled" };
    if (isHeadlessEnvironment(platform, env)) return { ok: false, error: "headless" };
    const gen = nextGeneration(provider);
    flows.get(provider)?.finish({ error: "cancelled" });
    try {
      const clientId = resolveClientId(provider, env);
      const pkce = createPkce(provider);
      let tokenUrl = CHATGPT_TOKEN_URL, outcome;
      if (provider === "chatgpt") {
        outcome = await authorize(provider, gen, pkce, redirectUri => buildChatGptAuthorizeUrl({ clientId, challenge: pkce.challenge, state: pkce.state, redirectUri }), false);
      } else {
        const endpoints = await xaiEndpoints();
        if (!isCurrent(provider, gen)) return { ok: false, error: "cancelled" };
        tokenUrl = endpoints.tokenUrl;
        outcome = await authorize(provider, gen, pkce, redirectUri => buildXaiAuthorizeUrl(endpoints.authorizeUrl, { clientId, challenge: pkce.challenge, state: pkce.state, redirectUri }), true);
      }
      if (outcome.error) return { ok: false, error: outcome.error };
      const exchanged = await postToken(provider, tokenUrl, new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code: outcome.code, code_verifier: pkce.verifier, redirect_uri: outcome.redirectUri }));
      if (!exchanged.tokens) return { ok: false, error: exchanged.error };
      return await completeSignIn(provider, gen, clientId, tokenUrl, exchanged.tokens);
    } catch {
      return { ok: false, error: "unknown" };
    }
  }

  /** Save a fresh sign-in (either flow) and hand it to the server. */
  async function completeSignIn(provider, gen, clientId, tokenUrl, tokens) {
    {
      // Without the account id the ChatGPT backend refuses every request.
      if (provider === "chatgpt" && !tokens.accountId) return { ok: false, error: "unauthorized" };
      const record = {
        state: "connected", revision: randomId(), clientId, tokenUrl, savedAt: now(),
        accessToken: tokens.accessToken,
        ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
        ...(tokens.idToken ? { idToken: tokens.idToken } : {}),
        ...(typeof tokens.expiresAt === "number" ? { expiresAt: tokens.expiresAt } : {}),
        ...(tokens.accountId ? { accountId: tokens.accountId } : {}),
        ...(tokens.plan ? { plan: tokens.plan } : {}),
        ...(tokens.email ? { email: tokens.email } : {}),
      };
      let kept;
      try { kept = await persist(provider, () => (isCurrent(provider, gen) ? record : undefined), () => isCurrent(provider, gen)); }
      catch { return { ok: false, error: "storage" }; }
      // Cancelled, signed out or superseded while the exchange was in flight.
      if (!kept) return { ok: false, error: "cancelled" };
      unsaved.delete(provider);
      failures.delete(provider); backoffUntil.delete(provider);
      publish();
      schedule(provider);
      return { ok: true, ...(record.email ? { email: record.email } : {}), ...(record.plan ? { plan: record.plan } : {}) };
    }
  }

  // ── Device-code sign-in: no browser on this machine ─────────────────────
  // The user opens a page on any device, types the short code, and this side
  // polls until the vendor says yes. ChatGPT: the Codex CLI's device flow.
  // Grok: RFC 8628 against auth.x.ai. Same custody and refresher afterwards.
  async function deviceRequest(url, { json, form, identity }) {
    const headers = { accept: "application/json", "content-type": json ? "application/json" : "application/x-www-form-urlencoded", ...(identity ? CHATGPT_IDENTITY_HEADERS : {}) };
    let response;
    try { response = await fetchWithTimeout(url, { method: "POST", headers, body: json ? JSON.stringify(json) : form.toString() }); }
    catch { return { offline: true }; }
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    const retryAfterMs = parseRetryAfterMs(response.headers?.get?.("retry-after") ?? undefined, now());
    return { ok: response.ok, status: response.status, body, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
  }

  function deviceSleep(flow, ms) {
    return new Promise(resolve => {
      const timer = setTimer(() => { flow.wake = null; resolve(); }, ms);
      timer?.unref?.();
      flow.wake = () => { clearTimer(timer); flow.wake = null; resolve(); };
    });
  }

  // The vendor's interval is a floor on how often we may poll: it is never
  // shortened, only lengthened (to our own 3 s minimum, or by slow_down).
  const deviceInterval = (seconds, fallbackMs) => {
    const ms = Number(seconds) * 1000;
    return Math.max(DEVICE_MIN_INTERVAL_MS, Number.isFinite(ms) && ms > 0 ? ms : fallbackMs);
  };

  /** Poll until `step` returns a result. `step` gets the poll and answers
   * {done}, {wait: ms?} to keep going, or {error}. */
  async function devicePoll(flow, intervalMs, deadline, poll, step) {
    let interval = intervalMs, bad = 0, vendorWait = 0;
    while (now() < deadline) {
      // Never sleep past the code's lifetime, and never poll after it. A
      // Retry-After on the last answer lengthens this wait, never shortens it.
      await deviceSleep(flow, Math.min(Math.max(interval, vendorWait), Math.max(0, deadline - now())));
      vendorWait = 0;
      if (flow.cancelled) return { error: "cancelled" };
      if (now() >= deadline) break;
      const reply = await poll();
      if (flow.cancelled) return { error: "cancelled" };
      if (now() >= deadline) break; // a late answer is not accepted
      if (reply.offline || reply.status >= 500 || reply.status === 429) {
        if (++bad >= DEVICE_MAX_POLL_FAILURES) return { error: "offline" };
        if (reply.status === 429) interval *= 2;
        vendorWait = reply.retryAfterMs ?? 0;
        continue;
      }
      bad = 0;
      const outcome = step(reply);
      if (outcome.error || outcome.done) return outcome;
      if (outcome.slowDown) interval += 5000;
    }
    return { error: "timeout" };
  }

  async function chatgptDeviceGrant(flow, clientId) {
    const started = await deviceRequest(CHATGPT_DEVICE_USERCODE_URL, { json: { client_id: clientId }, identity: true });
    if (started.offline) return { error: "offline" };
    if (!started.ok) return { error: "unknown" };
    const deviceAuthId = started.body?.device_auth_id, userCode = started.body?.user_code ?? started.body?.usercode;
    if (!text(deviceAuthId, 500) || !text(userCode, 100)) return { error: "unknown" };
    flow.device = { userCode, verificationUrl: CHATGPT_DEVICE_VERIFY_URL };
    const outcome = await devicePoll(flow, deviceInterval(started.body?.interval, 5000), now() + DEVICE_TIMEOUT_MS,
      () => deviceRequest(CHATGPT_DEVICE_TOKEN_URL, { json: { device_auth_id: deviceAuthId, user_code: userCode }, identity: true }),
      reply => {
        if (reply.ok) return text(reply.body?.authorization_code, 4096) && text(reply.body?.code_verifier, 512) ? { done: reply.body } : { error: "unknown" };
        // 403 and 404 both mean "not approved yet".
        return reply.status === 403 || reply.status === 404 ? {} : { error: "unauthorized" };
      });
    if (!outcome.done) return outcome;
    const exchanged = await postToken("chatgpt", CHATGPT_TOKEN_URL, new URLSearchParams({
      grant_type: "authorization_code", client_id: clientId, code: outcome.done.authorization_code,
      code_verifier: outcome.done.code_verifier, redirect_uri: CHATGPT_DEVICE_REDIRECT_URI,
    }));
    return exchanged.tokens ? { tokens: exchanged.tokens, tokenUrl: CHATGPT_TOKEN_URL } : { error: exchanged.error };
  }

  async function xaiDeviceGrant(flow, clientId) {
    const endpoints = await xaiEndpoints();
    if (!isPinnedXaiTokenUrl(endpoints.deviceUrl) || !isPinnedXaiTokenUrl(endpoints.tokenUrl)) return { error: "unknown" };
    const started = await deviceRequest(endpoints.deviceUrl, { form: new URLSearchParams({ client_id: clientId, scope: XAI_SCOPES }) });
    if (started.offline) return { error: "offline" };
    if (!started.ok) return { error: "unknown" };
    const { device_code: deviceCode, user_code: userCode } = started.body ?? {};
    const verificationUrl = pinnedXaiVerificationUrl(started.body?.verification_uri_complete, started.body?.verification_uri);
    if (!text(deviceCode, 2000) || !text(userCode, 100) || !verificationUrl) return { error: "unknown" };
    flow.device = { userCode, verificationUrl };
    const expiresIn = Number(started.body?.expires_in);
    const lifetime = Number.isFinite(expiresIn) && expiresIn > 0 ? Math.min(expiresIn * 1000, DEVICE_TIMEOUT_MS) : DEVICE_TIMEOUT_MS;
    const outcome = await devicePoll(flow, deviceInterval(started.body?.interval, 5000), now() + lifetime,
      () => deviceRequest(endpoints.tokenUrl, { form: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: clientId, device_code: deviceCode }) }),
      reply => {
        if (reply.ok) {
          const tokens = parseTokenResponse("supergrok", reply.body, now());
          // A sign-in with no refresh token would end within hours.
          return tokens?.refreshToken ? { done: tokens } : { error: "unknown" };
        }
        const code = String(reply.body?.error ?? "");
        if (code === "authorization_pending") return {};
        if (code === "slow_down") return { slowDown: true };
        return { error: code === "expired_token" ? "timeout" : "unauthorized" };
      });
    return outcome.done ? { tokens: outcome.done, tokenUrl: endpoints.tokenUrl } : outcome;
  }

  async function startDevice(provider) {
    if (!isProvider(provider)) return { ok: false, error: "unknown" };
    if (!signInProviderEnabled(provider, env)) return { ok: false, error: "disabled" };
    const gen = nextGeneration(provider);
    flows.get(provider)?.finish({ error: "cancelled" });
    const flow = { cancelled: false, wake: null, device: null, finish() { this.cancelled = true; this.wake?.(); } };
    flows.set(provider, flow);
    try {
      const clientId = resolveClientId(provider, env);
      const grant = provider === "chatgpt" ? await chatgptDeviceGrant(flow, clientId) : await xaiDeviceGrant(flow, clientId);
      if (flow.cancelled || !isCurrent(provider, gen)) return { ok: false, error: "cancelled" };
      if (!grant.tokens) return { ok: false, error: grant.error ?? "unknown" };
      return await completeSignIn(provider, gen, clientId, grant.tokenUrl, grant.tokens);
    } catch {
      return { ok: false, error: "unknown" };
    } finally {
      if (flows.get(provider) === flow) flows.delete(provider);
    }
  }

  /** Single flight per provider. Resolves true when a fresh token was published. */
  function refresh(provider, { reactive = false } = {}) {
    if (!isProvider(provider)) return Promise.resolve(false);
    const running = refreshing.get(provider);
    if (running) return running;
    // The back-off deadline holds for every entry point: the gateway, the
    // timer, and resume() after a server restart.
    const remainingBackoff = (backoffUntil.get(provider) ?? 0) - now();
    if (remainingBackoff > 0) {
      if (!reactive && !disposed && !timers.has(provider)) {
        const timer = setTimer(() => { timers.delete(provider); void refresh(provider); }, Math.min(MAX_TIMER_MS, remainingBackoff));
        timer?.unref?.();
        timers.set(provider, timer);
      }
      return Promise.resolve(false);
    }
    if (reactive) {
      const last = lastReactive.get(provider) ?? 0;
      if (now() - last < REACTIVE_COOLDOWN_MS) return Promise.resolve(false);
      lastReactive.set(provider, now());
    }
    const work = (async () => {
      const row = refreshRecord(provider);
      if (!row || row.state !== "connected") return false;
      const markDead = async () => {
        const fromUnsaved = unsaved.get(provider)?.refreshToken === row.refreshToken;
        unsaved.delete(provider);
        await persist(provider, current => current?.revision === row.revision && (current.refreshToken === row.refreshToken || fromUnsaved)
          ? { state: "needs-sign-in", revision: current.revision, savedAt: now(), ...(current.email ? { email: current.email } : {}), ...(current.plan ? { plan: current.plan } : {}), ...(current.clientId ? { clientId: current.clientId } : {}) }
          : undefined);
        publish();
        return false;
      };
      if (!row.refreshToken) return markDead();
      const clientId = text(row.clientId, 200) ? row.clientId : resolveClientId(provider, env);
      const tokenUrl = provider === "chatgpt" ? CHATGPT_TOKEN_URL : isPinnedXaiTokenUrl(row.tokenUrl) ? row.tokenUrl : XAI_TOKEN_URL_FALLBACK;
      const result = await postToken(provider, tokenUrl, new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: row.refreshToken, scope: provider === "chatgpt" ? CHATGPT_SCOPES : XAI_SCOPES }));
      if (!result.tokens) {
        if (result.failure === "dead") return markDead();
        retryLater(provider, result.retryAfterMs);
        return false;
      }
      const tokens = result.tokens;
      // Persist BEFORE publish: the old refresh token may already be dead.
      // A sign-out or a new sign-in that landed meanwhile wins.
      const next = { ...row, state: "connected", savedAt: now(), accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? row.refreshToken,
        ...(tokens.idToken ? { idToken: tokens.idToken } : {}),
        ...(typeof tokens.expiresAt === "number" ? { expiresAt: tokens.expiresAt } : {}),
        ...(tokens.accountId ? { accountId: tokens.accountId } : {}),
        ...(tokens.plan ? { plan: tokens.plan } : {}),
        ...(tokens.email ? { email: tokens.email } : {}) };
      const wasUnsaved = unsaved.get(provider)?.refreshToken === row.refreshToken;
      let saved;
      try {
        saved = await persist(provider, current => current?.revision === row.revision && (current.refreshToken === row.refreshToken || wasUnsaved) ? next : undefined);
        if (saved) unsaved.delete(provider);
      } catch {
        // The vendor already rotated, so keep the new pair privately and retry
        // the save. It is NOT published until it is committed: a restart before
        // then must find the disk and the server agreeing on the same pair.
        if (refreshRecord(provider)?.revision !== row.revision) return false;
        unsavedFrom.set(next, records()[provider]?.refreshToken);
        unsaved.set(provider, next);
        saveUnsavedLater(provider);
        return false;
      }
      if (!saved) return false;
      failures.delete(provider); backoffUntil.delete(provider);
      publish();
      schedule(provider);
      return true;
    })().catch(() => { retryLater(provider); return false; }).finally(() => { if (refreshing.get(provider) === work) refreshing.delete(provider); });
    refreshing.set(provider, work);
    return work;
  }

  return {
    start,
    startDevice,
    refresh,
    cancel(provider) {
      if (isProvider(provider)) nextGeneration(provider); // also kills a flow that is mid-exchange
      const flow = flows.get(provider);
      if (!flow) return false;
      flow.finish({ error: "cancelled" });
      return true;
    },
    /** Grok only: finish the waiting flow with a code pasted from the x.ai page. */
    submitCode(provider, code) {
      const trimmed = typeof code === "string" ? code.trim() : "";
      const flow = flows.get(provider);
      if (!flow?.manual || !trimmed || trimmed.length > 4096 || /[\s\0]/.test(trimmed)) return false;
      flow.manual(trimmed);
      return true;
    },
    async signOut(provider) {
      if (!isProvider(provider)) return false;
      nextGeneration(provider);
      flows.get(provider)?.finish({ error: "cancelled" });
      const saveTimer = saveTimers.get(provider);
      if (saveTimer) clearTimer(saveTimer);
      saveTimers.delete(provider);
      const timer = timers.get(provider);
      if (timer) clearTimer(timer);
      timers.delete(provider);
      await refreshing.get(provider)?.catch(() => false);
      unsaved.delete(provider);
      await persist(provider, () => null);
      publish();
      return true;
    },
    status() {
      const saved = records();
      return SIGNIN_PROVIDERS.map(provider => {
        const row = saved[provider];
        return {
          provider, enabled: signInProviderEnabled(provider, env),
          state: flows.has(provider) ? "waiting" : row?.state ?? "signed-out",
          acceptsCode: Boolean(flows.get(provider)?.manual),
          ...(flows.get(provider)?.device ? { device: { ...flows.get(provider).device } } : {}),
          ...(text(row?.email, 320) ? { email: row.email } : {}),
          ...(text(row?.plan, 40) ? { plan: row.plan } : {}),
        };
      });
    },
    /** Push every saved sign-in to a freshly started server, then refresh
     * anything that expired while Murage was closed. */
    resume() {
      publish();
      const saved = records();
      for (const provider of SIGNIN_PROVIDERS) {
        const row = saved[provider];
        if (row?.state !== "connected" || !signInProviderEnabled(provider, env)) continue;
        if (typeof row.expiresAt === "number" && row.expiresAt - 5 * 60 * 1000 <= now()) void refresh(provider);
        else schedule(provider);
      }
    },
    dispose() {
      disposed = true;
      for (const flow of [...flows.values()]) flow.finish({ error: "cancelled" });
      for (const timer of [...timers.values(), ...saveTimers.values()]) clearTimer(timer);
      timers.clear(); saveTimers.clear();
    },
  };
}
