// SPDX-License-Identifier: AGPL-3.0-or-later
// Proof producer: tri3-g1 (Claude); durable consumer: tri3-g2 (server).
// The durable completion listener asks for the exact lease before sendTurn
// returns. Every process and mount belongs to this isolated fixture.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import type { ProviderInstance, ProviderStopResult } from "../contracts.ts";
import { ensureDirs } from "../config.ts";
import { recordEvents } from "../testing/events.ts";
import { fixtureMountTurn } from "../testing/mcp-admission-fixture.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import * as processTree from "./process-tree.ts";
import { CliMountRelay } from "./cli-mount-relay.ts";
import { ClaudeDriver, resetClaudeMcpReadinessForTests } from "./claude.ts";
// Use the same isolated qualification receipt as the S2 protocol fixtures.
vi.mock("./claude-s2-qualification.ts", async original => {
  const api = await original<typeof import("./claude-s2-qualification.ts")>();
  const receipt = { platform: "linux" as const, arch: "fixture", version: "0.0.0",
    build: "0".repeat(64), evidence: "isolated-wire-fixture" };
  const qualified = () => api.claudeS2Qualified({}, receipt.platform,
    receipt.version, receipt.build, receipt.arch, [receipt]);
  return { ...api, claudeS2QualifiedCli: async () => qualified(), claudeS2QualifiedCliNow: qualified };
});
const stopSignals = vi.hoisted(() => ({ reads: 0 }));
vi.mock("../procs.ts", async original => {
  const api = await original<typeof import("../procs.ts")>();
  return { ...api, cliTreeStoppedSignal: (...args: Parameters<typeof api.cliTreeStoppedSignal>) => {
    stopSignals.reads++;
    return api.cliTreeStoppedSignal(...args);
  } };
});
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

it.each([false, true])("retained completion keeps its process without per-turn close subscriptions (mounted=%s)", async mounted => {
  resetClaudeMcpReadinessForTests();
  ensureDirs(); root = mkdtempSync(join(tmpdir(), "claude-retained-close-"));
  const dump = join(root, "dump.json");
  const retirement = vi.spyOn(CliMountRelay.prototype, "retireGeneration");
  // The fake MCP client's transient helpers are outside this protocol-retirement witness.
  const baseline = vi.spyOn(processTree, "descendantBaseline").mockResolvedValue(new Set<number>());
  const descendants = vi.spyOn(processTree, "untrackedDescendants").mockResolvedValue(new Set<number>());
  instance = await ClaudeDriver.create({ instanceId: "retained-close", displayName: "Fixture", enabled: true,
    config: { cli, permissionMode: "bypassPermissions" }, environment: { HOME: root, USERPROFILE: root,
      CLAUDE_CONFIG_DIR: root, FAKE_CLAUDE_DUMP: dump, FAKE_CLAUDE_DUMP_EACH_TURN: "1" } });
  const events = recordEvents(instance.adapter);
  const proofs: Array<Promise<ProviderStopResult>> = [];
  const stop = instance.adapter.onEvent(event => {
    if (event.type === "turn.completed") proofs.push(instance!.adapter.awaitTurnTeardown!(event.threadId, event.turnId));
  });
  let pid: number | undefined, subscriptions: number | undefined;
  try {
    for (let i = 0; i < 3; i++) {
      const sent = await instance.adapter.sendTurn(fixtureMountTurn({ threadId: "retained-close", cwd: root, text: "fixture",
        draftOnly: mounted ? undefined : true,
        ...(mounted ? { integrations: { agents: { command: process.execPath, args: [idle], env: {} } } } : {}) }));
      expect(await events.until(event => event.type === "turn.completed" && event.turnId === sent.turnId)).toMatchObject({ ok: true });
      expect(await proofs[i]).toEqual({ closeConfirmed: true });
      await instance.adapter.awaitTurnClose!("retained-close", sent.turnId);
      const currentPid = JSON.parse(readFileSync(dump, "utf8")).pid;
      pid ??= currentPid;
      expect(currentPid).toBe(pid);
      expect(() => process.kill(currentPid, 0)).not.toThrow();
      if (mounted) {
        expect(retirement).toHaveBeenCalledTimes(i + 1);
        expect(await retirement.mock.results[i]!.value).toBe(true);
      } else {
        subscriptions ??= stopSignals.reads;
        expect(stopSignals.reads).toBe(subscriptions);
      }
    }
    expect(proofs).toHaveLength(3);
  } finally { stop(); events.stop(); retirement.mockRestore(); baseline.mockRestore(); descendants.mockRestore(); }
}, 30000);
