// Implementation owner: win-sac-sign; policy owner: GrokBuild; release proof owner: MAIN.
import { copyFile, lstat, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadWindowsSacAllowlist, windowsPeFiles } from "./windows-sac-inventory.mjs";
import { normalizeWindowsPeSources, peSha256, readWindowsPeSnapshot, readWindowsPeSourceReceipt, runnerWindowsPeTrust, signPinnedWindowsPe, verifyFrozenWindowsPe, verifyWindowsPeRecord } from "./windows-pe-signing.mjs";
import { windowsSigningGraph, windowsSigningAdapters } from "./windows-signing-session.mjs";
import { WINDOWS_BACKUP_RAW_SHA256 } from "../shared/windows-backup-tools.mjs";
import { buildBackupHelper } from "./build-backup-helper.mjs";
const sha = peSha256;

/** The native transport pins the full age image as well. A changed digest must
 * enter the compiled helper before that helper receives its final signature. */
export async function refreshWindowsBackupTransport({ appOutDir, projectDir, signIf, native, build = buildBackupHelper, sourcePin, sourceRevision = process.env.MURAGE_BUILD_COMMIT }) {
  const directory = path.join(appOutDir, "resources/backup-tools/x64");
  const ageDigest = sha(await readFile(path.join(directory, "age.exe")));
  if (ageDigest === WINDOWS_BACKUP_RAW_SHA256.age) return false;
  const helper = path.join(directory, "murage-backup-age.exe");
  const adapters = windowsSigningAdapters();
  const rebuilt = await (adapters ? adapters.backup({ ageDigest }) : build({ root: projectDir, ageDigest }));
  // A declared compiler invocation produces this receipt. Observing an output
  // directory never creates build provenance, and stale receipts cannot pass.
  const pin = adapters ? await adapters.backupReceipt() : sourcePin ?? (await readWindowsPeSourceReceipt(process.env.MURAGE_WINDOWS_BACKUP_BUILD_RECEIPT,
    process.env.MURAGE_WINDOWS_BACKUP_BUILD_RECEIPT_SHA256, { target: "win32-x64", sourceRevision }))[0];
  if (pin?.component !== "backup-transport" || !pin.inputs?.some(input => input.component === "age" && input.sha256 === ageDigest)) throw Error("WINDOWS_BACKUP_HELPER_BUILD_RECEIPT_REQUIRED");
  await copyFile(rebuilt, helper);
  const stat = await lstat(helper);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > 64 * 1024 ** 2) throw Error("WINDOWS_BACKUP_HELPER_UNSAFE");
  const record = await signPinnedWindowsPe(helper, pin, native ?? await runnerWindowsPeTrust(), signIf,
    { target: "win32-x64", sourceRevision, path: "resources/backup-tools/x64/murage-backup-age.exe" });
  return { source: pin, record };
}

export async function removeForeignWindowsAddons(appOutDir) {
  for (const file of await windowsPeFiles(appOutDir)) {
    const name = path.relative(appOutDir, file).split(path.sep).join("/");
    if (/^resources\/server\/.*onnxruntime-node\/bin\/napi-v6\/(darwin|linux)\/.+\.node$/.test(name)) await unlink(file);
  }
}

/** Raw source pins establish provenance. Final per-build pins describe signed bytes.
 * A failed/unknown trust verdict is never repaired by blindly re-signing it.
 */
export async function signWindowsUpstream({ appOutDir, signIf, native, allowlist, target = "win32-x64", sourceRevision }) {
  allowlist ??= (await loadWindowsSacAllowlist()).filter(pin => pin.target === target);
  const sources = normalizeWindowsPeSources(allowlist, { target, sourceRevision });
  // Missing required entries are errors, never silently optional ENOENT paths.
  for (const pin of sources) {
    const file = path.resolve(appOutDir, pin.path), stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || sha(await readFile(file)) !== pin.sourceSha256) throw Error("WINDOWS_SAC_UPSTREAM_HASH_MISMATCH");
  }
  const trust = native ?? await runnerWindowsPeTrust(), records = [], signedFiles = [];
  for (const pin of sources) {
    const file = path.resolve(appOutDir, pin.path);
    const record = await signPinnedWindowsPe(file, pin, trust, signIf, { target, sourceRevision, path: pin.path });
    records.push(record);
    if (record.disposition === "signed") signedFiles.push(file);
    // The transport needs signed age before the whole app can be frozen.
    const graph = windowsSigningGraph();
    if (graph && pin.path === "resources/backup-tools/x64/age.exe") await graph.freezeInput("app", pin.path, async () => {
      await verifyFrozenWindowsPe(file, pin, record, trust);
      return { [pin.path]: record.finalSha256 };
    });
  }
  // Runtime projections use these exact successful common-function records.
  // Source pins and frozen final hashes remain distinct in the full manifest.
  const final = sources.map((pin, i) => ({ ...pin, ...records[i], originalSha256: pin.sourceSha256, sha256: records[i].finalSha256 }));
  const backups = final.filter(pin => pin.path.startsWith("resources/backup-tools/x64/"));
  if (backups.length && backups.length !== 3) throw Error("WINDOWS_BACKUP_SIGNED_PINS_INVALID");
  for (const record of records) verifyWindowsPeRecord((await readWindowsPeSnapshot(path.join(appOutDir, record.path))).bytes, sources.find(pin => pin.path === record.path), record);
  await writeFile(path.join(appOutDir, "resources/windows-sac-allowlist.json"), JSON.stringify({ schema: 2, sources, files: records }, null, 2) + "\n");
  if (backups.length) {
    await writeFile(path.join(appOutDir, "resources/backup-tools/x64/windows-sac-pins.json"), JSON.stringify({ schema: 1, files: backups.map(pin => ({ ...pin, path: path.posix.basename(pin.path) })) }, null, 2) + "\n");
  }
  Object.defineProperties(signedFiles, { records: { value: records }, sources: { value: sources } });
  return signedFiles;
}
