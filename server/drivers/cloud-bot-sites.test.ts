// SPDX-License-Identifier: AGPL-3.0-or-later
//
// On a Cloud home the launcher refuses any engine run that names no bot, except the CLI probes
// (`--version`, `auth status --json`, `login status`). These tests pin the one-shot spawn sites
// (Claude's review/proposal/text helper, PIP's text-only turns, the browser checker's review) to
// the bot each call is made for. spawnCli is replaced: nothing is launched.
import { readFileSync } from "node:fs";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawned = vi.hoisted(() => [] as Array<{ cli: string; args: string[]; env: Record<string, string | undefined> }>);
vi.mock("../procs.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../procs.ts")>();
  return {
    ...actual,
    spawnCli: (cli: string, args: string[], opts: { env?: Record<string, string | undefined> }) => {
      spawned.push({ cli, args, env: { ...(opts.env ?? {}) } });
      throw Object.assign(new Error("spawn fixture: nothing is launched"), { code: "ENOENT" });
    },
  };
});

import type { ProviderInstance } from "../contracts.ts";
import { ABSENT_PINS, valuePins } from "../../shared/arg-vocabulary.ts";
import { TURN_BOT, TURN_MARKER } from "../cloud-home/turn-process.ts";
import { ClaudeDriver } from "./claude.ts";
import { claudeTextOnlyTurn } from "./headless-text-only.ts";
import { readCodexAppServerModelCatalog } from "./codex-catalog.ts";
import { resolveCheckerConnection } from "../browser-action-checker-connection.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { resetPathCacheForTests } from "../env-path.ts";

let base: string;
beforeEach(() => { spawned.length = 0; base = mkdtempSync(join(tmpdir(), "cloud-bot-sites-")); });
afterEach(() => { vi.unstubAllEnvs(); removeTempDirSync(base); });

describe("one-shot Cloud spawns name their bot", () => {
  it("Claude's review, proposal and text helper carry the bot they are called for", async () => {
    const instance = await ClaudeDriver.create({ instanceId: "claude-sites", displayName: "Claude", environment: {}, enabled: true, config: ClaudeDriver.decodeConfig({ cli: "claude-fixture" }) });
    const before = spawned.length; // anything create itself ran
    try {
      vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
      await expect(instance.reviewPermission!("review", undefined, "bot-atlas")).rejects.toThrow();
      await expect(instance.proposeProject!("propose", new AbortController().signal, "claude-haiku-4-5", "bot-chief")).rejects.toThrow();
      await expect(instance.generateText!("title", "bot-scribe")).rejects.toThrow();
      expect(spawned.slice(before).map((s) => s.env[TURN_BOT])).toEqual(["bot-atlas", "bot-chief", "bot-scribe"]);
      // The review grammar the launcher accepts, unchanged.
      expect(spawned[before].args).toEqual(expect.arrayContaining(["-p", "--tools", "", "--strict-mcp-config", "--no-session-persistence"]));
    } finally {
      vi.unstubAllEnvs();
      await instance.dispose();
    }
  });

  it("Claude's review spawn carries the handed Rule 74 pins, on a Cloud home and off it", async () => {
    // off Cloud the review launches the claude-fixture found on Murage's own PATH (isolation-cache.ts engineLaunchFile)
    const bin = join(base, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "claude-fixture"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    vi.stubEnv("MURAGE_EXTRA_PATH", bin);
    resetPathCacheForTests();
    const instance = await ClaudeDriver.create({ instanceId: "claude-pins", displayName: "Claude", environment: {}, enabled: true, config: ClaudeDriver.decodeConfig({ cli: "claude-fixture" }) });
    try {
      // off Cloud: the owner map with the pins on top
      let before = spawned.length;
      await expect(instance.generateText!("title", "bot-scribe")).rejects.toThrow();
      const plain = spawned.slice(before).filter((s) => s.args.includes("-p"));
      expect(plain).toHaveLength(1);
      if (process.platform !== "win32") expect(plain[0].cli).toBe(join(bin, "claude-fixture"));
      for (const [name, value] of valuePins(process.platform)) expect(plain[0].env[name], name).toBe(value);
      for (const name of ABSENT_PINS) expect(plain[0].env, name).not.toHaveProperty(name);
      // on a Cloud home: the pins ride on top of the cloudTurnEnvironment map, whose turn markers stay
      vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
      before = spawned.length;
      await expect(instance.reviewPermission!("review", undefined, "bot-atlas")).rejects.toThrow();
      const cloud = spawned.slice(before).filter((s) => s.args.includes("-p"));
      expect(cloud).toHaveLength(1);
      expect(cloud[0].env[TURN_BOT]).toBe("bot-atlas");
      expect(cloud[0].env[TURN_MARKER]).toBe("claudeAgent");
      // the pins are the host platform's (this fixture runs the Cloud spawn on every runner): PSQLRC is NUL on Windows, /dev/null elsewhere
      for (const [name, value] of valuePins(process.platform === "win32" ? "win32" : "linux")) if (name !== "GIT_SSH_COMMAND" && name !== "RSYNC_RSH") expect(cloud[0].env[name], name).toBe(value);
      for (const name of ABSENT_PINS) expect(cloud[0].env, name).not.toHaveProperty(name);
    } finally {
      vi.unstubAllEnvs();
      resetPathCacheForTests();
      await instance.dispose();
    }
  });

  it("a PIP text-only turn carries the bot of its run context", async () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    const input = {
      system: "SYS", text: "USER", model: "model-1", signal: new AbortController().signal, maxOutputTokens: 2000, maxOutputBytes: 12 * 1024,
      outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } }, additionalProperties: false },
      context: { botId: "bot-atlas", runId: "run1", family: "lived", attempt: 1 },
    } as Parameters<typeof claudeTextOnlyTurn>[0];
    await expect(claudeTextOnlyTurn(input, {
      cli: "claude-fixture", tmpBase: join(base, "tmp"), env: { PATH: "/usr/bin:/bin" },
      preflight: { etcRoot: join(base, "etc"), home: join(base, "home"), platform: "linux", mdmDir: null, claudeManagedPath: join(base, "no-managed.json") },
    })).rejects.toThrow();
    expect(spawned).toHaveLength(1);
    expect(spawned[0].env[TURN_BOT]).toBe("bot-atlas");
  });

  it("the browser checker's review on the bot's own engine runs for that bot", async () => {
    const reviewPermission = vi.fn(async (_prompt: string, _signal?: AbortSignal, _botId?: string) => "ALLOW");
    const instance = { instanceId: "engine-1", driverKind: "claudeAgent", displayName: "Claude", enabled: true, reviewPermission } as unknown as ProviderInstance;
    const connection = resolveCheckerConnection({ switch: "bot", instances: [instance], botInstanceId: "engine-1", botId: "bot-atlas" })!;
    await connection.transport({ model: "m", system: "s", user: "u", maxTokens: 8, signal: new AbortController().signal });
    expect(reviewPermission).toHaveBeenCalledWith("s\n\nu", expect.anything(), "bot-atlas");
  });

  it("the Codex catalog read runs no engine on a home (it would name no bot); the fallback list is kept", async () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    await expect(readCodexAppServerModelCatalog("codex", { HOME: "/data/engine-homes/codex" })).resolves.toBeNull();
    expect(spawned).toEqual([]);
  });

  it("callers pass the bot: the approval review names its asker, the project proposal its Chief, the checker its bot", () => {
    const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
    const index = source("../index.ts");
    expect(index).toContain("requestReview((prompt, signal) => review(prompt, signal, args.asker.id)");
    expect(index).toContain("instance!.proposeProject!(prompt,signal,chief.modelSelection.model,chief.id)");
    expect(source("../browser-extension-integration.ts")).toContain("...(bot?.id ? { botId: bot.id } : {})");
    // Antigravity has no launcher grammar on a home, but its one-shot helper names the bot like every other site.
    // 1.0.3 runs it through the one-shot queue (oneShots), which hands the bot on to generateTextNow.
    expect(source("./antigravity.ts")).toMatch(/const generateText = \(prompt: string, botId\?: string\)[^\n]*generateTextNow\(prompt, signal, botId\)[\s\S]*const generateTextNow = async \(prompt: string, signal: AbortSignal, botId\?: string\)[\s\S]*cloudTurnBot\(callEnv, botId\)/);
  });
});
