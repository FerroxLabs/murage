// Validator/tests owner: win-sac-sign; production evidence, extractor and trusted pins owner: MAIN.
import fs from "node:fs";
import { sign } from "node:crypto";
import * as extractionGate from "./windows-sac-stage-gate.mjs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../server/testing/cleanup.ts";
import { unsignedPeFixture, appendPeFixtureCertificate } from "./fixtures/windows-pe-signing.mjs";
import { fixturePeSource } from "./fixtures/windows-pe-provenance.mjs";
import { peSha256, windowsPeSourcePinId } from "./windows-pe-signing.mjs";
import { windowsSigningReceipt } from "./windows-signing-receipt.mjs";
import { verifyWindowsSacPromotion } from "./windows-sac-promotion.mjs";
import { windowsExtractionFixture, windowsExtractionFixtureHelper } from "./fixtures/windows-extraction.mjs";
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sac-promotion-")); roots.push(root);
  const assetsDir = path.join(root, "assets"), proofDir = path.join(root, "release-sac"); fs.mkdirSync(assetsDir); fs.mkdirSync(proofDir);
  const bytes = appendPeFixtureCertificate(unsignedPeFixture()), files = ["Murage.exe", "resources/engine-exclusion.node", "resources/anchored-read.node",
    "resources/presence-guard.node", "resources/gepa-worker/gepa-worker.exe", "Uninstall Murage.exe"];
  const payload = Object.fromEntries(files.map(file => [file, bytes.toString("base64")]));
  const installer = Buffer.concat([bytes, Buffer.from("\nFIXTURE_PAYLOAD\n" + JSON.stringify(payload))]);
  for (const name of ["Murage-1.0.19-setup.exe", "Murage-setup.exe"]) fs.writeFileSync(path.join(assetsDir, name), installer);
  const identity = { sourceRevision: "a".repeat(40), version: "1.0.19", target: "win32-x64", runId: "123", runAttempt: "1" };
  const candidate = { schema: 1, ...identity, installer: { name: "Murage-1.0.19-setup.exe", sha256: peSha256(installer) },
    files: files.map(file => ({ path: file, sha256: peSha256(bytes) })),
    assets: fs.readdirSync(assetsDir).map(file => ({ path: file, sha256: peSha256(fs.readFileSync(path.join(assetsDir, file))) })) };
  const candidateFile = path.join(proofDir, "candidate.json"); fs.writeFileSync(candidateFile, JSON.stringify(candidate));
  const capture = { file: "capture.json", sha256: peSha256("fixture capture") }; fs.writeFileSync(path.join(proofDir, capture.file), "fixture capture");
  const candidateSha256 = peSha256(fs.readFileSync(candidateFile));
  const evidence = { schema: 1, ...identity, candidateSha256, installer: candidate.installer, files: candidate.files,
    windows: { major: 11, build: 26100 }, sac: { before: "ENFORCING", after: "ENFORCING", throughout: true, policyExport: capture },
    tokens: ["install", "app", "engine", "addon"].map(process => ({ process, userType: "standard", administratorMember: false,
      elevated: false, elevationType: "Default", integrityLevel: "Medium" })), tokenExport: capture, signatures: capture, inventory: capture,
    payloadPreservation: capture, helperLoads: capture, codeIntegrity: { ...capture, relatedBlocks: 0, intervalCovered: true },
    install: { exitCode: 0 }, launch: { exitCode: 0 }, turn: { kind: "real-engine", id: "fixture-turn", started: true, completed: true, engineExitCode: 0 },
    addon: { path: "resources/engine-exclusion.node", sha256: peSha256(bytes), version: "fixture-version", loaded: true,
      nativeCall: "success", privilegesRemoved: true }, s4: { refusalCode: "EPOWER", engineSpawned: false, jobStarted: false,
      tokenOpen: { api: "OpenProcessToken", requestedAccess: 0x28, succeeded: false,
        process: { pid: 20, creationTime: "200", imageSha256: peSha256(bytes) }, tokenOwner: { pid: 20, creationTime: "200" } },
      successProcess: { pid: 21, creationTime: "201", imageSha256: peSha256(bytes) }, witnessProcess: { pid: 22, creationTime: "202" } }, bypass: false, developerAllowRule: false };
  const evidenceFile = path.join(proofDir, "evidence.json");
  // A local data-only installer fixture and extractor exercise real process and
  // byte boundaries. No Windows execution or real SAC result is claimed here.
  let extractionControl;
  const extractor = windowsExtractionFixture(root, value => { extractionControl = value; });
  const options = { assetsDir, candidateFile, candidateSha256, evidenceFile, extractor,
    identity, workDir: path.join(root, "scratch") };
  const save = () => { fs.writeFileSync(evidenceFile, JSON.stringify(evidence)); options.evidenceSha256 = peSha256(fs.readFileSync(evidenceFile)); };
  save(); const f = { root, options, candidate, evidence, payload, save, extractionControl };
  await promotionReceipt(f); return f;
}
it("accepts only authenticated enforcing-SAC standard-user proof for the actual installer and exact extracted PE set", async () => {
  const f = await fixture(), result = await verifyWindowsSacPromotion(f.options);
  expect(result.evidenceSha256).toBe(f.options.evidenceSha256); expect(result.files).toHaveLength(6);
  expect(fs.readdirSync(f.options.workDir)).toEqual([]);
});
const mutations = [
  ["unapproved release version", f => { f.options.identity.version = "1.0.20"; }],
  ["omitted", f => { fs.unlinkSync(f.options.evidenceFile); }],
  ["Evaluation", f => { f.evidence.sac.before = "Evaluation"; f.save(); }],
  ["OFF after launch", f => { f.evidence.sac.after = "OFF"; f.save(); }],
  ["admin", f => { f.evidence.tokens[0].administratorMember = true; f.save(); }],
  ["filtered administrator", f => { f.evidence.tokens[1].elevationType = "Limited"; f.save(); }],
  ["elevated", f => { f.evidence.tokens[2].elevated = true; f.save(); }],
  ["missing token", f => { f.evidence.tokens.pop(); f.save(); }],
  ["wrong installer hash", f => { fs.appendFileSync(path.join(f.options.assetsDir, f.candidate.installer.name), " "); }],
  ["wrong PE hash", f => { f.evidence.files[0].sha256 = "0".repeat(64); f.save(); }],
  ["missing PE", f => { f.evidence.files.pop(); f.save(); }],
  ["mocked turn", f => { f.evidence.turn.kind = "mocked"; f.save(); }],
  ["addon call failed", f => { f.evidence.addon.nativeCall = "failed"; f.save(); }],
  ["related enforcement event", f => { f.evidence.codeIntegrity.relatedBlocks = 1; f.save(); }],
  ["wrong revision", f => { f.evidence.sourceRevision = "b".repeat(40); f.save(); }],
  ["stale attempt", f => { f.evidence.runAttempt = "2"; f.save(); }],
  ["S4 spawned an engine", f => { f.evidence.s4.engineSpawned = true; f.save(); }],
  ["S4 did not refuse", f => { f.evidence.s4.refusalCode = "OK"; f.save(); }],
  ["S4 missing native seam", f => { delete f.evidence.s4.tokenOpen; f.save(); }],
  ["S4 side token", f => { f.evidence.s4.tokenOpen.tokenOwner.pid = 23; f.save(); }],
  ["S4 reused success process", f => { f.evidence.s4.successProcess = f.evidence.s4.tokenOpen.process; f.save(); }],
  ["S4 witness logon token", f => { f.evidence.s4.witnessProcess = f.evidence.s4.tokenOpen.process; f.save(); }],
  ["S4 wrong access", f => { f.evidence.s4.tokenOpen.requestedAccess = 8; f.save(); }],
  ["S4 native open succeeded", f => { f.evidence.s4.tokenOpen.succeeded = true; f.save(); }],
  ["S4 created a job", f => { f.evidence.s4.jobStarted = true; f.save(); }],
  ["S4 missing creation time", f => { delete f.evidence.s4.tokenOpen.process.creationTime; f.save(); }],
  ["S4 numeric creation time", f => { f.evidence.s4.tokenOpen.process.creationTime = 200; f.save(); }],
  ["S4 foreign failure image", f => { f.evidence.s4.tokenOpen.process.imageSha256 = "a".repeat(64); f.save(); }],
  ["S4 foreign success image", f => { f.evidence.s4.successProcess.imageSha256 = "a".repeat(64); f.save(); }],
  ["unauthenticated manifest", f => { f.options.evidenceSha256 = "0".repeat(64); }],
];
it.each(mutations)("rejects %s evidence before extractor or promotion execution", async (_name, mutate) => {
  const f = await fixture(), run = vi.fn(); mutate(f);
  await expect(verifyWindowsSacPromotion(f.options, { run })).rejects.toThrow(); expect(run).not.toHaveBeenCalled();
});
it.each(["change", "extra", "omit-uninstaller"])("rejects an extractor's %s payload independently of authenticated evidence", async mode => {
  const f = await fixture();
  const run = async (command, args, options) => {
    execFileSync(command, args, { ...options, env: { ...options.env, FIXTURE_EXTRACT_MODE: mode } });
  };
  await expect(verifyWindowsSacPromotion(f.options, { run })).rejects.toThrow("WINDOWS_SAC_PROMOTION_PAYLOAD_MISMATCH");
  expect(fs.readdirSync(f.options.workDir)).toEqual([]);
});
// Option A (Sean 2026-11-18T06:42Z): 1.0.19 signs as 1.0.18 shipped; controller-admitted signing + SAC
// qualification are the first post-release item. The release guard therefore no longer drives this
// promotion, and the tests that reached it THROUGH `release-guard.mjs <command>` are retired with their
// mechanism (the module-level tests above and below still hold the promotion itself to its contract).
// What the guard must do instead is asserted here on the real CLI: no command loads the promotion or its
// stage gate, none asks GitHub for a SAC or extraction artifact, and publication stays bound to the exact
// local staged bytes (a draft whose remote digest differs is refused with no PATCH).
function optionAGuard(command, { remoteMismatch = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "option-a-guard-")); roots.push(root);
  const scripts = path.join(root, "scripts"), bin = path.join(root, "bin"), assets = path.join(root, "assets");
  for (const dir of [scripts, bin, assets, path.join(root, "infra/windows-signing/qualsign"), path.join(root, "temp")]) fs.mkdirSync(dir, { recursive: true });
  for (const name of ["release-guard.mjs", "qualsign-release-exclusion.mjs"]) fs.copyFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), path.join(scripts, name));
  fs.copyFileSync(fileURLToPath(new URL("../infra/windows-signing/qualsign/refused-sha256.txt", import.meta.url)), path.join(root, "infra/windows-signing/qualsign/refused-sha256.txt"));
  fs.writeFileSync(path.join(scripts, "signal-release-prerequisites.mjs"), "export function assertSignalReleaseReady() {}\n");
  for (const name of ["windows-sac-promotion.mjs", "windows-sac-stage-gate.mjs"]) fs.writeFileSync(path.join(scripts, name), "throw Error('SAC_PROMOTION_LOADED');\n");
  fs.writeFileSync(path.join(assets, "Murage-1.0.19-x64-setup.exe"), "neutral installer"); fs.writeFileSync(path.join(assets, "latest.yml"), "neutral feed");
  fs.writeFileSync(path.join(root, "temp/release-notes.md"), "neutral notes\n");
  const calls = path.join(root, "calls"), published = path.join(root, "published");
  fs.writeFileSync(path.join(bin, "gh"), `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
if(args[0]==='run')process.exit(2);
if(args[args.indexOf('--method')+1]==='PATCH'){fs.writeFileSync(${JSON.stringify(published)},args.includes('prerelease=true')?'prerelease':'1');console.log('{}');return;}
const assets=fs.readdirSync('assets').map(name=>({name,state:'uploaded',digest:'sha256:'+crypto.createHash('sha256').update(fs.readFileSync(path.join('assets',name))).digest('hex')}));
if(${remoteMismatch}) assets[0].digest='sha256:'+'0'.repeat(64);
console.log('HTTP/2.0 200 OK\\n\\n'+JSON.stringify({id:7,tag_name:'v1.0.19',draft:!fs.existsSync(${JSON.stringify(published)}),prerelease:fs.existsSync(${JSON.stringify(published)})&&fs.readFileSync(${JSON.stringify(published)},'utf8')==='prerelease',immutable:false,assets}));
`, { mode: 0o755 });
  const args = command === "publish" ? ["1.0.19", "7", "assets"] : command === "upload" ? ["1.0.19", "assets", path.join(root, "temp/release-notes.md")] : [];
  const result = spawnSync(process.execPath, [path.join(scripts, "release-guard.mjs"), command, ...args], { cwd: root, encoding: "utf8", timeout: 30_000,
    env: { PATH: bin, VERSION: "1.0.19", RELEASE_ID: "7", GITHUB_REPOSITORY: "fixture/release", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", RUNNER_TEMP: path.join(root, "temp") } });
  const seen = fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  return { result, seen, published: fs.existsSync(published) };
}
it.each(["stage", "upload", "upload-prepared", "publish", "publish-prepared"])("Option A: release guard %s never loads the SAC promotion and never requests SAC or extraction artifacts", command => {
  const { result, seen } = optionAGuard(command);
  expect(result.stderr).not.toContain("SAC_PROMOTION_LOADED");
  expect(result.stderr).not.toMatch(/WINDOWS_SAC_|unknown release guard command/);
  expect(seen.some(args => args[0] === "run" || args.some(arg => /sac|windows-extraction/i.test(arg)))).toBe(false);
  if (command === "stage") { expect(result.status).toBe(0); expect(seen).toEqual([]); }
  else expect(seen.length).toBeGreaterThan(0);
});
it.each(["publish", "publish-prepared"])("Option A: %s publishes exactly the local staged bytes and refuses a draft whose remote digest differs", command => {
  const live = optionAGuard(command);
  expect(live.result.status, live.result.stderr).toBe(0);
  expect(live.published).toBe(true);
  expect(live.seen.filter(args => args.includes("PATCH"))).toHaveLength(1);
  const refused = optionAGuard(command, { remoteMismatch: true });
  expect(refused.result.status).not.toBe(0);
  expect(refused.published).toBe(false);
  expect(refused.seen.filter(args => args.includes("PATCH"))).toEqual([]);
});
const assetChanges = [
  ["unsigned extra DLL", f => fs.writeFileSync(path.join(f.options.assetsDir, "extra.dll"), unsignedPeFixture())],
  ["extra metadata", f => fs.writeFileSync(path.join(f.options.assetsDir, "extra.json"), "{}")],
  ["changed metadata", f => fs.appendFileSync(path.join(f.options.assetsDir, "latest.yml"), "changed")],
  ["missing metadata", f => fs.unlinkSync(path.join(f.options.assetsDir, "latest.yml"))],
  ["nested directory", f => fs.mkdirSync(path.join(f.options.assetsDir, "nested"))],
  ["symlink", f => { const file = path.join(f.options.assetsDir, "latest.yml"); fs.unlinkSync(file); fs.symlinkSync(f.options.candidateFile, file); }],
];
function addMetadata(f) {
  const file = path.join(f.options.assetsDir, "latest.yml"); fs.writeFileSync(file, "fixture feed");
  f.candidate.assets.push({ path: "latest.yml", sha256: peSha256(fs.readFileSync(file)) });
  fs.writeFileSync(f.options.candidateFile, JSON.stringify(f.candidate));
  f.options.candidateSha256 = peSha256(fs.readFileSync(f.options.candidateFile));
  f.evidence.candidateSha256 = f.options.candidateSha256; f.save();
}
it("binds every release asset including metadata in the prepared result", async () => {
  const f = await fixture(); addMetadata(f);
  const prepared = await verifyWindowsSacPromotion(f.options);
  expect(prepared.assets).toEqual([...f.candidate.assets].sort((a, b) => a.path.localeCompare(b.path)));
});
it.each(assetChanges)("rechecks %s introduced while extraction is running", async (_name, mutate) => {
  const f = await fixture(); addMetadata(f);
  const run = async (...args) => { execFileSync(...args); mutate(f); };
  await expect(verifyWindowsSacPromotion(f.options, { run })).rejects.toThrow();
});
it.each(["missing", "duplicate", "nested", "wrong digest"])("rejects %s authenticated asset declarations before extraction", async mode => {
  const f = await fixture();
  if (mode === "missing") delete f.candidate.assets;
  if (mode === "duplicate") f.candidate.assets.push(f.candidate.assets[0]);
  if (mode === "nested") f.candidate.assets[0].path = "nested/asset";
  if (mode === "wrong digest") f.candidate.assets[0].sha256 = "0".repeat(64);
  fs.writeFileSync(f.options.candidateFile, JSON.stringify(f.candidate));
  f.options.candidateSha256 = peSha256(fs.readFileSync(f.options.candidateFile));
  f.evidence.candidateSha256 = f.options.candidateSha256; f.save();
  const run = vi.fn(); await expect(verifyWindowsSacPromotion(f.options, { run })).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
});

// Data-only promotion fixtures exercise receipt authentication and joins. They
// do not claim that this fake installer or its payload has Windows trust.
async function promotionReceipt(f, change = () => {}) {
  const configuration = { identity: { repositoryId: "1", workflowSha: "b".repeat(40), ...f.options.identity },
    authority: Object.fromEntries(["staticLaunchSha256", "runAuthorizationSha256", "inputArtifactDigest", "buildPlanSha256",
      "checkerSha256", "providerReceiptSha256", "builderTreeSha256"].map(key => [key, "c".repeat(64)])) };
  configuration.authority.inputArtifactId = "3";
  const coverage = f.candidate.files.map(row => ({ path: row.path.startsWith("Uninstall ") ? `artifacts/${row.path}` : row.path,
    scope: row.path.startsWith("Uninstall ") ? "uninstaller" : row.path.includes("gepa-worker/") ? "gepa" : "app", producerRequired: true }));
  coverage.push({ scope: "transient", path: "artifacts/helper.exe", producerRequired: true },
    { scope: "installer", path: `artifacts/${f.candidate.installer.name}`, producerRequired: true });
  const configurationData = { configuration, coverage }; change(configurationData);
  const writer = windowsSigningReceipt(configurationData.configuration, configurationData.coverage);
  let uninstallerRecordSha256; const sources = [], records = [];
  const installedUninstaller = f.candidate.files.find(row => /^Uninstall [^/]+\.exe$/.test(row.path));
  const prepare = async scope => {
    const hashes = {};
    for (const row of configurationData.coverage.filter(row => row.scope === scope)) {
      const sha256 = scope === "installer" ? f.candidate.installer.sha256 : scope === "transient" ? peSha256(windowsExtractionFixtureHelper())
        : scope === "uninstaller" ? installedUninstaller.sha256 : f.candidate.files.find(file => file.path === row.path.replace(/^artifacts\//, "")).sha256;
      const bytes = scope === "installer" ? fs.readFileSync(path.join(f.options.assetsDir, f.candidate.installer.name)) : scope === "transient" ? windowsExtractionFixtureHelper()
        : Buffer.from(f.payload[scope === "uninstaller" ? installedUninstaller.path : row.path.replace(/^artifacts\//, "")], "base64");
      const source = fixturePeSource(row.path, bytes), record = { path: row.path, target: source.target, component: source.component, version: source.version,
        sourcePinId: windowsPeSourcePinId(source), sourceSha256: sha256, finalSha256: sha256, disposition: "preserved", nativeVerdictSha256: "e".repeat(64), leafCertificateSha256: "f".repeat(64) };
      sources.push(source); records.push(record);
      await writer.producer(scope, row.path, async () => ({ inputDigests: { tool: "d".repeat(64) }, outputDigests: { [row.path]: sha256 } }));
      const details = await writer.sign(scope, row.path, sha256, async () => record);
      if (scope === "uninstaller") uninstallerRecordSha256 = details.recordSha256;
      hashes[row.path] = sha256;
    }
    await writer.freeze(scope, async () => hashes);
  };
  await prepare("gepa");
  await writer.package("app", async () => { await prepare("app"); await prepare("uninstaller"); await prepare("transient");
    await writer.package("installer", async () => prepare("installer")); });
  await writer.packageComplete(async () => {});
  const receiptFile = path.join(path.dirname(f.options.candidateFile), "driver.json");
  const { sha256 } = await writer.complete(receiptFile, { gepaProjectionSha256: "a".repeat(64), appManifestSha256: "b".repeat(64),
    installerName: f.candidate.installer.name, installerSha256: f.candidate.installer.sha256, uninstallerRecordSha256,
    zipSha256: "c".repeat(64), extractionResultSha256: "d".repeat(64) }, async () => {});
  f.candidate.signing = { file: "driver.json", sha256, ...configurationData };
  const recordsFile = path.join(path.dirname(receiptFile), "records.json");
  fs.writeFileSync(recordsFile, JSON.stringify({schema:2,target:f.options.identity.target,sourceRevision:f.options.identity.sourceRevision,sources,files:records}));
  f.candidate.signing.records = {file:"records.json",sha256:peSha256(fs.readFileSync(recordsFile))};
  const signaturesFile = path.join(path.dirname(receiptFile), "signatures.json");
  fs.writeFileSync(signaturesFile, JSON.stringify({schema:1,files:records.map(row=>({path:row.path,sha256:row.finalSha256,leafCertificateSha256:row.leafCertificateSha256,
    status:"Valid",embedded:true,timestamp:true,publisher:"Ferrox Labs, LLC"}))}));
  f.evidence.signatures = {file:"signatures.json",sha256:peSha256(fs.readFileSync(signaturesFile))};
  f.candidate.uninstaller = { retainedPath: configurationData.coverage.find(row => row.scope === "uninstaller").path,
    installedPath: installedUninstaller.path, sha256: installedUninstaller.sha256 };
  f.candidate.transientFiles = [{ path: "artifacts/helper.exe", sha256: peSha256(windowsExtractionFixtureHelper()) }];
  saveCandidate(f);
}
function saveCandidate(f) {
  fs.writeFileSync(f.options.candidateFile, JSON.stringify(f.candidate));
  f.options.candidateSha256 = peSha256(fs.readFileSync(f.options.candidateFile));
  f.evidence.candidateSha256 = f.options.candidateSha256; f.save();
}
const driverChanges = [
  ["omitted driver receipt", f => { fs.unlinkSync(path.join(path.dirname(f.options.candidateFile), "driver.json")); }],
  ["missing driver authority", f => { delete f.candidate.signing; saveCandidate(f); }],
  ["changed driver bytes", f => { fs.appendFileSync(path.join(path.dirname(f.options.candidateFile), "driver.json"), " "); }],
  ["incomplete driver", f => { changeReceipt(f, receipt => { receipt.complete = false; }); }],
  ["different driver identity", f => { f.candidate.signing.configuration.identity.runAttempt = "2"; saveCandidate(f); }],
  ["different driver coverage", f => { f.candidate.signing.coverage.pop(); saveCandidate(f); }],
  ["authentic other attempt", async f => {
    fs.unlinkSync(path.join(path.dirname(f.options.candidateFile), "driver.json"));
    await promotionReceipt(f, data => { data.configuration.identity.runAttempt = "2"; });
  }],
  ["authentic incomplete coverage", async f => {
    fs.unlinkSync(path.join(path.dirname(f.options.candidateFile), "driver.json"));
    await promotionReceipt(f, data => { data.coverage = data.coverage.filter(row => row.path !== "resources/anchored-read.node"); });
  }],
  ["authentic other installer", async f => {
    fs.unlinkSync(path.join(path.dirname(f.options.candidateFile), "driver.json"));
    const original = f.candidate.installer.sha256; f.candidate.installer.sha256 = "e".repeat(64);
    await promotionReceipt(f); f.candidate.installer.sha256 = original; saveCandidate(f);
  }],
  ["reordered driver events", f => { changeReceipt(f, receipt => { receipt.events.reverse(); }); }],
];
function changeReceipt(f, change) {
  const file = path.join(path.dirname(f.options.candidateFile), "driver.json"), receipt = JSON.parse(fs.readFileSync(file));
  change(receipt); fs.writeFileSync(file, JSON.stringify(receipt));
  f.candidate.signing.sha256 = peSha256(fs.readFileSync(file)); saveCandidate(f);
}
it("binds the authenticated complete driver receipt digest in the prepared result", async () => {
  const f = await fixture(), prepared = await verifyWindowsSacPromotion(f.options);
  expect(prepared.driverReceiptSha256).toBe(f.candidate.signing.sha256);
});
it("rechecks driver receipt bytes after extraction", async () => {
  const f = await fixture();
  const run = (...args) => { execFileSync(...args); fs.appendFileSync(path.join(path.dirname(f.options.candidateFile), "driver.json"), " "); };
  await expect(verifyWindowsSacPromotion(f.options, { run })).rejects.toThrow();
});
it("maps the retained NSIS build filename to the installed uninstaller using the same signed bytes", async () => {
  const f = await fixture(); fs.unlinkSync(path.join(path.dirname(f.options.candidateFile), "driver.json"));
  await promotionReceipt(f, data => { data.coverage.find(row => row.scope === "uninstaller").path = "artifacts/Murage-1.0.19-setup.__uninstaller.exe"; });
  expect((await verifyWindowsSacPromotion(f.options)).files).toHaveLength(6);
});
it.each(["missing records", "wrong certificate leaf", "invalid native trust", "missing uninstaller mapping", "unknown transient"])("refuses %s before extraction", async mode => {
  const f = await fixture();
  if (mode === "missing records") delete f.candidate.signing.records;
  if (mode === "missing uninstaller mapping") delete f.candidate.uninstaller;
  if (mode === "unknown transient") f.candidate.transientFiles = [{path:"artifacts/unknown.dll",sha256:peSha256(windowsExtractionFixtureHelper())}];
  if (mode === "wrong certificate leaf" || mode === "invalid native trust") {
    const file = path.join(path.dirname(f.options.evidenceFile), f.evidence.signatures.file), capture = JSON.parse(fs.readFileSync(file));
    if (mode === "wrong certificate leaf") capture.files[0].leafCertificateSha256 = "a".repeat(64); else capture.files[0].status = "NotTrusted";
    fs.writeFileSync(file, JSON.stringify(capture)); f.evidence.signatures.sha256 = peSha256(fs.readFileSync(file));
  }
  saveCandidate(f); const run = vi.fn(); await expect(verifyWindowsSacPromotion(f.options,{run})).rejects.toThrow(); expect(run).not.toHaveBeenCalled();
});
it.each(["records.json", "signatures.json"])("rechecks %s after asynchronous extraction", async name => {
  const f = await fixture();
  await expect(verifyWindowsSacPromotion(f.options,{run(...args){execFileSync(...args);fs.appendFileSync(path.join(path.dirname(f.options.candidateFile),name)," ");}})).rejects.toThrow();
});

async function invocationFixture(command = "stage") {
  const f = await fixture();
  f.options.publication = {runId: "123", runAttempt: "1"};
  const output = path.join(f.root, "invocation");
  await extractionGate.extractWindowsSacInvocation(command, f.options, output);
  return {...f, output};
}
it("G-B consumers materialize and rehash a signed result without launching the extractor", async () => {
  const f = await invocationFixture();
  const result = await extractionGate.consumeWindowsSacInvocation("stage", f.options, f.output);
  expect(result.installer.sha256).toBe(f.candidate.installer.sha256);
  expect(result.files).toHaveLength(6);
  expect(fs.readdirSync(f.options.workDir)).toEqual([]);
});
it("G-B stage cannot authorize publish even when unsigned artifact labels are rewritten", async () => {
  const f = await invocationFixture();
  const metaFile = path.join(f.output, "invocation.json"), meta = JSON.parse(fs.readFileSync(metaFile));
  meta.command = "publish-prepared"; fs.writeFileSync(metaFile, JSON.stringify(meta));
  await expect(extractionGate.consumeWindowsSacInvocation("publish-prepared", f.options, f.output)).rejects.toThrow("EXTRACTION_FAILED");
});
it("G-B stage and publish have distinct invocation nonces for identical installer bytes", async () => {
  const f = await invocationFixture();
  const publish = path.join(f.root, "publish");
  await extractionGate.extractWindowsSacInvocation("publish-prepared", f.options, publish);
  const request = dir => JSON.parse(fs.readFileSync(path.join(dir, "request.json")));
  expect(request(publish).nonce).not.toBe(request(f.output).nonce);
  expect((await extractionGate.consumeWindowsSacInvocation("publish-prepared", f.options, publish)).installer).toEqual(f.candidate.installer);
});
it.each(["nonce", "identity", "installerSha256", "run-authorization-key", "archive"])("G-B rejects a signed result with wrong %s", async field => {
  const f = await invocationFixture();
  const resultFile = path.join(f.output, "result.json"), envelope = JSON.parse(fs.readFileSync(resultFile));
  const value = JSON.parse(Buffer.from(envelope.payload, "base64"));
  if (field === "nonce") value.nonce = "e".repeat(64);
  if (field === "identity") value.identity.runAttempt = "2";
  if (field === "installerSha256") value.installerSha256 = "e".repeat(64);
  if (field === "archive") value.archiveSha256 = "e".repeat(64);
  const bytes = Buffer.from(JSON.stringify(value));
  envelope.payload = bytes.toString("base64"); envelope.payloadSha256 = peSha256(bytes);
  envelope.signature = sign(null, bytes, (field === "run-authorization-key" ? f.extractionControl.runKey : f.extractionControl.extractionKey).privateKey).toString("base64");
  if (field === "run-authorization-key") envelope.keyId = "run";
  fs.writeFileSync(resultFile, JSON.stringify(envelope));
  const metaFile = path.join(f.output, "invocation.json"), meta = JSON.parse(fs.readFileSync(metaFile));
  meta.resultSha256 = peSha256(fs.readFileSync(resultFile)); fs.writeFileSync(metaFile, JSON.stringify(meta));
  await expect(extractionGate.consumeWindowsSacInvocation("stage", f.options, f.output)).rejects.toThrow("EXTRACTION_FAILED");
});
it.each(["runAttempt", "candidateSha256", "evidenceSha256"])("G-B refuses another invocation's %s before materialization", async field => {
  const f = await invocationFixture();
  if (field === "runAttempt") f.options.publication.runAttempt = "2";
  else f.options[field] = "e".repeat(64);
  await expect(extractionGate.consumeWindowsSacInvocation("stage", f.options, f.output)).rejects.toThrow(field === "runAttempt" ? "EXTRACTION_FAILED" : "AUTHENTICATED_INPUT_MISMATCH");
});

it("G-B stage consumes the signed archive when client execution is unavailable", async () => {
  const f = await invocationFixture();
  fs.chmodSync(f.options.extractor.file, 0o600);
  const source = `import {windowsSacStageGate} from ${JSON.stringify(new URL("./windows-sac-stage-gate.mjs", import.meta.url).href)};
    await windowsSacStageGate(${JSON.stringify(f.options)},${JSON.stringify(f.output)});`;
  const result = spawnSync(process.execPath,["--input-type=module","-e",source],{cwd:f.root,encoding:"utf8",timeout:30_000});
  expect(result.status,result.stderr).toBe(0);
  expect(JSON.parse(fs.readFileSync(path.join(f.root,"release-sac/prepared.json"))).installer).toEqual(f.candidate.installer);
  expect(JSON.parse(fs.readFileSync(path.join(f.root,"release-sac/inputs.json"))).candidateSha256).toBe(f.options.candidateSha256);
});
