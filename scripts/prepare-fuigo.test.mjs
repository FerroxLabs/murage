// The bundled Fuigo engine's packaging contract: an exact pinned version, one
// staged file per BUILD TARGET rather than per build host, and a staged file
// name that cannot drift from the electron-builder `to:` basename.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { FUIGO_EXECUTABLE_NAMES } from "../electron/harness-resources.mjs";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
import { executableTarget } from "./prepare-cloudflared.mjs";
import * as cloudflared from "./prepare-cloudflared.mjs";
import {
  FUIGO_ASSETS,
  FUIGO_VERSION,
  expectedManifest,
  finalizeTargetDirectory,
  fuigoExecutableName,
  parsePrepareFuigoArgs,
  prepareFuigo,
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
    tarballSha256: "5cbd899c77ccb9fd3bb0232efdb84594c6bee9a98f4b28ed16b007c11d84b173",
    binarySha256: "b325cf67bdd1fcede7f8fad43f28c49b46590acd3d9195067581e179fbfdbb9b",
  },
  "darwin-x64": {
    package: "@fuigo/darwin-x64",
    tarballSha256: "59c55d9875afba16e613ad54ebaadec2069c37addb630f68442cd123e71c61f0",
    binarySha256: "e4aafaaedb44fddab521e35dcdc03e8862d0d55084226d21a0cd1fe8b4d79c61",
  },
  "linux-arm64": {
    package: "@fuigo/linux-arm64",
    tarballSha256: "5d421b31b818d04de033fadc29e7b66d451836ac9a18519769223b218eaf2800",
    binarySha256: "43614a9f2bb7145fd4d8ffedf8a8a452c899f9ac1a1002ab2fd7dc05705cc055",
  },
  "linux-x64": {
    package: "@fuigo/linux-x64",
    tarballSha256: "90d0aeb92589be3f89561b50aaada82294a4c5ded95115c14905dc610e106a0a",
    binarySha256: "fe9024dc4fb479a08ba9898d3de3ff0b94c2e8a0d04c1b46b386965a2c0fc835",
  },
  "win32-arm64": {
    package: "@fuigo/win32-arm64",
    tarballSha256: "64c0f43a0b13a1d5a5f27d2c095538f4312d1bbfa610a29ef138448f0e6b9577",
    binarySha256: "24f5167ddb624cdf36b20d5010cc4cd0f3b7dcdf6e4e58c51c6dbfe00895ba97",
  },
  "win32-x64": {
    package: "@fuigo/win32-x64",
    tarballSha256: "b9c541949d6cbb2a2722faf5f5c30b54237b32e90812670f5e62a1b17e0fdd91",
    binarySha256: "dc63a79e3004682d17612f672fafdfb847e83adc158be799592c5a966ae9591a",
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
    // for aarch64 — the values read off the real published 1.0.39 engines.
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
  it("ties all six pins to official 1.0.39 metadata and the intended source commit", () => {
    const proof=JSON.parse(readFileSync(new URL("./fuigo-1.0.39-provenance.json",import.meta.url),"utf8"));
    expect(proof.version).toBe("1.0.39");expect(proof.source).toBe("1d4f04b330d15e9f68907ae431cd1f6a2548d997");expect(proof.packages).toHaveLength(7);
    const wrapper=proof.packages.find(item=>item.target==="wrapper");expect(Object.keys(wrapper.optionalDependencies).sort()).toEqual(Object.values(FUIGO_ASSETS).map(item=>item.package).sort());expect(Object.values(wrapper.optionalDependencies).every(value=>value==="1.0.39")).toBe(true);
    for(const [target,pin] of Object.entries(FUIGO_ASSETS)) {const item=proof.packages.find(row=>row.target===target);expect(item.gitHead).toBe(proof.source);expect(item.tarball).toBe(tarballUrl(target));expect(item.tarballSha256).toBe(pin.tarballSha256);expect(item.binarySha256).toBe(pin.binarySha256);expect(item.header.target).toBe(target);expect(item.integrity).toMatch(/^sha512-/);expect(item.shasum).toMatch(/^[a-f0-9]{40}$/);}
    expect(proof.installScriptsExecuted).toBe(false);
  });

  it("pins the exact shipped version and a complete digest pair per target", () => {
    expect(FUIGO_VERSION).toBe("1.0.39");
    expect(FUIGO_ASSETS).toEqual(PINNED_ASSETS);
    for (const target of Object.keys(PINNED_ASSETS)) {
      // npm names a scoped package's tarball after the UNSCOPED half, so the
      // basename is `<target>-1.0.39.tgz`, never `@fuigo/<target>-1.0.39.tgz`.
      expect(tarballName(target)).toBe(`${target}-1.0.39.tgz`);
      expect(tarballName(target)).not.toContain("/");
      expect(tarballUrl(target)).toBe(
        `https://registry.npmjs.org/@fuigo/${target}/-/${target}-1.0.39.tgz`,
      );
      // The URL carries the pin, so a staged binary can never come from
      // whatever `latest` happens to be on the registry that day.
      expect(tarballUrl(target)).toContain("-1.0.39.tgz");
    }
  });

  it("pins every target fuigo@1.0.39 publishes, including ones it does not stage", () => {
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

  it.skipIf(process.platform === "win32").each([
    "darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64",
  ])("publishes %s with modes readable by the runtime user", (target) => {
    const root = mkdtempSync(join(tmpdir(), "murage-prepare-fuigo-"));
    try {
      const staging = mkdtempSync(join(root, `.${target}-`));
      const finalDirectory = join(root, target);
      const executable = fuigoExecutableName(target);
      const manifest = `${JSON.stringify(expectedManifest(target))}\n`;
      writeFileSync(join(staging, executable), executableFixture(target), { mode: 0o700 });
      writeFileSync(join(staging, "manifest.json"), manifest, { mode: 0o600 });
      // Explicit private modes make the regression independent of umask.
      chmodSync(staging, 0o700);
      chmodSync(join(staging, executable), 0o700);
      chmodSync(join(staging, "manifest.json"), 0o600);

      finalizeTargetDirectory(staging, finalDirectory, target);

      expect(existsSync(staging)).toBe(false);
      expect(statSync(finalDirectory).mode & 0o777).toBe(0o755);
      expect(statSync(join(finalDirectory, "manifest.json")).mode & 0o777).toBe(0o644);
      expect(statSync(join(finalDirectory, executable)).mode & 0o777).toBe(0o755);
      expect(readFileSync(join(finalDirectory, "manifest.json"), "utf8")).toBe(manifest);
      expect(readFileSync(join(finalDirectory, executable))).toEqual(executableFixture(target));
    } finally {
      safeWipeSync(root);
    }
  });

  it.skipIf(process.platform === "win32")("widens a pre-existing same-version tree to 0755/0644/0755 on an offline prepare rerun", async () => {
    const root = mkdtempSync(join(tmpdir(), "murage-prepare-fuigo-"));
    // A non-host target keeps the synthetic executable from being run.
    const target = process.platform === "linux" && process.arch === "arm64"
      ? "linux-x64" : "linux-arm64";
    const directory = stagedDirectory(root, target);
    const binary = join(directory, fuigoExecutableName(target));
    const manifestFile = join(directory, "manifest.json");
    const bytes = executableFixture(target);
    const manifest = `${JSON.stringify(expectedManifest(target))}\n`;
    const checksum = vi.spyOn(cloudflared, "verifySha256")
      .mockReturnValue(FUIGO_ASSETS[target].binarySha256);
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("unexpected network access during offline prepare rerun"));
    try {
      mkdirSync(directory, { recursive: true });
      writeFileSync(binary, bytes);
      writeFileSync(manifestFile, manifest);
      chmodSync(directory, 0o700);
      chmodSync(manifestFile, 0o600);
      chmodSync(binary, 0o700);
      const paths = [directory, manifestFile, binary];
      const inodes = paths.map((path) => statSync(path).ino);

      await prepareFuigo({ root, targets: [target] });

      expect(paths.map((path) => statSync(path).mode & 0o777)).toEqual([0o755, 0o644, 0o755]);
      expect(paths.map((path) => statSync(path).ino)).toEqual(inodes);
      expect(readFileSync(manifestFile, "utf8")).toBe(manifest);
      expect(readFileSync(binary)).toEqual(bytes);
      expect(checksum).toHaveBeenCalledExactlyOnceWith(
        bytes, FUIGO_ASSETS[target].binarySha256, `${target} fuigo executable`,
      );
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      checksum.mockRestore();
      fetch.mockRestore();
      safeWipeSync(root);
    }
  });

  it("records the pin in the staged manifest so a stale tree is restaged", () => {
    expect(expectedManifest("darwin-arm64")).toEqual({
      version: "1.0.39",
      target: "darwin-arm64",
      registryPackage: "@fuigo/darwin-arm64@1.0.39",
      tarball: "darwin-arm64-1.0.39.tgz",
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
