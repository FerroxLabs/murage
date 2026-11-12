import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { hostPowerDeps, hostPowerProbeDeps, HOST_POWER_TEST_UNWRAPPED } from "../../host-power.ts";
import { recordEvents } from "../../testing/events.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { useOutsideStoreFixture } from "../../testing/outside-store-fixture.ts";
import { GeminiAgentDriver } from "./gemini.ts";
const deps = { ...hostPowerDeps }, probes = { ...hostPowerProbeDeps };
let instance: ProviderInstance | undefined;
let scratch: string | undefined;
afterEach(async () => {
  await instance?.dispose(); instance = undefined;
  Object.assign(hostPowerDeps, deps); Object.assign(hostPowerProbeDeps, probes);
  (globalThis as Record<symbol, unknown>)[HOST_POWER_TEST_UNWRAPPED] = true;
  vi.restoreAllMocks();
  if (scratch) await removeTempDir(scratch); scratch = undefined;
});
it("E2 ACP engines launch No limits after a failed macOS power profile", async () => {
  ensureDirs(); scratch = mkdtempSync(join(tmpdir(), "acp-no-limits-power-"));
  const wrapper = join(scratch, "fake-seatbelt");
  writeFileSync(wrapper, '#!/bin/sh\necho "sandbox-exec: profile rejected" >&2\nexit 65\n'); chmodSync(wrapper, 0o755);
  const cli = join(process.cwd(), "server/testing/fake-acp-cli.ts"); chmodSync(cli, 0o755);
  Object.assign(hostPowerDeps, { platform: () => "darwin", sandboxExec: wrapper });
  hostPowerProbeDeps.runSync = () => ({ code: 65, stderr: "profile rejected" });
  (globalThis as Record<symbol, unknown>)[HOST_POWER_TEST_UNWRAPPED] = false;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  instance = await GeminiAgentDriver.create({ instanceId: "acp-power", displayName: "Gemini", enabled: true,
    config: GeminiAgentDriver.decodeConfig({ cli }), environment: { HOME: scratch, GEMINI_API_KEY: "fixture-only", FAKE_ACP_MODE: "happy" } });
  const recorder = recordEvents(instance.adapter);
  try {
    for (const threadId of ["acp-power-owner", "acp-power-owner-next"]) {
      const sent = await instance.adapter.sendTurn({ threadId, text: "fixture", cwd: scratch, stopLine: true, noLimits: true });
      expect(await recorder.until(e => e.type === "turn.completed" && e.turnId === sent.turnId)).toMatchObject({ ok: true });
    }
    expect(warn.mock.calls.filter(([line]) => String(line).includes("No limits session"))).toHaveLength(1);
  } finally { recorder.stop(); }
});
useOutsideStoreFixture();
