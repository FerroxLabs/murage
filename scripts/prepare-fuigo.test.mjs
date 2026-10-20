// The bundled Fuigo engine's packaging contract: an exact pinned version, one
// staged file per BUILD TARGET rather than per build host, and a staged file
// name that cannot drift from the electron-builder `to:` basename.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { FUIGO_EXECUTABLE_NAMES } from "../electron/harness-resources.mjs";
import { executableTarget } from "./prepare-cloudflared.mjs";
import {
  FUIGO_ASSETS,
  FUIGO_VERSION,
  expectedManifest,
  fuigoExecutableName,
  parsePrepareFuigoArgs,
  stagedDirectory,
  tarballName,
  tarballUrl,
  targetForCurrentHost,
  targetsForHost,
  targetsForPreparation,
  verifyPinnedBinary,
} from "./prepare-fuigo.mjs";

// Verified against the published registry tarballs — each digest recomputed
// from the downloaded bytes at this bump, not copied forward. A shipped binary
// is never a floating range, so these live here as literals: changing the pin
// has to be a deliberate edit in two places.
const PINNED_ASSETS = {
  "darwin-arm64": {
    package: "@fuigo/darwin-arm64",
    tarballSha256: "8293eef6dfd26fd60e26da64bea00b634b0a35d39b88fc01db91b8668f5b83d6",
    binarySha256: "2831f872e0c5448873e4c8ee8397139d48900448ee2d00c4551ec595b753f040",
  },
  "darwin-x64": {
    package: "@fuigo/darwin-x64",
    tarballSha256: "ed7fb4cdd604ef8e1e28a21dfe159f914a66d749b6428fe1c02bc07ec7bb7313",
    binarySha256: "30d69a324a6e0727cc0fcfef4ead320a68a8418f5be02a243b2f4cf37e2d6faf",
  },
  "linux-arm64": {
    package: "@fuigo/linux-arm64",
    tarballSha256: "c01380ae81217e4274b0dca08f8c93b98e1334f01c04a7e25afd0cdfa6e90489",
    binarySha256: "e43e886656bcdc1e67db2131113211be94b4526cf11eeddf559ec6fe70aa97d7",
  },
  "linux-x64": {
    package: "@fuigo/linux-x64",
    tarballSha256: "f731a36d51ead90c44d398d506afca5de53ed0293f70cdfd626c208ad6507985",
    binarySha256: "eee61e7f31c84548c9288be246b46c3a1f5f5d9435135751ae0bb4fa4ad9100c",
  },
  "win32-arm64": {
    package: "@fuigo/win32-arm64",
    tarballSha256: "3767ba2497753ebdc9d036f472592aba2797f79e85266c132f7335a681adeb40",
    binarySha256: "e75e42d801a6de9b7b3f3c57fd579aab74d1662c087d13ed9f0385a0a2f8e259",
  },
  "win32-x64": {
    package: "@fuigo/win32-x64",
    tarballSha256: "b0e35ae1670cf10bbcb47aabd8defe69eae22e2b6613d98782f898eba097d846",
    binarySha256: "db4e4264b3a024811600ef92b43526a5ad5d28fe73877ead9474a24fff2c87d3",
  },
};

// Targets that are pinned above but that the shared executableTarget() header
// parser cannot classify yet, so nothing may try to fetch them.
const UNSTAGEABLE = ["win32-arm64"];

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function executableFixture(target) {
  const bytes = Buffer.alloc(128);
  if (target === "darwin-arm64" || target === "darwin-x64") {
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(target === "darwin-arm64" ? 0x0100000c : 0x01000007, 4);
  } else if (target === "linux-x64" || target === "linux-arm64") {
    // ELF64 little-endian; e_machine at offset 18 is 0x3e for x86-64 and 0xb7
    // for aarch64 — the values read off the real published 1.0.31 engines.
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(bytes);
    bytes.writeUInt16LE(target === "linux-arm64" ? 0xb7 : 0x3e, 18);
  } else if (target === "win32-x64" || target === "win32-arm64") {
    // PE32+; machine word follows the PE\0\0 signature. 0x8664 = AMD64,
    // 0xaa64 = IMAGE_FILE_MACHINE_ARM64, again as published.
    bytes.write("MZ", 0, "ascii");
    bytes.writeUInt32LE(0x40, 0x3c);
    bytes.write("PE\0\0", 0x40, "binary");
    bytes.writeUInt16LE(target === "win32-arm64" ? 0xaa64 : 0x8664, 0x44);
  } else {
    throw new Error(`executableFixture has no header for ${target}`);
  }
  return bytes;
}

describe("pinned fuigo packaging", () => {
  it("ties all six pins to official 1.0.31 metadata and the intended source commit", () => {
    const proof=JSON.parse(readFileSync(new URL("./fuigo-1.0.31-provenance.json",import.meta.url),"utf8"));
    expect(proof.version).toBe("1.0.31");expect(proof.source).toBe("d32d580c487ce889fe394a928d96073848150625");expect(proof.packages).toHaveLength(7);
    const wrapper=proof.packages.find(item=>item.target==="wrapper");expect(Object.keys(wrapper.optionalDependencies).sort()).toEqual(Object.values(FUIGO_ASSETS).map(item=>item.package).sort());expect(Object.values(wrapper.optionalDependencies).every(value=>value==="1.0.31")).toBe(true);
    for(const [target,pin] of Object.entries(FUIGO_ASSETS)) {const item=proof.packages.find(row=>row.target===target);expect(item.gitHead).toBe(proof.source);expect(item.tarball).toBe(tarballUrl(target));expect(item.tarballSha256).toBe(pin.tarballSha256);expect(item.binarySha256).toBe(pin.binarySha256);expect(item.header.target).toBe(target);expect(item.integrity).toMatch(/^sha512-/);expect(item.shasum).toMatch(/^[a-f0-9]{40}$/);}
    expect(proof.installScriptsExecuted).toBe(false);
  });

  it("pins the exact shipped version and a complete digest pair per target", () => {
    expect(FUIGO_VERSION).toBe("1.0.31");
    expect(FUIGO_ASSETS).toEqual(PINNED_ASSETS);
    for (const target of Object.keys(PINNED_ASSETS)) {
      // npm names a scoped package's tarball after the UNSCOPED half, so the
      // basename is `<target>-1.0.31.tgz`, never `@fuigo/<target>-1.0.31.tgz`.
      expect(tarballName(target)).toBe(`${target}-1.0.31.tgz`);
      expect(tarballName(target)).not.toContain("/");
      expect(tarballUrl(target)).toBe(
        `https://registry.npmjs.org/@fuigo/${target}/-/${target}-1.0.31.tgz`,
      );
      // The URL carries the pin, so a staged binary can never come from
      // whatever `latest` happens to be on the registry that day.
      expect(tarballUrl(target)).toContain("-1.0.31.tgz");
    }
  });

  it("pins every target fuigo@1.0.31 publishes, including ones it does not stage", () => {
    // The pin list is the reviewed-digest list; targetsForHost is the
    // packaged-target list. They are allowed to differ, and do.
    expect(Object.keys(FUIGO_ASSETS).sort()).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
      "win32-arm64",
      "win32-x64",
    ]);
  });

  it("stages both macOS architectures and only shipped desktop targets elsewhere", () => {
    expect(targetsForHost("darwin")).toEqual(["darwin-arm64", "darwin-x64"]);
    expect(targetsForHost("linux")).toEqual(["linux-x64"]);
    expect(targetsForHost("win32")).toEqual(["win32-x64"]);
    expect(() => targetsForHost("freebsd")).toThrow(/unsupported/);
  });

  it("selects by build target, not by the build host", () => {
    // An explicit target wins over anything this machine happens to be.
    expect(
      targetsForPreparation({ targets: ["win32-x64"], platform: "darwin", arch: "arm64" }),
    ).toEqual(["win32-x64"]);
    expect(
      targetsForPreparation({ targets: ["darwin-x64", "darwin-x64"], platform: "linux", arch: "x64" }),
    ).toEqual(["darwin-x64"]);
    expect(() => targetsForPreparation({ targets: ["freebsd-x64"] })).toThrow(/No pinned fuigo asset/);
    // Without one, the host's own package script decides.
    expect(targetsForPreparation({ platform: "darwin", arch: "arm64" })).toEqual([
      "darwin-arm64",
      "darwin-x64",
    ]);
    expect(targetsForPreparation({ current: true, platform: "darwin", arch: "arm64" })).toEqual([
      "darwin-arm64",
    ]);
    expect(targetForCurrentHost("linux", "x64")).toBe("linux-x64");
    // Still refused, but for a new reason. @fuigo/win32-arm64 is published,
    // pinned and runnable on such a host; what blocks it is that the shared
    // executableTarget() header parser cannot classify PE ARM64, so staging
    // would fail after the download rather than before it.
    expect(() => targetForCurrentHost("win32", "arm64")).toThrow(/unsupported/);
    // linux-arm64 is stageable now (Cloud homes on the build host CAX): the shared
    // header parser classifies ELF aarch64 (0xb7).
    expect(targetForCurrentHost("linux", "arm64")).toBe("linux-arm64");
    expect(targetsForPreparation({ targets: ["linux-arm64"] })).toEqual(["linux-arm64"]);
    expect(executableTarget(executableFixture("linux-arm64"))).toBe("linux-arm64");
  });

  it("refuses a pinned target the shared header parser cannot classify, before downloading", () => {
    for (const target of UNSTAGEABLE) {
      // Pinned...
      expect(FUIGO_ASSETS[target]).toBeDefined();
      // ...but every entry point that could start a fetch says no first.
      expect(() => targetsForPreparation({ targets: [target] })).toThrow(/not yet stageable/);
      // And the reason is real: the published header genuinely is rejected.
      expect(() => verifyPinnedBinary(executableFixture(target), target)).toThrow(/unsupported/);
    }
    // Nothing that IS staged is caught by that refusal.
    for (const target of targetsForHost("darwin")) {
      expect(targetsForPreparation({ targets: [target] })).toEqual([target]);
    }
  });

  it("accepts only the documented CLI options and the target env override", () => {
    expect(parsePrepareFuigoArgs([], {})).toEqual({ current: false, targets: [] });
    expect(parsePrepareFuigoArgs(["--current"], {})).toEqual({ current: true, targets: [] });
    expect(parsePrepareFuigoArgs(["--target", "linux-x64"], {})).toEqual({
      current: false,
      targets: ["linux-x64"],
    });
    expect(parsePrepareFuigoArgs(["--target=win32-x64"], {})).toEqual({
      current: false,
      targets: ["win32-x64"],
    });
    expect(parsePrepareFuigoArgs([], { MURAGE_FUIGO_TARGETS: "linux-x64, win32-x64" })).toEqual({
      current: false,
      targets: ["linux-x64", "win32-x64"],
    });
    expect(() => parsePrepareFuigoArgs(["--all"], {})).toThrow(/Usage:/);
    expect(() => parsePrepareFuigoArgs(["--target"], {})).toThrow(/Usage:/);
    expect(() => parsePrepareFuigoArgs(["--current", "--target", "linux-x64"], {})).toThrow(
      /mutually exclusive/,
    );
  });

  it("names the staged file from the one declaration the packager and server share", () => {
    expect(fuigoExecutableName("darwin-arm64")).toBe(FUIGO_EXECUTABLE_NAMES.darwin);
    expect(fuigoExecutableName("linux-x64")).toBe(FUIGO_EXECUTABLE_NAMES.linux);
    expect(fuigoExecutableName("win32-x64")).toBe(FUIGO_EXECUTABLE_NAMES.win32);
    expect(() => fuigoExecutableName("aix-ppc64")).toThrow(/no bundled fuigo/);
  });

  it("stages each target where electron-builder's per-platform `from:` looks", () => {
    for (const target of Object.keys(PINNED_ASSETS)) {
      expect(stagedDirectory("/repo", target)).toBe(join("/repo", "dist-native", "fuigo", target));
    }
  });

  it("records the pin in the staged manifest so a stale tree is restaged", () => {
    expect(expectedManifest("darwin-arm64")).toEqual({
      version: "1.0.31",
      target: "darwin-arm64",
      registryPackage: "@fuigo/darwin-arm64@1.0.31",
      tarball: "darwin-arm64-1.0.31.tgz",
      tarballSha256: PINNED_ASSETS["darwin-arm64"].tarballSha256,
      binarySha256: PINNED_ASSETS["darwin-arm64"].binarySha256,
    });
  });

  it("checks the executable header before accepting pinned bytes", () => {
    const bytes = executableFixture("darwin-arm64");
    // A correctly checksummed asset still cannot be filed under another target.
    expect(() => verifyPinnedBinary(bytes, "darwin-x64")).toThrow(/architecture mismatch/);
    expect(() => verifyPinnedBinary(bytes, "darwin-arm64")).toThrow(/SHA-256 verification/);
    expect(() => verifyPinnedBinary(Buffer.from("not an executable"), "linux-x64")).toThrow(
      /unsupported/,
    );
  });

  it("prepares fuigo as part of every packaged build", () => {
    expect(packageJson.scripts["build:fuigo"]).toBe("node scripts/prepare-fuigo.mjs");
    // package:prepare is what package:mac / :win / :linux all run.
    expect(packageJson.scripts["package:prepare"]).toContain("pnpm build:fuigo");
  });
});
