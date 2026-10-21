// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.3 gate (Fable's audit after the Codex fix, 2026-10-21): pi probed its CLI's `--version` on Murage's own PATH but
// spawned the turn with the owner's captured shell PATH (the handed map), which can find another, older build first. The
// binary whose version Murage gated on (piIsolationArgs) is the one that must run (isolation-cache.ts engineLaunchFile).
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
import { augmentedPath, resetPathCacheForTests } from "../env-path.ts";
import { cliFile } from "./isolation-cache.ts";
import { PiDriver } from "./pi.ts";

const state = vi.hoisted(() => ({ shellDir: "" }));

// The owner's captured shell PATH names ANOTHER pi ahead of the one Murage's own PATH finds.
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

const BIN = "pi";
const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE = join(HERE, "..", "testing", "fake-pi-cli.ts");

let instance: ProviderInstance | undefined;
let recorder: EventRecorder | undefined;
let scratch: string;
let extraPath: string | undefined;

/** A `pi` on its own folder that logs the arguments of each start, then runs the fake. */
function wrapper(dir: string, log: string): void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "pi");
  writeFileSync(file, `#!/bin/sh\necho "$*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(FAKE)} "$@"\n`);
  chmodSync(file, 0o755);
}
const lines = (path: string): string[] => existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];

beforeEach(() => {
  ensureDirs();
  chmodSync(FAKE, 0o755);
  scratch = mkdtempSync(join(tmpdir(), "murage-pi-launch-"));
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

/** Two `pi`s: the one on Murage's PATH (MURAGE_EXTRA_PATH) and another first on the owner's shell PATH. */
function twoBinaries(): { probedLog: string; shellLog: string } {
  const probedLog = join(scratch, "probed.log");
  const shellLog = join(scratch, "shell.log");
  wrapper(join(scratch, "probed"), probedLog);
  wrapper(join(scratch, "shell"), shellLog);
  state.shellDir = join(scratch, "shell");
  process.env.MURAGE_EXTRA_PATH = join(scratch, "probed");
  resetPathCacheForTests();
  invalidateCliVersions();
  return { probedLog, shellLog };
}

describe.skipIf(process.platform === "win32")("the pi turn binary", () => {
  it("is the pi Murage probed, not the first one on the owner's shell PATH", async () => {
    const { probedLog, shellLog } = twoBinaries();
    instance = await PiDriver.create({ instanceId: "pi-launch", displayName: "pi", environment: {}, enabled: true, config: { cli: "pi", fullAuto: false } });
    recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "t-pi-launch", text: "hi", model: "ollama-cloud/glm-5.2" });
    await recorder.until((e) => e.type === "turn.completed");

    const probed = lines(probedLog);
    expect(probed).toContain("--version");
    expect(probed.some((line) => line.startsWith("--mode rpc --no-session ") )).toBe(true);
    expect(lines(shellLog)).toEqual([]);
  });

  it("refuses the turn when Murage's PATH has no pi, never running the shell PATH's", async (ctx) => {
    const shellLog = join(scratch, "shell.log");
    wrapper(join(scratch, "shell"), shellLog);
    state.shellDir = join(scratch, "shell");
    delete process.env.MURAGE_EXTRA_PATH;
    resetPathCacheForTests();
    invalidateCliVersions();
    // A machine with a real one on Murage's own PATH would run it: nothing to prove there.
    if (cliFile(BIN, { PATH: augmentedPath() })) ctx.skip();
    instance = await PiDriver.create({ instanceId: "pi-launch", displayName: "pi", environment: {}, enabled: true, config: { cli: "pi", fullAuto: false } });
    recorder = recordEvents(instance.adapter);
    const outcome = await instance.adapter.sendTurn({ threadId: "t-pi-missing", text: "hi", model: "ollama-cloud/glm-5.2" }).then(
      () => recorder!.until((e) => e.type === "turn.completed").then((e) => JSON.stringify(e)),
      (error: unknown) => String(error instanceof Error ? `${(error as NodeJS.ErrnoException).code} ${error.message}` : error),
    );
    // The version gate refuses first (no --version answered on Murage's PATH); engineLaunchFile's ENOENT stands behind it.
    expect(outcome).toMatch(/has no readable version|ENOENT|not installed|not found|cannot find/i);
    expect(lines(shellLog)).toEqual([]);
  });
});
