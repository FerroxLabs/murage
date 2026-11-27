// SPDX-License-Identifier: AGPL-3.0-or-later
// O1 m2 S1a (designs/1021-m2-w0 r3 D1.1/D1.6/D1.7, r3.2 A12): the W0 host process entry. It is spawned only by
// server/host/host-launch.ts on the HOSTED branch (never in a shipped build, F1), over an inherited IPC channel.
//
// Owners: both sides of the channel belong to the O1 m2 S1a builder lane (fix/1022-o1m2): this host and the
// coordinator-side launcher. The host holds no engine-bound content (D1.9) and has no parent-death signal (D1.6):
// it exits on channel EOF. The step-0 probe tests the exec gate and stdin handover before driver dispatch is enabled.
import "../../shared/win-hide-child-process.mjs";
import { spawn } from "node:child_process";
import { Socket } from "node:net";
import { isAbsolute } from "node:path";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { withHideInherit } from "../../shared/win-hide-child-process.mjs";
import { hostProcessIdentity } from "../bwrap-process.ts";
import { loadExclusionAddon } from "../engine-exclusion.ts";
import { launcherEnvironment } from "../launcher-environment.ts";

type HelloRequest = { type: "hello"; boot_id: string; inc: number };
type ExecProbe = { pid: number; start: string; cwd: string; release: Writable; handedOff: boolean; released: boolean };
const PROBE_SCRIPT = `process.stdout.write(JSON.stringify({
  pid: process.pid, ppid: process.ppid, cwd: process.cwd(), marker: process.env.FUIGO_EXEC_PROBE
}) + "\\n"); process.stdin.pipe(process.stdout);`;
const PROBE_ENV = { ELECTRON_RUN_AS_NODE: "1", FUIGO_EXEC_PROBE: "gate-released" };

// D1.7 condition (1), host side: the core-dump policy is applied before hello is answered (Linux also sets PR_SET_DUMPABLE 0).
let dumpsDisabled = false;
try { dumpsDisabled = loadExclusionAddon()?.disableCoreDumps?.() === true; } catch { dumpsDisabled = false; }

if (typeof process.send !== "function") {
  // Not launched over the inherited channel: there is no coordinator to answer, so the host refuses to run.
  process.exitCode = 2;
} else {
  let hello: HelloRequest | undefined;
  let probe: ExecProbe | undefined;
  const shutdown = () => {
    if (probe && hostProcessIdentity(probe.pid)?.start === probe.start) {
      try { process.kill(-probe.pid, "SIGKILL"); } catch { /* exited */ }
    }
    process.exit(0);
  };
  const reply = (message: object, handle?: Socket, sent?: () => void) => {
    if (!process.connected) return shutdown();
    process.send!(message, handle, { keepOpen: true }, error => {
      if (error) shutdown();
      else sent?.();
    });
  };
  process.on("message", (raw: unknown) => {
    const message = raw as { type?: string; boot_id?: string; inc?: number; pid?: number; cwd?: string } | null;
    if (message?.type === "shutdown") return shutdown();
    if (!hello && message?.type === "hello" && typeof message.boot_id === "string" && Number.isSafeInteger(message.inc)) {
      hello = { type: "hello", boot_id: message.boot_id, inc: message.inc! };
      reply({ ...hello, pid: process.pid, dumpsDisabled });
      return;
    }
    if (!message || !hello || message.boot_id !== hello.boot_id || message.inc !== hello.inc) return;
    const frame = { boot_id: hello.boot_id, inc: hello.inc };
    if (message.type === "probe_exec" && !probe && typeof message.cwd === "string" && isAbsolute(message.cwd)) {
      const cwd = message.cwd;
      const gate = fileURLToPath(new URL("./exec-gate.mjs", import.meta.url));
      const child = spawn(process.execPath, [gate, "--", process.execPath, "-e", PROBE_SCRIPT], withHideInherit({
        cwd: "/", env: launcherEnvironment(), detached: true, stdio: ["pipe", "pipe", "ignore", "pipe"],
      }));
      child.once("error", shutdown);
      const identity = child.pid ? hostProcessIdentity(child.pid) : undefined;
      const stdin = child.stdin;
      const release = child.stdio[3] as Writable | null;
      if (!identity || !(stdin instanceof Socket) || !release) {
        child.kill("SIGKILL");
        return shutdown();
      }
      const current: ExecProbe = { ...identity, cwd, release, handedOff: false, released: false };
      probe = current;
      release.on("error", shutdown);
      stdin.on("error", shutdown);
      let output = "";
      child.stdout!.setEncoding("utf8").on("data", chunk => { output += chunk; });
      child.once("close", code => reply({ type: "probe_result", ...frame, pid: current.pid, code, output }));
      reply({ type: "probe_spawned", ...frame, ...identity }, stdin, () => {
        stdin.once("close", () => {
          current.handedOff = true;
          reply({ type: "probe_handoff", ...frame, pid: current.pid });
        });
        stdin.destroy();
      });
    } else if (message.type === "release_gate" && probe && message.pid === probe.pid && probe.handedOff && !probe.released) {
      probe.released = true;
      const body = Buffer.from(JSON.stringify({ cwd: probe.cwd, env: PROBE_ENV }));
      const header = Buffer.alloc(4);
      header.writeUInt32BE(body.length);
      probe.release.end(Buffer.concat([header, body]));
    }
  });
  // D1.6: coordinator death closes the channel; the host exits without the coordinator.
  process.on("disconnect", shutdown);
}
