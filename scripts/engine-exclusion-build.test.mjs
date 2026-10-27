// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The build and the packaging gate of the engine-exclusion addon (native/engine-exclusion): the Windows build links the static C
// runtime (/MT) and runs inside the Visual Studio developer environment; a package without the addon, or with one for another
// platform, is refused.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildEngineExclusion, msvcCommand, ENGINE_EXCLUSION_BUILD_SCRIPT } from "./build-engine-exclusion.mjs";
import { LINUX_FLOOR_IMAGE } from "./linux-floor.mjs";
import { validateEngineExclusionResource } from "./engine-exclusion-resource.mjs";
import { ADDON_VERSION, WINDOWS_NATIVE_FUNCTIONS } from "../server/engine-exclusion.ts";
import { WINDOWS_NATIVE_VERSION } from "../electron/windows-native.mjs";
import { removeTempDirSync } from "../server/testing/cleanup.ts";

const directories = [];
const scratch = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "murage-excl-build-")); directories.push(dir); return dir; };
afterEach(() => { for (const dir of directories.splice(0)) removeTempDirSync(dir); });

function headers() {
  const dir = scratch();
  for (const name of ["node_api.h", "node_api_types.h", "js_native_api.h", "js_native_api_types.h"]) fs.writeFileSync(path.join(dir, name), "");
  return dir;
}

describe("the Windows build", () => {
  it("links the static C runtime (/MT) so no VCRUNTIME140.dll is needed, and never the dynamic one", () => {
    for (const env of [{ VSCMD_ARG_TGT_ARCH: "x64" }, {}]) {
      const outputRoot = scratch();
      fs.mkdirSync(path.join(outputRoot, `win32-${process.arch}`), { recursive: true });
      fs.writeFileSync(path.join(outputRoot, `win32-${process.arch}`, "engine-exclusion.node"), "MZ");
      const calls = [];
      buildEngineExclusion({ platform: "win32", env, environmentFile: "C:\\VS\\Common7\\Tools\\VsDevCmd.bat", headerDirectory: headers(), outputRoot, exec: (command, args) => { calls.push({ command, args }); } });
      const text = calls.map((call) => `${call.command} ${call.args.join(" ")}`).join("\n");
      expect(text).toContain("/MT");
      expect(text).toContain("/LD");
      expect(text).toContain("Advapi32.lib");
      expect(text).not.toMatch(/\/MD\b/);
      expect(calls).toHaveLength(2); // lib.exe, cl.exe
      if (env.VSCMD_ARG_TGT_ARCH) expect(calls[1].command).toBe("cl.exe");
      else expect(calls[1].args.join(" ")).toContain('call "C:\\VS\\Common7\\Tools\\VsDevCmd.bat" -arch=x64 -host_arch=x64 && cl.exe');
    }
  });

  it("an unsafe argument is refused rather than passed to a shell", () => {
    expect(() => msvcCommand("cl.exe", ['/Fe"x'], { env: {}, environmentFile: "C:\\VS\\VsDevCmd.bat" })).toThrow(/UNSAFE/);
  });

  it("the Linux build is compiled with -Wall -Werror", () => {
    expect(ENGINE_EXCLUSION_BUILD_SCRIPT).toContain('-Wall -Werror -fPIC');
  });

  it("both loaders require addon v10 and Windows requires the privilege-drop export", () => {
    const source = fs.readFileSync(new URL("../native/engine-exclusion/exclusion.c", import.meta.url), "utf8");
    expect(ADDON_VERSION).toBe(10);
    expect(WINDOWS_NATIVE_VERSION).toBe(ADDON_VERSION);
    expect(source).toMatch(/^#define ADDON_VERSION 10$/m);
    expect(WINDOWS_NATIVE_FUNCTIONS).toContain("dropShutdownPrivileges");
    expect(source).toContain('add(env, exports, "dropShutdownPrivileges", drop_shutdown_privileges);');
  });
});

describe.skipIf(process.platform === "win32")("the Linux floor build", () => {
  it.each(["ok", "glibc", "needed"])("uses pinned Docker and checks the emitted addon (%s)", mode => {
    const outputRoot = scratch(), headerDirectory = headers(), calls = [];
    const exec = (command, args) => {
      calls.push({ command, args });
      if (command === "docker") {
        expect(args).toContain(LINUX_FLOOR_IMAGE);
        expect(args).toContain(`type=bind,source=${headerDirectory},target=/headers,readonly`);
        expect(args).toContain(`type=bind,source=${path.resolve("native/engine-exclusion/exclusion.c")},target=/source/exclusion.c,readonly`);
        expect(args).toContain(`type=bind,source=${path.join(outputRoot, `linux-${process.arch}`)},target=/work`);
        expect(args.slice(-3)).toEqual(["/bin/bash", "-c", ENGINE_EXCLUSION_BUILD_SCRIPT]);
        expect(args).not.toContain("--privileged");
        expect(ENGINE_EXCLUSION_BUILD_SCRIPT).not.toContain(outputRoot);
        fs.writeFileSync(path.join(outputRoot, `linux-${process.arch}`, "engine-exclusion.node"), "fixture addon");
        return "";
      }
      if (command === "objdump") {
        expect(args[0]).toBe("-T");
        return `GLIBC_${mode === "glibc" ? "2.38" : "2.17"}`;
      }
      if (command === "readelf") return `(NEEDED) Shared library: [${mode === "needed" ? "libm.so.6" : "libc.so.6"}]`;
      throw new Error(`Unexpected command ${command}`);
    };
    const build = () => buildEngineExclusion({ platform: "linux", headerDirectory, outputRoot, exec, env: { CC: "must-not-run" } });
    if (mode === "ok") expect(build()[0]).toMatchObject({ glibcFloor: "2.28", containerImage: LINUX_FLOOR_IMAGE, napiVersion: 9, version: 1 });
    else {
      expect(build).toThrow(mode === "glibc" ? "GLIBC_FLOOR_EXCEEDED" : "DYNAMIC_DEPENDENCY");
      expect(fs.existsSync(path.join(outputRoot, `linux-${process.arch}`, "build.json"))).toBe(false);
    }
    expect(calls[0].command).toBe("docker");
    expect(calls.filter(call => call.command === "docker")).toHaveLength(1);
    expect(calls.some(call => call.command === "objdump")).toBe(true);
  });
});

describe("the packaging gate", () => {
  // a real header for the machine: ELF64 x86-64, a PE for x64, a 64-bit arm64 Mach-O (the package's own architecture)
  const elf = () => { const b = Buffer.alloc(4096); Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(b); b.writeUInt16LE(0x3e, 18); b.writeUInt16LE(3, 16); return b; };
  const pe = () => { const b = Buffer.alloc(4096); b[0] = 0x4d; b[1] = 0x5a; b.writeUInt32LE(0x80, 0x3c); b.writeUInt32BE(0x50450000, 0x80); b.writeUInt16LE(0x8664, 0x84); b.writeUInt16LE(0x2000, 0x80 + 22); return b; };
  const macho = () => { const b = Buffer.alloc(4096); Buffer.from([0xcf, 0xfa, 0xed, 0xfe]).copy(b); b.writeUInt32LE(0x0100000c, 4); b.writeUInt32LE(8, 12); return b; };
  const image = { linux: elf(), win32: pe(), darwin: macho() };
  const arch = { linux: "x64", win32: "x64", darwin: "arm64" };
  const addon = (bytes) => { const resources = scratch(); fs.writeFileSync(path.join(resources, "engine-exclusion.node"), bytes); return resources; };

  it("accepts an executable image of the platform and machine it is packaged for", () => {
    for (const platform of ["linux", "win32", "darwin"]) expect(validateEngineExclusionResource(addon(image[platform]), platform, arch[platform])).toMatch(/engine-exclusion\.node$/);
  });

  it("refuses an image for another machine, and a file that only starts like one", () => {
    expect(() => validateEngineExclusionResource(addon(image.darwin), "darwin", "x64")).toThrow(/MISMATCH/);
    expect(() => validateEngineExclusionResource(addon(image.linux), "linux", "arm64")).toThrow(/MISMATCH/);
    expect(() => validateEngineExclusionResource(addon(Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(4096)])), "linux", "x64")).toThrow(/MISMATCH/);
    expect(() => validateEngineExclusionResource(addon(Buffer.concat([Buffer.from("MZ"), Buffer.alloc(4096)])), "win32", "x64")).toThrow(/MISMATCH/);
  });

  it("refuses a missing addon, one for another platform, an empty file, a link and a folder", () => {
    expect(() => validateEngineExclusionResource(scratch(), "linux", "x64")).toThrow(/MISSING/);
    expect(() => validateEngineExclusionResource(addon(image.win32), "linux", "x64")).toThrow(/MISMATCH/);
    expect(() => validateEngineExclusionResource(addon(image.linux), "win32", "x64")).toThrow(/MISMATCH/);
    const empty = scratch();
    fs.writeFileSync(path.join(empty, "engine-exclusion.node"), "");
    expect(() => validateEngineExclusionResource(empty, "linux", "x64")).toThrow(/INVALID/);
    const linked = scratch();
    const real = path.join(scratch(), "real.node");
    fs.writeFileSync(real, image.linux);
    fs.symlinkSync(real, path.join(linked, "engine-exclusion.node"));
    expect(() => validateEngineExclusionResource(linked, "linux", "x64")).toThrow(/INVALID/);
    const folder = scratch();
    fs.mkdirSync(path.join(folder, "engine-exclusion.node"));
    expect(() => validateEngineExclusionResource(folder, "linux", "x64")).toThrow(/INVALID/);
    expect(() => validateEngineExclusionResource(scratch(), "freebsd", "x64")).toThrow(/UNSUPPORTED/);
  });
});
