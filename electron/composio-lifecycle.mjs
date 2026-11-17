// Owners: composio-429-e owns both the runtime authority and its request consumers.
// All lifecycle transports are private. Callers can submit intents, never an
// executable callback, an admission exemption, or a caller-selected scope.
import { FLUX_BROKER_TOKEN, FLUX_BROKER_TOKEN_REMINT_WINDOW_MS, brokerTokenFingerprint, fluxKeyFingerprint, clearFluxComposioBrokerToken, sha256Hex } from "./flux-composio-token.mjs";
import { readComposioCustody, normalizeManagedComposioBrokerUrl, readComposioLegacyClaim, writeComposioLegacyClaim } from "./managed-composio.mjs";
import { COMPOSIO_ADMISSION_NAMESPACE as ADMISSION_NAMESPACE } from "./composio-release-config.mjs";
import { LEGACY_CLAIM_AUDIENCE } from "./composio-legacy-claim.mjs";
import { isFluxKeyShape } from "./provider-connections.mjs";
const ERROR_CODE = /^[a-z_]{1,64}$/;
/** Best effort: a revoked or unreachable token is fine either way. */
async function revokeFluxComposioBrokerToken({
  fluxBrokerUrl,
  token,
  fetchImpl = globalThis.fetch,
  timeoutSignal = (milliseconds) => AbortSignal.timeout(milliseconds),
}) {
  const url = normalizeManagedComposioBrokerUrl(fluxBrokerUrl);
  if (!url || !FLUX_BROKER_TOKEN.test(token ?? "")) return false;
  try {
    const response = await fetchImpl(`${url}/v1/tokens/current`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
      signal: timeoutSignal(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Mint or keep the broker token. Returns the next credentials document (a
 * copy) and never throws: this is optional background work. */
async function ensureFluxComposioBrokerToken({
  fluxBrokerUrl,
  credentials,
  fluxKey,
  fetchImpl = globalThis.fetch,
  log = () => {},
  timeoutSignal = (milliseconds) => AbortSignal.timeout(milliseconds),
  now = Date.now(),
  force = false,
  rejectedTokenFingerprint,
  onRateLimited = () => {},
  onTransientFailure = () => {},
  onMinted = () => {},
  /** When given, the previous token is NOT revoked here: it is queued as
   * `{ fluxBrokerUrl, previous, minted }` for the caller to settle once the
   * new document is saved (revoke `previous` if it was, `minted` if it was
   * discarded), so a discarded result cannot orphan a token. */
  revokeSink,
  label = "murage-desktop",
}) {
  const url = normalizeManagedComposioBrokerUrl(fluxBrokerUrl);
  const next = { ...credentials };
  if (!url) return next;
  // Only a Flux key is ever sent to Flux. A base URL, a short value or another
  // provider's key in the Flux slot is treated as no key at all (2026-10-01:
  // an install sent an sk- key Flux never issued here every ten minutes).
  const key = typeof fluxKey === "string" && isFluxKeyShape(fluxKey) ? fluxKey.trim() : "";
  const previousToken = FLUX_BROKER_TOKEN.test(next.fluxComposioBrokerToken ?? "") ? next.fluxComposioBrokerToken : null;
  if (!key) {
    // The key is gone: the token it minted goes with it. Revoke it at Flux so
    // it stops working immediately rather than at its expiry.
    if (previousToken) await revokeFluxComposioBrokerToken({ fluxBrokerUrl: url, token: previousToken, fetchImpl, timeoutSignal });
    return clearFluxComposioBrokerToken(next);
  }
  const fingerprint = fluxKeyFingerprint(key);
  // A forced re-mint is only for the token that was actually rejected. A
  // straggler naming a token that has since been replaced (several calls in
  // one turn all got the same 401) must not mint again.
  if (force && rejectedTokenFingerprint && previousToken && brokerTokenFingerprint(previousToken) !== rejectedTokenFingerprint) {
    force = false;
  }
  // A token minted by a different key belongs to another account. Whatever
  // happens to the new mint, it must never be handed on as this key's token.
  const storedFingerprint = next.fluxComposioBrokerTokenKeyFingerprint;
  const staleToken = Boolean(previousToken) && typeof storedFingerprint === "string" && storedFingerprint !== fingerprint;
  const withoutStale = async (document) => {
    if (!staleToken || document.fluxComposioBrokerTokenKeyFingerprint !== storedFingerprint || document.fluxComposioBrokerToken !== previousToken) return document;
    // Best effort: end the old account's token at Flux too, as a key removal does.
    await revokeFluxComposioBrokerToken({ fluxBrokerUrl: url, token: previousToken, fetchImpl, timeoutSignal });
    const kept = { fluxComposioTokenError: document.fluxComposioTokenError, fluxComposioTokenRefusedKeyFingerprint: document.fluxComposioTokenRefusedKeyFingerprint };
    const cleared = clearFluxComposioBrokerToken(document);
    for (const [field, value] of Object.entries(kept)) if (value !== undefined) cleared[field] = value;
    return cleared;
  };
  // Flux refused this exact key before: do not ask again until it changes.
  if (!force && next.fluxComposioTokenRefusedKeyFingerprint === fingerprint) return await withoutStale(next);
  const expiresAt = Date.parse(next.fluxComposioBrokerTokenExpiresAt ?? "");
  if (
    !force
    && previousToken
    && next.fluxComposioBrokerTokenKeyFingerprint === fingerprint
    && Number.isFinite(expiresAt)
    && expiresAt - now > FLUX_BROKER_TOKEN_REMINT_WINDOW_MS
  ) return next;

  let response;
  try {
    response = await fetchImpl(`${url}/v1/tokens`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ label }),
      redirect: "error",
      signal: timeoutSignal(15_000),
    });
  } catch (error) {
    log(`FluxRouter connected-apps token request failed: ${error?.name === "TimeoutError" ? "timed out" : "network error"}`);
    onTransientFailure();
    return await withoutStale(next);
  }
  const body = await response.json().catch(() => null);
  if (response.ok) {
    const kind = body?.accountKind === "personal" ? "personal" : "shared";
    if (!FLUX_BROKER_TOKEN.test(body?.token ?? "") || !Number.isFinite(Date.parse(body?.expiresAt ?? ""))) {
      log("FluxRouter returned an invalid connected-apps token");
      onTransientFailure();
      return await withoutStale(next);
    }
    next.fluxComposioBrokerToken = body.token;
    next.fluxComposioBrokerTokenExpiresAt = new Date(Date.parse(body.expiresAt)).toISOString();
    next.fluxComposioBrokerTokenKeyFingerprint = fingerprint;
    next.fluxComposioAccountKind = kind;
    delete next.fluxComposioTokenError;
    delete next.fluxComposioTokenRefusedKeyFingerprint;
    onMinted({ token: body.token, forced: force });
    if (previousToken !== body.token) {
      // Mint first, then end THIS install's own previous token (never another
      // device's: it is the one this document held), so the app is never
      // tokenless and a renewal does not leave two live tokens counting
      // against the account's cap. Best effort: it may already be dead.
      if (revokeSink) revokeSink.push({ fluxBrokerUrl: url, previous: previousToken, minted: body.token });
      else if (previousToken) await revokeFluxComposioBrokerToken({ fluxBrokerUrl: url, token: previousToken, fetchImpl, timeoutSignal });
    }
    log("FluxRouter connected-apps token ready");
    return next;
  }
  if (response.status === 401 || response.status === 403) next.fluxComposioTokenRefusedKeyFingerprint = fingerprint;
  if ([401, 402, 403].includes(response.status) && typeof body?.code === "string" && ERROR_CODE.test(body.code)) {
    // Keep a token this key minted: data routes never consult the key's model
    // budget, so a token minted before the budget ran out keeps working.
    next.fluxComposioTokenError = body.code;
    log(`FluxRouter declined a connected-apps token (${body.code})`);
    return await withoutStale(next);
  }
  if (response.status === 429) onRateLimited(response.headers.get("retry-after") ?? undefined);
  else if (response.status >= 500 || response.status === 408 || response.status === 404) onTransientFailure(response.headers.get("retry-after") ?? undefined);
  log(`FluxRouter connected-apps token request returned HTTP ${response.status}`);
  return await withoutStale(next);
}

const TOKEN = /^[0-9a-f]{64}$/;
const CODE = /^[a-z_]{1,64}$/;
const TERMINAL_FLUX_CONFLICTS = new Set(["account_already_claimed", "account_has_connections", "install_already_claimed"]);

function codeOf(body) {
  return typeof body?.code === "string" && CODE.test(body.code) ? body.code : undefined;
}

async function readJson(response) {
  return response.json().catch(() => null);
}

function claimPreconditions(credentials, claim) {
  if (!TOKEN.test(credentials.composioBrokerToken ?? "")) return false;
  if (!FLUX_BROKER_TOKEN.test(credentials.fluxComposioBrokerToken ?? "")) return false;
  if (typeof credentials.composioInstallationId !== "string" || !credentials.composioInstallationId) return false;
  if (claim.state === "conflict" || claim.state === "abandoned") return false;
  if (claim.state === "claimed" && !claim.confirmPending) return false;
  return true;
}

function transition(credentials, previous, patch, nowIso) {
  const claim = {
    installationId: credentials.composioInstallationId ?? previous.installationId,
    ...patch,
    at: patch.state === previous.state ? previous.at ?? nowIso : nowIso,
    lastAttemptAt: nowIso,
  };
  for (const key of Object.keys(claim)) if (claim[key] === undefined) delete claim[key];
  return writeComposioLegacyClaim(credentials, claim);
}

function abandon(credentials, previous, nowIso) {
  // The Worker says this install token is gone (absent or disabled row): the
  // one definitive legacy answer. Drop it, as the Worker-only app always has.
  const next = transition(credentials, previous, { state: "abandoned", code: "legacy_token_rejected" }, nowIso);
  delete next.composioBrokerToken;
  delete next.composioInstallationId;
  return next;
}

async function remintAfterRevocation(credentials, { fluxBrokerUrl, fluxKey, fetchImpl, log, timeoutSignal, now, revokeSink, onRateLimited, onTransientFailure, onMinted }) {
  // The dead token stays in the document until a new one is minted: deleting
  // it first left the install holding no token at all whenever the mint failed
  // offline. It is already dead at Flux, so keeping it costs nothing, and
  // `ensureFluxComposioBrokerToken` replaces it (and ends it, best effort)
  // the moment a mint succeeds. With no key there is nothing to mint with, so
  // the token goes, as before.
  if (!fluxKey) return clearFluxComposioBrokerToken(credentials);
  return ensureFluxComposioBrokerToken({ fluxBrokerUrl, credentials, fluxKey, fetchImpl, log, timeoutSignal, now, force: true, revokeSink, onRateLimited, onTransientFailure, onMinted });
}

/** The three legs. Runs on the PluginsPanel button, on auto-claim, and on the
 * retry timer for `pending` and `confirmPending`. Returns the next document. */
async function claimLegacyComposioInstall({
  fluxBrokerUrl,
  legacyBrokerUrl,
  credentials,
  fluxKey,
  fetchImpl = globalThis.fetch,
  log = () => {},
  timeoutSignal = (milliseconds) => AbortSignal.timeout(milliseconds),
  now = Date.now(),
  onRateLimited = () => {},
  onTransientFailure = () => {},
  onMinted = () => {},
  revokeSink,
}) {
  const flux = normalizeManagedComposioBrokerUrl(fluxBrokerUrl);
  const legacy = normalizeManagedComposioBrokerUrl(legacyBrokerUrl);
  let next = { ...credentials };
  const previous = readComposioLegacyClaim(next);
  if (!flux || !legacy || !claimPreconditions(next, previous)) return next;
  const nowIso = new Date(now).toISOString();
  const installToken = next.composioBrokerToken;
  let claim = previous;

  if (claim.state !== "claimed") {
    // Leg 1: issue.
    let issued;
    try {
      const response = await fetchImpl(`${legacy}/v1/claims`, {
        method: "POST",
        headers: { authorization: `Bearer ${installToken}`, "content-type": "application/json" },
        body: JSON.stringify({ audience: LEGACY_CLAIM_AUDIENCE, brokerTokenSha256: sha256Hex(next.fluxComposioBrokerToken) }),
        redirect: "error",
        signal: timeoutSignal(15_000),
      });
      const body = await readJson(response);
      if (response.status === 401) {
        log("connected-apps install is no longer registered with Murage's service");
        return abandon(next, previous, nowIso);
      }
      if (response.status === 410 && codeOf(body) === "claims_closed") {
        return transition(next, previous, { state: "conflict", code: "claims_closed" }, nowIso);
      }
      if (response.status === 429) onRateLimited(response.headers.get("retry-after") ?? undefined);
    else if (response.status >= 500) onTransientFailure(response.headers.get("retry-after") ?? undefined);
      if (!response.ok || typeof body?.assertion !== "string" || body.assertion.length > 8192) {
        // 404 included: after a Worker rollback the old code has no
        // /v1/claims route and answers 404 for a perfectly valid token.
        log(`moving connected apps: Murage's service returned HTTP ${response.status}; will retry`);
        return transition(next, previous, { state: "pending", code: response.status === 429 ? "rate_limited" : undefined }, nowIso);
      }
      issued = body;
    } catch {
      onTransientFailure();
      return transition(next, previous, { state: "pending" }, nowIso);
    }

    // Leg 2: redeem.
    try {
      const response = await fetchImpl(`${flux}/v1/claim`, {
        method: "POST",
        headers: { authorization: "Bearer " + next.fluxComposioBrokerToken, "content-type": "application/json" },
        body: JSON.stringify({ assertion: issued.assertion }),
        redirect: "error",
        signal: timeoutSignal(15_000),
      });
      const body = await readJson(response);
      const code = codeOf(body);
      if (response.ok && body?.claimed === true) {
        const jti = typeof body.jti === "string" ? body.jti : typeof issued.jti === "string" ? issued.jti : undefined;
        claim = { state: "claimed", jti, confirmPending: Boolean(jti) };
        next = transition(next, previous, claim, nowIso);
        log("connected apps moved to FluxRouter");
      } else if (response.status === 409 && code && TERMINAL_FLUX_CONFLICTS.has(code)) {
        return transition(next, previous, { state: "conflict", code }, nowIso);
      } else if (response.status === 401 && code === "broker_token_revoked") {
        next = await remintAfterRevocation(next, { fluxBrokerUrl: flux, fluxKey, fetchImpl, log, timeoutSignal, now, revokeSink, onRateLimited, onTransientFailure, onMinted });
        return transition(next, previous, { state: "pending" }, nowIso);
      } else {
        if (response.status === 429) onRateLimited(response.headers.get("retry-after") ?? undefined);
        else if (response.status >= 500) onTransientFailure(response.headers.get("retry-after") ?? undefined);
        log(`moving connected apps: FluxRouter returned HTTP ${response.status}; will retry`);
        return transition(next, previous, { state: "pending", code: response.status === 429 ? "rate_limited" : undefined }, nowIso);
      }
    } catch {
      onTransientFailure();
      return transition(next, previous, { state: "pending" }, nowIso);
    }
  }

  // Leg 3: confirm. Until this succeeds the Worker keeps serving the install
  // and only its 7-day issuance fallback can end that.
  const current = readComposioLegacyClaim(next);
  if (!current.confirmPending || !current.jti) return next;
  try {
    const response = await fetchImpl(`${legacy}/v1/claims/confirm`, {
      method: "POST",
      headers: { authorization: `Bearer ${installToken}`, "content-type": "application/json" },
      body: JSON.stringify({ jti: current.jti }),
      redirect: "error",
      signal: timeoutSignal(15_000),
    });
    if (response.ok) {
      const confirmed = { ...current };
      delete confirmed.confirmPending;
      return transition(next, current, confirmed, nowIso);
    }
    if (response.status === 401) return abandon(next, current, nowIso);
    if (response.status === 409 && codeOf(await readJson(response)) === "claim_unknown") {
      // The Worker issued a newer assertion since. Flux's redeem is idempotent
      // for this account, so re-running all three legs is safe.
      return transition(next, current, { state: "pending" }, nowIso);
    }
    if (response.status === 429) onRateLimited(response.headers.get("retry-after") ?? undefined);
    else if (response.status >= 500) onTransientFailure(response.headers.get("retry-after") ?? undefined);
  } catch {
    onTransientFailure();
    // retried on the timer
  }
  return transition(next, current, { ...current }, nowIso);
}

/** The boot and timer path. Network only; never asks the Worker to sign
 * anything for a shared account. Returns the next document. */
function preparationAfterClaim(credentials) {
  const claim = readComposioLegacyClaim(credentials);
  return { credentials, preparation: claim.state === "claimed" && !claim.confirmPending ? "complete" : "deferred" };
}

async function prepareLegacyComposioClaim({
  fluxBrokerUrl,
  legacyBrokerUrl,
  credentials,
  fluxKey,
  fetchImpl = globalThis.fetch,
  log = () => {},
  timeoutSignal = (milliseconds) => AbortSignal.timeout(milliseconds),
  now = Date.now(),
  onRateLimited = () => {},
  onTransientFailure = () => {},
  onMinted = () => {},
  revokeSink,
}) {
  const flux = normalizeManagedComposioBrokerUrl(fluxBrokerUrl);
  let next = { ...credentials };
  const claim = readComposioLegacyClaim(next);
  if (!flux || !claimPreconditions(next, claim)) return { credentials: next, preparation: "not-applicable" };
  const options = { fluxBrokerUrl: flux, legacyBrokerUrl, fluxKey, fetchImpl, log, timeoutSignal, now, onRateLimited, onTransientFailure, onMinted, revokeSink };
  if (claim.state === "claimed" && claim.confirmPending) return preparationAfterClaim(await claimLegacyComposioInstall({ ...options, credentials: next }));

  try {
    const health = await fetchImpl(`${flux}/health`, { redirect: "error", signal: timeoutSignal(5_000) });
    if (health.status === 429) onRateLimited(health.headers.get("retry-after") ?? undefined);
    else if (health.status >= 500) onTransientFailure(health.headers.get("retry-after") ?? undefined);
    const body = await readJson(health);
    if (!health.ok || body?.ready !== true || body?.claims !== true) return { credentials: next, preparation: "deferred" };
  } catch {
    onTransientFailure();
    return { credentials: next, preparation: "deferred" };
  }

  let me;
  try {
    const response = await fetchImpl(`${flux}/v1/me`, {
      headers: { authorization: "Bearer " + next.fluxComposioBrokerToken },
      redirect: "error",
      signal: timeoutSignal(8_000),
    });
    me = await readJson(response);
    if (response.status === 401 && codeOf(me) === "broker_token_revoked") {
      return { credentials: await remintAfterRevocation(next, { fluxBrokerUrl: flux, fluxKey, fetchImpl, log, timeoutSignal, now, revokeSink, onRateLimited, onTransientFailure, onMinted }), preparation: "deferred" };
    }
    if (response.status === 429) onRateLimited(response.headers.get("retry-after") ?? undefined);
    else if (response.status >= 500) onTransientFailure(response.headers.get("retry-after") ?? undefined);
    if (!response.ok || !me || typeof me !== "object") return { credentials: next, preparation: "deferred" };
  } catch {
    onTransientFailure();
    return { credentials: next, preparation: "deferred" };
  }
  if (me.accountKind !== "personal" && me.accountKind !== "shared") return { credentials: next, preparation: "deferred" };
  next.fluxComposioAccountKind = me.accountKind;
  const nowIso = new Date(now).toISOString();

  if (typeof me.legacyInstallationId === "string" && me.legacyInstallationId === next.composioInstallationId) {
    // Already on this account (a claim that finished while the app was down,
    // or an earlier attempt whose reply was lost). With the claim's jti we
    // only owe the Worker its confirmation. Without it, re-run the legs: the
    // account already holds this install, so Flux's redeem is an idempotent
    // 200 and the Worker gets a jti it can confirm.
    if (claim.jti) {
      next = transition(next, claim, { state: "claimed", jti: claim.jti, confirmPending: true }, nowIso);
    }
    return preparationAfterClaim(await claimLegacyComposioInstall({ ...options, credentials: next }));
  }
  if (me.claimable === false) {
    const code = codeOf({ code: me.claimBlockedReason }) ?? "account_already_claimed";
    return { credentials: transition(next, claim, { state: "conflict", code }, nowIso), preparation: "not-applicable" };
  }
  if (me.claimable !== true) return { credentials: next, preparation: "deferred" };
  if (me.accountKind === "personal") return preparationAfterClaim(await claimLegacyComposioInstall({ ...options, credentials: next }));
  if (claim.state === "pending") return { credentials: next, preparation: "deferred" }; // the user already chose; the timer retries the legs
  return { credentials: transition(next, claim, { state: "offered" }, nowIso), preparation: "complete" };
}

async function ensureManagedComposioCredentials({
  brokerUrl,
  credentials,
  fetchImpl = globalThis.fetch,
  saveCredentials,
  log = () => {},
  onTransientFailure = () => {},
  onMinted = () => {},
  timeoutSignal = (milliseconds) => AbortSignal.timeout(milliseconds),
  existingCredentialTimeoutMs = 8_000,
  registrationTimeoutMs = 15_000,
  // False once the FluxRouter broker is configured: new installs get
  // connected apps through a FluxRouter account, never an anonymous Worker
  // registration. An existing Worker token is kept untouched (it may still be
  // claimable), so this path makes no request at all.
  registrationAllowed = true,
}) {
  const url = normalizeManagedComposioBrokerUrl(brokerUrl);
  if (!url) {
    if (brokerUrl) log("connected-apps broker URL rejected: HTTPS or a loopback HTTP URL is required");
    return credentials;
  }
  if (!registrationAllowed) return credentials;
  const existingToken = credentials.composioBrokerToken;
  if (TOKEN.test(existingToken ?? "")) {
    try {
      const check = await fetchImpl(`${url}/v1/me`, {
        headers: { authorization: `Bearer ${existingToken}` },
        redirect: "error",
        signal: timeoutSignal(existingCredentialTimeoutMs),
      });
      if (check.ok) return credentials;
      // Only a definitive auth failure rotates the credential. A transient
      // outage keeps the existing identity so reconnecting cannot strand the
      // user's already-authorized accounts under a new installation.
      if (check.status !== 401) return credentials;
      delete credentials.composioBrokerToken;
      delete credentials.composioInstallationId;
    } catch {
      return credentials;
    }
  }
  try {
    const response = await fetchImpl(`${url}/v1/installations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      redirect: "error",
      signal: timeoutSignal(registrationTimeoutMs),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
    if (!TOKEN.test(body?.token ?? "") || typeof body?.installationId !== "string") {
      throw new Error("the connected-apps service returned invalid credentials");
    }
    credentials.composioBrokerToken = body.token;
    credentials.composioInstallationId = body.installationId;
    await saveCredentials(credentials);
    log("connected-apps installation registered");
  } catch (error) {
    // This operation always settles locally. The caller runs it after first
    // paint, so an optional hosted integration cannot delay desktop readiness.
    onTransientFailure();
    log(`connected-apps registration failed: ${error?.message ?? error}`);
  }
  return credentials;
}


const REVOCATION_MAX_PENDING = 256;
const REVOCATION_BATCH = 16;
const STORAGE_RETRY_MS = 15_000;
const RETRY_TIMER_MAX = 2_147_000_000;
class AdmissionHeld extends Error {
  constructor(status) { super("admission_held"); this.admission = status; }
}
function retryAfterDeadline(value, receivedAt) {
  if (typeof value !== "string" || !value.trim()) return 0;
  const v = value.trim();
  const deadline = /^\d+$/.test(v) ? receivedAt + Number(v) * 1000 : Date.parse(v);
  return Number.isFinite(deadline) ? deadline : 0;
}

/** One installation authority. Only request() can cause network work. */
export function createComposioLifecycle(dependencies) {
  const d = dependencies;
  const wall = d.now ?? (() => Date.now());
  const monotonic = d.monotonic ?? (() => performance.now());
  const random = d.random ?? (() => Math.random());
  const startedAt = wall(), startedMono = monotonic();
  // A forward wall jump must not release a running hold. A backward jump is
  // conservative; persisted wall deadlines still work after a restart.
  const clock = () => Math.min(wall(), startedAt + Math.max(0, monotonic() - startedMono));
  const holds = new Map();
  const listeners = new Set();
  const queue = new Map();
  const pendingRevokes = new Map();
  const completedRevokes = new Set();
  const revoking = new Map(), settledRevokes = new Set(), activeScopes = new Map(), reservedScopes = new Map();
  let brokerRequests = 0;
  const revokeKey = entry => { const base = normalizeManagedComposioBrokerUrl(entry.fluxBrokerUrl); return `${base}|${entry.token}`; };
  let flight = null, timer = null, disposed = false, storageError = null, unsettledPass = null;
  let preparedIdentity;
  let pendingWrite = null, credentialRetryAt = 0, credentialFailures = 0;
  let cleanupDirty = false, cleanupRevision = 0, cleanupChain = Promise.resolve(), cleanupVersion, cleanupLoaded = false, cleanupInvalid = false;
  const cleanupTouched = new Set(), cleanupObserved = new Map();
  let recoveryFailed = false, recoveryPassTimedOut = false;
  const terminalFailure = () => ({ outcome: "failed", reason: "credential_recovery_failed", attempted: false });
  const durableCredentials = () => d.readDurableCredentials ? d.readDurableCredentials() : Promise.resolve(d.getCredentials());
  const touchCleanup = key => { cleanupTouched.add(key); cleanupDirty = true; cleanupRevision++; };
  const ownRevoke = entry => {
    const key = revokeKey(entry);
    // A duplicate revoke intent must not erase an unresolved replacement or
    // its second cleanup leg already held by this record.
    if (pendingRevokes.has(key) && !entry.replacement && !entry.after) return true;
    if (!pendingRevokes.has(key) && pendingRevokes.size >= REVOCATION_MAX_PENDING) return false;
    pendingRevokes.set(key, { ...pendingRevokes.get(key), ...entry }); touchCleanup(key); return true;
  };
  const loadCleanup = () => {
    const version = d.pendingRevocationsVersion?.();
    if (cleanupLoaded && (!d.pendingRevocationsVersion || version === cleanupVersion)) return;
    let entries;
    try { entries = readComposioCustody(d.getPendingRevocations?.() ?? []); }
    catch { cleanupInvalid = true; cleanupLoaded = true; cleanupVersion = version; return; }
    for (const key of pendingRevokes.keys()) {
      if (!cleanupTouched.has(key) && !entries.some(entry => revokeKey(entry) === key)) pendingRevokes.delete(key);
    }
    for (const entry of entries) {
      const key = revokeKey(entry);
      if (settledRevokes.has(key) || cleanupTouched.has(key)) continue;
      cleanupObserved.set(key, structuredClone(entry));
      pendingRevokes.set(key, entry);
    }
    cleanupInvalid = false; cleanupLoaded = true; cleanupVersion = version;
  };
  const persistCleanup = (beforeCredentialSave = false) => {
    const work = cleanupChain.then(async () => {
      const save = beforeCredentialSave ? d.savePendingCredentialWrite : d.savePendingRevocations;
      // The optional write-ahead hook is distinct from the established
      // post-save cleanup callback. Memory custody exists in either mode.
      if (!cleanupDirty || (beforeCredentialSave && !save)) return;
      // Refresh only when another credential writer changed the protected queue.
      loadCleanup();
      if (cleanupInvalid) throw new Error("revocation_backlog_capacity");
      const revision = cleanupRevision;
      const changes = [...cleanupTouched].map(key => ({ previous: cleanupObserved.get(key), entry: pendingRevokes.get(key) })).filter(change => change.previous || change.entry);
      let committed;
      try { committed = save ? await save([...pendingRevokes.values()], changes) : undefined; }
      catch (error) {
        if (!d.requireDurableCustody || !d.readDurableCredentials) throw error;
        const proof = readComposioCustody((await d.readDurableCredentials()).composioPendingRevocations);
        const observed = new Map(proof.map(entry => [revokeKey(entry), entry]));
        if (changes.some(change => JSON.stringify(observed.get(revokeKey(change.entry ?? change.previous))) !== JSON.stringify(change.entry))) throw error;
        // Confirm an ambiguous transition with a successful durable write.
        const confirmed = changes.map(change => ({ previous: observed.get(revokeKey(change.entry ?? change.previous)), entry: change.entry })).filter(change => change.previous || change.entry);
        committed = await save(proof, confirmed);
      }
      if (!save && d.requireDurableCustody) throw new Error("credential_recovery_failed");
      for (const change of changes) {
        const key = revokeKey(change.entry ?? change.previous);
        if (change.entry) cleanupObserved.set(key, structuredClone(change.entry)); else cleanupObserved.delete(key);
      }
      if (revision === cleanupRevision) { cleanupDirty = false; cleanupTouched.clear(); }
      if (Array.isArray(committed)) {
        const currentKeys = new Set(committed.map(revokeKey));
        for (const key of pendingRevokes.keys()) if (!currentKeys.has(key) && !cleanupTouched.has(key)) pendingRevokes.delete(key);
        for (const entry of committed) {
          const key = revokeKey(entry);
          if (!cleanupTouched.has(key)) { pendingRevokes.set(key, entry); cleanupObserved.set(key, structuredClone(entry)); }
        }
      }
      cleanupVersion = d.pendingRevocationsVersion?.();
    });
    cleanupChain = work.catch(() => {});
    return work;
  };
  const recovery = { force: null, claim: null, refresh: null };
  const recoverySlot = intent => intent.force || intent.operation === "reconnect" ? "force" : intent.operation === "claim" ? "claim" : "refresh";
  const hasRecovery = () => Object.values(recovery).some(Boolean);
  const takeRecovery = () => { const intents = Object.values(recovery).filter(Boolean); for (const key of Object.keys(recovery)) recovery[key] = null; return intents; };
  let persistChain = Promise.resolve();
  const configuration = () => d.getConfiguration();
  const hash = value => sha256Hex(`${ADMISSION_NAMESPACE}:${value}`);
  const online = () => !disposed && (d.isOnline?.() ?? true) && !(d.isShuttingDown?.() ?? false);
  const activeRows = () => [...holds.values()].map(row => ({ ...row }));
  const status = () => {
    const now = clock();
    const held = [...holds.values()].filter(row => row.notBefore > now).sort((a, b) => b.notBefore - a.notBefore)[0];
    if (recoveryFailed || ([...pendingRevokes.values()].some(entry => entry.exhausted) && [...pendingRevokes.values()].every(entry => entry.exhausted)) || (cleanupInvalid && d.requireDurableCustody)) return terminalFailure();
    const eligible = [...pendingRevokes.values()].filter(entry => !entry.exhausted);
    const custodyRetryAt = eligible.length ? Math.min(...eligible.map(entry => entry.retryAt ?? 0)) : 0;
    return { outcome: held ? "held" : storageError || pendingWrite || cleanupInvalid ? "deferred" : "completed",
      reason: storageError ?? (pendingWrite ? "credential_storage_unavailable" : cleanupInvalid ? "revocation_backlog_capacity" : null) ?? (held ? held.status === 429 ? "rate_limited" : "upstream_unavailable" : "ready"),
      retryAt: Math.max(held?.notBefore ?? 0, credentialRetryAt, custodyRetryAt) || undefined, status: held?.status, attempted: false };
  };
  const publish = () => { const s = status(); for (const listener of listeners) { try { listener(s); } catch { /* observers cannot dispatch */ } } };
  const persist = () => {
    const rows = activeRows();
    const work = persistChain.then(() => d.store?.save(rows));
    persistChain = work.catch(() => {});
    return work.then(() => { storageError = null; }, () => { storageError = "admission_storage_unavailable"; });
  };
  const ready = Promise.resolve().then(() => d.store?.load() ?? []).then(rows => {
    for (const row of rows) holds.set(row.scope, { ...row });
  }).catch(() => {
    storageError = "admission_storage_invalid";
    const scope = hash("storage-fallback");
    holds.set(scope, { scope, failureStreak: 1, status: 503, notBefore: wall() + 300_000, generation: 1 });
  });
  function scopes(url, lifecycle) {
    const config = configuration();
    const allowed = [config.fluxBrokerUrl, config.legacyBrokerUrl, config.brokerUrl].map(normalizeManagedComposioBrokerUrl).filter(Boolean);
    const base = allowed.sort((a, b) => b.length - a.length).find(base => url === base || url.startsWith(`${base}/`));
    if (!base) throw new Error("admission_broker_invalid");
    const parsed = new URL(url);
    const path = url.slice(base.length).split("?")[0];
    if (!lifecycle && (!/^\/(?:health|v1\/(?:me|mcp|catalog(?:\/[a-z0-9_-]+)*|connectors(?:\/[a-zA-Z0-9_%.-]+)*))$/.test(path)
      || /(?:^|\/)\.{1,2}(?:\/|$)|%2e|%2f|%5c/i.test(path) || parsed.username || parsed.password || parsed.hash)) throw new Error("admission_operation_invalid");
    const family = lifecycle ? "lifecycle" : path === "/health" ? "health" : path === "/v1/connectors/connected" ? "inventory" : "data";
    // The installation is the custody owner. Rotation of a key or token never
    // creates a new origin floor, nor can the caller choose an exemption.
    const credentials = d.getCredentials();
    const owner = typeof credentials.fluxApiKey === "string" && credentials.fluxApiKey.trim()
      ? fluxKeyFingerprint(credentials.fluxApiKey.trim()) : typeof credentials.composioInstallationId === "string" ? credentials.composioInstallationId : "installation";
    const claimed = readComposioLegacyClaim(credentials).state === "claimed" || config.legacyClaimed === true;
    const dataBase = family === "data" && claimed && config.fluxBrokerUrl ? normalizeManagedComposioBrokerUrl(config.fluxBrokerUrl) : base;
    // Lifecycle legs share admission floors but keep their own failure history:
    // a healthy /health or a cleanup DELETE cannot recover a refused /v1/me.
    const own = hash(`${dataBase}|${owner}|${family}${lifecycle ? `|${path}` : ""}`);
    const origin = hash(`${new URL(base).origin}|origin`);
    const keys = [own, origin, hash("storage-fallback")];
    if (lifecycle) keys.push(hash("lifecycle"), ...allowed.map(base => hash(`${new URL(base).origin}|origin`)));
    else if (family !== "health") keys.push(hash(`${base}|${owner}|health`));
    // Health depends on data availability, whereas a fresh inventory check
    // must still discover EXPIRED after an MCP 503.
    if (family === "health") keys.push(hash(`${base}|${owner}|data`));
    return { own, origin, keys, lifecycle, family, base };
  }
  const heldFor = scope => {
    const now = clock();
    const entry = scope.keys.map(key => holds.get(key)).filter(row => row && row.notBefore > now).sort((a,b) => b.notBefore - a.notBefore)[0];
    return entry ? { outcome: "held", reason: storageError ?? (entry.status === 429 ? "rate_limited" : "upstream_unavailable"),
      retryAt: entry.notBefore, status: entry.status, attempted: false } : null;
  };
  function nominal(streak, statusCode, lifecycle) {
    const n = Math.min(streak - 1, 20);
    if (!lifecycle) return Math.min(30_000 * 2 ** n, 900_000);
    if (statusCode === 429) return Math.min(3600_000 * 2 ** n, 4 * 3600_000);
    if (d.policy === "dev") return Math.min(60_000 * 2 ** n, 3600_000);
    return [15_000, 30_000, 60_000, 120_000, 300_000][Math.min(n, 4)];
  }
  async function failure(scope, code, retryAfter) {
    const receivedAt = wall(), now = clock();
    const previous = holds.get(scope.own);
    const streak = (previous?.failureStreak ?? 0) + 1;
    const delay = Math.round(nominal(streak, code, scope.lifecycle) * (0.5 + 0.5 * Math.min(1, Math.max(0, random(scope.lifecycle ? "lifecycle" : "broker")))));
    const notBefore = Math.max(previous?.notBefore ?? 0, now + delay, retryAfterDeadline(retryAfter, receivedAt));
    const row = { scope: scope.own, failureStreak: streak, status: code, notBefore, generation: (previous?.generation ?? 0) + 1 };
    holds.set(scope.own, row);
    if (scope.lifecycle) {
      const key = hash("lifecycle"), old = holds.get(key);
      holds.set(key, { ...row, scope: key, notBefore: Math.max(notBefore, old?.notBefore ?? 0) });
    }
    if (code === 429) {
      const old = holds.get(scope.origin);
      holds.set(scope.origin, { ...row, scope: scope.origin, notBefore: Math.max(notBefore, old?.notBefore ?? 0) });
    }
    // Active deadlines are never evicted. Exhaustion denies new identities.
    for (const [key, value] of holds) if (holds.size > 192 && value.notBefore <= now && key !== scope.own && !activeScopes.has(key)) holds.delete(key);
    publish();
    await persist();
    publish();
    schedule();
  }
  async function dispatch(url, init, context) {
    await ready;
    await persistChain;
    let scope = scopes(String(url), context.lifecycle);
    if (!online()) { context.held = { outcome: "deferred", reason: "offline", attempted: false }; throw new AdmissionHeld(context.held); }
    const held = heldFor(scope);
    if (held) { context.held = held; throw new AdmissionHeld(held); }
    if (holds.size >= 192) {
      for (const [key, row] of holds) if (row.notBefore <= clock() && !scope.keys.includes(key) && !activeScopes.has(key)) holds.delete(key);
    }
    // Any accounting/spend await happens before this final admission check.
    const transport = context.lifecycle ? d.lifecycleTransport ?? d.transport ?? globalThis.fetch : d.transport ?? globalThis.fetch;
    if (d.beforeTransport) await d.beforeTransport(url, init);
    scope = scopes(String(url), context.lifecycle);
    const current = d.getCredentials(), configured = configuration();
    if (context.lifecycle && context.operation !== "revoke" && (current.fluxApiKey !== context.snapshot.fluxApiKey || current.composioBrokerToken !== context.snapshot.composioBrokerToken || current.composioInstallationId !== context.snapshot.composioInstallationId)) {
      context.held = { outcome: "deferred", reason: "credentials_changed", attempted: false }; throw new AdmissionHeld(context.held);
    }
    if (!context.lifecycle && scope.family !== "health") {
      const ownToken = scope.base === normalizeManagedComposioBrokerUrl(configured.fluxBrokerUrl) ? current.fluxComposioBrokerToken : current.composioBrokerToken;
      const expected = Array.isArray(configured.brokerCredentials)
        ? configured.brokerCredentials.find(entry => normalizeManagedComposioBrokerUrl(entry.url) === scope.base)?.tokenFingerprint
        : typeof ownToken === "string" && FLUX_BROKER_TOKEN.test(ownToken) ? brokerTokenFingerprint(ownToken) : undefined;
      if (!expected || context.tokenFingerprint !== expected) {
        context.held = { outcome: "deferred", reason: "credentials_changed", attempted: false }; throw new AdmissionHeld(context.held);
      }
    }
    const finalHold = heldFor(scope);
    if (!online() || finalHold) { context.held = finalHold ?? { outcome: "deferred", reason: "offline", attempted: false }; throw new AdmissionHeld(context.held); }
    const floorKeys = [scope.own, scope.origin, ...(scope.lifecycle ? [hash("lifecycle")] : [])];
    const occupied = new Set([...holds.keys(), ...reservedScopes.keys(), ...floorKeys]);
    if (occupied.size > 256) throw new AdmissionHeld({ outcome: "deferred", reason: "admission_capacity", attempted: false });
    const generation = holds.get(scope.own)?.generation ?? 0;
    d.onDispatch?.(url, init);
    for (const key of floorKeys) reservedScopes.set(key, (reservedScopes.get(key) ?? 0) + 1);
    context.attempted = true;
    context.lastScope = scope;
    if (context.lifecycle) (context.recoveryScopes ??= new Map()).set(scope.own, generation);
    activeScopes.set(scope.own, (activeScopes.get(scope.own) ?? 0) + 1);
    try {
    let response;
    try { response = await transport(url, init); }
    catch (error) {
      if (error instanceof AdmissionHeld) throw error;
      if (error?.admissionAttempted === false) { context.attempted = false; throw error; }
      await failure(scope, 503);
      context.failure = true;
      throw error;
    }
    // Observe the raw status, before an MCP 503 becomes a JSON-RPC HTTP 200.
    if (response.status === 429 || response.status >= 500 || (context.lifecycle && d.policy === "dev" && response.status === 402)) {
      context.failure = true;
      await failure(scope, response.status === 402 ? 503 : response.status, response.headers.get("retry-after"));
    } else if (response.ok && !context.lifecycle) {
      const row = holds.get(scope.own);
      if (row && row.generation === generation && row.notBefore <= clock()) {
        holds.delete(scope.own);
        await persist();
        publish();
      } else if (storageError && (holds.get(hash("storage-fallback"))?.notBefore ?? 0) <= clock()) {
        holds.delete(hash("storage-fallback")); await persist(); publish();
      }
    }
    return response;
    } finally {
      const active = (activeScopes.get(scope.own) ?? 1) - 1;
      if (active) activeScopes.set(scope.own, active); else activeScopes.delete(scope.own);
      for (const key of floorKeys) {
        const count = (reservedScopes.get(key) ?? 1) - 1;
        if (count) reservedScopes.set(key, count); else reservedScopes.delete(key);
      }
    }
  }
  function schedule() {
    if (timer !== null) (d.clearTimer ?? clearTimeout)(timer);
    timer = null;
    if (disposed || recoveryFailed || !online() || (!hasRecovery() && ![...pendingRevokes.values()].some(entry => !entry.exhausted))) return;
    const until = status().retryAt ?? (pendingRevokes.size ? clock() + STORAGE_RETRY_MS : undefined);
    if (!until) return;
    const delay = Math.max(1, Math.min(RETRY_TIMER_MAX, until - clock()));
    timer = (d.setTimer ?? setTimeout)(() => {
      timer = null;
      if (!online()) return;
      if ((status().retryAt ?? 0) > clock()) { schedule(); return; }
      const intents = takeRecovery();
      if (intents.length) { for (const intent of intents) void request(intent); }
      else { const entry = [...pendingRevokes.values()].find(entry => !entry.exhausted); if (entry) void request({ operation: "revoke", token: entry.token }); }
    }, delay);
    timer?.unref?.();
  }
  const identityOf = (config, credentials) => JSON.stringify([config.fluxBrokerUrl, config.legacyBrokerUrl,
    credentials.fluxComposioBrokerToken, credentials.composioBrokerToken, credentials.composioInstallationId]);
  async function execute(intent) {
    await ready;
    if (intent.operation !== "broker") loadCleanup();
    const config = configuration();
    const snapshot = { ...d.getCredentials() };
    const context = { lifecycle: intent.operation !== "broker", operation: intent.operation, snapshot, tokenFingerprint: intent.tokenFingerprint, attempted: false, failure: false };
    if (intent.operation === "broker") {
      const url = String(intent.url);
      const parsed = new URL(url);
      if (parsed.username || parsed.password || parsed.hash || !["GET", "POST", "DELETE"].includes((intent.init?.method ?? "GET").toUpperCase())) throw new Error("admission_operation_invalid");
      try {
        const response = await dispatch(url, intent.init, context);
        return { outcome: response.ok ? "completed" : "failed", reason: response.ok ? "ready" : "upstream_refused", attempted: true, response, ...status(), attempted: true };
      } catch (error) {
        if (error instanceof AdmissionHeld) return error.admission;
        throw error;
      }
    }
    if (intent.retryRecovery === true) {
      for (const [key, entry] of pendingRevokes) { pendingRevokes.set(key, { ...entry, attempts: 0, exhausted: false, retryAt: undefined }); touchCleanup(key); }
      try { await persistCleanup(); recoveryFailed = false; recoveryPassTimedOut = false; credentialRetryAt = 0; credentialFailures = 0; }
      catch { recoveryFailed = true; }
    }
    if (recoveryFailed || (cleanupInvalid && d.requireDurableCustody)) return { ...terminalFailure(), reconnected: false, credentials: d.getCredentials() };
    if (d.requireDurableCustody && (!d.savePendingCredentialWrite || !d.savePendingRevocations || !d.readDurableCredentials)) {
      recoveryFailed = true; publish(); return { ...terminalFailure(), reconnected: false };
    }
    if (d.requireDurableCustody && !pendingWrite && !pendingRevokes.size) {
      try { const document = await durableCredentials(); readComposioCustody(document.composioPendingRevocations); }
      catch { recoveryFailed = true; publish(); return { ...terminalFailure(), reconnected: false }; }
    }
    if (intent.rejectedTokenFingerprint && snapshot.fluxComposioTokenError === "token_taken_over") {
      return { outcome: "deferred", reason: "token_taken_over", attempted: false, credentials: d.getCredentials(), reconnected: false };
    }
    if (intent.operation !== "revoke" && (cleanupInvalid || (pendingWrite && credentialRetryAt > clock()))) {
      schedule();
      return { ...status(), outcome: "deferred", attempted: false, reconnected: false, credentials: d.getCredentials() };
    }
    if ([...pendingRevokes.values()].some(entry => entry.exhausted && (entry.replacement || entry.after)) || (pendingRevokes.size >= REVOCATION_MAX_PENDING - 1 && [...pendingRevokes.values()].every(entry => entry.exhausted))) {
      recoveryFailed = true; takeRecovery(); publish(); return { ...terminalFailure(), reconnected: false, credentials: d.getCredentials() };
    }
    const retryingWrite = intent.operation !== "revoke" ? pendingWrite : null;
    const revokeSink = retryingWrite?.revokeSink ?? [];
    const reservedCleanup = new Set();
    let custodySnapshot = retryingWrite?.snapshot ?? snapshot;
    let transient = false, rateLimited = false, preparation = "not-applicable";
    const fetchImpl = (url, init) => dispatch(url, init, context);
    const options = { ...config, credentials: { ...snapshot }, fluxKey: snapshot.fluxApiKey ?? "", fetchImpl,
      now: wall(), log: d.log ?? (() => {}), revokeSink,
      onRateLimited: value => { rateLimited = true; d.onRateLimited?.(value); },
      onTransientFailure: value => { transient = true; d.onTransientFailure?.(value); },
      onMinted: event => { if (event.forced) context.forcedMint = event.token; },
    };
    let next = snapshot;
    let reconnected = false;
    try {
      if (retryingWrite) {
        context.storageReconciled = true;
        next = retryingWrite.next;
        context.forcedMint = retryingWrite.forcedMint;
        context.recoveryScopes = retryingWrite.recoveryScopes;
        preparation = retryingWrite.preparation;
        reconnected = retryingWrite.reconnected;
      } else if (intent.operation === "revoke") {
        const entry = { fluxBrokerUrl: config.fluxBrokerUrl, token: intent.token };
        if (completedRevokes.has(revokeKey(entry))) return { outcome: "completed", reason: "revoked", attempted: false, revoked: true };
        if (!ownRevoke(entry)) return { outcome: "deferred", reason: "revocation_backlog_capacity", attempted: false, revoked: false };
      } else if (pendingRevokes.size >= REVOCATION_MAX_PENDING - 1 || [...pendingRevokes.values()].some(entry => entry.replacement || entry.after)) {
        context.reconciling = pendingRevokes.size < REVOCATION_MAX_PENDING - 1;
        // Resolve compound custody before minting another generation.
        // Reserve custody before issuing another capability. Drain existing
        // work in a bounded batch; never mint a token the owner cannot retain.
        context.cleanupOnly = true;
      } else if (intent.operation === "register") {
        next = await ensureManagedComposioCredentials({ ...options, brokerUrl: config.legacyBrokerUrl ?? config.brokerUrl,
          registrationAllowed: config.registrationAllowed ?? !config.fluxBrokerUrl, saveCredentials: async () => {} });
      } else {
        // Local sign-out/key replacement is immediate, even during a hold.
        const key = typeof snapshot.fluxApiKey === "string" ? snapshot.fluxApiKey : "";
        if (snapshot.fluxComposioBrokerToken && (!isFluxKeyShape(key) || (snapshot.fluxComposioBrokerTokenKeyFingerprint && snapshot.fluxComposioBrokerTokenKeyFingerprint !== fluxKeyFingerprint(key)))) {
          const entry = { fluxBrokerUrl: config.fluxBrokerUrl, token: snapshot.fluxComposioBrokerToken };
          ownRevoke(entry);
          next = clearFluxComposioBrokerToken(snapshot);
          await persistCleanup();
          await d.saveCredentials(next, snapshot);
          custodySnapshot = { ...d.getCredentials() };
        }
        if (intent.operation !== "prepare" && intent.operation !== "claim") next = await ensureFluxComposioBrokerToken({ ...options, credentials: next,
          force: intent.force === true || intent.operation === "reconnect", rejectedTokenFingerprint: intent.rejectedTokenFingerprint });
        if (!context.failure && !context.held && !transient && config.prepareLegacy !== false) {
          const claim = readComposioLegacyClaim(next);
          if (intent.operation === "claim" || claim.state === "pending" || (claim.state === "claimed" && claim.confirmPending)) {
            next = await claimLegacyComposioInstall({ ...options, credentials: next });
            preparation = preparationAfterClaim(next).preparation;
          } else {
            const identity = identityOf(config, next);
            if (identity !== preparedIdentity || intent.operation === "prepare") {
              const result = await prepareLegacyComposioClaim({ ...options, credentials: next });
              next = result.credentials; preparation = result.preparation;
              if (preparation !== "deferred") preparedIdentity = identity;
              else transient = true;
            } else preparation = "complete";
          }
        }
        reconnected = next.fluxComposioBrokerToken !== snapshot.fluxComposioBrokerToken && Boolean(next.fluxComposioBrokerToken);
      }
      if (preparation === "deferred") transient = true;
      if (transient && !context.failure && !context.held && context.lastScope) {
        // A malformed successful lifecycle reply is a real failed attempt.
        await failure(context.lastScope, rateLimited ? 429 : 503);
        context.failure = true;
      }
      let saved = true;
      if (intent.operation !== "revoke" && !context.cleanupOnly) {
        // Take custody before any awaited save. An ambiguous write retains the
        // minted and previous identities until storage can confirm its result.
        pendingWrite = { next, snapshot: custodySnapshot, revokeSink, forcedMint: context.forcedMint, recoveryScopes: context.recoveryScopes, preparation, reconnected };
        try {
          for (const entry of revokeSink) {
            if (!ownRevoke({ fluxBrokerUrl: entry.fluxBrokerUrl, token: entry.minted, previous: entry.previous, replacement: true })) throw new Error("revocation_backlog_capacity");
          }
          if (retryingWrite) {
            for (const entry of revokeSink) {
              const key = revokeKey({ fluxBrokerUrl: entry.fluxBrokerUrl, token: entry.minted });
              const record = pendingRevokes.get(key);
              if (record) {
                if (record.exhausted || (record.attempts ?? 0) >= 3) { recoveryFailed = true; throw new Error("credential_recovery_failed"); }
                pendingRevokes.set(key, { ...record, attempts: (record.attempts ?? 0) + 1, exhausted: (record.attempts ?? 0) + 1 >= 3, retryAt: clock() + STORAGE_RETRY_MS * 2 ** Math.min(credentialFailures, 5) }); touchCleanup(key);
              }
            }
          }
          await persistCleanup(true);
          if (disposed || recoveryPassTimedOut) throw new Error("credential_recovery_failed");
          saved = await d.saveCredentials(next, custodySnapshot);
          if (disposed || recoveryPassTimedOut) throw new Error("credential_recovery_failed");
          if (saved === false && revokeSink.length) {
            const proof = await durableCredentials();
            if (proof.fluxComposioBrokerToken === next.fluxComposioBrokerToken
              && (proof.fluxApiKey ?? "") === (next.fluxApiKey ?? "")
              && (proof.composioBrokerToken ?? "") === (next.composioBrokerToken ?? "")
              && (proof.fluxComposioTokenError ?? "") === (next.fluxComposioTokenError ?? "")) saved = true;
          }
          const beforeTransition = new Map();
          for (const entry of revokeSink) {
            for (const token of [entry.minted, entry.previous].filter(Boolean)) {
              const key = revokeKey({ fluxBrokerUrl: entry.fluxBrokerUrl, token });
              if (!beforeTransition.has(key)) beforeTransition.set(key, pendingRevokes.get(key));
            }
          }
          try {
            for (const entry of revokeSink) {
              const mintedKey = revokeKey({ fluxBrokerUrl: entry.fluxBrokerUrl, token: entry.minted });
              const receipt = pendingRevokes.get(mintedKey);
              const active = (await durableCredentials()).fluxComposioBrokerToken;
              pendingRevokes.delete(mintedKey); touchCleanup(mintedKey);
              const token = active === entry.minted ? entry.previous : entry.minted;
              const after = active !== entry.minted && entry.previous && active !== entry.previous ? entry.previous : undefined;
              if (active !== next.fluxComposioBrokerToken) { reconnected = false; context.discarded = true; }
              if (token) {
                const cleanup = { fluxBrokerUrl: entry.fluxBrokerUrl, token, attempts: receipt?.attempts ?? 0,
                  exhausted: receipt?.exhausted, retryAt: receipt?.retryAt, ...(after ? { after } : {}) };
                ownRevoke(cleanup);
                if (retryingWrite && receipt?.attempts) reservedCleanup.add(revokeKey(cleanup));
              }
            }
            await persistCleanup();
          } catch (error) {
            for (const [key, entry] of beforeTransition) {
              if (entry) pendingRevokes.set(key, entry); else pendingRevokes.delete(key);
              touchCleanup(key);
            }
            throw error;
          }
          pendingWrite = null; credentialRetryAt = 0; credentialFailures = 0;
        } catch (error) {
          credentialFailures++;
          for (const entry of revokeSink) {
            const key = revokeKey({ fluxBrokerUrl: entry.fluxBrokerUrl, token: entry.minted }), record = pendingRevokes.get(key);
            if (record && (record.attempts ?? 0) >= 3) { pendingRevokes.set(key, { ...record, exhausted: true, retryAt: undefined }); touchCleanup(key); recoveryFailed = true; }
          }
          credentialRetryAt = clock() + Math.min(STORAGE_RETRY_MS * 2 ** Math.min(credentialFailures - 1, 5), 300_000);
          for (const entry of revokeSink) {
            const key = revokeKey({ fluxBrokerUrl: entry.fluxBrokerUrl, token: entry.minted }), record = pendingRevokes.get(key);
            if (record && !record.exhausted) { pendingRevokes.set(key, { ...record, retryAt: credentialRetryAt }); touchCleanup(key); }
          }
          preparedIdentity = undefined;
          // Without a newly minted capability there is no ambiguous token to
          // reconcile; recompute preparation on the next explicit pass.
          if (!revokeSink.length) { pendingWrite = null; credentialRetryAt = 0; }
          else {
            // A caller without a write-ahead hook still gets durable ambiguous
            // custody after the failed save attempt, with memory retry if the
            // same storage outage prevents this protected write as well.
            try { await persistCleanup(); } catch { /* pendingWrite retains custody */ }
          }
          throw error;
        }
      }
      if (saved === false) { reconnected = false; context.discarded = true; preparedIdentity = undefined; }
      else if (context.forcedMint && context.forcedMint === next.fluxComposioBrokerToken) d.onAutomaticReplacement?.({ tokenFingerprint: brokerTokenFingerprint(context.forcedMint), at: wall() });
      await persistCleanup();
      // The same reconciler runs on startup, foreground and background wakes.
      // A live pendingWrite exclusively owns its replacement until settlement.
      const requestedCleanup = intent.operation === "revoke" ? revokeKey({ fluxBrokerUrl: config.fluxBrokerUrl, token: intent.token }) : null;
      const orderedCleanup = [...pendingRevokes.entries()].filter(([key, entry]) => !entry.exhausted || reservedCleanup.has(key));
      if (requestedCleanup && pendingRevokes.has(requestedCleanup) && !pendingRevokes.get(requestedCleanup).exhausted) orderedCleanup.unshift([requestedCleanup, pendingRevokes.get(requestedCleanup)]);
      const cleanup = orderedCleanup.filter(([key], index, items) => items.findIndex(item => item[0] === key) === index).slice(0, REVOCATION_BATCH);
      for (const [key, original] of cleanup) {
        if (disposed || recoveryPassTimedOut || !pendingRevokes.has(key)) break;
        let entry = pendingRevokes.get(key);
        if (!reservedCleanup.has(key) && (entry.exhausted || (entry.retryAt ?? 0) > clock())) continue;
        if (pendingWrite?.revokeSink.some(item => item.minted === entry.token)) continue;
        if (completedRevokes.has(key)) { pendingRevokes.delete(key); touchCleanup(key); continue; }
        const held = status();
        const localOnly = !online() || (held.outcome === "held" && held.retryAt > clock());
        if (held.outcome === "held") context.held = held;
        if (localOnly && !entry.replacement) continue;
        // Offline/held identity reconciliation is local and consumes no attempt.
        const attempt = (entry.attempts ?? 0) + (localOnly || reservedCleanup.has(key) ? 0 : 1);
        if (attempt > 3) { entry = { ...entry, exhausted: true, retryAt: undefined }; pendingRevokes.set(key, entry); touchCleanup(key); await persistCleanup(); continue; }
        if (!localOnly && !reservedCleanup.has(key)) {
          entry = { ...entry, attempts: attempt, exhausted: attempt >= 3, retryAt: attempt >= 3 ? undefined : clock() + STORAGE_RETRY_MS * 2 ** (attempt - 1) };
          pendingRevokes.set(key, entry); touchCleanup(key);
        }
        try {
          await persistCleanup();
          let active = (await durableCredentials()).fluxComposioBrokerToken;
          if (entry.replacement || active === entry.token) {
            const token = active === entry.token ? entry.previous ?? entry.after : entry.token;
            const after = active !== entry.token && (entry.previous ?? entry.after) !== active ? entry.previous ?? entry.after : undefined;
            pendingRevokes.delete(key); touchCleanup(key);
            if (token && token !== active) {
              entry = { fluxBrokerUrl: entry.fluxBrokerUrl, token, attempts: entry.attempts, exhausted: entry.exhausted, retryAt: entry.retryAt, ...(after && after !== token ? { after } : {}) };
              ownRevoke(entry);
            } else entry = null;
            // W3 is durable before any DELETE, including when M remains active.
            await persistCleanup();
            if (!entry || localOnly) continue;
            if (!d.backgroundCleanup && original.replacement && !original.retryAt && !intent.retryRecovery) continue;
          }
          const workKey = revokeKey(entry);
          active = (await durableCredentials()).fluxComposioBrokerToken;
          if (active === entry.token) throw new Error("credential_custody_changed");
          let work = revoking.get(workKey);
          if (!work) {
            const fetchCleanup = async (url, init) => {
              const cleanupContext = { ...context, operation: "revoke", snapshot: d.getCredentials(), recoveryScopes: context.recoveryScopes ??= new Map() };
              try { return await dispatch(url, init, cleanupContext); }
              finally {
                context.attempted ||= cleanupContext.attempted;
                context.failure ||= cleanupContext.failure;
                context.held ??= cleanupContext.held;
              }
            };
            work = revokeFluxComposioBrokerToken({ ...entry, fetchImpl: fetchCleanup }).finally(() => revoking.delete(workKey));
            revoking.set(workKey, work);
          }
          const ok = await work;
          if (disposed || recoveryPassTimedOut) break;
          if (!ok) throw new Error("credential_cleanup_unavailable");
          // W4 retains the second leg and episode budget until durably settled.
          const afterKey = entry.after ? revokeKey({ fluxBrokerUrl: entry.fluxBrokerUrl, token: entry.after }) : null;
          const previousAfter = afterKey ? pendingRevokes.get(afterKey) : undefined;
          pendingRevokes.delete(workKey); touchCleanup(workKey); settledRevokes.add(workKey);
          if (entry.after) ownRevoke({ fluxBrokerUrl: entry.fluxBrokerUrl, token: entry.after, attempts: attempt, exhausted: attempt >= 3 });
          try { await persistCleanup(); }
          catch (error) {
            settledRevokes.delete(workKey);
            pendingRevokes.set(workKey, entry); touchCleanup(workKey);
            if (afterKey) { if (previousAfter) pendingRevokes.set(afterKey, previousAfter); else pendingRevokes.delete(afterKey); touchCleanup(afterKey); }
            throw error;
          }
          completedRevokes.add(workKey); if (completedRevokes.size > 256) completedRevokes.delete(completedRevokes.values().next().value);
        } catch {
          if (localOnly) { recoveryFailed = true; break; }
          // A failed transition retains all identities and rotates fairly.
          const currentKey = entry ? revokeKey(entry) : key;
          const retained = pendingRevokes.get(currentKey) ?? entry ?? original;
          const exhausted = attempt >= 3;
          pendingRevokes.delete(currentKey);
          pendingRevokes.set(currentKey, { ...retained, attempts: attempt, exhausted, retryAt: exhausted ? undefined : clock() + STORAGE_RETRY_MS * 2 ** (attempt - 1) });
          touchCleanup(currentKey);
          if (!exhausted) {
            const scope = hash("lifecycle"), previous = holds.get(scope), retryAt = pendingRevokes.get(currentKey).retryAt;
            holds.set(scope, { scope, failureStreak: previous?.failureStreak ?? 1, status: previous?.status ?? 503,
              generation: previous?.generation ?? 1, notBefore: Math.max(previous?.notBefore ?? 0, retryAt) });
            await persist();
          }
          try { await persistCleanup(); } catch { recoveryFailed = true; }

          if (status().outcome === "held") context.held = { ...status(), attempted: false };
        }
      }
      await persistCleanup();
      settledRevokes.clear();
    } catch (error) {
      if (error instanceof AdmissionHeld) context.held = error.admission;
      else { transient = true; preparedIdentity = undefined; d.log?.("Connected apps request deferred."); }
    }
    // Storage recovery is part of a validated operation's settlement. Retry
    // the durable hold write before choosing its public outcome; otherwise a
    // former storage error would prevent its own recovery forever.
    if (!context.failure && !context.held && !transient && !pendingWrite && !context.discarded && !context.cleanupOnly) {
      let recovered = false;
      for (const [key, generation] of context.recoveryScopes ?? []) {
        const row = holds.get(key);
        if (row && row.generation === generation && row.notBefore <= clock()) { holds.delete(key); recovered = true; }
      }
      const fallback = holds.get(hash("storage-fallback"));
      if (fallback && fallback.notBefore <= clock()) { holds.delete(fallback.scope); recovered = true; }
      if (recovered || storageError) await persist();
    }
    if (disposed) return { outcome: "deferred", reason: "disposed", attempted: false, reconnected: false };
    if (recoveryFailed || (cleanupInvalid && d.requireDurableCustody) || ((context.cleanupOnly || context.failure) && status().outcome === "failed")) {
      takeRecovery(); schedule(); publish(); return { ...terminalFailure(), reconnected: false, credentials: d.getCredentials() };
    }
    const held = context.held ?? (context.failure ? status() : null);
    const revoked = intent.operation === "revoke" && !pendingRevokes.has(revokeKey({ fluxBrokerUrl: config.fluxBrokerUrl, token: intent.token }));
    const reconciledRetry = intent.retryRecovery && context.cleanupOnly && !pendingRevokes.size && !pendingWrite;
    const outcome = reconciledRetry ? "completed" : revoked ? "completed" : held?.outcome ?? (transient || storageError || pendingWrite || context.cleanupOnly || context.discarded || preparation === "deferred" ? "deferred" : "completed");
    if ((intent.force || intent.operation === "reconnect" || intent.operation === "claim" || preparation === "deferred" || (context.attempted && context.failure && intent.operation !== "revoke")) && outcome !== "completed") {
      // Only lifecycle work is retried. Arbitrary broker actions never replay.
      recovery[recoverySlot(intent)] = { ...intent, retryRecovery: false };
    }
    if (outcome === "completed") {
      recovery[recoverySlot(intent)] = null; if (reconnected) recovery.force = null;
    }

    if (pendingWrite || (context.cleanupOnly && !d.backgroundCleanup && !reconciledRetry)) recovery[recoverySlot(intent)] = { ...intent, retryRecovery: false };
    // A resolved stale save owes cleanup, not another forced replacement of
    // the newer generation's valid capability.
    if (context.discarded) recovery[recoverySlot(intent)] = null;
    if (status().outcome === "failed") takeRecovery();
    schedule(); publish();
    return { outcome, reason: reconciledRetry ? "ready" : revoked ? "revoked" : held?.reason ?? (pendingWrite ? "credential_storage_unavailable" : context.cleanupOnly ? context.reconciling ? "credential_custody_pending" : "revocation_backlog_capacity" : null) ?? storageError ?? (context.discarded ? "credentials_changed" : transient ? "upstream_unavailable" : "ready"),
      retryAt: reconciledRetry ? undefined : held?.retryAt ?? status().retryAt ?? (context.reconciling ? clock() + STORAGE_RETRY_MS : undefined), status: held?.status ?? status().status, attempted: context.attempted,
      credentials: d.getCredentials(), preparation, reconnected: reconnected && outcome === "completed",
      revoked: intent.operation === "revoke" ? revoked : undefined };
  }
  function boundedExecute(intent, previous) {
    let timeout, expired = false;
    // The raw tail keeps the writer fence even after a caller's deadline.
    const run = Promise.resolve(previous).catch(() => {}).then(() => {
      if (expired) return { ...terminalFailure(), reconnected: false };
      if (disposed) return { outcome: "deferred", reason: "disposed", attempted: false };
      const pass = execute(intent);
      unsettledPass = pass;
      return pass.finally(() => { if (unsettledPass === pass) unsettledPass = null; });
    }).finally(() => { if (flight === run) flight = null; });
    flight = run;
    if (!d.requireDurableCustody) return run;
    const finished = run.finally(() => { (d.clearTimer ?? clearTimeout)(timeout); });
    const deadline = new Promise(resolve => {
      timeout = (d.setTimer ?? setTimeout)(() => {
        expired = true; recoveryPassTimedOut = true; recoveryFailed = true;
        takeRecovery(); schedule(); publish();
        resolve({ ...terminalFailure(), reconnected: false });
      }, 30_000);
      timeout?.unref?.();
    });
    return Promise.race([finished, deadline]);
  }
  function request(intent = { operation: "refresh" }) {
    if (!intent || !["refresh", "reconnect", "claim", "prepare", "register", "revoke", "broker"].includes(intent.operation)) return Promise.reject(new Error("admission_operation_invalid"));
    if (disposed) return Promise.resolve({ outcome: "deferred", reason: "disposed", attempted: false });
    if (recoveryFailed && unsettledPass && intent.operation !== "broker") return Promise.resolve({ ...terminalFailure(), reconnected: false });
    if (intent.operation === "broker") {
      if (brokerRequests >= 200) return Promise.resolve({ outcome: "deferred", reason: "admission_capacity", attempted: false });
      brokerRequests++;
      const work = execute(intent).finally(() => { brokerRequests--; });
      d.trackRequest?.(work); return work;
    }
    if (intent.operation === "refresh" && online() && hasRecovery() && !(status().retryAt > clock())) {
      const intents = takeRecovery();
      return Promise.all(intents.map(request)).then(results => results[0]);
    }
    const key = JSON.stringify([intent.operation, intent.force, intent.retryRecovery, intent.rejectedTokenFingerprint, intent.operation === "revoke" ? intent.token : ""]);
    if (queue.has(key)) return queue.get(key);
    if (queue.size >= 32) return Promise.resolve({ outcome: "deferred", reason: "admission_capacity", attempted: false });
    const work = boundedExecute(intent, flight).finally(() => { queue.delete(key); });
    queue.set(key, work);
    d.trackRequest?.(work);
    return work;
  }
  ready.then(publish);
  return Object.freeze({ request, inspect: url => url ? heldFor(scopes(url, false)) ?? { outcome: "completed", reason: "ready", attempted: false } : status(),
    subscribe(listener) { listeners.add(listener); listener(status()); return () => listeners.delete(listener); },
    dispose() { disposed = true; if (timer !== null) (d.clearTimer ?? clearTimeout)(timer); timer = null; listeners.clear(); takeRecovery(); },
  });
}
