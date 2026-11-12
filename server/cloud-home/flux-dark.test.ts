// SPDX-License-Identifier: AGPL-3.0-or-later
// Dark guarantee: with no home Flux key delivered, a Cloud home behaves exactly as it did before the delivery existed.
import { mkdtempSync, mkdirSync, chmodSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertFluxNotPaused, createFluxHomeGate, fluxHomePause, startFluxHomeGate, stopFluxHomeGate } from "./flux-home-gate.ts";
import { peekFluxSubkey } from "./flux-subkey-delivery.ts";
import { assertFinalEngineEnv, assertNoFluxForSignInEngine, scrubFluxFromSignInEnv } from "./engine-flux-guard.ts";
import { isGenericCredentialPatch, serverCredentialProjection } from "./credential-projection.ts";
import { classifyFluxRefusal } from "./flux-credit-refusal.ts";
import { acpRpcErrorMessage } from "../drivers/acp/core.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

afterEach(() => { stopFluxHomeGate(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("no key delivered: the home behaves as before", () => {
  it("the gate asks nothing, pauses nothing and never touches the network", async () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    const fetch = vi.fn(async () => { throw new Error("no request may be made"); });
    const gate = createFluxHomeGate({ key: () => null, fetch: fetch as never, now: () => 1 });
    expect(await gate.refresh()).toMatchObject({ paused: false, state: "no-key", message: null });
    gate.noteRefusal(402);
    await gate.refresh();
    expect(fetch).not.toHaveBeenCalled();
    startFluxHomeGate({ key: () => null, fetch: fetch as never });
    await vi.waitFor(() => expect(fluxHomePause().state).toBe("no-key"));
    expect(() => assertFluxNotPaused()).not.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a desktop is never gated, key or no key", () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "");
    expect(() => assertFluxNotPaused()).not.toThrow();
    expect(() => assertNoFluxForSignInEngine("codex")).not.toThrow();
    const env: NodeJS.ProcessEnv = { FLUX_API_KEY: "sk-flux-owner-key-on-a-desktop-0000000000" }; // secret-scan: fixture
    expect(scrubFluxFromSignInEnv("codex", env)).toEqual([]);
    expect(env.FLUX_API_KEY).toBeDefined();
    expect(() => assertFinalEngineEnv("claudeAgent", env, ["--x", "sk-flux-anything"])).not.toThrow();
  });

  it("no hand-off directory or an empty one means no key waits", () => {
    const dir = mkdtempSync(join(tmpdir(), "flux-dark-"));
    try {
      expect(peekFluxSubkey(join(dir, "missing"))).toBeNull();
      const empty = join(dir, "flux-subkey"); mkdirSync(empty); chmodSync(empty, 0o700);
      expect(peekFluxSubkey(empty)).toBeNull();
      expect(readdirSync(empty)).toEqual([]);
    } finally { removeTempDirSync(dir); }
  });

  it("an empty Flux slot and ordinary credentials are accepted exactly as before", () => {
    expect(isGenericCredentialPatch({ fluxApiKey: "" })).toBe(true);
    expect(isGenericCredentialPatch({ anthropicApiKey: "sk-ant-fixture" })).toBe(true);
    expect(serverCredentialProjection({ anthropicApiKey: "sk-ant-fixture", fluxApiKey: "" })).toEqual({ anthropicApiKey: "sk-ant-fixture", fluxApiKey: "" });
  });

  it("answers that are not the router's credit answers keep their old wording, on a home and off it", () => {
    for (const role of ["home", ""]) {
      vi.stubEnv("MURAGE_CLOUD_ROLE", role);
      expect(classifyFluxRefusal({ status: 402, body: { error: "something else" } })).toBeNull();
      expect(classifyFluxRefusal({ status: 500, body: {} })).toBeNull();
      expect(acpRpcErrorMessage({ message: "Request failed.", data: { http_status: 500, message: "boom" } })).toBe("Request failed.");
    }
    // Off a home the reviewed provider copy is unchanged even for the router's own shapes.
    vi.stubEnv("MURAGE_CLOUD_ROLE", "");
    expect(acpRpcErrorMessage({ message: "x", data: { http_status: 402, message: "Your credit balance is exhausted. https://fluxrouter.ai/home/billing" } })).toContain("Flux Router is out of credits");
  });
});
