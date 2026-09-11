// Moving a Worker-registered install's connected apps onto a FluxRouter
// account without orphaning them.
//
// The Worker registered each install as Composio user murage_<install id>.
// Composio cannot re-key connections to a new user id, so the FluxRouter
// account ADOPTS that user id instead. Three legs, each a separate request:
//
//   1. issue   the Worker signs a 5-minute assertion for this install, bound
//              to sha256(Flux broker token) so nobody else can redeem it
//   2. redeem  Flux verifies the assertion and binds the account to it
//   3. confirm the Worker records that Flux accepted; ITS grace clock starts
//              here, never at issuance, so a failed redeem strands nothing
//
// Boot only PREPARES (health + /v1/me). A shared (team) account is moved only
// on the user's explicit button press, because every holder of that
// account's keys would then use these connections. A personal desktop-OAuth
// account is one person's identity and is moved automatically.
//
// Every failure keeps the Worker token. Only two answers are definitive: a
// Worker 401 for the install token (the install no longer exists) and a
// terminal 409 from Flux. The kept token is the rollback path.
import {
  normalizeManagedComposioBrokerUrl,
  readComposioLegacyClaim,
  writeComposioLegacyClaim,
} from "./managed-composio.mjs";
import {
  clearFluxComposioBrokerToken,
  ensureFluxComposioBrokerToken,
  FLUX_BROKER_TOKEN,
  sha256Hex,
} from "./flux-composio-token.mjs";

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

async function remintAfterRevocation(credentials, { fluxBrokerUrl, fluxKey, fetchImpl, log, timeoutSignal, now }) {
  const cleared = clearFluxComposioBrokerToken(credentials);
  if (!fluxKey) return cleared;
  return ensureFluxComposioBrokerToken({ fluxBrokerUrl, credentials: cleared, fluxKey, fetchImpl, log, timeoutSignal, now, force: true });
}

/** The three legs. Runs on the PluginsPanel button, on auto-claim, and on the
 * retry timer for `pending` and `confirmPending`. Returns the next document. */
export async function claimLegacyComposioInstall({
  fluxBrokerUrl,
  legacyBrokerUrl,
  credentials,
  fluxKey,
  fetchImpl = globalThis.fetch,
  log = () => {},
  timeoutSignal = (milliseconds) => AbortSignal.timeout(milliseconds),
  now = Date.now(),
  onRateLimited = () => {},
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
        body: JSON.stringify({ audience: "fluxrouter-composio", brokerTokenSha256: sha256Hex(next.fluxComposioBrokerToken) }),
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
      if (response.status === 429) onRateLimited();
      if (!response.ok || typeof body?.assertion !== "string" || body.assertion.length > 8192) {
        // 404 included: after a Worker rollback the old code has no
        // /v1/claims route and answers 404 for a perfectly valid token.
        log(`moving connected apps: Murage's service returned HTTP ${response.status}; will retry`);
        return transition(next, previous, { state: "pending", code: response.status === 429 ? "rate_limited" : undefined }, nowIso);
      }
      issued = body;
    } catch {
      return transition(next, previous, { state: "pending" }, nowIso);
    }

    // Leg 2: redeem.
    try {
      const response = await fetchImpl(`${flux}/v1/claim`, {
        method: "POST",
        headers: { authorization: `Bearer ${next.fluxComposioBrokerToken}`, "content-type": "application/json" },
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
        next = await remintAfterRevocation(next, { fluxBrokerUrl: flux, fluxKey, fetchImpl, log, timeoutSignal, now });
        return transition(next, previous, { state: "pending" }, nowIso);
      } else {
        if (response.status === 429) onRateLimited();
        log(`moving connected apps: FluxRouter returned HTTP ${response.status}; will retry`);
        return transition(next, previous, { state: "pending", code: response.status === 429 ? "rate_limited" : undefined }, nowIso);
      }
    } catch {
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
    if (response.status === 429) onRateLimited();
  } catch {
    // retried on the timer
  }
  return transition(next, current, { ...current }, nowIso);
}

/** The boot and timer path. Network only; never asks the Worker to sign
 * anything for a shared account. Returns the next document. */
export async function prepareLegacyComposioClaim({
  fluxBrokerUrl,
  legacyBrokerUrl,
  credentials,
  fluxKey,
  fetchImpl = globalThis.fetch,
  log = () => {},
  timeoutSignal = (milliseconds) => AbortSignal.timeout(milliseconds),
  now = Date.now(),
  onRateLimited = () => {},
}) {
  const flux = normalizeManagedComposioBrokerUrl(fluxBrokerUrl);
  let next = { ...credentials };
  const claim = readComposioLegacyClaim(next);
  if (!flux || !claimPreconditions(next, claim)) return next;
  const options = { fluxBrokerUrl: flux, legacyBrokerUrl, fluxKey, fetchImpl, log, timeoutSignal, now, onRateLimited };
  if (claim.state === "claimed" && claim.confirmPending) return claimLegacyComposioInstall({ ...options, credentials: next });

  try {
    const health = await fetchImpl(`${flux}/health`, { redirect: "error", signal: timeoutSignal(5_000) });
    const body = await readJson(health);
    if (!health.ok || body?.ready !== true || body?.claims === false) return next;
  } catch {
    return next;
  }

  let me;
  try {
    const response = await fetchImpl(`${flux}/v1/me`, {
      headers: { authorization: `Bearer ${next.fluxComposioBrokerToken}` },
      redirect: "error",
      signal: timeoutSignal(8_000),
    });
    me = await readJson(response);
    if (response.status === 401 && codeOf(me) === "broker_token_revoked") {
      return remintAfterRevocation(next, { fluxBrokerUrl: flux, fluxKey, fetchImpl, log, timeoutSignal, now });
    }
    if (response.status === 429) onRateLimited();
    if (!response.ok || !me || typeof me !== "object") return next;
  } catch {
    return next;
  }
  if (me.accountKind === "personal" || me.accountKind === "shared") next.fluxComposioAccountKind = me.accountKind;
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
    return claimLegacyComposioInstall({ ...options, credentials: next });
  }
  if (me.claimable === false) {
    const code = codeOf({ code: me.claimBlockedReason }) ?? "account_already_claimed";
    return transition(next, claim, { state: "conflict", code }, nowIso);
  }
  if (me.claimable !== true) return next;
  if (me.accountKind === "personal") return claimLegacyComposioInstall({ ...options, credentials: next });
  if (claim.state === "pending") return next; // the user already chose; the timer retries the legs
  return transition(next, claim, { state: "offered" }, nowIso);
}
