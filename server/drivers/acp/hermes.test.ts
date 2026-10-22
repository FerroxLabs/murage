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
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { beforeEach } from "vitest";
import { parse as parseYaml } from "yaml";

import { ensureDirs } from "../../config.ts";
import { ConversationDeletions, runConversationDeletion } from "../../conversation-deletion.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { HermesAgentDriver, applyHermesFluxHome, applyHermesFluxMemory, fluxHermesHome, hermesFluxHeaderGate, parseHermesVersion } from "./hermes.ts";
import { FLUX_HEADER_REFUSAL } from "../../flux-memory-headers.ts";
import { resetVersionProbeBackoff } from "../isolation-cache.ts";

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
      environment: { HOME: home, MURAGE_DATA_DIR: state, FAKE_ACP_DUMP: dump, FAKE_ACP_VERSION: "Hermes Agent v0.21.3 (2026.9.14)", ...extra },
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
    resetVersionProbeBackoff(); // one fake file reports a different version per test; a real binary keeps one version per file signature
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

  // Gap 4: Hermes must hand an enforced turn's permission request to Murage.
  it("routeAsks overrides only Hermes skip-all permission answers", async () => {
    for (const fullAuto of [false, true]) {
      if (fullAuto) { recorder!.stop(); await instance!.dispose(); }
      instance = await HermesAgentDriver.create({
        instanceId: "hermes-enforce", displayName: "Hermes", enabled: true,
        environment: { ...scopedEnv(), FAKE_ACP_MODE: "permission", FAKE_ACP_VERSION: "Hermes Agent v0.21.3 (2026.9.14)" },
        config: { cli: FAKE_ACP, fullAuto },
      });
      recorder = recordEvents(instance.adapter);
      for (const [turn, enforced] of [false, true, false].entries()) {
        const threadId = `t-enforce-${fullAuto}-${turn}`;
        const sent = await instance.adapter.sendTurn({ threadId, text: "go", model: "flux-auto",
          ...(enforced ? { routeAsks: true as const } : {}),
        });
        const event = await recorder.until((event) => event.turnId === sent.turnId &&
          (event.type === "request.opened" || event.type === "turn.completed"));
        expect(event.type).toBe(!fullAuto || enforced ? "request.opened" : "turn.completed");
        if (event.type === "request.opened") {
          expect(event).toMatchObject({ requestType: "permission", toolCall: { name: "shell", input: { command: "echo hi" } } });
          await instance.adapter.respondToRequest(threadId, event.requestId!, { behavior: "deny" });
          await recorder.until((event) => event.type === "turn.completed" && event.turnId === sent.turnId);
        }
      }
    }
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
    // `-p default` keeps the scoped home: Hermes resolves `default` to the
    // root HERMES_HOME names, and a sticky profile is never read.
    expect(argv).toEqual(["-p", "default", "acp"]);
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
    expect(Object.keys(env).sort()).toEqual(["HERMES_HOME", "HOME", "MURAGE_DATA_DIR", "MURAGE_HERMES_ROUTED_HOME", "PATH"]);
    expect(env.MURAGE_HERMES_ROUTED_HOME).toBe(env.HERMES_HOME);
  });

  const decision = (capture: "on" | "off", inject: "on" | "off") => {
    const headers: Record<string, string> = { "x-flux-memory-app": "murage" };
    if (capture === "off") headers["x-flux-memory-capture"] = "off";
    if (inject === "off") headers["x-flux-memory-inject"] = "off";
    return { capture, inject, reason: "owner" as const, audience: "owner" as never, signature: `${capture}${inject}`, headers };
  };
  const fluxTurn = (d: ReturnType<typeof decision>, extra: Record<string, string> = {}) => {
    const env: Record<string, string | undefined> = { HOME: home, MURAGE_DATA_DIR: state, PATH: "/bin", HERMES_MANAGED_DIR: join(home, "no-admin"), ...extra };
    expect(applyHermesFluxHome(env, "flux-auto", FLUX_KEY)).toBe("flux-auto");
    applyHermesFluxMemory(env, d);
    return env;
  };
  const overlayOf = (env: Record<string, string | undefined>) => parseYaml(readFileSync(join(env.HERMES_MANAGED_DIR!, "config.yaml"), "utf8")) as { model: { extra_headers: Record<string, string> } };

  it("keeps ONE home for every audience; each child reads only its own turn's headers from its own overlay", () => {
    const owner = fluxTurn(decision("on", "on"));
    const off = fluxTurn(decision("off", "off")); // starts while the owner child is still running
    const noRecall = fluxTurn(decision("on", "off"));
    const owner2 = fluxTurn(decision("on", "on"));
    // one home: state.db and sessions/ stay where deletion and resume look
    for (const env of [owner, off, noRecall, owner2]) {
      expect(env.HERMES_HOME).toBe(fluxHermesHome(scopedEnv()));
      expect(env.MURAGE_HERMES_ROUTED_HOME).toBe(env.HERMES_HOME);
    }
    // distinct overlays per contract, the same one for the same contract
    expect(new Set([owner, off, noRecall].map((env) => env.HERMES_MANAGED_DIR)).size).toBe(3);
    expect(owner2.HERMES_MANAGED_DIR).toBe(owner.HERMES_MANAGED_DIR);
    // a later turn never changed what an earlier child reads
    expect(overlayOf(owner)).toEqual({ model: { extra_headers: { "x-flux-memory-app": "murage" } } });
    expect(overlayOf(off)).toEqual({ model: { extra_headers: { "x-flux-memory-app": "murage", "x-flux-memory-capture": "off", "x-flux-memory-inject": "off" } } });
    expect(overlayOf(noRecall)).toEqual({ model: { extra_headers: { "x-flux-memory-app": "murage", "x-flux-memory-inject": "off" } } });
    // the shared home's file is never edited for a turn, and no overlay holds the key
    expect(readFileSync(scopedYaml(), "utf8")).not.toContain("extra_headers");
    for (const env of [owner, off, noRecall]) expect(readFileSync(join(env.HERMES_MANAGED_DIR!, "config.yaml"), "utf8")).not.toContain(FLUX_KEY);
  });

  it("carries an administrator's managed config into the overlay, with Murage's memory headers winning", () => {
    const admin = join(home, "admin");
    mkdirSync(admin, { recursive: true });
    writeFileSync(join(admin, "config.yaml"), 'approvals:\n  mode: manual\nmodel:\n  extra_headers:\n    x-team: a\n    x-flux-memory-capture: "on"\n');
    const env = fluxTurn(decision("off", "off"), { HERMES_MANAGED_DIR: admin });
    expect(env.HERMES_MANAGED_DIR).not.toBe(admin);
    expect(overlayOf(env)).toEqual({ approvals: { mode: "manual" }, model: { extra_headers: { "x-team": "a", "x-flux-memory-app": "murage", "x-flux-memory-capture": "off", "x-flux-memory-inject": "off" } } });
  });

  it("deleting a conversation removes its native history from the one home every Flux turn used", async () => {
    const off = fluxTurn(decision("off", "off"));
    const owner = fluxTurn(decision("on", "on"));
    const shared = (env: Record<string, string | undefined>) => env.HERMES_HOME!;
    expect(shared(off)).toBe(shared(owner));
    const sid = "a1b2c3d4-1111-4222-8333-444455556666";
    const store = new DatabaseSync(join(shared(off), "state.db"));
    store.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY, parent_session_id TEXT); CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, content TEXT);");
    store.prepare("INSERT INTO sessions(id, parent_session_id) VALUES (?, NULL), ('kept-session-0001', NULL)").run(sid);
    store.prepare("INSERT INTO messages(session_id, content) VALUES (?, 'capture-off secret'), ('kept-session-0001', 'kept')").run(sid);
    store.close();
    mkdirSync(join(shared(off), "sessions"), { recursive: true });
    writeFileSync(join(shared(off), "sessions", `${sid}.jsonl`), "capture-off secret");
    const data = mkdtempSync(join(tmpdir(), "murage-hermes-del-"));
    // the conversation's own desk folder, which is what starts engine-history removal
    mkdirSync(join(data, "workspaces", "f25024c1-a18e-4251-acf1-0c1713d9b6d9", "threads", "2e9018ee-1f45-46be-8ed1-7a02fc022807"), { recursive: true });
    writeFileSync(join(data, "workspaces", "f25024c1-a18e-4251-acf1-0c1713d9b6d9", "threads", "2e9018ee-1f45-46be-8ed1-7a02fc022807", "a.md"), "x");
    const db = new DatabaseSync(join(data, "messages.db"));
    try {
      const deletions = new ConversationDeletions({ dataDir: data, database: () => db });
      // the home server/index.ts registers for Flux Hermes turns
      await runConversationDeletion(deletions, { threadIds: ["2e9018ee-1f45-46be-8ed1-7a02fc022807"], engineHomes: [{ engine: "hermes", home: fluxHermesHome({ MURAGE_DATA_DIR: state }) }], sessionIds: { hermesAgent: [sid] } }, () => true);
    } finally {
      db.close();
      await removeTempDir(data);
    }
    const after = new DatabaseSync(join(shared(off), "state.db"));
    expect(after.prepare("SELECT id FROM sessions").all().map((row) => row.id)).toEqual(["kept-session-0001"]);
    expect(after.prepare("SELECT content FROM messages").all().map((row) => row.content)).toEqual(["kept"]);
    after.close();
    expect(existsSync(join(shared(off), "sessions", `${sid}.jsonl`))).toBe(false);
  });

  it("refuses a capture-off or inject-off turn when the home is not Murage's own, and lets an owner turn through", () => {
    const foreign = () => ({ HOME: home, MURAGE_DATA_DIR: state, HERMES_HOME: join(home, "x"), MURAGE_HERMES_ROUTED_HOME: join(home, "x") });
    expect(() => applyHermesFluxMemory(foreign(), decision("off", "off"))).toThrow(/cannot carry Flux Memory choices/);
    expect(() => applyHermesFluxMemory(foreign(), decision("on", "off"))).toThrow(/cannot carry Flux Memory choices/);
    const ownerEnv: Record<string, string | undefined> = foreign();
    expect(() => applyHermesFluxMemory(ownerEnv, decision("on", "on"))).not.toThrow();
    expect(ownerEnv.HERMES_MANAGED_DIR).toBeUndefined();
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

  it("refuses a Flux turn whose headers say off when Hermes predates managed scope, or its version is unknown", async () => {
    await expect(spawnFor("flux-auto", { FAKE_ACP_VERSION: "Hermes Agent v0.16.0 (2026.6.5)" })).rejects.toThrow(FLUX_HEADER_REFUSAL);
    await instance?.dispose();
    instance = undefined;
    resetVersionProbeBackoff();
    await expect(spawnFor("flux-auto", { FAKE_ACP_VERSION: "fake-acp 1.0.0" })).rejects.toThrow(FLUX_HEADER_REFUSAL);
  });

  // POSIX mode bits cannot establish Windows ACL privacy.
  it.skipIf(process.platform === "win32")("keeps the bearer token private through POSIX permissions", async () => {
    await spawnFor("flux-auto");
    expect(statSync(scopedYaml()).mode & 0o777).toBe(0o600);
    expect(statSync(fluxHermesHome(scopedEnv())).mode & 0o777).toBe(0o700);
  });

  it("refuses a Flux route for a pinned profile instead of losing the persona", () => {
    const env: Record<string, string | undefined> = { HOME: home, MURAGE_DATA_DIR: state };
    expect(() => applyHermesFluxHome(env, "flux-auto", FLUX_KEY, { profile: "research" })).toThrow(/Hermes profile "research"/);
    expect(env.HERMES_HOME).toBeUndefined();
    expect(existsSync(scopedYaml())).toBe(false);
  });

  it("keys the refusal on the pinned profile, not HERMES_PROFILE (Hermes ignores it)", () => {
    const env: Record<string, string | undefined> = { HOME: home, MURAGE_DATA_DIR: state, HERMES_PROFILE: "research" };
    expect(applyHermesFluxHome(env, "flux-auto", FLUX_KEY)).toBe("flux-auto");
    expect(env.HERMES_HOME).toBe(fluxHermesHome(scopedEnv()));
  });

  it("keeps Flux for a profile pinned from the sticky default on upgrade (O12)", () => {
    const env: Record<string, string | undefined> = { HOME: home, MURAGE_DATA_DIR: state };
    expect(applyHermesFluxHome(env, "flux-auto", FLUX_KEY, { profile: "flux-ceo", profileOrigin: "sticky" })).toBe("flux-auto");
  });

  it("surfaces that refusal as a failed turn, not a silently native one", async () => {
    const dump = join(home, "dump-profile.json");
    instance = await HermesAgentDriver.create({
      instanceId: "hermes-flux-profile",
      displayName: "Hermes",
      environment: { HOME: home, MURAGE_DATA_DIR: state, FAKE_ACP_DUMP: dump },
      enabled: true,
      config: { cli: FAKE_ACP, fullAuto: true, profile: "research" },
    });
    await expect(
      instance.adapter.sendTurn({ threadId: "t-profile", text: "hi", model: "flux-auto" }),
    ).rejects.toThrow(/Hermes profile "research"/);
    expect(existsSync(dump)).toBe(false);
  });

  it("does not offer Flux rows to a pinned profile that could never run them", async () => {
    instance = await HermesAgentDriver.create({
      instanceId: "hermes-profile-catalog",
      displayName: "Hermes",
      environment: { HOME: home, MURAGE_DATA_DIR: state },
      enabled: true,
      config: { cli: FAKE_ACP, fullAuto: true, profile: "research" },
    });
    expect(instance.models.options.filter((option) => option.id.startsWith("flux-"))).toEqual([]);
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

describe("hermesSpawnArgs routed homes (audit round 1, Astra 3)", () => {
  it("keeps the pinned profile when the owner's own Hermes home sits under the data dir", async () => {
    const { hermesSpawnArgs } = await import("./hermes.ts");
    const dataDir = "/workspace/murage";
    expect(hermesSpawnArgs({ profile: "fred" }, { MURAGE_DATA_DIR: dataDir, HERMES_HOME: `${dataDir}/my-hermes` })).toEqual(["-p", "fred", "acp"]);
  });

  it("passes -p default only for a home Murage made for this turn", async () => {
    const { hermesSpawnArgs, markHermesRoutedHome } = await import("./hermes.ts");
    const env: Record<string, string | undefined> = { HERMES_HOME: "/anywhere/turn-home" };
    markHermesRoutedHome(env);
    expect(hermesSpawnArgs({ profile: "fred" }, env)).toEqual(["-p", "default", "acp"]);
    // A later HERMES_HOME that is not the marked one is the owner's again.
    env.HERMES_HOME = "/elsewhere";
    expect(hermesSpawnArgs({ profile: "fred" }, env)).toEqual(["-p", "fred", "acp"]);
  });
});

describe("hermesFluxHeaderGate (managed-scope minimum 0.17.0)", () => {
  const dec = (capture: "on" | "off", inject: "on" | "off") => ({ capture, inject, reason: "owner" as const, audience: "owner" as never, signature: `${capture}${inject}`, headers: {} });
  const banner = (v: string) => `Hermes Agent v${v} (2026.9.14)`;

  it("reads the version out of the banner, not the release date", () => {
    expect(parseHermesVersion(banner("0.21.3"))).toEqual([0, 21, 3]);
    expect(parseHermesVersion("v0.17.0")).toEqual([0, 17, 0]);
    expect(parseHermesVersion("")).toBeNull();
    expect(parseHermesVersion("Hermes Agent (2026.9.14)")).toBeNull();
  });

  it("refuses an off turn on a build older than 0.17.0, with the existing refusal text", () => {
    for (const v of ["0.16.0", "0.15.1", "0.2.0"]) {
      expect(hermesFluxHeaderGate(banner(v), dec("off", "on"))).toBe(FLUX_HEADER_REFUSAL);
      expect(hermesFluxHeaderGate(banner(v), dec("on", "off"))).toBe(FLUX_HEADER_REFUSAL);
    }
  });

  it("refuses an off turn when the version is unknown or unreadable", () => {
    expect(hermesFluxHeaderGate("", dec("off", "off"))).toBe(FLUX_HEADER_REFUSAL);
    expect(hermesFluxHeaderGate("something else", dec("on", "off"))).toBe(FLUX_HEADER_REFUSAL);
  });

  it("lets an off turn run on 0.17.0 and later", () => {
    for (const v of ["0.17.0", "0.17.1", "0.20.6", "0.21.3", "1.0.0"]) expect(hermesFluxHeaderGate(banner(v), dec("off", "off"))).toBeNull();
  });

  it("never gates an all-on owner turn, whatever the version", () => {
    for (const v of ["", "0.2.0", "0.16.9", "0.21.3"]) expect(hermesFluxHeaderGate(v && banner(v), dec("on", "on"))).toBeNull();
  });
});

describe("hermes ask hook: every action asks at Ask (real hermes 0.22.2: an ordinary shell command ran unasked)", () => {
  const dirs: string[] = [];
  afterEach(async () => { for (const d of dirs.splice(0)) await removeTempDir(d); });
  const turnEnv = (extra: Record<string, string | undefined> = {}) => {
    const root = mkdtempSync(join(tmpdir(), "murage-hermes-ask-"));
    dirs.push(root);
    return { MURAGE_DATA_DIR: root, HERMES_MANAGED_DIR: join(root, "no-admin"), ...extra } as Record<string, string | undefined>;
  };
  const overlayOf = (env: Record<string, string | undefined>) => parseYaml(readFileSync(join(env.HERMES_MANAGED_DIR!, "config.yaml"), "utf8")) as { hooks: Record<string, any[]>; model?: unknown };
  const matches = (matcher: string, tool: string) => new RegExp(`^(?:${matcher})$`).test(tool);

  it("registers a pre_tool_call hook, accepted for this process, in a Murage-owned overlay", async () => {
    const { hermesAcpSupport } = await import("./hermes.ts");
    const env = turnEnv();
    hermesAcpSupport.spawnArgs({} as any, { integrations: {} } as any, { env });
    const hook = overlayOf(env).hooks.pre_tool_call[0];
    expect(hook.fail_closed).toBe(true);
    expect(hook.command).toContain("ask-hook-");
    expect(env.HERMES_ACCEPT_HOOKS).toBe("1");
    expect(env.HERMES_MANAGED_DIR!.startsWith(join(env.MURAGE_DATA_DIR!, "native", "hermes-ask"))).toBe(true);
  });

  it("removes the Hermes auto-approve switches an owner exported, so the hook gate cannot be skipped", async () => {
    const { hermesAcpSupport } = await import("./hermes.ts");
    const env = turnEnv({ HERMES_YOLO_MODE: "1", HERMES_ACP_AUTO_APPROVE: "1" });
    hermesAcpSupport.spawnArgs({} as any, { integrations: {} } as any, { env });
    expect("HERMES_YOLO_MODE" in env).toBe(false);
    expect("HERMES_ACP_AUTO_APPROVE" in env).toBe(false);
    expect(overlayOf(env).hooks.pre_tool_call[0].fail_closed).toBe(true);
  });

  it("asks for shell, code and every MCP tool, and leaves reads and Hermes's own edit approval alone", async () => {
    const { hermesAskMatcher } = await import("./hermes.ts");
    const m = hermesAskMatcher(false);
    for (const tool of ["terminal", "execute_code", "process_manage", "browser_exec", "computer_use", "delegate_task", "cronjob_manage", "mcp__computer__click", "mcp__other__thing"]) expect(matches(m, tool)).toBe(true);
    for (const tool of ["read_file", "search_files", "tool_describe", "write_file", "patch", "web_search"]) expect(matches(m, tool)).toBe(false);
  });

  it("lets Murage's computer mount through only on a host-computer turn", async () => {
    const { hermesAcpSupport, hermesAskMatcher } = await import("./hermes.ts");
    expect(hermesAcpSupport.hostComputerAskedByMurage).toBe(true);
    expect(matches(hermesAskMatcher(true), "mcp__computer__click")).toBe(false);
    expect(matches(hermesAskMatcher(true), "mcp__other__click")).toBe(true);
    expect(matches(hermesAskMatcher(true), "terminal")).toBe(true);
    const host = turnEnv();
    hermesAcpSupport.spawnArgs({} as any, { integrations: { localComputer: { command: "node", args: [], scope: "local-computer" } } } as any, { env: host });
    expect(overlayOf(host).hooks.pre_tool_call[0].matcher).toBe(hermesAskMatcher(true));
    const cloud = turnEnv();
    hermesAcpSupport.spawnArgs({} as any, { integrations: { computer: { url: "https://vm" } } } as any, { env: cloud });
    expect(overlayOf(cloud).hooks.pre_tool_call[0].matcher).toBe(hermesAskMatcher(false));
  });

  it("keeps the computer tools on the ask hook for a Local VM or VPS computer (no host scope), at every level", async () => {
    const { hermesAcpSupport, hermesAskMatcher } = await import("./hermes.ts");
    // The shapes containerComputerMcp and vpsComputerMcp hand over: integrations.localComputer with no `scope`.
    const vm = { command: process.execPath, args: ["/app/container-computer-mcp.mjs", "docker", "murage-vm", "/tmp/cua.sock"], env: { ELECTRON_RUN_AS_NODE: "1" } };
    const vps = { command: process.execPath, args: ["/app/vps-container-mcp.mjs", "my-vps", "murage-bot"], env: { ELECTRON_RUN_AS_NODE: "1" } };
    for (const localComputer of [vm, vps]) {
      for (const config of [{}, { fullAuto: true }, { fullAuto: false }]) {
        const env = turnEnv();
        hermesAcpSupport.spawnArgs(config as any, { integrations: { localComputer } } as any, { env });
        const matcher = overlayOf(env).hooks.pre_tool_call[0].matcher;
        expect(matcher).toBe(hermesAskMatcher(false));
        expect(matches(matcher, "mcp__computer__click")).toBe(true);
        expect(matches(matcher, "mcp__computer__screenshot")).toBe(true);
      }
    }
    // The host computer keeps today's exemption.
    const host = turnEnv();
    hermesAcpSupport.spawnArgs({} as any, { integrations: { localComputer: { command: "node", args: [], scope: "local-computer" } } } as any, { env: host });
    expect(matches(overlayOf(host).hooks.pre_tool_call[0].matcher, "mcp__computer__click")).toBe(false);
  });

  it("keeps the managed config it was given (Flux Memory headers, an administrator's hooks) and drops the owner's other hooks", async () => {
    const { hermesAcpSupport } = await import("./hermes.ts");
    const root = mkdtempSync(join(tmpdir(), "murage-hermes-admin-"));
    dirs.push(root);
    writeFileSync(join(root, "config.yaml"), "model:\n  extra_headers:\n    x-flux-memory-capture: on\nhooks:\n  pre_tool_call:\n    - command: /opt/admin-hook\n  post_tool_call:\n    - command: /opt/other\n");
    const env = turnEnv({ HERMES_MANAGED_DIR: root });
    hermesAcpSupport.spawnArgs({} as any, { integrations: {} } as any, { env });
    const overlay = overlayOf(env);
    expect((overlay.model as any).extra_headers["x-flux-memory-capture"]).toBe("on");
    expect(overlay.hooks.pre_tool_call.map((h) => h.command)).toEqual([expect.stringContaining("ask-hook-"), "/opt/admin-hook"]);
    expect(overlay.hooks.post_tool_call).toEqual([]);
  });

  it("the hook program answers approve with the command, whatever it is told", async () => {
    const { HERMES_ASK_HOOK_SOURCE } = await import("./hermes.ts");
    const { spawnSync } = await import("node:child_process");
    const run = (stdin: string) => JSON.parse(spawnSync(process.execPath, ["-e", HERMES_ASK_HOOK_SOURCE], { input: stdin, encoding: "utf8" }).stdout);
    expect(run(JSON.stringify({ tool_name: "terminal", tool_input: { command: "echo PROBE > ran.txt" } }))).toEqual({ action: "approve", message: "terminal: echo PROBE > ran.txt" });
    expect(run("not json").action).toBe("approve");
  });
});
