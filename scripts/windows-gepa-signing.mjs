// Owner: win-sac-sign (signing/freeze); MAIN owns release CI signature proof.
import { windowsSigningSession } from "./windows-signing-session.mjs";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { inventoryGepaBundle, verifyGepaBundle } from "../server/gepa-resource.ts";
import { windowsPeFiles } from "./windows-sac-inventory.mjs";
import { normalizeWindowsPeSources, peSha256, readWindowsPeSourceReceipt, runnerWindowsPeTrust, signPinnedWindowsPe, verifyFrozenWindowsPe, verifyWindowsPeRecord } from "./windows-pe-signing.mjs";

/** afterExtract runs before app.asar and its Electron integrity metadata are made.
 * Authenticate the input receipt first; only the signer may change its files.
 * The resource copier must preserve these signed bytes (including DLLs/PYDs).
 */
export default async function signWindowsGepa(context) {
  if (context.electronPlatformName !== "win32") return;
  const arch = typeof context.arch === "string" ? context.arch : ({ 1: "x64", 3: "arm64" })[context.arch];
  if (arch !== "x64") throw new Error("GEPA_RESOURCE_TARGET_UNAVAILABLE");
  const packager = context.packager, target = "win32-x64";
  const projection = packager.config?.extraMetadata?.murageWindowsPeGepa;
  if (projection) {
    // CI already applied the common function before freezing GEPA metadata.
    // Copying a frozen projection is verification, never another signing pass.
    const directory = packager.config.win.extraResources.find(row => row.to === "gepa-worker")?.from;
    if (!directory || !path.isAbsolute(directory) || peSha256(JSON.stringify(projection.sourceManifest, null, 2) + "\n") !== projection.sourceManifestSha256) throw Error("GEPA_RESOURCE_SOURCE_PIN_REQUIRED");
    const sources = normalizeWindowsPeSources(projection.sources, { target, sourceRevision: process.env.MURAGE_BUILD_COMMIT });
    const pins = packager.config.extraMetadata.murageGepaManifests;
    if (projection.finalManifestSha256 !== pins?.[target]) throw Error("GEPA_RESOURCE_BUILD_RECEIPT_REQUIRED");
    verifyGepaBundle(directory, target, pins[target]);
    const files = await windowsPeFiles(directory), trust = context.signingTrust ?? windowsSigningSession(context).trust ?? await runnerWindowsPeTrust();
    if (sources.length !== files.length || projection.records?.length !== files.length) throw Error("GEPA_RESOURCE_SOURCE_PIN_REQUIRED");
    for (const file of files) {
      const name = `resources/gepa-worker/${path.relative(directory, file).split(path.sep).join("/")}`;
      const pin = sources.find(pin => pin.path === name), record = projection.records.find(record => record.path === name);
      if (pin?.sourceReceiptSha256 !== projection.sourceManifestSha256 || pin.version !== projection.sourceManifest.gepa
        || pin.sourceSha256 !== projection.sourceManifest.files.find(row => `resources/gepa-worker/${row.path}` === name)?.sha256) throw Error("GEPA_RESOURCE_SOURCE_PIN_REQUIRED");
      await verifyFrozenWindowsPe(file, pin, record, trust);
    }
    return { directory, manifestSha256: pins[target], sourceManifestSha256: projection.sourceManifestSha256, sources, records: projection.records };
  }
  const pins = packager.config?.extraMetadata?.murageGepaManifests;
  if (!/^[a-f0-9]{64}$/.test(pins?.[target] ?? "")) throw new Error("GEPA_RESOURCE_BUILD_RECEIPT_REQUIRED");
  const source = path.resolve(packager.projectDir, "dist-native/gepa", target);
  const { manifest } = verifyGepaBundle(source, target, pins[target]);
  const sourceManifestSha256 = pins[target];
  const identity = { target, sourceRevision: process.env.MURAGE_BUILD_COMMIT };
  const catalogue = normalizeWindowsPeSources(context.windowsPeSources ?? await readWindowsPeSourceReceipt(
    process.env.MURAGE_WINDOWS_PE_SOURCE_RECEIPT, process.env.MURAGE_WINDOWS_PE_SOURCE_RECEIPT_SHA256, identity), identity);
  const sources = catalogue.filter(pin => pin.path.startsWith("resources/gepa-worker/"));
  const originalFiles = await windowsPeFiles(source);
  const sourcePins = new Map(sources.map(pin => [pin.path, pin]));
  // Check the complete source set before any signer can run. GEPA's pinned
  // manifest is an input receipt, never a second signing authority.
  for (const file of originalFiles) {
    const name = path.relative(source, file).split(path.sep).join("/"), pin = sourcePins.get(`resources/gepa-worker/${name}`);
    const input = manifest.files.find(item => item.path === name);
    if (!pin || pin.version !== manifest.gepa || pin.component !== "gepa" || pin.sourceReceiptSha256 !== sourceManifestSha256
      || pin.sourceSha256 !== input?.sha256) throw Error("GEPA_RESOURCE_SOURCE_PIN_REQUIRED");
  }
  if (sources.length !== originalFiles.length) throw Error("GEPA_RESOURCE_SOURCE_PIN_REQUIRED");
  const trust = context.signingTrust ?? windowsSigningSession(context).trust ?? await runnerWindowsPeTrust();
  // Leave the CI input receipt and tree intact: a new builder invocation can
  // retry a transient download failure with the same trusted command-line pin.
  await mkdir(context.outDir, { recursive: true });
  const stage = await mkdtemp(path.join(context.outDir, ".gepa-signing-"));
  const directory = path.join(stage, target);
  await cp(source, directory, { recursive: true, force: false, errorOnExist: true });
  verifyGepaBundle(directory, target, pins[target]);
  const files = await windowsPeFiles(directory);
  const records = [];
  for (const file of files) {
    const name = `resources/gepa-worker/${path.relative(directory, file).split(path.sep).join("/")}`;
    const session = windowsSigningSession(context), output = session.receipts?.outputs.find(row => row.path === name);
    if (session.graph && sourcePins.get(name).kind === "build"
      && (!output || (await session.receipts.consume(name, output.stage)).sourceSha256 !== sourcePins.get(name).sourceSha256)) throw Error("GEPA_RESOURCE_SOURCE_PIN_REQUIRED");
    records.push(await signPinnedWindowsPe(file, sourcePins.get(name), trust, windowsSigningSession(context).sign, { ...identity, path: name }));
  }
  // Reject additions/removals and changes outside the explicitly signed images.
  const signed = new Set(files.map(file => path.relative(directory, file).split(path.sep).join("/")));
  const inventory = inventoryGepaBundle(directory);
  if (inventory.length !== manifest.files.length || inventory.some((item, i) => {
    const before = manifest.files[i];
    if (!signed.has(item.path)) return JSON.stringify(item) !== JSON.stringify(before);
    const name = `resources/gepa-worker/${item.path}`, record = records.find(row => row.path === name);
    return item.path !== before.path || item.kind !== "file" || before.kind !== "file" || item.executable !== before.executable || item.sha256 !== record?.finalSha256;
  })) throw new Error("GEPA_RESOURCE_CHANGED_DURING_SIGNING");
  for (const record of records) verifyWindowsPeRecord(await readFile(path.join(directory, record.path.slice("resources/gepa-worker/".length))), sourcePins.get(record.path), record);
  const text = JSON.stringify({ ...manifest, files: inventory }, null, 2) + "\n";
  await writeFile(path.join(directory, "manifest.json"), text);
  const hash = createHash("sha256").update(await readFile(path.join(directory, "manifest.json"))).digest("hex");
  verifyGepaBundle(directory, target, hash);
  // Retain the original digest, full input manifest and build identity. Runtime
  // GEPA pins are a projection of the successful source-to-final records.
  packager.config.extraMetadata.murageWindowsPeGepa = { sourceManifestSha256, sourceManifest: manifest, sources, records, finalManifestSha256: hash };
  pins[target] = hash;
  for (const scope of [packager.config.win, packager.platformSpecificBuildOptions]) {
    for (const row of scope?.extraResources ?? []) {
      if (row.to === "gepa-worker") row.from = directory;
      if (row.to === "gepa-worker/gepa-worker.exe") row.from = path.join(directory, "gepa-worker.exe");
    }
  }
  return { directory, manifestSha256: hash, sourceManifestSha256, sources, records };
}
