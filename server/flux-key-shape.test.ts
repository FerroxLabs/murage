// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Only a Flux Router key ever goes to api.fluxrouter.ai.
//
// 2026-10-01, Flux ingress: three Windows installs of Murage 0.1.61 polled
// GET /v1/models with a bearer that was (a) the base URL `https://…/v1`,
// (b) a short value with no `sk-` prefix, (c) empty, and a fourth sent an
// `sk-` key Flux never issued. Every customer key Flux mints is
// `sk-flux-…` (flux-router-app key-issuance.service.ts), so the shape alone
// tells all four apart from a real key without a network call. Fixture
// values below are shapes only, never live credentials.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertProviderKey, isFluxKeyShape } from "../electron/provider-connections.mjs";
import { fluxCredentialRevision, fluxCredentialStatus, planFluxCredentialChange } from "../electron/flux-credential-policy.mjs";
import { fluxConfigured, fluxKey, fluxKeyState } from "./flux-config.ts";
import { extractKeys } from "../shared/key-extract.ts";
import { fluxKeyLooksValid } from "../shared/setup.ts";

const REAL = "sk-flux-Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OBSERVED = {
  baseUrl: "https://api.fluxrouter.ai/v1",
  shortJunk: "abc12345xyz",
  foreignSk: "sk-0123456789abcdef0123456789abcdef",
};

beforeEach(() => { delete process.env.FLUX_API_KEY; });
afterEach(() => { delete process.env.FLUX_API_KEY; });

describe("the Flux key shape", () => {
  it("accepts only sk-flux- keys", () => {
    expect(isFluxKeyShape(REAL)).toBe(true);
    expect(isFluxKeyShape(` ${REAL} `)).toBe(true);
    for (const bad of [...Object.values(OBSERVED), "", "sk-flux-", "sk-flux-has space", "sk-ant-api03-xxxxxxxxxxxxxxxx"]) {
      expect(isFluxKeyShape(bad), bad).toBe(false);
    }
  });
});

describe("fluxKey() never hands out a value that is not a Flux key", () => {
  for (const [name, value] of Object.entries(OBSERVED)) {
    it(`refuses the observed ${name} variant`, () => {
      process.env.FLUX_API_KEY = value;
      expect(fluxKey()).toBeNull();
      expect(fluxConfigured()).toBe(false);
      // Saved but unusable is not the same as missing: the owner is told.
      expect(fluxKeyState()).toBe("not-flux");
    });
  }

  it("returns a real key and reports it as ok", () => {
    process.env.FLUX_API_KEY = REAL;
    expect(fluxKey()).toBe(REAL);
    expect(fluxKeyState()).toBe("ok");
  });

  it("reports an empty slot as missing", () => {
    process.env.FLUX_API_KEY = "   ";
    expect(fluxKey()).toBeNull();
    expect(fluxKeyState()).toBe("missing");
  });
});

describe("every door that saves a Flux key checks the shape", () => {
  it("the Flux connection card refuses a base URL or another provider's key", () => {
    for (const value of Object.values(OBSERVED)) {
      expect(() => assertProviderKey("flux", value), value).toThrow(/Flux Router key/);
    }
    expect(() => assertProviderKey("flux", REAL)).not.toThrow();
  });

  it("connect and replace refuse it too", () => {
    const empty = { bank: "[]", workspaceKey: "", aliases: [] };
    const revision = fluxCredentialRevision(empty);
    expect(() => planFluxCredentialChange(empty, { action: "connect", revision, key: OBSERVED.baseUrl })).toThrow(/Flux Router key/);
    expect(planFluxCredentialChange(empty, { action: "connect", revision, key: REAL }).workspaceKey).toBe(REAL);
  });

  it("pasting a bare sk- key never offers Flux as its home", () => {
    const [candidate] = extractKeys(OBSERVED.foreignSk);
    expect(candidate?.providers).not.toContain("flux");
  });

  it("the setup check calls a base URL not a key", () => {
    expect(fluxKeyLooksValid(OBSERVED.baseUrl)).toBe(false);
    expect(fluxKeyLooksValid(OBSERVED.shortJunk)).toBe(false);
    expect(fluxKeyLooksValid(REAL)).toBe(true);
  });
});

describe("the catalog backoff", () => {
  it("doubles the wait after each failure, up to a ceiling, and never stops for good", async () => {
    const { CATALOG_BACKOFF_BASE_MS: base, CATALOG_BACKOFF_MAX_MS: max, catalogFetchAllowed, noteCatalogResult, resetFluxKeyHealthForTests } = await import("./flux-key-health.ts");
    resetFluxKeyHealthForTests();
    let now = 0;
    for (let failure = 1; failure <= 12; failure++) {
      expect(catalogFetchAllowed(REAL, now), `before failure ${failure}`).toBe(true);
      noteCatalogResult(REAL, "failed", now);
      const wait = Math.min(base * 2 ** (failure - 1), max);
      expect(catalogFetchAllowed(REAL, now + wait - 1)).toBe(false);
      now += wait;
    }
    expect(max).toBeLessThanOrEqual(6 * 3_600_000);
    // A different key starts clean.
    expect(catalogFetchAllowed("sk-flux-Bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", now)).toBe(true);
    resetFluxKeyHealthForTests();
  });

  it("lets a person-initiated refresh skip the wait, but not a refusal", async () => {
    const { catalogFetchAllowed, noteCatalogResult, noteFluxKeyRefused, resetFluxKeyHealthForTests } = await import("./flux-key-health.ts");
    resetFluxKeyHealthForTests();
    for (let i = 0; i < 8; i++) noteCatalogResult(REAL, "failed", 0);
    expect(catalogFetchAllowed(REAL, 1)).toBe(false);
    expect(catalogFetchAllowed(REAL, 1, { manual: true })).toBe(true);
    noteFluxKeyRefused(REAL);
    expect(catalogFetchAllowed(REAL, 1, { manual: true })).toBe(false);
    resetFluxKeyHealthForTests();
  });

  it("stops at once for a refused key; only Flux accepting the key clears it", async () => {
    const { catalogFetchAllowed, noteCatalogResult, noteFluxKeyAccepted, noteFluxKeyRefused, resetFluxKeyHealthForTests } = await import("./flux-key-health.ts");
    resetFluxKeyHealthForTests();
    noteFluxKeyRefused(REAL);
    expect(catalogFetchAllowed(REAL, 10 * 365 * 86_400_000)).toBe(false);
    process.env.FLUX_API_KEY = REAL;
    expect(fluxKeyState()).toBe("refused");
    // Fuigo falls back to bundled models and exits 0 on a 401, so its "ok"
    // says nothing about the key.
    noteCatalogResult(REAL, "ok", 1);
    expect(fluxKeyState()).toBe("refused");
    noteFluxKeyAccepted(REAL);
    expect(fluxKeyState()).toBe("ok");
    resetFluxKeyHealthForTests();
  });
});

describe("a bad value saved in config.json does not trap the owner", () => {
  const bank = "[]";
  const state = (over: Record<string, unknown>) => ({ bank, workspaceKey: "", aliases: [], fileWorkspaceKey: "", ambientWorkspaceKey: "", ...over });

  it("is not a choice and does not count as configured", () => {
    for (const bad of Object.values(OBSERVED)) {
      const status = fluxCredentialStatus(state({ fileWorkspaceKey: bad, ambientWorkspaceKey: bad }));
      expect(status.configured, bad).toBe(false);
      expect(status.choices, bad).toEqual([]);
      expect(status.conflict, bad).toBe(false);
    }
  });

  it("connect works instead of returning 409", () => {
    for (const bad of Object.values(OBSERVED)) {
      const saved = state({ fileWorkspaceKey: bad });
      const revision = fluxCredentialStatus(saved).revision;
      expect(planFluxCredentialChange(saved, { action: "connect", revision, key: REAL }).workspaceKey, bad).toBe(REAL);
    }
  });

  it("select and consolidate refuse a value that is not a Flux key", () => {
    for (const bad of Object.values(OBSERVED)) {
      const saved = state({ fileWorkspaceKey: bad });
      const revision = fluxCredentialStatus(saved).revision;
      expect(() => planFluxCredentialChange(saved, { action: "select", revision, connectionId: "legacy-flux-file" }), bad).toThrow(/Flux Router key|Choose an existing/);
      const row = JSON.stringify([{ id: "rec-1", preset: "flux", label: "Old", key: bad, enabled: true, revision: "rev-1" }]);
      const withRow = state({ bank: row });
      const rowRevision = fluxCredentialStatus(withRow).revision;
      expect(() => planFluxCredentialChange(withRow, { action: "select", revision: rowRevision, connectionId: "rec-1" }), bad).toThrow(/Flux Router key|Choose an existing/);
      expect(() => planFluxCredentialChange(withRow, { action: "consolidate", revision: rowRevision }), bad).toThrow(/Flux Router key|Select a saved/);
    }
  });

  it("a real saved key still shows as a choice and still blocks connect", () => {
    const saved = state({ fileWorkspaceKey: REAL });
    const status = fluxCredentialStatus(saved);
    expect(status.choices.map(c => c.id)).toContain("legacy-flux-file");
    expect(() => planFluxCredentialChange(saved, { action: "connect", revision: status.revision, key: REAL })).toThrow(/already saved/);
  });
});
