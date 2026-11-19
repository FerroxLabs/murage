import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeDriver } from "./claude.ts";
import { CodexDriver } from "./codex.ts";
import type { ProviderInstance, SendTurnInput } from "../contracts.ts";
import { bindFixtureAdapter, fixtureMountTurn } from "../testing/mcp-admission-fixture.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { removeTempDir } from "../testing/cleanup.ts";
const relayApi = existsSync(new URL("./cli-mount-relay.ts", import.meta.url)) ? await import("./cli-mount-relay.ts") : undefined;

// Observe the actual spawn boundary, not a subsequent prompt-time dump. The
// fake CLI still speaks the engine protocol and the real relay owns children.
const observed = vi.hoisted(() => ({
  paths: [] as string[],
  spawns: [] as Array<{ pid?: number; files: Record<string, any> }>,
  threadStarts: [] as Array<Record<string, any>>,
}));
vi.mock("./turn-credentials.ts", async original => {
  const actual = await original<typeof import("./turn-credentials.ts")>();
  return { ...actual, createTurnCredentialStore: () => {
    const store = actual.createTurnCredentialStore();
    observed.paths.push(store.path);
    return store;
  } };
});
vi.mock("../procs.ts", async original => {
  const actual = await original<typeof import("../procs.ts")>();
  return { ...actual, spawnCli: (...args: Parameters<typeof actual.spawnCli>) => {
    const snapshot = () => Object.fromEntries(observed.paths.filter(existsSync)
      .map(path => [path, JSON.parse(readFileSync(path, "utf8"))]));
    const engine = /fake-(claude-cli|codex-app-server)\.ts$/.test(args[0]) && !args[1].includes("--version");
    const files = engine ? snapshot() : {};
    const child = actual.spawnCli(...args);
    if (engine) {
      observed.spawns.push({ pid: child.pid, files });
      const write = child.stdin.write.bind(child.stdin);
      vi.spyOn(child.stdin, "write").mockImplementation((...input: Parameters<typeof child.stdin.write>) => {
        if (String(input[0]).includes('"method":"thread/start"')) observed.threadStarts.push(snapshot());
        return write(...input);
      });
    }
    return child;
  } };
});

const source = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
describe.each(["claude", "codex"])("S1 %s launch contract", engine => {
  let scratch: string;
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  const input = (): SendTurnInput => ({ threadId: `s1-${engine}`, text: "fixture", cwd: scratch, warmIdentity: { botId: `s1-${engine}`, audience: "owner" },
    integrations: { agents: { command: process.execPath, args: ["-e", "process.stdin.resume()"], env: { MURAGE_COMMS_TOKEN: "s1-secret", MURAGE_BOT_ID: `s1-${engine}` } } } });
  const run = async (extra: Partial<SendTurnInput> = {}) => {
    const sent = await instance.adapter.sendTurn({ ...input(), ...extra });
    const done = await recorder.until(event => event.type === "turn.completed" && event.turnId === sent.turnId);
    expect(done).toMatchObject({ ok: true });
    return JSON.parse(readFileSync(join(scratch, "dump.json"), "utf8"));
  };
  beforeEach(async () => {
    scratch = mkdtempSync(join(tmpdir(), "murage-s1-driver-"));
    observed.paths.length = 0; observed.spawns.length = 0; observed.threadStarts.length = 0;
    vi.stubEnv("CLAUDE_CONFIG_DIR", join(scratch, "claude"));
    vi.stubEnv("FAKE_CLAUDE_DUMP", join(scratch, "dump.json"));
    vi.stubEnv("FAKE_CLAUDE_DUMP_EACH_TURN", "1");
    // S2:29: this contract exercises the unsupported-build S1 cold path.
    vi.stubEnv("FAKE_CLAUDE_MCP_STATUS", "error");
    vi.stubEnv("FAKE_CODEX_DUMP", join(scratch, "dump.json"));
    vi.stubEnv("FAKE_CODEX_WARM", "1");
    vi.stubEnv("FAKE_CODEX_MODE", "resume");
    const cli = fileURLToPath(new URL(engine === "claude" ? "../testing/fake-claude-cli.ts" : "../testing/fake-codex-app-server.ts", import.meta.url));
    chmodSync(cli, 0o755);
    instance = await (engine === "claude" ? ClaudeDriver : CodexDriver).create({
      instanceId: `s1-${engine}`, displayName: "S1 fixture", enabled: true, environment: {},
      config: (engine === "claude" ? { cli, permissionMode: "acceptEdits" } : { cli, fullAuto: false }) as never,
    });
    bindFixtureAdapter(instance.adapter); recorder = recordEvents(instance.adapter);
    // Catalog probes are not turns.
    observed.spawns.length = 0;
  });
  afterEach(async () => {
    recorder?.stop(); await instance?.dispose();
    vi.unstubAllEnvs(); vi.restoreAllMocks();
    await removeTempDir(scratch);
  });
  it("T-NO-SPARE: mounted intent-prewarm and direct prewarm create no process or credentials", async () => {
    await run();
    const count = observed.spawns.length, files = observed.paths.length;
    expect(await instance.adapter.prewarm!(input().threadId)).toBe(false);
    await expect(instance.adapter.sendTurn({ ...input(), prewarm: true })).rejects.toThrow("MOUNTED_PREWARM_REFUSED");
    expect(observed.spawns).toHaveLength(count);
    expect(observed.paths).toHaveLength(files);
    await run({ resumeCursor: engine === "claude" ? "fake-session" : "codex-thread-1" });
    expect(observed.spawns).toHaveLength(count + 1);
  });
  it("T-S1-SINGLE-USE: mounted turns get distinct processes and dispose credentials at settle", async () => {
    const first = await run();
    expect(observed.spawns).toHaveLength(1);
    for (const path of observed.paths) expect(existsSync(path)).toBe(false);
    const second = await run({ resumeCursor: engine === "claude" ? "fake-session" : "codex-thread-1" });
    expect(second.pid).not.toBe(first.pid);
    expect(observed.spawns).toHaveLength(2);
    for (const path of observed.paths) expect(existsSync(path)).toBe(false);
  });
  it("T-S1-NO-ADOPTION: a mounted turn cannot take the process used by an unmounted draft", async () => {
    const first = await run({ draftOnly: true, integrations: {} });
    const second = await run({ resumeCursor: engine === "claude" ? "fake-session" : "codex-thread-1" });
    expect(second.pid).not.toBe(first.pid);
    expect(observed.spawns).toHaveLength(2);
    for (const path of observed.paths) expect(existsSync(path)).toBe(false);
  });
  it("T-S1-UNMOUNTED: relay quarantine does not change a mount-free draft", async () => {
    expect(relayApi?.assertRelayAvailable, "relay quarantine contract must exist").toBeTypeOf("function");
    const guard = vi.spyOn(relayApi!, "assertRelayAvailable").mockImplementation(() => {
      throw new Error("MOUNT_RELAY_STOP_UNCONFIRMED");
    });
    try {
      await run({ draftOnly: true, integrations: {} });
      expect(guard).not.toHaveBeenCalled();
      await expect(instance.adapter.sendTurn(input())).rejects.toThrow("MOUNT_RELAY_STOP_UNCONFIRMED");
      expect(guard).toHaveBeenCalledOnce();
    } finally { guard.mockRestore(); }
  });
  it("R1 Stop retires mounted ingress without a memory refusal", async () => {
    const refused = vi.fn();
    vi.stubEnv(engine === "claude" ? "FAKE_CLAUDE_MODE" : "FAKE_CODEX_MODE", engine === "claude" ? "hang" : "tool-hold");
    const sent = await instance.adapter.sendTurn(fixtureMountTurn(input(), refused));
    await recorder.until(event => event.type === "session.started" && event.turnId === sent.turnId);
    if (engine === "claude") await expect.poll(() => existsSync(join(scratch, "dump.json"))).toBe(true);
    else await recorder.until(event => event.type === "item.started" && event.turnId === sent.turnId && event.itemId === "quiet-1");
    await instance.adapter.interruptTurn(input().threadId, sent.turnId);
    const done = await recorder.until(event => event.type === "turn.completed" && event.turnId === sent.turnId);
    expect(done).toMatchObject({ ok: true, stopReason: "cancelled" });
    expect(refused).not.toHaveBeenCalled();
  });
  it("T-CRED-ORDER: secrets and relay ticket precede CLI spawn and Codex thread/start", async () => {
    await run();
    expect(observed.spawns).toHaveLength(1);
    const check = (files: Record<string, any>) => {
      expect(Object.keys(files)).toHaveLength(1);
      const credentials = Object.values(files)[0];
      expect(credentials.agents.MURAGE_COMMS_TOKEN).toBe("s1-secret");
      expect(credentials.agents.MURAGE_RELAY_TICKET).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(credentials.agents.MURAGE_RELAY_SOCKET).toBeTruthy();
    };
    check(observed.spawns[0]!.files);
    if (engine === "codex") {
      expect(observed.threadStarts).toHaveLength(1);
      check(observed.threadStarts[0]!);
    }
  });
});
it("T-NO-PING-RELIANCE: the shared mounted transport contains no awaited ping barrier", () => {
  const path = new URL("./cli-mount-relay.ts", import.meta.url);
  expect(existsSync(path), "cold relay must replace any engine-owned mount path").toBe(true); // red: base has no relay
  for (const file of ["cli-mount-relay", "claude", "codex"]) {
    const text = source(`./${file}.ts`);
    expect(text).not.toMatch(/await[^;\n]*(?:request|notify|controlRequest)\([^;\n]*["']ping["']/);
    expect(text).not.toContain("murage-fence:");
  }
});
