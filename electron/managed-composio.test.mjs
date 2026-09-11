import { describe, expect, it, vi } from "vitest";
import {
  applyComposioCredentialResult,
  composioLegacyBrokerUntil,
  deriveManagedComposioCredentials,
  ensureManagedComposioCredentials,
  MANAGED_COMPOSIO_UPDATE_OPTIONS,
  managedComposioAccess,
  fluxComposioBrokerUrl,
  legacyBrokerOpen,
  managedComposioChildEnvironment,
  normalizeManagedComposioBrokerUrl,
  publicComposioLegacyClaim,
  readComposioLegacyClaim,
  writeComposioLegacyClaim,
} from "./managed-composio.mjs";
import { COMPOSIO_LEGACY_BROKER_UNTIL, FLUX_COMPOSIO_BROKER_URL } from "./composio-release-config.mjs";

const TOKEN = "a".repeat(64);

describe("managed Composio desktop registration", () => {
  it("publishes only a complete broker credential", () => {
    expect(managedComposioAccess("https://broker.example/", { composioBrokerToken: TOKEN })).toEqual({
      url: "https://broker.example",
      token: TOKEN,
    });
    expect(managedComposioAccess("https://broker.example", {})).toBeNull();
    expect(managedComposioAccess("", { composioBrokerToken: TOKEN })).toBeNull();
  });

  it("accepts HTTPS and loopback development brokers but rejects insecure remote URLs", async () => {
    expect(normalizeManagedComposioBrokerUrl("https://broker.example/root/")).toBe(
      "https://broker.example/root",
    );
    expect(normalizeManagedComposioBrokerUrl("http://127.0.0.1:8787/")).toBe(
      "http://127.0.0.1:8787",
    );
    expect(normalizeManagedComposioBrokerUrl("http://localhost:8787")).toBe(
      "http://localhost:8787",
    );
    expect(normalizeManagedComposioBrokerUrl("http://[::1]:8787/")).toBe(
      "http://[::1]:8787",
    );
    expect(normalizeManagedComposioBrokerUrl("http://broker.example")).toBe("");
    expect(normalizeManagedComposioBrokerUrl("https://user:secret@broker.example")).toBe("");
    expect(normalizeManagedComposioBrokerUrl("https://broker.example?redirect=evil")).toBe("");

    const fetchImpl = vi.fn();
    const credentials = { composioBrokerToken: TOKEN };
    await ensureManagedComposioCredentials({
      brokerUrl: "http://broker.example",
      credentials,
      fetchImpl,
      saveCredentials: vi.fn(),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(managedComposioAccess("http://broker.example", credentials)).toBeNull();
    expect(
      managedComposioChildEnvironment("http://broker.example", credentials, {
        PATH: "/usr/bin",
        MURAGE_COMPOSIO_BROKER_URL: "http://attacker.example",
        MURAGE_COMPOSIO_BROKER_TOKEN: "attacker-controlled",
      }),
    ).toEqual({ PATH: "/usr/bin" });
    expect(
      managedComposioChildEnvironment("http://[::1]:8787", credentials, { PATH: "/usr/bin" }),
    ).toEqual({
      PATH: "/usr/bin",
      MURAGE_COMPOSIO_BROKER_URL: "http://[::1]:8787",
      MURAGE_COMPOSIO_BROKER_TOKEN: TOKEN,
    });
  });

  it("registers a new installation and persists it", async () => {
    const credentials = {};
    const saveCredentials = vi.fn(async () => {});
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ token: TOKEN, installationId: "installation-test" }),
    }));

    await ensureManagedComposioCredentials({
      brokerUrl: "https://broker.example",
      credentials,
      fetchImpl,
      saveCredentials,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://broker.example/v1/installations",
      expect.objectContaining({ method: "POST", redirect: "error" }),
    );
    expect(credentials).toEqual({
      composioBrokerToken: TOKEN,
      composioInstallationId: "installation-test",
    });
    expect(saveCredentials).toHaveBeenCalledWith(credentials);
  });

  it("settles a stalled optional registration without storing partial credentials", async () => {
    vi.useFakeTimers();
    try {
      const credentials = {};
      const saveCredentials = vi.fn(async () => {});
      const log = vi.fn();
      const fetchImpl = vi.fn(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
          }),
      );
      const operation = ensureManagedComposioCredentials({
        brokerUrl: "https://broker.example",
        credentials,
        fetchImpl,
        saveCredentials,
        log,
        registrationTimeoutMs: 25,
      });

      await vi.advanceTimersByTimeAsync(25);
      await expect(operation).resolves.toBe(credentials);
      expect(credentials).toEqual({});
      expect(saveCredentials).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining("registration failed"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a valid installation identity during a transient broker outage", async () => {
    const credentials = {
      composioBrokerToken: TOKEN,
      composioInstallationId: "installation-test",
    };
    const saveCredentials = vi.fn(async () => {});

    await ensureManagedComposioCredentials({
      brokerUrl: "https://broker.example",
      credentials,
      fetchImpl: vi.fn(async () => {
        throw new Error("offline");
      }),
      saveCredentials,
    });

    expect(credentials).toEqual({
      composioBrokerToken: TOKEN,
      composioInstallationId: "installation-test",
    });
    expect(saveCredentials).not.toHaveBeenCalled();
  });

  it("keeps a definitive 401 invalidation in the derived document when the replacement is aborted", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn((url, init) => {
      if (url.endsWith("/v1/me")) return Promise.resolve({ ok: false, status: 401 });
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
        controller.abort();
      });
    });

    const derived = await deriveManagedComposioCredentials({
      brokerUrl: "https://broker.example",
      fetchImpl,
      timeoutSignal: () => controller.signal,
    })({ other: "kept", composioBrokerToken: TOKEN, composioInstallationId: "installation-revoked" });

    // Abort is not an unchanged signal: the revoked identity is gone.
    expect(derived).toEqual({ other: "kept" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("declares the startup writer optional so an unchanged derivation may skip its native write", () => {
    expect(MANAGED_COMPOSIO_UPDATE_OPTIONS).toEqual({ skipUnchanged: true });
    expect(Object.isFrozen(MANAGED_COMPOSIO_UPDATE_OPTIONS)).toBe(true);
  });
});

// ── the move to FluxRouter ─────────────────────────────────────────────

describe("the desktop's side of moving connected apps to FluxRouter", () => {
  const FLUX = "https://api.fluxrouter.ai/composio";
  const FLUX_TOKEN = "b".repeat(64);

  it("ships 0.1.52 pointed at the FluxRouter broker with the Worker cut-off set (rollout step 7)", () => {
    // A packaged 0.1.52 with no QA override must reach FluxRouter, and the
    // Worker broker must close 60 days after the release.
    expect(FLUX_COMPOSIO_BROKER_URL).toBe(FLUX);
    expect(COMPOSIO_LEGACY_BROKER_UNTIL).toBe("2026-11-10T00:00:00Z");
    expect(fluxComposioBrokerUrl({}, { packaged: true })).toBe(FLUX);
    expect(fluxComposioBrokerUrl({}, { packaged: false })).toBe("");
    expect(composioLegacyBrokerUntil({}, { packaged: true })).toBe("2026-11-10T00:00:00Z");
    expect(composioLegacyBrokerUntil({}, { packaged: false })).toBe("");
    expect(legacyBrokerOpen(COMPOSIO_LEGACY_BROKER_UNTIL, Date.UTC(2026, 8, 12))).toBe(true);
    expect(legacyBrokerOpen(COMPOSIO_LEGACY_BROKER_UNTIL, Date.UTC(2026, 10, 11))).toBe(false);
  });

  it("only honours the release constant in a packaged build", () => {
    // Without this gate, a dev run points at production FluxRouter with the
    // developer's real account and lands dev connections on the production
    // Composio project — the exact opposite of the separate-projects rule.
    const env = {};
    expect(fluxComposioBrokerUrl(env, { packaged: false, releaseUrl: FLUX })).toBe("");
    expect(fluxComposioBrokerUrl(env, { packaged: true, releaseUrl: FLUX })).toBe(FLUX);
    expect(composioLegacyBrokerUntil(env, { packaged: false, releaseUntil: "2026-12-15T00:00:00Z" })).toBe("");
    expect(composioLegacyBrokerUntil(env, { packaged: true, releaseUntil: "2026-12-15T00:00:00Z" })).toBe("2026-12-15T00:00:00Z");

    // A QA override works in every build, so a local Flux stack is reachable.
    const overridden = { MURAGE_FLUX_COMPOSIO_BROKER_URL: "http://127.0.0.1:4000/composio" };
    expect(fluxComposioBrokerUrl(overridden, { packaged: false, releaseUrl: FLUX })).toBe("http://127.0.0.1:4000/composio");
    expect(fluxComposioBrokerUrl({ MURAGE_FLUX_COMPOSIO_BROKER_URL: "http://broker.example" }, { packaged: true })).toBe("");
  });

  it("stops registering anonymously once FluxRouter holds connected apps", async () => {
    // A new install must get its apps from a FluxRouter account. Minting
    // another anonymous Worker identity would create connections nobody can
    // reach from FluxRouter, and the Worker is closing.
    const fetchImpl = vi.fn();
    const credentials = {};
    await ensureManagedComposioCredentials({
      brokerUrl: "https://broker.example",
      credentials,
      fetchImpl,
      saveCredentials: vi.fn(),
      registrationAllowed: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(credentials).toEqual({});
  });

  it("never probes or discards an existing Worker token while a claim is possible", async () => {
    // That token IS the user's Gmail grant until the claim moves it. The old
    // path deleted it on a 401; here it is not even asked about.
    const fetchImpl = vi.fn();
    const credentials = { composioBrokerToken: TOKEN, composioInstallationId: "installation-test" };
    await ensureManagedComposioCredentials({
      brokerUrl: "https://broker.example",
      credentials,
      fetchImpl,
      saveCredentials: vi.fn(),
      registrationAllowed: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(credentials).toEqual({ composioBrokerToken: TOKEN, composioInstallationId: "installation-test" });
  });

  it("withdraws the Worker broker at the cut-off, and fails closed on a bad one", () => {
    const credentials = { composioBrokerToken: TOKEN };
    const until = "2026-12-15T00:00:00Z";
    const before = Date.UTC(2026, 11, 14);
    const after = Date.UTC(2026, 11, 16);

    expect(legacyBrokerOpen("", before)).toBe(true);
    expect(legacyBrokerOpen(until, before)).toBe(true);
    expect(legacyBrokerOpen(until, after)).toBe(false);
    const log = vi.fn();
    expect(legacyBrokerOpen("whenever", before, log)).toBe(false);
    expect(log).toHaveBeenCalled();

    expect(managedComposioAccess("https://broker.example", credentials, { legacyUntil: until, now: before })).toEqual({
      url: "https://broker.example",
      token: TOKEN,
    });
    expect(managedComposioAccess("https://broker.example", credentials, { legacyUntil: until, now: after })).toBeNull();
  });

  it("publishes the FluxRouter broker to the child, and strips both tokens first", () => {
    const credentials = {
      composioBrokerToken: TOKEN,
      composioInstallationId: "installation-test",
      fluxComposioBrokerToken: FLUX_TOKEN,
      fluxComposioAccountKind: "shared",
      composioLegacyClaim: JSON.stringify({ state: "offered", installationId: "installation-test", at: "2026-09-11T00:00:00Z" }),
    };
    const child = managedComposioChildEnvironment("https://broker.example", credentials, {
      PATH: "/usr/bin",
      // Whatever the launching shell claimed is overwritten, never merged.
      MURAGE_FLUX_COMPOSIO_BROKER_TOKEN: "attacker-controlled",
      MURAGE_COMPOSIO_LEGACY_CLAIM: '{"state":"claimed"}',
    }, { fluxBrokerUrl: FLUX, legacyUntil: "2026-12-15T00:00:00Z", now: Date.UTC(2026, 8, 11) });

    expect(child.MURAGE_COMPOSIO_BROKER_TOKEN).toBe(TOKEN);
    expect(child.MURAGE_FLUX_COMPOSIO_BROKER_URL).toBe(FLUX);
    expect(child.MURAGE_FLUX_COMPOSIO_BROKER_TOKEN).toBe(FLUX_TOKEN);
    expect(child.MURAGE_FLUX_COMPOSIO_ACCOUNT_KIND).toBe("shared");
    expect(child.MURAGE_COMPOSIO_LEGACY_BROKER_UNTIL).toBe("2026-12-15T00:00:00Z");
    expect(JSON.parse(child.MURAGE_COMPOSIO_LEGACY_CLAIM)).toEqual({
      state: "offered",
      installationId: "installation-test",
      at: "2026-09-11T00:00:00Z",
    });

    // No FluxRouter broker in this build: no URL, and no token either.
    const off = managedComposioChildEnvironment("https://broker.example", credentials, { PATH: "/usr/bin" });
    expect(off.MURAGE_FLUX_COMPOSIO_BROKER_URL).toBeUndefined();
    expect(off.MURAGE_FLUX_COMPOSIO_BROKER_TOKEN).toBeUndefined();
  });

  it("keeps the claim state well-formed however credentials.bin comes back", () => {
    expect(readComposioLegacyClaim({})).toEqual({ state: "none" });
    expect(readComposioLegacyClaim({ composioLegacyClaim: "not json" })).toEqual({ state: "none" });
    expect(readComposioLegacyClaim({ composioLegacyClaim: JSON.stringify({ state: "elsewhere" }) })).toEqual({ state: "none" });
    expect(readComposioLegacyClaim({
      composioLegacyClaim: JSON.stringify({ state: "conflict", code: "NOT A CODE", jti: "j", confirmPending: "yes" }),
    })).toEqual({ state: "conflict", jti: "j" });

    const written = writeComposioLegacyClaim({ other: "kept" }, { state: "pending", jti: "j" });
    expect(JSON.parse(written.composioLegacyClaim)).toEqual({ state: "pending", jti: "j" });
    expect(writeComposioLegacyClaim(written, { state: "none" }).composioLegacyClaim).toBeUndefined();
  });

  it("never puts a secret in the claim state the renderer sees", () => {
    const view = publicComposioLegacyClaim({
      composioLegacyClaim: JSON.stringify({ state: "claimed", jti: "secret-jti", installationId: "installation-test", at: "2026-09-11T00:00:00Z", confirmPending: true }),
    });
    // `jti` identifies one signed assertion; the panel has no use for it.
    expect(view).toEqual({ state: "claimed", installationId: "installation-test", at: "2026-09-11T00:00:00Z", confirmPending: true });
  });

  it("discards a lifecycle result derived from credentials that have since changed", () => {
    // The network ran outside the credential lock. If a Flux key was saved or
    // a token rotated meanwhile, this answer is about a document that no
    // longer exists and applying it would undo the newer write.
    const snapshot = { fluxApiKey: "sk-old", composioBrokerToken: TOKEN };
    const result = { ...snapshot, fluxComposioBrokerToken: FLUX_TOKEN };

    const stale = applyComposioCredentialResult({ fluxApiKey: "sk-new", composioBrokerToken: TOKEN }, snapshot, result);
    expect(stale.applied).toBe(false);
    expect(stale.credentials.fluxComposioBrokerToken).toBeUndefined();

    const fresh = applyComposioCredentialResult({ ...snapshot, unrelated: "kept" }, snapshot, result);
    expect(fresh.applied).toBe(true);
    expect(fresh.credentials).toEqual({ ...snapshot, unrelated: "kept", fluxComposioBrokerToken: FLUX_TOKEN });

    // A field the result dropped (an abandoned install) is dropped here too.
    const abandoned = applyComposioCredentialResult({ ...snapshot }, snapshot, { fluxApiKey: "sk-old" });
    expect(abandoned.credentials.composioBrokerToken).toBeUndefined();
  });
});
