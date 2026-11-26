// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import type { ProviderInstance } from "../contracts.ts";
import { ensureDirs, NATIVE_DIR } from "../config.ts";
import { invalidateCliVersions } from "../cli-version-cache.ts";
import { fixtureBotFolder } from "../testing/bot-folder-fixture.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { bindFixtureAdapter } from "../testing/mcp-admission-fixture.ts";
import { useOutsideStoreFixture } from "../testing/outside-store-fixture.ts";
import { ClaudeDriver, resetClaudeMcpReadinessForTests } from "./claude.ts";
import { resetClaudeVersionGate } from "./claude-guards.ts";

vi.mock("node:child_process", async original => (await import("../testing/exec-check-spy.ts")).withExecCheckSpy(await original()));
vi.mock("./claude-s2-qualification.ts", async original => {
  const actual = await original<typeof import("./claude-s2-qualification.ts")>();
  return (await import("../testing/claude-s2-wire-receipt.ts")).withClaudeWireReceipt(actual);
});

let instance: ProviderInstance | undefined;
let recorder: EventRecorder | undefined;
afterEach(async () => {
  recorder?.stop();
  await instance?.dispose();
  instance = undefined;
  recorder = undefined;
  vi.unstubAllEnvs();
  resetClaudeVersionGate();
  resetClaudeMcpReadinessForTests();
  invalidateCliVersions();
});

for (const status of ["allowed", "allowed_warning", "rejected", "malformed"] as const) {
  it(`A4/F1 consumes ${status} native limit frames before diagnostic persistence and keeps the real turn`, async () => {
    ensureDirs();
    const fake = fileURLToPath(new URL("../testing/fake-claude-cli.ts", import.meta.url));
    chmodSync(fake, 0o755);
    const threadId = `limit-intake-${status}`;
    const frame = { type: "rate_limit_event", uuid: "fixture-observation", session_id: "fixture-session",
      rate_limit_info: { status, rateLimitType: "five_hour", utilization: 0.31415926,
        resetsAt: 1_900_000_000, overageStatus: "allowed", overageDisabledReason: "fixture private reason" } };
    instance = await ClaudeDriver.create({ instanceId: "limit-intake", displayName: "Claude", enabled: true,
      environment: { FAKE_CLAUDE_START_FRAMES: JSON.stringify([frame, frame]) },
      config: { cli: fake, tools: [], permissionMode: "acceptEdits" } });
    bindFixtureAdapter(instance.adapter);
    recorder = recordEvents(instance.adapter);
    const sent = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId, text: "fixture request", draftOnly: true });
    expect(await recorder.until(event => event.type === "turn.completed" && event.turnId === sent.turnId)).toMatchObject({ ok: true });
    const trace = readFileSync(join(NATIVE_DIR, `${threadId}.ndjson`), "utf8");
    expect(trace).toContain("claude.sdk.message");
    expect(trace).not.toContain("rate_limit_info");
    expect(trace).not.toContain("0.31415926");
    expect(trace).not.toContain("fixture private reason");
    expect(recorder.events.filter(event => event.type === "turn.completed")).toHaveLength(1);
    expect(recorder.events.some(event => event.type === "turn.retrying")).toBe(false);
  });
}

useOutsideStoreFixture();
