// Source/signing producer owner: win-sac-sign; trusted CI inputs and runtime consumer owner: MAIN.
// This is the only source-to-final Windows PE signing policy.
import { windowsSigningGraph } from "./windows-signing-session.mjs";
import { createHash } from "node:crypto";
import { lstat, open, readFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { credentialFreeWindowsEnvironment } from "./windows-signing-config.mjs";
import { parseWindowsCheckerVerdict, verifyWindowsCheckerAttestation } from "./windows-checker-contract.mjs";
import { hasEmbeddedWindowsPeSignature, unsignedWindowsPePin, verifySignedWindowsPe } from "../shared/windows-signed-pe.mjs";
import { WINDOWS_BROWSER_PUBLISHER, requireBrowserSignature } from "../server/browser-windows-identity.ts";

export const peSha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const fail = code => { throw Error(code); };
export function canonicalWindowsPePath(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes(":") || path.posix.isAbsolute(value)
    || value.split("/").some(part => !part || part === "." || part === ".." || /[. ]$/.test(part) || [...part].some(character => character.charCodeAt(0) < 32))) fail("WINDOWS_PE_PATH_INVALID");
  return value;
}
// A vendor cannot be reclassified as a local output. CI must issue receipts at
// these build boundaries, bound to its selected revision and declared inputs.
export const WINDOWS_PE_BUILD_OUTPUTS = Object.freeze({
  "Murage.exe": "murage-app",
  "resources/engine-exclusion.node": "engine-exclusion",
  "resources/anchored-read.node": "anchored-read",
  "resources/presence-guard.node": "presence-guard",
  "resources/murage-recovery.exe": "recovery",
  "resources/backup-tools/x64/murage-backup-age.exe": "backup-transport",
  "resources/fuigo-probe/launcher.exe": "fuigo-probe",
  "resources/browser-extension/win32-x64/murage-browser-host.exe": "browser-host",
  "resources/gepa-worker/gepa-worker.exe": "gepa",
});
export function normalizeWindowsPeSources(sources, { target = "win32-x64", sourceRevision } = {}) {
  if (!Array.isArray(sources)) fail("WINDOWS_PE_SOURCE_CATALOGUE_REQUIRED");
  const seen = new Set();
  return sources.map(input => {
    const pin = { ...input, path: canonicalWindowsPePath(input.path) };
    if (seen.has(pin.path.toLowerCase())) fail("WINDOWS_PE_DUPLICATE_PATH");
    seen.add(pin.path.toLowerCase());
    if (pin.target !== target || !["win32-x64", "win32-arm64"].includes(target) || typeof pin.component !== "string" || !pin.component.trim()
      || typeof pin.version !== "string" || !pin.version.trim() || !digest(pin.sourceSha256) || !digest(pin.sourceReceiptSha256)
      || !Array.isArray(pin.publishers) || pin.publishers.some(p => typeof p !== "string" || !p.trim())
      || !["upstream", "build"].includes(pin.kind)) fail("WINDOWS_PE_SOURCE_IDENTITY_INVALID");
    const declaredBuild = WINDOWS_PE_BUILD_OUTPUTS[pin.path] === pin.component
      || (/^artifacts\/[^/]+\.exe$/.test(pin.path) && ["installer", "uninstaller"].includes(pin.component))
      || (/^transient\/[^/]+\.exe$/.test(pin.path) && pin.component === "nsis-helper");
    if (pin.kind === "build" && (!declaredBuild || !/^[a-f0-9]{40}$/.test(pin.sourceRevision ?? "")
      || !sourceRevision || pin.sourceRevision !== sourceRevision || !Array.isArray(pin.inputs) || !pin.inputs.length
      || pin.inputs.some(input => typeof input.component !== "string" || !digest(input.sha256))
      || !Array.isArray(pin.transformations) || !pin.transformations.length || pin.transformations.some(value => typeof value !== "string" || !value.trim()))) fail("WINDOWS_PE_BUILD_RECEIPT_INVALID");
    return pin;
  });
}
export function windowsPeSourcePinId(pin) {
  return peSha256(JSON.stringify({ path: pin.path, target: pin.target, component: pin.component, version: pin.version, kind: pin.kind,
    sourceSha256: pin.sourceSha256, sourceReceiptSha256: pin.sourceReceiptSha256, publishers: pin.publishers,
    ...(pin.kind === "build" ? { sourceRevision: pin.sourceRevision, inputs: pin.inputs, transformations: pin.transformations } : {}) }));
}
const sameObject = (a, b) => a.dev === b.dev && a.ino === b.ino && a.nlink === b.nlink;
export async function readWindowsPeSnapshot(file) {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail("WINDOWS_PE_FILE_UNSAFE");
  const handle = await open(file, "r");
  try {
    const stat = await handle.stat(), bytes = await handle.readFile(), after = await lstat(file);
    if (!sameObject(before, stat) || !sameObject(stat, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs || bytes.length !== after.size) fail("WINDOWS_PE_FILE_REPLACED");
    return { stat: after, bytes };
  } finally { await handle.close(); }
}
function embeddedTrust(verdict) {
  return verdict?.status === "Valid" && verdict.embedded === true;
}
export function trustedPinnedWindowsPe(verdict, sourcePin, disposition) {
  return embeddedTrust(verdict) && (disposition === "signed"
    ? verdict.publisher === WINDOWS_BROWSER_PUBLISHER && verdict.timestamp === true
    : sourcePin.publishers.includes(verdict.publisher));
}
/** The caller supplies a catalogue lookup result and a runner-side trusted
 * checker, never the unsigned target addon. No record is returned on failure. */
export async function signPinnedWindowsPe(file, sourcePin, trust, sign, identity = {}) {
  const graph = windowsSigningGraph();
  if (!graph) return signWindowsPe(file, sourcePin, trust, sign, identity);
  let record;
  await graph.sign(graph.scopeFor(sourcePin?.path), sourcePin.path, sourcePin.sourceSha256,
    async () => (record = await signWindowsPe(file, sourcePin, trust, sign, identity)));
  return record;
}
async function signWindowsPe(file, sourcePin, trust, sign, identity) {
  if (!sourcePin) fail("WINDOWS_PE_SOURCE_PIN_REQUIRED");
  const [pin] = normalizeWindowsPeSources([sourcePin], identity);
  if (identity.path !== undefined && pin.path !== identity.path) fail("WINDOWS_PE_PATH_IDENTITY_MISMATCH");
  if (!trust || typeof trust.authenticode !== "function") fail("WINDOWS_PE_TRUST_CHECKER_UNAVAILABLE");
  const before = await readWindowsPeSnapshot(file);
  if (peSha256(before.bytes) !== pin.sourceSha256) fail("WINDOWS_SAC_UPSTREAM_HASH_MISMATCH");
  const embedded = hasEmbeddedWindowsPeSignature(before.bytes);
  const verdict = await trust.authenticode(file);
  let unsigned, disposition, finalTrust = verdict;
  if (embedded && trustedPinnedWindowsPe(verdict, pin, "preserved")) {
    disposition = "preserved";
  } else if (!embedded && verdict?.status === "NotSigned") {
    unsigned = unsignedWindowsPePin(before.bytes);
    // A trust callback cannot swap the file between source verification and sign.
    const ready = await readWindowsPeSnapshot(file);
    if (!sameObject(before.stat, ready.stat) || peSha256(ready.bytes) !== pin.sourceSha256) fail("WINDOWS_PE_FILE_REPLACED");
    if (await sign(file) !== true) fail("WINDOWS_SAC_UPSTREAM_SIGNING_FAILED");
    disposition = "signed";
  } else fail("WINDOWS_SAC_UPSTREAM_TRUST_FAILED");
  const after = await readWindowsPeSnapshot(file);
  if (!sameObject(before.stat, after.stat)) fail("WINDOWS_PE_FILE_REPLACED");
  if (unsigned) {
    verifySignedWindowsPe(after.bytes, unsigned);
    finalTrust = await trust.authenticode(file);
    requireBrowserSignature(finalTrust);
    if (!trustedPinnedWindowsPe(finalTrust, pin, "signed")) fail("WINDOWS_PE_EMBEDDED_TIMESTAMP_REQUIRED");
    await trust.verifySigned?.(file, finalTrust);
  } else if (peSha256(after.bytes) !== pin.sourceSha256) fail("WINDOWS_SAC_UPSTREAM_CHANGED");
  const frozen = await readWindowsPeSnapshot(file);
  if (!sameObject(after.stat, frozen.stat) || peSha256(frozen.bytes) !== peSha256(after.bytes)) fail("WINDOWS_PE_FILE_REPLACED");
  return Object.freeze({ path: pin.path, target: pin.target, component: pin.component, version: pin.version,
    sourcePinId: windowsPeSourcePinId(pin), sourceSha256: pin.sourceSha256, finalSha256: peSha256(frozen.bytes), disposition,
    nativeVerdictSha256: peSha256(JSON.stringify(finalTrust)),
    ...(digest(finalTrust.leafCertificateSha256) ? { leafCertificateSha256: finalTrust.leafCertificateSha256 } : {}), ...(unsigned ? { unsigned } : {}) });
}
export function verifyWindowsPeRecord(bytes, pin, record) {
  if (!pin || !record || record.path !== pin.path || record.target !== pin.target || record.version !== pin.version
    || record.component !== pin.component || record.sourcePinId !== windowsPeSourcePinId(pin) || record.sourceSha256 !== pin.sourceSha256
    || peSha256(bytes) !== record.finalSha256 || !hasEmbeddedWindowsPeSignature(bytes)) fail("WINDOWS_PE_RECORD_MISMATCH");
  if (record.disposition === "signed") {
    if (record.unsigned?.sha256 !== pin.sourceSha256) fail("WINDOWS_PE_RECORD_MISMATCH");
    verifySignedWindowsPe(bytes, record.unsigned);
  } else if (record.disposition !== "preserved" || record.unsigned || record.finalSha256 !== pin.sourceSha256) fail("WINDOWS_PE_RECORD_MISMATCH");
}
export async function verifyFrozenWindowsPe(file, pin, record, trust) {
  const before = await readWindowsPeSnapshot(file);
  verifyWindowsPeRecord(before.bytes, pin, record);
  const verdict = await trust.authenticode(file);
  if (!trustedPinnedWindowsPe(verdict, pin, record.disposition)) fail("WINDOWS_SAC_UPSTREAM_TRUST_FAILED: upstream PE has no valid trusted publisher signature");
  if (record.leafCertificateSha256 && verdict.leafCertificateSha256 !== record.leafCertificateSha256) fail("WINDOWS_PE_CERTIFICATE_MISMATCH");
  if (record.disposition === "signed") await trust.verifySigned?.(file, verdict);
  const after = await readWindowsPeSnapshot(file);
  if (!sameObject(before.stat, after.stat) || peSha256(before.bytes) !== peSha256(after.bytes)) fail("WINDOWS_PE_FILE_REPLACED");
  return verdict;
}
/** Trusted CI config pins this independent executable before any target is
 * loaded, including when signing the packaged signature checker itself. */
export async function runnerWindowsPeTrust(env = process.env, { platform = process.platform, run = promisify(execFile) } = {}) {
  const file = env.MURAGE_WINDOWS_TRUST_CHECKER, expected = env.MURAGE_WINDOWS_TRUST_CHECKER_SHA256;
  if (platform !== "win32" || !file || !path.isAbsolute(file) || !digest(expected)) fail("WINDOWS_PE_RUNNER_CHECKER_PIN_REQUIRED");
  const check = async () => {
    if (peSha256((await readWindowsPeSnapshot(file)).bytes) !== expected) fail("WINDOWS_PE_RUNNER_CHECKER_PIN_MISMATCH");
    await verifyWindowsCheckerAttestation(env.MURAGE_WINDOWS_TRUST_CHECKER_ATTESTATION,
      env.MURAGE_WINDOWS_TRUST_CHECKER_ATTESTATION_SHA256, expected);
  };
  await check();
  return { authenticode: async target => {
    await check();
    let stdout;
    try {
      ({ stdout } = await run(file, [path.resolve(target)], { env: credentialFreeWindowsEnvironment(env),
        windowsHide: true, timeout: 120_000, maxBuffer: 16_384 }));
    } finally { await check(); }
    return parseWindowsCheckerVerdict(stdout);
  } };
}
/** Receipts are selected by trusted CI, not discovered from mutable output. */
export async function readWindowsPeSourceReceipt(file, expected, identity) {
  if (!file || !digest(expected)) fail("WINDOWS_PE_SOURCE_RECEIPT_REQUIRED");
  const bytes = await readFile(file);
  if (peSha256(bytes) !== expected) fail("WINDOWS_PE_SOURCE_RECEIPT_HASH_MISMATCH");
  const data = JSON.parse(bytes);
  if (data.schema !== 2 || data.target !== identity.target || data.sourceRevision !== identity.sourceRevision) fail("WINDOWS_PE_SOURCE_IDENTITY_INVALID");
  return normalizeWindowsPeSources(data.sources, identity);
}
