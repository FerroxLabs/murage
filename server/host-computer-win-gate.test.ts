// DESIGN 1022-cua-windows D10 / D15 / D17 / D20: the harness gate terms, driven through the harness's REAL message
// handler (createHostGateState().onHostMessage, the function index.ts registers on the utility port) with messages
// built only by shared/cua-host-messages.mjs, and the proxy's wording of each refusal.
// Scope note: this exercises the gate the host route folds into authorized(); the route-level win32 cells (W-L1 at
// the booted route) need a win32 descriptor and run on the Windows runner (section 7); the all-platform selection
// term is witnessed at the booted route in server/host-computer-owner-path.test.ts (W-C5).
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostComputerBroker, type HostComputerSpec } from "./host-computer-broker.ts";
import { verifyExeIdentity, defaultIdentityFs } from "../shared/cua-driver-identity.mjs";
import { WINDOWS_DRIVER_ENV } from "./local-computer.ts";
import { createHostComputerBroker, createHostGateState, handleHostMessage, hostGateRefusal } from "./host-computer-gate.ts";
import { hostRefusalText } from "./drivers/host-computer-proxy.ts";
import { hostDesktopMessage, liveMessage, retiredMessage, withdrawnMessage } from "../shared/cua-host-messages.mjs";

const G = "0123456789ab";
const win = { command: "C:\\R\\cua-win32-x64\\cua-driver.exe", args: [], env: {}, platform: "win32" as const, generation: G, scope: "local-computer" as const };
const linux = { ...win, platform: "linux" as const, generation: "linux-gen" };
const refusal = (state: ReturnType<typeof createHostGateState>, over: Partial<Parameters<typeof hostGateRefusal>[0]> = {}) => hostGateRefusal({
  state, method: "tools/call", connection: win, currentGeneration: () => G, botComputer: () => "local", boundComputer: "local", hostPlatform: "win32", ...over,
});
const ready = () => {
  const state = createHostGateState();
  state.onHostMessage(liveMessage(G));
  state.onHostMessage(hostDesktopMessage("active"));
  return state;
};

describe("D10 desktop lock (R13, R13d)", () => {
  it("a fresh harness state refuses tools/call as host-locked until main pushes active", () => {
    const state = createHostGateState();
    state.onHostMessage(liveMessage(G));
    expect(state.hostDesktop).toBe("unknown");
    expect(refusal(state)).toEqual({ code: "host-locked" });
  });
  it("locked -> host-locked", () => {
    const state = ready();
    state.onHostMessage(hostDesktopMessage("locked"));
    expect(refusal(state)).toEqual({ code: "host-locked" });
  });
  it("active with every other term true -> no refusal", () => {
    expect(refusal(ready())).toBeNull();
  });
  it("tools/list is never gated by the lock", () => {
    const state = ready();
    state.onHostMessage(hostDesktopMessage("locked"));
    expect(refusal(state, { method: "tools/list" })).toBeNull();
  });
  it("darwin/linux descriptors with no push are unchanged", () => {
    const state = createHostGateState();
    expect(refusal(state, { connection: linux, hostPlatform: "linux" })).toBeNull();
  });
});

describe("D15 / D20 generation fence (R17d v)", () => {
  it("desktop active, bot on This computer, descriptor names G, but main never said live:G in this harness -> host-off", () => {
    const state = createHostGateState();
    state.onHostMessage(hostDesktopMessage("active"));
    expect(state.hostDesktop).toBe("active");
    expect(refusal(state)).toEqual({ code: "host-off", cause: "restart" });
  });
  it("withdrawn:G (disable) -> host-off worded by its cause, and a later live:G never re-admits G", () => {
    const state = ready();
    state.onHostMessage(withdrawnMessage(G, "disable"));
    expect(refusal(state)).toEqual({ code: "host-off", cause: "disable" });
    state.onHostMessage(liveMessage(G));
    expect(refusal(state)).toEqual({ code: "host-off", cause: "disable" });
  });
  it("the current descriptor names another generation -> host-off restart", () => {
    expect(refusal(ready(), { currentGeneration: () => "ba9876543210" })).toEqual({ code: "host-off", cause: "restart" });
  });
});

describe("D17 selection (all platforms)", () => {
  for (const computer of [undefined, "cloud", "off"] as const) {
    it(`bot now on ${String(computer)} -> host-off bot-off on win32 and linux`, () => {
      expect(refusal(ready(), { botComputer: () => computer }), expect.getState().currentTestName).toEqual({ code: "host-off", cause: "bot-off" });
      expect(refusal(createHostGateState(), { connection: linux, hostPlatform: "linux", botComputer: () => computer })).toEqual({ code: "host-off", cause: "bot-off" });
    });
  }
  it("a grant made while the bot was not on this computer is not a revocation (only a change since the grant is)", () => {
    expect(refusal(createHostGateState(), { connection: linux, hostPlatform: "linux", botComputer: () => undefined, boundComputer: undefined })).toBeNull();
  });
  it("a deleted bot -> host-off bot-off", () => {
    expect(refusal(ready(), { botComputer: () => null })).toEqual({ code: "host-off", cause: "bot-off" });
  });
});

describe("proxy wording (D10, D15, D17)", () => {
  it("host-locked, not sent / sent", () => {
    expect(hostRefusalText({ code: "host-locked", sent: false })).toBe("This PC is locked. Computer actions resume when the owner unlocks it; nothing was performed.");
    expect(hostRefusalText({ code: "host-locked", sent: true })).toMatch(/^This PC was locked while this action ran; it was cancelled, but part of it may already have taken effect/);
  });
  it("host-off by cause", () => {
    expect(hostRefusalText({ code: "host-off", cause: "disable" })).toBe("Local control was switched off on this PC; nothing was performed.");
    expect(hostRefusalText({ code: "host-off", cause: "restart" })).toMatch(/restarting on this PC; nothing was performed/);
    expect(hostRefusalText({ code: "host-off", cause: "bot-off" })).toBe("This bot is no longer set to use this computer; nothing was performed.");
    expect(hostRefusalText({ code: "host-off", cause: "bot-off", sent: true })).toMatch(/taken off this computer while this action ran/);
  });
  it("other codes keep today's wording", () => {
    expect(hostRefusalText({ code: "cancelled" })).toBeNull();
  });
});

// DESIGN 1022-cua-windows R5b / W-S3, W-S3b and R6b / W-S4: before each new MCP child of a win32 descriptor the broker
// hashes the exe through one fd (the same verifyExeIdentity the runtime uses) and never lets an inherited CUA_* key
// or DO_NOT_TRACK through. Driven through the broker's real dispatch; only the engine start is a recording fake.
describe("W-S3 / W-S4 the per-session spawn of a win32 descriptor", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });
  const staged = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "murage-win-gate-"));
    dirs.push(dir);
    const exe = path.join(dir, "cua-driver.exe");
    fs.writeFileSync(exe, Buffer.alloc(8192, 3));
    fs.writeFileSync(path.join(dir, "other.exe"), Buffer.alloc(8192, 4));
    return { dir, exe, pin: createHash("sha256").update(fs.readFileSync(exe)).digest("hex") };
  };
  const engine = () => ({ request: async () => ({ content: [] }), notify: async () => {}, close: async () => {} });
  const winSpec = (exe: string): HostComputerSpec => ({ command: exe, args: ["mcp", "--embedded", "--socket", "\\\\.\\pipe\\murage-cua-1-0123456789ab"], env: { ...WINDOWS_DRIVER_ENV }, platform: "win32", generation: G });
  const broker = (pin: string, start: ReturnType<typeof vi.fn>, onIntegrity = vi.fn(), identityFs = defaultIdentityFs) =>
    new HostComputerBroker(start as never, { verifySpawn: async (command) => {
      const answer = await verifyExeIdentity(command, pin, identityFs, { platform: "linux", exclusive: false });
      return answer.ok ? "ok" : answer.reason === "busy" || answer.reason === "unreadable" ? "busy" : "integrity";
    }, onIntegrity });

  it("control: the pinned exe -> the MCP child starts once", async () => {
    const { exe, pin } = staged();
    const start = vi.fn((_spec: HostComputerSpec) => engine());
    await broker(pin, start).dispatch(winSpec(exe), "tools/call", { name: "click" }, () => true);
    expect(start).toHaveBeenCalledTimes(1);
  });
  it("W-S3 the staged exe replaced with a same-size other file -> driver-integrity, start 0, main told", async () => {
    const { dir, exe, pin } = staged();
    fs.renameSync(path.join(dir, "other.exe"), exe);
    const start = vi.fn((_spec: HostComputerSpec) => engine());
    const onIntegrity = vi.fn();
    const outcome = await broker(pin, start, onIntegrity).dispatch(winSpec(exe), "tools/call", { name: "click" }, () => true).then(() => null, (error) => error);
    expect(outcome?.code, expect.getState().currentTestName).toBe("driver-integrity");
    expect(start).toHaveBeenCalledTimes(0);
    expect(onIntegrity).toHaveBeenCalledWith(G);
  });
  // The OS decides whether a file held open can be replaced: POSIX lets the rename through (the hash read next is of the
  // OTHER file -> driver-integrity); NTFS refuses it (EPERM/EBUSY, the real Windows run on 4e3d2628f0), so the held bytes stay
  // the pinned ones and the pinned file starts. `refuse` simulates the NTFS answer on every platform.
  for (const refuse of [false, true]) {
    it.skipIf(!refuse && process.platform === "win32")(`W-S3b a same-size file renamed over the path after the first fd read, ${refuse ? "the OS refuses (NTFS) -> the pinned file starts once" : "the OS allows (POSIX) -> driver-integrity, start 0"}`, async () => {
      const { dir, exe, pin } = staged();
      let reads = 0;
      let swapped = false;
      let attempts = 0;
      const identityFs = { ...defaultIdentityFs, read: async (fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
        const bytes = await defaultIdentityFs.read(fd, buffer, offset, length, position);
        reads += 1;
        if (reads === 1) {
          attempts += 1;
          try {
            if (refuse) throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
            fs.renameSync(path.join(dir, "other.exe"), exe); swapped = true;
          } catch { swapped = false; }
        }
        return bytes;
      } };
      const start = vi.fn((_spec: HostComputerSpec) => engine());
      const outcome = await broker(pin, start, vi.fn(), identityFs).dispatch(winSpec(exe), "tools/call", { name: "click" }, () => true).then(() => null, (error) => error);
      expect(attempts, `${expect.getState().currentTestName}: the rename was attempted exactly once, after the first fd read`).toBe(1);
      expect(swapped, "the swap outcome is the OS's, as set up").toBe(!refuse);
      if (swapped) {
        expect(outcome?.code, expect.getState().currentTestName).toBe("driver-integrity");
        expect(start).toHaveBeenCalledTimes(0);
      } else {
        expect(outcome, expect.getState().currentTestName).toBeNull();
        expect(createHash("sha256").update(fs.readFileSync(exe)).digest("hex"), "the file on disk is still the pinned one").toBe(pin);
        expect(start).toHaveBeenCalledTimes(1);
      }
    });
  }
  // Runs on every platform with the OS's own answer, so its attempt counter is proven by a mutant on Linux CI too.
  it("W-S3b (real rename, the OS decides) a rename over the held file either fails (the pinned file starts) or ends driver-integrity; a swapped file never starts", async () => {
    const { dir, exe, pin } = staged();
    let reads = 0; let swapped = false; let attempts = 0; let refusedWith: unknown = null;
    const identityFs = { ...defaultIdentityFs, read: async (fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
      const bytes = await defaultIdentityFs.read(fd, buffer, offset, length, position);
      reads += 1;
      if (reads === 1) { attempts += 1; try { fs.renameSync(path.join(dir, "other.exe"), exe); swapped = true; } catch (error) { swapped = false; refusedWith = (error as NodeJS.ErrnoException)?.code ?? "unknown"; } }
      return bytes;
    } };
    const start = vi.fn((_spec: HostComputerSpec) => engine());
    const outcome = await broker(pin, start, vi.fn(), identityFs).dispatch(winSpec(exe), "tools/call", { name: "click" }, () => true).then(() => null, (error) => error);
    expect(attempts, `${expect.getState().currentTestName}: the rename was attempted exactly once, after the first fd read`).toBe(1);
    if (!swapped) expect(["EPERM", "EBUSY", "EACCES"], `the OS refused the rename with ${String(refusedWith)}`).toContain(refusedWith);
    if (swapped) { expect(outcome?.code, expect.getState().currentTestName).toBe("driver-integrity"); expect(start, "a swapped file never starts").toHaveBeenCalledTimes(0); }
    else { expect(outcome, expect.getState().currentTestName).toBeNull(); expect(start).toHaveBeenCalledTimes(1); }
  });
  it("W-S4 hostile harness env -> the MCP child gets the D4 values", async () => {
    vi.stubEnv("CUA_DRIVER_RS_TELEMETRY_ENABLED", "true"); vi.stubEnv("DO_NOT_TRACK", "0"); vi.stubEnv("CUA_DRIVER_FOO", "1");
    const { exe, pin } = staged();
    const start = vi.fn((_spec: HostComputerSpec) => engine());
    await broker(pin, start).dispatch(winSpec(exe), "tools/call", { name: "click" }, () => true);
    expect(start.mock.calls[0]![0].env).toMatchObject(WINDOWS_DRIVER_ENV);
  });
  it("W-S4 hostile harness env -> no other CUA_* key reaches the MCP child", async () => {
    vi.stubEnv("CUA_DRIVER_RS_TELEMETRY_ENABLED", "true"); vi.stubEnv("DO_NOT_TRACK", "0"); vi.stubEnv("CUA_DRIVER_FOO", "1");
    const { exe, pin } = staged();
    const start = vi.fn((_spec: HostComputerSpec) => engine());
    await broker(pin, start).dispatch(winSpec(exe), "tools/call", { name: "click" }, () => true);
    expect(Object.keys(start.mock.calls[0]![0].env).filter((key) => /^CUA_/i.test(key)).sort()).toEqual(Object.keys(WINDOWS_DRIVER_ENV).filter((key) => key.startsWith("CUA_")).sort());
  });
  it("an exe that cannot be read now -> driver-busy for that call only: main is not told, nothing is stopped", async () => {
    const { exe, pin } = staged();
    fs.rmSync(exe);
    const start = vi.fn((_spec: HostComputerSpec) => engine());
    const onIntegrity = vi.fn();
    const outcome = await broker(pin, start, onIntegrity).dispatch(winSpec(exe), "tools/call", { name: "click" }, () => true).then(() => null, (error) => error);
    expect(outcome?.code).toBe("driver-busy");
    expect(onIntegrity).toHaveBeenCalledTimes(0);
    expect(start).toHaveBeenCalledTimes(0);
  });
  it("proxy wording for driver-integrity is the D6 sentence", () => {
    expect(hostRefusalText({ code: "driver-integrity" })).toBe("This computer's driver failed its integrity check, so nothing was performed. The owner can reinstall Murage.");
  });
});

// DESIGN 1022-cua-windows R17 / W-K2 (harness half): main's `withdrawn:G` and `retired:G` reach the broker through the
// harness's one handler, handleHostMessage (the function server/index.ts registers), built only by
// shared/cua-host-messages.mjs. The runtime's own posting order is witnessed in electron/cua-windows-runtime.test.mjs.
describe("W-K2 main's withdrawn / retired reach the broker fence", () => {
  const never = () => new Promise(() => {});
  const setup = () => {
    const start = vi.fn(() => ({ request: async (method: string) => method === "initialize" ? {} : never(), notify: async () => {}, close: async () => {} }));
    const broker = new HostComputerBroker(start as never, { verifySpawn: async () => "ok" });
    return { start, broker, state: ready() };
  };
  const spec = (generation: string) => ({ ...win, generation });
  it("withdrawn:G -> a call on G is refused host-off by the broker itself, start 0; retired:G -> the waiting call answers driver-exited", async () => {
    const { start, broker, state } = setup();
    const first = broker.dispatch(spec(G), "tools/call", { name: "click" }, () => true);
    const outcome = first.then(() => "ok", (error: { code?: string }) => error.code);
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(handleHostMessage(withdrawnMessage(G, "disable"), broker, state)).toBe(true);
    expect(() => broker.dispatch(spec(G), "tools/call", { name: "click" }, () => true)).toThrow(expect.objectContaining({ code: "host-off" }));
    expect(() => broker.dispatch(spec("ba9876543210"), "tools/call", { name: "click" }, () => true)).toThrow("in progress");
    expect(handleHostMessage(retiredMessage(G), broker, state)).toBe(true);
    expect(await Promise.race([outcome, new Promise(resolve => setTimeout(() => resolve("still-waiting"), 100))])).toBe("driver-exited");
    expect(start).toHaveBeenCalledTimes(1);
  });
  // The registered parent-port handler lives in server/index.ts, which only runs inside the Electron utility process
  // (no parent port in a test child), so this is a source pin, not a real-path witness (declared limit, PARTIAL).
  it("the harness entry routes every parent message through handleHostMessage with the broker, built before the early replay", () => {
    const source = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const lines = source.split("\n");
    const handler = lines.findIndex(line => /const onUtilityParentMessage = /.test(line));
    const routed = lines.findIndex(line => /if \(handleHostMessage\(message, hostComputer\)\) return;/.test(line));
    // r8: the broker comes from createHostComputerBroker (its cua-stuck / cua-integrity hooks are witnessed through that
    // factory in W-K6/W-K3), posting to the utility parent port
    const broker = lines.findIndex(line => /^const hostComputer = createHostComputerBroker\(message => utilityParentPort\?\.postMessage\(message\)\);/.test(line));
    const replay = lines.findIndex(line => /replayEarlyParentMessages\(onUtilityParentMessage/.test(line));
    expect(handler).toBeGreaterThan(0);
    expect(routed, "handleHostMessage(message, hostComputer) in the handler").toBeGreaterThan(handler);
    expect(routed - handler).toBeLessThan(8);
    expect(broker, "the broker comes from createHostComputerBroker posting to the parent port").toBeGreaterThan(0);
    expect(broker, "the broker exists before the handler can run").toBeLessThan(handler);
    expect(replay).toBeGreaterThan(routed);
  });
  it("a message that is not ours is not routed", () => {
    const { broker, state } = setup();
    expect(handleHostMessage({ type: "murage:other" }, broker, state)).toBe(false);
  });
});

// DESIGN 1022-cua-windows R17e W-K6 and R17b W-K3 (C8 / D16 a, D13), harness half. Entry: the harness's one broker,
// built by createHostComputerBroker (server/index.ts:2066 builds it the same way and posts to the utility parent port),
// with the REAL MCP transport (startHeadlessEngine) spawning a real child process. The child is a stand-in driver
// written here: it answers initialize and then, on tools/call, either exits (W-K6) or never answers and ignores the
// cancel (W-K3). The descriptor is linux-shaped with a generation so the win32 exe-pin check does not refuse the stand-in;
// the hooks are keyed on the generation, not the platform (win32 itself is W-R3 on the Windows runner). main's side (cua-stuck
// {G} -> D15 stop -> G+1, stale {G-1} ignored) is electron/cua-windows-runtime.test.mjs:426/:443.
describe("W-K6 / W-K3 a lost or unanswered started action: driver-lost, claim kept, cua-stuck {G} to main", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
  const G1 = "0123456789ab"; const G2 = "ba9876543210";
  const driver = (mode: "exit" | "silent" | "answer" | "error", generation: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "murage-wk6-")); dirs.push(dir);
    const script = path.join(dir, "stand-in-driver.mjs");
    fs.writeFileSync(script, `import { createInterface } from "node:readline";
const mode = ${JSON.stringify(mode)};
const say = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
process.on("SIGTERM", () => {});
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return say({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: {} } });
  if (message.method !== "tools/call") return;
  if (mode === "exit") process.exit(3);
  if (mode === "answer") say({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "clicked" }] } });
  if (mode === "error") say({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "stand-in refused" } });
});
setInterval(() => {}, 1000);
`);
    return { command: process.execPath, args: [script], env: {}, platform: "linux", generation };
  };
  const harness = () => {
    const posted: Array<{ type: string; generation?: string; at: number }> = [];
    const broker = createHostComputerBroker(message => posted.push({ ...(message as { type: string; generation?: string }), at: Date.now() }));
    return { posted, broker, state: createHostGateState() };
  };

  it("W-K6: the child exits after taking a click -> that call answers driver-lost 409 sent:true, the claim is kept, cua-stuck {G} is posted within 100 ms; retired:G frees it and the next call reaches the G+1 child", async () => {
    const { posted, broker, state } = harness();
    const call = broker.dispatch(driver("exit", G1), "tools/call", { name: "click" }, () => true);
    const error = await call.then(() => null, (failure: { status?: number; code?: string; sent?: boolean; at?: number }) => ({ ...failure, at: Date.now() })) as { status?: number; code?: string; sent?: boolean; at: number } | null;
    expect(error).toMatchObject({ status: 409, code: "driver-lost", sent: true });
    const stuck = posted.filter(message => message.type === "murage:cua-stuck");
    expect(stuck.map(message => message.generation)).toEqual([G1]);
    expect(Math.abs(stuck[0]!.at - error!.at)).toBeLessThan(100);
    // the daemon may still be acting: no other action starts until main confirms G is gone
    expect(() => broker.dispatch(driver("answer", G2), "tools/call", { name: "click" }, () => true)).toThrow("in progress");
    expect(handleHostMessage(retiredMessage(G1), broker, state)).toBe(true);
    await expect(broker.dispatch(driver("answer", G2), "tools/call", { name: "click" }, () => true)).resolves.toEqual({ content: [{ type: "text", text: "clicked" }] });
    await broker.drain();
  }, 20_000);

  it("W-K6 kept session: the same loss on a turn's kept connection answers driver-lost and posts cua-stuck {G} once", async () => {
    const { posted, broker } = harness();
    const turn = { key: JSON.stringify(["bot", "thread", "t1", 0]), owner: JSON.stringify(["bot", "thread"]) };
    await expect(broker.dispatch(driver("exit", G1), "tools/call", { name: "click" }, () => true, undefined, turn)).rejects.toMatchObject({ status: 409, code: "driver-lost", sent: true });
    expect(posted.filter(message => message.type === "murage:cua-stuck").map(message => message.generation)).toEqual([G1]);
    expect(() => broker.dispatch(driver("answer", G2), "tools/call", { name: "click" }, () => true)).toThrow("in progress");
  }, 20_000);

  it("W-K6 control: a driver that answers posts nothing and frees the computer", async () => {
    const { posted, broker } = harness();
    await expect(broker.dispatch(driver("answer", G1), "tools/call", { name: "click" }, () => true)).resolves.toEqual({ content: [{ type: "text", text: "clicked" }] });
    expect(posted).toEqual([]);
    await expect(broker.dispatch(driver("answer", G1), "tools/call", { name: "click" }, () => true)).resolves.toBeTruthy();
    await broker.drain();
  }, 20_000);

  it("W-K3: a Stop withdraws a click the driver never answers -> the caller gets cancelled at once; after the 10 s withdraw grace kill cua-stuck {G} is posted, the claim is kept until retired:G, then G+1 runs", async () => {
    const { posted, broker, state } = harness();
    const stop = new AbortController();
    const call = broker.dispatch(driver("silent", G1), "tools/call", { name: "click" }, () => true, stop.signal);
    const outcome = call.then(() => "ok", (failure: { code?: string }) => failure.code);
    await new Promise(resolve => setTimeout(resolve, 500));
    const stoppedAt = Date.now();
    stop.abort();
    expect(await outcome).toBe("cancelled");
    expect(posted).toEqual([]);
    await vi.waitFor(() => expect(posted.map(message => message.type)).toEqual(["murage:cua-stuck"]), { timeout: 14_000, interval: 100 });
    expect(posted[0]!.generation).toBe(G1);
    expect(posted[0]!.at - stoppedAt).toBeGreaterThanOrEqual(9_000);
    expect(() => broker.dispatch(driver("answer", G2), "tools/call", { name: "click" }, () => true)).toThrow("in progress");
    expect(handleHostMessage(retiredMessage(G1), broker, state)).toBe(true);
    await expect(broker.dispatch(driver("answer", G2), "tools/call", { name: "click" }, () => true)).resolves.toEqual({ content: [{ type: "text", text: "clicked" }] });
    await broker.drain();
  }, 30_000);

  // OPUS self-review r8 High: production always passes a turn session (server/index.ts host route), so W-K3 must hold on
  // the kept-session path too (M-K3s is the same mutant as M-K3 on that path).
  it("W-K3 kept session: a Stop withdraws a click on the turn's kept connection that the driver never answers -> cancelled at once, cua-stuck {G} after the grace kill, claim kept until retired:G", async () => {
    const { posted, broker, state } = harness();
    const stop = new AbortController();
    const turn = { key: JSON.stringify(["bot", "thread", "t3", 0]), owner: JSON.stringify(["bot", "thread"]) };
    const call = broker.dispatch(driver("silent", G1), "tools/call", { name: "click" }, () => true, stop.signal, turn);
    const outcome = call.then(() => "ok", (failure: { code?: string }) => failure.code);
    await new Promise(resolve => setTimeout(resolve, 500));
    const stoppedAt = Date.now();
    stop.abort();
    expect(await outcome).toBe("cancelled");
    await vi.waitFor(() => expect(posted.map(message => message.type)).toEqual(["murage:cua-stuck"]), { timeout: 14_000, interval: 100 });
    expect(posted[0]!.generation).toBe(G1);
    expect(posted[0]!.at - stoppedAt).toBeGreaterThanOrEqual(9_000);
    expect(() => broker.dispatch(driver("answer", G2), "tools/call", { name: "click" }, () => true)).toThrow("in progress");
    expect(handleHostMessage(retiredMessage(G1), broker, state)).toBe(true);
    await expect(broker.dispatch(driver("answer", G2), "tools/call", { name: "click" }, () => true)).resolves.toEqual({ content: [{ type: "text", text: "clicked" }] });
  }, 30_000);

  // OPUS self-review r8 Medium: only a LOST child is driver-lost. A driver that answers a JSON-RPC error and stays alive
  // keeps the old answer, posts nothing to main, and does not trigger a restart.
  it("W-K6 control: an error reply from a live driver is not driver-lost and posts nothing", async () => {
    const { posted, broker } = harness();
    const turn = { key: JSON.stringify(["bot", "thread", "t4", 0]), owner: JSON.stringify(["bot", "thread"]) };
    const failure = await broker.dispatch(driver("error", G1), "tools/call", { name: "click" }, () => true, undefined, turn).then(() => null, (error: { code?: string }) => error);
    expect(failure?.code).toBeUndefined();
    expect(posted).toEqual([]);
  }, 20_000);
});

// ASTRA precheck on caf3fd457a (r8) / board 4035 (W-K2 runtime-driven): both halves in one process, no hand-made
// messages. MAIN's half is the real Electron runtime (electron/cua-windows-runtime.cjs createWindowsCuaRuntime: its own
// state machine, D15 stop order and generation fence; only the daemon process, the OS probes and the native addon are
// faked, as in electron/cua-windows-runtime.test.mjs). The HARNESS half is the real broker from createHostComputerBroker
// and handleHostMessage. main's port posts go to handleHostMessage; the broker's hook posts go to
// runtime.onHarnessMessage (what main's proc.on("message") does via routeHarnessMessage). The per-turn MCP child is the
// real stand-in process through startHeadlessEngine.
describe("W-K2 / W-K6 runtime-driven: main's runtime and the harness broker wired to each other", () => {
  const requireCjs = createRequire(import.meta.url);
  const { createWindowsCuaRuntime } = requireCjs("../electron/cua-windows-runtime.cjs") as { createWindowsCuaRuntime: (options: Record<string, unknown>) => any };
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
  const MEDIUM = '"Mandatory Label\\Medium Mandatory Level","Label","S-1-16-8192","Mandatory group, Enabled by default, Enabled group"\r\n';
  const NO_TASKS = "INFO: No tasks are running which match the specified criteria.\r\n";
  const standIn = (mode: "exit" | "silent" | "answer", generation: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "murage-wk2rt-")); dirs.push(dir);
    const script = path.join(dir, "stand-in-driver.mjs");
    fs.writeFileSync(script, `import { createInterface } from "node:readline";
const say = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return say({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: {} } });
  if (message.method !== "tools/call") return;
  if (${JSON.stringify(mode)} === "exit") process.exit(3);
  if (${JSON.stringify(mode)} === "answer") say({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "clicked" }] } });
});
setInterval(() => {}, 1000);
`);
    return { command: process.execPath, args: [script], env: {}, platform: "linux", generation };
  };
  /** The daemon's exit is held until the test releases it, so "claim kept until the exit is confirmed" is observable. */
  const joined = () => {
    const toMain: string[] = []; const toHarness: string[] = [];
    const daemons: Array<{ pid: number; exit: () => void; emitter: import("node:events").EventEmitter & { pid: number; exitCode: number | null } }> = [];
    const heldExits: Array<() => void> = [];
    const state = createHostGateState();
    let runtime: any;
    const broker = createHostComputerBroker(message => { toMain.push(`${(message as { type: string }).type}`); runtime.onHarnessMessage(message, harnessProc); });
    const harnessProc = { postMessage: (message: unknown) => { toHarness.push(JSON.stringify(message)); handleHostMessage(message, broker, state); } };
    let nextPid = 7000;
    runtime = createWindowsCuaRuntime({
      resourcesPath: "C:\\R", runtimeDir: "C:\\U\\cua",
      preferenceStore: (() => { let value = false; return { read: () => value, write: (next: boolean) => { value = next; } }; })(),
      port: harnessProc,
      spawn: () => {
        const emitter = Object.assign(new (requireCjs("node:events").EventEmitter)(), { pid: nextPid++, exitCode: null as number | null });
        const exit = () => { if (emitter.exitCode === null) { emitter.exitCode = 0; emitter.emit("exit", 0); } };
        daemons.push({ pid: emitter.pid, exit, emitter });
        return emitter;
      },
      taskkill: (pid: number) => { const daemon = daemons.find(item => item.pid === pid); if (daemon) heldExits.push(daemon.exit); },
      runProbe: async () => ({ code: 0, stdout: MEDIUM }),
      runTasklist: async () => ({ code: 0, stdout: NO_TASKS }),
      native: { processStart: (pid: number) => String(132000000000000000n + BigInt(pid)), terminateIfStart: () => "unknown" },
      arm64: async () => false,
      verifyExeIdentity: async () => ({ ok: true, identity: { dev: "1", ino: "2", size: "3", mtimeNs: "4", ctimeNs: "5" } }),
      statIdentity: () => ({ dev: "1", ino: "2", size: "3", mtimeNs: "4", ctimeNs: "5" }),
      pins: { driver: "a".repeat(64), cursor: "b".repeat(64) },
      handshake: async () => true, writeDescriptor: () => {}, deleteDescriptor: () => {},
      fs: { files: new Map(), readFileSync() { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); }, writeFileSync() {}, rmSync() {}, mkdirSync() {} },
      clock: { now: () => Date.now(), setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id) },
      env: {}, processId: 4242,
      generationId: (() => { let n = 0; return () => { n += 1; return n.toString(16).padStart(12, "0"); }; })(),
    });
    const releaseExits = () => { for (const exit of heldExits.splice(0)) exit(); };
    return { runtime, broker, state, toMain, toHarness, daemons, heldExits, releaseExits, harnessProc };
  };
  const G1 = "000000000001"; const G2 = "000000000002";

  it("child loss under a click: the broker tells the runtime cua-stuck {G1}, the runtime withdraws G1 (claim kept while the daemon lives), retires it after the exit, starts G2, and the next call reaches the G2 child", async () => {
    const j = joined();
    await j.runtime.enable();
    await vi.waitFor(() => expect(j.runtime.getStatus()).toMatchObject({ status: "ready", generation: G1 }));
    j.runtime.onHarnessMessage({ type: "murage:host-desktop-ready" }, j.harnessProc);
    expect(j.state.liveGeneration).toBe(G1);
    const lost = await j.broker.dispatch(standIn("exit", G1), "tools/call", { name: "click" }, () => true).then(() => null, (error: { code?: string }) => error);
    expect(lost?.code).toBe("driver-lost");
    expect(j.toMain).toEqual(["murage:cua-stuck"]);
    // main's D15 stop: withdrawn reached the harness; the daemon has not exited yet, so the claim is still held
    await vi.waitFor(() => expect(j.heldExits).toHaveLength(1));
    expect(j.state.withdrawnCause(G1)).toBe("restart");
    expect(() => j.broker.dispatch(standIn("answer", G1), "tools/call", { name: "click" }, () => true)).toThrow(expect.objectContaining({ code: "host-off" }));
    expect(() => j.broker.dispatch(standIn("answer", G2), "tools/call", { name: "click" }, () => true)).toThrow("in progress");
    j.releaseExits();
    await vi.waitFor(() => expect(j.runtime.getStatus()).toMatchObject({ status: "ready", generation: G2 }));
    expect(j.toHarness.some(line => line.includes(`"retired":"${G1}"`))).toBe(true);
    const next = await Promise.resolve().then(() => j.broker.dispatch(standIn("answer", G2), "tools/call", { name: "click" }, () => true)).then(value => value, (error: { message?: string }) => error.message);
    expect(next, "the G2 call reaches the G2 child once G1 is retired").toEqual({ content: [{ type: "text", text: "clicked" }] });
    expect(j.daemons.map(item => item.pid)).toEqual([7000, 7001]);
  }, 20_000);

  it("owner Disable while a click waits in the G1 driver: the runtime's withdrawn refuses new G1 calls with host-off and keeps the claim; only after the daemon's confirmed exit does the waiting call answer driver-exited and the claim clear", async () => {
    const j = joined();
    await j.runtime.enable();
    await vi.waitFor(() => expect(j.runtime.getStatus()).toMatchObject({ status: "ready", generation: G1 }));
    j.runtime.onHarnessMessage({ type: "murage:host-desktop-ready" }, j.harnessProc);
    const waiting = j.broker.dispatch(standIn("silent", G1), "tools/call", { name: "click" }, () => true).then(() => "ok", (error: { code?: string }) => error.code);
    await new Promise(resolve => setTimeout(resolve, 500));
    const disabled = j.runtime.disable();
    await vi.waitFor(() => expect(j.heldExits).toHaveLength(1));
    expect(j.state.withdrawnCause(G1)).toBe("disable");
    expect(() => j.broker.dispatch(standIn("answer", G1), "tools/call", { name: "click" }, () => true)).toThrow(expect.objectContaining({ code: "host-off" }));
    expect(await Promise.race([waiting, new Promise(resolve => setTimeout(() => resolve("still-waiting"), 200))])).toBe("still-waiting");
    expect(() => j.broker.dispatch(standIn("answer", "0000000000ff"), "tools/call", { name: "click" }, () => true)).toThrow("in progress");
    j.releaseExits();
    await disabled;
    expect(await waiting).toBe("driver-exited");
    await expect(j.broker.dispatch(standIn("answer", "0000000000ff"), "tools/call", { name: "click" }, () => true)).resolves.toBeTruthy();
  }, 20_000);
});
