import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ClaudeDriver, readClaudeModelCatalog, STATIC_CLAUDE_MODELS } from "./claude.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) removeTempDirSync(dir);
});

describe("readClaudeModelCatalog", () => {
  it("returns the official models when settings are missing", () => {
    expect(readClaudeModelCatalog({ HOME: join(tmpdir(), "murage-claude-missing-home") })).toEqual(STATIC_CLAUDE_MODELS);
    expect(STATIC_CLAUDE_MODELS.options.slice(0, 2)).toEqual([
      { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
      { id: "claude-fable-5", label: "Claude Fable 5" },
    ]);
  });

  it("gives Opus 5.5 its 1M context window and leaves the default alone", () => {
    const ids = STATIC_CLAUDE_MODELS.options.map((option) => option.id);
    expect(STATIC_CLAUDE_MODELS.options[ids.indexOf("claude-opus-5-5")]).toEqual({
      id: "claude-opus-5-5",
      label: "Claude Opus 5.5",
      contextWindow: 1_000_000,
    });
    expect(STATIC_CLAUDE_MODELS.options[ids.indexOf("claude-opus-5")]).toEqual({ id: "claude-opus-5", label: "Claude Opus 5" });
    // Sonnet 5.5 (upstream #2025): the id the Claude CLI 2.1.287 carries as its
    // first-party id, with the 1M window it reports as native.
    expect(STATIC_CLAUDE_MODELS.options[ids.indexOf("claude-sonnet-5-5")]).toEqual({
      id: "claude-sonnet-5-5",
      label: "Claude Sonnet 5.5",
      contextWindow: 1_000_000,
    });
    expect(ids.indexOf("claude-sonnet-5-5")).toBe(ids.indexOf("claude-sonnet-5") - 1);
    // Haiku 5.5 (2026-10-07): the API id, with its 1M window, just above Haiku 4.5.
    expect(STATIC_CLAUDE_MODELS.options[ids.indexOf("claude-haiku-5-5")]).toEqual({
      id: "claude-haiku-5-5",
      label: "Claude Haiku 5.5",
      contextWindow: 1_000_000,
    });
    expect(ids.indexOf("claude-haiku-5-5")).toBe(ids.indexOf("claude-haiku-4-5") - 1);
    expect(STATIC_CLAUDE_MODELS.default).toBe("claude-sonnet-5");
  });

  it("tags extra settings models as custom and leaves official rows untagged", () => {
    const home = mkdtempSync(join(tmpdir(), "murage-claude-catalog-"));
    scratchDirs.push(home);
    const dir = join(home, ".claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({
        model: "claude-sonnet-5",
        availableModels: [{ id: "my-local-opus", name: "Local Opus" }],
        env: { ANTHROPIC_MODEL: "hosted-qwen" },
      }),
    );

    expect(readClaudeModelCatalog({ HOME: home })).toEqual({
      default: "claude-sonnet-5",
      options: [
        ...STATIC_CLAUDE_MODELS.options,
        { id: "my-local-opus", label: "Local Opus", custom: true },
        { id: "hosted-qwen", label: "hosted-qwen", custom: true },
      ],
    });
  });

  it("lists a newer Anthropic model from extraModels with the official rows, not as custom", () => {
    const home = mkdtempSync(join(tmpdir(), "murage-claude-catalog-"));
    scratchDirs.push(home);
    const dir = join(home, ".claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ extraModels: [{ id: "claude-fixture-9-1", label: "Claude Fixture 9.1" }, "omlx::local-qwen"] }),
    );

    expect(readClaudeModelCatalog({ HOME: home }).options.slice(STATIC_CLAUDE_MODELS.options.length)).toEqual([
      { id: "claude-fixture-9-1", label: "Claude Fixture 9.1" },
      { id: "omlx::local-qwen", label: "omlx::local-qwen", custom: true },
    ]);
  });

  it("does not list settings.model as a Custom leftover", () => {
    const home = mkdtempSync(join(tmpdir(), "murage-claude-leftover-"));
    scratchDirs.push(home);
    const dir = join(home, ".claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ model: "orcarouter/Qwen3.8-27B-Uncensored-GGUF" }),
    );

    expect(readClaudeModelCatalog({ HOME: home })).toEqual(STATIC_CLAUDE_MODELS);
  });
});

describe("readClaudeModelCatalog: the owner's own Claude Code models", () => {
  const catalogWithEnv = (env: Record<string, unknown>, processEnv: Record<string, string | undefined> = {}) => {
    const home = mkdtempSync(join(tmpdir(), "murage-claude-extras-"));
    scratchDirs.push(home);
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ env }));
    return readClaudeModelCatalog({ HOME: home, ...processEnv }).options.slice(STATIC_CLAUDE_MODELS.options.length);
  };

  it("lists the custom model option, labelled by its name when there is one", () => {
    expect(catalogWithEnv({ ANTHROPIC_CUSTOM_MODEL_OPTION: "gateway/glm-5", ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: "Gateway GLM" })).toEqual([
      { id: "gateway/glm-5", label: "Gateway GLM", custom: true },
    ]);
    expect(catalogWithEnv({ ANTHROPIC_CUSTOM_MODEL_OPTION: "gateway/glm-5" })).toEqual([
      { id: "gateway/glm-5", label: "gateway/glm-5", custom: true },
    ]);
  });

  it("lists a non-official tier model by tier, and not an official claude-* id again", () => {
    expect(catalogWithEnv({
      ANTHROPIC_DEFAULT_SONNET_MODEL: "bedrock:sonnet-gw",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-5-5",
    })).toEqual([{ id: "bedrock:sonnet-gw", label: "Sonnet tier: bedrock:sonnet-gw", custom: true }]);
  });

  it("drops ids with characters a model id never has", () => {
    expect(catalogWithEnv({ ANTHROPIC_CUSTOM_MODEL_OPTION: "bad id; rm -rf", ANTHROPIC_DEFAULT_HAIKU_MODEL: "x y" })).toEqual([]);
  });

  it("does not offer a value only a shell left behind, and never copies a key", () => {
    expect(catalogWithEnv({}, { ANTHROPIC_CUSTOM_MODEL_OPTION: "leftover", ANTHROPIC_DEFAULT_SONNET_MODEL: "leftover-2" })).toEqual([]);
    expect(JSON.stringify(catalogWithEnv({ ANTHROPIC_API_KEY: "sk-secret", ANTHROPIC_CUSTOM_MODEL_OPTION: "m1" }))).not.toContain("sk-secret");
  });
});

describe("ClaudeDriver catalog", () => {
  it("loads extras when the instance is created", async () => {
    const home = mkdtempSync(join(tmpdir(), "murage-claude-instance-"));
    scratchDirs.push(home);
    const dir = join(home, ".claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ customModels: ["local-glm"] }));
    const instance = await ClaudeDriver.create({
      instanceId: "claude-catalog",
      displayName: "Claude",
      environment: { HOME: home },
      enabled: true,
      config: ClaudeDriver.defaultConfig(),
    });
    try {
      expect(instance.models.options.some((option) => option.id === "local-glm" && option.custom)).toBe(true);
      expect(instance.refreshModels).toEqual(expect.any(Function));
    } finally {
      await instance.dispose();
    }
  });

  it("does not offer a picker row for an ambient ANTHROPIC_MODEL", async () => {
    // readClaudeModelCatalog folds env.ANTHROPIC_MODEL into the extras. When
    // that value is a leftover from a provider switcher in the user's shell,
    // the row is a phantom: the spawned CLI is never pointed at it, because
    // the same switch is stripped from the child env before spawn.
    const home = mkdtempSync(join(tmpdir(), "murage-claude-ambient-"));
    scratchDirs.push(home);
    const dir = join(home, ".claude");
    mkdirSync(dir, { recursive: true });
    // a settings.json must exist: readClaudeModelCatalog returns the static
    // four without ever reaching the env fallback when it cannot be read
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ model: "claude-sonnet-5" }));
    const saved = process.env.ANTHROPIC_MODEL;
    process.env.ANTHROPIC_MODEL = "leftover-switcher-model";
    let instance;
    try {
      instance = await ClaudeDriver.create({
        instanceId: "claude-ambient-catalog",
        displayName: "Claude",
        environment: { HOME: home },
        enabled: true,
        config: ClaudeDriver.defaultConfig(),
      });
      expect(instance.models.options.some((option) => option.id === "leftover-switcher-model")).toBe(false);
      expect(instance.models).toEqual(STATIC_CLAUDE_MODELS);
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_MODEL;
      else process.env.ANTHROPIC_MODEL = saved;
      await instance?.dispose();
    }
  });
});
