// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildFuigoProbe, PROBE_BUILD_SCRIPT } from "./build-fuigo-probe.mjs";
import { LINUX_FLOOR_IMAGE } from "./linux-floor.mjs";
import { removeTempDirSync } from "../server/testing/cleanup.ts";

const directories = [];
const scratch = () => { const dir = mkdtempSync(path.join(tmpdir(), "murage-probe-build-")); directories.push(dir); return dir; };
afterEach(() => { for (const dir of directories.splice(0)) removeTempDirSync(dir); });

describe.skipIf(process.platform === "win32")("Fuigo probe floor build", () => {
  it.each([false, true])("builds the launcher and optional canary (withCanary=%s)", async withCanary => {
    const outputRoot = scratch(), work = [];
    const exec = vi.fn(async (command, args) => {
      if (command === "docker") {
        const name = work.length ? "canary" : "launcher";
        expect(args).toContain(LINUX_FLOOR_IMAGE);
        expect(args).toContain(`type=bind,source=${path.resolve(`native/fuigo-probe/${name}.c`)},target=/source/input.c,readonly`);
        expect(args).toContain('type=bind,source=/usr/include/linux/landlock.h,target=/uapi/linux/landlock.h,readonly');
        expect(args).toContain('type=bind,source=/usr/include/x86_64-linux-gnu/asm/unistd_64.h,target=/uapi/asm/unistd_64.h,readonly');
        const mount = args.find(arg => arg.endsWith(",target=/work"));
        const directory = mount.slice("type=bind,source=".length, -",target=/work".length);
        work.push(directory);
        expect(args.slice(-3)).toEqual(["/bin/bash", "-c", PROBE_BUILD_SCRIPT]);
        expect(PROBE_BUILD_SCRIPT).not.toContain(outputRoot);
        expect(PROBE_BUILD_SCRIPT).toContain("gcc -std=c11 -O2 -Wall -Wextra");
        expect(PROBE_BUILD_SCRIPT).toContain('-DSYS_landlock_create_ruleset=__NR_landlock_create_ruleset');
        expect(PROBE_BUILD_SCRIPT).toContain('-DSYS_pidfd_getfd=__NR_pidfd_getfd');
        writeFileSync(path.join(directory, "output"), name);
        return { stdout: "", stderr: "" };
      }
      expect(command).toBe("objdump");
      expect(args).toEqual(["-T", path.join(work.at(-1), "output")]);
      return { stdout: "GLIBC_2.28", stderr: "" };
    });
    await buildFuigoProbe({ platform: "linux", arch: "x64", outputRoot, withCanary, exec });
    const root = path.join(outputRoot, "linux-x64");
    expect(readdirSync(root).sort()).toEqual(withCanary ? ["canary", "launcher", "manifest.json"] : ["launcher", "manifest.json"]);
    expect(JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8"))).toMatchObject({ schema: 1, target: "linux-x64", executable: "launcher", glibcFloor: "2.28", containerImage: LINUX_FLOOR_IMAGE });
    expect(exec.mock.calls.filter(([command]) => command === "objdump")).toHaveLength(withCanary ? 2 : 1);
    for (const directory of work) expect(existsSync(directory)).toBe(false);
  });
  it.each(["launcher", "canary"])("rejects an over-floor %s before staging it and cleans the work directory", async failedName => {
    const outputRoot = scratch();
    let name;
    const exec = vi.fn(async (command, args) => {
      if (command === "docker") {
        name = name ? "canary" : "launcher";
        const mount = args.find(arg => arg.endsWith(",target=/work"));
        writeFileSync(path.join(mount.slice("type=bind,source=".length, -",target=/work".length), "output"), name);
        return { stdout: "", stderr: "" };
      }
      return { stdout: name === failedName ? "GLIBC_2.34" : "GLIBC_2.28", stderr: "" };
    });
    await expect(buildFuigoProbe({ platform: "linux", arch: "x64", outputRoot, withCanary: true, exec })).rejects.toThrow("GLIBC_FLOOR_EXCEEDED");
    expect(readdirSync(path.join(outputRoot, "linux-x64")).sort()).toEqual(failedName === "launcher" ? [] : ["launcher", "manifest.json"]);
  });
});
