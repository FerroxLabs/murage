// SPDX-License-Identifier: AGPL-3.0-or-later
// O1 m2 S1a witnesses for the W0 host and custody (designs/1021-m2-w0 r3 D1.6/D1.7/D1.8, r5 F3): T-W0-CUSTODY reap arms on
// real processes, and the real host process: custody record before hello, hello over the inherited channel, quit reap,
// and exit on channel EOF. Owner: O1 m2 S1a builder lane (fix/1022-o1m2). Every data dir here is a temporary directory.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { appendCustodyRecord, hostedCustodyPath, readCustodyRecords, reapCustody, reapDeps, type CustodyRecord } from "./custody.ts";
import { HOST_ENTRY, launchHostedHost } from "./host-launch.ts";
import { removeTempDir, waitForExit } from "../testing/cleanup.ts";
import { hostProcessIdentity } from "../bwrap-process.ts";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const dirs: string[] = [];
const children: ChildProcess[] = [], zombieGroups: number[] = [];
afterAll(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) await waitForExit(child, { signal: "SIGKILL" }); for (const pgid of zombieGroups) try { process.kill(-pgid, "SIGKILL"); } catch { /* gone */ }
  for (const dir of dirs) await removeTempDir(dir);
});
const dataDir = () => { const dir = mkdtempSync(join(tmpdir(), "murage-s1a-custody-")); dirs.push(dir); return dir; };
const startOf = (pid: number) => readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(/\s+/)[19]!;
const groupAlive = (pgid: number) => { try { process.kill(-pgid, 0); return true; } catch { return false; } };
async function detached(command: string, args: string[]): Promise<ChildProcess> {
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  children.push(child);
  await new Promise(resolve => child.once("spawn", resolve));
  return child;
}
/** Observe an exit without signalling (waitForExit would send its own SIGKILL). */
const exitedWithin = (child: ChildProcess, ms: number) => child.exitCode !== null || child.signalCode !== null
  ? Promise.resolve(true) : Promise.race([new Promise<boolean>(resolve => child.once("exit", () => resolve(true))), sleep(ms).then(() => false)]);
const kboot = () => readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
const record = (pid: number, start: string, role: CustodyRecord["role"] = "engine", recordKboot = kboot()): CustodyRecord => ({ boot_id: "fixture-boot", kboot: recordKboot, inc: 1, role, pid, start, pgid: pid });

describe.skipIf(process.platform !== "linux")("C5 exec gate through the host IPC channel", () => {
  const hostOnly = { FUIGO_GATE_TEST_CREDENTIAL: "fixture-credential", FUIGO_GATE_TEST_SETTING: "fixture-setting" };
  async function prepareProbe(dir: string, withMember = false) {
    const preload = join(dir, "observe-stdin.mjs");
    const trace = join(dir, "stdin-owner.json");
    const running = join(dir, "probe-running");
    const member = join(dir, "probe-member");
    writeFileSync(preload, `
import cp from "node:child_process";
import { readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const spawn = cp.spawn;
cp.spawn = function (...args) {
  const gate = args[1]?.some(arg => typeof arg === "string" && arg.endsWith("/exec-gate.mjs"));
  if (gate && ${withMember}) {
    args[1][args[1].length - 1] += ${JSON.stringify(`
const sibling = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 8000)"], { stdio: "ignore" });
require("node:fs").writeFileSync(${JSON.stringify(member)}, String(sibling.pid));
sibling.unref();
`)};
  }
  const child = spawn.apply(this, args);
  if (gate) {
    child.stdout.once("data", () => writeFileSync(${JSON.stringify(running)}, ""));
  }
  return child;
};
syncBuiltinESMExports();
if (process.send) {
  const send = process.send.bind(process);
  let socket;
  const fdTarget = fd => { try { return readlinkSync("/proc/self/fd/" + fd); } catch { return null; } };
  process.send = function (frame, handle, ...rest) {
    if (frame.type === "probe_spawned") socket = fdTarget(handle._handle.fd);
    if (frame.type === "probe_handoff") {
      const open = readdirSync("/proc/self/fd").some(fd => fdTarget(fd) === socket);
      const envPresent = Object.entries(${JSON.stringify(hostOnly)}).every(([key, value]) => process.env[key] === value);
      writeFileSync(${JSON.stringify(trace)}, JSON.stringify({ socket: typeof socket === "string" && socket.startsWith("socket:"), open, envPresent }));
    }
    return send(frame, handle, ...rest);
  };
}
`);
    const env = { ...hostOnly, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preload).href}`.trim() };
    const previous = Object.keys(env).map(key => [key, process.env[key]] as const);
    Object.assign(process.env, env);
    let host;
    try { host = launchHostedHost({ dataDir: dir }); }
    finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    children.push(host.child);
    expect((await host.hello()).ok).toBe(true);
    const envelope = { boot_id: host.bootId, inc: host.inc };
    const pending = new Promise<{ pid: number; start: string; stdin: Socket } | undefined>(resolve => {
      let gate: { pid: number; start: string; stdin: Socket } | undefined;
      const finish = () => {
        clearTimeout(timer);
        host.child.off("message", onMessage);
        resolve(gate);
      };
      const onMessage = (raw: unknown, handle: unknown) => {
        const message = raw as { type: string; pid: number; start: string };
        if (message.type === "probe_spawned" && handle instanceof Socket) {
          handle.on("error", () => {});
          gate = { pid: message.pid, start: message.start, stdin: handle };
        }
        if (message.type === "probe_handoff" && message.pid === gate?.pid) finish();
      };
      const timer = setTimeout(finish, 2_500);
      host.child.on("message", onMessage);
    });
    host.child.send({ type: "probe_exec", ...envelope, cwd: dir });
    return { host, envelope, gate: await pending, trace, running, member };
  }

  function gateState(pid: number) {
    const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(/\s+/);
    return { ppid: Number(fields[1]), pgid: Number(fields[2]), start: fields[19] };
  }
  const gateReleased = (pid: number) => readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes("FUIGO_EXEC_PROBE=gate-released");

  it("retains its pid, parent and process group across exec, with the environment delivered only after release", async () => {
    const dir = dataDir();
    const { host, envelope, gate, trace } = await prepareProbe(dir);
    try {
      expect(gate, "private IPC hands the coordinator a real stdin writer").toBeDefined();
      expect(existsSync(trace) ? JSON.parse(readFileSync(trace, "utf8")) : null, "host closes its own stdin writer before handoff").toEqual({ socket: true, open: false, envPresent: true });
      const { pid, start, stdin } = gate!;
      const expected = { ppid: host.child.pid, pgid: pid, start };
      expect(gateState(pid)).toEqual(expected);
      expect(realpathSync(`/proc/${pid}/exe`)).toBe(realpathSync(process.execPath));
      expect(gateReleased(pid), "gate environment before release").toBe(false);
      const gateKeys = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").map(entry => entry.split("=")[0]);
      expect(gateKeys.filter(key => key && Object.hasOwn(hostOnly, key)), "gate never inherits the host credential or turn key").toEqual([]);
      appendCustodyRecord(dir, record(pid, start));
      host.child.send({ type: "release_gate", ...envelope, pid });
      await vi.waitFor(() => expect(gateReleased(pid), "engine environment after exec").toBe(true));
      expect(gateState(pid), "same process after exec").toEqual(expected);
      const result = new Promise(resolve => host.child.once("message", resolve));
      stdin.end("fixture-probe\n");
      expect(await result).toMatchObject({ type: "probe_result", pid, code: 0,
        output: JSON.stringify({ pid, ppid: host.child.pid, cwd: dir, marker: "gate-released" }) + "\nfixture-probe\n" });
    } finally {
      gate?.stdin.destroy();
      await host.shutdown();
    }
  }, 15_000);

  it("kills the released process group when the host loses its coordinator channel", async () => {
    const dir = dataDir();
    const { host, envelope, gate, running, member } = await prepareProbe(dir, true);
    try {
      expect(gate, "gate running before the channel closes").toBeDefined();
      const { pid, start } = gate!;
      appendCustodyRecord(dir, record(pid, start));
      host.child.send({ type: "release_gate", ...envelope, pid });
      await vi.waitFor(() => expect(existsSync(running), "fixture wrote its startup frame before disconnect").toBe(true));
      await vi.waitFor(() => expect(existsSync(member), "fixture spawned a second group member").toBe(true));
      const memberPid = Number(readFileSync(member, "utf8"));
      expect(gateState(memberPid).pgid).toBe(pid);
      host.child.disconnect();
      await vi.waitFor(() => expect([pid, memberPid].map(id => existsSync(`/proc/${id}/exe`)), "released group died with its host channel").toEqual([false, false]));
    } finally {
      gate?.stdin.destroy();
      await host.shutdown();
    }
  }, 15_000);

  it("leaves no running gate when the host is killed before release", async () => {
    const { host, gate } = await prepareProbe(dataDir());
    try {
      expect(gate, "gate running before host death").toBeDefined();
      const { pid } = gate!;
      expect(gateReleased(pid), "host death cuts the gate before exec").toBe(false);
      host.child.kill("SIGKILL");
      await vi.waitFor(() => expect(existsSync(`/proc/${pid}/exe`), "unreleased gate ended on fd 3 EOF").toBe(false));
    } finally {
      if (gate && hostProcessIdentity(gate.pid)?.start === gate.start) process.kill(gate.pid, "SIGKILL");
      gate?.stdin.destroy();
      await host.shutdown();
    }
  }, 15_000);
});

describe.skipIf(process.platform !== "linux")("T-W0-CUSTODY reap (D1.6, real processes)", () => {
  it("does nothing and creates nothing when the custody file is absent", async () => {
    const dir = dataDir();
    expect(await reapCustody(dir)).toEqual({ reaped: 0, unresolved: 0 });
    expect(existsSync(hostedCustodyPath(dir))).toBe(false);
  });

  it("kills a live executor whose start token matches, then drops the record and removes the file", async () => {
    const dir = dataDir();
    const child = await detached("sleep", ["300"]);
    appendCustodyRecord(dir, record(child.pid!, startOf(child.pid!)));
    expect(await reapCustody(dir)).toEqual({ reaped: 1, unresolved: 0 });
    expect(await exitedWithin(child, 5_000)).toBe(true);
    expect(child.signalCode).toBe("SIGKILL");
    expect(existsSync(hostedCustodyPath(dir))).toBe(false);
  });

  it("drops a record whose pid is alive with a different start token (a reused number) without killing it", async () => {
    const dir = dataDir();
    const child = await detached("sleep", ["300"]);
    appendCustodyRecord(dir, record(child.pid!, `${startOf(child.pid!)}0`));
    expect(await reapCustody(dir)).toEqual({ reaped: 1, unresolved: 0 });
    expect(await exitedWithin(child, 300)).toBe(false);
    expect(existsSync(hostedCustodyPath(dir))).toBe(false);
  });

  // Opus H1: a pid or group number from another kernel boot may now belong to an unrelated process; it is never signalled.
  it("drops a record from another kernel boot without signalling the process that now has its number", async () => {
    const dir = dataDir();
    const child = await detached("sleep", ["300"]);
    appendCustodyRecord(dir, record(child.pid!, startOf(child.pid!), "engine", "00000000-0000-4000-8000-000000000000"));
    expect(await reapCustody(dir)).toEqual({ reaped: 1, unresolved: 0 });
    expect(await exitedWithin(child, 300)).toBe(false);
    expect(existsSync(hostedCustodyPath(dir))).toBe(false);
  });

  it("kills the surviving group when the recorded leader is gone but a member lives", async () => {
    const dir = dataDir();
    const leader = await detached("sh", ["-c", "sleep 300 & wait"]);
    const pgid = leader.pid!;
    appendCustodyRecord(dir, record(pgid, startOf(pgid)));
    await sleep(100);
    process.kill(pgid, "SIGKILL");
    expect(await exitedWithin(leader, 5_000)).toBe(true);
    expect(groupAlive(pgid)).toBe(true);
    expect(await reapCustody(dir)).toEqual({ reaped: 1, unresolved: 0 });
    for (let i = 0; i < 100 && groupAlive(pgid); i++) await sleep(50);
    expect(groupAlive(pgid)).toBe(false);
  });

  // Opus r2 M (zombie): a recorded group leader whose parent never reaps it stays a zombie. kill(-pgid, 0) still succeeds,
  // but SIGKILL cannot remove a zombie, so before r3 the record stayed unresolved (admission closed) for the whole boot.
  // The parent here blocks its event loop after the spawn, so it never collects the leader's exit status.
  async function zombieLeader(script: string): Promise<number> {
    const parent = spawn(process.execPath, ["-e", `const c = require("node:child_process").spawn("sh", ["-c", process.argv[1]], { detached: true, stdio: "ignore" });
c.on("spawn", () => { require("node:fs").writeSync(1, c.pid + "\\n"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); });`, script], { stdio: ["ignore", "pipe", "ignore"] });
    children.push(parent);
    const pid = Number(await new Promise<string>(resolve => parent.stdout!.once("data", chunk => resolve(String(chunk)))));
    for (let i = 0; i < 100 && !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8")); i++) await sleep(50);
    expect(readFileSync(`/proc/${pid}/stat`, "utf8"), "fixture: the leader is a zombie").toMatch(/^\d+ \(.*\) Z /);
    zombieGroups.push(pid); return pid;
  }

  it("drops a record whose group is only a zombie leader (nothing left that SIGKILL could remove)", async () => {
    const dir = dataDir();
    const pid = await zombieLeader("exit 0");
    appendCustodyRecord(dir, record(pid, startOf(pid)));
    expect(await reapCustody(dir, reapDeps, 500)).toEqual({ reaped: 1, unresolved: 0 });
    expect(existsSync(hostedCustodyPath(dir))).toBe(false);
  });

  it("still kills a live member of a group whose recorded leader is a zombie", async () => {
    const dir = dataDir();
    const pid = await zombieLeader("sleep 300 & exit 0");
    appendCustodyRecord(dir, record(pid, startOf(pid)));
    const member = () => readdirSync("/proc").filter(name => /^\d+$/.test(name)).some(name => {
      try { const fields = readFileSync(`/proc/${name}/stat`, "utf8").split(") ")[1]!.split(" "); return Number(fields[2]) === pid && fields[0] !== "Z"; } catch { return false; }
    });
    expect(member(), "fixture: a live member").toBe(true);
    expect(await reapCustody(dir)).toEqual({ reaped: 1, unresolved: 0 });
    for (let i = 0; i < 100 && member(); i++) await sleep(50);
    expect(member(), "live member killed").toBe(false);
  });

  it("keeps an unresolved record in the file after the pass budget", async () => {
    const dir = dataDir();
    appendCustodyRecord(dir, record(424_242, "1"));
    const stuck = { ...reapDeps, identity: (pid: number) => ({ pid, start: "1" }), kill: () => {} };
    expect(await reapCustody(dir, stuck, 120)).toEqual({ reaped: 0, unresolved: 1 });
    expect(readCustodyRecords(dir)).toEqual([record(424_242, "1")]);
  });
});

describe.skipIf(process.platform !== "linux")("W0 host process (D1.6 order, D1.7 hello, D1.8 quit)", () => {
  it("refuses to run when not launched over the inherited channel", () => {
    const run = spawnSync(process.execPath, [HOST_ENTRY], { encoding: "utf8", timeout: 30_000 });
    expect(run.status).toBe(2);
  });

  it("appends the host custody record before hello is sent, answers hello for this boot, and quit reaps the record", async () => {
    const dir = dataDir();
    const host = launchHostedHost({ dataDir: dir, bootId: "fixture-boot-1" });
    children.push(host.child);
    const recordedAtHello: CustodyRecord[][] = [];
    const send = host.child.send.bind(host.child);
    host.child.send = ((message: unknown, ...rest: never[]) => {
      if ((message as { type?: string })?.type === "hello") recordedAtHello.push(readCustodyRecords(dir));
      return send(message as never, ...rest);
    }) as typeof host.child.send;
    const hello = await host.hello();
    expect(hello.ok).toBe(true);
    const pid = host.child.pid!;
    const expected = { boot_id: "fixture-boot-1", kboot: kboot(), inc: 1, role: "host", pid, start: startOf(pid), pgid: pid };
    expect(recordedAtHello).toEqual([[expected]]);
    expect(readCustodyRecords(dir)).toEqual([expected]);
    expect(await host.shutdown()).toBe(0);
    expect(await exitedWithin(host.child, 5_000)).toBe(true);
    expect(existsSync(hostedCustodyPath(dir))).toBe(false);
  }, 30_000);

  it("ignores a hello reply for another boot: hello waits for its own boot id", async () => {
    const dir = dataDir();
    const host = launchHostedHost({ dataDir: dir, bootId: "fixture-boot-2" });
    children.push(host.child);
    const send = host.child.send.bind(host.child);
    // The coordinator asks for boot 2, but the frame on the wire names another boot: the host's reply must not satisfy hello.
    host.child.send = ((message: unknown, ...rest: never[]) => send({ ...(message as object), boot_id: "other-boot" } as never, ...rest)) as typeof host.child.send;
    const started = Date.now();
    expect(await host.hello(), "other boot").toEqual({ ok: false, dumpsDisabled: false });
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_500);
    expect(await host.shutdown()).toBe(0);
  }, 30_000);

  // Opus H3: a hello reply of another incarnation or another pid does not satisfy hello.
  it("ignores a hello reply for another incarnation", async () => {
    const host = launchHostedHost({ dataDir: dataDir(), inc: 2 });
    children.push(host.child);
    const send = host.child.send.bind(host.child);
    host.child.send = ((message: unknown, ...rest: never[]) => send({ ...(message as object), inc: 1 } as never, ...rest)) as typeof host.child.send;
    expect(await host.hello(), "other incarnation").toEqual({ ok: false, dumpsDisabled: false });
    expect(await host.shutdown()).toBe(0);
  }, 30_000);

  it("ignores a hello reply that names another pid than the recorded host", async () => {
    const host = launchHostedHost({ dataDir: dataDir() });
    children.push(host.child);
    const emit = host.child.emit.bind(host.child) as (event: string | symbol, ...args: unknown[]) => boolean;
    host.child.emit = ((event: string | symbol, ...args: unknown[]) => event === "message"
      ? emit(event, { ...(args[0] as object), pid: (args[0] as { pid: number }).pid + 1 }, ...args.slice(1)) : emit(event, ...args)) as typeof host.child.emit;
    expect(await host.hello(), "other pid").toEqual({ ok: false, dumpsDisabled: false });
    expect(await host.shutdown()).toBe(0);
  }, 30_000);

  it("exits on channel EOF", async () => {
    const dir = dataDir();
    const host = launchHostedHost({ dataDir: dir });
    children.push(host.child);
    expect((await host.hello()).ok).toBe(true);
    host.child.disconnect();
    expect(await exitedWithin(host.child, 5_000)).toBe(true);
    expect(host.child.exitCode).toBe(0);
    expect(await reapCustody(dir)).toEqual({ reaped: 1, unresolved: 0 });
  }, 30_000);

  // D1.6 coordinator death: a real coordinator process launches the host and is SIGKILLed; the host must go by itself
  // (nothing else signals it), and the next boot's reap finds its record and drops it.
  it("exits by itself when its coordinator is SIGKILLed", async () => {
    const dir = dataDir();
    const script = `const { launchHostedHost } = await import(${JSON.stringify(new URL("./host-launch.ts", import.meta.url).href)});
      const host = launchHostedHost({ dataDir: ${JSON.stringify(dir)} });
      const hello = await host.hello();
      console.log(JSON.stringify({ ok: hello.ok, pid: host.child.pid }));
      setInterval(() => {}, 1000);`;
    const coordinator = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
    children.push(coordinator);
    const first = await new Promise<string>(resolve => { let out = ""; coordinator.stdout!.on("data", chunk => { out += chunk; if (out.includes("\n")) resolve(out); }); });
    const { ok, pid } = JSON.parse(first) as { ok: boolean; pid: number };
    expect(ok).toBe(true);
    const start = startOf(pid);
    coordinator.kill("SIGKILL");
    let alive = true;
    for (let i = 0; i < 100 && alive; i++) { await sleep(50); try { alive = startOf(pid) === start && !/^\S+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { alive = false; } }
    expect(alive).toBe(false);
    expect(await reapCustody(dir)).toEqual({ reaped: 1, unresolved: 0 });
  }, 30_000);
});
