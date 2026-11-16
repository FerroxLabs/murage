// SPDX-License-Identifier: AGPL-3.0-or-later
// Proof producer: tri3-g1 (Claude); durable consumer: tri3-g2 (server).
// The durable completion listener asks for the exact lease before sendTurn
// returns. Every process and mount belongs to this isolated fixture.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import type { ProviderInstance, ProviderStopResult } from "../contracts.ts";
import { ensureDirs } from "../config.ts";
import { recordEvents } from "../testing/events.ts";
import { fixtureMountTurn } from "../testing/mcp-admission-fixture.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { ClaudeDriver } from "./claude.ts";
const cli = fileURLToPath(new URL("../testing/fake-claude-cli.ts", import.meta.url));
const idle = fileURLToPath(new URL("../testing/fake-idle-mcp.mjs", import.meta.url));
let instance: ProviderInstance | undefined, root: string | undefined;
afterEach(async () => { await instance?.dispose(); instance = undefined; if (root) await removeTempDir(root); root = undefined; });
it.each([false, true])("completion publishes its exact teardown proof before listeners (single-use=%s)", async mounted => {
  ensureDirs(); root = mkdtempSync(join(tmpdir(), "claude-turn-close-"));
  const dump = join(root, "dump.json");
  instance = await ClaudeDriver.create({ instanceId: "turn-close", displayName: "Fixture", enabled: true,
    config: { cli, permissionMode: "bypassPermissions" }, environment: { HOME: root, USERPROFILE: root,
      CLAUDE_CONFIG_DIR: root, FAKE_CLAUDE_DUMP: dump, FAKE_CLAUDE_DUMP_EACH_TURN: "1", FAKE_CLAUDE_MCP_STATUS: "error" } });
  const events = recordEvents(instance.adapter);
  let captured: Promise<ProviderStopResult> | undefined;
  const stop = instance.adapter.onEvent(event => {
    if (event.type === "turn.completed") captured = instance!.adapter.awaitTurnTeardown!(event.threadId, event.turnId);
  });
  const turn = () => fixtureMountTurn({ threadId: "turn-close", cwd: root, text: "fixture", draftOnly: mounted ? undefined : true,
    ...(mounted ? { integrations: { agents: { command: process.execPath, args: [idle], env: {} } } } : {}) });
  try {
    const first = await instance.adapter.sendTurn(turn());
    expect(await events.until(event => event.type === "turn.completed" && event.turnId === first.turnId)).toMatchObject({ ok: true });
    expect(captured).toBeDefined();
    expect(await captured).toMatchObject({ closeConfirmed: true });
    expect(await instance.adapter.awaitTurnTeardown!("another-thread", first.turnId)).toMatchObject({ closeConfirmed: false });
    expect(await instance.adapter.awaitTurnTeardown!("turn-close", "unknown-turn")).toMatchObject({ closeConfirmed: false });
    await instance.adapter.awaitTurnClose!("turn-close", first.turnId);
    if (!mounted) {
      const pid = JSON.parse(readFileSync(dump, "utf8")).pid;
      expect(() => process.kill(pid, 0)).not.toThrow();
      const next = await instance.adapter.sendTurn(turn());
      expect(await events.until(event => event.type === "turn.completed" && event.turnId === next.turnId)).toMatchObject({ ok: true });
      expect(await captured).toMatchObject({ closeConfirmed: true });
      expect(JSON.parse(readFileSync(dump, "utf8")).pid).toBe(pid);
    }
  } finally { stop(); events.stop(); }
}, 30000);
