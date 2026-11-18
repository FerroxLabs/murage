import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ZipFile } from "yazl";
import { removeTempDirSync } from "../server/testing/cleanup.ts";
import { peSha256 } from "./windows-pe-signing.mjs";
import { WINDOWS_SIGNING_PROVIDER, loadWindowsSigningProvider, stageWindowsSigningProvider } from "./windows-signing-provider.mjs";
import { windowsSigningLaunchScript } from "./windows-signing-launch.mjs";
import { azureWindowsPeSigner } from "./windows-azure-signer.mjs";

import { assertSigningWorkflowIsolation, signingWorkflows } from "./fixtures/windows-signing-workflows.mjs";
const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) removeTempDirSync(dir); });
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "windows-provider-")); dirs.push(root);
  const action = Buffer.from("inputs: {file-digest: {default: SHA256}}\nruns:\n  using: composite\n  steps:\n    - name: Invoke signing\n      shell: pwsh\n      run: Invoke-ArtifactSigning @params\n");
  const zip = new ZipFile(), chunks = [], done = new Promise(resolve => { zip.outputStream.on("data", chunk => chunks.push(chunk)); zip.outputStream.on("end", resolve); });
  zip.addBuffer(Buffer.from("# neutral module fixture"), "ArtifactSigning.psd1"); zip.end(); await done;
  const module = Buffer.concat(chunks), pin = { ...WINDOWS_SIGNING_PROVIDER, dependencies: [], actionSha256: peSha256(action), moduleSha256: peSha256(module) };
  const directory = path.join(root, "provider"), download = vi.fn(async url => url.endsWith("action.yml") ? action : module);
  return { root, directory, download, pin, actionRef: pin.action, env: {} };
}

it.each(["actionSha256", "moduleSha256"])("RED rejects a changed %s before extracting or executing provider code", async field => {
  const f = await fixture(); f.pin[field] = "0".repeat(64);
  await expect(stageWindowsSigningProvider(f)).rejects.toThrow("WINDOWS_SIGNING_PROVIDER_HASH_MISMATCH");
  expect(fs.existsSync(f.directory)).toBe(false);
});
it("rejects a changed NuGet dependency before extracting provider code", async () => {
  const f = await fixture();
  f.pin.dependencies = [{ name: "fixture-dependency", version: "1.0.0", sha256: "0".repeat(64) }];
  await expect(stageWindowsSigningProvider(f)).rejects.toThrow("WINDOWS_SIGNING_DEPENDENCY_HASH_MISMATCH");
  expect(fs.existsSync(f.directory)).toBe(false);
});
it("refuses provider preparation when signing credentials are present", async () => {
  const f = await fixture(); f.env.AZURE_CLIENT_SECRET = "neutral-fixture";
  await expect(stageWindowsSigningProvider(f)).rejects.toThrow("WINDOWS_SIGNING_PREPARATION_HAS_CREDENTIALS");
  expect(f.download).not.toHaveBeenCalled();
});
async function signingFixture() {
  const f = await fixture(), staged = await stageWindowsSigningProvider(f);
  const runtime = path.join(f.root, "runtime"); fs.mkdirSync(runtime);
  const pwsh = path.join(runtime, "pwsh.exe"), node = path.join(runtime, "node.exe"), driver = path.join(runtime, "driver.mjs"), launchScript = path.join(runtime, "launch.ps1");
  for (const file of [pwsh, node, driver]) fs.writeFileSync(file, "neutral pinned executable fixture");
  fs.writeFileSync(launchScript, windowsSigningLaunchScript(node, driver));
  const provider = JSON.parse(fs.readFileSync(staged.receipt));
  const files = [...provider.files, { path: staged.receipt, sha256: staged.sha256 }, ...[pwsh, node, driver, launchScript].map(file => ({ path: file, sha256: peSha256(fs.readFileSync(file)) }))];
  const executables = Object.fromEntries([["pwsh", pwsh], ["node", node]].map(([name, file]) => [name, {
    source: "trusted-configuration", path: file, sha256: peSha256(fs.readFileSync(file)), signer: "Fixture Vendor",
  }]));
  const contract = { schema: 1, roots: [f.directory, runtime], files, pwsh, node, driver, launchScript,
    providerReceipt: staged.receipt, executables, path: [runtime], modulePath: [f.directory], environment: {} };
  const contractFile = path.join(f.root, "launch.json");
  const pinContract = () => { fs.writeFileSync(contractFile, JSON.stringify(contract)); return { file: contractFile, sha256: peSha256(fs.readFileSync(contractFile)) }; };
  const measureExecutable = vi.fn(async () => ({ status: "Valid", embedded: true, publisher: "Fixture Vendor", userWritable: false }));
  const env = { MURAGE_WINDOWS_SIGNER_RECEIPT: staged.receipt, MURAGE_WINDOWS_SIGNER_RECEIPT_SHA256: staged.sha256,
    INPUT_FILES_FOLDER: "unreviewed", INPUT_FILES_FOLDER_RECURSE: "true", INPUT_TRACE: "true" };
  const run = vi.fn(async () => ({}));
  const signer = () => azureWindowsPeSigner({ publisherName: "Ferrox Labs, LLC", endpoint: "https://signing.example.invalid", codeSigningAccountName: "fixture", certificateProfileName: "fixture" },
    { platform: "win32", env, run, measureExecutable, launchContract: pinContract() });
  return { ...f, staged, env, run, contract, measureExecutable, signer };
}
it("executes the pinned action's single-file invocation and rejects staged code substitution with zero executions", async () => {
  const f = await signingFixture(), { run } = f, sign = f.signer();
  await expect(sign("one-file.exe")).resolves.toBe(true);
  expect(run).toHaveBeenCalledOnce();
  const [command, args, options] = run.mock.calls[0];
  // MAIN RULING 1115-WINSAC-PWSH: windows-signing-provider.test.mjs:49 may drop bare `pwsh.exe`.
  // Passing spawn: command === trusted-configuration pwsh pin.path, path.win32.isAbsolute(command), basename pwsh.exe, and only after file SHA256 === pin.sha256 and measured Authenticode signer === pin.signer. argv exactly ["-NoProfile","-NonInteractive","-File", absolute invoke.ps1]; options.shell === false. Keep the existing INPUT_FILES env assertions. Keep Azure action.yml shell token `pwsh` (windows-signing-provider.mjs:28).
  // Refuse with zero run() calls: bare `pwsh` and `pwsh.exe`; any PATH or GITHUB_PATH resolution, including an absolute result; relative paths; an absolute path in a user-writable directory (TEMP, profile, workspace, runner temp) even when hash and signer match; wrong SHA256; wrong signer.
  expect(command).toBe(f.contract.executables.pwsh.path);
  expect(peSha256(fs.readFileSync(command))).toBe(f.contract.executables.pwsh.sha256);
  expect(path.win32.isAbsolute(command)).toBe(true); expect(path.win32.basename(command)).toBe("pwsh.exe");
  expect(args).toEqual(["-NoProfile", "-NonInteractive", "-File", path.join(f.directory, "invoke.ps1")]);
  expect(path.isAbsolute(args[3])).toBe(true); expect(options.shell).toBe(false);
  expect(f.measureExecutable).toHaveBeenCalledWith(command, expect.any(Object));
  expect(f.measureExecutable.mock.invocationCallOrder[0]).toBeLessThan(run.mock.invocationCallOrder[0]);
  expect(options.env.INPUT_FILES).toBe("one-file.exe");
  for (const key of ["INPUT_FILES_FOLDER", "INPUT_FILES_FOLDER_RECURSE", "INPUT_TRACE"]) expect(options.env[key]).toBeUndefined();
  run.mockClear(); fs.appendFileSync(path.join(f.directory, "ArtifactSigning/0.1.8/ArtifactSigning.psd1"), "changed");
  await expect(sign("one-file.exe")).rejects.toThrow("WINDOWS_SIGNING_PROVIDER_HASH_MISMATCH"); expect(run).not.toHaveBeenCalled();
});
it("rejects a substituted provider receipt without trusting its hashes", async () => {
  const f = await fixture(), staged = await stageWindowsSigningProvider(f);
  fs.appendFileSync(staged.receipt, " ");
  await expect(loadWindowsSigningProvider({ MURAGE_WINDOWS_SIGNER_RECEIPT: staged.receipt, MURAGE_WINDOWS_SIGNER_RECEIPT_SHA256: staged.sha256 })).rejects.toThrow("WINDOWS_SIGNING_PROVIDER_HASH_MISMATCH");
});
// Option A (Sean 2026-11-18T06:42Z): 1.0.19 signs Windows in-job exactly as 1.0.18 shipped; controller-admitted signing + SAC qualification are the first post-release item.
// The content-pinned provider preparation job is a controller job and does not exist in 1.0.19, so its wiring assertions are
// retired; the provider module itself stays tested above. What must hold now: credentials sit only where 1.0.18 had them, and
// the GEPA images are signed by the same pinned Azure action in both workflows before packaging.
it("RED both Windows workflows sign with one pinned Azure action before the only credentialed package step", () => {
  const workflows = signingWorkflows();
  assertSigningWorkflowIsolation(workflows);
  const pins = [];
  for (const [file, name] of [["release.yml", "windows"], ["package-win.yml", "package"]]) {
    const steps = workflows[file].jobs[name].steps;
    const action = steps.findIndex(step => String(step.uses).startsWith("Azure/artifact-signing-action@"));
    const pack = steps.findIndex(step => step.env?.AZURE_CLIENT_SECRET);
    expect(action).toBeGreaterThanOrEqual(0);
    expect(pack).toBeGreaterThan(action);
    expect(steps[action].with["files-folder-filter"]).toBe("exe,dll,pyd");
    expect(JSON.stringify(workflows[file])).not.toContain("windows-signing-provider.mjs");
    pins.push(steps[action].uses);
  }
  expect(new Set(pins).size).toBe(1);
});

it.each(["pwsh", "pwsh.exe", "relative/pwsh.exe", "PATH", "GITHUB_PATH", "PATH-absolute", "GITHUB_PATH-absolute", "wrong-sha256", "wrong-signer",
  "TEMP", "profile", "workspace", "runner-temp"])("refuses %s launch selection with zero run calls", async mode => {
  const f = await signingFixture(), pin = f.contract.executables.pwsh;
  if (["pwsh", "pwsh.exe", "relative/pwsh.exe"].includes(mode)) f.contract.pwsh = pin.path = mode;
  else if (mode.startsWith("PATH") || mode.startsWith("GITHUB_PATH")) {
    pin.source = mode.split("-")[0];
    f.env[pin.source] = path.dirname(pin.path);
    if (!mode.endsWith("absolute")) f.contract.pwsh = pin.path = "pwsh.exe";
  } else if (mode === "wrong-sha256") pin.sha256 = "0".repeat(64);
  else if (mode === "wrong-signer") f.measureExecutable.mockResolvedValue({ status: "Valid", embedded: true, publisher: "Other Vendor", userWritable: false });
  else {
    // Native AccessCheck reports writable even when the bytes and signer match.
    expect(peSha256(fs.readFileSync(pin.path))).toBe(pin.sha256);
    f.env[{ TEMP: "TEMP", profile: "USERPROFILE", workspace: "GITHUB_WORKSPACE", "runner-temp": "RUNNER_TEMP" }[mode]] = path.dirname(pin.path);
    f.measureExecutable.mockResolvedValue({ status: "Valid", embedded: true, publisher: pin.signer, userWritable: true });
  }
  await expect(f.signer()("one-file.exe")).rejects.toThrow("WINDOWS_SIGNING_LAUNCH_REJECTED");
  expect(f.run).not.toHaveBeenCalled();
});
it.each([
  { status: "NotSigned", embedded: false, publisher: "Fixture Vendor", userWritable: false },
  { status: "Valid", embedded: false, publisher: "Fixture Vendor", userWritable: false },
  { status: "Valid", embedded: true, publisher: "Fixture Vendor" },
])("refuses incomplete native launch trust %j with zero run calls", async measured => {
  const f = await signingFixture(); f.measureExecutable.mockResolvedValue(measured);
  await expect(f.signer()("one-file.exe")).rejects.toThrow("WINDOWS_SIGNING_LAUNCH_REJECTED");
  expect(f.run).not.toHaveBeenCalled();
});
