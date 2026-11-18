// SPDX-License-Identifier: AGPL-3.0-or-later
// B4 hole 7: a primary Flux key hidden inside a serialized credential (the provider bank is a JSON string).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloudHomeCopy } from "./copy.ts";
import { fluxCredentialViolation } from "./credentials.ts";
import { isGenericCredentialPatch, serverCredentialProjection } from "./credential-projection.ts";
import { fluxKeyPolicyError } from "./flux-key-policy.ts";
import { workspaceCredentialEnv } from "../../electron/workspace-credentials.mjs";
import { ProviderConnectionsService } from "../provider-connections.ts";
import { applyProviderRoute } from "../provider-routing.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const PRIMARY = `sk-flux-${"p".repeat(30)}`;
const HOME = `sk-flux-home-${"h".repeat(30)}`;
const row = (preset: string, key: string, id = "c1") => ({ id, preset, label: "Row", enabled: true, key, revision: "r1" });
const bank = (...rows: object[]) => JSON.stringify(rows);
beforeEach(() => { vi.stubEnv("MURAGE_CLOUD_ROLE", "home"); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("hole 7: the serialized provider bank cannot carry a primary Flux key", () => {
  it("hole 7: the generic patch refuses a serialized bank holding a primary key (flux row, other row, nested JSON, escaped)", () => {
    expect(isGenericCredentialPatch({ modelProviderConnections: bank(row("flux", PRIMARY)) })).toBe(false);
    expect(isGenericCredentialPatch({ modelProviderConnections: bank(row("openai", PRIMARY)) })).toBe(false);
    expect(isGenericCredentialPatch({ modelProviderConnections: JSON.stringify([{ ...row("flux", "x".repeat(10)), key: JSON.stringify({ k: PRIMARY }) }]) })).toBe(false);
    expect(isGenericCredentialPatch({ modelProviderConnections: '[{"id":"c1","preset":"flux","label":"R","enabled":true,"key":"\\u0073k-flux-' + "q".repeat(20) + '","revision":"r1"}]' })).toBe(false);
    expect(isGenericCredentialPatch({ telegramBotToken: encodeURIComponent(PRIMARY) })).toBe(false);
    expect(isGenericCredentialPatch({ modelProviderConnections: bank(row("flux", HOME)) })).toBe(true);
    expect(isGenericCredentialPatch({ modelProviderConnections: bank(row("openai", "sk-proj-fixture-key-private")) })).toBe(true);
  });
  it("hole 7: a home key in a non-Flux bank row is refused (it must not leave for another provider)", () => {
    expect(isGenericCredentialPatch({ modelProviderConnections: bank(row("openai", HOME)) })).toBe(false);
  });
  it("hole 7: section validation reports a violation for the serialized bank", () => {
    expect(fluxCredentialViolation({ modelProviders: { bank: bank(row("flux", PRIMARY)) } })).toBe(cloudHomeCopy.fluxKeyMustBeHomeKey);
    expect(fluxCredentialViolation({ modelProviders: { bank: bank(row("openai", HOME)) } })).toBe(cloudHomeCopy.fluxHomeKeyOnlyForFlux);
    expect(fluxCredentialViolation({ modelProviders: { bank: bank(row("flux", HOME)) } })).toBeNull();
  });
  it("hole 7: restore projection drops a stored bank holding a primary key", () => {
    const stored = { modelProviderConnections: bank(row("flux", PRIMARY)), telegramBotToken: "t-ok-123456", fluxApiKey: PRIMARY };
    expect(serverCredentialProjection(stored)).toEqual({ telegramBotToken: "t-ok-123456" });
  });
  it("hole 7: the desktop-shell env projection restores no bank with a primary key on a home", () => {
    const env = workspaceCredentialEnv({ modelProviderConnections: bank(row("flux", PRIMARY)), telegramBotToken: "t-ok-123456" });
    expect(env).toEqual({ MURAGE_TELEGRAM_BOT_TOKEN: "t-ok-123456" });
    vi.stubEnv("MURAGE_CLOUD_ROLE", "");
    expect(workspaceCredentialEnv({ modelProviderConnections: bank(row("flux", PRIMARY)) }).MURAGE_MODEL_PROVIDER_CONNECTIONS).toContain(PRIMARY); // the desktop owner keeps their own key
  });
  it("hole 7: final route resolution never enables a row holding a primary key", () => {
    const dir = mkdtempSync(join(tmpdir(), "bank-flux-"));
    try {
      const service = new ProviderConnectionsService({ readBank: () => bank(row("flux", PRIMARY, "a"), row("openai", HOME, "b"), row("flux", HOME, "c")), cacheDir: dir });
      expect(service.resolve("a")).toMatchObject({ enabled: false, key: "" });
      expect(service.resolve("b")).toMatchObject({ enabled: false });
      expect(service.resolve("c")).toMatchObject({ enabled: true, key: HOME });
    } finally { removeTempDirSync(dir); }
  });
  it.each(["fuigoAgent", "hermesAgent", "opencodeGo"])("hole 7: a %s provider route with a primary key is refused to any address", driver => {
    for (const baseUrl of ["https://api.fluxrouter.ai/v1", "https://api.example.com/v1"]) {
      const route = { connectionId: "c", preset: "openai", protocol: "openai", baseUrl, apiKey: PRIMARY, model: "m", revision: "r" } as never;
      expect(() => applyProviderRoute(driver, {}, route)).toThrow(cloudHomeCopy.fluxKeyMustBeHomeKey);
    }
  });
  it("hole 7: the compatible-endpoint policy refuses a primary key for a non-Flux address too", () => {
    expect(fluxKeyPolicyError(PRIMARY, "https://api.example.com/v1")).toBe(cloudHomeCopy.fluxKeyMustBeHomeKey);
    expect(fluxKeyPolicyError(HOME, "https://api.fluxrouter.ai/v1")).toBeNull();
  });
});
