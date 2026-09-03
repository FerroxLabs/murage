import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents } from "../../testing/events.ts";
import {
  classifyOpenCodeError,
  canListOpenCodeModels,
  createOpenCodeDriver,
  normalizeLegacyOpenCodeModel,
  parseOpenCodeModelsOutput,
} from "./opencode-go.ts";
import type { ModelCatalog } from "../../contracts.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");

const catalog = (...ids: string[]): ModelCatalog => ({
  default: ids[0]!,
  options: ids.map((id) => ({ id, label: id })),
});

describe("OpenCode catalog", () => {
  it("parses Zen, Go, third-party, and local models using exact CLI slugs", () => {
    const models = parseOpenCodeModelsOutput([
      "openrouter/vendor/model-v2",
      JSON.stringify({ name: "Vendor Model", status: "active" }, null, 2),
      "opencode/x-preview-f-free",
      JSON.stringify({ name: "Ox Alpha Free", status: "active", limit: { context: 1_000_000 } }, null, 2),
      "opencode-go/minimax-m3",
      JSON.stringify({ name: "MiniMax M3", status: "active" }, null, 2),
      "ollama/qwen3",
      JSON.stringify({ name: "Qwen 3", api: { url: "http://127.0.0.1:11434/v1" } }, null, 2),
      "lmstudio/qwen3-ipv6",
      JSON.stringify({ name: "Qwen 3 IPv6", api: { url: "http://[::1]:1234/v1" } }, null, 2),
      "opencode/retired",
      JSON.stringify({ name: "Retired", status: "deprecated" }, null, 2),
    ].join("\n"));

    expect(models?.default).toBe("opencode/x-preview-f-free");
    expect(models?.options).toEqual([
      expect.objectContaining({ id: "openrouter/vendor/model-v2", label: "OpenRouter · Vendor Model" }),
      expect.objectContaining({
        id: "opencode/x-preview-f-free",
        label: "Zen · Ox Alpha Free",
        contextWindow: 1_000_000,
      }),
      expect.objectContaining({ id: "opencode-go/minimax-m3", label: "Go · MiniMax M3" }),
      expect.objectContaining({ id: "ollama/qwen3", custom: true, loaded: true }),
      expect.objectContaining({ id: "lmstudio/qwen3-ipv6", custom: true, loaded: true }),
    ]);
  });

  it("caches the anonymous model probe across authentication checks", async () => {
    const runModels = vi.fn(async () => "opencode/x-preview-f-free\n");

    await expect(canListOpenCodeModels({}, "counting-opencode", runModels)).resolves.toBe(true);
    await expect(canListOpenCodeModels({}, "counting-opencode", runModels)).resolves.toBe(true);

    expect(runModels).toHaveBeenCalledOnce();
  });

  it("accepts header-only output from older CLIs and rejects malformed lines", () => {
    const models = parseOpenCodeModelsOutput([
      "Available models",
      "opencode/x-preview-f-free",
      "bad model/with space",
      "openrouter/anthropic/claude-sonnet-5",
    ].join("\n"));

    expect(models?.options.map((option) => option.id)).toEqual([
      "opencode/x-preview-f-free",
      "openrouter/anthropic/claude-sonnet-5",
    ]);
  });

  it("refreshes the same instance catalog on each explicit refresh", async () => {
    let calls = 0;
    const driver = createOpenCodeDriver(async () => {
      calls += 1;
      const id = calls === 1
        ? "opencode/x-preview-f-free"
        : calls === 2
          ? "opencode-go/extra-two"
          : "openrouter/vendor/extra-three";
      return catalog(id);
    });
    const instance = await driver.create({
      instanceId: "opencode-refresh",
      displayName: "OpenCode",
      environment: {},
      enabled: true,
      config: driver.defaultConfig(),
    });

    expect(instance.models.default).toBe("opencode/x-preview-f-free");
    expect(instance.models.options.some((option) => option.custom)).toBe(false);
    await instance.refreshModels?.();
    expect(instance.models.options.some((option) => option.id === "opencode-go/extra-two" && !option.custom)).toBe(true);
    await instance.refreshModels?.();
    expect(instance.models.options.some((option) => option.id === "openrouter/vendor/extra-three" && !option.custom)).toBe(true);
    await instance.dispose();
  });

  it("keeps the driver optional and declares the OpenCode CLI setup", () => {
    const driver = createOpenCodeDriver(async () => catalog("opencode/x-preview-f-free"));
    expect(driver.driverKind).toBe("opencodeGo");
    expect(driver.metadata.displayName).toBe("OpenCode");
    expect(driver.decodeConfig(undefined)).toEqual({ cli: "opencode", fullAuto: false, workspace: undefined });
    expect(driver.install?.docsUrl).toContain("opencode.ai");
    expect(driver.install?.signInCommand).toBe("opencode auth login");
  });

  it("migrates the retired Ox preview id without changing current ids", () => {
    expect(normalizeLegacyOpenCodeModel("opencode-go/ox-alpha-free", {})).toBe(
      "opencode/x-preview-f-free",
    );
    expect(normalizeLegacyOpenCodeModel("opencode-go/ox-alpha-free", { OPENCODE_API_KEY: "configured" })).toBe(
      "opencode-go/x-preview-f-free",
    );
    expect(normalizeLegacyOpenCodeModel("opencode/gpt-5.6-sol", {})).toBe("opencode/gpt-5.6-sol");
  });

  it("recognizes an OpenCode Go login stored by the CLI", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "murage-opencode-auth-"));
    const authDir = join(scratch, "opencode");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "auth.json"), JSON.stringify({
      "opencode-go": { type: "api", key: "stored-secret" },
    }));
    const driver = createOpenCodeDriver(async () => catalog("opencode-go/minimax-m3"));
    const instance = await driver.create({
      instanceId: "opencode-auth",
      displayName: "OpenCode",
      environment: { XDG_DATA_HOME: scratch, OPENCODE_API_KEY: "" },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect((await instance.snapshot()).authenticated).toBe(true);
    } finally {
      await instance.dispose();
      await removeTempDir(scratch);
    }
  });

  it("finds the CLI's login at ~/.local/share on every platform, macOS included", async () => {
    // `opencode auth list` prints ~/.local/share/opencode/auth.json on macOS —
    // the CLI is xdg-flavoured everywhere. Looking only in Library/Application
    // Support is the bug that told signed-in users to sign in. No XDG override
    // here on purpose: this is the exact real-world shape.
    const scratch = mkdtempSync(join(tmpdir(), "murage-opencode-home-"));
    const authDir = join(scratch, ".local", "share", "opencode");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "auth.json"), JSON.stringify({
      "opencode-go": { type: "api", key: "stored-secret" },
    }));
    const driver = createOpenCodeDriver(async () => catalog("opencode-go/minimax-m3"));
    const instance = await driver.create({
      instanceId: "opencode-home-auth",
      displayName: "OpenCode",
      environment: { HOME: scratch, USERPROFILE: scratch, XDG_DATA_HOME: "", OPENCODE_API_KEY: "" },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect((await instance.snapshot()).authenticated).toBe(true);
    } finally {
      await instance.dispose();
      await removeTempDir(scratch);
    }
  });

  it("recognizes an existing OpenCode Zen login", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "murage-opencode-oauth-"));
    const authDir = join(scratch, "opencode");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "auth.json"), JSON.stringify({
      opencode: { type: "oauth", access: "acc-token", refresh: "ref-token" },
    }));
    const driver = createOpenCodeDriver(async () => catalog("opencode/x-preview-f-free"));
    const instance = await driver.create({
      instanceId: "opencode-oauth-auth",
      displayName: "OpenCode",
      environment: { XDG_DATA_HOME: scratch, OPENCODE_API_KEY: "" },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect((await instance.snapshot()).authenticated).toBe(true);
    } finally {
      await instance.dispose();
      await removeTempDir(scratch);
    }
  });

  it("treats OpenCode's anonymous free catalog as runnable without a saved key", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "murage-opencode-free-"));
    const driver = createOpenCodeDriver(async () => catalog("opencode/x-preview-f-free"));
    const instance = await driver.create({
      instanceId: "opencode-free",
      displayName: "OpenCode",
      environment: {
        HOME: scratch,
        USERPROFILE: scratch,
        XDG_DATA_HOME: join(scratch, "data"),
        FAKE_ACP_MODELS: "opencode/x-preview-f-free",
      },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect((await instance.snapshot()).authenticated).toBe(true);
    } finally {
      await instance.dispose();
      await removeTempDir(scratch);
    }
  });

  it("runs a Zen model through ACP using the exact discovered id", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "murage-opencode-zen-only-"));
    const authDir = join(scratch, "opencode");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "auth.json"), JSON.stringify({
      opencode: { type: "api", key: "zen-only-secret" },
    }));
    const driver = createOpenCodeDriver(async () => catalog("opencode/x-preview-f-free"));
    const instance = await driver.create({
      instanceId: "opencode-zen-only",
      displayName: "OpenCode",
      environment: {
        XDG_DATA_HOME: scratch,
        OPENCODE_API_KEY: "",
        FAKE_ACP_MODELS: "opencode/x-preview-f-free",
      },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({
        threadId: "t-opencode-zen-only",
        text: "hello",
        model: "opencode/x-preview-f-free",
      });
      const done = await recorder.until((event) => event.type === "turn.completed");
      expect(done).toMatchObject({ ok: true });
      expect(recorder.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "session.started", model: "opencode/x-preview-f-free" }),
      ]));
    } finally {
      recorder.stop();
      await instance.dispose();
      await removeTempDir(scratch);
    }
  });

  it("classifies ACP's standard authentication error", () => {
    expect(classifyOpenCodeError({ code: -32000 })).toBe("invalid_credentials");
  });

  it("keeps the OpenCode key in the child environment only", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "murage-opencode-go-"));
    try {
      const dump = join(scratch, "env.json");
      const driver = createOpenCodeDriver(async () => catalog("opencode-go/minimax-m3"));
      const instance = await driver.create({
        instanceId: "opencode-go",
        displayName: "OpenCode",
        environment: {
          OPENCODE_API_KEY: "secret-value",
          OPENAI_API_KEY: "wrong-provider-secret",
          ANTHROPIC_API_KEY: "wrong-provider-secret",
          FAKE_ACP_DUMP: dump,
        },
        enabled: true,
        config: { cli: FAKE_CLI, fullAuto: false },
      });
      await instance.snapshot();
      const child = JSON.parse(readFileSync(dump, "utf8")) as { env: Record<string, string> };
      expect(child.env.OPENCODE_API_KEY).toBe("secret-value");
      expect(child.env.OPENAI_API_KEY).toBeUndefined();
      expect(child.env.ANTHROPIC_API_KEY).toBeUndefined();
      await instance.dispose();
    } finally {
      await removeTempDir(scratch);
    }
  });
});

// ---------------------------------------------------------------------------
// OpenCode × Flux Router — the CONFIG-WRITE surface.
//
// OpenCode is the engine that cannot be routed by env at all: it defaults to a
// non-openai provider and will not resolve `flux-auto` out of its own catalog,
// so the route only exists once `provider.flux` is in the user's own
// opencode.json. That makes it `setup`-class, and it makes the gate here
// stateful in a way no other engine's is — the picker must not offer a row
// whose provider is not on disk.
//
// Everything below runs against a temp HOME. The connector's own safety
// properties (backup, drift, rollback, symlinks) are in flux-connector.test.ts;
// these are about the DRIVER: does the gate follow the file, and does the spawn
// rewrite the id without writing anything.
import { existsSync } from "node:fs";
import { afterEach, beforeEach } from "vitest";

import { connectOpenCodeFlux, disconnectOpenCodeFlux, openCodeFluxRouted } from "../../opencode-config.ts";
import { resetOpenCodeModelCache } from "./opencode-go.ts";

const FLUX_KEY = "sk-flux-Dddddddddddddddddddddddddddddddddddddddddd";

describe("OpenCode Flux routing", () => {
  let scratch: string;
  let env: Record<string, string | undefined>;
  let configPath: string;

  const fluxRows = (models: ModelCatalog) => models.options.filter((option) => option.id.startsWith("flux-"));

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "murage-opencode-flux-"));
    env = { HOME: scratch, MURAGE_DATA_DIR: join(scratch, "state") };
    configPath = join(scratch, ".config", "opencode", "opencode.json");
    mkdirSync(dirname(configPath), { recursive: true });
    process.env.FLUX_API_KEY = FLUX_KEY;
    resetOpenCodeModelCache();
  });

  afterEach(async () => {
    delete process.env.FLUX_API_KEY;
    resetOpenCodeModelCache();
    await removeTempDir(scratch);
  });

  async function instanceWith(extra: Record<string, string> = {}) {
    const driver = createOpenCodeDriver(async () => catalog("opencode/x-preview-f-free"));
    return await driver.create({
      instanceId: "opencode-flux",
      displayName: "OpenCode",
      environment: { ...env, ...extra } as Record<string, string>,
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
  }

  it("offers no Flux rows until the connector has actually written the file", async () => {
    expect(openCodeFluxRouted(env)).toBe(false);
    const instance = await instanceWith();
    try {
      expect(fluxRows(instance.models)).toEqual([]);
    } finally {
      await instance.dispose();
    }
  });

  it("POSITIVE CONTROL — offers the four tiers once the connector has run", async () => {
    // Without this the gate test above passes on an implementation that can
    // never offer a Flux row at all.
    expect((await connectOpenCodeFlux({ key: FLUX_KEY, env })).ok).toBe(true);
    expect(openCodeFluxRouted(env)).toBe(true);
    const instance = await instanceWith();
    try {
      expect(fluxRows(instance.models).map((option) => option.id)).toEqual([
        "flux-auto",
        "flux-reasoning",
        "flux-standard",
        "flux-fast",
      ]);
      // OpenCode is a subscription-access engine, so its rows belong in the
      // official pane — the custom flag hermes needs would hide them here.
      expect(fluxRows(instance.models).every((option) => option.custom === undefined)).toBe(true);
    } finally {
      await instance.dispose();
    }
  });

  it("withdraws the rows again when the connector is disconnected", async () => {
    await connectOpenCodeFlux({ key: FLUX_KEY, env });
    await disconnectOpenCodeFlux({ env });
    const instance = await instanceWith();
    try {
      expect(fluxRows(instance.models)).toEqual([]);
    } finally {
      await instance.dispose();
    }
  });

  it("fails closed on a drifted config rather than offering a row that will 4xx", async () => {
    await connectOpenCodeFlux({ key: FLUX_KEY, env });
    const edited = JSON.parse(readFileSync(configPath, "utf8")) as any;
    edited.provider.flux.options.baseURL = "https://my-own-proxy.example/v1";
    writeFileSync(configPath, `${JSON.stringify(edited, null, 2)}\n`);
    expect(openCodeFluxRouted(env)).toBe(false);
    const instance = await instanceWith();
    try {
      expect(fluxRows(instance.models)).toEqual([]);
    } finally {
      await instance.dispose();
    }
  });

  it("rewrites the picker id to OpenCode's provider-qualified slug at spawn", async () => {
    await connectOpenCodeFlux({ key: FLUX_KEY, env });
    // The fake agent rejects an unadvertised model with -32602, and the core
    // refuses a set_config_option that silently keeps the old one, so a turn
    // completing on `flux/flux-auto` IS the proof the rewrite happened.
    const instance = await instanceWith({ FAKE_ACP_MODELS: "flux/flux-auto" });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId: "t-flux", text: "hi", model: "flux-auto" });
      const done = await recorder.until((event) => event.type === "turn.completed");
      expect(done).toMatchObject({ ok: true });
      expect(recorder.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "session.started", model: "flux/flux-auto" }),
      ]));
    } finally {
      recorder.stop();
      await instance.dispose();
    }
  });

  it("writes NOTHING to the user's opencode.json during a Flux turn", async () => {
    await connectOpenCodeFlux({ key: FLUX_KEY, env });
    const before = readFileSync(configPath, "utf8");
    const instance = await instanceWith({ FAKE_ACP_MODELS: "flux/flux-auto" });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId: "t-flux-2", text: "hi", model: "flux-auto" });
      await recorder.until((event) => event.type === "turn.completed");
      // A spawn must never be able to touch a file the user owns. The only
      // writer is the deliberate connector call.
      expect(readFileSync(configPath, "utf8")).toBe(before);
    } finally {
      recorder.stop();
      await instance.dispose();
    }
  });

  it("counts a connected Flux provider as a usable login", async () => {
    // Its key lives inline in opencode.json, not auth.json, so without this
    // the pre-spawn subscription gate would refuse a Flux turn on an install
    // with no other provider.
    const emptyData = join(scratch, "empty-xdg-data");
    mkdirSync(emptyData, { recursive: true });
    const bare = { ...env, XDG_DATA_HOME: emptyData, OPENCODE_API_KEY: "" } as Record<string, string>;

    const before = await createOpenCodeDriver(async () => catalog("opencode/x-preview-f-free")).create({
      instanceId: "opencode-flux-auth-before",
      displayName: "OpenCode",
      environment: bare,
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect((await before.snapshot()).authenticated).toBe(false);
    } finally {
      await before.dispose();
    }

    resetOpenCodeModelCache();
    await connectOpenCodeFlux({ key: FLUX_KEY, env });

    const after = await createOpenCodeDriver(async () => catalog("opencode/x-preview-f-free")).create({
      instanceId: "opencode-flux-auth-after",
      displayName: "OpenCode",
      environment: bare,
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect((await after.snapshot()).authenticated).toBe(true);
    } finally {
      await after.dispose();
    }
  });

  it("leaves the local-inject writer working on the same shared upsert", async () => {
    // The Flux connector and the local-inject writer share one implementation
    // of "how a provider goes into opencode.json"; this pins that the shared
    // path did not regress the inject side, and that the two coexist.
    await connectOpenCodeFlux({ key: FLUX_KEY, env });
    const { ensureOpenCodeInjectModel } = await import("./opencode-go.ts");
    expect(ensureOpenCodeInjectModel("omlx::GLM-5.2-fp8", env)).toBe("omlx/GLM-5.2-fp8");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as any;
    expect(config.provider.omlx.options.baseURL).toBe("http://127.0.0.1:8080/v1");
    expect(config.provider.flux.options.apiKey).toBe(FLUX_KEY);
    expect(openCodeFluxRouted(env)).toBe(true);
    expect(existsSync(configPath)).toBe(true);
  });
});
