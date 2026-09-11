import { COMPOSIO_LEGACY_BROKER_UNTIL, FLUX_COMPOSIO_BROKER_URL } from "./composio-release-config.mjs";

const TOKEN = /^[0-9a-f]{64}$/;

export function normalizeManagedComposioBrokerUrl(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    return "";
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return "";
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) return "";
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

/** The FluxRouter-hosted broker, or "" when it is off.
 *
 * The env override is honoured in every build (QA, a local Flux stack). The
 * release constant only applies to a packaged build, exactly like the Worker
 * URL: without that gate a dev run would point at production Flux with the
 * developer's real account and land dev connections on the production
 * Composio project. Identity itself is resolved by Flux from the account that
 * minted the broker token, so any build that reaches the same Flux broker
 * with the same account resolves the same Composio user. */
export function fluxComposioBrokerUrl(
  env = process.env,
  { packaged = false, releaseUrl = FLUX_COMPOSIO_BROKER_URL } = {},
) {
  const configured = typeof env?.MURAGE_FLUX_COMPOSIO_BROKER_URL === "string"
    ? env.MURAGE_FLUX_COMPOSIO_BROKER_URL.trim()
    : "";
  return normalizeManagedComposioBrokerUrl(configured || (packaged ? releaseUrl : ""));
}

/** The Worker cut-off instant as written ("" = none). Same gating as the URL. */
export function composioLegacyBrokerUntil(
  env = process.env,
  { packaged = false, releaseUntil = COMPOSIO_LEGACY_BROKER_UNTIL } = {},
) {
  const configured = typeof env?.MURAGE_COMPOSIO_LEGACY_BROKER_UNTIL === "string"
    ? env.MURAGE_COMPOSIO_LEGACY_BROKER_UNTIL.trim()
    : "";
  return configured || (packaged ? releaseUntil : "");
}

/** Whether the Worker broker may still be used for data calls. An unparseable
 * cut-off counts as closed (fail closed) and says so. */
export function legacyBrokerOpen(until, now = Date.now(), log = () => {}) {
  if (typeof until !== "string" || !until.trim()) return true;
  const at = Date.parse(until.trim());
  if (!Number.isFinite(at)) {
    log("connected-apps legacy cut-off is not a valid date; treating the Murage service as ended");
    return false;
  }
  return now < at;
}

export function managedComposioAccess(brokerUrl, credentials, { legacyUntil = "", now = Date.now() } = {}) {
  const url = normalizeManagedComposioBrokerUrl(brokerUrl);
  const token = credentials?.composioBrokerToken;
  if (!url || !TOKEN.test(token ?? "")) return null;
  if (!legacyBrokerOpen(legacyUntil, now)) return null;
  return { url, token };
}

/** The Flux broker credential the harness may use for data calls. Never the
 * Flux API key: that one reaches engines, the broker token never does. */
export function fluxComposioAccess(fluxBrokerUrl, credentials) {
  const url = normalizeManagedComposioBrokerUrl(fluxBrokerUrl);
  const token = credentials?.fluxComposioBrokerToken;
  if (!url || !TOKEN.test(token ?? "")) return null;
  return { url, token };
}

export const LEGACY_CLAIM_STATES = Object.freeze(["none", "offered", "pending", "claimed", "conflict", "abandoned"]);
const CLAIM_CODE = /^[a-z_]{1,64}$/;

/** The stored claim state, always well-formed. credentials.bin keeps it as a
 * JSON string, the same way it keeps the Flux connection aliases. */
export function readComposioLegacyClaim(credentials) {
  let value = credentials?.composioLegacyClaim;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      value = null;
    }
  }
  if (!value || typeof value !== "object" || !LEGACY_CLAIM_STATES.includes(value.state)) return { state: "none" };
  const claim = { state: value.state };
  if (typeof value.code === "string" && CLAIM_CODE.test(value.code)) claim.code = value.code;
  if (typeof value.installationId === "string" && value.installationId.length <= 64) claim.installationId = value.installationId;
  if (typeof value.at === "string") claim.at = value.at;
  if (typeof value.lastAttemptAt === "string") claim.lastAttemptAt = value.lastAttemptAt;
  if (typeof value.jti === "string" && value.jti.length <= 64) claim.jti = value.jti;
  if (value.confirmPending === true) claim.confirmPending = true;
  return claim;
}

export function writeComposioLegacyClaim(credentials, claim) {
  const next = { ...credentials };
  if (!claim || claim.state === "none") delete next.composioLegacyClaim;
  else next.composioLegacyClaim = JSON.stringify(claim);
  return next;
}

/** The secret-free view the harness and the renderer see. */
export function publicComposioLegacyClaim(credentials) {
  const claim = readComposioLegacyClaim(credentials);
  const result = { state: claim.state };
  if (claim.code) result.code = claim.code;
  if (claim.installationId) result.installationId = claim.installationId;
  if (claim.at) result.at = claim.at;
  if (claim.confirmPending) result.confirmPending = true;
  return result;
}

export function managedComposioChildEnvironment(
  brokerUrl,
  credentials,
  environment,
  { fluxBrokerUrl = "", legacyUntil = "", now = Date.now() } = {},
) {
  const next = { ...environment };
  for (const key of [
    "MURAGE_COMPOSIO_BROKER_URL",
    "MURAGE_COMPOSIO_BROKER_TOKEN",
    "MURAGE_FLUX_COMPOSIO_BROKER_URL",
    "MURAGE_FLUX_COMPOSIO_BROKER_TOKEN",
    "MURAGE_FLUX_COMPOSIO_ACCOUNT_KIND",
    "MURAGE_COMPOSIO_LEGACY_BROKER_UNTIL",
    "MURAGE_COMPOSIO_LEGACY_CLAIM",
  ]) delete next[key];
  const access = managedComposioAccess(brokerUrl, credentials, { legacyUntil, now });
  if (access) {
    next.MURAGE_COMPOSIO_BROKER_URL = access.url;
    next.MURAGE_COMPOSIO_BROKER_TOKEN = access.token;
  }
  const flux = normalizeManagedComposioBrokerUrl(fluxBrokerUrl);
  if (flux) {
    next.MURAGE_FLUX_COMPOSIO_BROKER_URL = flux;
    const fluxAccess = fluxComposioAccess(flux, credentials);
    if (fluxAccess) next.MURAGE_FLUX_COMPOSIO_BROKER_TOKEN = fluxAccess.token;
    if (credentials?.fluxComposioAccountKind === "personal" || credentials?.fluxComposioAccountKind === "shared") {
      next.MURAGE_FLUX_COMPOSIO_ACCOUNT_KIND = credentials.fluxComposioAccountKind;
    }
  }
  if (typeof legacyUntil === "string" && legacyUntil.trim()) next.MURAGE_COMPOSIO_LEGACY_BROKER_UNTIL = legacyUntil.trim();
  // Only when there is something to say. "none" is what the harness assumes
  // in the absence of the variable, and an install that never registered with
  // the Worker has no move to be in the middle of.
  const claim = publicComposioLegacyClaim(credentials);
  if (claim.state !== "none") next.MURAGE_COMPOSIO_LEGACY_CLAIM = JSON.stringify(claim);
  return next;
}

/** Every credential field the connected-apps lifecycle owns. */
export const COMPOSIO_CREDENTIAL_FIELDS = Object.freeze([
  "composioBrokerToken",
  "composioInstallationId",
  "composioLegacyClaim",
  "fluxComposioBrokerToken",
  "fluxComposioBrokerTokenExpiresAt",
  "fluxComposioBrokerTokenKeyFingerprint",
  "fluxComposioAccountKind",
  "fluxComposioTokenError",
]);

/** Apply a lifecycle result computed OUTSIDE the credential lock.
 *
 * Network runs on a snapshot; only the write happens under the lock. If any
 * credential the result was derived from changed meanwhile (a Flux key saved,
 * a token re-minted, the Worker token rotated), the result is stale and is
 * discarded: the next timer tick recomputes it from the new document. */
export function applyComposioCredentialResult(current, snapshot, next) {
  for (const key of ["composioBrokerToken", "fluxApiKey", "fluxComposioBrokerToken"]) {
    if ((current?.[key] ?? undefined) !== (snapshot?.[key] ?? undefined)) return { credentials: current, applied: false };
  }
  const merged = { ...current };
  for (const key of COMPOSIO_CREDENTIAL_FIELDS) {
    if (next[key] === undefined) delete merged[key];
    else merged[key] = next[key];
  }
  return { credentials: merged, applied: true };
}

/** Update options for the optional startup writer. An unchanged derivation (a
 * pending registration aborted, a transient outage) skips the native write; a
 * definitive 401 invalidation or a completed registration changes the document
 * and persists, even if the request that followed was aborted. */
export const MANAGED_COMPOSIO_UPDATE_OPTIONS = Object.freeze({ skipUnchanged: true });

/** The optional startup derivation, run under the shared credential queue. The
 * queue performs the one atomic encrypted write after the complete document is
 * derived, so the helper's own save hook is a no-op here. */
export function deriveManagedComposioCredentials(options) {
  return async (credentials) => {
    await ensureManagedComposioCredentials({ ...options, credentials, saveCredentials: async () => {} });
    return credentials;
  };
}

export async function ensureManagedComposioCredentials({
  brokerUrl,
  credentials,
  fetchImpl = globalThis.fetch,
  saveCredentials,
  log = () => {},
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
  if (TOKEN.test(credentials.composioBrokerToken ?? "")) {
    try {
      const check = await fetchImpl(`${url}/v1/me`, {
        headers: { authorization: `Bearer ${credentials.composioBrokerToken}` },
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
    log(`connected-apps registration failed: ${error?.message ?? error}`);
  }
  return credentials;
}
