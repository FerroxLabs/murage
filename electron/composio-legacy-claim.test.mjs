// Moving a device's connected apps without losing them.
//
// The rule every test here enforces: nothing destructive happens until the
// move is definitively done or definitively impossible. Composio cannot re-key
// a connection, so the install's `murage_<id>` identity IS the user's Gmail
// grant — drop the Worker token on a transient failure and those connections
// are gone for good. Exactly two answers are treated as final: a Worker 401
// (the install row is gone or disabled) and a terminal 409 from FluxRouter.
// Everything else, 404 and 5xx and offline included, means "try later".
import { describe, expect, it, vi } from "vitest";

import { claimLegacyComposioInstall, prepareLegacyComposioClaim } from "./composio-legacy-claim.mjs";
import { readComposioLegacyClaim } from "./managed-composio.mjs";
import { sha256Hex } from "./flux-composio-token.mjs";

const FLUX = "https://api.fluxrouter.ai/composio";
const LEGACY = "https://composio-broker.murage.workers.dev";
const INSTALL_TOKEN = "a".repeat(64);
const BROKER_TOKEN = "b".repeat(64);
const INSTALL_ID = "11111111-2222-4333-8444-555555555555";
const JTI = "99999999-8888-4777-8666-555555555555";
const NOW = Date.UTC(2026, 8, 11, 12, 0, 0);

const credentials = (overrides = {}) => ({
  composioBrokerToken: INSTALL_TOKEN,
  composioInstallationId: INSTALL_ID,
  fluxComposioBrokerToken: BROKER_TOKEN,
  fluxApiKey: "sk-flux-stored",
  ...overrides,
});

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Route a fake fetch by "METHOD path", so a test says only what it changes. */
function router(routes) {
  const calls = [];
  const impl = vi.fn(async (url, init = {}) => {
    const path = String(url).replace(FLUX, "flux").replace(LEGACY, "legacy");
    const key = `${init.method ?? "GET"} ${path}`;
    calls.push({ key, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers ?? {} });
    const handler = routes[key];
    if (!handler) throw new Error(`unrouted ${key}`);
    return typeof handler === "function" ? handler() : handler;
  });
  return { impl, calls, keys: () => calls.map((call) => call.key) };
}

const options = (impl, over = {}) => ({
  fluxBrokerUrl: FLUX,
  legacyBrokerUrl: LEGACY,
  fetchImpl: impl,
  now: NOW,
  fluxKey: "sk-flux-stored",
  ...over,
});

// A fresh Response each time: a body can only be read once, and these routes
// are shared across tests.
const HEALTHY = () => jsonResponse({ service: "flux-composio", ready: true, claims: true });
const ISSUED = () => jsonResponse({ assertion: "eyJhbGciOiJFZERTQSJ9.payload.signature", expiresAt: NOW + 300_000, jti: JTI });

describe("preparing the move at boot", () => {
  it("offers a shared account the choice and asks the Worker for nothing", async () => {
    // Every holder of a team account's keys would be able to use these
    // connections. That is a consent decision, not a boot-time one.
    const { impl, keys } = router({
      "GET flux/health": HEALTHY,
      "GET flux/v1/me": jsonResponse({ installationId: "acct-1", accountKind: "shared", legacyInstallationId: null, claimable: true }),
    });
    const next = await prepareLegacyComposioClaim({ ...options(impl), credentials: credentials() });

    expect(readComposioLegacyClaim(next)).toMatchObject({ state: "offered", installationId: INSTALL_ID });
    expect(keys()).toEqual(["GET flux/health", "GET flux/v1/me"]);
    expect(next.fluxComposioAccountKind).toBe("shared");
  });

  it("moves a personal desktop account by itself", async () => {
    // A desktop-OAuth key's account is one person's identity, so there is
    // nobody else to consent on behalf of.
    const { impl, keys } = router({
      "GET flux/health": HEALTHY,
      "GET flux/v1/me": jsonResponse({ installationId: "acct-1", accountKind: "personal", legacyInstallationId: null, claimable: true }),
      "POST legacy/v1/claims": ISSUED,
      "POST flux/v1/claim": jsonResponse({ claimed: true, legacyInstallationId: INSTALL_ID, jti: JTI }),
      "POST legacy/v1/claims/confirm": jsonResponse({ confirmed: true, graceEndsAt: NOW + 900_000 }),
    });
    const next = await prepareLegacyComposioClaim({ ...options(impl), credentials: credentials() });

    expect(readComposioLegacyClaim(next)).toMatchObject({ state: "claimed" });
    expect(readComposioLegacyClaim(next).confirmPending).toBeUndefined();
    expect(keys()).toContain("POST legacy/v1/claims/confirm");
  });

  it("records a blocked account as a conflict rather than retrying for ever", async () => {
    const { impl } = router({
      "GET flux/health": HEALTHY,
      "GET flux/v1/me": jsonResponse({ accountKind: "shared", claimable: false, claimBlockedReason: "account_has_connections" }),
    });
    const next = await prepareLegacyComposioClaim({ ...options(impl), credentials: credentials() });
    expect(readComposioLegacyClaim(next)).toMatchObject({ state: "conflict", code: "account_has_connections" });
  });

  it("changes nothing while FluxRouter is unhealthy or has claims paused", async () => {
    for (const health of [
      jsonResponse({ ready: false, claims: true }),
      jsonResponse({ ready: true, claims: false }),
      jsonResponse({ error: "nope" }, 503),
    ]) {
      const { impl, keys } = router({ "GET flux/health": health });
      const next = await prepareLegacyComposioClaim({ ...options(impl), credentials: credentials() });
      expect(readComposioLegacyClaim(next)).toEqual({ state: "none" });
      expect(keys()).toEqual(["GET flux/health"]);
    }
  });

  it("finishes a claim that completed while the app was closed", async () => {
    // FluxRouter already holds this install. All that is owed is the Worker's
    // confirmation, and re-running the legs is safe because redeem is
    // idempotent for an account that already carries this install.
    const { impl, keys } = router({
      "GET flux/health": HEALTHY,
      "GET flux/v1/me": jsonResponse({ accountKind: "personal", legacyInstallationId: INSTALL_ID, claimable: false }),
      "POST legacy/v1/claims/confirm": jsonResponse({ confirmed: true }),
    });
    const next = await prepareLegacyComposioClaim({
      ...options(impl),
      credentials: credentials({ composioLegacyClaim: JSON.stringify({ state: "claimed", jti: JTI, confirmPending: true, installationId: INSTALL_ID }) }),
    });
    expect(readComposioLegacyClaim(next)).toMatchObject({ state: "claimed" });
    expect(readComposioLegacyClaim(next).confirmPending).toBeUndefined();
    expect(keys()).not.toContain("POST legacy/v1/claims");
  });

  it("stays out of the way once the state is terminal", async () => {
    for (const state of ["conflict", "abandoned"]) {
      const { impl, keys } = router({});
      const next = await prepareLegacyComposioClaim({
        ...options(impl),
        credentials: credentials({ composioLegacyClaim: JSON.stringify({ state, code: "claims_closed" }) }),
      });
      expect(readComposioLegacyClaim(next).state).toBe(state);
      expect(keys()).toEqual([]);
    }
  });
});

describe("running the three legs", () => {
  it("binds the assertion to this broker token and keeps the Worker token afterwards", async () => {
    const { impl, calls, keys } = router({
      "POST legacy/v1/claims": ISSUED,
      "POST flux/v1/claim": jsonResponse({ claimed: true, legacyInstallationId: INSTALL_ID, jti: JTI }),
      "POST legacy/v1/claims/confirm": jsonResponse({ confirmed: true }),
    });
    const next = await claimLegacyComposioInstall({ ...options(impl), credentials: credentials() });

    expect(keys()).toEqual(["POST legacy/v1/claims", "POST flux/v1/claim", "POST legacy/v1/claims/confirm"]);
    expect(calls[0].body).toEqual({ audience: "fluxrouter-composio", brokerTokenSha256: sha256Hex(BROKER_TOKEN) });
    expect(calls[0].headers.authorization).toBe(`Bearer ${INSTALL_TOKEN}`);
    expect(calls[1].headers.authorization).toBe(`Bearer ${BROKER_TOKEN}`);
    expect(calls[2].body).toEqual({ jti: JTI });
    // The kept token is the rollback path: the Worker's gate, not a deleted
    // credential, is what stops the install using both brokers.
    expect(next.composioBrokerToken).toBe(INSTALL_TOKEN);
    expect(next.composioInstallationId).toBe(INSTALL_ID);
    expect(readComposioLegacyClaim(next)).toMatchObject({ state: "claimed", installationId: INSTALL_ID });
  });

  it("never sends the Flux API key to the Worker, in any form", async () => {
    const { impl, calls } = router({
      "POST legacy/v1/claims": ISSUED,
      "POST flux/v1/claim": jsonResponse({ claimed: true, jti: JTI }),
      "POST legacy/v1/claims/confirm": jsonResponse({ confirmed: true }),
    });
    await claimLegacyComposioInstall({ ...options(impl), credentials: credentials() });
    const toWorker = JSON.stringify(calls.filter((call) => call.key.includes("legacy/")));
    expect(toWorker).not.toContain("sk-flux-stored");
    expect(toWorker).not.toContain(sha256Hex("sk-flux-stored"));
  });

  it("abandons the Worker identity only on its one definitive answer", async () => {
    const { impl } = router({ "POST legacy/v1/claims": jsonResponse({ error: "unauthorized" }, 401) });
    const next = await claimLegacyComposioInstall({ ...options(impl), credentials: credentials() });
    expect(readComposioLegacyClaim(next)).toMatchObject({ state: "abandoned", code: "legacy_token_rejected" });
    expect(next.composioBrokerToken).toBeUndefined();
    expect(next.composioInstallationId).toBeUndefined();
  });

  it("treats a Worker 404 as 'try later', because that is what a rollback looks like", async () => {
    // The pre-claim Worker has no /v1/claims route and answers 404 for a
    // perfectly valid token. Reading that as terminal would strand the
    // install the moment Sean rolled back.
    const { impl } = router({ "POST legacy/v1/claims": jsonResponse({ error: "not found" }, 404) });
    const next = await claimLegacyComposioInstall({ ...options(impl), credentials: credentials() });
    expect(readComposioLegacyClaim(next).state).toBe("pending");
    expect(next.composioBrokerToken).toBe(INSTALL_TOKEN);
  });

  it("stops for good when the claim window has closed", async () => {
    const { impl } = router({ "POST legacy/v1/claims": jsonResponse({ error: "ended", code: "claims_closed" }, 410) });
    const next = await claimLegacyComposioInstall({ ...options(impl), credentials: credentials() });
    expect(readComposioLegacyClaim(next)).toMatchObject({ state: "conflict", code: "claims_closed" });
    expect(next.composioBrokerToken).toBe(INSTALL_TOKEN);
  });

  it.each(["account_already_claimed", "account_has_connections", "install_already_claimed"])(
    "records FluxRouter's %s as terminal and keeps the apps where they are",
    async (code) => {
      const { impl } = router({
        "POST legacy/v1/claims": ISSUED,
        "POST flux/v1/claim": jsonResponse({ error: "no", code }, 409),
      });
      const next = await claimLegacyComposioInstall({ ...options(impl), credentials: credentials() });
      expect(readComposioLegacyClaim(next)).toMatchObject({ state: "conflict", code });
      expect(next.composioBrokerToken).toBe(INSTALL_TOKEN);
    },
  );

  it("re-mints and retries when FluxRouter says the broker token is revoked", async () => {
    const { impl, keys } = router({
      "POST legacy/v1/claims": ISSUED,
      "POST flux/v1/claim": jsonResponse({ error: "no", code: "broker_token_revoked" }, 401),
      "POST flux/v1/tokens": jsonResponse({ token: "c".repeat(64), expiresAt: new Date(NOW + 30 * 86_400_000).toISOString(), accountKind: "personal" }),
    });
    const next = await claimLegacyComposioInstall({ ...options(impl), credentials: credentials() });
    expect(keys()).toContain("POST flux/v1/tokens");
    expect(next.fluxComposioBrokerToken).toBe("c".repeat(64));
    expect(readComposioLegacyClaim(next).state).toBe("pending");
  });

  it("keeps confirmPending set when the Worker cannot be told yet", async () => {
    // Until the Worker is told, it keeps serving this install. Nothing is
    // lost by waiting; the retry timer carries it.
    const { impl } = router({
      "POST legacy/v1/claims": ISSUED,
      "POST flux/v1/claim": jsonResponse({ claimed: true, jti: JTI }),
      "POST legacy/v1/claims/confirm": jsonResponse({ error: "down" }, 503),
    });
    const next = await claimLegacyComposioInstall({ ...options(impl), credentials: credentials() });
    const claim = readComposioLegacyClaim(next);
    expect(claim).toMatchObject({ state: "claimed", confirmPending: true, jti: JTI });

    // The next tick retries only the confirmation.
    const retry = router({ "POST legacy/v1/claims/confirm": jsonResponse({ confirmed: true }) });
    const confirmed = await claimLegacyComposioInstall({ ...options(retry.impl), credentials: next });
    expect(retry.keys()).toEqual(["POST legacy/v1/claims/confirm"]);
    expect(readComposioLegacyClaim(confirmed).confirmPending).toBeUndefined();
  });

  it("re-runs every leg when the Worker no longer recognises the claim", async () => {
    const { impl } = router({
      "POST legacy/v1/claims": ISSUED,
      "POST flux/v1/claim": jsonResponse({ claimed: true, jti: JTI }),
      "POST legacy/v1/claims/confirm": jsonResponse({ error: "unknown claim", code: "claim_unknown" }, 409),
    });
    const next = await claimLegacyComposioInstall({ ...options(impl), credentials: credentials() });
    expect(readComposioLegacyClaim(next).state).toBe("pending");
    expect(next.composioBrokerToken).toBe(INSTALL_TOKEN);
  });

  it("keeps everything on a network failure", async () => {
    const next = await claimLegacyComposioInstall({
      ...options(async () => { throw new Error("offline"); }),
      credentials: credentials(),
    });
    expect(readComposioLegacyClaim(next).state).toBe("pending");
    expect(next.composioBrokerToken).toBe(INSTALL_TOKEN);
    expect(next.fluxComposioBrokerToken).toBe(BROKER_TOKEN);
  });

  it("does nothing without both credentials", async () => {
    const { impl, keys } = router({});
    for (const missing of [{ composioBrokerToken: undefined }, { fluxComposioBrokerToken: undefined }, { composioInstallationId: undefined }]) {
      const next = await claimLegacyComposioInstall({ ...options(impl), credentials: credentials(missing) });
      expect(readComposioLegacyClaim(next)).toEqual({ state: "none" });
    }
    expect(keys()).toEqual([]);
  });
});
