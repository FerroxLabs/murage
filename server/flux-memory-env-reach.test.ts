// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// U05 (1.0.4): a turn whose launch env sends the engine to Flux reaches Flux
// whatever its pick is called. On every ACP engine a non-owner or background
// turn then carries capture off + inject off, or is refused where the engine
// cannot carry them. The owner's own turn keeps today's headers.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { FLUX_ENGINE_HEADERS, FLUX_HEADER_REFUSAL, envReachesFlux, fluxHeaderRefusal, fluxMemoryDecision } from "./flux-memory-headers.ts";

describe("U05 launch env that reaches Flux", () => {
  it("spots a model host or base URL set to Flux Router", () => {
    expect(envReachesFlux({ KIMI_MODEL_BASE_URL: "https://api.fluxrouter.ai/v1" })).toBe(true);
    expect(envReachesFlux({ OPENAI_BASE_URL: " https://api.fluxrouter.ai/v1 " })).toBe(true);
    expect(envReachesFlux({ GROK_XAI_API_BASE_URL: "https://eu.fluxrouter.ai" })).toBe(true);
    expect(envReachesFlux({ OPENAI_API_BASE: "https://api.fluxrouter.ai/v1" })).toBe(true);
  });
  it("leaves other hosts and non-host values alone", () => {
    expect(envReachesFlux({ KIMI_MODEL_BASE_URL: "http://127.0.0.1:8080/v1" })).toBe(false);
    expect(envReachesFlux({ OPENAI_BASE_URL: "https://fluxrouter.ai.example.com/v1" })).toBe(false);
    expect(envReachesFlux({ NOTES: "https://api.fluxrouter.ai/v1" })).toBe(false);
    expect(envReachesFlux({})).toBe(false);
  });
  it("every Flux turn, the owner's included, is refused on an engine that cannot carry the headers", () => {
    const nonOwner = fluxMemoryDecision({ audience: "non-owner" });
    expect(nonOwner.capture).toBe("off");
    expect(nonOwner.inject).toBe("off");
    const owner = fluxMemoryDecision({ audience: "owner" });
    expect(owner.headers["x-flux-memory-capture"]).toBe("off");
    for (const engine of ["kimiAgent", "droidAgent", "cursorAgent", "clineAgent", "geminiAgent", "customAcp", "openclawAgent"]) {
      expect(FLUX_ENGINE_HEADERS[engine]).toBeUndefined();
      expect(fluxHeaderRefusal(engine as never, nonOwner)).toBe(FLUX_HEADER_REFUSAL);
      expect(fluxHeaderRefusal(engine as never, owner)).toBe(FLUX_HEADER_REFUSAL);
    }
  });
  it("the ACP core decides from the engine's real host outside the flux-* pick path (flux-engine-reach.test.ts)", () => {
    const source = readFileSync(new URL("./drivers/acp/core.ts", import.meta.url), "utf8");
    const at = source.indexOf("else if (!support.effectiveDestination && !turn.providerRoute) {");
    expect(at).toBeGreaterThan(0);
    const block = source.slice(at, at + 1600);
    expect(block).toContain("acpFluxReach(support, env, config)");
    expect(block).toContain("!support.applyFluxMemory ? FLUX_HEADER_REFUSAL : null");
    expect(block).toContain("support.applyFluxMemory?.(env, { decision: fluxMemory");
  });
});
