import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  CLOUDFLARED_ASSETS,
  CLOUDFLARED_VERSION,
  executableTarget,
  parsePrepareCloudflaredArgs,
  sha256,
  targetForCurrentHost,
  targetsForHost,
  targetsForPreparation,
  verifyPinnedBinary,
  verifySha256,
} from "./prepare-cloudflared.mjs";

const PINNED_ASSETS = {
  "darwin-arm64": {
    name: "cloudflared-darwin-arm64.tgz",
    sha256: "1165d14b6f6360a3b8c283d7d1100024d6ec7cd9bc9e32519e96150645f3ec55",
    binarySha256: "f249139e0541fa589c987397d867cc16c83ab1236d31eb6782f2e4552ee9cf80",
    archive: true,
  },
  "darwin-x64": {
    name: "cloudflared-darwin-amd64.tgz",
    sha256: "81b7b85f2376815c4f59b1aa323887b62e16ce8b67555c2e1577dc23f2a82000",
    binarySha256: "947e2942d6a59922d80190d23b12f3ade8da16e23e3bd937182a48993b7c00db",
    archive: true,
  },
  "linux-x64": {
    name: "cloudflared-linux-amd64",
    sha256: "053b80b0a23031a038fdbf3c073f59f82b8f1f152aa67971d7383ffafc0dbab0",
    binarySha256: "053b80b0a23031a038fdbf3c073f59f82b8f1f152aa67971d7383ffafc0dbab0",
    archive: false,
  },
  "linux-arm64": {
    name: "cloudflared-linux-arm64",
    sha256: "89297ebfb9e8c99c0dc013a1140601453cf3798d8306c5591651f4a3f5210be8",
    binarySha256: "89297ebfb9e8c99c0dc013a1140601453cf3798d8306c5591651f4a3f5210be8",
    archive: false,
  },
  "win32-x64": {
    name: "cloudflared-windows-amd64.exe",
    sha256: "76b2805253d0d6ffacb092a7acfbee99e7af6917835c0c5410e23f3ef5052da2",
    binarySha256: "76b2805253d0d6ffacb092a7acfbee99e7af6917835c0c5410e23f3ef5052da2",
    archive: false,
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
  } else if (target === "linux-arm64") {
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(bytes);
    bytes.writeUInt16LE(0xb7, 18);
  } else if (target === "win32-x64") {
    bytes.write("MZ", 0, "ascii");
    bytes.writeUInt32LE(0x40, 0x3c);
    bytes.write("PE\0\0", 0x40, "binary");
    bytes.writeUInt16LE(0x8664, 0x44);
  }
  return bytes;
}

describe("pinned cloudflared packaging", () => {
  it("stages both macOS architectures and only shipped desktop targets elsewhere", () => {
    expect(targetsForHost("darwin")).toEqual(["darwin-arm64", "darwin-x64"]);
    expect(targetsForHost("linux")).toEqual(["linux-x64"]);
    expect(targetsForHost("win32")).toEqual(["win32-x64"]);
    expect(() => targetsForHost("freebsd")).toThrow(/unsupported/);
  });

  it("stages only the exact current desktop target in development mode", () => {
    expect(targetForCurrentHost("darwin", "arm64")).toBe("darwin-arm64");
    expect(targetForCurrentHost("darwin", "x64")).toBe("darwin-x64");
    expect(targetForCurrentHost("linux", "x64")).toBe("linux-x64");
    expect(targetForCurrentHost("win32", "x64")).toBe("win32-x64");
    expect(targetsForPreparation({ current: true, platform: "darwin", arch: "arm64" })).toEqual([
      "darwin-arm64",
    ]);
    expect(targetsForPreparation({ current: false, platform: "darwin", arch: "arm64" })).toEqual([
      "darwin-arm64",
      "darwin-x64",
    ]);
    expect(targetForCurrentHost("linux", "arm64")).toBe("linux-arm64");
  });

  it("accepts only the documented current-target CLI option", () => {
    expect(parsePrepareCloudflaredArgs([])).toEqual({ current: false });
    expect(parsePrepareCloudflaredArgs(["--current"])).toEqual({ current: true });
    expect(() => parsePrepareCloudflaredArgs(["--all"])).toThrow(/Usage:/);
    expect(() => parsePrepareCloudflaredArgs(["--current", "--current"])).toThrow(/Usage:/);
  });

  it("stages the current target for development without narrowing package preparation", () => {
    expect(packageJson.scripts["dev:desktop"]).toBe(
      "node scripts/prepare-source-cage.mjs && node scripts/prepare-cloudflared.mjs --current && electron .",
    );
    expect(packageJson.scripts["build:cloudflared"]).toBe(
      "node scripts/prepare-cloudflared.mjs",
    );
  });

  it("pins a complete release asset and digest for every packaged target", () => {
    expect(CLOUDFLARED_VERSION).toBe("2026.10.3");
    expect(CLOUDFLARED_ASSETS).toEqual(PINNED_ASSETS);
  });

  it("rejects altered release bytes", () => {
    const payload = Buffer.from("official bytes");
    const digest = sha256(payload);
    expect(verifySha256(payload, digest)).toBe(digest);
    expect(() => verifySha256(Buffer.from("altered"), digest)).toThrow(/SHA-256 verification/);
  });

  it("recognizes only the executable formats and architectures we ship", () => {
    for (const target of Object.keys(PINNED_ASSETS)) {
      expect(executableTarget(executableFixture(target))).toBe(target);
    }
    expect(() => executableTarget(Buffer.from("not an executable"))).toThrow(/unsupported/);
  });

  it("checks architecture before accepting a pinned executable", () => {
    const bytes = executableFixture("darwin-arm64");
    expect(() => verifyPinnedBinary(bytes, "darwin-x64")).toThrow(/architecture mismatch/);
    expect(() => verifyPinnedBinary(bytes, "darwin-arm64")).toThrow(/SHA-256 verification/);
  });
});
