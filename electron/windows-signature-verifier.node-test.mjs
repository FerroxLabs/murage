// Exercise the shipped verifier through the real NSIS download task. All
// subprocess/network operations are fixtures; this is not native Windows proof.
//
// Astra nops #6: electron-updater's own Windows check starts PowerShell. The
// shipped default starts nothing and refuses; the app's native check
// (electron/windows-update-signature.mjs, WinVerifyTrust through the addon)
// is what accepts a correctly signed update.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { assertWindowsVerifierSource, patchWindowsSignatureVerifier } from "../scripts/patch-windows-signature-verifier.mjs";
import { updateErrorMessage, WINDOWS_SIGNATURE_MISMATCH_MESSAGE, WINDOWS_SIGNATURE_UNAVAILABLE_MESSAGE } from "./update-errors.mjs";
import { createWindowsUpdateVerifier, installWindowsUpdateVerifier, parseDistinguishedName, publisherMatches } from "./windows-update-signature.mjs";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundlePath = join(root, "electron/vendor/electron-updater.cjs");
const bundle = readFileSync(bundlePath, "utf8");
const destination = "C:\\updates\\fixture.exe";
const subject = "CN=Fixture Publisher, O=Fixture Company";
const validAnswer = () => ({ status: "Valid", publisher: "Fixture Publisher", subject, code: 0 });

function fixture({ native, publishers = [subject] } = {}) {
  const calls = { processes: 0, signature: 0, downloaded: 0, complete: 0, cleanup: 0 };
  const childProcess = {
    execFile() { calls.processes++; assert.fail("the signature check must not start a process"); },
    execFileSync() { calls.processes++; assert.fail("the signature check must not start a process"); },
    spawn() { calls.processes++; assert.fail("must not start a process"); },
  };
  const isolated = new Module(bundlePath);
  isolated.filename = bundlePath;
  isolated.paths = Module._nodeModulePaths(dirname(bundlePath));
  isolated.require = (name) => {
    if (name === "electron") return { app: {}, autoUpdater: new EventEmitter() };
    if (name === "child_process") return childProcess;
    return require(name);
  };
  isolated._compile(bundle, bundlePath);
  const updater = new isolated.exports.NsisUpdater(null, { version: "1.0.0" });
  updater.logger = { info() {}, warn() {}, error() {}, debug() {} };
  if (native) {
    const authenticode = async (file) => { calls.signature++; assert.equal(file, destination); return native(file); };
    assert.equal(installWindowsUpdateVerifier(updater, { platform: "win32", native: { authenticode } }), true);
  }
  updater.configOnDisk = { value: Promise.resolve({ publisherName: publishers }) };
  updater.httpExecutor = { async download() { calls.downloaded++; } };
  // Only the outer file/cache harness is fake. task is the real NSIS code,
  // including the verifier, config read, result/error consumption and gate.
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

test("the shipped default verifier starts no process (no PowerShell) and refuses the update", async () => {
  const { updater, calls, run } = fixture();
  const error = await run().then(() => assert.fail("must refuse"), value => value);
  assert.equal(error.code, "ERR_UPDATER_INVALID_SIGNATURE");
  assert.equal(error.signatureCheck, "unavailable");
  assert.equal(updateErrorMessage(error), WINDOWS_SIGNATURE_UNAVAILABLE_MESSAGE);
  assert.equal(calls.processes, 0);
  assert.equal(calls.downloaded, 1, "the task reached its post-download verification gate");
  assert.equal(updater.installerPath, null);
});

test("the shipped verifier module holds no child process and no PowerShell", () => {
  const module = /var require_windowsExecutableCodeSignatureVerifier = __commonJS\(\{[\s\S]*?\n\}\);/.exec(bundle)?.[0] ?? "";
  assert.ok(module.length > 0);
  assert.doesNotMatch(module, /child_process|powershell|pwsh|Get-AuthenticodeSignature/i);
  assert.doesNotMatch(bundle, /powershell|pwsh/i);
});

const negatives = [
  ["an unsigned file", () => ({ status: "NotSigned", publisher: "", subject: "", code: 0x800b0100 })],
  ["a changed file", () => ({ status: "HashMismatch", publisher: "", subject: "", code: 0x80096010 })],
  ["an untrusted signer", () => ({ ...validAnswer(), status: "NotTrusted" })],
  ["another publisher", () => ({ ...validAnswer(), publisher: "Other", subject: "CN=Other, O=Other" })],
  ["the right common name in another company", () => ({ ...validAnswer(), subject: "CN=Fixture Publisher, O=Other Company" })],
];
for (const [name, native] of negatives) {
  test(`the native check refuses ${name} through the real NSIS task`, async () => {
    const { updater, calls, run } = fixture({ native });
    const error = await run().then(() => assert.fail("must refuse"), value => value);
    assert.equal(error.code, "ERR_UPDATER_INVALID_SIGNATURE");
    assert.equal(updateErrorMessage(error), WINDOWS_SIGNATURE_MISMATCH_MESSAGE);
    assert.equal(calls.signature, 1, "the native check ran");
    assert.equal(calls.processes, 0);
    assert.equal(calls.complete, 0);
    assert.equal(updater.installerPath, null);
    assert.equal(updater.install(false, false), false, "failed task must not make the update installable");
  });
}
test("a native check that cannot run refuses the update and says so", async () => {
  const { calls, run } = fixture({ native: () => { throw new Error("authenticode check did not finish"); } });
  const error = await run().then(() => assert.fail("must refuse"), value => value);
  assert.equal(error.signatureCheck, "unavailable");
  assert.equal(updateErrorMessage(error), WINDOWS_SIGNATURE_UNAVAILABLE_MESSAGE);
  assert.equal(calls.processes, 0);
});
for (const [name, publishers] of [["full DN", [subject]], ["existing CN policy", ["Fixture Publisher"]]]) {
  test(`the native check accepts a valid matching ${name} through the real NSIS task`, async () => {
    const { updater, calls, run } = fixture({ native: validAnswer, publishers });
    assert.deepEqual(await run(), [destination]);
    assert.equal(calls.signature, 1);
    assert.equal(calls.processes, 0);
    assert.equal(calls.complete, 1);
    assert.equal(calls.cleanup, 0);
    assert.equal(updater.installerPath, destination);
  });
}

test("publisher rules: Murage's own publisher name, a comma inside a common name, quoted and escaped values", () => {
  // electron-builder.yml's publisherName is a plain name holding a comma: it is a common name, not a DN
  assert.equal(parseDistinguishedName("Ferrox Labs, LLC").size, 0);
  const signer = { publisher: "Ferrox Labs, LLC", subject: 'CN="Ferrox Labs, LLC", O="Ferrox Labs, LLC", L=Miami, S=Florida, C=US' };
  assert.equal(publisherMatches(["Ferrox Labs, LLC"], signer), true);
  assert.equal(publisherMatches(['CN="Ferrox Labs, LLC", C=US'], signer), true);
  assert.equal(publisherMatches(["CN=Ferrox Labs\\, LLC, L=Miami"], signer), true);
  assert.equal(publisherMatches(["CN=Ferrox Labs\\, LLC, L=Austin"], signer), false);
  assert.equal(publisherMatches(["Ferrox Labs"], signer), false);
  assert.equal(publisherMatches([""], { publisher: "", subject: "" }), false);
});

test("the native check is set only on Windows with the addon", () => {
  const updater = {};
  assert.equal(installWindowsUpdateVerifier(updater, { platform: "darwin", native: { authenticode() {} } }), false);
  assert.equal(installWindowsUpdateVerifier(updater, { platform: "win32", native: null }), false);
  assert.equal(updater.verifyUpdateCodeSignature, undefined);
  assert.equal(installWindowsUpdateVerifier(updater, { platform: "win32", native: { authenticode() {} } }), true);
  assert.equal(typeof updater.verifyUpdateCodeSignature, "function");
});

test("a relative or missing path is never handed to the native check", async () => {
  let asked = 0;
  const verify = createWindowsUpdateVerifier({ authenticode: async () => { asked++; return validAnswer(); }, logger: null });
  await assert.rejects(verify([subject], "relative.exe"), { signatureCheck: "unavailable" });
  await assert.rejects(createWindowsUpdateVerifier({})([subject], destination), { signatureCheck: "unavailable" });
  assert.equal(asked, 0);
});

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

test("the shipped verifier is exactly the reviewed patch of upstream", async () => {
  const result = await build({ entryPoints: [require.resolve("electron-updater")], bundle: true, platform: "node", target: "node20", format: "cjs", external: ["electron"], write: false, logLevel: "silent" });
  const module = (text) => /var require_windowsExecutableCodeSignatureVerifier = __commonJS\(\{[\s\S]*?\n\}\);/.exec(text)?.[0];
  assert.equal(module(patchWindowsSignatureVerifier(result.outputFiles[0].text)), module(bundle));
});
