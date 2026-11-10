// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Ownership-bound shutdown. Recorded process numbers are observations, never signal targets.
import { readFileSync, readlinkSync, realpathSync } from "node:fs";
import { connect } from "node:net";
import { execFile } from "node:child_process";
import { join } from "node:path";
import type { AgentBrowserSpec } from "./browser-engine.ts";
import { closeDaemonSession, controlTokenFrom } from "./browser-control-token.ts";
import { loadExclusionAddon } from "./engine-exclusion.ts";
import { nativeProcessList } from "./drivers/win-process-table.ts";

type Identity = { pid: number; start: string; exe: string };
type Owner = { v: number; session: string; launchId: string | null; daemon: Identity; group: { kind: string; name?: string } };
export const ownedClosePlatform = { current: (): NodeJS.Platform => process.platform };
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
const unknown = () => new Error("Browser ownership is unconfirmed; try closing it again");
function identity(pid: number): Identity | null {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/u);
      if (fields.length < 20) throw unknown();
      if (fields[0] === "Z") return null;
      return { pid, start: `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${fields[19]}`, exe: readlinkSync(`/proc/${pid}/exe`) };
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  const list = nativeProcessList();
  if (!list) throw unknown();
  const entry = list.find(row => row.pid === pid);
  if (!entry) return null;
  if (typeof entry.start !== "number" || !entry.exe) throw unknown();
  const start = process.platform === "darwin"
    ? `${Math.floor(entry.start)}.${String(Math.round((entry.start % 1) * 1e6)).padStart(6, "0")}`
    : loadExclusionAddon()?.processStart?.(pid);
  if (!start) throw unknown();
  return { pid, start, exe: entry.exe };
}
function same(expected: Identity): boolean {
  const actual = identity(expected.pid);
  return actual !== null && actual.start === expected.start && actual.exe === expected.exe;
}
function stopChannel(path: string, launchId: string | null): Promise<void> {
  return new Promise((resolve, reject) => {
    let pending = ""; let settled = false;
    const socket = connect({ path }, () => socket.write(JSON.stringify({ launchId }) + "\n"));
    const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); if (error) reject(error); else resolve(); };
    const timer = setTimeout(() => finish(unknown()), 15_000);
    socket.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(pending) + chunk.length > 65536) return finish(unknown());
      pending += chunk.toString("utf8");
      if (!pending.includes("\n")) return;
      try {
        const reply = JSON.parse(pending.slice(0, pending.indexOf("\n")));
        if (reply.launchId !== launchId || reply.groupExhausted !== true || reply.outsideSeen !== 0 || reply.unconfirmed != null
          || (process.platform === "linux" && launchId !== null && reply.treeExhausted !== true)) return finish(unknown());
        finish();
      } catch { finish(unknown()); }
    });
    socket.on("error", () => finish(unknown()));
    socket.on("close", () => finish(unknown()));
  });
}

export async function closeOwnedBrowser(spec: AgentBrowserSpec, pid: number | null): Promise<void> {
  const dir = spec.env.AGENT_BROWSER_SOCKET_DIR!;
  const session = spec.env.AGENT_BROWSER_SESSION!;
  let owner: Owner;
  try { owner = JSON.parse(readFileSync(join(dir, `${session}.owner.json`), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw unknown();
    // Older engines have no ownership channel. Observe their idle exit only.
    if (pid === null) return;
    const first = identity(pid);
    if (!first) return;
    const deadline = Date.now() + 70_000;
    while (Date.now() < deadline) { if (!same(first)) return; await pause(); }
    throw unknown();
  }
  if (owner.v !== 1 || owner.session !== session || !owner.daemon || !Number.isSafeInteger(owner.daemon.pid) || owner.daemon.pid <= 0
    || typeof owner.daemon.start !== "string" || typeof owner.daemon.exe !== "string"
    || !(owner.launchId === null || /^[0-9a-f]{16}$/u.test(owner.launchId))) throw unknown();
  if (spec.env.AGENT_BROWSER_LAUNCH_ID && owner.launchId !== spec.env.AGENT_BROWSER_LAUNCH_ID) throw unknown();
  // A named job is itself the pinned authority, including after daemon death.
  const windows = ownedClosePlatform.current() === "win32";
  if (!windows && (!same(owner.daemon) || owner.daemon.exe !== realpathSync(spec.command))) throw unknown();
  let closeError: unknown;
  try {
    const endpoint = windows
      ? { host: "127.0.0.1", port: Number(readFileSync(join(dir, `${session}.port`), "utf8")) }
      : { path: join(dir, `${session}.sock`) };
    await closeDaemonSession(endpoint, windows ? controlTokenFrom(spec.env) : undefined, { launchId: owner.launchId, requireSaved: false });
    return;
  } catch (error) { closeError = error; }
  try {
    if (windows) {
      const expectedName = `Local\\agent-browser-${owner.launchId ?? `${session}-${owner.daemon.pid}`}`;
      if (owner.group?.kind !== "job" || owner.group.name !== expectedName) throw unknown();
      await new Promise<void>((resolve, reject) => {
        // This maintenance command opens the recorded job and never starts a daemon.
        execFile(spec.command, ["launch-group", "--owner-file", join(dir, `${session}.owner.json`), "--stop"], {
          env: spec.env, cwd: spec.env.HOME, windowsHide: true, timeout: 15_000, maxBuffer: 65536, encoding: "utf8",
        }, (error, stdout) => {
          if (error) return reject(unknown());
          try {
            const proof = JSON.parse(stdout);
            if (proof.launchId !== owner.launchId || proof.groupExhausted !== true || proof.treeExhausted !== true
              || proof.outsideSeen !== 0 || proof.unconfirmed != null) return reject(unknown());
            resolve();
          } catch { reject(unknown()); }
        });
      });
    } else {
      if (!same(owner.daemon)) throw unknown();
      await stopChannel(join(dir, `${session}.stop`), owner.launchId);
    }
  } catch (cause) { throw new AggregateError([closeError, cause], "Browser ownership is unconfirmed; try closing it again"); }
}
