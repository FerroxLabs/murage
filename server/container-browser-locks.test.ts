// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Adapted from OpenMausBot a8ac33f36: the desktop image's workspace script runs every time supervisord restarts the
// Cua driver, and it used to delete Chrome's Singleton locks under a running Chrome. It now clears them once per
// container start (boot id + PID 1 start time). The script is run here as written in the image, with /proc swapped
// for files in a scratch folder.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IMAGE_LAYER_VERSION, managedImageDockerfile, VM_WORKSPACE_GUEST } from "./container-computer.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) removeTempDirSync(dir); });

const initStat = (start: number) => ["1 (container init) S", ...Array(18).fill(0), start, 0].join(" ");

function prepareScript(dir: string, workspace: string): string {
  const dockerfile = managedImageDockerfile();
  const end = dockerfile.indexOf("> /usr/local/bin/prepare-murage-workspace.sh");
  const start = dockerfile.lastIndexOf("RUN printf", end);
  expect(start).toBeGreaterThan(-1);
  const printf = dockerfile.slice(start + "RUN ".length, end).replaceAll(VM_WORKSPACE_GUEST, workspace)
    .replaceAll("/proc/sys/kernel/random/boot_id", join(dir, "boot-id")).replaceAll("/proc/1/stat", join(dir, "init-stat"));
  const script = join(dir, "prepare.sh");
  execFileSync("/bin/sh", ["-c", `${printf} > '${script}'`]);
  return script;
}

describe.skipIf(process.platform === "win32")("desktop browser locks", () => {
  it.each(["PID 1 start time", "boot id"])("survive a Cua driver restart and are cleared when the %s changes", (identity) => {
    const dir = mkdtempSync(join(tmpdir(), "murage-browser-locks-")); dirs.push(dir);
    const home = join(dir, "home"), workspace = join(dir, "workspace");
    mkdirSync(home); mkdirSync(workspace);
    writeFileSync(join(dir, "boot-id"), "synthetic-boot"); writeFileSync(join(dir, "init-stat"), initStat(123));
    const script = prepareScript(dir, workspace);
    const run = () => execFileSync("/bin/sh", [script], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home } });
    run();
    const chromium = join(workspace, ".browser-profiles", "chromium");
    const locks = [[join(chromium, "SingletonLock"), "host-4242"], [join(chromium, "SingletonSocket"), "/tmp/socket"], [join(chromium, "SingletonCookie"), "cookie"]] as const;
    for (const [lock, target] of locks) symlinkSync(target, lock);

    run(); // the driver restarts inside the same container: Chrome's live locks stay
    for (const [lock, target] of locks) expect(readlinkSync(lock)).toBe(target);

    if (identity === "boot id") writeFileSync(join(dir, "boot-id"), "next-boot");
    else writeFileSync(join(dir, "init-stat"), initStat(456));
    run(); // a new container start: stale locks go
    for (const [lock] of locks) expect(() => lstatSync(lock)).toThrow();
    expect(existsSync(join(home, ".cache", "murage-browser-locks"))).toBe(true);
  });

  it("ships as a new image layer so existing desktops pick the script up", () => {
    expect(IMAGE_LAYER_VERSION).toBe("5");
  });
});
