// Production-driver/config witness owner: win-sac-sign; native enrollment and real Windows build witness owner: MAIN.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WINDOWS_BUILDER_HOOKS, WINDOWS_CUSTOM_SIGNER } from "../windows-signing-config.mjs";
import { windowsSigningGraph } from "../windows-signing-session.mjs";
import { completeDriverFixture } from "./windows-driver-complete.mjs";
import { peSha256 } from "../windows-pe-signing.mjs";

const [root, mode = "valid"] = process.argv.slice(2), projectDir = path.join(root, "inputs");
fs.mkdirSync(projectDir, { recursive: true });
const require = createRequire(import.meta.url), builder = createRequire(require.resolve("electron-builder/package.json"));
const library = createRequire(builder.resolve("app-builder-lib/package.json"));
const packagerPath = library.resolve("./out/packager.js"), corePath = library.resolve("./out/core.js");
const configFile = path.join(projectDir, "builder.json"), marker = path.join(root, "config-executed");
const driver = fileURLToPath(new URL("../windows-signing-driver.mjs", import.meta.url));
const producerModule = fileURLToPath(new URL("../windows-build-producers.mjs", import.meta.url));
const callback = fileURLToPath(new URL(WINDOWS_CUSTOM_SIGNER.replace("./scripts/", "../"), import.meta.url));
const sentinel = path.join(projectDir, "electron-builder.cjs");
fs.writeFileSync(sentinel, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); module.exports = JSON.parse(require('node:fs').readFileSync(${JSON.stringify(configFile)}));`);
const config = { extends: null, publish: null, npmRebuild: false, nodeGypRebuild: false, buildDependenciesFromSource: false,
  ...WINDOWS_BUILDER_HOOKS, appId: "test.fixture", productName: "Murage", electronVersion: "43.8.1", forceCodeSigning: true,
  directories: { output: path.join(root, "output") },
  win: { signtoolOptions: { sign: callback, publisherName: "Ferrox Labs, LLC", signingHashAlgorithms: ["sha256"] } } };
if (mode === "extends") config.extends = sentinel;
if (mode === "hook") config.afterPack = sentinel;
if (["projection","complete"].includes(mode)) config.extraMetadata = { murageGepaManifests: { "win32-x64": "c".repeat(64) } };
fs.writeFileSync(configFile, JSON.stringify(config));
fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ name: "fixture", description: "Fixture", version: "1.0.19", author: "Fixture", main: "index.js" }));
const launchFile = path.join(root, "launch.json"), launchDigest = peSha256("fixture launch");
const environment = { MURAGE_BUILD_COMMIT: "a".repeat(40) };
const launch = { schema: 2, node: process.execPath, driver, runRoot: projectDir, files: [producerModule, callback, ...Object.values(WINDOWS_BUILDER_HOOKS)].map(file => ({ path: file })),
  runAuthorization: { files: [{ path: "builder.json", sha256: peSha256(fs.readFileSync(configFile)) }] }, environment: {},
  driverSettings: { projectDir, configFile, producerModule, environment, runId: "1", runAttempt: "1" } };
const counts = { graphRegistrations: 0, graphConsumers: 0, buildRuns: 0, builderLoads: 0, providerRuns: 0, credentialLeaks: 0, validations: 0, configPath: null, finalized: 0 };
globalThis.signingConfigWitness = counts;
registerHooks({ load(url, context, nextLoad) {
  const file = url.startsWith("file:") ? fileURLToPath(url) : "";
  const module = source => ({ format: "module", source, shortCircuit: true });
  if (file.endsWith("/windows-signing-launch.mjs")) return module(`export async function verifyWindowsSigningLaunch() { return globalThis.configWitnessLaunch; }`);
  if (!["graph","complete"].includes(mode) && file.endsWith("/windows-signing-receipt.mjs")) return module(`export async function windowsSigningDriverReceipt() {
    return { async package(_scope, operation) { return operation(); }, async freeze(_scope, operation) { return operation(); }, assertComplete() {} };
  }`);
  if (mode === "complete" && file.endsWith("/windows-build-adapters.mjs")) return module(`export async function windowsBuildAdapters() { return globalThis.completeDriver.adapters; }`);
  if (mode === "complete" && file.endsWith("/windows-gepa-signing.mjs")) return module(`export default async function sign(context) { return globalThis.completeDriver.gepa(context); }`);
  if (mode === "projection" && file.endsWith("/windows-build-adapters.mjs")) return module(`export async function windowsBuildAdapters() { return { install() { return () => {}; }, async prepareTransientResources() {} }; }`);
  if (mode === "projection" && file.endsWith("/windows-gepa-signing.mjs")) return module(`export default async function sign(context) {
    context.packager.config.extraMetadata.murageGepaManifests['win32-x64'] = 'd'.repeat(64);
    context.packager.config.extraMetadata.murageWindowsPeGepa = { sources: [], records: [] };
    return { directory: context.outDir, sources: [], records: [] };
  }`);
  if (mode === "projection" && file.endsWith("/windows-build-finalize.mjs")) return module(`export async function finalizeWindowsBuild() { globalThis.signingConfigWitness.finalized++; }`);
  if (["projection","complete"].includes(mode) && file === library.resolve("./out/winPackager.js")) return { format: "commonjs", shortCircuit: true, source: `exports.WinPackager = class {
    constructor(info) { globalThis.signingConfigWitness.preparedMetadata = info.config.extraMetadata.murageGepaManifests['win32-x64'];
      globalThis.signingConfigWitness.rootMetadata = info.metadata.murageGepaManifests['win32-x64']; }
  };` };
  if (file.endsWith("/windows-stage-receipts.mjs")) return module(`export async function readWindowsBuildPlan() { return globalThis.configWitnessPlan ?? { outputs: [] }; } export function windowsStageReceiptConsumer(_plan, _producers, graph) {
    if (globalThis.configWitnessGraphMode) {
      if (graph && graph === globalThis.configWitnessGraph) globalThis.signingConfigWitness.graphConsumers++;
    }
    return { assertComplete() {} };
  }`);
  if (file.endsWith("/windows-build-producers.mjs")) return module(`export function windowsPreparedProducerFiles() { return []; } export async function registerWindowsBuildProducers(_plan, options) {
    if (globalThis.configWitnessGraphMode) {
      globalThis.configWitnessGraph = options.session;
      if (typeof options.session?.producer === 'function') globalThis.signingConfigWitness.graphRegistrations++;
    }
    return new Map();
  }`);
  if (file.endsWith("/windows-signing-trust.mjs")) return module(`export async function windowsSigningTrust() { return globalThis.completeDriver?.trust ?? {}; }`);
  if (file.endsWith("/windows-azure-signer.mjs")) return module(`export function azureWindowsPeSigner() { return globalThis.completeDriver?.sign ?? (async () => { globalThis.signingConfigWitness.providerRuns++; throw Error('UNEXPECTED_SIGN'); }); }`);
  if (file === library.resolve("./out/index.js")) {
    if (globalThis.configWitnessGraphMode && windowsSigningGraph() !== globalThis.configWitnessGraph) throw Error("GRAPH_SESSION_REQUIRED");
    counts.builderLoads++;
    if (Object.keys(process.env).some(key => /^AZURE_/i.test(key))) counts.credentialLeaks++;
    return { format: "commonjs", shortCircuit: true, source: `
      exports.Packager = require(${JSON.stringify(packagerPath)}).Packager;
      exports.Platform = require(${JSON.stringify(corePath)}).Platform;
      exports.build = async (options, packager) => {
        globalThis.signingConfigWitness.buildRuns++;
        globalThis.signingConfigWitness.configPath = options.config;
        await packager.validateConfig(); globalThis.signingConfigWitness.validations++;
        if (${["projection","complete"].includes(mode)}) options.platformPackagerFactory(packager, exports.Platform.WINDOWS);
        if (${mode === "complete"}) return globalThis.completeDriver.build();
      };` };
  }
  return nextLoad(url, context);
} });
if (["graph","complete"].includes(mode)) {
  const identity = { repositoryId: "1", workflowSha: "b".repeat(40), sourceRevision: environment.MURAGE_BUILD_COMMIT,
    version: "1.0.19", target: "win32-x64", runId: "1", runAttempt: "1" };
  const coverage = { schema: 1, identity, files: [
    { scope: "gepa", path: "resources/gepa-worker/gepa-worker.exe", producerRequired: false },
    { scope: "app", path: "Murage.exe", producerRequired: true },
    { scope: "uninstaller", path: "artifacts/Uninstall Murage.exe", producerRequired: true },
    { scope: "transient", path: "artifacts/helper.exe", producerRequired: false },
    { scope: "installer", path: "artifacts/Murage-1.0.19-setup.exe", producerRequired: true } ] };
  const file = path.join(projectDir, "signing-coverage.json"); fs.writeFileSync(file, JSON.stringify(coverage));
  Object.assign(launch.runAuthorization, identity, { launchSha256: launchDigest, planSha256: "c".repeat(64),
    sha256: "d".repeat(64), artifactId: "2", outerSha256: "e".repeat(64) });
  launch.runAuthorization.files.push({ path: "signing-coverage.json", sha256: peSha256(fs.readFileSync(file)) });
  launch.providerReceiptSha256 = "f".repeat(64);
  launch.signingAuthority = { enrolled: true, executables: { checker: { sha256: "a".repeat(64) } },
    trees: [{ component: "builder", files: [{ relativePath: "builder.js", sha256: "b".repeat(64) }] }] };
  globalThis.configWitnessCoverage = coverage.files;
  globalThis.configWitnessPlan = { ...identity, sha256: "c".repeat(64), outputs: [] };
  globalThis.configWitnessGraphMode = true;
}
if (mode === "complete") { environment.MURAGE_WINDOWS_DRIVER_RECEIPT = path.join(root,"driver-receipt.json"); globalThis.completeDriver = completeDriverFixture(root,launch); }
globalThis.configWitnessLaunch = launch;
Object.assign(process.env, { AZURE_TENANT_ID: "fixture-tenant", AZURE_CLIENT_ID: "fixture-client", AZURE_CLIENT_SECRET: "fixture-secret",
  MURAGE_WINDOWS_SIGNING_LAUNCH: launchFile, MURAGE_WINDOWS_SIGNING_LAUNCH_SHA256: launchDigest });
const { runWindowsSigningDriver } = await import(pathToFileURL(driver).href);
if (["valid","projection","complete"].includes(mode)) {
  await runWindowsSigningDriver();
  assert.equal(fs.existsSync(marker), false);
  assert.equal(counts.configPath, configFile); assert.equal(counts.validations, 1);
  if (mode === "projection") { assert.equal(counts.preparedMetadata, "d".repeat(64)); assert.equal(counts.rootMetadata, "d".repeat(64)); assert.equal(counts.finalized, 1); }
} else if (mode === "graph") {
  let failure;
  try { await runWindowsSigningDriver(); } catch (error) { failure = error; }
  assert.equal(counts.buildRuns, 0, JSON.stringify(counts));
  assert.match(failure?.message ?? "", /WINDOWS_SIGNING_RECEIPT_REJECTED/); assert.equal(counts.graphRegistrations, 1); assert.equal(counts.graphConsumers, 1);
} else {
  await assert.rejects(runWindowsSigningDriver(), /WINDOWS_SIGNING_BUILDER_CONFIG_REJECTED/);
  assert.equal(counts.builderLoads, 0);
}
assert.equal(fs.existsSync(marker), false);
assert.equal(counts.providerRuns, mode === "complete" ? 4 : 0); assert.equal(counts.credentialLeaks, 0);
process.stdout.write(JSON.stringify(counts) + "\n");
