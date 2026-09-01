// The surface table has one job the type system cannot do for it: keep a
// `flux-*` id off an engine that would POST it somewhere that 400s, and get the
// key into the child env AFTER the strip that deletes it. Both are pinned here.
import { describe, expect, it } from "vitest";

import {
  PROVIDER_CREDENTIAL_ENV,
  ROUTING_ENV,
  stripRoutingEnv,
  stripWorkspaceCredentialEnv,
  WORKSPACE_CREDENTIAL_ENV,
} from "./config.ts";
import {
  applyFluxSurface,
  FLUX_ANTHROPIC_BASE,
  FLUX_CODEX_ENV_KEY,
  FLUX_CODEX_PROVIDER,
  FLUX_MODEL_IDS,
  FLUX_MODELS,
  FLUX_OPENAI_BASE,
  FLUX_RESPONSES_BASE,
  FLUX_SURFACE,
  fluxModelId,
  fluxSurfaceFor,
  isFluxModel,
  isFluxPickerModel,
} from "./flux-routing.ts";

const KEY = "sk-flux-RrLp0sj95M2kmW5zTXbUpTgfAxKc4n6VOPbL6eQJR7Q";

describe("FLUX_SURFACE", () => {
  it("maps exactly the three engines with a verified surface", () => {
    expect(FLUX_SURFACE).toEqual({ claudeAgent: "anthropic", qwenAgent: "openai", codex: "responses" });
  });

  it("leaves every non-routable engine absent, so the gate denies by default", () => {
    // opencode/qoder are config-file-only; droid/cursor/gemini/kimi/hermes and
    // the vendor-locked CLIs have no Flux surface at all (spec §4.4).
    for (const kind of ["opencodeGo", "droidAgent", "cursorAgent", "geminiAgent", "kimiAgent", "hermesAgent", "grokAgent", "piAgent", "antigravityAgent", "minimax", "openai-compat", "boxAgent", "customAcp", "gooseAgent"]) {
      expect(fluxSurfaceFor(kind)).toBeNull();
    }
  });

  it("points each surface at its verified endpoint base", () => {
    // POST https://api.fluxrouter.ai/anthropic/v1/messages — Claude Code
    // appends /v1/messages, so the base carries /anthropic. The bare host also
    // answers (both probed 200, 2026-09-01) but is not in the spec's §1.1
    // verified set, so this pins the documented route.
    expect(FLUX_ANTHROPIC_BASE).toBe("https://api.fluxrouter.ai/anthropic");
    expect(`${FLUX_ANTHROPIC_BASE}/v1/messages`).toBe("https://api.fluxrouter.ai/anthropic/v1/messages");
    expect(`${FLUX_OPENAI_BASE}/chat/completions`).toBe("https://api.fluxrouter.ai/v1/chat/completions");
    expect(`${FLUX_RESPONSES_BASE}/responses`).toBe("https://api.fluxrouter.ai/v1/responses");
  });
});

describe("FLUX_MODELS", () => {
  it("offers the four tiers in picker order, Auto first", () => {
    expect(FLUX_MODEL_IDS).toEqual(["flux-auto", "flux-reasoning", "flux-standard", "flux-fast"]);
    expect(FLUX_MODELS[0]).toEqual({ id: "flux-auto", label: "Flux Auto" });
    expect(FLUX_MODELS.map((row) => row.label)).toEqual(["Flux Auto", "Flux Reasoning", "Flux Standard", "Flux Fast"]);
  });
});

describe("isFluxModel", () => {
  it("accepts every flux-* alias, not only the four picker rows", () => {
    // The guards ask "must this turn NOT go native?". flux-pinned-* and
    // flux-voice are served by GET /v1/models and would 400 on api.openai.com.
    for (const id of ["flux-auto", "flux-fast", "flux-pinned-claude-opus-5", "flux-voice", "flux-image"]) {
      expect(isFluxModel(id)).toBe(true);
    }
  });

  it("accepts codex's provider-qualified form", () => {
    expect(isFluxModel("flux::flux-auto")).toBe(true);
    expect(fluxModelId("flux::flux-auto")).toBe("flux-auto");
    expect(fluxModelId("flux-auto")).toBe("flux-auto");
  });

  it("rejects non-flux ids, a bare prefix, and an empty selection", () => {
    for (const id of [null, undefined, "", "flux-", "flux", "fluxy-auto", "gpt-5.6-sol", "claude-opus-5", "flux::gpt-4o", "ollama::qwen3", "Flux-Auto"]) {
      expect(isFluxModel(id)).toBe(false);
      expect(fluxModelId(id)).toBeNull();
    }
  });

  it("isFluxPickerModel is the narrower exact-set test", () => {
    expect(isFluxPickerModel("flux-auto")).toBe(true);
    expect(isFluxPickerModel("flux::flux-fast")).toBe(true);
    expect(isFluxPickerModel("flux-pinned-claude-opus-5")).toBe(false);
    expect(isFluxPickerModel("flux-voice")).toBe(false);
  });
});

describe("applyFluxSurface — the gate", () => {
  it("is a no-op on an engine with no surface, leaving the env untouched", () => {
    const env: Record<string, string | undefined> = { OPENAI_API_KEY: "sk-native", PATH: "/bin" };
    const result = applyFluxSurface("opencodeGo", env, "flux-auto", KEY);
    expect(result.applied).toBe(false);
    expect(result.surface).toBeNull();
    expect(env).toEqual({ OPENAI_API_KEY: "sk-native", PATH: "/bin" });
  });

  it("is a no-op on a routable engine when the model is not a Flux id", () => {
    const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: "sk-ant-native" };
    expect(applyFluxSurface("claudeAgent", env, "claude-opus-5", KEY).applied).toBe(false);
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-native");
  });

  it("is a no-op with no key — degrades to native, never a half-written env", () => {
    const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: "sk-ant-native" };
    for (const key of [null, undefined, "", "   "]) {
      expect(applyFluxSurface("claudeAgent", env, "flux-auto", key).applied).toBe(false);
    }
    expect(env).toEqual({ ANTHROPIC_API_KEY: "sk-ant-native" });
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });
});

describe("applyFluxSurface — anthropic (claude)", () => {
  it("writes the four vars, both auth headers pinned to the Flux key", () => {
    const env: Record<string, string | undefined> = {};
    const result = applyFluxSurface("claudeAgent", env, "flux-reasoning", KEY);
    expect(result.surface).toBe("anthropic");
    expect(result.model).toBe("flux-reasoning");
    expect(result.args).toEqual([]);
    expect(env).toEqual({
      ANTHROPIC_BASE_URL: "https://api.fluxrouter.ai/anthropic",
      ANTHROPIC_AUTH_TOKEN: KEY,
      ANTHROPIC_API_KEY: KEY,
      ANTHROPIC_MODEL: "flux-reasoning",
    });
    expect(result.env).toEqual(env);
  });

  it("drops a native Anthropic identity first — mutual exclusivity", () => {
    // ANTHROPIC_API_KEY is not in ROUTING_ENV, so nothing upstream removes it;
    // the bundled claude binary prefers x-api-key, so a leftover would win.
    const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: "sk-ant-native", ANTHROPIC_BASE_URL: "http://cc-switch.local" };
    const result = applyFluxSurface("claudeAgent", env, "flux-auto", KEY);
    expect(result.stripped).toContain("ANTHROPIC_API_KEY");
    expect(env.ANTHROPIC_API_KEY).toBe(KEY);
    expect(env.ANTHROPIC_BASE_URL).toBe(FLUX_ANTHROPIC_BASE);
  });
});

describe("applyFluxSurface — openai (qwen)", () => {
  it("writes the chat-completions base, key and defensive model", () => {
    const env: Record<string, string | undefined> = { OPENAI_API_KEY: "sk-native", OPENAI_BASE_URL: "http://leftover" };
    const result = applyFluxSurface("qwenAgent", env, "flux-fast", KEY);
    expect(result.surface).toBe("openai");
    expect(result.args).toEqual([]);
    expect(env.OPENAI_BASE_URL).toBe("https://api.fluxrouter.ai/v1");
    expect(env.OPENAI_API_KEY).toBe(KEY);
    expect(env.OPENAI_MODEL).toBe("flux-fast");
    expect(result.stripped).toContain("OPENAI_API_KEY");
  });

  it("never writes an ANTHROPIC_* var on the openai surface", () => {
    const env: Record<string, string | undefined> = {};
    applyFluxSurface("qwenAgent", env, "flux-auto", KEY);
    expect(Object.keys(env).filter((k) => k.startsWith("ANTHROPIC_"))).toEqual([]);
  });
});

describe("applyFluxSurface — responses (codex)", () => {
  it("declares the provider table and keeps the secret out of argv", () => {
    const env: Record<string, string | undefined> = {};
    const result = applyFluxSurface("codex", env, "flux::flux-auto", KEY);
    expect(result.surface).toBe("responses");
    expect(result.model).toBe("flux-auto");
    expect(env[FLUX_CODEX_ENV_KEY]).toBe(KEY);
    expect(result.args).toEqual([
      "-c", `model_providers.${FLUX_CODEX_PROVIDER}.name="Flux Router"`,
      "-c", `model_providers.${FLUX_CODEX_PROVIDER}.base_url="https://api.fluxrouter.ai/v1"`,
      "-c", `model_providers.${FLUX_CODEX_PROVIDER}.wire_api="responses"`,
      "-c", `model_providers.${FLUX_CODEX_PROVIDER}.env_key="${FLUX_CODEX_ENV_KEY}"`,
    ]);
    // argv is world-readable in `ps`: the NAME travels, never the value.
    expect(result.args.join(" ")).not.toContain(KEY);
    expect(result.args.join(" ")).toContain(FLUX_CODEX_ENV_KEY);
  });

  it("sets no global model_provider — codex picks it per thread/start", () => {
    // codex.ts:540-544 passes `modelProvider` decoded from `flux::flux-auto`.
    // A global default would hijack a native turn on the same app-server.
    const { args } = applyFluxSurface("codex", {}, "flux-auto", KEY);
    expect(args.join(" ")).not.toContain("model_provider=");
  });

  it("drops codex's native bearers so a Flux turn carries one identity", () => {
    const env: Record<string, string | undefined> = { OPENAI_API_KEY: "sk-native", CODEX_API_KEY: "sk-codex" };
    const result = applyFluxSurface("codex", env, "flux-auto", KEY);
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CODEX_API_KEY).toBeUndefined();
    expect(result.stripped).toEqual(expect.arrayContaining(["OPENAI_API_KEY", "CODEX_API_KEY"]));
  });
});

describe("Kimi finding C — the key must survive the strip", () => {
  it("FLUX_API_KEY really is deleted from a child env, so it cannot be the source", () => {
    const env: Record<string, string | undefined> = { FLUX_API_KEY: KEY };
    stripWorkspaceCredentialEnv(env);
    expect(env.FLUX_API_KEY).toBeUndefined();
    expect(WORKSPACE_CREDENTIAL_ENV).toContain("FLUX_API_KEY");
  });

  it("takes the key from its argument, never from the env it is mutating", () => {
    // Exactly the shape childEnv() hands us: the key is gone from `env`.
    const env: Record<string, string | undefined> = { FLUX_API_KEY: KEY };
    stripWorkspaceCredentialEnv(env);
    expect(applyFluxSurface("claudeAgent", env, "flux-auto", KEY).applied).toBe(true);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(KEY);

    // And the inverse: a key sitting in `env` is NOT a source. If this ever
    // starts passing as applied, the applier has begun reading the env and
    // will 401 the moment it runs after a real strip.
    const ambient: Record<string, string | undefined> = { FLUX_API_KEY: KEY };
    expect(applyFluxSurface("claudeAgent", ambient, "flux-auto", undefined).applied).toBe(false);
    expect(ambient.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("the codex indirection name is in NO strip list, so it reaches the CLI", () => {
    expect(WORKSPACE_CREDENTIAL_ENV as readonly string[]).not.toContain(FLUX_CODEX_ENV_KEY);
    expect(PROVIDER_CREDENTIAL_ENV as readonly string[]).not.toContain(FLUX_CODEX_ENV_KEY);
    expect(ROUTING_ENV as readonly string[]).not.toContain(FLUX_CODEX_ENV_KEY);

    const env: Record<string, string | undefined> = { FLUX_API_KEY: KEY };
    stripWorkspaceCredentialEnv(env);
    stripRoutingEnv(env);
    applyFluxSurface("codex", env, "flux::flux-auto", KEY);
    // Re-run both strips: a real spawn path may strip again downstream, and
    // the whole point of the harness-owned name is that it survives.
    stripWorkspaceCredentialEnv(env);
    stripRoutingEnv(env);
    expect(env[FLUX_CODEX_ENV_KEY]).toBe(KEY);
    expect(env.FLUX_API_KEY).toBeUndefined();
  });

  it("the anthropic/openai surfaces are stripped by a LATE strip — they must be applied last", () => {
    // Documents the ordering contract for the driver wiring phase: these four
    // names are in ROUTING_ENV, so injecting before the strip silently 401s.
    const env: Record<string, string | undefined> = {};
    applyFluxSurface("claudeAgent", env, "flux-auto", KEY);
    stripRoutingEnv(env);
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(ROUTING_ENV as readonly string[]).toContain("ANTHROPIC_BASE_URL");
  });
});
