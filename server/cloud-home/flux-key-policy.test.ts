// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { fluxKeyPolicyError, fluxTarget, fluxSectionViolation } from "./flux-key-policy.ts";
import { isGenericCredentialPatch } from "./credential-projection.ts";
import { fluxCredentialViolation, withCloudCredentials } from "./credentials.ts";
import { mkdtempSync, openSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = `sk-flux-home-${"h".repeat(30)}`;
const PRIMARY = `sk-flux-${"p".repeat(30)}`;

describe("Flux target classification", () => {
  it.each([
    ["https://api.fluxrouter.ai/v1", "flux"], ["https://fluxrouter.ai", "flux"], ["https://x.y.fluxrouter.ai/v1", "flux"],
    ["HTTPS://API.FLUXROUTER.AI./v1", "flux"], ["https://api.fluxrouter.ai:443/v1", "flux"],
    ["https://u" + "@" + "api.fluxrouter.ai/v1", "suspicious"], ["https://api.fluxrouter.ai:8443/v1", "suspicious"], ["http://api.fluxrouter.ai", "suspicious"],
    ["https://fluxrouter.ai.evil.test", "suspicious"], ["https://api.fluxrouter.ai@evil.test/v1", "suspicious"], ["fluxrouter.ai/v1", "suspicious"],
    ["https://openrouter.ai/api/v1", "other"], ["https://evil.test/fluxrouter.ai", "other"], ["", "other"], [undefined, "other"],
  ])("%s -> %s", (url, kind) => { expect(fluxTarget(url)).toBe(kind); });
});

describe("home-key-only policy", () => {
  it("accepts the home key on Flux, refuses a primary key on Flux and the home key elsewhere", () => {
    expect(fluxKeyPolicyError(HOME, "https://api.fluxrouter.ai/v1")).toBeNull();
    expect(fluxKeyPolicyError(PRIMARY, "https://api.fluxrouter.ai/v1")).toMatch(/credits connection/);
    expect(fluxKeyPolicyError(HOME, "https://openrouter.ai/api/v1")).toMatch(/only works with its own service/);
    expect(fluxKeyPolicyError(PRIMARY, "https://eu.FLUXROUTER.ai./v1")).toMatch(/credits connection/);
    expect(fluxKeyPolicyError(HOME, "https://u:p" + "@" + "api.fluxrouter.ai/v1")).toMatch(/credits connection/);
    expect(fluxKeyPolicyError("opaque-key", "https://openrouter.ai/api/v1")).toBeNull();
    expect(fluxKeyPolicyError("", "https://api.fluxrouter.ai")).toBeNull();
  });
  it("refuses a primary Flux key in any credential-patch slot, not just fluxApiKey", () => {
    expect(isGenericCredentialPatch({ openaiCompatKey: PRIMARY })).toBe(false);
    expect(isGenericCredentialPatch({ xaiApiKey: ` ${PRIMARY}` })).toBe(false);
    expect(isGenericCredentialPatch({ fluxApiKey: PRIMARY })).toBe(false);
    expect(isGenericCredentialPatch({ fluxApiKey: HOME, openaiCompatKey: HOME })).toBe(true);
    expect(isGenericCredentialPatch({ openaiCompatKey: "opaque-key" })).toBe(true);
  });
  it("checks a config's key against the URL beside it", () => {
    expect(fluxSectionViolation({ url: "https://api.fluxrouter.ai/v1", key: PRIMARY }, "key")).toMatch(/credits connection/);
    expect(fluxSectionViolation({ url: "https://api.fluxrouter.ai/v1", key: HOME }, "key")).toBeNull();
    expect(fluxCredentialViolation({ openaiCompat: { url: "https://api.fluxrouter.ai/v1", key: PRIMARY } })).toMatch(/credits connection/);
    expect(fluxCredentialViolation({ flux: { apiKey: PRIMARY } })).toMatch(/credits connection/);
    expect(fluxCredentialViolation({ openaiCompat: { url: "https://openrouter.ai/api/v1", key: "k" }, flux: { apiKey: HOME } })).toBeNull();
  });
  it("drops a restored key that breaks the rule", () => {
    process.env.MURAGE_CLOUD_ROLE = "home";
    try {
      const dir = mkdtempSync(join(tmpdir(), "flux-restore-"));
      const file = join(dir, "s");
      writeFileSync(file, JSON.stringify({ version: 1, bootstrapSecret: "b".repeat(40), credentials: { openaiCompatKey: PRIMARY, fluxApiKey: PRIMARY, xaiApiKey: "opaque" } }), { mode: 0o600 });
      process.env.MURAGE_CLOUD_SECRETS_FD = String(openSync(file, "r"));
      const restored = withCloudCredentials({ openaiCompat: { url: "https://api.fluxrouter.ai/v1" }, flux: {}, xai: {} }) as Record<string, Record<string, string>>;
      expect(restored.openaiCompat.key).toBe("");
      expect(restored.flux.apiKey).toBe("");
      expect(restored.xai.key).toBe("opaque");
    } finally { delete process.env.MURAGE_CLOUD_ROLE; }
  });
});
