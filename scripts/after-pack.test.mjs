import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import afterPack from "./after-pack.mjs";
import { LICENSE_FILES } from "./cua-linux-release.mjs";

const temporaryDirectories = [];

function fixture() {
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), "murage-after-pack-"));
  temporaryDirectories.push(appOutDir);
  const resources = path.join(appOutDir, "resources");
  const cua = path.join(resources, "cua-linux-x64");
  const licenses = path.join(cua, "licenses");
  fs.mkdirSync(licenses, { recursive: true, mode: 0o775 });
  for (const directory of [appOutDir, resources, cua, licenses]) fs.chmodSync(directory, 0o775);
  for (const name of ["cua-driver", "cua-cursor-theme", "release.json"]) {
    fs.writeFileSync(path.join(cua, name), "fixture", { mode: 0o664 });
    fs.chmodSync(path.join(cua, name), 0o664);
  }
  for (const name of LICENSE_FILES) {
    fs.writeFileSync(path.join(licenses, name), "fixture", { mode: 0o664 });
    fs.chmodSync(path.join(licenses, name), 0o664);
  }
  return { appOutDir, resources, cua, licenses };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform === "win32")("Linux afterPack permissions", () => {
  it("repairs every packaged CUA ancestor and resource mode", async () => {
    const { appOutDir, resources, cua, licenses } = fixture();

    await afterPack({ electronPlatformName: "linux", appOutDir });

    for (const directory of [appOutDir, resources, cua, licenses]) {
      expect(fs.lstatSync(directory).mode & 0o777).toBe(0o755);
    }
    for (const name of ["cua-driver", "cua-cursor-theme"]) {
      expect(fs.lstatSync(path.join(cua, name)).mode & 0o777).toBe(0o755);
    }
    expect(fs.lstatSync(path.join(cua, "release.json")).mode & 0o777).toBe(0o644);
    for (const name of fs.readdirSync(licenses)) {
      expect(fs.lstatSync(path.join(licenses, name)).mode & 0o777).toBe(0o644);
    }
  });

  it("fails closed when the runtime root is replaced by a symlink", async () => {
    const { appOutDir, cua } = fixture();
    const replacement = path.join(appOutDir, "replacement");
    fs.mkdirSync(replacement);
    fs.rmSync(cua, { recursive: true });
    fs.symlinkSync(replacement, cua, "dir");
    await expect(afterPack({ electronPlatformName: "linux", appOutDir })).rejects.toThrow(
      "must be a real directory",
    );
  });

  it("fails closed when the release manifest is missing", async () => {
    const { appOutDir, cua } = fixture();
    fs.unlinkSync(path.join(cua, "release.json"));
    await expect(afterPack({ electronPlatformName: "linux", appOutDir })).rejects.toThrow();
  });

  it("leaves non-Linux package modes unchanged", async () => {
    const { appOutDir, cua } = fixture();
    await afterPack({ electronPlatformName: "darwin", appOutDir });
    expect(fs.lstatSync(cua).mode & 0o777).toBe(0o775);
    expect(fs.lstatSync(path.join(cua, "cua-driver")).mode & 0o777).toBe(0o664);
  });
});

// The bundled Fuigo engine is validated inside the packaged app, before either
// artifact is assembled and before macOS signing rewrites its signature — the
// last point the upstream bytes exist unmodified in the bundle.
describe.skipIf(process.platform === "win32")("packaged fuigo resource", () => {
  function machO(arch) {
    const bytes = Buffer.alloc(128);
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(arch === "arm64" ? 0x0100000c : 0x01000007, 4);
    return bytes;
  }

  function elf64() {
    const bytes = Buffer.alloc(128);
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(bytes);
    bytes.writeUInt16LE(0x3e, 18);
    return bytes;
  }

  // Same resources path afterPack derives without an electron-builder packager.
  function withFuigo(platform, contents, entries = {}) {
    const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), "murage-after-pack-fuigo-"));
    temporaryDirectories.push(appOutDir);
    const resources = platform === "darwin"
      ? path.join(appOutDir, "Murage.app", "Contents", "Resources")
      : path.join(appOutDir, "resources");
    const root = path.join(resources, "fuigo");
    fs.mkdirSync(root, { recursive: true, mode: 0o775 });
    const executable = path.join(root, "fuigo");
    fs.writeFileSync(executable, contents, { mode: 0o664 });
    fs.chmodSync(executable, 0o664);
    for (const [name, value] of Object.entries(entries)) {
      fs.writeFileSync(path.join(root, name), value, { mode: 0o664 });
    }
    const licenses = path.join(resources, "licenses");
    fs.mkdirSync(licenses, { recursive: true, mode: 0o775 });
    for (const name of ["fuigo-LICENSE.txt", "fuigo-README.md", "fuigo-THIRD_PARTY_NOTICES.md"]) {
      fs.writeFileSync(path.join(licenses, name), "fixture", { mode: 0o664 });
    }
    return { appOutDir, resources, root, executable };
  }

  it("refuses a macOS engine in a Linux package", async () => {
    const { appOutDir } = withFuigo("linux", machO("arm64"));
    await expect(afterPack({ electronPlatformName: "linux", appOutDir })).rejects.toThrow(
      /wrong fuigo target: darwin-arm64/,
    );
  });

  it("refuses a Linux engine in a macOS package", async () => {
    const { appOutDir } = withFuigo("darwin", elf64());
    await expect(afterPack({ electronPlatformName: "darwin", appOutDir })).rejects.toThrow(
      /wrong fuigo target: linux-x64/,
    );
  });

  it("accepts either macOS architecture before checking the pinned bytes", async () => {
    for (const arch of ["arm64", "x64"]) {
      const { appOutDir } = withFuigo("darwin", machO(arch));
      // Past the architecture gate; only the digest stops this fixture.
      await expect(afterPack({ electronPlatformName: "darwin", appOutDir })).rejects.toThrow(
        /SHA-256 verification/,
      );
    }
  });

  it("refuses an npm shim or the compressed artifact in place of the executable", async () => {
    const shim = Buffer.from("#!/usr/bin/env node\nrequire('./fuigo-bootstrap.js');\n");
    const { appOutDir } = withFuigo("linux", shim);
    await expect(afterPack({ electronPlatformName: "linux", appOutDir })).rejects.toThrow(
      /unsupported executable format/,
    );
  });

  it("refuses stray entries beside the engine", async () => {
    const { appOutDir } = withFuigo("linux", elf64(), { "manifest.json": "{}" });
    await expect(afterPack({ electronPlatformName: "linux", appOutDir })).rejects.toThrow(
      /Unexpected entries in packaged fuigo resource/,
    );
  });

  it("refuses bytes that are not the pinned engine", async () => {
    const { appOutDir } = withFuigo("linux", elf64());
    await expect(afterPack({ electronPlatformName: "linux", appOutDir })).rejects.toThrow(
      /SHA-256 verification/,
    );
  });

  it("repairs the executable bit electron-builder drops on the copied resource", async () => {
    const { appOutDir, executable } = withFuigo("linux", elf64());
    await expect(afterPack({ electronPlatformName: "linux", appOutDir })).rejects.toThrow();
    // The mode is repaired before the digest check, so a shipped engine is
    // never left unrunnable by electron-builder's 0664 normalization.
    expect(fs.lstatSync(executable).mode & 0o777).toBe(0o755);
  });
});
