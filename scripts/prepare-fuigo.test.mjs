// The bundled Fuigo engine's packaging contract: an exact pinned version, one
// staged file per BUILD TARGET rather than per build host, and a staged file
// name that cannot drift from the electron-builder `to:` basename.
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

// Verified against the published registry tarballs — each digest recomputed
// from the downloaded bytes at this bump, not copied forward. A shipped binary
// is never a floating range, so these live here as literals: changing the pin
// has to be a deliberate edit in two places.
const PINNED_ASSETS = {
  "darwin-arm64": {
    package: "@fuigo/darwin-arm64",
    tarballSha256: "ab7b23d70a3ba816703abe3e9597c65e09b458341059c0a8d400352c1c3c3c2f",
    binarySha256: "475431636935a63b32436e5279a014c1f34f7bccb2fbade0aac56318bd718fb2",
  },
  "darwin-x64": {
    package: "@fuigo/darwin-x64",
    tarballSha256: "6fa891eff5d63c3a3492bc39e9847438b7a29b49cef5b31a21f4799c564b22f5",
    binarySha256: "e000ebb48d6f48bf143611a707aed18ae77ebee169c886ae2f88fbdb7e87f85f",
  },
  "linux-arm64": {
    package: "@fuigo/linux-arm64",
    tarballSha256: "002eb0df8561b257ddfed8a373c07411fa7d4ced942676b5981360fbad86271d",
    binarySha256: "e375a178844a57aa11b05fba57bc8217e80ed5fadfcd1dd8f36834c867f7fe18",
  },
  "linux-x64": {
    package: "@fuigo/linux-x64",
    tarballSha256: "3973283fe5953403fb0958cea5099c508c4abc84a2ee5e4d642eb175ad13f2ef",
    binarySha256: "1ba9ee844e124af5f1931e6277e145a3201a889c74bf4cc9fd15730f023ff29c",
  },
  "win32-arm64": {
    package: "@fuigo/win32-arm64",
    tarballSha256: "7a82e85b2a784eb373d57580dce54f79891975f78c672031a1606da1288dabb3",
    binarySha256: "d035456fd450539ab1458c7dfeaea7563f5a8b88c417f35eeaa67dd43fa54f83",
  },
  "win32-x64": {
    package: "@fuigo/win32-x64",
    tarballSha256: "4a986f3a707b28d08cc3651337307a0c4dcd3ca1eaeb42a794a81b82a9ff778a",
    binarySha256: "4c19d38c418ad433cc2ad11b76a60ac5a4dd12b8e97d3937f10a410390e56cfc",
  },
};

// Targets that are pinned above but that the shared executableTarget() header
// parser cannot classify yet, so nothing may try to fetch them.
const UNSTAGEABLE = ["linux-arm64", "win32-arm64"];

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function executableFixture(target) {
  const bytes = Buffer.alloc(128);
  if (target === "darwin-arm64" || target === "darwin-x64") {
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(target === "darwin-arm64" ? 0x0100000c : 0x01000007, 4);
  } else if (target === "linux-x64" || target === "linux-arm64") {
    // ELF64 little-endian; e_machine at offset 18 is 0x3e for x86-64 and 0xb7
    // for aarch64 — the values read off the real published 1.0.13 engines.
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
  it("pins the exact shipped version and a complete digest pair per target", () => {
    expect(FUIGO_VERSION).toBe("1.0.13");
    expect(FUIGO_ASSETS).toEqual(PINNED_ASSETS);
    for (const target of Object.keys(PINNED_ASSETS)) {
      // npm names a scoped package's tarball after the UNSCOPED half, so the
      // basename is `<target>-1.0.13.tgz`, never `@fuigo/<target>-1.0.13.tgz`.
      expect(tarballName(target)).toBe(`${target}-1.0.13.tgz`);
      expect(tarballName(target)).not.toContain("/");
      expect(tarballUrl(target)).toBe(
        `https://registry.npmjs.org/@fuigo/${target}/-/${target}-1.0.13.tgz`,
      );
      // The URL carries the pin, so a staged binary can never come from
      // whatever `latest` happens to be on the registry that day.
      expect(tarballUrl(target)).toContain("-1.0.13.tgz");
    }
  });

  it("pins every target fuigo@1.0.13 publishes, including ones it does not stage", () => {
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
    expect(() => targetForCurrentHost("linux", "arm64")).toThrow(/unsupported/);
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
      version: "1.0.13",
      target: "darwin-arm64",
      registryPackage: "@fuigo/darwin-arm64@1.0.13",
      tarball: "darwin-arm64-1.0.13.tgz",
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
