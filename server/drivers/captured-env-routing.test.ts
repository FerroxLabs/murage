// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Astra 1.0.3 pre-audit (B): a Finder launch gives Murage no shell exports, so
// the strips each driver applies to process.env never see a provider
// switcher's ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN (or OPENAI_BASE_URL).
// The owner's CAPTURED shell map does hold them, and it is the base the engine
// is handed. Those names belong to the turn's settings: the captured copy is
// dropped, and the turn's own routing still lands. Every value here is fake.
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { fixtureCredentialFingerprint } from "../testing/fixture-dump.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { invalidateCliVersions } from "../cli-version-cache.ts";
import { ClaudeDriver } from "./claude.ts";
import { resetClaudeVersionGate } from "./claude-guards.ts";
import { CodexDriver } from "./codex.ts";

vi.mock("node:child_process", async (original) => (await import("../testing/exec-check-spy.ts")).withExecCheckSpy(await original()));

const SHELL_ONLY = {
  ANTHROPIC_BASE_URL: "https://shell-provider.invalid",
  ANTHROPIC_AUTH_TOKEN: "fake-shell-token-0001-not-real",
  ANTHROPIC_MODEL: "shell-model",
  ANTHROPIC_API_KEY: "fake-shell-key-0002-not-real",
  OPENAI_BASE_URL: "https://shell-provider.invalid/v1",
  OPENAI_API_KEY: "fake-shell-key-0003-not-real",
} as const;

// The capture as a Finder-launched Murage gets it: the shell's exports, which this process never had.
vi.mock("../env-path.ts", async (original) => {
  const real = await original<typeof import("../env-path.ts")>();
  return {
    ...real,
    captureOwnerEnv: vi.fn(async () => {
      const env: Record<string, string> = {};
      for (const [name, value] of Object.entries(process.env)) if (typeof value === "string") env[name] = value;
      return { env: { ...env, ...SHELL_ONLY, PATH: real.augmentedPath() }, capture: "session" as const };
    }),
  };
});

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(HERE, "..", "testing", "fake-claude-cli.ts");
const FAKE_CODEX = join(HERE, "..", "testing", "fake-codex-app-server.ts");

let instance: ProviderInstance | undefined;
let recorder: EventRecorder | undefined;
let scratch: string;

beforeEach(() => {
  ensureDirs();
  chmodSync(FAKE_CLAUDE, 0o755);
  chmodSync(FAKE_CODEX, 0o755);
  scratch = mkdtempSync(join(tmpdir(), "murage-captured-env-"));
  for (const name of Object.keys(SHELL_ONLY)) expect(process.env[name]).toBeUndefined();
});

afterEach(async () => {
  delete process.env.FAKE_CLAUDE_DUMP;
  delete process.env.FAKE_CODEX_DUMP;
  resetClaudeVersionGate();
  invalidateCliVersions();
  recorder?.stop();
  await instance?.dispose();
  instance = undefined;
  await removeTempDir(scratch);
});

const claude = async (environment: Record<string, string> = {}) => {
  instance = await ClaudeDriver.create({ instanceId: "claude-captured", displayName: "Claude", environment, enabled: true, config: { cli: FAKE_CLAUDE, permissionMode: "acceptEdits" } });
  recorder = recordEvents(instance.adapter);
};

describe("the captured shell map on a Claude turn", () => {
  it("does not route a subscription turn to the shell's provider", async () => {
    await claude();
    const dump = join(scratch, "claude.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    await instance!.adapter.sendTurn({ threadId: "t-captured-sub", text: "hi" });
    await recorder!.until((e) => e.type === "turn.completed");
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    for (const name of Object.keys(SHELL_ONLY)) expect(seen.env[name], name).toBeUndefined();
  });

  it("keeps the turn's own routing over the shell's", async () => {
    await claude({ UNSLOTH_STUDIO_AUTH_TOKEN: "fake-unsloth-0004-not-real" });
    const dump = join(scratch, "claude-inject.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    await instance!.adapter.sendTurn({ threadId: "t-captured-inject", text: "hi", model: "unsloth::local-model" });
    await recorder!.until((e) => e.type === "turn.completed");
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8888");
    expect(seen.env.ANTHROPIC_AUTH_TOKEN).toBe(fixtureCredentialFingerprint("fake-unsloth-0004-not-real"));
    expect(seen.env.ANTHROPIC_MODEL).toBe("local-model");
  });
});

describe("the captured shell map on a Codex turn", () => {
  it("does not point the CLI's own login at the shell's provider", async () => {
    const dump = join(scratch, "codex.json");
    process.env.FAKE_CODEX_DUMP = dump;
    instance = await CodexDriver.create({ instanceId: "codex-captured", displayName: "Codex", environment: {}, enabled: true, config: { cli: FAKE_CODEX, fullAuto: false } });
    recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "t-captured-codex", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    for (const name of Object.keys(SHELL_ONLY)) expect(seen.env[name], name).toBeUndefined();
  });
});
