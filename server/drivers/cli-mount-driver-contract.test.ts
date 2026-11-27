import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeDriver, resetClaudeMcpReadinessForTests } from "./claude.ts";
import { CodexDriver } from "./codex.ts";
import type { ProviderInstance, SendTurnInput } from "../contracts.ts";
import { bindFixtureAdapter, fixtureBoundTurn, fixtureMountTurn } from "../testing/mcp-admission-fixture.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { createLedgerLease, LEDGER_REFUSAL_LINE } from "../ledger-refusal.ts";
import { consumingFixture } from "../testing/consuming-fixture.ts";
import * as procs from "../procs.ts";
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
      instanceId: `s1-${engine}`, displayName: "S1 fixture", enabled: true, environment: { FIELD_REPLAY_MAILBOX: scratch },
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
  it.each(engine === "claude" ? ["browser", "computer", "wipe", "non-owner"] : [])("T-MOUNT-FAILURE: %s", async kind => {
    vi.stubEnv("FAKE_CLAUDE_START_DELAY_MS", "700");
    const exits = { command: process.execPath, args: ["-e", "setTimeout(() => process.exit(7), 300)"], env: {} };
    const integrations = kind === "browser" || kind === "non-owner" ? { browser: exits } : kind === "computer" ?
      { localComputer: { command: join(scratch, "missing-computer"), args: [], env: {} } } :
      { custom: { notes: { command: process.execPath, args: [SPAWNED_PROXIES.wipeMcp, "notes",
        JSON.stringify({ command: process.execPath, args: ["-e", "process.stdin.resume()"] })], env: {} } } };
    if (kind === "wipe") {
      const launch = procs.spawnCli;
      vi.spyOn(procs, "spawnCli").mockImplementation((...args) => {
        const child = launch(...args);
        if (args[1][0] === SPAWNED_PROXIES.wipeMcp) setTimeout(() => child.kill("SIGKILL"), 300).unref();
        return child;
      });
    }
    const turn = input();
    const { threadId } = turn;
    if (kind === "non-owner") turn.warmIdentity = { ...turn.warmIdentity!, audience: "non-owner" };
    const sent = await instance.adapter.sendTurn({ ...turn, integrations });
    const done = await recorder.until(event => event.type === "turn.completed" && event.turnId === sent.turnId);
    const notices = recorder.events.filter(event => event.type === "item.started" && event.itemType === "tool" && event.toolKind === "notice");
    const dump = join(scratch, "dump.json");
    // MAIN 11:08Z allows transport loss on both audiences and drops tools whose wipe wrapper died.
    const name = kind === "wipe" ? "notes" : kind === "non-owner" ? "browser" : kind;
    expect(done).toMatchObject({ ok: true });
    expect(existsSync(dump)).toBe(true);
    expect(notices).toEqual([expect.objectContaining({ threadId, title: `Murage couldn't use the ${name} for this reply.` })]);
  }, 15_000);
  it.each(engine === "claude" ? ["browser", "computer"] : [])("T-MOUNT-PROXY-TERMINAL: %s backend failure", async kind => {
    const replyGate = join(scratch, "allow-reply");
    const dump = join(scratch, "dump.json");
    vi.stubEnv("FAKE_CLAUDE_MODE", "slow");
    vi.stubEnv("FAKE_CLAUDE_REPLY_GATE", replyGate);
    resetClaudeMcpReadinessForTests();
    const warning = vi.spyOn(console, "warn");
    const requests: string[] = [];
    const endpoint = createServer((req, res) => {
      requests.push(req.url!);
      res.writeHead(503).end();
    });
    await new Promise<void>(resolve => endpoint.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}`;
    const stopEndpoint = () => new Promise<void>((resolve, reject) => endpoint.close(error => error ? reject(error) : resolve()));
    if (kind === "computer") await stopEndpoint();
    try {
      const turn = input();
      const mount = { command: process.execPath, args: [kind === "browser" ? SPAWNED_PROXIES.unifiedBrowser : SPAWNED_PROXIES.hostComputer],
        env: { MURAGE_CONTROL_URL: url, MURAGE_CONTROL_TOKEN: "fixture-control", MURAGE_BOT_ID: turn.warmIdentity!.botId, MURAGE_THREAD_ID: turn.threadId } };
      const sent = await instance.adapter.sendTurn({ ...turn, integrations: kind === "browser" ? { browser: mount } : { localComputer: mount } });
      await expect.poll(() => existsSync(dump), { timeout: 5_000 }).toBe(true);
      const { pid } = JSON.parse(readFileSync(dump, "utf8")) as { pid: number };
      const request = join(scratch, "proxy-request.pending");
      writeFileSync(request, JSON.stringify({ id: "backend", server: kind, name: "unused", args: {} }));
      renameSync(request, join(scratch, `${pid}-request.json`));
      await expect.poll(() => warning.mock.calls.some(([line]) => {
        const message = String(line);
        return message.includes(`mount="${kind}" cause=ipc`) || message.includes("seals the relay type=turn-release-terminal");
      }), { timeout: 6_000 }).toBe(true);
      if (kind === "browser") expect(requests).toEqual([expect.stringContaining("/api/internal/unified-browser?")]);
      writeFileSync(replyGate, "1");
      expect(await recorder.until(event => event.type === "turn.completed" && event.turnId === sent.turnId)).toMatchObject({ ok: true });
      expect(recorder.events.filter(event => event.type === "item.started" && event.itemType === "tool" && event.toolKind === "notice"))
        .toEqual([expect.objectContaining({ title: `Murage couldn't use the ${kind} for this reply.` })]);
    } finally { if (endpoint.listening) await stopEndpoint(); }
  }, 15_000);
  it.each(engine === "claude" ? ["silent", "initialized"] : [])("T-MOUNT-DOWNSTREAM: %s owner server", async mode => {
    const replyGate = join(scratch, "allow-reply");
    const exitGate = join(scratch, "exit-server");
    const listing = join(scratch, "listed");
    const received = join(scratch, "received");
    resetClaudeMcpReadinessForTests();
    vi.stubEnv("FAKE_CLAUDE_MCP_STATUS", "");
    vi.stubEnv("FAKE_CLAUDE_MODE", "slow");
    vi.stubEnv("FAKE_CLAUDE_REPLY_GATE", replyGate);
    vi.stubEnv("FAKE_CLAUDE_MCP_LIST_LOG", listing);
    const warning = vi.spyOn(console, "warn");
    const server = { command: process.execPath, args: ["-e", `
      const fs = require("node:fs");
      require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
        const { id, method } = JSON.parse(line);
        if (method === "initialize") fs.writeFileSync(process.argv[1], "1");
        if (process.argv[3] === "silent" || id === undefined) return;
        const result = method === "tools/list" ? { tools: [] } : { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "notes", version: "1" } };
        console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
      });
      setInterval(() => { if (fs.existsSync(process.argv[2])) process.exit(7); }, 25);`, received, exitGate, mode] };
    const sent = await instance.adapter.sendTurn({ ...input(), integrations: { custom: {
      notes: { command: process.execPath, args: [SPAWNED_PROXIES.wipeMcp, "notes", JSON.stringify(server)], env: {} },
    } } });
    await expect.poll(() => existsSync(received), { timeout: 5_000 }).toBe(true);
    if (mode === "initialized") {
      await expect.poll(() => existsSync(listing) && readFileSync(listing, "utf8").includes('"name":"notes"'), { timeout: 5_000 }).toBe(true);
      writeFileSync(exitGate, "1");
    }
    await expect.poll(() => warning.mock.calls.some(([line]) => String(line).includes('mount="notes" cause=server')),
      { timeout: mode === "silent" ? 13_000 : 5_000 }).toBe(true);
    writeFileSync(replyGate, "1");
    expect(await recorder.until(event => event.type === "turn.completed" && event.turnId === sent.turnId)).toMatchObject({ ok: true });
    expect(recorder.events.filter(event => event.type === "item.started" && event.itemType === "tool" && event.toolKind === "notice"))
      .toEqual([expect.objectContaining({ title: "Murage couldn't use the notes for this reply." })]);
  }, 40_000);
  it.each(engine === "claude" ? ["owner", "non-owner"] as const : [])("T-MOUNT-FIRST-FRAME-REFUSAL: %s", async audience => {
    resetClaudeMcpReadinessForTests();
    vi.stubEnv("FAKE_CLAUDE_MCP_STATUS", "");
    const signal = join(scratch, "initialize-requested");
    const allow = join(scratch, "send-initialize");
    const args = ["-e", `
      const fs = require("node:fs");
      require("node:readline").createInterface({ input: process.stdin }).once("line", line => {
        const { id } = JSON.parse(line);
        fs.writeFileSync(process.argv[1], "1");
        const timer = setInterval(() => {
          if (!fs.existsSync(process.argv[2])) return;
          clearInterval(timer);
          console.log(JSON.stringify({ jsonrpc: "2.0", id, result: {} }));
        }, 10);
      });`, signal, allow];
    const original = input();
    let lease: ReturnType<typeof createLedgerLease>;
    const f = consumingFixture(undefined, { threadId: original.threadId, botId: original.warmIdentity!.botId,
      onRefused: verdict => lease.onLedgerRefused(verdict) });
    const present = vi.fn();
    const settle = vi.fn();
    lease = createLedgerLease(f.binding.identity, { seal: f.replace, settle, present, quarantine: vi.fn(),
      interrupt: async id => (await instance.adapter.interruptTurn(original.threadId, id))?.closeConfirmed === true });
    try {
      const sending = instance.adapter.sendTurn(fixtureBoundTurn({
        ...original, warmIdentity: { ...original.warmIdentity!, audience },
        integrations: { browser: { command: process.execPath, args, env: {} } },
        releaseBinding: f.binding,
      }));
      await expect.poll(() => existsSync(signal), { timeout: 5_000 }).toBe(true);
      f.flip();
      writeFileSync(allow, "1");
      const sent = await sending;
      lease.attach(sent.turnId);
      await expect.poll(() => present.mock.calls).toEqual([[LEDGER_REFUSAL_LINE, undefined]]);
      expect(settle).toHaveBeenCalledExactlyOnceWith("memory-refused", { state: "withheld", reason: "deny-line" });
      expect(f.refusals).toBe(1);
      expect(existsSync(join(scratch, "dump.json"))).toBe(false);
      expect(recorder.events.some(event => event.type === "item.started" && event.itemType === "tool" && event.toolKind === "notice")).toBe(false);
    } finally { await instance.dispose(); f.close(); }
  }, 15_000);
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
