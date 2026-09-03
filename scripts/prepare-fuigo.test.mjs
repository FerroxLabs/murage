// The bundled Fuigo engine's packaging contract: an exact pinned version, one
// staged file per BUILD TARGET rather than per build host, and a staged file
// name that cannot drift from the electron-builder `to:` basename.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { FUIGO_EXECUTABLE_NAMES } from "../electron/harness-resources.mjs";
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

// Verified against the published registry tarballs. A shipped binary is never
// a floating range, so these live here as literals: changing the pin has to be
// a deliberate edit in two places.
const PINNED_ASSETS = {
  "darwin-arm64": {
    package: "fuigo-darwin-arm64",
    tarballSha256: "427c173e43e371952c5648127b9eead94c32afdd88b3579e2d6c30c8326fffbe",
    binarySha256: "8d8ead462def617c95e1fbdb01847b9115ca97d8f414bac68b768c397e725a28",
  },
  "darwin-x64": {
    package: "fuigo-darwin-x64",
    tarballSha256: "8ab3c8a1b856a9316841504ad279fb123edc4816f5c998c039f9e0ff36287b5c",
    binarySha256: "73d46ce9adf496af2d3264679a1e9f46428f21c3ed30d82dfee1f100777bdddc",
  },
  "linux-x64": {
    package: "fuigo-linux-x64",
    tarballSha256: "7a0d14eb02a7f481bc81c459c36ac7adfee05d29effffcad48c7f178f9c3af8b",
    binarySha256: "fc2d483f1cf724f1b69529e5a94b35e4c23209474dc90747c0719c4875887046",
  },
  "win32-x64": {
    package: "fuigo-win32-x64",
    tarballSha256: "42f6b25d248f12298af322b745118bb1db9c5f0f2cee50f97ff4e0515e5e6792",
    binarySha256: "81b364b7f9b02ba2c32c94e8c7dc6399fe82b036cea34f0a3ddd6ef1f9a788ac",
  },
};

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function executableFixture(target) {
  const bytes = Buffer.alloc(128);
  if (target === "darwin-arm64" || target === "darwin-x64") {
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(target === "darwin-arm64" ? 0x0100000c : 0x01000007, 4);
  } else if (target === "linux-x64") {
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(bytes);
    bytes.writeUInt16LE(0x3e, 18);
  } else if (target === "win32-x64") {
    bytes.write("MZ", 0, "ascii");
    bytes.writeUInt32LE(0x40, 0x3c);
    bytes.write("PE\0\0", 0x40, "binary");
    bytes.writeUInt16LE(0x8664, 0x44);
  }
  return bytes;
}

describe("pinned fuigo packaging", () => {
  it("pins the exact shipped version and a complete digest pair per target", () => {
    expect(FUIGO_VERSION).toBe("1.0.2");
    expect(FUIGO_ASSETS).toEqual(PINNED_ASSETS);
    for (const target of Object.keys(PINNED_ASSETS)) {
      expect(tarballName(target)).toBe(`${PINNED_ASSETS[target].package}-1.0.2.tgz`);
      // The URL carries the pin, so a staged binary can never come from
      // whatever `latest` happens to be on the registry that day.
      expect(tarballUrl(target)).toContain("-1.0.2.tgz");
    }
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
    expect(() => targetsForPreparation({ targets: ["win32-arm64"] })).toThrow(/No pinned fuigo asset/);
    // Without one, the host's own package script decides.
    expect(targetsForPreparation({ platform: "darwin", arch: "arm64" })).toEqual([
      "darwin-arm64",
      "darwin-x64",
    ]);
    expect(targetsForPreparation({ current: true, platform: "darwin", arch: "arm64" })).toEqual([
      "darwin-arm64",
    ]);
    expect(targetForCurrentHost("linux", "x64")).toBe("linux-x64");
    expect(() => targetForCurrentHost("win32", "arm64")).toThrow(/unsupported/);
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
      expect(stagedDirectory("/repo", target)).toBe(`/repo/dist-native/fuigo/${target}`);
    }
  });

  it("records the pin in the staged manifest so a stale tree is restaged", () => {
    expect(expectedManifest("darwin-arm64")).toEqual({
      version: "1.0.2",
      target: "darwin-arm64",
      registryPackage: "fuigo-darwin-arm64@1.0.2",
      tarball: "fuigo-darwin-arm64-1.0.2.tgz",
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
