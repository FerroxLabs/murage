import * as procs from "../../procs.ts";
// control: retain the isolated turn and mount admission used by server dispatch.
import { bindFixtureAdapter } from "../../testing/mcp-admission-fixture.ts";
import { expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createAcpDriver } from "./core.ts";
import { ToolLimitStore } from "./opencode-tool-budget.ts";
import { cloudMcpCatalogRegistrationCount, publishCloudMcpCatalog } from "../../mcp-listed.ts";
import { ensureDirs } from "../../config.ts";
import { recordEvents } from "../../testing/events.ts";

it.each([false, true])("T34 pending cancellation and setup failure churn preserves attached publisher (pooled=%s)", async pooled => {
  ensureDirs();
  const baseline = cloudMcpCatalogRegistrationCount();
  const root = mkdtempSync(join(tmpdir(), "c11-lifetime-")), log = join(root, "rpc.jsonl");
  const fake = fileURLToPath(new URL("../../testing/fake-acp-cli.ts", import.meta.url));
  const home = process.env.HOME!;
  vi.stubEnv("MURAGE_CLOUD_ROLE", "home"); vi.stubEnv("MURAGE_ACP_POOL", "1");
  let setupFailure = false;
  const driver = createAcpDriver({ driverKind: "opencodeGo", displayName: "Lifetime fixture", models: { default: "mock", options: [] }, defaultCli: process.execPath, nativeSource: "c11.lifetime", loginNote: "unused", spawnArgs: () => [fake], pickAuthMethod: () => null, authFailure: "continue", isAuthenticated: () => true, pooledSessions: pooled,
    toolBudget: { routeKey: () => "b".repeat(64) }, applyMountEnv: () => { if (setupFailure) throw new Error("fixture setup exit"); },
    finishTurnEnv: () => { delete process.env.MURAGE_CLOUD_ROLE; },
    transformEnv: env => { delete env.MURAGE_CLOUD_TURN_ENGINE; Object.assign(env, { HOME: home, TMPDIR: process.env.TMPDIR, FAKE_ACP_RPC_FULL_LOG: log, FAKE_ACP_MODE: "hang", OPENCODE_CONFIG_CONTENT: "{}" }); }, fluxReach: () => "elsewhere" as const
  });
  const instance = await driver.create({ instanceId: "lifetime", displayName: "Lifetime", enabled: true, environment: {}, config: { cli: process.execPath, fullAuto: false } });
  bindFixtureAdapter(instance.adapter);
  const events = recordEvents(instance.adapter);
  const spawns = vi.spyOn(procs, "spawnCli");
  const turn = (threadId: string) => { process.env.MURAGE_CLOUD_ROLE = "home"; return ({ threadId, cwd: root,
    // Keep the publisher's actual engine turn attached while setups churn.
    // A consuming turn retires its mounts after completion, including when
    // pooling is enabled (RULINGS-1114A §6 D); no parked publisher exists.
    text: threadId === "attached" ? "offline fixture __fixture_cancel_ack__" : "offline fixture",
    integrations: { agents: { command: process.execPath, args: [fileURLToPath(new URL("../../testing/fake-idle-mcp.mjs", import.meta.url))], env: { MURAGE_HARNESS_URL: "http://127.0.0.1:1" } } } }); };
  const get = vi.spyOn(ToolLimitStore.prototype, "get").mockResolvedValue(undefined);
  try {
    // Keep a real process attached while other turns churn before spawn.
    await instance.adapter.sendTurn(turn("attached"));
    await expect.poll(() => existsSync(log) && readFileSync(log, "utf8").includes('"session/new"')).toBe(true);
    const request = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)).find(row => row.method === "session/new");
    expect(request.params.mcpServers[0].args[0]).toMatch(/cli-mount-shim/);
    const mountedSpawn = spawns.mock.calls.find(([, args]) => args.some(arg => arg.endsWith("fake-idle-mcp.mjs")));
    expect(mountedSpawn).toBeDefined();
    const env = mountedSpawn![2].env as Record<string, string>;
    const key = new URL(env.MURAGE_MCP_LISTED_URL).pathname.split("/").at(-1)!;
    let revision = 0;
    const publish = () => publishCloudMcpCatalog(key, "attached", { v: 2, processGeneration: basename(env.MURAGE_MCP_LISTED_FILE).split(".")[0], catalogGeneration: 1, revision: ++revision, at: Date.now(), complete: true, ready: true, tools: ["still-attached"], resources: false });
    await events.until(e => e.type === "content.delta", 10000);
    // MAIN RULING INT-CONFLICT-DEFAULT 0058cec1be / eb01447e7d: a mounted generation is
    // single-use even on a pooling-capable driver. Keep its real prompt attached while
    // other threads churn, then prove disposal removes its publisher below.
    expect(events.events.filter(e => e.type === "turn.completed")).toEqual([]);
    expect(cloudMcpCatalogRegistrationCount()).toBe(baseline + 1);
    for (let i = 0; i < 12; i++) {
      setupFailure = true;
      await expect(instance.adapter.sendTurn(turn(`failed-${i}`))).rejects.toThrow("engine could not be set up in its own folder");
      setupFailure = false;
      expect(cloudMcpCatalogRegistrationCount()).toBe(baseline + 1);
      let release!: () => void;
      get.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(undefined); }));
      const thread = `cancelled-${i}`;
      const sent = instance.adapter.sendTurn(turn(thread));
      // Attach rejection handling before issuing the cancellation.
      // A stop before the turn started ends it as a stopped turn (STOP-FENCE: a receipt, no engine); a superseded setup throws. Both leave no registration and no engine.
      const settled = sent.then((receipt) => ({ receipt }), (error: Error) => ({ error }));
      await expect.poll(() => typeof release).toBe("function");
      expect(cloudMcpCatalogRegistrationCount()).toBe(baseline + 2);
      if (i % 2 === 1) {
        // A second send on a thread whose setup is still awaiting is refused at entry (STOP-FENCE); it must leave that setup and its registration alone.
        await expect(instance.adapter.sendTurn(turn(thread))).rejects.toThrow("already running");
        expect(cloudMcpCatalogRegistrationCount()).toBe(baseline + 2);
      }
      await instance.adapter.resetSession!(thread);
      expect(cloudMcpCatalogRegistrationCount()).toBe(baseline + 1);
      release(); const outcome = await settled;
      if ("error" in outcome) expect(outcome.error.message).toContain("stopped before it started");
      expect(cloudMcpCatalogRegistrationCount()).toBe(baseline + 1);
      expect(publish()).toBe(true);
    }
    await instance.adapter.interruptTurn("attached");
    await expect.poll(cloudMcpCatalogRegistrationCount).toBe(baseline);
    expect(publish()).toBe(false);
    await instance.dispose();
    await expect.poll(cloudMcpCatalogRegistrationCount).toBe(baseline);
    expect(publish()).toBe(false);
  } finally { spawns.mockRestore(); get.mockRestore(); events.stop(); await instance.dispose(); vi.unstubAllEnvs(); }
}, 30000);
