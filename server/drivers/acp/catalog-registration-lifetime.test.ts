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
    transformEnv: env => { delete env.MURAGE_CLOUD_TURN_ENGINE; Object.assign(env, { HOME: home, TMPDIR: process.env.TMPDIR, FAKE_ACP_RPC_FULL_LOG: log, FAKE_ACP_MODE: pooled ? "normal" : "hang", OPENCODE_CONFIG_CONTENT: "{}" }); },
  });
  const instance = await driver.create({ instanceId: "lifetime", displayName: "Lifetime", enabled: true, environment: {}, config: { cli: process.execPath, fullAuto: false } });
  const events = recordEvents(instance.adapter);
  const turn = (threadId: string) => { process.env.MURAGE_CLOUD_ROLE = "home"; return ({ threadId, cwd: root, text: "offline fixture", integrations: { agents: { command: process.execPath, args: [], env: { MURAGE_HARNESS_URL: "http://127.0.0.1:1" } } } }); };
  const get = vi.spyOn(ToolLimitStore.prototype, "get").mockResolvedValue(undefined);
  try {
    // Keep a real process attached or parked while other turns churn before spawn.
    await instance.adapter.sendTurn(turn("attached"));
    await expect.poll(() => existsSync(log) && readFileSync(log, "utf8").includes('"session/new"')).toBe(true);
    const request = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)).find(row => row.method === "session/new");
    const env = Object.fromEntries(request.params.mcpServers[0].env.map((e: any) => [e.name, e.value]));
    const key = new URL(env.MURAGE_MCP_LISTED_URL).pathname.split("/").at(-1)!;
    let revision = 0;
    const publish = () => publishCloudMcpCatalog(key, "attached", { v: 2, processGeneration: basename(env.MURAGE_MCP_LISTED_FILE).split(".")[0], catalogGeneration: 1, revision: ++revision, at: Date.now(), complete: true, ready: true, tools: ["still-attached"], resources: false });
    if (pooled) await events.until(e => e.type === "turn.completed", 10000);
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
    await instance.dispose();
    await expect.poll(cloudMcpCatalogRegistrationCount).toBe(baseline);
    expect(publish()).toBe(false);
  } finally { get.mockRestore(); events.stop(); await instance.dispose(); vi.unstubAllEnvs(); }
}, 30000);
