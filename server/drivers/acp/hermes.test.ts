import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../../testing/cleanup.ts";
import {
  HERMES_CONFIG_MODEL_ID,
  HERMES_OPENMAUS_SCREENSHOT_COMPAT,
  HERMES_OPENMAUS_SCREENSHOT_COMPAT_MODEL,
  bindHermesScreenshotCompat,
  hermesAcpModelId,
  hermesConfiguredModel,
} from "./hermes.ts";

describe("Hermes Murage screenshot compatibility binding", () => {
  it("binds the exact leaf model for an injected local picker model", () => {
    const env = {
      [HERMES_OPENMAUS_SCREENSHOT_COMPAT]: undefined,
      [HERMES_OPENMAUS_SCREENSHOT_COMPAT_MODEL]: undefined,
    };

    bindHermesScreenshotCompat(env, "omlx::gemma-4-31b-it-bf16");

    expect(env[HERMES_OPENMAUS_SCREENSHOT_COMPAT]).toBe("1");
    expect(env[HERMES_OPENMAUS_SCREENSHOT_COMPAT_MODEL]).toBe("gemma-4-31b-it-bf16");
  });

  it.each([undefined, "", "anthropic/claude-opus-4.6", "unknown::model"])(
    "clears inherited compatibility for an unbound model %s",
    (model) => {
      const env = {
        [HERMES_OPENMAUS_SCREENSHOT_COMPAT]: "1",
        [HERMES_OPENMAUS_SCREENSHOT_COMPAT_MODEL]: "stale/model",
      };

      bindHermesScreenshotCompat(env, model);

      expect(env[HERMES_OPENMAUS_SCREENSHOT_COMPAT]).toBeUndefined();
      expect(env[HERMES_OPENMAUS_SCREENSHOT_COMPAT_MODEL]).toBeUndefined();
    },
  );
});

describe("hermesConfiguredModel", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await removeTempDir(d);
  });

  const home = (env: string, cfg?: string) => {
    const root = mkdtempSync(join(tmpdir(), "murage-hermes-"));
    dirs.push(root);
    const h = join(root, ".hermes");
    mkdirSync(h, { recursive: true });
    writeFileSync(join(h, ".env"), env);
    if (cfg !== undefined) writeFileSync(join(h, "config.yaml"), cfg);
    return { HERMES_HOME: h };
  };

  it("offers the configured model when a hosted key is set", () => {
    const env = home("OPENROUTER_API_KEY=sk-or-v1-test\n", "model:\n  default: anthropic/claude-opus-4.6\n");
    expect(hermesConfiguredModel(env)).toEqual({
      id: HERMES_CONFIG_MODEL_ID,
      label: "anthropic/claude-opus-4.6 (Hermes config)",
      // ModelPicker shows a custom-only agent ONLY its custom-flagged options.
      custom: true,
    });
  });

  it.each(["GLM_API_KEY", "ZAI_API_KEY", "Z_AI_API_KEY"])(
    "offers Hermes for a key-only Z.AI setup using %s",
    (name) => {
      const env = home(`${name}=zai-test-key\n`);
      expect(hermesConfiguredModel(env)).toEqual({
        id: HERMES_CONFIG_MODEL_ID,
        label: "Hermes default (config)",
        custom: true,
      });
    },
  );

  it("treats a commented-out key with no config.yaml as not configured", () => {
    // The shipped .env carries `# OPENROUTER_API_KEY=`; without config.yaml
    // there's no evidence of a working provider, so it must not read as configured.
    const env = home("# OPENROUTER_API_KEY=\n");
    expect(hermesConfiguredModel(env)).toBeNull();
  });

  it("treats a commented-out key with config.yaml as configured (Nous Portal)", () => {
    // A Nous Portal user has OAuth tokens, not an OpenRouter API key.
    // config.yaml existing is sufficient evidence of a working provider.
    const env = home("# OPENROUTER_API_KEY=\n", "model:\n  default: z-ai/glm-5.2\n");
    expect(hermesConfiguredModel(env)).toEqual({
      id: HERMES_CONFIG_MODEL_ID,
      label: "z-ai/glm-5.2 (Hermes config)",
      custom: true,
    });
  });

  it.each([
    "OPENROUTER_API_KEY=\n",
    'OPENROUTER_API_KEY=""\n',
    "OPENROUTER_API_KEY='' # intentionally blank\n",
    "OPENROUTER_API_KEY=   # configured later\n",
  ])("does not treat a blank key with no config.yaml as configured: %j", (line) => {
    expect(hermesConfiguredModel(home(line))).toBeNull();
  });

  it("returns null when there is no .env and no config.yaml, leaving local-only setups unchanged", () => {
    const root = mkdtempSync(join(tmpdir(), "murage-hermes-bare-"));
    dirs.push(root);
    mkdirSync(join(root, ".hermes"), { recursive: true });
    expect(hermesConfiguredModel({ HERMES_HOME: join(root, ".hermes") })).toBeNull();
  });

  it("offers the configured model when only config.yaml exists (Nous Portal OAuth)", () => {
    // A Nous Portal user logs in via OAuth — no API key in .env, but
    // config.yaml exists with a default model. This is the most common
    // setup for `hermes setup` / `hermes login` users.
    const root = mkdtempSync(join(tmpdir(), "murage-hermes-nous-"));
    dirs.push(root);
    const h = join(root, ".hermes");
    mkdirSync(h, { recursive: true });
    writeFileSync(join(h, "config.yaml"), "model:\n  default: z-ai/glm-5.2\n");
    expect(hermesConfiguredModel({ HERMES_HOME: h })).toEqual({
      id: HERMES_CONFIG_MODEL_ID,
      label: "z-ai/glm-5.2 (Hermes config)",
      custom: true,
    });
  });

  it("does not treat an inject-only config.yaml as hosted configuration", () => {
    const env = home("", "providers:\n  ollama:\n    base_url: http://127.0.0.1:11434/v1\n");
    expect(hermesConfiguredModel(env)).toBeNull();
  });

  it.each(["custom", "ollama", "vllm", "llamacpp", "lmstudio"])(
    "does not probe a model explicitly routed through the local %s provider",
    (provider) => {
      const env = home("", `model:\n  default: llama3.2 # local model\n  provider: ${provider}\n`);
      expect(hermesConfiguredModel(env)).toBeNull();
    },
  );

  it("keeps an explicit local provider even when a hosted key is also present", () => {
    const env = home(
      "OPENROUTER_API_KEY=stale-hosted-key\n",
      "model:\n  default: llama3.2\n  provider: ollama\n",
    );
    expect(hermesConfiguredModel(env)).toBeNull();
  });

  it("keeps a named custom provider even when a hosted key is also present", () => {
    const env = home(
      "OPENROUTER_API_KEY=stale-hosted-key\n",
      "model:\n  default: local-model\n  provider: custom:local\n",
    );
    expect(hermesConfiguredModel(env)).toBeNull();
  });

  it.each([
    ["scalar", "model: z-ai/glm-5.2 # selected by setup\n", "z-ai/glm-5.2"],
    ["default", "model:\n  default: z-ai/glm-5.2 # selected by setup\n", "z-ai/glm-5.2"],
    ["model alias", "model:\n  model: z-ai/glm-5.2\n", "z-ai/glm-5.2"],
    ["name alias", "model:\n  name: z-ai/glm-5.2\n", "z-ai/glm-5.2"],
    [
      "nested default",
      "model:\n  provider: auto\n  default:\n    provider: nous\n    model: z-ai/glm-5.2\n",
      "z-ai/glm-5.2",
    ],
    ["legacy root provider", "provider: nous\nmodel:\n  default: z-ai/glm-5.2\n", "z-ai/glm-5.2"],
  ])("supports Hermes' %s configuration schema", (_schema, cfg, expectedModel) => {
    const env = home("", cfg);
    expect(hermesConfiguredModel(env)).toEqual({
      id: HERMES_CONFIG_MODEL_ID,
      label: `${expectedModel} (Hermes config)`,
      custom: true,
    });
  });

  it("still offers the model when config.yaml is unreadable, with a generic label", () => {
    const env = home("OPENROUTER_API_KEY=sk-or-v1-test\n");
    mkdirSync(join(env.HERMES_HOME, "config.yaml"));
    expect(hermesConfiguredModel(env)).toEqual({
      id: HERMES_CONFIG_MODEL_ID,
      label: "Hermes default (config)",
      custom: true,
    });
  });

  it("does not map to an ACP model id, so no session/set_model is sent for it", () => {
    // This is what makes Hermes fall through to its own configured provider.
    expect(hermesAcpModelId(HERMES_CONFIG_MODEL_ID)).toBeNull();
  });
});

describe("hermesAcpModelId", () => {
  it("forwards Hermes' own provider-scoped ids untouched", () => {
    // These are what `session/new` advertises. Returning null for them is what
    // confined the picker to locally injected hosts.
    expect(hermesAcpModelId("openrouter:qwen/qwen3.8-max")).toBe("openrouter:qwen/qwen3.8-max");
    expect(hermesAcpModelId("openrouter:deepseek/deepseek-v4-flash")).toBe(
      "openrouter:deepseek/deepseek-v4-flash",
    );
  });

  it("still maps local inject ids to Hermes' custom:<host>:<model> form", () => {
    expect(hermesAcpModelId("ollama::llama3")).toBe("custom:ollama:llama3");
  });

  it("returns null for the config sentinel, so Hermes keeps its own default", () => {
    expect(hermesAcpModelId(HERMES_CONFIG_MODEL_ID)).toBeNull();
  });

  it("returns null for a bare word that names no provider", () => {
    expect(hermesAcpModelId("gpt-5")).toBeNull();
});
});

// ---------------------------------------------------------------------------
// Hermes × Flux Router — the SCOPED HOME surface.
//
// Hermes is the engine that proves env injection is not the only mechanism.
// It reads no Flux variable at all: the route lives entirely in a config.yaml
// this app writes into a directory it owns, and one HERMES_HOME pointing at
// it. So every assertion below is about a FILE and about what the child was
// spawned with — read off FAKE_ACP_DUMP rather than from the driver, because
// the interesting failures are ordering ones (core.ts:311 builds the env,
// :322 is the only hook that can both write the file and aim the child at it).
//
// The user's real ~/.hermes is asserted untouched every time. That is the
// entire justification for preferring a scoped home over a config write, and
// an implementation that quietly wrote to ~/.hermes/config.yaml would pass a
// naive "does Flux work" test and fail these.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { HermesAgentDriver, applyHermesFluxHome, fluxHermesHome } from "./hermes.ts";

const FAKE_ACP = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");

/** Shape only, never a live credential. */
const FLUX_KEY = "sk-flux-Cccccccccccccccccccccccccccccccccccccccccc";

describe("hermes Flux routing — the scoped HERMES_HOME", () => {
  let home: string;
  let state: string;
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;

  const scopedEnv = () => ({ HOME: home, MURAGE_DATA_DIR: state });
  const scopedYaml = () => join(fluxHermesHome(scopedEnv()), "config.yaml");
  const userConfig = () => join(home, ".hermes", "config.yaml");

  async function spawnFor(
    model: string | undefined,
    extra: Record<string, string> = {},
  ): Promise<{ argv: string[]; env: Record<string, string> }> {
    const dump = join(home, `dump-${Math.random().toString(36).slice(2)}.json`);
    instance = await HermesAgentDriver.create({
      instanceId: "hermes-flux",
      displayName: "Hermes",
      environment: { HOME: home, MURAGE_DATA_DIR: state, FAKE_ACP_DUMP: dump, ...extra },
      enabled: true,
      config: { cli: FAKE_ACP, fullAuto: true },
    });
    recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "t-flux", text: "hi", model });
    await recorder.until((e) => e.type === "turn.completed");
    return JSON.parse(readFileSync(dump, "utf8")) as { argv: string[]; env: Record<string, string> };
  }

  beforeEach(() => {
    ensureDirs();
    home = mkdtempSync(join(tmpdir(), "murage-hermes-flux-"));
    state = mkdtempSync(join(tmpdir(), "murage-hermes-state-"));
    process.env.FLUX_API_KEY = FLUX_KEY;
  });

  afterEach(async () => {
    delete process.env.FLUX_API_KEY;
    recorder?.stop();
    await instance?.dispose();
    instance = undefined;
    recorder = undefined;
    await removeTempDir(state);
  });

  it("writes a config.yaml hermes will accept, with the key INLINE", async () => {
    await spawnFor("flux-auto");
    const yaml = readFileSync(scopedYaml(), "utf8");
    expect(yaml).toContain("  default: flux-auto");
    // `custom` is the literal hermes requires — an invented `provider: flux`
    // dies with `AuthError: Unknown provider 'flux'` (Wayland HERMES-PROOF.md:32-35).
    expect(yaml).toContain("  provider: custom");
    expect(yaml).toContain("  base_url: https://api.fluxrouter.ai/v1");
    expect(yaml).toContain("  api_mode: chat_completions");
    // Inline, never key_env: for a `custom` provider hermes ignores key_env and
    // falls back to a stale stored token → HTTP 401 token_not_found.
    expect(yaml).toContain(`  api_key: ${FLUX_KEY}`);
    expect(yaml).not.toContain("key_env");
    expect(yaml).toContain("providers: {}");
  });

  it("leaves ~/.hermes alone and passes no -m", async () => {
    const { argv } = await spawnFor("flux-auto");
    expect(existsSync(userConfig())).toBe(false);
    // ACP ignores -m, so the model can only come from the scoped config.yaml.
    expect(argv).toEqual(["acp"]);
  });

  it("aims the child env at the scoped home, and puts the key NOWHERE in it", () => {
    // Read off the env object directly rather than FAKE_ACP_DUMP: that dump is
    // a fixed allowlist of names (fake-acp-cli.ts:60-110) which carries
    // neither HERMES_HOME nor FLUX_API_KEY, so a dump-based assertion here
    // would pass whatever the implementation did.
    const env: Record<string, string | undefined> = { HOME: home, MURAGE_DATA_DIR: state, PATH: "/bin" };
    const tier = applyHermesFluxHome(env, "flux-auto", FLUX_KEY);
    expect(tier).toBe("flux-auto");
    expect(env.HERMES_HOME).toBe(fluxHermesHome(scopedEnv()));
    // The bearer lives in the 0600 config.yaml and in no variable at all.
    expect(Object.keys(env).filter((key) => env[key] === FLUX_KEY)).toEqual([]);
    expect(Object.keys(env).sort()).toEqual(["HERMES_HOME", "HOME", "MURAGE_DATA_DIR", "PATH"]);
  });

  it("POSITIVE CONTROL — the same helper touches nothing for a native id", () => {
    const env: Record<string, string | undefined> = { HOME: home, MURAGE_DATA_DIR: state, PATH: "/bin" };
    expect(applyHermesFluxHome(env, "openrouter:qwen/qwen3.8-max", FLUX_KEY)).toBeNull();
    expect(env.HERMES_HOME).toBeUndefined();
    expect(existsSync(scopedYaml())).toBe(false);
  });

  it("sends no session/set_model, so config.yaml's default is what runs", () => {
    // hermesAcpModelId returning null is the mechanism: configureSession
    // early-returns and hermes falls through to `model.default`.
    for (const tier of ["flux-auto", "flux-reasoning", "flux-standard", "flux-fast"]) {
      expect(hermesAcpModelId(tier)).toBeNull();
    }
  });

  it("regenerates the scoped home per spawn, so a tier change lands", async () => {
    await spawnFor("flux-auto");
    expect(readFileSync(scopedYaml(), "utf8")).toContain("default: flux-auto");
    await instance?.dispose();
    instance = undefined;
    await spawnFor("flux-reasoning");
    const yaml = readFileSync(scopedYaml(), "utf8");
    expect(yaml).toContain("default: flux-reasoning");
    expect(yaml).not.toContain("flux-auto");
  });

  it("keeps the bearer token off other users of the machine", async () => {
    await spawnFor("flux-auto");
    expect(statSync(scopedYaml()).mode & 0o777).toBe(0o600);
    expect(statSync(fluxHermesHome(scopedEnv())).mode & 0o777).toBe(0o700);
  });

  it("refuses a Flux route under HERMES_PROFILE instead of losing the persona", () => {
    const env: Record<string, string | undefined> = { HOME: home, MURAGE_DATA_DIR: state, HERMES_PROFILE: "research" };
    expect(() => applyHermesFluxHome(env, "flux-auto", FLUX_KEY)).toThrow(/HERMES_PROFILE/);
    expect(env.HERMES_HOME).toBeUndefined();
    expect(existsSync(scopedYaml())).toBe(false);
  });

  it("surfaces that refusal as a failed turn, not a silently native one", async () => {
    const dump = join(home, "dump-profile.json");
    instance = await HermesAgentDriver.create({
      instanceId: "hermes-flux-profile",
      displayName: "Hermes",
      environment: { HOME: home, MURAGE_DATA_DIR: state, FAKE_ACP_DUMP: dump, HERMES_PROFILE: "research" },
      enabled: true,
      config: { cli: FAKE_ACP, fullAuto: true },
    });
    await expect(
      instance.adapter.sendTurn({ threadId: "t-profile", text: "hi", model: "flux-auto" }),
    ).rejects.toThrow(/HERMES_PROFILE/);
    expect(existsSync(dump)).toBe(false);
  });

  it("POSITIVE CONTROL — a native model writes no scoped home at all", async () => {
    // Without this, every assertion above would also pass on an implementation
    // that materialised the scoped home unconditionally.
    await spawnFor("openrouter:qwen/qwen3.8-max");
    expect(existsSync(scopedYaml())).toBe(false);
  });

  it("degrades to native when there is no Flux key, never to a half-written home", async () => {
    delete process.env.FLUX_API_KEY;
    await spawnFor("flux-auto");
    expect(existsSync(scopedYaml())).toBe(false);
    const env: Record<string, string | undefined> = { HOME: home, MURAGE_DATA_DIR: state };
    expect(applyHermesFluxHome(env, "flux-auto", null)).toBeNull();
    expect(env.HERMES_HOME).toBeUndefined();
  });

  it("offers the Flux tiers as CUSTOM rows, or the picker never shows them", async () => {
    instance = await HermesAgentDriver.create({
      instanceId: "hermes-flux-catalog",
      displayName: "Hermes",
      environment: { HOME: home, MURAGE_DATA_DIR: state },
      enabled: true,
      config: { cli: FAKE_ACP, fullAuto: true },
    });
    const flux = instance.models.options.filter((option) => option.id.startsWith("flux-"));
    expect(flux.map((option) => option.id)).toEqual([
      "flux-auto",
      "flux-reasoning",
      "flux-standard",
      "flux-fast",
    ]);
    // Hermes is access:"custom"; ModelPicker pins it to the Custom pane
    // (ModelPicker.tsx:166) with no way back (:208), and that pane renders
    // only options carrying this flag.
    expect(flux.every((option) => option.custom === true)).toBe(true);
  });
});
