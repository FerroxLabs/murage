// Launch validator/tests owner: win-sac-sign; real Windows runner isolation proof owner: MAIN.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../server/testing/cleanup.ts";
import { peSha256 } from "./windows-pe-signing.mjs";
import { verifyWindowsSigningLaunch, launchWindowsSigningDriver, windowsSigningLaunchScript } from "./windows-signing-launch.mjs";
import { azureWindowsPeSigner } from "./windows-azure-signer.mjs";
import { WINDOWS_SIGNING_PROVIDER } from "./windows-signing-provider.mjs";
const roots = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) removeTempDirSync(root); });
function launchFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "signing-launch-")); roots.push(root);
  const tree = path.join(root, "verified"), poison = path.join(root, "poison"); fs.mkdirSync(tree); fs.mkdirSync(poison);
  const marker = path.join(root, "poison-ran"), observed = path.join(root, "observed.json");
  const sentinel = `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'executed');\n`;
  for (const name of ["node", "pwsh.exe", "preload.cjs", "Microsoft.PowerShell_profile.ps1", "profile.ps1"]) fs.writeFileSync(path.join(poison, name), sentinel, { mode: 0o755 });
  const pwsh = path.join(tree, "pwsh.exe"), node = path.join(tree, "node.exe"), driver = path.join(tree, "driver.mjs"), launchScript = path.join(tree, "launch.ps1"),
    providerReceipt = path.join(tree, "provider.json");
  // POSIX process fixture proves executable/environment selection. Real pwsh
  // profile semantics and Windows process creation remain mandatory CI proof.
  fs.writeFileSync(pwsh, `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(observed)},JSON.stringify({
    argv:process.argv.slice(2),PATH:process.env.PATH,PSModulePath:process.env.PSModulePath,NODE_OPTIONS:process.env.NODE_OPTIONS,
    secretPresent:!!process.env.AZURE_CLIENT_SECRET,home:process.env.HOME,commandFile:process.env.GITHUB_PATH}));\n`, { mode: 0o755 });
  for (const file of [node, driver, launchScript, providerReceipt]) fs.writeFileSync(file, "fixture pinned input");
  fs.writeFileSync(providerReceipt, "{}");
  fs.writeFileSync(launchScript, windowsSigningLaunchScript(node, driver));
  const files = fs.readdirSync(tree).map(name => ({ path: path.join(tree, name), sha256: peSha256(fs.readFileSync(path.join(tree, name))) }));
  const executables = Object.fromEntries([["pwsh", pwsh], ["node", node]].map(([name, file]) => [name, {
    source: "trusted-configuration", path: file, sha256: peSha256(fs.readFileSync(file)), signer: "Fixture Vendor",
  }]));
  const contract = { executables, schema: 1, roots: [tree], files, pwsh, node, driver, launchScript, providerReceipt, path: [tree], modulePath: [tree], environment: {} };
  const contractFile = path.join(root, "launch.json"); fs.writeFileSync(contractFile, JSON.stringify(contract));
  const expected = peSha256(fs.readFileSync(contractFile));
  const measureExecutable = vi.fn(async () => ({ status: "Valid", embedded: true, publisher: "Fixture Vendor", userWritable: false }));
  return { root, tree, poison, marker, observed, contract, contractFile, expected, measureExecutable };
}
it("uses only hash-pinned absolute binaries and fresh frozen environment before releasing a fake secret", async () => {
  const f = launchFixture(), boundary = { assertIsolatedAndSealed: vi.fn(async () => {}) };
  const measure = f.measureExecutable.getMockImplementation();
  f.measureExecutable.mockImplementation(async (...args) => {
    expect(boundary.assertIsolatedAndSealed).toHaveBeenCalledOnce(); return measure(...args);
  });
  vi.stubEnv("PATH", f.poison); vi.stubEnv("GITHUB_PATH", f.poison); vi.stubEnv("HOME", f.poison);
  vi.stubEnv("NODE_OPTIONS", `--require=${path.join(f.poison, "preload.cjs")}`); vi.stubEnv("PSModulePath", f.poison);
  const run = vi.fn(promisify(execFile));
  // MAIN RULING 1115-WINSAC-F: only the service gets fake credentials; bootstrap gets an exit/receipt pair.
  const releaseCredentials = vi.fn(async () => {
    expect(boundary.assertIsolatedAndSealed).toHaveBeenCalledOnce();
    await run(f.contract.pwsh, ["-NoProfile", "-NonInteractive", "-File", f.contract.launchScript], {
      shell: false, cwd: f.tree, env: { PATH: f.tree, PSModulePath: f.tree, NODE_OPTIONS: "",
        AZURE_TENANT_ID: "fixture-tenant", AZURE_CLIENT_ID: "fixture-client", AZURE_CLIENT_SECRET: "fixture-secret" },
    });
    return { exitCode: 0, receiptSha256: peSha256("fixture receipt") };
  });
  boundary.release = releaseCredentials;
  const result = await launchWindowsSigningDriver({ ...f, boundary });
  expect(result).toEqual({ exitCode: 0, receiptSha256: peSha256("fixture receipt") });
  expect(run.mock.calls[0][0]).toBe(f.contract.pwsh);
  expect(run.mock.calls[0][2].shell).toBe(false);
  expect(run.mock.calls[0][2].cwd).toBe(f.tree);
  const observed = JSON.parse(fs.readFileSync(f.observed));
  expect(observed).toEqual({ argv: ["-NoProfile", "-NonInteractive", "-File", f.contract.launchScript],
    PATH: f.tree, PSModulePath: f.tree, NODE_OPTIONS: "", secretPresent: true });
  expect(fs.existsSync(f.marker)).toBe(false); expect(releaseCredentials).toHaveBeenCalledOnce();
});
it.each(["pwsh", "node", "driver", "launchScript", "providerReceipt"])("changed %s fails before secret injection or execution", async field => {
  const f = launchFixture(); fs.appendFileSync(f.contract[field], "changed");
  const releaseCredentials = vi.fn(), run = vi.fn(), boundary = { assertIsolatedAndSealed: vi.fn(), release: releaseCredentials };
  await expect(launchWindowsSigningDriver({ ...f, boundary, releaseCredentials, run })).rejects.toThrow("WINDOWS_SIGNING_LAUNCH_REJECTED");
  expect(releaseCredentials).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled(); expect(boundary.assertIsolatedAndSealed).not.toHaveBeenCalled();
});
it("rejects extra dependency code and linked files before secret injection", async () => {
  for (const mode of ["extra", "link"]) {
    const f = launchFixture();
    if (mode === "extra") fs.writeFileSync(path.join(f.tree, "extra.dll"), "poison");
    else { fs.unlinkSync(f.contract.node); fs.symlinkSync(path.join(f.poison, "node"), f.contract.node); }
    await expect(verifyWindowsSigningLaunch(f.contractFile, f.expected, f)).rejects.toThrow("WINDOWS_SIGNING_LAUNCH_REJECTED");
  }
});
it("rejects missing runner isolation/sealing and changed bytes during sealing without releasing credentials", async () => {
  const f = launchFixture(), releaseCredentials = vi.fn(), run = vi.fn();
  await expect(launchWindowsSigningDriver({ ...f, releaseCredentials, run })).rejects.toThrow();
  const boundary = { assertIsolatedAndSealed: async () => fs.appendFileSync(f.contract.node, "changed"), release: releaseCredentials };
  await expect(launchWindowsSigningDriver({ ...f, boundary, releaseCredentials, run })).rejects.toThrow();
  expect(releaseCredentials).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
});
it("does not expose child diagnostics containing fake credentials", async () => {
  // MAIN RULING 1115-WINSAC-F: the broker suppresses child diagnostics and returns no credentials.
  const f = launchFixture(), boundary = { assertIsolatedAndSealed: async () => {}, release: async () => { throw Error("fixture-secret"); } };
  await expect(launchWindowsSigningDriver({ ...f, boundary })).rejects.toThrow(/^WINDOWS_SIGNING_DRIVER_FAILED$/);
});
it("refuses a bootstrap that already received credentials before launch verification", async () => {
  const f = launchFixture(), releaseCredentials = vi.fn(), run = vi.fn(); vi.stubEnv("AZURE_CLIENT_SECRET", "fixture-secret");
  await expect(launchWindowsSigningDriver({ ...f, boundary: { assertIsolatedAndSealed: async () => {}, release: releaseCredentials }, run })).rejects.toThrow("WINDOWS_SIGNING_LAUNCH_REJECTED");
  expect(releaseCredentials).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
});
it("rejects a re-pinned launch script that resolves node through ambient PATH", async () => {
  const f = launchFixture(); fs.writeFileSync(f.contract.launchScript, "node driver.mjs\n");
  f.contract.files.find(row => row.path === f.contract.launchScript).sha256 = peSha256(fs.readFileSync(f.contract.launchScript));
  fs.writeFileSync(f.contractFile, JSON.stringify(f.contract));
  await expect(verifyWindowsSigningLaunch(f.contractFile, peSha256(fs.readFileSync(f.contractFile)), f)).rejects.toThrow("WINDOWS_SIGNING_LAUNCH_REJECTED");
});
it("signing child ignores poison PATH/NODE_OPTIONS/profiles and rejects provider/runtime substitution with zero executions", async () => {
  const f = launchFixture(), entry = path.join(f.tree, "invoke.ps1"); fs.writeFileSync(entry, "fixture provider entry");
  fs.writeFileSync(f.contract.providerReceipt, JSON.stringify({ actionRef: WINDOWS_SIGNING_PROVIDER.action, entry,
    localAppData: f.tree, defaults: {}, files: [{ path: entry, sha256: peSha256(fs.readFileSync(entry)) }] }));
  f.contract.files = fs.readdirSync(f.tree).map(name => ({ path: path.join(f.tree, name), sha256: peSha256(fs.readFileSync(path.join(f.tree, name))) }));
  fs.writeFileSync(f.contractFile, JSON.stringify(f.contract)); const expected = peSha256(fs.readFileSync(f.contractFile));
  const env = { PATH: f.poison, NODE_OPTIONS: `--require=${path.join(f.poison, "preload.cjs")}`, PSModulePath: f.poison,
    HOME: f.poison, GITHUB_PATH: f.poison, INPUT_TRACE: "true", GITHUB_TOKEN: "fixture-token", AZURE_CLIENT_SECRET: "fixture-secret" };
  const run = vi.fn(promisify(execFile));
  const sign = azureWindowsPeSigner({ publisherName: "Ferrox Labs, LLC", endpoint: "https://signing.example.invalid",
    codeSigningAccountName: "fixture", certificateProfileName: "fixture" },
  { platform: "win32", env, run, measureExecutable: f.measureExecutable, launchContract: { file: f.contractFile, sha256: expected } });
  await expect(sign("one-file.exe")).resolves.toBe(true);
  expect(run.mock.calls[0][0]).toBe(f.contract.pwsh); expect(run.mock.calls[0][2].shell).toBe(false);
  expect(run.mock.calls[0][2].cwd).toBe(f.tree);
  expect(JSON.parse(fs.readFileSync(f.observed))).toEqual({ argv: ["-NoProfile", "-NonInteractive", "-File", entry],
    PATH: f.tree, PSModulePath: f.tree, NODE_OPTIONS: "", secretPresent: true });
  expect(fs.existsSync(f.marker)).toBe(false); run.mockClear();
  fs.appendFileSync(f.contract.node, "changed runtime");
  await expect(sign("one-file.exe")).rejects.toThrow("WINDOWS_SIGNING_LAUNCH_REJECTED"); expect(run).not.toHaveBeenCalled();
});

it.each([
  { AZURE_CLIENT_SECRET: "fixture-secret" },
  { exitCode: 0, receiptSha256: peSha256("fixture receipt"), AZURE_TENANT_ID: "fixture-tenant" },
  { exitCode: 1, receiptSha256: peSha256("fixture receipt") },
  { exitCode: 0, receiptSha256: "" },
])("rejects broker credential leakage or incomplete completion %j", async result => {
  const f = launchFixture(), boundary = { assertIsolatedAndSealed: async () => {}, release: async () => result };
  await expect(launchWindowsSigningDriver({ ...f, boundary })).rejects.toThrow("WINDOWS_SIGNING_DRIVER_FAILED");
});

export function runLaunchFixture() {
  const f = launchFixture(), runRoot = path.join(f.root, "source"); fs.mkdirSync(runRoot);
  const configFile = path.join(runRoot, "builder.json"); fs.writeFileSync(configFile, "{}");
  const packageFile = path.join(runRoot, "package.json"), packageBytes = JSON.stringify({ version: "1.0.19" });
  fs.writeFileSync(packageFile, packageBytes);
  f.contract.schema = 2; f.contract.runRoot = runRoot;
  f.contract.driverSettings = { producerModule: f.contract.driver, environment: { MURAGE_STATIC: "fixture" } };
  fs.writeFileSync(f.contractFile, JSON.stringify(f.contract)); f.expected = peSha256(fs.readFileSync(f.contractFile));
  // The authority verifier's cryptographic controls have their own generated-key tests.
  const lock = { launchSha256: f.expected, executables: f.contract.executables, trees: [{ root: f.tree,
    files: f.contract.files.map(row => ({ relativePath: path.relative(f.tree, row.path), sha256: row.sha256 })) }] };
  const run = { sourceRevision: "a".repeat(40), version: "1.0.19", planSha256: peSha256("plan"), runId: "10", runAttempt: "2",
    files: [{ path: "builder.json", size: 2, sha256: peSha256("{}") }, { path: "package.json", size: Buffer.byteLength(packageBytes), sha256: peSha256(packageBytes) }],
    settings: { projectDir: runRoot, configFile, environment: { MURAGE_BUILD_COMMIT: "a".repeat(40), MURAGE_WINDOWS_BUILD_PLAN_SHA256: peSha256("plan") } } };
  const config = { launchFile: f.contractFile }, readRunContext = async () => ({ lock, run, config });
  return { ...f, lock, run, config, readRunContext, runRoot, configFile };
}
it("schema 2 separates authenticated run data from static executable authority", async () => {
  const f = runLaunchFixture();
  const result = await verifyWindowsSigningLaunch(f.contractFile, f.expected, f);
  expect(result.driverSettings).toEqual({ ...f.contract.driverSettings, ...f.run.settings,
    runId: "10", runAttempt: "2", environment: { MURAGE_STATIC: "fixture", ...f.run.settings.environment } });
  expect(result.executables).toEqual(f.contract.executables);
});
export const runLaunchViolations = [
  ["lock launch pin", f => { f.lock.launchSha256 = peSha256("different"); }],
  ["1.0.19 tree relabeled 1.0.20", f => { f.run.version = "1.0.20"; }],
  ["1.0.20 tree relabeled 1.0.19", f => {
    const bytes = JSON.stringify({ version: "1.0.20" });
    fs.writeFileSync(path.join(f.runRoot, "package.json"), bytes);
    Object.assign(f.run.files.find(row => row.path === "package.json"), { size: Buffer.byteLength(bytes), sha256: peSha256(bytes) });
  }],
  ["launch location", f => { f.config.launchFile = path.join(f.root, "other.json"); }],
  ["source revision", f => { f.run.settings.environment.MURAGE_BUILD_COMMIT = "b".repeat(40); }],
  ["plan digest", f => { f.run.settings.environment.MURAGE_WINDOWS_BUILD_PLAN_SHA256 = peSha256("different"); }],
  ["wrong project", f => { f.run.settings.projectDir = f.root; }],
  ["config outside root", f => { f.run.settings.configFile = path.join(f.root, "other.json"); }],
  ["run byte replacement", f => { fs.appendFileSync(f.configFile, " "); }],
  ["run size", f => { f.run.files[0].size = 10; }],
  ["run digest", f => { f.run.files[0].sha256 = peSha256("other"); }],
  ["unlisted run file", f => { fs.writeFileSync(path.join(f.runRoot, "extra.json"), "{}"); }],
  ["linked run file", f => { fs.unlinkSync(f.configFile); fs.symlinkSync(f.contract.providerReceipt, f.configFile); }],
  ["executable selector", f => { f.lock.executables = { ...f.lock.executables, pwsh: { ...f.lock.executables.pwsh, signer: "Different Vendor" } }; }],
  ["missing enrolled tree file", f => { f.lock.trees[0].files.push({ relativePath: "absent.dll", sha256: peSha256("absent") }); }],
];
it.each(runLaunchViolations)("schema 2 refuses %s before native execution", async (_name, mutate) => {
  const f = runLaunchFixture(); mutate(f);
  await expect(verifyWindowsSigningLaunch(f.contractFile, f.expected, f)).rejects.toThrow("WINDOWS_SIGNING_LAUNCH_REJECTED");
  expect(f.measureExecutable).not.toHaveBeenCalled();
});
