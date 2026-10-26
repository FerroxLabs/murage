// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.5 (Grok fuigo-windows-start r1 Medium): a driver that chose and version-checked an exact engine file
// (AcpSupport.launchExecutable; Fuigo on Windows: the fuigo.exe resolveFuigoCli checked) has THAT file launched and
// probed, never the configured bare name looked up again. Here the configured cli is a name found nowhere, and the hook
// names the fake ACP CLI: the snapshot's `--version` probe and the turn's spawn must both run the hook's file.
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { invalidateCliVersions } from "../../cli-version-cache.ts";
import { ensureDirs } from "../../config.ts";
import type { ProviderInstance, RuntimeEvent } from "../../contracts.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(HERE, "..", "..", "testing", "fake-acp-cli.ts");
const MISSING = "murage-launch-executable-not-on-any-path";

describe.skipIf(process.platform === "win32")("an ACP driver's checked engine file is the one launched (launchExecutable)", () => {
  let scratch: string;
  let wrapper: string;
  let startLog: string;
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;
  const hookCalls: string[] = [];

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "murage-acp-launch-exe-"));
    startLog = join(scratch, "starts.log");
    // the checked file: logs each start's argv, then runs the fake ACP CLI
    wrapper = join(scratch, "checked-engine");
    writeFileSync(wrapper, `#!/bin/sh\necho "$*" >> ${JSON.stringify(startLog)}\nexec ${JSON.stringify(FAKE_CLI)} "$@"\n`);
    chmodSync(wrapper, 0o755);
    hookCalls.length = 0;
    invalidateCliVersions();
  });
  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
    instance = undefined;
    invalidateCliVersions();
    await removeTempDir(scratch);
  });

  const support = (): AcpSupport => ({
    driverKind: "launchExecutableTest",
    displayName: "Launch Executable Test",
    models: { default: "m-one", options: [{ id: "m-one", label: "One" }] },
    defaultCli: MISSING,
    nativeSource: "launchexe.acp",
    loginNote: "never reached",
    spawnArgs: () => ["agent", "stdio"],
    pickAuthMethod: (methods) => methods[0]?.id ?? null,
    authFailure: "continue",
    isAuthenticated: () => true,
    launchExecutable: (_env, config) => {
      hookCalls.push(config.cli);
      return wrapper;
    },
  });
  const starts = () => (existsSync(startLog) ? readFileSync(startLog, "utf8").split("\n").filter(Boolean) : []);

  it("the version probe and the turn both run the file the driver named, not the configured name", async () => {
    instance = await createAcpDriver(support()).create({ instanceId: "launch-exe", displayName: "Launch", environment: {}, enabled: true, config: { cli: MISSING, fullAuto: false } });
    recorder = recordEvents(instance.adapter);
    const snapshot = await instance.snapshot();
    expect(snapshot).toMatchObject({ state: "available" });
    expect(starts()).toContain("--version");

    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-launch-exe", text: "hello" });
    const done = (await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId)) as Extract<RuntimeEvent, { type: "turn.completed" }>;
    expect(done).toMatchObject({ ok: true });
    expect(starts()).toContain("agent stdio");
    expect(hookCalls.every((cli) => cli === MISSING)).toBe(true);
    expect(hookCalls.length).toBeGreaterThan(0);
  });

  it("without the hook the configured name is what runs (a name found nowhere is the spawn's own failure)", async () => {
    const plain: AcpSupport = { ...support() };
    delete plain.launchExecutable;
    instance = await createAcpDriver({ ...plain, driverKind: "launchExecutablePlainTest" }).create({ instanceId: "launch-plain", displayName: "Plain", environment: {}, enabled: true, config: { cli: MISSING, fullAuto: false } });
    expect(await instance.snapshot()).toMatchObject({ state: "unavailable" });
    expect(starts()).toEqual([]);
  });
});
