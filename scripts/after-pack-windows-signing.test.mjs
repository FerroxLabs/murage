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
import { appendPeFixtureCertificate, unsignedPeFixture } from "./fixtures/windows-pe-signing.mjs";
import { fixturePeSource, fixturePreservedRecord, fixturePeTrust, fixtureRevision } from "./fixtures/windows-pe-provenance.mjs";
import { WINDOWS_PE_BUILD_OUTPUTS } from "./windows-pe-signing.mjs";
import { unsignedWindowsPePin, verifySignedWindowsPe } from "../shared/windows-signed-pe.mjs";
import { dispatchWindowsBuilderSigning, windowsBuilderSigning } from "./windows-builder-signing.mjs";
import { windowsGepaFixture } from "./fixtures/windows-gepa.mjs";
vi.mock("../shared/windows-backup-tools.mjs", async () => {
  const { createHash } = await import("node:crypto"); const { unsignedPeFixture } = await import("./fixtures/windows-pe-signing.mjs");
  const sha = value => createHash("sha256").update(value).digest("hex"), pe = text => Buffer.concat([unsignedPeFixture(), Buffer.from(text)]);
  return { WINDOWS_BACKUP_RAW_SHA256: { age: sha(pe("raw age fixture")), keygen: sha(pe("raw keygen fixture")), license: sha("raw license fixture") }, WINDOWS_BACKUP_ARCHIVE: { url: "https://invalid.example/never-used", sha256: "0".repeat(64) } };
});
vi.mock("../shared/backup-restic-pin.mjs", async original => {
  const actual = await original(); const { createHash } = await import("node:crypto"); const { unsignedPeFixture } = await import("./fixtures/windows-pe-signing.mjs");
  return { ...actual, RESTIC_PINS: { ...actual.RESTIC_PINS, "win32-x64": { ...actual.RESTIC_PINS["win32-x64"], originalSha256: createHash("sha256").update(Buffer.concat([unsignedPeFixture(), Buffer.from("raw restic fixture")])).digest("hex") } } };
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
import { loadEngineExclusionResource } from "./engine-exclusion-resource.mjs";
import { nativeAuthenticodeIn } from "../server/browser-windows-identity.ts";
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
    loadEngineExclusionResource: vi.fn(() => "loaded"),
  };
});
// Exercise the real frozen GEPA inventory as well as its packaging call order.
vi.mock("../server/gepa-resource.ts", async original => {
  const actual = await original();
  return { ...actual, verifyGepaBundle: vi.fn(actual.verifyGepaBundle) };
});
import { verifyGepaBundle } from "../server/gepa-resource.ts";
const GEPA_RECEIPT = "a".repeat(64);
import { verifyBrowserBundle } from "./prepare-browser.mjs";
vi.mock("../server/browser-windows-identity.ts", async importOriginal => ({
  ...await importOriginal(),
  verifyWindowsBrowserImage: vi.fn(() => ({ signed: true })),
  verifyWindowsBrowserSignatures: vi.fn(async () => {}),
  // the packaged addon's WinVerifyTrust check (no PowerShell fallback exists any more)
  nativeAuthenticodeIn: vi.fn(resources => ({ resources, authenticode: async () => ({ status: "Valid", publisher: "Ferrox Labs, LLC", embedded: true, timestamp: true }) })),
}));
import { verifyWindowsBrowserImage, verifyWindowsBrowserSignatures } from "../server/browser-windows-identity.ts";
import afterPack from "./after-pack.mjs";
import afterSign from "./windows-hide-package-manifest.mjs";
import { browserBundlePaths } from "../server/browser-bundle-release.ts";
import { verifyFuigoExecutable } from "./prepare-fuigo.mjs";
import { verifyWindowsSacInventory, windowsPeFiles } from "./windows-sac-inventory.mjs";

const peBytes = text => Buffer.concat([unsignedPeFixture(), Buffer.from(text)]);
const temporaryDirectories = [];
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  exclusionRun.calls.length = 0;
  exclusionRun.receipt = undefined;
  for (const directory of temporaryDirectories.splice(0)) removeTempDirSync(directory);
});

const CONTROL_PLANE = fs.readFileSync(path.join(import.meta.dirname, "..", "electron", "cloud-control-plane.mjs"));

/** resources/app.asar holding electron/cloud-control-plane.mjs, in the asar format (size pickle, header pickle, file data). The prod-pin gate has its own suite (packaged-prod-pin.test.mjs); here the package carries the real module so that gate passes for real. */
function writeAppAsar(resources, member = CONTROL_PLANE, gepaHash = GEPA_RECEIPT) {
  const metadata = Buffer.from(JSON.stringify({ murageGepaManifests: { "win32-x64": gepaHash } }));
  const json = Buffer.from(JSON.stringify({ files: { "package.json": { size: metadata.length, offset: String(member.length) }, electron: { files: { "cloud-control-plane.mjs": { size: member.length, offset: "0" } } } } }), "utf8");
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4);
  json.copy(padded);
  const header = Buffer.alloc(8);
  header.writeUInt32LE(padded.length + 4, 0);
  header.writeUInt32LE(json.length, 4);
  const size = Buffer.alloc(8);
  size.writeUInt32LE(4, 0);
  size.writeUInt32LE(header.length + padded.length, 4);
  fs.writeFileSync(path.join(resources, "app.asar"), Buffer.concat([size, header, padded, member, metadata]));
}

function fixture() {
  proveAnchoredReadResource.mockReturnValue("loaded");
  verifyWindowsBrowserImage.mockReturnValue({ signed: true });
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), "murage-windows-signing-"));
  const gui = unsignedPeFixture();
  fs.writeFileSync(path.join(appOutDir, "Murage.exe"), gui);
  temporaryDirectories.push(appOutDir);
  const resources = path.join(appOutDir, "resources");
  for (const name of ["fuigo", "fuigo-probe", "cloudflared", "licenses"]) fs.mkdirSync(path.join(resources, name), { recursive: true });
  const gepa = windowsGepaFixture(path.join(resources, "gepa-worker"), path.join(appOutDir, "gepa-metadata.json"), { signed: true });
  writeAppAsar(resources, CONTROL_PLANE, gepa.hash);
  const executable = path.join(resources, "fuigo", "fuigo.exe");
  fs.writeFileSync(executable, peBytes("pinned fixture"));
  const recovery = path.join(resources, "murage-recovery.exe");
  fs.writeFileSync(recovery, peBytes("recovery fixture"));
  const browser = browserBundlePaths(path.join(resources, "browser-engine"), "win32-x64");
  fs.mkdirSync(path.dirname(browser.chrome), { recursive: true });
  fs.writeFileSync(browser.engine, peBytes("pinned browser engine"));
  fs.writeFileSync(browser.chrome, peBytes("pinned browser chrome"));
  fs.writeFileSync(path.join(resources, "cloudflared", "cloudflared.exe"), peBytes("vendor fixture"));
  fs.writeFileSync(path.join(resources, "anchored-read.node"), peAddon());
  fs.writeFileSync(path.join(resources, "presence-guard.node"), peAddon());
  fs.writeFileSync(path.join(resources, "engine-exclusion.node"), peAddon()); // the engine-exclusion addon (the gate refuses a package without it)
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
  const header = unsignedPeFixture();
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
  for (const [file, bytes] of [["age.exe", "raw age fixture"], ["age-keygen.exe", "raw keygen fixture"], ["LICENSE", "raw license fixture"], ["restic.exe", "raw restic fixture"]]) fs.writeFileSync(path.join(backupDirectory, file), file.endsWith(".exe") ? peBytes(bytes) : bytes);
  // Include every reviewed packaged path, plus all our built resources and GEPA's onedir images.
  const catalogue = JSON.parse(fs.readFileSync(new URL("./windows-sac-allowlist.json", import.meta.url), "utf8")).files;
  for (const item of catalogue) {
    const file = path.join(appOutDir, item.path);
    if (!fs.existsSync(file)) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, header); }
  }
  const signIf = vi.fn(async file => {
    expect(verifyFuigoExecutable).toHaveBeenCalledWith(executable, "win32-x64");
    expect(verifyBrowserBundle).toHaveBeenCalledWith(path.join(resources, "browser-engine"), "win32-x64");
    fs.writeFileSync(file, appendPeFixtureCertificate(fs.readFileSync(file)));
    return true;
  });
  // The signing builder supplies a clean source repository for package provenance.
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "murage-signing-source-"));
  temporaryDirectories.push(projectDir);
  fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ name: "signing-fixture", version: "1.0.19" }));
  const git = args => execFileSync("git", args, { cwd: projectDir, encoding: "utf8" }).trim();
  git(["init", "-q"]);
  git(["add", "package.json"]);
  git(["-c", "user.name=ci", "-c", "user.email=fixture@example.test", "commit", "-qm", "signing fixture"]);
  const sources = [];
  // Synthetic receipts for the explicitly constructed fixture, never a production build receipt.
  const pinsForFixture = directory => { for (const name of fs.readdirSync(directory)) {
    const file = path.join(directory, name);
    if (fs.statSync(file).isDirectory()) pinsForFixture(file);
    else if (/\.(exe|dll|node|pyd)$/i.test(name) || fs.readFileSync(file).subarray(0, 2).toString() === "MZ") {
      const relative = path.relative(appOutDir, file).split(path.sep).join("/"), component = WINDOWS_PE_BUILD_OUTPUTS[relative];
      sources.push(fixturePeSource(relative, fs.readFileSync(file), component ? { kind: "build", component, sourceRevision: fixtureRevision,
        inputs: [{ component: "source", sha256: "b".repeat(64) }], transformations: ["fixture compile/resource edit"] } : {}));
    }
  } }; pinsForFixture(appOutDir);
  const frozen = sources.filter(pin => pin.path.startsWith("resources/gepa-worker/"));
  for (const pin of frozen) { pin.sourceReceiptSha256 = gepa.hash; pin.version = "0.1.4"; pin.component = "gepa"; }
  const compiledRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compiled-transport-")); temporaryDirectories.push(compiledRoot);
  const finalAge = createHash("sha256").update(appendPeFixtureCertificate(peBytes("raw age fixture"))).digest("hex");
  const transportPin = fixturePeSource("resources/backup-tools/x64/murage-backup-age.exe", header, { kind: "build", component: "backup-transport", sourceRevision: fixtureRevision,
    inputs: [{ component: "age", sha256: finalAge }], transformations: ["fixture compile with final age pin"] });
  const context = { windowsPeSigner: signIf, appOutDir, arch: "x64", electronPlatformName: "win32", windowsPeSources: sources, windowsPeSourceRevision: fixtureRevision, signingTrust: fixturePeTrust,
    windowsBackupSourcePin: transportPin, windowsBackupBuild: () => { const file = path.join(compiledRoot, "compiled-helper.exe"); fs.writeFileSync(file, header); return file; },
    packager: { projectDir, signIf, appInfo: { updaterCacheDirName: "signing-fixture-updater" }, config: { publish: null, extraMetadata: { murageGepaManifests: { "win32-x64": gepa.hash },
      murageWindowsPeGepa: { sourceManifestSha256: gepa.hash, sources: frozen, records: frozen.map(fixturePreservedRecord) } } } } };
  context.packager.signIf = file => dispatchWindowsBuilderSigning(context.packager, file);
  return { executable, recovery, browser, helper, helperManifest, backupDirectory, backupHelper, signIf, gepa, context };
}

// Builder owns the resource-edit/final-sign boundary; the real afterSign hook
// must perform all packaged smoke checks only after that boundary.
async function finalSignAndSmoke(context) {
  await context.packager.signIf(path.join(context.appOutDir, "Murage.exe"));
  const ui = path.join(context.appOutDir, "resources/ui"); fs.mkdirSync(ui, { recursive: true });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  fs.writeFileSync(path.join(ui, "build-commit.json"), JSON.stringify({ commit }));
  vi.stubEnv("MURAGE_WINDOWS_SAC_RELEASE_METADATA", path.join(context.packager.projectDir, "release-metadata.json"));
  await afterSign(context);
}

it("RED substituted GUI PE is rejected with zero packaged executions", async () => {
  const { context } = fixture();
  const file = path.join(context.appOutDir, "Murage.exe");
  const bytes = fs.readFileSync(file); bytes[600] ^= 1; fs.writeFileSync(file, bytes);
  await expect((async () => { await afterPack(context); await finalSignAndSmoke(context); })()).rejects.toThrow("WINDOWS_SAC_UPSTREAM_HASH_MISMATCH");
  expect(loadEngineExclusionResource).not.toHaveBeenCalled();
  expect(proveAnchoredReadResource).not.toHaveBeenCalled();
  expect(nativeAuthenticodeIn).not.toHaveBeenCalled();
});

it.each(["Murage.exe", "resources/engine-exclusion.node", "resources/anchored-read.node", "resources/presence-guard.node", "ffmpeg.dll"])("RED final-boundary substitution of %s is rejected with zero packaged executions", async name => {
  const { context } = fixture();
  await afterPack(context);
  await context.packager.signIf(path.join(context.appOutDir, "Murage.exe"));
  const file = path.join(context.appOutDir, name), bytes = fs.readFileSync(file);
  bytes[600] ^= 1; fs.writeFileSync(file, bytes);
  const rejection = await finalSignAndSmoke(context).then(() => null, error => error);
  expect(loadEngineExclusionResource).not.toHaveBeenCalled();
  expect(proveAnchoredReadResource).not.toHaveBeenCalled();
  expect(nativeAuthenticodeIn).not.toHaveBeenCalled();
  expect(rejection).toBeInstanceOf(Error);
  expect(rejection.message).toMatch(/WINDOWS_PE_RECORD_MISMATCH|WINDOWS_SAC_INVENTORY_REJECTED/);
});

it.each(["Murage.exe", "resources/engine-exclusion.node", "resources/anchored-read.node", "resources/presence-guard.node", "ffmpeg.dll"])("independent Invalid trust for %s rejects before any packaged execution", async name => {
  const { context } = fixture();
  const check = vi.fn(async file => {
    const verdict = await fixturePeTrust.authenticode(file);
    return path.relative(context.appOutDir, file).split(path.sep).join("/") === name ? { ...verdict, status: "Invalid" } : verdict;
  });
  await afterPack(context);
  await context.packager.signIf(path.join(context.appOutDir, "Murage.exe"));
  const state = await windowsBuilderSigning(context);
  state.trust = { authenticode: check };
  await expect(finalSignAndSmoke(context)).rejects.toThrow(/WINDOWS_SAC_UPSTREAM_TRUST_FAILED|WINDOWS_SAC_INVENTORY_REJECTED/);
  expect(loadEngineExclusionResource).not.toHaveBeenCalled();
  expect(proveAnchoredReadResource).not.toHaveBeenCalled();
  expect(nativeAuthenticodeIn).not.toHaveBeenCalled();
});

it("afterPack leaves all packaged execution deferred until final signing and independent verification", async () => {
  const { context } = fixture();
  await afterPack(context);
  expect(loadEngineExclusionResource).not.toHaveBeenCalled();
  expect(proveAnchoredReadResource).not.toHaveBeenCalled();
  expect(nativeAuthenticodeIn).not.toHaveBeenCalled();
  const state = await windowsBuilderSigning(context), verified = new Set();
  state.trust = { authenticode: vi.fn(async file => { verified.add(path.relative(context.appOutDir, file).split(path.sep).join("/")); return fixturePeTrust.authenticode(file); }) };
  loadEngineExclusionResource.mockImplementationOnce(() => {
    expect([...verified].sort()).toEqual(state.sources.map(pin => pin.path).sort());
    expect(state.records.some(record => record.path === "Murage.exe")).toBe(true);
    expect(state.frozen).toBe(true);
    return "loaded after independent verification";
  });
  await finalSignAndSmoke(context);
  expect(loadEngineExclusionResource).toHaveBeenCalledOnce();
  expect(proveAnchoredReadResource).toHaveBeenCalledOnce();
});

it("verifies pinned inventory before signing engines and updater helper", async () => {
  const { context, executable, recovery, browser, helper, helperManifest, backupDirectory, backupHelper, signIf } = fixture();
  await afterPack(context);
  expect(JSON.parse(fs.readFileSync(path.join(context.appOutDir, "resources", "build-provenance.json"), "utf8"))).toEqual({
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: context.packager.projectDir, encoding: "utf8" }).trim(),
    tree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: context.packager.projectDir, encoding: "utf8" }).trim(),
    version: "1.0.19",
  });
  // MAIN RULING 1115-WINSAC-C (GrokBuild): our GEPA build must verify its frozen signed-byte manifest, supplied by the representative fixture.
  expect(verifyGepaBundle).toHaveBeenCalledWith(path.join(context.appOutDir, "resources", "gepa-worker"), "win32-x64", context.packager.config.extraMetadata.murageGepaManifests["win32-x64"]);
  // MAIN RULING 1115-WINSAC-C (GrokBuild): all unsigned upstream PEs go first; main is deferred to builder's final edit/sign boundary.
  const expected = (await windowsPeFiles(context.appOutDir)).filter(file => file !== path.join(context.appOutDir, "Murage.exe") && !gepaPath(file));
  function gepaPath(file) { return file.startsWith(path.join(context.appOutDir, "resources/gepa-worker") + path.sep); }
  expect(signIf.mock.calls.map(([file]) => file).sort()).toEqual(expected.sort());
  expect(signIf.mock.calls.filter(([file]) => file === backupHelper)).toHaveLength(1);
  expect(signIf).toHaveBeenCalledWith(helper);
  for (const [file, text] of [[recovery, "recovery fixture"], [browser.engine, "pinned browser engine"], [browser.chrome, "pinned browser chrome"], [executable, "pinned fixture"]]) {
    expect(fs.readFileSync(file)).toEqual(appendPeFixtureCertificate(peBytes(text)));
  }
  // MAIN RULING 1115-WINSAC-D: round d moves the same smoke assertions to the final signing hook.
  await finalSignAndSmoke(context);
  expect(verifyWindowsBrowserSignatures).toHaveBeenCalledWith(signIf.mock.calls.map(([file]) => file), process.env.SystemRoot, expect.objectContaining({ resources: path.join(context.appOutDir, "resources") }));
  verifyWindowsBackupTools(backupDirectory);
  expect(JSON.parse(fs.readFileSync(helperManifest, "utf8")).binarySha256).toBe(createHash("sha256").update(fs.readFileSync(helper)).digest("hex"));
});

// CONTRACTS-B 1.5 R16/R25 (Astra r1 block 2): the /MT receipt check is part of the Windows packaging path, through afterPack itself.
const peAddon = () => { const b = unsignedPeFixture(); b.writeUInt16LE(0x2022, 86); return b; };
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
  // MAIN RULING 1115-WINSAC-C (GrokBuild): the common signer supplies the failure code.
  await expect(afterPack(context)).rejects.toThrow("WINDOWS_SAC_UPSTREAM_SIGNING_FAILED");
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
  signIf.mockImplementation(async file => { if (path.basename(file) === name) return false; fs.writeFileSync(file, appendPeFixtureCertificate(fs.readFileSync(file))); return true; });
  // MAIN RULING 1115-WINSAC-C (GrokBuild): the common signer supplies the failure code.
  await expect(afterPack(context)).rejects.toThrow("WINDOWS_SAC_UPSTREAM_SIGNING_FAILED");
});

it("refuses tampered raw backup tools before signing and detects signing-time mutation", async () => {
  const first = fixture(); fs.appendFileSync(path.join(first.backupDirectory, "age.exe"), "tampered");
  await expect(afterPack(first.context)).rejects.toThrow("WINDOWS_BACKUP_RAW_MISMATCH"); expect(first.signIf).not.toHaveBeenCalled();
  const second = fixture(); second.signIf.mockImplementation(async file => { fs.writeFileSync(file, appendPeFixtureCertificate(fs.readFileSync(file))); if (file === second.backupHelper) fs.appendFileSync(path.join(second.backupDirectory, "age-keygen.exe"), "incorrect signature"); return true; });
  // MAIN RULING 1115-WINSAC-C (GrokBuild): backup upstreams are already frozen before transport signing.
  await expect(afterPack(second.context)).rejects.toThrow("WINDOWS_BACKUP_SIGNED_MISMATCH"); expect(verifyWindowsBrowserSignatures).not.toHaveBeenCalled();
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
  for (const [file, value] of [["age/age.exe", "raw age fixture"], ["age/age-keygen.exe", "raw keygen fixture"], ["age/LICENSE", "raw license fixture"], ["age/ignored.txt", "not extracted"]]) zip.addBuffer(file.endsWith(".exe") ? peBytes(value) : Buffer.from(value), file);
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
  fs.writeFileSync(path.join(f.backupDirectory, "age.exe"), peBytes("raw age fixture"));
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
  await afterPack(fresh.context);
  await expect(finalSignAndSmoke(fresh.context)).rejects.toThrow("valid Ferrox Labs signature");
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

it("refuses a failed signed anchored-reader packaged smoke before archiving", async () => {
  const f = fixture();
  proveAnchoredReadResource.mockImplementationOnce(() => { throw Error("ANCHORED_RESOURCE_PROOF_FAILED"); });
  await afterPack(f.context);
  await expect(finalSignAndSmoke(f.context)).rejects.toThrow("ANCHORED_RESOURCE_PROOF_FAILED");
  expect(f.signIf).toHaveBeenCalledWith(path.join(f.context.appOutDir, "resources", "anchored-read.node"));
  expect(verifyWindowsBrowserSignatures).not.toHaveBeenCalled();
});

it("refuses a console-subsystem Murage before signing or scheduling can flash a terminal", async () => {
  const { context, signIf } = fixture();
  const file = path.join(context.appOutDir, "Murage.exe");
  const bytes = fs.readFileSync(file); bytes.writeUInt16LE(3, bytes.readUInt32LE(60) + 24 + 68); fs.writeFileSync(file, bytes);
  await expect(afterPack(context)).rejects.toThrow("WINDOWS_GUI_SUBSYSTEM_REQUIRED");
  expect(signIf).not.toHaveBeenCalled();
});


it.each(["engine-exclusion.node", "anchored-read.node", "presence-guard.node"])("SAC refuses an unsigned packaged addon: %s", async name => {
  const { context, signIf } = fixture();
  fs.writeFileSync(path.join(context.appOutDir, "resources", "presence-guard.node"), peAddon());
  signIf.mockImplementation(async file => { if (path.basename(file) === name) return false; fs.writeFileSync(file, appendPeFixtureCertificate(fs.readFileSync(file))); return true; });
  // MAIN RULING 1115-WINSAC-C (GrokBuild): the common signer supplies the failure code.
  await expect(afterPack(context)).rejects.toThrow("WINDOWS_SAC_UPSTREAM_SIGNING_FAILED");
});

it("signs every addon declared by Windows packaging and inventories every runtime addon", async () => {
  const f = fixture();
  const config = parse(fs.readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8"));
  const declared = config.win.extraResources.filter(row => /\.node$/i.test(row.to)).map(row => row.to);
  expect(declared.length).toBeGreaterThan(0);
  // A newly shipped addon needs a fixture and a source receipt before this can pass.
  for (const name of declared) expect(fs.existsSync(path.join(f.context.appOutDir, "resources", name))).toBe(true);
  await afterPack(f.context);
  await f.context.packager.signIf(path.join(f.context.appOutDir, "Murage.exe"));
  const state = await windowsBuilderSigning(f.context);
  const result = await verifyWindowsSacInventory({ ...state, appOutDir: f.context.appOutDir,
    report: path.join(f.context.appOutDir, "inventory.md"), native: nativeAuthenticodeIn(path.join(f.context.appOutDir, "resources")) });
  const addons = (await windowsPeFiles(f.context.appOutDir)).filter(file => /\.node$/i.test(file));
  expect(addons.length).toBeGreaterThanOrEqual(declared.length);
  for (const file of addons) {
    const name = path.relative(f.context.appOutDir, file).split(path.sep).join("/");
    expect(result.rows.find(row => row.path === name)?.signed).toBe(true);
    expect(state.records.find(row => row.path === name)?.finalSha256).toBe(createHash("sha256").update(fs.readFileSync(file)).digest("hex"));
  }
});

it.each(["unlisted.dll", "unlisted.node", "unlisted.exe", "renamed-component.bin"])("SAC refuses an unlisted PE even when renamed: %s", async name => {
  const { context } = fixture();
  fs.writeFileSync(path.join(context.appOutDir, name), peAddon());
  // MAIN RULING 1115-WINSAC-C (GrokBuild): complete source membership is checked before any signing.
  await expect(afterPack(context)).rejects.toThrow("WINDOWS_PE_SOURCE_SET_MISMATCH");
});


it.each(["engine-exclusion.node", "anchored-read.node", "presence-guard.node"])("SAC rejects signIf success without a valid addon signature: %s", async name => {
  const { context } = fixture();
  nativeAuthenticodeIn.mockReturnValueOnce({ authenticode: async file => ({ status: path.basename(file) === name ? "NotSigned" : "Valid", publisher: "Ferrox Labs, LLC", embedded: true, timestamp: true }) });
  await afterPack(context);
  await expect(finalSignAndSmoke(context)).rejects.toThrow("WINDOWS_SAC_INVENTORY_REJECTED");
});

it("SAC loads and version-checks the signed checker only after all signIf calls", async () => {
  const { context, signIf } = fixture();
  loadEngineExclusionResource.mockImplementationOnce(file => {
    expect(path.basename(file)).toBe("engine-exclusion.node");
    expect(signIf).toHaveBeenCalledWith(file);
    // MAIN RULING 1115-WINSAC-C (GrokBuild): verify the real PE source-to-final record in place of an appended text marker.
    expect(() => verifySignedWindowsPe(fs.readFileSync(file), unsignedWindowsPePin(peAddon()))).not.toThrow();
    return "loaded signed checker";
  });
  await afterPack(context);
  await finalSignAndSmoke(context);
  expect(loadEngineExclusionResource).toHaveBeenCalledTimes(1);
  const checkerCall = loadEngineExclusionResource.mock.invocationCallOrder[0];
  expect(checkerCall).toBeGreaterThan(Math.max(...signIf.mock.invocationCallOrder));
});
it("requires the independently pinned runner checker before signing or loading the target checker", async () => {
  const f = fixture(); delete f.context.signingTrust;
  await expect(afterPack(f.context)).rejects.toThrow("WINDOWS_PE_RUNNER_CHECKER_PIN_REQUIRED");
  expect(f.signIf).not.toHaveBeenCalled(); expect(loadEngineExclusionResource).not.toHaveBeenCalled();
});

it("both Windows CI jobs recheck the real final SAC inventory after packaging", () => {
  for (const [file, job] of [["release.yml", "windows"], ["package-win.yml", "package"]]) {
    const config = parse(fs.readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8"));
    const steps = config.jobs[job].steps;
    const gate = steps.findIndex(step => step.name === "Gate: final Windows SAC PE inventory");
    expect(gate).toBeGreaterThan(steps.findIndex(step => step.name === "Package (Azure Trusted Signing)"));
    expect(steps[gate].run).toContain("node scripts/windows-sac-inventory.mjs release/win-unpacked qualification-evidence/SAC-INVENTORY.md");
    expect(steps.find(step => step.name === "Upload Windows SAC inventory").if).toBe("always()");
  }
});

it("the representative package inventories every reviewed resource path and every built PE, including all GEPA images", async () => {
  const f = fixture();
  const foreign = ["darwin/arm64", "linux/arm64", "linux/x64"].map(target => path.join(f.context.appOutDir, "resources/server/node_modules/onnxruntime-node/bin/napi-v6", target, "onnxruntime_binding.node"));
  for (const file of foreign) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "foreign fixture"); }
  await afterPack(f.context);
  expect(foreign.every(file => !fs.existsSync(file))).toBe(true);
  // MAIN RULING 1115-WINSAC-C (GrokBuild): simulate builder's final main signing before the complete inventory.
  await f.context.packager.signIf(path.join(f.context.appOutDir, "Murage.exe"));
  const state = await windowsBuilderSigning(f.context);
  const result = await verifyWindowsSacInventory({ ...state, appOutDir: f.context.appOutDir, report: path.join(f.context.appOutDir, "inventory.md"), signedFiles: f.signIf.mock.calls.map(([file]) => file),
    native: nativeAuthenticodeIn(path.join(f.context.appOutDir, "resources")) });
  const paths = result.rows.map(row => row.path);
  const catalogue = JSON.parse(fs.readFileSync(new URL("./windows-sac-allowlist.json", import.meta.url), "utf8")).files;
  for (const item of catalogue) expect(paths).toContain(item.path);
  const discovered = (await windowsPeFiles(path.join(f.context.appOutDir, "resources")))
    .map(file => path.relative(f.context.appOutDir, file).split(path.sep).join("/"));
  expect(paths.filter(name => name.startsWith("resources/"))).toEqual(discovered);
  const gepa = result.rows.filter(row => row.path.startsWith("resources/gepa-worker/"));
  expect(gepa).toHaveLength(f.gepa.images.length);
  expect(gepa.every(row => row.signedBeforeFreeze && !row.signedHere)).toBe(true);
  expect(gepa.some(row => row.path.endsWith(".pyd"))).toBe(true);
  expect(result.counts.rejected).toBe(0);
});

it.each(["gepa-worker.exe", "python313.dll", "_socket.pyd", "native-image.bin"])("SAC rejects a frozen GEPA image without the Murage publisher signature: %s", async name => {
  const f = fixture();
  nativeAuthenticodeIn.mockReturnValueOnce({ authenticode: async file => ({ status: path.basename(file) === name ? "NotSigned" : "Valid", publisher: "Ferrox Labs, LLC", embedded: true, timestamp: true }) });
  await afterPack(f.context);
  await expect(finalSignAndSmoke(f.context)).rejects.toThrow("WINDOWS_SAC_INVENTORY_REJECTED");
});
