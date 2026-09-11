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
    expect(calls).toHaveLength(1);
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
  const main = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "main.mjs"), "utf8");

  it("mints and claims from the desktop shell only when packaged", () => {
    // A dev shell has no encrypted Flux key and no server child to hand a
    // token to (`syncManagedComposioCredentials` needs `serverProc`), so a
    // mint there could only ever burn one of the account's five live tokens.
    // The dev harness mints for itself: server/flux-composio-dev-token.ts.
    const gate = main.slice(main.indexOf("function fluxComposioLifecycleEnabled()"), main.indexOf("\n}\n", main.indexOf("function fluxComposioLifecycleEnabled()")));
    expect(gate).toContain("app.isPackaged");
    expect(gate).toContain("fluxComposioBrokerUrlValue()");
    expect(gate).toContain("!credentialStoreUnavailable");

    const lifecycle = main.slice(main.indexOf("async function runComposioLifecycle("), main.indexOf("function startComposioLifecycleTimer()"));
    expect(lifecycle).toContain("if (!fluxComposioLifecycleEnabled() || !secureCredentialState)");
    const timer = main.slice(main.indexOf("function startComposioLifecycleTimer()"), main.indexOf("\n}\n", main.indexOf("function startComposioLifecycleTimer()")));
    expect(timer).toContain("!fluxComposioLifecycleEnabled()");
    // Every trigger goes through the gate: boot, the Flux key save, the
    // revoked-token message. The consent button refuses a dev launch outright.
    expect(main.match(/if \(fluxComposioLifecycleEnabled\(\)\) (?:void )?runComposioLifecycle\(/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(main).toContain("if (fluxComposioLifecycleEnabled()) {\n    void runComposioLifecycle().catch(() => {});\n    startComposioLifecycleTimer();");
    expect(main).toContain("if (fluxComposioLifecycleEnabled()) {\n      void runComposioLifecycle().catch(() => {});\n      startComposioLifecycleTimer();");
    expect(main).toContain("if (fluxComposioLifecycleEnabled()) void runComposioLifecycle({ force: true })");
    const claim = main.slice(main.indexOf('ipcMain.handle("composio:claim-legacy"'), main.indexOf("runComposioLifecycle({ claim: true })"));
    expect(claim).toContain("if (!app.isPackaged) throw new Error(");
  });
});
