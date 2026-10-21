// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.3 gate (muragegate, 2026-10-21): the Engines panel probed `codex` on Murage's PATH (0.163.0, whose catalog
// names gpt-6.1-sol as the default) while the app-server was spawned with the owner's captured shell PATH, which
// found an older Codex first (/opt/homebrew/bin/codex, 0.144.4). ChatGPT refuses the new models to that build:
// "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account." The binary whose version
// Murage checked (scoped home, hook gate, policy spelling) and whose catalog it shows is the one that must run.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { invalidateCliVersions } from "../cli-version-cache.ts";
import { resetPathCacheForTests } from "../env-path.ts";
import { CodexDriver } from "./codex.ts";

const state = vi.hoisted(() => ({ shellDir: "" }));

// The owner's captured shell PATH names ANOTHER codex ahead of the one Murage's own PATH finds.
vi.mock("../env-path.ts", async (original) => {
  const real = await original<typeof import("../env-path.ts")>();
  return {
    ...real,
    captureOwnerEnv: vi.fn(async () => {
      const env: Record<string, string> = {};
      for (const [name, value] of Object.entries(process.env)) if (typeof value === "string") env[name] = value;
      return { env: { ...env, PATH: [state.shellDir, real.augmentedPath()].join(delimiter) }, capture: "session" as const };
    }),
  };
});

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_CODEX = join(HERE, "..", "testing", "fake-codex-app-server.ts");

let instance: ProviderInstance | undefined;
let recorder: EventRecorder | undefined;
let scratch: string;
let extraPath: string | undefined;

/** A `codex` on its own folder that logs each subcommand it was started with, then runs the fake. */
function wrapper(dir: string, log: string): void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "codex");
  writeFileSync(file, `#!/bin/sh\necho "$1" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(FAKE_CODEX)} "$@"\n`);
  chmodSync(file, 0o755);
}

beforeEach(() => {
  ensureDirs();
  chmodSync(FAKE_CODEX, 0o755);
  scratch = mkdtempSync(join(tmpdir(), "murage-codex-launch-"));
  extraPath = process.env.MURAGE_EXTRA_PATH;
});

afterEach(async () => {
  recorder?.stop();
  await instance?.dispose();
  instance = undefined;
  if (extraPath === undefined) delete process.env.MURAGE_EXTRA_PATH; else process.env.MURAGE_EXTRA_PATH = extraPath;
  resetPathCacheForTests();
  invalidateCliVersions();
  await removeTempDir(scratch);
});

describe.skipIf(process.platform === "win32")("the Codex app-server binary", () => {
  it("is the codex Murage probed, not the first one on the owner's shell PATH", async () => {
    const probedLog = join(scratch, "probed.log");
    const shellLog = join(scratch, "shell.log");
    wrapper(join(scratch, "probed"), probedLog);
    wrapper(join(scratch, "shell"), shellLog);
    state.shellDir = join(scratch, "shell");
    process.env.MURAGE_EXTRA_PATH = join(scratch, "probed");
    resetPathCacheForTests();
    invalidateCliVersions();

    instance = await CodexDriver.create({ instanceId: "codex-launch", displayName: "Codex", environment: {}, enabled: true, config: { cli: "codex", fullAuto: false } });
    recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "t-codex-launch", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const probed = readFileSync(probedLog, "utf8").split("\n");
    expect(probed).toContain("--version");
    expect(probed).toContain("app-server");
    expect(existsSync(shellLog) ? readFileSync(shellLog, "utf8") : "").not.toContain("app-server");
  });
});
