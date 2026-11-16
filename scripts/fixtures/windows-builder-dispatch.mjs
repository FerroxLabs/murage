// Fixture owner: win-sac-sign; real Windows resource/NSIS/ZIP qualification consumer: MAIN.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { windowsBuilderSigning, preflightWindowsPackage, signWindowsPackageSource } from "../windows-builder-signing.mjs";
import { beginWindowsSigningSession } from "../windows-signing-session.mjs";
import { validateWindowsSigningConfig, WINDOWS_CUSTOM_SIGNER } from "../windows-signing-config.mjs";
import { fixturePeSource, fixturePeTrust, fixtureRevision } from "./windows-pe-provenance.mjs";
import { unsignedPeFixture, appendPeFixtureCertificate } from "./windows-pe-signing.mjs";
const require = createRequire(import.meta.url), builder = createRequire(require.resolve("electron-builder/package.json")), library = createRequire(builder.resolve("app-builder-lib/package.json"));
const { WinPackager } = library("./out/index.js");
const azure = library("./out/codeSign/windowsSignAzureManager.js"), tool = library("./out/codeSign/windowsSignToolManager.js");
let azureCalls = 0, stockCalls = 0;
azure.WindowsSignAzureManager = class { constructor() { azureCalls++; throw Error("AZURE_MANAGER_SENTINEL"); } };
tool.WindowsSignToolManager.prototype.doSign = () => { stockCalls++; throw Error("STOCK_SIGNER_SENTINEL"); };
process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false"; process.env.CSC_LINK = ""; process.env.WIN_CSC_LINK = "";
const root = process.argv[2], app = path.join(root, "app"), artifactDir = path.join(root, "artifacts");
fs.mkdirSync(path.join(app, "resources"), { recursive: true }); fs.mkdirSync(artifactDir);
const raw = unsignedPeFixture(), vendor = appendPeFixtureCertificate(raw), sources = [];
for (const [name, component, bytes] of [["Murage.exe", "murage-app", raw], ["resources/engine-exclusion.node", "engine-exclusion", raw],
  ["resources/vendor.dll", undefined, vendor], ["artifacts/installer.exe", "installer", raw], ["artifacts/uninstaller.exe", "uninstaller", raw]]) {
  fs.writeFileSync(name.startsWith("artifacts/") ? path.join(root, name) : path.join(app, name), bytes);
  sources.push(fixturePeSource(name, bytes, component ? { kind: "build", component, sourceRevision: fixtureRevision,
    inputs: [{ component: "source", sha256: "b".repeat(64) }], transformations: ["fixture compilation"] } : {}));
}
const config = { forceCodeSigning: true, extraMetadata: {}, win: { signtoolOptions: { sign: path.resolve(WINDOWS_CUSTOM_SIGNER),
  publisherName: "Ferrox Labs, LLC", signingHashAlgorithms: ["sha256"] } } };
validateWindowsSigningConfig(config);
class FixtureWinPackager extends WinPackager {
  prepareAppInfo() { return { type: "module", productName: "Murage", computePackageUrl: async () => "https://example.invalid" }; }
}
const packager = new FixtureWinPackager({ config, projectDir: process.cwd(), getWorkspaceRoot: async () => process.cwd() });
const providerCalls = [];
const sign = async file => { providerCalls.push(file); fs.writeFileSync(file, appendPeFixtureCertificate(fs.readFileSync(file))); return true; };
const end = beginWindowsSigningSession({ sign });
try {
  const state = await windowsBuilderSigning({ packager, appOutDir: app, arch: "x64", windowsPeSources: sources,
    windowsPeSourceRevision: fixtureRevision, signingTrust: fixturePeTrust });
  await preflightWindowsPackage(state);
  for (const pin of state.sources.filter(pin => pin.path !== "Murage.exe")) await signWindowsPackageSource(state, pin);
  assert.deepEqual(await (await packager.signingManager.value).computedPublisherName.value, ["Ferrox Labs, LLC"]);
  await packager.signIf(path.join(app, "Murage.exe"));
  await packager.signIf(path.join(artifactDir, "uninstaller.exe")); fs.unlinkSync(path.join(artifactDir, "uninstaller.exe"));
  await packager.signIf(path.join(artifactDir, "installer.exe"));
  assert.deepEqual(state.artifactRecords.map(row => row.path).sort(), ["artifacts/installer.exe", "artifacts/uninstaller.exe"]);
  assert.equal(providerCalls.length, 4); assert.equal(azureCalls, 0); assert.equal(stockCalls, 0);
  assert.deepEqual(fs.readFileSync(path.join(app, "resources/vendor.dll")), vendor);
} finally { end(); }
