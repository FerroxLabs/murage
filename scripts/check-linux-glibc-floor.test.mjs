// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { checkLinuxGlibcFloor, exceedsCeiling, findAppImageOffset, REVIEWED_CEILINGS, walkElfFiles } from "./check-linux-glibc-floor.mjs";
import { compareVersions, maxGlibcVersion } from "./linux-floor.mjs";
import { LINUX_CUA_RELEASE } from "./cua-linux-release.mjs";
import { removeTempDirSync } from "../server/testing/cleanup.ts";

// Pin tiny local fixture bytes while exercising the gate's real SHA-256 hashing.
vi.mock("./cua-linux-release.mjs", async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, LINUX_CUA_RELEASE: Object.freeze({
    ...actual.LINUX_CUA_RELEASE,
    driverSha256: actual.sha256(Buffer.from("\x7fELFcua-driver")),
    cursorThemeSha256: actual.sha256(Buffer.from("\x7fELFcua-cursor-theme")),
  }) };
});

const directories = [];
const scratch = () => { const dir = mkdtempSync(path.join(tmpdir(), "murage-floor-test-")); directories.push(dir); return dir; };
afterEach(() => { for (const dir of directories.splice(0)) removeTempDirSync(dir); });
const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
const cuaBytes = name => Buffer.concat([elf, Buffer.from(name)]);
function write(root, name, bytes = elf) {
  const file = path.join(root, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  return file;
}

function appImage({ wide = true, little = true, extended = false, size = 400, magic = 300 } = {}) {
  const bytes = Buffer.alloc(size);
  elf.copy(bytes); bytes[4] = wide ? 2 : 1; bytes[5] = little ? 1 : 2;
  const u16 = (value, offset) => little ? bytes.writeUInt16LE(value, offset) : bytes.writeUInt16BE(value, offset);
  const word = (value, offset) => wide
    ? little ? bytes.writeBigUInt64LE(BigInt(value), offset) : bytes.writeBigUInt64BE(BigInt(value), offset)
    : little ? bytes.writeUInt32LE(value, offset) : bytes.writeUInt32BE(value, offset);
  word(128, wide ? 40 : 32);
  u16(wide ? 64 : 40, wide ? 58 : 46);
  u16(extended ? 0 : 2, wide ? 60 : 48);
  if (extended) word(2, 128 + (wide ? 32 : 20));
  bytes.write("hsqs", 80); // Decoy inside the runtime, before section headers end.
  bytes.write("hsqs", magic);
  return bytes;
}

describe("numeric GLIBC ceilings", () => {
  it("compares versions numerically, including patches", () => {
    expect(compareVersions("2.9", "2.28")).toBe(-1);
    expect(compareVersions("2.28.0", "2.28")).toBe(0);
    expect(maxGlibcVersion("GLIBC_2.9 GLIBC_2.28.1 GLIBC_PRIVATE GLIBCXX_3.4")).toBe("2.28.1");
    expect(maxGlibcVersion("no symbols")).toBeNull();
    for (const version of ["2.28", "2.28.0", null]) expect(exceedsCeiling(version, "resources/other")).toBe(false);
    for (const version of ["2.28.1", "2.29", "2.38", "2.100", "3.0"]) expect(exceedsCeiling(version, "resources/other")).toBe(true);
  });
  it("grants only the two reviewed CUA files 2.30, never 2.31", () => {
    expect(Object.keys(REVIEWED_CEILINGS)).toEqual(["resources/cua-linux-x64/cua-driver", "resources/cua-linux-x64/cua-cursor-theme"]);
    expect(REVIEWED_CEILINGS["resources/cua-linux-x64/cua-driver"].sha256).toBe(LINUX_CUA_RELEASE.driverSha256);
    expect(REVIEWED_CEILINGS["resources/cua-linux-x64/cua-cursor-theme"].sha256).toBe(LINUX_CUA_RELEASE.cursorThemeSha256);
    for (const [file, { sha256 }] of Object.entries(REVIEWED_CEILINGS)) {
      expect(exceedsCeiling("2.30", file, sha256)).toBe(false);
      expect(exceedsCeiling("2.31", file, sha256)).toBe(true);
      expect(exceedsCeiling("2.30.1", file, sha256)).toBe(true);
      expect(exceedsCeiling("2.30", file)).toBe(true);
      expect(exceedsCeiling("2.30", file, "wrong")).toBe(true);
      expect(exceedsCeiling("2.30", file + ".new", sha256)).toBe(true);
      expect(exceedsCeiling("2.30", "nested/" + file, sha256)).toBe(true);
    }
  });
});

describe("non-executing AppImage offset discovery", () => {
  it.each([true, false])("handles ELF width wide=%s and either byte order", wide => {
    for (const little of [true, false]) for (const extended of [true, false]) {
      expect(findAppImageOffset(appImage({ wide, little, extended }))).toBe(300);
    }
  });
  it("finds the first eligible magic, including at the section end or a chunk boundary", () => {
    expect(findAppImageOffset(appImage({ magic: 256 }))).toBe(256);
    const bytes = appImage({ size: 1024 * 1024 + 400, magic: 256 + 1024 * 1024 - 2 });
    expect(findAppImageOffset(bytes)).toBe(256 + 1024 * 1024 - 2);
    const multiple = appImage(); multiple.write("hsqs", 280);
    expect(findAppImageOffset(multiple)).toBe(280);
  });
  it("rejects missing magic, invalid ELF and out-of-bounds tables", () => {
    const missing = appImage(); missing.fill(0, 300);
    expect(() => findAppImageOffset(missing)).toThrow(/not found/);
    expect(() => findAppImageOffset(Buffer.alloc(64))).toThrow(/header/);
    const invalid = appImage(); invalid.writeBigUInt64LE(10000n, 40);
    expect(() => findAppImageOffset(invalid)).toThrow(/section table/);
    expect(() => findAppImageOffset(appImage().subarray(0, 60))).toThrow(/Truncated/);
  });
});

it("walks only regular ELF files, never links or non-ELF files", () => {
  const root = scratch(), outside = scratch();
  const expected = write(root, "nested/real");
  write(root, "text", "ordinary text"); write(root, "short", "\x7fEL");
  const external = write(outside, "external");
  symlinkSync(external, path.join(root, "linked-file"));
  symlinkSync(outside, path.join(root, "linked-dir"), "dir");
  symlinkSync(path.join(root, "missing"), path.join(root, "dangling"));
  expect([...walkElfFiles(root)]).toEqual([expected]);
  expect([...walkElfFiles(path.join(root, "linked-file"))]).toEqual([]);
});

describe("package gate orchestration", () => {
  it("prints both allowances even with no artifacts", () => {
    const log = vi.fn(), error = vi.fn(), exec = vi.fn();
    expect(checkLinuxGlibcFloor([], { exec, log, error })).toBe(1);
    expect(log.mock.calls).toHaveLength(2);
    for (const [resourcePath, allowance] of Object.entries(REVIEWED_CEILINGS)) {
      expect(log).toHaveBeenCalledWith(`Allowance ${resourcePath} sha256=${allowance.sha256} ceiling=GLIBC_${allowance.ceiling}: ${allowance.reason}`);
    }
    expect(exec).not.toHaveBeenCalled();
  });
  it.each(["2.28", "2.38"])("reports every max and exit code for a bare ELF at %s", version => {
    const file = write(scratch(), "fuigo"), log = vi.fn(), error = vi.fn();
    const exec = vi.fn(() => {
      for (const [resourcePath, allowance] of Object.entries(REVIEWED_CEILINGS)) {
        expect(log).toHaveBeenCalledWith(`Allowance ${resourcePath} sha256=${allowance.sha256} ceiling=GLIBC_2.30: pinned Linux cua-driver-rs ${LINUX_CUA_RELEASE.version} prebuilt; ceiling approved by owner on 2026-10-26`);
      }
      return `GLIBC_2.9 GLIBC_${version}`;
    });
    expect(checkLinuxGlibcFloor([file], { exec, log, error })).toBe(version === "2.28" ? 0 : 1);
    expect(exec).toHaveBeenCalledWith("objdump", ["-T", file], expect.any(Object));
    expect(log).toHaveBeenCalledWith(`${version} ${file}`);
    expect(log.mock.calls.flat().join("\n")).toContain("1 ELF files");
    for (const resourcePath of Object.keys(REVIEWED_CEILINGS)) {
      expect(log).toHaveBeenCalledWith(`CUA ${file}: ${resourcePath} found=no matched=no`);
    }
    if (version === "2.38") expect(error).toHaveBeenCalledWith(`2.38 ${file}`);
    else expect(error).not.toHaveBeenCalled();
  });
  it.each(["deb", "AppImage"])("extracts %s, checks the runtime, applies exact CUA exceptions and cleans up", extension => {
    const input = write(scratch(), `Murage.${extension}`, extension === "deb" ? Buffer.from("deb") : appImage());
    const log = vi.fn(), error = vi.fn();
    let root;
    const exec = vi.fn((command, args) => {
      if (command === "objdump") return path.basename(args[1]).startsWith("cua-") ? "GLIBC_2.30" : "GLIBC_2.28";
      expect(log.mock.calls.filter(([line]) => line.startsWith("Allowance "))).toHaveLength(2);
      if (command === "dpkg-deb") {
        expect(args.slice(0, 2)).toEqual(["-x", input]); root = args[2];
      } else if (command === "unsquashfs") {
        expect(args).toEqual(["-no-xattrs", "-d", expect.any(String), "-o", "300", input]); root = args[2];
      } else throw new Error(`Unexpected executable ${command}`);
      const prefix = extension === "deb" ? "opt/Murage/" : "";
      for (const name of ["cua-driver", "cua-cursor-theme"]) write(root, prefix + "resources/cua-linux-x64/" + name, cuaBytes(name));
      write(root, prefix + "resources/fuigo/fuigo");
      write(root, prefix + "readme", "not ELF");
      return "";
    });
    expect(checkLinuxGlibcFloor([input], { exec, log, error })).toBe(0);
    expect(error).not.toHaveBeenCalled();
    expect(existsSync(path.dirname(root))).toBe(false);
    expect(exec.mock.calls.filter(([command]) => command === "objdump")).toHaveLength(extension === "deb" ? 3 : 4);
    expect(exec.mock.calls.some(([command]) => command === input)).toBe(false);
    for (const resourcePath of Object.keys(REVIEWED_CEILINGS)) {
      expect(log).toHaveBeenCalledWith(`CUA ${input}: ${resourcePath} found=yes matched=yes`);
    }
  });
  describe.each(["deb", "AppImage"])("%s CUA identity and ceiling", extension => {
    it.each(["cua-driver", "cua-cursor-theme"])("rejects changed %s even below the floor, and pinned bytes above 2.30", name => {
      const input = write(scratch(), `Murage.${extension}`, extension === "deb" ? "deb" : appImage());
      const resourcePath = `resources/cua-linux-x64/${name}`;
      const relative = (extension === "deb" ? "opt/Murage/" : "") + resourcePath;
      for (const [version, bytes, matched] of [
        ["2.27", elf, false], ["2.28", elf, false], ["2.30", elf, false],
        [null, elf, false], ["2.28", Buffer.from("not ELF"), false], ["2.31", cuaBytes(name), true],
      ]) {
        const log = vi.fn(), error = vi.fn();
        const exec = (command, args) => {
          if (command === "objdump") return args[1] === input ? "GLIBC_2.28" : version ? `GLIBC_${version}` : "no symbols";
          write(args[2], relative, bytes);
          return "";
        };
        expect(checkLinuxGlibcFloor([input], { exec, log, error })).toBe(1);
        expect(log).toHaveBeenCalledWith(`CUA ${input}: ${resourcePath} found=yes matched=${matched ? "yes" : "no"}`);
        expect(error).toHaveBeenCalledWith(matched ? `2.31 ${input}:${relative}` : `sha256 mismatch ${resourcePath}`);
      }
    });
    it("rejects other paths at 2.29 even with pinned CUA bytes", () => {
      const input = write(scratch(), `Murage.${extension}`, extension === "deb" ? "deb" : appImage());
      const prefix = extension === "deb" ? "opt/Murage/" : "";
      const log = vi.fn(), error = vi.fn();
      const exec = (command, args) => {
        if (command === "objdump") return args[1] === input ? "GLIBC_2.28" : "GLIBC_2.29";
        write(args[2], prefix + "resources/other", cuaBytes("cua-driver"));
        return "";
      };
      expect(checkLinuxGlibcFloor([input], { exec, log, error })).toBe(1);
      expect(error).toHaveBeenCalledWith(`2.29 ${input}:${prefix}resources/other`);
      for (const resourcePath of Object.keys(REVIEWED_CEILINGS)) {
        expect(log).toHaveBeenCalledWith(`CUA ${input}: ${resourcePath} found=no matched=no`);
      }
      expect(log.mock.calls.filter(([line]) => line.startsWith("Allowance "))).toHaveLength(2);
    });
  });
  it("reports CUA presence separately for each artifact", () => {
    const first = write(scratch(), "with-cua.deb", "deb");
    const second = write(scratch(), "without-cua.deb", "deb");
    const log = vi.fn(), error = vi.fn();
    const exec = (command, args) => {
      if (command === "objdump") return "GLIBC_2.28";
      write(args[2], "opt/Murage/resources/other");
      if (args[1] === first) {
        for (const name of ["cua-driver", "cua-cursor-theme"]) write(args[2], `opt/Murage/resources/cua-linux-x64/${name}`, cuaBytes(name));
      }
      return "";
    };
    expect(checkLinuxGlibcFloor([first, second], { exec, log, error })).toBe(0);
    expect(error).not.toHaveBeenCalled();
    for (const resourcePath of Object.keys(REVIEWED_CEILINGS)) {
      expect(log).toHaveBeenCalledWith(`CUA ${first}: ${resourcePath} found=yes matched=yes`);
      expect(log).toHaveBeenCalledWith(`CUA ${second}: ${resourcePath} found=no matched=no`);
    }
    expect(log.mock.calls.filter(([line]) => line.startsWith("Allowance "))).toHaveLength(2);
  });
  it("rejects unreviewed nested paths and an over-ceiling reviewed file", () => {
    const input = write(scratch(), "Murage.deb", "deb"), log = vi.fn(), error = vi.fn();
    const exec = (command, args) => {
      if (command === "dpkg-deb") {
        write(args[2], "opt/Murage/resources/cua-linux-x64/cua-driver", cuaBytes("cua-driver"));
        write(args[2], "other/resources/cua-linux-x64/cua-cursor-theme", cuaBytes("cua-cursor-theme"));
        return "";
      }
      return args[1].endsWith("cua-driver") ? "GLIBC_2.31" : "GLIBC_2.30";
    };
    expect(checkLinuxGlibcFloor([input], { exec, log, error })).toBe(1);
    expect(error).toHaveBeenCalledTimes(2);
  });
  it("accepts objdump's static-ELF result but fails closed on other tool errors", () => {
    const input = write(scratch(), "fuigo"), log = vi.fn(), error = vi.fn();
    const exec = vi.fn(() => { throw Object.assign(new Error("objdump"), { status: 1, stdout: "DYNAMIC SYMBOL TABLE:\nno symbols\n", stderr: "objdump: file: not a dynamic object" }); });
    expect(checkLinuxGlibcFloor([input], { exec, log, error })).toBe(0);
    expect(log).toHaveBeenCalledWith(`none ${input}`);
    exec.mockImplementation(() => { throw new Error("tool failed"); });
    expect(checkLinuxGlibcFloor([input], { exec, log, error })).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("tool failed"));
  });
  it("cleans failed extractions and rejects empty packages, non-ELFs, missing inputs and no arguments", () => {
    const input = write(scratch(), "Murage.deb", "deb"), error = vi.fn(), log = vi.fn();
    let root;
    const exec = vi.fn((_command, args) => { root = args[2]; throw new Error("extract failed"); });
    expect(checkLinuxGlibcFloor([input], { exec, log, error })).toBe(1);
    expect(existsSync(path.dirname(root))).toBe(false);
    exec.mockImplementation((_command, args) => { root = args[2]; mkdirSync(root); return ""; });
    expect(checkLinuxGlibcFloor([input], { exec, log, error })).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("No ELF files"));
    expect(existsSync(path.dirname(root))).toBe(false);
    for (const files of [[], [write(scratch(), "text", "text")], ["/nonexistent/murage-floor-test"]]) expect(checkLinuxGlibcFloor(files, { exec, log, error })).toBe(1);
  });
});

it("gates all three Linux packaging workflows before checksums or uploads", () => {
  for (const name of ["release", "package-linux", "ci"]) {
    const workflow = parse(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8"));
    const job = Object.values(workflow.jobs).find(job => job.steps?.some(step => /pnpm package:linux(?:\s|:offline)/.test(step.run ?? "")));
    const steps = job.steps;
    const pack = steps.findIndex(step => /pnpm package:linux(?:\s|:offline)/.test(step.run ?? ""));
    const gate = steps.findIndex(step => step.run?.includes("node scripts/check-linux-glibc-floor.mjs"));
    expect(gate).toBe(pack + 1);
    for (const artifact of ["release/Murage-$v-amd64.deb", "release/Murage-$v-x86_64.AppImage", "dist-native/fuigo/linux-x64/fuigo"]) expect(steps[gate].run).toContain(artifact);
    expect(steps.slice(pack + 1, gate).some(step => /upload|sha256sum/.test(JSON.stringify(step)))).toBe(false);
    expect(steps.some(step => /apt-get install/.test(step.run ?? "") && /python3-pip/.test(step.run))).toBe(true);
  }
});
