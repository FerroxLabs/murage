// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: Fuigo launch policy (fuigo-policy.ts ensureFuigoPolicy). Consumer: every Fuigo launch (fuigo.ts applyFuigoTurnPolicy).
// FUIGO2BOT (1.0.20 field report): two Fuigo bots whose turns overlap. A running Fuigo (1.0.36+) keeps the one per-install
// policy file open for its whole life as its pin (fuigo-workspace permission/launch_policy.rs keeps a same_file::Handle),
// and every launch used to rename a fresh copy over that file. Windows refuses a rename onto a file another process holds
// open, so the second bot's launch failed with EPERM ... rename ... fuigo-policy/launch-*.toml. Here the holder is a real
// second process with the file open; on POSIX the Windows rule is put on rename by windows-replace-rule.mjs, judged from
// the holder's real open handles; on Windows the operating system enforces it.
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, lstatSync, mkdtempSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { removeTempDirSync } from "../../testing/cleanup.ts";
import { heldByOtherProcess, installWindowsReplaceRule, replaceAttempts } from "../../testing/windows-replace-rule.mjs";
import { FUIGO_POLICY_SHA256, FUIGO_POLICY_TEXT, ensureFuigoPolicy, fuigoPolicyPath } from "./fuigo-policy.ts";

const temps: string[] = [];
const holders: ChildProcess[] = [];
let uninstall: (() => void) | null = null;
afterEach(async () => {
  uninstall?.(); uninstall = null;
  for (const child of holders.splice(0)) { if (child.exitCode === null) { child.kill(); await once(child, "exit"); } }
  for (const dir of temps.splice(0)) removeTempDirSync(dir);
});
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "murage-fuigo2bot-")); temps.push(dir); return dir; };

/** A running "Fuigo" of the first bot: a separate process that opens the policy file (once it exists) and keeps it open,
 *  like the pin. Resolves when it is spawned; `held` resolves once the file is open. */
function holder(path: string): { held: Promise<void> } {
  const child = spawn(process.execPath, ["-e", `const fs = require("node:fs"); const wait = () => { try { fs.openSync(process.argv[1], "r"); fs.writeFileSync(process.argv[1] + ".held", ""); process.stdout.write("held\\n"); setInterval(() => {}, 1000); } catch { setTimeout(wait, 5); } }; wait();`, path], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
  holders.push(child);
  return { held: once(child.stdout!, "data").then(([chunk]) => { expect(String(chunk)).toBe("held\n"); }) };
}
const holdOpen = (path: string) => holder(path).held;
/** Block this thread until `done()` (a synchronous hook cannot await), at most 10 s. */
const waitSync = (done: () => boolean) => { const end = Date.now() + 10_000; while (!done()) { if (Date.now() > end) throw new Error("waitSync timed out"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); } };

describe("FUIGO2BOT: a second bot's Fuigo launch beside a running one", () => {
  it("starts while the first bot's Fuigo holds the pinned policy file open, and hands the engine the exact policy", async () => {
    const root = temp();
    const first = ensureFuigoPolicy(root); // bot A's launch
    await holdOpen(first.path); // bot A's Fuigo is running and pins the file
    uninstall = installWindowsReplaceRule();
    // Precondition, so the witness cannot pass vacuously: under the rule a replace of the held file is refused.
    if (process.platform !== "win32") expect(heldByOtherProcess(first.path)).toBe(true);
    const probe = join(root, "probe.toml");
    writeFileSync(probe, FUIGO_POLICY_TEXT);
    expect(() => renameSync(probe, first.path)).toThrow(/EPERM|EACCES|EBUSY/);

    const before = replaceAttempts(first.path);
    const second = ensureFuigoPolicy(root); // bot B's launch (v1.0.20: EPERM ... rename ... launch-*.toml)
    expect(second).toEqual({ path: fuigoPolicyPath(root), sha256: FUIGO_POLICY_SHA256 });
    expect(readFileSync(second.path, "utf8")).toBe(FUIGO_POLICY_TEXT);
    expect(lstatSync(second.path).isFile()).toBe(true);
    // The pinned file already holds the policy: B's launch does not try to replace it at all (no refused rename, and on
    // Windows none of the retry delay).
    expect(replaceAttempts(first.path) - before).toBe(0);
  });

  it("starts when another bot's first launch writes the policy and its Fuigo pins it while this launch is writing too", async () => {
    const root = temp();
    const path = fuigoPolicyPath(root);
    const other = holder(path); // the other bot's Fuigo, about to start
    let raced = false;
    uninstall = installWindowsReplaceRule({ beforeReplace: (to) => {
      if (raced || to !== path) return;
      raced = true;
      // Between this launch's check (no file yet) and its rename, the other bot's launch lands the policy and its
      // Fuigo opens and pins it.
      writeFileSync(path, FUIGO_POLICY_TEXT, { mode: 0o600 });
      waitSync(() => existsSync(`${path}.held`) && (process.platform === "win32" || heldByOtherProcess(path)));
    } });
    const policy = ensureFuigoPolicy(root); // v1.0.20 and a launch without the refused-replace acceptance: EPERM
    await other.held;
    expect(raced).toBe(true);
    expect(policy).toEqual({ path, sha256: FUIGO_POLICY_SHA256 });
    expect(readFileSync(path, "utf8")).toBe(FUIGO_POLICY_TEXT);
  });

  it("still refuses (never accepts) a changed policy file it cannot replace while it is held", async () => {
    const root = temp();
    const { path } = ensureFuigoPolicy(root);
    writeFileSync(path, '[permission]\nallow = ["*"]\n');
    await holdOpen(path);
    uninstall = installWindowsReplaceRule();
    expect(() => ensureFuigoPolicy(root)).toThrow(/EPERM|EACCES|EBUSY/);
    expect(readFileSync(path, "utf8")).not.toBe(FUIGO_POLICY_TEXT); // and the engine's hash check refuses it (exit 78)
  });

  it("still rewrites a missing, changed or linked policy file when nothing holds it", () => {
    const root = temp();
    const { path } = ensureFuigoPolicy(root);
    expect(readFileSync(path, "utf8")).toBe(FUIGO_POLICY_TEXT);
    writeFileSync(path, '[permission]\nallow = ["*"]\n');
    ensureFuigoPolicy(root);
    expect(readFileSync(path, "utf8")).toBe(FUIGO_POLICY_TEXT);
    if (process.platform !== "win32") {
      // a link to a file with the exact bytes is not "the policy file": it is replaced by a plain file
      const elsewhere = join(temp(), "policy.toml");
      writeFileSync(elsewhere, FUIGO_POLICY_TEXT);
      unlinkSync(path);
      symlinkSync(elsewhere, path);
      ensureFuigoPolicy(root);
      expect(lstatSync(path).isSymbolicLink()).toBe(false);
      expect(readFileSync(path, "utf8")).toBe(FUIGO_POLICY_TEXT);
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
    }
  });
});
