import { expect, it, vi } from "vitest";
import { buildMcpServers } from "./mcp-mounts.ts";
import { openChatMcpServers } from "./chat-mcp-client.ts";
import { fixtureBotFolder } from "../testing/bot-folder-fixture.ts";
import type { SendTurnInput } from "../contracts.ts";

// Exercise the existing public builders and spawn boundary before A3. No
// missing admission API is replaced with a successful fixture capability.
it("S1 refuses raw configured mounts before any unadmitted rendering", () => {
  const turn: SendTurnInput = { threadId: "fixture", text: "fixture", integrations: {
    agents: { command: "fixture-engine", args: [], env: {} },
  } };
  expect(() => buildMcpServers(turn)).toThrow("MEMORY_CONTEXT_REVOKED");
});

it.each([1, 65])("S1 refuses %i unadmitted entries before the actual spawn boundary", async count => {
  const spawn = vi.fn(() => { throw new Error("actual spawn boundary reached"); });
  const servers = Object.fromEntries(Array.from({ length: count }, (_, i) => [String(i), { command: "fixture-mcp", args: [], env: {} }]));
  try { await openChatMcpServers(servers, { cwd: fixtureBotFolder(), spawn }); }
  catch (error) { expect(error).toMatchObject({ message: "MEMORY_CONTEXT_REVOKED" }); }
  expect(spawn).not.toHaveBeenCalled();
});

it("S1 mount-free rendering remains a control", () => {
  expect(buildMcpServers({ threadId: "fixture", text: "fixture" })).toBeNull();
});

it.each(["pi", "antigravity"] as const)("S1 refuses %s external native acceptance before the actual spawn", async engine => {
  const { consumingFixture } = await import("../testing/consuming-fixture.ts");
  const { ensureDirs } = await import("../config.ts");
  const procs = await import("../procs.ts");
  const driver = engine === "pi" ? (await import("./pi.ts")).PiDriver : (await import("./antigravity.ts")).AntigravityDriver;
  ensureDirs();
  const cwd = fixtureBotFolder(), f = consumingFixture();
  const instance = await driver.create({ instanceId: `unsupported-${engine}`, displayName: engine, enabled: true,
    environment: { HOME: cwd }, config: { cli: process.execPath, fullAuto: true } });
  const spawn = vi.spyOn(procs, "spawnCli").mockImplementation(() => { throw new Error("UNSUPPORTED_NATIVE_SPAWN_REACHED"); });
  try {
    await expect(instance.adapter.sendTurn({ threadId: "T", text: "fixture", cwd, releaseBinding: f.binding }))
      .rejects.toMatchObject({ message: "MEMORY_CONTEXT_REVOKED" });
    expect(spawn).not.toHaveBeenCalled();
  } finally { spawn.mockRestore(); await instance.dispose(); f.close(); }
});
