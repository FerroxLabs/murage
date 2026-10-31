// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Adapted from OpenMausBot 7045f15a1: when Codex announced a tool item before its turn/start answer and the turn then
// failed to start, the failure says the action may have run. Text alone never earns the warning. Either way the turn
// is never sent again (G03-2) and the unbound tool item never reaches the transcript.
import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { ProviderInstance } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { CODEX_TOOL_MAY_HAVE_RUN, CodexDriver } from "./codex.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-codex-app-server.ts");

describe("Codex turn-start failure after early updates", () => {
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;

  afterEach(async () => {
    delete process.env.FAKE_CODEX_MODE;
    recorder?.stop();
    await instance?.dispose();
    instance = undefined;
  });

  const run = async (mode: string) => {
    chmodSync(FAKE_CLI, 0o755);
    process.env.FAKE_CODEX_MODE = mode;
    instance = await CodexDriver.create({ instanceId: "codex-early", displayName: "Codex Test", environment: {}, enabled: true, config: { cli: FAKE_CLI, fullAuto: false } });
    recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: `t-${mode}`, text: "record one action" });
    const done = await recorder.until((event) => event.type === "turn.completed");
    return { done, events: recorder.events };
  };

  it("warns that a tool action may have run when a tool item came before the failed start", async () => {
    const { done, events } = await run("parent-early-tool-fail");
    expect(done).toMatchObject({ ok: false, stopReason: "rpc_error" });
    expect(events.filter((event) => event.type === "runtime.error").map((event) => event.message)).toEqual([
      expect.stringMatching(new RegExp(`turn could not start.* ${CODEX_TOOL_MAY_HAVE_RUN.replace(/\./g, "\\.")}$`)),
    ]);
    expect(events.some((event) => event.type === "turn.retrying")).toBe(false);
    expect(events.filter((event) => (event.type === "item.started" || event.type === "item.completed") && event.itemType === "tool")).toHaveLength(0);
  });

  it("does not warn when only text came before the failed start", async () => {
    const { done, events } = await run("parent-early-text-fail");
    expect(done).toMatchObject({ ok: false });
    const errors = events.filter((event) => event.type === "runtime.error").map((event) => String(event.message));
    expect(errors).toHaveLength(1);
    expect(errors[0]).not.toContain(CODEX_TOOL_MAY_HAVE_RUN);
    expect(events.some((event) => event.type === "turn.retrying")).toBe(false);
  });
});
