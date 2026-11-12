import { withHideInherit } from "../shared/win-hide-child-process.mjs";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Ownership-bound shutdown. Recorded process numbers are observations, never signal targets.
import { readFileSync, readlinkSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import type { AgentBrowserSpec } from "./browser-engine.ts";
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
export class OwnedCloseError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code === "orphans_remain"
      ? "Some browser helpers from a window that stopped unexpectedly are still running. Murage left them alone. Close them yourself or restart your computer."
      : ["ownership_unproven", "launch_mismatch", "engine_mismatch"].includes(code)
        ? "Murage could not confirm this browser window is the one it opened, so it left it running. Close the window yourself, then try again."
        : "The browser window is still closing. Try again in a moment.");
    this.name = "OwnedCloseError";
    this.code = code;
  }
}
export const ownedCloseCli = {
  run(spec: AgentBrowserSpec, launchId: string | null): Promise<{ code: number; stdout: string }> {
    const args = ["close-owned", "--session", spec.env.AGENT_BROWSER_SESSION!];
    if (launchId !== null) args.push("--launch-id", launchId);
    args.push("--json");
    return new Promise((resolve, reject) => {
      execFile(spec.command, [...args], withHideInherit({ env: spec.env, cwd: spec.env.HOME, windowsHide: true,
        timeout: 45_000, maxBuffer: 65536, encoding: "utf8" }), (error, stdout) => {
        if (error && typeof error.code !== "number") return reject(new OwnedCloseError("tree_lingering"));
        resolve({ code: error?.code as number ?? 0, stdout });
      });
    });
  },
};

export async function closeOwnedBrowser(spec: AgentBrowserSpec, pid: number | null): Promise<void> {
  const dir = spec.env.AGENT_BROWSER_SOCKET_DIR;
  const session = spec.env.AGENT_BROWSER_SESSION;
  const supplied = spec.env.AGENT_BROWSER_LAUNCH_ID;
  if (!dir || !session || (supplied !== undefined && !/^[0-9a-f]{16}$/u.test(supplied))) throw new OwnedCloseError("ownership_unproven");
  let owner: Owner | undefined;
  try { owner = JSON.parse(readFileSync(join(dir, `${session}.owner.json`), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || supplied !== undefined) throw new OwnedCloseError("ownership_unproven");
  }
  if (owner !== undefined && (owner === null || owner.v !== 1 || owner.session !== session || !owner.daemon
    || !Number.isSafeInteger(owner.daemon.pid) || owner.daemon.pid <= 0 || !owner.daemon.start || !owner.daemon.exe
    || !(owner.launchId === null || typeof owner.launchId === "string" && /^[0-9a-f]{16}$/u.test(owner.launchId)))) throw new OwnedCloseError("ownership_unproven");
  if (owner && supplied !== undefined && owner.launchId !== supplied) throw new OwnedCloseError("launch_mismatch");
  const expected = supplied ?? owner?.launchId ?? null;
  const legacy = owner === undefined && expected === null;
  const first = legacy && pid !== null ? identity(pid) : null;
  const { code, stdout } = await ownedCloseCli.run(spec, expected);
  let proof;
  try { proof = JSON.parse(stdout); } catch { throw new OwnedCloseError("ownership_unproven"); }
  if (proof.launchId !== expected) throw new OwnedCloseError("launch_mismatch");
  if (code !== 0) throw new OwnedCloseError(typeof proof.error === "string" ? proof.error : "ownership_unproven");
  if (proof.closed !== true || proof.groupExhausted !== true || proof.outsideSeen !== 0 || proof.unconfirmed !== null
    || (!legacy && expected !== null && ownedClosePlatform.current() === "linux" && proof.treeExhausted !== true)) throw new OwnedCloseError("tree_lingering");
  if (first) {
    const deadline = Date.now() + 70_000;
    while (same(first)) {
      if (Date.now() >= deadline) throw new OwnedCloseError("daemon_unresponsive");
      await pause();
    }
  }
}
