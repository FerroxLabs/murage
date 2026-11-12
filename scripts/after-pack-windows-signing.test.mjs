import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { parse } from "yaml";
import { afterEach, expect, it, vi } from "vitest";
import { ZipFile } from "yazl";
import { removeTempDirSync } from "../server/testing/cleanup.ts";
vi.mock("../shared/windows-backup-tools.mjs", async () => {
  const { createHash } = await import("node:crypto"); const sha = value => createHash("sha256").update(value).digest("hex");
  return { WINDOWS_BACKUP_RAW_SHA256: { age: sha("raw age fixture"), keygen: sha("raw keygen fixture"), license: sha("raw license fixture") }, WINDOWS_BACKUP_ARCHIVE: { url: "https://invalid.example/never-used", sha256: "0".repeat(64) } };
});
vi.mock("../shared/backup-restic-pin.mjs", async original => {
  const actual = await original(); const { createHash } = await import("node:crypto");
  return { ...actual, RESTIC_PINS: { ...actual.RESTIC_PINS, "win32-x64": { ...actual.RESTIC_PINS["win32-x64"], originalSha256: createHash("sha256").update("raw restic fixture").digest("hex") } } };
});
import { WINDOWS_BACKUP_ARCHIVE } from "../shared/windows-backup-tools.mjs";
import { stageWindowsBackupTools, verifyWindowsBackupTools } from "./prepare-windows-backup-tools.mjs";
import { verifyPackagedBackupTools, verifyPackagedBrowserAdmission } from "./windows-release-gates.mjs";

vi.mock("./prepare-cloudflared.mjs", () => ({
  executableTarget: () => "win32-x64",
  verifyCloudflaredExecutable: vi.fn(),
}));
vi.mock("./prepare-fuigo.mjs", () => ({
  FUIGO_VERSION: "fixture",
  verifyFuigoExecutable: vi.fn(),
}));
vi.mock("./prepare-browser.mjs", () => ({ verifyBrowserBundle: vi.fn() }));
// The packaged-import guard has its own suite (windows-native-imports.test.mjs); the fixtures here are not real PE files.
vi.mock("./windows-native-imports.mjs", () => ({ assertWindowsNativeImports: vi.fn(() => ({})) }));
// Anchored native execution is proved on the native gate; these fixtures exercise signing order.
vi.mock("./anchored-read-resource.mjs", () => ({ proveAnchoredReadResource: vi.fn(() => "loaded") }));
import { proveAnchoredReadResource } from "./anchored-read-resource.mjs";
// The engine-exclusion addon gate has its own suite (engine-exclusion-build.test.mjs); this one is about signing, and has no packaged Electron to load it with.
// R16/R25: afterPack must hand the validator the build's own receipt; `exclusionRun.receipt` swaps in a test receipt and runs the REAL validator on it.
const exclusionRun = vi.hoisted(() => ({ calls: [], receipt: undefined }));
vi.mock("./engine-exclusion-resource.mjs", async importOriginal => {
  const actual = await importOriginal();
  return {
    validateEngineExclusionResource: (resources, platform, arch, receipt) => {
      exclusionRun.calls.push([platform, arch, receipt]);
      if (exclusionRun.receipt === undefined) return path.join(resources, "engine-exclusion.node");
      return actual.validateEngineExclusionResource(resources, platform, arch, exclusionRun.receipt);
    },
    loadEngineExclusionResource: () => "loaded",
  };
});
// The GEPA runtime is required before signing (GEPA_RESOURCE_BUILD_RECEIPT_REQUIRED);
// its bundle verification has its own suite (server/gepa-resource.test.ts).
vi.mock("../server/gepa-resource.ts", () => ({ verifyGepaBundle: vi.fn() }));
import { verifyGepaBundle } from "../server/gepa-resource.ts";
const GEPA_RECEIPT = "a".repeat(64);
import { verifyBrowserBundle } from "./prepare-browser.mjs";
vi.mock("../server/browser-windows-identity.ts", async importOriginal => ({
  ...await importOriginal(),
  verifyWindowsBrowserImage: vi.fn(() => ({ signed: true })),
  verifyWindowsBrowserSignatures: vi.fn(async () => {}),
  // the packaged addon's WinVerifyTrust check (no PowerShell fallback exists any more)
  nativeAuthenticodeIn: vi.fn(resources => ({ resources, authenticode: async () => ({ status: "Valid", publisher: "Ferrox Labs, LLC" }) })),
}));
import { verifyWindowsBrowserImage, verifyWindowsBrowserSignatures } from "../server/browser-windows-identity.ts";
import afterPack from "./after-pack.mjs";
import { browserBundlePaths } from "../server/browser-bundle-release.ts";
import { verifyFuigoExecutable } from "./prepare-fuigo.mjs";

const temporaryDirectories = [];
afterEach(() => {
  vi.resetAllMocks();
  exclusionRun.calls.length = 0;
  exclusionRun.receipt = undefined;
  for (const directory of temporaryDirectories.splice(0)) removeTempDirSync(directory);
});

const CONTROL_PLANE = fs.readFileSync(path.join(import.meta.dirname, "..", "electron", "cloud-control-plane.mjs"));

/** resources/app.asar holding electron/cloud-control-plane.mjs, in the asar format (size pickle, header pickle, file data). The prod-pin gate has its own suite (packaged-prod-pin.test.mjs); here the package carries the real module so that gate passes for real. */
function writeAppAsar(resources, member = CONTROL_PLANE) {
  const json = Buffer.from(JSON.stringify({ files: { electron: { files: { "cloud-control-plane.mjs": { size: member.length, offset: "0" } } } } }), "utf8");
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4);
  json.copy(padded);
  const header = Buffer.alloc(8);
  header.writeUInt32LE(padded.length + 4, 0);
  header.writeUInt32LE(json.length, 4);
  const size = Buffer.alloc(8);
  size.writeUInt32LE(4, 0);
  size.writeUInt32LE(header.length + padded.length, 4);
  fs.writeFileSync(path.join(resources, "app.asar"), Buffer.concat([size, header, padded, member]));
}

function fixture() {
  proveAnchoredReadResource.mockReturnValue("loaded");
  verifyWindowsBrowserImage.mockReturnValue({ signed: true });
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), "murage-windows-signing-"));
  const gui = Buffer.alloc(512);
  gui.writeUInt16LE(0x5a4d); gui.writeUInt32LE(128, 0x3c); gui.writeUInt32LE(0x4550, 128);
  gui.writeUInt16LE(240, 148); gui.writeUInt16LE(0x20b, 152); gui.writeUInt16LE(2, 220);
  fs.writeFileSync(path.join(appOutDir, "Murage.exe"), gui);
  temporaryDirectories.push(appOutDir);
  const resources = path.join(appOutDir, "resources");
  for (const name of ["fuigo", "fuigo-probe", "cloudflared", "licenses"]) fs.mkdirSync(path.join(resources, name), { recursive: true });
  writeAppAsar(resources);
  const executable = path.join(resources, "fuigo", "fuigo.exe");
  fs.writeFileSync(executable, "pinned fixture");
  const recovery = path.join(resources, "murage-recovery.exe");
  fs.writeFileSync(recovery, "recovery fixture");
  const browser = browserBundlePaths(path.join(resources, "browser-engine"), "win32-x64");
  fs.mkdirSync(path.dirname(browser.chrome), { recursive: true });
  fs.writeFileSync(browser.engine, "pinned browser engine");
  fs.writeFileSync(browser.chrome, "pinned browser chrome");
  fs.writeFileSync(path.join(resources, "cloudflared", "cloudflared.exe"), "vendor fixture");
  fs.writeFileSync(path.join(resources, "anchored-read.node"), Buffer.alloc(4096));
  fs.writeFileSync(path.join(resources, "engine-exclusion.node"), Buffer.concat([Buffer.from("MZ"), Buffer.alloc(4096)])); // the engine-exclusion addon (the gate refuses a package without it)
  for (const name of ["fuigo-LICENSE.txt", "fuigo-README.md", "fuigo-THIRD_PARTY_NOTICES.md", "cloudflared-LICENSE.txt", "cloudflared-README.md"]) {
    fs.writeFileSync(path.join(resources, "licenses", name), "fixture");
  }
  // Supply the runtime preconditions enforced before signing. The dedicated
  // after-pack-memory tests retain real architecture/absence negative coverage.
  const server = path.join(resources, "server");
  const runtimePath = "node_modules/onnxruntime-node", sharpPath = "node_modules/sharp";
  const runtime = path.join(server, runtimePath);
  const native = path.join(runtime, "bin/napi-v6/win32/x64");
  fs.mkdirSync(native, { recursive: true });
  fs.mkdirSync(path.join(server, "memory"), { recursive: true });
  fs.writeFileSync(path.join(server, "memory/worker.js"), "// fixture worker");
  fs.writeFileSync(path.join(server, "browser-extension-panel-avatar-encoder.js"), "// fixture worker");
  fs.writeFileSync(path.join(server, "bot-package-guard-worker.js"), "// fixture worker");
  fs.writeFileSync(path.join(server, "engine-history-worker.js"), "// fixture worker");
  fs.writeFileSync(path.join(server, "inbox-fill-worker.js"), "// fixture worker");
  fs.writeFileSync(path.join(server, "transcript-read-worker.js"), "// fixture worker");
  fs.writeFileSync(path.join(server, "memory-model-manifest.json"), JSON.stringify({ runtimeVersion: "4.2.0", files: [{ path: "config.json", bytes: 1, sha256: "0".repeat(64) }] }));
  fs.writeFileSync(path.join(runtime, "package.json"), JSON.stringify({ name: "onnxruntime-node", version: "1.24.3" }));
  const commonDir = path.join(server, "node_modules/onnxruntime-common");
  fs.mkdirSync(commonDir, { recursive: true });
  fs.writeFileSync(path.join(commonDir, "package.json"), JSON.stringify({ name: "onnxruntime-common", version: "1.24.3" }));
  const wasmFiles = ["ort.node.min.mjs", "ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"].map(name => {
    const file = `memory/ort-wasm/${name}`, bytes = Buffer.from(`fixture ${name}`);
    fs.mkdirSync(path.join(server, "memory/ort-wasm"), { recursive: true });
    fs.writeFileSync(path.join(server, file), bytes);
    return { path: file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  fs.writeFileSync(path.join(server, "memory-runtime-manifest.json"), JSON.stringify({
    wasmBackend: { package: "onnxruntime-web", version: "1.24.3", license: "MIT", common: { version: "1.24.3", path: "node_modules/onnxruntime-common" }, files: wasmFiles },
    platform: "win32", arch: "x64", packages: [
      { name: "@huggingface/transformers", version: "4.2.0", path: "node_modules/@huggingface/transformers" },
      { name: "onnxruntime-node", version: "1.24.3", path: runtimePath },
      { name: "sharp", version: "0.35.5", path: sharpPath },
    ],
  }));
  const header = Buffer.alloc(128);
  header.write("MZ", 0); header.writeUInt32LE(0x40, 0x3c);
  header.write("PE\0\0", 0x40); header.writeUInt16LE(0x8664, 0x44);
  for (const name of ["onnxruntime_binding.node", "onnxruntime.dll", "DirectML.dll", "dxcompiler.dll", "dxil.dll"])
    fs.writeFileSync(path.join(native, name), header);
  const sharpNative = path.join(server, sharpPath, "node_modules/@img/sharp-win32-x64/lib");
  fs.mkdirSync(sharpNative, { recursive: true });
  fs.writeFileSync(path.join(server, sharpPath, "package.json"), JSON.stringify({ name: "sharp", version: "0.35.5" }));
  for (const name of ["sharp-win32-x64-0.35.5.node", "libvips-42.dll"]) fs.writeFileSync(path.join(sharpNative, name), header);
  const helper = path.join(resources, "fuigo-probe", "launcher.exe"), helperManifest = path.join(resources, "fuigo-probe", "manifest.json");
  fs.writeFileSync(helper, header);
  fs.writeFileSync(helperManifest, JSON.stringify({ schema: 1, target: "win32-x64", executable: "launcher.exe", binarySha256: createHash("sha256").update(header).digest("hex") }));
  const backupDirectory = path.join(resources, "backup-tools", "x64"); fs.mkdirSync(backupDirectory, { recursive: true });
  const backupHelper = path.join(backupDirectory, "murage-backup-age.exe"); fs.writeFileSync(backupHelper, header);
  for (const [file, bytes] of [["age.exe", "raw age fixture"], ["age-keygen.exe", "raw keygen fixture"], ["LICENSE", "raw license fixture"], ["restic.exe", "raw restic fixture"]]) fs.writeFileSync(path.join(backupDirectory, file), bytes);
  const signIf = vi.fn(async file => {
    expect(verifyFuigoExecutable).toHaveBeenCalledWith(executable, "win32-x64");
    expect(verifyBrowserBundle).toHaveBeenCalledWith(path.join(resources, "browser-engine"), "win32-x64");
    fs.appendFileSync(file, " signed fixture");
    return true;
  });
  // The signing builder supplies a clean source repository for package provenance.
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "murage-signing-source-"));
  temporaryDirectories.push(projectDir);
  fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ name: "signing-fixture", version: "1.0.19" }));
  const git = args => execFileSync("git", args, { cwd: projectDir, encoding: "utf8" }).trim();
  git(["init", "-q"]);
  git(["add", "package.json"]);
  git(["-c", "user.name=ci", "-c", "user.email=ci@example.test", "commit", "-qm", "signing fixture"]);
  return { executable, recovery, browser, helper, helperManifest, backupDirectory, backupHelper, signIf, context: { appOutDir, arch: "x64", electronPlatformName: "win32", packager: { projectDir, signIf, appInfo: { updaterCacheDirName: "signing-fixture-updater" }, config: { publish: null, extraMetadata: { murageGepaManifests: { "win32-x64": GEPA_RECEIPT } } } } } };
}

it("verifies pinned inventory before signing engines and updater helper", async () => {
  const { context, executable, recovery, browser, helper, helperManifest, backupDirectory, backupHelper, signIf } = fixture();
  await afterPack(context);
  expect(JSON.parse(fs.readFileSync(path.join(context.appOutDir, "resources", "build-provenance.json"), "utf8"))).toEqual({
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: context.packager.projectDir, encoding: "utf8" }).trim(),
    tree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: context.packager.projectDir, encoding: "utf8" }).trim(),
    version: "1.0.19",
  });
  expect(verifyGepaBundle).toHaveBeenCalledWith(path.join(context.appOutDir, "resources", "gepa-worker"), "win32-x64", GEPA_RECEIPT);
  expect(signIf.mock.calls.map(([file]) => file)).toEqual([executable, browser.engine, browser.chrome, recovery, backupHelper, helper]);
  expect(fs.readFileSync(recovery, "utf8")).toBe("recovery fixture signed fixture");
  expect(fs.readFileSync(browser.engine, "utf8")).toBe("pinned browser engine signed fixture");
  expect(fs.readFileSync(browser.chrome, "utf8")).toBe("pinned browser chrome signed fixture");
  expect(verifyWindowsBrowserSignatures).toHaveBeenCalledWith([browser.engine, browser.chrome, recovery, backupHelper, helper], process.env.SystemRoot, expect.objectContaining({ resources: path.join(context.appOutDir, "resources") }));
  verifyWindowsBackupTools(backupDirectory);
  expect(JSON.parse(fs.readFileSync(helperManifest, "utf8")).binarySha256).toBe(createHash("sha256").update(fs.readFileSync(helper)).digest("hex"));
  expect(fs.readFileSync(executable, "utf8")).toBe("pinned fixture signed fixture");
});

// CONTRACTS-B 1.5 R16/R25 (Astra r1 block 2): the /MT receipt check is part of the Windows packaging path, through afterPack itself.
const peAddon = () => { const b = Buffer.alloc(4096); b[0] = 0x4d; b[1] = 0x5a; b.writeUInt32LE(0x80, 0x3c); b.writeUInt32BE(0x50450000, 0x80); b.writeUInt16LE(0x8664, 0x84); b.writeUInt16LE(0x2000, 0x80 + 22); return b; };
const receiptFile = (context, value, raw) => {
  const file = path.join(context.appOutDir, "receipt.json");
  fs.writeFileSync(file, raw ?? JSON.stringify(value));
  return file;
};
it("afterPack gives the Windows addon check the build script's own receipt for the target", async () => {
  const { context } = fixture();
  await afterPack(context);
  expect(exclusionRun.calls).toHaveLength(1);
  const [platform, arch, receipt] = exclusionRun.calls[0];
  expect([platform, arch]).toEqual(["win32", "x64"]);
  expect(receipt).toBe(path.resolve(import.meta.dirname, "..", "dist-native", "engine-exclusion", "win32-x64", "build.json"));
});
it("afterPack refuses a Windows addon whose receipt is missing, malformed or not /MT, and accepts /MT", async () => {
  const run = async (make) => {
    const { context } = fixture();
    fs.writeFileSync(path.join(context.appOutDir, "resources", "engine-exclusion.node"), peAddon());
    exclusionRun.receipt = make(context);
    return afterPack(context);
  };
  await expect(run(context => path.join(context.appOutDir, "no-such-build.json"))).rejects.toThrow("ENGINE_EXCLUSION_RECEIPT_MISSING");
  await expect(run(context => receiptFile(context, null, "not json"))).rejects.toThrow("ENGINE_EXCLUSION_RECEIPT_MISSING");
  await expect(run(context => receiptFile(context, { crt: "MTd" }))).rejects.toThrow("ENGINE_EXCLUSION_RECEIPT_CRT");
  await expect(run(context => receiptFile(context, { crt: "other" }))).rejects.toThrow("ENGINE_EXCLUSION_RECEIPT_CRT");
  await expect(run(context => receiptFile(context, {}))).rejects.toThrow("ENGINE_EXCLUSION_RECEIPT_CRT");
  await expect(run(context => receiptFile(context, { crt: "MT" }))).resolves.toBeUndefined();
});

it("never signs a package whose control-plane module differs from the source", async () => {
  const { context, signIf } = fixture();
  const changed = Buffer.from(CONTROL_PLANE);
  changed[changed.length - 1] ^= 1;
  writeAppAsar(path.join(context.appOutDir, "resources"), changed);
  await expect(afterPack(context)).rejects.toThrow("PACKAGED_PROD_PIN_MISMATCH");
  expect(signIf).not.toHaveBeenCalled();
  fs.rmSync(path.join(context.appOutDir, "resources", "app.asar"));
  await expect(afterPack(context)).rejects.toThrow("PACKAGED_PROD_PIN_MISSING");
  expect(signIf).not.toHaveBeenCalled();
});

it("never signs an engine rejected by pinned-byte verification", async () => {
  const { context, signIf } = fixture();
  verifyFuigoExecutable.mockImplementation(() => { throw new Error("SHA-256 verification failed"); });
  await expect(afterPack(context)).rejects.toThrow("SHA-256 verification failed");
  expect(signIf).not.toHaveBeenCalled();
});

it("fails packaging if the configured signer skips the engine", async () => {
  const { context, signIf } = fixture();
  signIf.mockResolvedValue(false);
  await expect(afterPack(context)).rejects.toThrow("Windows signing did not complete");
});

it("propagates Azure signing failures before artifacts are assembled", async () => {
  const { context, signIf } = fixture();
  signIf.mockRejectedValue(new Error("Azure signing failed"));
  await expect(afterPack(context)).rejects.toThrow("Azure signing failed");
});


it("never signs any engine when the browser bundle pin is rejected", async () => {
  const { context, signIf } = fixture();
  verifyBrowserBundle.mockImplementation(() => { throw new Error("Browser pinned SHA-256 verification failed"); });
  await expect(afterPack(context)).rejects.toThrow("Browser pinned SHA-256 verification failed");
  expect(signIf).not.toHaveBeenCalled();
});

it.each(["agent-browser.exe", "chrome-headless-shell.exe", "murage-recovery.exe", "launcher.exe", "murage-backup-age.exe"])("fails closed when packaged signing is skipped for %s", async (name) => {
  const { context, signIf } = fixture();
  signIf.mockImplementation(async file => path.basename(file) !== name);
  await expect(afterPack(context)).rejects.toThrow(`Windows signing did not complete: ${name}`);
});

it("refuses tampered raw backup tools before signing and detects signing-time mutation", async () => {
  const first = fixture(); fs.appendFileSync(path.join(first.backupDirectory, "age.exe"), "tampered");
  await expect(afterPack(first.context)).rejects.toThrow("WINDOWS_BACKUP_RAW_MISMATCH"); expect(first.signIf).not.toHaveBeenCalled();
  const second = fixture(); second.signIf.mockImplementation(async file => { if (file === second.backupHelper) fs.appendFileSync(path.join(second.backupDirectory, "age-keygen.exe"), "incorrect signature"); return true; });
  await expect(afterPack(second.context)).rejects.toThrow("WINDOWS_BACKUP_RAW_MISMATCH"); expect(verifyWindowsBrowserSignatures).not.toHaveBeenCalled();
});

it("requires the backup helper instead of accepting the copy step's missing-file warning", async () => {
  const f = fixture(); fs.rmSync(f.backupHelper);
  await expect(afterPack(f.context)).rejects.toThrow(); expect(f.signIf).not.toHaveBeenCalled();
});

it("copies all five backup resources (age, keygen, license, helper, restic) individually without early signing", async () => {
  const require = createRequire(import.meta.url), builder = path.dirname(require.resolve("electron-builder/package.json"));
  const { FileMatcher, copyFiles } = require(require.resolve("app-builder-lib/out/fileMatcher.js", { paths: [builder] }));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "murage-backup-copy-")); temporaryDirectories.push(root);
  const config = parse(fs.readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8"));
  const entries = config.win.extraResources.filter(entry => entry.to.startsWith("backup-tools/x64/")); expect(entries).toHaveLength(5); expect(entries.map(entry => entry.to)).toContain("backup-tools/x64/restic.exe");
  const source = path.join(root, "dist-native/backup-tools/win32-x64"); fs.mkdirSync(source, { recursive: true });
  for (const entry of entries) fs.writeFileSync(path.join(root, entry.from), `original ${path.basename(entry.from)}`);
  const transformer = vi.fn(() => null);
  await copyFiles(entries.map(entry => new FileMatcher(path.join(root, entry.from), path.join(root, "resources", entry.to), value => value)), transformer, false);
  expect(transformer).not.toHaveBeenCalled();
  for (const entry of entries) expect(fs.readFileSync(path.join(root, "resources", entry.to), "utf8")).toBe(`original ${path.basename(entry.from)}`);
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  expect(pkg.scripts["package:win"]).toContain("pnpm prepare:backup-windows"); expect(pkg.scripts["package:win"]).toContain("pnpm build:backup-helper");
});

it("stages only pinned named ZIP members and refuses archive mismatch or existing collisions", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "murage-backup-stage-")); temporaryDirectories.push(root);
  const zip = new ZipFile(), chunks = []; const done = new Promise((resolve, reject) => { zip.outputStream.on("data", chunk => chunks.push(chunk)); zip.outputStream.on("end", resolve); zip.outputStream.on("error", reject); });
  for (const [file, value] of [["age/age.exe", "raw age fixture"], ["age/age-keygen.exe", "raw keygen fixture"], ["age/LICENSE", "raw license fixture"], ["age/ignored.txt", "not extracted"]]) zip.addBuffer(Buffer.from(value), file);
  zip.end(); await done; const bytes = Buffer.concat(chunks), archive = path.join(root, "fixture.zip"); fs.writeFileSync(archive, bytes);
  WINDOWS_BACKUP_ARCHIVE.sha256 = createHash("sha256").update(bytes).digest("hex");
  const output = await stageWindowsBackupTools({ root, archive }); verifyWindowsBackupTools(output, { restic: false }); expect(() => verifyWindowsBackupTools(output)).toThrow("restic.exe");
  expect(fs.readdirSync(output).sort()).toEqual(["LICENSE", "age-keygen.exe", "age.exe"]); expect(fs.existsSync(path.join(output, "ignored.txt"))).toBe(false);
  fs.appendFileSync(path.join(output, "age.exe"), "changed"); await expect(stageWindowsBackupTools({ root, archive })).rejects.toThrow("COLLISION");
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "murage-backup-bad-archive-")); temporaryDirectories.push(other);
  fs.writeFileSync(archive, "not the pinned archive"); await expect(stageWindowsBackupTools({ root: other, archive })).rejects.toThrow("ARCHIVE_MISMATCH");
});

it("release signature gate exempts only exact verified upstream paths and still verifies the helper", async () => {
  const workflow = parse(fs.readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"));
  const gate = workflow.jobs.windows.steps.find(step => step.name === "Gate: the installer must actually be signed").run;
  const fixed = "release/win-unpacked/resources/backup-tools/x64";
  const exemptions = [...gate.matchAll(/\$rawBackupFiles\.Add\(\[System\.IO\.Path\]::GetFullPath\('([^']+)'\)\)/g)].map(match => match[1]);
  expect(exemptions).toEqual([`${fixed}/age.exe`, `${fixed}/age-keygen.exe`, `${fixed}/restic.exe`]);
  expect(gate).toContain("$rawBackupFiles.Contains([System.IO.Path]::GetFullPath($_.FullName))");
  expect(gate).not.toMatch(/\$rawBackupFiles\.Contains\([^\n]*\$_\.Name/);
  // The Node half runs first and its failure stops the step, before any exemption exists.
  expect(gate.indexOf("& node scripts/windows-release-gates.mjs backup")).toBeGreaterThan(-1);
  expect(gate.indexOf("& node scripts/windows-release-gates.mjs backup")).toBeLessThan(gate.indexOf("if ($LASTEXITCODE -ne 0)"));
  expect(gate.indexOf("if ($LASTEXITCODE -ne 0)")).toBeLessThan(gate.indexOf("$rawBackupFiles ="));
  expect(gate).toContain("$allowed = @('Ferrox Labs, LLC', 'Cloudflare, Inc.')");
  expect(gate).toContain("@('Murage.exe', 'Murage-*-setup.exe', 'fuigo.exe', 'murage-browser-host.exe')");
  // The gate hands the packaged resources folder's own addon to the check, as an absolute path (require() reads a bare
  // relative path as a package name). This runs the real gate function with the checks injected.
  const resourcesDir = path.resolve("release/win-unpacked/resources");
  const f = fixture();
  const verifyRaw = directory => { expect(directory).toBe(fixed); verifyWindowsBackupTools(f.backupDirectory); };
  const verifySigned = vi.fn(async (files, systemRoot, native) => { expect(files).toEqual([`${fixed}/murage-backup-age.exe`]); expect(native).toEqual({ resources: resourcesDir }); await verifyWindowsBrowserSignatures([f.backupHelper], systemRoot, native); });
  const run = (systemRoot) => verifyPackagedBackupTools({ systemRoot, deps: {
    verifyWindowsBackupTools: verifyRaw, verifyWindowsBrowserSignatures: verifySigned, log() {},
    nativeAuthenticodeIn: resources => { expect(resources).toBe(resourcesDir); return { resources }; },
  } });
  await run("C:\\Windows"); expect(verifySigned).toHaveBeenCalledOnce();
  verifySigned.mockClear(); fs.rmSync(path.join(f.backupDirectory, "LICENSE"));
  await expect(run(undefined)).rejects.toThrow(); expect(verifySigned).not.toHaveBeenCalled();
  fs.writeFileSync(path.join(f.backupDirectory, "LICENSE"), "raw license fixture"); fs.appendFileSync(path.join(f.backupDirectory, "age.exe"), "changed");
  await expect(run(undefined)).rejects.toThrow("WINDOWS_BACKUP_RAW_MISMATCH"); expect(verifySigned).not.toHaveBeenCalled();
  fs.writeFileSync(path.join(f.backupDirectory, "age.exe"), "raw age fixture");
  verifyWindowsBrowserSignatures.mockRejectedValueOnce(new Error("Windows browser requires a valid Ferrox Labs signature"));
  await expect(run(undefined)).rejects.toThrow("valid Ferrox Labs signature");
  // This exercises the shared gate function and the CI step's source shape; it does not claim a real Authenticode verification.
});

it("package-win runs the same release gates as the release workflow", () => {
  const release = parse(fs.readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"));
  const pack = parse(fs.readFileSync(new URL("../.github/workflows/package-win.yml", import.meta.url), "utf8"));
  const releaseSteps = release.jobs.windows.steps.map(step => step.run ?? "").join("\n");
  const packSteps = pack.jobs.package.steps;
  for (const gate of ["backup", "admission"]) {
    expect(releaseSteps).toContain(`node scripts/windows-release-gates.mjs ${gate}`);
    expect(packSteps.map(step => step.run ?? "").join("\n")).toContain(`node scripts/windows-release-gates.mjs ${gate}`);
  }
  // After the signed package exists, before its tree is relied on.
  const names = packSteps.map(step => step.name);
  const gateStep = names.indexOf("Gate: release backup-tool signature and browser admission checks");
  expect(gateStep).toBeGreaterThan(names.indexOf("Package (Azure Trusted Signing)"));
  expect(gateStep).toBeLessThan(names.indexOf("verify the packaged tree"));
});

it("the admission gate gives the check the packaged resources path and the bundle's own engine and browser", async () => {
  const env = { SystemRoot: "C:\\Windows" };
  const seen = [];
  await verifyPackagedBrowserAdmission({ env, deps: {
    log() {},
    browserBundlePaths: (root, target) => { seen.push([root, target]); return { engine: `${root}/engine.exe`, chrome: `${root}/chrome.exe` }; },
    ensureBrowserSandboxAccess: async spec => { seen.push(spec); },
  } });
  const root = path.join(path.resolve("release/win-unpacked/resources"), "browser-engine");
  expect(env.MURAGE_RESOURCES_PATH).toBe(path.resolve("release/win-unpacked/resources"));
  expect(seen).toEqual([[root, "win32-x64"], { command: `${root}/engine.exe`, env: { MURAGE_BROWSER_BUNDLE_DIR: root, AGENT_BROWSER_EXECUTABLE_PATH: `${root}/chrome.exe`, SystemRoot: "C:\\Windows" } }]);
});


it("rejects signed browser content changes before trusting the signature", async () => {
  const { context } = fixture();
  verifyWindowsBrowserImage.mockImplementation(() => { throw new Error("Windows browser image differs from its pinned original"); });
  await expect(afterPack(context)).rejects.toThrow("differs from its pinned original");
  expect(verifyWindowsBrowserSignatures).not.toHaveBeenCalled();
});

it("rejects unsigned output and invalid final browser signatures", async () => {
  const { context } = fixture();
  verifyWindowsBrowserImage.mockReturnValue({ signed: false });
  await expect(afterPack(context)).rejects.toThrow("left an unsigned image");
  verifyWindowsBrowserImage.mockReturnValue({ signed: true });
  const fresh = fixture();
  verifyWindowsBrowserSignatures.mockRejectedValue(new Error("Windows browser requires a valid Ferrox Labs signature"));
  await expect(afterPack(fresh.context)).rejects.toThrow("valid Ferrox Labs signature");
});
it("refuses a changed native updater helper before invoking the signer", async () => {
  const { context, helper, signIf } = fixture(); fs.appendFileSync(helper, "tampered");
  await expect(afterPack(context)).rejects.toThrow("Fuigo probe resource identity mismatch");
  expect(signIf).not.toHaveBeenCalled();
});


it("copies the configured browser EXEs without electron-builder's early signing transformer", async () => {
  const require = createRequire(import.meta.url);
  const builder = path.dirname(require.resolve("electron-builder/package.json"));
  const { FileMatcher, copyFiles } = require(require.resolve("app-builder-lib/out/fileMatcher.js", { paths: [builder] }));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "murage-browser-copy-")); temporaryDirectories.push(root);
  const config = parse(fs.readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8"));
  const entries = config.win.extraResources.filter(entry => entry.to.startsWith("browser-engine"));
  const source = path.join(root, "dist-native/browser/win32-x64");
  const browser = browserBundlePaths(source, "win32-x64");
  fs.mkdirSync(path.dirname(browser.chrome), { recursive: true });
  fs.writeFileSync(browser.engine, "original engine"); fs.writeFileSync(browser.chrome, "original chrome");
  fs.writeFileSync(path.join(source, "manifest.json"), "original manifest");
  const expand = value => value.replaceAll("${arch}", "x64");
  const matchers = entries.map(entry => new FileMatcher(path.join(root, entry.from), path.join(root, "resources", entry.to), expand, entry.filter));
  const transformer = vi.fn(() => null);
  await copyFiles(matchers, transformer, false);
  const copied = browserBundlePaths(path.join(root, "resources/browser-engine"), "win32-x64");
  expect(fs.readFileSync(copied.engine, "utf8")).toBe("original engine");
  expect(fs.readFileSync(copied.chrome, "utf8")).toBe("original chrome");
  expect(fs.readFileSync(copied.manifest, "utf8")).toBe("original manifest");
  expect(transformer.mock.calls.map(([file]) => path.basename(file))).not.toContain("agent-browser.exe");
  expect(transformer.mock.calls.map(([file]) => path.basename(file))).not.toContain("chrome-headless-shell.exe");
});

it("refuses a failed anchored-reader packaged smoke before invoking the signer", async () => {
  const f = fixture();
  proveAnchoredReadResource.mockImplementationOnce(() => { throw Error("ANCHORED_RESOURCE_PROOF_FAILED"); });
  await expect(afterPack(f.context)).rejects.toThrow("ANCHORED_RESOURCE_PROOF_FAILED");
  expect(f.signIf).not.toHaveBeenCalled();
});

it("refuses a console-subsystem Murage before signing or scheduling can flash a terminal", async () => {
  const { context, signIf } = fixture();
  const file = path.join(context.appOutDir, "Murage.exe");
  const bytes = fs.readFileSync(file); bytes.writeUInt16LE(3, 220); fs.writeFileSync(file, bytes);
  await expect(afterPack(context)).rejects.toThrow("WINDOWS_GUI_SUBSYSTEM_REQUIRED");
  expect(signIf).not.toHaveBeenCalled();
});
