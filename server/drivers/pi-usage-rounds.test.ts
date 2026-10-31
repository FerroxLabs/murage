// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Adapted from OpenMausBot 97d7c6df3: a Pi turn that ran a tool reports the tokens of every model round, not only
// the last one. The fake's tooluse turn is a 5/1 tool round, then a 12/2 reply round.
import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { PiDriver } from "./pi.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-pi-cli.ts");
let instance: ProviderInstance | undefined;
let recorder: EventRecorder | undefined;
afterEach(async () => {
  recorder?.stop();
  await instance?.dispose();
  instance = undefined;
});

const turnUsage = async (mode?: string) => {
  ensureDirs();
  chmodSync(FAKE_CLI, 0o755);
  instance = await PiDriver.create({ instanceId: "pi-usage", displayName: "pi Test", environment: mode ? { FAKE_PI_MODE: mode } : {}, enabled: true, config: { cli: FAKE_CLI, fullAuto: false } });
  recorder = recordEvents(instance.adapter);
  await instance.adapter.sendTurn({ threadId: `t-usage-${mode ?? "plain"}`, text: "run it" });
  const done = await recorder.until((event) => event.type === "turn.completed");
  return { done, usage: (done as { usage?: { input: number; output: number } }).usage };
};

it("sums the tool round and the reply round", async () => {
  const { done, usage } = await turnUsage("tooluse");
  expect(done).toMatchObject({ ok: true, stopReason: "end_turn" });
  expect(usage).toEqual({ input: 17, output: 3 });
});

it("keeps a one-round turn's usage as reported", async () => {
  const { done, usage } = await turnUsage();
  expect(done).toMatchObject({ ok: true });
  expect(usage).toEqual({ input: 12, output: 3 });
});
