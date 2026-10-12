// The connector bridge answers a tools/list inside ONE absolute deadline
// (CONNECTOR_LIST_DEADLINE_MS). Every engine that Murage configures with a
// list/startup limit of its own must allow at least twice that, so the bridge's answer
// (the real list, or the stand-in) always reaches the engine first. A stalled
// list used to hit the engine's own limit exactly (Pi: 8 s against 8 s) and
// lose the whole mount.
import { describe, expect, it } from "vitest";

import { CONNECTOR_LIST_DEADLINE_MS, CONNECTOR_LIST_TRANSPORT_MARGIN_MS, ENGINE_MCP_LIST_LIMIT_MS } from "./connector-cache.ts";
import { CODEX_MURAGE_MCP_STARTUP_TIMEOUT_SEC } from "./drivers/codex.ts";
import { claudeMcpStartupEnv } from "./drivers/claude.ts";
import { MCP_RECONNECT_WAIT_MS } from "./drivers/mcp-readiness.ts";
import { MCP_LIST_TIMEOUT_MS } from "./drivers/pi-mcp-extension.ts";

const bridgeNeedsMs = CONNECTOR_LIST_DEADLINE_MS + CONNECTOR_LIST_TRANSPORT_MARGIN_MS;

describe("the bridge's tools/list deadline against every engine's limit", () => {
  it("is well below the limits of the engines that Murage configures only for its own server (at most half of each)", () => {
    expect(CONNECTOR_LIST_DEADLINE_MS).toBe(8_000);
    const limits: Record<string, number> = {
      pi: MCP_LIST_TIMEOUT_MS,
      codex: CODEX_MURAGE_MCP_STARTUP_TIMEOUT_SEC * 1000,
      shared: ENGINE_MCP_LIST_LIMIT_MS,
    };
    for (const [engine, limit] of Object.entries(limits)) {
      expect(limit, engine).toBeGreaterThan(bridgeNeedsMs);
      expect(limit, engine).toBeGreaterThanOrEqual(2 * CONNECTOR_LIST_DEADLINE_MS);
    }
  });

  it("Claude's process-wide MCP_TIMEOUT stays at the previous 15 s (it also bounds custom servers); the bridge's deadline plus margin is below it", () => {
    expect(MCP_RECONNECT_WAIT_MS).toBe(15_000);
    for (const supported of [true, false]) expect(Number(claudeMcpStartupEnv(supported).MCP_TIMEOUT)).toBe(15_000);
    expect(bridgeNeedsMs).toBeLessThan(15_000);
  });
});
