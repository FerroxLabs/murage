// Exercise the shipped verifier through the real NSIS download task. All
// subprocess/network operations are fixtures; this is not native Windows proof.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { assertWindowsVerifierSource, patchWindowsSignatureVerifier } from "../scripts/patch-windows-signature-verifier.mjs";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundlePath = join(root, "electron/vendor/electron-updater.cjs");
const bundle = readFileSync(bundlePath, "utf8");
const destination = "C:\\updates\\fixture.exe";
const subject = "CN=Fixture Publisher, O=Fixture Company";
const valid = () => ({ Status: 0, Path: destination, SignerCertificate: { Subject: subject } });

function fixture(response, publishers = [subject]) {
  const calls = { signature: 0, fallback: 0, downloaded: 0, complete: 0, cleanup: 0 };
  const childProcess = {
    execFile(command, args, options, callback) {
      assert.match(command, /powershell\.exe/);
      assert.match(args.at(-1), /Get-AuthenticodeSignature/);
      assert.equal(options.timeout, 20000);
      calls.signature++;
      callback(response.error ?? null, response.stdout ?? JSON.stringify(valid()), response.stderr ?? "");
    },
    execFileSync() {
      calls.fallback++;
      throw new Error("Fixture PowerShell fallback unavailable");
    },
    spawn() { assert.fail("must not start a process"); },
  };
  const isolated = new Module(bundlePath);
  isolated.filename = bundlePath;
  isolated.paths = Module._nodeModulePaths(dirname(bundlePath));
  isolated.require = (name) => {
    if (name === "electron") return { app: {}, autoUpdater: new EventEmitter() };
    if (name === "child_process") return childProcess;
    if (name === "os") return { ...require("node:os"), release: () => response.osRelease ?? "10.0.22631" };
    return require(name);
  };
  isolated._compile(bundle, bundlePath);
  const updater = new isolated.exports.NsisUpdater(null, { version: "1.0.0" });
  updater.logger = { info() {}, warn() {}, error() {}, debug() {} };
  updater.configOnDisk = { value: Promise.resolve({ publisherName: publishers }) };
  updater.httpExecutor = { async download() { calls.downloaded++; } };
  // Only the outer file/cache harness is fake. task is the real NSIS code,
  // including default verifier, config read, result/error consumption and gate.
  updater.executeDownload = async ({ task }) => {
    await task(destination, {}, null, async () => { calls.cleanup++; });
    calls.complete++;
    updater.downloadedUpdateHelper = { file: destination, downloadedFileInfo: {} };
    return [destination];
  };
  const file = { url: new URL("https://fixture.invalid/update.exe"), info: { url: "update.exe", sha512: "fixture-only" } };
  const run = () => updater.doDownloadUpdate({
    disableWebInstaller: true,
    disableDifferentialDownload: true,
    updateInfoAndProvider: { info: { version: "1.0.1" }, provider: { resolveFiles: () => [file] } },
  });
  return { updater, calls, run };
}

const negatives = [
  ["signature subprocess and fallback unavailable", { error: new Error("PowerShell unavailable") }],
  ["old Windows cannot bypass a subprocess failure", { error: new Error("PowerShell unavailable"), osRelease: "6.1.7601" }],
  ["stderr cannot become success", { stderr: "verification blocked" }],
  ["malformed JSON", { stdout: "not-json" }],
  ["missing path", { stdout: JSON.stringify({ ...valid(), Path: undefined }) }],
  ["non-string path", { stdout: JSON.stringify({ ...valid(), Path: 42 }) }],
  ["mismatched path", { stdout: JSON.stringify({ ...valid(), Path: "C:\\other.exe" }) }],
  ["unsigned status", { stdout: JSON.stringify({ ...valid(), Status: 2 }) }],
  ["missing certificate", { stdout: JSON.stringify({ ...valid(), SignerCertificate: null }) }],
  ["wrong publisher", { stdout: JSON.stringify({ ...valid(), SignerCertificate: { Subject: "CN=Other, O=Other" } }) }],
];
for (const [name, response] of negatives) {
  test(`real NSIS task rejects ${name}`, async () => {
    const { updater, calls, run } = fixture(response);
    await assert.rejects(run(), { code: "ERR_UPDATER_INVALID_SIGNATURE" });
    assert.equal(calls.signature, 1, "the actual default verifier must run");
    assert.equal(calls.downloaded, 1, "the task must reach its post-download verification gate");
    assert.equal(calls.fallback, 0, "a compatibility probe cannot establish signature validity");
    assert.equal(calls.complete, 0);
    assert.equal(updater.installerPath, null);
    assert.equal(updater.install(false, false), false, "failed task must not make the update installable");
  });
}
for (const [name, publishers] of [["full DN", [subject]], ["existing CN policy", ["Fixture Publisher"]]]) {
  test(`real NSIS task accepts valid matching ${name}`, async () => {
    const { updater, calls, run } = fixture({}, publishers);
    assert.deepEqual(await run(), [destination]);
    assert.equal(calls.signature, 1);
    assert.equal(calls.fallback, 0);
    assert.equal(calls.complete, 1);
    assert.equal(calls.cleanup, 0);
    assert.equal(updater.installerPath, destination);
  });
}

test("reviewed upstream source identity is pinned", () => {
  const packagePath = require.resolve("electron-updater/package.json");
  const version = JSON.parse(readFileSync(packagePath, "utf8")).version;
  const source = readFileSync(join(dirname(packagePath), "out/windowsExecutableCodeSignatureVerifier.js"));
  assert.doesNotThrow(() => assertWindowsVerifierSource(version, source));
  assert.throws(() => assertWindowsVerifierSource("0.0.0", source), /source changed/);
  assert.throws(() => assertWindowsVerifierSource(version, Buffer.concat([source, Buffer.from("\n")])), /source changed/);
});

test("generated upstream verifier patch rejects missing, duplicate and moved shapes", async () => {
  const result = await build({ entryPoints: [require.resolve("electron-updater")], bundle: true, platform: "node", target: "node20", format: "cjs", external: ["electron"], write: false, logLevel: "silent" });
  const source = result.outputFiles[0].text;
  assert.doesNotThrow(() => patchWindowsSignatureVerifier(source));
  assert.throws(() => patchWindowsSignatureVerifier(""), /found 0/);
  assert.throws(() => patchWindowsSignatureVerifier(source + source), /found 2/);
  assert.throws(() => patchWindowsSignatureVerifier(source.replace("function handleError(logger, error, stderr, reject)", "function renamedError(logger, error, stderr, reject)")), /error handler sites, found 0/);
  assert.throws(() => patchWindowsSignatureVerifier(source.replace("Skipping this step of validation.", "Different upstream handling.")), /missing path rejection sites, found 0/);
  assert.throws(() => patchWindowsSignatureVerifier(patchWindowsSignatureVerifier(source)), /sites, found 0/);
});
