// The two-credential rule, tested where it is decided.
//
// Engines receive the Flux API key — the claude CLI gets it as
// ANTHROPIC_API_KEY — so if that key were also what unlocked connected apps,
// any shell command a model ran could read the owner's Gmail past the per-bot
// restrictions. The key is used exactly once, here, to mint a broker token the
// harness keeps. These tests hold that line: the key goes to `/v1/tokens` and
// nowhere else, and only the STORED key is ever spent.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  brokerTokenFingerprint,
  clearFluxComposioBrokerToken,
  ensureFluxComposioBrokerToken,
  fluxKeyFingerprint,
  revokeFluxComposioBrokerToken,
  sha256Hex,
} from "./flux-composio-token.mjs";

const FLUX = "https://api.fluxrouter.ai/composio";
const TOKEN = "a".repeat(64);
const NEXT_TOKEN = "b".repeat(64);
const KEY = "sk-flux-stored";
const NOW = Date.UTC(2026, 8, 11, 12, 0, 0);
const DAY = 86_400_000;

const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();

/** A fetch stand-in that records every call and answers by path. */
function fakeFetch(handlers) {
  const calls = [];
  const impl = vi.fn(async (url, init) => {
    calls.push({ url: String(url), init });
    for (const [suffix, handler] of Object.entries(handlers)) {
      if (String(url).endsWith(suffix)) return handler(init);
    }
    return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
  });
  return { impl, calls };
}

const minted = (token = NEXT_TOKEN, accountKind = "shared") => () =>
  new Response(JSON.stringify({ token, expiresAt: iso(30 * DAY), accountId: "acct-1", accountKind }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const declined = (status, code) => () =>
  new Response(JSON.stringify({ error: "no", code }), { status, headers: { "content-type": "application/json" } });

const base = (overrides = {}) => ({ fluxBrokerUrl: FLUX, fluxKey: KEY, now: NOW, ...overrides });

describe("minting the FluxRouter connected-apps token", () => {
  it("mints when there is no token, and stores what identifies it", async () => {
    const { impl, calls } = fakeFetch({ "/v1/tokens": minted() });
    const next = await ensureFluxComposioBrokerToken(base({ credentials: {}, fetchImpl: impl }));

    expect(next.fluxComposioBrokerToken).toBe(NEXT_TOKEN);
    expect(next.fluxComposioBrokerTokenKeyFingerprint).toBe(fluxKeyFingerprint(KEY));
    expect(next.fluxComposioAccountKind).toBe("shared");
    expect(Date.parse(next.fluxComposioBrokerTokenExpiresAt)).toBe(NOW + 30 * DAY);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${FLUX}/v1/tokens`);
    expect(calls[0].init.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(calls[0].init.body)).toEqual({ label: "murage-desktop" });
  });

  it("labels the token for whoever is minting, so a dev harness's shows as such at FluxRouter", async () => {
    const { impl, calls } = fakeFetch({ "/v1/tokens": minted() });
    await ensureFluxComposioBrokerToken(base({ credentials: {}, fetchImpl: impl, label: "murage-dev-harness" }));
    expect(JSON.parse(calls[0].init.body)).toEqual({ label: "murage-dev-harness" });
  });

  it("leaves a healthy token alone", async () => {
    const { impl, calls } = fakeFetch({ "/v1/tokens": minted() });
    const credentials = {
      fluxComposioBrokerToken: TOKEN,
      fluxComposioBrokerTokenExpiresAt: iso(20 * DAY),
      fluxComposioBrokerTokenKeyFingerprint: fluxKeyFingerprint(KEY),
    };
    const next = await ensureFluxComposioBrokerToken(base({ credentials, fetchImpl: impl }));
    expect(next.fluxComposioBrokerToken).toBe(TOKEN);
    expect(calls).toHaveLength(0);
  });

  it("re-mints with a week left, so a token never expires mid-use", async () => {
    const { impl, calls } = fakeFetch({ "/v1/tokens": minted() });
    const credentials = {
      fluxComposioBrokerToken: TOKEN,
      fluxComposioBrokerTokenExpiresAt: iso(6 * DAY),
      fluxComposioBrokerTokenKeyFingerprint: fluxKeyFingerprint(KEY),
    };
    const next = await ensureFluxComposioBrokerToken(base({ credentials, fetchImpl: impl }));
    expect(next.fluxComposioBrokerToken).toBe(NEXT_TOKEN);
    // Mint first; then this install's own previous token is revoked (see the
    // 0.1.62 rules below), so a renewal never leaves a second live token
    // counting against the account's cap.
    expect(calls.map((call) => `${call.init.method} ${call.url.replace(FLUX, "")}`)).toEqual(["POST /v1/tokens", "DELETE /v1/tokens/current"]);
  });

  it("re-mints and revokes the old token when a different key arrives", async () => {
    // The old token belongs to the old account. Leaving it live would leave a
    // credential for an account this install no longer uses.
    const { impl, calls } = fakeFetch({ "/v1/tokens/current": () => new Response(null, { status: 200 }), "/v1/tokens": minted() });
    const credentials = {
      fluxComposioBrokerToken: TOKEN,
      fluxComposioBrokerTokenExpiresAt: iso(20 * DAY),
      fluxComposioBrokerTokenKeyFingerprint: fluxKeyFingerprint("sk-flux-previous"),
    };
    const next = await ensureFluxComposioBrokerToken(base({ credentials, fetchImpl: impl }));
    expect(next.fluxComposioBrokerToken).toBe(NEXT_TOKEN);
    const revoke = calls.find((call) => call.url.endsWith("/v1/tokens/current"));
    expect(revoke?.init.method).toBe("DELETE");
    expect(revoke?.init.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("clears and revokes the token when the Flux key is removed", async () => {
    const { impl, calls } = fakeFetch({ "/v1/tokens/current": () => new Response(null, { status: 200 }) });
    const credentials = {
      fluxComposioBrokerToken: TOKEN,
      fluxComposioBrokerTokenExpiresAt: iso(20 * DAY),
      fluxComposioBrokerTokenKeyFingerprint: fluxKeyFingerprint(KEY),
      fluxComposioAccountKind: "personal",
    };
    const next = await ensureFluxComposioBrokerToken(base({ credentials, fluxKey: "", fetchImpl: impl }));
    expect(next.fluxComposioBrokerToken).toBeUndefined();
    expect(next.fluxComposioAccountKind).toBeUndefined();
    expect(calls[0].url).toBe(`${FLUX}/v1/tokens/current`);
  });

  it.each([
    [402, "flux_key_budget_exhausted"],
    [401, "flux_key_expired"],
    [403, "flux_key_blocked"],
  ])("keeps the existing token on a %i and records why (%s)", async (status, code) => {
    // A data route never consults the key's model budget, so a token minted
    // before the budget ran out keeps working. Throwing it away would take
    // connected apps from someone who still has them.
    const { impl } = fakeFetch({ "/v1/tokens": declined(status, code) });
    const credentials = {
      fluxComposioBrokerToken: TOKEN,
      fluxComposioBrokerTokenExpiresAt: iso(1 * DAY),
      fluxComposioBrokerTokenKeyFingerprint: fluxKeyFingerprint(KEY),
    };
    const next = await ensureFluxComposioBrokerToken(base({ credentials, fetchImpl: impl }));
    expect(next.fluxComposioBrokerToken).toBe(TOKEN);
    expect(next.fluxComposioTokenError).toBe(code);
  });

  it("keeps everything on a network error or an unexpected status", async () => {
    const credentials = { fluxComposioBrokerToken: TOKEN, fluxComposioBrokerTokenExpiresAt: iso(1 * DAY), fluxComposioBrokerTokenKeyFingerprint: fluxKeyFingerprint(KEY) };
    const thrown = await ensureFluxComposioBrokerToken(base({
      credentials,
      fetchImpl: async () => { throw new Error("offline"); },
    }));
    expect(thrown.fluxComposioBrokerToken).toBe(TOKEN);
    expect(thrown.fluxComposioTokenError).toBeUndefined();

    let rateLimited = false;
    const { impl } = fakeFetch({ "/v1/tokens": () => new Response("{}", { status: 429, headers: { "content-type": "application/json" } }) });
    const throttled = await ensureFluxComposioBrokerToken(base({ credentials, fetchImpl: impl, onRateLimited: () => { rateLimited = true; } }));
    expect(throttled.fluxComposioBrokerToken).toBe(TOKEN);
    expect(rateLimited).toBe(true);
  });

  it("refuses a reply that is not a well-formed 64-hex token", async () => {
    const { impl } = fakeFetch({
      "/v1/tokens": () => new Response(JSON.stringify({ token: "short", expiresAt: iso(DAY) }), { status: 200, headers: { "content-type": "application/json" } }),
    });
    const next = await ensureFluxComposioBrokerToken(base({ credentials: {}, fetchImpl: impl }));
    expect(next.fluxComposioBrokerToken).toBeUndefined();
  });

  it("does nothing at all without a broker URL", async () => {
    const { impl, calls } = fakeFetch({});
    const next = await ensureFluxComposioBrokerToken(base({ fluxBrokerUrl: "", credentials: {}, fetchImpl: impl }));
    expect(next).toEqual({});
    expect(calls).toHaveLength(0);
  });

  it("spends only the key it was handed, never an ambient FLUX_API_KEY", async () => {
    // The stored key and the shell's key can name different accounts. If the
    // token were minted from one and the claim run against the other, a
    // device's connections would be moved onto an account nobody chose.
    const previous = process.env.FLUX_API_KEY;
    process.env.FLUX_API_KEY = "sk-flux-ambient";
    try {
      const { impl, calls } = fakeFetch({ "/v1/tokens": minted() });
      await ensureFluxComposioBrokerToken(base({ credentials: {}, fetchImpl: impl }));
      expect(calls[0].init.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(JSON.stringify(calls)).not.toContain("sk-flux-ambient");
    } finally {
      if (previous === undefined) delete process.env.FLUX_API_KEY;
      else process.env.FLUX_API_KEY = previous;
    }
  });
});

describe("the token's supporting helpers", () => {
  it("fingerprints a key without keeping it, or its whole hash", () => {
    const fingerprint = fluxKeyFingerprint(KEY);
    expect(fingerprint).toHaveLength(16);
    expect(sha256Hex(KEY).startsWith(fingerprint)).toBe(true);
    expect(fingerprint).not.toContain(KEY);
    expect(fluxKeyFingerprint("other")).not.toBe(fingerprint);
  });

  it("clears every token field and leaves the rest of the document alone", () => {
    const cleared = clearFluxComposioBrokerToken({
      fluxApiKey: KEY,
      composioBrokerToken: TOKEN,
      fluxComposioBrokerToken: TOKEN,
      fluxComposioBrokerTokenExpiresAt: iso(DAY),
      fluxComposioBrokerTokenKeyFingerprint: "x",
      fluxComposioAccountKind: "shared",
      fluxComposioTokenError: "flux_key_expired",
    });
    expect(cleared).toEqual({ fluxApiKey: KEY, composioBrokerToken: TOKEN });
  });

  it("treats an unreachable revoke as done", async () => {
    await expect(revokeFluxComposioBrokerToken({
      fluxBrokerUrl: FLUX,
      token: TOKEN,
      fetchImpl: async () => { throw new Error("offline"); },
    })).resolves.toBe(false);
    await expect(revokeFluxComposioBrokerToken({ fluxBrokerUrl: FLUX, token: "nope", fetchImpl: async () => new Response(null) })).resolves.toBe(false);
  });
});

// main.mjs boots Electron on import, so its wiring is checked by source
// shape (the harness-resources suite does the same).
describe("who mints, in which build", () => {
  // LF whatever the checkout wrote: the shapes below span lines, and a
  // Windows checkout with core.autocrlf is CRLF.
  const main = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "main.mjs"), "utf8").replace(/\r\n/g, "\n");

  it("mints and claims from the desktop shell only when packaged", () => {
    // A dev shell has no encrypted Flux key and no server child to hand a
    // token to (`syncManagedComposioCredentials` needs `serverProc`), so a
    // mint there could only ever burn one of the account's five live tokens.
    // The dev harness mints for itself: server/flux-composio-dev-token.ts.
    const gate = main.slice(main.indexOf("function fluxComposioLifecycleEnabled()"), main.indexOf("\n}\n", main.indexOf("function fluxComposioLifecycleEnabled()")));
    expect(gate).toContain("app.isPackaged");
    expect(gate).toContain("fluxComposioBrokerUrlValue()");
    expect(gate).toContain("!credentialStoreUnavailable");

    const lifecycle = main.slice(main.indexOf("async function runComposioLifecyclePass("), main.indexOf("function startComposioLifecycleTimer()"));
    expect(lifecycle).toContain("if (!fluxComposioLifecycleEnabled() || !secureCredentialState)");
    const timer = main.slice(main.indexOf("function startComposioLifecycleTimer()"), main.indexOf("\n}\n", main.indexOf("function startComposioLifecycleTimer()")));
    expect(timer).toContain("!fluxComposioLifecycleEnabled()");
    // Every trigger goes through the gate: boot, the Flux key save, the
    // revoked-token message. The consent button refuses a dev launch outright.
    expect(main.match(/if \(fluxComposioLifecycleEnabled\(\)\) (?:void )?runComposioLifecycle\(|if \(fluxComposioLifecycleEnabled\(\)\) \{\s+void runComposioLifecycle\(/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(main).toContain("if (fluxComposioLifecycleEnabled()) {\n    void runComposioLifecycle().catch(() => {});\n    startComposioLifecycleTimer();");
    expect(main).toContain("if (fluxComposioLifecycleEnabled()) {\n      void runComposioLifecycle().catch(() => {});\n      startComposioLifecycleTimer();");
    // The rejected-token path is gated the same way, and it goes through the
    // decision (one automatic re-mint, or "another device took over").
    expect(main).toContain("if (fluxComposioLifecycleEnabled()) {\n          void composioTokenRejections.onRejected(");
    const reconnect = main.slice(main.indexOf('ipcMain.handle("composio:reconnect"'), main.indexOf("composioTokenRejections.reconnect()"));
    expect(reconnect).toContain("if (!fluxComposioLifecycleEnabled()) throw new Error(");
    const claim = main.slice(main.indexOf('ipcMain.handle("composio:claim-legacy"'), main.indexOf("runComposioLifecycle({ claim: true })"));
    expect(claim).toContain("if (!app.isPackaged) throw new Error(");
  });
});

// 2026-10-01: an install sent POST /composio/v1/tokens every ten minutes with
// an sk- key Flux never issued, and kept doing it after each 401.
describe("the connected-apps token needs a real Flux key", () => {
  for (const [name, value] of [["the base URL", "https://api.fluxrouter.ai/v1"], ["a short value", "abc12345xyz"], ["another provider's key", "sk-0123456789abcdef0123456789abcdef"]]) {
    it(`does not ask Flux with ${name}`, async () => {
      const { impl, calls } = fakeFetch({ "/v1/tokens": minted() });
      const next = await ensureFluxComposioBrokerToken(base({ credentials: {}, fluxKey: value, fetchImpl: impl }));
      expect(calls).toEqual([]);
      expect(next.fluxComposioBrokerToken).toBeUndefined();
    });
  }

  it("after Flux refuses a key, does not ask again with that key, and asks again once it changes", async () => {
    const { impl, calls } = fakeFetch({ "/v1/tokens": declined(401, "invalid_api_key") });
    const first = await ensureFluxComposioBrokerToken(base({ credentials: {}, fetchImpl: impl }));
    expect(calls).toHaveLength(1);
    expect(first.fluxComposioTokenError).toBe("invalid_api_key");
    const second = await ensureFluxComposioBrokerToken(base({ credentials: first, fetchImpl: impl, now: NOW + DAY }));
    expect(calls).toHaveLength(1);
    expect(second.fluxComposioTokenError).toBe("invalid_api_key");
    await ensureFluxComposioBrokerToken(base({ credentials: second, fluxKey: "sk-flux-replacement", fetchImpl: impl }));
    expect(calls).toHaveLength(2);
  });

  it("a 401 with no code still counts as a refusal", async () => {
    const { impl, calls } = fakeFetch({ "/v1/tokens": () => new Response("{}", { status: 401, headers: { "content-type": "application/json" } }) });
    const first = await ensureFluxComposioBrokerToken(base({ credentials: {}, fetchImpl: impl }));
    await ensureFluxComposioBrokerToken(base({ credentials: first, fetchImpl: impl }));
    expect(calls).toHaveLength(1);
  });
});

// 0.1.62 (Bug 2): the token-minting rules. Flux confirmed nothing minted or
// revoked on its side after 2026-10-01 03:11Z, so the churn in the log was
// this client re-creating sessions and clients. Each rule is one test.
describe("token minting rules", () => {
  const held = (over = {}) => ({
    fluxComposioBrokerToken: TOKEN,
    fluxComposioBrokerTokenExpiresAt: iso(20 * DAY),
    fluxComposioBrokerTokenKeyFingerprint: fluxKeyFingerprint(KEY),
    ...over,
  });
  const verbs = (calls) => calls.map((call) => `${call.init.method} ${call.url.replace(FLUX, "")}`);

  it("rule 1: never re-mints while a valid token exists, however often it is asked", async () => {
    const { impl, calls } = fakeFetch({ "/v1/tokens": minted() });
    let credentials = held();
    for (let i = 0; i < 5; i += 1) {
      credentials = await ensureFluxComposioBrokerToken(base({ credentials: { ...credentials }, fetchImpl: impl }));
    }
    expect(credentials.fluxComposioBrokerToken).toBe(TOKEN);
    expect(calls).toHaveLength(0);
  });

  it("rule 1: ignores a forced re-mint for a token that is no longer the one held", async () => {
    // Four 401s in one turn name the same dead token; once it has been
    // replaced the stragglers must not mint again.
    const { impl, calls } = fakeFetch({ "/v1/tokens": minted() });
    const next = await ensureFluxComposioBrokerToken(base({
      credentials: held({ fluxComposioBrokerToken: NEXT_TOKEN }),
      fetchImpl: impl,
      force: true,
      rejectedTokenFingerprint: brokerTokenFingerprint(TOKEN),
    }));
    expect(next.fluxComposioBrokerToken).toBe(NEXT_TOKEN);
    expect(calls).toHaveLength(0);
  });

  it("rule 1: does re-mint for the token that was actually rejected", async () => {
    const { impl, calls } = fakeFetch({ "/v1/tokens": minted(), "/v1/tokens/current": () => new Response(null, { status: 401 }) });
    const next = await ensureFluxComposioBrokerToken(base({
      credentials: held(),
      fetchImpl: impl,
      force: true,
      rejectedTokenFingerprint: brokerTokenFingerprint(TOKEN),
    }));
    expect(next.fluxComposioBrokerToken).toBe(NEXT_TOKEN);
    expect(verbs(calls)[0]).toBe("POST /v1/tokens");
  });

  it("rule 2: mints first, then revokes this install's own previous token and only that one", async () => {
    const { impl, calls } = fakeFetch({ "/v1/tokens/current": () => new Response(null, { status: 200 }), "/v1/tokens": minted() });
    const next = await ensureFluxComposioBrokerToken(base({ credentials: held(), fetchImpl: impl, force: true }));
    expect(next.fluxComposioBrokerToken).toBe(NEXT_TOKEN);
    expect(verbs(calls)).toEqual(["POST /v1/tokens", "DELETE /v1/tokens/current"]);
    // The revoke is made with the OLD token as bearer (that is how Flux names
    // the token to end); nothing of any other device's is touched.
    expect(calls[1].init.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("rule 2: never revokes the old token when the mint did not succeed, and keeps it", async () => {
    const { impl, calls } = fakeFetch({ "/v1/tokens": () => { throw new TypeError("fetch failed"); } });
    const next = await ensureFluxComposioBrokerToken(base({ credentials: held(), fetchImpl: impl, force: true }));
    expect(next.fluxComposioBrokerToken).toBe(TOKEN);
    expect(verbs(calls)).toEqual(["POST /v1/tokens"]);
  });

  it("rule 2: the app is never tokenless after an offline re-mint", async () => {
    const { impl } = fakeFetch({ "/v1/tokens": () => { throw new TypeError("fetch failed"); } });
    const next = await ensureFluxComposioBrokerToken(base({ credentials: held(), fetchImpl: impl, force: true }));
    expect(next.fluxComposioBrokerToken).toMatch(/^[0-9a-f]{64}$/);
  });

  it("review F12: with a revoke sink the old token is NOT revoked until the caller has saved the new one", async () => {
    const { impl, calls } = fakeFetch({ "/v1/tokens": minted(), "/v1/tokens/current": () => new Response(null, { status: 200 }) });
    const revokeSink = [];
    const next = await ensureFluxComposioBrokerToken(base({ credentials: held(), fetchImpl: impl, force: true, revokeSink }));
    expect(next.fluxComposioBrokerToken).toBe(NEXT_TOKEN);
    expect(verbs(calls)).toEqual(["POST /v1/tokens"]);
    expect(revokeSink).toEqual([{ fluxBrokerUrl: FLUX, previous: TOKEN, minted: NEXT_TOKEN }]);
  });

  it("rule 4: a new session or client with the same key reuses the token and mints nothing", async () => {
    const { impl, calls } = fakeFetch({ "/v1/tokens": minted() });
    const stored = held();
    // Two "clients": fresh credential copies, as a re-created session reads them.
    await ensureFluxComposioBrokerToken(base({ credentials: JSON.parse(JSON.stringify(stored)), fetchImpl: impl }));
    await ensureFluxComposioBrokerToken(base({ credentials: JSON.parse(JSON.stringify(stored)), fetchImpl: impl, label: "murage-dev-harness" }));
    expect(calls).toHaveLength(0);
  });

  it("reports a network failure as transient so the caller can retry soon", async () => {
    const { impl } = fakeFetch({ "/v1/tokens": () => { throw new TypeError("fetch failed"); } });
    const transient = vi.fn();
    await ensureFluxComposioBrokerToken(base({ credentials: {}, fetchImpl: impl, onTransientFailure: transient }));
    expect(transient).toHaveBeenCalledTimes(1);
  });

  it("reports a 503 as transient but a refusal of the key as not", async () => {
    const transient = vi.fn();
    const down = fakeFetch({ "/v1/tokens": declined(503) });
    await ensureFluxComposioBrokerToken(base({ credentials: {}, fetchImpl: down.impl, onTransientFailure: transient }));
    expect(transient).toHaveBeenCalledTimes(1);
    const refused = fakeFetch({ "/v1/tokens": declined(401, "flux_key_invalid") });
    await ensureFluxComposioBrokerToken(base({ credentials: {}, fetchImpl: refused.impl, onTransientFailure: transient }));
    expect(transient).toHaveBeenCalledTimes(1);
  });
});
