import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { connect, Socket } from "node:net";
import { PassThrough } from "node:stream";
import { spawn, type ChildProcess } from "node:child_process";
import { consumingFixture } from "../testing/consuming-fixture.ts";
import { createProxyReleaseAuthority, frameDigest } from "../consuming-turn-ingress.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { createMcpMountAdmission, assertConsumingMountAdmission } from "./mcp-mounts.ts";
import { createTurnCredentialStore } from "./turn-credentials.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { cloudMcpStanza, CLOUD_MCP_PROXIES } from "../cloud-home/engine-render.ts";
import type { SendTurnInput } from "../contracts.ts";
import * as procs from "../procs.ts";
import { ChatMcpDescendants, openChatMcpServers } from "./chat-mcp-client.ts";

const stop = vi.hoisted(() => ({ confirmed: true }));
vi.mock("../procs.ts", async original => ({
  ...await original<typeof import("../procs.ts")>(),
  killCliTree: vi.fn(), awaitCliTreeStopped: async () => stop.confirmed,
  cliTreeStoppedSignal: () => new Promise<true>(() => {}),
}));
// A base checkout fails an assertion, not module loading.
const api = existsSync(new URL("./cli-mount-relay.ts", import.meta.url)) ? await import("./cli-mount-relay.ts") : undefined;
function relayApi() {
  expect(api?.CliMountRelay, "S1 must provide the server-owned relay").toBeTypeOf("function");
  return api!;
}
const cleanups: Array<() => void | Promise<unknown>> = [];
afterEach(async () => { stop.confirmed = true; for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const custom = { command: "fixture-mcp", args: [], env: {} };
function fixture() {
  const f = consumingFixture(undefined, { botId: randomUUID() }); cleanups.push(() => f.close());
  const caps = new InternalCapabilities(); caps.begin(f.binding.identity.botId, f.turn.threadId, f.binding.identity.dispatchGeneration);
  const authority = createProxyReleaseAuthority(caps);
  const admission = createMcpMountAdmission(f.binding, authority, "http://127.0.0.1:1");
  const cred = createTurnCredentialStore(); cleanups.push(() => cred.dispose());
  const turn: SendTurnInput = { threadId: f.turn.threadId, text: "isolated", warmIdentity: { botId: f.binding.identity.botId, audience: "owner" }, releaseBinding: f.binding, mountAdmission: admission };
  const children: ChildProcess[] = [];
  const envs: Record<string, string>[] = [];
  const spawn = vi.fn((_command: string, _args: string[], env: Record<string, string>) => {
    envs.push(env);
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      pid: undefined, exitCode: null, signalCode: null, connected: Boolean(env.MURAGE_RELEASE_INSTANCE),
      send: vi.fn((_message: unknown, callback: (error: Error | null) => void) => { callback(null); return true; }),
    }) as unknown as ChildProcess;
    children.push(child); return child;
  });
  const create = async (servers: Record<string, unknown> = { one: custom }) => {
    const relay = await relayApi().CliMountRelay.create(turn, servers, { one: { MURAGE_COMMS_TOKEN: "turn-secret" } }, cred, spawn);
    cleanups.push(() => relay.finish()); return relay;
  };
  return { f, caps, authority, admission, cred, turn, children, envs, spawn, create };
}
async function socketFor(relay: import("./cli-mount-relay.ts").CliMountRelay,
  server = "one", ticket = relay.ticket): Promise<Socket> {
  const socket = connect(relay.socketPath); cleanups.push(() => { socket.destroy(); });
  socket.on("error", () => {}); await once(socket, "connect");
  socket.write(JSON.stringify({ ticket, server }) + "\n"); return socket;
}
const request = (id: number, method = "tools/list") => JSON.stringify({ jsonrpc: "2.0", id, method });

describe("S1 admitted relay", () => {
  it("T-S1-SHIM-TRANSPORT: the real shim authenticates from the credential file and relays accepted bytes", async () => {
    const x = fixture(); const relay = await x.create();
    const spec = relay.servers.one as { command: string; args: string[]; env: Record<string, string> };
    const shim = spawn(spec.command, spec.args, { env: { ...process.env, ...spec.env }, stdio: ["pipe", "pipe", "pipe"] });
    const exited = new Promise<void>(resolve => shim.once("close", () => resolve()));
    cleanups.push(async () => { await relay.finish(); shim.kill(); await exited; });
    shim.stderr.resume();
    const input = once(x.children[0]!.stdin!, "data");
    shim.stdin.write(request(1) + "\n");
    expect((await input)[0].toString()).toBe(request(1) + "\n");
    const output = once(shim.stdout, "data");
    const frame = '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}';
    x.children[0]!.stdout!.emit("data", Buffer.from(frame + "\n"));
    expect((await output)[0].toString()).toBe(frame + "\n");
    expect(x.f.refusals).toBe(0);
  });
  it("T-S1-SERVER-SPAWN: the admitted default spawn requests server MCP ownership and IPC", async () => {
    const x = fixture();
    const spawn = vi.spyOn(procs, "spawnCli").mockImplementation((command, args, options) =>
      x.spawn(command, args, options.env as Record<string, string>) as ReturnType<typeof procs.spawnCli>);
    try {
      const relay = await relayApi().CliMountRelay.create(x.turn,
        { one: { command: process.execPath, args: [SPAWNED_PROXIES.memory], env: {} } }, {}, x.cred);
      cleanups.push(() => relay.finish());
      expect(spawn).toHaveBeenCalledOnce();
      expect(spawn.mock.calls[0]![2]).toMatchObject({ stdio: ["pipe", "pipe", "pipe", "ipc"],
        env: { MURAGE_RELEASE_INSTANCE: expect.any(String), MURAGE_RELEASE_TOKEN: expect.any(String) } });
      expect(spawn.mock.calls[0]![4]).toEqual({ serverTool: "mcp" });
    } finally { spawn.mockRestore(); }
  });
  it("T-EXTERNAL-REFUSED: valid dispatcher admission never authorizes external mounts", async () => {
    const x = fixture();
    const relay = await x.create(); // red: no server-owned relay on base
    for (const stanza of Object.values(relay.servers) as any[]) expect(stanza.args[0]).toBe(SPAWNED_PROXIES.cliMountShim);
    expect(() => assertConsumingMountAdmission(x.turn, "external", true)).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(x.f.refusals).toBe(1);
  });
  it.each([false, true])("T-ROUNDTRIP: custom/bundled=%s request, acceptance, then IPC ack", async bundled => {
    const x = fixture();
    const relay = await x.create({ one: bundled ? { command: process.execPath, args: [SPAWNED_PROXIES.memory], env: {} } : custom });
    const socket = await socketFor(relay);
    for (const [index, method] of ["initialize", "tools/list", "tools/call"].entries()) {
      const input = once(x.children[0]!.stdin!, "data"); socket.write(request(index + 1, method) + "\n"); await input;
      const frame = JSON.stringify({ jsonrpc: "2.0", id: index + 1, result: {} });
      let wire = frame;
      if (bundled) {
        const env = x.envs[0]!;
        const claim = x.caps.resolve(`Bearer ${env.MURAGE_RELEASE_TOKEN}`)!;
        wire = JSON.stringify(x.authority.verdict(claim, { bytes: Buffer.byteLength(frame), descriptor: "proxy:memory:frame",
          digest: frameDigest(frame), frame, instanceId: env.MURAGE_RELEASE_INSTANCE, requestId: index + 1, sequence: index + 1 }));
      }
      const output = once(socket, "data"); x.children[0]!.stdout!.emit("data", Buffer.from(wire + "\n"));
      expect((await output)[0].toString()).toBe(frame + "\n");
      expect(x.children[0]!.send).toHaveBeenCalledTimes(bundled ? index + 1 : 0);
    }
    await relay.finish(); expect(x.f.refusals).toBe(0);
  });
  it.each(["bundled", "unsolicited", "bad-json"])("T-UNACCEPTED: %s seals with no fallback reply", async kind => {
    const x = fixture();
    const relay = await x.create({ one: kind === "bundled" ? { command: process.execPath, args: [SPAWNED_PROXIES.memory] } : custom });
    const socket = await socketFor(relay); const output: Buffer[] = []; socket.on("data", chunk => output.push(chunk as Buffer));
    x.children[0]!.stdout!.emit("data", Buffer.from(kind === "bad-json" ? "oops\n" : '{"jsonrpc":"2.0","id":1,"result":{}}\n'));
    expect(x.f.refusals).toBe(1); expect(output).toEqual([]);
  });
  it("T-S1-COLD-ORDER: secrets, ticket and release env exist before child spawn", async () => {
    const x = fixture();
    x.spawn.mockImplementationOnce((_command, _args, env) => {
      const file = JSON.parse(readFileSync(x.cred.path, "utf8"));
      expect(file.one.MURAGE_COMMS_TOKEN).toBe("turn-secret");
      expect(file.one.MURAGE_RELAY_TICKET).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(env.MURAGE_RELEASE_INSTANCE).toBeTruthy(); expect(env.MURAGE_RELEASE_TOKEN).toBeTruthy();
      expect(env.MURAGE_RELEASE_URL).toBe("http://127.0.0.1:1");
      return Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: undefined }) as unknown as ChildProcess;
    });
    await x.create({ one: { command: process.execPath, args: [SPAWNED_PROXIES.memory], env: {} } });
    expect(x.spawn).toHaveBeenCalledOnce();
  });
  // MAIN-RULING cause22-no-transport-caps: the 64-mount bound (mcp-mounts.ts) is deleted; 65 mounts are admitted and each one spawns.
  it("T-MOUNTS-64/65: all admission precedes every spawn", async () => {
    const x = fixture();
    await x.create(Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`m${i}`, custom])));
    expect(x.spawn).toHaveBeenCalledTimes(64);
    const y = fixture();
    const refused = await y.create(Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`m${i}`, custom]))).then(() => null, (error: unknown) => String(error));
    expect([refused, y.f.refusals], "65 mounts are admitted").toEqual([null, 0]);
    expect(y.spawn).toHaveBeenCalledTimes(65);
  });
  it("T-DRAFT: only a mount-free draft needs no admission", async () => {
    const { mountedTurn } = relayApi();
    const draft: SendTurnInput = { threadId: "draft", text: "draft", draftOnly: true };
    expect(mountedTurn(draft)).toBe(false);
    expect(() => assertConsumingMountAdmission(draft, "server")).not.toThrow();
    const connected = { ...draft, integrations: { memory: { command: "fixture", args: [], env: {} } } };
    expect(mountedTurn(connected)).toBe(true);
    expect(() => assertConsumingMountAdmission(connected, "server")).toThrow("MEMORY_CONTEXT_REVOKED");
  });
  it("T-RACE-2: a retired child's late stdout never reaches the next relay", async () => {
    const x = fixture(); const first = await x.create(); await first.finish();
    const y = fixture(); const second = await y.create();
    const socket = await socketFor(second); const output: Buffer[] = []; socket.on("data", chunk => output.push(chunk as Buffer));
    x.children[0]!.stdout!.emit("data", Buffer.from(request(5) + "\n"));
    expect(output).toEqual([]); expect(x.f.refusals).toBe(0); expect(y.f.refusals).toBe(0);
  });
  it("T-CLOUD-RELAY: strangers cannot refuse; authenticated duplicates seal", async () => {
    const x = fixture(); const relay = await x.create();
    expect(CLOUD_MCP_PROXIES.relay).toEqual({ script: "drivers/cli-mount-shim", arg: "server", env: ["MURAGE_RELAY_TICKET", "MURAGE_RELAY_SOCKET"] });
    const bad = await socketFor(relay, "one", "bad"); await once(bad, "close"); expect(x.f.refusals).toBe(0);
    const socket = await socketFor(relay); const input = once(x.children[0]!.stdin!, "data"); socket.write(request(1) + "\n"); await input;
    const duplicate = await socketFor(relay); await once(duplicate, "close"); expect(x.f.refusals).toBe(1);
    // The actual Python mount plan is covered by T-S1-BROKER-BIND.
  });
  it("T-SEALCAUSE-NAMES-MOUNT: every relay seal names the mount and the site, never a frame", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const x = fixture(); const relay = await x.create();
      const socket = await socketFor(relay); const input = once(x.children[0]!.stdin!, "data");
      socket.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { cursor: "fixture-marker" } }) + "\n"); await input;
      const duplicate = await socketFor(relay); await once(duplicate, "close"); expect(x.f.refusals).toBe(1);
      const lines = warning.mock.calls.map(call => String(call[0])).filter(line => line.startsWith("[mount-relay]"));
      expect(lines).toContain("[mount-relay] second engine connection for one mount seals the relay mount=one");
      expect(lines.join("\n")).not.toMatch(/fixture-marker/);
      warning.mockClear();
      const y = fixture(); await y.create(); y.children[0]!.emit("exit", 1, null);
      const exitLines = warning.mock.calls.map(call => String(call[0])).filter(line => line.startsWith("[mount-relay]"));
      expect(exitLines).toContain("[mount-relay] mount child exited code=1 signal=-");
      expect(exitLines).toContain("[mount-relay] mount failure seals the relay mount=one cause=native");
    } finally { warning.mockRestore(); }
  });
  it("MACMOUNTS-TERMINAL-REASON: a child's terminal notice is logged with its frame code and reason word, never frame text", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const x = fixture(); await x.create();
      x.children[0]!.emit("message", { type: "turn-release-terminal", instanceId: "fixture", reason: "Tools-List:HTTP 500\n<b>",
        frame: { jsonrpc: "2.0", id: null, error: { code: -32099, message: "fixture-marker", data: { code: "MEMORY_CONTEXT_REVOKED", terminal: true } } } });
      const lines = warning.mock.calls.map(call => String(call[0])).filter(line => line.startsWith("[mount-relay]"));
      expect(lines).toContain("[mount-relay] mount ipc message seals the relay type=turn-release-terminal keys=type,instanceId,reason,frame"
        + " frame=memory_context_revoked reason=tools-list:http-500-b-");
      expect(lines.join("\n")).not.toMatch(/fixture-marker|<b>/);
    } finally { warning.mockRestore(); }
  });
  it.each([["terminal", "cause=ipc reason=tools-list:http-401"], ["disconnect", "cause=ipc reason=disconnect"]])(
    "BROWSERROOT-DROP-REASON: a dropped browser mount (%s) names the child's refusing check and its stderr code words, never its text", async (signal, named) => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const x = fixture();
      const relay = await x.create({ browser: { command: process.execPath, args: [SPAWNED_PROXIES.browser] } });
      relay.attach(x.children[0]!, vi.fn());
      const child = x.children[0]!;
      (child.stderr as PassThrough).write("fixture-marker private page text\n[consuming] swallowed error site=proxy.fetch n=1 class=TypeError code=ECONNREFUSED fence=- message=\"fixture-marker\" at=a.js:1\n"
        + "[consuming] swallowed error site=proxy.refuse n=1 class=Error code=- fence=- message=\"PROXY_RELEASE_REFUSED\" at=a.js:2\n");
      await new Promise(resolve => setImmediate(resolve));
      if (signal === "terminal") child.emit("message", { type: "turn-release-terminal", instanceId: x.envs[0]!.MURAGE_RELEASE_INSTANCE, reason: "tools-list:http-401",
        frame: { jsonrpc: "2.0", id: null, error: { code: -32099, message: "fixture-marker", data: { code: "MEMORY_CONTEXT_REVOKED", terminal: true } } } });
      else child.emit("disconnect");
      expect(relay.mountUnavailable("browser")).toBe(true);
      child.emit("close", 1, null);
      const lines = warning.mock.calls.map(call => String(call[0])).filter(line => line.startsWith("[mount-relay]"));
      expect(lines).toContain(`[mount-relay] mount unavailable mount="browser" ${named}`);
      expect(lines).toContain('[mount-relay] dropped mount child closed mount="browser" code=1 signal=- stderr=proxy.fetch/typeerror/econnrefused,proxy.refuse/error/-');
      expect(lines.join("\n")).not.toMatch(/fixture-marker|private page/);
    } finally { warning.mockRestore(); }
  });
  it("T-CLOUD-CODEX-ONE-TICKET: equal env, distinct names, unknown name cannot refuse", async () => {
    const x = fixture(); const relay = await x.create({ one: custom, two: custom });
    const ticket = JSON.parse(readFileSync(x.cred.path, "utf8"));
    expect(ticket.one.MURAGE_RELAY_TICKET).toBe(ticket.two.MURAGE_RELAY_TICKET);
    expect(ticket.one.MURAGE_RELAY_SOCKET).toBe(ticket.two.MURAGE_RELAY_SOCKET);
    for (const name of ["one", "two"]) {
      const stanza = cloudMcpStanza({ ...(relay.servers[name] as object), env: ticket[name] }, { mounted: true });
      expect(stanza).toEqual({ proxy: "relay", server: name, env: { MURAGE_RELAY_TICKET: relay.ticket, MURAGE_RELAY_SOCKET: relay.socketPath } });
      const socket = await socketFor(relay, name);
      const target = x.children[name === "one" ? 0 : 1]!; const input = once(target.stdin!, "data");
      socket.write(request(1) + "\n"); expect((await input)[0].toString()).toBe(request(1) + "\n");
    }
    const unknown = await socketFor(relay, "unknown"); await once(unknown, "close"); expect(x.f.refusals).toBe(0);
  });
  it("T-CLOUD-REFUSED: mounted raw stdio and URL are refused before render", () => {
    expect(() => cloudMcpStanza(custom, { mounted: true })).toThrow("MEMORY_CONTEXT_REVOKED"); // red: base silently returns null
    expect(() => cloudMcpStanza({ type: "http", url: "https://example.invalid" }, { mounted: true })).toThrow("MEMORY_CONTEXT_REVOKED");
  });
  it.each(["retire", "kill", "confirmation", "clear", "dispose", "admission", "close"])("T-H5-FINALLY: fault at %s cannot skip later cleanup", async step => {
    const x = fixture(); const relay = await x.create();
    const clear = vi.spyOn(x.cred, "clear"); const dispose = vi.spyOn(x.cred, "dispose"); const close = vi.spyOn(relay, "close");
    // Admission is frozen; inject its failure through the owning turn instead.
    const admission = vi.fn(() => x.admission.dispose()); Object.defineProperty(x.turn, "mountAdmission", { value: { ...x.admission, dispose: admission } });
    const fail = () => { throw new Error("injected"); };
    if (step === "retire") vi.spyOn(relay, "retire").mockImplementationOnce(fail);
    if (step === "kill") vi.mocked(procs.killCliTree).mockImplementationOnce(fail);
    const confirmation = step === "confirmation" ? vi.spyOn(procs, "awaitCliTreeStopped").mockRejectedValueOnce(new Error("injected")) : undefined;
    if (step === "clear") clear.mockImplementationOnce(fail);
    if (step === "dispose") dispose.mockImplementationOnce(fail);
    if (step === "admission") admission.mockImplementationOnce(fail);
    if (step === "close") close.mockImplementationOnce(fail);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    await relay.finish(x.children[0]);
    if (step === "clear") expect(warning).toHaveBeenCalledWith("[mount-relay] credential clear failed");
    warning.mockRestore();
    confirmation?.mockRestore();
    expect(clear).toHaveBeenCalledOnce(); expect(dispose).toHaveBeenCalledOnce(); expect(admission).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
    close.mockRestore(); relay.close(); dispose.mockRestore(); x.cred.dispose();
  });
  it("T-TEARDOWN-FAIL: unconfirmed CLI stop quarantines the bot and clears credentials", async () => {
    const x = fixture(); const relay = await x.create(); stop.confirmed = false;
    expect(await relay.finish(x.children[0])).toBe(false);
    expect(existsSync(x.cred.path)).toBe(false);
    expect(() => relayApi().assertRelayAvailable(x.turn)).toThrow("MOUNT_RELAY_STOP_UNCONFIRMED");
  });
  it("T-A3F-STOP-CONFIRM-MUTANT: a closed CLI without tree confirmation cannot launch another mounted turn", async () => {
    const x = fixture(); const relay = await x.create();
    const cli = x.children[0]!;
    stop.confirmed = false;
    // Root exit is not positive confirmation of its whole tree. This remains
    // refused even though the fake presents the normal exit/close events.
    cli.emit("exit", 0, null);
    cli.emit("close", 0, null);
    expect(await relay.finish(cli)).toBe(false);
    expect(() => relayApi().assertRelayAvailable(x.turn)).toThrow("MOUNT_RELAY_STOP_UNCONFIRMED");
    const next = fixture();
    const turn = { ...next.turn, warmIdentity: x.turn.warmIdentity };
    await expect(relayApi().CliMountRelay.create(turn, { one: custom }, {}, next.cred, next.spawn))
      .rejects.toThrow("MOUNT_RELAY_STOP_UNCONFIRMED");
    expect(next.spawn).not.toHaveBeenCalled();
  });
  it("T-STOP-ENGINE-FIRST: a Stop ends the engine at once, while the mount servers still wait for their process list", async () => {
    const x = fixture(); const relay = await x.create();
    const cli = Object.assign(new EventEmitter(), { stdin: new PassThrough(), pid: undefined, exitCode: null, signalCode: null }) as unknown as ChildProcess;
    let listAnswered!: () => void;
    const ready = vi.spyOn(ChatMcpDescendants.prototype, "ready").mockReturnValue(new Promise<void>(resolve => { listAnswered = resolve; }));
    vi.mocked(procs.killCliTree).mockClear();
    try {
      const finished = relay.finish(cli);
      await new Promise(resolve => setTimeout(resolve, 20));
      // the process list has not answered: the engine is already ended, the mount server is not (its descendants are still to be read)
      expect(vi.mocked(procs.killCliTree).mock.calls.map(([child]) => child)).toEqual([cli]);
      listAnswered();
      expect(await finished).toBe(true);
      expect(vi.mocked(procs.killCliTree).mock.calls.map(([child]) => child)).toEqual([cli, x.children[0]]);
    } finally { ready.mockRestore(); }
  });
  it("T-STOP-CANCEL-FIRST: a cancellation the caller writes in the same step as the stop goes out before the engine is ended", async () => {
    const x = fixture(); const relay = await x.create();
    // the engine's stdin records, in order, what reached it: a line written, its end, and the tree signal
    const order: string[] = [];
    const stdin = { write: (line: string) => { order.push(`write ${line.trim()}`); return true; }, end: () => { order.push("end"); } };
    const cli = Object.assign(new EventEmitter(), { stdin, pid: undefined, exitCode: null, signalCode: null }) as unknown as ChildProcess;
    vi.mocked(procs.killCliTree).mockClear();
    vi.mocked(procs.killCliTree).mockImplementation(child => { if (child === cli) order.push("kill"); });
    try {
      // ACP interrupt: the relay's stop starts, then session/cancel is written, in one step
      const finished = relay.finish(cli);
      cli.stdin!.write("session/cancel\n");
      expect(await finished).toBe(true);
      expect(order).toEqual(["write session/cancel", "end", "kill"]);
    } finally { vi.mocked(procs.killCliTree).mockReset(); }
  });
  it("T-TEARDOWN-DESCENDANT: CLI death alone cannot release mount quarantine", async () => {
    const x = fixture(); const relay = await x.create();
    const stopDescendants = vi.spyOn(ChatMcpDescendants.prototype, "stop").mockResolvedValue(false);
    let confirmDescendants!: (value: true) => void;
    const gone = vi.spyOn(ChatMcpDescendants.prototype, "goneSignal").mockReturnValue(new Promise<true>(resolve => { confirmDescendants = resolve; }));
    const cliGone = vi.spyOn(procs, "cliTreeStoppedSignal").mockResolvedValue(true);
    try {
      expect(await relay.finish(x.children[0])).toBe(false);
      expect(existsSync(x.cred.path)).toBe(false);
      expect(() => relayApi().assertRelayAvailable(x.turn)).toThrow("MOUNT_RELAY_STOP_UNCONFIRMED");
      x.children[0]!.emit("close", 0, null);
      confirmDescendants(true);
      await relay.stopped;
      expect(await relay.finish(x.children[0])).toBe(true);
      expect(() => relayApi().assertRelayAvailable(x.turn)).not.toThrow();
    } finally { stopDescendants.mockRestore(); gone.mockRestore(); cliGone.mockRestore(); }
  });
});

// R1: observe the actual streams, including the delimiter that the relay adds.
it.each(["request", "response"])("actual relay %s owns the writer through enqueue and charges the complete frame", async direction => {
  const x = fixture();
  x.f.f.db.exec("PRAGMA journal_mode=WAL");
  const other = new DatabaseSync(String(x.f.f.db.prepare("PRAGMA database_list").get()!.file));
  other.exec("PRAGMA busy_timeout=0"); cleanups.push(() => other.close());
  const competing = () => other.exec("BEGIN IMMEDIATE; COMMIT");
  const relay = await x.create();
  const socket = await socketFor(relay);
  const requestFrame = request(177);
  const responseFrame = '{"jsonrpc":"2.0","id":177,"result":{"fixture":"é"}}';
  let writes = 0;
  const observe = () => {
    writes++;
    expect(x.f.f.db.isTransaction).toBe(true);
    expect(competing).toThrow(/busy|locked/i);
  };
  const stream = x.children[0]!.stdin!;
  const original = stream.write.bind(stream);
  const inputSpy = vi.spyOn(stream, "write").mockImplementation(((...args: Parameters<typeof stream.write>) => {
    if (direction === "request") observe();
    return original(...args);
  }) as typeof stream.write);
  const socketWrite = Socket.prototype.write;
  const outputSpy = vi.spyOn(Socket.prototype, "write").mockImplementation(function(this: Socket, ...args: Parameters<Socket["write"]>) {
    if (direction === "response" && String(args[0]) === responseFrame + "\n") observe();
    return socketWrite.apply(this, args);
  });
  try {
    let before = x.f.budget.counts;
    const input = once(stream, "data"); socket.write(requestFrame + "\n"); await input;
    if (direction === "response") {
      before = x.f.budget.counts;
      const output = once(socket, "data");
      x.children[0]!.stdout!.emit("data", Buffer.from(responseFrame + "\n"));
      expect(String((await output)[0])).toBe(responseFrame + "\n");
    }
    expect(writes).toBe(1);
    expect(competing).not.toThrow();
    expect(x.f.budget.counts.attempts - before.attempts).toBe(1);
    expect(x.f.budget.counts.bytes - before.bytes).toBe(Buffer.byteLength((direction === "request" ? requestFrame : responseFrame) + "\n") * (direction === "response" ? 2 : 1));
  } finally { inputSpy.mockRestore(); outputSpy.mockRestore(); }
});

it.each(["request", "response"] as const)("R1 relay %s writer failure keeps its native identity across all mounts", async direction => {
  const x = fixture(), relay = await x.create({ one: custom, two: custom });
  const failed = vi.fn(), native = Object.assign(new Error("fixture native write failure"), { code: "EPIPE" });
  relay.attach(x.children[0]!, failed);
  const mount = relay.mounts.get("one")!;
  if (direction === "response") mount.request(request(1));
  const before = x.f.budget.counts;
  const writer = direction === "request"
    ? vi.spyOn(x.children[0]!.stdin!, "write").mockImplementation(() => { throw native; })
    : vi.spyOn(mount, "write").mockImplementation(() => { throw native; });
  try {
    if (direction === "request") mount.request(request(1));
    else mount.data(Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}\n'));
    expect(failed).toHaveBeenCalledExactlyOnceWith(native);
    expect(x.f.refusals).toBe(0);
    expect(x.f.budget.counts.attempts - before.attempts).toBe(1);
    expect(x.f.budget.counts.bytes).toBeGreaterThan(before.bytes);
    expect(relay.mounts.get("two")!.mount.ingress.retired).toBe(true);
  } finally { writer.mockRestore(); }
});

it.each([false, true])("T-MOUNT-APPROVAL-BROKER: exit seals after release=%s", async released => {
  const x = fixture();
  x.turn.integrations = { custom: { muragebox: custom } };
  const relay = await x.create({ muragebox: custom });
  const failed = vi.fn(), notice = vi.fn();
  relay.attach(x.children[0]!, failed);
  if (released) {
    const socket = await socketFor(relay, "muragebox");
    const input = once(x.children[0]!.stdin!, "data");
    socket.write(request(1, "initialize") + "\n");
    await input;
    const output = once(socket, "data");
    x.children[0]!.stdout!.emit("data", Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}\n'));
    expect((await output)[0].toString()).toContain('"id":1');
  }
  x.children[0]!.emit("exit", 1, null);
  expect(failed).toHaveBeenCalledOnce();
  expect(relay.mountUnavailable("muragebox")).toBe(false);
  relay.reportUnavailable(() => ({ eventId: "notice", provider: "claudeAgent", threadId: x.turn.threadId,
    createdAt: new Date().toISOString() }), notice);
  expect(notice).not.toHaveBeenCalled();
});
it.each(["stdout", "terminal"])("T-MOUNT-ISSUANCE-REFUSAL: a parent denial survives %s before the first response", async signal => {
  const x = fixture();
  const relay = await x.create({ browser: { command: process.execPath, args: [SPAWNED_PROXIES.browser] } });
  const failed = vi.fn();
  relay.attach(x.children[0]!, failed);
  const socket = await socketFor(relay, "browser");
  const requestEntered = once(x.children[0]!.stdin!, "data");
  socket.write(request(1, "initialize") + "\n");
  await requestEntered;
  const frame = '{"jsonrpc":"2.0","id":1,"result":{}}';
  const env = x.envs[0]!;
  const claim = x.caps.resolve(`Bearer ${env.MURAGE_RELEASE_TOKEN}`)!;
  x.f.flip();
  expect(() => x.authority.verdict(claim, { bytes: Buffer.byteLength(frame), descriptor: "proxy:browser:frame",
    digest: frameDigest(frame), frame, instanceId: env.MURAGE_RELEASE_INSTANCE, requestId: 1, sequence: 1 })).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(x.f.refusals).toBe(1);
  if (signal === "terminal") x.children[0]!.emit("message", { type: "turn-release-terminal", instanceId: env.MURAGE_RELEASE_INSTANCE });
  else x.children[0]!.stdout!.emit("end");
  expect(failed).toHaveBeenCalledOnce();
  expect(relay.mountUnavailable("browser")).toBe(false);
});
it.each(["child-error", "child-exit", "stdout-end", "stdin-error", "socket-close"])("R1 native transport %s retires all authority without a ledger refusal", async event => {
  const x = fixture(), relay = await x.create({ one: custom, two: custom });
  const failed = vi.fn(), native = Object.assign(new Error("fixture transport loss"), { code: "EPIPE" });
  relay.attach(x.children[0]!, failed);
  const first = relay.mounts.get("one")!, next = relay.mounts.get("two")!;
  first.request(request(1));
  const before = x.f.budget.counts;
  if (event === "socket-close") {
    const socket = await socketFor(relay);
    const received = once(x.children[0]!.stdin!, "data"); socket.write(request(2) + "\n"); await received;
    socket.destroy();
    await expect.poll(() => failed.mock.calls.length).toBe(1);
  } else if (event === "child-error") x.children[0]!.emit("error", native);
  else if (event === "child-exit") x.children[0]!.emit("exit", 1, null);
  else if (event === "stdin-error") x.children[0]!.stdin!.emit("error", native);
  else x.children[0]!.stdout!.emit("end");
  expect(failed).toHaveBeenCalledOnce();
  expect(failed.mock.calls[0]![0]).toBeInstanceOf(Error);
  if (event.endsWith("error")) expect(failed.mock.calls[0]![0]).toBe(native);
  expect(x.f.refusals).toBe(0);
  expect(first.mount.ingress.retired).toBe(true);
  expect(next.mount.ingress.retired).toBe(true);
  const write = vi.spyOn(x.children[1]!.stdin!, "write");
  next.request(request(3));
  expect(write).not.toHaveBeenCalled();
  expect(x.f.budget.counts.attempts - before.attempts).toBe(event === "socket-close" ? 1 : 0);
});

it.each(["callback", "throw", "disconnected"])("R1 IPC acknowledgement %s failure preserves the released frame without memory refusal", async failure => {
  const x = fixture(), relay = await x.create({ one: { command: process.execPath, args: [SPAWNED_PROXIES.memory], env: {} } });
  const child = x.children[0]!, failed = vi.fn(), native = Object.assign(new Error("fixture IPC loss"), { code: "EPIPE" });
  relay.attach(child, failed);
  const mount = relay.mounts.get("one")!;
  const socket = await socketFor(relay);
  const input = once(child.stdin!, "data"); socket.write(request(1) + "\n"); await input;
  const env = x.envs[0]!, claim = x.caps.resolve(`Bearer ${env.MURAGE_RELEASE_TOKEN}`)!;
  const frame = '{"jsonrpc":"2.0","id":1,"result":{}}';
  const permit = x.authority.verdict(claim, { bytes: Buffer.byteLength(frame), descriptor: "proxy:memory:frame", digest: frameDigest(frame), frame,
    instanceId: env.MURAGE_RELEASE_INSTANCE, requestId: 1, sequence: 1 });
  if (failure === "callback") vi.mocked(child.send).mockImplementation(((_message: unknown, callback: (error: Error | null) => void) => { callback(native); return false; }) as typeof child.send);
  else if (failure === "throw") vi.mocked(child.send).mockImplementation(() => { throw native; });
  else Object.defineProperty(child, "connected", { value: false });
  const before = x.f.budget.counts;
  mount.data(Buffer.from(JSON.stringify(permit) + "\n"));
  expect(x.f.budget.counts.attempts - before.attempts).toBe(1);
  expect(failed).toHaveBeenCalledOnce();
  if (failure !== "disconnected") expect(failed.mock.calls[0]![0]).toBe(native);
  else expect(failed.mock.calls[0]![0]).toBeInstanceOf(Error);
  expect(x.f.refusals).toBe(0);
  expect(mount.mount.ingress.retired).toBe(true);
});

it.each(["cli-relay", "chat-client"])("R1 %s spawn failure is native and leaves no usable mount", async target => {
  const x = fixture(), native = Object.assign(new Error("fixture spawn refused"), { code: "EACCES" });
  if (target === "cli-relay") {
    x.spawn.mockImplementation(() => { throw native; });
    await expect(x.create()).rejects.toBe(native);
  } else {
    const entry = x.admission.mount(custom);
    const cwd = dirname(String(x.f.f.db.prepare("PRAGMA database_list").get()!.file));
    const result = await openChatMcpServers({ one: entry }, { cwd, spawn: () => { throw native; } });
    expect(result.sessions).toEqual([]);
    expect(result.failed).toEqual(["one"]);
  }
  expect(x.f.refusals).toBe(0);
});
it("T12 owned metering IPC preserves relay authority while unrelated IPC still seals it",async()=>{
 const {observeChildIo}=await import("../sentinel/io-child-receipts.ts");
 const x=fixture(),relay=await x.create(),child=x.children[0]!;
 observeChildIo(child,"fixture-owned-meter");
 child.emit("message",{type:"io",ioProtocol:1,generation:"fixture-owned-meter",sequence:1,fsWriteBlocks:0,ioBytes:8192,known:true,final:true});
 expect(relay.mounts.get("one")!.mount.ingress.sealed,"private metering receipts must not revoke application authority").toBe(false);
 expect(x.f.refusals).toBe(0);
 child.emit("message",{type:"io",ioProtocol:1,generation:"unowned-generation",sequence:1});
 expect(relay.mounts.get("one")!.mount.ingress.sealed,"unowned IPC remains an application protocol failure").toBe(true);
 expect(x.f.refusals).toBe(1);
 child.emit("exit",0,null);
});

it("LLM relay seal hands the pre-entry refusal error to the consumer; a native failure carries none", async () => {
  const { isMemoryRefusal } = await import("./engine-input.ts");
  const x = fixture(), relay = await x.create();
  const failed = vi.fn();
  relay.attach(x.children[0]!, failed);
  x.f.replace();
  relay.mounts.get("one")!.request(request(1));
  expect(failed).toHaveBeenCalledOnce();
  expect(failed.mock.calls[0]![0]).toBeUndefined();
  expect(isMemoryRefusal(failed.mock.calls[0]![1]), "the consumer receives the refusal error to claim with refusalFor").toBe(true);
  const y = fixture(), relayY = await y.create(), failedY = vi.fn(), native = Object.assign(new Error("fixture transport loss"), { code: "EPIPE" });
  relayY.attach(y.children[0]!, failedY);
  y.children[0]!.emit("error", native);
  expect(failedY).toHaveBeenCalledExactlyOnceWith(native);
});

it("LLM a relay sealed before attach replays the refusal error to the late consumer", async () => {
  const { isMemoryRefusal } = await import("./engine-input.ts");
  const x = fixture(), relay = await x.create(), failed = vi.fn();
  const refusal = Object.assign(new Error("MEMORY_CONTEXT_REVOKED"), { code: "MEMORY_CONTEXT_REVOKED" });
  relay.seal(undefined, refusal);
  relay.attach(x.children[0]!, failed);
  expect(failed).toHaveBeenCalledOnce();
  expect(failed.mock.calls[0]![0]).toBeUndefined();
  expect(isMemoryRefusal(failed.mock.calls[0]![1]), "late attach receives the sealed refusal").toBe(true);
});
