// Promotion validator owner: win-sac-sign; authenticated SAC producer, candidate pins and payload extractor owner: MAIN.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { normalizeWindowsPeSources, peSha256, readWindowsPeSnapshot, trustedPinnedWindowsPe, verifyWindowsPeRecord } from "./windows-pe-signing.mjs";
import { verifyWindowsSigningReceipt, windowsSigningRecordSha256 } from "./windows-signing-receipt.mjs";
import { extractWindowsInstaller } from "./windows-extraction-contract.mjs";
import { windowsPeFiles, WINDOWS_SAC_REQUIRED } from "./windows-sac-inventory.mjs";
import { WINDOWS_SIGNING_RELEASE_VERSION } from "./windows-signing-authority.mjs";

const fail = code => { throw Error(`WINDOWS_SAC_PROMOTION_${code}`); };
const digest = value => /^[a-f0-9]{64}$/.test(value ?? "");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const identityMatches = (data, identity) => ["sourceRevision", "version", "target", "runId", "runAttempt"].every(key => data?.[key] === identity[key]);
async function pinnedJson(file, expected) {
  if (!path.isAbsolute(file ?? "") || !digest(expected)) fail("AUTHENTICATED_INPUT_REQUIRED");
  const bytes = (await readWindowsPeSnapshot(file)).bytes;
  if (peSha256(bytes) !== expected) fail("AUTHENTICATED_INPUT_MISMATCH");
  return JSON.parse(bytes);
}
function inventory(rows) {
  if (!Array.isArray(rows) || !rows.length) fail("INVENTORY_REQUIRED");
  const seen = new Set();
  return rows.map(row => {
    if (typeof row?.path !== "string" || !row.path || row.path.includes("\\") || row.path.includes(":")
      || row.path.split("/").some(part => !part || part === "." || part === ".." || /[. ]$/.test(part) || /[\x00-\x1f]/.test(part))
      || !digest(row.sha256) || seen.has(row.path.toLowerCase())) fail("INVENTORY_INVALID");
    seen.add(row.path.toLowerCase());
    return { path: row.path, sha256: row.sha256 };
  }).sort((a, b) => a.path.localeCompare(b.path));
}
function standardToken(token) {
  return token?.userType === "standard" && token.administratorMember === false && token.elevated === false
    && token.elevationType === "Default" && token.integrityLevel === "Medium";
}
function s4OwnTokenFailure(s4, imageSha256) {
  const process = value => Number.isSafeInteger(value?.pid) && value.pid > 0 && typeof value.creationTime === "string" && /^[1-9][0-9]*$/.test(value.creationTime);
  const sameProcess = (a, b) => a.pid === b.pid && a.creationTime === b.creationTime;
  const open = s4?.tokenOpen;
  return open?.api === "OpenProcessToken" && open.requestedAccess === 0x28 && open.succeeded === false
    && [open.process, open.tokenOwner, s4.successProcess, s4.witnessProcess].every(process)
    && digest(imageSha256) && open.process.imageSha256 === imageSha256 && s4.successProcess.imageSha256 === imageSha256
    && sameProcess(open.process, open.tokenOwner) && !sameProcess(open.process, s4.successProcess)
    && !sameProcess(open.process, s4.witnessProcess) && !sameProcess(s4.successProcess, s4.witnessProcess)
    && s4.jobStarted === false;
}

/** Authentication uses digests selected by protected CI, not values supplied
 * inside the evidence or computed from an unauthenticated downloaded manifest.
 * The approved extractor materializes the installed path layout, including the
 * embedded uninstaller, from the installer passed here. Never trust an existing
 * extracted directory or a manifest that merely claims its payload hashes. */
export async function verifyWindowsSacPromotion({ assetsDir, candidateFile, candidateSha256, evidenceFile, evidenceSha256,
  extractor, identity, publication, workDir, extractionInvocation }, { run = promisify(execFile) } = {}) {
  if (!/^[a-f0-9]{40}$/.test(identity?.sourceRevision ?? "") || identity?.version !== WINDOWS_SIGNING_RELEASE_VERSION
    || !["win32-x64", "win32-arm64"].includes(identity?.target) || !/^[1-9][0-9]*$/.test(identity?.runId ?? "")
    || !/^[1-9][0-9]*$/.test(identity?.runAttempt ?? "")) fail("IDENTITY_REQUIRED");
  const candidate = await pinnedJson(candidateFile, candidateSha256), evidence = await pinnedJson(evidenceFile, evidenceSha256);
  if (candidate.schema !== 1 || evidence.schema !== 1 || !identityMatches(candidate, identity) || !identityMatches(evidence, identity)
    || evidence.candidateSha256 !== candidateSha256) fail("IDENTITY_MISMATCH");
  const installerName = `Murage-${identity.version}-setup.exe`;
  if (candidate.installer?.name !== installerName || !digest(candidate.installer?.sha256)
    || !same(candidate.installer, evidence.installer)) fail("INSTALLER_MISMATCH");
  const expected = inventory(candidate.files);
  if (!same(expected, inventory(evidence.files)) || WINDOWS_SAC_REQUIRED.some(name => !expected.some(row => row.path === name))
    || !expected.some(row => /^Uninstall [^/]+\.exe$/i.test(row.path))) fail("INVENTORY_MISMATCH");
  const signing = candidate.signing;
  if (typeof signing?.file !== "string" || path.basename(signing.file) !== signing.file) fail("DRIVER_RECEIPT_REQUIRED");
  const driverFile = path.join(path.dirname(candidateFile), signing.file);
  const driver = verifyWindowsSigningReceipt(JSON.stringify(await pinnedJson(driverFile, signing.sha256)), signing.configuration, signing.coverage);
  if (!identityMatches(driver.identity, identity) || driver.result.installerName !== installerName
    || driver.result.installerSha256 !== candidate.installer.sha256) fail("DRIVER_RECEIPT_MISMATCH");
  const uninstaller = candidate.uninstaller;
  const uninstallerFreeze = driver.events.find(row => row.event === "freeze" && row.scope === "uninstaller");
  if (!uninstaller || !/^Uninstall [^/]+\.exe$/i.test(uninstaller.installedPath ?? "")
    || !same(uninstallerFreeze.outputDigests, { [uninstaller.retainedPath]: uninstaller.sha256 })
    || !expected.some(row => row.path === uninstaller.installedPath && row.sha256 === uninstaller.sha256)) fail("UNINSTALLER_MAPPING_REQUIRED");
  const frozenPayload = driver.events.filter(row => row.event === "freeze" && ["gepa", "app", "uninstaller"].includes(row.scope))
    .flatMap(row => Object.entries(row.outputDigests).map(([name, sha256]) => ({
      path: row.scope === "uninstaller" ? uninstaller.installedPath : name, sha256 })));
  if (!same(expected, inventory(frozenPayload))) fail("DRIVER_PAYLOAD_MISMATCH");
  const records = signing.records;
  if (typeof records?.file !== "string" || path.basename(records.file) !== records.file) fail("PE_RECORDS_REQUIRED");
  const recordsFile = path.join(path.dirname(candidateFile), records.file);
  const sourceFinal = await pinnedJson(recordsFile, records.sha256);
  if (sourceFinal.schema !== 2 || sourceFinal.target !== identity.target || sourceFinal.sourceRevision !== identity.sourceRevision
    || !Array.isArray(sourceFinal.files)) fail("PE_RECORDS_REQUIRED");
  const sources = normalizeWindowsPeSources(sourceFinal.sources, identity), signedEvents = driver.events.filter(row => ["sign", "preserve"].includes(row.event));
  if (sourceFinal.files.length !== sources.length || sourceFinal.files.length !== signedEvents.length
    || new Set(sourceFinal.files.map(row => row.path)).size !== signedEvents.length) fail("PE_RECORDS_MISMATCH");
  for (const event of signedEvents) {
    const record = sourceFinal.files.find(row => row.path === event.path), source = sources.find(row => row.path === event.path);
    if (!source || !record || !digest(record.leafCertificateSha256) || windowsSigningRecordSha256(record) !== event.recordSha256
      || record.sourceSha256 !== event.inputDigests[event.path] || record.finalSha256 !== event.outputDigests[event.path]) fail("PE_RECORDS_MISMATCH");
  }
  if (evidence.windows?.major !== 11 || !Number.isInteger(evidence.windows.build) || evidence.windows.build < 22000
    || evidence.sac?.before !== "ENFORCING" || evidence.sac?.after !== "ENFORCING" || evidence.sac?.throughout !== true
    || !Array.isArray(evidence.tokens) || !same(evidence.tokens.map(row => row.process).sort(), ["addon", "app", "engine", "install"])
    || evidence.tokens.some(row => !standardToken(row))) fail("ENFORCING_STANDARD_USER_REQUIRED");
  const proofDigest = value => digest(value?.sha256);
  if (!proofDigest(evidence.sac.policyExport) || !proofDigest(evidence.tokenExport) || !proofDigest(evidence.signatures)
    || !proofDigest(evidence.inventory) || !proofDigest(evidence.payloadPreservation) || !proofDigest(evidence.helperLoads)
    || !proofDigest(evidence.codeIntegrity) || evidence.codeIntegrity.relatedBlocks !== 0 || evidence.codeIntegrity.intervalCovered !== true
    || evidence.install?.exitCode !== 0 || evidence.launch?.exitCode !== 0 || evidence.turn?.kind !== "real-engine"
    || !evidence.turn.id || evidence.turn.started !== true || evidence.turn.completed !== true || evidence.turn.engineExitCode !== 0
    || evidence.addon?.path !== "resources/engine-exclusion.node" || evidence.addon.sha256 !== expected.find(row => row.path === evidence.addon.path)?.sha256
    || !evidence.addon.version || evidence.addon.loaded !== true || evidence.addon.nativeCall !== "success"
    || evidence.addon.privilegesRemoved !== true || evidence.s4?.refusalCode !== "EPOWER" || evidence.s4.engineSpawned !== false
    || !s4OwnTokenFailure(evidence.s4, expected.find(row => row.path === "Murage.exe")?.sha256)
    || evidence.bypass !== false || evidence.developerAllowRule !== false) fail("PROOF_INCOMPLETE");
  // Every retained diagnostic is itself content-bound, not just a successful
  // workflow status or a path to an unrelated capture.
  const checkCaptures = async () => {
    for (const record of [evidence.sac.policyExport, evidence.tokenExport, evidence.signatures, evidence.inventory,
      evidence.payloadPreservation, evidence.helperLoads, evidence.codeIntegrity]) {
      if (typeof record.file !== "string" || path.basename(record.file) !== record.file) fail("PROOF_INCOMPLETE");
      if (peSha256((await readWindowsPeSnapshot(path.join(path.dirname(evidenceFile), record.file))).bytes) !== record.sha256) fail("PROOF_CAPTURE_MISMATCH");
    }
  };
  await checkCaptures();
  const signatures = await pinnedJson(path.join(path.dirname(evidenceFile), evidence.signatures.file), evidence.signatures.sha256);
  if (signatures.schema !== 1 || !Array.isArray(signatures.files) || signatures.files.length !== sourceFinal.files.length
    || new Set(signatures.files.map(row => row.path)).size !== sourceFinal.files.length) fail("CERTIFICATE_PROOF_MISMATCH");
  for (const record of sourceFinal.files) {
    const capture = signatures.files.find(row => row.path === record.path), source = sources.find(row => row.path === record.path);
    if (!capture || capture.sha256 !== record.finalSha256 || capture.leafCertificateSha256 !== record.leafCertificateSha256
      || !trustedPinnedWindowsPe(capture, source, record.disposition)) fail("CERTIFICATE_PROOF_MISMATCH");
  }
  const assets = inventory(candidate.assets);
  if (assets.some(row => path.posix.basename(row.path) !== row.path)) fail("ASSET_SET_INVALID");
  const checkAssets = async () => {
    const directory = await lstat(assetsDir);
    if (!directory.isDirectory() || directory.isSymbolicLink()) fail("ASSET_SET_INVALID");
    const names = (await readdir(assetsDir)).sort();
    if (!same(names, assets.map(row => row.path).sort())) fail("ASSET_SET_MISMATCH");
    for (const row of assets) {
      if (peSha256((await readWindowsPeSnapshot(path.join(assetsDir, row.path))).bytes) !== row.sha256) fail("ASSET_MISMATCH");
    }
  };
  await checkAssets();
  const installers = (await readdir(assetsDir)).filter(name => /\.exe$/i.test(name)).sort();
  if (!same(installers, [installerName, "Murage-setup.exe"].sort())) fail("INSTALLER_SET_MISMATCH");
  const installer = path.resolve(assetsDir, installerName);
  for (const name of installers) if (peSha256((await readWindowsPeSnapshot(path.join(assetsDir, name))).bytes) !== candidate.installer.sha256) fail("INSTALLER_MISMATCH");
  const checkExtractor = async () => {
    if (!path.isAbsolute(extractor?.file ?? "") || !digest(extractor?.sha256)
      || peSha256((await readWindowsPeSnapshot(extractor.file)).bytes) !== extractor.sha256) fail("PINNED_EXTRACTOR_REQUIRED");
  };
  await checkExtractor();
  if (!path.isAbsolute(workDir ?? "")) fail("WORK_DIRECTORY_REQUIRED");
  await mkdir(workDir, { recursive: true });
  const scratch = await mkdtemp(path.join(workDir, "sac-payload-"));
  try {
    const payload = path.join(scratch, "payload");
    try {
      const allowedTransient = driver.events.filter(row => row.event === "freeze").flatMap(row => Object.entries(row.outputDigests).map(([name, sha256]) => ({path:name,sha256})));
      await extractWindowsInstaller({ extractor, installer, installerSha256: candidate.installer.sha256, output: payload, identity: driver.identity,
        allowedTransient, expectedTransient: inventory(candidate.transientFiles),
        ...(publication ? { publication } : {}),
        ...(extractionInvocation ? { requestNonce: peSha256(JSON.stringify({ command: extractionInvocation, identity: driver.identity, publication, installerSha256: candidate.installer.sha256, candidateSha256, evidenceSha256, extractorSha256: extractor.sha256, bundleSha256: extractor.bundleSha256 })) } : {}) }, { run });
    } catch { fail("EXTRACTION_FAILED"); }
    finally { await checkExtractor(); }
    const observed = [];
    for (const file of await windowsPeFiles(payload)) observed.push({ path: path.relative(payload, file).split(path.sep).join("/"),
      sha256: peSha256((await readWindowsPeSnapshot(file)).bytes) });
    if (!same(expected, inventory(observed))) fail("PAYLOAD_MISMATCH");
    for (const row of expected) {
      const name = row.path === uninstaller.installedPath ? uninstaller.retainedPath : row.path;
      verifyWindowsPeRecord((await readWindowsPeSnapshot(path.join(payload, row.path))).bytes,
        sources.find(source => source.path === name), sourceFinal.files.find(record => record.path === name));
    }
    for (const row of inventory(candidate.transientFiles)) verifyWindowsPeRecord(
      (await readWindowsPeSnapshot(path.join(`${payload}.transients`, row.path))).bytes,
      sources.find(source => source.path === row.path), sourceFinal.files.find(record => record.path === row.path));
    verifyWindowsPeRecord((await readWindowsPeSnapshot(installer)).bytes,
      sources.find(source => source.path === `artifacts/${installerName}`), sourceFinal.files.find(record => record.path === `artifacts/${installerName}`));
    // Catch installer replacement while an extractor is reading it.
    for (const name of installers) if (peSha256((await readWindowsPeSnapshot(path.join(assetsDir, name))).bytes) !== candidate.installer.sha256) fail("INSTALLER_MISMATCH");
    await checkAssets();
    await checkCaptures();
    await pinnedJson(recordsFile, records.sha256);
    await pinnedJson(driverFile, signing.sha256);
    await pinnedJson(candidateFile, candidateSha256); await pinnedJson(evidenceFile, evidenceSha256);
    return Object.freeze({ schema: 1, ...identity, candidateSha256, evidenceSha256, installer: candidate.installer, files: expected, assets, driverReceiptSha256: signing.sha256 });
  } finally {
    // Only the fresh directory allocated above, never a caller's payload tree.
    if (!(await lstat(scratch)).isSymbolicLink()) await rm(scratch, { recursive: true, force: true });
  }
}

export function windowsSacPromotionOptions(env = process.env) {
  return { assetsDir: path.resolve("assets"), candidateFile: path.resolve("release-sac/candidate.json"),
    candidateSha256: env.MURAGE_WINDOWS_SAC_CANDIDATE_SHA256, evidenceFile: path.resolve("release-sac/evidence.json"),
    evidenceSha256: env.MURAGE_WINDOWS_SAC_EVIDENCE_SHA256,
    extractor: { file: env.MURAGE_WINDOWS_SAC_EXTRACTOR, sha256: env.MURAGE_WINDOWS_SAC_EXTRACTOR_SHA256,
      bundleFile: env.MURAGE_WINDOWS_SAC_EXTRACTION_BUNDLE, bundleSha256: env.MURAGE_WINDOWS_SAC_EXTRACTION_BUNDLE_SHA256 },
    workDir: env.RUNNER_TEMP, identity: { sourceRevision: env.SHA, version: env.VERSION, target: "win32-x64",
      runId: env.MURAGE_WINDOWS_BUILD_RUN_ID ?? env.GITHUB_RUN_ID, runAttempt: env.MURAGE_WINDOWS_BUILD_RUN_ATTEMPT ?? env.GITHUB_RUN_ATTEMPT },
    publication: { runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT } };
}
