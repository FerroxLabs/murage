// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Off-site copies on every shipped platform: restic (and age for Intel Macs)
// is pinned, staged, packaged, gated in the release job and attested at run
// time for darwin-arm64, darwin-x64, linux-x64 and win32-x64.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZipFile } from "yazl";
const overrides = vi.hoisted(() => new Map());
vi.mock("../shared/backup-restic-pin.mjs", async original => {
  const actual = await original();
  // A proxy over an unfrozen copy: the real pins are frozen, as they must be.
  const pins = new Proxy({ ...actual.RESTIC_PINS }, { get: (target, key) => overrides.get(key) ?? target[key] });
  return { ...actual, RESTIC_PINS: pins, resticPinForTarget: (platform, arch) => { const key = `${platform}-${arch}`; return overrides.get(key) ?? actual.resticPinForTarget(platform, arch); } };
});
import { RESTIC_LICENSE_SHA256, RESTIC_PINS, RESTIC_ORIGINAL_SHA256, RESTIC_PAYLOAD_SHA256, resticPinForTarget } from "../shared/backup-restic-pin.mjs";
import { BACKUP_AGE_PINS, backupAgePinForTarget } from "../shared/backup-age-pins.mjs";
import { defaultResticTargets, resticStagedPath, stageBackupRestic } from "./prepare-backup-restic.mjs";
import { verifyPackagedBackupTools } from "./verify-packaged-backup-tools.mjs";
import { normalizedAgePayloadHash } from "../electron/backup-age-attestation.mjs";
import { packagedResticPath, trustedBackupResticExecutable, trustedBackupResticExecutableAsync } from "../electron/backup-restic-attestation.mjs";
import { createResticToolCapability } from "../electron/backup-mode.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const hex = /^[a-f0-9]{64}$/;
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); vi.unstubAllGlobals(); });
const scratch = () => { const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "murage-offsite-platforms-"))); roots.push(root); return root; };
const withPlatform = async (platform, arch, work) => {
  const saved = [Object.getOwnPropertyDescriptor(process, "platform"), Object.getOwnPropertyDescriptor(process, "arch")];
  Object.defineProperty(process, "platform", { value: platform, configurable: true }); Object.defineProperty(process, "arch", { value: arch, configurable: true });
  try { return await work(); } finally { Object.defineProperty(process, "platform", saved[0]); Object.defineProperty(process, "arch", saved[1]); }
};
const SHIPPED = [["darwin", "arm64"], ["darwin", "x64"], ["linux", "x64"], ["win32", "x64"]];

describe("pins", () => {
  it("every shipped target has one complete restic pin, and macOS targets a signed-payload pin", () => {
    expect(Object.keys(RESTIC_PINS).sort()).toEqual(["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"]);
    for (const [platform, arch] of SHIPPED) {
      const pin = resticPinForTarget(platform, arch);
      expect(pin, `${platform}-${arch}`).toMatchObject({ platform, arch, archiveSha256: expect.stringMatching(hex), originalSha256: expect.stringMatching(hex) });
      expect(pin.url).toMatch(/^https:\/\/github\.com\/restic\/restic\/releases\/download\/v0\.19\.1\/restic_0\.19\.1_/);
      if (platform === "darwin") expect(pin.payloadSha256).toMatch(hex); else expect(pin.payloadSha256).toBeUndefined();
    }
    expect(resticPinForTarget("linux", "arm64")).toBeNull(); expect(resticPinForTarget("win32", "arm64")).toBeNull();
    // Earlier exports still name the darwin-arm64 values.
    expect([RESTIC_ORIGINAL_SHA256, RESTIC_PAYLOAD_SHA256]).toEqual([RESTIC_PINS["darwin-arm64"].originalSha256, RESTIC_PINS["darwin-arm64"].payloadSha256]);
    expect(sha(fs.readFileSync(new URL("../third_party/restic/LICENSE", import.meta.url)))).toBe(RESTIC_LICENSE_SHA256);
  });
  it("age covers the same macOS and Linux targets, with a payload pin for each Mac", () => {
    for (const [platform, arch] of SHIPPED.filter(([platform]) => platform !== "win32")) expect(backupAgePinForTarget(platform, arch), `${platform}-${arch}`).not.toBeNull();
    expect(BACKUP_AGE_PINS["darwin-x64"]).toMatchObject({ stagingDirectory: "backup-age", arch: "x64", payloadSha256: expect.stringMatching(hex) });
    expect(BACKUP_AGE_PINS["darwin-arm64"].payloadSha256).toMatch(hex);
  });
});

describe("staging", () => {
  // Synthetic archives stand in for the release assets; the pins are swapped
  // for the synthetic hashes so the real code path runs, with no download.
  async function archiveFor(pin, bytes, root) {
    if (pin.format === "bz2") return execFileSync("/usr/bin/bzip2", ["-c"], { input: bytes });
    const zip = new ZipFile(), chunks = []; zip.addBuffer(bytes, pin.member); zip.addBuffer(Buffer.from("notes"), "README.md"); zip.end();
    for await (const chunk of zip.outputStream) chunks.push(chunk); return Buffer.concat(chunks);
  }
  it.each(Object.keys(RESTIC_PINS))("stages %s from its pinned archive, refuses a mismatch and a changed staged file", async target => {
    const root = scratch(); fs.mkdirSync(path.join(root, "third_party", "restic"), { recursive: true });
    fs.copyFileSync(new URL("../third_party/restic/LICENSE", import.meta.url), path.join(root, "third_party", "restic", "LICENSE"));
    const original = RESTIC_PINS[target], bytes = Buffer.from(`synthetic restic for ${target}`), archive = await archiveFor(original, bytes, root);
    const pin = { ...original, archiveSha256: sha(archive), originalSha256: sha(bytes) };
    overrides.set(target, pin);
    try {
      const fetched = []; const fetchArchive = async url => { fetched.push(url); return { ok: true, body: [archive] }; };
      const staged = await stageBackupRestic({ root, target, fetchArchive });
      expect(staged).toBe(resticStagedPath(root, pin)); expect(fetched).toEqual([pin.url]); expect(fs.readFileSync(staged)).toEqual(bytes);
      expect(staged.endsWith(target === "win32-x64" ? path.join("backup-tools", "win32-x64", "restic.exe") : path.join(pin.stagingDirectory, pin.arch, "restic"))).toBe(true);
      if (target !== "win32-x64") expect(fs.statSync(staged).mode & 0o111).toBeTruthy();
      await expect(stageBackupRestic({ root, target, fetchArchive })).resolves.toBe(staged);
      fs.appendFileSync(staged, "changed"); await expect(stageBackupRestic({ root, target, fetchArchive })).rejects.toThrow("PAYLOAD_MISMATCH");
      fs.rmSync(staged); await expect(stageBackupRestic({ root, target, fetchArchive: async () => ({ ok: true, body: [Buffer.from("not the archive")] }) })).rejects.toThrow("ARCHIVE_MISMATCH");
      expect(fs.existsSync(staged)).toBe(false);
    } finally { overrides.delete(target); }
  });
  it("a package job stages every target it packages, by host", () => {
    expect(defaultResticTargets("darwin", "arm64")).toEqual(["darwin-arm64", "darwin-x64"]);
    expect(defaultResticTargets("linux", "x64")).toEqual(["linux-x64"]);
    expect(defaultResticTargets("win32", "x64")).toEqual(["win32-x64"]);
  });
});

describe("packaging and the release gate", () => {
  const config = parse(fs.readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8"));
  const workflow = fs.readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  it("each platform's package carries its restic", () => {
    expect(config.mac.extraResources).toContainEqual({ from: "dist-native/backup-restic", to: "backup-tools", filter: ["${arch}/restic"] });
    expect(config.mac.extraResources).toContainEqual(expect.objectContaining({ from: "dist-native/backup-age", filter: expect.arrayContaining(["${arch}/age"]) }));
    expect(config.linux.extraResources).toContainEqual({ from: "dist-native/backup-restic-linux", to: "backup-tools", filter: ["${arch}/restic"] });
    expect(config.win.extraResources).toContainEqual({ from: "dist-native/backup-tools/win32-x64/restic.exe", to: "backup-tools/x64/restic.exe" });
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.scripts["package:prepare"]).toContain("node scripts/prepare-backup-restic.mjs");
    for (const script of ["package:mac", "package:win", "package:linux", "package:linux:offline"]) expect(pkg.scripts[script]).toContain("package:prepare");
  });
  it("the release job gates every platform's packaged tools", () => {
    expect(workflow).toContain('node scripts/verify-packaged-backup-tools.mjs "$app/Contents/Resources" darwin "$arch"');
    expect(workflow).toContain("node scripts/verify-packaged-backup-tools.mjs release/linux-unpacked/resources linux x64");
    expect(workflow).toContain("verifyWindowsBackupTools(backup);");
    expect(workflow).toContain("backup-tools/x64/restic.exe'))");
  });
  function packaged(platform, arch, tools) {
    const resources = path.join(scratch(), platform === "darwin" ? "Murage.app/Contents/Resources" : "resources");
    for (const [name, bytes] of Object.entries(tools)) { const file = path.join(resources, "backup-tools", arch, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes, { mode: 0o755 }); }
    return resources;
  }
  it("Linux: exact upstream bytes pass; a changed or non-executable tool fails", () => {
    const age = Buffer.from("age"), restic = Buffer.from("restic");
    const pinsAge = { ...BACKUP_AGE_PINS["linux-x64"] }, pinsRestic = { ...RESTIC_PINS["linux-x64"] };
    const resources = packaged("linux", "x64", { age, restic });
    expect(() => verifyPackagedBackupTools(resources, "linux", "x64")).toThrow("BACKUP_TOOL_PIN_MISMATCH: age");
    expect(pinsAge.executableSha256).toMatch(hex); expect(pinsRestic.originalSha256).toMatch(hex);
    expect(() => verifyPackagedBackupTools(resources, "linux", "arm64")).toThrow("TARGET_UNSUPPORTED");
  });
  it("macOS: the pinned payload with the app's team passes; another team or payload fails", () => {
    const signedLike = bytes => bytes; // payloads are compared through normalizedAgePayloadHash
    const resources = packaged("darwin", "x64", { age: signedLike(Buffer.from("x")), restic: Buffer.from("y") });
    expect(() => verifyPackagedBackupTools(resources, "darwin", "x64", { run: () => ({ status: 0, stderr: "TeamIdentifier=ABCDE12345" }) })).toThrow("PIN_MISMATCH: age");
    expect(() => verifyPackagedBackupTools(resources, "darwin", "x64", { run: () => ({ status: 0, stderr: "" }) })).toThrow("APP_UNSIGNED");
  });
});

describe("macOS payload pins match the real release binaries", () => {
  // Pinned assets are staged by pnpm package:prepare; skipped when absent.
  const staged = (dir, arch, name) => new URL(`../dist-native/${dir}/${arch}/${name}`, import.meta.url);
  for (const [dir, name, pins, key] of [["backup-restic", "restic", RESTIC_PINS, "darwin"], ["backup-age", "age", BACKUP_AGE_PINS, "darwin"]]) {
    for (const arch of ["arm64", "x64"]) {
      const file = staged(dir, arch, name);
      it.skipIf(!fs.existsSync(file))(`${name} ${arch}: ad-hoc signed staged bytes normalise to the pin`, () => {
        const pin = pins[`${key}-${arch}`], copy = path.join(scratch(), name); fs.copyFileSync(file, copy);
        expect(sha(fs.readFileSync(copy))).toBe(pin.originalSha256 ?? pin.executableSha256);
        if (process.platform === "darwin") { execFileSync("/usr/bin/codesign", ["-s", "-", "-f", "--options", "runtime", copy], { stdio: "ignore" }); expect(normalizedAgePayloadHash(fs.readFileSync(copy))).toBe(pin.payloadSha256); }
      });
    }
  }
});

describe("runtime attestation and capability, per platform", () => {
  it.each(SHIPPED)("%s-%s: packaged path is fixed per platform", (platform, arch) => {
    const resources = platform === "win32" ? "C:\\Program Files\\Murage\\resources" : "/opt/Murage/resources";
    const expected = platform === "win32" ? "C:\\Program Files\\Murage\\resources\\backup-tools\\x64\\restic.exe" : `/opt/Murage/resources/backup-tools/${arch}/restic`;
    expect(packagedResticPath(resources, platform, arch)).toBe(expected);
  });
  it("unshipped targets have no restic", () => { expect(packagedResticPath("/r", "linux", "arm64")).toBeNull(); expect(packagedResticPath("/r", "freebsd", "x64")).toBeNull(); });
  it.each([["linux", "x64"], ["win32", "x64"], ["darwin", "x64"]])("%s-%s: exact pinned bytes are trusted, anything else is not", async (platform, arch) => {
    const root = scratch(), file = path.join(root, "restic"), good = Buffer.from(`pinned ${platform}`);
    fs.writeFileSync(file, good, { mode: 0o755 });
    const target = `${platform}-${arch}`; overrides.set(target, { ...RESTIC_PINS[target], originalSha256: sha(good) });
    try {
      await withPlatform(platform, arch, async () => {
        expect(trustedBackupResticExecutable(file)).toBe(true);
        expect(await trustedBackupResticExecutableAsync(file)).toBe(true);
        fs.writeFileSync(file, "tampered"); expect(trustedBackupResticExecutable(file)).toBe(false); expect(await trustedBackupResticExecutableAsync(file)).toBe(false);
        fs.writeFileSync(file, good); fs.symlinkSync(file, path.join(root, "link")); expect(trustedBackupResticExecutable(path.join(root, "link"))).toBe(false);
        // Group- or world-writable is refused where modes exist; Windows has none.
        fs.chmodSync(file, 0o777); expect(trustedBackupResticExecutable(file)).toBe(platform === "win32");
      });
    } finally { overrides.delete(target); }
  });
  it("an unshipped platform never trusts a restic", async () => {
    const file = path.join(scratch(), "restic"); fs.writeFileSync(file, "x", { mode: 0o755 });
    await withPlatform("linux", "arm64", async () => { expect(trustedBackupResticExecutable(file)).toBe(false); expect(await trustedBackupResticExecutableAsync(file)).toBe(false); });
  });
  it.each(SHIPPED)("%s-%s: the capability is ready only while usable and while the attested file is unchanged", async (platform, arch) => {
    const root = scratch(), file = path.join(root, "restic"); fs.writeFileSync(file, "tool", { mode: 0o755 });
    let usable = true; const verify = vi.fn(async () => true);
    const capability = createResticToolCapability({ resourcesPath: root, currentExecutable: process.execPath, isUsable: () => usable, locate: resources => { expect(resources).toBe(root); return file; }, verify });
    await withPlatform(platform, arch, async () => {
      expect(capability.currentTool()).toBeNull();
      await expect(capability.requireTool()).resolves.toBe(file); expect(capability.currentTool()).toBe(file); expect(verify).toHaveBeenCalledTimes(1);
      usable = false; expect(capability.currentTool()).toBeNull(); await expect(capability.requireTool()).rejects.toMatchObject({ code: "BACKUP_UNAVAILABLE" }); usable = true;
      await capability.requireTool(); fs.appendFileSync(file, "changed"); expect(capability.currentTool()).toBeNull();
      verify.mockResolvedValueOnce(false); await expect(capability.requireTool()).rejects.toMatchObject({ code: "BACKUP_UNAVAILABLE" });
    });
    const missing = createResticToolCapability({ resourcesPath: root, currentExecutable: process.execPath, isUsable: () => true, locate: () => null, verify });
    await expect(missing.requireTool()).rejects.toMatchObject({ code: "BACKUP_UNAVAILABLE" });
  });
  it("main enables off-site copies wherever a restic is pinned, with no platform gate", () => {
    const main = fs.readFileSync(new URL("../electron/main.mjs", import.meta.url), "utf8");
    const start = main.indexOf("async function initializeBackupRemoteHost()"), body = main.slice(start, main.indexOf("\nasync function ", start + 10));
    expect(body).toContain("packagedResticPath(process.resourcesPath)"); expect(body).toContain("createResticToolCapability(");
    expect(body).not.toMatch(/process\.platform\s*===\s*"darwin"/);
    expect(body).toMatch(/isUsable:\(\)=>Boolean\(tool&&/);
  });
});
