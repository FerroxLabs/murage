import { afterEach, expect, it } from "vitest";
import { admittedFixtureInstance } from "../testing/mcp-admission-fixture.ts";
import { useOutsideStoreFixture } from "../testing/outside-store-fixture.ts";
import { fixtureBotFolder } from "../testing/bot-folder-fixture.ts";
import { ensureDirs } from "../config.ts";
import { recordEvents } from "../testing/events.ts";
import { ClaudeDriver } from "./claude.ts";
import { resetClaudeVersionGate } from "./claude-guards.ts";
import type { ProviderInstance } from "../contracts.ts";
import { fileURLToPath } from "node:url";
let instance: ProviderInstance | undefined;
afterEach(async () => { await instance?.dispose(); instance = undefined; resetClaudeVersionGate(); });
it("normal S1 completion retains exact-turn close proof before publishing its result", async () => {
  ensureDirs();
  instance = await admittedFixtureInstance(ClaudeDriver.create({ instanceId: "completion-proof", displayName: "fixture",
    enabled: true, environment: { FAKE_CLAUDE_MCP_STATUS: "error" }, config: { cli: fileURLToPath(new URL("../testing/fake-claude-cli.ts", import.meta.url)), permissionMode: "bypassPermissions" } }));
  const events = recordEvents(instance.adapter);
  try {
    const { turnId } = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "completed", text: "hello" });
    await events.until(event => event.type === "turn.completed" && event.turnId === turnId, 30000);
    expect(await instance.adapter.awaitTurnTeardown?.("completed", turnId)).toEqual({ closeConfirmed: true });
    expect(await instance.adapter.awaitTurnTeardown?.("other", turnId)).toEqual({ closeConfirmed: false, reason: "stop-failed" });
    await expect(instance.adapter.awaitTurnClose?.("completed", turnId)).resolves.toBeUndefined();
    expect(await instance.adapter.awaitTurnTeardown?.("completed", "missing")).toEqual({ closeConfirmed: false, reason: "stop-failed" });
  } finally { events.stop(); }
}, 60000);
useOutsideStoreFixture();
