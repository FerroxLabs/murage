// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloudHomeCopy } from "./copy.ts";
import { assertFinalEngineEnv, assertFinalLaunchFluxFree, assertNoFluxInSignInArgs, decodeTomlEscapes, scrubFluxFromSignInEnv } from "./engine-flux-guard.ts";
import { cloudTurnEnvironment, cloudTurnLaunch, cloudTurnRender } from "./turn-process.ts";
import { isGenericCredentialPatch, serverCredentialProjection } from "./credential-projection.ts";
import { applyFluxSurface } from "../flux-routing.ts";
import { applyProviderRoute } from "../provider-routing.ts";
import { claudeEnvironment } from "../drivers/claude.ts";

const HOME = `sk-flux-home-${"h".repeat(30)}`;
beforeEach(() => { vi.stubEnv("MURAGE_CLOUD_ROLE", "home"); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("Claude Code and Codex never get Flux on a Cloud home", () => {
  it.each(["claudeAgent", "codex"])("%s: strips a Flux key and a Flux URL under any variable name", engine => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: HOME, OPENAI_API_KEY: HOME, ANTHROPIC_BASE_URL: "https://api.fluxrouter.ai/anthropic",
      OPENAI_BASE_URL: "https://API.FluxRouter.AI./v1", MY_ENDPOINT: "https://eu.fluxrouter.ai/x", ODD_TOKEN: HOME, FLUX_API_KEY: "x", KEEP: "ok" };
    const removed = scrubFluxFromSignInEnv(engine, env);
    expect(removed.sort()).toEqual(["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "FLUX_API_KEY", "MY_ENDPOINT", "ODD_TOKEN", "OPENAI_API_KEY", "OPENAI_BASE_URL"]);
    expect(env).toEqual({ KEEP: "ok" });
  });
  it("leaves other engines and non-home processes alone", () => {
    const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: HOME };
    expect(scrubFluxFromSignInEnv("fuigoAgent", env)).toEqual([]);
    vi.stubEnv("MURAGE_CLOUD_ROLE", "");
    expect(scrubFluxFromSignInEnv("codex", env)).toEqual([]);
    expect(env.OPENAI_API_KEY).toBe(HOME);
  });
  it.each(["claudeAgent", "codex"])("%s: the Flux applier refuses in plain words", engine => {
    const env: NodeJS.ProcessEnv = {};
    expect(() => applyFluxSurface(engine as never, env, "flux-auto", HOME)).toThrow(cloudHomeCopy.signInEnginesNoFlux);
    expect(env).toEqual({});
  });
  it("Claude's real launch env carries no Flux key or address", () => {
    const env = claudeEnvironment("claude-sonnet-5", { ANTHROPIC_API_KEY: HOME, ANTHROPIC_AUTH_TOKEN: HOME, ANTHROPIC_BASE_URL: "https://api.fluxrouter.ai/anthropic", WEIRD_URL: "https://api.fluxrouter.ai/v1" });
    expect(Object.values(env).some(value => /sk-flux-|fluxrouter/i.test(value ?? ""))).toBe(false);
  });
  it("Codex config arguments naming Flux are refused", () => {
    expect(() => assertNoFluxInSignInArgs("codex", ["app-server", "-c", 'model_providers.flux.base_url="https://api.fluxrouter.ai/v1"'])).toThrow(cloudHomeCopy.signInEnginesNoFlux);
    expect(() => assertNoFluxInSignInArgs("codex", ["app-server", "-c", "model=gpt-5"])).not.toThrow();
  });
  it("a Flux provider route for Codex or Claude is refused on a home", () => {
    const route = { connectionId: "c", preset: "flux", protocol: "openai", baseUrl: "https://api.fluxrouter.ai/v1", apiKey: HOME, model: "m", revision: "r" } as never;
    expect(() => applyProviderRoute("codex", {}, route)).toThrow(cloudHomeCopy.signInEnginesNoFlux);
    expect(() => applyProviderRoute("claudeAgent", {}, route)).toThrow();
  });
  it("the credential projection refuses and hides a Flux key under a sign-in engine name", () => {
    expect(isGenericCredentialPatch({ anthropicApiKey: HOME })).toBe(false);
    expect(isGenericCredentialPatch({ openaiApiKey: HOME })).toBe(false);
    expect(isGenericCredentialPatch({ codexApiKey: "https://api.fluxrouter.ai/v1" })).toBe(false);
    expect(serverCredentialProjection({ anthropicApiKey: HOME, fluxApiKey: HOME, other: "x" })).toEqual({ fluxApiKey: HOME, other: "x" });
  });
});

describe("hole 6: the guard sits at the final launch boundary", () => {
  const BAD = `sk-flux-${"p".repeat(30)}`;
  it("hole 6: a Flux key put into the final Codex env by an MCP server env is refused", () => {
    const env = cloudTurnEnvironment("codex", {});
    // exactly what mountMcpServer does: Object.assign(env, server.env), after the early scrub
    Object.assign(env, { MY_MCP_TOKEN: BAD });
    expect(() => cloudTurnLaunch("/opt/codex", ["app-server"], env)).toThrow(cloudHomeCopy.signInEnginesNoFlux);
    expect(() => assertFinalEngineEnv("codex", env, ["app-server"])).toThrow(cloudHomeCopy.signInEnginesNoFlux);
  });
  it("hole 6: a Flux key in Claude's typed render (what the launcher renders its MCP config from) is refused", () => {
    for (const token of [BAD, "sk%2Dflux-" + "q".repeat(30)]) {
      const env = cloudTurnEnvironment("claudeAgent", {});
      cloudTurnRender(env, "mcp", { x: { proxy: "connectors", env: { MURAGE_CONNECTORS_TOKEN: token } } });
      expect(() => cloudTurnLaunch("/opt/claude", ["-p"], env)).toThrow(cloudHomeCopy.signInEnginesNoFlux);
      expect(() => assertFinalEngineEnv("claudeAgent", env, [])).toThrow(cloudHomeCopy.signInEnginesNoFlux);
    }
  });
  it("hole 6: a Flux base URL in a Codex render or in argv is refused", () => {
    const env = cloudTurnEnvironment("codex", {});
    cloudTurnRender(env, "route", { provider: "flux", baseUrl: "https://api.fluxrouter.ai/v1", model: "m", apiKey: "x" });
    expect(() => cloudTurnLaunch("/opt/codex", [], env)).toThrow(cloudHomeCopy.signInEnginesNoFlux);
    expect(() => cloudTurnLaunch("/opt/codex", ["-c", "x=https%3A%2F%2Fapi.fluxrouter.ai"], cloudTurnEnvironment("codex", {}))).toThrow();
  });
  it("hole 6: a clean sign-in launch and a system prompt that merely names Flux still start; other engines are not touched", () => {
    const env = cloudTurnEnvironment("claudeAgent", {});
    cloudTurnRender(env, "systemPrompt", "Tell me about fluxrouter.ai pricing");
    expect(cloudTurnLaunch("/opt/claude", ["-p"], env)).not.toBeNull();
    cloudTurnRender(env, "systemPrompt", `my key ${BAD}`);
    expect(() => cloudTurnLaunch("/opt/claude", ["-p"], env)).toThrow(cloudHomeCopy.signInEnginesNoFlux);
    const other = cloudTurnEnvironment("fuigoAgent", {}); other.X = BAD;
    expect(cloudTurnLaunch("/opt/fuigo", [], other)).not.toBeNull();
  });
});

describe("finding 6: TOML escapes cannot hide Flux from the TypeScript guard", () => {
  const B = String.fromCharCode(92);
  const z = "z".repeat(24);
  const cases: Record<string, string> = {
    "short escapes": `token = "${B}u0073k-${B}u0066lux-${z}"`,
    "long escape": `token = "${B}U00000073k-flux-${z}"`,
    "hex escape": `token = "${B}x73k-flux-${z}"`,
    "escaped host": `base_url = "https://api.${B}u0066luxrouter.ai/v1"`,
    "line continuation": `base_url = "https://api.flux${B}\n      router.ai/v1"`,
    "continuation inside a key": `[model_providers.sk-fl${B}\n   ux-${z}]`,
    "escaped table key": `[model_providers."${B}u0066luxrouter"]\nname = "x"`,
    "plain": 'base_url = "https://api.fluxrouter.ai/v1"',
  };
  it.each(Object.entries(cases))("a staged Codex TOML with %s is refused", (_name, text) => {
    expect(() => assertFinalLaunchFluxFree("codex", { files: { "/work/.codex/config.toml": text } })).toThrow(cloudHomeCopy.signInEnginesNoFlux);
    expect(() => assertFinalLaunchFluxFree("claudeAgent", { files: { "/work/.claude/x.toml": text } })).toThrow(cloudHomeCopy.signInEnginesNoFlux);
    expect(() => assertFinalLaunchFluxFree("codex", { args: ["-c", text] })).toThrow(cloudHomeCopy.signInEnginesNoFlux);
  });
  it("decodes only what TOML decodes, and an ordinary config still passes", () => {
    expect(decodeTomlEscapes(`${B}u0041${B}x42${B}U00000043${B}${B}${B}"`)).toBe(`ABC${B}"`);
    expect(decodeTomlEscapes(`a${B}\n   b`)).toBe("ab");
    expect(decodeTomlEscapes(`${B}U00110000`)).toBe(`${B}U00110000`);
    expect(() => assertFinalLaunchFluxFree("codex", { files: { "/work/.codex/config.toml": 'check_for_update_on_startup = false\nmodel = "gpt-5"\n' }, args: ["-c", "sandbox_mode=read-only"] })).not.toThrow();
  });
});
