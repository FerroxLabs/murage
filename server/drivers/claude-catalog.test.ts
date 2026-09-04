import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ClaudeDriver, readClaudeModelCatalog, STATIC_CLAUDE_MODELS } from "./claude.ts";

const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("readClaudeModelCatalog", () => {
  it("returns the official models when settings are missing", () => {
    expect(readClaudeModelCatalog({ HOME: join(tmpdir(), "murage-claude-missing-home") })).toEqual(STATIC_CLAUDE_MODELS);
    expect(STATIC_CLAUDE_MODELS.options.slice(0, 2)).toEqual([
      { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
      { id: "claude-fable-5", label: "Claude Fable 5" },
    ]);
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
