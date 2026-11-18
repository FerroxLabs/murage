// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.19: the meter's private murage-meter-* addon copy is removed at exit and, at startup, when its process is dead. Each guard has its own witness.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import Module from "node:module";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ADDON_VERSION, HANDLE_FUNCTIONS, WINDOWS_NATIVE_FUNCTIONS, loadIoMeterAddon } from "./engine-exclusion.ts";
import { METER_COPY_FILE, METER_COPY_MARKER, ownerIsDead, realCleanupHost, removeOwnCopyDir, sweepStaleMeterCopies, writeCopyMarker, type CleanupHost } from "./meter-copy-cleanup.ts";
import { safeWipeSync } from "./testing/safe-wipe.mjs";

const standIn = `const f = () => 0; module.exports = { version: () => ${ADDON_VERSION}, lock: f, processes: f, renameNoReplace: f, writers: f, fullSync: f, ioMeterAdd: f, ioMeterTotal: f, ioMeterBytes: f }; for (const name of ${JSON.stringify([...HANDLE_FUNCTIONS, ...WINDOWS_NATIVE_FUNCTIONS])}) module.exports[name] ??= f;`;
const saved = { ...process.env };
const exts = (Module as unknown as { _extensions: Record<string, (m: { _compile(c: string, f: string): void }, f: string) => void> })._extensions;
const nativeLoader = exts[".node"];
let base = "", src = "";
const kids: ChildProcess[] = [];
const toWipe: string[] = [];
beforeEach(() => {
  exts[".node"] = (m, f) => { m._compile(readFileSync(f, "utf8"), f); };
  base = realpathSync(mkdtempSync(join(tmpdir(), "meter-cleanup-")));
  src = join(base, "stand-in.node"); writeFileSync(src, standIn);
  delete process.env.MURAGE_RESOURCES_PATH; delete process.env.OMB_RESOURCES_PATH; delete process.env.MURAGE_PACKAGED; process.env.NODE_ENV = "test";
});
afterEach(() => {
  exts[".node"] = nativeLoader!;
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  for (const kid of kids.splice(0)) { try { if (kid.pid) process.kill(kid.pid); } catch { /* gone */ } }
  for (const dir of toWipe.splice(0)) safeWipeSync(dir, { tmpdir: dirname(dir) });
  safeWipeSync(base, { tmpdir: dirname(base) });
});

const sleeper = (): ChildProcess => { const kid = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" }); kids.push(kid); return kid; };
async function deadPid(): Promise<number> {
  const kid = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise(resolve => kid.once("exit", resolve));
  return kid.pid!;
}
const folder = (parent: string, name: string, marker: object | null, uid?: number): string => {
  const dir = join(parent, name); mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(dir, METER_COPY_FILE), "x");
  if (marker) writeFileSync(join(dir, METER_COPY_MARKER), JSON.stringify(marker));
  void uid; return dir;
};
const host = (over: Partial<CleanupHost> = {}): CleanupHost => ({ ...realCleanupHost(), ...over });
const startOfLive = (pid: number): string | null => realCleanupHost().startOf(pid);

it("own copy: the exit hook removes this process's murage-meter-* folder", () => {
  const before = new Set(process.listeners("exit"));
  process.env.MURAGE_ENGINE_EXCLUSION_PATH = src;
  const loaded = loadIoMeterAddon()!;
  expect(loaded).not.toBeNull();
  const dir = dirname(loaded.path); toWipe.push(dir);
  expect(existsSync(dir)).toBe(true);
  expect(JSON.parse(readFileSync(join(dir, METER_COPY_MARKER), "utf8")).pid).toBe(process.pid);
  const added = process.listeners("exit").filter(l => !before.has(l));
  expect(added.length, "one exit hook registered for the copy").toBe(1);
  (added[0] as () => void)();
  for (const l of added) process.off("exit", l as () => void);
  expect(existsSync(dir), "the folder is gone after the hook").toBe(false);
});
it("startup: a dead process's folder in the temp directory is removed by the first load; live, wrong-prefix and linked ones stay", async () => {
  const dead = await deadPid(), live = sleeper().pid!;
  const root = tmpdir();
  const staleDir = folder(root, "murage-meter-" + "Dd1Zz9", { v: 1, pid: dead, start: null });
  const liveDir = folder(root, "murage-meter-" + "Ll2Yy8", { v: 1, pid: live, start: startOfLive(live) });
  const wrong = folder(root, "murage-metre-" + "Ww3Xx7", { v: 1, pid: dead, start: null });
  const target = folder(base, "target-dir", { v: 1, pid: dead, start: null });
  const alias = join(root, "murage-meter-" + "Aa4Vv6"); symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
  toWipe.push(staleDir, liveDir, wrong, alias);
  process.env.MURAGE_ENGINE_EXCLUSION_PATH = src;
  const before = new Set(process.listeners("exit"));
  vi.resetModules(); // the sweep runs once per module instance: a fresh one is "the next start"
  const fresh = await import("./engine-exclusion.ts");
  const loaded = fresh.loadIoMeterAddon()!; toWipe.push(dirname(loaded.path));
  for (const l of process.listeners("exit")) if (!before.has(l)) process.off("exit", l as () => void);
  expect(existsSync(staleDir), "stale dead-pid folder removed").toBe(false);
  expect(existsSync(liveDir), "live-pid folder kept").toBe(true);
  expect(existsSync(wrong), "wrong prefix kept").toBe(true);
  expect(existsSync(join(target, METER_COPY_FILE)), "the alias target was not followed").toBe(true);
  expect(existsSync(alias)).toBe(true);
});
it("guard liveness: a folder whose pid is alive is never removed", () => {
  const live = sleeper().pid!;
  const dir = folder(base, "murage-meter-Lv1Aa1", { v: 1, pid: live, start: startOfLive(live) });
  expect(sweepStaleMeterCopies([base], null, host())).toEqual([]);
  expect(existsSync(dir)).toBe(true);
});
it("guard liveness: a reused pid (alive, other start time) counts as dead; an unreadable start counts as alive", () => {
  const live = sleeper().pid!;
  expect(ownerIsDead({ v: 1, pid: live, start: "1" }, host({ startOf: () => "2" }))).toBe(true);
  expect(ownerIsDead({ v: 1, pid: live, start: "1" }, host({ startOf: () => null }))).toBe(false);
  expect(ownerIsDead({ v: 1, pid: live, start: null }, host({ startOf: () => "2" }))).toBe(false);
  expect(ownerIsDead({ v: 1, pid: process.pid, start: "1" }, host({ startOf: () => "2" })), "never this process").toBe(false);
});
it("guard marker: a folder without a valid marker is left", async () => {
  const dead = await deadPid();
  const none = folder(base, "murage-meter-Nm1Aa1", null);
  const bad = folder(base, "murage-meter-Nm2Aa2", { v: 2, pid: dead, start: null });
  const neg = folder(base, "murage-meter-Nm3Aa3", { v: 1, pid: -5, start: null });
  expect(sweepStaleMeterCopies([base], null, host())).toEqual([]);
  for (const d of [none, bad, neg]) expect(existsSync(d)).toBe(true);
});
it("guard prefix: only the exact murage-meter-<6> name is removed", async () => {
  const dead = await deadPid(); const marker = { v: 1, pid: dead, start: null };
  const ok = folder(base, "murage-meter-Ok1Aa1", marker);
  const others = ["murage-metre-Ok1Aa1", "xmurage-meter-Ok1Aa1", "murage-meter-Ok1Aa1x", "murage-meter-Ok1", "murage-meter-"].map(n => folder(base, n, marker));
  expect(sweepStaleMeterCopies([base], null, host())).toEqual([ok]);
  for (const d of others) expect(existsSync(d), d).toBe(true);
});
it.skipIf(process.platform === "win32")("guard owner: another user's folder (uid differs) is left", async () => {
  const dead = await deadPid();
  const dir = folder(base, "murage-meter-Ow1Aa1", { v: 1, pid: dead, start: null });
  expect(sweepStaleMeterCopies([base], null, host({ uid: process.getuid!() + 1 }))).toEqual([]);
  expect(existsSync(dir)).toBe(true);
  expect(sweepStaleMeterCopies([base], null, host())).toEqual([dir]);
});
it("guard owner (Windows form): an owner SID that is not ours leaves the folder", async () => {
  const dead = await deadPid();
  const dir = folder(base, "murage-meter-Os1Aa1", { v: 1, pid: dead, start: null });
  const own = folder(base, "murage-meter-Os2Aa2", { v: 1, pid: process.pid, start: null });
  const sids: Record<string, string> = { [dir]: "S-1-5-21-1-2-3-1001", [own]: "S-1-5-21-1-2-3-1000" };
  const win = (ownerSid: (t: string) => string | null) => host({ platform: "win32", uid: null, ownerSid });
  expect(sweepStaleMeterCopies([base], own, win(t => sids[t] ?? null))).toEqual([]);
  expect(sweepStaleMeterCopies([base], own, win(() => null))).toEqual([]);
  expect(existsSync(dir)).toBe(true);
  sids[dir] = sids[own]!;
  expect(sweepStaleMeterCopies([base], own, win(t => sids[t] ?? null))).toEqual([dir]);
});
it("guard symlink: a symlinked folder alias is not followed and a link inside the folder is not removed through", async () => {
  const dead = await deadPid(); const marker = { v: 1, pid: dead, start: null };
  const real = folder(base, "real-target", marker);
  symlinkSync(real, join(base, "murage-meter-Sy1Aa1"), process.platform === "win32" ? "junction" : "dir");
  const outside = join(base, "outside.txt"); writeFileSync(outside, "keep");
  const trap = folder(base, "murage-meter-Sy2Aa2", marker);
  symlinkSync(outside, join(trap, "extra-link"));
  expect(sweepStaleMeterCopies([base], null, host())).toEqual([]);
  expect(existsSync(join(real, METER_COPY_FILE)), "alias target untouched").toBe(true);
  expect(existsSync(join(trap, METER_COPY_FILE)), "a folder with an unexpected entry is left whole").toBe(true);
  expect(readFileSync(outside, "utf8")).toBe("keep");
  const linked = folder(base, "murage-meter-Sy3Aa3", marker);
  unlinkSync(join(linked, METER_COPY_FILE)); symlinkSync(outside, join(linked, METER_COPY_FILE));
  expect(sweepStaleMeterCopies([base], null, host())).toEqual([linked]);
  expect(readFileSync(outside, "utf8"), "a link named like our copy is unlinked, its target kept").toBe("keep");
});
it("guard symlink: a symlinked marker is not read", async () => {
  const dead = await deadPid();
  const dir = join(base, "murage-meter-Sm1Aa1"); mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(dir, METER_COPY_FILE), "x");
  const real = join(base, "marker-elsewhere.json"); writeFileSync(real, JSON.stringify({ v: 1, pid: dead, start: null }));
  symlinkSync(real, join(dir, METER_COPY_MARKER));
  expect(sweepStaleMeterCopies([base], null, host())).toEqual([]);
  expect(existsSync(dir)).toBe(true);
});
it("own folder: never swept by this process, and removeOwnCopyDir refuses a link or a foreign name", () => {
  const own = folder(base, "murage-meter-Me1Aa1", { v: 1, pid: process.pid, start: null });
  expect(sweepStaleMeterCopies([base], own, host())).toEqual([]);
  const target = folder(base, "target", null);
  const link = join(base, "murage-meter-Me2Aa2"); symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  expect(removeOwnCopyDir(link)).toBe(false);
  expect(removeOwnCopyDir(target), "name does not match").toBe(false);
  expect(existsSync(join(target, METER_COPY_FILE))).toBe(true);
  expect(removeOwnCopyDir(own)).toBe(true);
  expect(existsSync(own)).toBe(false);
});
it("marker: writeCopyMarker records this pid", () => {
  const dir = join(base, "m"); mkdirSync(dir);
  writeCopyMarker(dir);
  expect(JSON.parse(readFileSync(join(dir, METER_COPY_MARKER), "utf8")).pid).toBe(process.pid);
  expect(readdirSync(dir)).toEqual([METER_COPY_MARKER]);
});
