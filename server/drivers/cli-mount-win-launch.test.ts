import { expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ClaudeDriver } from "./claude.ts";
import { CliMountRelay } from "./cli-mount-relay.ts";
import { createMcpMountAdmission } from "./mcp-mounts.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { createProxyReleaseAuthority } from "../consuming-turn-ingress.ts";
import { consumingFixture } from "../testing/consuming-fixture.ts";
import { recordEvents } from "../testing/events.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import * as procs from "../procs.ts";
import type { ProviderInstance } from "../contracts.ts";

const enabled = process.platform === "win32" && process.env.MURAGE_WIN_REAL === "1";
if (!enabled) console.info("T-WIN-LAUNCH skipped: requires win32 and MURAGE_WIN_REAL=1 (real Windows job addon and IPC).");

// No process, job, relay, proxy or broker is mocked. Only the model-facing CLI
// is a deterministic fixture; it starts the real shim and calls approve over MCP.
it.skipIf(!enabled)("T-WIN-LAUNCH: mounted approval card round trip through the real job launcher and IPC bridge", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "murage-win-relay-"));
  const fixture = consumingFixture(undefined, { threadId: "win-relay", botId: "win-relay" });
  const caps = new InternalCapabilities();
  caps.begin("win-relay", "win-relay", fixture.binding.identity.dispatchGeneration);
  const authority = createProxyReleaseAuthority(caps);
  let verdicts = 0, upstream = 0;
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const claim = caps.resolve(req.headers.authorization);
      if (!claim) throw new Error("fixture authority missing");
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (body.operation === "upstream") {
        authority.reserveUpstream(claim, body); upstream++;
        res.end(JSON.stringify({ reserved: true }));
      } else {
        const envelope = authority.verdict(claim, body); verdicts++;
        res.end(JSON.stringify(envelope));
      }
    } catch { res.writeHead(409).end(); }
  });
  let instance: ProviderInstance | undefined;
  let recorder: ReturnType<typeof recordEvents> | undefined;
  let admission: ReturnType<typeof createMcpMountAdmission> | undefined;
  const relays: CliMountRelay[] = [];
  const create = CliMountRelay.create.bind(CliMountRelay);
  const relaySpy = vi.spyOn(CliMountRelay, "create").mockImplementation(async (...args) => {
    const relay = await create(...args); relays.push(relay); return relay;
  });
  const spawn = procs.spawnCli;
  const children: ReturnType<typeof spawn>[] = [];
  const acknowledgements: unknown[] = [];
  const spawnSpy = vi.spyOn(procs, "spawnCli").mockImplementation((...args) => {
    const child = spawn(...args);
    children.push(child);
    if (child.send) {
      const send = child.send.bind(child);
      vi.spyOn(child, "send").mockImplementation((...message: Parameters<typeof send>) => {
        acknowledgements.push(message[0]); return send(...message);
      });
    }
    return child;
  });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    admission = createMcpMountAdmission(fixture.binding, authority, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    instance = await ClaudeDriver.create({
      instanceId: "win-relay", displayName: "Windows relay fixture", enabled: true,
      environment: { CLAUDE_CONFIG_DIR: join(scratch, "claude"), FAKE_CLAUDE_DUMP: join(scratch, "dump.json"),
        FAKE_CLAUDE_PERM_TOOL: "Bash", FAKE_CLAUDE_PERM_INPUT: JSON.stringify({ command: "rm -rf ~/Documents" }) },
      config: { cli: fileURLToPath(new URL("../testing/fake-claude-cli.ts", import.meta.url)), permissionMode: "default" },
    });
    children.length = 0; // exclude catalog probes
    recorder = recordEvents(instance.adapter);
    const sent = await instance.adapter.sendTurn({ threadId: "win-relay", text: "__fixture_permission_tool__", cwd: scratch,
      warmIdentity: { botId: "win-relay", audience: "owner" }, releaseBinding: fixture.binding, mountAdmission: admission });
    const card = await recorder.until(event => event.type === "request.opened" && event.turnId === sent.turnId);
    expect(relays).toHaveLength(1);
    expect(relays[0]!.mounts.size).toBeGreaterThan(0);
    const mounts = [...relays[0]!.mounts.values()];
    for (const mount of mounts) {
      expect(procs.cliContainment(mount.child)).toBe("job");
      expect(mount.child.connected).toBe(true);
      // The exposed PID is the job launcher, and the engine/proxy PID came
      // back through fd 3. This prevents a direct spawn from passing the test.
      await vi.waitFor(() => {
        expect(procs.cliProcessPid(mount.child)).toBeTypeOf("number");
        expect(procs.cliProcessPid(mount.child)).not.toBe(mount.child.pid);
      });
    }
    const dump = JSON.parse(readFileSync(join(scratch, "dump.json"), "utf8"));
    expect(Object.values(dump.mcpConfig.mcpServers).every((entry: any) => entry.args.some((arg: string) => /cli-mount-shim\.(ts|js)$/.test(arg)))).toBe(true);
    const engine = children.find(child => procs.cliProcessPid(child) === dump.pid);
    expect(engine).toBeDefined(); expect(procs.cliContainment(engine!)).toBe("job");
    await instance.adapter.respondToRequest(card.threadId, card.requestId!, { behavior: "deny" });
    await recorder.until(event => event.type === "item.completed" && event.turnId === sent.turnId && event.itemType === "assistant_text" && /permission: denied/.test(event.text));
    expect(await recorder.until(event => event.type === "turn.completed" && event.turnId === sent.turnId)).toMatchObject({ ok: true });
    expect(recorder.events.filter(event => event.type === "request.opened")).toHaveLength(1);
    expect(verdicts).toBeGreaterThanOrEqual(2);
    expect(upstream).toBeGreaterThan(0);
    expect(acknowledgements.filter((message: any) => message.type === "turn-release-ack").length).toBeGreaterThanOrEqual(2);
    expect(fixture.refusals).toBe(0);
  } finally {
    recorder?.stop(); await instance?.dispose();
    for (const relay of relays) await relay.finish();
    admission?.dispose();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    spawnSpy.mockRestore(); relaySpy.mockRestore(); vi.restoreAllMocks();
    fixture.close(); await removeTempDir(scratch);
  }
}, 90_000);
