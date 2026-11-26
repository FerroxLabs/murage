// SPDX-License-Identifier: AGPL-3.0-or-later
// O1 m2 S1a (designs/1021-m2-w0 r3 D1.6/D1.7/D1.8): the coordinator side of the W0 host. It is loaded by a dynamic
// import() on the HOSTED branch only, so a production boot never evaluates it.
//
// Owners: both sides of the host channel and the custody producer belong to the O1 m2 S1a builder lane
// (fix/1022-o1m2). Order (D1.6): spawn, append the host's custody record (write + fsync), THEN send and accept hello.
// A host whose identity cannot be read gets no record, so it is killed and the boot stays COORDINATOR.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { withHideInherit } from "../../shared/win-hide-child-process.mjs";
import { hostProcessIdentity, hostProcessIsChild } from "../bwrap-process.ts";
import { appendCustodyRecord, kernelBootId, reapCustody } from "./custody.ts";

const sourceHostEntry = fileURLToPath(new URL("./host-main.ts", import.meta.url));
export const HOST_ENTRY = existsSync(sourceHostEntry) ? sourceHostEntry : fileURLToPath(new URL("./host/host-main.js", import.meta.url));
const HELLO_TIMEOUT_MS = 5_000;
const SHUTDOWN_GRACE_MS = 3_000;

export type HostHello = Readonly<{ ok: boolean; dumpsDisabled: boolean }>;
export type LaunchedHost = Readonly<{
  bootId: string;
  inc: number;
  child: ChildProcess;
  hello: () => Promise<HostHello>;
  probeExec: () => Promise<ExecProbeResult>;
  /** D1.8 quit: shutdown, wait up to 3 s, SIGKILL by exact identity, then reap custody. Resolves with the unresolved count. */
  shutdown: () => Promise<number>;
}>;

/**
 * D1.2 stdin handover: after the host reports the handoff, no fd of the host process may refer to the handed-over socket
 * (Linux: /proc/<host>/fd). "shared": a host fd still holds it, which refuses. "unconfirmed": the scan cannot be read (the
 * host is non-dumpable after r3.2 A12, so a coordinator without CAP_SYS_PTRACE gets EACCES; or no /proc). MAIN-RULING
 * 2026-11-22T15:22:59Z o1m2-D1.2-vs-A12 option (2): an unreadable scan accepts the host's close report, on Linux exactly as
 * on macOS; a host that never reports the close is refused as stdin_owner_unconfirmed (probeExec).
 */
export type StdinOwner = "sole" | "shared" | "unconfirmed";
export function soleStdinWriter(stdin: Socket, hostPid: number): StdinOwner {
  const fd = (stdin as unknown as { _handle?: { fd?: number } })._handle?.fd;
  if (process.platform !== "linux" || typeof fd !== "number" || fd < 0) return "unconfirmed";
  let socket: string;
  let entries: string[];
  try {
    socket = readlinkSync(`/proc/self/fd/${fd}`);
    entries = readdirSync(`/proc/${hostPid}/fd`);
  } catch {
    return "unconfirmed";
  }
  if (!socket.startsWith("socket:")) return "unconfirmed";
  let read = 0;
  for (const entry of entries) {
    let target: string;
    try { target = readlinkSync(`/proc/${hostPid}/fd/${entry}`); } catch (error) {
      // Only an fd closed during the scan is skipped. Any other error (EACCES: a reader that may list a non-dumpable
      // host's fds but not follow them) cannot confirm anything.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return "unconfirmed";
    }
    read++;
    if (target === socket) return "shared";
  }
  // A live host always has fds (its IPC channel at least); reading none confirms nothing.
  return read > 0 ? "sole" : "unconfirmed";
}

/** The exec-gate probe outcome; the boot maps every value but "ok" to COORDINATOR with the same id. */
export type ExecProbeResult = "ok" | "exec_gate_unavailable" | "stdin_owner_unconfirmed";

export function launchHostedHost(input: { dataDir: string; inc?: number; bootId?: string }): LaunchedHost {
  const bootId = input.bootId ?? randomUUID();
  const inc = input.inc ?? 1;
  const child = spawn(process.execPath, [HOST_ENTRY], withHideInherit({
    // The host leads its own group so the reap can prove the whole group gone; no parent-death signal (D1.6).
    detached: true, windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"], env: { ...process.env },
  }));
  child.stderr?.resume();
  // A late IPC write failure (EPIPE after the host died) is emitted as "error"; it must never become an uncaught exception.
  child.on("error", () => {});
  const exited = new Promise<void>(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once("exit", () => resolve()); });
  const spawned = new Promise<boolean>(resolve => { child.once("spawn", () => resolve(true)); child.once("error", () => resolve(false)); });
  let recorded: { pid: number; start: string } | undefined;
  let helloAccepted = false;

  const hello = async (): Promise<HostHello> => {
    const fail = { ok: false, dumpsDisabled: false } as const;
    if (!(await spawned) || !child.pid) return fail;
    const identity = hostProcessIdentity(child.pid);
    const kboot = kernelBootId();
    if (!identity || !kboot) { child.kill("SIGKILL"); return fail; }
    try {
      appendCustodyRecord(input.dataDir, { boot_id: bootId, kboot, inc, role: "host", pid: identity.pid, start: identity.start, pgid: identity.pid });
    } catch {
      // No durable record, no hello: the host is killed through its own handle before it can receive anything.
      child.kill("SIGKILL");
      return fail;
    }
    recorded = identity;
    return await new Promise<HostHello>(resolve => {
      const timer = setTimeout(() => { cleanup(); resolve(fail); }, HELLO_TIMEOUT_MS);
      const onMessage = (raw: unknown) => {
        const reply = raw as { type?: string; boot_id?: string; inc?: number; pid?: number; dumpsDisabled?: boolean } | null;
        // Frames of another boot or incarnation are ignored (D1.6 same-boot respawn rule).
        if (reply?.type !== "hello" || reply.boot_id !== bootId || reply.inc !== inc || reply.pid !== identity.pid) return;
        helloAccepted = true;
        cleanup();
        resolve({ ok: true, dumpsDisabled: reply.dumpsDisabled === true });
      };
      const onExit = () => { cleanup(); resolve(fail); };
      const cleanup = () => { clearTimeout(timer); child.off("message", onMessage); child.off("exit", onExit); };
      child.on("message", onMessage);
      child.once("exit", onExit);
      try { child.send({ type: "hello", boot_id: bootId, inc }); } catch { cleanup(); resolve(fail); }
    });
  };

  const probeExec = async (): Promise<ExecProbeResult> => {
    const parent = recorded;
    const kboot = kernelBootId();
    if (!helloAccepted || !parent || !kboot || !child.connected) return "exec_gate_unavailable";
    const cwd = realpathSync(input.dataDir);
    const pulse = "hosted-exec-probe\n";
    return await new Promise(resolve => {
      let stdin: Socket | undefined;
      let gate: { pid: number; start: string } | undefined;
      let released = false;
      const finish = (result: ExecProbeResult) => {
        clearTimeout(timer);
        child.off("message", onMessage);
        child.off("disconnect", onLost);
        stdin?.destroy();
        resolve(result);
      };
      const onLost = () => finish("exec_gate_unavailable");
      // D1.2 (MAIN-RULING o1m2-D1.2-vs-A12): a gate whose host never reported the stdin close is not confirmed.
      const timer = setTimeout(() => finish(gate && !released ? "stdin_owner_unconfirmed" : "exec_gate_unavailable"), HELLO_TIMEOUT_MS);
      const onMessage = (raw: unknown, handle: unknown) => {
        const reply = raw as { type?: string; boot_id?: string; inc?: number; pid?: number; start?: string; code?: number; output?: string } | null;
        const accepted = reply?.boot_id === bootId && reply.inc === inc;
        if (accepted && reply.type === "probe_spawned" && !gate && Number.isInteger(reply.pid) && typeof reply.start === "string" && handle instanceof Socket) {
          const identity = { pid: reply.pid!, start: reply.start };
          stdin = handle;
          stdin.on("error", onLost);
          if (!hostProcessIsChild(identity, parent)) return onLost();
          gate = identity;
          return;
        }
        if (handle instanceof Socket) handle.destroy();
        if (!accepted || !gate || reply.pid !== gate.pid || !stdin) return;
        if (reply.type === "probe_handoff" && !released) {
          // D1.2: probe_handoff is the host's close report (sent after its stdin "close"). No custody record and no release
          // while a readable scan shows the host still holding a copy of the engine's stdin writer; an unreadable scan
          // ("unconfirmed", the non-dumpable host) accepts the report (MAIN-RULING o1m2-D1.2-vs-A12 option (2)).
          if (soleStdinWriter(stdin, parent.pid) === "shared") return finish("exec_gate_unavailable");
          try {
            appendCustodyRecord(input.dataDir, { boot_id: bootId, kboot, inc, role: "engine", ...gate, pgid: gate.pid });
            released = true;
            child.send({ type: "release_gate", boot_id: bootId, inc, pid: gate.pid }, error => { if (error) onLost(); });
            stdin.end(pulse);
          } catch { onLost(); }
        } else if (reply.type === "probe_result" && released) {
          const expected = JSON.stringify({ pid: gate.pid, ppid: parent.pid, cwd, marker: "gate-released" }) + "\n" + pulse;
          finish(reply.code === 0 && reply.output === expected ? "ok" : "exec_gate_unavailable");
        }
      };
      child.on("message", onMessage);
      child.once("disconnect", onLost);
      try { child.send({ type: "probe_exec", boot_id: bootId, inc, cwd }, error => { if (error) onLost(); }); } catch { onLost(); }
    });
  };

  const shutdown = async (): Promise<number> => {
    if (child.connected) { try { child.send({ type: "shutdown" }); } catch { /* channel already closed */ } }
    let grace: NodeJS.Timeout | undefined;
    await Promise.race([exited, new Promise(resolve => { grace = setTimeout(resolve, SHUTDOWN_GRACE_MS); })]);
    clearTimeout(grace);
    if (child.exitCode === null && child.signalCode === null && recorded && hostProcessIdentity(recorded.pid)?.start === recorded.start) {
      try { process.kill(recorded.pid, "SIGKILL"); } catch { /* gone meanwhile */ }
      await exited;
    }
    return (await reapCustody(input.dataDir)).unresolved;
  };

  return Object.freeze({ bootId, inc, child, hello, probeExec, shutdown });
}
