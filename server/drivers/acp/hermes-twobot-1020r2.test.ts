// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: Flux Hermes shared home and turn overlays (hermes.ts materializeFluxHermesHome / writeHermesTurnOverlay, through
// atomic.ts writeFileAtomicUnlessSame). Consumer: every Flux-routed Hermes launch (hermes.ts resolveTurnModel).
// FUIGO2BOT r2 (review of 76892ffe08): every Flux Hermes bot's child reads ONE flux-hermes-home/config.yaml and re-reads
// it lazily, and every launch renamed a fresh copy over it. Windows refuses a rename onto a file another process holds
// open, so a second bot's launch could fail with EPERM ... rename ... config.yaml while the first bot's Hermes had it open.
// The holder is a real second process; on POSIX the Windows rule is put on rename by windows-replace-rule.mjs, judged from
// the holder's real open handles; on Windows the operating system enforces it.
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { removeTempDirSync } from "../../testing/cleanup.ts";
import { heldByOtherProcess, installWindowsReplaceRule, replaceAttempts } from "../../testing/windows-replace-rule.mjs";
import { applyHermesFluxHome, fluxHermesHome, materializeFluxHermesHome } from "./hermes.ts";

const KEY = "fixture-flux-key-twobot-a";
const temps: string[] = [];
const holders: ChildProcess[] = [];
let uninstall: (() => void) | null = null;
afterEach(async () => {
  uninstall?.(); uninstall = null;
  for (const child of holders.splice(0)) { if (child.exitCode === null) { child.kill(); await once(child, "exit"); } }
  for (const dir of temps.splice(0)) removeTempDirSync(dir);
});
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "murage-hermes2bot-")); temps.push(dir); return dir; };
const envFor = (root: string): Record<string, string | undefined> => ({ HOME: join(root, "home"), MURAGE_DATA_DIR: join(root, "data"), PATH: "/bin" });

/** A running Hermes of another bot: a separate process that opens `path` (once it exists) and keeps it open. */
function holder(path: string): { held: Promise<void> } {
  const child = spawn(process.execPath, ["-e", `const fs = require("node:fs"); const wait = () => { try { fs.openSync(process.argv[1], "r"); fs.writeFileSync(process.argv[1] + ".held", ""); process.stdout.write("held\\n"); setInterval(() => {}, 1000); } catch { setTimeout(wait, 5); } }; wait();`, path], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
  holders.push(child);
  return { held: once(child.stdout!, "data").then(([chunk]) => { expect(String(chunk)).toBe("held\n"); }) };
}
/** Block this thread until `done()` (a synchronous hook cannot await), at most 10 s. */
const waitSync = (done: () => boolean) => { const end = Date.now() + 10_000; while (!done()) { if (Date.now() > end) throw new Error("waitSync timed out"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); } };
const heldNow = (path: string) => existsSync(`${path}.held`) && (process.platform === "win32" || heldByOtherProcess(path));

/** Between this launch's check and its rename onto a matching `to`, another bot's launch lands the same bytes and its
 *  Hermes opens and keeps the file. */
function raceFirstPublication(match: (to: string) => boolean): { raced: () => string | null; held: () => Promise<void> } {
  let raced: string | null = null;
  let other: { held: Promise<void> } | null = null;
  uninstall = installWindowsReplaceRule({ beforeReplace: (to, from) => {
    if (raced || !match(to)) return;
    raced = to;
    other = holder(to);
    copyFileSync(from, to);
    chmodSync(to, 0o600);
    waitSync(() => heldNow(to));
  } });
  return { raced: () => raced, held: () => other?.held ?? Promise.resolve() };
}

describe("FUIGO2BOT r2: a second Flux Hermes bot's launch beside a running one", () => {
  it("starts while the first bot's Hermes holds the shared config.yaml open, and leaves the exact bytes in place", async () => {
    const root = temp();
    const env = envFor(root);
    const dir = materializeFluxHermesHome(env, KEY); // bot A's launch
    const file = join(dir, "config.yaml");
    const bytes = readFileSync(file, "utf8");
    await holder(file).held; // bot A's Hermes has it open
    uninstall = installWindowsReplaceRule();
    // Precondition, so the witness cannot pass vacuously: under the rule a replace of the held file is refused.
    if (process.platform !== "win32") expect(heldByOtherProcess(file)).toBe(true);
    const probe = join(root, "probe.yaml");
    writeFileSync(probe, bytes);
    expect(() => renameSync(probe, file)).toThrow(/EPERM|EACCES|EBUSY/);

    const before = replaceAttempts(file);
    expect(materializeFluxHermesHome(envFor(root), KEY)).toBe(dir); // bot B (76892ffe08: EPERM ... rename ... config.yaml)
    expect(readFileSync(file, "utf8")).toBe(bytes);
    // Same bytes: no replace is attempted at all (no refused rename, and on Windows none of the retry delay).
    expect(replaceAttempts(file) - before).toBe(0);
  });

  it("starts when another bot's first launch writes the same config.yaml and its Hermes opens it while this launch is writing too", async () => {
    const root = temp();
    const file = join(fluxHermesHome(envFor(root)), "config.yaml");
    const race = raceFirstPublication((to) => to === file);
    expect(() => materializeFluxHermesHome(envFor(root), KEY)).not.toThrow(); // 76892ffe08: EPERM
    await race.held();
    expect(race.raced()).toBe(file);
    expect(readFileSync(file, "utf8")).toContain(KEY);
  });

  it("starts when two bots on the same tier publish the same turn overlay at once and the other bot's Hermes holds it", async () => {
    const root = temp();
    const overlays = join(envFor(root).MURAGE_DATA_DIR!, "native", "flux-memory") + sep;
    const race = raceFirstPublication((to) => to.startsWith(overlays));
    const env = envFor(root);
    expect(applyHermesFluxHome(env, "flux-auto", KEY)).toBe("flux-auto"); // 76892ffe08: EPERM on the overlay rename
    await race.held();
    expect(race.raced()).toBe(join(env.HERMES_MANAGED_DIR!, "config.yaml"));
    expect(readFileSync(race.raced()!, "utf8")).toContain("flux-auto");
  });

  it("still refuses (never serves a stale key from) a held config.yaml with other bytes", async () => {
    const root = temp();
    const dir = materializeFluxHermesHome(envFor(root), KEY);
    const file = join(dir, "config.yaml");
    await holder(file).held;
    uninstall = installWindowsReplaceRule();
    expect(() => materializeFluxHermesHome(envFor(root), "fixture-flux-key-rotated")).toThrow(/EPERM|EACCES|EBUSY/);
    expect(readFileSync(file, "utf8")).not.toContain("fixture-flux-key-rotated");
  });

  it("still rewrites a changed, loosened or linked config.yaml when nothing holds it", () => {
    const root = temp();
    const dir = materializeFluxHermesHome(envFor(root), KEY);
    const file = join(dir, "config.yaml");
    const bytes = readFileSync(file, "utf8");
    writeFileSync(file, bytes.replace(KEY, "fixture-flux-key-stale"));
    materializeFluxHermesHome(envFor(root), KEY);
    expect(readFileSync(file, "utf8")).toBe(bytes);
    if (process.platform !== "win32") {
      chmodSync(file, 0o644); // same bytes, but the bearer readable by others: rewritten at 0600
      materializeFluxHermesHome(envFor(root), KEY);
      expect(lstatSync(file).mode & 0o777).toBe(0o600);
      const elsewhere = join(temp(), "config.yaml");
      writeFileSync(elsewhere, bytes, { mode: 0o600 });
      unlinkSync(file);
      symlinkSync(elsewhere, file); // a link to the exact bytes is not the home's file
      materializeFluxHermesHome(envFor(root), KEY);
      expect(lstatSync(file).isSymbolicLink()).toBe(false);
      expect(readFileSync(file, "utf8")).toBe(bytes);
    }
  });
});
