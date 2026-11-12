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
  registryBytes,
  stagedDirectory,
  tarballName,
  tarballUrl,
  tarballUrls,
  targetForCurrentHost,
  targetsForHost,
  targetsForPreparation,
  verifyPinnedBinary,
} from "./prepare-fuigo.mjs";

// Pending Fuigo 1.0.43 pins, filled with the verified release record. A shipped binary
// is never a floating range, so these live here as literals: changing the pin
// has to be a deliberate edit in two places.
const PINNED_ASSETS = {
  "darwin-arm64": {
    package: "@fuigo/darwin-arm64",
    tarballSha256: "FILL-AT-NPM",
    binarySha256: "FILL-AT-NPM",
  },
  "darwin-x64": {
    package: "@fuigo/darwin-x64",
    tarballSha256: "FILL-AT-NPM",
    binarySha256: "FILL-AT-NPM",
  },
  "linux-arm64": {
    package: "@fuigo/linux-arm64",
    tarballSha256: "FILL-AT-NPM",
    binarySha256: "FILL-AT-NPM",
  },
  "linux-x64": {
    package: "@fuigo/linux-x64",
    tarballSha256: "FILL-AT-NPM",
    binarySha256: "FILL-AT-NPM",
  },
  "win32-arm64": {
    package: "@fuigo/win32-arm64",
    tarballSha256: "FILL-AT-NPM",
    binarySha256: "FILL-AT-NPM",
  },
  "win32-x64": {
    package: "@fuigo/win32-x64",
    tarballSha256: "FILL-AT-NPM",
    binarySha256: "FILL-AT-NPM",
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
    // for aarch64 — the architecture identifiers for these targets.
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
  it("ties every active pin to the pending or verified 1.0.43 receipt", () => {
    const proof = JSON.parse(readFileSync(new URL("./fuigo-1.0.43-provenance.json", import.meta.url), "utf8"));
    expect(proof.version).toBe("1.0.43");
    expect(proof.packages).toHaveLength(7);
    expect(proof.installScriptsExecuted).toBe(false);
    expect(proof.nativeExecutablesRun).toBe(false);
    expect(["FILL-AT-NPM", "filled"]).toContain(proof.status);
    const pending = proof.status === "FILL-AT-NPM";
    for (const row of proof.packages) {
      expect(row.version).toBe("1.0.43");
      expect(row.tarballSha256).toMatch(pending ? /^FILL-AT-NPM$/ : /^[a-f0-9]{64}$/);
      expect(row.integrity).toMatch(pending ? /^FILL-AT-NPM$/ : /^sha512-[A-Za-z0-9+/]{86}==$/);
      expect(row.shasum).toMatch(pending ? /^FILL-AT-NPM$/ : /^[a-f0-9]{40}$/);
    }
    expect(proof.source).toMatch(pending ? /^FILL-AT-NPM$/ : /^[a-f0-9]{40}$/);
    for (const [target, asset] of Object.entries(FUIGO_ASSETS)) {
      const row = proof.packages.find(item => item.target === target);
      expect(row).toMatchObject({ tarballSha256: asset.tarballSha256, binarySha256: asset.binarySha256, name: asset.package, version: FUIGO_VERSION, tarball: tarballUrl(target) });
      for (const digest of [row.tarballSha256, row.binarySha256]) {
        expect(digest).toMatch(pending ? /^FILL-AT-NPM$/ : /^[a-f0-9]{64}$/);
      }
    }
    const wrapper = proof.packages.find(item => item.target === "wrapper");
    expect(wrapper.optionalDependencies).toEqual(Object.fromEntries(Object.values(FUIGO_ASSETS).map(asset => [asset.package, FUIGO_VERSION])));
  });

  it("refuses pending pins before preparing any target", async () => {
    if (FUIGO_ASSETS["linux-x64"].binarySha256 !== "FILL-AT-NPM") return;
    const fetcher = vi.spyOn(globalThis, "fetch");
    try {
      await expect(prepareFuigo({ root: "/unused", targets: ["linux-x64"] })).rejects.toThrow(/FILL-AT-NPM/);
      expect(fetcher).not.toHaveBeenCalled();
    } finally { fetcher.mockRestore(); }
  });

  it("pins the exact shipped version and a complete digest pair per target", () => {
    expect(FUIGO_VERSION).toBe("1.0.43");
    for (const file of ["../shared/capabilities/engines.yaml", "../shared/capability-db.ts"]) {
      const knowledge = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(knowledge).toContain(`Desktop Murage bundles Fuigo ${FUIGO_VERSION};`);
    }
    expect(FUIGO_ASSETS).toEqual(PINNED_ASSETS);
    for (const target of Object.keys(PINNED_ASSETS)) {
      // npm names a scoped package's tarball after the UNSCOPED half, so the
      // basename is `<target>-1.0.43.tgz`, never `@fuigo/<target>-1.0.43.tgz`.
      expect(tarballName(target)).toBe(`${target}-1.0.43.tgz`);
      expect(tarballName(target)).not.toContain("/");
      expect(tarballUrl(target)).toBe(
        `https://registry.npmjs.org/@fuigo/${target}/-/${target}-1.0.43.tgz`,
      );
      // The URL carries the pin, so a staged binary can never come from
      // whatever `latest` happens to be on the registry that day.
      expect(tarballUrl(target)).toContain("-1.0.43.tgz");
    }
  });

  it("pins every target fuigo@1.0.43 publishes, including ones it does not stage", () => {
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

  it("offers npm and GitHub Release URLs for the same pinned tarball on every target", () => {
    for (const target of Object.keys(PINNED_ASSETS)) {
      expect(tarballUrls(target)).toEqual([
        `https://registry.npmjs.org/@fuigo/${target}/-/${target}-1.0.43.tgz`,
        `https://github.com/FerroxLabs/fuigo/releases/download/v1.0.43/fuigo-${target}-1.0.43.tgz`,
      ]);
    }
  });

  it.each(["none", "http", "network", "body"])("checks the same digest after %s download failure", async (failure) => {
    const bytes = Buffer.from("synthetic archive");
    const fetcher = vi.fn();
    if (failure === "http") fetcher.mockResolvedValueOnce(new Response(null, { status: 503 }));
    if (failure === "network") fetcher.mockRejectedValueOnce(new Error("offline"));
    if (failure === "body") fetcher.mockResolvedValueOnce({ ok: true, arrayBuffer: async () => { throw new Error("truncated transfer"); } });
    fetcher.mockResolvedValueOnce(new Response(bytes));
    const checksum = vi.spyOn(cloudflared, "verifySha256").mockReturnValue(PINNED_ASSETS["linux-x64"].tarballSha256);
    try {
      expect(await registryBytes("linux-x64", { fetcher, archiveDirectory: "" })).toEqual(bytes);
      expect(fetcher.mock.calls.map(([url]) => url)).toEqual(tarballUrls("linux-x64").slice(0, failure === "none" ? 1 : 2));
      expect(checksum).toHaveBeenCalledExactlyOnceWith(bytes, PINNED_ASSETS["linux-x64"].tarballSha256, "linux-x64-1.0.43.tgz");
    } finally {
      checksum.mockRestore();
    }
  });

  it.each([false, true])("rejects corrupt archive bytes (fallback: %s) before extraction", async (fallback) => {
    const fetcher = vi.fn();
    if (fallback) fetcher.mockResolvedValueOnce(new Response(null, { status: 404 }));
    fetcher.mockResolvedValueOnce(new Response("corrupt archive"));
    await expect(registryBytes("linux-x64", { fetcher, archiveDirectory: "" })).rejects.toThrow(/SHA-256 verification/);
    expect(fetcher).toHaveBeenCalledTimes(fallback ? 2 : 1);
  });

  it("reports both unavailable download sources", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    await expect(registryBytes("linux-x64", { fetcher, archiveDirectory: "" })).rejects.toThrow(/registry\.npmjs\.org.*HTTP 503.*github\.com.*HTTP 503/);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects a corrupt offline archive without trying a network source", async () => {
    const root = mkdtempSync(join(tmpdir(), "murage-fuigo-cache-"));
    const fetcher = vi.fn();
    try {
      writeFileSync(join(root, tarballName("linux-x64")), "corrupt cache");
      await expect(registryBytes("linux-x64", { fetcher, archiveDirectory: root })).rejects.toThrow(/SHA-256 verification/);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      safeWipeSync(root);
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

      if (FUIGO_ASSETS[target].binarySha256 === "FILL-AT-NPM") {
        await expect(prepareFuigo({ root, targets: [target] })).rejects.toThrow(/FILL-AT-NPM/);
        expect(paths.map(path => statSync(path).mode & 0o777)).toEqual([0o700, 0o600, 0o700]);
        expect(fetch).not.toHaveBeenCalled();
        return;
      }
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
      version: "1.0.43",
      target: "darwin-arm64",
      registryPackage: "@fuigo/darwin-arm64@1.0.43",
      tarball: "darwin-arm64-1.0.43.tgz",
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
