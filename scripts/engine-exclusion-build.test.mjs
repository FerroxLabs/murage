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

import { buildEngineExclusion, msvcCommand } from "./build-engine-exclusion.mjs";
import { validateEngineExclusionResource } from "./engine-exclusion-resource.mjs";
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
    const source = fs.readFileSync(new URL("./build-engine-exclusion.mjs", import.meta.url), "utf8");
    expect(source).toContain('"-Wall","-Werror","-fPIC"');
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
