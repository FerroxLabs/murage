import { fixtureBotFolder } from "../testing/bot-folder-fixture.ts";
import { useOutsideStoreFixture } from "../testing/outside-store-fixture.ts";
import { chmodSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as procs from "../procs.ts";
import { recordEvents } from "../testing/events.ts";
import { CodexDriver } from "./codex.ts";
import {
  decodeCodexSelection,
  encodeCodexSelection,
  OFFICIAL_CODEX_PROVIDER,
  readCodexModelCatalog,
  STATIC_CODEX_MODELS,
} from "./codex-catalog.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const scratchDirs: string[] = [];
const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-codex-app-server.ts");

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) removeTempDirSync(dir);
});

function scratchHome(files: Record<string, string>): string {
  const home = mkdtempSync(join(tmpdir(), "murage-codex-catalog-"));
  scratchDirs.push(home);
  const root = join(home, ".codex");
  mkdirSync(root, { recursive: true });
  for (const [relative, body] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body);
  }
  return home;
}

describe("decodeCodexSelection", () => {
  it("forces official rows onto the ChatGPT provider", () => {
    expect(decodeCodexSelection("gpt-5.6-sol")).toEqual({
      model: "gpt-5.6-sol",
      modelProvider: OFFICIAL_CODEX_PROVIDER,
    });
  });

  it("forces newly discovered bare ids onto the ChatGPT provider too", () => {
    expect(decodeCodexSelection("gpt-future-codex")).toEqual({
      model: "gpt-future-codex",
      modelProvider: OFFICIAL_CODEX_PROVIDER,
    });
  });

  it("splits provider-encoded custom ids", () => {
    expect(decodeCodexSelection("omlx::Qwen3.6-35B-A3B-bf16:qwen3-5-6-n-r-reasoning")).toEqual({
      model: "Qwen3.6-35B-A3B-bf16:qwen3-5-6-n-r-reasoning",
      modelProvider: "omlx",
    });
  });
});

describe("STATIC_CODEX_MODELS", () => {
  it("names gpt-6.1-sol, the verified Codex CLI model, in the offline fallback", () => {
    expect(STATIC_CODEX_MODELS.options.map(option => option.id)).toContain("gpt-6.1-sol");
    expect(STATIC_CODEX_MODELS.options.map(option => option.id)).toContain("gpt-6-sol");
  });
});

describe("readCodexModelCatalog", () => {
  it("uses the new default for an empty configured choice without writing the config", async () => {
    const config = 'model = ""\n';
    const home = scratchHome({ "config.toml": config });
    expect((await readCodexModelCatalog({ HOME: home })).default).toBe("gpt-6.1-sol");
    expect(readFileSync(join(home, ".codex/config.toml"), "utf8")).toBe(config);
  });

  it.each(["gpt-5.6-sol", "openai::gpt-5.6-sol"])("keeps the configured old default %s without rewriting config", async saved => {
    const qualified = saved.startsWith("openai::");
    const config = `${qualified ? 'model_provider = "openai"\n' : ''}model = "gpt-5.6-sol"\n`;
    const home = scratchHome({ "config.toml": config });
    const catalog = await readCodexModelCatalog({ HOME: home });
    expect(catalog.default).toBe("gpt-5.6-sol");
    expect(readFileSync(join(home, ".codex/config.toml"), "utf8")).toBe(config);
  });

  it.each([false, true])("preserves the configured old choice omitted by a live catalog (qualified=%s)", async qualified => {
    chmodSync(FAKE_CLI, 0o755);
    const config = `${qualified ? 'model_provider = "openai"\n' : ''}model = "gpt-5.6-sol"\n`;
    const home = scratchHome({ "config.toml": config });
    const catalog = await readCodexModelCatalog({ HOME: home, PATH: process.env.PATH }, fetch, FAKE_CLI);
    expect(catalog.default).toBe("gpt-5.6-sol");
    expect(catalog.options).toContainEqual(STATIC_CODEX_MODELS.options.find(row => row.id === "gpt-5.6-sol"));
    expect(readFileSync(join(home, ".codex/config.toml"), "utf8")).toBe(config);
  });

  it.each(["0.144.4", "unknown", "0.162.1"])("gates an initial failed catalog probe for engine %s", async version => {
    const home = scratchHome({});
    const cli = join(home, "codex-fixture");
    writeFileSync(cli, `#!/usr/bin/env node\nif (process.argv[2] === "--version") { console.log("codex-cli ${version}"); } else { process.exit(1); }\n`, { mode: 0o755 });
    const result = readCodexModelCatalog({ HOME: home, PATH: process.env.PATH }, fetch, cli);
    if (version === "0.162.1") expect((await result).default).toBe("gpt-6.1-sol");
    else await expect(result).rejects.toThrow("Update Codex");
    const instance = await CodexDriver.create({ instanceId: "fallback-gate", displayName: "Codex", enabled: true, environment: { HOME: home }, config: { ...CodexDriver.defaultConfig(), cli } });
    try {
      if (version !== "0.162.1") {
        expect(await instance.snapshot()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("Update Codex") });
        const recorder = recordEvents(instance.adapter);
        try {
          await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "blocked", text: "hello" });
          expect(await recorder.until(event => event.type === "turn.completed")).toMatchObject({ ok: false, stopReason: version === "unknown" ? "scope_unavailable" : "update_required" });
        } finally { recorder.stop(); }
      } else expect(instance.models.default).toBe("gpt-6.1-sol");
    } finally { await instance.dispose(); }
  });

  it("requalifies a replaced binary before reusing a previous fallback", async () => {
    const home = scratchHome({});
    const cli = join(home, "codex-replaced");
    const binary = (version: string) => writeFileSync(cli, '#!/usr/bin/env node\nif(process.argv[2] === "--version") console.log("codex-cli ' + version + '"); else process.exit(1);\n', { mode: 0o755 });
    binary("0.162.1");
    const instance = await CodexDriver.create({ instanceId: "replaced", displayName: "Codex", enabled: true, environment: { HOME: home }, config: { ...CodexDriver.defaultConfig(), cli } });
    try {
      expect(instance.models.default).toBe("gpt-6.1-sol");
      binary("0.144.4-old");
      await instance.refreshModels?.();
      expect(await instance.snapshot()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("Update Codex") });
      expect(instance.models.options).toEqual([]);
    } finally { await instance.dispose(); }
  });

  it("qualifies the cloud fallback even though cloud skips model/list", async () => {
    const home = scratchHome({});
    const prior = process.env.MURAGE_CLOUD_ROLE;
    process.env.MURAGE_CLOUD_ROLE = "home";
    let version = "0.144.4";
    // Stand in for the Cloud launcher's signed, botless --version response.
    const probe = vi.spyOn(procs, "execCli").mockImplementation((_cli, _args, _opts, callback) => {
      callback(null, "codex-cli " + version, "");
    });
    try {
      await expect(readCodexModelCatalog({ HOME: home }, fetch, "codex")).rejects.toThrow("Update Codex");
      version = "0.162.1";
      expect((await readCodexModelCatalog({ HOME: home }, fetch, "codex")).default).toBe("gpt-6.1-sol");
      expect(probe.mock.calls.map(call => call[1])).toEqual([["--version"], ["--version"]]);
    } finally {
      probe.mockRestore();
      if (prior === undefined) delete process.env.MURAGE_CLOUD_ROLE;
      else process.env.MURAGE_CLOUD_ROLE = prior;
    }
  });

  it("returns the static cloud fallback when there is no config or CLI probe", async () => {
    expect(await readCodexModelCatalog({ HOME: join(tmpdir(), "murage-codex-missing-home") })).toEqual(
      STATIC_CODEX_MODELS,
    );
  });

  it("retains the last discovered official catalog when a later CLI refresh fails", async () => {
    const home = scratchHome({});
    const previous = { default: "gpt-discovered-later", options: [{ id: "gpt-discovered-later", label: "Discovered later" }] };
    const result = await readCodexModelCatalog({ HOME: home, PATH: process.env.PATH }, fetch, join(home, "missing-codex"), previous);
    expect(result).toEqual(previous);
    expect(result.options.some(option => option.id === "gpt-6-astra")).toBe(false);
  });

  it("uses every visible page from the installed Codex app-server catalog", async () => {
    chmodSync(FAKE_CLI, 0o755);
    const catalog = await readCodexModelCatalog(
      { HOME: join(tmpdir(), "murage-codex-app-server-models"), PATH: process.env.PATH },
      fetch,
      FAKE_CLI,
    );

    expect(catalog).toEqual({
      default: "gpt-fake-default",
      options: [
        { id: "gpt-fake-default", label: "GPT Fake Default" },
        { id: "gpt-page-two", label: "GPT Page Two" },
      ],
    });
  });

  it("appends the configured local model and cached catalog slugs as custom", async () => {
    const home = scratchHome({
      "config.toml": `
model_provider = "omlx"
model = "Qwen3.6-35B-A3B-bf16:qwen3-5-6-n-r-reasoning"

[model_providers.omlx]
name = "oMLX"
base_url = "http://127.0.0.1:9/v1"
`,
      "omlx.config.toml": `
model_provider = "omlx"
model = "GLM-5.2-mxfp4"
`,
      "model-catalogs/omlx-models.json": JSON.stringify({
        models: [{ slug: "GLM-5.2-mxfp4", display_name: "GLM-5.2-mxfp4 (oMLX)" }],
      }),
    });

    const catalog = await readCodexModelCatalog({ HOME: home }, async () => {
      throw new Error("live probe should not be required");
    });

    expect(catalog.default).toBe(encodeCodexSelection("omlx", "Qwen3.6-35B-A3B-bf16:qwen3-5-6-n-r-reasoning"));
    expect(catalog.options.slice(0, STATIC_CODEX_MODELS.options.length)).toEqual(STATIC_CODEX_MODELS.options);
    expect(catalog.options.filter((option) => option.custom).map((option) => option.id)).toEqual([
      encodeCodexSelection("omlx", "Qwen3.6-35B-A3B-bf16:qwen3-5-6-n-r-reasoning"),
      encodeCodexSelection("omlx", "GLM-5.2-mxfp4"),
    ]);
    expect(catalog.options.find((option) => option.id.endsWith("GLM-5.2-mxfp4"))?.label).toBe("GLM-5.2-mxfp4 (oMLX)");
  });

  it("keeps an official-looking model slug bound to its configured local provider", async () => {
    const home = scratchHome({
      "config.toml": `
model_provider = "omlx"
model = "gpt-5.4"

[model_providers.omlx]
name = "oMLX"
`,
    });

    const catalog = await readCodexModelCatalog({ HOME: home });
    const local = encodeCodexSelection("omlx", "gpt-5.4");

    expect(catalog.default).toBe(local);
    expect(catalog.options).toContainEqual({
      id: local,
      label: "gpt-5.4 (oMLX)",
      custom: true,
    });
    expect(decodeCodexSelection(catalog.default)).toEqual({
      model: "gpt-5.4",
      modelProvider: "omlx",
    });
  });

  it("honors CODEX_HOME over HOME and merges live /v1/models", async () => {
    const ignored = scratchHome({
      "config.toml": `model_provider = "omlx"\nmodel = "ignored"\n`,
    });
    const parent = mkdtempSync(join(tmpdir(), "murage-codex-home-"));
    scratchDirs.push(parent);
    const codexHome = join(parent, "codex");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(
      join(codexHome, "config.toml"),
      `
model_provider = "unsloth_api"
model = "unsloth/gemma-4-26B-A4B-it-GGUF"

[model_providers.unsloth_api]
name = "Unsloth Studio"
base_url = "http://127.0.0.1:8888/v1"
env_key = "UNSLOTH_STUDIO_AUTH_TOKEN"
`,
    );

    const catalog = await readCodexModelCatalog(
      { HOME: ignored, CODEX_HOME: codexHome, UNSLOTH_STUDIO_AUTH_TOKEN: "sk-test" },
      async (url, init) => {
        expect(String(url)).toBe("http://127.0.0.1:8888/v1/models");
        expect((init as RequestInit | undefined)?.headers).toMatchObject({ Authorization: "Bearer sk-test" });
        return new Response(JSON.stringify({ data: [{ id: "unsloth/extra-live" }, { id: "bad id" }] }), { status: 200 });
      },
    );

    expect(catalog.options.map((option) => option.id)).toContain(
      encodeCodexSelection("unsloth_api", "unsloth/gemma-4-26B-A4B-it-GGUF"),
    );
    expect(catalog.options.map((option) => option.id)).toContain(encodeCodexSelection("unsloth_api", "unsloth/extra-live"));
    expect(catalog.options.map((option) => option.id)).not.toContain(encodeCodexSelection("omlx", "ignored"));
  });

  it("ignores invalid slugs and a default that is not in the catalog", async () => {
    const home = scratchHome({
      "config.toml": `
model_provider = "nope!"
model = "not installed"

[model_providers.omlx]
name = "oMLX"
`,
    });
    const catalog = await readCodexModelCatalog({ HOME: home });
    expect(catalog.default).toBe("gpt-6.1-sol");
    expect(catalog.options.every((option) => !option.custom)).toBe(true);
  });
});

describe("CodexDriver catalog", () => {
  it("stores an omitted explicit OpenAI choice once and dispatches its bare id", async () => {
    chmodSync(FAKE_CLI, 0o755);
    const model = "gpt-saved-omitted";
    const home = scratchHome({ "config.toml": `model_provider = "openai"\nmodel = "${model}"\n` });
    const dump = join(home, "dispatch.json");
    const instance = await CodexDriver.create({
      instanceId: "saved-openai",
      displayName: "Codex",
      environment: { HOME: home, CODEX_HOME: join(home, ".codex"), FAKE_CODEX_DUMP: dump },
      enabled: true,
      config: { ...CodexDriver.defaultConfig(), cli: FAKE_CLI },
    });
    const recorder = recordEvents(instance.adapter);
    try {
      expect(instance.models.default).toBe(model);
      expect(instance.models.options.filter(row => decodeCodexSelection(row.id).model === model)).toEqual([
        { id: model, label: model },
      ]);
      expect(instance.models.options.some(row => row.id === `openai::${model}`)).toBe(false);
      const sent = await instance.adapter.sendTurn({ threadId: "saved-openai", text: "hello", cwd: home, model: instance.models.default });
      await recorder.until(event => event.type === "turn.completed" && event.turnId === sent.turnId);
      const { calls } = JSON.parse(readFileSync(dump, "utf8"));
      expect(calls.find((call: { method: string }) => call.method === "thread/start").params.model).toBe(model);
    } finally {
      recorder.stop();
      await instance.dispose();
    }
  });

  it("loads the config catalog when the instance is created", async () => {
    chmodSync(FAKE_CLI, 0o755);
    const home = scratchHome({
      "config.toml": `
model_provider = "omlx"
model = "MiniMax-M3-4bit"

[model_providers.omlx]
name = "oMLX"
`,
    });
    const instance = await CodexDriver.create({
      instanceId: "codex-catalog",
      displayName: "Codex",
      environment: { HOME: home, CODEX_HOME: join(home, ".codex") },
      enabled: true,
      config: { ...CodexDriver.defaultConfig(), cli: FAKE_CLI },
    });
    try {
      expect(instance.models.options.some((option) => option.id === "omlx::MiniMax-M3-4bit" && option.custom)).toBe(true);
      expect(instance.refreshModels).toEqual(expect.any(Function));
    } finally {
      await instance.dispose();
    }
  });
});

// Adapter turns in this suite use an isolated durable store.
useOutsideStoreFixture();
