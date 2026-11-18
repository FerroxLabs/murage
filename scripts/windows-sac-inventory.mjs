// Owner: win-sac-sign (signing and inventory); GrokBuild owns policy; MAIN owns release proof.
// A vendor signature alone never admits a new file. Raw upstream bytes require a reviewed path + SHA-256.
import { createRequire } from "node:module";
import { lstat, mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { nativeAuthenticodeIn, WINDOWS_BROWSER_PUBLISHER } from "../server/browser-windows-identity.ts";
import { verifyGepaBundle } from "../server/gepa-resource.ts";
import { canonicalWindowsPePath, normalizeWindowsPeSources, peSha256, readWindowsPeSnapshot, runnerWindowsPeTrust, trustedPinnedWindowsPe, verifyFrozenWindowsPe, verifyWindowsPeRecord } from "./windows-pe-signing.mjs";

export const WINDOWS_SAC_REQUIRED = Object.freeze(["Murage.exe", "resources/engine-exclusion.node", "resources/anchored-read.node", "resources/presence-guard.node", "resources/gepa-worker/gepa-worker.exe"]);

export async function loadWindowsSacAllowlist(appOutDir, expectedManifestSha256) {
  if (appOutDir) {
    const manifest = await loadWindowsSacManifest(appOutDir, expectedManifestSha256);
    for (const pin of manifest.sources) verifyWindowsPeRecord((await readWindowsPeSnapshot(path.join(appOutDir, pin.path))).bytes, pin, manifest.files.find(record => record.path === pin.path));
    return manifest.sources.map(pin => {
      const record = manifest.files.find(item => item.path === pin.path);
      return { ...pin, sha256: record.finalSha256, originalSha256: pin.sourceSha256, ...(record.unsigned ? { unsigned: record.unsigned } : {}) };
    });
  }
  const data = JSON.parse(await readFile(new URL("./windows-sac-allowlist.json", import.meta.url), "utf8"));
  if (data.schema !== 1 || !Array.isArray(data.files)) throw Error("WINDOWS_SAC_ALLOWLIST_INVALID");
  // The catalogue contains both target architectures. Each package selects one explicitly.
  const files = [];
  for (const target of ["win32-x64", "win32-arm64"]) files.push(...normalizeWindowsPeSources(data.files.filter(pin => pin.target === target), { target }));
  if (files.length !== data.files.length) throw Error("WINDOWS_SAC_ALLOWLIST_INVALID");
  return files;
}

export function trustedWindowsUpstreamSignature(result, pin) {
  return trustedPinnedWindowsPe(result, pin, "preserved");
}

export async function loadWindowsSacManifest(appOutDir, expectedManifestSha256 = process.env.MURAGE_WINDOWS_SAC_MANIFEST_SHA256) {
  if (!/^[a-f0-9]{64}$/.test(expectedManifestSha256 ?? "")) throw Error("WINDOWS_SAC_EXPECTED_MANIFEST_DIGEST_REQUIRED");
  const bytes = (await readWindowsPeSnapshot(path.join(appOutDir, "resources/windows-sac-signing.json"))).bytes;
  if (peSha256(bytes) !== expectedManifestSha256) throw Error("WINDOWS_SAC_MANIFEST_DIGEST_MISMATCH");
  const data = JSON.parse(bytes);
  if (data.schema !== 2 || !Array.isArray(data.sources) || !Array.isArray(data.files)) throw Error("WINDOWS_SAC_RECEIPT_INVALID");
  normalizeWindowsPeSources(data.sources, { target: data.target, sourceRevision: data.sourceRevision });
  const paths = new Set();
  for (const record of data.files) {
    canonicalWindowsPePath(record.path);
    if (paths.has(record.path.toLowerCase()) || !data.sources.some(pin => pin.path === record.path)) throw Error("WINDOWS_SAC_RECEIPT_INVALID");
    paths.add(record.path.toLowerCase());
  }
  if (paths.size !== data.sources.length) throw Error("WINDOWS_SAC_RECEIPT_INVALID");
  return data;
}

/** Include executable extensions even for malformed images, and sniff every other file for MZ. Never follow links. */
export async function windowsPeFiles(root) {
  root = path.resolve(root);
  const files = [];
  const walk = async (directory, depth = 0) => {
    if (depth > 64) throw new Error("WINDOWS_SAC_INVENTORY_DEPTH");
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("WINDOWS_SAC_INVENTORY_LINK");
    for (const name of (await readdir(directory)).sort()) {
      const file = path.join(directory, name), info = await lstat(file);
      if (info.isSymbolicLink()) throw new Error("WINDOWS_SAC_INVENTORY_LINK");
      if (info.isDirectory()) { await walk(file, depth + 1); continue; }
      if (!info.isFile()) throw new Error("WINDOWS_SAC_INVENTORY_FILE");
      const handle = await open(file, "r");
      let mz;
      try { const head = Buffer.alloc(2); const { bytesRead } = await handle.read(head, 0, 2, 0); mz = bytesRead === 2 && head.toString("ascii") === "MZ"; }
      finally { await handle.close(); }
      if (/\.(exe|dll|node|pyd)$/i.test(name) || mz) files.push(file);
    }
  };
  await walk(root);
  return files;
}

const cell = value => String(value).replaceAll("|", "\\|").replace(/[\r\n]/g, " ");

/** GEPA is signed before copying so its manifest can pin SIGNED bytes in app.asar.
 * Read the same metadata the runtime trusts, never a loose receipt beside it.
 * Full inventory verification also rejects extra files, missing files and tampering.
 */
async function frozenGepaFiles(appOutDir) {
  const resources = path.resolve(appOutDir, "resources"), directory = path.join(resources, "gepa-worker");
  try { await lstat(directory); } catch (error) { if (error.code === "ENOENT") return new Set(); throw error; }
  const fromBuilder = createRequire(createRequire(import.meta.url).resolve("electron-builder/package.json"));
  const asar = createRequire(fromBuilder.resolve("app-builder-lib/package.json"))("@electron/asar");
  const archive = path.join(resources, "app.asar");
  asar.uncache(archive);
  const metadata = JSON.parse(asar.extractFile(archive, "package.json").toString("utf8"));
  const expected = metadata.murageGepaManifests?.["win32-x64"];
  if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) throw new Error("GEPA_RESOURCE_BUILD_RECEIPT_REQUIRED");
  verifyGepaBundle(directory, "win32-x64", expected);
  return new Set(await windowsPeFiles(directory));
}

/** Complete independent admission before a packaged executable or addon runs. */
export async function verifyWindowsPeRecords(appOutDir, sources, records, trust) {
  const discovered = (await windowsPeFiles(appOutDir)).map(file => path.relative(path.resolve(appOutDir), file).split(path.sep).join("/"));
  const paths = new Set(records.map(record => record.path.toLowerCase()));
  if (paths.size !== records.length || records.length !== sources.length || discovered.length !== sources.length
    || sources.some(pin => !discovered.includes(pin.path) || !records.some(record => record.path === pin.path))) throw Error("WINDOWS_PE_SOURCE_SET_MISMATCH");
  for (const pin of sources) {
    try { await verifyFrozenWindowsPe(path.resolve(appOutDir, pin.path), pin, records.find(record => record.path === pin.path), trust); }
    catch (error) { throw Error(`WINDOWS_SAC_INVENTORY_REJECTED: ${pin.path}: ${error.message}`); }
  }
}

/** The diagnostic signing sets confer no admission. Source, final and observed
 * path sets must be equal; every path uses the same payload and trust predicate. */
export async function verifyWindowsSacInventory({ appOutDir, signedFiles = [], native, bootstrapTrust,
  sources, records, target = "win32-x64", sourceRevision, expectedManifestSha256, requiredFiles = WINDOWS_SAC_REQUIRED,
  report = path.resolve(appOutDir, "..", "SAC-INVENTORY.md") }) {
  if (!sources || !records) {
    const manifest = await loadWindowsSacManifest(appOutDir, expectedManifestSha256);
    sources = manifest.sources; records = manifest.files; target = manifest.target; sourceRevision = manifest.sourceRevision;
  }
  sources = normalizeWindowsPeSources(sources, { target, sourceRevision });
  if (!Array.isArray(records)) throw Error("WINDOWS_SAC_RECEIPT_INVALID");
  if (!native) {
    // Authenticate every executable/addon with the independently pinned runner
    // before loading any code from the mutable package, including the checker.
    await verifyWindowsPeRecords(appOutDir, sources, records, bootstrapTrust ?? await runnerWindowsPeTrust());
    native = nativeAuthenticodeIn(path.resolve(appOutDir, "resources"));
    if (!native) throw Error("WINDOWS_SAC_SIGNATURE_HELPER_UNAVAILABLE");
  }
  const signed = new Set(signedFiles.map(file => path.resolve(file))), gepa = await frozenGepaFiles(appOutDir);
  const pins = new Map(sources.map(pin => [pin.path, pin])), finals = new Map(), failures = [], rows = [];
  const seen = new Set();
  for (const record of records) {
    canonicalWindowsPePath(record.path);
    if (seen.has(record.path.toLowerCase())) throw Error("WINDOWS_PE_DUPLICATE_PATH");
    seen.add(record.path.toLowerCase()); finals.set(record.path, record);
    if (!pins.has(record.path)) failures.push(`unreviewed final record: ${record.path}`);
  }
  for (const file of await windowsPeFiles(appOutDir)) {
    const name = path.relative(path.resolve(appOutDir), file).split(path.sep).join("/");
    const pin = pins.get(name), record = finals.get(name), snapshot = await readWindowsPeSnapshot(file);
    let hash = peSha256(snapshot.bytes), result, risk;
    try {
      result = await verifyFrozenWindowsPe(file, pin, record, native);
      hash = record.finalSha256;
      risk = "Verified source-to-final payload and embedded publisher signature; Windows decides SAC admission.";
    } catch (error) { failures.push(name); risk = `REJECTED: ${error.message}`; }
    const valid = result?.status === "Valid" && result.embedded === true;
    rows.push({ path: name, sha256: hash, signedHere: signed.has(file), signedBeforeFreeze: gepa.has(file), signed: valid,
      vendor: valid && result.publisher !== WINDOWS_BROWSER_PUBLISHER, risk });
  }
  for (const pin of sources) {
    if (!finals.has(pin.path)) failures.push(`missing final record: ${pin.path}`);
    if (!rows.some(row => row.path === pin.path)) failures.push(`missing expected PE: ${pin.path}`);
  }
  for (const required of requiredFiles) if (!rows.some(row => row.path === required) || !pins.has(required) || !finals.has(required)) failures.push(`required signed component: ${required}`);
  for (const file of signed) if (!rows.some(row => path.resolve(appOutDir, row.path) === file)) failures.push(path.basename(file));
  const counts = { pe: rows.length, signed: rows.filter(row => row.signed).length, vendor: rows.filter(row => row.vendor).length,
    allowlisted: rows.filter(row => !row.signedHere && finals.get(row.path)?.finalSha256 === row.sha256).length, rejected: failures.length };
  await mkdir(path.dirname(report), { recursive: true });
  await writeFile(report, `# Windows SAC inventory\n\nOwner: win-sac-sign; CI/runtime consumer: MAIN.\n\nPE candidates ${counts.pe}; signed ${counts.signed}; vendor ${counts.vendor}; allowlisted ${counts.allowlisted}; rejected ${counts.rejected}.\n\nSigning columns are diagnostic only. Every admitted PE requires a source pin, verified final record and current embedded Windows trust. Windows alone decides SAC admission.\n\n| Packaged path | SHA-256 | Signed | Vendor signature present | Signed after copy | SAC risk |\n| --- | --- | --- | --- | --- | --- |\n${rows.map(row => `| ${cell(row.path)} | ${row.sha256} | ${row.signed ? "yes" : "no"} | ${row.vendor ? "yes" : "no"} | ${row.signedHere ? "yes" : "no"} | ${cell(row.risk)} |`).join("\n")}\n`);
  if (failures.length) throw Error(`WINDOWS_SAC_INVENTORY_REJECTED: ${failures.join(", ")}`);
  return { rows, counts };
}

/** Freeze once after the final builder boundary. Never derive provenance or
 * refresh any record from observed package bytes. */
export async function writeWindowsSacReceipt(appOutDir, state, options = {}) {
  if (!state || Array.isArray(state) || !Array.isArray(state.sources) || !Array.isArray(state.records)) throw Error("WINDOWS_SAC_SOURCE_FINAL_RECORDS_REQUIRED");
  await verifyWindowsSacInventory({ ...options, ...state, appOutDir });
  const text = JSON.stringify({ schema: 2, target: state.target, sourceRevision: state.sourceRevision, sources: state.sources, files: state.records }, null, 2) + "\n";
  await writeFile(path.join(appOutDir, "resources/windows-sac-signing.json"), text, { flag: "wx" });
  return peSha256(text);
}

/** afterSign is read-only: even Murage.exe must already match its final record. */
export async function refreshWindowsSacReceipt(appOutDir, options = {}) {
  return verifyWindowsSacInventory({ ...options, appOutDir });
}

export async function verifyPackagedWindowsSac(appOutDir = "release/win-unpacked", report, expectedManifestSha256, options = {}) {
  return verifyWindowsSacInventory({ ...options, appOutDir: path.resolve(appOutDir), report, expectedManifestSha256 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log((await verifyPackagedWindowsSac(process.argv[2], process.argv[3], process.argv[4])).counts); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
